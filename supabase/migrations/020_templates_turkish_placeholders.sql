-- =============================================================================
-- HomeGuru PMS — migration 020
-- Normalize message_templates content to use Turkish placeholder names.
-- =============================================================================
-- The original 005_seed.sql template used English placeholders ({checkin},
-- {checkout}, {property}, {unit}). The substitution layer accepts both
-- English aliases and Turkish canonicals, but stored content should use
-- the canonical Turkish names so the UI is consistent with the rest of
-- the product (which is Turkish).
--
-- Idempotent: REPLACE is a no-op when the source token is absent, so
-- re-running this migration causes no further changes.

UPDATE message_templates
SET content = REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(content, '{checkin}',  '{giris_tarihi}'),
                    '{checkout}',                   '{cikis_tarihi}'
                  ),
                  '{property}',                     '{mulk_adi}'
                ),
                '{unit}',                           '{birim_adi}'
              )
WHERE content LIKE '%{checkin}%'
   OR content LIKE '%{checkout}%'
   OR content LIKE '%{property}%'
   OR content LIKE '%{unit}%';
