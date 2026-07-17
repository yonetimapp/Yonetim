-- =============================================================================
-- HomeGuru PMS — migration 052
-- Per-user, per-event-type push notification preferences + idempotency hook
-- for the new "upcoming reservation, 2 days before" notification.
-- =============================================================================
-- Up to migration 051 every notification was sent to every staff member whose
-- role matched the trigger's hard-coded recipient list. This migration lets
-- each user opt OUT of any individual event type via the ring-icon settings
-- modal in the app shell. Defaults are "ON" — a missing preference row is
-- treated as enabled, so existing users see no behaviour change until they
-- explicitly toggle something off.
--
-- Event types (must match the literals the Edge Function and triggers send):
--   new_issue                  — housekeeping_issues INSERT (migration 051)
--   payment_unconfirmed        — payment_collections UNCONFIRMED INSERT
--   new_reservation            — reservations INSERT
--   reservation_auto_completed — reservations UPDATE by the 048 cron
--   salary_auto_paid           — staff_salary_payments AUTO INSERT (049 cron)
--   upcoming_reservation_2d    — NEW: 2-day-before reservation reminder
-- =============================================================================

CREATE TABLE notification_preferences (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN (
    'new_issue',
    'payment_unconfirmed',
    'new_reservation',
    'reservation_auto_completed',
    'salary_auto_paid',
    'upcoming_reservation_2d'
  )),
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_type)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- Each user owns their own preferences — no cross-user visibility.
CREATE POLICY notification_preferences_select ON notification_preferences FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY notification_preferences_insert ON notification_preferences FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY notification_preferences_update ON notification_preferences FOR UPDATE
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY notification_preferences_delete ON notification_preferences FOR DELETE
  USING (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Reservations: track when the 2-day-before push fired, so the daily cron
-- doesn't spam the same row on repeated runs. NULL = not yet notified.
-- A row moved forward past its 2-day window stays NULL and will get picked
-- up the next time it's exactly 2 days out.
-- ----------------------------------------------------------------------------
ALTER TABLE reservations ADD COLUMN notified_2d_before timestamptz;

-- ----------------------------------------------------------------------------
-- Notifications audit log: add a finer-grained event_type column so the UI
-- can filter the history feed by the same keys the preferences modal uses.
-- Nullable for backfill safety; new rows written by send-push always set it.
-- ----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN event_type text;
