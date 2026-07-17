-- =============================================================================
-- HomeGuru PMS — migration 105
-- Optionally tie a gider to a specific birim (unit) within the mülk.
-- =============================================================================
-- A mülk gider can now name a single birim (e.g. one room of Bornova Bina), or
-- stay at "Tüm birimler" (unit_id NULL = the whole mülk). This is metadata only:
-- region/kasa routing still follows the mülk (property_id), so nothing about the
-- money flow changes.
-- =============================================================================

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS expenses_unit_idx
  ON expenses(unit_id) WHERE unit_id IS NOT NULL;

-- record_expense gains _unit_id (after _region). Validates the unit really
-- belongs to the mülk so a bad pairing can't be stored.
DROP FUNCTION IF EXISTS record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint, text);

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
  _expense  expenses;
BEGIN
  IF _unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM units WHERE id = _unit_id AND property_id = _property_id
  ) THEN
    RAISE EXCEPTION 'Seçilen birim bu mülke ait değil';
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
  RETURN _expense;
END;
$$;

GRANT EXECUTE ON FUNCTION
  record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint, text, uuid)
  TO authenticated;
