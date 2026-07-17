-- =============================================================================
-- HomeGuru PMS — migration 019
-- Per-unit photo catalog URL for WhatsApp `{katalog_link}` template variable.
-- =============================================================================
-- Stores an external link (Google Drive, Dropbox, etc.) to the unit's photo
-- gallery so reception/housekeeping can paste it into WhatsApp messages via
-- the {katalog_link} (alias: {catalog}) placeholder.
--
-- Nullable, plaintext. No RLS change needed — covered by existing units policies.

ALTER TABLE units
  ADD COLUMN catalog_url text;

-- Light sanity check: if a value is set it must look like an http(s) URL.
-- (Length-bounded to prevent abuse; the UI also enforces type="url".)
ALTER TABLE units
  ADD CONSTRAINT units_catalog_url_format_chk
    CHECK (
      catalog_url IS NULL
      OR (
        catalog_url ~* '^https?://'
        AND char_length(catalog_url) <= 1000
      )
    );

COMMENT ON COLUMN units.catalog_url IS
  'Optional external photo gallery link for this unit. Used by WhatsApp templates as {katalog_link}.';
