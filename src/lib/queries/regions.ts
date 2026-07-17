import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

export type Region = Database['public']['Tables']['regions']['Row'];

/** A region plus its kasa's id/balance, for the Bölgeler tab. */
export type RegionWithKasa = Region & {
  kasa_id: string | null;
  kasa_name: string | null;
  balance: number;
};

/**
 * Every region, default first then alphabetical. Readable by any signed-in user
 * (the Mülk form and staff screen need it for their pickers).
 */
export async function listRegions(): Promise<Region[]> {
  const { data, error } = await supabase
    .from('regions')
    .select('*')
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Regions joined to their kasa + balance. Only a finance role can read
 * cash_accounts/cash_transactions (RLS), so a non-finance caller gets the region
 * list with a null kasa rather than an error.
 */
export async function listRegionsWithKasa(): Promise<RegionWithKasa[]> {
  const regions = await listRegions();

  const { data: accounts } = await supabase
    .from('cash_accounts')
    .select('id, name, region');
  const { data: balances } = await supabase.rpc('cash_account_balances');

  const balanceById = new Map<string, number>(
    (balances ?? []).map((b) => [b.cash_account_id, Number(b.balance)]),
  );

  return regions.map((r) => {
    const kasa = (accounts ?? []).find((a) => a.region === r.name);
    return {
      ...r,
      kasa_id: kasa?.id ?? null,
      kasa_name: kasa?.name ?? null,
      balance: kasa ? (balanceById.get(kasa.id) ?? 0) : 0,
    };
  });
}

/** SUPER_ADMIN only. Creates the region and its kasa in one transaction. */
export async function createRegion(name: string): Promise<Region> {
  const { data, error } = await supabase.rpc('create_region', { p_name: name });
  if (error) throw new Error(error.message);
  return data as Region;
}

/** SUPER_ADMIN only. The rename cascades to every referencing row. */
export async function renameRegion(id: string, name: string): Promise<Region> {
  const { data, error } = await supabase.rpc('rename_region', { p_id: id, p_name: name });
  if (error) throw new Error(error.message);
  return data as Region;
}

/**
 * SUPER_ADMIN only. Refuses the default region, a region whose kasa has
 * movements, or one with active staff. Mülks do NOT block: their tie is broken
 * and they are parked on the default region — the returned names are those
 * mülks, so the UI can tell the Yönetici which ones need a new bölge picked.
 */
export async function deleteRegion(id: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('delete_region', { p_id: id });
  if (error) throw new Error(error.message);
  return (data as string[] | null) ?? [];
}

/** Mülk count per region name — feeds the delete dialog's "N mülk taşınacak" warning. */
export async function countPropertiesByRegion(): Promise<Record<string, number>> {
  const { data, error } = await supabase.from('properties').select('region');
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { region: string }[]) {
    counts[row.region] = (counts[row.region] ?? 0) + 1;
  }
  return counts;
}
