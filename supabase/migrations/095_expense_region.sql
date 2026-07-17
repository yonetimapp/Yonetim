-- =============================================================================
-- HomeGuru PMS — migration 095
-- Region isolation — give giderler their own `region` (fixes genel gider RLS).
-- =============================================================================
-- 093 scoped giderler by their MÜLK's region (region_of_property). That breaks
-- for a GENEL (mülksüz) gider: it has no mülk, so its region was always NULL,
-- and a region manager (e.g. Bornova) could neither create nor see one —
-- "new row violates row-level security policy for table expenses".
--
-- Fix: every gider carries its own `region`, set by a trigger:
--   * mülk gider  -> the mülk's region (authoritative)
--   * genel gider -> an explicit region (admin Bölge picker) else the caller's
--                    own region
-- RLS then scopes on expenses.region directly. The kasa routing from 094 is
-- unaffected (it already sends a region manager's genel gider to their kasa via
-- the caller's region).
-- =============================================================================

-- 1. The column.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS region text;
COMMENT ON COLUMN expenses.region IS
  'Region this gider belongs to (matches properties.region). NULL = Ana Grup/HQ. '
  'Mülk gider inherits its mülk region; genel gider takes the creator''s region.';

-- 2. Backfill existing rows from their mülk (genel stay NULL = HQ — all current
--    genel giderler were created in the HQ context).
UPDATE expenses e
SET region = p.region
FROM properties p
WHERE e.property_id = p.id
  AND e.region IS DISTINCT FROM p.region;

-- 3. Keep region in sync on write.
CREATE OR REPLACE FUNCTION set_expense_region()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.property_id IS NOT NULL THEN
    -- a mülk gider always inherits its mülk's region
    NEW.region := (SELECT region FROM properties WHERE id = NEW.property_id);
  ELSE
    -- a genel gider: an explicit region (admin picker) wins, else it belongs
    -- to the caller's own region
    NEW.region := COALESCE(NEW.region, auth_region());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_set_region ON expenses;
CREATE TRIGGER expenses_set_region
  BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_expense_region();

-- 4. Re-scope the gider RLS on expenses.region (replaces the region_of_property
--    checks from 093). The BEFORE trigger sets region first, so WITH CHECK sees
--    the resolved value.
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'YETKILI' AND created_by = auth.uid())
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

DROP POLICY IF EXISTS expenses_insert ON expenses;
CREATE POLICY expenses_insert ON expenses FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
    OR (
      auth_role() = 'YETKILI'
      AND approval_status = 'pending'
      AND region IS NOT DISTINCT FROM auth_region()
    )
  );

DROP POLICY IF EXISTS expenses_update ON expenses;
CREATE POLICY expenses_update ON expenses FOR UPDATE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

DROP POLICY IF EXISTS expenses_delete ON expenses;
CREATE POLICY expenses_delete ON expenses FOR DELETE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

-- 5. Make the kasa routing (094) honour the gider's OWN region. A genel gider
--    is approved by the SUPER_ADMIN, so resolving its kasa from the *caller's*
--    region (094) would wrongly send a Bornova manager's genel gider to the HQ
--    kasa. Route by the linked gider's stored region instead — which already
--    equals the mülk's region for mülk giderler.
CREATE OR REPLACE FUNCTION route_cash_tx_to_region_kasa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _region    text;
  _resolved  boolean := false;
BEGIN
  -- Work out the region this movement belongs to.
  IF NEW.property_id IS NOT NULL THEN
    _region := (SELECT region FROM properties WHERE id = NEW.property_id);
    _resolved := true;
  ELSIF NEW.ref_type = 'expense' AND NEW.ref_id IS NOT NULL THEN
    -- gider (incl. genel + recurring): use the gider's own region
    SELECT region INTO _region FROM expenses WHERE id = NEW.ref_id;
    _resolved := true;
  ELSIF NEW.ref_type = 'payment_collection' AND NEW.ref_id IS NOT NULL THEN
    SELECT region_of_property(property_id) INTO _region
      FROM payment_collections WHERE id = NEW.ref_id;
    _resolved := true;
  END IF;

  -- No mülk / gider / tahsilat behind it (avans, maaş, manuel) → caller's region.
  IF NOT _resolved THEN
    _region := auth_region();
  END IF;

  -- Pin the kasa for that region, falling back to the main/HQ kasa.
  NEW.cash_account_id := COALESCE(
    (SELECT id FROM cash_accounts WHERE region IS NOT DISTINCT FROM _region LIMIT 1),
    (SELECT id FROM cash_accounts WHERE region IS NULL LIMIT 1)
  );
  RETURN NEW;
END;
$$;
