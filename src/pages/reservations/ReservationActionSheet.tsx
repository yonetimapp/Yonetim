import { useEffect, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { Card } from '@/components/ui/Card';
import {
  EyeIcon,
  PencilIcon,
  ArrowsLeftRightIcon,
  PlusIcon,
  MinusIcon,
  XMarkIcon,
  ClockIcon,
} from '@/components/icons/ActionIcons';
import type { ReservationStatus, StayType } from '@/types/database';

export type ReservationAction =
  | 'detail'
  | 'edit'
  | 'move'
  | 'extend'
  | 'shorten'
  | 'cancel';

interface Props {
  guestName: string;
  unitName: string;
  status: ReservationStatus;
  stayType: StayType;
  /** Nights for overnight stays — drives whether "Kısalt" is offered. */
  nights: number;
  canEdit: boolean;
  canCancel: boolean;
  onPick: (action: ReservationAction) => void;
  onClose: () => void;
}

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

interface ActionDef {
  key: ReservationAction;
  Icon: IconComponent;
  label: string;
  hint: string;
}

const STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: 'Beklemede',
  upcoming: 'Yakında',
  active: 'Aktif',
  completed: 'Tamamlandı',
  cancelled: 'İptal',
};

/**
 * Action sheet that pops when an existing reservation bar is tapped on the
 * calendar. The old behaviour (click bar → straight to detail page) is now
 * the first option ("Detayı aç"), the others are quick in-place edits that
 * skip a round-trip to the detail page for the common operations: move,
 * extend by one night, shorten by one night, cancel.
 *
 * Uzat/Kısalt are hidden for day-use stays (they're hourly, not nightly).
 * Kısalt is also hidden when there's only one night left — the DB CHECK
 * (stay_end > stay_start) would reject it anyway.
 */
export function ReservationActionSheet({
  guestName,
  unitName,
  status,
  stayType,
  nights,
  canEdit,
  canCancel,
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

  const isCancelled = status === 'cancelled';

  const actions: ActionDef[] = [
    {
      key: 'detail',
      Icon: EyeIcon,
      label: 'Detayı aç',
      hint: 'Cari hesap, ödemeler, KBS vb. tüm rezervasyon ayrıntıları.',
    },
  ];
  if (canEdit && !isCancelled) {
    actions.push({
      key: 'edit',
      Icon: PencilIcon,
      label: 'Düzenle',
      hint: 'Tutar, durum, ek bilgileri açılır formda değiştir.',
    });
    actions.push({
      key: 'move',
      Icon: ArrowsLeftRightIcon,
      label: 'Taşı',
      hint:
        stayType === 'DAYUSE'
          ? 'Saatleri koruyarak başka bir tarihe kaydır.'
          : 'Gece sayısını koruyarak başka bir tarihe kaydır.',
    });
    if (stayType === 'OVERNIGHT') {
      actions.push({
        key: 'extend',
        Icon: PlusIcon,
        label: 'Uzat (+1 gece)',
        hint: 'Çıkış tarihini bir gün ileri al.',
      });
      if (nights > 1) {
        actions.push({
          key: 'shorten',
          Icon: MinusIcon,
          label: 'Kısalt (−1 gece)',
          hint: 'Çıkış tarihini bir gün geri al.',
        });
      }
    }
  }
  if (canCancel && !isCancelled) {
    actions.push({
      key: 'cancel',
      Icon: XMarkIcon,
      label: 'İptal Et',
      hint: 'Rezervasyonu iptal statüsüne çek (silmez).',
    });
  }

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
              {guestName}
            </h2>
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-stone-600 dark:text-stone-300">
              <span>
                {unitName} · {STATUS_LABELS[status]}
              </span>
              {stayType === 'DAYUSE' && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                  <ClockIcon className="h-3 w-3" />
                  Güniçi
                </span>
              )}
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
          {actions.map((a) => (
            <li key={a.key}>
              <ActionButton
                icon={<a.Icon className="h-5 w-5" />}
                label={a.label}
                hint={a.hint}
                destructive={a.key === 'cancel'}
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
  destructive?: boolean;
  onClick: () => void;
}

function ActionButton({ icon, label, hint, destructive, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ' +
        (destructive
          ? 'border-stone-200 bg-white text-red-700 hover:border-red-300 hover:bg-red-50 dark:border-stone-700 dark:bg-stone-900 dark:text-red-400 dark:hover:border-red-700 dark:hover:bg-red-950/40'
          : 'border-stone-200 bg-white text-stone-800 hover:border-emerald-300 hover:bg-emerald-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-emerald-600 dark:hover:bg-emerald-950/40')
      }
    >
      <span
        aria-hidden="true"
        className={
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full ' +
          (destructive
            ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
            : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200')
        }
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
