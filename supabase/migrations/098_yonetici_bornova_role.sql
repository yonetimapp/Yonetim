-- =============================================================================
-- HomeGuru PMS — migration 098
-- Make "Yönetici Bornova" a real, assignable role (YONETICI_BORNOVA).
-- =============================================================================
-- Until now the Bornova manager was modelled as PROPERTY_MANAGER + a region tag.
-- The operator wants a single distinct role they can pick from the staff form.
-- We add the role value and translate it centrally so NONE of the region
-- isolation logic (092-097) has to change:
--
--   * auth_role()   normalises YONETICI_BORNOVA -> PROPERTY_MANAGER, so every
--     permission/RLS check treats them as a (region-scoped) manager.
--   * auth_region() derives 'bornova' from the role itself — the role is now the
--     single source of truth (staff_profiles.region is no longer consulted).
--
-- Only three SECURITY DEFINER tahsilat functions read staff_profiles.role
-- DIRECTLY into _caller_role; they're re-pointed at auth_role() so the new role
-- flows through their existing PROPERTY_MANAGER region-scope checks. (Reading the
-- raw role would let a YONETICI_BORNOVA skip the auth_sees_property scope check —
-- a hole — so this normalisation is required, not cosmetic.)
-- =============================================================================

-- 1. Allow the new role value.
ALTER TABLE staff_profiles DROP CONSTRAINT staff_profiles_role_check;
ALTER TABLE staff_profiles ADD CONSTRAINT staff_profiles_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YONETICI_BORNOVA',
                  'RECEPTION', 'HOUSEKEEPING', 'YETKILI', 'PENDING'));

-- 2. Migrate any existing Bornova manager (set up as PM + region tag) to the
--    new role. region column becomes vestigial (kept, but no longer read).
UPDATE staff_profiles
   SET role = 'YONETICI_BORNOVA'
 WHERE role = 'PROPERTY_MANAGER' AND region = 'bornova';

-- 3. auth_role(): YONETICI_BORNOVA behaves as PROPERTY_MANAGER everywhere.
CREATE OR REPLACE FUNCTION auth_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN role = 'YONETICI_BORNOVA' THEN 'PROPERTY_MANAGER' ELSE role END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- 4. auth_region(): the region is implied by the role (single source of truth).
CREATE OR REPLACE FUNCTION auth_region()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN role = 'YONETICI_BORNOVA' THEN 'bornova' ELSE NULL END
  FROM staff_profiles
  WHERE user_id = auth.uid() AND deleted_at IS NULL;
$$;

-- ----------------------------------------------------------------------------
-- 5. The three tahsilat functions: source _caller_role from auth_role() (which
--    now normalises YONETICI_BORNOVA), leaving every downstream branch intact.
-- ----------------------------------------------------------------------------

-- collect_payment (was 067)
CREATE OR REPLACE FUNCTION collect_payment(
  _reservation_id  uuid,
  _amount          numeric,
  _method          text,
  _cash_account_id uuid DEFAULT NULL,
  _note            text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user          uuid;
  _caller_role          text;
  _reservation_property uuid;
  _property_type        text;
  _payment_id           uuid;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  _caller_role := auth_role();
  IF _caller_role IS NULL THEN
    RAISE EXCEPTION 'Personel profili bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT r.property_id, p.type
    INTO _reservation_property, _property_type
  FROM reservations r
  JOIN properties p ON p.id = r.property_id
  WHERE r.id = _reservation_id;

  IF _reservation_property IS NULL THEN
    RAISE EXCEPTION 'Rezervasyon bulunamadı';
  END IF;

  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL;
  ELSIF _caller_role IN ('PROPERTY_MANAGER', 'YETKILI', 'RECEPTION', 'HOUSEKEEPING') THEN
    IF NOT auth_sees_property(_reservation_property) THEN
      RAISE EXCEPTION 'Bu mülke erişim yetkiniz yok' USING ERRCODE = '42501';
    END IF;
    IF _caller_role = 'RECEPTION' AND _property_type <> 'HOTEL' THEN
      RAISE EXCEPTION 'Resepsiyon yalnızca otellerde ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
    IF _caller_role = 'HOUSEKEEPING' AND _property_type <> 'APARTMENT' THEN
      RAISE EXCEPTION 'Temizlik yalnızca apartmanlarda ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Yetkisiz rol' USING ERRCODE = '42501';
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Tutar sıfırdan büyük olmalıdır';
  END IF;
  IF _method NOT IN ('CASH', 'TRANSFER', 'CARD') THEN
    RAISE EXCEPTION 'Ödeme yöntemi geçersiz (CASH / TRANSFER / CARD)';
  END IF;

  -- ALL callers (yönetici included) submit UNCONFIRMED. The cari + kasa
  -- only update when confirm_payment fires from /finance/pending.
  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id, amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user, _amount, _method, 'UNCONFIRMED'
  )
  RETURNING id INTO _payment_id;

  RETURN _payment_id;
END;
$$;

-- confirm_payment (was 071)
CREATE OR REPLACE FUNCTION confirm_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user            uuid;
  _caller_role            text;
  _pc                     payment_collections;
  _reservation_guest      uuid;
  _resolved_cash_account  uuid;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  _caller_role := auth_role();

  IF _caller_role NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Yalnızca yönetici tahsilat onaylayabilir' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _pc FROM payment_collections WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tahsilat bulunamadı';
  END IF;

  IF _pc.status <> 'UNCONFIRMED' THEN
    RAISE EXCEPTION 'Bu tahsilat zaten % durumunda, onaylanamaz', _pc.status;
  END IF;

  IF _caller_role = 'PROPERTY_MANAGER' AND NOT auth_sees_property(_pc.property_id) THEN
    RAISE EXCEPTION 'Bu tahsilata erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  SELECT guest_id INTO _reservation_guest
  FROM reservations WHERE id = _pc.reservation_id;
  IF _reservation_guest IS NULL THEN
    RAISE EXCEPTION 'İlişkili rezervasyon bulunamadı';
  END IF;

  SELECT id INTO _resolved_cash_account FROM cash_accounts LIMIT 1;
  IF _resolved_cash_account IS NULL THEN
    RAISE EXCEPTION 'Genel kasa bulunamadı';
  END IF;

  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by, payment_collection_id
  ) VALUES (
    _reservation_guest, _pc.reservation_id, 'PAYMENT', _pc.amount,
    'Ödeme — ' || _pc.method || ' (onaylandı)', _caller_user, _pc.id
  );

  INSERT INTO cash_transactions (
    cash_account_id, amount, direction, description,
    ref_type, ref_id, created_by, payment_collection_id, property_id
  ) VALUES (
    _resolved_cash_account, _pc.amount, 'IN',
    'Misafir ödemesi — ' || _pc.method || ' (onaylandı)',
    'payment_collection', _pc.id, _caller_user, _pc.id, _pc.property_id
  );

  UPDATE payment_collections
  SET status = 'CONFIRMED', confirmed_by = _caller_user, confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;

-- dispute_payment (was 033)
CREATE OR REPLACE FUNCTION dispute_payment(_payment_id uuid)
RETURNS payment_collections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_user      uuid;
  _caller_role      text;
  _pc               payment_collections;
BEGIN
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  _caller_role := auth_role();

  IF _caller_role NOT IN ('SUPER_ADMIN', 'PROPERTY_MANAGER') THEN
    RAISE EXCEPTION 'Yalnızca yönetici tahsilatı reddedebilir' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _pc FROM payment_collections WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tahsilat bulunamadı';
  END IF;

  IF _pc.status <> 'UNCONFIRMED' THEN
    RAISE EXCEPTION 'Bu tahsilat zaten % durumunda', _pc.status;
  END IF;

  IF _caller_role = 'PROPERTY_MANAGER' AND NOT auth_sees_property(_pc.property_id) THEN
    RAISE EXCEPTION 'Bu tahsilata erişim yetkiniz yok' USING ERRCODE = '42501';
  END IF;

  UPDATE payment_collections
  SET status = 'DISPUTED', confirmed_by = _caller_user, confirmed_at = now()
  WHERE id = _pc.id
  RETURNING * INTO _pc;

  RETURN _pc;
END;
$$;
