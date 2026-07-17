import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type PropertyDateNote = Database['public']['Tables']['property_date_notes']['Row'];

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/** Notes that fall within the visible date window. note_date is a DATE → string. */
export async function listNotesInRange(
  startDate: string,
  endDate: string,
): Promise<PropertyDateNote[]> {
  const { data, error } = await supabase
    .from('property_date_notes')
    .select('*')
    .gte('note_date', startDate)
    .lt('note_date', endDate)
    .order('note_date', { ascending: true });
  if (error) throw wrapErr(error);
  return data ?? [];
}

export interface NoteUpsertInput {
  property_id: string;
  unit_id: string;
  note_date: string;
  note: string;
  created_by: string;
}

/**
 * Upsert by (unit_id, note_date) — the unique index. Calling this for the
 * same cell repeatedly overwrites the previous note instead of creating
 * duplicates.
 */
export async function upsertNote(input: NoteUpsertInput): Promise<PropertyDateNote> {
  const { data, error } = await supabase
    .from('property_date_notes')
    .upsert(input, { onConflict: 'unit_id,note_date' })
    .select()
    .single();
  if (error) throw wrapErr(error);
  return data;
}

export async function deleteNote(id: string): Promise<void> {
  const { error } = await supabase.from('property_date_notes').delete().eq('id', id);
  if (error) throw wrapErr(error);
}
