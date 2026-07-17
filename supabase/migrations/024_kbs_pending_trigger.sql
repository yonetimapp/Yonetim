-- =============================================================================
-- HomeGuru PMS — migration 024
-- KBS Bildirim Listesi (Phase 4A — manual flow).
-- =============================================================================
-- Goal: every reservation that transitions to status='active' produces a
-- PENDING row in kbs_submissions. A new admin page lists these and lets
-- the user mark each one as SUBMITTED after they hand-enter the data into
-- the KBS portal. The future Edge Function (Option B) will replace the
-- "mark SUBMITTED" button with real API submission.
--
-- This migration adds:
--   • Trigger _kbs_ensure_pending_on_activate on reservations
--   • Backfill for already-active reservations that have no kbs row yet
--   • UPDATE policy so PROPERTY_MANAGER / SUPER_ADMIN can flip status

-- -----------------------------------------------------------------------------
-- Trigger function: insert a PENDING kbs_submissions row when reservation
-- transitions to 'active'. SECURITY DEFINER so it bypasses RLS on the
-- kbs_submissions table (there's no INSERT policy by design — only the
-- trigger and the future Edge Function should create rows).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _kbs_ensure_pending_on_activate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when status becomes 'active' (either from another status, or
  -- when a reservation is inserted already in 'active' state).
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active')
  THEN
    INSERT INTO kbs_submissions (reservation_id, payload)
    SELECT NEW.id, '{}'::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM kbs_submissions WHERE reservation_id = NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservations_kbs_pending_trg ON reservations;

CREATE TRIGGER reservations_kbs_pending_trg
  AFTER INSERT OR UPDATE OF status ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION _kbs_ensure_pending_on_activate();

-- -----------------------------------------------------------------------------
-- Backfill: any pre-existing 'active' reservation that doesn't have a
-- kbs row yet gets one. Idempotent.
-- -----------------------------------------------------------------------------
INSERT INTO kbs_submissions (reservation_id, payload)
SELECT r.id, '{}'::jsonb
FROM reservations r
WHERE r.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM kbs_submissions WHERE reservation_id = r.id
  );

-- -----------------------------------------------------------------------------
-- Permissions: allow UPDATE so the "Bildirildi olarak işaretle" button works.
-- SELECT was already created in 003_rls.sql for SUPER_ADMIN + branch managers;
-- we also broaden it to RECEPTION since they're typically the ones at the
-- front desk handling KBS reporting.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS kbs_select ON kbs_submissions;
CREATE POLICY kbs_select ON kbs_submissions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = kbs_submissions.reservation_id
          AND r.property_id = auth_property_id()
      )
    )
  );

CREATE POLICY kbs_update ON kbs_submissions FOR UPDATE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = kbs_submissions.reservation_id
          AND r.property_id = auth_property_id()
      )
    )
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.id = kbs_submissions.reservation_id
          AND r.property_id = auth_property_id()
      )
    )
  );

GRANT EXECUTE ON FUNCTION _kbs_ensure_pending_on_activate() TO authenticated;
