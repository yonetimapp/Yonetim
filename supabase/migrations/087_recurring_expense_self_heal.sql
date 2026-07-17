-- =============================================================================
-- HomeGuru PMS — migration 087
-- Make recurring-gider generation self-healing (and run it often).
-- =============================================================================
-- The cron from migration 054 fired ONCE a day (09:05 Istanbul) and only when
-- `recurring_day = today's day`. If the project was asleep/busy during that one
-- window on that exact day, the month's instance was NEVER created — the next
-- day's run no longer matched the day. On the Supabase free tier (the DB only
-- runs pg_cron while awake) this means düzenli giderler routinely miss their
-- month and never hit the kasa. That is the "not added on its time" bug.
--
-- Fix:
--   * Generate for ANY template whose due day has ARRIVED OR PASSED this month
--     (recurring_day <= today, clamped to the month length) and that hasn't been
--     materialised yet — so a missed/slept-through day self-corrects on the next
--     run instead of being lost.
--   * Date the instance on its due day (matches the "Beklenen" projection) even
--     when back-filled a few days late.
--   * Run every 30 min (was daily) so a wake-up catches up quickly. The function
--     is idempotent per (template, month), so extra runs are harmless no-ops.
--   * approval_status is set explicitly to 'approved' (the column default, made
--     explicit for clarity) — recurring giderler are auto-approved, never queued.
-- =============================================================================

CREATE OR REPLACE FUNCTION generate_recurring_expenses()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t            expenses;
  _today        date := (now() AT TIME ZONE 'Europe/Istanbul')::date;
  _today_day    int  := EXTRACT(DAY FROM _today)::int;
  _last_day     int  := EXTRACT(DAY FROM (date_trunc('month', _today) + interval '1 month' - interval '1 day'))::int;
  _month_start  date := date_trunc('month', _today)::date;
  _due_day      int;
  _expense_date date;
  _kasa_id      uuid;
  _instance_id  uuid;
BEGIN
  SELECT id INTO _kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;

  FOR _t IN
    SELECT * FROM expenses
    WHERE is_recurring = true
      AND recurring_source_id IS NULL
      AND recurring_day IS NOT NULL
  LOOP
    -- This month's due day, clamped (day 31 → 28/30 in short months).
    _due_day := LEAST(_t.recurring_day, _last_day);

    -- Not due yet this month → wait (it will post once the day arrives).
    IF _today_day < _due_day THEN
      CONTINUE;
    END IF;

    -- Skip the template's own month (it already represents that month).
    IF date_trunc('month', _t.expense_date)::date = _month_start THEN
      CONTINUE;
    END IF;

    -- Already materialised this month? (self-healing idempotency)
    IF EXISTS (
      SELECT 1 FROM expenses e
      WHERE e.recurring_source_id = _t.id
        AND date_trunc('month', e.expense_date)::date = _month_start
    ) THEN
      CONTINUE;
    END IF;

    -- Date the instance on its due day (matches the Beklenen projection).
    _expense_date := make_date(
      EXTRACT(YEAR FROM _today)::int, EXTRACT(MONTH FROM _today)::int, _due_day
    );

    INSERT INTO expenses (
      property_id, category, amount, description, expense_date,
      is_recurring, paid_from_kasa, recurring_source_id, approval_status, created_by
    ) VALUES (
      _t.property_id, _t.category, _t.amount, _t.description, _expense_date,
      false, _t.paid_from_kasa, _t.id, 'approved', NULL
    )
    RETURNING id INTO _instance_id;

    IF _t.paid_from_kasa AND _kasa_id IS NOT NULL THEN
      INSERT INTO cash_transactions (
        cash_account_id, amount, direction, description,
        ref_type, ref_id, approval_status, created_by
      ) VALUES (
        _kasa_id, _t.amount, 'OUT',
        'Düzenli gider: ' || _t.category || COALESCE(' — ' || _t.description, ''),
        'expense', _instance_id, 'approved', NULL
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION generate_recurring_expenses() FROM PUBLIC, anon, authenticated;

-- Re-schedule: every 30 min (:08, :38) instead of once daily, so a missed window
-- self-corrects within half an hour of the DB being awake. Same job name, so this
-- replaces the old schedule cleanly (no orphan job left behind).
DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-daily-recurring-expenses');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-daily-recurring-expenses',
  '8,38 * * * *',
  $$ SELECT generate_recurring_expenses(); $$
);
