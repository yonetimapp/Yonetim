-- =============================================================================
-- HomeGuru PMS — migration 034
-- RLS hardening: three fixes from the pre-launch RLS sanity pass.
-- =============================================================================
-- 1. decrypt_sensitive() was callable directly by any authenticated user
--    (Postgres grants EXECUTE to PUBLIC by default and PostgREST exposes every
--    public-schema function as an RPC). A staffer who can SELECT a guest row
--    gets the encrypted bytea columns and could feed them straight to
--    decrypt_sensitive — reading TC kimlik / passport WITHOUT the GUEST_DECRYPT
--    audit row that get_guest_decrypted writes. That defeats the KVKK
--    "every access to encrypted fields is audited" requirement.
--    Fix: revoke decrypt_sensitive from callers, and make get_guest_decrypted
--    SECURITY DEFINER (so its nested decrypt_sensitive call still resolves)
--    with an explicit guest-visibility check that mirrors the guests_select
--    policy. encrypt_sensitive is intentionally left callable — encrypting your
--    own input leaks nothing, and the SECURITY INVOKER RPCs create_guest /
--    update_guest depend on reaching it.
--
-- 2. payment_collections_update was role-only (SUPER_ADMIN / PROPERTY_MANAGER)
--    with no scope check, while every other policy in migration 033 is scoped
--    via auth_sees_property(). A scope-limited PROPERTY_MANAGER could PATCH an
--    out-of-scope payment row directly through PostgREST. Fix: add the scope
--    check, consistent with 033.
--
-- 3. audit_log SELECT was readable by PROPERTY_MANAGER. The audit log carries
--    guest names (GUEST_DECRYPT rows) and has no property_id to scope by; the
--    app already restricts the Denetim Kaydi page and its nav entry to
--    SUPER_ADMIN, so the PROPERTY_MANAGER grant only widened the REST surface.
--    Fix: SUPER_ADMIN only.
--
-- None of the three changes alters application behaviour — they only close
-- direct-REST bypass paths the UI never uses.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Lock down the decrypted-PII path.
-- -----------------------------------------------------------------------------

-- Stop authenticated users from calling the raw decryptor directly. After this,
-- the ONLY path to plaintext TC / passport is get_guest_decrypted, which audits
-- every call. service_role is left untouched (server-side only, never shipped
-- to the client).
REVOKE EXECUTE ON FUNCTION decrypt_sensitive(bytea) FROM PUBLIC, anon, authenticated;

-- get_guest_decrypted becomes SECURITY DEFINER so its nested decrypt_sensitive
-- call still resolves after the revoke (it now runs as the function owner).
-- Because a DEFINER function owned by the table owner bypasses RLS on `guests`,
-- it performs an explicit access check that mirrors the guests_select policy —
-- the same rows, enforced in code instead of by row security.
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
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Access check — mirrors the guests_select RLS policy (migration 033):
  --   SUPER_ADMIN                 -> every guest
  --   PROPERTY_MANAGER / RECEPTION -> every guest (vetted-staff blanket)
  --   everyone else               -> only guests with a reservation at a
  --                                  property their access_scope covers.
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

  -- KVKK audit: one GUEST_DECRYPT row per call, written before data is
  -- returned. _audit_guest_decrypt is the SECURITY DEFINER helper from 030.
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

-- CREATE OR REPLACE preserves existing grants, but re-assert it for clarity.
GRANT EXECUTE ON FUNCTION get_guest_decrypted(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Scope-isolate payment_collections UPDATE.
-- -----------------------------------------------------------------------------
-- confirm_payment / dispute_payment are SECURITY DEFINER and bypass this policy
-- (they keep their own auth_sees_property() checks). This policy governs only
-- direct PostgREST UPDATEs, which the app never issues.
DROP POLICY IF EXISTS payment_collections_update ON payment_collections;
CREATE POLICY payment_collections_update ON payment_collections FOR UPDATE
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND auth_sees_property(property_id))
  )
  WITH CHECK (
    auth_role() = 'SUPER_ADMIN'
    OR (auth_role() = 'PROPERTY_MANAGER' AND auth_sees_property(property_id))
  );

-- -----------------------------------------------------------------------------
-- 3. Restrict audit_log reads to SUPER_ADMIN.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_select ON audit_log;
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (auth_role() = 'SUPER_ADMIN');
