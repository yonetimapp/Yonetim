import { useEffect, useState, type FormEvent } from 'react';
import { updateStaffRole } from '@/lib/queries/staff';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { formatRole } from '@/lib/utils';
import type { Role } from '@/types/database';

interface Props {
  staffUserId: string;
  staffName: string;
  currentRole: Role;
  onClose: () => void;
  onUpdated: (newRole: Role) => void;
}

const ALL_ROLES: Role[] = [
  'SUPER_ADMIN',
  'PROPERTY_MANAGER',
  'YETKILI',
  'TEKNIK_PERSONEL',
  'RECEPTION',
  'HOUSEKEEPING',
  'PENDING',
];

const ROLE_OPTIONS = ALL_ROLES.map((r) => ({ value: r, label: formatRole(r) }));

/**
 * Promote a PENDING signup to a real role — or change an existing staff
 * member's role. Backed by updateStaffRole → RLS limits this to SUPER_ADMIN
 * (staff_profiles_modify, migration 003).
 */
export function EditRoleModal({
  staffUserId,
  staffName,
  currentRole,
  onClose,
  onUpdated,
}: Props) {
  const [role, setRole] = useState<Role>(currentRole);
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
    if (role === currentRole) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await updateStaffRole(staffUserId, role);
      onUpdated(role);
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
            Rolü Değiştir
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
          için yeni rolü seçin. Yeni rol bir sonraki girişte etkili olur.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Select
            label="Rol"
            name="role"
            value={role}
            onChange={(v) => setRole(v as Role)}
            options={ROLE_OPTIONS}
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
