import { supabase } from '@/lib/supabase';
import type { Database, HousekeepingStatus } from '@/types/database';

type TaskRow = Database['public']['Tables']['housekeeping_tasks']['Row'];
type TaskInsert = Database['public']['Tables']['housekeeping_tasks']['Insert'];

export type HousekeepingTask = TaskRow;

export interface TaskWithRefs extends TaskRow {
  unit: { name: string; room_type: string; property_id: string } | null;
  property: { name: string; type: string } | null;
}

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/**
 * Lists every housekeeping_tasks row visible to the caller (RLS-filtered to
 * the caller's branch via hk_tasks_select). Caller is expected to call
 * `latestPerUnit()` to derive each unit's current status.
 *
 * We don't aggregate server-side (no DISTINCT ON in PostgREST) — for a
 * realistic property count this is cheap.
 */
export async function listAllTasks(): Promise<TaskWithRefs[]> {
  const { data, error } = await supabase
    .from('housekeeping_tasks')
    .select(
      'id, property_id, unit_id, status, notes, updated_by, updated_at, created_at, unit:units(name, room_type, property_id), property:properties(name, type)',
    )
    .order('updated_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as TaskWithRefs[]) ?? [];
}

/**
 * Append a new status-change event. We never UPDATE — the row history
 * doubles as an audit trail. The UI uses latestPerUnit() to compute the
 * "current" state.
 */
export async function recordTaskStatus(input: TaskInsert): Promise<TaskRow> {
  const { data, error } = await supabase
    .from('housekeeping_tasks')
    .insert(input)
    .select()
    .single();
  if (error) throw wrapErr(error);
  return data;
}

/**
 * Reduce a list of task events to the latest entry per unit_id.
 * `tasks` is expected to be ordered newest-first (as `listAllTasks()` returns).
 */
export function latestPerUnit(tasks: TaskWithRefs[]): Map<string, TaskWithRefs> {
  const out = new Map<string, TaskWithRefs>();
  for (const t of tasks) {
    if (!out.has(t.unit_id)) out.set(t.unit_id, t);
  }
  return out;
}

/** Default status for units with no recorded task history. */
export const DEFAULT_STATUS: HousekeepingStatus = 'DIRTY';
