-- =============================================================================
-- HomeGuru PMS — migration 092
-- Region (label) isolation — Phase 1: foundation.
-- =============================================================================
-- A mülk can carry a `region` label (e.g. 'bornova'); a manager can be locked to
-- a region. A region-locked manager (a "Yönetici · Bornova") then sees ONLY that
-- region's mülkler — and, through the single chokepoint auth_sees_property(),
-- their reservations, temizlik, units and mülk lists too — while SUPER_ADMIN
-- still sees everything.
--
-- This phase is foundation only and is SAFE / ADDITIVE: every existing mülk and
-- staff row gets region = NULL, and the partition treats NULL = NULL as a match,
-- so today's behaviour is unchanged (NULL-region staff see NULL-region mülkler).
--
-- NOT yet isolated here (Phase 2): giderler (they scope by auth_property_id, not
-- the chokepoint) and the kasa (a DB-enforced singleton). So a region manager
-- must NOT be activated until Phase 2 — until then they'd still see HQ giderler
-- and the shared kasa.
-- =============================================================================

-- 1. Region label on mülkler. NULL = the main/HQ set.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS region text;
COMMENT ON COLUMN properties.region IS
  'Region/label, e.g. ''bornova''. NULL = main/HQ set. Partitions non-admin visibility via auth_sees_property().';

-- 2. The region a manager is locked to (matches properties.region). NULL = HQ
--    staff. SUPER_ADMIN ignores this entirely (sees all regions).
ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS region text;
COMMENT ON COLUMN staff_profiles.region IS
  'Region a staff member is locked to (matches properties.region). NULL = HQ/main. Ignored for SUPER_ADMIN.';

-- 3. Region-partition the chokepoint. Identical to migration 065 except the one
--    added line: a non-admin only sees a mülk whose region matches their own
--    (NULL IS NOT DISTINCT FROM NULL → HQ staff ↔ HQ mülkler; 'bornova' ↔
--    'bornova'; never across). SUPER_ADMIN short-circuits to TRUE as before.
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
        AND sp.region IS NOT DISTINCT FROM pr.region
        AND (
          sp.access_scope = 'ALL'
          OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
          OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
        )
    );
$$;

GRANT EXECUTE ON FUNCTION auth_sees_property(uuid) TO authenticated;
