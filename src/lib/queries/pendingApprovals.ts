import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type ExpenseRow = Database['public']['Tables']['expenses']['Row'];
type CashTxRow = Database['public']['Tables']['cash_transactions']['Row'];

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

// =============================================================================
// Pending expense submissions — created with status='pending' by record_expense
// when the caller isn't SUPER_ADMIN (migration 055). The /finance/pending page
// shows them under the "Gider" tab so admin can approve or reject.
// =============================================================================

export interface PendingExpense extends ExpenseRow {
  property: { name: string; type: string } | null;
}

export async function listPendingExpenses(): Promise<PendingExpense[]> {
  const { data, error } = await supabase
    .from('expenses')
    .select('*, property:properties(name, type)')
    .eq('approval_status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as PendingExpense[]) ?? [];
}

export async function approveExpense(expenseId: string): Promise<ExpenseRow> {
  const { data, error } = await supabase.rpc('approve_expense', { _expense_id: expenseId });
  if (error) throw wrapErr(error);
  return data as ExpenseRow;
}

export async function rejectExpense(
  expenseId: string,
  reason: string | null = null,
): Promise<ExpenseRow> {
  const { data, error } = await supabase.rpc('reject_expense', {
    _expense_id: expenseId,
    _reason: reason,
  });
  if (error) throw wrapErr(error);
  return data as ExpenseRow;
}

// =============================================================================
// Pending manual cash_transactions submissions — inserted with status='pending'
// by submit_cash_tx for non-admin callers. Approval flips status='approved',
// at which point cash_account_balances() starts counting the row.
// =============================================================================

export interface PendingCashTx extends CashTxRow {
  // The kasa this movement belongs to → its region (a regions.name). Nullable
  // only because the embed itself can come back empty, not the column.
  cash_account: { region: string | null } | null;
}

export async function listPendingCashTransactions(): Promise<PendingCashTx[]> {
  const { data, error } = await supabase
    .from('cash_transactions')
    .select('*, cash_account:cash_accounts(region)')
    .eq('approval_status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as PendingCashTx[]) ?? [];
}

/**
 * Total count of everything still awaiting manager approval — pending expenses
 * + pending manual cash entries + UNCONFIRMED payment collections. Three
 * head-only count queries (no rows transferred) so it's cheap enough to run on
 * every finance page load to badge the "Onaylar" tab. RLS scopes the counts to
 * the caller's branch automatically.
 */
export async function countPendingApprovals(
  includeReservations = false,
): Promise<number> {
  const [exp, cash, pay] = await Promise.all([
    supabase
      .from('expenses')
      .select('id', { count: 'exact', head: true })
      .eq('approval_status', 'pending'),
    supabase
      .from('cash_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('approval_status', 'pending'),
    supabase
      .from('payment_collections')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'UNCONFIRMED'),
  ]);
  if (exp.error) throw wrapErr(exp.error);
  if (cash.error) throw wrapErr(cash.error);
  if (pay.error) throw wrapErr(pay.error);
  let total = (exp.count ?? 0) + (cash.count ?? 0) + (pay.count ?? 0);

  // Reservation deletion requests are resolved by SUPER_ADMIN only (the Onaylar
  // "Rezervasyonlar" tab is theirs), so only fold them into the badge for them —
  // a manager would otherwise see a count with no tab to act on.
  if (includeReservations) {
    const rez = await supabase
      .from('reservation_deletion_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (rez.error) throw wrapErr(rez.error);
    total += rez.count ?? 0;
  }
  return total;
}

export async function approveCashTransaction(id: string): Promise<CashTxRow> {
  const { data, error } = await supabase.rpc('approve_cash_tx', { _cash_tx_id: id });
  if (error) throw wrapErr(error);
  return data as CashTxRow;
}

export async function rejectCashTransaction(
  id: string,
  reason: string | null = null,
): Promise<CashTxRow> {
  const { data, error } = await supabase.rpc('reject_cash_tx', {
    _cash_tx_id: id,
    _reason: reason,
  });
  if (error) throw wrapErr(error);
  return data as CashTxRow;
}

// =============================================================================
// Pending reservation DELETION requests — filed by non-admins (migration 090).
// SUPER_ADMIN approves (deletes the reservation → Çöp Kutusu) or denies (keeps
// it) from the Onaylar "Rezervasyonlar" tab.
// =============================================================================

export interface PendingReservationDeletion {
  id: string;
  reservation_id: string;
  reason: string | null;
  requested_by: string | null;
  created_at: string;
  reservation: {
    stay_start: string;
    stay_end: string;
    guest: { full_name: string } | null;
    unit: { name: string } | null;
    property: { name: string; region: string | null } | null;
  } | null;
}

export async function listPendingReservationDeletions(): Promise<PendingReservationDeletion[]> {
  const { data, error } = await supabase
    .from('reservation_deletion_requests')
    .select(
      'id, reservation_id, reason, requested_by, created_at, reservation:reservations(stay_start, stay_end, guest:guests(full_name), unit:units(name), property:properties(name, region))',
    )
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw wrapErr(error);
  return (data as unknown as PendingReservationDeletion[]) ?? [];
}

export async function approveReservationDeletion(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('approve_reservation_deletion', {
    _request_id: requestId,
  });
  if (error) throw wrapErr(error);
}

export async function denyReservationDeletion(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('deny_reservation_deletion', {
    _request_id: requestId,
  });
  if (error) throw wrapErr(error);
}
