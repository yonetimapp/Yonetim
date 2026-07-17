-- =============================================================================
-- HomeGuru PMS — migration 017
-- Allows SUPER_ADMIN to delete ledger_entries rows.
-- =============================================================================
-- Ledger entries were originally append-only at the DB level (no DELETE
-- policy → all deletes silently blocked by RLS). That mirrors the cash
-- transactions situation: right for accounting integrity but impractical
-- when the operator needs to clean up typos or test data.
--
-- Restricted to SUPER_ADMIN — managers shouldn't be silently rewriting
-- cari history. For payment-linked entries (those with payment_collection_id
-- set by collect_payment / backfilled by migration 016), the UI prefers to
-- cascade-delete via payment_collections, which removes the matching cash
-- transaction row too. This direct DELETE on ledger_entries is the fallback
-- for manual entries and auto-debit cron entries that have no payment link.
-- =============================================================================

CREATE POLICY ledger_delete ON ledger_entries FOR DELETE
  USING (auth_role() = 'SUPER_ADMIN');
