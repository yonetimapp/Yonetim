import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { can, seesAllRegions as seesAllRegionsOf } from '@/lib/rbac';
import { listGuests, listGuestRegions, type GuestSummary } from '@/lib/queries/guests';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';
import { useRegions } from '@/hooks/useRegions';
import { RegionFilterChips, ALL_REGIONS } from '@/components/RegionFilterChips';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { WarningTriangleIcon } from '@/components/icons/WarningTriangleIcon';
import { formatDate } from '@/lib/utils';

export function GuestsListPage() {
  const { profile } = useAuth();
  // The region filter only helps someone whose guests span several regions. A
  // region-scoped user already sees only their own region's guests (RLS), so the
  // chips would be noise. Mirrors auth_all_regions() — never role-derived.
  const seesAllRegions = seesAllRegionsOf(profile);
  const { regions } = useRegions();
  const [guests, setGuests] = useState<GuestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState<string>(ALL_REGIONS);
  const [guestRegions, setGuestRegions] = useState<Map<string, Set<string>> | null>(null);
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    listGuests()
      .then(setGuests)
      .catch((e) => setError(e?.message ?? 'Misafirler yüklenemedi'));
    // Best-effort: powers the "Oluşturan: X" line on each guest box.
    loadStaffDirectory().then(setStaffMap).catch(() => {});
    // Guest → region links power the region filter (all-region users only).
    if (seesAllRegions) {
      listGuestRegions()
        .then(setGuestRegions)
        .catch((e) => console.error('Bölge misafir filtresi yüklenemedi:', e));
    }
  }, [seesAllRegions]);

  const canCreate = profile && can(profile.role, 'guest:create');

  const filtered = useMemo(() => {
    if (!guests) return [];
    let list = guests;
    // A guest with no reservation yet belongs to no region, so any region filter
    // (correctly) excludes them — they still show under "Tümü".
    if (region !== ALL_REGIONS && guestRegions) {
      list = list.filter((g) => guestRegions.get(g.id)?.has(region) ?? false);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) =>
          g.full_name.toLowerCase().includes(q) ||
          (g.phone ?? '').toLowerCase().includes(q) ||
          (g.email ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [guests, search, region, guestRegions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Misafirler</h1>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Kayıtlı misafirlerinizin listesi
          </p>
        </div>
        {canCreate && (
          <Link to="/guests/new" className="shrink-0">
            <Button>+ Yeni Misafir</Button>
          </Link>
        )}
      </div>

      <div className="max-w-md">
        <Input
          name="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Ad, telefon veya e-posta ile ara…"
        />
      </div>

      {seesAllRegions && (
        <RegionFilterChips
          regions={regions.map((r) => r.name)}
          value={region}
          onChange={setRegion}
          allLabel="Tümü"
        />
      )}

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {!guests && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {guests && filtered.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            {search ? 'Arama sonucu bulunamadı.' : 'Henüz misafir eklenmemiş.'}
          </p>
        </Card>
      )}

      {guests && filtered.length > 0 && (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-2 sm:hidden">
            {filtered.map((g) => (
              <Link
                key={g.id}
                to={`/guests/${g.id}`}
                className="block rounded-lg border border-stone-200 bg-white p-3 transition-colors hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800/50"
              >
                <div className="flex items-center gap-1.5">
                  {g.is_problematic && (
                    <WarningTriangleIcon
                      className="h-4 w-4 shrink-0 text-red-500"
                      aria-label="Sorunlu misafir"
                    />
                  )}
                  <p className="font-medium text-stone-900 dark:text-stone-100">
                    {g.full_name}
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-600 dark:text-stone-300">
                  {g.phone && <span>{g.phone}</span>}
                  {g.email && <span className="truncate">{g.email}</span>}
                  {g.nationality && (
                    <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] uppercase text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                      {g.nationality}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                  {g.created_by && staffMap.get(g.created_by)
                    ? `Oluşturan: ${staffMap.get(g.created_by)} · ${formatDate(g.created_at)}`
                    : `Eklendi: ${formatDate(g.created_at)}`}
                </p>
              </Link>
            ))}
          </div>

          {/* Tablet+ : table */}
          <Card className="hidden p-0 sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-stone-300 text-xs uppercase text-stone-600 dark:border-stone-700 dark:text-stone-300">
                  <tr>
                    <th className="px-6 py-3 font-medium">Ad Soyad</th>
                    <th className="px-6 py-3 font-medium">Telefon</th>
                    <th className="px-6 py-3 font-medium">E-posta</th>
                    <th className="px-6 py-3 font-medium">Uyruk</th>
                    <th className="px-6 py-3 font-medium">Oluşturan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-300 dark:divide-stone-700">
                  {filtered.map((g) => (
                    <tr
                      key={g.id}
                      className="cursor-pointer transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    >
                      <td className="px-6 py-3 font-medium text-stone-900 dark:text-stone-100">
                        <Link to={`/guests/${g.id}`} className="flex items-center gap-1.5">
                          {g.is_problematic && (
                            <WarningTriangleIcon
                              className="h-4 w-4 shrink-0 text-amber-500"
                              aria-label="Sorunlu misafir"
                            />
                          )}
                          <span>{g.full_name}</span>
                        </Link>
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {g.phone ?? '—'}
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {g.email ?? '—'}
                      </td>
                      <td className="px-6 py-3 text-stone-700 dark:text-stone-300">
                        {g.nationality ?? '—'}
                      </td>
                      <td className="px-6 py-3 text-stone-600 dark:text-stone-400">
                        {g.created_by && staffMap.get(g.created_by)
                          ? `${staffMap.get(g.created_by)} · ${formatDate(g.created_at)}`
                          : formatDate(g.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
