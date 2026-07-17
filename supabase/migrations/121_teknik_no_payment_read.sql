-- =============================================================================
-- HomeGuru PMS — migration 121
-- Teknik Personel cannot read payment collections (tahsilat / finance data).
-- =============================================================================
-- Migration 117 gave Teknik an all-regions bypass in auth_sees_property() so it
-- can see reservations + housekeeping issues + units everywhere. But that helper
-- is also the gate for payment_collections_select (033), so the bypass silently
-- let Teknik read every tahsilat amount/method across all regions via the API —
-- beyond its "reservations + issues" scope, and Teknik has no finance role at all
-- (cash_accounts / expenses already exclude it, since those gate on
-- auth_sees_all_regions()/PROPERTY_MANAGER, not auth_sees_property).
--
-- Fix: exclude Teknik from payment_collections_select by RAW role (auth_role()
-- returns 'HOUSEKEEPING' for it, so it can't be distinguished there). Guest reads
-- are intentionally NOT touched — the reservation Liste that Teknik legitimately
-- sees shows each guest's name/phone via the guests join, and guests_select only
-- exposes guests reachable through a visible reservation, so that is inherent to
-- the all-regions reservation access (and TC/passport stays blocked, migration
-- 117). Payment WRITES are already blocked by the migration 118 trigger.
-- =============================================================================

DROP POLICY IF EXISTS payment_collections_select ON payment_collections;
CREATE POLICY payment_collections_select ON payment_collections FOR SELECT
  USING (
    auth_sees_property(property_id)
    AND (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
          IS DISTINCT FROM 'TEKNIK_PERSONEL'
  );
