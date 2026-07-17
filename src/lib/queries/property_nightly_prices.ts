import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type NightlyPrice = Database['public']['Tables']['property_nightly_prices']['Row'];

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/** Price overrides that fall within the visible calendar window. */
export async function listPricesInRange(
  startDate: string,
  endDate: string,
): Promise<NightlyPrice[]> {
  const { data, error } = await supabase
    .from('property_nightly_prices')
    .select('*')
    .gte('price_date', startDate)
    .lt('price_date', endDate)
    .order('price_date', { ascending: true });
  if (error) throw wrapErr(error);
  return data ?? [];
}

/**
 * Bulk-set a flat price across a date range. Backed by set_nightly_price_range
 * (migration 047) which upserts one row per night in [startDate, endDate]
 * inclusive. Returns the count of nights affected.
 */
export async function setPriceRange(
  propertyId: string,
  unitId: string,
  startDate: string,
  endDate: string,
  price: number,
): Promise<number> {
  const { data, error } = await supabase.rpc('set_nightly_price_range', {
    _property_id: propertyId,
    _unit_id: unitId,
    _start_date: startDate,
    _end_date: endDate,
    _price: price,
  });
  if (error) throw wrapErr(error);
  return data ?? 0;
}

export async function deletePrice(id: string): Promise<void> {
  const { error } = await supabase.from('property_nightly_prices').delete().eq('id', id);
  if (error) throw wrapErr(error);
}
