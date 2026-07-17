import { supabase } from '@/lib/supabase';
import type { Database, PaymentMethod, PaymentStatus } from '@/types/database';

type PaymentCollectionRow = Database['public']['Tables']['payment_collections']['Row'];

export type PaymentCollection = PaymentCollectionRow;

/**
 * payment_collections row enriched with reservation + guest + property/unit names
 * for the pending-approvals queue.
 */
export interface PendingPaymentWithRefs extends PaymentCollectionRow {
  reservation: {
    guest: { full_name: string } | null;
    unit: { name: string } | null;
  } | null;
  property: { name: string; type: string; region: string | null } | null;
}

export interface CollectPaymentInput {
  reservationId: string;
  amount: number;
  method: PaymentMethod;
  /** Required when method = CASH and caller can see cash_accounts. Otherwise the RPC auto-picks the property's CASH account. */
  cashAccountId?: string | null;
  note?: string | null;
}

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/**
 * Records a payment atomically — payment_collections + ledger PAYMENT entry +
 * (if CASH) cash_transactions IN. Server-side SECURITY DEFINER function enforces
 * the role × property-type rules; any rule violation surfaces as a thrown Error
 * with the Turkish message from the RPC.
 *
 * Returns the new payment_collections.id.
 */
export async function collectPayment(input: CollectPaymentInput): Promise<string> {
  const { data, error } = await supabase.rpc('collect_payment', {
    _reservation_id: input.reservationId,
    _amount: input.amount,
    _method: input.method,
    _cash_account_id: input.cashAccountId ?? null,
    _note: input.note ?? null,
  });
  if (error) throw wrapErr(error);
  if (!data) throw new Error('Ödeme kaydı oluşturulamadı');
  return data as string;
}

/**
 * Deletes a payment_collections row. Migration 016 wired ON DELETE CASCADE
 * to ledger_entries and cash_transactions via payment_collection_id, so this
 * single call removes the cari PAYMENT entry and the cash drawer IN entry
 * in lockstep. RLS limits this to SUPER_ADMIN.
 *
 * `.select()` ensures we detect silent zero-row outcomes (RLS deny or
 * pre-migration data) instead of optimistically reporting success.
 */
export async function deletePaymentCollection(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('payment_collections')
    .delete()
    .eq('id', id)
    .select();
  if (error) throw wrapErr(error);
  if (!data || data.length === 0) {
    throw new Error(
      'Tahsilat silinemedi. Yetkiniz olmayabilir veya migration 016 henüz uygulanmamış olabilir.',
    );
  }
}

/**
 * Lists every payment_collections row currently waiting for manager approval
 * (status = UNCONFIRMED). RLS scopes managers to their branch.
 */
export async function listUnconfirmedPayments(): Promise<PendingPaymentWithRefs[]> {
  const { data, error } = await supabase
    .from('payment_collections')
    .select(
      'id, reservation_id, property_id, collected_by_user_id, amount, method, receipt_photo_path, status, confirmed_by, confirmed_at, created_at, reservation:reservations(guest:guests(full_name), unit:units(name)), property:properties(name, type, region)',
    )
    .eq('status', 'UNCONFIRMED' satisfies PaymentStatus)
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as PendingPaymentWithRefs[]) ?? [];
}

/**
 * Manager approves a pending payment (Phase 3C). The RPC creates the
 * previously-deferred ledger PAYMENT entry and (if CASH) the cash_transactions
 * IN row, then stamps the audit row CONFIRMED.
 */
export async function confirmPayment(paymentId: string): Promise<PaymentCollectionRow> {
  const { data, error } = await supabase.rpc('confirm_payment', { _payment_id: paymentId });
  if (error) throw wrapErr(error);
  return data as unknown as PaymentCollectionRow;
}

/**
 * Counts payment_collections rows that represent money the operator has
 * already attempted to collect for this reservation — UNCONFIRMED + CONFIRMED.
 * DISPUTED rows are excluded (those were rejected and never moved money).
 * Used by the detail page to warn before a second Ödeme Topla.
 */
export async function countActivePaymentsForReservation(
  reservationId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('payment_collections')
    .select('id', { count: 'exact', head: true })
    .eq('reservation_id', reservationId)
    .in('status', ['UNCONFIRMED', 'CONFIRMED'] satisfies PaymentStatus[]);
  if (error) throw wrapErr(error);
  return count ?? 0;
}

/**
 * Returns a Map of reservation_id → total collected amount across active
 * (UNCONFIRMED or CONFIRMED) payment_collections rows. Lets the reservation
 * list render a "Kısmi / tam / fazladan Ödeme Alındı" badge per card by
 * comparing the collected sum against the reservation total, without an N+1
 * query loop. DISPUTED payments are excluded — those were rejected.
 */
export async function loadReservationsWithPayments(): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('payment_collections')
    .select('reservation_id, amount')
    .in('status', ['UNCONFIRMED', 'CONFIRMED'] satisfies PaymentStatus[]);
  if (error) throw wrapErr(error);
  const map = new Map<string, number>();
  for (const row of data ?? []) {
    if (!row.reservation_id) continue;
    map.set(row.reservation_id, (map.get(row.reservation_id) ?? 0) + Number(row.amount));
  }
  return map;
}

/**
 * Manager rejects a pending payment. Row is marked DISPUTED; no ledger/cash
 * entries are ever created. The row stays as an audit record.
 */
export async function disputePayment(paymentId: string): Promise<PaymentCollectionRow> {
  const { data, error } = await supabase.rpc('dispute_payment', { _payment_id: paymentId });
  if (error) throw wrapErr(error);
  return data as unknown as PaymentCollectionRow;
}
