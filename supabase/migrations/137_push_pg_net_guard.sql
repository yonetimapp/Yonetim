-- =============================================================================
-- Yönetim PMS — migration 137
-- Push hardening: guarantee pg_net exists; a push failure never aborts a write.
-- =============================================================================
-- Found live (2026-07-18): the new project had the push vault secrets configured
-- but the pg_net EXTENSION was never enabled — SETUP.md §2 listed pgcrypto /
-- btree_gist / pg_cron and omitted pg_net (a doc gap inherited from homeguru,
-- where it was enabled through some untracked path). Because every _notify_*
-- trigger runs INSIDE the business transaction, `schema "net" does not exist`
-- didn't just kill the push — it aborted the gider/reservation/issue INSERT
-- that fired it. Notification plumbing was able to take money writes down.
--
-- Two-part fix:
--   1. The migration creates pg_net itself (idempotent), so no fresh install
--      can ever depend on a human reading the docs step.
--   2. _send_push_async wraps its work in an exception guard: ANY error —
--      missing extension, vault trouble, queueing failure — degrades to a
--      NOTICE and the caller's transaction proceeds. This matches the existing
--      missing-secrets guard's philosophy (push stays off, nothing else breaks).
--      Deliberate trade-off: push breakage is now always silent at SQL level;
--      the place to notice it is the send-push function logs + the bell UI
--      going quiet, never a failed gider.
--
-- Body is otherwise verbatim from 132 (same signature — no DROP needed).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION _send_push_async(
  _roles      text[],
  _title      text,
  _body       text,
  _url        text,
  _kind       text,
  _event_type text,
  _data       jsonb DEFAULT NULL,
  _region     text  DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  function_url text;
  service_key  text;
  push_secret  text;
  request_id   bigint;
BEGIN
  SELECT decrypted_secret INTO function_url
    FROM vault.decrypted_secrets WHERE name = 'send_push_url' LIMIT 1;
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
  SELECT decrypted_secret INTO push_secret
    FROM vault.decrypted_secrets WHERE name = 'push_shared_secret' LIMIT 1;

  IF function_url IS NULL OR service_key IS NULL OR push_secret IS NULL THEN
    RAISE NOTICE '[push] vault secrets send_push_url/service_role_key/push_shared_secret missing — skipping';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'x-push-secret', push_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'roles',      _roles,
      'title',      _title,
      'body',       _body,
      'url',        _url,
      'kind',       _kind,
      'event_type', _event_type,
      'region',     _region,
      'data',       COALESCE(_data, '{}'::jsonb)
    )
  ) INTO request_id;

  RETURN request_id;
EXCEPTION WHEN OTHERS THEN
  -- A notification must never take the business write down with it.
  RAISE NOTICE '[push] gönderim kuyruğa alınamadı — bildirim atlandı: %', SQLERRM;
  RETURN NULL;
END;
$$;
