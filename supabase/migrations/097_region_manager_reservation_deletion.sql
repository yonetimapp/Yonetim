-- =============================================================================
-- HomeGuru PMS — migration 097
-- Region isolation — a region yönetici resolves its region's deletion requests.
-- =============================================================================
-- 090 made reservation deletion a request that only a SUPER_ADMIN approves/denies
-- from Onaylar. A "Yönetici Bornova" is the yönetici for its region and should
-- resolve its OWN region's requests. We reuse auth_can_review_region (096):
-- SUPER_ADMIN resolves any; a region manager resolves only requests whose
-- reservation belongs to their region. The request's region comes from its
-- snapshotted property_id. HQ / Ana Grup requests stay SUPER_ADMIN-only.
--
-- Visibility is already correct: rdr_select (090) scopes a manager to requests
-- they can see via auth_sees_property, which is region-isolated since Phase 1.
-- Deletion still happens inside these SECURITY DEFINER functions, so the
-- SUPER_ADMIN-only reservations_delete RLS is unaffected.
-- =============================================================================

CREATE OR REPLACE FUNCTION approve_reservation_deletion(_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _req reservation_deletion_requests;
BEGIN
  SELECT * INTO _req FROM reservation_deletion_requests
   WHERE id = _request_id AND status = 'pending';
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Talep bulunamadı veya zaten sonuçlandırılmış.';
  END IF;

  IF NOT auth_can_review_region(region_of_property(_req.property_id)) THEN
    RAISE EXCEPTION 'Yönetici yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;

  -- Soft-delete the reservation → Çöp Kutusu. A reservation tied to other
  -- records (ödeme, KBS, temizlik) can't be deleted — surface a clear reason
  -- and leave the request pending so it can be retried after cleanup.
  BEGIN
    PERFORM soft_delete_entity('reservations', _req.reservation_id);
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'Bu rezervasyon başka kayıtlara (ödeme, KBS, temizlik) bağlı olduğu için silinemez. Önce ilgili kayıtları kaldırın.';
  END;

  UPDATE reservation_deletion_requests
     SET status = 'approved', resolved_by = auth.uid(), resolved_at = now()
   WHERE id = _request_id;
END;
$$;
GRANT EXECUTE ON FUNCTION approve_reservation_deletion(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION deny_reservation_deletion(_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _req reservation_deletion_requests;
BEGIN
  SELECT * INTO _req FROM reservation_deletion_requests
   WHERE id = _request_id AND status = 'pending';
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Talep bulunamadı veya zaten sonuçlandırılmış.';
  END IF;

  IF NOT auth_can_review_region(region_of_property(_req.property_id)) THEN
    RAISE EXCEPTION 'Yönetici yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;

  UPDATE reservation_deletion_requests
     SET status = 'denied', resolved_by = auth.uid(), resolved_at = now()
   WHERE id = _request_id;
END;
$$;
GRANT EXECUTE ON FUNCTION deny_reservation_deletion(uuid) TO authenticated;
