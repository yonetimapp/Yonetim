-- =============================================================================
-- HomeGuru PMS — migration 108  (ONE-TIME DATA FIX, self-backed-up)
-- Merge the "one mülk per oda" mistake into two proper Bina mülkler.
-- =============================================================================
--   Group A (APARTMENT)  -> new Bina "Daireler" (Ana Grup): No.1..No.6,No.9,No.10
--   Group B (HOTEL)      -> new Bina "Binalar"  (Ana Grup): B1..B11
--   Each oda's birim is renamed to its old mülk name (suffix dropped); every
--   reference (rezervasyon, tahsilat, gider[+düzenli], temizlik, blok, fiyat,
--   kasa, çöp) is re-pointed; the 19 emptied mülkler + empty "test" are deleted.
--
-- NO Pro / no PITR — so PART 1 snapshots everything this touches into _bak108_*
-- tables. If anything looks wrong afterwards, the REVERSE block at the very
-- bottom (commented out) restores the exact prior state from those snapshots.
-- Safe: constraints are keyed on unit_id (unchanged); PART 2 is one transaction
-- with a guard that rolls back if any source still has a reference. Idempotent.
-- After you've verified the result, drop the _bak108_* tables.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PART 1 — BACKUP. Uses CREATE TABLE IF NOT EXISTS so a re-run NEVER overwrites
-- an existing snapshot (your undo path), and a fresh DB just gets empty backups
-- + a no-op merge in PART 2. To take a fresh snapshot, drop the _bak108_* first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _bak108_src (id uuid PRIMARY KEY, grp char(1));
INSERT INTO _bak108_src (id, grp) VALUES
  ('493cf581-e89a-4143-8463-f8152436ed03','A'), -- No.1
  ('9b7e153e-f6aa-4457-9750-19d82d6d978c','A'), -- No.2
  ('f8f0212f-1f2d-4fb9-9dba-84e16d3de549','A'), -- No.3
  ('722946d0-96d0-42ed-a995-b2d0fe533958','A'), -- No.4
  ('6a85e4a6-f1d7-4b2a-b9d9-7f51055a3e54','A'), -- No.5
  ('7fd4dccc-b994-445b-9bd7-a18f2afce1d5','A'), -- No.6
  ('94784ad2-74b8-4410-a5c9-a4cd272ca64a','A'), -- No.9
  ('d2104367-f78f-4583-abad-20a943f21162','A'), -- No.10
  ('51a28b9f-3e12-47d2-ba89-54beec4474d9','B'), -- B1
  ('76199661-c069-4b97-9327-a23ef21f67a1','B'), -- B2
  ('0f395880-4b7d-46d6-8741-f99a6136590d','B'), -- B3
  ('0b1412f2-362d-4130-9536-c6a701589f66','B'), -- B4
  ('038da10f-f4c5-4850-a1d2-15ab6c1390c1','B'), -- B5
  ('56298566-51a6-40db-a8a0-db0237987c92','B'), -- B6
  ('e7719610-f031-43dc-85ae-9701a7951420','B'), -- B7
  ('6d3fc89e-3fa3-45a5-9dc7-1dbb84b32d8c','B'), -- B8
  ('7a2df203-5e57-4e1b-88e2-537da2a1cbcf','B'), -- B9
  ('db2fbf01-b649-4052-9751-39e989df8ce0','B'), -- B10
  ('09f2a741-2f4b-4d44-b4bf-663305a54ab0','B') -- B11
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS _bak108_properties AS
  SELECT * FROM properties
  WHERE id IN (SELECT id FROM _bak108_src)
     OR id = 'cf5d91e8-c2b0-4b11-bb8a-eff3e038610f';  -- + empty "test"

CREATE TABLE IF NOT EXISTS _bak108_units AS
  SELECT id, property_id AS old_property_id, name AS old_name
  FROM units WHERE property_id IN (SELECT id FROM _bak108_src);

CREATE TABLE IF NOT EXISTS _bak108_refs AS
  SELECT 'reservations'::text AS tbl, id, property_id AS old_pid FROM reservations                 WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'expenses',                 id, property_id FROM expenses                        WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'payment_collections',      id, property_id FROM payment_collections             WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'housekeeping_tasks',       id, property_id FROM housekeeping_tasks              WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'housekeeping_issues',      id, property_id FROM housekeeping_issues             WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'property_blocks',          id, property_id FROM property_blocks                 WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'property_date_notes',      id, property_id FROM property_date_notes             WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'property_nightly_prices',  id, property_id FROM property_nightly_prices         WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'cash_transactions',        id, property_id FROM cash_transactions              WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'cash_accounts',            id, property_id FROM cash_accounts                   WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'staff_profiles',           user_id, property_id FROM staff_profiles            WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'reservation_deletion_requests', id, property_id FROM reservation_deletion_requests WHERE property_id IN (SELECT id FROM _bak108_src)
  UNION ALL SELECT 'trash_entries',            id, branch_id   FROM trash_entries                   WHERE branch_id   IN (SELECT id FROM _bak108_src);

CREATE TABLE IF NOT EXISTS _bak108_targets (name text PRIMARY KEY, id uuid);  -- filled by PART 2

-- ---------------------------------------------------------------------------
-- PART 2 — MERGE (atomic; rolls back entirely on any guard failure).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  _dai uuid;  -- "Daireler"
  _bin uuid;  -- "Binalar"
  _left int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM properties WHERE id IN (SELECT id FROM _bak108_src)) THEN
    RAISE NOTICE 'Kaynak mülkler yok — birleştirme zaten yapılmış, atlanıyor.';
    RETURN;
  END IF;

  INSERT INTO properties (name, type, region) VALUES ('Daireler', 'HOTEL', NULL) RETURNING id INTO _dai;
  INSERT INTO properties (name, type, region) VALUES ('Binalar', 'HOTEL', NULL) RETURNING id INTO _bin;
  INSERT INTO _bak108_targets VALUES ('Daireler', _dai), ('Binalar', _bin);

  -- Rename each oda's birim to its OLD mülk name (drop suffixes), pre-reparent.
  UPDATE units u SET name = p.name FROM properties p
   WHERE u.property_id = p.id AND u.property_id IN (SELECT id FROM _bak108_src);

  -- Re-parent birims, then re-point every reference. unit_id never changes.
  UPDATE units                          SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE reservations                   SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE expenses                       SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE payment_collections            SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE housekeeping_tasks             SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE housekeeping_issues            SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE property_blocks                SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE property_date_notes            SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE property_nightly_prices        SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE cash_transactions              SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE cash_accounts                  SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE staff_profiles                 SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE reservation_deletion_requests  SET property_id = CASE WHEN property_id IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE property_id IN (SELECT id FROM _bak108_src);
  UPDATE trash_entries                  SET branch_id   = CASE WHEN branch_id   IN (SELECT id FROM _bak108_src WHERE grp='A') THEN _dai ELSE _bin END WHERE branch_id   IN (SELECT id FROM _bak108_src);

  -- Guard: abort+rollback if ANYTHING still points at a source.
  SELECT
      (SELECT count(*) FROM units                         WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM reservations                  WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM expenses                      WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM payment_collections           WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM housekeeping_tasks            WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM housekeeping_issues           WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM property_blocks               WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM property_date_notes           WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM property_nightly_prices       WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM cash_transactions             WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM cash_accounts                 WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM staff_profiles                WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM reservation_deletion_requests WHERE property_id IN (SELECT id FROM _bak108_src))
    + (SELECT count(*) FROM trash_entries                 WHERE branch_id   IN (SELECT id FROM _bak108_src))
    INTO _left;
  IF _left > 0 THEN
    RAISE EXCEPTION 'Taşınmamış % referans kaldı — silme iptal, her şey geri alındı.', _left;
  END IF;

  DELETE FROM properties WHERE id IN (SELECT id FROM _bak108_src);
  DELETE FROM properties WHERE id = 'cf5d91e8-c2b0-4b11-bb8a-eff3e038610f';  -- empty "test"

  RAISE NOTICE 'Birleştirme tamam. Daireler=%  Binalar=%', _dai, _bin;
END $$;

-- =============================================================================
-- REVERSE — run ONLY if you need to undo (before dropping the _bak108_* tables).
-- Uncomment the whole block and run it.
-- =============================================================================
-- DO $$
-- BEGIN
--   -- 1. recreate the deleted source mülkler (+ test) with their original ids
--   INSERT INTO properties SELECT * FROM _bak108_properties
--     ON CONFLICT (id) DO NOTHING;
--   -- 2. restore birims (old parent + old name)
--   UPDATE units u SET property_id = b.old_property_id, name = b.old_name
--     FROM _bak108_units b WHERE u.id = b.id;
--   -- 3. restore every reference to its old property
--   UPDATE reservations                  t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='reservations'                  AND t.id = b.id;
--   UPDATE expenses                      t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='expenses'                      AND t.id = b.id;
--   UPDATE payment_collections           t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='payment_collections'           AND t.id = b.id;
--   UPDATE housekeeping_tasks            t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='housekeeping_tasks'            AND t.id = b.id;
--   UPDATE housekeeping_issues           t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='housekeeping_issues'           AND t.id = b.id;
--   UPDATE property_blocks               t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='property_blocks'               AND t.id = b.id;
--   UPDATE property_date_notes           t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='property_date_notes'           AND t.id = b.id;
--   UPDATE property_nightly_prices       t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='property_nightly_prices'       AND t.id = b.id;
--   UPDATE cash_transactions             t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='cash_transactions'             AND t.id = b.id;
--   UPDATE cash_accounts                 t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='cash_accounts'                 AND t.id = b.id;
--   UPDATE staff_profiles                t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='staff_profiles'                AND t.user_id = b.id;
--   UPDATE reservation_deletion_requests t SET property_id = b.old_pid FROM _bak108_refs b WHERE b.tbl='reservation_deletion_requests' AND t.id = b.id;
--   UPDATE trash_entries                 t SET branch_id   = b.old_pid FROM _bak108_refs b WHERE b.tbl='trash_entries'                 AND t.id = b.id;
--   -- 4. remove the two merged Binalar (now empty again)
--   DELETE FROM properties WHERE id IN (SELECT id FROM _bak108_targets);
-- END $$;
