-- =============================================================================
-- HomeGuru PMS — migration 100
-- Add "Personel Bornova" (PERSONEL_BORNOVA) — the Personel (YETKILI) role scoped
-- to the Bornova region. Same shape as YONETICI_BORNOVA (098).
-- =============================================================================
-- PERSONEL_BORNOVA behaves exactly as YETKILI but only within Bornova:
--   * auth_role()   normalises PERSONEL_BORNOVA -> YETKILI (every permission /
--     RLS check + the tahsilat functions treat them as a Personel).
--   * auth_region() derives 'bornova' from the role, so all isolation applies.
-- The tahsilat functions already source _caller_role from auth_role() (098) and
-- already handle YETKILI, so they need no change.
-- =============================================================================

ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YONETICI_BORNOVA',
                  'RECEPTION', 'HOUSEKEEPING', 'YETKILI', 'PERSONEL_BORNOVA',
                  'PENDING'));

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
           ELSE role
         END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

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
