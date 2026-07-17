-- =============================================================================
-- HomeGuru PMS — migration 018
-- Per-role split for payment collection (Phase 3C-lite).
-- =============================================================================
-- Until now, every successful `collect_payment` call atomically created
-- three rows: payment_collections (status=CONFIRMED), ledger_entries (PAYMENT),
-- and cash_transactions (IN) — meaning money landed in the kasa immediately
-- regardless of who collected it.
--
-- For APARTMENT-delivery flows housekeeping collects on-site and a manager
-- isn't there to verify. The architectural intent is:
--   - Housekeeping submits → status=UNCONFIRMED, no kasa/cari effect yet.
--   - Manager reviews → either CONFIRMED (cari + kasa entries created) or
--     DISPUTED (no entries; row stays as audit trail).
--
-- This migration:
--   1. Rewrites collect_payment so HOUSEKEEPING callers create UNCONFIRMED
--      payment_collections rows only. Other roles keep the current eager flow.
--   2. Adds confirm_payment(payment_id) — manager approves, this is when the
--      ledger PAYMENT + cash_transactions IN finally get inserted (FK-linked,
--      so cascade delete still works).
--   3. Adds dispute_payment(payment_id) — marks the row DISPUTED, no entries.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rewrite collect_payment
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
  _caller_property         uuid;
  _reservation_property    uuid;
  _reservation_guest       uuid;
  _property_type           text;
  _resolved_cash_account   uuid;
  _payment_id              uuid;
  _initial_status          text;
BEGIN
  -- 1. Identity
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role, property_id
    INTO _caller_role, _caller_property
  FROM staff_profiles
  WHERE user_id = _caller_user;

  IF _caller_role IS NULL THEN
    RAISE EXCEPTION 'Personel profili bulunamadı' USING ERRCODE = '28000';
  END IF;

  -- 2. Resolve reservation + property
  SELECT r.property_id, r.guest_id, p.type
    INTO _reservation_property, _reservation_guest, _property_type
  FROM reservations r
  JOIN properties p ON p.id = r.property_id
  WHERE r.id = _reservation_id;

  IF _reservation_property IS NULL THEN
    RAISE EXCEPTION 'Rezervasyon bulunamadı';
  END IF;

  -- 3. Role × property-type × branch matrix (unchanged)
  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL;
  ELSIF _caller_role = 'PROPERTY_MANAGER' THEN
    IF _caller_property IS DISTINCT FROM _reservation_property THEN
      RAISE EXCEPTION 'Bu rezervasyon başka bir şubeye ait' USING ERRCODE = '42501';
    END IF;
  ELSIF _caller_role = 'RECEPTION' THEN
    IF _caller_property IS DISTINCT FROM _reservation_property THEN
      RAISE EXCEPTION 'Bu rezervasyon başka bir şubeye ait' USING ERRCODE = '42501';
    END IF;
    IF _property_type <> 'HOTEL' THEN
      RAISE EXCEPTION 'Resepsiyon yalnızca otellerde ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSIF _caller_role = 'HOUSEKEEPING' THEN
    IF _caller_property IS DISTINCT FROM _reservation_property THEN
      RAISE EXCEPTION 'Bu rezervasyon başka bir şubeye ait' USING ERRCODE = '42501';
    END IF;
    IF _property_type <> 'APARTMENT' THEN
      RAISE EXCEPTION 'Temizlik yalnızca apartmanlarda ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Yetkisiz rol' USING ERRCODE = '42501';
  END IF;

  -- 4. Validate inputs
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Tutar sıfırdan büyük olmalıdır';
  END IF;
  IF _method NOT IN ('CASH', 'TRANSFER', 'CARD') THEN
    RAISE EXCEPTION 'Ödeme yöntemi geçersiz (CASH / TRANSFER / CARD)';
  END IF;

  -- 5. Decide initial status based on role:
  --    HOUSEKEEPING → UNCONFIRMED (cari/kasa effects deferred to confirm_payment)
  --    everyone else → CONFIRMED (eager, current behavior)
  IF _caller_role = 'HOUSEKEEPING' THEN
    _initial_status := 'UNCONFIRMED';
  ELSE
    _initial_status := 'CONFIRMED';
  END IF;

  -- 6. For an eager CONFIRMED + CASH path, resolve the kasa now.
  --    Deferred (UNCONFIRMED) rows resolve the kasa at confirm_payment time.
  IF _initial_status = 'CONFIRMED' AND _method = 'CASH' THEN
    IF _cash_account_id IS NULL THEN
      SELECT id INTO _resolved_cash_account
      FROM cash_accounts
      WHERE property_id = _reservation_property
        AND account_type = 'CASH'
      ORDER BY created_at
      LIMIT 1;
      IF _resolved_cash_account IS NULL THEN
        RAISE EXCEPTION 'Bu mülk için nakit kasası tanımlanmamış. Önce bir nakit kasası oluşturun.';
      END IF;
    ELSE
      SELECT id INTO _resolved_cash_account
      FROM cash_accounts
      WHERE id = _cash_account_id
        AND property_id = _reservation_property;
      IF _resolved_cash_account IS NULL THEN
        RAISE EXCEPTION 'Seçilen kasa bu mülke ait değil';
      END IF;
    END IF;
  END IF;

  -- 7. Always insert the payment_collections audit row
  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id,
    amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user,
    _amount, _method, _initial_status
  )
  RETURNING id INTO _payment_id;

  -- 8. Eager flow: also insert ledger + (if CASH) cash entries.
  --    Deferred flow: nothing else happens until confirm_payment runs.
  IF _initial_status = 'CONFIRMED' THEN
    INSERT INTO ledger_entries (
      guest_id, reservation_id, type, amount, note, created_by,
      payment_collection_id
    ) VALUES (
      _reservation_guest, _reservation_id, 'PAYMENT', _amount,
      COALESCE(_note, 'Ödeme — ' || _method), _caller_user,
      _payment_id
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

-- -----------------------------------------------------------------------------
-- 2. confirm_payment — manager approves an UNCONFIRMED row
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION confirm_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user            uuid;
  _caller_role            text;
  _caller_property        uuid;
  _pc                     payment_collections;
  _reservation_guest      uuid;
  _resolved_cash_account  uuid;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role, property_id
    INTO _caller_role, _caller_property
  FROM staff_profiles
  WHERE user_id = _caller_user;

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

  -- Branch check for PROPERTY_MANAGER
  IF _caller_role = 'PROPERTY_MANAGER'
     AND _caller_property IS DISTINCT FROM _pc.property_id THEN
    RAISE EXCEPTION 'Bu tahsilat başka bir şubeye ait' USING ERRCODE = '42501';
  END IF;

  -- Look up guest_id from the reservation (ledger_entries needs it)
  SELECT guest_id INTO _reservation_guest
  FROM reservations WHERE id = _pc.reservation_id;
  IF _reservation_guest IS NULL THEN
    RAISE EXCEPTION 'İlişkili rezervasyon bulunamadı';
  END IF;

  -- For CASH: pick the property's CASH account
  IF _pc.method = 'CASH' THEN
    SELECT id INTO _resolved_cash_account
    FROM cash_accounts
    WHERE property_id = _pc.property_id
      AND account_type = 'CASH'
    ORDER BY created_at
    LIMIT 1;
    IF _resolved_cash_account IS NULL THEN
      RAISE EXCEPTION 'Bu mülk için nakit kasası tanımlanmamış. Önce bir nakit kasası oluşturun.';
    END IF;
  END IF;

  -- Insert the previously-deferred ledger PAYMENT entry, linked back via FK
  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by,
    payment_collection_id
  ) VALUES (
    _reservation_guest, _pc.reservation_id, 'PAYMENT', _pc.amount,
    'Ödeme — ' || _pc.method || ' (onaylandı)', _caller_user, _pc.id
  );

  -- For CASH, push the money into the kasa
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

  -- Flip the audit row to CONFIRMED
  UPDATE payment_collections
  SET status = 'CONFIRMED',
      confirmed_by = _caller_user,
      confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. dispute_payment — manager rejects an UNCONFIRMED row
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispute_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user      uuid;
  _caller_role      text;
  _caller_property  uuid;
  _pc               payment_collections;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role, property_id
    INTO _caller_role, _caller_property
  FROM staff_profiles
  WHERE user_id = _caller_user;

  IF _caller_role NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Yalnızca yönetici tahsilatı reddedebilir' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _pc FROM payment_collections WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tahsilat bulunamadı';
  END IF;

  IF _pc.status <> 'UNCONFIRMED' THEN
    RAISE EXCEPTION 'Bu tahsilat zaten % durumunda', _pc.status;
  END IF;

  IF _caller_role = 'PROPERTY_MANAGER'
     AND _caller_property IS DISTINCT FROM _pc.property_id THEN
    RAISE EXCEPTION 'Bu tahsilat başka bir şubeye ait' USING ERRCODE = '42501';
  END IF;

  UPDATE payment_collections
  SET status = 'DISPUTED',
      confirmed_by = _caller_user,
      confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION dispute_payment(uuid) TO authenticated;
