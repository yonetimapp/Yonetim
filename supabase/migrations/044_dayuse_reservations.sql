-- =============================================================================
-- HomeGuru PMS — migration 044
-- Günübirlik (day-use) reservations: short same-day stays, typically 2-4 hours.
-- =============================================================================
-- A reservation can now be marked as a day-use stay rather than an overnight
-- one. Day-use stays have explicit start/end times on the same date (e.g.
-- 14:00 → 17:00) and live alongside overnight stays in the same table.
--
-- We deliberately KEEP the existing tstzrange + EXCLUDE constraint untouched —
-- it already operates with hour precision (because stay is generated from
-- timestamptz columns), so a day-use 14:00-17:00 will correctly block an
-- overnight stay that covers the same date, and vice versa. The new column
-- is purely operational metadata (UI rendering, badges, KBS handling later).
--
-- Schema:
--   reservations.stay_type text NOT NULL DEFAULT 'OVERNIGHT'
--     CHECK (stay_type IN ('OVERNIGHT', 'DAYUSE'))
--
-- Backfill: every existing row gets OVERNIGHT (the DEFAULT), so no data
-- migration is needed.
-- =============================================================================

ALTER TABLE reservations
  ADD COLUMN stay_type text NOT NULL DEFAULT 'OVERNIGHT'
    CHECK (stay_type IN ('OVERNIGHT', 'DAYUSE'));

-- Cheap filter for the housekeeping / list views that segregate day-use stays.
CREATE INDEX reservations_stay_type_idx ON reservations(stay_type);

COMMENT ON COLUMN reservations.stay_type IS
  'OVERNIGHT (default) — multi-night stay with midnight-aligned check-in/out. '
  'DAYUSE — same-day short stay, 2-4 hours, with explicit start/end times. '
  'The EXCLUDE constraint on (unit_id, stay) handles overlap detection for '
  'both types because the underlying tstzrange has hour precision.';
