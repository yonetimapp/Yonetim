import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, id, ...rest }, ref) => {
    const inputId = id ?? rest.name;
    return (
      <div>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-stone-700 dark:text-stone-300"
          >
            {label}
            {rest.required && <span className="ml-0.5 text-red-500">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'mt-1 w-full rounded-md border px-3 py-2 text-stone-900 placeholder-stone-400 transition-colors',
            'border-stone-300 bg-white focus:border-emerald-500 focus:outline-none',
            'dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:placeholder-stone-500',
            error && 'border-red-500 focus:border-red-500 dark:border-red-500',
            className,
          )}
          {...rest}
        />
        {hint && !error && (
          <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">{hint}</p>
        )}
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';
