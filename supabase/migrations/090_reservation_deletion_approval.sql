-- =============================================================================
-- HomeGuru PMS — migration 090
-- Reservation deletion needs Yönetici approval when requested by a non-admin.
-- =============================================================================
-- Until now PROPERTY_MANAGER / RECEPTION / YETKILI could hard-delete a
-- reservation directly (reservations_delete RLS, migration 033). The operator
-- wants those deletions to instead become a REQUEST that a SUPER_ADMIN approves
-- or denies from the Onaylar page. Only SUPER_ADMIN may delete outright.
--
-- Design:
--   * reservation_deletion_requests — one pending row per reservation while it
--     awaits a decision.
--   * reservations_delete RLS is tightened to SUPER_ADMIN only. This is the real
--     security boundary: a non-admin can no longer DELETE a reservation through
--     the API at all, so the request flow can't be bypassed.
--   * request_reservation_deletion()  — non-admin files a pending request.
--   * approve_reservation_deletion()  — SUPER_ADMIN: soft-delete the reservation
--                                       (→ Çöp Kutusu) and mark the request done.
--   * deny_reservation_deletion()     — SUPER_ADMIN: keep the reservation, mark
--                                       the request denied.
-- All three are SECURITY DEFINER with explicit role/scope gates (DEFINER bypasses
-- RLS, so gating is done in-function).
-- =============================================================================

-- 1. Requests table.
CREATE TABLE IF NOT EXISTS reservation_deletion_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  property_id     uuid REFERENCES properties(id) ON DELETE SET NULL, -- snapshot for RLS scope
  requested_by    uuid REFERENCES auth.users(id),
  reason          text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'denied')),
  resolved_by     uuid REFERENCES auth.users(id),
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- At most one pending request per reservation.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_deletion_pending_uniq
  ON reservation_deletion_requests (reservation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS reservation_deletion_status_idx
  ON reservation_deletion_requests (status) WHERE status = 'pending';

ALTER TABLE reservation_deletion_requests ENABLE ROW LEVEL SECURITY;

-- SELECT: SUPER_ADMIN sees all (drives the Onaylar tab); the requester sees
-- their own; branch staff see their branch's (so the detail page can show
-- "onay bekliyor"). No client INSERT/UPDATE/DELETE — only via the RPCs below.
DROP POLICY IF EXISTS rdr_select ON reservation_deletion_requests;
CREATE POLICY rdr_select ON reservation_deletion_requests FOR SELECT
  USING (
    auth_role() = 'SUPER_ADMIN'
    OR requested_by = auth.uid()
    OR (property_id IS NOT NULL AND auth_sees_property(property_id))
  );

-- 2. Tighten reservation deletion to SUPER_ADMIN only.
DROP POLICY IF EXISTS reservations_delete ON reservations;
CREATE POLICY reservations_delete ON reservations FOR DELETE
  USING (auth_role() = 'SUPER_ADMIN');

-- 3. request_reservation_deletion — a non-admin files a pending request.
CREATE OR REPLACE FUNCTION request_reservation_deletion(
  _reservation_id uuid,
  _reason         text DEFAULT NULL
) RETURNS reservation_deletion_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r   reservations;
  _req reservation_deletion_requests;
BEGIN
  IF auth_role() NOT IN ('PROPERTY_MANAGER', 'RECEPTION', 'YETKILI') THEN
    RAISE EXCEPTION 'Silme talebi için yetkiniz yok.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM reservations WHERE id = _reservation_id;
  IF _r.id IS NULL OR NOT auth_sees_property(_r.property_id) THEN
    RAISE EXCEPTION 'Rezervasyon bulunamadı veya erişiminiz yok.' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: reuse the existing pending request (unique index guards too).
  SELECT * INTO _req FROM reservation_deletion_requests
   WHERE reservation_id = _reservation_id AND status = 'pending'
   LIMIT 1;
  IF _req.id IS NOT NULL THEN
    RETURN _req;
  END IF;

  INSERT INTO reservation_deletion_requests
    (reservation_id, property_id, requested_by, reason)
  VALUES
    (_reservation_id, _r.property_id, auth.uid(), NULLIF(btrim(COALESCE(_reason, '')), ''))
  RETURNING * INTO _req;

  -- Notify admins so the request surfaces without polling Onaylar.
  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Rezervasyon silme talebi',
    'Onay bekleyen bir rezervasyon silme talebi var.',
    '/finance/pending',
    'system',
    'pending_approval',
    jsonb_build_object('kind', 'reservation_deletion', 'id', _req.id)
  );

  RETURN _req;
END;
$$;
GRANT EXECUTE ON FUNCTION request_reservation_deletion(uuid, text) TO authenticated;

-- 4. approve_reservation_deletion — SUPER_ADMIN approves → soft-delete the rez.
CREATE OR REPLACE FUNCTION approve_reservation_deletion(_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _req reservation_deletion_requests;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yönetici yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _req FROM reservation_deletion_requests
   WHERE id = _request_id AND status = 'pending';
  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Talep bulunamadı veya zaten sonuçlandırılmış.';
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

-- 5. deny_reservation_deletion — SUPER_ADMIN denies → keep the reservation.
CREATE OR REPLACE FUNCTION deny_reservation_deletion(_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _req reservation_deletion_requests;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yönetici yetkisi gerekir.' USING ERRCODE = '42501';
  END IF;

  UPDATE reservation_deletion_requests
     SET status = 'denied', resolved_by = auth.uid(), resolved_at = now()
   WHERE id = _request_id AND status = 'pending'
  RETURNING * INTO _req;

  IF _req.id IS NULL THEN
    RAISE EXCEPTION 'Talep bulunamadı veya zaten sonuçlandırılmış.';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION deny_reservation_deletion(uuid) TO authenticated;
