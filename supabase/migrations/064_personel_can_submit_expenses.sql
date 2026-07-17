-- =============================================================================
-- HomeGuru PMS — migration 064
-- Personel (YETKILI) can submit giderler — but they queue for yönetici onay.
-- =============================================================================
-- Migration 055 made record_expense role-aware: non-SUPER_ADMIN inserts
-- land with approval_status='pending' and no kasa OUT until the yönetici
-- approves. The remaining gap was RLS — `expenses_modify` (003_rls) was
-- FOR ALL with USING/CHECK = ('SUPER_ADMIN', 'PROPERTY_MANAGER'), so
-- YETKILI's INSERT (via record_expense, SECURITY INVOKER) was blocked
-- at the RLS layer regardless of the column default.
--
-- Fix: split the policy into a more permissive INSERT path (admin /
-- manager / personel, with `approval_status='pending'` forced for the
-- personel branch — same shape as cash_tx_insert in migration 062) and
-- a stricter UPDATE/DELETE path that stays admin/manager-only. Also add
-- a SELECT branch so the operator can later see their own pending /
-- rejected submissions on the expenses list.
-- =============================================================================

DROP POLICY IF EXISTS expenses_modify ON expenses;

CREATE POLICY expenses_insert ON expenses FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    OR (auth_role() = 'YETKILI' AND approval_status = 'pending')
  );

CREATE POLICY expenses_update ON expenses FOR UPDATE
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

CREATE POLICY expenses_delete ON expenses FOR DELETE
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- Extend SELECT so YETKILI can see expenses they themselves submitted,
-- alongside the existing admin / branch-manager paths from migration 033.
DROP POLICY IF EXISTS expenses_select ON expenses;
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND property_id = auth_property_id())
    OR (auth_role() = 'YETKILI' AND created_by = auth.uid())
  );
