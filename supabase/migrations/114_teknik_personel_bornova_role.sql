-- =============================================================================
-- HomeGuru PMS — migration 114
-- Add "Teknik Personel Bornova" (TEKNIK_PERSONEL_BORNOVA) — a narrow technical
-- staff role scoped to the Bornova region.
-- =============================================================================
-- Unlike YONETICI_BORNOVA (098) / PERSONEL_BORNOVA (100), which are region-scoped
-- clones of an existing base role, Teknik Personel is a deliberately RESTRICTED
-- role: read-only reservation Liste + issue reporting only. Server posture:
--   * auth_role()   normalises TEKNIK_PERSONEL_BORNOVA -> 'HOUSEKEEPING', so it
--     inherits HOUSEKEEPING's locked-down RLS (region reservation/issue reads via
--     auth_sees_property; no reservation writes, no finance, no staff).
--   * auth_region() derives 'bornova' from the role, so all region isolation
--     (mülk / rezervasyon / temizlik / guests / kasa) applies.
--   * staff_region() resolves 'bornova' so its avans/maaş route to the Bornova
--     kasa and a Bornova manager can see it in the Personel list.
--   * _notify_new_issue() pushes "Yeni sorun bildirimi" to this role — but only
--     for Bornova-region issues (region isolation preserved).
-- The UI further narrows what it sees; that hiding is UX, the RLS above is the
-- boundary. Cleaning-status write and apartment payment-collect remain technically
-- reachable (inherited from HOUSEKEEPING, region-bounded, no UI path) — a known,
-- documented residual, not a leak beyond HOUSEKEEPING's vetted scope.
-- =============================================================================

-- 1. Allow the new role value.
ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YONETICI_BORNOVA',
                  'RECEPTION', 'HOUSEKEEPING', 'YETKILI', 'PERSONEL_BORNOVA',
                  'TEKNIK_PERSONEL_BORNOVA', 'PENDING'));

-- 2. auth_role() — normalise the new role to HOUSEKEEPING (every RLS / permission
--    check treats it as a housekeeper). Mirrors 110 + the new WHEN.
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
           WHEN role = 'TEKNIK_PERSONEL_BORNOVA' THEN 'HOUSEKEEPING'
           ELSE role
         END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- 3. auth_region() — derive 'bornova' for every Bornova-scoped role.
CREATE OR REPLACE FUNCTION auth_region()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA',
                         'TEKNIK_PERSONEL_BORNOVA') THEN 'bornova'
           ELSE NULL
         END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- 4. staff_region(user) — region of the RECIPIENT staff (avans/maaş routing, 112).
--    Hardcoded role list (does not call auth_region), so the new role is added here.
CREATE OR REPLACE FUNCTION staff_region(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA',
                            'TEKNIK_PERSONEL_BORNOVA') THEN 'bornova'
              ELSE NULL END
  FROM staff_profiles WHERE user_id = p_user_id;
$$;

-- 5. Keep the (vestigial) region column consistent with the role (110 pattern).
UPDATE staff_profiles
   SET region = CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA',
                                   'TEKNIK_PERSONEL_BORNOVA')
                     THEN 'bornova' ELSE NULL END
 WHERE region IS DISTINCT FROM (CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA',
                                                   'TEKNIK_PERSONEL_BORNOVA')
                                     THEN 'bornova' ELSE NULL END);

-- 6. Personel list visibility (109) — a Yönetici Bornova sees Bornova staff,
--    now including Teknik Personel. (Teknik itself has no staff-list access.)
DROP POLICY IF EXISTS staff_profiles_select ON staff_profiles;
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_sees_all_regions()
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() = 'bornova'
      AND role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA', 'TEKNIK_PERSONEL_BORNOVA')
    )
  );

-- 7. New-issue push — region-aware. SUPER_ADMIN + PROPERTY_MANAGER (the all-region
--    viewers: Süper Admin + Alt Yönetici) get every issue, as before. For a
--    BORNOVA issue we additionally notify TEKNIK_PERSONEL_BORNOVA. Conditioning on
--    the issue's region keeps Ana Grup issues from notifying Bornova staff.
--    Recipients are resolved by the RAW role column in the Edge Function, so the
--    literal role is required here. Body unchanged from migration 070.
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

  -- Most recently started active reservation on this unit, if any.
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
    CASE WHEN issue_region = 'bornova'
         THEN ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER', 'TEKNIK_PERSONEL_BORNOVA']
         ELSE ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER'] END::text[],
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
