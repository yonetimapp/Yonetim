-- =============================================================================
-- HomeGuru PMS — migration 057
-- Soft-delete personnel: hide ex-staff from the app without losing history.
-- =============================================================================
-- A staff_profiles row carries the link to advances, salary payments, kasa
-- movements, audit rows etc., so hard-deleting it would either break FK
-- chains or wipe legitimate history. Instead we add a deleted_at column —
-- the UI hides rows where it's set, and the auto-pay cron skips them.
-- The auth.users row is untouched, which is fine: a deleted staff member
-- has no staff_profiles visibility, so auth_role() returns NULL and the
-- account is effectively locked out of every RLS-gated path.
-- =============================================================================

ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS staff_profiles_deleted_at_idx
  ON staff_profiles(deleted_at) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- Auto-pay cron (migration 049): skip deleted staff so they don't keep
-- generating monthly salary entries after they leave.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- delete_staff RPC: SUPER_ADMIN-only soft delete. Sets deleted_at = now()
-- on the staff_profiles row. Idempotent; restoring is a single SQL UPDATE
-- (we don't surface restore in the UI yet — out of scope).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_staff(_user_id uuid)
RETURNS staff_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result staff_profiles;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Personel silme yetkisi yalnızca yöneticidedir';
  END IF;
  IF _user_id = auth.uid() THEN
    RAISE EXCEPTION 'Kendi hesabınızı silemezsiniz';
  END IF;

  UPDATE staff_profiles
  SET deleted_at = now()
  WHERE user_id = _user_id
    AND deleted_at IS NULL
  RETURNING * INTO result;

  IF result.user_id IS NULL THEN
    RAISE EXCEPTION 'Personel bulunamadı veya zaten silinmiş';
  END IF;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_staff(uuid) TO authenticated;
