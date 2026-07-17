import type { Unit } from '@/lib/queries/units';

/**
 * Resolve the value for the `{katalog_link}` WhatsApp template variable.
 *
 * Birim photos — and the public /g/u/<id> gallery they powered — were removed,
 * so the only source is the manually pasted catalog URL (a WhatsApp Business
 * catalog, Drive folder, etc.). Returns '' when unset, leaving the placeholder
 * unresolved so callers can fall back gracefully.
 */
export function resolveKatalogLink(
  unit: Pick<Unit, 'catalog_url'> | null | undefined,
): string {
  return unit?.catalog_url?.trim() || '';
}
