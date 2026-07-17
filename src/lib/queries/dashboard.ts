import { supabase } from '@/lib/supabase';
import { istanbulToday } from '@/lib/utils';
import { listAllUnits } from '@/lib/queries/units';
import { listAllTasks, latestPerUnit, DEFAULT_STATUS } from '@/lib/queries/housekeeping';

/**
 * Compact counts that the Panel renders as today's-at-a-glance tiles.
 * Each value is RLS-filtered server-side, so a RECEPTION user in property X
 * automatically sees only their own branch's numbers.
 */
export interface DashboardCounts {
  checkInsToday: number;
  checkOutsToday: number;
  activeNow: number;
  pendingPayments: number;
  openIssues: number;
  dirtyUnits: number;
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Fire five small count queries in parallel. RLS does the per-branch filtering
 * server-side, so each user automatically gets numbers for what they can see.
 * Any single query that errors falls back to 0 rather than blowing up the
 * whole dashboard (a missing kasa permission shouldn't hide today's check-ins).
 */
export async function loadDashboardCounts(): Promise<DashboardCounts> {
  const today = istanbulToday();
  const tomorrow = addDaysStr(today, 1);
  const todayISO = new Date(`${today}T00:00:00Z`).toISOString();
  const tomorrowISO = new Date(`${tomorrow}T00:00:00Z`).toISOString();

  const countOr0 = async (
    p: PromiseLike<{ count: number | null; error: unknown }>,
  ): Promise<number> => {
    try {
      const { count, error } = await p;
      if (error) return 0;
      return count ?? 0;
    } catch {
      return 0;
    }
  };

  // Dirty units = units whose latest housekeeping status is DIRTY (units with
  // no task history default to DIRTY). Mirrors the Temizlik page's Kirli count.
  const dirtyUnitsCount = async (): Promise<number> => {
    try {
      const [units, tasks] = await Promise.all([listAllUnits(), listAllTasks()]);
      const latest = latestPerUnit(tasks);
      return units.filter(
        (u) => (latest.get(u.id)?.status ?? DEFAULT_STATUS) === 'DIRTY',
      ).length;
    } catch {
      return 0;
    }
  };

  const [
    checkInsToday,
    checkOutsToday,
    activeNow,
    pendingPayments,
    openIssues,
    dirtyUnits,
  ] = await Promise.all([
      countOr0(
        supabase
          .from('reservations')
          .select('id', { count: 'exact', head: true })
          .gte('stay_start', todayISO)
          .lt('stay_start', tomorrowISO)
          .neq('status', 'cancelled'),
      ),
      countOr0(
        supabase
          .from('reservations')
          .select('id', { count: 'exact', head: true })
          .gte('stay_end', todayISO)
          .lt('stay_end', tomorrowISO)
          .neq('status', 'cancelled'),
      ),
      // "Şu an Aktif" — trust the status alone. The hourly auto-complete
      // cron flips active → completed when the actual end-time passes, so
      // counting status='active' captures both overnight + day-use stays
      // currently in progress. The previous UTC-midnight date filter missed
      // day-use rows (stay_start at 14:00 Istanbul > midnight UTC = todayISO).
      countOr0(
        supabase
          .from('reservations')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
      ),
      countOr0(
        supabase
          .from('payment_collections')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'UNCONFIRMED'),
      ),
      countOr0(
        supabase
          .from('housekeeping_issues')
          .select('id', { count: 'exact', head: true })
          .neq('status', 'RESOLVED'),
      ),
      dirtyUnitsCount(),
    ]);

  return {
    checkInsToday,
    checkOutsToday,
    activeNow,
    pendingPayments,
    openIssues,
    dirtyUnits,
  };
}
