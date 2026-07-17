-- =============================================================================
-- HomeGuru PMS — migration 117
-- Rename TEKNIK_PERSONEL_BORNOVA → TEKNIK_PERSONEL and make it an ALL-REGIONS role.
-- =============================================================================
-- The technical/issue role is no longer Bornova-scoped: it sees every property in
-- every region (Ana Grup + Bornova) and is notified of every new issue. It stays
-- deliberately narrow otherwise (read-only reservation Liste + issue reporting; no
-- finance / guest-PII / property / staff; UI gating unchanged).
--
-- Server model: auth_role() still normalises it to HOUSEKEEPING, but it is NO
-- longer given a region (auth_region() → NULL) — instead it gets a top-level
-- "sees every property" bypass in auth_sees_property (like SUPER_ADMIN, but only
-- for property visibility). Finance stays hidden because the kasa/gider policies
-- gate on auth_sees_all_regions()/PROPERTY_MANAGER, which still exclude it.
--
-- Idempotent-ish: assumes migrations 114–116 are applied. Migrates existing rows.
-- =============================================================================

-- 1. Rename the role value + clear its (now-vestigial) Bornova region marker.
ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
UPDATE staff_profiles
   SET role = 'TEKNIK_PERSONEL', region = NULL
 WHERE role = 'TEKNIK_PERSONEL_BORNOVA';
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YONETICI_BORNOVA',
                  'RECEPTION', 'HOUSEKEEPING', 'YETKILI', 'PERSONEL_BORNOVA',
                  'TEKNIK_PERSONEL', 'PENDING'));

-- 2. auth_role() — normalise the renamed role to HOUSEKEEPING.
CREATE OR REPLACE FUNCTION auth_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN role = 'YONETICI_BORNOVA' THEN 'PROPERTY_MANAGER'
           WHEN role = 'PERSONEL_BORNOVA' THEN 'YETKILI'
           WHEN role = 'TEKNIK_PERSONEL' THEN 'HOUSEKEEPING'
           ELSE role
         END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- 3. auth_region() — Teknik is no longer region-scoped; only the two Bornova
--    roles derive 'bornova' now.
CREATE OR REPLACE FUNCTION auth_region()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA') THEN 'bornova'
           ELSE NULL
         END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- 4. staff_region() — Teknik's avans/maaş route to HQ (NULL), so it is dropped
--    from the Bornova set here too.
CREATE OR REPLACE FUNCTION staff_region(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA') THEN 'bornova'
              ELSE NULL END
  FROM staff_profiles WHERE user_id = p_user_id;
$$;

-- 5. auth_sees_property() — Teknik sees EVERY property (all regions, all scopes),
--    added as a role bypass inside the EXISTS. Everything else verbatim from 102.
--    Finance is unaffected (those policies don't use auth_sees_property).
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
          sp.role = 'TEKNIK_PERSONEL'
          OR (
            (auth_sees_all_regions() OR auth_region() IS NOT DISTINCT FROM pr.region)
            AND (
              sp.access_scope = 'ALL'
              OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
              OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
            )
          )
        )
    );
$$;
GRANT EXECUTE ON FUNCTION auth_sees_property(uuid) TO authenticated;

-- 6. staff_profiles_select — Teknik is a global (HQ-level) role now, so it is
--    removed from the Bornova-manager visibility clause. It is seen by the
--    all-regions roles (SUPER_ADMIN + Alt Yönetici via auth_sees_all_regions()).
DROP POLICY IF EXISTS staff_profiles_select ON staff_profiles;
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_sees_all_regions()
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() = 'bornova'
      AND role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA')
    )
  );

-- 7. _notify_new_issue — Teknik now handles every region, so notify it on EVERY
--    issue (not just Bornova). Managers stay region-aware via _region_manager_roles.
CREATE OR REPLACE FUNCTION _notify_new_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  unit_name           text;
  property_name       text;
  issue_region        text;
  guest_name          text;
  res_creator_name    text;
  reporter_name       text;
  body                text;
BEGIN
  SELECT u.name, p.name, p.region
    INTO unit_name, property_name, issue_region
  FROM units u
  JOIN properties p ON p.id = u.property_id
  WHERE u.id = NEW.unit_id;

  SELECT g.full_name, sp.full_name
    INTO guest_name, res_creator_name
  FROM reservations r
  LEFT JOIN guests g ON g.id = r.guest_id
  LEFT JOIN staff_profiles sp ON sp.user_id = r.created_by
  WHERE r.unit_id = NEW.unit_id
    AND r.status = 'active'
  ORDER BY r.stay_start DESC
  LIMIT 1;

  SELECT full_name INTO reporter_name
  FROM staff_profiles WHERE user_id = NEW.reported_by;

  body :=
    COALESCE(property_name, '') ||
    CASE WHEN property_name IS NOT NULL AND unit_name IS NOT NULL THEN ' / ' ELSE '' END ||
    COALESCE(unit_name, '') ||
    COALESCE(' · ' || guest_name, '') ||
    E'\nSorun: ' || left(NEW.description, 100) ||
    COALESCE(E'\nRezervasyonu açan: ' || res_creator_name, '') ||
    COALESCE(E'\nSorunu açan: ' || reporter_name, '');

  PERFORM _send_push_async(
    _region_manager_roles(issue_region) || ARRAY['TEKNIK_PERSONEL']::text[],
    'Yeni sorun bildirimi',
    body,
    '/housekeeping',
    'issue',
    'new_issue',
    jsonb_build_object('id', NEW.id, 'unit_id', NEW.unit_id)
  );
  RETURN NEW;
END;
$$;

-- 8. Guest / companion PII deny guard — updated to the renamed role (verbatim
--    from migration 116 otherwise).
CREATE OR REPLACE FUNCTION get_guest_decrypted(_id uuid)
RETURNS TABLE(
  id                uuid,
  full_name         text,
  tc_kimlik         text,
  passport          text,
  phone             text,
  email             text,
  address           text,
  nationality       text,
  is_problematic    boolean,
  problematic_note  text,
  consent_given_at  timestamptz,
  consent_version   text,
  created_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
       = 'TEKNIK_PERSONEL' THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    auth_role() = 'SUPER_ADMIN'
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = _id
        AND auth_sees_property(r.property_id)
    )
  ) THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  PERFORM _audit_guest_decrypt(_id);

  RETURN QUERY
  SELECT
    g.id,
    g.full_name,
    decrypt_sensitive(g.tc_kimlik_encrypted),
    decrypt_sensitive(g.passport_encrypted),
    g.phone,
    g.email,
    g.address,
    g.nationality,
    g.is_problematic,
    g.problematic_note,
    g.consent_given_at,
    g.consent_version,
    g.created_at
  FROM guests g
  WHERE g.id = _id;
END;
$$;

CREATE OR REPLACE FUNCTION get_companions_decrypted(_guest_id uuid)
RETURNS TABLE(
  id uuid,
  guest_id uuid,
  full_name text,
  relationship text,
  birth_date date,
  nationality text,
  tc_kimlik text,
  passport text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
       = 'TEKNIK_PERSONEL' THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    auth_role() = 'SUPER_ADMIN'
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = _guest_id
        AND auth_sees_property(r.property_id)
    )
  ) THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM guest_companions gc WHERE gc.guest_id = _guest_id) THEN
    PERFORM _audit_guest_decrypt(_guest_id);
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.guest_id,
    c.full_name,
    c.relationship,
    c.birth_date,
    c.nationality,
    decrypt_sensitive(c.tc_kimlik_encrypted),
    decrypt_sensitive(c.passport_encrypted),
    c.created_at
  FROM guest_companions c
  WHERE c.guest_id = _guest_id
  ORDER BY c.created_at;
END;
$$;
