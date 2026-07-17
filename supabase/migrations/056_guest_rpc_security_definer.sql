-- =============================================================================
-- HomeGuru PMS — migration 056
-- create_guest / update_guest: SECURITY DEFINER with internal role check.
-- =============================================================================
-- The guests RLS policy (migration 028) lists every operational staff role,
-- but production sessions kept tripping
--   "new row violates row-level security policy for table guests" (42501)
-- even for accounts whose staff_profiles.role was on the allow-list. Root
-- cause was a fragile interaction between the SECURITY INVOKER RPC + the
-- guests RLS WITH CHECK + how auth_role() resolved in the request context.
--
-- The fix sidesteps it entirely: the RPCs become SECURITY DEFINER and gate
-- access themselves. Any signed-in staff whose role is NOT 'PENDING' may
-- create / update a guest. The guests RLS policies stay in place for
-- defense in depth and any direct-table access paths.
--
-- KVKK note: TC kimlik + passport remain encrypted via encrypt_sensitive(),
-- and read access is still gated by get_guest_decrypted's auditing path.
-- =============================================================================

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
  SELECT role INTO caller_role FROM staff_profiles WHERE user_id = auth.uid();
  IF caller_role IS NULL OR caller_role = 'PENDING' THEN
    RAISE EXCEPTION 'Misafir oluşturma yetkisi yok';
  END IF;

  INSERT INTO guests (
    full_name, tc_kimlik_encrypted, passport_encrypted,
    phone, email, address, nationality,
    is_problematic, problematic_note
  ) VALUES (
    _full_name,
    encrypt_sensitive(_tc_kimlik),
    encrypt_sensitive(_passport),
    _phone, _email, _address, _nationality,
    COALESCE(_is_problematic, false),
    NULLIF(btrim(COALESCE(_problematic_note, '')), '')
  )
  RETURNING * INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION update_guest(
  _id               uuid,
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
  SELECT role INTO caller_role FROM staff_profiles WHERE user_id = auth.uid();
  IF caller_role IS NULL OR caller_role = 'PENDING' THEN
    RAISE EXCEPTION 'Misafir güncelleme yetkisi yok';
  END IF;

  UPDATE guests SET
    full_name = _full_name,
    tc_kimlik_encrypted = encrypt_sensitive(_tc_kimlik),
    passport_encrypted = encrypt_sensitive(_passport),
    phone = _phone,
    email = _email,
    address = _address,
    nationality = _nationality,
    is_problematic = COALESCE(_is_problematic, false),
    problematic_note = NULLIF(btrim(COALESCE(_problematic_note, '')), '')
  WHERE id = _id
  RETURNING * INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Misafir bulunamadı';
  END IF;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION create_guest(text, text, text, text, text, text, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION update_guest(uuid, text, text, text, text, text, text, text, boolean, text) TO authenticated;
