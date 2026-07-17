-- =============================================================================
-- HomeGuru PMS — migration 088
-- Auto-debit: charge each night's NIGHTLY RATE, not a slice of the total.
-- =============================================================================
-- Migration 080 accrued one night per day by SPLITTING total_amount across the
-- nights (incremental cumulative rounding so the slices summed to the total).
-- The operator wants the opposite: each night should be debited that night's
-- gecelik ücret directly — never derived from the toplam.
--
-- Nightly rate for a given night = the price calendar entry for that unit on that
-- date (property_nightly_prices.price, UNIQUE per unit+date), falling back to the
-- unit's base price (units.base_price) when there's no override — exactly the
-- per-night prices the booking form sums into the suggested total. A weekend
-- night can therefore cost more than a weekday night.
--
-- Consequences (intended):
--   * The auto-debited total no longer necessarily equals reservations.total_amount
--     — it is the sum of the actual nightly rates, independent of the toplam.
--   * total_amount is no longer used by this sweep at all.
--   * An orphaned reservation (unit deleted → unit_id NULL) has no nightly rate,
--     so it is skipped by the amount > 0 filter (can't price a missing unit).
--
-- Everything else is unchanged from 080: every-5-min sweep, post the current
-- night-day the moment the check-in hour arrives, once per reservation per day,
-- skip cari_blocked stays and those already charged in full under 077.
--
-- Transition note: a reservation already mid-stay keeps its earlier 080 slice
-- charges (per-day idempotency never re-charges a day); only its remaining nights
-- accrue at the nightly rate. New stays accrue entirely at the nightly rate.
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('homeguru-auto-debit-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'homeguru-auto-debit-nightly',
  '4-59/5 * * * *',
  $$
  INSERT INTO ledger_entries (guest_id, reservation_id, type, amount, currency, note, created_by)
  SELECT n.guest_id, n.reservation_id, 'DEBT', n.amount, 'TRY', n.note, NULL
  FROM (
    SELECT
      r.guest_id,
      r.id AS reservation_id,
      -- That night's rate: price-calendar override for this unit+date, else the
      -- unit's base price. No division of total_amount.
      COALESCE(
        (SELECT pnp.price FROM property_nightly_prices pnp
          WHERE pnp.unit_id = r.unit_id AND pnp.price_date = cur.today
          LIMIT 1),
        u.base_price
      ) AS amount,
      'Otomatik borçlandırma (gece) ' || to_char(cur.today, 'YYYY-MM-DD') AS note
    FROM reservations r
    LEFT JOIN units u ON u.id = r.unit_id
    CROSS JOIN (
      SELECT (now() AT TIME ZONE 'Europe/Istanbul')        AS now_ts,
             (now() AT TIME ZONE 'Europe/Istanbul')::date  AS today
    ) cur
    WHERE r.auto_debit = true
      AND r.status = 'active'
      AND r.cari_blocked = false
      -- Chargeable night-days: check-in day .. day before checkout. The
      -- GREATEST(...) gives day-use (same-day) a single chargeable day.
      AND cur.today >= r.stay_start::date
      AND cur.today <  GREATEST(r.stay_end::date, r.stay_start::date + 1)
      -- Only once today's check-in hour has actually arrived (Istanbul wall clock).
      AND cur.now_ts >= cur.today + (r.stay_start AT TIME ZONE 'Europe/Istanbul')::time
      -- Transition guard: skip stays already charged in full under migration 077.
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le0
        WHERE le0.reservation_id = r.id
          AND le0.type = 'DEBT'
          AND le0.note = 'Otomatik borçlandırma (giriş)'
      )
      -- Idempotent: at most one nightly charge per reservation per calendar day.
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le1
        WHERE le1.reservation_id = r.id
          AND le1.type = 'DEBT'
          AND le1.note = 'Otomatik borçlandırma (gece) ' || to_char(cur.today, 'YYYY-MM-DD')
      )
  ) n
  -- ledger_entries.amount has CHECK (amount > 0); a NULL/zero nightly rate
  -- (e.g. orphaned unit, no base price) is skipped so the sweep can't abort.
  WHERE n.amount > 0;
  $$
);
