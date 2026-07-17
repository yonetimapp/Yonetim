-- =============================================================================
-- HomeGuru PMS — migration 021
-- Central "Çöp Kutusu" (trash bin) for recoverable deletes.
-- =============================================================================
-- Adds:
--   • trash_entries — central JSONB snapshot table
--   • soft_delete_entity(type, id) — snapshots row, deletes original, trims trash
--   • restore_trash(trash_id) — re-inserts row into its original table
--   • _trash_trim(type, branch) — keeps newest 15 entries per (type, branch)
--
-- Supported entity types (everything else keeps hard-delete):
--   housekeeping_issues, reservations, cash_transactions, ledger_entries,
--   expenses, staff_advances, message_templates, units
--
-- Excluded (cascade-heavy or encryption-sensitive; revisit later):
--   properties, guests, cash_accounts, payment_collections
--
-- Visibility:
--   Only SUPER_ADMIN can view, restore, or permanently delete trash entries.
--   Lower roles can still trigger soft_delete through the normal Sil UI; their
--   deleted rows simply sit in trash invisibly until an admin acts on them.

-- -----------------------------------------------------------------------------
-- Trash table
-- -----------------------------------------------------------------------------
CREATE TABLE trash_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  entity_label text,                                   -- short human-readable
  branch_id    uuid REFERENCES properties(id) ON DELETE SET NULL,
  payload      jsonb NOT NULL,
  deleted_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trash_entries_type_deleted_idx
  ON trash_entries(entity_type, deleted_at DESC);
CREATE INDEX trash_entries_branch_idx
  ON trash_entries(branch_id);

ALTER TABLE trash_entries ENABLE ROW LEVEL SECURITY;

-- SUPER_ADMIN can read, delete (= permanent delete from trash).
-- INSERT is gated to the caller writing their own deleted_by — used by
-- soft_delete_entity RPC running as the invoker.
CREATE POLICY trash_select ON trash_entries FOR SELECT
  USING (auth_role() = 'SUPER_ADMIN');

CREATE POLICY trash_delete ON trash_entries FOR DELETE
  USING (auth_role() = 'SUPER_ADMIN');

CREATE POLICY trash_insert ON trash_entries FOR INSERT
  WITH CHECK (deleted_by = auth.uid());

-- -----------------------------------------------------------------------------
-- Helper: trim trash to newest 15 per (entity_type, branch_id).
-- SECURITY DEFINER so non-admin callers (whose own soft_delete just pushed
-- the count over the limit) can still cause the trim. Branch scoping prevents
-- cross-branch interference.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _trash_trim(p_type text, p_branch uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM trash_entries
  WHERE id IN (
    SELECT id FROM trash_entries
    WHERE entity_type = p_type
      AND branch_id IS NOT DISTINCT FROM p_branch
    ORDER BY deleted_at DESC
    OFFSET 15
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- soft_delete_entity: the single funnel for all "deletable with trash" entities.
-- Runs as INVOKER so the caller's RLS on the original table decides whether
-- the DELETE succeeds — we don't reinvent permission rules. The trash INSERT
-- is permitted by trash_insert policy as long as deleted_by = auth.uid().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soft_delete_entity(p_type text, p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
  v_branch  uuid;
  v_label   text;
  v_trash_id uuid;
  v_deleted int;
BEGIN
  -- Snapshot + derive branch + a short human-readable label.
  -- SELECTs run under caller RLS, so an invisible row produces v_payload IS NULL.
  CASE p_type
    WHEN 'housekeeping_issues' THEN
      SELECT to_jsonb(t),
             t.property_id,
             left(t.description, 80)
        INTO v_payload, v_branch, v_label
        FROM housekeeping_issues t
        WHERE t.id = p_id;

    WHEN 'reservations' THEN
      SELECT to_jsonb(t) - 'stay',                       -- strip generated col
             t.property_id,
             to_char(t.stay_start, 'YYYY-MM-DD') || ' — ' || COALESCE(g.full_name, '?')
        INTO v_payload, v_branch, v_label
        FROM reservations t
        LEFT JOIN guests g ON g.id = t.guest_id
        WHERE t.id = p_id;

    WHEN 'cash_transactions' THEN
      SELECT to_jsonb(t),
             a.property_id,
             t.direction || ' ' || t.amount::text || COALESCE(' — ' || t.description, '')
        INTO v_payload, v_branch, v_label
        FROM cash_transactions t
        JOIN cash_accounts a ON a.id = t.cash_account_id
        WHERE t.id = p_id;

    WHEN 'ledger_entries' THEN
      SELECT to_jsonb(t),
             (SELECT property_id FROM reservations WHERE id = t.reservation_id),
             t.type || ' ' || t.amount::text || COALESCE(' — ' || t.note, '')
        INTO v_payload, v_branch, v_label
        FROM ledger_entries t
        WHERE t.id = p_id;

    WHEN 'expenses' THEN
      SELECT to_jsonb(t),
             t.property_id,
             t.category || ' — ' || t.amount::text
        INTO v_payload, v_branch, v_label
        FROM expenses t
        WHERE t.id = p_id;

    WHEN 'message_templates' THEN
      SELECT to_jsonb(t),
             NULL::uuid,                                   -- templates are global
             t.name
        INTO v_payload, v_branch, v_label
        FROM message_templates t
        WHERE t.id = p_id;

    WHEN 'staff_advances' THEN
      SELECT to_jsonb(t),
             (SELECT property_id FROM staff_profiles WHERE user_id = t.user_id),
             t.amount::text || COALESCE(' — ' || t.note, '')
        INTO v_payload, v_branch, v_label
        FROM staff_advances t
        WHERE t.id = p_id;

    WHEN 'units' THEN
      SELECT to_jsonb(t),
             t.property_id,
             t.name
        INTO v_payload, v_branch, v_label
        FROM units t
        WHERE t.id = p_id;

    ELSE
      RAISE EXCEPTION 'Trash bin does not support entity type: %', p_type;
  END CASE;

  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Kayıt bulunamadı veya görme yetkiniz yok.';
  END IF;

  -- Insert trash entry. Permissive INSERT policy gates by deleted_by.
  INSERT INTO trash_entries (entity_type, entity_id, entity_label, branch_id, payload, deleted_by)
  VALUES (p_type, p_id, v_label, v_branch, v_payload, auth.uid())
  RETURNING id INTO v_trash_id;

  -- Delete the original. RLS on each table governs whether this actually
  -- removes the row — if not, we roll back the trash insert.
  CASE p_type
    WHEN 'housekeeping_issues' THEN DELETE FROM housekeeping_issues WHERE id = p_id;
    WHEN 'reservations'        THEN DELETE FROM reservations        WHERE id = p_id;
    WHEN 'cash_transactions'   THEN DELETE FROM cash_transactions   WHERE id = p_id;
    WHEN 'ledger_entries'      THEN DELETE FROM ledger_entries      WHERE id = p_id;
    WHEN 'expenses'            THEN DELETE FROM expenses            WHERE id = p_id;
    WHEN 'message_templates'   THEN DELETE FROM message_templates   WHERE id = p_id;
    WHEN 'staff_advances'      THEN DELETE FROM staff_advances      WHERE id = p_id;
    WHEN 'units'               THEN DELETE FROM units               WHERE id = p_id;
  END CASE;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    DELETE FROM trash_entries WHERE id = v_trash_id;
    RAISE EXCEPTION 'Silme yetkisi yok ya da kayıt zaten silinmiş.';
  END IF;

  -- Trim to newest 15 per (type, branch). SECURITY DEFINER helper.
  PERFORM _trash_trim(p_type, v_branch);

  RETURN v_trash_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- restore_trash: re-insert the row into its original table, then remove from
-- trash. RLS on trash_entries already gates this to SUPER_ADMIN — non-admin
-- callers can't even read the row to restore.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION restore_trash(p_trash_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec trash_entries%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM trash_entries WHERE id = p_trash_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Çöp kaydı bulunamadı veya erişim yok.';
  END IF;

  CASE rec.entity_type
    WHEN 'housekeeping_issues' THEN
      INSERT INTO housekeeping_issues
      SELECT * FROM jsonb_populate_record(NULL::housekeeping_issues, rec.payload);

    WHEN 'reservations' THEN
      -- Explicit columns to skip generated `stay`.
      INSERT INTO reservations
        (id, property_id, unit_id, guest_id, stay_start, stay_end,
         status, total_amount, deposit, auto_debit, created_by, created_at)
      SELECT id, property_id, unit_id, guest_id, stay_start, stay_end,
             status, total_amount, deposit, auto_debit, created_by, created_at
      FROM jsonb_populate_record(NULL::reservations, rec.payload);

    WHEN 'cash_transactions' THEN
      INSERT INTO cash_transactions
      SELECT * FROM jsonb_populate_record(NULL::cash_transactions, rec.payload);

    WHEN 'ledger_entries' THEN
      INSERT INTO ledger_entries
      SELECT * FROM jsonb_populate_record(NULL::ledger_entries, rec.payload);

    WHEN 'expenses' THEN
      INSERT INTO expenses
      SELECT * FROM jsonb_populate_record(NULL::expenses, rec.payload);

    WHEN 'message_templates' THEN
      INSERT INTO message_templates
      SELECT * FROM jsonb_populate_record(NULL::message_templates, rec.payload);

    WHEN 'staff_advances' THEN
      INSERT INTO staff_advances
      SELECT * FROM jsonb_populate_record(NULL::staff_advances, rec.payload);

    WHEN 'units' THEN
      INSERT INTO units
      SELECT * FROM jsonb_populate_record(NULL::units, rec.payload);

    ELSE
      RAISE EXCEPTION 'Unknown entity type: %', rec.entity_type;
  END CASE;

  DELETE FROM trash_entries WHERE id = p_trash_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants (PostgREST exposes everything in `public`; explicit EXECUTE for clarity)
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION soft_delete_entity(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION restore_trash(uuid)             TO authenticated;
-- _trash_trim is an internal helper, no direct grant
