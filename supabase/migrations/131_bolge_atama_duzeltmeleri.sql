-- =============================================================================
-- Yönetim PMS — migration 131
-- Bölge ataması düzeltmeleri: Teknik daima tüm-bölge + delete_region soft-delete.
-- =============================================================================
-- Review follow-up to the 124–130 re-release chain.
--
-- 1) TEKNIK_PERSONEL sees every region BY DESIGN — its DATA access already
--    bypasses the region gate inside auth_sees_property (117/125). But the push
--    region gate (130) reads the all_regions COLUMN, and 124's backfill was a
--    one-time UPDATE: anyone promoted to Teknik afterwards carried
--    all_regions = false and silently lost other regions' issue notifications.
--    A BEFORE trigger now pins the column to true for the role no matter which
--    path writes the row (role modal, signup approval, raw SQL).
--
-- 2) delete_region (125) guarded only ACTIVE staff (deleted_at IS NULL), but
--    soft-deleted rows still hold the region FK — deleting an otherwise-empty
--    region raised a raw English FK violation instead of a Turkish message.
--    Empty regions now first move their soft-deleted ex-staff to the default
--    region (they are hidden everywhere; home region is meaningless for them).
-- =============================================================================

-- 1. Teknik Personel ⇒ all_regions = true, enforced at the row level.
CREATE OR REPLACE FUNCTION staff_teknik_all_regions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role = 'TEKNIK_PERSONEL' THEN
    NEW.all_regions := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS staff_teknik_all_regions ON staff_profiles;
CREATE TRIGGER staff_teknik_all_regions
  BEFORE INSERT OR UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE FUNCTION staff_teknik_all_regions();

-- Backfill any Teknik row written between 124's one-time UPDATE and this trigger.
UPDATE staff_profiles SET all_regions = true
 WHERE role = 'TEKNIK_PERSONEL' AND NOT all_regions;

-- 2. delete_region — verbatim from 125 except the soft-deleted-staff step
--    before the final deletes.
CREATE OR REPLACE FUNCTION delete_region(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _name text; _is_default boolean;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici bölge silebilir' USING ERRCODE = '42501';
  END IF;
  SELECT name, is_default INTO _name, _is_default FROM regions WHERE id = p_id;
  IF _name IS NULL THEN RAISE EXCEPTION 'Bölge bulunamadı'; END IF;
  IF _is_default THEN RAISE EXCEPTION 'Varsayılan bölge silinemez'; END IF;
  IF EXISTS (SELECT 1 FROM properties WHERE region = _name) THEN
    RAISE EXCEPTION 'Bu bölgede mülk var; önce mülkleri başka bölgeye taşıyın';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_profiles WHERE region = _name AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Bu bölgeye atanmış personel var; önce personeli başka bölgeye taşıyın';
  END IF;
  IF EXISTS (SELECT 1 FROM expenses WHERE region = _name) THEN
    RAISE EXCEPTION 'Bu bölgede gider kaydı var; bölge silinemez';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cash_transactions ct
    JOIN cash_accounts ca ON ca.id = ct.cash_account_id
    WHERE ca.region = _name
  ) THEN
    RAISE EXCEPTION 'Bu bölgenin kasasında hareket var; bölge silinemez';
  END IF;
  -- Soft-deleted ex-staff still reference the region (their rows survive for
  -- history). Park them on the default region so the FK doesn't block the
  -- delete — active staff were refused above.
  UPDATE staff_profiles
     SET region = (SELECT name FROM regions WHERE is_default LIMIT 1)
   WHERE region = _name AND deleted_at IS NOT NULL;
  -- Empty region: detach any dangling salary denorm, drop the kasa, drop the region.
  UPDATE staff_salary_payments SET cash_account_id = NULL
    WHERE cash_account_id IN (SELECT id FROM cash_accounts WHERE region = _name);
  DELETE FROM cash_accounts WHERE region = _name;
  DELETE FROM regions WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION delete_region(uuid) TO authenticated;
