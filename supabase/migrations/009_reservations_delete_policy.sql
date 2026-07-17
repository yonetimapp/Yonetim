-- =============================================================================
-- HomeGuru PMS — migration 009
-- Adds the missing DELETE policy for reservations.
-- =============================================================================
-- 003_rls.sql defined SELECT / INSERT / UPDATE policies for `reservations` but
-- no DELETE policy. With RLS enabled and no matching policy, Postgres silently
-- blocks every delete (0 rows affected, no error) — so the app could never
-- remove a reservation.
--
-- Hard-delete is permitted for the same roles that can cancel a reservation:
-- SUPER_ADMIN, PROPERTY_MANAGER, RECEPTION. Branch isolation is still enforced —
-- non-admins may only delete reservations belonging to their own property.
-- =============================================================================

CREATE POLICY reservations_delete ON reservations FOR DELETE
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );
