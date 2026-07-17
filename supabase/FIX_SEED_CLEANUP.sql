-- =============================================================================
-- ONE-TIME fixup for the new operator's Supabase — run in the SQL editor, ONCE,
-- then re-run `supabase db push`.
-- =============================================================================
-- What happened: `db push` applied migrations 001–093 and failed at 094
-- ("could not create unique index cash_accounts_one_per_region"). Migration
-- 005 seeded HomeGuru dev sample data (2 properties, 4 units, 6 per-property
-- kasa); because those kasa rows existed, 036 skipped creating its single
-- 'Genel Kasa', and 094's one-kasa-per-region index found 6 NULL-region rows.
--
-- This script removes the sample data and recreates the exact state 036
-- produces on a clean database (one general kasa). 005 itself is now a no-op
-- in the repo, so this can never happen again on a fresh project.
--
-- Safe to run: at this point the database contains ONLY seed data (plus your
-- bootstrap admin in staff_profiles/auth, which is not touched).
-- =============================================================================

BEGIN;

-- 1. Kasa movements first — cash_transactions → cash_accounts is ON DELETE
--    RESTRICT, so any row here would block the cascade below. (Expected: 0.)
DELETE FROM cash_transactions;

-- 2. Seeded properties — cascades the 4 units and all 6 per-property kasa.
DELETE FROM properties;

-- 3. Safety net (should already be empty after the cascade).
DELETE FROM cash_accounts;

-- 4. Recreate what 036 creates on a clean slate: the single general kasa.
--    (036's singleton trigger allows this insert because the table is empty.)
INSERT INTO cash_accounts (property_id, name, account_type, currency)
VALUES (NULL, 'Genel Kasa', 'CASH', 'TRY');

-- 5. The seeded WhatsApp template (old operator's branded text).
DELETE FROM message_templates;

-- 6. Trash snapshots created by the deletes above (delete-capture triggers
--    fire on cascaded deletes too).
DELETE FROM trash_entries;

COMMIT;

-- Verify: must return exactly 1 row — 'Genel Kasa', region NULL.
SELECT id, name, region FROM cash_accounts;
