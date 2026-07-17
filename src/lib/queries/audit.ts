import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type AuditRow = Database['public']['Tables']['audit_log']['Row'];
export type AuditEntry = AuditRow;

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

export interface AuditFilters {
  /** Filter by action name (e.g., 'DECRYPT'). Empty string = all. */
  action?: string;
  /** Filter by entity_type (e.g., 'sensitive_field'). Empty string = all. */
  entityType?: string;
  /** Filter by user_id. Empty string = all. */
  userId?: string;
  /** Lower bound (inclusive), ISO string. */
  from?: string;
  /** Upper bound (exclusive), ISO string. */
  to?: string;
}

export interface PageParams {
  /** Zero-based page index. */
  page: number;
  /** Rows per page. */
  pageSize: number;
}

export interface AuditPage {
  rows: AuditEntry[];
  /** Total row count matching the filters (server-side count via PostgREST). */
  total: number;
}

/**
 * Fetch a page of audit_log rows. RLS gates this to SUPER_ADMIN +
 * PROPERTY_MANAGER (audit_select in 003_rls.sql); the page also restricts
 * the UI further to SUPER_ADMIN.
 */
export async function listAuditLog(
  filters: AuditFilters,
  page: PageParams,
): Promise<AuditPage> {
  let q = supabase
    .from('audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (filters.action) q = q.eq('action', filters.action);
  if (filters.entityType) q = q.eq('entity_type', filters.entityType);
  if (filters.userId) q = q.eq('user_id', filters.userId);
  if (filters.from) q = q.gte('created_at', filters.from);
  if (filters.to) q = q.lt('created_at', filters.to);

  const from = page.page * page.pageSize;
  const to = from + page.pageSize - 1;
  const { data, error, count } = await q.range(from, to);
  if (error) throw wrapErr(error);
  return { rows: data ?? [], total: count ?? 0 };
}

/**
 * Distinct values for action / entity_type, used to populate the filter dropdowns.
 * Read once on page load; cheap because audit_log is well-indexed.
 *
 * PostgREST doesn't expose SELECT DISTINCT, so we pull a wide page and dedupe
 * client-side. Capped to the most recent N entries to keep the scan bounded.
 */
export async function listAuditFacets(limit = 1000): Promise<{
  actions: string[];
  entityTypes: string[];
}> {
  const { data, error } = await supabase
    .from('audit_log')
    .select('action, entity_type')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw wrapErr(error);
  const actions = new Set<string>();
  const types = new Set<string>();
  for (const r of data ?? []) {
    if (r.action) actions.add(r.action);
    if (r.entity_type) types.add(r.entity_type);
  }
  return {
    actions: Array.from(actions).sort(),
    entityTypes: Array.from(types).sort(),
  };
}

/**
 * Build a quick Map<user_id, full_name> for the staff who appear in
 * audit_log so the UI can render names instead of raw uuids.
 *
 * Filtered to just the user_ids in the given list so we don't pull every
 * staff profile when only two distinct users have audit rows on this page.
 */
export async function lookupStaffNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const unique = Array.from(new Set(userIds));
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('user_id, full_name')
    .in('user_id', unique);
  if (error) throw wrapErr(error);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.user_id, row.full_name);
  }
  return map;
}
