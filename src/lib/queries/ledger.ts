import { supabase } from '@/lib/supabase';
import { softDeleteEntity } from '@/lib/queries/trash';
import type { Database, PaymentMethod } from '@/types/database';

type LedgerRow = Database['public']['Tables']['ledger_entries']['Row'];
type LedgerInsert = Database['public']['Tables']['ledger_entries']['Insert'];

export interface LedgerEntry extends LedgerRow {
  /** Joined from payment_collections — set on PAYMENT entries that have a
      payment_collection_id. Lets the cari hesap card surface the actual
      payment method (Nakit / Havale / Kart) below "Misafirden Alındı". */
  payment_collection?: { method: PaymentMethod } | null;
}

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/**
 * Entries for a single reservation, newest first.
 * Filters strictly by reservation_id — does NOT include guest-scoped entries
 * (reservation_id IS NULL) that may also belong to this guest.
 */
export async function listLedgerForReservation(reservationId: string): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('*, payment_collection:payment_collections(method)')
    .eq('reservation_id', reservationId)
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as LedgerEntry[]) ?? [];
}

/** All entries for a guest, newest first — useful for a future guest-level cari view. */
export async function listLedgerForGuest(guestId: string): Promise<LedgerRow[]> {
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('*')
    .eq('guest_id', guestId)
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return data ?? [];
}

export async function createLedgerEntry(input: LedgerInsert): Promise<LedgerRow> {
  const { data, error } = await supabase
    .from('ledger_entries')
    .insert(input)
    .select()
    .single();
  if (error) throw wrapErr(error);
  return data;
}

/**
 * Soft-delete a single ledger entry → lands in Çöp Kutusu. RLS gates the
 * underlying delete to SUPER_ADMIN (migration 017).
 *
 * Callers should prefer `deletePaymentCollection` for entries that have a
 * payment_collection_id set — that path cascades and keeps the cash drawer
 * in sync (and bypasses trash because cascade can't be partially restored).
 */
export async function deleteLedgerEntry(id: string): Promise<void> {
  await softDeleteEntity('ledger_entries', id);
}

/** Balance = SUM(DEBT) − SUM(PAYMENT). Positive means the guest still owes. */
export function balanceFor(entries: LedgerEntry[]): number {
  return entries.reduce(
    (acc, e) => acc + (e.type === 'DEBT' ? Number(e.amount) : -Number(e.amount)),
    0,
  );
}
