-- =============================================================================
-- HomeGuru PMS — migration 026
-- Public unit gallery — backs the {katalog_link} built-in fallback.
-- =============================================================================
-- A SECURITY DEFINER RPC that returns the minimal public-safe shape for a
-- single unit (name, room_type, capacity, base_price, photo_paths) plus the
-- parent property (name, type, address). Bypasses RLS so unauthenticated
-- visitors landing on /g/u/<unit-id> can see the gallery without logging in.
--
-- Why an RPC instead of a permissive SELECT policy on units:
--   • RLS is row-level, not column-level. We don't want anon to read sensitive
--     columns we may add later (notes, internal flags, etc.). An RPC returns
--     exactly the fields we approve and nothing else — fail-closed by default.
--   • Storage URLs are already public via the unit-photos bucket; only the
--     "which paths belong to which unit" mapping needs unlocking.

CREATE OR REPLACE FUNCTION get_public_unit_gallery(p_unit_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT to_jsonb(t) FROM (
    SELECT
      u.id,
      u.name,
      u.room_type,
      u.capacity,
      u.base_price,
      u.photo_paths,
      p.id           AS property_id,
      p.name         AS property_name,
      p.type         AS property_type,
      p.address      AS property_address
    FROM units u
    JOIN properties p ON p.id = u.property_id
    WHERE u.id = p_unit_id
  ) t;
$$;

-- Grant to both anon (unauthenticated browsers landing on the public URL)
-- and authenticated (so staff testing the link also gets a result).
GRANT EXECUTE ON FUNCTION get_public_unit_gallery(uuid) TO anon, authenticated;

COMMENT ON FUNCTION get_public_unit_gallery(uuid) IS
  'Public-safe read for /g/u/<id>: returns name, type, capacity, base_price, photo_paths + parent property name/type/address. SECURITY DEFINER bypasses RLS by design.';
