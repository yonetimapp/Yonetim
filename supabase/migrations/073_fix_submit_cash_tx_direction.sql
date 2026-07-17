-- ============================================================================
-- 073: Fix submit_cash_tx — remove bogus ::tx_direction cast
-- ============================================================================
-- The manual "Yeni Kasa Hareketi" form failed with:
--   type "tx_direction" does not exist (42704)
-- submit_cash_tx (from migration 067) cast _direction::tx_direction, but no
-- such enum type exists — cash_transactions.direction is plain text with a
-- CHECK (direction IN ('IN','OUT')) constraint (migration 001). The cast was
-- copied from the EXCLUDE/INSERT paths by mistake. Recreate the function
-- inserting the text value directly; the CHECK + the NOT IN guard above keep
-- it constrained to 'IN'/'OUT'.
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
    _cash_account_id, _amount, _direction,
    NULLIF(btrim(COALESCE(_description, '')), ''),
    'pending', auth.uid(), auth.uid()
  )
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION
  submit_cash_tx(uuid, numeric, text, text) TO authenticated;
