-- =============================================================================
-- Yönetim PMS — migration 124
-- Regions become a first-class, admin-managed entity (data model).
-- =============================================================================
-- Re-release change #2, part 1 of 2 (structure; 125 = behaviour/RPCs).
--
-- BEFORE (migrations 092–121): "region" was a free-text label on properties /
-- staff_profiles / cash_accounts / expenses, with NULL meaning HQ/"Genel" and a
-- single hardcoded extra value 'bornova'. There was no table of regions, no way
-- for the Yönetici to create one, and region access was derived from the ROLE
-- (YONETICI_BORNOVA / PERSONEL_BORNOVA).
--
-- AFTER: a real `regions` table the Yönetici manages. Region stays TEXT keyed to
-- `regions.name` (FK, ON UPDATE CASCADE so a rename fans out) — deliberately
-- minimal so the proven text-based RLS + money-routing helpers keep working. The
-- implicit NULL="Genel" becomes an explicit default region 'Genel'; the seeded
-- 'bornova' kasa is removed. Staff region access is decoupled from the role via a
-- new `all_regions` flag (see 125 for the helper/RPC rewrites).
--
-- Fresh-DB note: the new operator has NO data — the only region-carrying rows are
-- the two seeded kasa (Genel = NULL, Bornova = 'bornova') and the bootstrap
-- SUPER_ADMIN. The backfills below are therefore near-empty in practice but are
-- written to be correct for any state.
-- =============================================================================

-- 1. The regions table. `name` is the natural key every other table references.
CREATE TABLE IF NOT EXISTS regions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- At most one default region.
CREATE UNIQUE INDEX IF NOT EXISTS regions_one_default ON regions (is_default) WHERE is_default;

-- Seed the default region. 'Genel' replaces the old implicit NULL = HQ concept.
INSERT INTO regions (name, is_default)
VALUES ('Genel', true)
ON CONFLICT (name) DO NOTHING;

-- 2. Staff region access is now data-driven, orthogonal to the role:
--    all_regions = true  → sees/works every region (visibility only).
--    all_regions = false → scoped to their home region (staff_profiles.region).
--    Home region also decides which kasa pays their maaş/avans (staff_region()).
ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS all_regions boolean NOT NULL DEFAULT false;

-- Preserve today's all-region users: SUPER_ADMIN + Teknik (all regions by design)
-- and any plain PROPERTY_MANAGER that was all-region (old signal: region IS NULL).
-- The two Bornova roles (region = 'bornova') are intentionally NOT all-region.
UPDATE staff_profiles
   SET all_regions = true
 WHERE role IN ('SUPER_ADMIN', 'TEKNIK_PERSONEL')
    OR (role = 'PROPERTY_MANAGER' AND region IS NULL);

-- 3. Drop the seeded 'bornova' kasa (the new operator has no Bornova). Delete any
--    dependent rows first so the ON DELETE RESTRICT FKs don't block it. On a fresh
--    DB the Bornova kasa has no transactions, so these are no-ops.
DELETE FROM cash_transactions
 WHERE cash_account_id IN (SELECT id FROM cash_accounts WHERE region = 'bornova');
UPDATE staff_salary_payments
   SET cash_account_id = NULL
 WHERE cash_account_id IN (SELECT id FROM cash_accounts WHERE region = 'bornova');
DELETE FROM cash_accounts WHERE region = 'bornova';

-- 4. Collapse NULL (HQ) and any residual 'bornova' labels onto the default 'Genel'
--    region across every region-carrying table, so all values are valid FK targets.
UPDATE cash_accounts   SET region = 'Genel' WHERE region IS NULL OR region = 'bornova';
UPDATE properties      SET region = 'Genel' WHERE region IS NULL OR region = 'bornova';
UPDATE staff_profiles  SET region = 'Genel' WHERE region IS NULL OR region = 'bornova';
UPDATE expenses        SET region = 'Genel' WHERE region IS NULL OR region = 'bornova';

-- Convention: a kasa is named exactly after its region. Rename the pre-existing
-- default kasa ('Genel Kasa' from migration 036) to just 'Genel'.
UPDATE cash_accounts SET name = 'Genel' WHERE region = 'Genel' AND name = 'Genel Kasa';

-- 5. Region is now mandatory and defaults to 'Genel'; enforce referential
--    integrity to regions(name). ON UPDATE CASCADE makes rename_region() (125)
--    a single-row update that fans out to every reference.
ALTER TABLE cash_accounts  ALTER COLUMN region SET DEFAULT 'Genel';
ALTER TABLE properties     ALTER COLUMN region SET DEFAULT 'Genel';
ALTER TABLE staff_profiles ALTER COLUMN region SET DEFAULT 'Genel';
-- expenses.region deliberately gets NO default: set_expense_region() (migration
-- 095) resolves it in a BEFORE trigger — from the mülk, else
-- COALESCE(NEW.region, auth_region()) so a region manager's genel gider lands in
-- THEIR region. A column default would arrive as 'Genel' before the trigger and
-- defeat that COALESCE. NOT NULL is still satisfied because the trigger always
-- populates it (constraints are checked after BEFORE triggers).

ALTER TABLE cash_accounts  ALTER COLUMN region SET NOT NULL;
ALTER TABLE properties     ALTER COLUMN region SET NOT NULL;
ALTER TABLE staff_profiles ALTER COLUMN region SET NOT NULL;
ALTER TABLE expenses       ALTER COLUMN region SET NOT NULL;

-- Each FK is dropped first so this migration survives a re-run: Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS, and a bare ADD on the second pass aborts the file
-- half-applied.
ALTER TABLE cash_accounts  DROP CONSTRAINT IF EXISTS cash_accounts_region_fk;
ALTER TABLE cash_accounts
  ADD CONSTRAINT cash_accounts_region_fk
  FOREIGN KEY (region) REFERENCES regions(name) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE properties     DROP CONSTRAINT IF EXISTS properties_region_fk;
ALTER TABLE properties
  ADD CONSTRAINT properties_region_fk
  FOREIGN KEY (region) REFERENCES regions(name) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE staff_profiles DROP CONSTRAINT IF EXISTS staff_profiles_region_fk;
ALTER TABLE staff_profiles
  ADD CONSTRAINT staff_profiles_region_fk
  FOREIGN KEY (region) REFERENCES regions(name) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE expenses       DROP CONSTRAINT IF EXISTS expenses_region_fk;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_region_fk
  FOREIGN KEY (region) REFERENCES regions(name) ON UPDATE CASCADE ON DELETE RESTRICT;

-- The one-kasa-per-region rule from migration 094 (unique on COALESCE(region,''))
-- still holds; with region now NOT NULL it is effectively UNIQUE(region).

-- 6. RLS: any authenticated user may READ the region list (needed by pickers on
--    the Mülk form, the staff screen, and the Bölgeler tab). All writes go through
--    the SECURITY DEFINER RPCs in 125 (SUPER_ADMIN only) — no direct-write policy.
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS regions_select ON regions;
CREATE POLICY regions_select ON regions FOR SELECT
  USING (auth.uid() IS NOT NULL);

GRANT SELECT ON regions TO authenticated;
