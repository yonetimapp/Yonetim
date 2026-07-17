-- =============================================================================
-- HomeGuru PMS — migration 051
-- Push notification triggers: fire send-push Edge Function on key events.
-- =============================================================================
-- Wires the four notification event sources to the send-push Edge Function
-- (Phase 2). All trigger functions are SECURITY DEFINER + auth.uid() filtered
-- so only the right surface fires the right push.
--
-- BEFORE APPLYING THIS MIGRATION:
--
-- 1. pg_net extension is enabled (Database → Extensions).
-- 2. Deploy the Edge Function:
--      supabase functions deploy send-push
-- 3. Set Edge Function secrets in Supabase dashboard:
--      VAPID_SUBJECT       mailto:owner@example.com
--      VAPID_PUBLIC_KEY    <same value as VITE_VAPID_PUBLIC_KEY>
--      VAPID_PRIVATE_KEY   <private half from `npx web-push generate-vapid-keys`>
-- 4. Store the Edge Function URL + service role key in vault (one-time):
--      SELECT vault.create_secret(
--        'https://<project-ref>.supabase.co/functions/v1/send-push',
--        'send_push_url'
--      );
--      SELECT vault.create_secret(
--        '<service role / secret key from Settings → API>',
--        'service_role_key'
--      );
--
-- After everything is in place, INSERT a test row into housekeeping_issues
-- (e.g. via the UI's Sorunlar quick action) and your subscribed device should
-- receive a push within a few seconds.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Helper: posts an async HTTP call to the send-push Edge Function. Reads
--    URL + service role key from Supabase Vault so neither secret is in the
--    migration text. Returns the pg_net request_id (NULL when not configured
--    so trigger inserts still succeed in environments that haven't set up
--    notifications yet).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _send_push_async(
  _roles  text[],
  _title  text,
  _body   text,
  _url    text,
  _kind   text,
  _data   jsonb DEFAULT NULL
) RETURNS bigint
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
    FROM vault.decrypted_secrets WHERE name = 'send_push_url' LIMIT 1;
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

  IF function_url IS NULL OR service_key IS NULL THEN
    RAISE NOTICE '[push] vault secrets send_push_url/service_role_key missing — skipping';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'roles', _roles,
      'title', _title,
      'body',  _body,
      'url',   _url,
      'kind',  _kind,
      'data',  COALESCE(_data, '{}'::jsonb)
    )
  ) INTO request_id;

  RETURN request_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. New housekeeping issue → notify SUPER_ADMIN + PROPERTY_MANAGER
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  unit_name text;
BEGIN
  SELECT name INTO unit_name FROM units WHERE id = NEW.unit_id;
  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
    'Yeni sorun bildirimi',
    COALESCE(unit_name, 'Bilinmeyen birim') || ' — ' || left(NEW.description, 120),
    '/housekeeping',
    'issue',
    jsonb_build_object('id', NEW.id, 'unit_id', NEW.unit_id)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER housekeeping_issues_notify
  AFTER INSERT ON housekeeping_issues
  FOR EACH ROW EXECUTE FUNCTION _notify_new_issue();

-- ----------------------------------------------------------------------------
-- 3. New unconfirmed payment_collection → notify finance roles
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'UNCONFIRMED' THEN
    PERFORM _send_push_async(
      ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
      'Onay bekleyen tahsilat',
      'Tutar: ' || NEW.amount::text || ' ₺ (' || NEW.method || ')',
      '/finance/pending',
      'payment',
      jsonb_build_object('id', NEW.id, 'reservation_id', NEW.reservation_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_collections_notify
  AFTER INSERT ON payment_collections
  FOR EACH ROW EXECUTE FUNCTION _notify_new_payment();

-- ----------------------------------------------------------------------------
-- 4. New reservation → notify SUPER_ADMIN + PROPERTY_MANAGER
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  guest_name text;
  unit_name  text;
BEGIN
  SELECT full_name INTO guest_name FROM guests WHERE id = NEW.guest_id;
  SELECT name INTO unit_name FROM units WHERE id = NEW.unit_id;
  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
    'Yeni rezervasyon',
    COALESCE(guest_name, 'Misafir') || ' · ' || COALESCE(unit_name, 'birim')
      || ' · ' || to_char(NEW.stay_start, 'DD Mon') || '→' || to_char(NEW.stay_end, 'DD Mon'),
    '/reservations/' || NEW.id::text,
    'reservation',
    jsonb_build_object('id', NEW.id)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_notify
  AFTER INSERT ON reservations
  FOR EACH ROW EXECUTE FUNCTION _notify_new_reservation();

-- ----------------------------------------------------------------------------
-- 5. Automatic system events
-- ----------------------------------------------------------------------------

-- 5a. Salary auto-paid (source='AUTO' on staff_salary_payments insert).
CREATE OR REPLACE FUNCTION _notify_salary_auto_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  staff_name text;
BEGIN
  IF NEW.source = 'AUTO' THEN
    SELECT full_name INTO staff_name FROM staff_profiles WHERE user_id = NEW.user_id;
    PERFORM _send_push_async(
      ARRAY['SUPER_ADMIN']::text[],
      'Otomatik maaş ödendi',
      COALESCE(staff_name, 'Personel') || ' — ' || NEW.amount::text || ' ₺ kasadan düşüldü',
      '/finance/staff/' || NEW.user_id::text,
      'system',
      jsonb_build_object('id', NEW.id, 'user_id', NEW.user_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_salary_payments_notify
  AFTER INSERT ON staff_salary_payments
  FOR EACH ROW EXECUTE FUNCTION _notify_salary_auto_paid();

-- 5b. Reservation auto-completed (cron from migration 048). Fires only when
--     the status transition has no auth context — i.e. cron, not a human edit.
CREATE OR REPLACE FUNCTION _notify_reservation_auto_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  guest_name text;
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' AND auth.uid() IS NULL THEN
    SELECT full_name INTO guest_name FROM guests WHERE id = NEW.guest_id;
    PERFORM _send_push_async(
      ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
      'Rezervasyon tamamlandı',
      COALESCE(guest_name, 'Misafir') || ' otomatik olarak tamamlandı.',
      '/reservations/' || NEW.id::text,
      'system',
      jsonb_build_object('id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_notify_auto_completed
  AFTER UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION _notify_reservation_auto_completed();
