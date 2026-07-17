-- =============================================================================
-- HomeGuru PMS — migration 061
-- Auto-mark unit "Kirli" when its reservation completes.
-- =============================================================================
-- Every time a reservation flips to 'completed' (whether by the operator,
-- the hourly auto-complete cron, or any other path), append a Kirli
-- housekeeping_tasks event for the unit. HousekeepingPage reduces tasks
-- via latestPerUnit() so this immediately surfaces the unit on the Temizlik
-- queue's DIRTY filter.
--
-- SECURITY DEFINER so the trigger can write into housekeeping_tasks even
-- when the underlying status flip ran without an auth context (cron) or
-- by a role that wouldn't normally insert housekeeping rows.
--
-- We deliberately skip the "OLD/NEW both completed" no-op so re-saving a
-- completed reservation doesn't spam duplicate Kirli markers — but a true
-- re-completion (cancelled→active→completed, etc.) does fire because the
-- intervening status was different.
-- =============================================================================

CREATE OR REPLACE FUNCTION _trg_reservation_completed_marks_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO housekeeping_tasks (
      property_id, unit_id, status, notes, updated_by
    ) VALUES (
      NEW.property_id,
      NEW.unit_id,
      'DIRTY',
      'Rezervasyon tamamlandı — temizlik bekliyor',
      auth.uid()  -- NULL when fired from cron, that's fine
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservations_mark_dirty_on_complete ON reservations;
CREATE TRIGGER reservations_mark_dirty_on_complete
  AFTER UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION _trg_reservation_completed_marks_dirty();
