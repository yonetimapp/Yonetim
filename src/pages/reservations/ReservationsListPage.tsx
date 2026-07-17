import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, isTeknikPersonel } from '@/lib/rbac';
import {
  listReservations,
  reservationPropertyLabel,
  reservationUnitLabel,
  type ReservationWithRefs,
} from '@/lib/queries/reservations';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ReservationsViewTabs } from './ViewTabs';
import { formatTRY, formatDate, checkoutTimeLabel, istanbulToday } from '@/lib/utils';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';
import { loadReservationsWithPayments } from '@/lib/queries/payments';
import type { ReservationStatus } from '@/types/database';

const timeFmt = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'short' });
function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

// Tomorrow's Istanbul calendar date as YYYY-MM-DD. Anchored at noon UTC so the
// +1 day shift can never cross a DST/offset edge (Turkey is UTC+3 fixed).
function istanbulTomorrow(): string {
  const d = new Date(istanbulToday() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Payment badge: compares the collected sum against the reservation total.
//   none → Ödeme Alınmadı, < total → Kısmi, = total → Ödeme Alındı, > total → Fazladan.
// A small epsilon absorbs float rounding so an exact-amount payment reads "tam".
function paymentBadge(
  paid: number,
  total: number,
): { label: string; className: string } {
  const amber =
    'rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  const emerald =
    'rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  const sky =
    'rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
  if (paid <= 0) return { label: 'Ödeme Alınmadı', className: amber };
  if (paid < total - 0.005) return { label: 'Kısmi Ödeme Alındı', className: amber };
  if (paid > total + 0.005) return { label: 'Fazladan Ödeme Alındı', className: sky };
  return { label: 'Ödeme Alındı', className: emerald };
}

const STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: 'Beklemede',
  upcoming: 'Yakında',
  active: 'Aktif',
  completed: 'Tamamlandı',
  cancelled: 'İptal',
};

const STATUS_COLORS: Record<ReservationStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  upcoming: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  completed: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

// The "Tümü" view groups reservations under one heading per status, in this
// order — so Yakında, Aktif etc. each get their own section.
const GROUP_ORDER: ReservationStatus[] = [
  'active',
  'upcoming',
  'completed',
  'pending',
  'cancelled',
];

export function ReservationsListPage() {
  const { profile } = useAuth();
  const [reservations, setReservations] = useState<ReservationWithRefs[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());
  /** reservation_id → total collected (active payments) — drives the
      "Kısmi / tam / fazladan Ödeme Alındı" badge on each card. */
  const [paidMap, setPaidMap] = useState<Map<string, number>>(() => new Map());
  // 'CHECKOUT_TODAY' is a virtual filter — it cuts across statuses and shows
  // any reservation whose stay_end is on today's Istanbul calendar date.
  // Cancelled stays are excluded — "bugün çıkacaklar" is a reception-desk
  // view that should only highlight guests who are actually leaving.
  const [filter, setFilter] = useState<
    'ALL' | 'CHECKOUT_TODAY' | 'CHECKOUT_TOMORROW' | ReservationStatus
  >('ALL');
  /** Free-text search over guest name. Applied before status filtering. */
  const [search, setSearch] = useState('');

  useEffect(() => {
    listReservations()
      .then(setReservations)
      .catch((e) => setError(e?.message ?? 'Rezervasyonlar yüklenemedi'));
    // Best-effort: staff directory powers the "Oluşturan: X" line.
    loadStaffDirectory().then(setStaffMap).catch(() => {});
    loadReservationsWithPayments().then(setPaidMap).catch(() => {});
  }, []);

  const canCreate = profile && can(profile.role, 'reservation:create');
  // Teknik Personel has no finance access — hide reservation tutar + the tahsilat
  // (Ödeme) badge, and don't rely on payment data it can't read (migration 121).
  const isTeknik = isTeknikPersonel(profile?.role);

  // Name search — applied before status filtering/grouping so it works in both
  // the "Tümü" grouped view and the single-status views.
  const searched = useMemo(() => {
    if (!reservations) return null;
    const q = search.trim().toLocaleLowerCase('tr');
    if (!q) return reservations;
    return reservations.filter((r) =>
      (r.guest?.full_name ?? '').toLocaleLowerCase('tr').includes(q),
    );
  }, [reservations, search]);

  // The flat list for a specific status filter — also drives the empty check.
  const filtered = useMemo(() => {
    if (!searched) return [];
    if (filter === 'ALL') return searched;
    if (filter === 'CHECKOUT_TODAY') {
      const today = istanbulToday();
      return searched.filter(
        (r) => r.stay_end.slice(0, 10) === today && r.status !== 'cancelled',
      );
    }
    if (filter === 'CHECKOUT_TOMORROW') {
      const tomorrow = istanbulTomorrow();
      return searched.filter(
        (r) => r.stay_end.slice(0, 10) === tomorrow && r.status !== 'cancelled',
      );
    }
    return searched.filter((r) => r.status === filter);
  }, [searched, filter]);

  // The "Tümü" view: one section per status, plus a virtual "Bugün Çıkış"
  // section inserted right after Aktif (rezervasyonlar bugün çıkıyor — same
  // semantic as the standalone CHECKOUT_TODAY filter chip).
  const groups = useMemo(() => {
    if (!searched) return [];
    const today = istanbulToday();
    const tomorrow = istanbulTomorrow();
    const checkoutTodayItems = searched
      .filter((r) => r.stay_end.slice(0, 10) === today && r.status !== 'cancelled')
      .sort((a, b) => a.stay_end.localeCompare(b.stay_end));
    const checkoutTomorrowItems = searched
      .filter((r) => r.stay_end.slice(0, 10) === tomorrow && r.status !== 'cancelled')
      .sort((a, b) => a.stay_end.localeCompare(b.stay_end));

    const byStatus = GROUP_ORDER.map((status) => ({
      key: status as string,
      label: STATUS_LABELS[status],
      items: searched
        .filter((r) => r.status === status)
        .sort((a, b) =>
          status === 'upcoming'
            ? a.stay_start.localeCompare(b.stay_start)
            : b.stay_start.localeCompare(a.stay_start),
        ),
    }));

    const result: { key: string; label: string; items: ReservationWithRefs[] }[] = [];
    for (const g of byStatus) {
      result.push(g);
      // Insert Bugün Çıkış right after the Aktif section so the receptionist
      // sees today's departures next to the live stays.
      if (g.key === 'active' && checkoutTodayItems.length > 0) {
        result.push({
          key: 'checkout_today',
          label: 'Bugün Çıkış',
          items: checkoutTodayItems,
        });
      }
      // Yarın Çıkış follows Bugün Çıkış so departures read today → tomorrow.
      if (g.key === 'active' && checkoutTomorrowItems.length > 0) {
        result.push({
          key: 'checkout_tomorrow',
          label: 'Yarın Çıkış',
          items: checkoutTomorrowItems,
        });
      }
    }
    return result.filter((g) => g.items.length > 0);
  }, [searched]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Rezervasyonlar
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Tüm rezervasyonların listesi
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <ReservationsViewTabs />
          {canCreate && (
            <Link to="/reservations/new">
              <Button>+ Yeni</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          ['ALL', 'active', 'CHECKOUT_TODAY', 'CHECKOUT_TOMORROW', 'upcoming', 'completed', 'pending', 'cancelled'] as const
        ).map((f) => {
          const isActive = filter === f;
          const label =
            f === 'ALL'
              ? 'Tümü'
              : f === 'CHECKOUT_TODAY'
                ? 'Bugün Çıkış'
                : f === 'CHECKOUT_TOMORROW'
                  ? 'Yarın Çıkış'
                  : STATUS_LABELS[f];
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                isActive
                  ? 'rounded-full border border-emerald-600 bg-emerald-600 px-4 py-1 text-sm font-medium text-white'
                  : 'rounded-full border border-stone-300 px-4 py-1 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800'
              }
            >
              {label}
            </button>
          );
        })}
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="İsimle ara…"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 focus:border-emerald-500 focus:outline-none dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
      />

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!reservations && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {reservations && filtered.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Bu filtreyle eşleşen rezervasyon yok.
          </p>
        </Card>
      )}

      {reservations &&
        filtered.length > 0 &&
        (filter === 'ALL' ? (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.key} className="space-y-2">
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                  {g.label}
                  <span className="ml-2 text-sm font-normal text-stone-500 dark:text-stone-400">
                    {g.items.length}
                  </span>
                </h2>
                <ReservationRows
                  items={g.items}
                  staffMap={staffMap}
                  paidMap={paidMap}
                  showAmounts={!isTeknik}
                />
              </section>
            ))}
          </div>
        ) : (
          <ReservationRows
            items={filtered}
            staffMap={staffMap}
            paidMap={paidMap}
            showAmounts={!isTeknik}
          />
        ))}
    </div>
  );
}

/** The mobile cards + tablet table for a list of reservations. */
function ReservationRows({
  items,
  staffMap,
  paidMap,
  showAmounts,
}: {
  items: ReservationWithRefs[];
  staffMap: Map<string, string>;
  paidMap: Map<string, number>;
  showAmounts: boolean;
}) {
  return (
    <>
      {/* Mobile: stacked cards */}
      <div className="space-y-2 sm:hidden">
        {items.map((r) => (
          <Link
            key={r.id}
            to={`/reservations/${r.id}`}
            className="block rounded-lg border border-stone-200 bg-white p-3 transition-colors hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800/50"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 font-medium text-stone-900 dark:text-stone-100">
                {r.guest?.full_name ?? '—'}
                {r.stay_type === 'DAYUSE' && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    Güniçi
                  </span>
                )}
                {r.note && (
                  <span
                    title={r.note}
                    className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  >
                    Not
                  </span>
                )}
              </p>
              <span
                className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[r.status]}`}
              >
                {STATUS_LABELS[r.status]}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-stone-600 dark:text-stone-300">
              {reservationPropertyLabel(r)} · {reservationUnitLabel(r)}
            </p>
            <p className="mt-1 flex items-center justify-between gap-2 text-xs text-stone-700 dark:text-stone-300">
              <span className="flex flex-col gap-0.5">
                {r.stay_type === 'DAYUSE' ? (
                  <span>
                    {`${formatDate(r.stay_start)} · ${formatTime(r.stay_start)}–${formatTime(r.stay_end)}`}
                  </span>
                ) : (
                  <>
                    <span>
                      {formatDate(r.stay_start)} {formatTime(r.stay_start)} Giriş
                    </span>
                    <span>
                      {formatDate(r.stay_end)} {checkoutTimeLabel(r.late_checkout_hours)} Çıkış
                    </span>
                  </>
                )}
              </span>
              {showAmounts && (
                <span className="flex flex-col items-end gap-0.5">
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {formatTRY(Number(r.total_amount))}
                  </span>
                  {(() => {
                    const badge = paymentBadge(
                      paidMap.get(r.id) ?? 0,
                      Number(r.total_amount),
                    );
                    return <span className={badge.className}>{badge.label}</span>;
                  })()}
                </span>
              )}
            </p>
            {staffMap.get(r.created_by) && (
              <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">
                Oluşturan: {staffMap.get(r.created_by)}
              </p>
            )}
          </Link>
        ))}
      </div>

      {/* Tablet+ : table */}
      <Card className="hidden p-0 sm:block">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-300 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
              <tr>
                <th className="px-6 py-3 font-medium">Misafir</th>
                <th className="px-6 py-3 font-medium">Mülk / Birim</th>
                <th className="px-6 py-3 font-medium">Tarih</th>
                {showAmounts && <th className="px-6 py-3 font-medium">Tutar</th>}
                <th className="px-6 py-3 font-medium">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
              {items.map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50">
                  <td className="px-6 py-3 font-medium text-stone-900 dark:text-stone-100">
                    <Link to={`/reservations/${r.id}`} className="block">
                      {r.guest?.full_name ?? '—'}
                      {r.stay_type === 'DAYUSE' && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          Güniçi
                        </span>
                      )}
                      {r.note && (
                        <span
                          title={r.note}
                          className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                        >
                          Not
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                    <div className="text-base font-semibold text-stone-900 dark:text-stone-100">
                      {reservationUnitLabel(r)}
                    </div>
                    <div className="text-xs text-stone-600 dark:text-stone-400">
                      {reservationPropertyLabel(r)}
                    </div>
                  </td>
                  <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                    {r.stay_type === 'DAYUSE' ? (
                      <>
                        <div>{formatDate(r.stay_start)}</div>
                        <div className="text-xs text-stone-600 dark:text-stone-400">
                          {formatTime(r.stay_start)}–{formatTime(r.stay_end)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div>{formatDate(r.stay_start)} · Giriş {formatTime(r.stay_start)}</div>
                        <div className="text-xs text-stone-600 dark:text-stone-400">
                          → {formatDate(r.stay_end)} · Çıkış {checkoutTimeLabel(r.late_checkout_hours)}
                        </div>
                      </>
                    )}
                  </td>
                  {showAmounts && (
                    <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                      {formatTRY(Number(r.total_amount))}
                    </td>
                  )}
                  <td className="px-6 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[r.status]}`}>
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
