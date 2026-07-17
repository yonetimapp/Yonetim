import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type PropertyRow = Database['public']['Tables']['properties']['Row'];
type PropertyInsert = Database['public']['Tables']['properties']['Insert'];
type PropertyUpdate = Database['public']['Tables']['properties']['Update'];

export type Property = PropertyRow;

/** List all properties visible to the current user (RLS-filtered). */
export async function listProperties() {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/** Distinct region (bölge) labels currently in use — powers the Bölge picker
 *  so an existing region is clicked, not re-typed. RLS-filtered. */
export async function listRegions(): Promise<string[]> {
  const { data, error } = await supabase
    .from('properties')
    .select('region')
    .not('region', 'is', null);
  if (error) throw error;
  const set = new Set<string>();
  for (const r of data ?? []) if (r.region) set.add(r.region);
  return [...set].sort();
}

/** Fetch a single property by ID. Returns null if not found / not visible. */
export async function getProperty(id: string) {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createProperty(input: PropertyInsert) {
  const { data, error } = await supabase
    .from('properties')
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateProperty(id: string, input: PropertyUpdate) {
  const { data, error } = await supabase
    .from('properties')
    .update(input)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Delete a property via the `delete_property` RPC (migration 079). The RPC
 * "breaks the tie" (bağı kopar) instead of cascading: reservations, cash
 * transactions and expenses are PRESERVED — their property/unit reference is
 * nulled and the property's name is snapshotted onto the row, so they keep
 * showing as "silinmiş olan <isim>". Operational data (units, housekeeping,
 * blocks, notes, nightly-prices) is removed with the property. SUPER_ADMIN only
 * (enforced inside the RPC). This is irreversible.
 */
export async function deleteProperty(id: string) {
  const { error } = await supabase.rpc('delete_property', { _property_id: id });
  if (error) throw new Error(error.message || 'Silme başarısız');
}

/**
 * Sort a properties array HOTEL-first, APARTMENT-second, alphabetical within
 * each type. Pure function — returns a new sorted array, doesn't mutate.
 */
export function sortHotelsFirst(properties: Property[]): Property[] {
  return [...properties].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'HOTEL' ? -1 : 1;
    // numeric: true → "B2" < "B10" (natural order) instead of "B10" < "B2".
    return a.name.localeCompare(b.name, 'tr', { numeric: true });
  });
}
