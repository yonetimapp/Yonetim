import { useEffect, useState, type FormEvent } from 'react';
import { setGuestProblematic } from '@/lib/queries/guests';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { WarningTriangleIcon } from '@/components/icons/WarningTriangleIcon';

interface Props {
  guestId: string;
  guestName: string;
  /** Current persisted flag state — drives the initial checkbox value. */
  initialIsProblematic: boolean;
  /** Current persisted note — drives the initial textarea value. */
  initialNote: string | null;
  onClose: () => void;
  /** Fires after a successful save with the new state so the parent can refresh. */
  onSaved: (next: { isProblematic: boolean; note: string | null }) => void;
}

/**
 * Quick-edit the persistent "Sorunlu Misafir" flag and note on a guest.
 * Opened from the warning-triangle icon next to the guest name on
 * ReservationDetailPage / GuestDetailPage. Backed by set_guest_problematic
 * (migration 043).
 */
export function ProblematicFlagModal({
  guestId,
  guestName,
  initialIsProblematic,
  initialNote,
  onClose,
  onSaved,
}: Props) {
  const [isProblematic, setIsProblematic] = useState(initialIsProblematic);
  const [note, setNote] = useState(initialNote ?? '');
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
    setSaving(true);
    try {
      const trimmedNote = note.trim() || null;
      // If the flag is being cleared, drop the note too — keeps the data tidy.
      const nextNote = isProblematic ? trimmedNote : null;
      await setGuestProblematic(guestId, isProblematic, nextNote);
      onSaved({ isProblematic, note: nextNote });
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
          <h2 className="flex items-center gap-2 text-lg font-semibold text-stone-900 dark:text-stone-100">
            <WarningTriangleIcon className="h-5 w-5 text-red-500" />
            Sorunlu Misafir
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
          {guestName} için temizlik / resepsiyon ekibine kalıcı bir uyarı bırakın.
          İşaret kaldırıldığında not da temizlenir.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <label className="flex items-start gap-2 text-sm text-stone-800 dark:text-stone-200">
            <input
              type="checkbox"
              checked={isProblematic}
              onChange={(e) => setIsProblematic(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-stone-300 text-red-600 focus:ring-red-500 dark:border-stone-600 dark:bg-stone-800"
            />
            <span>Bu misafiri <strong>sorunlu</strong> olarak işaretle</span>
          </label>

          <div>
            <label
              htmlFor="problematic_note"
              className="block text-sm font-medium text-stone-700 dark:text-stone-300"
            >
              Not (opsiyonel)
            </label>
            <textarea
              id="problematic_note"
              name="problematic_note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={!isProblematic}
              maxLength={500}
              rows={4}
              placeholder="Örn: Önceki konaklamada lamba kırdı, depozito alın."
              className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 shadow-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder-stone-500 dark:disabled:bg-stone-800"
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              En fazla 500 karakter.
            </p>
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
              Kaydet
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
