-- =============================================================================
-- HomeGuru PMS — migration 042
-- Ek Misafir: companions / family members attached to a guest.
-- =============================================================================
-- A guest can carry companions (family members travelling with them). Each
-- companion has the same encrypted identity fields as a guest — TC kimlik /
-- passport via pgcrypto — so the same encrypt + audited-decrypt machinery
-- applies. Companions cascade-delete with their parent guest.
-- =============================================================================

-- 1. Table.
CREATE TABLE guest_companions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id            uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  full_name           text NOT NULL,
  relationship        text,
  birth_date          date,
  nationality         text,
  tc_kimlik_encrypted bytea,
  passport_encrypted  bytea,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX guest_companions_guest_idx ON guest_companions(guest_id);

-- 2. RLS — a companion mirrors its parent guest's visibility; finance/ops
--    roles that can edit guests can manage companions.
ALTER TABLE guest_companions ENABLE ROW LEVEL SECURITY;

CREATE POLICY guest_companions_select ON guest_companions FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guest_companions.guest_id
        AND auth_sees_property(r.property_id)
    )
  );

CREATE POLICY guest_companions_modify ON guest_companions FOR ALL
  USING (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'))
  WITH CHECK (auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI'));

-- 3. create_companion — insert, encrypting TC / passport. SECURITY INVOKER so
--    the insert runs under the caller's RLS, exactly like create_guest.
CREATE OR REPLACE FUNCTION create_companion(
  _guest_id     uuid,
  _full_name    text,
  _relationship text DEFAULT NULL,
  _birth_date   date DEFAULT NULL,
  _nationality  text DEFAULT NULL,
  _tc_kimlik    text DEFAULT NULL,
  _passport     text DEFAULT NULL
) RETURNS guest_companions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result guest_companions;
BEGIN
  INSERT INTO guest_companions (
    guest_id, full_name, relationship, birth_date, nationality,
    tc_kimlik_encrypted, passport_encrypted
  ) VALUES (
    _guest_id, _full_name,
    NULLIF(btrim(COALESCE(_relationship, '')), ''),
    _birth_date,
    NULLIF(btrim(COALESCE(_nationality, '')), ''),
    encrypt_sensitive(_tc_kimlik),
    encrypt_sensitive(_passport)
  )
  RETURNING * INTO result;
  RETURN result;
END;
$$;

-- 4. update_companion.
CREATE OR REPLACE FUNCTION update_companion(
  _id           uuid,
  _full_name    text,
  _relationship text DEFAULT NULL,
  _birth_date   date DEFAULT NULL,
  _nationality  text DEFAULT NULL,
  _tc_kimlik    text DEFAULT NULL,
  _passport     text DEFAULT NULL
) RETURNS guest_companions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result guest_companions;
BEGIN
  UPDATE guest_companions SET
    full_name = _full_name,
    relationship = NULLIF(btrim(COALESCE(_relationship, '')), ''),
    birth_date = _birth_date,
    nationality = NULLIF(btrim(COALESCE(_nationality, '')), ''),
    tc_kimlik_encrypted = encrypt_sensitive(_tc_kimlik),
    passport_encrypted = encrypt_sensitive(_passport)
  WHERE id = _id
  RETURNING * INTO result;
  RETURN result;
END;
$$;

-- 5. get_companions_decrypted — a guest's companions with TC / passport
--    decrypted. SECURITY DEFINER (decrypt_sensitive is revoked from callers);
--    performs its own access check mirroring guests_select, then audit-logs.
CREATE OR REPLACE FUNCTION get_companions_decrypted(_guest_id uuid)
RETURNS TABLE(
  id uuid,
  guest_id uuid,
  full_name text,
  relationship text,
  birth_date date,
  nationality text,
  tc_kimlik text,
  passport text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Access check — mirrors the guests_select policy for the parent guest.
  IF NOT (
    auth_role() = 'SUPER_ADMIN'
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = _guest_id
        AND auth_sees_property(r.property_id)
    )
  ) THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  -- KVKK audit — only when there are companions to actually decrypt, so
  -- opening a guest with no companions doesn't log a hollow access.
  IF EXISTS (SELECT 1 FROM guest_companions gc WHERE gc.guest_id = _guest_id) THEN
    PERFORM _audit_guest_decrypt(_guest_id);
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.guest_id,
    c.full_name,
    c.relationship,
    c.birth_date,
    c.nationality,
    decrypt_sensitive(c.tc_kimlik_encrypted),
    decrypt_sensitive(c.passport_encrypted),
    c.created_at
  FROM guest_companions c
  WHERE c.guest_id = _guest_id
  ORDER BY c.created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION
  create_companion(uuid, text, text, date, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION
  update_companion(uuid, text, text, date, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_companions_decrypted(uuid) TO authenticated;
