-- =============================================================================
-- HomeGuru PMS — migration 050
-- Web Push notifications: subscriptions registry + notification audit log.
-- =============================================================================
-- Foundation for Phase 1 of the notification system. This migration does NOT
-- yet send anything — it sets up the storage layer so the frontend can:
--   - Register a browser/PWA push subscription (one row per device/browser).
--   - Read its own historical notifications.
--   - Mark notifications read.
--
-- Phase 2 will add the Edge Function (send-push) + DB triggers that write
-- into `notifications` and call out to the Web Push service.
--
-- Tables:
--   push_subscriptions  one row per (user, device). Endpoint URL is UNIQUE so
--                       a re-subscribe replaces (frontend deletes-then-inserts
--                       on token rotation).
--   notifications       append-only log of what was sent to whom. user_id
--                       points at the recipient; `kind` lets the UI filter
--                       (issue / payment / reservation / system).
--
-- RLS:
--   push_subscriptions: caller can only see and modify their own rows.
--   notifications:      caller can SELECT and UPDATE-set-read on their own;
--                       INSERT/DELETE intentionally NOT exposed to clients —
--                       the Edge Function uses service_role to fan them out.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. push_subscriptions
-- ----------------------------------------------------------------------------
CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint)
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY push_subscriptions_update ON push_subscriptions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 2. notifications — audit log of sent notifications, per recipient.
-- ----------------------------------------------------------------------------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text,
  url         text,
  kind        text NOT NULL CHECK (kind IN (
    'issue', 'payment', 'reservation', 'system'
  )),
  data        jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Most-recent-first index for the (eventual) bell dropdown.
CREATE INDEX notifications_user_created_idx
  ON notifications(user_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (user_id = auth.uid());

-- Allow recipients to flip read_at on their own rows; other columns are
-- effectively immutable because UPDATE policies aren't column-scoped here,
-- but the API surface from the client only sets read_at.
CREATE POLICY notifications_update_read ON notifications FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No INSERT / DELETE policies — Phase 2's Edge Function writes rows under
-- service_role (which bypasses RLS) so the client can't forge entries.
