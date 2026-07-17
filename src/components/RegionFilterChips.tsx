/**
 * Region filter chips, shared by the misafir / mülk / onay lists.
 *
 * Renders nothing below two regions: with a single region (the fresh-install
 * shape, just 'Genel') a filter would only ever be a no-op chip.
 */

/** Sentinel for the optional leading "everything" chip. Not a region name. */
export const ALL_REGIONS = '';

interface RegionFilterChipsProps {
  /** Region names, in display order (useRegions() yields default-first). */
  regions: string[];
  /** Selected region name, or ALL_REGIONS. */
  value: string;
  onChange: (value: string) => void;
  /**
   * When set, prepends a chip carrying ALL_REGIONS with this label (e.g "Tümü").
   * Omit on screens that show exactly one region at a time (a switcher).
   */
  allLabel?: string;
  /** Optional per-region badge counts, keyed by region name. */
  counts?: Record<string, number>;
}

export function RegionFilterChips({
  regions,
  value,
  onChange,
  allLabel,
  counts,
}: RegionFilterChipsProps) {
  if (regions.length < 2) return null;

  const options = allLabel !== undefined ? [ALL_REGIONS, ...regions] : regions;

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((r) => {
        const selected = value === r;
        const count = counts?.[r] ?? 0;
        return (
          <button
            key={r === ALL_REGIONS ? '__all' : r}
            onClick={() => onChange(r)}
            className={
              selected
                ? 'rounded-full bg-emerald-600 px-4 py-1 text-sm font-medium text-white'
                : 'rounded-full border border-stone-300 px-4 py-1 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800'
            }
          >
            {r === ALL_REGIONS ? allLabel : r}
            {count > 0 && (
              <span
                className={
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-xs ' +
                  (selected
                    ? 'bg-white/25 text-white'
                    : 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200')
                }
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
