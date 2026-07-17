import { useEffect, useState, type FormEvent } from 'react';
import { updateStaffRegion } from '@/lib/queries/staff';
import { listRegions, type Region } from '@/lib/queries/regions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import type { Role } from '@/types/database';

interface Props {
  staffUserId: string;
  staffName: string;
  /** Raw role — TEKNIK_PERSONEL is always all-region (server-pinned, migration 131). */
  staffRole: Role;
  currentRegion: string;
  currentAllRegions: boolean;
  onClose: () => void;
  onUpdated: (region: string, allRegions: boolean) => void;
}

/**
 * Assigns a staff member's home region + the all-regions visibility flag
 * (migrations 124/125: region access is a per-user assignment, not a role).
 * Backed by `updateStaffRegion` → RLS limits it to SUPER_ADMIN
 * (staff_profiles_modify). The home region also routes maaş/avans to that
 * region's kasa; the flag widens visibility only — kasa access stays
 * role-gated server-side (auth_sees_all_regions).
 */
export function AssignRegionModal({
  staffUserId,
  staffName,
  staffRole,
  currentRegion,
  currentAllRegions,
  onClose,
  onUpdated,
}: Props) {
  const isTeknik = staffRole === 'TEKNIK_PERSONEL';
  const [region, setRegion] = useState(currentRegion);
  const [allRegions, setAllRegions] = useState(isTeknik ? true : currentAllRegions);
  const [regions, setRegions] = useState<Region[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRegions()
      .then(setRegions)
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : 'Bölgeler yüklenemedi'),
      );
  }, []);

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
    const nextAllRegions = isTeknik ? true : allRegions;
    if (region === currentRegion && nextAllRegions === currentAllRegions) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const row = await updateStaffRegion(staffUserId, region, nextAllRegions);
      // Echo the server's values (the migration-131 trigger may pin all_regions).
      onUpdated(row.region, row.all_regions);
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
            Bölge Ataması
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
          hangi bölgeye bağlı çalışacak? Maaş ve avanslar ana bölgenin kasasından
          ödenir.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Select
            label="Ana Bölge"
            name="region"
            value={region}
            onChange={(v) => setRegion(v)}
            options={regions.map((r) => ({ value: r.name, label: r.name }))}
          />

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={isTeknik ? true : allRegions}
              disabled={isTeknik}
              onChange={(e) => setAllRegions(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-stone-300 text-emerald-600 focus:ring-emerald-500 dark:border-stone-600"
            />
            <span className="text-sm text-stone-700 dark:text-stone-300">
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Tüm bölgeleri görebilir
              </span>
              <br />
              <span className="text-xs text-stone-500 dark:text-stone-400">
                Diğer bölgelerin mülk, rezervasyon ve bildirimlerini de görür.
                Kasa erişimi rolüne bağlı kalır.
              </span>
            </span>
          </label>

          {isTeknik && (
            <p className="rounded bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              Teknik Personel her zaman tüm bölgeleri görür; bu ayar kapatılamaz.
            </p>
          )}

          {(loadError || error) && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {loadError || error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              İptal
            </Button>
            <Button type="submit" loading={saving} disabled={regions.length === 0}>
              Kaydet
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
