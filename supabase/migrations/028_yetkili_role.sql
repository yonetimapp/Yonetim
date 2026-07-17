-- =============================================================================
-- HomeGuru PMS — migration 028
-- New role: YETKILI (branch operator, no finance / no staff / no admin)
-- =============================================================================
-- Permissions:
--   ✓ Reservation CRUD (own branch)
--   ✓ Guest CRUD
--   ✓ Unit edit (own branch)
--   ✓ Housekeeping read+write (via existing branch-only RLS)
--   ✓ Payment collect (both HOTEL and APARTMENT) — creates UNCONFIRMED, like
--     HOUSEKEEPING, since YETKILI has no finance-write access. A manager
--     confirms the row to push the entry into kasa + cari.
--   ✓ Use WhatsApp templates (template_select USING(true) already allows)
-- Blocked (no change needed — existing policies already exclude them):
--   ✗ Finance writes (kasalar / giderler / cari / staff_advances)
--   ✗ Confirm/dispute payments (payment_collections_update)
--   ✗ Template management (templates_modify)
--   ✗ Audit log read (audit_select)
--   ✗ Trash bin (trash_select / _delete)
--   ✗ Other branches' data (auth_property_id() branch isolation)
--   ✗ Add/edit other staff (staff_profiles_modify is SUPER_ADMIN-only)

-- -----------------------------------------------------------------------------
-- 1. Extend the role CHECK constraint
-- -----------------------------------------------------------------------------
ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING', 'YETKILI'));

-- -----------------------------------------------------------------------------
-- 2. units_modify — let YETKILI edit units in their own branch
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS units_modify ON units;
CREATE POLICY units_modify ON units FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

-- -----------------------------------------------------------------------------
-- 3. guests policies — add YETKILI to select / insert / update
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS guests_select ON guests;
CREATE POLICY guests_select ON guests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guests.id
        AND r.property_id = auth_property_id()
    )
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
  );

DROP POLICY IF EXISTS guests_insert ON guests;
CREATE POLICY guests_insert ON guests FOR INSERT
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'));

DROP POLICY IF EXISTS guests_update ON guests;
CREATE POLICY guests_update ON guests FOR UPDATE
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'));

-- -----------------------------------------------------------------------------
-- 4. reservations insert/update — add YETKILI
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS reservations_insert ON reservations;
CREATE POLICY reservations_insert ON reservations FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

DROP POLICY IF EXISTS reservations_update ON reservations;
CREATE POLICY reservations_update ON reservations FOR UPDATE
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

-- -----------------------------------------------------------------------------
-- 5. payment_collections_insert — YETKILI can insert for both property types
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS payment_collections_insert ON payment_collections;
CREATE POLICY payment_collections_insert ON payment_collections FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND property_id = auth_property_id())
    OR (auth_role() = 'YETKILI' AND property_id = auth_property_id())
    OR (
      auth_role() = 'HOUSEKEEPING'
      AND property_id = auth_property_id()
      AND EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = payment_collections.property_id AND p.type = 'APARTMENT'
      )
    )
    OR (
      auth_role() = 'RECEPTION'
      AND property_id = auth_property_id()
      AND EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = payment_collections.property_id AND p.type = 'HOTEL'
      )
    )
  );

-- payment_collections_update unchanged — only PROPERTY_MANAGER + SUPER_ADMIN
-- can confirm/dispute. YETKILI submits, manager approves.

-- -----------------------------------------------------------------------------
-- 6. collect_payment — extend the role matrix + status decision for YETKILI
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

  -- 3. Role × property-type × branch matrix
  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL;
  ELSIF _caller_role IN ('PROPERTY_MANAGER', 'YETKILI') THEN
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

  -- 5. Initial status — roles without finance-write capability submit
  --    UNCONFIRMED rows that a manager later approves.
  IF _caller_role IN ('HOUSEKEEPING', 'YETKILI') THEN
    _initial_status := 'UNCONFIRMED';
  ELSE
    _initial_status := 'CONFIRMED';
  END IF;

  -- 6. CONFIRMED + CASH path: resolve the kasa now.
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
