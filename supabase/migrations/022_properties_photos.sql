-- =============================================================================
-- HomeGuru PMS — migration 022
-- Photo gallery on properties (max 10 per mülk, enforced client-side).
-- =============================================================================
-- Stores Supabase Storage paths (uuid.jpg) for each property's photo gallery.
-- Mirrors the pattern used by housekeeping_issues.photo_paths.
--
-- Storage bucket "property-photos" must be created manually in the Supabase
-- dashboard (Storage → New bucket → name: property-photos, Public: YES)
-- before this feature works end-to-end. Photos are PUBLIC by design — they're
-- meant to be shared with prospective guests via WhatsApp deep links.

ALTER TABLE properties
  ADD COLUMN photo_paths text[] NOT NULL DEFAULT '{}';

-- Defensive cap on array length so a buggy client or rogue caller can't
-- bloat the column unbounded. UI limit is 10; we leave a small headroom.
ALTER TABLE properties
  ADD CONSTRAINT properties_photo_paths_size_chk
    CHECK (array_length(photo_paths, 1) IS NULL OR array_length(photo_paths, 1) <= 20);

COMMENT ON COLUMN properties.photo_paths IS
  'Supabase Storage paths (bucket: property-photos) for the mülk gallery. Up to 10 by UI convention; DB cap is 20 as defense-in-depth.';
