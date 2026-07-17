-- =============================================================================
-- HomeGuru PMS — migration 014
-- Tightens staff_advances RLS so PROPERTY_MANAGER may only modify advances
-- belonging to staff in their own branch.
-- =============================================================================
-- 003_rls.sql defined a tight SELECT (manager sees their branch's staff,
-- everyone sees their own) but a loose modify policy:
--
--   CREATE POLICY staff_advances_modify ON staff_advances FOR ALL
--     USING       (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
--     WITH CHECK  (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));
--
-- A manager from Branch A could insert/update/delete an advance against
-- Branch B's staff if they discovered the row's UUID. Mirrors the gaps
-- already fixed for cash (010), ledger (011), expenses (013).
--
-- Branch is derived through staff_profiles.property_id of the target user.
-- =============================================================================

DROP POLICY IF EXISTS staff_advances_modify ON staff_advances;

CREATE POLICY staff_advances_modify ON staff_advances FOR ALL
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND staff_advances.user_id IN (
        SELECT user_id FROM staff_profiles WHERE property_id = auth_property_id()
      )
    )
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND staff_advances.user_id IN (
        SELECT user_id FROM staff_profiles WHERE property_id = auth_property_id()
      )
    )
  );
