-- =============================================================================
-- HomeGuru PMS — migration 054
-- Expenses: per-template recurring_day, matching the staff salary pattern.
-- =============================================================================
-- Up to migration 037 the recurring-expense pipeline was a single boolean
-- (is_recurring) and a monthly cron that fired on the 1st. The operator UI
-- now mirrors the salary "Otomatik Ödeme Günü" dropdown, where each
-- recurring template carries the day-of-month it should post on. So:
--
--   * recurring_day NULL → one-off expense (was is_recurring=false).
--   * recurring_day 1..31 → template; the daily cron generates this month's
--     instance + kasa OUT when the calendar day matches.
--   * recurring_day > the current month's last day → falls back to that
--     month's last day (so day=31 still pays in February).
--
-- Backfill: any existing is_recurring=true template gets recurring_day set
-- to the day of its template's expense_date so the cron behaviour matches
-- where it sat before. is_recurring stays in place to keep migration 037's
-- record_expense / RLS / list queries unchanged — recurring_day is just the
-- finer-grained dial.
-- =============================================================================

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring_day smallint
  CHECK (recurring_day IS NULL OR (recurring_day BETWEEN 1 AND 31));

-- Backfill: preserve historical timing for templates already marked recurring.
UPDATE expenses
SET recurring_day = EXTRACT(DAY FROM expense_date)::smallint
WHERE is_recurring = true
  AND recurring_source_id IS NULL
  AND recurring_day IS NULL;

-- ----------------------------------------------------------------------------
-- record_expense — add _recurring_day so the form can persist the picked day
-- without an extra round trip. Default NULL keeps existing callers working.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_expense(uuid, text, numeric, text, date, boolean, boolean);

CREATE OR REPLACE FUNCTION record_expense(
  _property_id    uuid,
  _category       text,
  _amount         numeric,
  _description    text,
  _expense_date   date,
  _is_recurring   boolean,
  _paid_from_kasa boolean,
  _recurring_day  smallint DEFAULT NULL
) RETURNS expenses
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _expense  expenses;
  _kasa_id  uuid;
BEGIN
  INSERT INTO expenses (
    property_id, category, amount, description, expense_date,
    is_recurring, paid_from_kasa, recurring_day, created_by
  ) VALUES (
    _property_id, _category, _amount,
    NULLIF(btrim(COALESCE(_description, '')), ''),
    _expense_date,
    COALESCE(_is_recurring, false),
    COALESCE(_paid_from_kasa, false),
    _recurring_day,
    auth.uid()
  )
  RETURNING * INTO _expense;

  IF _expense.paid_from_kasa THEN
    SELECT id INTO _kasa_id FROM cash_accounts LIMIT 1;
    IF _kasa_id IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı';
    END IF;
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description, ref_type, ref_id, created_by
    ) VALUES (
      _kasa_id, _expense.amount, 'OUT',
      'Gider: ' || _expense.category || COALESCE(' — ' || _expense.description, ''),
      'expense', _expense.id, auth.uid()
    );
  END IF;

  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION
  record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint) TO authenticated;

-- ----------------------------------------------------------------------------
-- generate_recurring_expenses — day-aware: pick templates whose recurring_day
-- matches today's Istanbul-local day (or whose day exceeds this month's last
-- day, on the last day, as a Feb/Apr safety net). Idempotent within a month
-- via the existing recurring_source_id check.
-- ----------------------------------------------------------------------------
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
  _last_day     int  := EXTRACT(DAY FROM (date_trunc('month', _today) + interval '1 month - 1 day'))::int;
  _month_start  date := date_trunc('month', _today)::date;
  _kasa_id      uuid;
  _instance_id  uuid;
BEGIN
  SELECT id INTO _kasa_id FROM cash_accounts LIMIT 1;

  FOR _t IN
    SELECT * FROM expenses
    WHERE is_recurring = true
      AND recurring_source_id IS NULL
      AND recurring_day IS NOT NULL
      AND (
        recurring_day = _today_day
        OR (recurring_day > _last_day AND _today_day = _last_day)
      )
  LOOP
    -- Skip the template's own month (template carries its own first-instance
    -- expense_date — don't double-book the month it was created in).
    IF date_trunc('month', _t.expense_date)::date = _month_start THEN
      CONTINUE;
    END IF;
    -- Already materialised for this month?
    IF EXISTS (
      SELECT 1 FROM expenses e
      WHERE e.recurring_source_id = _t.id
        AND date_trunc('month', e.expense_date)::date = _month_start
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO expenses (
      property_id, category, amount, description, expense_date,
      is_recurring, paid_from_kasa, recurring_source_id, created_by
    ) VALUES (
      _t.property_id, _t.category, _t.amount, _t.description, _today,
      false, _t.paid_from_kasa, _t.id, NULL
    )
    RETURNING id INTO _instance_id;

    IF _t.paid_from_kasa AND _kasa_id IS NOT NULL THEN
      INSERT INTO cash_transactions (
        cash_account_id, amount, direction, description, ref_type, ref_id, created_by
      ) VALUES (
        _kasa_id, _t.amount, 'OUT',
        'Düzenli gider: ' || _t.category || COALESCE(' — ' || _t.description, ''),
        'expense', _instance_id, NULL
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION generate_recurring_expenses() FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Replace the monthly cron with a daily one (06:05 UTC = 09:05 Istanbul).
-- cron.unschedule swallows the "doesn't exist" case via DO block, so this
-- migration is idempotent across re-runs.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-monthly-recurring-expenses');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-daily-recurring-expenses');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-daily-recurring-expenses',
  '5 6 * * *',
  $$ SELECT generate_recurring_expenses(); $$
);
