-- =============================================================================
-- HomeGuru PMS — migration 069
-- list_staff_directory(): a name-only directory any signed-in user can call.
-- =============================================================================
-- staff_profiles_select (migrations 003 + 033) only exposes a row to its
-- owner + SUPER_ADMIN + PROPERTY_MANAGER, so non-admin roles can't render
-- "Oluşturan: <name>" on reservations / giderler / kasa / sorun lists. This
-- adds a SECURITY DEFINER RPC that returns just (user_id, full_name) for
-- every non-deleted staff member — strictly less data than direct SELECT
-- on the full row.
-- =============================================================================

CREATE OR REPLACE FUNCTION list_staff_directory()
RETURNS TABLE(user_id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id, full_name
  FROM staff_profiles
  WHERE deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION list_staff_directory() TO authenticated;
