import { supabase } from '@/lib/supabase';

export interface StaffDirectoryEntry {
  user_id: string;
  full_name: string;
}

/**
 * Returns a name-only directory of every non-deleted staff member. Backed
 * by the list_staff_directory RPC (migration 069) which is callable by
 * any signed-in user — strictly less data than direct staff_profiles SELECT.
 *
 * Cached in module scope as a single promise so multiple pages calling
 * this concurrently share one network round-trip.
 */
let cache: Promise<Map<string, string>> | null = null;

export function loadStaffDirectory(): Promise<Map<string, string>> {
  if (cache) return cache;
  cache = (async () => {
    const { data, error } = await supabase.rpc('list_staff_directory');
    if (error) {
      cache = null; // allow retry on next call
      throw new Error(error.message);
    }
    const map = new Map<string, string>();
    for (const row of (data ?? []) as StaffDirectoryEntry[]) {
      map.set(row.user_id, row.full_name);
    }
    return map;
  })();
  return cache;
}

/** Drop the cache — call after a staff create / rename / delete to force refresh. */
export function invalidateStaffDirectory(): void {
  cache = null;
}
