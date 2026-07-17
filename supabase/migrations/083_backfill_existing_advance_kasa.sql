-- =============================================================================
-- HomeGuru PMS — migration 083
-- Bring EXISTING advances into the new model (reverses the 082 grandfather).
-- =============================================================================
-- Migration 082 grandfathered every pre-existing advance (settled_at = now(),
-- no kasa record) so the new system applied only to new advances. The operator
-- now wants those existing advances to ALSO:
--   * sit in the kasa as a gider (the cash already left the till), and
--   * be deducted from the upcoming salary (auto-netting).
--
-- A grandfathered advance is identifiable as: settled_at IS NOT NULL AND it has
-- NO kasa gider yet (a genuinely salary-settled advance always has its kasa OUT
-- from the 082 trigger). So:
--   1. Make those outstanding again (settled_at = NULL) → deducted from next maaş.
--   2. Backfill an approved kasa OUT for every advance still missing one.
-- This lowers the kasa balance by the total of those advances — intended; it
-- corrects the prior overstatement.
-- =============================================================================

-- 1. Un-grandfather: settled-but-not-in-kasa advances → outstanding again.
UPDATE staff_advances sa
SET settled_at = NULL
WHERE sa.settled_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM cash_transactions ct
    WHERE ct.ref_type = 'staff_advance' AND ct.ref_id = sa.id
  );

-- 2. Backfill an approved kasa gider for every advance that still lacks one.
--    Guarded on the general kasa existing so it's a no-op on an unseeded DB.
INSERT INTO cash_transactions (
  cash_account_id, amount, direction, description,
  ref_type, ref_id, created_by, approval_status
)
SELECT
  (SELECT id FROM cash_accounts WHERE property_id IS NULL LIMIT 1),
  sa.amount, 'OUT',
  'Avans: ' || COALESCE(sp.full_name, 'Personel'),
  'staff_advance', sa.id, sa.created_by, 'approved'
FROM staff_advances sa
LEFT JOIN staff_profiles sp ON sp.user_id = sa.user_id
WHERE NOT EXISTS (
    SELECT 1 FROM cash_transactions ct
    WHERE ct.ref_type = 'staff_advance' AND ct.ref_id = sa.id
  )
  AND EXISTS (SELECT 1 FROM cash_accounts WHERE property_id IS NULL);
