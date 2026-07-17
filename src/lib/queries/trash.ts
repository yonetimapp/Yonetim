import { supabase } from '@/lib/supabase';
import { deleteIssuePhotos } from '@/lib/photos';
import type { Database, Json } from '@/types/database';

type TrashRow = Database['public']['Tables']['trash_entries']['Row'];
export type TrashEntry = TrashRow;

/**
 * Entity types currently supported by the trash bin. Must match the CASE
 * branches in soft_delete_entity / restore_trash (migration 021).
 */
export const TRASHABLE_TYPES = [
  'housekeeping_issues',
  'reservations',
  'cash_transactions',
  'ledger_entries',
  'expenses',
  'message_templates',
  'staff_advances',
  'units',
] as const;

export type TrashableType = (typeof TRASHABLE_TYPES)[number];

/**
 * Turkish display labels for trashable entity types. Used in the
 * Çöp Kutusu UI's group headers and per-row metadata.
 */
export const TRASHABLE_LABELS: Record<TrashableType, string> = {
  housekeeping_issues: 'Sorunlar',
  reservations: 'Rezervasyonlar',
  cash_transactions: 'Kasa Hareketleri',
  ledger_entries: 'Cari Hareketler',
  expenses: 'Giderler',
  message_templates: 'Şablonlar',
  staff_advances: 'Personel Avansları',
  units: 'Birimler',
};

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/**
 * Lists all trash entries the caller can see. RLS on trash_entries means
 * this returns rows only for SUPER_ADMIN; other roles get an empty array.
 */
export async function listTrash(): Promise<TrashEntry[]> {
  const { data, error } = await supabase
    .from('trash_entries')
    .select('*')
    .order('deleted_at', { ascending: false });
  if (error) throw wrapErr(error);
  return data ?? [];
}

/**
 * Soft-delete an entity via the central RPC. Replaces direct `.delete()`
 * calls across the app. Returns the new trash_entries id.
 */
export async function softDeleteEntity(
  entityType: TrashableType,
  entityId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('soft_delete_entity', {
    p_type: entityType,
    p_id: entityId,
  });
  if (error) throw wrapErr(error);
  if (!data) throw new Error('Silinemedi.');
  return data;
}

/**
 * Restore a trashed entry back to its original table. RLS gates this to
 * SUPER_ADMIN. Throws if the trash row is gone or restore fails (e.g.,
 * FK references a now-missing parent).
 */
export async function restoreTrashEntry(trashId: string): Promise<void> {
  const { error } = await supabase.rpc('restore_trash', { _trash_id: trashId });
  if (error) throw wrapErr(error);
}

/**
 * Permanently delete a trash entry. Best-effort cleans up associated
 * resources (currently: housekeeping_issues photos). The DELETE itself
 * is RLS-gated to SUPER_ADMIN.
 */
export async function purgeTrashEntry(entry: TrashEntry): Promise<void> {
  // Best-effort resource cleanup BEFORE the row is gone — otherwise we lose
  // the payload that points to the resources.
  if (entry.entity_type === 'housekeeping_issues') {
    const payload = entry.payload as { photo_paths?: string[] } | null;
    const paths = Array.isArray(payload?.photo_paths) ? payload!.photo_paths : [];
    await deleteIssuePhotos(paths);
  }

  const { data, error } = await supabase
    .from('trash_entries')
    .delete()
    .eq('id', entry.id)
    .select();
  if (error) throw wrapErr(error);
  if (!data || data.length === 0) {
    throw new Error('Kalıcı silme başarısız. Yetkiniz olmayabilir.');
  }
}

/** Convenience: payload field accessor with safe fallback. */
export function payloadField<T = unknown>(entry: TrashEntry, key: string): T | undefined {
  if (entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)) {
    return (entry.payload as Record<string, Json | undefined>)[key] as T | undefined;
  }
  return undefined;
}
