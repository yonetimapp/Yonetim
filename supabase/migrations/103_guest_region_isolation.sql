-- =============================================================================
-- HomeGuru PMS — migration 103
-- Region-isolate guest visibility: a Bornova role sees only Bornova-linked guests.
-- =============================================================================
-- guests_select (033) gave PROPERTY_MANAGER / RECEPTION BLANKET access to every
-- guest. A YONETICI_BORNOVA normalises to PROPERTY_MANAGER (auth_role()), so it
-- was inheriting that blanket access — seeing all guests, not just Bornova ones.
--
-- Fix: the blanket clause now requires a region-less user (auth_region() IS NULL
-- = SUPER_ADMIN / Alt Yönetici / HQ reception). A region-restricted Bornova role
-- (auth_region() = 'bornova') falls through to the scoped EXISTS, which only
-- matches a guest who has a reservation the caller can see (auth_sees_property,
-- already region-aware). So a Bornova role sees exactly the guests with a
-- Bornova reservation. Super admin + Alt Yönetici + HQ desk are unchanged.
-- =============================================================================

DROP POLICY IF EXISTS guests_select ON guests;
CREATE POLICY guests_select ON guests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION') AND auth_region() IS NULL)
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guests.id
        AND auth_sees_property(r.property_id)
    )
  );
