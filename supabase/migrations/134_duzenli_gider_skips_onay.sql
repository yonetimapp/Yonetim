-- =============================================================================
-- Yönetim PMS — migration 134
-- Düzenli giderler skip the onay queue, and a non-approved template never posts.
-- =============================================================================
-- Ported from the HomeGuru change of the same name (its migration 125; numbers
-- diverge here, so 134). Two defects, one root cause: onay only ever gated a
-- düzenli gider's FIRST month, and the cron ignored the verdict entirely.
--
-- (1) record_expense (105) births every gider 'pending' with no kasa movement;
--     the kasa OUT is written only by approve_expense (096). But the months the
--     cron generates are born 'approved' with the kasa OUT written directly
--     (106/133) — no onay, ever. So a yönetici had to approve month 1 while
--     months 2..∞ posted themselves. Inconsistent, and it is why a test düzenli
--     sat unapproved and never reached the kasa.
--
-- (2) generate_recurring_expenses selects templates by is_recurring /
--     recurring_source_id / recurring_day and NEVER checks approval_status. So a
--     REJECTED template still generated an auto-approved kasa gider every month
--     — the yönetici's rejection did nothing — and a PENDING template's months
--     bypassed onay completely. This is a money bug.
--
-- Fixes:
--   * A düzenli gider is born APPROVED (kasa OUT immediately) when the creator
--     could approve it themselves — gate is auth_can_review_region(), NOT the
--     raw role. "If you could approve it yourself, we skip the click"; no new
--     privilege is granted to anyone. Gating on the role instead would make
--     approve_expense RAISE and abort the whole creation for anyone who cannot
--     review — see the note below.
--     A YETKILI's düzenli still goes to onay once; the cron takes over only
--     after it is approved.
--   * The generator only materialises APPROVED templates.
--
-- WHO SELF-APPROVES HERE: auth_can_review_region() is this app's version (125),
-- so it is SUPER_ADMIN, or a PROPERTY_MANAGER **scoped to the gider's region**.
-- An ALL-REGION PROPERTY_MANAGER is deliberately review-excluded (125 preserved
-- 096's rule that HQ-level approval belongs to the SUPER_ADMIN), so their düzenli
-- still goes to onay. That is the same shape as HomeGuru, where the exclusion
-- falls out of auth_region() IS NULL instead of the all_regions flag.
--
-- The kasa OUT must go through approve_expense (SECURITY DEFINER): the
-- cash_tx_insert policy (067) only permits a client-side INSERT when
-- approval_status = 'pending', so an INVOKER function cannot write an approved
-- kasa row itself. Reusing approve_expense also keeps the reviewed_by/at audit
-- trail and the kasa routing in one place.
--
-- REBUILD BASES (each is this repo's LATEST version — they are not HomeGuru's):
--   * _notify_new_pending_expense ← 070, NOT 055. HomeGuru's own port rebuilt it
--     from 055 and so dropped 070's "Oluşturan: <ad>" line from the push body;
--     that regression is not reproduced here.
--   * generate_recurring_expenses ← 133, which carries the region fix this app
--     needs (the instance must inherit the template's region or the cron dies on
--     a genel düzenli gider — expenses.region is NOT NULL since 124). Rebuilding
--     from HomeGuru's version would silently reintroduce that crash.
--   * record_expense ← 105 (byte-identical in both repos).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Don't page a yönetici to review a gider that is approved in the same
--    transaction. record_expense sets a transaction-local flag around the INSERT
--    when it is about to self-approve; identical to 070 otherwise.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_pending_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prop_name    text;
  creator_name text;
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;

  -- Born pending only as a stepping stone to approve_expense() — nothing is
  -- actually awaiting review, so no "onay bekleyen gider" push.
  IF COALESCE(current_setting('app.expense_autoapprove', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT name INTO prop_name FROM properties WHERE id = NEW.property_id;
  SELECT full_name INTO creator_name
    FROM staff_profiles WHERE user_id = NEW.created_by;

  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Onay bekleyen gider',
    COALESCE(prop_name, 'Genel') || ' — ' || NEW.category || ' · ' || NEW.amount::text || ' ₺'
      || COALESCE(E'\nOluşturan: ' || creator_name, ''),
    '/finance/pending',
    'system',
    'pending_approval',
    jsonb_build_object('id', NEW.id, 'kind', 'expense')
  );
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. record_expense — identical to 105 plus the düzenli self-approve.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_expense(
  _property_id    uuid,
  _category       text,
  _amount         numeric,
  _description    text,
  _expense_date   date,
  _is_recurring   boolean,
  _paid_from_kasa boolean,
  _recurring_day  smallint DEFAULT NULL,
  _region         text     DEFAULT NULL,
  _unit_id        uuid     DEFAULT NULL
) RETURNS expenses
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _expense    expenses;
  _eff_region text;
  _auto       boolean;
BEGIN
  IF _unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM units WHERE id = _unit_id AND property_id = _property_id
  ) THEN
    RAISE EXCEPTION 'Seçilen birim bu mülke ait değil';
  END IF;

  -- Mirrors set_expense_region (095) so the decision can be made BEFORE the
  -- INSERT (the notify trigger fires on it). If this ever drifts from 095 the
  -- worst case is a düzenli that still goes to onay, or an aborted create with a
  -- clear message — never a wrong kasa row.
  IF _property_id IS NOT NULL THEN
    _eff_region := (SELECT region FROM properties WHERE id = _property_id);
  ELSE
    _eff_region := COALESCE(NULLIF(btrim(COALESCE(_region, '')), ''), auth_region());
  END IF;

  _auto := COALESCE(_is_recurring, false) AND auth_can_review_region(_eff_region);

  IF _auto THEN
    PERFORM set_config('app.expense_autoapprove', 'on', true);
  END IF;

  INSERT INTO expenses (
    property_id, unit_id, category, amount, description, expense_date,
    is_recurring, paid_from_kasa, recurring_day, region, approval_status, created_by
  ) VALUES (
    _property_id, _unit_id, _category, _amount,
    NULLIF(btrim(COALESCE(_description, '')), ''),
    _expense_date,
    COALESCE(_is_recurring, false),
    COALESCE(_paid_from_kasa, false),
    _recurring_day,
    NULLIF(btrim(COALESCE(_region, '')), ''),
    'pending',
    auth.uid()
  )
  RETURNING * INTO _expense;

  -- Writes the kasa OUT + reviewed_by/at. Runs in this same transaction, so if
  -- it refuses, the gider is not created either — no half state.
  IF _auto THEN
    _expense := approve_expense(_expense.id);
  END IF;

  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION
  record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint, text, uuid)
  TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. generate_recurring_expenses — 133's version (tekrar-günü + start-month
--    guard + the region carry) plus: only APPROVED templates materialise. A
--    rejected template must never charge the kasa again, and a pending one must
--    wait for its onay.
-- -----------------------------------------------------------------------------
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
  -- Any kasa will do: the cash_tx BEFORE trigger (112/125) re-points the movement
  -- to the gider's own region kasa. This only has to be non-NULL.
  SELECT id INTO _kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;

  FOR _t IN
    SELECT * FROM expenses
    WHERE is_recurring = true
      AND recurring_source_id IS NULL
      AND recurring_day IS NOT NULL
      AND approval_status = 'approved'
  LOOP
    _due_day := LEAST(_t.recurring_day, _last_day);

    IF _today_day < _due_day THEN
      CONTINUE;
    END IF;

    -- The template's own month already represents that month, and a template
    -- dated in a LATER month has not started yet — never back-post into the
    -- current month (133).
    IF date_trunc('month', _t.expense_date)::date >= _month_start THEN
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

    -- region := the TEMPLATE's region. Without it set_expense_region() resolves a
    -- genel gider to auth_region(), which is NULL under the cron → NOT NULL
    -- violation → the whole run aborts (133).
    INSERT INTO expenses (
      property_id, unit_id, category, amount, description, expense_date,
      is_recurring, paid_from_kasa, recurring_source_id, approval_status, created_by,
      region
    ) VALUES (
      _t.property_id, _t.unit_id, _t.category, _t.amount, _t.description, _expense_date,
      false, _t.paid_from_kasa, _t.id, 'approved', NULL,
      _t.region
    )
    RETURNING id INTO _instance_id;

    IF _t.paid_from_kasa AND _kasa_id IS NOT NULL THEN
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
