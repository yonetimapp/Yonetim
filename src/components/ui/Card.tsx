import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-white p-6',
        'border-stone-300 dark:border-stone-700 dark:bg-stone-900',
        className,
      )}
    >
      {children}
    </div>
  );
}
