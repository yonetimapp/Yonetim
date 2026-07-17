-- =============================================================================
-- HomeGuru PMS — migration 010
-- Tightens cash_accounts + cash_transactions RLS to enforce branch isolation.
-- =============================================================================
-- 003_rls.sql defined SELECT on cash_accounts with a property-scope check,
-- but the modify policy was role-only:
--
--   CREATE POLICY cash_accounts_modify ON cash_accounts FOR ALL
--     USING       (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
--     WITH CHECK  (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));
--
-- That lets a PROPERTY_MANAGER from Branch A insert / update / delete a cash
-- account belonging to Branch B if they discover the row's UUID. Same hole
-- existed on cash_tx_insert.
--
-- This migration drops the loose policies and recreates them with the same
-- branch-isolation pattern already used by units_modify and reservations_*.
-- =============================================================================

-- cash_accounts: tighten ALL (INSERT/UPDATE/DELETE) to require matching branch
DROP POLICY IF EXISTS cash_accounts_modify ON cash_accounts;

CREATE POLICY cash_accounts_modify ON cash_accounts FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

-- cash_transactions: tighten INSERT so the target account must live in the
-- caller's branch. We look it up via cash_accounts since cash_transactions
-- itself doesn't carry property_id.
DROP POLICY IF EXISTS cash_tx_insert ON cash_transactions;

CREATE POLICY cash_tx_insert ON cash_transactions FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (
      auth_role() = 'SUPER_ADMIN'
      OR EXISTS (
        SELECT 1 FROM cash_accounts ca
        WHERE ca.id = cash_transactions.cash_account_id
          AND ca.property_id = auth_property_id()
      )
    )
  );
