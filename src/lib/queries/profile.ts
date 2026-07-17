import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type StaffRow = Database['public']['Tables']['staff_profiles']['Row'];

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/**
 * Self-service rename — calls the `update_own_full_name` RPC (migration 027).
 * Only updates the caller's own staff_profiles row; salary / role / branch
 * are left untouched. Returns the fresh row so the caller can sync local state.
 */
export async function updateOwnFullName(fullName: string): Promise<StaffRow> {
  const { data, error } = await supabase.rpc('update_own_full_name', {
    p_full_name: fullName,
  });
  if (error) throw wrapErr(error);
  if (!data) throw new Error('Profil güncellenemedi.');
  return data;
}
