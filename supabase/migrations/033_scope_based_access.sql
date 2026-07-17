-- =============================================================================
-- HomeGuru PMS — migration 033
-- Scope-based access: a staff member works in Daireler / Oteller / Tüm Hepsinde
-- instead of being pinned to one property.
-- =============================================================================
-- Replaces the single-property branch-isolation model. Before: every check was
-- `property_id = auth_property_id()` (one property per user). Now: a user has
-- an `access_scope` and a new helper `auth_sees_property(uuid)` decides, per
-- property, whether the caller's scope covers it.
--
--   access_scope:
--     ALL        → every property
--     HOTELS     → properties of type HOTEL
--     APARTMENTS → properties of type APARTMENT
--
-- staff_profiles.property_id is left in place (harmless) but no longer drives
-- isolation. PENDING users are excluded inside the helper, so they still see
-- nothing regardless of scope. SUPER_ADMIN bypasses everything.
--
-- Fail-safe note: if any property-scoped policy were missed, it would keep
-- comparing against auth_property_id() (now effectively unused / NULL) and
-- fail CLOSED — show nothing — never leak. The only correctness-critical
-- piece is auth_sees_property() itself.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. access_scope column. Existing staff default to ALL (no one loses access
--    on migration day); narrow each person afterwards via the staff page.
-- -----------------------------------------------------------------------------
ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS access_scope text NOT NULL
  DEFAULT 'ALL'
  CHECK (access_scope IN ('ALL', 'HOTELS', 'APARTMENTS'));

-- -----------------------------------------------------------------------------
-- 2. auth_sees_property(property_id): does the caller's scope cover this
--    property? SUPER_ADMIN always true. PENDING (and any role-less user)
--    always false.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_sees_property(p_property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1
      FROM staff_profiles sp
      JOIN properties pr ON pr.id = p_property_id
      WHERE sp.user_id = auth.uid()
        AND sp.role <> 'PENDING'
        AND (
          sp.access_scope = 'ALL'
          OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
          OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
        )
    );
$$;

GRANT EXECUTE ON FUNCTION auth_sees_property(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Rewrite every property-scoped policy: `property_id = auth_property_id()`
--    becomes `auth_sees_property(property_id)`. Role gates are preserved.
-- -----------------------------------------------------------------------------

-- properties --------------------------------------------------------------
DROP POLICY IF EXISTS properties_select ON properties;
CREATE POLICY properties_select ON properties FOR SELECT
  USING (auth_sees_property(id));
-- properties_modify unchanged (SUPER_ADMIN only).

-- units -------------------------------------------------------------------
DROP POLICY IF EXISTS units_select ON units;
CREATE POLICY units_select ON units FOR SELECT
  USING (auth_sees_property(property_id));

DROP POLICY IF EXISTS units_modify ON units;
CREATE POLICY units_modify ON units FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI')
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI')
    AND auth_sees_property(property_id)
  );

-- staff_profiles ----------------------------------------------------------
-- Staff have no property type, so scope doesn't apply. Managers + admin see
-- all staff; everyone else sees only their own row.
DROP POLICY IF EXISTS staff_profiles_select ON staff_profiles;
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
  );
-- staff_profiles_modify unchanged (SUPER_ADMIN only).

-- staff_advances ----------------------------------------------------------
DROP POLICY IF EXISTS staff_advances_select ON staff_advances;
CREATE POLICY staff_advances_select ON staff_advances FOR SELECT
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    OR user_id = auth.uid()
  );

DROP POLICY IF EXISTS staff_advances_modify ON staff_advances;
CREATE POLICY staff_advances_modify ON staff_advances FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- guests ------------------------------------------------------------------
DROP POLICY IF EXISTS guests_select ON guests;
CREATE POLICY guests_select ON guests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guests.id
        AND auth_sees_property(r.property_id)
    )
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
  );
-- guests_insert / guests_update / guests_delete are role-only — unchanged.

-- reservations ------------------------------------------------------------
DROP POLICY IF EXISTS reservations_select ON reservations;
CREATE POLICY reservations_select ON reservations FOR SELECT
  USING (auth_sees_property(property_id));

DROP POLICY IF EXISTS reservations_insert ON reservations;
CREATE POLICY reservations_insert ON reservations FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND auth_sees_property(property_id)
  );

DROP POLICY IF EXISTS reservations_update ON reservations;
CREATE POLICY reservations_update ON reservations FOR UPDATE
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND auth_sees_property(property_id)
  );

DROP POLICY IF EXISTS reservations_delete ON reservations;
CREATE POLICY reservations_delete ON reservations FOR DELETE
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND auth_sees_property(property_id)
  );

-- ledger_entries ----------------------------------------------------------
DROP POLICY IF EXISTS ledger_select ON ledger_entries;
CREATE POLICY ledger_select ON ledger_entries FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = ledger_entries.reservation_id
          AND auth_sees_property(r.property_id)
      )
    )
  );

DROP POLICY IF EXISTS ledger_insert ON ledger_entries;
CREATE POLICY ledger_insert ON ledger_entries FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (
      auth_role() = 'SUPER_ADMIN'
      OR (
        ledger_entries.reservation_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.id = ledger_entries.reservation_id
            AND auth_sees_property(r.property_id)
        )
      )
      OR (
        ledger_entries.reservation_id IS NULL
        AND EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.guest_id = ledger_entries.guest_id
            AND auth_sees_property(r.property_id)
        )
      )
    )
  );
-- ledger_delete unchanged (SUPER_ADMIN only).

-- cash_accounts -----------------------------------------------------------
DROP POLICY IF EXISTS cash_accounts_select ON cash_accounts;
CREATE POLICY cash_accounts_select ON cash_accounts FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND auth_sees_property(property_id))
  );

DROP POLICY IF EXISTS cash_accounts_modify ON cash_accounts;
CREATE POLICY cash_accounts_modify ON cash_accounts FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND auth_sees_property(property_id)
  );

-- cash_transactions -------------------------------------------------------
-- Also gate SELECT to finance roles — the original 003 policy had no role
-- check, which would let a branch-matched non-finance user read the kasa.
DROP POLICY IF EXISTS cash_tx_select ON cash_transactions;
CREATE POLICY cash_tx_select ON cash_transactions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM cash_accounts ca
        WHERE ca.id = cash_transactions.cash_account_id
          AND auth_sees_property(ca.property_id)
      )
    )
  );

DROP POLICY IF EXISTS cash_tx_insert ON cash_transactions;
CREATE POLICY cash_tx_insert ON cash_transactions FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (
      auth_role() = 'SUPER_ADMIN'
      OR EXISTS (
        SELECT 1 FROM cash_accounts ca
        WHERE ca.id = cash_transactions.cash_account_id
          AND auth_sees_property(ca.property_id)
      )
    )
  );
-- cash_tx_delete unchanged (SUPER_ADMIN only).

-- expenses ----------------------------------------------------------------
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND auth_sees_property(property_id))
  );

DROP POLICY IF EXISTS expenses_modify ON expenses;
CREATE POLICY expenses_modify ON expenses FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND auth_sees_property(property_id)
  );

-- housekeeping_tasks ------------------------------------------------------
DROP POLICY IF EXISTS hk_tasks_select ON housekeeping_tasks;
CREATE POLICY hk_tasks_select ON housekeeping_tasks FOR SELECT
  USING (auth_sees_property(property_id));

DROP POLICY IF EXISTS hk_tasks_modify ON housekeeping_tasks;
CREATE POLICY hk_tasks_modify ON housekeeping_tasks FOR ALL
  USING (auth_sees_property(property_id))
  WITH CHECK (auth_sees_property(property_id));

-- housekeeping_issues -----------------------------------------------------
DROP POLICY IF EXISTS hk_issues_select ON housekeeping_issues;
CREATE POLICY hk_issues_select ON housekeeping_issues FOR SELECT
  USING (auth_sees_property(property_id));

DROP POLICY IF EXISTS hk_issues_modify ON housekeeping_issues;
CREATE POLICY hk_issues_modify ON housekeeping_issues FOR ALL
  USING (auth_sees_property(property_id))
  WITH CHECK (auth_sees_property(property_id));

-- payment_collections -----------------------------------------------------
DROP POLICY IF EXISTS payment_collections_select ON payment_collections;
CREATE POLICY payment_collections_select ON payment_collections FOR SELECT
  USING (auth_sees_property(property_id));

DROP POLICY IF EXISTS payment_collections_insert ON payment_collections;
CREATE POLICY payment_collections_insert ON payment_collections FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND auth_sees_property(property_id))
    OR (auth_role() = 'YETKILI' AND auth_sees_property(property_id))
    OR (
      auth_role() = 'HOUSEKEEPING'
      AND auth_sees_property(property_id)
      AND EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = payment_collections.property_id AND p.type = 'APARTMENT'
      )
    )
    OR (
      auth_role() = 'RECEPTION'
      AND auth_sees_property(property_id)
      AND EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = payment_collections.property_id AND p.type = 'HOTEL'
      )
    )
  );
-- payment_collections_update unchanged (SUPER_ADMIN + PROPERTY_MANAGER).

-- kbs_submissions ---------------------------------------------------------
DROP POLICY IF EXISTS kbs_select ON kbs_submissions;
CREATE POLICY kbs_select ON kbs_submissions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = kbs_submissions.reservation_id
          AND auth_sees_property(r.property_id)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Payment RPCs — replace single-property branch checks with auth_sees_property.
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

  IF _initial_status = 'CONFIRMED' AND _method = 'CASH' THEN
    IF _cash_account_id IS NULL THEN
      SELECT id INTO _resolved_cash_account
      FROM cash_accounts
      WHERE property_id = _reservation_property AND account_type = 'CASH'
      ORDER BY created_at
      LIMIT 1;
      IF _resolved_cash_account IS NULL THEN
        RAISE EXCEPTION 'Bu mülk için nakit kasası tanımlanmamış. Önce bir nakit kasası oluşturun.';
      END IF;
    ELSE
      SELECT id INTO _resolved_cash_account
      FROM cash_accounts
      WHERE id = _cash_account_id AND property_id = _reservation_property;
      IF _resolved_cash_account IS NULL THEN
        RAISE EXCEPTION 'Seçilen kasa bu mülke ait değil';
      END IF;
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

-- confirm_payment — scope check replaces the old branch check.
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
    SELECT id INTO _resolved_cash_account
    FROM cash_accounts
    WHERE property_id = _pc.property_id AND account_type = 'CASH'
    ORDER BY created_at
    LIMIT 1;
    IF _resolved_cash_account IS NULL THEN
      RAISE EXCEPTION 'Bu mülk için nakit kasası tanımlanmamış. Önce bir nakit kasası oluşturun.';
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

-- dispute_payment — scope check replaces the old branch check.
CREATE OR REPLACE FUNCTION dispute_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user      uuid;
  _caller_role      text;
  _pc               payment_collections;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO _caller_role FROM staff_profiles WHERE user_id = _caller_user;

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

  IF _caller_role = 'PROPERTY_MANAGER' AND NOT auth_sees_property(_pc.property_id) THEN
    RAISE EXCEPTION 'Bu tahsilata erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  UPDATE payment_collections
  SET status = 'DISPUTED', confirmed_by = _caller_user, confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;
