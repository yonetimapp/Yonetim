-- =============================================================================
-- HomeGuru PMS — migration 043
-- Sorunlu Misafir: persistent guest warning flag for housekeeping / reception.
-- =============================================================================
-- A guest can be flagged as "sorunlu" with an optional note (e.g. "broke the
-- lamp last visit"). The flag is persistent and follows the guest across all
-- future reservations. Surfaced as a warning triangle next to the guest name
-- on reservation detail, guest detail, and guest list views.
--
-- Schema additions:
--   guests.is_problematic    boolean NOT NULL DEFAULT false
--   guests.problematic_note  text NULLABLE
--
-- RPC changes:
--   create_guest / update_guest extended with _is_problematic + _problematic_note
--     (both DEFAULTed so existing callers continue to work unchanged).
--   get_guest_decrypted extended to return the two new fields.
--   set_guest_problematic added — focused quick-toggle for the warning button.
--
-- All three modified functions must be DROPped + recreated because adding
-- parameters (or changing RETURNS TABLE shape) makes a new signature; CREATE
-- OR REPLACE would otherwise leave the old overload behind and PostgREST
-- would fail to disambiguate.
-- =============================================================================

-- 1. Columns.
ALTER TABLE guests
  ADD COLUMN is_problematic    boolean NOT NULL DEFAULT false,
  ADD COLUMN problematic_note  text;

-- 2. Drop old signatures so we can recreate with new params / return shape.
DROP FUNCTION IF EXISTS create_guest(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS update_guest(uuid, text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS get_guest_decrypted(uuid);

-- 3. create_guest with new optional flag fields.
CREATE FUNCTION create_guest(
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
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result guests;
BEGIN
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

-- 4. update_guest with new optional flag fields.
CREATE FUNCTION update_guest(
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
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result guests;
BEGIN
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
  RETURN result;
END;
$$;

-- 5. get_guest_decrypted — return new fields. Keeps SECURITY DEFINER + access
--    check + KVKK audit-log call from migration 034.
CREATE FUNCTION get_guest_decrypted(_id uuid)
RETURNS TABLE(
  id                uuid,
  full_name         text,
  tc_kimlik         text,
  passport          text,
  phone             text,
  email             text,
  address           text,
  nationality       text,
  is_problematic    boolean,
  problematic_note  text,
  consent_given_at  timestamptz,
  consent_version   text,
  created_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Access check — mirrors guests_select RLS (migration 033).
  IF NOT (
    auth_role() = 'SUPER_ADMIN'
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = _id
        AND auth_sees_property(r.property_id)
    )
  ) THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  -- KVKK audit (helper from migration 030).
  PERFORM _audit_guest_decrypt(_id);

  RETURN QUERY
  SELECT
    g.id,
    g.full_name,
    decrypt_sensitive(g.tc_kimlik_encrypted),
    decrypt_sensitive(g.passport_encrypted),
    g.phone,
    g.email,
    g.address,
    g.nationality,
    g.is_problematic,
    g.problematic_note,
    g.consent_given_at,
    g.consent_version,
    g.created_at
  FROM guests g
  WHERE g.id = _id;
END;
$$;

-- 6. set_guest_problematic — focused RPC for the warning icon button. Lets
--    the user toggle the flag and edit the note without sending the full
--    guest payload. SECURITY INVOKER so guests RLS (migration 033) still
--    gates who can write.
CREATE FUNCTION set_guest_problematic(
  _id              uuid,
  _is_problematic  boolean,
  _note            text DEFAULT NULL
) RETURNS guests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result guests;
BEGIN
  UPDATE guests SET
    is_problematic = COALESCE(_is_problematic, false),
    problematic_note = NULLIF(btrim(COALESCE(_note, '')), '')
  WHERE id = _id
  RETURNING * INTO result;
  RETURN result;
END;
$$;

-- 7. Grants.
GRANT EXECUTE ON FUNCTION
  create_guest(text, text, text, text, text, text, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION
  update_guest(uuid, text, text, text, text, text, text, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_guest_decrypted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION
  set_guest_problematic(uuid, boolean, text) TO authenticated;
