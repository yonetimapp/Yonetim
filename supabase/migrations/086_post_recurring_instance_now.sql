-- =============================================================================
-- HomeGuru PMS — migration 086
-- Post a recurring expense's THIS-MONTH instance on demand ("Kasaya işle").
-- =============================================================================
-- The daily cron (migration 054) runs once each morning (09:05 Istanbul) and
-- materialises the month's instance for every template whose recurring_day
-- matches *that* day. If a template's day was wrong when the cron ran — or the
-- template was created/fixed later the same day — the cron has already passed
-- and won't run again until tomorrow, when the (now-correct) day no longer
-- matches. Result: that month's gider never posts and never drops from the kasa.
--
-- This RPC lets a yönetici / şube yöneticisi post the current month's instance
-- immediately, replicating the cron EXACTLY: instance row + (when kasa-paid) an
-- approved kasa OUT, so it drops from the kasa right away. Recurring giderler are
-- auto-approved (they never go through Onaylar), so this stays consistent with
-- every other month's auto-generated instance.
--
-- SECURITY DEFINER (like the cron) so it can post 'approved' kasa rows that
-- migration 067's cash_tx_insert RLS otherwise reserves for DEFINER paths. Since
-- DEFINER bypasses RLS, this gates the caller explicitly and enforces branch
-- isolation for PROPERTY_MANAGER (mirrors the expenses_select scope, mig. 064).
-- Idempotent: if this month's instance already exists, it is returned unchanged
-- (no second kasa movement).
-- =============================================================================

CREATE OR REPLACE FUNCTION post_recurring_instance_now(_template_id uuid)
RETURNS expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t            expenses;
  _today        date := (now() AT TIME ZONE 'Europe/Istanbul')::date;
  _last_day     int  := EXTRACT(DAY FROM (date_trunc('month', _today) + interval '1 month - 1 day'))::int;
  _month_start  date := date_trunc('month', _today)::date;
  _day          int;
  _expense_date date;
  _kasa_id      uuid;
  _instance     expenses;
  _existing     expenses;
BEGIN
  -- DEFINER bypasses RLS — gate the caller to finance roles explicitly.
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

  -- Branch isolation: a manager may only post for their own branch.
  IF auth_role() = 'PROPERTY_MANAGER'
     AND _t.property_id IS DISTINCT FROM auth_property_id() THEN
    RAISE EXCEPTION 'Bu mülke erişim yetkiniz yok.' USING ERRCODE = '42501';
  END IF;

  -- The template's own month already represents this month — nothing to post.
  IF date_trunc('month', _t.expense_date)::date = _month_start THEN
    RAISE EXCEPTION 'Bu ayın gideri zaten kayıtlı.';
  END IF;

  -- Serialise concurrent posts for the same template+month so a double-click or
  -- two admins can't slip two instances (and two kasa OUTs) past the check below.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(_template_id::text || to_char(_month_start, 'YYYYMM'), 0)
  );

  -- Idempotent: this month's instance already exists → return it, no double kasa.
  SELECT * INTO _existing FROM expenses
   WHERE recurring_source_id = _template_id
     AND date_trunc('month', expense_date)::date = _month_start
   LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN _existing;
  END IF;

  -- This month's recurring day (clamped to the month length) = the projected date.
  _day := LEAST(COALESCE(_t.recurring_day, 1), _last_day);
  _expense_date := make_date(
    EXTRACT(YEAR FROM _today)::int, EXTRACT(MONTH FROM _today)::int, _day
  );

  -- Materialise the instance exactly like the cron: is_recurring false,
  -- recurring_source_id = template, approval_status 'approved'.
  INSERT INTO expenses (
    property_id, category, amount, description, expense_date,
    is_recurring, paid_from_kasa, recurring_source_id, approval_status, created_by
  ) VALUES (
    _t.property_id, _t.category, _t.amount, _t.description, _expense_date,
    false, _t.paid_from_kasa, _t.id, 'approved', auth.uid()
  )
  RETURNING * INTO _instance;

  -- Post the matching approved kasa OUT when the template is kasa-paid.
  IF _instance.paid_from_kasa THEN
    SELECT id INTO _kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
    IF _kasa_id IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı.';
    END IF;
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, approval_status, created_by
    ) VALUES (
      _kasa_id, _instance.amount, 'OUT',
      'Düzenli gider: ' || _instance.category || COALESCE(' — ' || _instance.description, ''),
      'expense', _instance.id, 'approved', auth.uid()
    );
  END IF;

  RETURN _instance;
END;
$$;

GRANT EXECUTE ON FUNCTION post_recurring_instance_now(uuid) TO authenticated;

COMMENT ON FUNCTION post_recurring_instance_now(uuid) IS
  'Materialises a recurring expense template''s current-month instance on demand (+ approved kasa OUT when kasa-paid), replicating the cron. Idempotent; branch-scoped for managers.';
