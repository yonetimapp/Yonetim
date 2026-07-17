-- =============================================================================
-- 074: Track who created each guest
-- =============================================================================
-- The guests table only stored created_at, so the Misafirler list couldn't
-- show an "Oluşturan: X" line like reservations / expenses / cash do. Add a
-- nullable created_by (NULL for the existing rows that predate this) and stamp
-- it inside create_guest with auth.uid(). create_guest is SECURITY DEFINER, so
-- it sets the column directly; this is the only insert path from the app.
-- ----------------------------------------------------------------------------

ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

-- Recreate create_guest (latest definition from migration 065) so the INSERT
-- records the caller. Only this clause + the column list change vs. 065.
CREATE OR REPLACE FUNCTION create_guest(
  _full_name        text,
  _tc_kimlik        text DEFAULT NULL,
  _passport         text DEFAULT NULL,
  _phone            text DEFAULT NULL,
  _email            text DEFAULT NULL,
  _address          text DEFAULT NULL,
  _nationality      text DEFAULT NULL,
  _is_problematic   boolean DEFAULT false,
  _problematic_note text DEFAULT NULL
) RETURNS guests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result      guests;
  caller_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı';
  END IF;
  SELECT role INTO caller_role FROM staff_profiles
    WHERE user_id = auth.uid() AND deleted_at IS NULL;
  IF caller_role IS NULL OR caller_role = 'PENDING' THEN
    RAISE EXCEPTION 'Misafir oluşturma yetkisi yok';
  END IF;

  INSERT INTO guests (
    full_name, tc_kimlik_encrypted, passport_encrypted,
    phone, email, address, nationality,
    is_problematic, problematic_note, created_by
  ) VALUES (
    _full_name,
    encrypt_sensitive(_tc_kimlik),
    encrypt_sensitive(_passport),
    _phone, _email, _address, _nationality,
    COALESCE(_is_problematic, false),
    NULLIF(btrim(COALESCE(_problematic_note, '')), ''),
    auth.uid()
  )
  RETURNING * INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION
  create_guest(text, text, text, text, text, text, text, boolean, text) TO authenticated;
