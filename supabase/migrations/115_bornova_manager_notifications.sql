-- =============================================================================
-- HomeGuru PMS — migration 115
-- Yönetici Bornova receives the same push notifications as Alt Yönetici
-- (PROPERTY_MANAGER), region-filtered to Bornova.
-- =============================================================================
-- Push recipients are resolved by the RAW role column in the Edge Function, so a
-- YONETICI_BORNOVA never matched the 'PROPERTY_MANAGER' literal the triggers sent
-- — meaning a Bornova manager got ZERO notifications. This adds the role to the
-- five events Alt Yönetici receives, but only when the underlying entity is in the
-- Bornova region (HQ/Ana Grup entities are unchanged). The three SUPER_ADMIN-only
-- events (pending_approval, pending_google_reservation, salary_auto_paid) are left
-- as-is, mirroring Alt Yönetici which also does not receive them.
--
-- NOTE: the client notification-settings modal mirrors this routing in
-- src/lib/queries/notification_preferences.ts (EVENT_RECIPIENT_ROLES) so each role
-- only sees toggles for events it can actually receive — keep the two in sync.
-- =============================================================================

-- Region → manager recipient roles. Bornova entities also notify the Bornova
-- manager; everything else is the HQ pair (Süper Admin + Alt Yönetici).
CREATE OR REPLACE FUNCTION _region_manager_roles(p_region text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_region = 'bornova'
              THEN ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER', 'YONETICI_BORNOVA']
              ELSE ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER'] END;
$$;

-- 1. New housekeeping issue — managers (region-aware) + Teknik Personel for
--    Bornova. Supersedes the version in migration 114. Body unchanged (070/114).
CREATE OR REPLACE FUNCTION _notify_new_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  unit_name           text;
  property_name       text;
  issue_region        text;
  guest_name          text;
  res_creator_name    text;
  reporter_name       text;
  body                text;
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
    _region_manager_roles(issue_region)
      || (CASE WHEN issue_region = 'bornova'
               THEN ARRAY['TEKNIK_PERSONEL_BORNOVA'] ELSE ARRAY[]::text[] END),
    'Yeni sorun bildirimi',
    body,
    '/housekeeping',
    'issue',
    'new_issue',
    jsonb_build_object('id', NEW.id, 'unit_id', NEW.unit_id)
  );
  RETURN NEW;
END;
$$;

-- 2. Unconfirmed payment — region from the payment's reservation. Body unchanged (072).
CREATE OR REPLACE FUNCTION _notify_new_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
      jsonb_build_object('id', NEW.id, 'reservation_id', NEW.reservation_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- 3. New reservation — region from NEW.property_id. Body unchanged (070).
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
    _region_manager_roles(v_region),
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

-- 4. Reservation auto-completed (cron) — region from NEW.property_id. Body unchanged (053).
CREATE OR REPLACE FUNCTION _notify_reservation_auto_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
      jsonb_build_object('id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Upcoming reservation 2 days out (cron) — region per row. Body unchanged (053).
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
      _region_manager_roles(v_region),
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
