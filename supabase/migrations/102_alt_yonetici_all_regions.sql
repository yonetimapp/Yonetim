-- =============================================================================
-- HomeGuru PMS — migration 102
-- Alt Yönetici (PROPERTY_MANAGER) sees/manages ALL regions, incl. Bornova.
-- =============================================================================
-- The region feature accidentally narrowed a plain PROPERTY_MANAGER to HQ (their
-- region is NULL, which only matched HQ mülkler). The operator wants the Alt
-- Yönetici restored to cross-region access — only the bornova-specific roles
-- (YONETICI_BORNOVA / PERSONEL_BORNOVA) stay locked to Bornova.
--
-- auth_sees_all_regions(): SUPER_ADMIN, or a PROPERTY_MANAGER WITHOUT a region.
-- A Yönetici Bornova also normalises to PROPERTY_MANAGER via auth_role(), but
-- has auth_region() = 'bornova' (NOT NULL), so it's correctly NOT all-regions.
-- We add this as a bypass to every region match (mülk visibility, kasa,
-- giderler). access_scope (HOTELS/APARTMENTS) still applies.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth_sees_all_regions()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth_role() = 'SUPER_ADMIN'
      OR (auth_role() = 'PROPERTY_MANAGER' AND auth_region() IS NULL);
$$;
GRANT EXECUTE ON FUNCTION auth_sees_all_regions() TO authenticated;

-- 1. mülk visibility (reservations, units, temizlik, tahsilat, cari, deletion).
--    SUPER_ADMIN keeps the top-level bypass; the region match inside EXISTS now
--    also yields to an all-regions manager — but access_scope still applies.
CREATE OR REPLACE FUNCTION auth_sees_property(p_property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1
      FROM staff_profiles sp
      JOIN properties pr ON pr.id = p_property_id
      WHERE sp.user_id = auth.uid()
        AND sp.deleted_at IS NULL
        AND sp.role <> 'PENDING'
        AND (auth_sees_all_regions() OR auth_region() IS NOT DISTINCT FROM pr.region)
        AND (
          sp.access_scope = 'ALL'
          OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
          OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
        )
    );
$$;
GRANT EXECUTE ON FUNCTION auth_sees_property(uuid) TO authenticated;

-- 2. kasa visibility.
DROP POLICY IF EXISTS cash_accounts_select ON cash_accounts;
CREATE POLICY cash_accounts_select ON cash_accounts FOR SELECT
  USING (
    auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

DROP POLICY IF EXISTS cash_tx_select ON cash_transactions;
CREATE POLICY cash_tx_select ON cash_transactions FOR SELECT
  USING (
    auth_sees_all_regions()
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM cash_accounts ca
        WHERE ca.id = cash_transactions.cash_account_id
          AND ca.region IS NOT DISTINCT FROM auth_region()
      )
    )
  );

-- 3. giderler (select / insert / update / delete).
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_sees_all_regions()
    OR (auth_role() = 'YETKILI' AND created_by = auth.uid())
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

DROP POLICY IF EXISTS expenses_insert ON expenses;
CREATE POLICY expenses_insert ON expenses FOR INSERT
  WITH CHECK (
    auth_sees_all_regions()
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
    auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  )
  WITH CHECK (
    auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

DROP POLICY IF EXISTS expenses_delete ON expenses;
CREATE POLICY expenses_delete ON expenses FOR DELETE
  USING (
    auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );
