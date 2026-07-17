-- =============================================================================
-- HomeGuru PMS — migration 059
-- Two-way Google Calendar sync scaffolding.
-- =============================================================================
-- Tables added:
--   google_oauth_tokens          owner's OAuth refresh + access tokens, one
--                                row per connected user (today: the single
--                                SUPER_ADMIN owner). Stores the calendar id +
--                                last_sync_token for incremental pull.
--   pending_google_reservations  external Google Calendar events (e.g. created
--                                by Meta AI on the customer's behalf) that
--                                arrived via the pull cron and need an owner
--                                to assign a unit + guest before they become
--                                real HomeGuru reservations.
--
-- Columns added:
--   reservations.google_event_id  links the HomeGuru reservation to its Google
--                                 Calendar event id so we don't re-import our
--                                 own pushes and can update/delete in place.
--                                 UNIQUE so the pull side can match in O(1).
--
-- The push side is wired by a trigger that calls the google-sync-push Edge
-- Function asynchronously via pg_net + Supabase Vault — same pattern as the
-- existing push notifications pipeline (migration 051). Trigger fires only
-- when reservation fields the calendar cares about actually change, so the
-- "store google_event_id back on the row" follow-up update doesn't loop.
--
-- New notification event type:
--   pending_google_reservation   fires when a new pending_google_reservations
--                                row lands, so the owner sees a push and can
--                                jump straight into the assign-unit flow.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. google_oauth_tokens
-- ----------------------------------------------------------------------------
CREATE TABLE google_oauth_tokens (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token     text NOT NULL,
  refresh_token    text NOT NULL,
  expires_at       timestamptz NOT NULL,
  calendar_id      text NOT NULL DEFAULT 'primary',
  last_sync_token  text,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE google_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Owner can read their own row to show connection state. Tokens themselves
-- are only ever read by Edge Functions running under service_role; the SELECT
-- policy is for the "Bağlı: vareonx@gmail.com" UI badge.
CREATE POLICY google_oauth_tokens_select ON google_oauth_tokens FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY google_oauth_tokens_delete ON google_oauth_tokens FOR DELETE
  USING (user_id = auth.uid() AND auth_role() = 'SUPER_ADMIN');
-- INSERT/UPDATE intentionally NOT exposed to clients — Edge Functions
-- (service_role) own writes.

-- ----------------------------------------------------------------------------
-- 2. pending_google_reservations
-- ----------------------------------------------------------------------------
CREATE TABLE pending_google_reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_event_id   text NOT NULL UNIQUE,
  summary           text,
  description       text,
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  raw_payload       jsonb,
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'imported', 'dismissed')),
  reservation_id    uuid REFERENCES reservations(id) ON DELETE SET NULL,
  imported_at       timestamptz,
  dismissed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_google_reservations_status_idx
  ON pending_google_reservations(status) WHERE status = 'pending';

ALTER TABLE pending_google_reservations ENABLE ROW LEVEL SECURITY;

-- SUPER_ADMIN owns the review queue; this is single-owner workflow today.
CREATE POLICY pending_google_reservations_select ON pending_google_reservations FOR SELECT
  USING (auth_role() = 'SUPER_ADMIN');
CREATE POLICY pending_google_reservations_update ON pending_google_reservations FOR UPDATE
  USING (auth_role() = 'SUPER_ADMIN')
  WITH CHECK (auth_role() = 'SUPER_ADMIN');
-- INSERTs come from the google-sync-pull Edge Function (service_role).

-- ----------------------------------------------------------------------------
-- 3. reservations.google_event_id — link to the Google Calendar event.
-- ----------------------------------------------------------------------------
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS google_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS reservations_google_event_id_idx
  ON reservations(google_event_id) WHERE google_event_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. notification_preferences: register pending_google_reservation event.
-- ----------------------------------------------------------------------------
ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_type_check;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_event_type_check
  CHECK (event_type IN (
    'new_issue',
    'payment_unconfirmed',
    'new_reservation',
    'reservation_auto_completed',
    'salary_auto_paid',
    'upcoming_reservation_2d',
    'pending_approval',
    'pending_google_reservation'
  ));

-- ----------------------------------------------------------------------------
-- 5. Helper: post async HTTP to the google-sync-push Edge Function. Same
--    Vault-secret + pg_net pattern as _send_push_async (migration 051).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _google_sync_async(_payload jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  function_url text;
  service_key  text;
  request_id   bigint;
BEGIN
  SELECT decrypted_secret INTO function_url
    FROM vault.decrypted_secrets WHERE name = 'google_sync_push_url' LIMIT 1;
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
  IF function_url IS NULL OR service_key IS NULL THEN
    RAISE NOTICE '[google-sync] vault secrets missing — skipping';
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    ),
    body := _payload
  ) INTO request_id;
  RETURN request_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Trigger functions: fire push to Google on relevant changes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _trg_reservation_google_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cancelled / completed are "soft" stops — still update the Google event
  -- (e.g. mark its summary with [İptal]) so the owner sees the state on
  -- the connected calendar. Hard delete is handled by a separate trigger.
  PERFORM _google_sync_async(jsonb_build_object(
    'op',             'upsert',
    'reservation_id', NEW.id
  ));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION _trg_reservation_google_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.google_event_id IS NOT NULL THEN
    PERFORM _google_sync_async(jsonb_build_object(
      'op',              'delete',
      'google_event_id', OLD.google_event_id
    ));
  END IF;
  RETURN OLD;
END;
$$;

-- INSERT trigger: always push.
DROP TRIGGER IF EXISTS reservations_google_push_insert ON reservations;
CREATE TRIGGER reservations_google_push_insert
  AFTER INSERT ON reservations
  FOR EACH ROW EXECUTE FUNCTION _trg_reservation_google_push();

-- UPDATE trigger: only on columns the Google event mirrors. The follow-up
-- "store google_event_id back" UPDATE deliberately isn't in this list so
-- the trigger doesn't re-fire from its own side effect.
DROP TRIGGER IF EXISTS reservations_google_push_update ON reservations;
CREATE TRIGGER reservations_google_push_update
  AFTER UPDATE OF
    stay_start, stay_end, status, stay_type, late_checkout_hours,
    guest_id, unit_id, property_id
  ON reservations
  FOR EACH ROW EXECUTE FUNCTION _trg_reservation_google_push();

DROP TRIGGER IF EXISTS reservations_google_push_delete ON reservations;
CREATE TRIGGER reservations_google_push_delete
  AFTER DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION _trg_reservation_google_delete();

-- ----------------------------------------------------------------------------
-- 7. Push notification on new pending Google reservation arrival.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_pending_google_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;
  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Yeni Google rezervasyonu',
    COALESCE(NEW.summary, 'Misafir') || ' — ' ||
      to_char(NEW.start_at AT TIME ZONE 'Europe/Istanbul', 'DD Mon HH24:MI'),
    '/reservations/google-pending',
    'reservation',
    'pending_google_reservation',
    jsonb_build_object('id', NEW.id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pending_google_reservations_notify ON pending_google_reservations;
CREATE TRIGGER pending_google_reservations_notify
  AFTER INSERT ON pending_google_reservations
  FOR EACH ROW EXECUTE FUNCTION _notify_new_pending_google_reservation();

-- ----------------------------------------------------------------------------
-- 8. Pull cron: fires google-sync-pull every 5 minutes. Same Vault pattern;
--    no-op if google_sync_pull_url isn't set yet.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _run_google_pull()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  function_url text;
  service_key  text;
  request_id   bigint;
BEGIN
  SELECT decrypted_secret INTO function_url
    FROM vault.decrypted_secrets WHERE name = 'google_sync_pull_url' LIMIT 1;
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
  IF function_url IS NULL OR service_key IS NULL THEN
    RAISE NOTICE '[google-sync-pull] vault secrets missing — skipping';
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) INTO request_id;
  RETURN request_id;
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-google-pull');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-google-pull',
  '*/5 * * * *',
  $$ SELECT _run_google_pull(); $$
);
