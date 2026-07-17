-- =============================================================================
-- HomeGuru PMS — migration 041
-- New reservation status 'upcoming' (Yakında) + auto-transition to 'active'.
-- =============================================================================
-- A reservation created for a future check-in is 'upcoming'; a daily job flips
-- it to 'active' once its check-in date arrives. Same-day reservations are
-- created 'active' directly (handled in the app). The other statuses are
-- unchanged and still settable by hand.
-- =============================================================================

-- 1. Extend the status CHECK constraint with 'upcoming'.
ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('pending', 'active', 'completed', 'cancelled', 'upcoming'));

-- 2. Daily job — promote 'upcoming' reservations to 'active' once their
--    check-in date has arrived (Europe/Istanbul). Scheduled at 00:01 Istanbul
--    (21:01 UTC), just before the 00:05 auto-debit job so a stay with
--    auto_debit gets charged from its first night.
SELECT cron.schedule(
  'homeguru-activate-upcoming',
  '1 21 * * *',
  $$
  UPDATE reservations
  SET status = 'active'
  WHERE status = 'upcoming'
    AND (now() AT TIME ZONE 'Europe/Istanbul')::date >= stay_start::date;
  $$
);
