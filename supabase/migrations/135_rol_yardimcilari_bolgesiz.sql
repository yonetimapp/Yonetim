-- =============================================================================
-- Yönetim PMS — migration 135
-- Push-recipient role helpers lose their dead 'bornova' branch.
-- =============================================================================
-- Final check-up finding. _region_reservation_roles (119) and
-- _region_manager_roles (115/117/119) still branch on p_region = 'bornova',
-- returning the two _BORNOVA role names that migration 126 removed.
--
-- Today the branch is dead: no region named 'bornova' exists, so every caller
-- falls through to the ELSE arm, and per-region scoping is done by the send-push
-- region gate (130) against staff_profiles.region/all_regions — roles only decide
-- WHICH KINDS of staff hear about an event, never which region.
--
-- But the branch is a booby trap, not just dead weight: the Bölgeler screen lets
-- the operator name a region anything, and a region literally named 'bornova'
-- would silently route its reservation pushes to two roles that no longer exist —
-- excluding RECEPTION / HOUSEKEEPING / YETKILI there with no error anywhere.
--
-- Fix: both helpers return their flat base-role array unconditionally. The
-- parameter stays (call sites in 130 pass it; changing arity would mean
-- rebuilding four notify functions for no behavioural gain).
-- =============================================================================

-- Reservation events (new_reservation, upcoming_reservation_2d). TEKNIK_PERSONEL
-- stays deliberately absent (119). Client mirror:
-- src/lib/queries/notification_preferences.ts EVENT_RECIPIENT_ROLES.
CREATE OR REPLACE FUNCTION _region_reservation_roles(p_region text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING', 'YETKILI'];
$$;

-- Manager-only events (payment_unconfirmed, reservation_auto_completed).
CREATE OR REPLACE FUNCTION _region_manager_roles(p_region text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['SUPER_ADMIN', 'PROPERTY_MANAGER'];
$$;
