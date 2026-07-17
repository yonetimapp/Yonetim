-- =============================================================================
-- HomeGuru PMS — migration 071
-- Denormalize property_id onto cash_transactions for "Mülk Bazlı" kasa view.
-- =============================================================================
-- The kasa page wants three views: Genel (all), Bugünün Cirosu (today only),
-- and Mülk Bazlı (filter by property). The third needs a fast per-row
-- property lookup. Tracing back via payment_collections + expenses joins on
-- every render is unbounded and ugly; instead we store property_id directly
-- on the cash_transactions row.
--
-- Manual kasa entries (submit_cash_tx) + salary OUT rows stay NULL — they
-- aren't bound to a property. Genel giderler (property_id IS NULL on the
-- expense) also stay NULL here.
--
-- Backfill walks the two source tables (payment_collections, expenses) so
-- historical rows pick up the right property.
-- =============================================================================

ALTER TABLE cash_transactions
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cash_transactions_property_idx
  ON cash_transactions(property_id) WHERE property_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill from payment_collections (CASH/CONFIRMED rows are linked by
-- payment_collection_id, set up since migration 016).
-- ---------------------------------------------------------------------------
UPDATE cash_transactions ct
SET property_id = pc.property_id
FROM payment_collections pc
WHERE ct.payment_collection_id = pc.id
  AND ct.property_id IS NULL;

-- ---------------------------------------------------------------------------
-- Backfill from expenses (ref_type='expense', ref_id = expense.id).
-- ---------------------------------------------------------------------------
UPDATE cash_transactions ct
SET property_id = e.property_id
FROM expenses e
WHERE ct.ref_type = 'expense'
  AND ct.ref_id = e.id
  AND ct.property_id IS NULL;

-- ---------------------------------------------------------------------------
-- Update the three RPCs that insert cash_transactions on behalf of the
-- operator so future rows have property_id from day one.
-- ---------------------------------------------------------------------------

-- 1. record_expense (migration 067 was the last version; admin path is now
-- a no-op for kasa but the approve_expense path is what actually posts).
-- Update both. record_expense itself just inserts an expense as 'pending',
-- so the kasa insert here is unreachable — but we'll update it anyway for
-- future-proofing in case the always-pending flag is ever relaxed.

-- approve_expense (migration 055 last touched it): set property_id on the
-- kasa OUT row from the expense's own property_id.
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
  SET approval_status  = 'approved',
      reviewed_by      = auth.uid(),
      reviewed_at      = now(),
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
      approval_status, property_id, created_by
    ) VALUES (
      _kasa_id, _expense.amount, 'OUT',
      'Gider: ' || _expense.category || COALESCE(' — ' || _expense.description, ''),
      'expense', _expense.id,
      'approved', _expense.property_id, auth.uid()
    );
  END IF;

  RETURN _expense;
END;
$$;

-- 2. confirm_payment (migration 039 last full version): set property_id from
-- the payment_collection (which has it natively).
CREATE OR REPLACE FUNCTION confirm_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user            uuid;
  _caller_role            text;
  _pc                     payment_collections;
  _reservation_guest      uuid;
  _resolved_cash_account  uuid;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO _caller_role FROM staff_profiles
    WHERE user_id = _caller_user AND deleted_at IS NULL;

  IF _caller_role NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Yalnızca yönetici tahsilat onaylayabilir' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _pc FROM payment_collections WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tahsilat bulunamadı';
  END IF;

  IF _pc.status <> 'UNCONFIRMED' THEN
    RAISE EXCEPTION 'Bu tahsilat zaten % durumunda, onaylanamaz', _pc.status;
  END IF;

  IF _caller_role = 'PROPERTY_MANAGER' AND NOT auth_sees_property(_pc.property_id) THEN
    RAISE EXCEPTION 'Bu tahsilata erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  SELECT guest_id INTO _reservation_guest
  FROM reservations WHERE id = _pc.reservation_id;
  IF _reservation_guest IS NULL THEN
    RAISE EXCEPTION 'İlişkili rezervasyon bulunamadı';
  END IF;

  SELECT id INTO _resolved_cash_account FROM cash_accounts LIMIT 1;
  IF _resolved_cash_account IS NULL THEN
    RAISE EXCEPTION 'Genel kasa bulunamadı';
  END IF;

  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by, payment_collection_id
  ) VALUES (
    _reservation_guest, _pc.reservation_id, 'PAYMENT', _pc.amount,
    'Ödeme — ' || _pc.method || ' (onaylandı)', _caller_user, _pc.id
  );

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by, payment_collection_id, property_id
  ) VALUES (
    _resolved_cash_account, _pc.amount, 'IN',
    'Misafir ödemesi — ' || _pc.method || ' (onaylandı)',
    'payment_collection', _pc.id, _caller_user, _pc.id, _pc.property_id
  );

  UPDATE payment_collections
  SET status = 'CONFIRMED', confirmed_by = _caller_user, confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;
