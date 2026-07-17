-- =============================================================================
-- HomeGuru PMS — migration 112
-- Avans + maaş route by the RECIPIENT staff's region (not the payer's).
-- =============================================================================
-- A Bornova staff member's (Yönetici/Personel Bornova) avans + maaş now always
-- come out of the Bornova kasa, regardless of who pays. HQ staff → Genel Kasa.
--
--   * staff_region(user) — 'bornova' if the staff has a Bornova role, else NULL.
--   * avans: the kasa-routing trigger resolves the region from the advance's
--     recipient (ref_type='staff_advance', ref_id = staff_advances.id).
--   * maaş: the salary cash_tx carries no recipient (ref_id NULL), so a trigger
--     on staff_salary_payments (which has user_id + cash_tx_id) re-points the
--     cash_tx to the recipient's region kasa. The money functions are untouched.
-- =============================================================================

-- Helpers ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION staff_region(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA') THEN 'bornova'
              ELSE NULL END
  FROM staff_profiles WHERE user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION kasa_for_region(p_region text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT id FROM cash_accounts WHERE region IS NOT DISTINCT FROM p_region LIMIT 1),
    (SELECT id FROM cash_accounts WHERE region IS NULL LIMIT 1)  -- HQ fallback
  );
$$;

-- 1. Routing trigger: add the avans (staff_advance) branch. Rest = 104.
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
  -- All-regions user's MANUAL entry keeps the kasa they chose.
  IF NEW.ref_type IS NULL
     AND NEW.submitted_by IS NOT NULL
     AND auth_sees_all_regions() THEN
    RETURN NEW;
  END IF;

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
  ELSIF NEW.ref_type = 'staff_advance' AND NEW.ref_id IS NOT NULL THEN
    -- avans → the recipient staff's region
    SELECT staff_region(sa.user_id) INTO _region
      FROM staff_advances sa WHERE sa.id = NEW.ref_id;
    _resolved := true;
  END IF;

  -- maaş (staff_salary_payment, no ref) + truly-unbound rows → caller's region;
  -- maaş is then corrected to the recipient's region by the trigger below.
  IF NOT _resolved THEN
    _region := auth_region();
  END IF;

  NEW.cash_account_id := kasa_for_region(_region);
  RETURN NEW;
END;
$$;

-- 2. maaş: re-point the salary cash_tx to the recipient's region kasa. Fires on
--    the staff_salary_payments insert (manual + auto), which carries user_id +
--    cash_tx_id. Runs in the same transaction as the payment, so atomic.
CREATE OR REPLACE FUNCTION reroute_salary_to_staff_region()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _kasa uuid;
BEGIN
  IF NEW.cash_tx_id IS NULL THEN
    RETURN NEW;
  END IF;
  _kasa := kasa_for_region(staff_region(NEW.user_id));
  NEW.cash_account_id := _kasa;                       -- keep the denorm in sync
  UPDATE cash_transactions SET cash_account_id = _kasa WHERE id = NEW.cash_tx_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS staff_salary_payments_reroute ON staff_salary_payments;
CREATE TRIGGER staff_salary_payments_reroute
  BEFORE INSERT ON staff_salary_payments
  FOR EACH ROW EXECUTE FUNCTION reroute_salary_to_staff_region();
