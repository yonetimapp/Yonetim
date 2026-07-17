-- =============================================================================
-- HomeGuru PMS — migration 082
-- Avans ↔ kasa reconciliation (outstanding-advance model).
-- =============================================================================
-- Until now a staff advance (avans) was recorded only in staff_advances and
-- never touched the kasa, so the kasa overstated real cash by the outstanding
-- advances. New model:
--
--   1. Giving an avans posts a kasa GIDER (OUT) immediately — the cash left the
--      till. Role-based approval mirrors record_expense (admin → approved,
--      manager → pending for review). Guarded against a restore-from-trash
--      re-insert posting a duplicate.
--   2. A salary payment (manual pay_staff_salary AND the auto-pay cron) now pays
--      the NET = maaş − ödenmemiş (outstanding) avanslar, and marks those
--      advances "settled" (settled_at) so each avans is recovered exactly once.
--      → avans (−5.000) + net maaş (−35.000) = tam maaş (−40.000). Kasa correct.
--
-- "Outstanding" = staff_advances.settled_at IS NULL. This supersedes migration
-- 049's "advances are NOT netted against salary" decision (deliberately).
-- =============================================================================

-- 1. Settlement marker. NULL = not yet recovered from a paid salary.
ALTER TABLE staff_advances ADD COLUMN IF NOT EXISTS settled_at timestamptz;

-- 1a. Transition (operator choice): grandfather every advance that already
--     exists. Mark them settled so they post NO back-dated kasa gider and are
--     NOT deducted from any future salary — they were handled under the old
--     (manual) model. The new reconciliation applies only to advances created
--     AFTER this migration (their INSERT fires the trigger; settled_at = NULL).
UPDATE staff_advances SET settled_at = now() WHERE settled_at IS NULL;

-- 2. Post each new advance to the general kasa as an OUT.
CREATE OR REPLACE FUNCTION _post_advance_to_kasa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  kasa_id    uuid;
  staff_name text;
  status     text := CASE WHEN auth_role() = 'SUPER_ADMIN' THEN 'approved' ELSE 'pending' END;
BEGIN
  -- restore_trash re-inserts the original row; its kasa OUT still exists, so
  -- don't post a second one.
  IF EXISTS (
    SELECT 1 FROM cash_transactions
    WHERE ref_type = 'staff_advance' AND ref_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
  IF kasa_id IS NULL THEN
    RAISE NOTICE 'No general kasa configured; advance not posted to kasa.';
    RETURN NEW;
  END IF;

  SELECT full_name INTO staff_name FROM staff_profiles WHERE user_id = NEW.user_id;

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by, approval_status
  ) VALUES (
    kasa_id, NEW.amount, 'OUT',
    'Avans: ' || COALESCE(staff_name, 'Personel'),
    'staff_advance', NEW.id, NEW.created_by, status
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS staff_advances_kasa ON staff_advances;
CREATE TRIGGER staff_advances_kasa
  AFTER INSERT ON staff_advances
  FOR EACH ROW EXECUTE FUNCTION _post_advance_to_kasa();

-- 3. Manual salary RPC — pay the operator-entered amount (the modal defaults it
--    to the net), then settle all outstanding advances for this staff.
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
  kasa_id    uuid;
  staff_name text;
  new_tx_id  uuid;
  result     staff_salary_payments;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Maaş ödemesi için yönetici yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Maaş tutarı sıfırdan büyük olmalıdır.';
  END IF;

  SELECT id INTO kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
  IF kasa_id IS NULL THEN
    RAISE EXCEPTION 'Genel kasa bulunamadı.';
  END IF;

  SELECT full_name INTO staff_name FROM staff_profiles WHERE user_id = _user_id;
  IF staff_name IS NULL THEN
    RAISE EXCEPTION 'Personel bulunamadı.';
  END IF;

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by, approval_status
  ) VALUES (
    kasa_id, _amount, 'OUT',
    'Maaş: ' || staff_name,
    'staff_salary_payment', NULL, auth.uid(), 'approved'
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

  -- Settle outstanding advances — this salary recovers them.
  UPDATE staff_advances
  SET settled_at = now()
  WHERE user_id = _user_id AND settled_at IS NULL;

  RETURN result;
END;
$$;

-- 4. Auto-pay cron — pay NET (maaş − outstanding avans), settle the advances.
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
  outstanding       numeric;
  net               numeric;
  new_tx_id         uuid;
  count_paid        int := 0;
BEGIN
  today_day := EXTRACT(DAY FROM (now() AT TIME ZONE 'Europe/Istanbul')::date)::int;
  today_month := date_trunc('month', (now() AT TIME ZONE 'Europe/Istanbul')::date)::date;
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
    WHERE sp.deleted_at IS NULL
      AND sp.salary IS NOT NULL
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
    SELECT COALESCE(SUM(amount), 0) INTO outstanding
    FROM staff_advances
    WHERE user_id = staff_rec.user_id AND settled_at IS NULL;

    net := GREATEST(0, staff_rec.salary - outstanding);

    new_tx_id := NULL;
    -- Only move cash when there's a positive net (advances may fully cover it).
    IF net > 0 THEN
      INSERT INTO cash_transactions (
        cash_account_id, amount, direction, description,
        ref_type, ref_id, created_by, approval_status
      ) VALUES (
        kasa_id, net, 'OUT',
        'Maaş (otomatik): ' || staff_rec.full_name,
        'staff_salary_payment', NULL, NULL, 'approved'
      )
      RETURNING id INTO new_tx_id;
    END IF;

    INSERT INTO staff_salary_payments (
      user_id, amount, source, pay_period,
      cash_account_id, cash_tx_id, created_by
    ) VALUES (
      staff_rec.user_id, net, 'AUTO',
      today_month, kasa_id, new_tx_id, NULL
    );

    UPDATE staff_advances
    SET settled_at = now()
    WHERE user_id = staff_rec.user_id AND settled_at IS NULL;

    count_paid := count_paid + 1;
  END LOOP;

  RETURN count_paid;
END;
$$;
