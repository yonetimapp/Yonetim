-- =============================================================================
-- HomeGuru PMS — migration 047
-- Nightly pricing overrides: a per-(unit, date) price that overrides the
-- unit's base_price for that night.
-- =============================================================================
-- Use cases: weekend premium, holiday spike, off-season discount, last-minute
-- haggle. The override is opt-in per cell — if no row exists for a (unit,
-- date), the unit's base_price applies as before.
--
-- Schema:
--   property_nightly_prices(id, property_id, unit_id, price_date, price,
--                           created_by, created_at, updated_at)
--   UNIQUE (unit_id, price_date) — one override per cell.
--
-- Bulk RPC:
--   set_nightly_price_range(_unit_id, _start, _end, _price) — upserts every
--   date in [start, end] inclusive. Returns the number of nights affected.
--
-- RLS: read = auth_sees_property; write = SUPER_ADMIN / PROPERTY_MANAGER
-- (pricing is a management decision; reception and housekeeping don't set it).
-- =============================================================================

CREATE TABLE property_nightly_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  price_date  date NOT NULL,
  price       numeric(10, 2) NOT NULL CHECK (price >= 0),
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, price_date)
);

CREATE INDEX property_nightly_prices_property_idx ON property_nightly_prices(property_id);
CREATE INDEX property_nightly_prices_date_idx ON property_nightly_prices(price_date);

CREATE OR REPLACE FUNCTION _property_nightly_prices_touch_updated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_nightly_prices_touch
  BEFORE UPDATE ON property_nightly_prices
  FOR EACH ROW EXECUTE FUNCTION _property_nightly_prices_touch_updated();

-- -----------------------------------------------------------------------------
-- RLS — pricing is a management decision; reception/housekeeping read-only.
-- -----------------------------------------------------------------------------
ALTER TABLE property_nightly_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_nightly_prices_select ON property_nightly_prices FOR SELECT
  USING (auth_sees_property(property_id));

CREATE POLICY property_nightly_prices_modify ON property_nightly_prices FOR ALL
  USING (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI')
    AND auth_sees_property(property_id)
  )
  WITH CHECK (
    auth_role() IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'YETKILI')
    AND auth_sees_property(property_id)
  );

-- -----------------------------------------------------------------------------
-- Bulk-set RPC: upsert one row per night in [_start_date, _end_date] inclusive.
-- SECURITY INVOKER so RLS still applies; service_role doesn't need this.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_nightly_price_range(
  _property_id uuid,
  _unit_id     uuid,
  _start_date  date,
  _end_date    date,
  _price       numeric
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  affected int := 0;
BEGIN
  IF _end_date < _start_date THEN
    RAISE EXCEPTION 'Bitiş tarihi başlangıçtan önce olamaz.';
  END IF;
  IF _price < 0 THEN
    RAISE EXCEPTION 'Fiyat negatif olamaz.';
  END IF;

  INSERT INTO property_nightly_prices (property_id, unit_id, price_date, price, created_by)
  SELECT _property_id, _unit_id, gs::date, _price, auth.uid()
  FROM generate_series(_start_date, _end_date, interval '1 day') gs
  ON CONFLICT (unit_id, price_date)
  DO UPDATE SET price = EXCLUDED.price;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION
  set_nightly_price_range(uuid, uuid, date, date, numeric) TO authenticated;
