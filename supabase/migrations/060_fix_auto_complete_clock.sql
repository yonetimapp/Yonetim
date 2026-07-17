-- =============================================================================
-- HomeGuru PMS — migration 060
-- Auto-complete cron honors the real customary checkout hour.
-- =============================================================================
-- Migration 048 flipped overnight reservations to 'completed' as soon as
-- stay_end passed — but stay_end is stored at midnight UTC of the checkout
-- date (= 03:00 Istanbul). With the customary 11:00 checkout (migration 058)
-- that means a guest still in the room between 03:03 and 11:00 saw their
-- reservation already marked "Tamamlandı" on the operator's screen.
--
-- Fix: for overnight rows the cron now waits for
--   stay_end + 8 hours          (= 11:00 Istanbul on checkout date)
--     + late_checkout_hours     (Geç Çıkış picker)
-- before flipping. Day-use rows keep the original behaviour since they
-- already store the real end timestamp.
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-complete-ended');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-complete-ended',
  '3 * * * *',
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
