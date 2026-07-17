import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { createBlock, type PropertyBlock } from '@/lib/queries/property_blocks';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';

interface Props {
  propertyId: string;
  unitId: string;
  unitName: string;
  /** Pre-fill the start date (typically the cell that was clicked). */
  initialStart: string;
  /** Pre-fill the end date — used by the range-select flow (Task 9). When
      omitted we default to initialStart + 1 so a single click gives a 1-day
      block, preserving the original single-cell behaviour. */
  initialEnd?: string;
  onClose: () => void;
  onCreated: (block: PropertyBlock) => void;
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Block a unit's calendar for maintenance / owner stay / deep-clean — anything
 * that isn't a paying reservation. The DB triggers (migration 045) refuse to
 * create a block that overlaps a non-cancelled reservation; that error surfaces
 * inline so the operator can adjust dates.
 */
export function BlockDatesModal({
  propertyId,
  unitId,
  unitName,
  initialStart,
  initialEnd,
  onClose,
  onCreated,
}: Props) {
  const { user } = useAuth();
  const [start, setStart] = useState(initialStart);
  // Default to next-day end so a single click gives a 1-day block; when a
  // range was pre-selected, honour it instead.
  const [end, setEnd] = useState(() => initialEnd ?? addDaysStr(initialStart, 1));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!user) {
      setError('Oturum bulunamadı.');
      return;
    }
    if (end <= start) {
      setError('Bitiş tarihi başlangıçtan sonra olmalıdır.');
      return;
    }
    setSaving(true);
    try {
      // Same midnight-UTC convention as overnight reservations so the row
      // shows the right span on the calendar without timezone jiggle.
      const block_start = new Date(start + 'T00:00:00Z').toISOString();
      const block_end = new Date(end + 'T00:00:00Z').toISOString();
      const created = await createBlock({
        property_id: propertyId,
        unit_id: unitId,
        block_start,
        block_end,
        reason: reason.trim() || null,
        created_by: user.id,
      });
      onCreated(created);
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
      <Card className="w-full max-w-md">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Tarihi Blokla
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700"
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

        <p className="mb-3 text-sm text-stone-600 dark:text-stone-300">
          <strong>{unitName}</strong> birimini rezervasyon dışı bırak — bakım,
          ev sahibi konaklaması, derin temizlik vb.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <DateInput
              label="Başlangıç"
              name="block_start"
              required
              value={start}
              onChange={setStart}
            />
            <DateInput
              label="Bitiş"
              name="block_end"
              required
              value={end}
              onChange={setEnd}
            />
          </div>

          <div>
            <label
              htmlFor="block_reason"
              className="block text-sm font-medium text-stone-700 dark:text-stone-300"
            >
              Sebep (opsiyonel)
            </label>
            <textarea
              id="block_reason"
              name="block_reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              rows={3}
              placeholder="Örn: Klima tamiri, ev sahibi kalıyor, derin temizlik"
              className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder-stone-500"
            />
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
              Blokla
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
