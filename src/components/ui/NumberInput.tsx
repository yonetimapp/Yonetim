import {
  forwardRef,
  useEffect,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  label?: string;
  error?: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  (
    { label, error, hint, value, onChange, min, max, step = 1, required, name, id, ...rest },
    ref,
  ) => {
    const inputId = id ?? name;
    const stepNum = Number(step) || 1;

    // Internal display string — lets the field be temporarily empty (or hold
    // partial input like "-") without snapping back to "0".
    const [display, setDisplay] = useState<string>(() => String(value));

    // Sync display when parent updates value externally (e.g., form reset, +/− buttons).
    useEffect(() => {
      if (Number(display) !== value) {
        setDisplay(String(value));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const clamp = (n: number) => {
      if (min !== undefined && n < Number(min)) return Number(min);
      if (max !== undefined && n > Number(max)) return Number(max);
      return n;
    };

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setDisplay(raw);

      // Allow temporarily-empty input so the user can clear and retype.
      if (raw === '' || raw === '-') return;

      const num = Number(raw);
      if (!Number.isNaN(num) && Number.isFinite(num)) {
        onChange(clamp(num));
      }
    };

    const handleBlur = () => {
      // On blur, normalize the display. Empty / invalid → fall back to min (or 0).
      if (display === '' || display === '-' || Number.isNaN(Number(display))) {
        const fallback = min !== undefined ? Number(min) : 0;
        onChange(fallback);
        setDisplay(String(fallback));
        return;
      }
      const normalized = clamp(Number(display));
      onChange(normalized);
      setDisplay(String(normalized));
    };

    const handleIncrement = () => {
      const next = clamp(Number(value) + stepNum);
      onChange(next);
      setDisplay(String(next));
    };

    const handleDecrement = () => {
      const next = clamp(Number(value) - stepNum);
      onChange(next);
      setDisplay(String(next));
    };

    const atMin = min !== undefined && Number(value) <= Number(min);
    const atMax = max !== undefined && Number(value) >= Number(max);

    return (
      <div>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-stone-700 dark:text-stone-300"
          >
            {label}
            {required && <span className="ml-0.5 text-red-500">*</span>}
          </label>
        )}
        <div
          className={cn(
            'mt-1 flex items-stretch rounded-md border bg-white transition-colors',
            'border-stone-300 dark:border-stone-600 dark:bg-stone-800',
            'focus-within:border-emerald-500 focus-within:ring-1 focus-within:ring-emerald-500/30',
            error && 'border-red-500 dark:border-red-500',
          )}
        >
          <input
            ref={ref}
            id={inputId}
            name={name}
            type="number"
            value={display}
            min={min}
            max={max}
            step={step}
            required={required}
            onChange={handleInputChange}
            onBlur={handleBlur}
            className="flex-1 bg-transparent px-3 py-2 text-stone-900 focus:outline-none dark:text-stone-100"
            {...rest}
          />
          <div
            className="flex flex-col divide-y border-l text-stone-600 dark:text-stone-300
                       border-stone-300 divide-stone-300
                       dark:border-stone-600 dark:divide-stone-600"
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label="Artır"
              disabled={atMax}
              onClick={handleIncrement}
              className="flex w-9 flex-1 items-center justify-center transition-colors
                         hover:bg-stone-100 active:bg-stone-200
                         dark:hover:bg-stone-700 dark:active:bg-stone-600
                         disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M2 6.5L5 3.5L8 6.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Azalt"
              disabled={atMin}
              onClick={handleDecrement}
              className="flex w-9 flex-1 items-center justify-center transition-colors
                         hover:bg-stone-100 active:bg-stone-200
                         dark:hover:bg-stone-700 dark:active:bg-stone-600
                         disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M2 3.5L5 6.5L8 3.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        {hint && !error && <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">{hint}</p>}
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  },
);

NumberInput.displayName = 'NumberInput';
