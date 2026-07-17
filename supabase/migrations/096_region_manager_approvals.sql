-- =============================================================================
-- HomeGuru PMS — migration 096
-- Region isolation — a region yönetici approves/rejects within their region.
-- =============================================================================
-- The Onaylar queue (giderler + manuel kasa) was SUPER_ADMIN-only. But a
-- "Yönetici Bornova" (PROPERTY_MANAGER with a region) IS the yönetici for that
-- region and must approve/reject its own giderler + kasa hareketleri. We relax
-- the four review functions: a region manager may review only items in their
-- own region; HQ / Ana Grup items stay SUPER_ADMIN-only (unchanged). The
-- super admin still reviews everything.
-- =============================================================================

-- Reviewer gate: SUPER_ADMIN always, or a region manager for their own region.
-- HQ property managers (region NULL) are intentionally excluded — HQ approval
-- stays with the super admin, as before.
CREATE OR REPLACE FUNCTION auth_can_review_region(p_region text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth_role() = 'SUPER_ADMIN'
    OR (
      auth_role() = 'PROPERTY_MANAGER'
      AND auth_region() IS NOT NULL
      AND p_region IS NOT DISTINCT FROM auth_region()
    );
$$;
GRANT EXECUTE ON FUNCTION auth_can_review_region(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- approve_expense (was 071) — region-scoped gate; rest unchanged. The kasa OUT
-- is routed to the right region kasa by the 094/095 trigger.
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
  IF NOT auth_can_review_region((SELECT region FROM expenses WHERE id = _expense_id)) THEN
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

-- ----------------------------------------------------------------------------
-- reject_expense (was 055) — region-scoped gate; rest unchanged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_expense(_expense_id uuid, _reason text DEFAULT NULL)
RETURNS expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _expense expenses;
BEGIN
  IF NOT auth_can_review_region((SELECT region FROM expenses WHERE id = _expense_id)) THEN
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

-- ----------------------------------------------------------------------------
-- approve_cash_tx (was 055) — region from the movement's kasa.
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
  IF NOT auth_can_review_region((
        SELECT ca.region FROM cash_accounts ca
        JOIN cash_transactions ct ON ct.cash_account_id = ca.id
        WHERE ct.id = _cash_tx_id)) THEN
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

-- ----------------------------------------------------------------------------
-- reject_cash_tx (was 055) — region from the movement's kasa.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_cash_tx(_cash_tx_id uuid, _reason text DEFAULT NULL)
RETURNS cash_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row cash_transactions;
BEGIN
  IF NOT auth_can_review_region((
        SELECT ca.region FROM cash_accounts ca
        JOIN cash_transactions ct ON ct.cash_account_id = ca.id
        WHERE ct.id = _cash_tx_id)) THEN
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
