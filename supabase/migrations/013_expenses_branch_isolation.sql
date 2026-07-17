-- =============================================================================
-- HomeGuru PMS — migration 013
-- Tightens expenses RLS to enforce branch isolation on writes.
-- =============================================================================
-- 003_rls.sql defined SELECT on expenses with a property-scope check, but the
-- modify policy was role-only:
--
--   CREATE POLICY expenses_modify ON expenses FOR ALL
--     USING       (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
--     WITH CHECK  (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));
--
-- That lets a PROPERTY_MANAGER from Branch A insert / update / delete expense
-- rows belonging to Branch B if they discover the row's UUID. Mirrors the gap
-- already fixed for cash_accounts (010), ledger_entries (011).
-- =============================================================================

DROP POLICY IF EXISTS expenses_modify ON expenses;

CREATE POLICY expenses_modify ON expenses FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );
