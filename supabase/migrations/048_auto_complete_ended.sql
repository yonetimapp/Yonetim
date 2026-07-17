-- =============================================================================
-- HomeGuru PMS — migration 048
-- Auto-complete reservations whose stay_end has passed.
-- =============================================================================
-- Symmetric to migration 041's "upcoming → active" promotion: this job flips
-- a still-active reservation to 'completed' once its stay_end is in the past.
--
-- Catches:
--   - Overnight stays the morning of checkout day (stay_end is at UTC
--     midnight of the checkout date, so the first hourly run after that
--     midnight finds stay_end <= now() and flips the row).
--   - Day-use stays within ~1 hour of their end time (e.g. a 14:00–17:00
--     stay auto-completes between 17:00 and 18:00 Istanbul).
--
-- Why hourly (not daily like 041): day-use stays end mid-day, so a daily cron
-- would leave them visibly "Aktif" for the rest of the evening. An hourly
-- heartbeat keeps the calendar's status badges honest within a tight window
-- without meaningfully changing DB load (the UPDATE filters on indexed
-- columns and almost always touches zero rows).
--
-- Scheduled at minute 3 of every hour. Lines up cleanly with the existing
-- daily 21:01 (upcoming → active) and 21:05 (auto-debit) jobs at midnight
-- Istanbul without crossing them.
--
-- Status filter: 'active' is the obvious case. 'upcoming' is included as a
-- safety net — if a single-day past stay slipped through the upcoming →
-- active daily job (e.g. it was created backdated), this catches it. Pending
-- stays are left alone (they're awaiting confirmation, not time-based).
-- =============================================================================

SELECT cron.schedule(
  'homeguru-complete-ended',
  '3 * * * *',
  $$
  UPDATE reservations
  SET status = 'completed'
  WHERE status IN ('active', 'upcoming')
    AND stay_end <= now();
  $$
);
