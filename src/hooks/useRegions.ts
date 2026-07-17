import { useEffect, useState } from 'react';
import { listRegions, type Region } from '@/lib/queries/regions';

/**
 * The region list (migration 124), loaded once per mount.
 *
 * Every signed-in user may read `regions` (RLS), so this is a safe call from any
 * screen. On failure it settles to an empty list rather than throwing: the region
 * filters that consume it hide themselves below two regions, so a failed load
 * degrades to "no region filter" instead of a broken page.
 */
export function useRegions(): { regions: Region[]; defaultRegion: string | null } {
  const [regions, setRegions] = useState<Region[]>([]);

  useEffect(() => {
    let alive = true;
    listRegions()
      .then((rs) => {
        if (alive) setRegions(rs);
      })
      .catch((e) => console.error('Bölgeler yüklenemedi:', e));
    return () => {
      alive = false;
    };
  }, []);

  // listRegions() orders default-first, but resolve it explicitly rather than
  // trusting [0] — the fallback keeps callers working if the flag ever goes.
  const defaultRegion = regions.find((r) => r.is_default)?.name ?? regions[0]?.name ?? null;

  return { regions, defaultRegion };
}
