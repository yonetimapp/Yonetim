-- =============================================================================
-- HomeGuru PMS — migration 077
-- Auto-debit moves from nightly accrual to a one-time charge at activation.
-- =============================================================================
-- OLD behaviour (migration 004): a cron ran every night at 00:05 Istanbul and
-- posted one night's share (total_amount / nights) to the guest's cari while the
-- reservation was active — so the debt accrued night by night.
--
-- NEW behaviour: the moment a reservation becomes 'active' (at check-in — via
-- the 00:01 activate-upcoming cron, a manual status change, or being created
-- already active) the FULL total_amount is posted to the cari once, if
-- auto_debit is on. Same total debt, charged upfront instead of nightly.
--
-- Implemented as an AFTER trigger (mirrors the KBS on-activate trigger in 024)
-- so every activation path is covered. Idempotent: a reservation is debited at
-- most once (NOT EXISTS guard on the note), so re-activations or auto_debit
-- re-toggles never double-charge.
--
-- Transition note: existing mid-stay active reservations that were being charged
-- nightly keep their already-posted 'Auto-debit …' entries; they are NOT
-- back-charged here (that would double up). Their remaining nights simply stop
-- accruing once the cron is removed — adjust by hand if needed.
-- =============================================================================

-- 1. Remove the nightly cron. Wrapped so a missing job doesn't fail the migration.
DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-nightly-auto-debit');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Trigger: post the full amount once, when the reservation is active and
--    auto_debit is on. SECURITY DEFINER so the ledger insert bypasses RLS
--    regardless of who flips the status (cron, RECEPTION, PROPERTY_MANAGER).
CREATE OR REPLACE FUNCTION _auto_debit_on_activate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active'
     AND NEW.auto_debit = true
     AND COALESCE(NEW.total_amount, 0) > 0
  THEN
    INSERT INTO ledger_entries
      (guest_id, reservation_id, type, amount, currency, note, created_by)
    SELECT NEW.guest_id, NEW.id, 'DEBT', NEW.total_amount, 'TRY',
           'Otomatik borçlandırma (giriş)', NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_entries le
      WHERE le.reservation_id = NEW.id
        AND le.type = 'DEBT'
        AND le.note LIKE 'Otomatik borçlandırma%'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservations_auto_debit_trg ON reservations;

CREATE TRIGGER reservations_auto_debit_trg
  AFTER INSERT OR UPDATE OF status, auto_debit ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION _auto_debit_on_activate();

GRANT EXECUTE ON FUNCTION _auto_debit_on_activate() TO authenticated;
