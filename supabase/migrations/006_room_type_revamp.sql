-- =============================================================================
-- HomeGuru PMS — Room type revamp migration 006
-- =============================================================================
-- Replaces generic ROOM/SUITE types with capacity-named hotel room types:
--   SINGLE  (Tek Kişilik)  → capacity 1
--   DOUBLE  (Çift Kişilik) → capacity 2
--   TRIPLE  (Üç Kişilik)   → capacity 3
--   QUAD    (Dört Kişilik) → capacity 4
-- Apartment types (1+0, 1+1, 2+1) are unchanged.
-- =============================================================================

-- 1. Drop the old CHECK constraint so we can update values first
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_room_type_check;

-- 2. Migrate existing ROOM/SUITE rows to new capacity-named types
UPDATE units
SET room_type = CASE
  WHEN capacity <= 1 THEN 'SINGLE'
  WHEN capacity = 2 THEN 'DOUBLE'
  WHEN capacity = 3 THEN 'TRIPLE'
  ELSE 'QUAD'
END
WHERE room_type IN ('ROOM', 'SUITE');

-- 3. Re-add the CHECK constraint with the new allowed values
ALTER TABLE units ADD CONSTRAINT units_room_type_check
  CHECK (room_type IN ('1+0', '1+1', '2+1', 'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD'));
