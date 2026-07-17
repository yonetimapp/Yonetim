-- =============================================================================
-- HomeGuru PMS — Guest CRUD RPC functions, migration 007
-- =============================================================================
-- Server-side encryption for TC kimlik / passport via existing pgcrypto helpers
-- (encrypt_sensitive / decrypt_sensitive from migration 002).
--
-- All functions use SECURITY INVOKER so RLS on the guests table still applies
-- — the user can only create/update/read guests they're already authorized for.
-- decrypt_sensitive remains SECURITY DEFINER, so vault access + audit logging
-- works through it as expected.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_guest: insert a new guest, encrypting TC + passport server-side
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_guest(
  _full_name text,
  _tc_kimlik text DEFAULT NULL,
  _passport text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _email text DEFAULT NULL,
  _address text DEFAULT NULL,
  _nationality text DEFAULT NULL
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
    phone, email, address, nationality
  ) VALUES (
    _full_name,
    encrypt_sensitive(_tc_kimlik),
    encrypt_sensitive(_passport),
    _phone, _email, _address, _nationality
  )
  RETURNING * INTO result;
  RETURN result;
END;
$$;

-- -----------------------------------------------------------------------------
-- update_guest: update an existing guest. NULL TC/passport clears the field.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_guest(
  _id uuid,
  _full_name text,
  _tc_kimlik text DEFAULT NULL,
  _passport text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _email text DEFAULT NULL,
  _address text DEFAULT NULL,
  _nationality text DEFAULT NULL
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
    nationality = _nationality
  WHERE id = _id
  RETURNING * INTO result;
  RETURN result;
END;
$$;

-- -----------------------------------------------------------------------------
-- get_guest_decrypted: fetch a single guest with TC/passport decrypted.
-- Each call generates an audit_log entry per decrypt_sensitive invocation.
-- RLS on `guests` ensures the user can only fetch guests they're allowed to see.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_guest_decrypted(_id uuid)
RETURNS TABLE(
  id uuid,
  full_name text,
  tc_kimlik text,
  passport text,
  phone text,
  email text,
  address text,
  nationality text,
  consent_given_at timestamptz,
  consent_version text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
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
    g.consent_given_at,
    g.consent_version,
    g.created_at
  FROM guests g
  WHERE g.id = _id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants — authenticated role can call these RPCs (RLS still enforces row access)
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION create_guest TO authenticated;
GRANT EXECUTE ON FUNCTION update_guest TO authenticated;
GRANT EXECUTE ON FUNCTION get_guest_decrypted TO authenticated;
