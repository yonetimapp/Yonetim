-- =============================================================================
-- HomeGuru PMS — migration 015
-- Allows SUPER_ADMIN to delete cash_transactions rows.
-- =============================================================================
-- Cash transactions were originally append-only at the DB level (no DELETE
-- policy → all deletes silently blocked by RLS). That's the right default for
-- accounting integrity, but in practice the operator needs a way to fix
-- mistakes (typos, double-entries) without writing SQL by hand.
--
-- Restricting to SUPER_ADMIN keeps managers from rewriting branch history
-- silently. Reception/Housekeeping never had write access here.
-- =============================================================================

CREATE POLICY cash_tx_delete ON cash_transactions FOR DELETE
  USING (auth_role() = 'SUPER_ADMIN');
