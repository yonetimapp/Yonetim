-- =============================================================================
-- HomeGuru PMS — migration 109
-- Region-isolate the Personel list: a Bornova manager sees only Bornova staff.
-- =============================================================================
-- staff_profiles_select (033) let any PROPERTY_MANAGER see all staff. A Yönetici
-- Bornova normalises to PROPERTY_MANAGER (auth_role), so it was seeing the HQ
-- team (names + salaries) too. Now:
--   * SUPER_ADMIN + Alt Yönetici (auth_sees_all_regions) → everyone, as before.
--   * Yönetici Bornova → only staff with a Bornova role (Yönetici/Personel Bornova).
--   * everyone still sees their own row.
-- =============================================================================

DROP POLICY IF EXISTS staff_profiles_select ON staff_profiles;
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_sees_all_regions()
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() = 'bornova'
      AND role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA')
    )
  );
