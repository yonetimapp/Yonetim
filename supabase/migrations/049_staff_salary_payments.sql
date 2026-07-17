-- =============================================================================
-- HomeGuru PMS — migration 049
-- Per-staff monthly salary payment + auto-pay cron from the kasa.
-- =============================================================================
-- Each staff member can have a salary_day (1-31). On that day each month the
-- daily cron pays their staff_profiles.salary out of the singleton general
-- kasa and records the payment in staff_salary_payments. A UNIQUE(user_id,
-- pay_period) constraint protects against double-payment if the cron runs
-- twice on the same day, or a manager also fires a manual payment that month.
--
-- Manual payment path: pay_staff_salary RPC, SECURITY DEFINER, restricted to
-- SUPER_ADMIN + PROPERTY_MANAGER. Same kasa OUT + payment row, just with
-- source='MANUAL' and an optional note.
--
-- Insufficient kasa balance: we pay anyway (kasa can go negative); the
-- operator refills the kasa later. Mirrors the existing expenses → kasa
-- behavior — no balance check in the OUT path.
--
-- Advances (staff_advances) are intentionally NOT netted against the
-- monthly salary; they remain a separate ledger the manager reconciles by
-- hand. See the per-staff page for that view.
-- =============================================================================

-- 1. Schema additions.
ALTER TABLE staff_profiles
  ADD COLUMN salary_day int CHECK (salary_day BETWEEN 1 AND 31);

COMMENT ON COLUMN staff_profiles.salary_day IS
  'Day of month (1-31) the auto-pay cron fires for this staff. NULL = manual only.';

CREATE TABLE staff_salary_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount          numeric(10, 2) NOT NULL CHECK (amount >= 0),
  paid_at         timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL CHECK (source IN ('AUTO', 'MANUAL')),
  pay_period      date NOT NULL, -- first-of-month the payment covers
  cash_account_id uuid REFERENCES cash_accounts(id) ON DELETE SET NULL,
  cash_tx_id      uuid REFERENCES cash_transactions(id) ON DELETE SET NULL,
  note            text,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, pay_period)
);

CREATE INDEX staff_salary_payments_user_idx ON staff_salary_payments(user_id);
CREATE INDEX staff_salary_payments_period_idx ON staff_salary_payments(pay_period DESC);

-- 2. RLS — staff see their own; finance roles see all and can insert manual
--    payments. The auto-pay path runs as SECURITY DEFINER so it bypasses RLS.
ALTER TABLE staff_salary_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_salary_payments_select ON staff_salary_payments FOR SELECT
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    OR user_id = auth.uid()
  );

CREATE POLICY staff_salary_payments_insert ON staff_salary_payments FOR INSERT
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER'));

-- No UPDATE/DELETE policies — payments are append-only for audit.

-- 3. Manual payment RPC. SECURITY DEFINER so a manager doesn't need direct
--    INSERT rights on cash_transactions; we wrap the OUT-tx + payment row in
--    a single atomic operation with a friendly Turkish error envelope.
CREATE OR REPLACE FUNCTION pay_staff_salary(
  _user_id    uuid,
  _amount     numeric,
  _pay_period date,
  _note       text DEFAULT NULL
) RETURNS staff_salary_payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  kasa_id uuid;
  staff_name text;
  new_tx_id uuid;
  result staff_salary_payments;
BEGIN
  IF auth_role() NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Maaş ödemesi için yetkiniz yok.' USING ERRCODE = '42501';
  END IF;
  IF _amount < 0 THEN
    RAISE EXCEPTION 'Maaş tutarı negatif olamaz.';
  END IF;

  SELECT id INTO kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
  IF kasa_id IS NULL THEN
    RAISE EXCEPTION 'Genel kasa bulunamadı.';
  END IF;

  SELECT full_name INTO staff_name FROM staff_profiles WHERE user_id = _user_id;
  IF staff_name IS NULL THEN
    RAISE EXCEPTION 'Personel bulunamadı.';
  END IF;

  -- Kasa OUT transaction (allowed even if the kasa would go negative — same
  -- behavior as the existing expense → kasa flow).
  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by
  ) VALUES (
    kasa_id, _amount, 'OUT',
    'Maaş: ' || staff_name,
    'staff_salary_payment', NULL, auth.uid()
  )
  RETURNING id INTO new_tx_id;

  INSERT INTO staff_salary_payments (
    user_id, amount, source, pay_period,
    cash_account_id, cash_tx_id, note, created_by
  ) VALUES (
    _user_id, _amount, 'MANUAL',
    date_trunc('month', _pay_period)::date,
    kasa_id, new_tx_id, _note, auth.uid()
  )
  RETURNING * INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION
  pay_staff_salary(uuid, numeric, date, text) TO authenticated;

-- 4. Auto-pay cron function — daily heartbeat sweeps staff whose salary_day
--    matches today's day-of-month in Istanbul and who haven't been paid for
--    the current month yet. Idempotent (re-runs same day are no-ops).
CREATE OR REPLACE FUNCTION process_auto_salary_payments()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today_day         int;
  today_month       date;
  last_day_of_month int;
  kasa_id           uuid;
  staff_rec         record;
  new_tx_id         uuid;
  count_paid        int := 0;
BEGIN
  today_day := EXTRACT(DAY FROM (now() AT TIME ZONE 'Europe/Istanbul')::date)::int;
  today_month := date_trunc(
    'month', (now() AT TIME ZONE 'Europe/Istanbul')::date
  )::date;
  -- Last day of the current Istanbul month — drives the "salary_day overshoots
  -- this month's length" fallback so salary_day=31 still pays on Feb 28/29.
  last_day_of_month := EXTRACT(
    DAY FROM (today_month + interval '1 month' - interval '1 day')
  )::int;

  SELECT id INTO kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
  IF kasa_id IS NULL THEN
    RAISE NOTICE 'No general kasa configured; skipping salary cron run.';
    RETURN 0;
  END IF;

  FOR staff_rec IN
    SELECT sp.user_id, sp.salary, sp.full_name
    FROM staff_profiles sp
    WHERE sp.salary IS NOT NULL
      AND sp.salary > 0
      AND (
        sp.salary_day = today_day
        OR (sp.salary_day > last_day_of_month AND today_day = last_day_of_month)
      )
      AND NOT EXISTS (
        SELECT 1 FROM staff_salary_payments ssp
        WHERE ssp.user_id = sp.user_id
          AND ssp.pay_period = today_month
      )
  LOOP
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, created_by
    ) VALUES (
      kasa_id, staff_rec.salary, 'OUT',
      'Maaş (otomatik): ' || staff_rec.full_name,
      'staff_salary_payment', NULL, NULL
    )
    RETURNING id INTO new_tx_id;

    INSERT INTO staff_salary_payments (
      user_id, amount, source, pay_period,
      cash_account_id, cash_tx_id, created_by
    ) VALUES (
      staff_rec.user_id, staff_rec.salary, 'AUTO',
      today_month, kasa_id, new_tx_id, NULL
    );

    count_paid := count_paid + 1;
  END LOOP;

  RETURN count_paid;
END;
$$;

-- 5. Schedule daily at 00:07 Istanbul (21:07 UTC). Slots after the other
--    midnight crons (upcoming → active at :01, completed at :03, auto-debit
--    at :05) so it sees the latest state of the day.
SELECT cron.schedule(
  'homeguru-staff-salary',
  '7 21 * * *',
  $$ SELECT process_auto_salary_payments(); $$
);
