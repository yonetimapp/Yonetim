-- =============================================================================
-- HomeGuru PMS — migration 046
-- Per-date notes: short operations notes attached to (unit, date) pairs.
-- =============================================================================
-- "Note B1 needs deep clean on 2026-06-15", "klima servisi geliyor", etc. One
-- note per (unit, date). Housekeeping reads these from the calendar before a
-- shift; reception writes them while taking a phone call.
--
-- Why per-unit (not per-property): in this PMS each apartment building has one
-- unit, but the hotel has many rooms. Per-unit gives the housekeeper exactly
-- the granularity they need. A "this whole building is closed" intent should
-- go through Tarihi Blokla (migration 045), not a sticky note.
-- =============================================================================

CREATE TABLE property_date_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  note_date   date NOT NULL,
  note        text NOT NULL CHECK (length(btrim(note)) > 0),
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, note_date)
);

CREATE INDEX property_date_notes_property_idx ON property_date_notes(property_id);
CREATE INDEX property_date_notes_date_idx ON property_date_notes(note_date);

-- Auto-bump updated_at on every UPDATE so the calendar can sort "recently
-- changed" notes if it ever needs to.
CREATE OR REPLACE FUNCTION _property_date_notes_touch_updated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_date_notes_touch
  BEFORE UPDATE ON property_date_notes
  FOR EACH ROW EXECUTE FUNCTION _property_date_notes_touch_updated();

-- -----------------------------------------------------------------------------
-- RLS — housekeeping CAN write these (it's their primary use case).
-- -----------------------------------------------------------------------------
ALTER TABLE property_date_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_date_notes_select ON property_date_notes FOR SELECT
  USING (auth_sees_property(property_id));

CREATE POLICY property_date_notes_modify ON property_date_notes FOR ALL
  USING (
    auth_role() IN (
      'SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI', 'HOUSEKEEPING'
    )
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN (
      'SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI', 'HOUSEKEEPING'
    )
    AND auth_sees_property(property_id)
  );
