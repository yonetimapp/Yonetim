-- =============================================================================
-- HomeGuru PMS — migration 062
-- Money-correctness fixes uncovered by the audit:
--   * pay_staff_salary: SUPER_ADMIN-only + reject zero/negative
--   * cash_transactions INSERT RLS: non-admins forced to approval_status='pending'
--   * soft_delete_entity on cash_transactions: refuse rows linked to a
--     payment_collection so the kasa never diverges from the ledger
--   * expenses.paid_from_kasa: immutable after insert (no silent kasa drift)
--   * ledger_entries: UNIQUE (payment_collection_id) WHERE type='PAYMENT'
--     so a double-confirm path can never duplicate the PAYMENT row
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. pay_staff_salary — SUPER_ADMIN only. PROPERTY_MANAGERs that need a
--    manual payment go through a SUPER_ADMIN approval; nobody but the
--    yönetici can debit the kasa for salaries. Also tightens the amount
--    guard from "negative is bad" to "anything <= 0 is bad" so a fat-finger
--    zero doesn't burn the (user_id, pay_period) slot.
-- ----------------------------------------------------------------------------
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

  RETURN result;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. cash_transactions INSERT RLS — close the manager-bypass.
--    PROPERTY_MANAGER may only INSERT rows with approval_status='pending'
--    (which is what submit_cash_tx does anyway). SUPER_ADMIN unrestricted.
--    SECURITY DEFINER RPCs (collect_payment, confirm_payment, record_expense
--    on the admin path, pay_staff_salary, approve_*) bypass RLS so they
--    continue inserting 'approved' rows directly.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS cash_tx_insert ON cash_transactions;
CREATE POLICY cash_tx_insert ON cash_transactions FOR INSERT
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND approval_status = 'pending')
  );

-- ----------------------------------------------------------------------------
-- 3. soft_delete_entity — refuse trash on a cash_transactions row that
--    belongs to a payment_collection. The user must trash the parent
--    payment_collection instead (the existing ON DELETE CASCADE on
--    cash_transactions.payment_collection_id then sweeps the kasa row too).
--    Keeps the kasa balance in lockstep with the cari PAYMENT ledger entry.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soft_delete_entity(p_type text, p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload  jsonb;
  v_branch   uuid;
  v_label    text;
  v_trash_id uuid;
  v_pc_id    uuid;
BEGIN
  CASE p_type
    WHEN 'housekeeping_issues' THEN
      SELECT to_jsonb(t),
             t.property_id,
             COALESCE(left(t.description, 80), '(boş)')
        INTO v_payload, v_branch, v_label
        FROM housekeeping_issues t
        WHERE t.id = p_id;

    WHEN 'reservations' THEN
      SELECT to_jsonb(t),
             t.property_id,
             COALESCE(g.full_name, 'Misafir') ||
               ' · ' || to_char(t.stay_start, 'YYYY-MM-DD') ||
               '→' || to_char(t.stay_end, 'YYYY-MM-DD')
        INTO v_payload, v_branch, v_label
        FROM reservations t
        LEFT JOIN guests g ON g.id = t.guest_id
        WHERE t.id = p_id;

    WHEN 'cash_transactions' THEN
      SELECT to_jsonb(t),
             a.property_id,
             t.direction || ' ' || t.amount::text || COALESCE(' — ' || t.description, ''),
             t.payment_collection_id
        INTO v_payload, v_branch, v_label, v_pc_id
        FROM cash_transactions t
        JOIN cash_accounts a ON a.id = t.cash_account_id
        WHERE t.id = p_id;
      IF v_pc_id IS NOT NULL THEN
        RAISE EXCEPTION
          'Bu kasa hareketi misafir tahsilatından gelir. Önce tahsilatı (Rezervasyon → ledger) silin; kasa hareketi otomatik temizlenir.';
      END IF;

    WHEN 'ledger_entries' THEN
      SELECT to_jsonb(t),
             (SELECT property_id FROM reservations WHERE id = t.reservation_id),
             t.type || ' ' || t.amount::text || COALESCE(' — ' || t.note, '')
        INTO v_payload, v_branch, v_label
        FROM ledger_entries t
        WHERE t.id = p_id;

    WHEN 'expenses' THEN
      SELECT to_jsonb(t),
             t.property_id,
             t.category || ' — ' || t.amount::text
        INTO v_payload, v_branch, v_label
        FROM expenses t
        WHERE t.id = p_id;

    WHEN 'message_templates' THEN
      SELECT to_jsonb(t),
             NULL::uuid,
             t.name
        INTO v_payload, v_branch, v_label
        FROM message_templates t
        WHERE t.id = p_id;

    WHEN 'staff_advances' THEN
      SELECT to_jsonb(t),
             (SELECT property_id FROM staff_profiles WHERE user_id = t.user_id),
             t.amount::text || COALESCE(' — ' || t.note, '')
        INTO v_payload, v_branch, v_label
        FROM staff_advances t
        WHERE t.id = p_id;

    WHEN 'units' THEN
      SELECT to_jsonb(t),
             t.property_id,
             t.name
        INTO v_payload, v_branch, v_label
        FROM units t
        WHERE t.id = p_id;

    ELSE
      RAISE EXCEPTION 'Trash bin does not support entity type: %', p_type;
  END CASE;

  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı veya görme yetkiniz yok.';
  END IF;

  INSERT INTO trash_entries (entity_type, entity_id, entity_label, branch_id, payload, deleted_by)
  VALUES (p_type, p_id, v_label, v_branch, v_payload, auth.uid())
  RETURNING id INTO v_trash_id;

  CASE p_type
    WHEN 'housekeeping_issues' THEN DELETE FROM housekeeping_issues WHERE id = p_id;
    WHEN 'reservations'        THEN DELETE FROM reservations        WHERE id = p_id;
    WHEN 'cash_transactions'   THEN DELETE FROM cash_transactions   WHERE id = p_id;
    WHEN 'ledger_entries'      THEN DELETE FROM ledger_entries      WHERE id = p_id;
    WHEN 'expenses'            THEN DELETE FROM expenses            WHERE id = p_id;
    WHEN 'message_templates'   THEN DELETE FROM message_templates   WHERE id = p_id;
    WHEN 'staff_advances'      THEN DELETE FROM staff_advances      WHERE id = p_id;
    WHEN 'units'               THEN DELETE FROM units               WHERE id = p_id;
  END CASE;

  RETURN v_trash_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. expenses.paid_from_kasa is now immutable after insert. The kasa-sync
--    trigger from migration 040 only handles amount/category/description
--    changes; toggling paid_from_kasa would silently leave the matching
--    kasa OUT in place (or absent). Lock the column instead of trying to
--    bidirectional-sync — the operator can soft-delete + recreate.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _expense_paid_from_kasa_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.paid_from_kasa IS DISTINCT FROM NEW.paid_from_kasa THEN
    RAISE EXCEPTION
      'paid_from_kasa alanı sonradan değiştirilemez. Gideri silip yeniden oluşturun.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_paid_from_kasa_immutable ON expenses;
CREATE TRIGGER expenses_paid_from_kasa_immutable
  BEFORE UPDATE OF paid_from_kasa ON expenses
  FOR EACH ROW EXECUTE FUNCTION _expense_paid_from_kasa_immutable();

-- ----------------------------------------------------------------------------
-- 5. ledger_entries: defensive UNIQUE so a stray double-INSERT of the
--    PAYMENT row for a single payment_collection becomes a DB error rather
--    than silent duplicate. confirm_payment is already idempotent via the
--    status guard, but a manual SQL slip would otherwise corrupt the cari.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_unique
  ON ledger_entries (payment_collection_id)
  WHERE type = 'PAYMENT' AND payment_collection_id IS NOT NULL;
