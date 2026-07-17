-- =============================================================================
-- HomeGuru PMS — migration 023
-- Per-unit photo gallery (max 10 per oda/daire, enforced client-side).
-- =============================================================================
-- Mirrors the pattern set in migration 022 for properties. Each unit (hotel
-- room or standalone apartment) can hold up to ten gallery photos in addition
-- to its optional external catalog_url.
--
-- Storage bucket "unit-photos" must be created manually in the Supabase
-- dashboard (Storage → New bucket → name: unit-photos, Public: YES) and an
-- INSERT + DELETE policy added for authenticated users on storage.objects
-- WHERE bucket_id = 'unit-photos'. Same one-time setup as property-photos.

ALTER TABLE units
  ADD COLUMN photo_paths text[] NOT NULL DEFAULT '{}';

ALTER TABLE units
  ADD CONSTRAINT units_photo_paths_size_chk
    CHECK (array_length(photo_paths, 1) IS NULL OR array_length(photo_paths, 1) <= 20);

COMMENT ON COLUMN units.photo_paths IS
  'Supabase Storage paths (bucket: unit-photos) for the unit gallery. Up to 10 by UI convention; DB cap is 20 as defense-in-depth.';
