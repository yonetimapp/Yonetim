-- =============================================================================
-- HomeGuru PMS — migration 038
-- Property-optional expenses: a gider can be a general business cost that is
-- not tied to any mülk (e.g. accountant fees, company-wide costs).
-- =============================================================================

-- 1. property_id becomes optional.
ALTER TABLE expenses ALTER COLUMN property_id DROP NOT NULL;

-- 2. RLS — a property-less expense has no scope, so it is visible to and
--    editable by any finance role (SUPER_ADMIN + PROPERTY_MANAGER).
--    Property-tied expenses keep their per-scope check.
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND (property_id IS NULL OR auth_sees_property(property_id))
    )
  );

DROP POLICY IF EXISTS expenses_modify ON expenses;
CREATE POLICY expenses_modify ON expenses FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (property_id IS NULL OR auth_sees_property(property_id))
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (property_id IS NULL OR auth_sees_property(property_id))
  );
