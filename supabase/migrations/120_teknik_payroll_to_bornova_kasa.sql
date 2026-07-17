-- =============================================================================
-- HomeGuru PMS — migration 120
-- Teknik Personel's maaş + avans come out of the Bornova Kasası.
-- =============================================================================
-- Teknik Personel OPERATES across all regions (auth_region() = NULL + the
-- auth_sees_property bypass from migration 117), but its PAYROLL is a Bornova
-- expense: salary and advances should drop from the Bornova kasa, not the HQ
-- Genel Kasa. These are two different concepts —
--   auth_region()  → which region the user sees/works in   (NULL = all)
--   staff_region() → which region's kasa pays this staff   (bornova)
-- — so they legitimately diverge for this role. Migration 117 had set
-- staff_region(TEKNIK_PERSONEL) = NULL (→ Genel Kasa); flip it to 'bornova'.
--
-- The avans routing trigger and the salary-reroute trigger (migration 112) both
-- resolve the recipient's region through staff_region() → kasa_for_region(), so
-- this one function is the only change needed. Only affects payments made AFTER
-- this migration; any already-routed cash_transactions stay where they landed.
-- =============================================================================

CREATE OR REPLACE FUNCTION staff_region(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE
           WHEN role IN ('YONETICI_BORNOVA', 'PERSONEL_BORNOVA', 'TEKNIK_PERSONEL')
             THEN 'bornova'
           ELSE NULL
         END
  FROM staff_profiles WHERE user_id = p_user_id;
$$;
