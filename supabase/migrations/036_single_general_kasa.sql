-- =============================================================================
-- HomeGuru PMS — migration 036
-- Single general kasa: replace the per-property cash account model.
-- =============================================================================
-- Before: every cash_account belonged to a property; collect_payment resolved
-- the kasa from the reservation's property. The operation is a single owner
-- who wants ONE pot of cash for the whole business, so this collapses to a
-- single general kasa that belongs to no property.
--
-- Assumes the clean-slate state (no cash_accounts rows yet) — it seeds the one
-- general kasa. It does NOT merge pre-existing per-property kasas.
-- =============================================================================

-- 1. A general kasa has no property.
ALTER TABLE cash_accounts ALTER COLUMN property_id DROP NOT NULL;

-- 2. Seed the one general kasa (idempotent — only when none exists).
INSERT INTO cash_accounts (property_id, name, account_type, currency)
SELECT NULL, 'Genel Kasa', 'CASH', 'TRY'
WHERE NOT EXISTS (SELECT 1 FROM cash_accounts);

-- 3. Enforce the singleton — no second kasa may ever be created.
CREATE OR REPLACE FUNCTION enforce_single_cash_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cash_accounts) THEN
    RAISE EXCEPTION 'Sistemde yalnızca tek bir genel kasa bulunabilir';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cash_accounts_singleton ON cash_accounts;
CREATE TRIGGER cash_accounts_singleton
  BEFORE INSERT ON cash_accounts
  FOR EACH ROW EXECUTE FUNCTION enforce_single_cash_account();

-- 4. RLS — there is no property to scope by anymore, so cash visibility is
--    purely role-based: finance roles (SUPER_ADMIN + PROPERTY_MANAGER) see the
--    general kasa and its transactions.
DROP POLICY IF EXISTS cash_accounts_select ON cash_accounts;
CREATE POLICY cash_accounts_select ON cash_accounts FOR SELECT
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

DROP POLICY IF EXISTS cash_accounts_modify ON cash_accounts;
CREATE POLICY cash_accounts_modify ON cash_accounts FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

DROP POLICY IF EXISTS cash_tx_select ON cash_transactions;
CREATE POLICY cash_tx_select ON cash_transactions FOR SELECT
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

DROP POLICY IF EXISTS cash_tx_insert ON cash_transactions;
CREATE POLICY cash_tx_insert ON cash_transactions FOR INSERT
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));
-- cash_tx_delete unchanged (SUPER_ADMIN only).

-- -----------------------------------------------------------------------------
-- 5. Payment RPCs — resolve the single general kasa instead of a per-property
--    one. The reservation-property access check is kept (it gates WHO may
--    collect for WHICH reservation); only the kasa lookup changes.
--    `_cash_account_id` is kept in the signature for compatibility but ignored.
-- -----------------------------------------------------------------------------
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

  -- CONFIRMED + CASH lands in the single general kasa.
  IF _initial_status = 'CONFIRMED' AND _method = 'CASH' THEN
    SELECT id INTO _resolved_cash_account FROM cash_accounts LIMIT 1;
    IF _resolved_cash_account IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı';
    END IF;
  END IF;

  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id, amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user, _amount, _method, _initial_status
  )
  RETURNING id INTO _payment_id;

  IF _initial_status = 'CONFIRMED' THEN
    INSERT INTO ledger_entries (
      guest_id, reservation_id, type, amount, note, created_by, payment_collection_id
    ) VALUES (
      _reservation_guest, _reservation_id, 'PAYMENT', _amount,
      COALESCE(_note, 'Ödeme — ' || _method), _caller_user, _payment_id
    );

    IF _method = 'CASH' THEN
      INSERT INTO cash_transactions (
        cash_account_id, amount, direction, description,
        ref_type, ref_id, created_by, payment_collection_id
      ) VALUES (
        _resolved_cash_account, _amount, 'IN',
        COALESCE(_note, 'Misafir ödemesi'),
        'payment_collection', _payment_id, _caller_user, _payment_id
      );
    END IF;
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

  IF _pc.method = 'CASH' THEN
    SELECT id INTO _resolved_cash_account FROM cash_accounts LIMIT 1;
    IF _resolved_cash_account IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı';
    END IF;
  END IF;

  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by, payment_collection_id
  ) VALUES (
    _reservation_guest, _pc.reservation_id, 'PAYMENT', _pc.amount,
    'Ödeme — ' || _pc.method || ' (onaylandı)', _caller_user, _pc.id
  );

  IF _pc.method = 'CASH' THEN
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, created_by, payment_collection_id
    ) VALUES (
      _resolved_cash_account, _pc.amount, 'IN',
      'Misafir ödemesi (onaylandı)',
      'payment_collection', _pc.id, _caller_user, _pc.id
    );
  END IF;

  UPDATE payment_collections
  SET status = 'CONFIRMED', confirmed_by = _caller_user, confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;
