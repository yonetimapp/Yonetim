-- =============================================================================
-- HomeGuru PMS — migration 113
-- Close the remaining FOR-ALL "modify" policy leaks (same root cause as 111).
-- =============================================================================
-- A FOR ALL policy's USING also governs SELECT, so role-based modify policies
-- were OR-ing past the region-scoped reads. Three tables still leaked HQ data to
-- a Yönetici Bornova: expenses (genel giderler), staff_advances, guest_companions.
-- =============================================================================

-- 1. expenses: the granular select/insert/update/delete (102) already cover every
--    operation with region scoping, so expenses_modify (038) is redundant AND
--    leaked all genel giderler. Drop it.
DROP POLICY IF EXISTS expenses_modify ON expenses;

-- 2. staff_advances: scope by the RECIPIENT staff's region (staff_region). A
--    Bornova manager sees/manages only Bornova staff's avans; super admin + Alt
--    Yönetici all; everyone still sees their own.
DROP POLICY IF EXISTS staff_advances_select ON staff_advances;
CREATE POLICY staff_advances_select ON staff_advances FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER'
        AND staff_region(user_id) IS NOT DISTINCT FROM auth_region())
  );

DROP POLICY IF EXISTS staff_advances_modify ON staff_advances;
CREATE POLICY staff_advances_modify ON staff_advances FOR ALL
  USING (
    auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER'
        AND staff_region(user_id) IS NOT DISTINCT FROM auth_region())
  )
  WITH CHECK (
    auth_sees_all_regions()
    OR (auth_role() = 'PROPERTY_MANAGER'
        AND staff_region(user_id) IS NOT DISTINCT FROM auth_region())
  );

-- 3. guest_companions: follow the guest's visibility (mirrors guests_select, 103).
--    Blanket only for region-less desk roles; a Bornova role sees companions of
--    guests it can reach via a Bornova reservation.
DROP POLICY IF EXISTS guest_companions_select ON guest_companions;
CREATE POLICY guest_companions_select ON guest_companions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION') AND auth_region() IS NULL)
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guest_companions.guest_id
        AND auth_sees_property(r.property_id)
    )
  );

DROP POLICY IF EXISTS guest_companions_modify ON guest_companions;
CREATE POLICY guest_companions_modify ON guest_companions FOR ALL
  -- USING governs the read/update/delete path → region-scoped (closes the leak).
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION') AND auth_region() IS NULL)
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guest_companions.guest_id
        AND auth_sees_property(r.property_id)
    )
  )
  -- WITH CHECK governs inserts → keep role-based so a companion can still be
  -- added to a guest that has no reservation yet (creation isn't a read leak).
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
  );
