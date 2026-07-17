-- =============================================================================
-- HomeGuru PMS — migration 058
-- Per-reservation late-checkout offset (default checkout 11:00 Istanbul).
-- =============================================================================
-- Overnight stays don't carry a checkout hour in stay_end (it's stored at
-- midnight UTC — see ReservationFormPage). The app now treats 11:00
-- Istanbul as the standard checkout, with a per-reservation +0/+1/+2/+3
-- hour late-checkout option for guests who ask for extra time.
--
-- The column is just an offset; the front-end renders the actual label
-- (11:00 / 12:00 / 13:00 / 14:00). Keeping it numeric makes future tweaks
-- to the base hour a one-line change instead of a data migration.
-- =============================================================================

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS late_checkout_hours smallint NOT NULL DEFAULT 0
  CHECK (late_checkout_hours BETWEEN 0 AND 4);
