-- =============================================================================
-- HomeGuru PMS — migration 089
-- Free-text note on a reservation (operator-entered at creation / edit).
-- =============================================================================
-- Lets staff attach a note to a reservation ("Not Ekle") when creating or
-- editing it, and read it back on the Rezervasyonlar list. Nullable free text;
-- no special handling — covered by the existing reservations RLS (the note is
-- just another column on a row the caller is already allowed to write).
-- =============================================================================

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN reservations.note IS
  'Operator free-text note for this reservation (e.g. late check-in, special request). Nullable.';
