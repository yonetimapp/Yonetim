import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  upsertNote,
  deleteNote,
  type PropertyDateNote,
} from '@/lib/queries/property_date_notes';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/utils';

interface Props {
  propertyId: string;
  unitId: string;
  unitName: string;
  /** YYYY-MM-DD of the target cell. */
  dateStr: string;
  /** Existing note for this (unit, date), or null if none yet. */
  existing: PropertyDateNote | null;
  onClose: () => void;
  /** Called after upsert. Passing null means the note was deleted. */
  onSaved: (note: PropertyDateNote | null) => void;
}

/**
 * Add / edit / delete the per-date operations note for one (unit, date)
 * pair. Backed by property_date_notes (migration 046). The unique index on
 * (unit_id, note_date) means an upsert here behaves naturally — re-opening
 * for the same cell shows what's saved, saving overwrites in place.
 */
export function DateNoteModal({
  propertyId,
  unitId,
  unitName,
  dateStr,
  existing,
  onClose,
  onSaved,
}: Props) {
  const { user } = useAuth();
  const [note, setNote] = useState(existing?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    const trimmed = note.trim();
    if (!trimmed) {
      setError('Not boş olamaz. Silmek için aşağıdaki Sil düğmesini kullanın.');
      return;
    }
    if (!user) {
      setError('Oturum bulunamadı.');
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertNote({
        property_id: propertyId,
        unit_id: unitId,
        note_date: dateStr,
        note: trimmed,
        created_by: user.id,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteNote(existing.id);
      onSaved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Silinemedi');
      setDeleting(false);
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
              Tarih Notu
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              {unitName} · {formatDate(dateStr + 'T00:00:00Z')}
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
          <div>
            <label
              htmlFor="date_note"
              className="block text-sm font-medium text-stone-700 dark:text-stone-300"
            >
              Not
            </label>
            <textarea
              id="date_note"
              name="date_note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={4}
              autoFocus
              placeholder="Örn: Klima servisi 10:00, anahtarı kapıcıya bırak."
              className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder-stone-500"
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

          <div className="flex items-center justify-between gap-2 pt-1">
            {existing ? (
              <Button
                type="button"
                variant="danger"
                onClick={handleDelete}
                loading={deleting}
                disabled={saving}
              >
                Notu Sil
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={saving || deleting}
              >
                İptal
              </Button>
              <Button type="submit" loading={saving} disabled={deleting}>
                Kaydet
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
