import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

/**
 * Single-button theme toggle. Click cycles between explicit light and dark
 * (overriding system preference). Reset to 'system' is available via a
 * future settings page if needed.
 */
export function ThemeToggle() {
  const { resolved, setTheme } = useTheme();
  const isDark = resolved === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Açık temaya geç' : 'Koyu temaya geç'}
      title={isDark ? 'Açık tema' : 'Koyu tema'}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
        'border-stone-300 text-stone-700 hover:bg-stone-100',
        'dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
      )}
    >
      {isDark ? (
        // Sun icon — clicking goes to light
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        // Moon icon — clicking goes to dark
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
