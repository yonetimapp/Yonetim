-- =============================================================================
-- HomeGuru PMS — migration 029
-- Auto-create a YETKILI staff_profiles row whenever a new auth user signs up.
-- =============================================================================
-- Combined with re-enabling self-signup in the Supabase dashboard, this means
-- a brand-new account immediately becomes a usable YETKILI user. They have NO
-- property_id by default — RLS will hide everything branch-scoped until a
-- SUPER_ADMIN assigns them to a property via the staff page.
--
-- Use CREATE OR REPLACE / DROP IF EXISTS so this is safe to re-run after the
-- earlier PROPERTY_MANAGER variant of the trigger (if it was applied).

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
    'YETKILI',
    NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
