-- =============================================================================
-- HomeGuru PMS — migration 110  (FIX)
-- auth_region()/auth_role() must derive region from the ROLE, not the column.
-- =============================================================================
-- Symptom: a Yönetici Bornova whose staff_profiles.region column is NULL (the
-- role dropdown never sets it) was treated as "all regions" and saw both kasas.
-- Root cause: the live auth_region() was still reading the region COLUMN (the
-- pre-098 version) instead of deriving 'bornova' from the role. This re-applies
-- the role-derived definitions (idempotent) and syncs the vestigial column so
-- nothing that still reads it can be wrong.
-- =============================================================================

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

-- Keep the (now-vestigial) region column consistent with the role.
UPDATE staff_profiles
   SET region = CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA')
                     THEN 'bornova' ELSE NULL END
 WHERE region IS DISTINCT FROM (CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA')
                                     THEN 'bornova' ELSE NULL END);
