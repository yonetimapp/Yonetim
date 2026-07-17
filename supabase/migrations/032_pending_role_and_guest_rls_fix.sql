-- =============================================================================
-- HomeGuru PMS — migration 032
-- Security: PENDING signup role + close the guest-PII RLS leak.
-- =============================================================================
-- Two linked fixes from the security review:
--
-- 1. New signups were auto-granted YETKILI (migration 029). With open signup
--    enabled, that means anyone on the internet instantly got an operational
--    role. New signups now get PENDING — a zero-permission role that is in NO
--    RLS allow-list and has no rbac permissions. The account is inert until a
--    SUPER_ADMIN promotes it (the vetting step).
--
-- 2. guests_select had a blanket `OR auth_role() IN (..., 'YETKILI')` with no
--    branch check. Combined with #1 that exposed every guest's name / phone /
--    email / address — and, via the SECURITY INVOKER get_guest_decrypted RPC,
--    their decrypted TC kimlik + passport — to any signup. YETKILI is dropped
--    from the blanket; a YETKILI now sees guests only through the existing
--    branch-scoped EXISTS clause (guests with a reservation at their property).

-- -----------------------------------------------------------------------------
-- 1. Extend the role CHECK constraint with PENDING
-- -----------------------------------------------------------------------------
ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN (
    'SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING', 'YETKILI', 'PENDING'
  ));

-- -----------------------------------------------------------------------------
-- 2. New signups land as PENDING, not YETKILI.
--    (CREATE OR REPLACE — overwrites the migration 029 version.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO staff_profiles (user_id, full_name, role, property_id)
  VALUES (
    NEW.id,
    coalesce(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    'PENDING',
    NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. guests_select — drop YETKILI from the blanket clause.
--    SUPER_ADMIN: all. PROPERTY_MANAGER / RECEPTION: kept on the blanket
--    (pre-existing, vetted staff — out of scope here). Everyone else incl.
--    YETKILI: branch-scoped via the reservations EXISTS check.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS guests_select ON guests;
CREATE POLICY guests_select ON guests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.guest_id = guests.id
        AND r.property_id = auth_property_id()
    )
    OR auth_role() IN ('PROPERTY_MANAGER', 'RECEPTION')
  );
