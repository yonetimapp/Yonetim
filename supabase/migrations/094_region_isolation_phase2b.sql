-- =============================================================================
-- HomeGuru PMS — migration 094
-- Region isolation — Phase 2b: the Bornova kasa + automatic money routing.
-- =============================================================================
-- Phase 2a closed the leak (a region manager no longer sees the HQ kasa). This
-- phase gives Bornova its OWN kasa and makes new Bornova money flow into it.
--
-- Rather than rewrite all ~8 money-posting functions (collect/confirm payment,
-- approve_expense, recurring giderler, avans, maaş, manuel kasa) — each a money
-- path we don't want to risk — we route centrally with ONE trigger:
--
--   BEFORE INSERT on cash_transactions, set cash_account_id to the kasa of the
--   movement's region. The region is read from the row's property_id, or traced
--   from the linked gider / tahsilat, or (avans / maaş / manuel — no mülk) from
--   the caller's own region. So:
--     * Bornova mülk tahsilat / gider / kira  -> Bornova kasa
--     * Ana Grup (HQ) mülk                     -> Genel Kasa
--     * avans / maaş by SUPER_ADMIN            -> Genel Kasa
--     * anything a Bornova manager posts       -> Bornova kasa
--
-- The functions still set a cash_account_id; the trigger simply overrides it
-- with the correct region kasa, so none of them needed to change.
-- =============================================================================

-- 1. resolve_kasa(property): the kasa for a mülk's region, or — when there is
--    no mülk — the caller's own region. Falls back to the main/HQ kasa so a
--    movement can never land on a NULL account.
CREATE OR REPLACE FUNCTION resolve_kasa(p_property_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT ca.id FROM cash_accounts ca
      WHERE ca.region IS NOT DISTINCT FROM (
        CASE WHEN p_property_id IS NOT NULL
             THEN (SELECT pr.region FROM properties pr WHERE pr.id = p_property_id)
             ELSE auth_region() END
      )
      LIMIT 1),
    (SELECT ca.id FROM cash_accounts ca WHERE ca.region IS NULL LIMIT 1)
  );
$$;
GRANT EXECUTE ON FUNCTION resolve_kasa(uuid) TO authenticated;

-- 2. The routing trigger. Determines the movement's mülk, then pins the kasa.
CREATE OR REPLACE FUNCTION route_cash_tx_to_region_kasa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prop uuid;
BEGIN
  -- Prefer the explicit property_id; otherwise trace it from the linked gider
  -- or tahsilat (recurring giderler post with property_id NULL but ref_type =
  -- 'expense'). With no mülk at all, resolve_kasa() uses the caller's region.
  _prop := NEW.property_id;
  IF _prop IS NULL THEN
    IF NEW.ref_type = 'expense' AND NEW.ref_id IS NOT NULL THEN
      SELECT property_id INTO _prop FROM expenses WHERE id = NEW.ref_id;
    ELSIF NEW.ref_type = 'payment_collection' AND NEW.ref_id IS NOT NULL THEN
      SELECT property_id INTO _prop FROM payment_collections WHERE id = NEW.ref_id;
    END IF;
  END IF;

  NEW.cash_account_id := resolve_kasa(_prop);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cash_tx_route_kasa ON cash_transactions;
CREATE TRIGGER cash_tx_route_kasa
  BEFORE INSERT ON cash_transactions
  FOR EACH ROW EXECUTE FUNCTION route_cash_tx_to_region_kasa();

-- 3. Lift the single-kasa lock from migration 036 and replace it with a
--    one-kasa-per-region rule (COALESCE NULL -> '' so the HQ kasa counts).
DROP TRIGGER IF EXISTS cash_accounts_singleton ON cash_accounts;
DROP FUNCTION IF EXISTS enforce_single_cash_account();

CREATE UNIQUE INDEX IF NOT EXISTS cash_accounts_one_per_region
  ON cash_accounts (COALESCE(region, ''));

-- 4. Create the Bornova kasa (idempotent — the unique index blocks a second
--    Bornova kasa, ON CONFLICT makes a re-run a no-op).
INSERT INTO cash_accounts (property_id, name, account_type, currency, region)
VALUES (NULL, 'Bornova Kasası', 'CASH', 'TRY', 'bornova')
ON CONFLICT DO NOTHING;
