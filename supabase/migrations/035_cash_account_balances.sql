-- =============================================================================
-- HomeGuru PMS — migration 035
-- cash_account_balances(): server-side aggregate for cash account balances.
-- =============================================================================
-- Before, the cash accounts list fetched EVERY cash_transactions row and summed
-- it in JavaScript (balancesByAccount) — a query that grows unbounded with
-- transaction history. This RPC does the SUM in Postgres and returns one row
-- per account, so the payload is constant regardless of how much history
-- accumulates.
--
-- SECURITY INVOKER: the inner SELECT runs as the calling user, so the
-- cash_tx_select RLS policy (migration 033) still scopes the aggregate to the
-- accounts that caller is allowed to see — balances never leak across scope.
-- =============================================================================

CREATE OR REPLACE FUNCTION cash_account_balances()
RETURNS TABLE(cash_account_id uuid, balance numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    ct.cash_account_id,
    SUM(CASE WHEN ct.direction = 'IN' THEN ct.amount ELSE -ct.amount END)
  FROM cash_transactions ct
  GROUP BY ct.cash_account_id;
$$;

GRANT EXECUTE ON FUNCTION cash_account_balances() TO authenticated;
