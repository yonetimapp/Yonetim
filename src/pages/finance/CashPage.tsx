import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can } from '@/lib/rbac';
import {
  listCashAccounts,
  listCashTransactions,
  deleteCashTransaction,
  balanceOf,
  type CashAccount,
  type CashTransaction,
  type CashTransactionWithRefs,
} from '@/lib/queries/cashAccounts';
import { deletePaymentCollection } from '@/lib/queries/payments';
import { deleteAdvance } from '@/lib/queries/staff';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CashTxModal } from './CashTxModal';
import { FinanceTabs } from './FinanceTabs';
import { formatTRY, formatDate, istanbulToday, cn, tPaymentMethods } from '@/lib/utils';
import { exportRowsToCsv } from '@/lib/csvExport';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';
import { listProperties, sortHotelsFirst, type Property } from '@/lib/queries/properties';
import { Select } from '@/components/ui/Select';
import { DateInput } from '@/components/ui/DateInput';
import type { TxDirection } from '@/types/database';

const DIRECTION_LABEL: Record<TxDirection, string> = {
  IN: 'Gelir',
  OUT: 'Gider',
};

// tPaymentMethods is now in @/lib/utils so the cari ledger can use it too.

const timeFmt = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'short' });
function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

// A transaction's anchor day for the date-based kasa views. For a guest payment
// (Misafir ödemesi) this is the reservation's check-in = "aktif olma" date
// (payment_collection.reservation.stay_start), so its ciro lands on the day the
// stay became active rather than the day the cash happened to be collected.
// Manual / expense entries (no collection) fall back to their own created_at.
function txDateBasis(t: CashTransactionWithRefs): string {
  return t.payment_collection?.reservation?.stay_start ?? t.created_at;
}

/**
 * The single general kasa (migration 036). One cash pot for the whole
 * business — no per-property accounts. Shows the running balance and every
 * cash movement: guest payments flow in automatically, manual entries via
 * "İşlem Ekle".
 */
export function CashPage() {
  const { profile, user } = useAuth();

  const [account, setAccount] = useState<CashAccount | null>(null);
  // Every kasa the user can see — one per region. >1 only for an all-region
  // user, which is what surfaces the kasa switcher.
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [switchingKasa, setSwitchingKasa] = useState(false);
  const [transactions, setTransactions] = useState<CashTransactionWithRefs[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTxModal, setShowTxModal] = useState(false);
  /** Gelir / Gider filter for the Hareketler list. */
  const [directionFilter, setDirectionFilter] = useState<'ALL' | TxDirection>('ALL');
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());
  /** Top-level view mode — Genel kasa (default), Gün Bazlı (time-window cut)
      or Mülk Bazlı (single-property cut). The bottom direction filter stacks. */
  const [kasaView, setKasaView] = useState<'general' | 'today' | 'property' | 'calendar'>(
    'general',
  );
  /** Sub-range for the Gün Bazlı view: Bugün / Hafta / Ay. */
  const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month'>('day');
  /** Selected Takvim date range (ISO, inclusive). Both default to today, so the
      view opens on a single day and can be widened into a range. */
  const [calendarStart, setCalendarStart] = useState<string>(() => istanbulToday());
  const [calendarEnd, setCalendarEnd] = useState<string>(() => istanbulToday());
  /** Selected property id when kasaView === 'property'. */
  const [propertyFilter, setPropertyFilter] = useState<string>('');
  /** Selected day (ISO) for the Mülk Bazlı view — used only when range is Takvim. */
  const [propertyDate, setPropertyDate] = useState<string>(() => istanbulToday());
  /** Sub-range for the Mülk Bazlı view: Bugün / Hafta / Ay / Takvim. */
  const [propertyRange, setPropertyRange] = useState<'day' | 'week' | 'month' | 'calendar'>(
    'day',
  );
  const [properties, setProperties] = useState<Property[]>([]);

  // Per-row tx deletion (SUPER_ADMIN only — see migration 015).
  const [txToDelete, setTxToDelete] = useState<CashTransaction | null>(null);
  const [txDeleteError, setTxDeleteError] = useState<string | null>(null);
  const [txDeleting, setTxDeleting] = useState(false);

  const canWrite = Boolean(profile && can(profile.role, 'finance:write'));
  const canDeleteTx = profile?.role === 'SUPER_ADMIN';

  // created_at is UTC; we need the Istanbul calendar day for the "Gün Bazlı"
  // filter. Shift +3h then slice the YYYY-MM-DD prefix.
  const toIstanbulDate = (iso: string): string => {
    const d = new Date(iso);
    return new Date(d.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };

  // Monday of the current Istanbul week (week starts Monday per TR convention).
  const istanbulMondayOfWeek = (): string => {
    const today = istanbulToday();
    const d = new Date(today + 'T00:00:00Z');
    // Date.getUTCDay() — 0=Sun..6=Sat. Distance back to Monday: (day+6)%7.
    const offset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };

  // Takvim range, normalised so the earlier date is always the low bound (the
  // user may pick the end before the start). String compare on 'YYYY-MM-DD' is
  // chronological.
  const calendarRange = useMemo(
    () =>
      calendarStart <= calendarEnd
        ? { lo: calendarStart, hi: calendarEnd }
        : { lo: calendarEnd, hi: calendarStart },
    [calendarStart, calendarEnd],
  );

  // Apply the view-mode cut first (Genel / Gün / Mülk), then the direction
  // chip (Gelir / Gider / Tümü). Balance + totals at the top reflect the
  // view cut only (so flipping Gelir vs Gider doesn't change the headline
  // figure — same UX as before).
  const viewTransactions = useMemo(() => {
    if (kasaView === 'today') {
      const today = istanbulToday();
      const monday = istanbulMondayOfWeek();
      const monthPrefix = today.slice(0, 7);
      // All Gün Bazlı ranges anchor on each tx's date (see txDateBasis): guest
      // payments on the reservation's aktif olma / check-in date, manual entries
      // on created_at. Bugün is the Istanbul calendar day (matches Takvim for
      // today), not a rolling 24h window.
      return transactions.filter((t) => {
        const txDate = toIstanbulDate(txDateBasis(t));
        if (timeRange === 'day') return txDate === today;
        if (timeRange === 'week') return txDate >= monday && txDate <= today;
        return txDate.slice(0, 7) === monthPrefix;
      });
    }
    if (kasaView === 'calendar') {
      // Ciro for the chosen date range (inclusive), anchored on each tx's date
      // (see txDateBasis): guest payments on the reservation's aktif olma date,
      // manual entries on created_at.
      return transactions.filter((t) => {
        const d = toIstanbulDate(txDateBasis(t));
        return d >= calendarRange.lo && d <= calendarRange.hi;
      });
    }
    if (kasaView === 'property') {
      if (!propertyFilter) return [];
      // One property's movements over the chosen range — same Bugün/Hafta/Ay
      // logic as Gün Bazlı (txDateBasis: aktif olma date for guest payments),
      // or one picked day for Takvim.
      const today = istanbulToday();
      const monday = istanbulMondayOfWeek();
      const monthPrefix = today.slice(0, 7);
      return transactions.filter((t) => {
        if (t.property_id !== propertyFilter) return false;
        const txDate = toIstanbulDate(txDateBasis(t));
        if (propertyRange === 'calendar') return txDate === propertyDate;
        if (propertyRange === 'day') return txDate === today;
        if (propertyRange === 'week') return txDate >= monday && txDate <= today;
        return txDate.slice(0, 7) === monthPrefix;
      });
    }
    return transactions;
  }, [
    transactions,
    kasaView,
    propertyFilter,
    propertyDate,
    propertyRange,
    timeRange,
    calendarRange,
  ]);

  const filteredTransactions = useMemo(() => {
    if (directionFilter === 'ALL') return viewTransactions;
    return viewTransactions.filter((t) => t.direction === directionFilter);
  }, [viewTransactions, directionFilter]);

  const gelirCount = useMemo(
    () => viewTransactions.filter((t) => t.direction === 'IN').length,
    [viewTransactions],
  );
  const giderCount = useMemo(
    () => viewTransactions.filter((t) => t.direction === 'OUT').length,
    [viewTransactions],
  );
  const viewIncome = useMemo(
    () =>
      viewTransactions
        .filter((t) => t.direction === 'IN')
        .reduce((s, t) => s + Number(t.amount), 0),
    [viewTransactions],
  );
  const viewOutgo = useMemo(
    () =>
      viewTransactions
        .filter((t) => t.direction === 'OUT')
        .reduce((s, t) => s + Number(t.amount), 0),
    [viewTransactions],
  );

  useEffect(() => {
    setError(null);
    (async () => {
      try {
        const accs = await listCashAccounts();
        if (accs.length === 0) {
          setError('Kasa bulunamadı. Kasa migration\'ları uygulanmalı.');
          return;
        }
        setAccounts(accs);
        const a = accs[0];
        setAccount(a);
        setTransactions(await listCashTransactions(a.id));
        loadStaffDirectory().then(setStaffMap).catch(() => {});
        listProperties().then(setProperties).catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Yüklenemedi');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Switch which region's kasa the page shows. Reloads that kasa's movements;
  // balance + all views recompute from the new set.
  const selectKasa = async (acc: CashAccount) => {
    if (acc.id === account?.id) return;
    setSwitchingKasa(true);
    setError(null);
    try {
      setAccount(acc);
      setTransactions(await listCashTransactions(acc.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kasa yüklenemedi');
    } finally {
      setSwitchingKasa(false);
    }
  };

  const handleDeleteTx = async () => {
    if (!txToDelete) return;
    setTxDeleting(true);
    setTxDeleteError(null);
    try {
      if (txToDelete.payment_collection_id) {
        // Cascade path: deleting the payment_collection removes the linked
        // ledger PAYMENT entry AND this cash_transactions row in one shot
        // (FK ON DELETE CASCADE — migration 016).
        await deletePaymentCollection(txToDelete.payment_collection_id);
      } else if (txToDelete.ref_type === 'staff_advance' && txToDelete.ref_id) {
        // Avans hareketi → delete the avans AND this kasa hareketi atomically,
        // so the kasa and the personel Avans Geçmişi stay in sync (migration 122).
        await deleteAdvance(txToDelete.ref_id);
      } else {
        // Manual cash entry — delete just this row.
        await deleteCashTransaction(txToDelete.id);
      }
      setTransactions((prev) => prev.filter((t) => t.id !== txToDelete.id));
      setTxToDelete(null);
      setTxDeleting(false);
    } catch (e) {
      setTxDeleteError(e instanceof Error ? e.message : 'Silme başarısız');
      setTxDeleting(false);
    }
  };

  // Overall kasa balance — always from the full set, never from the view cut.
  const balance = balanceOf(transactions);
  // Balance scoped to the current view (today only / one mülk only). Used by
  // the headline figure inside Bugün / Mülk modes.
  const viewBalance = viewIncome - viewOutgo;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Kasa
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {account?.name ?? 'İşletmenin nakit kasası'}
          </p>
        </div>
        <FinanceTabs />
      </div>

      {/* Kasa switcher — only when the user can see more than one kasa (an
          all-region user). A region-scoped manager sees one kasa, no switcher. */}
      {accounts.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {accounts.map((acc) => (
            <button
              key={acc.id}
              type="button"
              onClick={() => selectKasa(acc)}
              disabled={switchingKasa}
              className={cn(
                'rounded-full border px-4 py-1 text-sm font-medium transition-colors disabled:opacity-60',
                acc.id === account?.id
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
              )}
            >
              {acc.name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {loading && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {account && (
        <>
          {/* Balance card */}
          <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-stone-600 dark:text-stone-300">
                Güncel Bakiye
              </p>
              <p
                className={
                  balance >= 0
                    ? 'mt-1 text-3xl font-semibold text-emerald-600 dark:text-emerald-400'
                    : 'mt-1 text-3xl font-semibold text-red-600 dark:text-red-400'
                }
              >
                {formatTRY(balance)}
              </p>
              <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                {transactions.length} hareket
              </p>
            </div>
            {canWrite && (
              <Button className="w-full sm:w-auto" onClick={() => setShowTxModal(true)}>
                + İşlem Ekle
              </Button>
            )}
          </Card>

          {/* View-mode buttons — Genel / Gün Bazlı / Mülk Bazlı. */}
          <div className="flex flex-wrap gap-2">
            {(['general', 'today', 'property', 'calendar'] as const).map((v) => {
              const label =
                v === 'general'
                  ? 'Genel Kasa'
                  : v === 'today'
                    ? 'Gün Bazlı'
                    : v === 'property'
                      ? 'Mülk Bazlı'
                      : 'Takvim';
              const isActive = kasaView === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setKasaView(v);
                    // Reset property pick when leaving property mode so a
                    // stale selection doesn't bleed into a future Mülk Bazlı
                    // session.
                    if (v !== 'property') setPropertyFilter('');
                  }}
                  className={cn(
                    'rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-emerald-600 bg-emerald-600 text-white'
                      : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Gün Bazlı sub-range: Bugün / Hafta / Ay. */}
          {kasaView === 'today' && (
            <div className="flex flex-wrap gap-2">
              {(['day', 'week', 'month'] as const).map((r) => {
                const label = r === 'day' ? 'Bugün' : r === 'week' ? 'Hafta' : 'Ay';
                const isActive = timeRange === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setTimeRange(r)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                      isActive
                        ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                        : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {kasaView === 'property' && (
            <Card className="space-y-4">
              <Select
                label="Mülk"
                name="cash_property_filter"
                value={propertyFilter}
                onChange={setPropertyFilter}
                options={[
                  { value: '', label: 'Mülk seçin' },
                  ...sortHotelsFirst(properties).map((p) => ({ value: p.id, label: p.name })),
                ]}
                searchable
              />
              {propertyFilter && (
                <>
                  <div className="flex flex-wrap gap-2">
                    {(['day', 'week', 'month', 'calendar'] as const).map((r) => {
                      const label =
                        r === 'day'
                          ? 'Bugün'
                          : r === 'week'
                            ? 'Hafta'
                            : r === 'month'
                              ? 'Ay'
                              : 'Takvim';
                      const isActive = propertyRange === r;
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setPropertyRange(r)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                            isActive
                              ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                              : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {propertyRange === 'calendar' && (
                    <DateInput
                      label="Gün seçin"
                      name="cash_property_date"
                      value={propertyDate}
                      onChange={(iso) => iso && setPropertyDate(iso)}
                      max={istanbulToday()}
                    />
                  )}
                </>
              )}
            </Card>
          )}

          {kasaView === 'calendar' && (
            <Card>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DateInput
                  label="Başlangıç"
                  name="cash_calendar_start"
                  value={calendarStart}
                  onChange={(iso) => iso && setCalendarStart(iso)}
                  max={istanbulToday()}
                />
                <DateInput
                  label="Bitiş"
                  name="cash_calendar_end"
                  value={calendarEnd}
                  onChange={(iso) => iso && setCalendarEnd(iso)}
                  max={istanbulToday()}
                />
              </div>
            </Card>
          )}

          {/* View summary — gün, property and calendar modes show their own headline. */}
          {kasaView === 'today' && (
            <Card className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-stone-600 dark:text-stone-300">
                {timeRange === 'day'
                  ? 'Bugünün Cirosu'
                  : timeRange === 'week'
                    ? 'Bu Haftanın Cirosu'
                    : 'Bu Ayın Cirosu'}
              </p>
              <div className="flex flex-wrap items-baseline gap-4">
                <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                  +{formatTRY(viewIncome)}
                </p>
                <p className="text-2xl font-semibold text-red-600 dark:text-red-400">
                  −{formatTRY(viewOutgo)}
                </p>
                <p className="text-sm text-stone-700 dark:text-stone-300">
                  Net: <strong>{formatTRY(viewBalance)}</strong>
                </p>
              </div>
            </Card>
          )}

          {kasaView === 'property' && propertyFilter && (
            <Card className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-stone-600 dark:text-stone-300">
                {properties.find((p) => p.id === propertyFilter)?.name ?? 'Mülk'} ·{' '}
                {propertyRange === 'calendar'
                  ? formatDate(propertyDate)
                  : propertyRange === 'day'
                    ? 'Bugün'
                    : propertyRange === 'week'
                      ? 'Bu Hafta'
                      : 'Bu Ay'}{' '}
                Cirosu
              </p>
              <div className="flex flex-wrap items-baseline gap-4">
                <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                  +{formatTRY(viewIncome)}
                </p>
                <p className="text-2xl font-semibold text-red-600 dark:text-red-400">
                  −{formatTRY(viewOutgo)}
                </p>
                <p className="text-sm text-stone-700 dark:text-stone-300">
                  Net: <strong>{formatTRY(viewBalance)}</strong>
                </p>
              </div>
            </Card>
          )}

          {kasaView === 'calendar' && (
            <Card className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-stone-600 dark:text-stone-300">
                {calendarRange.lo === calendarRange.hi
                  ? `${formatDate(calendarRange.lo)} Cirosu`
                  : `${formatDate(calendarRange.lo)} – ${formatDate(calendarRange.hi)} Cirosu`}
              </p>
              <div className="flex flex-wrap items-baseline gap-4">
                <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
                  +{formatTRY(viewIncome)}
                </p>
                <p className="text-2xl font-semibold text-red-600 dark:text-red-400">
                  −{formatTRY(viewOutgo)}
                </p>
                <p className="text-sm text-stone-700 dark:text-stone-300">
                  Net: <strong>{formatTRY(viewBalance)}</strong>
                </p>
              </div>
            </Card>
          )}

          {/* Transactions */}
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                Hareketler
              </h2>
              {transactions.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const rows = filteredTransactions.map((t) => ({
                      Tarih: formatDate(t.created_at),
                      Saat: formatTime(t.created_at),
                      Yön: DIRECTION_LABEL[t.direction],
                      Tutar: Number(t.amount).toFixed(2),
                      'Para Birimi': account.currency,
                      Açıklama: tPaymentMethods(t.description),
                      Misafir: t.payment_collection?.reservation?.guest?.full_name ?? '',
                      Tip: t.ref_type ?? '',
                    }));
                    exportRowsToCsv(
                      `kasa-${new Date().toISOString().slice(0, 10)}`,
                      rows,
                      [
                        { key: 'Tarih', label: 'Tarih' },
                        { key: 'Saat', label: 'Saat' },
                        { key: 'Yön', label: 'Yön' },
                        { key: 'Tutar', label: 'Tutar' },
                        { key: 'Para Birimi', label: 'Para Birimi' },
                        { key: 'Açıklama', label: 'Açıklama' },
                        { key: 'Misafir', label: 'Misafir' },
                        { key: 'Tip', label: 'Tip' },
                      ],
                    );
                  }}
                >
                  CSV İndir
                </Button>
              )}
            </div>

            {transactions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {(['ALL', 'IN', 'OUT'] as const).map((f) => {
                  const isActive = directionFilter === f;
                  const count =
                    f === 'ALL' ? viewTransactions.length : f === 'IN' ? gelirCount : giderCount;
                  const label = f === 'ALL' ? 'Tümü' : DIRECTION_LABEL[f];
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setDirectionFilter(f)}
                      className={
                        isActive
                          ? 'rounded-full bg-stone-900 px-4 py-1 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900'
                          : 'rounded-full border border-stone-300 px-4 py-1 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800'
                      }
                    >
                      {label} <span className="ml-1 text-xs opacity-70">({count})</span>
                    </button>
                  );
                })}
              </div>
            )}

            {transactions.length === 0 ? (
              <Card>
                <p className="text-center text-sm text-stone-600 dark:text-stone-300">
                  Henüz hareket yok.
                  {canWrite && ' Sağ üstteki “İşlem Ekle” butonu ile başlayın.'}
                </p>
              </Card>
            ) : filteredTransactions.length === 0 ? (
              <Card>
                <p className="text-center text-sm text-stone-600 dark:text-stone-300">
                  Bu filtre için kayıt yok.
                </p>
              </Card>
            ) : (
              <>
                {/* Mobile: stacked cards */}
                <div className="space-y-2 sm:hidden">
                  {filteredTransactions.map((t) => {
                    const positive = t.direction === 'IN';
                    return (
                      <div
                        key={t.id}
                        className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={
                                  positive
                                    ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                    : 'rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400'
                                }
                              >
                                {DIRECTION_LABEL[t.direction]}
                              </span>
                            </div>
                            {t.payment_collection?.reservation?.stay_start && (
                              <p className="mt-0.5 text-[11px] font-medium text-stone-700 dark:text-stone-200">
                                Giriş günü:{' '}
                                {formatDate(t.payment_collection.reservation.stay_start)}
                              </p>
                            )}
                            {t.payment_collection?.created_at ? (
                              <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
                                Toplandı: {formatDate(t.payment_collection.created_at)} ·{' '}
                                {formatTime(t.payment_collection.created_at)}
                                <span className="ml-1 text-stone-500 dark:text-stone-400">
                                  · Onaylandı: {formatDate(t.created_at)} ·{' '}
                                  {formatTime(t.created_at)}
                                </span>
                              </p>
                            ) : (
                              <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
                                {formatDate(t.created_at)} · {formatTime(t.created_at)}
                              </p>
                            )}
                            <p className="mt-1 break-words text-sm text-stone-700 dark:text-stone-300">
                              {tPaymentMethods(t.description)}
                            </p>
                            {t.deleted_property_name && (
                              <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                                silinmiş olan {t.deleted_property_name}
                              </p>
                            )}
                            {t.payment_collection?.reservation && (
                              <Link
                                to={`/reservations/${t.payment_collection.reservation.id}`}
                                className="mt-0.5 inline-block text-xs text-emerald-600 hover:underline dark:text-emerald-500"
                              >
                                {t.payment_collection.reservation.guest?.full_name ?? 'Misafir'}
                                {t.payment_collection.reservation.unit?.name
                                  ? ` · ${t.payment_collection.reservation.unit.name}`
                                  : ''}
                              </Link>
                            )}
                            {(() => {
                              const uid = t.submitted_by ?? t.created_by;
                              const name = uid ? staffMap.get(uid) : undefined;
                              if (!name) return null;
                              return (
                                <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
                                  Oluşturan: {name}
                                </p>
                              );
                            })()}
                          </div>
                          <p
                            className={
                              positive
                                ? 'shrink-0 font-semibold text-emerald-600 dark:text-emerald-400'
                                : 'shrink-0 font-semibold text-red-600 dark:text-red-400'
                            }
                          >
                            {positive ? '+' : '−'}
                            {formatTRY(Number(t.amount))}
                          </p>
                        </div>
                        {canDeleteTx && (
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => {
                                setTxDeleteError(null);
                                setTxToDelete(t);
                              }}
                              className="text-xs text-red-600 hover:underline dark:text-red-400"
                            >
                              Sil
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Tablet+ : table */}
                <Card className="hidden p-0 sm:block">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-stone-300 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
                        <tr>
                          <th className="px-6 py-3 font-medium">Tarih</th>
                          <th className="px-6 py-3 font-medium">Yön</th>
                          <th className="px-6 py-3 font-medium">Açıklama</th>
                          <th className="px-6 py-3 text-right font-medium">Tutar</th>
                          {canDeleteTx && <th className="px-6 py-3" aria-label="Sil" />}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
                        {filteredTransactions.map((t) => {
                          const positive = t.direction === 'IN';
                          return (
                            <tr key={t.id}>
                              <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                                {t.payment_collection?.reservation?.stay_start && (
                                  <div className="text-xs font-medium text-stone-700 dark:text-stone-200">
                                    Giriş günü:{' '}
                                    {formatDate(t.payment_collection.reservation.stay_start)}
                                  </div>
                                )}
                                {t.payment_collection?.created_at ? (
                                  <>
                                    <div className="text-xs text-stone-500 dark:text-stone-400">
                                      Toplandı: {formatDate(t.payment_collection.created_at)}{' '}
                                      {formatTime(t.payment_collection.created_at)}
                                    </div>
                                    <div className="text-xs text-stone-500 dark:text-stone-400">
                                      Onaylandı: {formatDate(t.created_at)}{' '}
                                      {formatTime(t.created_at)}
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <div>{formatDate(t.created_at)}</div>
                                    <div className="text-xs text-stone-600 dark:text-stone-300">
                                      {formatTime(t.created_at)}
                                    </div>
                                  </>
                                )}
                                {(() => {
                                  const uid = t.submitted_by ?? t.created_by;
                                  const name = uid ? staffMap.get(uid) : undefined;
                                  if (!name) return null;
                                  return (
                                    <div className="text-xs text-stone-500 dark:text-stone-400">
                                      Oluşturan: {name}
                                    </div>
                                  );
                                })()}
                              </td>
                              <td className="px-6 py-3">
                                <span
                                  className={
                                    positive
                                      ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                      : 'rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400'
                                  }
                                >
                                  {DIRECTION_LABEL[t.direction]}
                                </span>
                              </td>
                              <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                                <div>{tPaymentMethods(t.description)}</div>
                                {t.deleted_property_name && (
                                  <div className="text-xs text-amber-700 dark:text-amber-400">
                                    silinmiş olan {t.deleted_property_name}
                                  </div>
                                )}
                                {t.payment_collection?.reservation && (
                                  <Link
                                    to={`/reservations/${t.payment_collection.reservation.id}`}
                                    className="text-xs text-emerald-600 hover:underline dark:text-emerald-500"
                                  >
                                    {t.payment_collection.reservation.guest?.full_name ?? 'Misafir'}
                                    {t.payment_collection.reservation.unit?.name
                                      ? ` · ${t.payment_collection.reservation.unit.name}`
                                      : ''}
                                  </Link>
                                )}
                              </td>
                              <td
                                className={
                                  positive
                                    ? 'px-6 py-3 text-right font-semibold text-emerald-600 dark:text-emerald-400'
                                    : 'px-6 py-3 text-right font-semibold text-red-600 dark:text-red-400'
                                }
                              >
                                {positive ? '+' : '−'}
                                {formatTRY(Number(t.amount))}
                              </td>
                              {canDeleteTx && (
                                <td className="px-6 py-3 text-right">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setTxDeleteError(null);
                                      setTxToDelete(t);
                                    }}
                                    aria-label="Hareketi sil"
                                    className="rounded p-1 text-stone-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                                  >
                                    <svg
                                      className="h-4 w-4"
                                      viewBox="0 0 20 20"
                                      fill="none"
                                      aria-hidden="true"
                                    >
                                      <path
                                        d="M5 6h10M8 6V4h4v2M6 6l1 10h6l1-10"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            )}
          </section>
        </>
      )}

      {showTxModal && account && user && (
        <CashTxModal
          accountId={account.id}
          createdByUserId={user.id}
          onClose={() => setShowTxModal(false)}
          onCreated={(tx) => {
            // Only push to the visible list when the server marked the row
            // as approved (SUPER_ADMIN path). PROPERTY_MANAGER submissions
            // come back with approval_status='pending' and belong in the
            // /finance/pending queue — adding them here would inflate the
            // displayed balance until the next refresh.
            if (tx.approval_status === 'approved') {
              setTransactions((prev) => [tx, ...prev]);
            }
            setShowTxModal(false);
          }}
        />
      )}

      <ConfirmDialog
        open={txToDelete !== null}
        title="Hareket silinsin mi?"
        description={
          txToDelete && (
            <>
              <p>
                <strong>
                  {txToDelete.direction === 'IN' ? '+' : '−'}
                  {formatTRY(Number(txToDelete.amount))}
                </strong>
                {txToDelete.description ? ` — ${txToDelete.description}` : ''}
              </p>
              <p className="mt-2">
                Hareket Çöp Kutusu'na taşınır ve oradan geri yüklenebilir. Bakiye yeniden hesaplanır.
              </p>
              {txToDelete.payment_collection_id && (
                <div className="mt-3 rounded border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-700 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200">
                  <p>
                    <strong>Not:</strong> Bu hareket bir tahsilatla bağlantılı.
                    İşlem silindiğinde bağlı{' '}
                    <strong>tahsilat kaydı ve misafirin cari ödemesi</strong>{' '}
                    de otomatik olarak silinir.
                  </p>
                </div>
              )}
            </>
          )
        }
        confirmLabel="Sil"
        destructive
        loading={txDeleting}
        error={txDeleteError}
        onConfirm={handleDeleteTx}
        onCancel={() => {
          setTxToDelete(null);
          setTxDeleteError(null);
        }}
      />
    </div>
  );
}
