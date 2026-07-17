import { supabase } from '@/lib/supabase';
import { softDeleteEntity } from '@/lib/queries/trash';
import type { Database, TxDirection } from '@/types/database';

type CashAccountRow = Database['public']['Tables']['cash_accounts']['Row'];
type CashTxRow = Database['public']['Tables']['cash_transactions']['Row'];

export type CashAccount = CashAccountRow;
export type CashTransaction = CashTxRow;

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

// =============================================================================
// Kasa — exactly one per region (migration 094 + 124), created together with the
// region by create_region(). RLS scopes what each user sees: a region-scoped
// manager sees only their own region's kasa, an all-region user sees every kasa.
//
// Region is NOT NULL as of migration 124, so "the main kasa" is no longer "the
// one with region IS NULL" — it is the kasa of the region flagged is_default.
// =============================================================================

/** The default kasa for the current user — the default region's kasa for an
 *  all-region user, or their own region's kasa for a region-scoped one.
 *  Null if unseeded. */
export async function getGeneralKasa(): Promise<CashAccountRow | null> {
  // Resolve the default region first. Ordering by `region` can't stand in for
  // this any more: it used to work only because the main kasa's region was NULL
  // and NULLS FIRST floated it to the top. Every kasa has a real region name now,
  // so that same ordering would just pick whichever sorts first alphabetically.
  const { data: def } = await supabase
    .from('regions')
    .select('name')
    .eq('is_default', true)
    .maybeSingle();

  if (def?.name) {
    const { data, error } = await supabase
      .from('cash_accounts')
      .select('*')
      .eq('region', def.name)
      .maybeSingle();
    if (error) throw wrapErr(error);
    if (data) return data;
  }

  // Fallback: a region-scoped manager can't see the default region's kasa (RLS
  // returns no row above), so give them the one kasa they do have.
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .order('region', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw wrapErr(error);
  return data;
}

/** Every kasa the current user can see, by region name. An all-region user sees
 *  all of them; a region-scoped manager sees only their own.
 *  Drives the kasa switcher on the Kasa page. */
export async function listCashAccounts(): Promise<CashAccountRow[]> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .order('region', { ascending: true });
  if (error) throw wrapErr(error);
  return data ?? [];
}

// =============================================================================
// Cash transactions
// =============================================================================

/**
 * A kasa transaction enriched with its source reservation + guest, for
 * movements that came from a guest payment. Manual entries and expense
 * movements have no payment_collection.
 */
export interface CashTransactionWithRefs extends CashTxRow {
  payment_collection?: {
    created_at: string;
    reservation: {
      id: string;
      stay_start: string;
      guest: { full_name: string } | null;
      unit: { name: string } | null;
    } | null;
  } | null;
}

/**
 * Transactions for the kasa, newest first. Filters to approved rows only —
 * pending and rejected movements live in the /finance/pending queue and
 * shouldn't pollute the main kasa view (or its visible balance).
 */
export async function listCashTransactions(
  accountId: string,
): Promise<CashTransactionWithRefs[]> {
  const { data, error } = await supabase
    .from('cash_transactions')
    .select(
      '*, payment_collection:payment_collections(created_at, reservation:reservations(id, stay_start, guest:guests(full_name), unit:units(name)))',
    )
    .eq('cash_account_id', accountId)
    .eq('approval_status', 'approved')
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as CashTransactionWithRefs[]) ?? [];
}

/**
 * Submit a manual kasa entry via the submit_cash_tx RPC. Since migration 067
 * EVERY caller's entry (SUPER_ADMIN included) lands as approval_status='pending'
 * and waits for yönetici onay at /finance/pending — it only posts to the kasa
 * balance once approved.
 */
export async function submitCashTransaction(input: {
  cash_account_id: string;
  amount: number;
  direction: TxDirection;
  description: string | null;
}): Promise<CashTxRow> {
  const { data, error } = await supabase.rpc('submit_cash_tx', {
    _cash_account_id: input.cash_account_id,
    _amount: input.amount,
    _direction: input.direction,
    _description: input.description,
  });
  if (error) throw wrapErr(error);
  return data as CashTxRow;
}

/**
 * Soft-delete a cash transaction → lands in Çöp Kutusu. RLS gates the
 * underlying delete to SUPER_ADMIN (migration 015).
 */
export async function deleteCashTransaction(id: string): Promise<void> {
  await softDeleteEntity('cash_transactions', id);
}

/** Sum of IN minus sum of OUT. Pure client-side reduction. */
export function balanceOf(txs: CashTxRow[]): number {
  return txs.reduce(
    (acc, t) => acc + (t.direction === 'IN' ? Number(t.amount) : -Number(t.amount)),
    0,
  );
}
