-- =============================================================================
-- HomeGuru PMS — migration 066
-- Past (completed) reservations no longer block new ones.
-- =============================================================================
-- Migration 001 set the overlap-exclusion constraint to `WHERE status !=
-- 'cancelled'`, so completed stays kept reserving their tstzrange forever.
-- With day-use stays (migration 044) this means: book a 14:00–16:00 day-use
-- on May 26 → it auto-completes after 17:00 → user can't book an overnight
-- starting that same evening because the completed day-use range is still
-- in the EXCLUDE set.
--
-- Fix: drop the existing constraint and recreate it with `'cancelled'` AND
-- `'completed'` both excluded from the index. The semantics is "no two
-- ACTIVE / UPCOMING / PENDING stays may overlap on the same unit" — which
-- is what the operator actually means.
--
-- Safety: this loosens the constraint; it doesn't relax any existing
-- check. Active vs active overlap is still rejected. Completed vs anything
-- new is fine (the room WAS used during that range but is free now).
-- =============================================================================

-- The original constraint was created without an explicit name (migration
-- 001), so Postgres generated one. Find it dynamically and drop, then
-- recreate with an explicit name to make any future migration easy.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.reservations'::regclass
    AND contype = 'x'  -- exclusion
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE reservations DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (
    unit_id WITH =,
    stay WITH &&
  ) WHERE (status NOT IN ('cancelled', 'completed'));
