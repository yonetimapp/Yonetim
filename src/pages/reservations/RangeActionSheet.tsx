import { useEffect, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/utils';
import {
  NoEntryIcon,
  CurrencyLiraIcon,
  XMarkIcon,
} from '@/components/icons/ActionIcons';

export type RangeAction = 'block' | 'price';

interface Props {
  unitName: string;
  /** Normalized inclusive range (start <= end), YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  /** Inclusive night count for the range header. */
  nights: number;
  onPick: (action: RangeAction) => void;
  onClose: () => void;
}

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

interface ActionDef {
  key: RangeAction;
  Icon: IconComponent;
  label: string;
  hint: string;
}

const ACTIONS: ActionDef[] = [
  {
    key: 'block',
    Icon: NoEntryIcon,
    label: 'Aralığı blokla',
    hint: 'Bakım, ev sahibi konaklaması vb. için seçilen tüm günleri kapat.',
  },
  {
    key: 'price',
    Icon: CurrencyLiraIcon,
    label: 'Aralığa fiyat ayarla',
    hint: 'Hafta sonu, sezon vb. için aralıktaki her geceyi tek fiyata getir.',
  },
];

/**
 * Bulk action sheet that opens after the user finishes a range-select
 * (shift-click on desktop, two-tap with the "Aralık" button on mobile).
 *
 * Notes are intentionally NOT offered here — they're single-day operational
 * markers by design (one (unit, date) → one note), and a bulk apply would
 * just stamp the same string across N rows with no useful semantics.
 */
export function RangeActionSheet({
  unitName,
  startDate,
  endDate,
  nights,
  onPick,
  onClose,
}: Props) {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-16"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-sm">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-stone-900 dark:text-stone-100">
              {unitName}
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              {formatDate(startDate + 'T00:00:00Z')} → {formatDate(endDate + 'T00:00:00Z')}
              <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
                {nights} gece
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700"
            aria-label="Kapat"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <ul className="space-y-1.5">
          {ACTIONS.map((a) => (
            <li key={a.key}>
              <ActionButton
                icon={<a.Icon className="h-5 w-5" />}
                label={a.label}
                hint={a.hint}
                onClick={() => onPick(a.key)}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}

function ActionButton({ icon, label, hint, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-md border border-stone-200 bg-white px-3 py-2.5 text-left text-stone-800 transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-emerald-600 dark:hover:bg-emerald-950/40"
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
          {hint}
        </span>
      </span>
    </button>
  );
}
