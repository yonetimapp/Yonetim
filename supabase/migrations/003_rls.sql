-- =============================================================================
-- HomeGuru PMS — RLS migration 003
-- =============================================================================
-- All tenanted tables enforce property-scoped access.
-- SUPER_ADMIN bypasses checks (via auth_role() from 002_functions.sql).
-- =============================================================================

-- Enable RLS on every table that contains property-scoped data
ALTER TABLE properties           ENABLE ROW LEVEL SECURITY;
ALTER TABLE units                ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_advances       ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests               ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_tasks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_issues  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_collections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kbs_submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates    ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- properties
-- -----------------------------------------------------------------------------
CREATE POLICY properties_select ON properties FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR id = auth_property_id()
  );

CREATE POLICY properties_modify ON properties FOR ALL
  USING (auth_role() = 'SUPER_ADMIN')
  WITH CHECK (auth_role() = 'SUPER_ADMIN');

-- -----------------------------------------------------------------------------
-- units
-- -----------------------------------------------------------------------------
CREATE POLICY units_select ON units FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

CREATE POLICY units_modify ON units FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

-- -----------------------------------------------------------------------------
-- staff_profiles
-- -----------------------------------------------------------------------------
CREATE POLICY staff_profiles_select ON staff_profiles FOR SELECT
  USING (
    user_id = auth.uid()
    OR auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND property_id = auth_property_id())
  );

CREATE POLICY staff_profiles_modify ON staff_profiles FOR ALL
  USING (auth_role() = 'SUPER_ADMIN')
  WITH CHECK (auth_role() = 'SUPER_ADMIN');

-- -----------------------------------------------------------------------------
-- staff_advances
-- -----------------------------------------------------------------------------
CREATE POLICY staff_advances_select ON staff_advances FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND user_id IN (
      SELECT user_id FROM staff_profiles WHERE property_id = auth_property_id()
    ))
    OR user_id = auth.uid()
  );

CREATE POLICY staff_advances_modify ON staff_advances FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- -----------------------------------------------------------------------------
-- guests
-- -----------------------------------------------------------------------------
CREATE POLICY guests_select ON guests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guests.id
        AND r.property_id = auth_property_id()
    )
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
  );

CREATE POLICY guests_insert ON guests FOR INSERT
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION'));

CREATE POLICY guests_update ON guests FOR UPDATE
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION'));

CREATE POLICY guests_delete ON guests FOR DELETE
  USING (auth_role() = 'SUPER_ADMIN');

-- -----------------------------------------------------------------------------
-- reservations
-- -----------------------------------------------------------------------------
CREATE POLICY reservations_select ON reservations FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

CREATE POLICY reservations_insert ON reservations FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

CREATE POLICY reservations_update ON reservations FOR UPDATE
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION')
    AND (auth_role() = 'SUPER_ADMIN' OR property_id = auth_property_id())
  );

-- -----------------------------------------------------------------------------
-- ledger_entries (finance — reception cannot see)
-- -----------------------------------------------------------------------------
CREATE POLICY ledger_select ON ledger_entries FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = ledger_entries.reservation_id
          AND r.property_id = auth_property_id()
      )
    )
  );

CREATE POLICY ledger_insert ON ledger_entries FOR INSERT
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- -----------------------------------------------------------------------------
-- cash_accounts + cash_transactions
-- -----------------------------------------------------------------------------
CREATE POLICY cash_accounts_select ON cash_accounts FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND property_id = auth_property_id())
  );

CREATE POLICY cash_accounts_modify ON cash_accounts FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

CREATE POLICY cash_tx_select ON cash_transactions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1 FROM cash_accounts ca
      WHERE ca.id = cash_transactions.cash_account_id
        AND ca.property_id = auth_property_id()
    )
  );

CREATE POLICY cash_tx_insert ON cash_transactions FOR INSERT
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- -----------------------------------------------------------------------------
-- expenses
-- -----------------------------------------------------------------------------
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND property_id = auth_property_id())
  );

CREATE POLICY expenses_modify ON expenses FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- -----------------------------------------------------------------------------
-- Housekeeping
-- -----------------------------------------------------------------------------
CREATE POLICY hk_tasks_select ON housekeeping_tasks FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

CREATE POLICY hk_tasks_modify ON housekeeping_tasks FOR ALL
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

CREATE POLICY hk_issues_select ON housekeeping_issues FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

CREATE POLICY hk_issues_modify ON housekeeping_issues FOR ALL
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

-- -----------------------------------------------------------------------------
-- payment_collections: type-conditional insert permissions
-- -----------------------------------------------------------------------------
CREATE POLICY payment_collections_select ON payment_collections FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR property_id = auth_property_id()
  );

CREATE POLICY payment_collections_insert ON payment_collections FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND property_id = auth_property_id())
    OR (
      auth_role() = 'HOUSEKEEPING'
      AND property_id = auth_property_id()
      AND EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = payment_collections.property_id AND p.type = 'APARTMENT'
      )
    )
    OR (
      auth_role() = 'RECEPTION'
      AND property_id = auth_property_id()
      AND EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = payment_collections.property_id AND p.type = 'HOTEL'
      )
    )
  );

CREATE POLICY payment_collections_update ON payment_collections FOR UPDATE
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- -----------------------------------------------------------------------------
-- KBS submissions
-- -----------------------------------------------------------------------------
CREATE POLICY kbs_select ON kbs_submissions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = kbs_submissions.reservation_id
          AND r.property_id = auth_property_id()
      )
    )
  );

-- -----------------------------------------------------------------------------
-- audit_log: read-only via client
-- -----------------------------------------------------------------------------
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- -----------------------------------------------------------------------------
-- message_templates
-- -----------------------------------------------------------------------------
CREATE POLICY templates_select ON message_templates FOR SELECT
  USING (true);

CREATE POLICY templates_modify ON message_templates FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));
