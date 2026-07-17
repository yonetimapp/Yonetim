-- =============================================================================
-- HomeGuru PMS — migration 012
-- Atomic payment-collection RPC.
-- =============================================================================
-- collect_payment() records that a guest paid for a stay. It performs THREE
-- coordinated writes in one transaction:
--
--   1. payment_collections — the audit row (who collected, when, method, status)
--   2. ledger_entries (PAYMENT) — credits the guest's cari
--   3. cash_transactions (IN)   — only when method = 'CASH'; the money lands
--                                  in the property's cash drawer
--
-- SECURITY DEFINER is required because migrations 010 + 011 restrict
-- cash_transactions / ledger_entries INSERT to SUPER_ADMIN + PROPERTY_MANAGER,
-- but the operators who actually collect at the property level are
-- RECEPTION (in HOTELs) and HOUSEKEEPING (in APARTMENTs). The function
-- therefore bypasses RLS and enforces the rules in its own body, mirroring
-- the property-type-conditional matrix from the rbac.canCollectPayment() helper:
--
--     SUPER_ADMIN       — any property
--     PROPERTY_MANAGER  — own branch only
--     RECEPTION         — own branch, HOTEL  only
--     HOUSEKEEPING      — own branch, APARTMENT only
--
-- The function returns the new payment_collections.id.
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
  _caller_property         uuid;
  _reservation_property    uuid;
  _reservation_guest       uuid;
  _property_type           text;
  _resolved_cash_account   uuid;
  _payment_id              uuid;
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

  -- 3. Role × property-type × branch matrix
  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL; -- allowed everywhere
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

  -- 5. For CASH, resolve the cash account. If caller didn't pass one
  --    (typical for RECEPTION/HOUSEKEEPING who can't SELECT cash_accounts),
  --    pick the property's first CASH-type account. Verify the chosen account
  --    actually belongs to the reservation's property.
  IF _method = 'CASH' THEN
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

  -- 6. Insert payment_collections
  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id,
    amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user,
    _amount, _method, 'CONFIRMED'
  )
  RETURNING id INTO _payment_id;

  -- 7. Insert the ledger PAYMENT entry (credits the guest's cari)
  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by
  ) VALUES (
    _reservation_guest, _reservation_id, 'PAYMENT', _amount,
    COALESCE(_note, 'Ödeme — ' || _method), _caller_user
  );

  -- 8. If CASH, push the money into the cash drawer
  IF _method = 'CASH' THEN
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, created_by
    ) VALUES (
      _resolved_cash_account, _amount, 'IN',
      COALESCE(_note, 'Misafir ödemesi'),
      'payment_collection', _payment_id, _caller_user
    );
  END IF;

  RETURN _payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION collect_payment(uuid, numeric, text, uuid, text) TO authenticated;
