-- =============================================================================
-- HomeGuru PMS — migration 123
-- Birim silme: rezervasyon bağını kopar (delete_property'nin birim düzeyi eşi).
-- =============================================================================
-- Bug: deleting a birim from Mülk Detay failed with a raw FK error —
--   update or delete on table "units" violates foreign key constraint
--   "reservations_unit_id_fkey" on table "reservations" (23503)
-- because soft_delete_entity's units branch does a bare DELETE while
-- reservations.unit_id is ON DELETE RESTRICT (by design: reservation/financial
-- history must never silently cascade away).
--
-- Fix: mirror delete_property's "bağı kopar" behaviour (migration 079) at the
-- unit level. Deleting a birim now:
--   * refuses while the birim has an ACTIVE reservation (same guard/message
--     as delete_property — never cut a live stay loose from its room);
--   * orphans its reservations: the row is KEPT, unit_id is set NULL and the
--     birim's name is snapshotted into deleted_unit_name (column added by 079;
--     the UI already falls back to it — reservations.ts unitDisplayName);
--     property_id is untouched, the mülk still exists;
--   * then deletes the unit. Remaining referents behave as before: blocks /
--     date-notes / nightly-prices / housekeeping CASCADE (meaningless without
--     the birim), expenses.unit_id SET NULL (gider keeps its mülk).
--
-- The tie-break is IRREVERSIBLE, exactly like delete_property: restoring the
-- birim from Çöp Kutusu re-creates the unit row but does NOT re-attach the
-- orphaned reservations. (Likewise, a reservation already sitting in the trash
-- keeps the old unit_id in its payload; restoring it after the birim is gone
-- fails on the FK — pre-existing behaviour, unchanged.)
--
-- Trigger safety of the orphaning UPDATE — identical to 079's verified list
-- (same UPDATE shape, sets reservations.unit_id NULL):
--   * reservations_no_block_overlap    — passes (NULL unit matches no block)
--   * exclusion constraint (unit_id =) — NULL never conflicts
--   * google push / notification triggers — fire-and-forget, cannot roll back
--
-- Everything outside the units branch is byte-identical to the deployed
-- definition (migration 062).
-- =============================================================================

CREATE OR REPLACE FUNCTION soft_delete_entity(p_type text, p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload  jsonb;
  v_branch   uuid;
  v_label    text;
  v_trash_id uuid;
  v_pc_id    uuid;
BEGIN
  CASE p_type
    WHEN 'housekeeping_issues' THEN
      SELECT to_jsonb(t),
             t.property_id,
             COALESCE(left(t.description, 80), '(boş)')
        INTO v_payload, v_branch, v_label
        FROM housekeeping_issues t
        WHERE t.id = p_id;

    WHEN 'reservations' THEN
      SELECT to_jsonb(t),
             t.property_id,
             COALESCE(g.full_name, 'Misafir') ||
               ' · ' || to_char(t.stay_start, 'YYYY-MM-DD') ||
               '→' || to_char(t.stay_end, 'YYYY-MM-DD')
        INTO v_payload, v_branch, v_label
        FROM reservations t
        LEFT JOIN guests g ON g.id = t.guest_id
        WHERE t.id = p_id;

    WHEN 'cash_transactions' THEN
      SELECT to_jsonb(t),
             a.property_id,
             t.direction || ' ' || t.amount::text || COALESCE(' — ' || t.description, ''),
             t.payment_collection_id
        INTO v_payload, v_branch, v_label, v_pc_id
        FROM cash_transactions t
        JOIN cash_accounts a ON a.id = t.cash_account_id
        WHERE t.id = p_id;
      IF v_pc_id IS NOT NULL THEN
        RAISE EXCEPTION
          'Bu kasa hareketi misafir tahsilatından gelir. Önce tahsilatı (Rezervasyon → ledger) silin; kasa hareketi otomatik temizlenir.';
      END IF;

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
             NULL::uuid,
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

  INSERT INTO trash_entries (entity_type, entity_id, entity_label, branch_id, payload, deleted_by)
  VALUES (p_type, p_id, v_label, v_branch, v_payload, auth.uid())
  RETURNING id INTO v_trash_id;

  CASE p_type
    WHEN 'housekeeping_issues' THEN DELETE FROM housekeeping_issues WHERE id = p_id;
    WHEN 'reservations'        THEN DELETE FROM reservations        WHERE id = p_id;
    WHEN 'cash_transactions'   THEN DELETE FROM cash_transactions   WHERE id = p_id;
    WHEN 'ledger_entries'      THEN DELETE FROM ledger_entries      WHERE id = p_id;
    WHEN 'expenses'            THEN DELETE FROM expenses            WHERE id = p_id;
    WHEN 'message_templates'   THEN DELETE FROM message_templates   WHERE id = p_id;
    WHEN 'staff_advances'      THEN DELETE FROM staff_advances      WHERE id = p_id;

    WHEN 'units' THEN
      -- Same live-stay guard as delete_property: orphaning would technically
      -- work, but silently cutting an ongoing konaklama loose from its room
      -- is a mistake — block and let the operator finish it first.
      IF EXISTS (
        SELECT 1 FROM reservations
        WHERE unit_id = p_id AND status = 'active'
      ) THEN
        RAISE EXCEPTION 'Aktif (devam eden) rezervasyonu olan birim silinemez. Önce mevcut konaklamayı tamamlayın.'
          USING ERRCODE = 'check_violation';
      END IF;

      -- Orphan the reservations: keep the row, snapshot the birim's name
      -- (v_label, captured above), break only the unit tie. The mülk tie
      -- stays — the property still exists.
      UPDATE reservations SET
        deleted_unit_name = v_label,
        unit_id           = NULL
      WHERE unit_id = p_id;

      DELETE FROM units WHERE id = p_id;
  END CASE;

  RETURN v_trash_id;
END;
$$;
