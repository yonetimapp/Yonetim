import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type PropertyBlock = Database['public']['Tables']['property_blocks']['Row'];

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) => {
  // Match the friendly translations from queries/reservations.ts so the
  // calendar surfaces the same Turkish message whether the overlap is
  // reservation×reservation, block×reservation, or block×block.
  if (e.code === '23P01') {
    return new Error(
      e.message ?? 'Bu birim seçilen tarihler arasında başka bir rezervasyon/blokla çakışıyor.',
    );
  }
  return new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );
};

/**
 * Blocks that overlap the [startISO, endISO) window. A block overlaps when it
 * starts before the window ends and ends after the window starts — same shape
 * as listReservationsInRange so the calendar can use them interchangeably.
 */
export async function listBlocksInRange(
  startISO: string,
  endISO: string,
): Promise<PropertyBlock[]> {
  const { data, error } = await supabase
    .from('property_blocks')
    .select('*')
    .lt('block_start', endISO)
    .gt('block_end', startISO)
    .order('block_start', { ascending: true });
  if (error) throw wrapErr(error);
  return data ?? [];
}

export interface BlockInput {
  property_id: string;
  unit_id: string;
  block_start: string;
  block_end: string;
  reason?: string | null;
  created_by: string;
}

export async function createBlock(input: BlockInput): Promise<PropertyBlock> {
  const { data, error } = await supabase
    .from('property_blocks')
    .insert(input)
    .select()
    .single();
  if (error) throw wrapErr(error);
  return data;
}

export async function deleteBlock(id: string): Promise<void> {
  const { error } = await supabase.from('property_blocks').delete().eq('id', id);
  if (error) throw wrapErr(error);
}
