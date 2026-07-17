-- =============================================================================
-- HomeGuru PMS — Functions migration 002
-- =============================================================================
-- Helper functions used by RLS policies (must exist BEFORE 003_rls.sql runs)
-- + business-logic helpers (balance computation, encryption, triggers).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- auth_role(): returns the calling user's role.
-- SECURITY DEFINER so RLS policies can call it without recursing into the
-- staff_profiles RLS check.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM staff_profiles WHERE user_id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- auth_property_id(): returns the user's assigned property (NULL for super admin)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_property_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT property_id FROM staff_profiles WHERE user_id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- encrypt_sensitive / decrypt_sensitive: pgcrypto wrappers using a Vault key.
--
-- One-time setup (run manually after migrations):
--   SELECT vault.create_secret('replace-with-a-strong-key', 'pms_encryption_key');
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION encrypt_sensitive(plain text)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
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
SET search_path = public, vault
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

-- -----------------------------------------------------------------------------
-- guest_balance(guest_uuid): SUM(debts) - SUM(payments); positive = guest owes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guest_balance(guest_uuid uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(SUM(CASE WHEN type = 'DEBT' THEN amount ELSE -amount END), 0)
  FROM ledger_entries
  WHERE guest_id = guest_uuid
$$;

-- -----------------------------------------------------------------------------
-- Trigger: enforce single-unit constraint on APARTMENT properties
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_apartment_single_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prop_type text;
  unit_count int;
BEGIN
  SELECT type INTO prop_type FROM properties WHERE id = NEW.property_id;
  IF prop_type = 'APARTMENT' THEN
    SELECT count(*) INTO unit_count FROM units WHERE property_id = NEW.property_id;
    IF (TG_OP = 'INSERT' AND unit_count >= 1) THEN
      RAISE EXCEPTION 'APARTMENT properties may have only one unit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER units_apartment_single
  BEFORE INSERT ON units
  FOR EACH ROW EXECUTE FUNCTION enforce_apartment_single_unit();
