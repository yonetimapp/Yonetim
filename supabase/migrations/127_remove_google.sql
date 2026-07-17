-- =============================================================================
-- Yönetim PMS — migration 127
-- Remove the Google Calendar sync feature (DB side).
-- =============================================================================
-- Re-release change #1. Tears down everything migration 059 built: the pull cron,
-- the reservation push triggers + their functions, the two Google tables and
-- their notify trigger/function. The Edge Functions (google-oauth-callback,
-- google-sync-pull, google-sync-push) and all frontend Google code are removed
-- separately (they are files, not DB objects).
--
-- KEPT: reservations.google_event_id. It is a harmless NULL column once the
-- feature is gone, and restore_trash() (migration 065) lists it in its INSERT —
-- dropping it would break trash-restore. Leaving it vestigial is the safe choice.
-- =============================================================================

-- 1. Stop the nightly pull cron (guarded — no error if it was never scheduled).
DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-google-pull');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Drop the reservation push triggers, then their functions.
DROP TRIGGER IF EXISTS reservations_google_push_insert ON reservations;
DROP TRIGGER IF EXISTS reservations_google_push_update ON reservations;
DROP TRIGGER IF EXISTS reservations_google_push_delete ON reservations;

DROP FUNCTION IF EXISTS _trg_reservation_google_push() CASCADE;
DROP FUNCTION IF EXISTS _trg_reservation_google_delete() CASCADE;
DROP FUNCTION IF EXISTS _google_sync_async(jsonb) CASCADE;
DROP FUNCTION IF EXISTS _run_google_pull() CASCADE;

-- 3. Drop the two Google tables. CASCADE removes their policies, index, and the
--    pending_google_reservations_notify trigger. Then drop its notify function.
DROP TABLE IF EXISTS pending_google_reservations CASCADE;
DROP TABLE IF EXISTS google_oauth_tokens CASCADE;
DROP FUNCTION IF EXISTS _notify_new_pending_google_reservation() CASCADE;
