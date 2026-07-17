-- =============================================================================
-- HomeGuru PMS — migration 040
-- Keep a kasa-paid expense's kasa movement in step when the expense is edited.
-- =============================================================================
-- A kasa-paid expense posts a 'Gider' movement to the general kasa at creation
-- (migration 037). This trigger keeps that movement's amount + description in
-- sync when the expense is later edited — so changing a rent amount no longer
-- silently desyncs the kasa.
--
-- Deletes are intentionally NOT synced: removing an expense leaves its kasa
-- movement (the money did leave the kasa). If the expense was a mistake, the
-- operator removes the kasa entry deliberately — the UI warns them at delete.
-- =============================================================================

CREATE OR REPLACE FUNCTION sync_expense_kasa_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY DEFINER so the update bypasses RLS (cash_transactions has no
  -- UPDATE policy — it is otherwise append-only).
  UPDATE cash_transactions
  SET amount = NEW.amount,
      description =
        CASE WHEN NEW.recurring_source_id IS NOT NULL
             THEN 'Düzenli gider: ' ELSE 'Gider: ' END
        || NEW.category
        || COALESCE(' — ' || NEW.description, '')
  WHERE ref_type = 'expense' AND ref_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_sync_kasa ON expenses;
CREATE TRIGGER expenses_sync_kasa
  AFTER UPDATE ON expenses
  FOR EACH ROW
  WHEN (
    NEW.paid_from_kasa
    AND (
      OLD.amount IS DISTINCT FROM NEW.amount
      OR OLD.category IS DISTINCT FROM NEW.category
      OR OLD.description IS DISTINCT FROM NEW.description
    )
  )
  EXECUTE FUNCTION sync_expense_kasa_movement();
