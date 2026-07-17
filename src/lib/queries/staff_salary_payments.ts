import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type StaffSalaryPayment =
  Database['public']['Tables']['staff_salary_payments']['Row'];

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) => {
  if (e.code === '23505') {
    // UNIQUE (user_id, pay_period) — already paid for this month.
    return new Error('Bu personele bu ay için zaten maaş ödenmiş.');
  }
  return new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );
};

/** Past salary payments for a single staff member, newest first. */
export async function listSalaryPaymentsForStaff(
  userId: string,
): Promise<StaffSalaryPayment[]> {
  const { data, error } = await supabase
    .from('staff_salary_payments')
    .select('*')
    .eq('user_id', userId)
    .order('paid_at', { ascending: false });
  if (error) throw wrapErr(error);
  return data ?? [];
}

/**
 * Manual salary payment via the pay_staff_salary RPC (migration 049). The
 * RPC wraps a kasa OUT + payment row in a single atomic operation and runs
 * SECURITY DEFINER, so the caller doesn't need direct INSERT rights on
 * cash_transactions. Throws a friendly Turkish error if this period has
 * already been paid.
 */
export async function payStaffSalary(input: {
  userId: string;
  amount: number;
  payPeriod: string; // YYYY-MM-DD — typically first-of-month
  note?: string | null;
}): Promise<StaffSalaryPayment> {
  const { data, error } = await supabase.rpc('pay_staff_salary', {
    _user_id: input.userId,
    _amount: input.amount,
    _pay_period: input.payPeriod,
    _note: input.note ?? null,
  });
  if (error) throw wrapErr(error);
  return data;
}
