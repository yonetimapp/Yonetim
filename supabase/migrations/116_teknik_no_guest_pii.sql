-- =============================================================================
-- HomeGuru PMS — migration 116
-- Deny Teknik Personel Bornova from decrypting guest / companion PII.
-- =============================================================================
-- TEKNIK_PERSONEL_BORNOVA normalises to HOUSEKEEPING via auth_role() (migration
-- 114), and HOUSEKEEPING is allowed to decrypt TC kimlik / passport for guests
-- with an in-scope reservation (the EXISTS branch in get_guest_decrypted /
-- get_companions_decrypted). That gives the technical role more reach than
-- intended — it should report issues and read guest NAMES, never sensitive IDs.
--
-- Fix: an explicit deny at the top of both decrypt RPCs, keyed on the RAW role
-- (auth_role() returns 'HOUSEKEEPING' for this role, so it cannot distinguish it).
-- Everything else is reproduced verbatim from migrations 043 / 042 — no other
-- role's behaviour changes, and guest NAME reads (used by the Sorunlar dropdown)
-- are untouched (they go through guests_select, not these functions).
-- =============================================================================

-- get_guest_decrypted — verbatim from migration 043 + the Teknik deny guard.
CREATE OR REPLACE FUNCTION get_guest_decrypted(_id uuid)
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
  -- Teknik Personel Bornova is never allowed to decrypt guest PII. Checked by
  -- RAW role because auth_role() normalises it to HOUSEKEEPING.
  IF (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
       = 'TEKNIK_PERSONEL_BORNOVA' THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

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

-- get_companions_decrypted — verbatim from migration 042 + the Teknik deny guard.
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
  -- Teknik Personel Bornova is never allowed to decrypt companion PII.
  IF (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
       = 'TEKNIK_PERSONEL_BORNOVA' THEN
    RAISE EXCEPTION 'Bu misafire erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

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
