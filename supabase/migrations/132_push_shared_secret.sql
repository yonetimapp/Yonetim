-- =============================================================================
-- Yönetim PMS — migration 132
-- send-push auth fix: shared-secret header between the DB and the Edge Function.
-- =============================================================================
-- Fixes the recorded send-push auth-bypass finding (2026-06-11): the Edge
-- Function only checked for a Bearer-prefixed Authorization header, and with
-- the gateway's verify_jwt any valid project JWT — including one minted from
-- the PUBLIC anon key — passed. Anyone with the app bundle could push
-- arbitrary notifications to all staff and spam the notifications table.
--
-- Fix: a dedicated random secret, sent as an `x-push-secret` header by
-- _send_push_async and required (constant-time compared) by the Edge Function.
-- The Bearer header stays for the gateway; the shared secret is the real gate.
--
-- Setup (RERELEASE.md / SETUP.md §8):
--   1. Generate:  openssl rand -base64 32
--   2. Vault (SQL):    select vault.create_secret('<value>', 'push_shared_secret');
--   3. Edge Function:  supabase secrets set PUSH_SHARED_SECRET='<value>'
-- Until both sides are configured, _send_push_async skips with a NOTICE (same
-- graceful degradation as the existing url/key guard) — push simply stays off.
-- =============================================================================

DROP FUNCTION IF EXISTS _send_push_async(text[], text, text, text, text, text, jsonb, text);

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
END;
$$;
