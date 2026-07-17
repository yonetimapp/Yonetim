-- =============================================================================
-- Yönetim PMS — migration 126
-- Roles → the final 7. Drop the two hardcoded Bornova role variants.
-- =============================================================================
-- Re-release change #5. Region access is now a per-user assignment (all_regions
-- flag + home region, migrations 124–125), so the region-baked-into-the-role
-- variants YONETICI_BORNOVA / PERSONEL_BORNOVA are removed. The final set:
--   SUPER_ADMIN, PROPERTY_MANAGER, RECEPTION, HOUSEKEEPING, YETKILI,
--   TEKNIK_PERSONEL, PENDING.
--
-- Signups already default to PENDING (migration 032) — unchanged here (change #6
-- is satisfied by the proven chain).
--
-- Fresh-DB note: the new operator has no Bornova-role rows, so the folds below are
-- no-ops; they exist so this migration is correct on any state.
-- =============================================================================

-- 1. Fold any Bornova-role rows into their base role before the CHECK tightens.
--    (region/all_regions were already normalised in migration 124.)
UPDATE staff_profiles SET role = 'PROPERTY_MANAGER' WHERE role = 'YONETICI_BORNOVA';
UPDATE staff_profiles SET role = 'YETKILI'          WHERE role = 'PERSONEL_BORNOVA';

-- 2. Tighten the role CHECK to the final 7 (keep TEKNIK_PERSONEL + PENDING).
ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN (
    'SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING',
    'YETKILI', 'TEKNIK_PERSONEL', 'PENDING'
  ));

-- 3. auth_role(): drop the Bornova normalisations. Keep TEKNIK_PERSONEL →
--    HOUSEKEEPING (the narrow technical role still acts as a housekeeper for
--    permission checks; its all-region visibility is handled in auth_sees_property).
CREATE OR REPLACE FUNCTION auth_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN role = 'TEKNIK_PERSONEL' THEN 'HOUSEKEEPING' ELSE role END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- Dead references to 'YONETICI_BORNOVA' / 'PERSONEL_BORNOVA' remain in some
-- policies/functions from the 001–123 chain; they are now unreachable string
-- literals (no row can hold those roles) and are intentionally left untouched to
-- keep this change minimal. The end state is correct: those roles cannot exist.
