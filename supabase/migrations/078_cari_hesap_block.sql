-- =============================================================================
-- HomeGuru PMS — migration 078
-- Cari hesap kilitleme (block a reservation's current account).
-- =============================================================================
-- A SUPER_ADMIN (Yönetici) can lock a reservation's cari hesap once its balance
-- is exactly 0, after which NO new transactions can be added — not a charge
-- (+ Ekstra Ücret), not a payment (Ödeme Topla), nothing. Enforced at the DB
-- layer so the UI cannot be bypassed.
--
-- Pieces:
--   1. reservations.cari_blocked flag.
--   2. BEFORE INSERT triggers on ledger_entries + payment_collections that
--      reject inserts for a blocked reservation.
--   3. set_cari_blocked(reservation, bool) RPC — SUPER_ADMIN only; refuses to
--      block unless the ledger balance is 0.
--   4. Auto-debit (migration 077) skips blocked reservations so re-activating
--      one can't trip the ledger block trigger.
-- =============================================================================

-- 1. Flag.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS cari_blocked boolean NOT NULL DEFAULT false;

-- 2. Reject inserts on a blocked reservation. SECURITY DEFINER so it always
--    reads the true cari_blocked value regardless of the inserter's RLS view
--    (an RLS-hidden row must not silently bypass the lock).
CREATE OR REPLACE FUNCTION _reject_when_cari_blocked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  blocked boolean;
BEGIN
  IF NEW.reservation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT cari_blocked INTO blocked FROM reservations WHERE id = NEW.reservation_id;
  IF blocked IS TRUE THEN
    RAISE EXCEPTION 'Bu rezervasyonun cari hesabı kilitli — yeni işlem eklenemez.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledger_cari_block_trg ON ledger_entries;
CREATE TRIGGER ledger_cari_block_trg
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION _reject_when_cari_blocked();

DROP TRIGGER IF EXISTS payment_cari_block_trg ON payment_collections;
CREATE TRIGGER payment_cari_block_trg
  BEFORE INSERT ON payment_collections
  FOR EACH ROW EXECUTE FUNCTION _reject_when_cari_blocked();

-- 3. Lock / unlock RPC. SUPER_ADMIN only; balance must be 0 to lock.
CREATE OR REPLACE FUNCTION set_cari_blocked(_reservation_id uuid, _blocked boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal numeric;
BEGIN
  IF auth_role() <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Yalnızca yönetici cari hesabı kilitleyebilir.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF _blocked THEN
    SELECT
      COALESCE(SUM(CASE WHEN type = 'DEBT' THEN amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type = 'PAYMENT' THEN amount ELSE 0 END), 0)
    INTO bal
    FROM ledger_entries
    WHERE reservation_id = _reservation_id;

    IF bal <> 0 THEN
      RAISE EXCEPTION 'Cari hesap bakiyesi sıfır değil; kilitlemeden önce hesabı kapatın.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE reservations SET cari_blocked = _blocked WHERE id = _reservation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_cari_blocked(uuid, boolean) TO authenticated;

-- 4. Auto-debit must not fire for a blocked reservation (otherwise re-activating
--    one would hit the ledger block trigger and fail). Same body as migration
--    077 plus the cari_blocked guard.
CREATE OR REPLACE FUNCTION _auto_debit_on_activate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active'
     AND NEW.auto_debit = true
     AND NEW.cari_blocked = false
     AND COALESCE(NEW.total_amount, 0) > 0
  THEN
    INSERT INTO ledger_entries
      (guest_id, reservation_id, type, amount, currency, note, created_by)
    SELECT NEW.guest_id, NEW.id, 'DEBT', NEW.total_amount, 'TRY',
           'Otomatik borçlandırma (giriş)', NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_entries le
      WHERE le.reservation_id = NEW.id
        AND le.type = 'DEBT'
        AND le.note LIKE 'Otomatik borçlandırma%'
    );
  END IF;
  RETURN NEW;
END;
$$;
