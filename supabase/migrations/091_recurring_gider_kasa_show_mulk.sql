-- =============================================================================
-- HomeGuru PMS — migration 091
-- Show the mülk on a recurring gider's kasa hareketi.
-- =============================================================================
-- A düzenli (recurring) mülk gideri posts a kasa OUT described only as
-- "Düzenli gider: <kategori> — <açıklama>", so the Kasa → Hareketler list
-- doesn't say WHICH mülk it belongs to. This adds the mülk name as a prefix:
--   "Düzenli gider: B1 · Kira — Bina Kira"
-- General (mülksüz) recurring giderler get no prefix. Applied in three places:
--   1. generate_recurring_expenses()  — the nightly cron (was migration 087).
--   2. post_recurring_instance_now()   — the "Kasaya işle" RPC (was mig. 086).
--   3. a one-time backfill of the existing "Düzenli gider:%" kasa rows.
-- Only the kasa OUT description changes; amounts/refs/approval are untouched.
-- =============================================================================

-- 1. Nightly cron — re-create with the mülk prefix on the kasa description.
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
  _prop         text;
BEGIN
  SELECT id INTO _kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;

  FOR _t IN
    SELECT * FROM expenses
    WHERE is_recurring = true
      AND recurring_source_id IS NULL
      AND recurring_day IS NOT NULL
  LOOP
    _due_day := LEAST(_t.recurring_day, _last_day);

    IF _today_day < _due_day THEN
      CONTINUE;
    END IF;

    IF date_trunc('month', _t.expense_date)::date = _month_start THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM expenses e
      WHERE e.recurring_source_id = _t.id
        AND date_trunc('month', e.expense_date)::date = _month_start
    ) THEN
      CONTINUE;
    END IF;

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
      -- Mülk name (NULL for a general gider, or its snapshot if the mülk was
      -- later deleted) → "Düzenli gider: <mülk> · <kategori> — <açıklama>".
      SELECT name INTO _prop FROM properties WHERE id = _t.property_id;
      INSERT INTO cash_transactions (
        cash_account_id, amount, direction, description,
        ref_type, ref_id, approval_status, created_by
      ) VALUES (
        _kasa_id, _t.amount, 'OUT',
        'Düzenli gider: '
          || COALESCE(COALESCE(_prop, _t.deleted_property_name) || ' · ', '')
          || _t.category || COALESCE(' — ' || _t.description, ''),
        'expense', _instance_id, 'approved', NULL
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION generate_recurring_expenses() FROM PUBLIC, anon, authenticated;

-- 2. "Kasaya işle" RPC — re-create with the same mülk prefix.
CREATE OR REPLACE FUNCTION post_recurring_instance_now(_template_id uuid)
RETURNS expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t            expenses;
  _today        date := (now() AT TIME ZONE 'Europe/Istanbul')::date;
  _last_day     int  := EXTRACT(DAY FROM (date_trunc('month', _today) + interval '1 month' - interval '1 day'))::int;
  _month_start  date := date_trunc('month', _today)::date;
  _day          int;
  _expense_date date;
  _kasa_id      uuid;
  _instance     expenses;
  _existing     expenses;
  _prop         text;
BEGIN
  IF auth_role() NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Yetkiniz yok.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _t FROM expenses
   WHERE id = _template_id
     AND is_recurring = true
     AND recurring_source_id IS NULL;
  IF _t.id IS NULL THEN
    RAISE EXCEPTION 'Düzenli gider bulunamadı.' USING ERRCODE = '42501';
  END IF;

  IF auth_role() = 'PROPERTY_MANAGER'
     AND _t.property_id IS DISTINCT FROM auth_property_id() THEN
    RAISE EXCEPTION 'Bu mülke erişim yetkiniz yok.' USING ERRCODE = '42501';
  END IF;

  IF date_trunc('month', _t.expense_date)::date = _month_start THEN
    RAISE EXCEPTION 'Bu ayın gideri zaten kayıtlı.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(_template_id::text || to_char(_month_start, 'YYYYMM'), 0)
  );

  SELECT * INTO _existing FROM expenses
   WHERE recurring_source_id = _template_id
     AND date_trunc('month', expense_date)::date = _month_start
   LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN _existing;
  END IF;

  _day := LEAST(COALESCE(_t.recurring_day, 1), _last_day);
  _expense_date := make_date(
    EXTRACT(YEAR FROM _today)::int, EXTRACT(MONTH FROM _today)::int, _day
  );

  INSERT INTO expenses (
    property_id, category, amount, description, expense_date,
    is_recurring, paid_from_kasa, recurring_source_id, approval_status, created_by
  ) VALUES (
    _t.property_id, _t.category, _t.amount, _t.description, _expense_date,
    false, _t.paid_from_kasa, _t.id, 'approved', auth.uid()
  )
  RETURNING * INTO _instance;

  IF _instance.paid_from_kasa THEN
    SELECT id INTO _kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
    IF _kasa_id IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı.';
    END IF;
    SELECT name INTO _prop FROM properties WHERE id = _t.property_id;
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, approval_status, created_by
    ) VALUES (
      _kasa_id, _instance.amount, 'OUT',
      'Düzenli gider: '
        || COALESCE(COALESCE(_prop, _t.deleted_property_name) || ' · ', '')
        || _instance.category || COALESCE(' — ' || _instance.description, ''),
      'expense', _instance.id, 'approved', auth.uid()
    );
  END IF;

  RETURN _instance;
END;
$$;

GRANT EXECUTE ON FUNCTION post_recurring_instance_now(uuid) TO authenticated;

-- 3. Backfill existing recurring-gider kasa rows: rebuild the description from
--    the linked instance expense, now with the mülk prefix. Inner join on the
--    expense, so a kasa row whose expense was deleted is left as-is.
UPDATE cash_transactions ct
SET description = 'Düzenli gider: '
  || COALESCE(COALESCE(p.name, e.deleted_property_name) || ' · ', '')
  || e.category
  || COALESCE(' — ' || e.description, '')
FROM expenses e
LEFT JOIN properties p ON p.id = e.property_id
WHERE ct.ref_type = 'expense'
  AND ct.ref_id = e.id
  AND ct.description LIKE 'Düzenli gider:%';

-- 4. Edit-sync trigger (migration 040) re-builds the kasa description when an
--    expense is edited — give it the same mülk prefix so an edit (e.g. a rent
--    change) doesn't strip the mülk back out. Also fire it on a property change.
CREATE OR REPLACE FUNCTION sync_expense_kasa_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop text;
BEGIN
  IF NEW.recurring_source_id IS NOT NULL THEN
    SELECT name INTO _prop FROM properties WHERE id = NEW.property_id;
  END IF;
  UPDATE cash_transactions
  SET amount = NEW.amount,
      description =
        CASE WHEN NEW.recurring_source_id IS NOT NULL
             THEN 'Düzenli gider: '
                  || COALESCE(COALESCE(_prop, NEW.deleted_property_name) || ' · ', '')
             ELSE 'Gider: ' END
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
      OR OLD.property_id IS DISTINCT FROM NEW.property_id
    )
  )
  EXECUTE FUNCTION sync_expense_kasa_movement();
