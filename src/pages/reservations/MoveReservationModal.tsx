import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { updateReservation } from '@/lib/queries/reservations';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import type { StayType } from '@/types/database';

interface Props {
  reservationId: string;
  /** Current stay start as ISO timestamp — used as the move pivot. */
  currentStayStart: string;
  /** Current stay end as ISO timestamp. */
  currentStayEnd: string;
  stayType: StayType;
  guestName: string;
  unitName: string;
  onClose: () => void;
  /** Fires after the move succeeds — parent should refresh. */
  onMoved: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Move a reservation to a different start date while preserving:
 *   - Duration (nights for overnight, hours for day-use)
 *   - Time-of-day (the day-use 14:00–17:00 stays 14:00–17:00 on the new date)
 *
 * Backed by the existing updateReservation — the EXCLUDE constraint on
 * (unit_id, stay) and the block-overlap triggers from migration 045 reject
 * conflicts at the DB level, and the existing wrapErr surfaces a friendly
 * Turkish message.
 */
export function MoveReservationModal({
  reservationId,
  currentStayStart,
  currentStayEnd,
  stayType,
  guestName,
  unitName,
  onClose,
  onMoved,
}: Props) {
  // The current "date portion" depends on the convention:
  //   - Overnight stays are midnight-UTC → first 10 chars are the local date.
  //   - Day-use stays carry Istanbul-local time encoded in UTC; for the
  //     date-picker we just take the UTC date that the stay starts on,
  //     which lines up with the calendar grid.
  const initialDate = useMemo(
    () => currentStayStart.slice(0, 10),
    [currentStayStart],
  );
  const [newDate, setNewDate] = useState(initialDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  // Compute the shifted stay_start/stay_end. We shift both by the same
  // millisecond delta so the duration AND time-of-day are preserved exactly.
  const { previewStart, previewEnd, deltaDays } = useMemo(() => {
    const oldStart = new Date(initialDate + 'T00:00:00Z').getTime();
    const newStart = new Date(newDate + 'T00:00:00Z').getTime();
    const delta = newStart - oldStart;
    const sStart = new Date(new Date(currentStayStart).getTime() + delta).toISOString();
    const sEnd = new Date(new Date(currentStayEnd).getTime() + delta).toISOString();
    return {
      previewStart: sStart,
      previewEnd: sEnd,
      deltaDays: Math.round(delta / DAY_MS),
    };
  }, [newDate, initialDate, currentStayStart, currentStayEnd]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newDate === initialDate) {
      setError('Yeni tarih mevcut tarihle aynı — değişiklik yok.');
      return;
    }
    setSaving(true);
    try {
      await updateReservation(reservationId, {
        stay_start: previewStart,
        stay_end: previewEnd,
      });
      onMoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Taşıma başarısız');
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
      <Card className="w-full max-w-md">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Rezervasyonu Taşı
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              {guestName} · {unitName}
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

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {stayType === 'DAYUSE'
              ? 'Güniçi konaklamada saatler korunur, sadece tarih değişir.'
              : 'Konaklamanın süresi (gece sayısı) korunur, tarih kaydırılır.'}
          </p>

          <DateInput
            label="Yeni Tarih"
            name="new_start"
            required
            value={newDate}
            onChange={setNewDate}
          />

          <div className="rounded-md bg-stone-50 px-3 py-2 text-xs dark:bg-stone-800/40">
            <div className="text-stone-600 dark:text-stone-300">
              Önceki: <strong>{initialDate}</strong> → {currentStayEnd.slice(0, 10)}
            </div>
            <div className="text-stone-900 dark:text-stone-100">
              Yeni: <strong>{previewStart.slice(0, 10)}</strong> → {previewEnd.slice(0, 10)}
              {deltaDays !== 0 && (
                <span className="ml-1 text-stone-500 dark:text-stone-400">
                  ({deltaDays > 0 ? `+${deltaDays}` : deltaDays} gün)
                </span>
              )}
            </div>
          </div>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              İptal
            </Button>
            <Button type="submit" loading={saving}>
              Taşı
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
