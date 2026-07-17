-- =============================================================================
-- HomeGuru PMS — migration 037
-- Expenses: optional kasa link + automatic monthly recurrence.
-- =============================================================================
-- Two related additions:
--
-- 1. paid_from_kasa — when an expense is paid out of the cash kasa, this posts
--    a matching 'Gider' (OUT) movement to the general kasa so its balance
--    stays correct. Bank/transfer expenses leave it off.
--
-- 2. Real recurrence — an expense marked is_recurring is a TEMPLATE. A monthly
--    pg_cron job materialises one instance per month from each template
--    (recurring_source_id points back to the template). Editing the template's
--    amount flows to future months; deleting the template stops recurrence
--    (past instances are kept, their source_id set to NULL).
-- =============================================================================

-- 1. New columns.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_from_kasa boolean NOT NULL DEFAULT false;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring_source_id uuid
  REFERENCES expenses(id) ON DELETE SET NULL;

-- 2. record_expense — atomically insert an expense and, when paid_from_kasa,
--    the matching kasa OUT movement. SECURITY INVOKER: both inserts run under
--    the caller's RLS (finance roles only), exactly as a direct insert would.
CREATE OR REPLACE FUNCTION record_expense(
  _property_id    uuid,
  _category       text,
  _amount         numeric,
  _description    text,
  _expense_date   date,
  _is_recurring   boolean,
  _paid_from_kasa boolean
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
    is_recurring, paid_from_kasa, created_by
  ) VALUES (
    _property_id, _category, _amount,
    NULLIF(btrim(COALESCE(_description, '')), ''),
    _expense_date, COALESCE(_is_recurring, false), COALESCE(_paid_from_kasa, false),
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
  record_expense(uuid, text, numeric, text, date, boolean, boolean) TO authenticated;

-- 3. generate_recurring_expenses — run monthly. For each recurring template,
--    create this month's instance (and its kasa movement if kasa-paid) unless
--    one already exists. SECURITY DEFINER so the scheduled job bypasses RLS;
--    revoked from callers so only the cron job can run it.
CREATE OR REPLACE FUNCTION generate_recurring_expenses()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t            expenses;
  _month_start  date := date_trunc('month', (now() AT TIME ZONE 'Europe/Istanbul'))::date;
  _kasa_id      uuid;
  _instance_id  uuid;
BEGIN
  SELECT id INTO _kasa_id FROM cash_accounts LIMIT 1;

  FOR _t IN
    SELECT * FROM expenses
    WHERE is_recurring = true
      AND recurring_source_id IS NULL          -- templates only, never instances
  LOOP
    -- Don't duplicate the month the template itself sits in.
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
      _t.property_id, _t.category, _t.amount, _t.description, _month_start,
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

-- 4. Schedule it — 1st of each month, 06:00 UTC (09:00 Europe/Istanbul).
SELECT cron.schedule(
  'homeguru-monthly-recurring-expenses',
  '0 6 1 * *',
  $$ SELECT generate_recurring_expenses(); $$
);
