-- =============================================================================
-- HomeGuru PMS — Cron migration 004
-- =============================================================================
-- pg_cron jobs. Cron runs in UTC. Turkey is UTC+3 year-round (no DST since 2016).
-- Schedule '5 21 * * *' = 21:05 UTC = 00:05 Europe/Istanbul.
--
-- Prerequisite: pg_cron extension enabled (Dashboard → Database → Extensions)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- -----------------------------------------------------------------------------
-- Nightly auto-debit at 00:05 Europe/Istanbul (21:05 UTC)
-- Idempotent: the NOT EXISTS clause prevents duplicate debits for the same day.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'homeguru-nightly-auto-debit',
  '5 21 * * *',
  $$
  INSERT INTO ledger_entries (guest_id, reservation_id, type, amount, currency, note, created_by)
  SELECT
    r.guest_id,
    r.id,
    'DEBT',
    r.total_amount / GREATEST(1, (r.stay_end::date - r.stay_start::date)),
    'TRY',
    'Auto-debit ' || to_char(now() AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD'),
    NULL
  FROM reservations r
  WHERE r.auto_debit = true
    AND r.status = 'active'
    AND (now() AT TIME ZONE 'Europe/Istanbul')::date >= r.stay_start::date
    AND (now() AT TIME ZONE 'Europe/Istanbul')::date <  r.stay_end::date
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entries le
      WHERE le.reservation_id = r.id
        AND (le.created_at AT TIME ZONE 'Europe/Istanbul')::date
            = (now() AT TIME ZONE 'Europe/Istanbul')::date
        AND le.type = 'DEBT'
        AND le.note LIKE 'Auto-debit%'
    );
  $$
);

-- To inspect / cancel:
--   SELECT * FROM cron.job;
--   SELECT cron.unschedule('homeguru-nightly-auto-debit');
