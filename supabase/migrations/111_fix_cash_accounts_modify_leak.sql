-- =============================================================================
-- HomeGuru PMS — migration 111  (FIX)
-- Yönetici Bornova must see only the Bornova kasa.
-- =============================================================================
-- cash_accounts_modify was FOR ALL with USING (role IN SUPER_ADMIN/PROPERTY_MANAGER).
-- FOR ALL covers SELECT, so it OR'd into the read path and let every manager
-- (incl. a normalised Yönetici Bornova) see EVERY kasa — bypassing the
-- region-scoped cash_accounts_select. Kasa accounts are created by migrations,
-- so modify is restricted to SUPER_ADMIN; reads now go only through
-- cash_accounts_select, which scopes a Bornova manager to the Bornova kasa.
-- =============================================================================

DROP POLICY IF EXISTS cash_accounts_modify ON cash_accounts;
CREATE POLICY cash_accounts_modify ON cash_accounts FOR ALL
  USING (auth_role() = 'SUPER_ADMIN')
  WITH CHECK (auth_role() = 'SUPER_ADMIN');
