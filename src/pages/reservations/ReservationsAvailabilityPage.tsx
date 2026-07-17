import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can } from '@/lib/rbac';
import { listProperties, type Property } from '@/lib/queries/properties';
import { listAllUnits, type Unit } from '@/lib/queries/units';
import {
  listReservationsInRange,
  type ReservationWithRefs,
} from '@/lib/queries/reservations';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { NumberInput } from '@/components/ui/NumberInput';
import { Select } from '@/components/ui/Select';
import { ReservationsViewTabs } from './ViewTabs';
import { formatTRY, formatDate, istanbulToday } from '@/lib/utils';

// --- date helpers (UTC-day space, matching how stay_start/stay_end are stored) ---
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** [aStart, aEnd) overlaps [bStart, bEnd) — pure string compare works for ISO dates. */
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && aEnd > bStart;
}

interface AvailabilityResult {
  unit: Unit;
  property: Property;
  shift: number; // 0 = exact dates, negative = earlier, positive = later
  start: string;
  end: string;
}

function shiftLabel(shift: number): string {
  if (shift === 0) return 'Tam tarih';
  if (shift < 0) return `${Math.abs(shift)} gün önce`;
  return `${shift} gün sonra`;
}

export function ReservationsAvailabilityPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [properties, setProperties] = useState<Property[]>([]);
  const [allUnits, setAllUnits] = useState<Unit[]>([]);

  // Search inputs
  const [propertyId, setPropertyId] = useState(''); // '' = all properties
  const [checkin, setCheckin] = useState(istanbulToday());
  const [nights, setNights] = useState(1);
  const [flexDays, setFlexDays] = useState(3);

  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<AvailabilityResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canCreate = Boolean(profile && can(profile.role, 'reservation:create'));
  const checkout = useMemo(() => addDaysStr(checkin, nights), [checkin, nights]);

  // Load properties + units once
  useEffect(() => {
    Promise.all([listProperties(), listAllUnits()])
      .then(([p, u]) => {
        setProperties(p);
        setAllUnits(u);
      })
      .catch((e) => setError(e?.message ?? 'Yüklenemedi'));
  }, []);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSearching(true);
    setResults(null);

    try {
      // 1. Candidate units
      const candidateUnits = propertyId
        ? allUnits.filter((u) => u.property_id === propertyId)
        : allUnits;

      if (candidateUnits.length === 0) {
        setResults([]);
        return;
      }

      // 2. Window: requested dates ±flex on each side
      const windowStart = addDaysStr(checkin, -flexDays);
      const windowEnd = addDaysStr(checkout, flexDays);
      const startISO = new Date(windowStart + 'T00:00:00Z').toISOString();
      const endISO = new Date(windowEnd + 'T00:00:00Z').toISOString();

      // 3. Pull every reservation overlapping that window in one shot
      const reservations: ReservationWithRefs[] = await listReservationsInRange(
        startISO,
        endISO,
      );
      const reservedByUnit = new Map<string, ReservationWithRefs[]>();
      for (const r of reservations) {
        if (r.status === 'cancelled') continue;
        const arr = reservedByUnit.get(r.unit_id) ?? [];
        arr.push(r);
        reservedByUnit.set(r.unit_id, arr);
      }

      // 4. Build offset sequence: 0, -1, +1, -2, +2, … so we naturally prefer
      //    the smallest absolute shift, with "earlier" winning ties.
      const offsets: number[] = [0];
      for (let i = 1; i <= flexDays; i++) {
        offsets.push(-i, i);
      }

      // 5. For each unit, find the first offset that produces an open window
      const found: AvailabilityResult[] = [];
      for (const unit of candidateUnits) {
        const reservedForUnit = reservedByUnit.get(unit.id) ?? [];
        for (const shift of offsets) {
          const tryStart = addDaysStr(checkin, shift);
          const tryEnd = addDaysStr(tryStart, nights);
          const conflict = reservedForUnit.some((r) =>
            overlaps(
              tryStart,
              tryEnd,
              r.stay_start.slice(0, 10),
              r.stay_end.slice(0, 10),
            ),
          );
          if (!conflict) {
            const prop = properties.find((p) => p.id === unit.property_id);
            if (prop) {
              found.push({ unit, property: prop, shift, start: tryStart, end: tryEnd });
            }
            break;
          }
        }
      }

      // 6. Sort: shift==0 first, then by |shift|, then earlier before later
      found.sort((a, b) => {
        const aAbs = Math.abs(a.shift);
        const bAbs = Math.abs(b.shift);
        if (aAbs !== bAbs) return aAbs - bAbs;
        if (a.shift !== b.shift) return a.shift - b.shift;
        return a.property.name.localeCompare(b.property.name, 'tr', { numeric: true });
      });

      setResults(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Arama başarısız');
    } finally {
      setSearching(false);
    }
  };

  const propertyOptions = useMemo(
    () => [
      { value: '', label: 'Tüm mülkler' },
      ...properties.map((p) => ({ value: p.id, label: p.name })),
    ],
    [properties],
  );

  const exactMatches = results?.filter((r) => r.shift === 0) ?? [];
  const flexMatches = results?.filter((r) => r.shift !== 0) ?? [];

  const handleReserve = (r: AvailabilityResult) => {
    if (!canCreate) return;
    navigate(
      `/reservations/new?property=${r.property.id}&unit=${r.unit.id}&checkin=${r.start}&from=/reservations/availability`,
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Müsaitlik Sorgulama
          </h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Tarih aralığına göre uygun birim ara, dolu çıkarsa esnek alternatifler öner.
          </p>
        </div>
        <ReservationsViewTabs />
      </div>

      <Card>
        <form onSubmit={handleSearch} className="space-y-4" noValidate>
          <Select
            label="Mülk"
            name="property"
            value={propertyId}
            onChange={setPropertyId}
            options={propertyOptions}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <DateInput
              label="Giriş"
              name="checkin"
              required
              value={checkin}
              onChange={setCheckin}
            />
            <NumberInput
              label="Gece"
              name="nights"
              min={1}
              max={365}
              required
              value={nights}
              onChange={setNights}
            />
            <NumberInput
              label="Esneklik (±gün)"
              name="flex"
              min={0}
              max={14}
              value={flexDays}
              onChange={setFlexDays}
            />
          </div>

          <p className="text-xs text-stone-600 dark:text-stone-300">
            Tercih edilen tarih aralığı:{' '}
            <strong>
              {formatDate(checkin)} → {formatDate(checkout)}
            </strong>
            {flexDays > 0 && (
              <>
                {' '}· Alternatifler için ±{flexDays} gün taranacak.
              </>
            )}
          </p>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" loading={searching}>
              Ara
            </Button>
          </div>
        </form>
      </Card>

      {results && results.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Bu kriterlerle uygun birim bulunamadı. Esneklik aralığını artırmayı deneyin.
          </p>
        </Card>
      )}

      {exactMatches.length > 0 && (
        <ResultSection
          title="Tam Eşleşme"
          subtitle="Tercih edilen tarihlerde boş birimler"
          tone="exact"
          results={exactMatches}
          nights={nights}
          canCreate={canCreate}
          onReserve={handleReserve}
        />
      )}

      {flexMatches.length > 0 && (
        <ResultSection
          title="Alternatif Tarihler"
          subtitle="Tarihleri ±birkaç gün kaydırırsanız uygun olan birimler"
          tone="flex"
          results={flexMatches}
          nights={nights}
          canCreate={canCreate}
          onReserve={handleReserve}
        />
      )}
    </div>
  );
}

interface ResultSectionProps {
  title: string;
  subtitle: string;
  tone: 'exact' | 'flex';
  results: AvailabilityResult[];
  nights: number;
  canCreate: boolean;
  onReserve: (r: AvailabilityResult) => void;
}

function ResultSection({
  title,
  subtitle,
  tone,
  results,
  nights,
  canCreate,
  onReserve,
}: ResultSectionProps) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          {title}
          <span
            className={
              tone === 'exact'
                ? 'ml-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : 'ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
            }
          >
            {results.length}
          </span>
        </h2>
        <p className="text-xs text-stone-600 dark:text-stone-300">{subtitle}</p>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-2 sm:hidden">
        {results.map((r) => {
          const total = Number(r.unit.base_price) * nights;
          return (
            <div
              key={`${r.unit.id}_${r.shift}`}
              className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-stone-900 dark:text-stone-100">
                    {r.unit.name}
                  </p>
                  <p className="truncate text-xs text-stone-600 dark:text-stone-300">
                    {r.property.name}
                  </p>
                </div>
                <span
                  className={
                    r.shift === 0
                      ? 'shrink-0 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : 'shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  }
                >
                  {shiftLabel(r.shift)}
                </span>
              </div>
              <p className="mt-1 text-xs text-stone-700 dark:text-stone-300">
                {formatDate(r.start)} → {formatDate(r.end)}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="font-semibold text-stone-900 dark:text-stone-100">
                  {formatTRY(total)}
                </p>
                {canCreate && (
                  <Button size="sm" onClick={() => onReserve(r)}>
                    Rezerve Et
                  </Button>
                )}
              </div>
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
                <th className="px-6 py-3 font-medium">Birim</th>
                <th className="px-6 py-3 font-medium">Tarih</th>
                <th className="px-6 py-3 font-medium">Kayma</th>
                <th className="px-6 py-3 font-medium">Önerilen Tutar</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
              {results.map((r) => {
                const total = Number(r.unit.base_price) * nights;
                return (
                  <tr
                    key={`${r.unit.id}_${r.shift}`}
                    className="transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50"
                  >
                    <td className="px-6 py-3">
                      <div className="text-base font-semibold text-stone-900 dark:text-stone-100">
                        {r.unit.name}
                      </div>
                      <div className="text-xs text-stone-600 dark:text-stone-300">
                        {r.property.name}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                      <div>{formatDate(r.start)}</div>
                      <div className="text-xs text-stone-600 dark:text-stone-300">
                        → {formatDate(r.end)}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                      <span
                        className={
                          r.shift === 0
                            ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : 'rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                        }
                      >
                        {shiftLabel(r.shift)}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                      {formatTRY(total)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {canCreate && (
                        <Button size="sm" onClick={() => onReserve(r)}>
                          Rezerve Et
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

