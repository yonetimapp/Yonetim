import { supabase } from '@/lib/supabase';
import { softDeleteEntity } from '@/lib/queries/trash';
import type { Database } from '@/types/database';

type TemplateRow = Database['public']['Tables']['message_templates']['Row'];
type TemplateInsert = Database['public']['Tables']['message_templates']['Insert'];
type TemplateUpdate = Database['public']['Tables']['message_templates']['Update'];

export type MessageTemplate = TemplateRow;

/**
 * Variables supported by the template substitution helper. Template authors
 * insert these as `{misafir_adi}`, `{giris_tarihi}`, etc. Unknown tokens are
 * left as-is so a typo doesn't silently disappear.
 *
 * Canonical names are Turkish. English aliases (see VARIABLE_ALIASES below) also
 * resolve to the same values so templates can use either form.
 */
export const TEMPLATE_VARIABLES = [
  'misafir_adi',
  'giris_tarihi',
  'cikis_tarihi',
  'gece_sayisi',
  'toplam_tutar',
  'bakiye',
  'mulk_adi',
  'birim_adi',
  'katalog_link',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * English placeholder aliases → canonical Turkish variable name.
 * Lets templates use `{checkin}` interchangeably with `{giris_tarihi}`.
 */
const VARIABLE_ALIASES: Record<string, TemplateVariable> = {
  guest: 'misafir_adi',
  guest_name: 'misafir_adi',
  checkin: 'giris_tarihi',
  check_in: 'giris_tarihi',
  checkout: 'cikis_tarihi',
  check_out: 'cikis_tarihi',
  nights: 'gece_sayisi',
  total: 'toplam_tutar',
  total_amount: 'toplam_tutar',
  balance: 'bakiye',
  property: 'mulk_adi',
  property_name: 'mulk_adi',
  unit: 'birim_adi',
  unit_name: 'birim_adi',
  catalog: 'katalog_link',
  catalog_link: 'katalog_link',
  gallery: 'katalog_link',
};

const wrapErr = (e: { message: string; details?: string; hint?: string; code?: string }) =>
  new Error(
    `${e.message}${e.details ? ` — ${e.details}` : ''}${e.hint ? ` [${e.hint}]` : ''}${e.code ? ` (${e.code})` : ''}`,
  );

/** All message templates (everyone can read; RLS templates_select = USING(true)). */
export async function listTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from('message_templates')
    .select('*')
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw wrapErr(error);
  return data ?? [];
}

export async function createTemplate(input: TemplateInsert): Promise<TemplateRow> {
  const { data, error } = await supabase
    .from('message_templates')
    .insert(input)
    .select()
    .single();
  if (error) throw wrapErr(error);
  return data;
}

export async function updateTemplate(
  id: string,
  input: TemplateUpdate,
): Promise<TemplateRow> {
  const { data, error } = await supabase
    .from('message_templates')
    .update(input)
    .eq('id', id)
    .select()
    .single();
  if (error) throw wrapErr(error);
  return data;
}

/** Soft-delete a template → lands in Çöp Kutusu (admin-restorable). */
export async function deleteTemplate(id: string): Promise<void> {
  await softDeleteEntity('message_templates', id);
}

/**
 * Substitute `{var_name}` placeholders in template content using the
 * supplied map. Unknown placeholders are left as-is. English aliases
 * (see VARIABLE_ALIASES) resolve to their canonical Turkish value.
 */
export function substituteVariables(
  content: string,
  vars: Partial<Record<TemplateVariable, string>>,
): string {
  const map = vars as Record<string, string | undefined>;
  return content.replace(/\{(\w+)\}/g, (match, key) => {
    const canonical = VARIABLE_ALIASES[key] ?? key;
    const v = map[canonical];
    return v ?? match;
  });
}
