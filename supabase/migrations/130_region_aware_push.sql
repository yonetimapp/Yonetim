-- =============================================================================
-- Yönetim PMS — migration 130
-- Region-aware push: a region-scoped staffer only gets THEIR region's push.
-- =============================================================================
-- Before: _send_push_async passed a ROLES array to the Edge Function, which
-- resolved EVERY user with those roles — so a region-scoped PROPERTY_MANAGER got
-- every region's issue/payment/reservation push. Now each region-scoped notify
-- passes the entity's region; the Edge Function keeps a role-resolved recipient
-- only when they are SUPER_ADMIN, all_regions, or their home region matches.
--
-- The per-event ROLE sets are unchanged (issues add Teknik; reservations use the
-- wider _region_reservation_roles) — we only add the region gate. Admin-only
-- notifications (salary_auto_paid, entity_deleted, signup) pass no region and are
-- unaffected. Requires the matching send-push Edge Function update.
-- =============================================================================

-- 1. _send_push_async grows a trailing `_region text` (forwarded as `region`).
--    NULL region = no region filter (backward compatible for admin-only events).
DROP FUNCTION IF EXISTS _send_push_async(text[], text, text, text, text, text, jsonb);

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
      'region',     _region,
      'data',       COALESCE(_data, '{}'::jsonb)
    )
  ) INTO request_id;

  RETURN request_id;
END;
$$;

-- 2. Region-scoped notify functions — bodies verbatim from their final versions
--    (117 / 115 / 119); the only change is the trailing region argument.

-- New issue (final: 117). Managers of the region + Teknik (all regions).
CREATE OR REPLACE FUNCTION _notify_new_issue()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  unit_name        text;
  property_name    text;
  issue_region     text;
  guest_name       text;
  res_creator_name text;
  reporter_name    text;
  body             text;
BEGIN
  SELECT u.name, p.name, p.region
    INTO unit_name, property_name, issue_region
  FROM units u
  JOIN properties p ON p.id = u.property_id
  WHERE u.id = NEW.unit_id;

  SELECT g.full_name, sp.full_name
    INTO guest_name, res_creator_name
  FROM reservations r
  LEFT JOIN guests g ON g.id = r.guest_id
  LEFT JOIN staff_profiles sp ON sp.user_id = r.created_by
  WHERE r.unit_id = NEW.unit_id
    AND r.status = 'active'
  ORDER BY r.stay_start DESC
  LIMIT 1;

  SELECT full_name INTO reporter_name
  FROM staff_profiles WHERE user_id = NEW.reported_by;

  body :=
    COALESCE(property_name, '') ||
    CASE WHEN property_name IS NOT NULL AND unit_name IS NOT NULL THEN ' / ' ELSE '' END ||
    COALESCE(unit_name, '') ||
    COALESCE(' · ' || guest_name, '') ||
    E'\nSorun: ' || left(NEW.description, 100) ||
    COALESCE(E'\nRezervasyonu açan: ' || res_creator_name, '') ||
    COALESCE(E'\nSorunu açan: ' || reporter_name, '');

  PERFORM _send_push_async(
    _region_manager_roles(issue_region) || ARRAY['TEKNIK_PERSONEL']::text[],
    'Yeni sorun bildirimi',
    body,
    '/housekeeping',
    'issue',
    'new_issue',
    jsonb_build_object('id', NEW.id, 'unit_id', NEW.unit_id),
    issue_region
  );
  RETURN NEW;
END;
$$;

-- Unconfirmed payment (final: 115). Managers of the payment's region.
CREATE OR REPLACE FUNCTION _notify_new_payment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  collector_name text;
  method_label   text;
  v_region       text;
BEGIN
  IF NEW.status = 'UNCONFIRMED' THEN
    SELECT full_name INTO collector_name
      FROM staff_profiles WHERE user_id = NEW.collected_by_user_id;

    SELECT pr.region INTO v_region
      FROM reservations r JOIN properties pr ON pr.id = r.property_id
      WHERE r.id = NEW.reservation_id;

    method_label := CASE NEW.method
      WHEN 'CASH'     THEN 'Nakit'
      WHEN 'TRANSFER' THEN 'Havale/EFT'
      WHEN 'CARD'     THEN 'Kart'
      ELSE NEW.method
    END;

    PERFORM _send_push_async(
      _region_manager_roles(v_region),
      'Onay bekleyen tahsilat',
      'Tutar: ' || NEW.amount::text || ' ₺ (' || method_label || ')'
        || COALESCE(E'\nOluşturan: ' || collector_name, ''),
      '/finance/pending',
      'payment',
      'payment_unconfirmed',
      jsonb_build_object('id', NEW.id, 'reservation_id', NEW.reservation_id),
      v_region
    );
  END IF;
  RETURN NEW;
END;
$$;

-- New reservation (final: 119). Wider region recipient set.
CREATE OR REPLACE FUNCTION _notify_new_reservation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  guest_name   text;
  unit_name    text;
  creator_name text;
  v_region     text;
BEGIN
  SELECT full_name INTO guest_name FROM guests WHERE id = NEW.guest_id;
  SELECT name INTO unit_name FROM units WHERE id = NEW.unit_id;
  SELECT full_name INTO creator_name
    FROM staff_profiles WHERE user_id = NEW.created_by;
  SELECT region INTO v_region FROM properties WHERE id = NEW.property_id;

  PERFORM _send_push_async(
    _region_reservation_roles(v_region),
    'Yeni rezervasyon',
    COALESCE(guest_name, 'Misafir') || ' · ' || COALESCE(unit_name, 'birim')
      || ' · ' || to_char(NEW.stay_start, 'DD Mon') || '→' || to_char(NEW.stay_end, 'DD Mon')
      || COALESCE(E'\nOluşturan: ' || creator_name, ''),
    '/reservations/' || NEW.id::text,
    'reservation',
    'new_reservation',
    jsonb_build_object('id', NEW.id),
    v_region
  );
  RETURN NEW;
END;
$$;

-- Reservation auto-completed (final: 115). Managers of the region.
CREATE OR REPLACE FUNCTION _notify_reservation_auto_completed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  guest_name text;
  v_region   text;
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' AND auth.uid() IS NULL THEN
    SELECT full_name INTO guest_name FROM guests WHERE id = NEW.guest_id;
    SELECT region INTO v_region FROM properties WHERE id = NEW.property_id;
    PERFORM _send_push_async(
      _region_manager_roles(v_region),
      'Rezervasyon tamamlandı',
      COALESCE(guest_name, 'Misafir') || ' otomatik olarak tamamlandı.',
      '/reservations/' || NEW.id::text,
      'system',
      'reservation_auto_completed',
      jsonb_build_object('id', NEW.id),
      v_region
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Upcoming reservation, 2 days out (final: 119, cron). Region per row.
CREATE OR REPLACE FUNCTION _notify_upcoming_reservations_2d()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r          record;
  guest_name text;
  unit_name  text;
  v_region   text;
  target     date;
BEGIN
  target := (now() AT TIME ZONE 'Europe/Istanbul')::date + 2;

  FOR r IN
    SELECT id, guest_id, unit_id, property_id, stay_start
    FROM reservations
    WHERE (stay_start AT TIME ZONE 'Europe/Istanbul')::date = target
      AND status IN ('upcoming', 'pending')
      AND notified_2d_before IS NULL
  LOOP
    SELECT full_name INTO guest_name FROM guests WHERE id = r.guest_id;
    SELECT name INTO unit_name FROM units WHERE id = r.unit_id;
    SELECT region INTO v_region FROM properties WHERE id = r.property_id;

    PERFORM _send_push_async(
      _region_reservation_roles(v_region),
      'Yaklaşan rezervasyon (2 gün)',
      COALESCE(guest_name, 'Misafir') || ' — ' || COALESCE(unit_name, 'birim')
        || ' · ' || to_char(r.stay_start, 'DD Mon'),
      '/reservations/' || r.id::text,
      'reservation',
      'upcoming_reservation_2d',
      jsonb_build_object('id', r.id),
      v_region
    );

    UPDATE reservations SET notified_2d_before = now() WHERE id = r.id;
  END LOOP;
END;
$$;
