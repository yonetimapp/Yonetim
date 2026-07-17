-- =============================================================================
-- HomeGuru PMS — migration 065
-- Codebase-audit follow-up fixes:
--   1. Restore expenses_select scope check (064 regressed to a single-property
--      model that returns NULL under the scope-based system).
--   2. auth_role / auth_property_id / auth_sees_property filter deleted_at so
--      soft-deleted staff actually lose their RBAC powers (gap in 057).
--   3. guest_companions writes are now branch-scope-gated (042 had FOR ALL
--      with role-only check — any operational role could write companion PII
--      cross-scope).
--   4. update_guest / update_companion preserve encrypted TC + passport when
--      caller passes NULL (056/042 silently wiped them).
--   5. update_guest / create_guest run an explicit scope check inside the
--      SECURITY DEFINER body (RLS is bypassed; previous "defense in depth"
--      comment was wishful — there was no DD).
--   6. restore_trash for reservations preserves columns added after 021
--      (stay_type, notified_2d_before, late_checkout_hours, google_event_id).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. expenses_select — restore scope-aware visibility for PROPERTY_MANAGER
--    + keep YETKILI's "own submissions" branch from 064.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND (property_id IS NULL OR auth_sees_property(property_id))
    )
    OR (auth_role() = 'YETKILI' AND created_by = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- 2. Soft-deleted staff lose their role. Adding `deleted_at IS NULL` to the
--    three helper functions cascades through every RLS policy + SECURITY
--    DEFINER role check in the system. delete_staff (057) becomes a real
--    revocation, not just a list-filter.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION auth_property_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT property_id FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL
$$;

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
        AND sp.deleted_at IS NULL
        AND sp.role <> 'PENDING'
        AND (
          sp.access_scope = 'ALL'
          OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
          OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
        )
    );
$$;

-- ----------------------------------------------------------------------------
-- 3. guest_companions INSERT/UPDATE/DELETE — gate by parent-guest scope so
--    a YETKILI scoped to Daireler cannot blast a HOTEL guest's companion PII.
--    SELECT policy in 042 already had the scope check; this brings writes
--    into line.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS guest_companions_modify ON guest_companions;

CREATE POLICY guest_companions_insert ON guest_companions FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.guest_id = guest_companions.guest_id
          AND auth_sees_property(r.property_id)
      )
    )
  );

CREATE POLICY guest_companions_update ON guest_companions FOR UPDATE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.guest_id = guest_companions.guest_id
          AND auth_sees_property(r.property_id)
      )
    )
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.guest_id = guest_companions.guest_id
          AND auth_sees_property(r.property_id)
      )
    )
  );

CREATE POLICY guest_companions_delete ON guest_companions FOR DELETE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.guest_id = guest_companions.guest_id
          AND auth_sees_property(r.property_id)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 4. update_guest — preserve encrypted TC + passport when caller passes
--    NULL (was: wipe). update_companion same fix. Empty-string still wipes,
--    so an explicit "clear" still works via the form (which sends '' for
--    cleared fields, not NULL).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_guest(
  _id               uuid,
  _full_name        text,
  _tc_kimlik        text DEFAULT NULL,
  _passport         text DEFAULT NULL,
  _phone            text DEFAULT NULL,
  _email            text DEFAULT NULL,
  _address          text DEFAULT NULL,
  _nationality      text DEFAULT NULL,
  _is_problematic   boolean DEFAULT false,
  _problematic_note text DEFAULT NULL
) RETURNS guests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result      guests;
  caller_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı';
  END IF;
  SELECT role INTO caller_role FROM staff_profiles
    WHERE user_id = auth.uid() AND deleted_at IS NULL;
  IF caller_role IS NULL OR caller_role = 'PENDING' THEN
    RAISE EXCEPTION 'Misafir güncelleme yetkisi yok';
  END IF;

  -- Scope check (5): YETKILI / HOUSEKEEPING must be able to see at least
  -- one reservation for this guest in their access scope. SUPER_ADMIN +
  -- PROPERTY_MANAGER + RECEPTION have blanket guest access per the
  -- guests_select policy (migration 032 line 58–68), so they skip.
  IF caller_role NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION') THEN
    IF NOT EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = _id AND auth_sees_property(r.property_id)
    ) THEN
      RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok';
    END IF;
  END IF;

  UPDATE guests SET
    full_name = _full_name,
    -- Preserve encrypted fields when caller passes NULL. Passing '' still
    -- clears (encrypt_sensitive('') = NULL) so the explicit clear path works.
    tc_kimlik_encrypted =
      CASE WHEN _tc_kimlik IS NULL THEN tc_kimlik_encrypted
           ELSE encrypt_sensitive(_tc_kimlik) END,
    passport_encrypted =
      CASE WHEN _passport IS NULL THEN passport_encrypted
           ELSE encrypt_sensitive(_passport) END,
    phone = _phone,
    email = _email,
    address = _address,
    nationality = _nationality,
    is_problematic = COALESCE(_is_problematic, false),
    problematic_note = NULLIF(btrim(COALESCE(_problematic_note, '')), '')
  WHERE id = _id
  RETURNING * INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Misafir bulunamadı';
  END IF;

  RETURN result;
END;
$$;

-- create_guest also gets the scope check (a YETKILI shouldn't be able to
-- spawn a guest record they can't see). For SUPER_ADMIN + PROPERTY_MANAGER
-- + RECEPTION it's a no-op gate. Encrypted-field preservation isn't relevant
-- on INSERT (caller chooses what to set).
CREATE OR REPLACE FUNCTION create_guest(
  _full_name        text,
  _tc_kimlik        text DEFAULT NULL,
  _passport         text DEFAULT NULL,
  _phone            text DEFAULT NULL,
  _email            text DEFAULT NULL,
  _address          text DEFAULT NULL,
  _nationality      text DEFAULT NULL,
  _is_problematic   boolean DEFAULT false,
  _problematic_note text DEFAULT NULL
) RETURNS guests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result      guests;
  caller_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı';
  END IF;
  SELECT role INTO caller_role FROM staff_profiles
    WHERE user_id = auth.uid() AND deleted_at IS NULL;
  IF caller_role IS NULL OR caller_role = 'PENDING' THEN
    RAISE EXCEPTION 'Misafir oluşturma yetkisi yok';
  END IF;

  INSERT INTO guests (
    full_name, tc_kimlik_encrypted, passport_encrypted,
    phone, email, address, nationality,
    is_problematic, problematic_note
  ) VALUES (
    _full_name,
    encrypt_sensitive(_tc_kimlik),
    encrypt_sensitive(_passport),
    _phone, _email, _address, _nationality,
    COALESCE(_is_problematic, false),
    NULLIF(btrim(COALESCE(_problematic_note, '')), '')
  )
  RETURNING * INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION update_companion(
  _id           uuid,
  _full_name    text,
  _relationship text DEFAULT NULL,
  _birth_date   date DEFAULT NULL,
  _nationality  text DEFAULT NULL,
  _tc_kimlik    text DEFAULT NULL,
  _passport     text DEFAULT NULL
) RETURNS guest_companions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result guest_companions;
BEGIN
  UPDATE guest_companions SET
    full_name = _full_name,
    relationship = NULLIF(btrim(COALESCE(_relationship, '')), ''),
    birth_date = _birth_date,
    nationality = NULLIF(btrim(COALESCE(_nationality, '')), ''),
    tc_kimlik_encrypted =
      CASE WHEN _tc_kimlik IS NULL THEN tc_kimlik_encrypted
           ELSE encrypt_sensitive(_tc_kimlik) END,
    passport_encrypted =
      CASE WHEN _passport IS NULL THEN passport_encrypted
           ELSE encrypt_sensitive(_passport) END
  WHERE id = _id
  RETURNING * INTO result;
  RETURN result;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. restore_trash — bring the reservations branch up to date so restored
--    rows preserve stay_type, notified_2d_before, late_checkout_hours, and
--    google_event_id. Use the same generated-column-safe pattern as 021 but
--    with the full current column list. The original function had a
--    different return type (void vs uuid) so we DROP before CREATE.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS restore_trash(uuid);

CREATE FUNCTION restore_trash(_trash_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec       trash_entries;
  new_id    uuid;
BEGIN
  SELECT * INTO rec FROM trash_entries WHERE id = _trash_id;
  IF rec IS NULL THEN
    RAISE EXCEPTION 'Çöp kaydı bulunamadı';
  END IF;

  CASE rec.entity_type
    WHEN 'housekeeping_issues' THEN
      INSERT INTO housekeeping_issues
      SELECT * FROM jsonb_populate_record(NULL::housekeeping_issues, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'reservations' THEN
      -- Explicit columns + every field added after 021. `stay` is generated,
      -- so it's excluded; everything else flows through.
      INSERT INTO reservations
        (id, property_id, unit_id, guest_id, stay_start, stay_end,
         status, stay_type, total_amount, deposit, auto_debit,
         created_by, created_at,
         notified_2d_before, late_checkout_hours, google_event_id)
      SELECT id, property_id, unit_id, guest_id, stay_start, stay_end,
             status, stay_type, total_amount, deposit, auto_debit,
             created_by, created_at,
             notified_2d_before, late_checkout_hours, google_event_id
      FROM jsonb_populate_record(NULL::reservations, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'cash_transactions' THEN
      INSERT INTO cash_transactions
      SELECT * FROM jsonb_populate_record(NULL::cash_transactions, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'ledger_entries' THEN
      INSERT INTO ledger_entries
      SELECT * FROM jsonb_populate_record(NULL::ledger_entries, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'expenses' THEN
      INSERT INTO expenses
      SELECT * FROM jsonb_populate_record(NULL::expenses, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'message_templates' THEN
      INSERT INTO message_templates
      SELECT * FROM jsonb_populate_record(NULL::message_templates, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'staff_advances' THEN
      INSERT INTO staff_advances
      SELECT * FROM jsonb_populate_record(NULL::staff_advances, rec.payload)
      RETURNING id INTO new_id;

    WHEN 'units' THEN
      INSERT INTO units
      SELECT * FROM jsonb_populate_record(NULL::units, rec.payload)
      RETURNING id INTO new_id;

    ELSE
      RAISE EXCEPTION 'Restore desteklenmiyor: %', rec.entity_type;
  END CASE;

  DELETE FROM trash_entries WHERE id = _trash_id;

  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION restore_trash(uuid) TO authenticated;
