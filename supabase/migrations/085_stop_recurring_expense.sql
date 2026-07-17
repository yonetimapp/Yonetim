-- =============================================================================
-- HomeGuru PMS — migration 085
-- Stop a recurring expense (Düzenli gideri durdur) without losing history.
-- =============================================================================
-- A recurring expense is a TEMPLATE row (is_recurring=true, recurring_source_id
-- NULL). The daily cron (migration 054) materialises one instance per month
-- (is_recurring=false, recurring_source_id=template), and the UI projects the
-- template into the current + future months as display-only "Beklenen" rows.
--
-- The operator wants to "delete" a düzenli gider such that:
--   * the month they stop it + all upcoming months disappear, and
--   * past months stay visible but are no longer labelled "Düzenli".
--
-- Deleting the template row outright is WRONG: expenses.recurring_source_id is
-- ON DELETE SET NULL, so past instances would survive, but the template's OWN
-- origin-month row (a real past expense) would vanish. Instead we DE-RECUR the
-- template:
--   1. is_recurring=false, recurring_day=NULL  → keeps the row as plain history,
--      drops the "Düzenli" badge, stops the cron AND the UI projection.
--   2. soft-delete the current month's + any future generated instance so the
--      stop-month and beyond disappear; past instances are untouched.
-- Generated instances are inserted is_recurring=false, so they never carried the
-- "Düzenli" badge — past months are automatically un-labelled by step 1 alone.
--
-- SECURITY INVOKER: RLS (expenses_update / expenses_delete → SUPER_ADMIN /
-- PROPERTY_MANAGER, migration 064) governs who may run this. Kasa movements from
-- already-posted instances are left in place (cash already left the till), the
-- same rule as every other expense delete.
-- =============================================================================

CREATE OR REPLACE FUNCTION stop_recurring_expense(_template_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _month_start date := date_trunc('month', (now() AT TIME ZONE 'Europe/Istanbul'))::date;
  _inst        record;
  _updated     int;
BEGIN
  -- 1. De-recur the template (must be a real template, not an instance).
  UPDATE expenses
  SET is_recurring = false, recurring_day = NULL
  WHERE id = _template_id
    AND is_recurring = true
    AND recurring_source_id IS NULL;

  GET DIAGNOSTICS _updated = ROW_COUNT;
  IF _updated = 0 THEN
    RAISE EXCEPTION 'Düzenli gider bulunamadı veya yetkiniz yok.'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Soft-delete the stop-month + any future generated instance (→ Çöp Kutusu,
  --    restorable). Past instances (expense_date < this month) are kept.
  FOR _inst IN
    SELECT id FROM expenses
    WHERE recurring_source_id = _template_id
      AND expense_date >= _month_start
  LOOP
    PERFORM soft_delete_entity('expenses', _inst.id);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION stop_recurring_expense(uuid) TO authenticated;

COMMENT ON FUNCTION stop_recurring_expense(uuid) IS
  'Stops a recurring expense template: de-recurs it (keeps past history, drops the Düzenli label + future projections) and soft-deletes the current/future generated instances. Past months are preserved.';
