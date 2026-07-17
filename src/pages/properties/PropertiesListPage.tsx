import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, seesAllRegions as seesAllRegionsOf } from '@/lib/rbac';
import { listProperties, type Property } from '@/lib/queries/properties';
import { listAllUnits, type Unit } from '@/lib/queries/units';
import { useRegions } from '@/hooks/useRegions';
import { RegionFilterChips, ALL_REGIONS } from '@/components/RegionFilterChips';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { propertyPhotoUrl } from '@/lib/photos';
import { formatRoomType, formatTRY } from '@/lib/utils';

export function PropertiesListPage() {
  const { profile } = useAuth();
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'HOTEL' | 'APARTMENT'>('ALL');
  // Region is its own filter row rather than a chip in the type row, so the two
  // compose (e.g. "Daireler" + "Merkez").
  const [regionFilter, setRegionFilter] = useState<string>(ALL_REGIONS);
  const { regions } = useRegions();

  useEffect(() => {
    // Load properties + units in parallel so the card can show each mülk's
    // unit type(s) inline next to its name.
    Promise.all([listProperties(), listAllUnits()])
      .then(([props, us]) => {
        setProperties(props);
        setUnits(us);
      })
      .catch((e) => setError(e.message ?? 'Mülkler yüklenemedi'));
  }, []);

  /**
   * Build per-property unit-type summaries. For apartments (single unit) the
   * card shows that one type. For binalar with several rooms we surface the
   * distinct types comma-joined, e.g. "1+0 · 1+1".
   */
  const typesByProperty = useMemo(() => {
    const map = new Map<string, string>();
    const grouped = new Map<string, Unit[]>();
    for (const u of units) {
      const arr = grouped.get(u.property_id) ?? [];
      arr.push(u);
      grouped.set(u.property_id, arr);
    }
    for (const [propId, propUnits] of grouped) {
      const distinct = Array.from(new Set(propUnits.map((u) => u.room_type)));
      if (distinct.length === 0) continue;
      map.set(propId, distinct.map(formatRoomType).join(' · '));
    }
    return map;
  }, [units]);

  /**
   * Per-property base price summary. Single unit → exact price. Multiple
   * units with the same price → exact price. Otherwise show the range
   * (min–max). All zero/missing → undefined (card hides the chip).
   */
  const priceByProperty = useMemo(() => {
    const map = new Map<string, string>();
    const grouped = new Map<string, Unit[]>();
    for (const u of units) {
      const arr = grouped.get(u.property_id) ?? [];
      arr.push(u);
      grouped.set(u.property_id, arr);
    }
    for (const [propId, propUnits] of grouped) {
      const prices = propUnits
        .map((u) => Number(u.base_price))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (prices.length === 0) continue;
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      map.set(propId, min === max ? formatTRY(min) : `${formatTRY(min)}–${formatTRY(max)}`);
    }
    return map;
  }, [units]);

  const canCreate = profile && can(profile.role, 'admin:*');
  // The region filter only helps someone whose mülkler span several regions —
  // a region-scoped user sees just their own (RLS). Mirrors auth_all_regions().
  const seesAllRegions = seesAllRegionsOf(profile);
  const filtered = (
    properties?.filter((p) => {
      if (regionFilter !== ALL_REGIONS && p.region !== regionFilter) return false;
      if (filter === 'ALL') return true;
      return p.type === filter;
    }) ?? []
  )
    // On "Tümü", show hotels first; within each type, preserve oldest-first order
    .sort((a, b) => {
      if (filter === 'ALL' && a.type !== b.type) {
        return a.type === 'HOTEL' ? -1 : 1;
      }
      return 0;
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Mülkler</h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Bina ve dairelerinizin listesi
          </p>
        </div>
        {canCreate && (
          <Link to="/properties/new" className="shrink-0">
            <Button>+ Yeni Mülk</Button>
          </Link>
        )}
      </div>

      {/* Filter chips — type row, then the region row (all-region users only). */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {(['ALL', 'HOTEL', 'APARTMENT'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                filter === f
                  ? 'rounded-full bg-emerald-600 px-4 py-1 text-sm font-medium text-white'
                  : 'rounded-full border border-stone-300 px-4 py-1 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800'
              }
            >
              {f === 'ALL' ? 'Tümü' : f === 'HOTEL' ? 'Binalar' : 'Daireler'}
            </button>
          ))}
        </div>
        {seesAllRegions && (
          <RegionFilterChips
            regions={regions.map((r) => r.name)}
            value={regionFilter}
            onChange={setRegionFilter}
            allLabel="Tüm bölgeler"
          />
        )}
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!properties && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {properties && filtered.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            Henüz mülk eklenmemiş.
          </p>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((p) => {
          const thumb = p.photo_paths?.[0];
          return (
            <Link key={p.id} to={`/properties/${p.id}`} className="block">
              <Card className="overflow-hidden transition-shadow hover:shadow-md">
                {/* Thumbnail (first photo). Negative margins break out of Card's p-6 padding. */}
                <div className="-mx-6 -mt-6 mb-4 aspect-[16/9] overflow-hidden bg-stone-100 dark:bg-stone-800">
                  {thumb ? (
                    <img
                      src={propertyPhotoUrl(thumb)}
                      alt={`${p.name} kapak fotoğrafı`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-stone-400 dark:text-stone-500">
                      Fotoğraf yok
                    </div>
                  )}
                </div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <h3 className="truncate font-semibold text-stone-900 dark:text-stone-100">
                        {p.name}
                      </h3>
                      {typesByProperty.has(p.id) && (
                        <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                          {typesByProperty.get(p.id)}
                        </span>
                      )}
                      {priceByProperty.has(p.id) && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          {priceByProperty.get(p.id)}
                        </span>
                      )}
                      {p.region && (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium capitalize tracking-wide text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                          {p.region}
                        </span>
                      )}
                    </div>
                    {p.address && (
                      <p className="mt-1 truncate text-xs text-stone-600 dark:text-stone-300">
                        {p.address}
                      </p>
                    )}
                  </div>
                  <span
                    className={
                      p.type === 'HOTEL'
                        ? 'rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'rounded bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200'
                    }
                  >
                    {p.type === 'HOTEL' ? 'Bina' : 'Daire'}
                  </span>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
