import { supabase } from '@/lib/supabase';
import { softDeleteEntity } from '@/lib/queries/trash';
import type { GuestRow, DecryptedGuest } from '@/types/database';

/** Lightweight guest summary for list pages (no encrypted fields, no decryption). */
export interface GuestSummary {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  is_problematic: boolean;
  created_at: string;
  created_by: string | null;
}

export interface GuestInput {
  full_name: string;
  tc_kimlik?: string | null;
  passport?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  nationality?: string | null;
  is_problematic?: boolean;
  problematic_note?: string | null;
}

/**
 * Lists guests visible to the current user (RLS-filtered).
 * Selects only non-sensitive fields — no decryption, no audit log entry.
 * Includes is_problematic so list rows can flag warned guests at a glance
 * (migration 043).
 */
export async function listGuests(): Promise<GuestSummary[]> {
  const { data, error } = await supabase
    .from('guests')
    .select('id, full_name, phone, email, nationality, is_problematic, created_at, created_by')
    .order('full_name');
  if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.hint ? ` [${error.hint}]` : ''}${error.code ? ` (${error.code})` : ''}`);
  return data ?? [];
}

/**
 * Maps guest id → the set of regions they are linked to. A guest has no region of
 * their own: they belong to a region only by virtue of a reservation at a mülk in
 * it (and may span several). Powers the region filter on the misafir list for
 * all-region users.
 *
 * Two plain queries rather than one embedded filter — the embedded-filter syntax
 * silently failed here before. Both are RLS-scoped, so a region-limited caller
 * simply gets a map covering their own region.
 */
export async function listGuestRegions(): Promise<Map<string, Set<string>>> {
  const { data: props, error: pe } = await supabase
    .from('properties')
    .select('id, region');
  if (pe) throw new Error(`${pe.message}${pe.code ? ` (${pe.code})` : ''}`);
  const regionByProperty = new Map((props ?? []).map((p) => [p.id, p.region]));
  if (regionByProperty.size === 0) return new Map();

  // Soft-deleted reservations live in trash_entries, not here — no deleted_at
  // column to filter (filtering a missing column errored and broke the filter).
  const { data, error } = await supabase
    .from('reservations')
    .select('guest_id, property_id');
  if (error) throw new Error(`${error.message}${error.code ? ` (${error.code})` : ''}`);

  const byGuest = new Map<string, Set<string>>();
  for (const r of (data ?? []) as { guest_id: string; property_id: string | null }[]) {
    const region = r.property_id ? regionByProperty.get(r.property_id) : undefined;
    if (!region) continue;
    const set = byGuest.get(r.guest_id);
    if (set) set.add(region);
    else byGuest.set(r.guest_id, new Set([region]));
  }
  return byGuest;
}

/**
 * Fetches a guest with TC/passport decrypted server-side.
 * Each call writes an entry to audit_log (KVKK requirement).
 */
export async function getGuestDecrypted(id: string): Promise<DecryptedGuest | null> {
  const { data, error } = await supabase.rpc('get_guest_decrypted', { _id: id });
  if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.hint ? ` [${error.hint}]` : ''}${error.code ? ` (${error.code})` : ''}`);
  return data?.[0] ?? null;
}

/** Creates a guest. Sensitive fields are encrypted server-side. */
export async function createGuest(input: GuestInput): Promise<GuestRow> {
  const { data, error } = await supabase.rpc('create_guest', {
    _full_name: input.full_name,
    _tc_kimlik: input.tc_kimlik ?? null,
    _passport: input.passport ?? null,
    _phone: input.phone ?? null,
    _email: input.email ?? null,
    _address: input.address ?? null,
    _nationality: input.nationality ?? null,
    _is_problematic: input.is_problematic ?? false,
    _problematic_note: input.problematic_note ?? null,
  });
  if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.hint ? ` [${error.hint}]` : ''}${error.code ? ` (${error.code})` : ''}`);
  return data;
}

/** Updates a guest. Passing NULL for TC/passport clears that field. */
export async function updateGuest(id: string, input: GuestInput): Promise<GuestRow> {
  const { data, error } = await supabase.rpc('update_guest', {
    _id: id,
    _full_name: input.full_name,
    _tc_kimlik: input.tc_kimlik ?? null,
    _passport: input.passport ?? null,
    _phone: input.phone ?? null,
    _email: input.email ?? null,
    _address: input.address ?? null,
    _nationality: input.nationality ?? null,
    _is_problematic: input.is_problematic ?? false,
    _problematic_note: input.problematic_note ?? null,
  });
  if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.hint ? ` [${error.hint}]` : ''}${error.code ? ` (${error.code})` : ''}`);
  return data;
}

/**
 * Quick-toggle the "Sorunlu Misafir" flag on a guest, with an optional note.
 * Backed by set_guest_problematic (migration 043) which runs SECURITY INVOKER
 * — RLS on guests is the security boundary, same as updateGuest.
 */
export async function setGuestProblematic(
  id: string,
  isProblematic: boolean,
  note: string | null,
): Promise<GuestRow> {
  const { data, error } = await supabase.rpc('set_guest_problematic', {
    _id: id,
    _is_problematic: isProblematic,
    _note: note,
  });
  if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.hint ? ` [${error.hint}]` : ''}${error.code ? ` (${error.code})` : ''}`);
  return data;
}

/**
 * Counts the rows that block a guest delete (FK RESTRICT on reservations
 * and ledger_entries). Used to produce a helpful error message — the user
 * may have already deleted the reservation but orphaned ledger entries
 * (with reservation_id = NULL) still keep the guest pinned.
 */
export async function countGuestReferences(
  id: string,
): Promise<{ reservations: number; ledgerEntries: number }> {
  const [r, l] = await Promise.all([
    supabase
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .eq('guest_id', id),
    supabase
      .from('ledger_entries')
      .select('id', { count: 'exact', head: true })
      .eq('guest_id', id),
  ]);
  return {
    reservations: r.count ?? 0,
    ledgerEntries: l.count ?? 0,
  };
}

/** Deletes a guest. Only SUPER_ADMIN is permitted per RLS. */
export async function deleteGuest(id: string): Promise<void> {
  const { error } = await supabase.from('guests').delete().eq('id', id);
  if (!error) return;

  // FK violation: figure out exactly what's blocking so the user knows what to fix.
  if (error.code === '23503') {
    const refs = await countGuestReferences(id).catch(() => null);
    if (refs) {
      const parts: string[] = [];
      if (refs.reservations > 0) parts.push(`${refs.reservations} rezervasyon`);
      if (refs.ledgerEntries > 0) parts.push(`${refs.ledgerEntries} cari hareket`);
      if (parts.length > 0) {
        throw new Error(
          `Bu misafire bağlı ${parts.join(' ve ')} bulunduğu için silinemez. Önce ilgili kayıtları kaldırın.`,
        );
      }
    }
    throw new Error(
      'Bu misafir başka kayıtlara bağlı olduğu için silinemez. Önce bağlı kayıtları kaldırın.',
    );
  }

  throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.hint ? ` [${error.hint}]` : ''}${error.code ? ` (${error.code})` : ''}`);
}

/**
 * Cascade delete: soft-deletes every reservation + ledger entry tied to
 * the guest (each lands in Çöp Kutusu), then hard-deletes the guest.
 *
 * Note: guests aren't in trash scope, so the guest goes away permanently.
 * Restoring the cascaded ledgers/reservations later will fail because
 * their guest_id FK points to a row that no longer exists.
 *
 * Aborts on first sub-delete failure (no transaction wrapping — each soft
 * delete is its own RPC call). Re-running is safe; already-deleted rows
 * are skipped automatically.
 */
export async function cascadeDeleteGuest(id: string): Promise<void> {
  const [ledgerRes, resvRes] = await Promise.all([
    supabase.from('ledger_entries').select('id').eq('guest_id', id),
    supabase.from('reservations').select('id').eq('guest_id', id),
  ]);
  if (ledgerRes.error) throw new Error(`Cari hareketler okunamadı: ${ledgerRes.error.message}`);
  if (resvRes.error) throw new Error(`Rezervasyonlar okunamadı: ${resvRes.error.message}`);

  for (const row of ledgerRes.data ?? []) {
    await softDeleteEntity('ledger_entries', row.id);
  }
  for (const row of resvRes.data ?? []) {
    await softDeleteEntity('reservations', row.id);
  }

  // Final hard delete of the guest itself.
  await deleteGuest(id);
}
