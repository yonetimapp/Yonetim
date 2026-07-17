-- =============================================================================
-- HomeGuru PMS — migration 070
-- Push notifications: include Oluşturan + richer context in every body.
-- =============================================================================
-- Each trigger now resolves the relevant staff names + extra context and
-- formats the push body so the operator sees who did what at a glance:
--
--   new_issue:                 Mülk / Birim · Misafir adı
--                              Sorun: kısaltılmış açıklama
--                              Rezervasyonu açan: X
--                              Sorunu açan: Y
--   new_reservation:           Misafir · Mülk Birim · DD Mon → DD Mon
--                              Oluşturan: X
--   payment_unconfirmed:       Tutar ₺ (yöntem)
--                              Oluşturan: X
--   pending_approval (cash):   ± Tutar ₺ · açıklama
--                              Oluşturan: X
--   pending_approval (exp):    Mülk — kategori · Tutar ₺
--                              Oluşturan: X
--   reservation_auto_completed: Misafir otomatik tamamlandı.   (system event)
--   salary_auto_paid:          Personel — Tutar ₺              (system event)
--   upcoming_reservation_2d:   Misafir — Birim · DD Mon        (system event)
--
-- System-driven events that have no human originator deliberately omit
-- "Oluşturan" — the operator already knows it's a cron output.
-- =============================================================================

CREATE OR REPLACE FUNCTION _notify_new_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  unit_name           text;
  property_name       text;
  guest_name          text;
  res_creator_name    text;
  reporter_name       text;
  body                text;
BEGIN
  SELECT u.name, p.name
    INTO unit_name, property_name
  FROM units u
  JOIN properties p ON p.id = u.property_id
  WHERE u.id = NEW.unit_id;

  -- Most recently started active reservation on this unit, if any.
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
    ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
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

-- ----------------------------------------------------------------------------
-- New reservation: who created it.
-- ----------------------------------------------------------------------------
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
BEGIN
  SELECT full_name INTO guest_name FROM guests WHERE id = NEW.guest_id;
  SELECT name INTO unit_name FROM units WHERE id = NEW.unit_id;
  SELECT full_name INTO creator_name
    FROM staff_profiles WHERE user_id = NEW.created_by;

  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
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

-- ----------------------------------------------------------------------------
-- Payment collection (UNCONFIRMED): who collected it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  collector_name text;
BEGIN
  IF NEW.status = 'UNCONFIRMED' THEN
    SELECT full_name INTO collector_name
      FROM staff_profiles WHERE user_id = NEW.collected_by_user_id;

    PERFORM _send_push_async(
      ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
      'Onay bekleyen tahsilat',
      'Tutar: ' || NEW.amount::text || ' ₺ (' || NEW.method || ')'
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

-- ----------------------------------------------------------------------------
-- Pending expense (manager submission awaiting yönetici).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_pending_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prop_name    text;
  creator_name text;
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;
  SELECT name INTO prop_name FROM properties WHERE id = NEW.property_id;
  SELECT full_name INTO creator_name
    FROM staff_profiles WHERE user_id = NEW.created_by;

  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Onay bekleyen gider',
    COALESCE(prop_name, 'Genel') || ' — ' || NEW.category || ' · ' || NEW.amount::text || ' ₺'
      || COALESCE(E'\nOluşturan: ' || creator_name, ''),
    '/finance/pending',
    'system',
    'pending_approval',
    jsonb_build_object('id', NEW.id, 'kind', 'expense')
  );
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Pending cash transaction.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_pending_cash_tx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  creator_name text;
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;
  SELECT full_name INTO creator_name
    FROM staff_profiles
    WHERE user_id = COALESCE(NEW.submitted_by, NEW.created_by);

  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Onay bekleyen kasa hareketi',
    (CASE WHEN NEW.direction = 'IN' THEN '+ ' ELSE '- ' END)
      || NEW.amount::text || ' ₺'
      || COALESCE(' · ' || NEW.description, '')
      || COALESCE(E'\nOluşturan: ' || creator_name, ''),
    '/finance/pending',
    'system',
    'pending_approval',
    jsonb_build_object('id', NEW.id, 'kind', 'cash_tx')
  );
  RETURN NEW;
END;
$$;
