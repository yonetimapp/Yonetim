-- =============================================================================
-- HomeGuru PMS — migration 030
-- Make the KVKK audit log human-readable.
-- =============================================================================
-- Before: every TC/passport decryption logged a bare row —
--   action='DECRYPT', entity_type='sensitive_field', entity_id=NULL,
--   metadata={'at': <timestamp>}
-- That can't answer "who looked at WHOSE data" — entity_id was always NULL
-- and there were 2 rows per guest view (one per encrypted field).
--
-- After:
--   • decrypt_sensitive no longer writes audit rows (it has no guest context).
--   • get_guest_decrypted writes ONE row per call:
--       action='GUEST_DECRYPT', entity_type='guest', entity_id=<guest id>,
--       metadata={'guest_name': <name>}
--   • A SECURITY DEFINER helper does the insert, since get_guest_decrypted is
--     SECURITY INVOKER (keeps RLS on `guests`) and audit_log has no INSERT
--     policy for normal users.
--
-- Legacy 'DECRYPT' rows stay in place; the UI labels them as old records.

-- -----------------------------------------------------------------------------
-- 1. Quiet decrypt_sensitive — drop the per-field audit insert.
--    (get_guest_decrypted is its only caller, so no audit coverage is lost.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decrypt_sensitive(cipher bytea)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  k text;
BEGIN
  IF cipher IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO k FROM vault.decrypted_secrets WHERE name = 'pms_encryption_key';
  IF k IS NULL THEN
    RAISE EXCEPTION 'pms_encryption_key not configured in vault';
  END IF;
  RETURN pgp_sym_decrypt(cipher, k);
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Audit helper — one meaningful row per guest decrypt view.
--    SECURITY DEFINER so it can INSERT into audit_log (RLS-locked for users).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _audit_guest_decrypt(_guest_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _name text;
BEGIN
  SELECT full_name INTO _name FROM guests WHERE id = _guest_id;
  INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
  VALUES (
    auth.uid(),
    'GUEST_DECRYPT',
    'guest',
    _guest_id,
    jsonb_build_object('guest_name', COALESCE(_name, '(bilinmiyor)'))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION _audit_guest_decrypt(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. get_guest_decrypted — log one audit row, then return the decrypted guest.
--    Still SECURITY INVOKER so RLS on `guests` keeps gating row visibility.
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
  -- KVKK audit: record who viewed which guest's sensitive data.
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
    g.consent_given_at,
    g.consent_version,
    g.created_at
  FROM guests g
  WHERE g.id = _id;
END;
$$;
