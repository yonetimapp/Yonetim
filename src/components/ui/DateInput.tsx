import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface DateInputProps {
  label?: string;
  name: string;
  /** ISO YYYY-MM-DD string. Empty string for no value. */
  value: string;
  /** Called with an ISO YYYY-MM-DD string or '' when cleared. Never called with invalid text. */
  onChange: (iso: string) => void;
  required?: boolean;
  /** ISO YYYY-MM-DD — forwarded to the native picker. */
  min?: string;
  /** ISO YYYY-MM-DD — forwarded to the native picker. */
  max?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoToDisplay(iso: string): string {
  const m = ISO_RE.exec(iso);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Live-mask the gg/aa/yyyy field as the user types. Strips non-digits,
 * caps at 8 digits, and auto-inserts the two slashes — so "25052026"
 * becomes "25/05/2026" without the user reaching for `/`.
 */
function maskDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return digits.slice(0, 2) + '/' + digits.slice(2);
  return digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4);
}

/**
 * Parse "dd/mm/yyyy" (also accepts . - and 2-digit year) into ISO YYYY-MM-DD.
 * Returns '' for empty input, null for invalid (so the caller can show an error).
 */
function parseDisplay(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2,4})$/);
  if (!m) return null;
  const [, d, mo, rawY] = m;
  const y = rawY.length === 2 ? `20${rawY}` : rawY;
  const day = d.padStart(2, '0');
  const month = mo.padStart(2, '0');
  // Round-trip through Date so we reject impossible dates like 31/02 or 30/02.
  const date = new Date(`${y}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${y}-${month}-${day}`;
}

/**
 * Turkish-formatted date input. Shows gg/aa/yyyy regardless of browser/OS
 * locale. Live-masks slashes as the user types. A calendar icon on the right
 * sits under a transparent native <input type="date"> overlay — tapping the
 * icon opens the OS-native picker on iOS Safari + Android Chrome reliably
 * (the earlier showPicker() trick silently no-ops on mobile Safari < 16.4
 * and on hidden/zero-size inputs, which is what was breaking the icon).
 */
export function DateInput({
  label,
  name,
  value,
  onChange,
  required,
  min,
  max,
  hint,
  disabled,
  className,
}: DateInputProps) {
  const [display, setDisplay] = useState(() => isoToDisplay(value));
  const [error, setError] = useState<string | null>(null);

  // Re-sync the visible text whenever the parent updates `value` externally.
  useEffect(() => {
    setDisplay(isoToDisplay(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const parsed = parseDisplay(display);
    if (parsed === null) {
      setError('Geçersiz tarih (gg/aa/yyyy)');
      return;
    }
    // Block propagating an empty value when the field is required — otherwise
    // downstream consumers that assume a non-empty date (e.g. ReservationForm
    // calls addDays(checkin, nights) which throws on '') crash the whole page.
    if (required && parsed === '') {
      setError('Tarih zorunludur');
      return;
    }
    setError(null);
    if (parsed !== value) onChange(parsed);
  };

  const handleTextChange = (raw: string) => {
    const masked = maskDisplay(raw);
    setDisplay(masked);
    setError(null);
    // Commit on completion so an already-valid date doesn't wait for blur
    // (e.g. tapping a button right after typing the last digit).
    if (masked.length === 10) {
      const parsed = parseDisplay(masked);
      if (parsed && parsed !== value) onChange(parsed);
    }
  };

  return (
    <div className={className}>
      {label && (
        <label
          htmlFor={name}
          className="block text-sm font-medium text-stone-700 dark:text-stone-300"
        >
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      <div className="relative mt-1">
        <input
          type="text"
          id={name}
          name={name}
          value={display}
          onChange={(e) => handleTextChange(e.target.value)}
          onBlur={commit}
          placeholder="gg/aa/yyyy"
          inputMode="numeric"
          required={required}
          disabled={disabled}
          autoComplete="off"
          maxLength={10}
          className={cn(
            'w-full rounded-md border px-3 py-2 pr-10 text-stone-900 placeholder-stone-400 transition-colors',
            'border-stone-300 bg-white focus:border-emerald-500 focus:outline-none',
            'dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500',
            error && 'border-red-500 focus:border-red-500 dark:border-red-500',
          )}
        />
        {/* Calendar-icon zone. The SVG underneath is purely visual; the
            transparent <input type="date"> overlay sits on top with
            pointer-events enabled, so any tap on the icon area opens the
            OS-native picker (iOS Safari, Android Chrome, desktop). This
            replaces the earlier showPicker() hack which silently no-ops on
            older mobile Safari and on h-0/w-0 hidden inputs. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-stone-500 dark:text-stone-400"
        >
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
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </span>
        <input
          type="date"
          aria-label="Takvimden seç"
          tabIndex={-1}
          value={value || ''}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => {
            const iso = e.target.value;
            if (iso) {
              setDisplay(isoToDisplay(iso));
              setError(null);
              if (iso !== value) onChange(iso);
            }
          }}
          className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 cursor-pointer opacity-0"
        />
      </div>
      {hint && !error && (
        <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">{hint}</p>
      )}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
