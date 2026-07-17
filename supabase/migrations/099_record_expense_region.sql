-- =============================================================================
-- HomeGuru PMS — migration 099
-- record_expense gains an optional _region so an admin can file a GENEL gider
-- directly into a region (Bornova) from the form.
-- =============================================================================
-- For a mülk gider the region always follows the mülk (set_expense_region, 095),
-- so _region is ignored there. For a genel (mülksüz) gider the trigger keeps an
-- explicit region if given, else falls back to the caller's region — so:
--   * admin picks Bornova  -> _region = 'bornova' -> Bornova kasa
--   * admin leaves it       -> _region = NULL      -> Genel (Ana Grup) kasa
--   * a Bornova manager     -> _region NULL -> trigger uses their own region
-- =============================================================================

DROP FUNCTION IF EXISTS record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint);

CREATE OR REPLACE FUNCTION record_expense(
  _property_id    uuid,
  _category       text,
  _amount         numeric,
  _description    text,
  _expense_date   date,
  _is_recurring   boolean,
  _paid_from_kasa boolean,
  _recurring_day  smallint DEFAULT NULL,
  _region         text     DEFAULT NULL
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
    is_recurring, paid_from_kasa, recurring_day, region, approval_status, created_by
  ) VALUES (
    _property_id, _category, _amount,
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
  record_expense(uuid, text, numeric, text, date, boolean, boolean, smallint, text)
  TO authenticated;
