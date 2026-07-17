-- =============================================================================
-- HomeGuru PMS — migration 067
-- Yönetici self-review: even SUPER_ADMIN's own transactions queue for onay.
-- =============================================================================
-- Until now, SUPER_ADMIN was the "fast path" — record_expense, submit_cash_tx
-- and collect_payment all wrote rows as approved/CONFIRMED immediately for
-- the yönetici. Operator now wants the queue to be unconditional: every
-- human-initiated money movement (gider, kasa hareketi, tahsilat) lands in
-- /finance/pending and must be tapped Onayla — even by the yönetici who
-- created it. This is a deliberate double-confirm step to prevent typos
-- silently moving money.
--
-- Out of scope:
--   - Auto-pay salary cron, auto-debit cron, recurring-expense cron —
--     those are "the system" and continue to post directly.
--   - pay_staff_salary (manual MANUAL salary RPC) is admin-only by 062 and
--     stays admin-direct for now. Operator can ask later.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. record_expense — drop the SUPER_ADMIN fast path. Every caller submits
--    a 'pending' row with no kasa OUT until approve_expense fires.
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
  _expense  expenses;
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
    'pending',
    auth.uid()
  )
  RETURNING * INTO _expense;
  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION
  record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. submit_cash_tx — every caller's manual kasa entry lands as pending.
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
  _row cash_transactions;
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
    'pending', auth.uid(), auth.uid()
  )
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

-- Tighten the cash_tx_insert RLS too — even SUPER_ADMIN's direct INSERT
-- (when not going through a SECURITY DEFINER RPC) must now declare pending.
-- The collect_payment / confirm_payment / approve_* / record_expense
-- approval-side / pay_staff_salary RPCs are all SECURITY DEFINER so they
-- bypass RLS and continue inserting 'approved' rows on the post-approval
-- side.
DROP POLICY IF EXISTS cash_tx_insert ON cash_transactions;
CREATE POLICY cash_tx_insert ON cash_transactions FOR INSERT
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER')
    AND approval_status = 'pending'
  );

-- ----------------------------------------------------------------------------
-- 3. collect_payment — every caller submits UNCONFIRMED. Even SUPER_ADMIN
--    re-approves their own collection on /finance/pending → Tahsilat tab.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION collect_payment(
  _reservation_id  uuid,
  _amount          numeric,
  _method          text,
  _cash_account_id uuid DEFAULT NULL,
  _note            text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user          uuid;
  _caller_role          text;
  _reservation_property uuid;
  _property_type        text;
  _payment_id           uuid;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO _caller_role FROM staff_profiles
    WHERE user_id = _caller_user AND deleted_at IS NULL;
  IF _caller_role IS NULL THEN
    RAISE EXCEPTION 'Personel profili bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT r.property_id, p.type
    INTO _reservation_property, _property_type
  FROM reservations r
  JOIN properties p ON p.id = r.property_id
  WHERE r.id = _reservation_id;

  IF _reservation_property IS NULL THEN
    RAISE EXCEPTION 'Rezervasyon bulunamadı';
  END IF;

  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL;
  ELSIF _caller_role IN ('PROPERTY_MANAGER', 'YETKILI', 'RECEPTION', 'HOUSEKEEPING') THEN
    IF NOT auth_sees_property(_reservation_property) THEN
      RAISE EXCEPTION 'Bu mülke erişim yetkiniz yok' USING ERRCODE = '42501';
    END IF;
    IF _caller_role = 'RECEPTION' AND _property_type <> 'HOTEL' THEN
      RAISE EXCEPTION 'Resepsiyon yalnızca otellerde ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
    IF _caller_role = 'HOUSEKEEPING' AND _property_type <> 'APARTMENT' THEN
      RAISE EXCEPTION 'Temizlik yalnızca apartmanlarda ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Yetkisiz rol' USING ERRCODE = '42501';
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Tutar sıfırdan büyük olmalıdır';
  END IF;
  IF _method NOT IN ('CASH', 'TRANSFER', 'CARD') THEN
    RAISE EXCEPTION 'Ödeme yöntemi geçersiz (CASH / TRANSFER / CARD)';
  END IF;

  -- ALL callers (yönetici included) submit UNCONFIRMED. The cari + kasa
  -- only update when confirm_payment fires from /finance/pending.
  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id, amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user, _amount, _method, 'UNCONFIRMED'
  )
  RETURNING id INTO _payment_id;

  RETURN _payment_id;
END;
$$;
