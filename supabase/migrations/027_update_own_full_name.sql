-- =============================================================================
-- HomeGuru PMS — migration 027
-- Self-service profile name edit.
-- =============================================================================
-- Lets the logged-in user change ONLY their own staff_profiles.full_name.
-- Implemented as a SECURITY DEFINER RPC so we can:
--   • Update by auth.uid() without granting the user blanket UPDATE on the
--     table (which would let them change their own role / salary / branch).
--   • Keep the existing staff_profiles_modify RLS policy (SUPER_ADMIN only)
--     intact — admins still own all other column writes.

CREATE OR REPLACE FUNCTION update_own_full_name(p_full_name text)
RETURNS staff_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row staff_profiles;
  v_clean text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Oturum açık değil.';
  END IF;

  v_clean := trim(coalesce(p_full_name, ''));
  IF v_clean = '' THEN
    RAISE EXCEPTION 'Ad boş olamaz.';
  END IF;
  IF char_length(v_clean) > 120 THEN
    RAISE EXCEPTION 'Ad 120 karakteri geçemez.';
  END IF;

  UPDATE staff_profiles
     SET full_name = v_clean
   WHERE user_id = v_uid
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profil bulunamadı.';
  END IF;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION update_own_full_name(text) TO authenticated;

COMMENT ON FUNCTION update_own_full_name(text) IS
  'Self-update of staff_profiles.full_name. SECURITY DEFINER so the caller does not need direct UPDATE on staff_profiles (RLS still restricts everything else to SUPER_ADMIN).';
