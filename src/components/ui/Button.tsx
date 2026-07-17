import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-sky-700 text-white hover:bg-sky-800 disabled:bg-sky-700/50',
  secondary:
    'border border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800',
  danger:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  ghost:
    'text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-sm',
  md: 'px-4 py-2 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, disabled, className, children, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900',
        'disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
      )}
      {children}
    </button>
  ),
);

Button.displayName = 'Button';
