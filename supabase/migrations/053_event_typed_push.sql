-- =============================================================================
-- HomeGuru PMS — migration 053
-- Add event_type to the push pipeline + a daily cron that reminds staff
-- about reservations starting in 2 days.
-- =============================================================================
-- What changes:
--   1. _send_push_async grows a new `_event_type text` parameter and forwards
--      it to the Edge Function so send-push can apply per-user opt-outs from
--      notification_preferences (migration 052).
--   2. The four existing trigger functions are updated to pass the new arg.
--   3. New cron job: every morning at 09:00 Istanbul (06:00 UTC) scan for
--      reservations whose stay_start is exactly two Istanbul-local days
--      ahead and ping SUPER_ADMIN + PROPERTY_MANAGER once each.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Replace _send_push_async with the event_type-aware version. We drop
--    first because Postgres treats parameter list changes as a new function
--    overload, and we want exactly one signature alive.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS _send_push_async(text[], text, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION _send_push_async(
  _roles      text[],
  _title      text,
  _body       text,
  _url        text,
  _kind       text,
  _event_type text,
  _data       jsonb DEFAULT NULL
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
      'roles',      _roles,
      'title',      _title,
      'body',       _body,
      'url',        _url,
      'kind',       _kind,
      'event_type', _event_type,
      'data',       COALESCE(_data, '{}'::jsonb)
    )
  ) INTO request_id;

  RETURN request_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Update each of the four existing trigger functions to pass event_type.
--    Bodies are otherwise identical to migration 051.
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
    'new_issue',
    jsonb_build_object('id', NEW.id, 'unit_id', NEW.unit_id)
  );
  RETURN NEW;
END;
$$;

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
      'payment_unconfirmed',
      jsonb_build_object('id', NEW.id, 'reservation_id', NEW.reservation_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

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
    'new_reservation',
    jsonb_build_object('id', NEW.id)
  );
  RETURN NEW;
END;
$$;

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
      'salary_auto_paid',
      jsonb_build_object('id', NEW.id, 'user_id', NEW.user_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

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
      'reservation_auto_completed',
      jsonb_build_object('id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Upcoming-reservation cron: notify staff 2 days before stay_start.
--    Filters on Istanbul-local dates so the boundary lines up with the
--    operator's day, not UTC. Marks each row notified_2d_before so the next
--    run skips it; a reservation moved out of the window stays NULL and gets
--    picked up again when it lands at exactly 2 days out.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_upcoming_reservations_2d()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          record;
  guest_name text;
  unit_name  text;
  target     date;
BEGIN
  target := (now() AT TIME ZONE 'Europe/Istanbul')::date + 2;

  FOR r IN
    SELECT id, guest_id, unit_id, stay_start
    FROM reservations
    WHERE (stay_start AT TIME ZONE 'Europe/Istanbul')::date = target
      AND status IN ('upcoming', 'pending')
      AND notified_2d_before IS NULL
  LOOP
    SELECT full_name INTO guest_name FROM guests WHERE id = r.guest_id;
    SELECT name INTO unit_name FROM units WHERE id = r.unit_id;

    PERFORM _send_push_async(
      ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
      'Yaklaşan rezervasyon (2 gün)',
      COALESCE(guest_name, 'Misafir') || ' — ' || COALESCE(unit_name, 'birim')
        || ' · ' || to_char(r.stay_start, 'DD Mon'),
      '/reservations/' || r.id::text,
      'reservation',
      'upcoming_reservation_2d',
      jsonb_build_object('id', r.id)
    );

    UPDATE reservations SET notified_2d_before = now() WHERE id = r.id;
  END LOOP;
END;
$$;

-- Schedule daily at 06:00 UTC (09:00 Istanbul — early morning, not too noisy).
SELECT cron.schedule(
  'homeguru-notify-upcoming-2d',
  '0 6 * * *',
  $$SELECT _notify_upcoming_reservations_2d();$$
);
