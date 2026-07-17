-- =============================================================================
-- HomeGuru PMS — migration 119
-- "Yeni rezervasyon" + "Yaklaşan rezervasyon" now also reach the roles below Alt
-- Yönetici (except Teknik Personel), each for its OWN region.
-- =============================================================================
-- Recipients per reservation region (RAW role, resolved in the Edge Function):
--   Bornova   → SUPER_ADMIN, PROPERTY_MANAGER, YONETICI_BORNOVA, PERSONEL_BORNOVA
--   Ana Grup  → SUPER_ADMIN, PROPERTY_MANAGER, RECEPTION, HOUSEKEEPING, YETKILI
-- Süper Admin + Alt Yönetici (region-less PROPERTY_MANAGER) are in both, so they
-- get every region as before. TEKNIK_PERSONEL is deliberately absent (its raw role
-- is not HOUSEKEEPING, so it is naturally excluded).
--
-- Only the two reservation events change. payment_unconfirmed /
-- reservation_auto_completed keep the manager-only _region_manager_roles list.
--
-- Client mirror: src/lib/queries/notification_preferences.ts EVENT_RECIPIENT_ROLES
-- (new_reservation + upcoming_reservation_2d) — keep the two in sync.
-- =============================================================================

-- Region → reservation-notification recipient roles.
CREATE OR REPLACE FUNCTION _region_reservation_roles(p_region text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_region = 'bornova'
             THEN ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER', 'YONETICI_BORNOVA', 'PERSONEL_BORNOVA']
           ELSE ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING', 'YETKILI']
         END;
$$;

-- New reservation — region from NEW.property_id. Body verbatim from 115, only the
-- recipient list changes.
CREATE OR REPLACE FUNCTION _notify_new_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    jsonb_build_object('id', NEW.id)
  );
  RETURN NEW;
END;
$$;

-- Upcoming reservation (2 days out, cron) — region per row. Body verbatim from
-- 115, only the recipient list changes.
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
      jsonb_build_object('id', r.id)
    );

    UPDATE reservations SET notified_2d_before = now() WHERE id = r.id;
  END LOOP;
END;
$$;
