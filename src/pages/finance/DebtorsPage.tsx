import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listReservations, type ReservationWithRefs } from '@/lib/queries/reservations';
import { loadReservationsWithPayments } from '@/lib/queries/payments';
import { Card } from '@/components/ui/Card';
import { FinanceTabs } from './FinanceTabs';
import { formatTRY, formatDate } from '@/lib/utils';

interface Debtor {
  reservation: ReservationWithRefs;
  total: number;
  paid: number;
  outstanding: number;
}

/**
 * Borçlar — guests who still owe money. For every non-cancelled reservation we
 * compare the collected sum (active UNCONFIRMED + CONFIRMED payments) against
 * total_amount; any positive remainder is an outstanding debt (alacak). Rows
 * are sorted by the largest debt first so the desk can chase the big ones.
 *
 * Reuses listReservations + loadReservationsWithPayments (the same payment-sum
 * map that drives the reservation-card badge) — no extra query or migration.
 */
export function DebtorsPage() {
  const [reservations, setReservations] = useState<ReservationWithRefs[] | null>(null);
  const [paidMap, setPaidMap] = useState<Map<string, number>>(() => new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listReservations()
      .then(setReservations)
      .catch((e) => setError(e?.message ?? 'Rezervasyonlar yüklenemedi'));
    loadReservationsWithPayments().then(setPaidMap).catch(() => {});
  }, []);

  const debtors = useMemo<Debtor[]>(() => {
    if (!reservations) return [];
    const rows: Debtor[] = [];
    for (const r of reservations) {
      if (r.status === 'cancelled') continue;
      const total = Number(r.total_amount);
      const paid = paidMap.get(r.id) ?? 0;
      const outstanding = total - paid;
      if (outstanding > 0.005) rows.push({ reservation: r, total, paid, outstanding });
    }
    return rows.sort((a, b) => b.outstanding - a.outstanding);
  }, [reservations, paidMap]);

  const totalDebt = useMemo(
    () => debtors.reduce((sum, d) => sum + d.outstanding, 0),
    [debtors],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Borçlar
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Ödemesi eksik kalan rezervasyonlar — en yüksek borç üstte.
          </p>
        </div>
        <FinanceTabs />
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!reservations && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {reservations && debtors.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Borçlu rezervasyon yok — tüm ödemeler tamam.
          </p>
        </Card>
      )}

      {debtors.length > 0 && (
        <>
          <Card className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              <span className="block">Toplam borç</span>
              <span className="block text-xs font-normal text-stone-500 dark:text-stone-400">
                ({debtors.length} rezervasyon)
              </span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-lg font-semibold text-red-700 dark:text-red-400">
              {formatTRY(totalDebt)}
            </span>
          </Card>

          <div className="space-y-2">
            {debtors.map((d) => (
              <Link
                key={d.reservation.id}
                to={`/reservations/${d.reservation.id}`}
                className="block rounded-lg border border-stone-200 bg-white p-3 transition-colors hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800/50"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-stone-900 dark:text-stone-100">
                      {d.reservation.guest?.full_name ?? '—'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-stone-600 dark:text-stone-300">
                      {d.reservation.property?.name} · {d.reservation.unit?.name}
                    </p>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                      {formatDate(d.reservation.stay_start)} →{' '}
                      {formatDate(d.reservation.stay_end)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                      Kalan {formatTRY(d.outstanding)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
                      {formatTRY(d.paid)} / {formatTRY(d.total)}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
