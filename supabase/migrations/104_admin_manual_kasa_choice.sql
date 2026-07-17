-- =============================================================================
-- HomeGuru PMS — migration 104
-- Let an all-regions user's MANUAL kasa entry land in the kasa they chose.
-- =============================================================================
-- The routing trigger (095) force-routes every movement to a region kasa. For a
-- manual entry (submit_cash_tx) by SUPER_ADMIN / Alt Yönetici this ignored the
-- kasa they picked in the switcher and always used their own region (HQ) — so
-- they couldn't hand-add a row to the Bornova kasa.
--
-- A manual entry is identifiable: ref_type IS NULL AND submitted_by IS NOT NULL
-- (avans/maaş set ref_type; system posts don't set submitted_by). For an
-- all-regions user we now keep the explicitly-passed cash_account_id. A
-- region-restricted manager is still force-routed to their own kasa, so they
-- can't inject into another region's kasa.
-- =============================================================================

CREATE OR REPLACE FUNCTION route_cash_tx_to_region_kasa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _region    text;
  _resolved  boolean := false;
BEGIN
  -- All-regions user (admin / Alt Yönetici) making a MANUAL entry keeps the kasa
  -- they chose. Region-restricted users fall through and are force-routed below.
  IF NEW.ref_type IS NULL
     AND NEW.submitted_by IS NOT NULL
     AND auth_sees_all_regions() THEN
    RETURN NEW;
  END IF;

  -- Otherwise work out the region this movement belongs to.
  IF NEW.property_id IS NOT NULL THEN
    _region := (SELECT region FROM properties WHERE id = NEW.property_id);
    _resolved := true;
  ELSIF NEW.ref_type = 'expense' AND NEW.ref_id IS NOT NULL THEN
    SELECT region INTO _region FROM expenses WHERE id = NEW.ref_id;
    _resolved := true;
  ELSIF NEW.ref_type = 'payment_collection' AND NEW.ref_id IS NOT NULL THEN
    SELECT region_of_property(property_id) INTO _region
      FROM payment_collections WHERE id = NEW.ref_id;
    _resolved := true;
  END IF;

  -- No mülk / gider / tahsilat behind it (avans, maaş) → caller's region.
  IF NOT _resolved THEN
    _region := auth_region();
  END IF;

  NEW.cash_account_id := COALESCE(
    (SELECT id FROM cash_accounts WHERE region IS NOT DISTINCT FROM _region LIMIT 1),
    (SELECT id FROM cash_accounts WHERE region IS NULL LIMIT 1)
  );
  RETURN NEW;
END;
$$;
