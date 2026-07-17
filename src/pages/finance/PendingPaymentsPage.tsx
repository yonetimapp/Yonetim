import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import {
  listUnconfirmedPayments,
  confirmPayment,
  disputePayment,
  type PendingPaymentWithRefs,
} from '@/lib/queries/payments';
import {
  approveCashTransaction,
  approveExpense,
  approveReservationDeletion,
  denyReservationDeletion,
  listPendingCashTransactions,
  listPendingExpenses,
  listPendingReservationDeletions,
  rejectCashTransaction,
  rejectExpense,
  type PendingCashTx,
  type PendingExpense,
  type PendingReservationDeletion,
} from '@/lib/queries/pendingApprovals';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';
import { useRegions } from '@/hooks/useRegions';
import { seesAllRegions as seesAllRegionsOf } from '@/lib/rbac';
import { RegionFilterChips } from '@/components/RegionFilterChips';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FinanceTabs } from './FinanceTabs';
import { cn, formatTRY, formatDate } from '@/lib/utils';
import type { PaymentMethod } from '@/types/database';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Nakit',
  TRANSFER: 'Havale / EFT',
  CARD: 'Kart',
};

type Tab = 'payments' | 'expenses' | 'cash_tx' | 'reservations';

/** Per-action state used to spin the right button + drive the confirm dialog. */
type PendingAction =
  | { type: 'confirm-payment'; item: PendingPaymentWithRefs }
  | { type: 'dispute-payment'; item: PendingPaymentWithRefs }
  | { type: 'approve-expense'; item: PendingExpense }
  | { type: 'reject-expense'; item: PendingExpense }
  | { type: 'approve-cash'; item: PendingCashTx }
  | { type: 'reject-cash'; item: PendingCashTx }
  | { type: 'approve-reservation'; item: PendingReservationDeletion }
  | { type: 'deny-reservation'; item: PendingReservationDeletion };

/**
 * Money subtotal + per-category breakdown for the active sub-tab. Every row is
 * positive and the rows always sum to `total`, so "Ara Toplam" = sum of the
 * lines below it. Breakdown adapts per tab: Tahsilat → ödeme yöntemi
 * (Nakit/Havale/Kart), Gider → kasadan / kasa dışı, Kasa Hareketi → Gelir/Gider.
 */
function tabSubtotal(
  tab: Tab,
  payments: PendingPaymentWithRefs[] | null,
  expenses: PendingExpense[] | null,
  cashTxs: PendingCashTx[] | null,
): { total: number; rows: { label: string; amount: number }[] } {
  const rows: { label: string; amount: number }[] = [];
  let total = 0;
  if (tab === 'payments') {
    const by: Record<PaymentMethod, number> = { CASH: 0, TRANSFER: 0, CARD: 0 };
    for (const p of payments ?? []) by[p.method] += Number(p.amount);
    for (const m of ['CASH', 'TRANSFER', 'CARD'] as PaymentMethod[]) {
      if (by[m] > 0) rows.push({ label: METHOD_LABELS[m], amount: by[m] });
      total += by[m];
    }
  } else if (tab === 'expenses') {
    let kasa = 0;
    let other = 0;
    for (const e of expenses ?? []) {
      if (e.paid_from_kasa) kasa += Number(e.amount);
      else other += Number(e.amount);
    }
    if (kasa > 0) rows.push({ label: 'Kasadan', amount: kasa });
    if (other > 0) rows.push({ label: 'Kasa dışı', amount: other });
    total = kasa + other;
  } else if (tab === 'cash_tx') {
    let inSum = 0;
    let outSum = 0;
    for (const t of cashTxs ?? []) {
      if (t.direction === 'IN') inSum += Number(t.amount);
      else outSum += Number(t.amount);
    }
    if (inSum > 0) rows.push({ label: 'Gelir', amount: inSum });
    if (outSum > 0) rows.push({ label: 'Gider', amount: outSum });
    total = inSum + outSum;
  }
  // 'reservations' (deletion requests) has no money subtotal → total stays 0.
  return { total, rows };
}

/**
 * Three-in-one approval queue. PROPERTY_MANAGER submissions land in the
 * relevant sub-list as 'pending'; SUPER_ADMIN approves or rejects. The
 * payment confirmations tab continues to drive the existing UNCONFIRMED →
 * confirmed flow; expenses + manual kasa entries are new in migration 055.
 */
export function PendingPaymentsPage() {
  const { profile } = useAuth();
  // Reservation deletion requests are resolved by the SUPER_ADMIN (any region)
  // or a region manager for their own region. RLS + the approve/deny RPCs scope
  // a region manager to their own region's requests (migration 097).
  const canResolveDeletions =
    profile?.role === 'SUPER_ADMIN' || profile?.role === 'PROPERTY_MANAGER';
  // Region split for users who see every region: show each region's onaylar
  // separately so the totals never mix. A region-scoped user already sees only
  // their own region (RLS), so they get no switcher. Mirrors auth_all_regions().
  const seesAllRegions = seesAllRegionsOf(profile);
  const { regions, defaultRegion } = useRegions();
  // Empty until the region list loads; the effect below seeds it once.
  const [regionFilter, setRegionFilter] = useState<string>('');
  const [tab, setTab] = useState<Tab>('payments');

  const [payments, setPayments] = useState<PendingPaymentWithRefs[] | null>(null);
  const [expenses, setExpenses] = useState<PendingExpense[] | null>(null);
  const [cashTxs, setCashTxs] = useState<PendingCashTx[] | null>(null);
  const [reservationDeletions, setReservationDeletions] = useState<
    PendingReservationDeletion[] | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());

  const refreshAll = useCallback(() => {
    setLoadError(null);
    Promise.allSettled([
      listUnconfirmedPayments(),
      listPendingExpenses(),
      listPendingCashTransactions(),
      canResolveDeletions
        ? listPendingReservationDeletions()
        : Promise.resolve<PendingReservationDeletion[]>([]),
    ]).then(([p, e, c, r]) => {
      if (p.status === 'fulfilled') setPayments(p.value);
      else setLoadError(p.reason?.message ?? 'Tahsilatlar yüklenemedi');
      if (e.status === 'fulfilled') setExpenses(e.value);
      else setLoadError(e.reason?.message ?? 'Giderler yüklenemedi');
      if (c.status === 'fulfilled') setCashTxs(c.value);
      else setLoadError(c.reason?.message ?? 'Kasa hareketleri yüklenemedi');
      if (r.status === 'fulfilled') setReservationDeletions(r.value);
      else setLoadError(r.reason?.message ?? 'Silme talepleri yüklenemedi');
    });
  }, [canResolveDeletions]);

  useEffect(() => {
    refreshAll();
    // Best-effort: powers the "Oluşturan: X" line on each Tahsilat box.
    loadStaffDirectory().then(setStaffMap).catch(() => {});
  }, [refreshAll]);

  // Open on the default region once the region list arrives. Guarded on the empty
  // regionFilter so it only seeds the initial value, never overrides the user.
  useEffect(() => {
    if (seesAllRegions && !regionFilter && defaultRegion) setRegionFilter(defaultRegion);
  }, [seesAllRegions, regionFilter, defaultRegion]);

  const handleConfirm = async () => {
    if (!pending) return;
    setDialogError(null);
    setInFlight(true);
    try {
      switch (pending.type) {
        case 'confirm-payment':
          await confirmPayment(pending.item.id);
          setPayments((prev) => prev?.filter((p) => p.id !== pending.item.id) ?? prev);
          break;
        case 'dispute-payment':
          await disputePayment(pending.item.id);
          setPayments((prev) => prev?.filter((p) => p.id !== pending.item.id) ?? prev);
          break;
        case 'approve-expense':
          await approveExpense(pending.item.id);
          setExpenses((prev) => prev?.filter((e) => e.id !== pending.item.id) ?? prev);
          break;
        case 'reject-expense':
          await rejectExpense(pending.item.id);
          setExpenses((prev) => prev?.filter((e) => e.id !== pending.item.id) ?? prev);
          break;
        case 'approve-cash':
          await approveCashTransaction(pending.item.id);
          setCashTxs((prev) => prev?.filter((t) => t.id !== pending.item.id) ?? prev);
          break;
        case 'reject-cash':
          await rejectCashTransaction(pending.item.id);
          setCashTxs((prev) => prev?.filter((t) => t.id !== pending.item.id) ?? prev);
          break;
        case 'approve-reservation':
          await approveReservationDeletion(pending.item.id);
          setReservationDeletions(
            (prev) => prev?.filter((r) => r.id !== pending.item.id) ?? prev,
          );
          break;
        case 'deny-reservation':
          await denyReservationDeletion(pending.item.id);
          setReservationDeletions(
            (prev) => prev?.filter((r) => r.id !== pending.item.id) ?? prev,
          );
          break;
      }
      setPending(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'İşlem başarısız');
    } finally {
      setInFlight(false);
    }
  };

  // Narrow each list to the selected region (all-region users only; an empty
  // regionFilter means the region list hasn't loaded, so show everything rather
  // than blank the page).
  //
  // An item with no region of its own — a kasa hareketi whose cash_account embed
  // came back empty, a tahsilat with no mülk — falls back to the DEFAULT region,
  // which is exactly where it landed back when "Genel" meant region IS NULL. That
  // keeps such rows reviewable instead of hiding them from every tab.
  const regionOf = (r: string | null | undefined): string | null => r || defaultRegion;
  const pick = <T,>(arr: T[] | null, region: (x: T) => string | null | undefined): T[] | null => {
    if (!arr || !seesAllRegions || !regionFilter) return arr;
    return arr.filter((x) => regionOf(region(x)) === regionFilter);
  };
  const vPayments = pick(payments, (p) => p.property?.region);
  const vExpenses = pick(expenses, (e) => e.region);
  const vCashTxs = pick(cashTxs, (t) => t.cash_account?.region);
  const vDeletions = pick(reservationDeletions, (d) => d.reservation?.property?.region);

  // Tab badges show the ALL-REGION total per category (the full lists), so an
  // all-region reviewer sees the grand total per tab at a glance. The region
  // switcher below still filters only the displayed list + subtotal — not these
  // counts. (A region-scoped role only has its own region anyway.)
  const counts: Record<Tab, number> = {
    payments: payments?.length ?? 0,
    expenses: expenses?.length ?? 0,
    cash_tx: cashTxs?.length ?? 0,
    reservations: reservationDeletions?.length ?? 0,
  };
  const subtotal = tabSubtotal(tab, vPayments, vExpenses, vCashTxs);
  // Count for the bottom "Toplam X onay" — the SELECTED region's items in the
  // active tab, so it matches the visible list + Ara Toplam. Distinct from the
  // tab badges (counts), which show the all-region total.
  const visibleCount =
    tab === 'payments'
      ? vPayments?.length ?? 0
      : tab === 'expenses'
        ? vExpenses?.length ?? 0
        : tab === 'cash_tx'
          ? vCashTxs?.length ?? 0
          : vDeletions?.length ?? 0;

  // Per-region split for the ACTIVE section only → each region chip shows how
  // many of THIS tab's onaylar belong to it (and the badge hides at 0, so an
  // empty section shows no numbers). The region accessor differs per tab.
  const regionCounts: Record<string, number> = {};
  if (seesAllRegions) {
    const tally = (r: string | null | undefined) => {
      const key = regionOf(r);
      if (key) regionCounts[key] = (regionCounts[key] ?? 0) + 1;
    };
    if (tab === 'payments') (payments ?? []).forEach((p) => tally(p.property?.region));
    else if (tab === 'expenses') (expenses ?? []).forEach((e) => tally(e.region));
    else if (tab === 'cash_tx') (cashTxs ?? []).forEach((t) => tally(t.cash_account?.region));
    else if (tab === 'reservations' && canResolveDeletions)
      (reservationDeletions ?? []).forEach((d) => tally(d.reservation?.property?.region));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Onay Bekleyen İşlemler
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Yönetici onayı bekleyen tahsilatlar, giderler ve kasa hareketleri.
          </p>
        </div>
        <FinanceTabs />
      </div>

      {loadError && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{loadError}</p>
        </Card>
      )}

      <SubTabs
        tab={tab}
        setTab={setTab}
        counts={counts}
        showReservations={canResolveDeletions}
      />

      {/* Region split — keeps each region's onaylar (and their Ara Toplam)
          separate so transactions don't get mixed up. */}
      {seesAllRegions && (
        <RegionFilterChips
          regions={regions.map((r) => r.name)}
          value={regionFilter}
          onChange={setRegionFilter}
          counts={regionCounts}
        />
      )}

      {tab === 'payments' && (
        <PaymentsList
          items={vPayments}
          staffMap={staffMap}
          onConfirm={(it) => {
            setDialogError(null);
            setPending({ type: 'confirm-payment', item: it });
          }}
          onDispute={(it) => {
            setDialogError(null);
            setPending({ type: 'dispute-payment', item: it });
          }}
        />
      )}

      {tab === 'expenses' && (
        <ExpensesList
          items={vExpenses}
          onApprove={(it) => {
            setDialogError(null);
            setPending({ type: 'approve-expense', item: it });
          }}
          onReject={(it) => {
            setDialogError(null);
            setPending({ type: 'reject-expense', item: it });
          }}
        />
      )}

      {tab === 'cash_tx' && (
        <CashTxList
          items={vCashTxs}
          onApprove={(it) => {
            setDialogError(null);
            setPending({ type: 'approve-cash', item: it });
          }}
          onReject={(it) => {
            setDialogError(null);
            setPending({ type: 'reject-cash', item: it });
          }}
        />
      )}

      {tab === 'reservations' && (
        <ReservationDeletionsList
          items={vDeletions}
          onApprove={(it) => {
            setDialogError(null);
            setPending({ type: 'approve-reservation', item: it });
          }}
          onDeny={(it) => {
            setDialogError(null);
            setPending({ type: 'deny-reservation', item: it });
          }}
        />
      )}

      {/* Bottom summary — count (right) + money subtotal with a per-category
          breakdown that sums to "Ara Toplam", for the active sub-tab. */}
      {visibleCount > 0 && (
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Toplam {visibleCount} onay
          </p>
          {subtotal.total > 0 && (
            <div className="text-right">
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Ara Toplam: {formatTRY(subtotal.total)}
              </p>
              {subtotal.rows.map((r) => (
                <p
                  key={r.label}
                  className="mt-0.5 text-xs text-stone-600 dark:text-stone-300"
                >
                  {r.label}: {formatTRY(r.amount)}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending ? actionTitle(pending) : ''}
        description={pending ? actionDescription(pending) : null}
        confirmLabel={pending ? actionConfirmLabel(pending) : 'Onayla'}
        destructive={pending ? isDestructive(pending) : false}
        loading={inFlight}
        error={dialogError}
        onConfirm={handleConfirm}
        onCancel={() => {
          setPending(null);
          setDialogError(null);
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sub-tabs strip — picks between the three queues.
// ----------------------------------------------------------------------------
function SubTabs({
  tab,
  setTab,
  counts,
  showReservations,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: Record<Tab, number>;
  showReservations: boolean;
}) {
  const entries: { value: Tab; label: string }[] = [
    { value: 'payments', label: 'Tahsilat' },
    { value: 'expenses', label: 'Gider' },
    { value: 'cash_tx', label: 'Kasa Hareketi' },
    ...(showReservations
      ? [{ value: 'reservations' as Tab, label: 'Rezervasyonlar' }]
      : []),
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map((e) => (
        <button
          key={e.value}
          type="button"
          onClick={() => setTab(e.value)}
          className={cn(
            'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            tab === e.value
              ? 'bg-emerald-600 text-white'
              : 'border border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
          )}
        >
          {e.label}
          {counts[e.value] > 0 && (
            <span
              className={cn(
                'rounded-full px-1.5 text-xs font-semibold',
                tab === e.value
                  ? 'bg-white/20 text-white'
                  : 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200',
              )}
            >
              {counts[e.value]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Tahsilat list — wraps the existing UNCONFIRMED → confirm/dispute flow.
// ----------------------------------------------------------------------------
function PaymentsList({
  items,
  staffMap,
  onConfirm,
  onDispute,
}: {
  items: PendingPaymentWithRefs[] | null;
  staffMap: Map<string, string>;
  onConfirm: (it: PendingPaymentWithRefs) => void;
  onDispute: (it: PendingPaymentWithRefs) => void;
}) {
  if (items === null) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-stone-600 dark:text-stone-300">
          Onay bekleyen tahsilat yok.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div
          key={it.id}
          className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <Link
                to={`/reservations/${it.reservation_id}`}
                className="font-semibold text-stone-900 hover:underline dark:text-stone-100"
              >
                {it.reservation?.guest?.full_name ?? '—'}
              </Link>
              <p className="mt-0.5 truncate text-xs text-stone-600 dark:text-stone-300">
                {it.property?.name ?? '—'} · {it.reservation?.unit?.name ?? ''}
              </p>
              <p className="mt-1 text-xs text-stone-700 dark:text-stone-300">
                {METHOD_LABELS[it.method]} · {formatDate(it.created_at)}
              </p>
              {staffMap.get(it.collected_by_user_id) && (
                <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">
                  Oluşturan: {staffMap.get(it.collected_by_user_id)}
                </p>
              )}
            </div>
            <p className="font-semibold text-stone-900 dark:text-stone-100">
              {formatTRY(Number(it.amount))}
            </p>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" onClick={() => onConfirm(it)}>
              Onayla
            </Button>
            <Button variant="danger" size="sm" onClick={() => onDispute(it)}>
              İtiraz
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Gider list — new in migration 055.
// ----------------------------------------------------------------------------
function ExpensesList({
  items,
  onApprove,
  onReject,
}: {
  items: PendingExpense[] | null;
  onApprove: (it: PendingExpense) => void;
  onReject: (it: PendingExpense) => void;
}) {
  if (items === null) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-stone-600 dark:text-stone-300">
          Onay bekleyen gider yok.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div
          key={it.id}
          className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-stone-900 dark:text-stone-100">
                {it.category}
              </p>
              <p className="mt-0.5 truncate text-xs text-stone-600 dark:text-stone-300">
                {it.property?.name ?? 'Genel'} · {formatDate(it.expense_date)}
              </p>
              {it.description && (
                <p className="mt-1 text-xs text-stone-700 dark:text-stone-300">
                  {it.description}
                </p>
              )}
              {it.paid_from_kasa && (
                <p className="mt-1 inline-block rounded bg-stone-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                  Kasadan düşülür
                </p>
              )}
            </div>
            <p className="font-semibold text-stone-900 dark:text-stone-100">
              {formatTRY(Number(it.amount))}
            </p>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" onClick={() => onApprove(it)}>
              Onayla
            </Button>
            <Button variant="danger" size="sm" onClick={() => onReject(it)}>
              Reddet
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Kasa hareketi list — manual cash entries awaiting review.
// ----------------------------------------------------------------------------
function CashTxList({
  items,
  onApprove,
  onReject,
}: {
  items: PendingCashTx[] | null;
  onApprove: (it: PendingCashTx) => void;
  onReject: (it: PendingCashTx) => void;
}) {
  if (items === null) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-stone-600 dark:text-stone-300">
          Onay bekleyen kasa hareketi yok.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div
          key={it.id}
          className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-stone-900 dark:text-stone-100">
                {it.direction === 'IN' ? '↓ Gelir' : '↑ Gider'}
              </p>
              <p className="mt-0.5 truncate text-xs text-stone-600 dark:text-stone-300">
                {formatDate(it.created_at)}
              </p>
              {it.description && (
                <p className="mt-1 text-xs text-stone-700 dark:text-stone-300">
                  {it.description}
                </p>
              )}
            </div>
            <p
              className={cn(
                'font-semibold',
                it.direction === 'IN'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-red-700 dark:text-red-400',
              )}
            >
              {it.direction === 'IN' ? '+' : '−'}
              {formatTRY(Number(it.amount))}
            </p>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" onClick={() => onApprove(it)}>
              Onayla
            </Button>
            <Button variant="danger" size="sm" onClick={() => onReject(it)}>
              Reddet
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Rezervasyon silme talepleri — non-admins request a deletion; SUPER_ADMIN
// approves (deletes the reservation) or denies (keeps it). Migration 090.
// ----------------------------------------------------------------------------
function ReservationDeletionsList({
  items,
  onApprove,
  onDeny,
}: {
  items: PendingReservationDeletion[] | null;
  onApprove: (it: PendingReservationDeletion) => void;
  onDeny: (it: PendingReservationDeletion) => void;
}) {
  if (items === null) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-stone-600 dark:text-stone-300">
          Onay bekleyen silme talebi yok.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div
          key={it.id}
          className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
        >
          <div className="min-w-0">
            <Link
              to={`/reservations/${it.reservation_id}`}
              className="font-semibold text-stone-900 hover:underline dark:text-stone-100"
            >
              {it.reservation?.guest?.full_name ?? 'Misafir'}
            </Link>
            <p className="mt-0.5 truncate text-xs text-stone-600 dark:text-stone-300">
              {it.reservation?.property?.name ?? '—'}
              {it.reservation?.unit?.name ? ` · ${it.reservation.unit.name}` : ''}
            </p>
            {it.reservation && (
              <p className="mt-1 text-xs text-stone-700 dark:text-stone-300">
                {formatDate(it.reservation.stay_start)} –{' '}
                {formatDate(it.reservation.stay_end)}
              </p>
            )}
            {it.reason && (
              <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                Sebep: {it.reason}
              </p>
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="danger" size="sm" onClick={() => onApprove(it)}>
              Onayla (Sil)
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onDeny(it)}>
              Reddet
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// ConfirmDialog copy helpers — keeps the JSX above tidy.
// ----------------------------------------------------------------------------
function actionTitle(a: PendingAction): string {
  switch (a.type) {
    case 'confirm-payment':
      return 'Tahsilat onaylansın mı?';
    case 'dispute-payment':
      return 'Tahsilat reddedilsin mi?';
    case 'approve-expense':
      return 'Gider onaylansın mı?';
    case 'reject-expense':
      return 'Gider reddedilsin mi?';
    case 'approve-cash':
      return 'Kasa hareketi onaylansın mı?';
    case 'reject-cash':
      return 'Kasa hareketi reddedilsin mi?';
    case 'approve-reservation':
      return 'Silme talebi onaylansın mı?';
    case 'deny-reservation':
      return 'Silme talebi reddedilsin mi?';
  }
}

function actionConfirmLabel(a: PendingAction): string {
  if (a.type === 'approve-reservation') return 'Sil';
  if (a.type === 'deny-reservation') return 'Reddet';
  return isDestructive(a) ? 'Reddet' : 'Onayla';
}

function isDestructive(a: PendingAction): boolean {
  // approve-reservation deletes the reservation, so it's the destructive one;
  // deny-reservation keeps it (safe).
  return (
    a.type.startsWith('dispute-') ||
    a.type.startsWith('reject-') ||
    a.type === 'approve-reservation'
  );
}

function actionDescription(a: PendingAction): ReactNode {
  switch (a.type) {
    case 'confirm-payment':
      return (
        <p className="text-sm">
          <strong>{a.item.reservation?.guest?.full_name ?? 'Misafir'}</strong> —{' '}
          {METHOD_LABELS[a.item.method]}{' '}
          <strong>{formatTRY(Number(a.item.amount))}</strong>. Onaylandığında
          cari hesap ve nakitse kasa güncellenir.
        </p>
      );
    case 'dispute-payment':
      return (
        <p className="text-sm">
          <strong>{a.item.reservation?.guest?.full_name ?? 'Misafir'}</strong> —{' '}
          {METHOD_LABELS[a.item.method]}{' '}
          <strong>{formatTRY(Number(a.item.amount))}</strong>. Reddedilen
          tahsilat cari hesabı ve kasayı etkilemez.
        </p>
      );
    case 'approve-expense':
      return (
        <p className="text-sm">
          <strong>{a.item.category}</strong> ·{' '}
          <strong>{formatTRY(Number(a.item.amount))}</strong>
          {a.item.paid_from_kasa && ' — onaylandığında kasadan düşülür.'}
        </p>
      );
    case 'reject-expense':
      return (
        <p className="text-sm">
          <strong>{a.item.category}</strong> ·{' '}
          <strong>{formatTRY(Number(a.item.amount))}</strong>. Reddedilen gider
          kasayı etkilemez.
        </p>
      );
    case 'approve-cash':
      return (
        <p className="text-sm">
          {a.item.direction === 'IN' ? 'Gelir' : 'Gider'}:{' '}
          <strong>{formatTRY(Number(a.item.amount))}</strong>. Onaylandığında
          kasa bakiyesine yansır.
        </p>
      );
    case 'reject-cash':
      return (
        <p className="text-sm">
          {a.item.direction === 'IN' ? 'Gelir' : 'Gider'}:{' '}
          <strong>{formatTRY(Number(a.item.amount))}</strong>. Reddedilen
          hareket kasa bakiyesini etkilemez.
        </p>
      );
    case 'approve-reservation':
      return (
        <p className="text-sm">
          <strong>{a.item.reservation?.guest?.full_name ?? 'Misafir'}</strong>{' '}
          rezervasyonu silinir (Çöp Kutusu'na taşınır). Bu işlem silme talebini
          onaylar.
        </p>
      );
    case 'deny-reservation':
      return (
        <p className="text-sm">
          <strong>{a.item.reservation?.guest?.full_name ?? 'Misafir'}</strong> için
          silme talebi reddedilir; rezervasyon olduğu gibi kalır.
        </p>
      );
  }
}
