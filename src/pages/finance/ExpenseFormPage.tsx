import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { listProperties, sortHotelsFirst, type Property } from '@/lib/queries/properties';
import { listAllUnits, type Unit } from '@/lib/queries/units';
import { seesAllRegions as seesAllRegionsOf } from '@/lib/rbac';
import {
  createExpense,
  deleteExpense,
  getExpense,
  postRecurringInstanceNow,
  updateExpense,
  EXPENSE_CATEGORIES,
} from '@/lib/queries/expenses';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { Input } from '@/components/ui/Input';
import { NumberInput } from '@/components/ui/NumberInput';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { listRegions, type Region } from '@/lib/queries/regions';
import { cn, istanbulToday } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

/**
 * Dropdown options for the recurring-expense day picker. Empty value = the
 * expense is a one-off. Mirrors the salary EditSalaryModal so the operator
 * sees the same shape in both forms.
 */
const RECURRING_DAY_OPTIONS = [
  { value: '', label: 'Yok (tek seferlik)' },
  ...Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: `Her ayın ${i + 1}. günü`,
  })),
];

export function ExpenseFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();

  const [properties, setProperties] = useState<Property[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);

  const [propertyId, setPropertyId] = useState('');
  // Optional birim within the mülk. '' = Tüm birimler (whole mülk).
  const [unitId, setUnitId] = useState('');
  // 'general' = not tied to a mülk; 'property' = pick a specific mülk below.
  const [propertyMode, setPropertyMode] = useState<'general' | 'property'>('property');
  // Region for a GENEL (mülksüz) gider — which region's kasa it hits. Only shown
  // to users who see every region; '' means "let the server decide", and
  // set_expense_region() then falls back to the caller's own region. A mülk
  // gider ignores this entirely (the trigger takes the mülk's region).
  const [region, setRegion] = useState('');
  const [regions, setRegions] = useState<Region[]>([]);
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState(0);
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(istanbulToday());
  /**
   * Recurring-day picker. '' means "Yok" (one-off); '1'..'31' marks the
   * expense as a recurring template that the daily cron materialises every
   * month on the chosen day. Stored as string so the Select can clear.
   */
  const [recurringDay, setRecurringDay] = useState<string>('');
  // Whether the expense being edited posted a kasa movement — drives the
  // heads-up shown on the delete dialog.
  const [loadedPaidFromKasa, setLoadedPaidFromKasa] = useState(false);
  // Whether the loaded expense is a recurring TEMPLATE (is_recurring + no
  // source) — gates the "Kasaya işle" (post this month's instance) action.
  const [isTemplate, setIsTemplate] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [confirmPost, setConfirmPost] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Region list for the genel-gider picker.
  useEffect(() => {
    listRegions().then(setRegions).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [props, us] = await Promise.all([listProperties(), listAllUnits()]);
        setProperties(props);
        setUnits(us);
        if (!isEdit && props.length > 0 && !propertyId) {
          setPropertyId(props[0].id);
        }
        if (isEdit && id) {
          const e = await getExpense(id);
          if (!e) {
            setError('Gider bulunamadı');
            return;
          }
          setPropertyId(e.property_id ?? '');
          setPropertyMode(e.property_id ? 'property' : 'general');
          setRegion(e.region ?? '');
          setUnitId(e.unit_id ?? '');
          setCategory(e.category);
          setAmount(Number(e.amount));
          setDescription(e.description ?? '');
          setExpenseDate(e.expense_date);
          setRecurringDay(
            // Edit mode: prefer the explicit recurring_day; fall back to the
            // template's own day if a legacy row only has is_recurring set
            // (pre-054 data, until the backfill in 054 catches up).
            e.recurring_day != null
              ? String(e.recurring_day)
              : e.is_recurring
                ? String(Number(e.expense_date.slice(8, 10)))
                : '',
          );
          setLoadedPaidFromKasa(e.paid_from_kasa);
          setIsTemplate(e.is_recurring === true && e.recurring_source_id == null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Yüklenemedi');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEdit]);

  // A düzenli gider always lands on its tekrar günü — including the month it is
  // set up in — so keep the date's DAY pinned to the picker. The month stays the
  // user's choice (it selects the START month). The server enforces the same rule
  // (migration 133); this only makes the form show the date that will be saved.
  useEffect(() => {
    if (recurringDay === '') return;
    const day = Number(recurringDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) return;
    setExpenseDate((prev) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(prev)) return prev;
      const [y, m] = prev.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate(); // day 31 → 30/28
      const aligned = `${y}-${String(m).padStart(2, '0')}-${String(
        Math.min(day, lastDay),
      ).padStart(2, '0')}`;
      return aligned === prev ? prev : aligned;
    });
  }, [recurringDay, expenseDate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (propertyMode === 'property' && !propertyId) {
      setError('Mülk seçilmelidir.');
      return;
    }
    if (!category) {
      setError('Kategori seçilmelidir.');
      return;
    }
    if (amount < 0) {
      setError('Tutar negatif olamaz.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
      setError('Geçerli bir tarih giriniz.');
      return;
    }

    const effectivePropertyId = propertyMode === 'general' ? null : propertyId;

    // Translate the dropdown back to the (is_recurring, recurring_day) pair
    // the DB layer expects. Any picked day implies recurring=true, which in
    // turn implies paid_from_kasa=true (the kasa OUT is the whole point).
    let parsedDay: number | null = null;
    if (recurringDay !== '') {
      const n = Number(recurringDay);
      if (!Number.isInteger(n) || n < 1 || n > 31) {
        setError('Ödeme günü 1 ile 31 arasında olmalıdır.');
        return;
      }
      parsedDay = n;
    }
    const isRecurring = parsedDay !== null;

    setSaving(true);
    try {
      if (isEdit && id) {
        await updateExpense(id, {
          property_id: effectivePropertyId,
          category,
          amount,
          description: description.trim() || null,
          expense_date: expenseDate,
          is_recurring: isRecurring,
          recurring_day: parsedDay,
          // Direct table write: omit region unless this is a genel gider with an
          // explicit pick. set_expense_region() then resolves it (the mülk's
          // region, else the caller's own).
          ...(effectivePropertyId === null && region ? { region } : {}),
          unit_id: effectivePropertyId !== null ? unitId || null : null,
        });
      } else {
        await createExpense({
          propertyId: effectivePropertyId,
          category,
          amount,
          description: description.trim() || null,
          expenseDate,
          isRecurring,
          // Every expense — one-off or recurring — posts a matching OUT to the
          // general kasa so the cash balance always reflects reality.
          paidFromKasa: true,
          recurringDay: parsedDay,
          // RPC path: NULL means "server decides" — set_expense_region() takes the
          // mülk's region for a mülk gider, else the caller's own region.
          region: effectivePropertyId === null ? region || null : null,
          unitId: effectivePropertyId !== null ? unitId || null : null,
        });
      }
      navigate('/finance/expenses', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteExpense(id);
      navigate('/finance/expenses', { replace: true });
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Silme başarısız');
      setDeleting(false);
    }
  };

  // Post this recurring template's current-month instance to the kasa now —
  // used when the daily cron missed it (RPC is idempotent + branch-scoped).
  const handlePost = async () => {
    if (!id) return;
    setPosting(true);
    setPostError(null);
    try {
      await postRecurringInstanceNow(id);
      navigate('/finance/expenses', { replace: true });
    } catch (e) {
      setPostError(e instanceof Error ? e.message : 'İşlenemedi');
      setPosting(false);
    }
  };

  // Birim options for the currently-selected mülk.
  const unitsForProperty = units.filter((u) => u.property_id === propertyId);

  if (loading) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <button
        type="button"
        onClick={() =>
          location.key === 'default' ? navigate('/finance/expenses') : navigate(-1)
        }
        className="inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
      >
        ← Geri
      </button>

      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {isEdit ? 'Gider Düzenle' : 'Yeni Gider'}
        </h1>
        {isEdit && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            Sil
          </Button>
        )}
      </div>

      {properties.length === 0 && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Önce bir mülk eklemelisiniz.{' '}
            <Link to="/properties/new" className="underline">
              Mülk ekle
            </Link>
          </p>
        </Card>
      )}

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label className="block text-sm font-medium text-stone-700 dark:text-stone-300">
              Gider türü
            </label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(
                [
                  ['general', 'Genel'],
                  ['property', 'Mülke Ait'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setPropertyMode(mode);
                    if (mode === 'property' && !propertyId && properties.length > 0) {
                      setPropertyId(sortHotelsFirst(properties)[0].id);
                    }
                  }}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                    propertyMode === mode
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Only an all-region user may file a genel gider into a region other
              than their own — the expenses_insert RLS (migration 102) bypasses
              the region match on auth_sees_all_regions() alone. Showing the
              picker to a region-scoped manager would let them pick a region the
              policy then rejects with a raw RLS error; their gider always goes
              to their own region's kasa via the trigger, which is what
              "Otomatik" does anyway. */}
          {propertyMode === 'general' && seesAllRegionsOf(profile) && (
              <div>
                <Select
                  label="Bölge"
                  name="expense_region"
                  value={region}
                  onChange={setRegion}
                  options={[
                    { value: '', label: 'Otomatik (kendi bölgem)' },
                    ...regions.map((r) => ({ value: r.name, label: r.name })),
                  ]}
                />
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Bu genel gider seçilen bölgenin kasasına işlenir. "Otomatik" bırakırsanız
                  kendi bölgenizin kasası kullanılır.
                </p>
              </div>
            )}

          {propertyMode === 'property' && (
            <Select
              label="Mülk"
              name="property"
              required
              value={propertyId}
              onChange={(v) => {
                setPropertyId(v);
                setUnitId(''); // reset birim — it belongs to the old mülk
              }}
              options={sortHotelsFirst(properties).map((p) => ({ value: p.id, label: p.name }))}
              placeholder="Mülk seçin"
            />
          )}

          {propertyMode === 'property' && unitsForProperty.length > 0 && (
            <Select
              label="Birim"
              name="unit"
              value={unitId}
              onChange={setUnitId}
              options={[
                { value: '', label: 'Tüm birimler' },
                ...unitsForProperty.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          )}

          <Select
            label="Kategori"
            name="category"
            required
            value={category}
            onChange={setCategory}
            options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))}
          />

          <NumberInput
            label="Tutar (₺)"
            name="amount"
            required
            min={0}
            step={10}
            value={amount}
            onChange={setAmount}
          />

          <DateInput
            label="Tarih"
            name="expense_date"
            required
            value={expenseDate}
            onChange={setExpenseDate}
          />

          <Input
            label="Açıklama"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={250}
          />

          <div>
            <Select
              label="Otomatik Ödeme Günü"
              name="recurring_day"
              value={recurringDay}
              onChange={setRecurringDay}
              options={RECURRING_DAY_OPTIONS}
              searchable
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Seçilen gün geldiğinde gider otomatik oluşturulur ve kasadan
              düşülür (örn. kira, fatura). "Yok" seçerseniz yalnızca tek
              seferlik gider olur.
            </p>
            {/* Same Feb/Apr fallback as the salary cron — the
                generate_recurring_expenses() function pays on the last day
                of the month when recurring_day > that month's last day. */}
            {Number(recurringDay) >= 29 && (
              <p className="mt-1 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                Not: Bu sayının olmadığı aylarda (örn. Şubat) ödeme ayın son
                gününde otomatik yapılır.
              </p>
            )}
          </div>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Link to="/finance/expenses">
              <Button type="button" variant="secondary" disabled={saving}>
                İptal
              </Button>
            </Link>
            <Button type="submit" loading={saving}>
              {isEdit ? 'Kaydet' : 'Oluştur'}
            </Button>
          </div>
        </form>
      </Card>

      {isTemplate && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                Bu ayın giderini kasaya işle
              </p>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                Otomatik kayıt çalışmadıysa bu düzenli giderin bu ayki kaydını
                elle oluşturur ve (kasadan ödeniyorsa) kasadan düşer.
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                setPostError(null);
                setConfirmPost(true);
              }}
            >
              Kasaya işle
            </Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Gider silinsin mi?"
        description={
          <>
            <p>Gider Çöp Kutusu'na taşınır ve oradan geri yüklenebilir.</p>
            {loadedPaidFromKasa && (
              <p className="mt-2">
                <strong>Not:</strong> Bu giderin kasa hareketi otomatik
                silinmez — gerekirse Kasa sayfasından ayrıca kaldırın.
              </p>
            )}
          </>
        }
        confirmLabel="Sil"
        destructive
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />

      <ConfirmDialog
        open={confirmPost}
        title="Gider şimdi işlensin mi?"
        description={
          <>
            <p>Bu düzenli giderin bu ayki kaydı oluşturulur.</p>
            <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
              Kasadan ödenen bir gider ise tutar kasadan düşülür.
            </p>
          </>
        }
        confirmLabel="İşle"
        loading={posting}
        error={postError}
        onConfirm={handlePost}
        onCancel={() => {
          setConfirmPost(false);
          setPostError(null);
        }}
      />
    </div>
  );
}
