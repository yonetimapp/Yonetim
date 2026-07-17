-- =============================================================================
-- HomeGuru PMS — migration 025
-- Revert migration 024 (KBS manual flow). User decided not to ship 4A.
-- =============================================================================
-- Drops the trigger + helper function added in 024, restores the original
-- kbs_select policy from 003_rls.sql (PROPERTY_MANAGER + SUPER_ADMIN only,
-- no RECEPTION), and removes the kbs_update policy.
--
-- The kbs_submissions table itself stays in place (it was part of the
-- baseline schema in 001 and may be revisited for the automated submission
-- flow later). PENDING rows that were auto-created by the 024 trigger are
-- swept (identified by empty payload + PENDING status) so the table is back
-- to its pre-024 state.

DROP TRIGGER IF EXISTS reservations_kbs_pending_trg ON reservations;
DROP FUNCTION IF EXISTS _kbs_ensure_pending_on_activate();

DROP POLICY IF EXISTS kbs_update ON kbs_submissions;
DROP POLICY IF EXISTS kbs_select ON kbs_submissions;

-- Re-create the original SELECT policy from 003_rls.sql (no RECEPTION).
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

-- Clean up rows the 024 trigger inserted. Conservative match: only delete
-- PENDING rows with the empty placeholder payload our trigger used.
DELETE FROM kbs_submissions
WHERE status = 'PENDING'
  AND payload = '{}'::jsonb;
