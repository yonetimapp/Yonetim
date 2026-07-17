-- =============================================================================
-- HomeGuru PMS — Fix pgcrypto search path, migration 008
-- =============================================================================
-- Bug fix: encrypt_sensitive / decrypt_sensitive from migration 002 set
-- `search_path = public, vault` — but Supabase installs pgcrypto in the
-- `extensions` schema, not public. So `pgp_sym_encrypt` was not visible
-- inside SECURITY DEFINER functions, causing:
--   ERROR: function pgp_sym_encrypt(text, text) does not exist (42883)
--
-- Fix: add `extensions` to search_path so pgcrypto functions resolve.
-- =============================================================================

CREATE OR REPLACE FUNCTION encrypt_sensitive(plain text)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  k text;
BEGIN
  IF plain IS NULL OR plain = '' THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO k FROM vault.decrypted_secrets WHERE name = 'pms_encryption_key';
  IF k IS NULL THEN
    RAISE EXCEPTION 'pms_encryption_key not configured in vault';
  END IF;
  RETURN pgp_sym_encrypt(plain, k);
END;
$$;

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
  -- KVKK audit: every decryption is logged
  INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'DECRYPT', 'sensitive_field', NULL, jsonb_build_object('at', now()));
  RETURN pgp_sym_decrypt(cipher, k);
END;
$$;
