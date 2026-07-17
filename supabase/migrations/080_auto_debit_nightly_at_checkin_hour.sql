-- =============================================================================
-- HomeGuru PMS — migration 080
-- Auto-debit: back to nightly accrual, posted daily AT THE CHECK-IN HOUR.
-- =============================================================================
-- Migration 077 made auto-debit a one-time full charge at activation. The
-- operator wants the opposite: instead of dumping the whole nightly total onto
-- the cari at check-in, accrue ONE night's share per day, at the same hour as
-- check-in (giriş saati). e.g. check-in 4 Haz 14:00, 3 nights → 14:00 on 4/5/6
-- Haz each post one night's share.
--
-- Pieces:
--   1. Drop the one-time-at-activation trigger (077/078).
--   2. A pg_cron sweep (every 5 min) that posts the current day's night the
--      moment the check-in hour arrives, once per reservation per day.
--
-- Money correctness: the per-night share uses incremental cumulative rounding
--   night k amount = round(total*k/nights, 2) − round(total*(k-1)/nights, 2)
-- so the N nightly charges sum to EXACTLY total_amount (no kuruş drift). The
-- night number k is derived from the date offset, not a running count, so a
-- missed day never corrupts the others' amounts.
--
-- Edge cases:
--   * cari_blocked reservations are skipped (the ledger block trigger from 078
--     would otherwise raise inside the cron).
--   * day-use (stay_start::date = stay_end::date) → one charge of the full
--     amount on the giriş day (GREATEST(1, …) + the +1-day window). In practice
--     the auto_debit toggle is hidden for day-use, so this is just a safety net.
--   * TRANSITION: reservations already charged in full under 077 carry the
--     one-time 'Otomatik borçlandırma (giriş)' entry — they are skipped here so
--     they are never double-charged. Only new/future stays accrue nightly.
--
-- Free-tier note: like every cron here, this only runs while the project is
-- awake. A day slept-through simply isn't charged (per-day idempotency); it is
-- not retroactively back-charged. Same limitation as the salary / complete crons.
-- =============================================================================

-- 1. Stop the one-time-at-activation behaviour.
DROP TRIGGER IF EXISTS reservations_auto_debit_trg ON reservations;
DROP FUNCTION IF EXISTS _auto_debit_on_activate();

-- 2. Nightly accrual sweep. Minute offset :04 (4-59/5 → :04,:09,…,:59) so it
--    never collides with the complete-ended sweep (:02 cadence, migration 075)
--    or the daily 00:01 upcoming→active job.
DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-auto-debit-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-auto-debit-nightly',
  '4-59/5 * * * *',
  $$
  INSERT INTO ledger_entries (guest_id, reservation_id, type, amount, currency, note, created_by)
  SELECT n.guest_id, n.reservation_id, 'DEBT', n.amount, 'TRY', n.note, NULL
  FROM (
    SELECT
      r.guest_id,
      r.id AS reservation_id,
      round(r.total_amount * (cur.today - r.stay_start::date + 1)
            / GREATEST(1, r.stay_end::date - r.stay_start::date), 2)
      - round(r.total_amount * (cur.today - r.stay_start::date)
            / GREATEST(1, r.stay_end::date - r.stay_start::date), 2) AS amount,
      'Otomatik borçlandırma (gece) ' || to_char(cur.today, 'YYYY-MM-DD') AS note
    FROM reservations r
    CROSS JOIN (
      SELECT (now() AT TIME ZONE 'Europe/Istanbul')        AS now_ts,
             (now() AT TIME ZONE 'Europe/Istanbul')::date  AS today
    ) cur
    WHERE r.auto_debit = true
      AND r.status = 'active'
      AND r.cari_blocked = false
      AND COALESCE(r.total_amount, 0) > 0
      -- Chargeable night-days: check-in day .. day before checkout. The
      -- GREATEST(...) gives day-use (same-day) a single chargeable day.
      AND cur.today >= r.stay_start::date
      AND cur.today <  GREATEST(r.stay_end::date, r.stay_start::date + 1)
      -- Only once today's check-in hour has actually arrived (Istanbul wall clock).
      AND cur.now_ts >= cur.today + (r.stay_start AT TIME ZONE 'Europe/Istanbul')::time
      -- Transition guard: skip stays already charged in full under migration 077.
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le0
        WHERE le0.reservation_id = r.id
          AND le0.type = 'DEBT'
          AND le0.note = 'Otomatik borçlandırma (giriş)'
      )
      -- Idempotent: at most one nightly charge per reservation per calendar day.
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le1
        WHERE le1.reservation_id = r.id
          AND le1.type = 'DEBT'
          AND le1.note = 'Otomatik borçlandırma (gece) ' || to_char(cur.today, 'YYYY-MM-DD')
      )
  ) n
  -- ledger_entries.amount has CHECK (amount > 0); never insert a zero/negative
  -- share (only possible for pathological inputs) so the sweep can't abort.
  WHERE n.amount > 0;
  $$
);
