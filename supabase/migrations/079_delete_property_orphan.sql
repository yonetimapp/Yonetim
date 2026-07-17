-- =============================================================================
-- HomeGuru PMS — migration 079
-- "Bağı kopar": delete a property while PRESERVING its financial history.
-- =============================================================================
-- Business need: an operator must be able to remove a mülk (e.g. "No.8") even
-- when it has past reservations / cash movements / expenses. A hard delete is
-- blocked by ON DELETE RESTRICT foreign keys (reservations.property_id,
-- reservations.unit_id, payment_collections.property_id) — by design, so
-- financial & audit history can never be silently cascaded away.
--
-- New behaviour: deleting a property ORPHANS its financial records instead of
-- destroying them. Reservations, cash transactions and expenses KEEP their row;
-- their property/unit reference is set NULL and the property's (and unit's) NAME
-- is snapshotted onto the row, so the UI can show:
--     "Bu rezervasyon silinmiş olan No.8'e aittir".
-- Operational data (units, housekeeping tasks/issues, blocks, date-notes,
-- nightly-prices) is cascade-deleted with the property — it is meaningless
-- without it. The single general kasa (property_id IS NULL) is never touched.
--
-- This is intentionally IRREVERSIBLE — the tie is broken, not archived.
--
-- Trigger safety (verified): the orphaning UPDATEs below fire
--   * reservations_no_block_overlap  — passes (NULL unit_id matches no block)
--   * reservations_google_push_update — fires but is fire-and-forget async,
--     a no-op when Google sync isn't configured, and cannot roll back the txn
--   * expenses_sync_kasa  — does NOT fire (amount/category/description unchanged)
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Make the orphan-able references nullable + add name-snapshot columns.
--    No FK ON DELETE behaviour is changed: the RPC nulls every reference BEFORE
--    deleting the property, so nothing cascades unexpectedly and nothing is lost.
-- ----------------------------------------------------------------------------
ALTER TABLE reservations
  ALTER COLUMN property_id DROP NOT NULL,
  ALTER COLUMN unit_id     DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS deleted_property_name text,
  ADD COLUMN IF NOT EXISTS deleted_unit_name     text;

ALTER TABLE expenses
  ALTER COLUMN property_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS deleted_property_name text;

-- cash_transactions.property_id is already nullable + ON DELETE SET NULL (071).
ALTER TABLE cash_transactions
  ADD COLUMN IF NOT EXISTS deleted_property_name text;

-- payment_collections survive on their (preserved) reservation; they aren't
-- displayed by property name on their own, so no snapshot column is needed —
-- only the RESTRICT-blocking NOT NULL has to be relaxed.
ALTER TABLE payment_collections
  ALTER COLUMN property_id DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. delete_property: SUPER_ADMIN-only orphan-then-delete, in one transaction.
--    SECURITY DEFINER so it can update RLS-protected financial rows and delete
--    the property; the explicit auth_role() check is the only access gate.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_property(_property_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _name text;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici mülk silebilir.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT name INTO _name FROM properties WHERE id = _property_id;
  IF _name IS NULL THEN
    RAISE EXCEPTION 'Mülk bulunamadı.';
  END IF;

  -- Safety guard: never delete a mülk while a guest is currently staying. The
  -- orphaning itself would technically work, but silently cutting a live stay
  -- loose from its room is a mistake — block it and let the operator finish.
  IF EXISTS (
    SELECT 1 FROM reservations
    WHERE property_id = _property_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Aktif (devam eden) rezervasyonu olan mülk silinemez. Önce mevcut konaklamayı tamamlayın.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reservations: snapshot property + unit name, break both ties. Keep the row.
  UPDATE reservations r SET
    deleted_property_name = _name,
    deleted_unit_name     = COALESCE(
      (SELECT u.name FROM units u WHERE u.id = r.unit_id), r.deleted_unit_name),
    property_id = NULL,
    unit_id     = NULL
  WHERE r.property_id = _property_id;

  -- Cash transactions tagged to this property: snapshot name, break tie.
  UPDATE cash_transactions SET
    deleted_property_name = _name,
    property_id = NULL
  WHERE property_id = _property_id;

  -- Expenses: snapshot name, break tie. Keep the row. Also stop any recurrence
  -- (is_recurring → false, recurring_day → NULL) so the monthly cron doesn't
  -- keep posting a deleted property's rent forever as a property-less "Genel"
  -- expense — generate_recurring_expenses copies property_id (now NULL) but not
  -- the snapshot name, so a still-recurring orphan would lose its identity.
  UPDATE expenses SET
    deleted_property_name = _name,
    property_id = NULL,
    is_recurring = false,
    recurring_day = NULL
  WHERE property_id = _property_id;

  -- Payment collections: break the property tie (they survive on their
  -- preserved reservation). The RESTRICT FK would otherwise block the delete.
  UPDATE payment_collections SET
    property_id = NULL
  WHERE property_id = _property_id;

  -- The property now has no RESTRICT-referencing rows. Deleting it cascades
  -- only the operational tables (units, housekeeping, blocks, notes, prices).
  -- The general kasa (property_id IS NULL) is unaffected.
  DELETE FROM properties WHERE id = _property_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_property(uuid) FROM public;
GRANT EXECUTE ON FUNCTION delete_property(uuid) TO authenticated;
