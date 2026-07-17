-- =============================================================================
-- Yönetim PMS — migration 128
-- Restrict photo uploads: mülk 1, sorun 1, birim removed (+ public gallery).
-- =============================================================================
-- Re-release change #4 (DB side; the frontend pickers + gallery page/route are
-- removed separately).
--   • properties.photo_paths  : cap 20 → 1.
--   • housekeeping_issues.photo_paths : add a cap of 1 (had none).
--   • units.photo_paths       : dropped entirely, along with the public unit
--     gallery RPC it fed. units.catalog_url is KEPT — {katalog_link} now resolves
--     to the manually-pasted catalog URL only.
-- Storage buckets are created in the dashboard: property-photos + housekeeping-
-- issues stay; the unit-photos bucket is simply no longer created/used.
-- =============================================================================

-- 1. Mülk: exactly one photo. Truncate any extras first (no-op on a fresh DB),
--    then swap the ≤20 check for ≤1.
UPDATE properties SET photo_paths = photo_paths[1:1] WHERE array_length(photo_paths, 1) > 1;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_photo_paths_size_chk;
ALTER TABLE properties ADD CONSTRAINT properties_photo_paths_size_chk
  CHECK (array_length(photo_paths, 1) IS NULL OR array_length(photo_paths, 1) <= 1);

-- 2. Sorun: at most one photo (there was no cap before).
UPDATE housekeeping_issues SET photo_paths = photo_paths[1:1] WHERE array_length(photo_paths, 1) > 1;
ALTER TABLE housekeeping_issues DROP CONSTRAINT IF EXISTS housekeeping_issues_photo_paths_size_chk;
ALTER TABLE housekeeping_issues ADD CONSTRAINT housekeeping_issues_photo_paths_size_chk
  CHECK (array_length(photo_paths, 1) IS NULL OR array_length(photo_paths, 1) <= 1);

-- 3. Birim: remove the photo feature and the public gallery it powered.
--    Drop the gallery RPC first, then the column. catalog_url stays.
DROP FUNCTION IF EXISTS get_public_unit_gallery(uuid);
ALTER TABLE units DROP COLUMN IF EXISTS photo_paths;  -- also drops units_photo_paths_size_chk
