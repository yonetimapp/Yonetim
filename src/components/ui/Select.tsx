import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  name?: string;
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  required?: boolean;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** When true, the open dropdown shows a type-to-filter search box. */
  searchable?: boolean;
  /** Option value to softly highlight (e.g. the current month) with a slight green tint. */
  highlightValue?: string;
}

// Case- and diacritic-insensitive folding for Turkish search so a fast typist
// still matches: "Çetin", "cetin" and "çetın" all collapse to the same key.
const TR_FOLD: Record<string, string> = {
  ç: 'c', ş: 's', ğ: 'g', ı: 'i', ö: 'o', ü: 'u', â: 'a', î: 'i', û: 'u',
};
function searchNorm(s: string): string {
  return s
    .replace(/[İI]/g, 'i') // unify dotted/dotless capital I before folding
    .toLowerCase()
    .replace(/[çşğıöüâîû]/g, (c) => TR_FOLD[c] ?? c);
}

/**
 * Custom Select dropdown.
 * Replaces the native <select> so we control the appearance in all browsers.
 * Fully keyboard-accessible: arrow keys, Home/End, Enter/Space, Escape, Tab.
 * Pass `searchable` to add a type-to-filter box — useful for long lists.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      label,
      name,
      id,
      value,
      onChange,
      options,
      required,
      error,
      placeholder = 'Seçiniz…',
      disabled,
      className,
      searchable,
      highlightValue,
    },
    ref,
  ) => {
    const selectId = id ?? name;
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [highlighted, setHighlighted] = useState(0);

    const containerRef = useRef<HTMLDivElement>(null);
    const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
    const searchRef = useRef<HTMLInputElement>(null);

    // The options actually rendered — narrowed by the search query when searchable.
    const visibleOptions = useMemo(() => {
      if (!searchable || !query.trim()) return options;
      const q = searchNorm(query);
      return options.filter((o) => searchNorm(o.label).includes(q));
    }, [searchable, query, options]);

    // Click outside → close
    useEffect(() => {
      if (!open) return;
      const handle = (e: MouseEvent) => {
        if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener('mousedown', handle);
      return () => document.removeEventListener('mousedown', handle);
    }, [open]);

    // On open: clear the search box, sync the highlight to the current
    // selection, and focus the search field when searchable.
    useEffect(() => {
      if (!open) return;
      setQuery('');
      const idx = options.findIndex((o) => o.value === value);
      setHighlighted(idx >= 0 ? idx : 0);
      if (searchable) searchRef.current?.focus();
    }, [open, value, options, searchable]);

    // Typing in the search box re-highlights the first match.
    useEffect(() => {
      if (open && searchable) setHighlighted(0);
    }, [query, open, searchable]);

    // Keep the highlighted option visible if the list scrolls
    useEffect(() => {
      if (open) optionRefs.current[highlighted]?.scrollIntoView({ block: 'nearest' });
    }, [open, highlighted]);

    const selectOption = useCallback(
      (index: number) => {
        const opt = visibleOptions[index];
        if (opt) {
          onChange(opt.value);
          setOpen(false);
        }
      },
      [visibleOptions, onChange],
    );

    // Arrow / Enter / Escape handling shared by the trigger button and,
    // when searchable, the search input.
    const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!open) setOpen(true);
          else setHighlighted((i) => Math.min(i + 1, visibleOptions.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!open) setOpen(true);
          else setHighlighted((i) => Math.max(i - 1, 0));
          break;
        case 'Home':
          if (open) {
            e.preventDefault();
            setHighlighted(0);
          }
          break;
        case 'End':
          if (open) {
            e.preventDefault();
            setHighlighted(visibleOptions.length - 1);
          }
          break;
        case 'Enter':
          e.preventDefault();
          if (open) selectOption(highlighted);
          else setOpen(true);
          break;
        case ' ':
          // In the search box a space is just text — only treat Space as
          // select/open when we are not typing a query.
          if (!(searchable && open)) {
            e.preventDefault();
            if (open) selectOption(highlighted);
            else setOpen(true);
          }
          break;
        case 'Escape':
          if (open) {
            e.preventDefault();
            setOpen(false);
          }
          break;
        case 'Tab':
          if (open) setOpen(false);
          break;
      }
    };

    const selected = options.find((o) => o.value === value);

    return (
      <div ref={containerRef} className="relative">
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-stone-700 dark:text-stone-300"
          >
            {label}
            {required && <span className="ml-0.5 text-red-500">*</span>}
          </label>
        )}
        <button
          ref={ref}
          type="button"
          id={selectId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-required={required}
          aria-invalid={!!error}
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={handleKeyDown}
          className={cn(
            'mt-1 flex w-full items-center justify-between rounded-md border bg-white px-3 py-2 text-left text-sm transition-colors',
            'border-stone-300 dark:border-stone-600 dark:bg-stone-800',
            'focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30',
            error && 'border-red-500 dark:border-red-500',
            disabled && 'cursor-not-allowed opacity-60',
            className,
          )}
        >
          <span
            className={
              selected
                ? 'text-stone-900 dark:text-stone-100'
                : 'text-stone-400 dark:text-stone-400'
            }
          >
            {selected?.label ?? placeholder}
          </span>
          <svg
            className={cn(
              'h-4 w-4 text-stone-500 transition-transform dark:text-stone-300',
              open && 'rotate-180',
            )}
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M5 8l5 5 5-5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {open && (
          <div
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-white shadow-lg
                       border-stone-200 dark:border-stone-600 dark:bg-stone-900"
          >
            {searchable && (
              <div className="border-b border-stone-200 p-2 dark:border-stone-700">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ara…"
                  aria-label="Ara"
                  className="w-full rounded border bg-white px-2 py-1.5 text-sm text-stone-900 placeholder-stone-400
                             border-stone-300 focus:border-emerald-500 focus:outline-none
                             dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500"
                />
              </div>
            )}
            <ul role="listbox" tabIndex={-1} className="max-h-60 overflow-auto py-1">
              {searchable && visibleOptions.length === 0 && (
                <li className="px-3 py-2 text-sm text-stone-500 dark:text-stone-400">
                  Sonuç bulunamadı
                </li>
              )}
              {visibleOptions.map((opt, i) => {
                const isSelected = opt.value === value;
                const isHighlighted = i === highlighted;
                const isCurrent =
                  highlightValue !== undefined && opt.value === highlightValue;
                return (
                  <li
                    key={opt.value}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => selectOption(i)}
                    className={cn(
                      'cursor-pointer px-3 py-2 text-sm transition-colors',
                      isHighlighted
                        ? 'bg-emerald-600 text-white'
                        : isSelected
                          ? 'bg-emerald-50 font-medium text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200'
                          : isCurrent
                            ? 'bg-emerald-50/50 text-stone-900 dark:bg-emerald-900/20 dark:text-stone-100'
                            : 'text-stone-900 dark:text-stone-100',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{opt.label}</span>
                      {isSelected && (
                        <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <path
                            d="M4 10l4 4 8-8"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  },
);

Select.displayName = 'Select';
