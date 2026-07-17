-- =============================================================================
-- Yönetim PMS — migration 136
-- Bölge silme: yalnızca kasa hareketi engeller; mülk bağı koparılır.
-- =============================================================================
-- Owner request (2026-07-18). The old delete_region (125/131) refused deletion
-- whenever the region still held mülk or gider rows, which made any region that
-- was ever USED effectively undeletable. New rule:
--
--   * KASA HAREKETİ is the one hard financial blocker — money once moved in a
--     region's kasa, so the region (and its kasa) must stay for the books.
--   * MÜLKLER no longer block: deleting the region breaks their tie and parks
--     them on the DEFAULT region. properties.region is deliberately NOT NULL
--     (a NULL region would crash gider creation via set_expense_region and hide
--     the mülk from region-scoped staff), so "unassigned" is represented as
--     "on the default region, awaiting a re-pick". The RPC returns the moved
--     mülk names so the UI can tell the Yönetici exactly which ones to revisit.
--   * GİDER rows in the region move with the mülks (the FK would block the
--     delete otherwise). Safe by construction: the kasa-movement guard above
--     guarantees none of these ever touched the kasa — they are pending,
--     rejected, or "kasadan ödenmedi" informational records, and their mülk is
--     moving to the default region anyway, so the labels stay consistent.
--   * AKTİF PERSONEL still blocks, deliberately: a staffer's home region
--     decides which kasa pays their maaş/avans, so silently re-homing them is
--     exactly the kind of money rerouting that must stay a human decision.
--   * The DEFAULT region still can never be deleted.
--
-- Return type changes void → text[] (the moved mülk names), hence DROP + CREATE.
-- The pre-136 frontend ignores the return value, so either deploy order is safe.
-- =============================================================================

DROP FUNCTION IF EXISTS delete_region(uuid);

CREATE FUNCTION delete_region(p_id uuid)
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _name         text;
  _is_default   boolean;
  _default_name text;
  _moved        text[];
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici bölge silebilir' USING ERRCODE = '42501';
  END IF;

  SELECT name, is_default INTO _name, _is_default FROM regions WHERE id = p_id;
  IF _name IS NULL THEN RAISE EXCEPTION 'Bölge bulunamadı'; END IF;
  IF _is_default THEN RAISE EXCEPTION 'Varsayılan bölge silinemez'; END IF;

  -- The one financial blocker. Checked before ANY mutation below.
  IF EXISTS (
    SELECT 1 FROM cash_transactions ct
    JOIN cash_accounts ca ON ca.id = ct.cash_account_id
    WHERE ca.region = _name
  ) THEN
    RAISE EXCEPTION 'Kasa hareketi olan bölge silinemez';
  END IF;

  -- Active staff keep blocking: their home region routes maaş/avans money.
  IF EXISTS (
    SELECT 1 FROM staff_profiles WHERE region = _name AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Bu bölgeye atanmış personel var; önce personeli başka bölgeye taşıyın';
  END IF;

  _default_name := (SELECT name FROM regions WHERE is_default LIMIT 1);
  IF _default_name IS NULL THEN
    RAISE EXCEPTION 'Varsayılan bölge bulunamadı';
  END IF;

  -- Break the mülk ties: park them on the default region and report which ones,
  -- so the Yönetici re-picks each mülk's bölge from the Mülk Düzenle screen.
  WITH moved AS (
    UPDATE properties SET region = _default_name
     WHERE region = _name
    RETURNING name
  )
  SELECT COALESCE(array_agg(name ORDER BY name), '{}') INTO _moved FROM moved;

  -- Gider rows follow their (moved) mülks / the region label; see header for
  -- why this is safe. set_expense_region re-derives the mülk rows to the same
  -- default value; none of the other expense triggers fire on a region-only
  -- update (sync_kasa's WHEN watches amount/category/description/property_id).
  UPDATE expenses SET region = _default_name WHERE region = _name;

  -- Soft-deleted ex-staff still reference the region for history (131) — park
  -- them on the default region so the FK doesn't block; active staff were
  -- refused above.
  UPDATE staff_profiles SET region = _default_name
   WHERE region = _name AND deleted_at IS NOT NULL;

  -- Belt-and-braces from 125: detach any dangling salary denorm before the kasa
  -- goes (a real payment implies a kasa movement, so normally unreachable).
  UPDATE staff_salary_payments SET cash_account_id = NULL
   WHERE cash_account_id IN (SELECT id FROM cash_accounts WHERE region = _name);

  DELETE FROM cash_accounts WHERE region = _name;
  DELETE FROM regions WHERE id = p_id;

  RETURN _moved;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_region(uuid) TO authenticated;
