import { useEffect, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/utils';
import {
  PlusIcon,
  NoEntryIcon,
  NoteIcon,
  CurrencyLiraIcon,
  XMarkIcon,
} from '@/components/icons/ActionIcons';

export type CellAction = 'reservation' | 'block' | 'note' | 'price';

interface Props {
  /** Pretty label for the column heading — typically the unit name. */
  unitName: string;
  /** YYYY-MM-DD of the clicked cell. */
  dateStr: string;
  /** Disables actions whose dependent migrations haven't shipped yet. */
  disabled?: Partial<Record<CellAction, boolean>>;
  onPick: (action: CellAction) => void;
  onClose: () => void;
}

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

interface ActionDef {
  key: CellAction;
  Icon: IconComponent;
  label: string;
  hint: string;
}

const ACTIONS: ActionDef[] = [
  {
    key: 'reservation',
    Icon: PlusIcon,
    label: 'Yeni rezervasyon',
    hint: 'Bu birim için yeni bir konaklama oluştur.',
  },
  {
    key: 'block',
    Icon: NoEntryIcon,
    label: 'Tarihi blokla',
    hint: 'Bakım, ev sahibi konaklaması vb. için rezervasyon dışı bırak.',
  },
  {
    key: 'note',
    Icon: NoteIcon,
    label: 'Not ekle',
    hint: 'Bu tarihe özel temizlik / operasyon notu bırak.',
  },
  {
    key: 'price',
    Icon: CurrencyLiraIcon,
    label: 'Fiyat ayarla',
    hint: 'Bu tarihe özel gecelik fiyat ata.',
  },
];

/**
 * The empty-cell action sheet — replaces the old "click cell → straight to
 * /reservations/new" flow with a tiny modal that offers the four calendar
 * actions. Same modal shell pattern as ProblematicFlagModal et al.
 *
 * Disabled actions render greyed-out with "(Yakında)" so the operator can
 * see what's coming. The corresponding migrations land in tasks 6 (notes)
 * and 7 (pricing).
 */
export function CellActionSheet({
  unitName,
  dateStr,
  disabled,
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
              {formatDate(dateStr + 'T00:00:00Z')}
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
          {ACTIONS.map((a) => {
            const isDisabled = Boolean(disabled?.[a.key]);
            return (
              <li key={a.key}>
                <ActionButton
                  icon={<a.Icon className="h-5 w-5" />}
                  label={a.label}
                  hint={a.hint}
                  disabled={isDisabled}
                  onClick={() => onPick(a.key)}
                />
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}

function ActionButton({ icon, label, hint, disabled, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={
        'flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ' +
        (disabled
          ? 'cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-500'
          : 'border-stone-200 bg-white text-stone-800 hover:border-emerald-300 hover:bg-emerald-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-emerald-600 dark:hover:bg-emerald-950/40')
      }
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {label}
          {disabled && (
            <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-stone-600 dark:bg-stone-700 dark:text-stone-300">
              Yakında
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
          {hint}
        </span>
      </span>
    </button>
  );
}
