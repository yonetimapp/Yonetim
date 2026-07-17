-- =============================================================================
-- HomeGuru PMS — migration 118
-- Teknik Personel cannot flip cleaning status or create a payment collection.
-- =============================================================================
-- TEKNIK_PERSONEL normalises to HOUSEKEEPING (auth_role), and Housekeeping is
-- allowed to (a) change cleaning status and (b) collect payment in apartments.
-- Neither is part of the Teknik spec — it may ONLY report/resolve housekeeping
-- issues. Both are inherited side-effects; block them explicitly by RAW role
-- (auth_role() returns 'HOUSEKEEPING', so it can't distinguish the two).
--
-- Teknik still READS cleaning status (hk_tasks_select is unchanged) — it just
-- can't write it. After this, the only thing Teknik can write is housekeeping
-- issues, matching the spec exactly.
-- =============================================================================

-- 1. Cleaning status write — exclude Teknik from hk_tasks_modify. Verbatim from
--    migration 033 + the raw-role guard. hk_tasks_select stays open, so the
--    read-only status is still visible on the Temizlik panel (via the separate
--    SELECT policy, OR-ed with this one for reads).
DROP POLICY IF EXISTS hk_tasks_modify ON housekeeping_tasks;
CREATE POLICY hk_tasks_modify ON housekeeping_tasks FOR ALL
  USING (
    auth_sees_property(property_id)
    AND (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
          IS DISTINCT FROM 'TEKNIK_PERSONEL'
  )
  WITH CHECK (
    auth_sees_property(property_id)
    AND (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
          IS DISTINCT FROM 'TEKNIK_PERSONEL'
  );

-- 2. Payment collection — deny Teknik at INSERT on payment_collections. This
--    catches collect_payment (SECURITY DEFINER, which bypasses RLS) without
--    reproducing that long money function. auth.uid() is session-scoped, so it
--    still identifies the caller inside a DEFINER RPC. System / auto-debit inserts
--    run with auth.uid() = NULL and are unaffected.
CREATE OR REPLACE FUNCTION _deny_teknik_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT role FROM staff_profiles WHERE user_id = auth.uid() AND deleted_at IS NULL)
       = 'TEKNIK_PERSONEL' THEN
    RAISE EXCEPTION 'Teknik personel tahsilat oluşturamaz' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_collections_deny_teknik ON payment_collections;
CREATE TRIGGER payment_collections_deny_teknik
  BEFORE INSERT ON payment_collections
  FOR EACH ROW EXECUTE FUNCTION _deny_teknik_payment();
