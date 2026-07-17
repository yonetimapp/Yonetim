-- =============================================================================
-- HomeGuru PMS — migration 016
-- Cascading delete for payment collections.
-- =============================================================================
-- collect_payment() writes to three tables (payment_collections, ledger_entries,
-- cash_transactions). Until now the only link between them was a free-form
-- ref_type/ref_id text pair on cash_transactions, and ledger_entries had no
-- back-reference at all. So deleting a cash tx left the cari and audit row
-- behind — and migration 015 surfaces that as an amber warning in the UI.
--
-- This migration wires up a proper foreign key so a single delete on
-- payment_collections cascades cleanly to both child rows.
--
-- For data created BEFORE this migration, we backfill: cash_transactions
-- get the link directly from ref_id; ledger_entries get a best-effort match
-- on (reservation_id, amount, created_by). Old data without a usable match
-- keeps the existing "won't cascade" behavior.
-- =============================================================================

-- 1. Add FK columns (nullable — old rows and manual entries stay independent)
ALTER TABLE ledger_entries
  ADD COLUMN payment_collection_id uuid
    REFERENCES payment_collections(id) ON DELETE CASCADE;

ALTER TABLE cash_transactions
  ADD COLUMN payment_collection_id uuid
    REFERENCES payment_collections(id) ON DELETE CASCADE;

CREATE INDEX ledger_entries_payment_collection_idx
  ON ledger_entries(payment_collection_id);
CREATE INDEX cash_transactions_payment_collection_idx
  ON cash_transactions(payment_collection_id);

-- 2. Backfill existing rows
-- 2a. cash_transactions: ref_id already points at the payment_collection
UPDATE cash_transactions
SET payment_collection_id = ref_id
WHERE ref_type = 'payment_collection'
  AND ref_id IS NOT NULL
  AND payment_collection_id IS NULL;

-- 2b. ledger_entries: heuristic match on (reservation_id, amount, created_by).
-- collect_payment inserts all three rows in the same transaction, so
-- created_at is identical — but we don't tighten on that here in case admins
-- have already created manual matches we shouldn't disturb.
UPDATE ledger_entries le
SET payment_collection_id = pc.id
FROM payment_collections pc
WHERE le.type = 'PAYMENT'
  AND le.payment_collection_id IS NULL
  AND le.reservation_id = pc.reservation_id
  AND le.amount = pc.amount
  AND le.created_by = pc.collected_by_user_id;

-- 3. DELETE policy on payment_collections (SUPER_ADMIN only — same posture as
--    cash_tx_delete in migration 015)
DROP POLICY IF EXISTS payment_collections_delete ON payment_collections;
CREATE POLICY payment_collections_delete ON payment_collections FOR DELETE
  USING (auth_role() = 'SUPER_ADMIN');

-- 4. Rewrite collect_payment() so new inserts populate the FK
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
  _caller_user             uuid;
  _caller_role             text;
  _caller_property         uuid;
  _reservation_property    uuid;
  _reservation_guest       uuid;
  _property_type           text;
  _resolved_cash_account   uuid;
  _payment_id              uuid;
BEGIN
  -- 1. Identity
  _caller_user := auth.uid();
  IF _caller_user IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı' USING ERRCODE = '28000';
  END IF;

  SELECT role, property_id
    INTO _caller_role, _caller_property
  FROM staff_profiles
  WHERE user_id = _caller_user;

  IF _caller_role IS NULL THEN
    RAISE EXCEPTION 'Personel profili bulunamadı' USING ERRCODE = '28000';
  END IF;

  -- 2. Resolve reservation + property
  SELECT r.property_id, r.guest_id, p.type
    INTO _reservation_property, _reservation_guest, _property_type
  FROM reservations r
  JOIN properties p ON p.id = r.property_id
  WHERE r.id = _reservation_id;

  IF _reservation_property IS NULL THEN
    RAISE EXCEPTION 'Rezervasyon bulunamadı';
  END IF;

  -- 3. Role × property-type × branch matrix
  IF _caller_role = 'SUPER_ADMIN' THEN
    NULL;
  ELSIF _caller_role = 'PROPERTY_MANAGER' THEN
    IF _caller_property IS DISTINCT FROM _reservation_property THEN
      RAISE EXCEPTION 'Bu rezervasyon başka bir şubeye ait' USING ERRCODE = '42501';
    END IF;
  ELSIF _caller_role = 'RECEPTION' THEN
    IF _caller_property IS DISTINCT FROM _reservation_property THEN
      RAISE EXCEPTION 'Bu rezervasyon başka bir şubeye ait' USING ERRCODE = '42501';
    END IF;
    IF _property_type <> 'HOTEL' THEN
      RAISE EXCEPTION 'Resepsiyon yalnızca otellerde ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSIF _caller_role = 'HOUSEKEEPING' THEN
    IF _caller_property IS DISTINCT FROM _reservation_property THEN
      RAISE EXCEPTION 'Bu rezervasyon başka bir şubeye ait' USING ERRCODE = '42501';
    END IF;
    IF _property_type <> 'APARTMENT' THEN
      RAISE EXCEPTION 'Temizlik yalnızca apartmanlarda ödeme toplayabilir' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Yetkisiz rol' USING ERRCODE = '42501';
  END IF;

  -- 4. Validate inputs
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Tutar sıfırdan büyük olmalıdır';
  END IF;
  IF _method NOT IN ('CASH', 'TRANSFER', 'CARD') THEN
    RAISE EXCEPTION 'Ödeme yöntemi geçersiz (CASH / TRANSFER / CARD)';
  END IF;

  -- 5. Resolve cash account for CASH method
  IF _method = 'CASH' THEN
    IF _cash_account_id IS NULL THEN
      SELECT id INTO _resolved_cash_account
      FROM cash_accounts
      WHERE property_id = _reservation_property
        AND account_type = 'CASH'
      ORDER BY created_at
      LIMIT 1;
      IF _resolved_cash_account IS NULL THEN
        RAISE EXCEPTION 'Bu mülk için nakit kasası tanımlanmamış. Önce bir nakit kasası oluşturun.';
      END IF;
    ELSE
      SELECT id INTO _resolved_cash_account
      FROM cash_accounts
      WHERE id = _cash_account_id
        AND property_id = _reservation_property;
      IF _resolved_cash_account IS NULL THEN
        RAISE EXCEPTION 'Seçilen kasa bu mülke ait değil';
      END IF;
    END IF;
  END IF;

  -- 6. Insert payment_collections
  INSERT INTO payment_collections (
    reservation_id, property_id, collected_by_user_id,
    amount, method, status
  ) VALUES (
    _reservation_id, _reservation_property, _caller_user,
    _amount, _method, 'CONFIRMED'
  )
  RETURNING id INTO _payment_id;

  -- 7. Insert ledger PAYMENT entry — now linked via FK so it cascades
  INSERT INTO ledger_entries (
    guest_id, reservation_id, type, amount, note, created_by,
    payment_collection_id
  ) VALUES (
    _reservation_guest, _reservation_id, 'PAYMENT', _amount,
    COALESCE(_note, 'Ödeme — ' || _method), _caller_user,
    _payment_id
  );

  -- 8. If CASH, push the money into the cash drawer — also linked via FK
  IF _method = 'CASH' THEN
    INSERT INTO cash_transactions (
      cash_account_id, amount, direction, description,
      ref_type, ref_id, created_by, payment_collection_id
    ) VALUES (
      _resolved_cash_account, _amount, 'IN',
      COALESCE(_note, 'Misafir ödemesi'),
      'payment_collection', _payment_id, _caller_user, _payment_id
    );
  END IF;

  RETURN _payment_id;
END;
$$;
