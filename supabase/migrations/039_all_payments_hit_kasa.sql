-- =============================================================================
-- HomeGuru PMS — migration 039
-- Every collected payment posts to the general kasa — not just cash.
-- =============================================================================
-- Migration 036 collapsed the per-property Nakit / Banka / Kart accounts into a
-- single general kasa, but collect_payment / confirm_payment still only posted
-- a kasa movement when the method was CASH (a leftover from the old model).
-- That left CARD and TRANSFER payments recorded in the cari but invisible in
-- the kasa — with one general kasa they have nowhere else to go.
--
-- Now: a confirmed payment of ANY method (cash, card, transfer) posts an IN
-- movement to the general kasa. The kasa is the single record of money in.
-- =============================================================================

CREATE OR REPLACE FUNCTION collect_payment(
  _reservation_id  uuid,
  _amount          numeric,
  _method          text,
  _cash_account_id uuid DEFAULT NULL,
  _note            text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user             uuid;
  _caller_role             text;
  _reservation_property    uuid;
  _reservation_guest       uuid;
  _property_type           text;
  _resolved_cash_account   uuid;
  _payment_id              uuid;
  _initial_status          text;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO _caller_role FROM staff_profiles WHERE user_id = _caller_user;
  IF _caller_role IS NULL THEN
    RAISE EXCEPTION 'Personel profili bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT r.property_id, r.guest_id, p.type
    INTO _reservation_property, _reservation_guest, _property_type
  FROM reservations r
  JOIN properties p ON p.id = r.property_id
  WHERE r.id = _reservation_id;

  IF _reservation_property IS NULL THEN
    RAISE EXCEPTION 'Rezervasyon bulunamadı';
  END IF;

  -- Access check: scope must cover the reservation's property.
  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL;
  ELSIF _caller_role IN ('PROPERTY_MANAGER', 'YETKILI', 'RECEPTION', 'HOUSEKEEPING') THEN
    IF NOT auth_sees_property(_reservation_property) THEN
      RAISE EXCEPTION 'Bu mülke erişim yetkiniz yok' USING ERRCODE = '42501';
    END IF;
    IF _caller_role = 'RECEPTION' AND _property_type <> 'HOTEL' THEN
      RAISE EXCEPTION 'Resepsiyon yalnızca otellerde ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
    IF _caller_role = 'HOUSEKEEPING' AND _property_type <> 'APARTMENT' THEN
      RAISE EXCEPTION 'Temizlik yalnızca apartmanlarda ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Yetkisiz rol' USING ERRCODE = '42501';
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Tutar sıfırdan büyük olmalıdır';
  END IF;
  IF _method NOT IN ('CASH', 'TRANSFER', 'CARD') THEN
    RAISE EXCEPTION 'Ödeme yöntemi geçersiz (CASH / TRANSFER / CARD)';
  END IF;

  -- Roles without finance-write submit UNCONFIRMED rows for manager approval.
  IF _caller_role IN ('HOUSEKEEPING', 'YETKILI') THEN
    _initial_status := 'UNCONFIRMED';
  ELSE
    _initial_status := 'CONFIRMED';
  END IF;

  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id, amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user, _amount, _method, _initial_status
  )
  RETURNING id INTO _payment_id;

  -- A confirmed payment posts to the cari AND the general kasa, regardless of
  -- method — cash, card and transfer all flow through the one kasa.
  IF _initial_status = 'CONFIRMED' THEN
    SELECT id INTO _resolved_cash_account FROM cash_accounts LIMIT 1;
    IF _resolved_cash_account IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı';
    END IF;

    INSERT INTO ledger_entries (
      guest_id, reservation_id, type, amount, note, created_by, payment_collection_id
    ) VALUES (
      _reservation_guest, _reservation_id, 'PAYMENT', _amount,
      COALESCE(_note, 'Ödeme — ' || _method), _caller_user, _payment_id
    );

    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, created_by, payment_collection_id
    ) VALUES (
      _resolved_cash_account, _amount, 'IN',
      COALESCE(_note, 'Misafir ödemesi — ' || _method),
      'payment_collection', _payment_id, _caller_user, _payment_id
    );
  END IF;

  RETURN _payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION confirm_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user            uuid;
  _caller_role            text;
  _pc                     payment_collections;
  _reservation_guest      uuid;
  _resolved_cash_account  uuid;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO _caller_role FROM staff_profiles WHERE user_id = _caller_user;

  IF _caller_role NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Yalnızca yönetici tahsilat onaylayabilir' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _pc FROM payment_collections WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tahsilat bulunamadı';
  END IF;

  IF _pc.status <> 'UNCONFIRMED' THEN
    RAISE EXCEPTION 'Bu tahsilat zaten % durumunda, onaylanamaz', _pc.status;
  END IF;

  IF _caller_role = 'PROPERTY_MANAGER' AND NOT auth_sees_property(_pc.property_id) THEN
    RAISE EXCEPTION 'Bu tahsilata erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  SELECT guest_id INTO _reservation_guest
  FROM reservations WHERE id = _pc.reservation_id;
  IF _reservation_guest IS NULL THEN
    RAISE EXCEPTION 'İlişkili rezervasyon bulunamadı';
  END IF;

  SELECT id INTO _resolved_cash_account FROM cash_accounts LIMIT 1;
  IF _resolved_cash_account IS NULL THEN
    RAISE EXCEPTION 'Genel kasa bulunamadı';
  END IF;

  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by, payment_collection_id
  ) VALUES (
    _reservation_guest, _pc.reservation_id, 'PAYMENT', _pc.amount,
    'Ödeme — ' || _pc.method || ' (onaylandı)', _caller_user, _pc.id
  );

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by, payment_collection_id
  ) VALUES (
    _resolved_cash_account, _pc.amount, 'IN',
    'Misafir ödemesi — ' || _pc.method || ' (onaylandı)',
    'payment_collection', _pc.id, _caller_user, _pc.id
  );

  UPDATE payment_collections
  SET status = 'CONFIRMED', confirmed_by = _caller_user, confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;
