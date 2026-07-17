import { useEffect, useState, type FormEvent } from 'react';
import { updateStaffScope } from '@/lib/queries/staff';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import type { AccessScope } from '@/types/database';

interface Props {
  staffUserId: string;
  staffName: string;
  currentScope: AccessScope;
  onClose: () => void;
  onUpdated: (newScope: AccessScope) => void;
}

const SCOPE_OPTIONS: { value: AccessScope; label: string }[] = [
  { value: 'ALL', label: 'Tüm Mülkler' },
  { value: 'HOTELS', label: 'Binalar' },
  { value: 'APARTMENTS', label: 'Daireler' },
];

/**
 * Sets where a staff member works — the 3-way access scope. Replaces the old
 * single-property assignment. Backed by `updateStaffScope` → migration 033's
 * `auth_sees_property()` enforces it server-side.
 */
export function AssignScopeModal({
  staffUserId,
  staffName,
  currentScope,
  onClose,
  onUpdated,
}: Props) {
  const [scope, setScope] = useState<AccessScope>(currentScope);
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
    if (scope === currentScope) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await updateStaffScope(staffUserId, scope);
      onUpdated(scope);
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
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Nerede Çalışacak?
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

        <p className="mb-4 text-sm text-stone-600 dark:text-stone-300">
          <strong className="text-stone-900 dark:text-stone-100">{staffName}</strong>{' '}
          hangi mülklerde çalışacak? Personel yalnızca seçilen tür mülklerin
          verilerini görebilir.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Select
            label="Çalışma Alanı"
            name="access_scope"
            value={scope}
            onChange={(v) => setScope(v as AccessScope)}
            options={SCOPE_OPTIONS}
          />

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
