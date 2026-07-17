-- =============================================================================
-- HomeGuru PMS — migration 068
-- Cascade payment_collections when its parent reservation is deleted.
-- =============================================================================
-- The 001 schema set payment_collections.reservation_id to ON DELETE RESTRICT,
-- which surfaced as "Bu rezervasyon başka kayıtlara bağlı olduğu için
-- silinemez" even when the operator had no visible payments left (a stale
-- DISPUTED / UNCONFIRMED row was still there).
--
-- Switching the FK to CASCADE makes trashing a reservation also drop its
-- payment_collections — and those in turn cascade-drop their cash_transactions
-- (FK from migration 016 was already CASCADE). The ledger_entries.reservation_id
-- stays SET NULL so the cari (receivables) history survives.
--
-- kbs_submissions stays ON DELETE RESTRICT — a submitted KBS entry MUST be
-- preserved for compliance, so deletion stays blocked until the operator
-- manually handles it.
-- =============================================================================

ALTER TABLE payment_collections
  DROP CONSTRAINT IF EXISTS payment_collections_reservation_id_fkey;

ALTER TABLE payment_collections
  ADD CONSTRAINT payment_collections_reservation_id_fkey
  FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE;
