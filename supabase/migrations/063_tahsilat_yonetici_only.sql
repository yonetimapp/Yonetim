-- =============================================================================
-- HomeGuru PMS — migration 063
-- collect_payment: only SUPER_ADMIN bypasses onay.
-- =============================================================================
-- Migration 039 routed HOUSEKEEPING + YETKILI submissions through the
-- UNCONFIRMED queue but left PROPERTY_MANAGER and RECEPTION as direct
-- CONFIRMED — meaning they posted to the cari + kasa with zero admin
-- review. That contradicts the policy of "only Yönetici (SUPER_ADMIN)
-- can move money without approval" applied to giderler + kasa hareketi
-- in migrations 055 + 062. This brings tahsilat in line.
--
-- Net change: only SUPER_ADMIN gets `_initial_status := 'CONFIRMED'`.
-- Everyone else lands in UNCONFIRMED → SUPER_ADMIN confirms / disputes
-- on /finance/pending.
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

  -- Only SUPER_ADMIN posts straight to the cari + kasa. Everyone else
  -- queues for yönetici onayı on /finance/pending.
  IF _caller_role = 'SUPER_ADMIN' THEN
    _initial_status := 'CONFIRMED';
  ELSE
    _initial_status := 'UNCONFIRMED';
  END IF;

  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id, amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user, _amount, _method, _initial_status
  )
  RETURNING id INTO _payment_id;

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
