-- =============================================================================
-- HomeGuru PMS — migration 101  (BUGFIX)
-- auth_sees_property must derive the caller's region from auth_region(), not the
-- stale staff_profiles.region column.
-- =============================================================================
-- 098/100 moved the region source-of-truth to the ROLE (YONETICI_BORNOVA /
-- PERSONEL_BORNOVA), with auth_region() deriving 'bornova' from it. But
-- auth_sees_property (092) still compared the staff_profiles.region COLUMN, which
-- is NOT set when you assign the role from the staff form. The effect for a
-- newly-assigned Bornova user (region column NULL): they'd match HQ mülkler and
-- NOT Bornova ones — region isolation inverted. Switch the check to auth_region()
-- so it matches every other region-scoped policy (kasa, giderler, approvals),
-- which already use auth_region(). No behaviour change for SUPER_ADMIN or for a
-- plain PROPERTY_MANAGER (auth_region() = NULL = their column).
-- =============================================================================

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
        AND auth_region() IS NOT DISTINCT FROM pr.region
        AND (
          sp.access_scope = 'ALL'
          OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
          OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
        )
    );
$$;

GRANT EXECUTE ON FUNCTION auth_sees_property(uuid) TO authenticated;
