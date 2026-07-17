import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { baseRole } from '@/lib/rbac';
import {
  listExpenses,
  listRecurringTemplates,
  stopRecurringExpense,
  totalAmount,
  EXPENSE_CATEGORIES,
  type ExpenseWithProperty,
} from '@/lib/queries/expenses';
import { listProperties, sortHotelsFirst, type Property } from '@/lib/queries/properties';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FinanceTabs } from './FinanceTabs';
import { formatTRY, formatDate } from '@/lib/utils';
import { exportRowsToCsv } from '@/lib/csvExport';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';

function currentMonthStr(): string {
  // YYYY-MM in local time
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Filters persist across a round-trip into a gider's edit page (and back) via
 * this module-level cache — it survives the unmount/remount that navigation
 * causes. It resets on a full refresh (the module reloads) and is cleared when
 * the user leaves the Giderler area entirely (see the unmount effect below).
 */
let cachedFilters: {
  expenseType: 'ALL' | 'GENEL' | 'MULK';
  propertyId: string;
  month: string;
  category: string;
} | null = null;

/** A real expense row, or a projected ("Beklenen") recurring one for a future month. */
type DisplayExpense = ExpenseWithProperty & {
  __projected?: boolean;
  /** On a projected row, the real template id to act on (id is overwritten). */
  __templateId?: string;
};

/**
 * True for a düzenli TEMPLATE *and* for a month the cron generated from one.
 * The generator inserts instances with is_recurring=false (only the template
 * carries the flag), so keying the label off is_recurring alone made a gider
 * show "Düzenli" while projected and then lose the label the moment it actually
 * posted — the same gider looking one-off once it became real.
 */
const isRecurringRow = (e: ExpenseWithProperty) =>
  e.is_recurring || e.recurring_source_id != null;

/** True when this expense belonged to a now-deleted mülk ("bağı kopar"):
 *  property_id was nulled but the snapshotted name remains. */
function isOrphanedExpense(e: DisplayExpense): boolean {
  return e.property_id === null && e.deleted_property_name != null;
}

/** Property column label — falls back to "silinmiş olan <isim>" for an expense
 *  whose mülk was deleted, and to "Genel" for a truly property-less expense. */
function expensePropertyLabel(e: DisplayExpense): string {
  if (e.property?.name)
    return e.unit?.name ? `${e.property.name} · ${e.unit.name}` : e.property.name;
  if (e.deleted_property_name) return `silinmiş olan ${e.deleted_property_name}`;
  return 'Genel';
}

export function ExpensesListPage() {
  const { profile } = useAuth();

  const [properties, setProperties] = useState<Property[]>([]);
  /** Gider tipi: ALL (everything), GENEL (property_id null) or MULK (property-tied). */
  const [expenseType, setExpenseType] = useState<'ALL' | 'GENEL' | 'MULK'>(
    () => cachedFilters?.expenseType ?? 'ALL',
  );
  const [propertyId, setPropertyId] = useState(() => cachedFilters?.propertyId ?? '');
  const [month, setMonth] = useState(() => cachedFilters?.month ?? currentMonthStr());
  const [category, setCategory] = useState(() => cachedFilters?.category ?? '');

  const [expenses, setExpenses] = useState<ExpenseWithProperty[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());
  /** Recurring templates — projected into future months as "Beklenen" rows. */
  const [templates, setTemplates] = useState<ExpenseWithProperty[] | null>(null);
  /** "Düzenli'yi durdur" confirmation target (the projected/recurring row). */
  const [stopTarget, setStopTarget] = useState<DisplayExpense | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // YETKILI may *submit* a gider (queues pending), but doesn't have
  // finance:write for edits. Surface the "+ Yeni Gider" button for them too.
  const r = baseRole(profile?.role);
  const canCreateExpense =
    r === 'SUPER_ADMIN' || r === 'PROPERTY_MANAGER' || r === 'YETKILI';
  // Stopping a recurring series is a finance:write action (matches the
  // expenses_update / expenses_delete RLS in migration 064) — not YETKILI.
  const canStopRecurring = r === 'SUPER_ADMIN' || r === 'PROPERTY_MANAGER';

  // Load properties + staff directory once
  useEffect(() => {
    listProperties()
      .then(setProperties)
      .catch((e) => setError(e?.message ?? 'Mülkler yüklenemedi'));
    loadStaffDirectory().then(setStaffMap).catch(() => {});
    listRecurringTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Remember the current filters so a round-trip into a gider keeps them.
  useEffect(() => {
    cachedFilters = { expenseType, propertyId, month, category };
  }, [expenseType, propertyId, month, category]);

  // On leaving the Giderler area (any non-expenses route), forget the filters
  // so returning later starts fresh. Going into a gider edit / + Yeni Gider
  // (both under /finance/expenses) keeps them.
  useEffect(() => {
    return () => {
      if (!window.location.pathname.includes('/finance/expenses')) {
        cachedFilters = null;
      }
    };
  }, []);

  // Refetch whenever filters change
  useEffect(() => {
    setError(null);
    setExpenses(null);
    listExpenses({
      propertyId: expenseType === 'MULK' && propertyId ? propertyId : undefined,
      genelOnly: expenseType === 'GENEL',
      mulkOnly: expenseType === 'MULK' && !propertyId,
      month: month || undefined,
      category: category || undefined,
    })
      .then(setExpenses)
      .catch((e) => setError(e?.message ?? 'Giderler yüklenemedi'));
  }, [expenseType, propertyId, month, category]);

  const giderTipiOptions = [
    { value: 'ALL', label: 'Tümü' },
    { value: 'GENEL', label: 'Genel' },
    { value: 'MULK', label: 'Mülk' },
  ];

  const propertyOptions = useMemo(
    () => [
      { value: '', label: 'Tüm mülkler' },
      ...sortHotelsFirst(properties).map((p) => ({ value: p.id, label: p.name })),
    ],
    [properties],
  );

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Tüm kategoriler' },
      ...EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c })),
    ],
    [],
  );

  // Render Ay as a Select (matches Mülk + Kategori). Native <input type="month">
  // looked over-tall on iOS Safari. Show the last 24 months newest-first, but
  // never list pre-2025 months — there's no data before launch.
  const monthOptions = useMemo(() => {
    const monthFmt = new Intl.DateTimeFormat('tr-TR', {
      month: 'long',
      year: 'numeric',
    });
    const now = new Date();
    const out: { value: string; label: string }[] = [];
    // Next 3 months ahead (newest first) so recurring expenses can be planned.
    for (let i = 3; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      out.push({ value: `${y}-${m}`, label: monthFmt.format(d) });
    }
    // Current month + last 24, but never pre-2025 (no data before launch).
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      if (y < 2025) break;
      const m = String(d.getMonth() + 1).padStart(2, '0');
      out.push({ value: `${y}-${m}`, label: monthFmt.format(d) });
    }
    return out;
  }, []);

  // Project active recurring templates as "Beklenen" rows for the CURRENT and
  // FUTURE months (matching the current Gider Tipi / Mülk / Kategori filters),
  // skipping any template already represented this month — its own row or a
  // cron-generated instance — so there are never duplicates. Past months show
  // only real data. Display only; the real expense still posts on its day.
  const projected = useMemo<DisplayExpense[]>(() => {
    if (!templates || !expenses || month < currentMonthStr()) return [];
    const postedTemplateIds = new Set<string>();
    for (const e of expenses) {
      postedTemplateIds.add(e.id);
      if (e.recurring_source_id) postedTemplateIds.add(e.recurring_source_id);
    }
    const [y, mm] = month.split('-');
    const lastDay = new Date(Number(y), Number(mm), 0).getDate();
    return templates
      .filter((t) => !postedTemplateIds.has(t.id))
      // A template dated in a LATER month hasn't started yet — the generator
      // skips it (migration 133), so never promise a "Beklenen" before then.
      .filter((t) => t.expense_date.slice(0, 7) <= month)
      .filter((t) => {
        if (expenseType === 'GENEL') return t.property_id === null;
        if (expenseType === 'MULK')
          return propertyId ? t.property_id === propertyId : t.property_id !== null;
        return true;
      })
      .filter((t) => !category || t.category === category)
      .map((t) => {
        const day = Math.min(t.recurring_day ?? 1, lastDay);
        return {
          ...t,
          id: `proj:${t.id}:${month}`,
          expense_date: `${y}-${mm}-${String(day).padStart(2, '0')}`,
          __projected: true,
          __templateId: t.id,
        };
      });
  }, [templates, expenses, month, expenseType, propertyId, category]);

  // Real expenses for the month + projected ones. Projections count toward the
  // total (a future month is all projection anyway).
  //
  // Düzenli giderler (the template, the months generated from it, and any
  // projection) are pinned TOGETHER at the TOP — scattered through the date
  // order they were hard to follow. Everything else keeps the query's newest-
  // first date order below them. Array.sort is stable, so rows sharing a date
  // keep the created_at order the query already applied.
  const displayExpenses = useMemo<DisplayExpense[]>(() => {
    const all = [...(expenses ?? []), ...projected];
    return all.sort((a, b) => {
      const ar = isRecurringRow(a) ? 0 : 1;
      const br = isRecurringRow(b) ? 0 : 1;
      if (ar !== br) return ar - br;
      return b.expense_date.localeCompare(a.expense_date);
    });
  }, [expenses, projected]);

  const total = totalAmount(displayExpenses);

  // Split into Genel (no property) vs Mülk (tied to a property) so the list
  // can render two stacked sections with their own subtotals. The user-facing
  // contract: Genel first at the top, Mülk giderleri underneath.
  // Orphaned expenses (deleted mülk) keep property_id NULL but carry a
  // deleted_property_name — they belong under Mülk ("silinmiş olan …"), not Genel.
  const genelExpenses = useMemo(
    () => displayExpenses.filter((e) => e.property_id === null && !isOrphanedExpense(e)),
    [displayExpenses],
  );
  // Düzenli rows already float to the top of BOTH sections — displayExpenses is
  // sorted that way above, and filtering preserves that order — so this just
  // splits, it doesn't re-order.
  const mulkExpenses = useMemo(
    () => displayExpenses.filter((e) => e.property_id !== null || isOrphanedExpense(e)),
    [displayExpenses],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Giderler
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Mülk bazında işletme giderlerinizin kaydı
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <FinanceTabs />
          {canCreateExpense && (
            <Link to="/finance/expenses/new">
              <Button>+ Yeni Gider</Button>
            </Link>
          )}
        </div>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Gider Tipi"
            name="filter_expense_type"
            value={expenseType}
            onChange={(v) => setExpenseType(v as 'ALL' | 'GENEL' | 'MULK')}
            options={giderTipiOptions}
          />
          {expenseType === 'MULK' && (
            <Select
              label="Mülk"
              name="filter_property"
              value={propertyId}
              onChange={setPropertyId}
              options={propertyOptions}
            />
          )}
          <Select
            label="Ay"
            name="filter_month"
            value={month}
            onChange={setMonth}
            options={monthOptions}
            highlightValue={currentMonthStr()}
          />
          <Select
            label="Kategori"
            name="filter_category"
            value={category}
            onChange={setCategory}
            options={categoryOptions}
          />
        </div>
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!error && expenses === null && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {expenses && displayExpenses.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Bu kriterlerle kayıt bulunamadı.
          </p>
        </Card>
      )}

      {expenses && displayExpenses.length > 0 && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              {displayExpenses.length} kayıt
            </p>
            <div className="flex items-baseline gap-3">
              <p className="text-sm">
                <span className="text-stone-600 dark:text-stone-300">Toplam: </span>
                <strong className="text-lg text-stone-900 dark:text-stone-100">
                  {formatTRY(total)}
                </strong>
              </p>
              {expenses.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const rows = expenses.map((e) => ({
                    Tarih: formatDate(e.expense_date),
                    Mülk: expensePropertyLabel(e),
                    Kategori: e.category,
                    Düzenli: isRecurringRow(e) ? 'Evet' : 'Hayır',
                    Tutar: Number(e.amount).toFixed(2),
                    Açıklama: e.description ?? '',
                  }));
                  const parts = [
                    'giderler',
                    expenseType === 'GENEL' ? 'genel' : null,
                    expenseType === 'MULK' && propertyId
                      ? properties.find((p) => p.id === propertyId)?.name
                      : null,
                    month || null,
                    category || null,
                  ]
                    .filter(Boolean)
                    .join('-');
                  exportRowsToCsv(parts, rows, [
                    { key: 'Tarih', label: 'Tarih' },
                    { key: 'Mülk', label: 'Mülk' },
                    { key: 'Kategori', label: 'Kategori' },
                    { key: 'Düzenli', label: 'Düzenli' },
                    { key: 'Tutar', label: 'Tutar (TRY)' },
                    { key: 'Açıklama', label: 'Açıklama' },
                  ]);
                }}
              >
                CSV İndir
              </Button>
              )}
            </div>
          </div>

          {/* Genel giderler — property_id IS NULL. Always renders first. */}
          {genelExpenses.length > 0 && (
            <ExpenseSection
              title="Genel Giderler"
              items={genelExpenses}
              subtotal={totalAmount(genelExpenses)}
              staffMap={staffMap}
              canStop={canStopRecurring}
              onStop={(e) => {
                setStopError(null);
                setStopTarget(e);
              }}
            />
          )}

          {/* Mülk giderleri — tied to a property. Renders below. */}
          {mulkExpenses.length > 0 && (
            <ExpenseSection
              title="Mülk Giderleri"
              items={mulkExpenses}
              subtotal={totalAmount(mulkExpenses)}
              staffMap={staffMap}
              canStop={canStopRecurring}
              onStop={(e) => {
                setStopError(null);
                setStopTarget(e);
              }}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={stopTarget !== null}
        title="Düzenli gider durdurulsun mu?"
        description={
          stopTarget ? (
            <>
              <p>
                <strong>
                  {expensePropertyLabel(stopTarget)} · {stopTarget.category} ·{' '}
                  {formatTRY(Number(stopTarget.amount))}
                </strong>{' '}
                düzenli gideri durdurulur.
              </p>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
                Bu ay ve sonraki aylar için artık oluşturulmaz. Oluşturulmuş
                aylar olduğu gibi kalır.
              </p>
            </>
          ) : null
        }
        confirmLabel="Durdur"
        cancelLabel="Vazgeç"
        destructive
        loading={stopping}
        error={stopError}
        onConfirm={async () => {
          const templateId = stopTarget?.__templateId ?? stopTarget?.id;
          if (!templateId) return;
          setStopping(true);
          setStopError(null);
          try {
            await stopRecurringExpense(templateId);
            // Refresh both the templates (drops the projection) and the month's
            // real rows (the template loses its "Düzenli" label).
            const [tpl] = await Promise.all([
              listRecurringTemplates(),
              listExpenses({
                propertyId: expenseType === 'MULK' && propertyId ? propertyId : undefined,
                genelOnly: expenseType === 'GENEL',
                mulkOnly: expenseType === 'MULK' && !propertyId,
                month: month || undefined,
                category: category || undefined,
              }).then(setExpenses),
            ]);
            setTemplates(tpl);
            setStopTarget(null);
          } catch (err) {
            setStopError(err instanceof Error ? err.message : 'Durdurulamadı');
          } finally {
            setStopping(false);
          }
        }}
        onCancel={() => {
          setStopTarget(null);
          setStopError(null);
        }}
      />
    </div>
  );
}

/**
 * One titled block of expense rows + its own subtotal. Pulled out so the
 * Genel / Mülk split renders without duplicating the mobile-card-vs-table
 * markup. Each row remains a tap-target linking to the edit page.
 */
function ExpenseSection({
  title,
  items,
  subtotal,
  staffMap,
  canStop,
  onStop,
}: {
  title: string;
  items: DisplayExpense[];
  subtotal: number;
  staffMap: Map<string, string>;
  canStop: boolean;
  onStop: (e: DisplayExpense) => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-600 dark:text-stone-300">
          {title}{' '}
          <span className="ml-1 text-xs font-normal text-stone-500 dark:text-stone-400">
            ({items.length})
          </span>
        </h2>
        <p className="text-sm">
          <strong className="text-stone-900 dark:text-stone-100">
            {formatTRY(subtotal)}
          </strong>
        </p>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-2 sm:hidden">
        {items.map((e) => {
          const body = (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                    {e.category}
                  </span>
                  {isRecurringRow(e) && (
                    <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                      Düzenli
                    </span>
                  )}
                  {e.__projected && (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      Beklenen
                    </span>
                  )}
                  <span className="text-xs text-stone-600 dark:text-stone-300">
                    {formatDate(e.expense_date)}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-stone-700 dark:text-stone-300">
                  {expensePropertyLabel(e)}
                </p>
                {e.description && (
                  <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                    {e.description}
                  </p>
                )}
                {e.created_by && staffMap.get(e.created_by) && (
                  <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
                    Oluşturan: {staffMap.get(e.created_by)}
                  </p>
                )}
              </div>
              <p className="shrink-0 font-semibold text-stone-900 dark:text-stone-100">
                {formatTRY(Number(e.amount))}
              </p>
            </div>
          );
          const base =
            'block rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900';
          return e.__projected ? (
            <div key={e.id} className={base}>
              {/* Projected rows edit the underlying template (recurring day,
                  amount, name…) — same edit page as a real gider. */}
              <Link to={`/finance/expenses/${e.__templateId ?? e.id}/edit`} className="block">
                {body}
              </Link>
              {canStop && (
                <div className="mt-2 flex justify-end border-t border-stone-100 pt-2 dark:border-stone-800">
                  <button
                    type="button"
                    onClick={() => onStop(e)}
                    className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                  >
                    Sil
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              key={e.id}
              to={`/finance/expenses/${e.id}/edit`}
              className={`${base} transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50`}
            >
              {body}
            </Link>
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
                <th className="px-6 py-3 font-medium">Mülk</th>
                <th className="px-6 py-3 font-medium">Kategori</th>
                <th className="px-6 py-3 font-medium">Açıklama</th>
                <th className="px-6 py-3 text-right font-medium">Tutar</th>
                {canStop && <th className="px-6 py-3" aria-label="İşlem" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
              {items.map((e) => (
                <tr
                  key={e.id}
                  className="cursor-pointer transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50"
                >
                  <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                    {/* Projected rows edit the underlying template; real rows
                        edit themselves. */}
                    <Link
                      to={`/finance/expenses/${e.__templateId ?? e.id}/edit`}
                      className="block"
                    >
                      {formatDate(e.expense_date)}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                    {expensePropertyLabel(e)}
                  </td>
                  <td className="px-6 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="rounded bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                        {e.category}
                      </span>
                      {isRecurringRow(e) && (
                        <span
                          title="Düzenli (örn. her ay)"
                          className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                        >
                          Düzenli
                        </span>
                      )}
                      {e.__projected && (
                        <span
                          title="Bu ay henüz işlenmedi — beklenen"
                          className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                        >
                          Beklenen
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                    <div>{e.description || '—'}</div>
                    {e.created_by && staffMap.get(e.created_by) && (
                      <div className="text-xs text-stone-500 dark:text-stone-400">
                        Oluşturan: {staffMap.get(e.created_by)}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-3 text-right font-semibold text-stone-900 dark:text-stone-100">
                    {formatTRY(Number(e.amount))}
                  </td>
                  {canStop && (
                    <td className="px-6 py-3 text-right">
                      {e.__projected && (
                        <button
                          type="button"
                          onClick={() => onStop(e)}
                          className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                        >
                          Sil
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
