-- =============================================================================
-- HomeGuru PMS — migration 045
-- Tarih Blokları (date blocks): hold a unit off the market for maintenance,
-- owner stay, deep-clean, or any other reason that isn't a paying guest.
-- =============================================================================
-- A block reserves a unit's calendar without a guest. Two enforcement paths:
--
--   1. Same-table: an EXCLUDE constraint on (unit_id, block_range) prevents
--      two blocks from overlapping each other — same pattern reservations use.
--
--   2. Cross-table: BEFORE INSERT/UPDATE triggers run in both directions —
--      a block can't overlap a non-cancelled reservation, and a reservation
--      can't overlap an existing block. PostgreSQL can't EXCLUDE across two
--      tables; triggers give the same guarantee with a Turkish error message.
--
-- Schema:
--   property_blocks(id, property_id, unit_id, block_start, block_end,
--                   block_range generated tstzrange, reason, created_by,
--                   created_at)
--
-- RLS:
--   SELECT: mirrors reservations_select via auth_sees_property(property_id).
--   ALL:    SUPER_ADMIN / PROPERTY_MANAGER / RECEPTION / YETKILI within scope.
-- =============================================================================

CREATE TABLE property_blocks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id      uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  block_start  timestamptz NOT NULL,
  block_end    timestamptz NOT NULL,
  block_range  tstzrange GENERATED ALWAYS AS (tstzrange(block_start, block_end, '[)')) STORED,
  reason       text,
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (block_end > block_start),
  -- Same crown-jewel pattern as reservations — a unit can't have two blocks
  -- overlapping each other.
  EXCLUDE USING gist (
    unit_id WITH =,
    block_range WITH &&
  )
);

CREATE INDEX property_blocks_property_idx ON property_blocks(property_id);
CREATE INDEX property_blocks_unit_range_idx
  ON property_blocks USING gist (unit_id, block_range);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE property_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_blocks_select ON property_blocks FOR SELECT
  USING (auth_sees_property(property_id));

CREATE POLICY property_blocks_modify ON property_blocks FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'YETKILI')
    AND auth_sees_property(property_id)
  );

-- -----------------------------------------------------------------------------
-- Cross-table overlap enforcement.
-- -----------------------------------------------------------------------------

-- A block can't overlap any non-cancelled reservation on the same unit.
CREATE OR REPLACE FUNCTION _block_check_reservation_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.unit_id = NEW.unit_id
      AND r.status != 'cancelled'
      AND r.stay && tstzrange(NEW.block_start, NEW.block_end, '[)')
  ) THEN
    RAISE EXCEPTION
      'Bu birim seçilen tarihler arasında bir rezervasyonla çakışıyor.'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_blocks_no_reservation_overlap
  BEFORE INSERT OR UPDATE ON property_blocks
  FOR EACH ROW EXECUTE FUNCTION _block_check_reservation_overlap();

-- A reservation can't overlap any existing block on the same unit. Cancelled
-- reservations are exempt (an operator should be able to cancel even if a
-- block was added on top of an existing stay).
CREATE OR REPLACE FUNCTION _reservation_check_block_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM property_blocks b
    WHERE b.unit_id = NEW.unit_id
      AND b.block_range && tstzrange(NEW.stay_start, NEW.stay_end, '[)')
  ) THEN
    RAISE EXCEPTION
      'Bu birim seçilen tarihler arasında bloklu — önce bloğu kaldırın.'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_no_block_overlap
  BEFORE INSERT OR UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION _reservation_check_block_overlap();
