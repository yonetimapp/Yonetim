-- =============================================================================
-- HomeGuru PMS — migration 011
-- Tightens ledger_entries INSERT to enforce branch isolation.
-- =============================================================================
-- 003_rls.sql defined `ledger_insert` as role-only:
--
--   CREATE POLICY ledger_insert ON ledger_entries FOR INSERT
--     WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));
--
-- That lets a PROPERTY_MANAGER from Branch A insert a DEBT or PAYMENT against
-- a reservation belonging to Branch B if they know the row's UUID.
--
-- This migration recreates the policy so a non-admin caller's reservation_id
-- (if present) must reference a reservation in their branch. We also allow
-- reservation_id IS NULL (general guest entries not tied to a reservation),
-- but only if the guest has a reservation in the caller's branch — preventing
-- a manager from crediting/debiting unrelated guests.
--
-- Note: the nightly auto-debit cron runs as the table owner and bypasses RLS,
-- so this tightening does not affect it.
-- =============================================================================

DROP POLICY IF EXISTS ledger_insert ON ledger_entries;

CREATE POLICY ledger_insert ON ledger_entries FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND (
      auth_role() = 'SUPER_ADMIN'
      OR (
        -- For PROPERTY_MANAGER: the entry must tie to a reservation in their
        -- own branch (or, if reservation_id is NULL, the guest must at least
        -- have one reservation in their branch).
        (
          ledger_entries.reservation_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.id = ledger_entries.reservation_id
              AND r.property_id = auth_property_id()
          )
        )
        OR (
          ledger_entries.reservation_id IS NULL
          AND EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.guest_id = ledger_entries.guest_id
              AND r.property_id = auth_property_id()
          )
        )
      )
    )
  );
