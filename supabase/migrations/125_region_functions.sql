-- =============================================================================
-- Yönetim PMS — migration 125
-- Regions: decouple access from the role + add admin CRUD (behaviour).
-- =============================================================================
-- Re-release change #2, part 2 of 2 (behaviour; 124 = structure).
--
-- The whole region-scoped RLS + money-routing layer is expressed through a few
-- helper functions (auth_region / auth_sees_all_regions / staff_region /
-- kasa_for_region / auth_sees_property). Migrations 098–120 made those derive the
-- region from the ROLE ('bornova' for the Bornova roles). We now make them
-- COLUMN-driven instead, so region access is a per-user assignment:
--
--   auth_region()        → the caller's home region  (staff_profiles.region)
--   auth_all_regions()   → sees every region?        (SUPER_ADMIN OR all_regions)
--   auth_sees_all_regions() → finance all-region gate (manager/admin + the flag)
--   staff_region(u)      → the RECIPIENT's home region (drives maaş/avans kasa)
--
-- Because the routing trigger (route_cash_tx_to_region_kasa) and every region RLS
-- policy already call these helpers, redefining the helpers generalises the model
-- to N regions with NO change to the trigger and only two touch-ups below
-- (auth_sees_property uses the any-role flag; staff_profiles_select drops the
-- Bornova-only clause). The Bornova roles still exist in the CHECK until migration
-- 126 removes them; on the new operator's DB none are ever created.
-- =============================================================================

-- 1. The caller's home region — now the authoritative staff_profiles.region
--    column (was role-derived). NULL only for a caller with no profile.
CREATE OR REPLACE FUNCTION auth_region()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT region FROM staff_profiles
   WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION auth_region() TO authenticated;

-- 2. Does the caller see EVERY region? Any role may be granted all-region access
--    (visibility). SUPER_ADMIN always does. Used for property/reservation/etc.
--    visibility (any role) — NOT for finance (see auth_sees_all_regions()).
CREATE OR REPLACE FUNCTION auth_all_regions()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role = 'SUPER_ADMIN' OR all_regions
       FROM staff_profiles
      WHERE user_id = auth.uid() AND deleted_at IS NULL),
    false);
$$;
GRANT EXECUTE ON FUNCTION auth_all_regions() TO authenticated;

-- 3. Finance all-region gate: kept manager/admin-scoped (a YETKILI with the
--    all_regions flag must still NOT see the kasa) but now driven by the flag
--    instead of "region IS NULL". Used by cash_accounts / cash_tx / expenses RLS.
CREATE OR REPLACE FUNCTION auth_sees_all_regions()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth_role() = 'SUPER_ADMIN'
      OR (auth_role() = 'PROPERTY_MANAGER' AND auth_all_regions());
$$;
GRANT EXECUTE ON FUNCTION auth_sees_all_regions() TO authenticated;

-- 4. The recipient staff's home region → the kasa their maaş/avans come out of.
CREATE OR REPLACE FUNCTION staff_region(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT region FROM staff_profiles WHERE user_id = p_user_id;
$$;

-- 5. kasa_for_region: fall back to the DEFAULT region's kasa (was the NULL/HQ
--    kasa, which no longer exists now that HQ is the explicit 'Genel' region).
CREATE OR REPLACE FUNCTION kasa_for_region(p_region text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT id FROM cash_accounts WHERE region IS NOT DISTINCT FROM p_region LIMIT 1),
    (SELECT ca.id FROM cash_accounts ca
       JOIN regions r ON r.name = ca.region
      WHERE r.is_default
      LIMIT 1)
  );
$$;

-- 6. Property visibility chokepoint: the region bypass now honours the any-role
--    all_regions flag (auth_all_regions), so a RECEPTION / YETKILI granted "all
--    regions" sees every region's properties. Teknik keeps its explicit bypass;
--    access_scope (HOTELS/APARTMENTS) still applies. Otherwise verbatim from 117.
CREATE OR REPLACE FUNCTION auth_sees_property(p_property_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1
      FROM staff_profiles sp
      JOIN properties pr ON pr.id = p_property_id
      WHERE sp.user_id = auth.uid()
        AND sp.deleted_at IS NULL
        AND sp.role <> 'PENDING'
        AND (
          sp.role = 'TEKNIK_PERSONEL'
          OR (
            (auth_all_regions() OR auth_region() IS NOT DISTINCT FROM pr.region)
            AND (
              sp.access_scope = 'ALL'
              OR (sp.access_scope = 'HOTELS' AND pr.type = 'HOTEL')
              OR (sp.access_scope = 'APARTMENTS' AND pr.type = 'APARTMENT')
            )
          )
        )
    );
$$;
GRANT EXECUTE ON FUNCTION auth_sees_property(uuid) TO authenticated;

-- 7. Staff visibility: a region manager sees the staff of their own region;
--    all-region managers/admin see everyone; everyone sees themselves. Drops the
--    old Bornova-only clause (117).
DROP POLICY IF EXISTS staff_profiles_select ON staff_profiles;
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER' AND region IS NOT DISTINCT FROM auth_region())
  );

-- -----------------------------------------------------------------------------
-- 8. Admin CRUD for regions (SUPER_ADMIN only). Creating a region also creates
--    its one kasa; renaming fans out via the ON UPDATE CASCADE FK (124); deleting
--    is guarded against the default region and any region still in use.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_region(p_name text)
RETURNS regions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _r regions;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici bölge oluşturabilir' USING ERRCODE = '42501';
  END IF;
  p_name := btrim(coalesce(p_name, ''));
  IF p_name = '' THEN RAISE EXCEPTION 'Bölge adı boş olamaz'; END IF;
  IF EXISTS (SELECT 1 FROM regions WHERE lower(name) = lower(p_name)) THEN
    RAISE EXCEPTION 'Bu isimde bir bölge zaten var';
  END IF;
  INSERT INTO regions (name, is_default) VALUES (p_name, false) RETURNING * INTO _r;
  -- One kasa per region; the kasa is named exactly after the region.
  INSERT INTO cash_accounts (name, account_type, currency, region)
  VALUES (p_name, 'CASH', 'TRY', p_name);
  RETURN _r;
END;
$$;
GRANT EXECUTE ON FUNCTION create_region(text) TO authenticated;

CREATE OR REPLACE FUNCTION rename_region(p_id uuid, p_name text)
RETURNS regions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _old text; _r regions;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici bölge adını değiştirebilir' USING ERRCODE = '42501';
  END IF;
  p_name := btrim(coalesce(p_name, ''));
  IF p_name = '' THEN RAISE EXCEPTION 'Bölge adı boş olamaz'; END IF;
  SELECT name INTO _old FROM regions WHERE id = p_id;
  IF _old IS NULL THEN RAISE EXCEPTION 'Bölge bulunamadı'; END IF;
  IF EXISTS (SELECT 1 FROM regions WHERE lower(name) = lower(p_name) AND id <> p_id) THEN
    RAISE EXCEPTION 'Bu isimde bir bölge zaten var';
  END IF;
  UPDATE regions SET name = p_name WHERE id = p_id RETURNING * INTO _r;  -- cascades to every reference
  -- Keep the kasa label in sync when it still carries the old region name.
  UPDATE cash_accounts SET name = p_name
    WHERE region = p_name AND name = _old;
  RETURN _r;
END;
$$;
GRANT EXECUTE ON FUNCTION rename_region(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION delete_region(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _name text; _is_default boolean;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici bölge silebilir' USING ERRCODE = '42501';
  END IF;
  SELECT name, is_default INTO _name, _is_default FROM regions WHERE id = p_id;
  IF _name IS NULL THEN RAISE EXCEPTION 'Bölge bulunamadı'; END IF;
  IF _is_default THEN RAISE EXCEPTION 'Varsayılan bölge silinemez'; END IF;
  IF EXISTS (SELECT 1 FROM properties WHERE region = _name) THEN
    RAISE EXCEPTION 'Bu bölgede mülk var; önce mülkleri başka bölgeye taşıyın';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_profiles WHERE region = _name AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Bu bölgeye atanmış personel var; önce personeli başka bölgeye taşıyın';
  END IF;
  IF EXISTS (SELECT 1 FROM expenses WHERE region = _name) THEN
    RAISE EXCEPTION 'Bu bölgede gider kaydı var; bölge silinemez';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cash_transactions ct
    JOIN cash_accounts ca ON ca.id = ct.cash_account_id
    WHERE ca.region = _name
  ) THEN
    RAISE EXCEPTION 'Bu bölgenin kasasında hareket var; bölge silinemez';
  END IF;
  -- Empty region: detach any dangling salary denorm, drop the kasa, drop the region.
  UPDATE staff_salary_payments SET cash_account_id = NULL
    WHERE cash_account_id IN (SELECT id FROM cash_accounts WHERE region = _name);
  DELETE FROM cash_accounts WHERE region = _name;
  DELETE FROM regions WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION delete_region(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. Region-isolation corrections for the column-based model.
-- Migrations 103/113/096 used "auth_region() IS NULL" (or IS NOT NULL) as the old
-- "all regions" signal. Region is never NULL now (it defaults to 'Genel'), so
-- those checks silently break — they must use auth_all_regions() / its negation.
-- Everything else in these policies is verbatim from 103/113/096.
-- -----------------------------------------------------------------------------

-- guests_select (103): blanket guest visibility is for all-region desk/manager
-- roles; a region-scoped role only reaches guests via a visible reservation.
DROP POLICY IF EXISTS guests_select ON guests;
CREATE POLICY guests_select ON guests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION') AND auth_all_regions())
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guests.id
        AND auth_sees_property(r.property_id)
    )
  );

-- guest_companions_select + _modify USING (113): mirror guests_select.
DROP POLICY IF EXISTS guest_companions_select ON guest_companions;
CREATE POLICY guest_companions_select ON guest_companions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION') AND auth_all_regions())
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guest_companions.guest_id
        AND auth_sees_property(r.property_id)
    )
  );

DROP POLICY IF EXISTS guest_companions_modify ON guest_companions;
CREATE POLICY guest_companions_modify ON guest_companions FOR ALL
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION') AND auth_all_regions())
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guest_companions.guest_id
        AND auth_sees_property(r.property_id)
    )
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
  );

-- auth_can_review_region (096): a region-restricted (non-all-region) manager may
-- review items in their own region; all-region managers stay review-excluded (HQ
-- approval to SUPER_ADMIN), preserving the pre-existing behaviour.
CREATE OR REPLACE FUNCTION auth_can_review_region(p_region text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND NOT auth_all_regions()
      AND p_region IS NOT DISTINCT FROM auth_region()
    );
$$;
GRANT EXECUTE ON FUNCTION auth_can_review_region(text) TO authenticated;
