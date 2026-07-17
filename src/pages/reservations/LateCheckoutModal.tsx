import { useEffect, useState } from 'react';
import { updateReservation } from '@/lib/queries/reservations';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { checkoutTimeLabel, cn, DEFAULT_CHECKOUT_HOUR } from '@/lib/utils';

interface Props {
  reservationId: string;
  /** Current offset on the reservation. 0 = standart 11:00. */
  current: number;
  onClose: () => void;
  /** Called with the new offset after a successful save. */
  onUpdated: (next: number) => void;
}

/** Up to +4 hours past the base — same range the DB CHECK allows. */
const OPTIONS: number[] = [0, 1, 2, 3, 4];

/**
 * Mini modal: pick how many hours past the standard checkout (11:00) the
 * guest gets. Writes reservations.late_checkout_hours via a normal update —
 * RLS already lets the same roles that can edit a reservation update it.
 */
export function LateCheckoutModal({ reservationId, current, onClose, onUpdated }: Props) {
  const [selected, setSelected] = useState<number>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateReservation(reservationId, { late_checkout_hours: selected });
      onUpdated(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

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
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Geç Çıkış
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
              Standart çıkış saati {String(DEFAULT_CHECKOUT_HOUR).padStart(2, '0')}:00.
              Misafir biraz daha kalmak isterse buradan uzatın.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700"
            aria-label="Kapat"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {OPTIONS.map((n) => {
            const isActive = selected === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setSelected(n)}
                className={cn(
                  'rounded-md border px-2 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : 'border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
                )}
              >
                <div>{checkoutTimeLabel(n)}</div>
                <div className="text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                  {n === 0 ? 'Standart' : `+${n} saat`}
                </div>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            İptal
          </Button>
          <Button type="button" onClick={handleSave} loading={saving} disabled={selected === current}>
            Kaydet
          </Button>
        </div>
      </Card>
    </div>
  );
}
