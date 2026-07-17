-- =============================================================================
-- HomeGuru PMS — migration 084
-- Date avans kasa rows by when the avans was GIVEN, not when they were inserted.
-- =============================================================================
-- Migration 083 backfilled a kasa gider for each existing avans but let
-- created_at default to now() (the moment the migration ran), so every
-- backfilled row shows the migration date (e.g. "10 Haz 13:32") instead of when
-- the avans was actually given. The same latent bug exists in the 082 trigger:
-- it never set created_at, so a future avans (especially a back-dated one) would
-- also land on its insert time rather than its given_at.
--
--   1. Re-date every avans kasa row to its advance's given_at.
--   2. Make the avans→kasa trigger stamp created_at = NEW.given_at.
-- given_at is the real economic date of the cash leaving the till, so this is
-- the correct date for the kasa movement, its ordering, and reports.
-- =============================================================================

-- 1. Align each avans kasa row with its advance's given_at.
UPDATE cash_transactions ct
SET created_at = sa.given_at
FROM staff_advances sa
WHERE ct.ref_type = 'staff_advance'
  AND ct.ref_id = sa.id;

-- 2. Date future avans kasa rows by the advance's given_at, not insert-time.
--    Body is identical to migration 082's trigger except the added created_at.
CREATE OR REPLACE FUNCTION _post_advance_to_kasa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  kasa_id    uuid;
  staff_name text;
  status     text := CASE WHEN auth_role() = 'SUPER_ADMIN' THEN 'approved' ELSE 'pending' END;
BEGIN
  -- restore_trash re-inserts the original row; its kasa OUT still exists, so
  -- don't post a second one.
  IF EXISTS (
    SELECT 1 FROM cash_transactions
    WHERE ref_type = 'staff_advance' AND ref_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO kasa_id FROM cash_accounts WHERE property_id IS NULL LIMIT 1;
  IF kasa_id IS NULL THEN
    RAISE NOTICE 'No general kasa configured; advance not posted to kasa.';
    RETURN NEW;
  END IF;

  SELECT full_name INTO staff_name FROM staff_profiles WHERE user_id = NEW.user_id;

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by, approval_status, created_at
  ) VALUES (
    kasa_id, NEW.amount, 'OUT',
    'Avans: ' || COALESCE(staff_name, 'Personel'),
    'staff_advance', NEW.id, NEW.created_by, status, NEW.given_at
  );
  RETURN NEW;
END;
$$;
