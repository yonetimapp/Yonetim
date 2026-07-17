-- =============================================================================
-- HomeGuru PMS — migration 122
-- Atomic, idempotent avans ⇄ kasa cascade delete.
-- =============================================================================
-- Deleting an avans must also delete its kasa hareketi (and vice-versa). Doing it
-- as two separate soft_delete_entity calls from the client was (a) non-atomic — a
-- partial failure orphaned one row — and (b) fragile: soft_delete_entity RAISES
-- "Kayıt bulunamadı" if the target is already trashed, so deleting a hareketi
-- whose avans was already gone threw a confusing error.
--
-- This wraps both soft-deletes in ONE function = ONE transaction: if either fails
-- (e.g. RLS), the whole thing rolls back — no orphans. It only deletes rows that
-- are still present (guards), so it's idempotent and safe to call from either
-- side (Avans Geçmişi 'Sil' passes the advance id; the kasa 'Sil' passes the
-- hareketi's ref_id, which is the same advance id).
--
-- SECURITY INVOKER: soft_delete_entity keeps enforcing per-row RLS (its internal
-- ROW_COUNT=0 check rolls back an RLS-blocked delete), so permissions are
-- unchanged — cash_transactions deletes still require SUPER_ADMIN (migration 015).
-- =============================================================================

CREATE OR REPLACE FUNCTION delete_advance_cascade(p_advance_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tx_id uuid;
BEGIN
  -- The avans's kasa hareketi(leri) — only those still present (skip already
  -- trashed so a re-delete or reverse-cascade doesn't raise "Kayıt bulunamadı").
  FOR v_tx_id IN
    SELECT id FROM cash_transactions
    WHERE ref_type = 'staff_advance' AND ref_id = p_advance_id
  LOOP
    PERFORM soft_delete_entity('cash_transactions', v_tx_id);
  END LOOP;

  -- The avans itself, if it hasn't already been trashed.
  IF EXISTS (SELECT 1 FROM staff_advances WHERE id = p_advance_id) THEN
    PERFORM soft_delete_entity('staff_advances', p_advance_id);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_advance_cascade(uuid) TO authenticated;
