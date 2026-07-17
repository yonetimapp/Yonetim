-- =============================================================================
-- HomeGuru PMS — migration 072
-- Push body for "Onay bekleyen tahsilat" uses Turkish method label.
-- =============================================================================
-- Migration 070 wired Oluşturan into the push body but kept the raw
-- payment_method code (CASH / TRANSFER / CARD) in the parenthesis. The
-- operator's phone shouldn't ever surface those English tokens — the rest
-- of the app translates them at display time, but the push body is
-- generated server-side so the trigger has to do the mapping itself.
-- =============================================================================

CREATE OR REPLACE FUNCTION _notify_new_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  collector_name text;
  method_label   text;
BEGIN
  IF NEW.status = 'UNCONFIRMED' THEN
    SELECT full_name INTO collector_name
      FROM staff_profiles WHERE user_id = NEW.collected_by_user_id;

    method_label := CASE NEW.method
      WHEN 'CASH'     THEN 'Nakit'
      WHEN 'TRANSFER' THEN 'Havale/EFT'
      WHEN 'CARD'     THEN 'Kart'
      ELSE NEW.method
    END;

    PERFORM _send_push_async(
      ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER']::text[],
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
