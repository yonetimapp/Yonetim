-- =============================================================================
-- HomeGuru PMS — migration 055
-- Approval queue for non-SUPER_ADMIN money movements.
-- =============================================================================
-- Today every cash_transactions / expenses row inserted by PROPERTY_MANAGER
-- lands directly and immediately moves the kasa balance. The operator wants
-- a "yönetici onayı" (SUPER_ADMIN approval) gate in front of those flows —
-- mirroring the existing UNCONFIRMED → confirmed loop on payment_collections.
--
-- Shape:
--   * cash_transactions + expenses each get an approval_status column
--     ('pending' | 'approved' | 'rejected'), default 'approved' so historical
--     rows and admin-driven inserts behave as before.
--   * record_expense detects auth_role() at run time. SUPER_ADMIN keeps the
--     fast path (expense + kasa OUT in one shot). PROPERTY_MANAGER inserts
--     the expense with status='pending' and SKIPS the kasa OUT — the matching
--     kasa OUT only fires when SUPER_ADMIN approves.
--   * Manual kasa entries (the cash modal) go through a new submit_cash_tx
--     RPC. PROPERTY_MANAGER gets 'pending'; SUPER_ADMIN gets 'approved'.
--   * cash_account_balances() now ignores 'pending' / 'rejected' rows so the
--     visible kasa balance only reflects approved movements.
--   * Approve / reject RPCs are SUPER_ADMIN-only and audit the reviewer.
--   * Push: new event_type 'pending_approval' fires on every new pending row.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Approval columns. Defaults keep historical rows and admin inserts
--    transparent — only the new pending paths set status='pending'.
-- ----------------------------------------------------------------------------
ALTER TABLE cash_transactions
  ADD COLUMN IF NOT EXISTS approval_status   text NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS submitted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason  text;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS approval_status   text NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS reviewed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason  text;

CREATE INDEX IF NOT EXISTS cash_transactions_pending_idx
  ON cash_transactions(approval_status) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS expenses_pending_idx
  ON expenses(approval_status) WHERE approval_status = 'pending';

-- ----------------------------------------------------------------------------
-- 2. Balance aggregate now filters approved rows only. Pending submissions
--    sit in the queue without touching the visible balance.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cash_account_balances()
RETURNS TABLE(cash_account_id uuid, balance numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    ct.cash_account_id,
    SUM(CASE WHEN ct.direction = 'IN' THEN ct.amount ELSE -ct.amount END)
  FROM cash_transactions ct
  WHERE ct.approval_status = 'approved'
  GROUP BY ct.cash_account_id;
$$;

-- ----------------------------------------------------------------------------
-- 3. record_expense — role-aware. Drop and recreate to be explicit about
--    the new behaviour; signature unchanged from migration 054.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint);

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
  _expense          expenses;
  _kasa_id          uuid;
  _caller_role      text := auth_role();
  _approval_status  text := CASE WHEN _caller_role = 'SUPER_ADMIN' THEN 'approved' ELSE 'pending' END;
BEGIN
  INSERT INTO expenses (
    property_id, category, amount, description, expense_date,
    is_recurring, paid_from_kasa, recurring_day, approval_status, created_by
  ) VALUES (
    _property_id, _category, _amount,
    NULLIF(btrim(COALESCE(_description, '')), ''),
    _expense_date,
    COALESCE(_is_recurring, false),
    COALESCE(_paid_from_kasa, false),
    _recurring_day,
    _approval_status,
    auth.uid()
  )
  RETURNING * INTO _expense;

  -- Only post the matching kasa OUT immediately when the caller is admin —
  -- the pending path waits for approve_expense() to create it.
  IF _expense.paid_from_kasa AND _approval_status = 'approved' THEN
    SELECT id INTO _kasa_id FROM cash_accounts LIMIT 1;
    IF _kasa_id IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı';
    END IF;
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description, ref_type, ref_id,
      approval_status, created_by
    ) VALUES (
      _kasa_id, _expense.amount, 'OUT',
      'Gider: ' || _expense.category || COALESCE(' — ' || _expense.description, ''),
      'expense', _expense.id,
      'approved',
      auth.uid()
    );
  END IF;

  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION
  record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. submit_cash_tx — manual kasa modal. PROPERTY_MANAGER gets 'pending';
--    SUPER_ADMIN gets 'approved'. RECEPTION / HOUSEKEEPING are blocked by
--    the existing cash_tx_insert RLS policy regardless.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_cash_tx(
  _cash_account_id uuid,
  _amount          numeric,
  _direction       text,
  _description     text
) RETURNS cash_transactions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _row             cash_transactions;
  _caller_role     text := auth_role();
  _approval_status text := CASE WHEN _caller_role = 'SUPER_ADMIN' THEN 'approved' ELSE 'pending' END;
BEGIN
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Tutar sıfırdan büyük olmalıdır';
  END IF;
  IF _direction NOT IN ('IN', 'OUT') THEN
    RAISE EXCEPTION 'Geçersiz yön: %', _direction;
  END IF;

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    approval_status, submitted_by, created_by
  ) VALUES (
    _cash_account_id, _amount, _direction::tx_direction,
    NULLIF(btrim(COALESCE(_description, '')), ''),
    _approval_status, auth.uid(), auth.uid()
  )
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_cash_tx(uuid, numeric, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. approve_expense / reject_expense — SUPER_ADMIN-only review actions.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_expense(_expense_id uuid)
RETURNS expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _expense  expenses;
  _kasa_id  uuid;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Onay yetkisi yalnızca yöneticidedir';
  END IF;

  UPDATE expenses
  SET approval_status = 'approved',
      reviewed_by     = auth.uid(),
      reviewed_at     = now(),
      rejection_reason = NULL
  WHERE id = _expense_id
    AND approval_status = 'pending'
  RETURNING * INTO _expense;

  IF _expense.id IS NULL THEN
    RAISE EXCEPTION 'Gider bulunamadı veya zaten incelenmiş';
  END IF;

  IF _expense.paid_from_kasa THEN
    SELECT id INTO _kasa_id FROM cash_accounts LIMIT 1;
    IF _kasa_id IS NULL THEN
      RAISE EXCEPTION 'Genel kasa bulunamadı';
    END IF;
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description, ref_type, ref_id,
      approval_status, created_by
    ) VALUES (
      _kasa_id, _expense.amount, 'OUT',
      'Gider: ' || _expense.category || COALESCE(' — ' || _expense.description, ''),
      'expense', _expense.id,
      'approved',
      auth.uid()
    );
  END IF;

  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION approve_expense(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reject_expense(_expense_id uuid, _reason text DEFAULT NULL)
RETURNS expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _expense expenses;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Onay yetkisi yalnızca yöneticidedir';
  END IF;

  UPDATE expenses
  SET approval_status  = 'rejected',
      reviewed_by      = auth.uid(),
      reviewed_at      = now(),
      rejection_reason = NULLIF(btrim(COALESCE(_reason, '')), '')
  WHERE id = _expense_id
    AND approval_status = 'pending'
  RETURNING * INTO _expense;

  IF _expense.id IS NULL THEN
    RAISE EXCEPTION 'Gider bulunamadı veya zaten incelenmiş';
  END IF;

  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION reject_expense(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. approve_cash_tx / reject_cash_tx — same shape, in-place status flip.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_cash_tx(_cash_tx_id uuid)
RETURNS cash_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row cash_transactions;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Onay yetkisi yalnızca yöneticidedir';
  END IF;

  UPDATE cash_transactions
  SET approval_status  = 'approved',
      reviewed_by      = auth.uid(),
      reviewed_at      = now(),
      rejection_reason = NULL
  WHERE id = _cash_tx_id
    AND approval_status = 'pending'
  RETURNING * INTO _row;

  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'Kasa hareketi bulunamadı veya zaten incelenmiş';
  END IF;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION approve_cash_tx(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reject_cash_tx(_cash_tx_id uuid, _reason text DEFAULT NULL)
RETURNS cash_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row cash_transactions;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Onay yetkisi yalnızca yöneticidedir';
  END IF;

  UPDATE cash_transactions
  SET approval_status  = 'rejected',
      reviewed_by      = auth.uid(),
      reviewed_at      = now(),
      rejection_reason = NULLIF(btrim(COALESCE(_reason, '')), '')
  WHERE id = _cash_tx_id
    AND approval_status = 'pending'
  RETURNING * INTO _row;

  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'Kasa hareketi bulunamadı veya zaten incelenmiş';
  END IF;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION reject_cash_tx(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. Notification preferences: register the new pending_approval event type
--    so the bell-icon modal can show a toggle for it.
-- ----------------------------------------------------------------------------
ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_type_check;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_event_type_check
  CHECK (event_type IN (
    'new_issue',
    'payment_unconfirmed',
    'new_reservation',
    'reservation_auto_completed',
    'salary_auto_paid',
    'upcoming_reservation_2d',
    'pending_approval'
  ));

-- ----------------------------------------------------------------------------
-- 8. Push triggers on new pending rows. Fire ONLY when approval_status starts
--    as 'pending' — admin-driven inserts (approved by default) stay silent.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _notify_new_pending_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prop_name text;
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;
  SELECT name INTO prop_name FROM properties WHERE id = NEW.property_id;
  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Onay bekleyen gider',
    COALESCE(prop_name, 'Genel') || ' — ' || NEW.category || ' · ' || NEW.amount::text || ' ₺',
    '/finance/pending',
    'system',
    'pending_approval',
    jsonb_build_object('id', NEW.id, 'kind', 'expense')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION _notify_new_pending_cash_tx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.approval_status <> 'pending' THEN
    RETURN NEW;
  END IF;
  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Onay bekleyen kasa hareketi',
    (CASE WHEN NEW.direction = 'IN' THEN '+ ' ELSE '- ' END)
      || NEW.amount::text || ' ₺'
      || COALESCE(' · ' || NEW.description, ''),
    '/finance/pending',
    'system',
    'pending_approval',
    jsonb_build_object('id', NEW.id, 'kind', 'cash_tx')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_notify_pending ON expenses;
CREATE TRIGGER expenses_notify_pending
  AFTER INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION _notify_new_pending_expense();

DROP TRIGGER IF EXISTS cash_transactions_notify_pending ON cash_transactions;
CREATE TRIGGER cash_transactions_notify_pending
  AFTER INSERT ON cash_transactions
  FOR EACH ROW EXECUTE FUNCTION _notify_new_pending_cash_tx();
