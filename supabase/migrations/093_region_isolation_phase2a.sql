-- =============================================================================
-- HomeGuru PMS — migration 093
-- Region isolation — Phase 2a: kasa + giderler VISIBILITY (RLS only).
-- =============================================================================
-- Phase 1 isolated mülk/rezervasyon/temizlik (everything that flows through
-- auth_sees_property — incl. tahsilat + cari). This phase stops a region
-- manager from seeing the HQ kasa and HQ giderler:
--
--   * cash_accounts grows a `region` column (HQ kasa = NULL). A manager sees
--     only their region's kasa; SUPER_ADMIN sees all.
--   * cash_transactions are scoped by their kasa's region.
--   * giderler are scoped by their mülk's region (general/mülksüz = HQ region).
--
-- NO Bornova kasa is created here and NO money routing changes — so the single
-- existing kasa stays unambiguous. Right now a Bornova manager therefore sees an
-- EMPTY kasa + no giderler (the leak is closed). Phase 2b creates the Bornova
-- kasa and routes new Bornova money into it.
-- =============================================================================

-- 1. region on the kasa. The existing general kasa keeps region = NULL (HQ).
ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS region text;
COMMENT ON COLUMN cash_accounts.region IS
  'Region this kasa belongs to (matches properties.region). NULL = main/HQ kasa.';

-- 2. Helpers: the caller's region, and a mülk's region (both NULL-safe).
CREATE OR REPLACE FUNCTION auth_region()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT region FROM staff_profiles
   WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION auth_region() TO authenticated;

CREATE OR REPLACE FUNCTION region_of_property(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT region FROM properties WHERE id = p_id;
$$;
GRANT EXECUTE ON FUNCTION region_of_property(uuid) TO authenticated;

-- 3. cash_accounts: a manager sees only their region's kasa.
DROP POLICY IF EXISTS cash_accounts_select ON cash_accounts;
CREATE POLICY cash_accounts_select ON cash_accounts FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

-- 4. cash_transactions: scope by the transaction's kasa region.
DROP POLICY IF EXISTS cash_tx_select ON cash_transactions;
CREATE POLICY cash_tx_select ON cash_transactions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM cash_accounts ca
        WHERE ca.id = cash_transactions.cash_account_id
          AND ca.region IS NOT DISTINCT FROM auth_region()
      )
    )
  );

-- 5. giderler: a manager sees/edits only their region's giderler (general =
--    HQ region NULL). YETKILI still sees only its own submissions. Mirrors the
--    role gates of migration 064, with the region match added per role.
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'YETKILI' AND created_by = auth.uid())
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() IS NOT DISTINCT FROM region_of_property(property_id)
    )
  );

DROP POLICY IF EXISTS expenses_insert ON expenses;
CREATE POLICY expenses_insert ON expenses FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() IS NOT DISTINCT FROM region_of_property(property_id)
    )
    OR (
      auth_role() = 'YETKILI'
      AND approval_status = 'pending'
      AND auth_region() IS NOT DISTINCT FROM region_of_property(property_id)
    )
  );

DROP POLICY IF EXISTS expenses_update ON expenses;
CREATE POLICY expenses_update ON expenses FOR UPDATE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() IS NOT DISTINCT FROM region_of_property(property_id)
    )
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() IS NOT DISTINCT FROM region_of_property(property_id)
    )
  );

DROP POLICY IF EXISTS expenses_delete ON expenses;
CREATE POLICY expenses_delete ON expenses FOR DELETE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() IS NOT DISTINCT FROM region_of_property(property_id)
    )
  );
