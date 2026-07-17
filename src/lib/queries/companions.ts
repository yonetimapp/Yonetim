import { supabase } from '@/lib/supabase';
import type { DecryptedCompanion } from '@/types/database';

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

export interface CompanionInput {
  fullName: string;
  relationship: string | null;
  birthDate: string | null; // 'YYYY-MM-DD'
  nationality: string | null;
  tcKimlik: string | null;
  passport: string | null;
}

/**
 * A guest's companions (Ek Misafir) with TC kimlik / passport decrypted.
 * The RPC audit-logs the access — KVKK requirement, same as the main guest.
 */
export async function getCompanionsDecrypted(guestId: string): Promise<DecryptedCompanion[]> {
  const { data, error } = await supabase.rpc('get_companions_decrypted', {
    _guest_id: guestId,
  });
  if (error) throw wrapErr(error);
  return data ?? [];
}

/** Create a companion. TC / passport are encrypted server-side. */
export async function createCompanion(guestId: string, input: CompanionInput): Promise<void> {
  const { error } = await supabase.rpc('create_companion', {
    _guest_id: guestId,
    _full_name: input.fullName,
    _relationship: input.relationship,
    _birth_date: input.birthDate,
    _nationality: input.nationality,
    _tc_kimlik: input.tcKimlik,
    _passport: input.passport,
  });
  if (error) throw wrapErr(error);
}

/** Update a companion. Passing null for TC / passport clears that field. */
export async function updateCompanion(id: string, input: CompanionInput): Promise<void> {
  const { error } = await supabase.rpc('update_companion', {
    _id: id,
    _full_name: input.fullName,
    _relationship: input.relationship,
    _birth_date: input.birthDate,
    _nationality: input.nationality,
    _tc_kimlik: input.tcKimlik,
    _passport: input.passport,
  });
  if (error) throw wrapErr(error);
}

/** Delete a companion. */
export async function deleteCompanion(id: string): Promise<void> {
  const { error } = await supabase.from('guest_companions').delete().eq('id', id);
  if (error) throw wrapErr(error);
}
