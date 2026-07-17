-- =============================================================================
-- HomeGuru PMS — migration 075
-- Auto-complete sweep runs every 5 minutes (was hourly).
-- =============================================================================
-- Migration 060 made the auto-complete cron honor the customary 11:00 checkout
-- plus the Geç Çıkış offset (stay_end + 8h + late_checkout_hours). The FORMULA
-- is correct — a +2 late checkout (13:00) flips the row at 13:00 Istanbul.
--
-- The problem was CADENCE: the job ran only once an hour ('3 * * * *'). So a
-- 13:00 late checkout wasn't picked up until 13:03 at the earliest, and any
-- later if that minute's run was missed — the operator saw the reservation
-- still "Aktif" well past the checkout time.
--
-- Fix: run the same UPDATE every 5 minutes. Completion now lands within ~5 min
-- of the (late) checkout time instead of up to an hour late. The UPDATE is
-- cheap (indexed filter, almost always zero rows), so the extra runs are
-- negligible. Minute offset is :02 (2-59/5 → :02,:07,…,:57) so it never
-- coincides with the daily 21:01 (upcoming→active) and 21:05 (auto-debit) jobs.
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-complete-ended');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-complete-ended',
  '2-59/5 * * * *',
  $$
  UPDATE reservations
  SET status = 'completed'
  WHERE status IN ('active', 'upcoming')
    AND (
      (stay_type = 'DAYUSE' AND stay_end <= now())
      OR (
        stay_type <> 'DAYUSE'
        AND stay_end
            + interval '8 hours'
            + (late_checkout_hours * interval '1 hour') <= now()
      )
    );
  $$
);
