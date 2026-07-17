import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCompanionsDecrypted } from '@/lib/queries/companions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CompanionModal } from '@/pages/guests/CompanionModal';
import { formatDate } from '@/lib/utils';
import type { DecryptedCompanion } from '@/types/database';

interface Props {
  guestId: string;
  guestName?: string;
  /** Whether the caller can add / edit / delete (mirrors guest:update RBAC). */
  canEdit: boolean;
  onClose: () => void;
}

/**
 * Read-mostly inline view of a guest's companions (Ek Misafir) callable from
 * the reservation detail page. Avoids the round-trip to /guests/:id when the
 * receptionist just wants to glance at who else is on the booking. Add /
 * edit / delete are gated behind canEdit + delegate to the existing
 * CompanionModal (same form GuestDetailPage uses).
 */
export function CompanionListModal({ guestId, guestName, canEdit, onClose }: Props) {
  const [companions, setCompanions] = useState<DecryptedCompanion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DecryptedCompanion | 'new' | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  useEffect(() => {
    setError(null);
    getCompanionsDecrypted(guestId)
      .then(setCompanions)
      .catch((e) => setError(e instanceof Error ? e.message : 'Yüklenemedi'));
  }, [guestId, version]);

  const handleSaved = () => {
    setEditing(null);
    setVersion((v) => v + 1);
  };

  if (editing !== null) {
    return (
      <CompanionModal
        guestId={guestId}
        companion={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
    );
  }

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
              Ek Misafirler
            </h2>
            {guestName && (
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {guestName} adına kayıtlı
              </p>
            )}
          </div>
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

        {error && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}

        {!error && companions === null && (
          <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
        )}

        {companions && companions.length === 0 && (
          <p className="rounded bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-300">
            Ek misafir kaydı yok.
          </p>
        )}

        {companions && companions.length > 0 && (
          <ul className="divide-y divide-stone-200 dark:divide-stone-700">
            {companions.map((c) => (
              <li key={c.id} className="py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-stone-900 dark:text-stone-100">
                      {c.full_name}
                    </p>
                    <p className="text-xs text-stone-600 dark:text-stone-300">
                      {[
                        c.relationship,
                        c.birth_date ? formatDate(c.birth_date) : null,
                        c.nationality,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                    {(c.tc_kimlik || c.passport) && (
                      <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                        {c.tc_kimlik && <>TC: {c.tc_kimlik}</>}
                        {c.tc_kimlik && c.passport && ' · '}
                        {c.passport && <>Pasaport: {c.passport}</>}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => setEditing(c)}
                      className="rounded px-2 py-1 text-xs text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                    >
                      Düzenle
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {canEdit && (
            <Button type="button" onClick={() => setEditing('new')}>
              + Ek Misafir
            </Button>
          )}
          <Link
            to={`/guests/${guestId}`}
            className="inline-flex items-center rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Misafir Sayfası
          </Link>
          <Button type="button" variant="secondary" onClick={onClose}>
            Kapat
          </Button>
        </div>
      </Card>
    </div>
  );
}
