import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  listTrash,
  restoreTrashEntry,
  purgeTrashEntry,
  payloadField,
  TRASHABLE_LABELS,
  TRASHABLE_TYPES,
  type TrashEntry,
  type TrashableType,
} from '@/lib/queries/trash';
import { listProperties } from '@/lib/queries/properties';
import { listAllUnits } from '@/lib/queries/units';
import { loadStaffDirectory } from '@/lib/queries/staff_directory';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cn, formatDateTime } from '@/lib/utils';

type FilterOption = 'ALL' | TrashableType;

export function TrashPage() {
  const { profile } = useAuth();
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterOption>('ALL');
  // Lookups to turn the payload's IDs into names + who deleted the row.
  const [properties, setProperties] = useState<{ id: string; name: string }[]>([]);
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [staffMap, setStaffMap] = useState<Map<string, string>>(() => new Map());

  // Per-row action state
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const [toPurge, setToPurge] = useState<TrashEntry | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const isAdmin = profile?.role === 'SUPER_ADMIN';

  const load = () => {
    setError(null);
    listTrash()
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : 'Yüklenemedi'));
  };

  useEffect(() => {
    load();
    // Best-effort lookups for the per-entry detail lines.
    listProperties().then(setProperties).catch(() => {});
    listAllUnits().then(setUnits).catch(() => {});
    loadStaffDirectory().then(setStaffMap).catch(() => {});
  }, []);

  const propMap = useMemo(
    () => new Map(properties.map((p) => [p.id, p.name])),
    [properties],
  );
  const unitMap = useMemo(() => new Map(units.map((u) => [u.id, u.name])), [units]);

  // Extra context lines per entry: mülk/birim for reservations + sorunlar, mülk
  // for giderler (or "Genel"). Pulled from the deleted row's payload snapshot.
  const entryMeta = (entry: TrashEntry): string[] => {
    const propId = payloadField<string>(entry, 'property_id');
    const unitId = payloadField<string>(entry, 'unit_id');
    const propName = propId ? propMap.get(propId) : undefined;
    const unitName = unitId ? unitMap.get(unitId) : undefined;
    if (entry.entity_type === 'reservations') {
      const parts = [propName, unitName].filter(Boolean);
      return parts.length ? [`Mülk / Birim: ${parts.join(' · ')}`] : [];
    }
    if (entry.entity_type === 'expenses') {
      return [propName ? `Mülk: ${propName}` : 'Genel gider'];
    }
    if (entry.entity_type === 'housekeeping_issues') {
      const parts = [propName, unitName].filter(Boolean);
      return parts.length ? [`Mülk: ${parts.join(' · ')}`] : [];
    }
    return [];
  };

  const counts = useMemo(() => {
    const map = new Map<TrashableType, number>();
    for (const e of entries ?? []) {
      const t = e.entity_type as TrashableType;
      map.set(t, (map.get(t) ?? 0) + 1);
    }
    return map;
  }, [entries]);

  const totalCount = entries?.length ?? 0;

  const visible = useMemo(() => {
    if (!entries) return [];
    if (filter === 'ALL') return entries;
    return entries.filter((e) => e.entity_type === filter);
  }, [entries, filter]);

  const handleRestore = async (entry: TrashEntry) => {
    setRestoringId(entry.id);
    setRestoreError(null);
    try {
      await restoreTrashEntry(entry.id);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== entry.id) : prev));
    } catch (e) {
      setRestoreError(
        (e instanceof Error ? e.message : 'Geri yüklenemedi') +
          ' — Önce ilgili üst kayıt (mülk/misafir/rezervasyon) silinmiş olabilir.',
      );
    } finally {
      setRestoringId(null);
    }
  };

  const handlePurge = async () => {
    if (!toPurge) return;
    setPurging(true);
    setPurgeError(null);
    try {
      await purgeTrashEntry(toPurge);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== toPurge.id) : prev));
      setToPurge(null);
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : 'Kalıcı silme başarısız');
    } finally {
      setPurging(false);
    }
  };

  if (!isAdmin) {
    return (
      <Card>
        <p className="text-sm text-stone-700 dark:text-stone-300">
          Bu sayfayı görüntülemek için süper admin yetkisi gereklidir.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Çöp Kutusu
        </h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Silinen kayıtlar burada saklanır. Her tür için en yeni 15 kayıt korunur; daha eskileri otomatik silinir.
        </p>
      </div>

      {/* Type filter chips */}
      <div className="flex flex-wrap gap-2">
        <FilterChip
          active={filter === 'ALL'}
          onClick={() => setFilter('ALL')}
          label="Tümü"
          count={totalCount}
        />
        {TRASHABLE_TYPES.map((t) => (
          <FilterChip
            key={t}
            active={filter === t}
            onClick={() => setFilter(t)}
            label={TRASHABLE_LABELS[t]}
            count={counts.get(t) ?? 0}
          />
        ))}
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {restoreError && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm text-amber-800 dark:text-amber-300">{restoreError}</p>
        </Card>
      )}

      {!entries && !error && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
      )}

      {entries && visible.length === 0 && (
        <Card>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            {filter === 'ALL'
              ? 'Çöp kutusu boş.'
              : `"${TRASHABLE_LABELS[filter as TrashableType]}" türünde silinmiş kayıt yok.`}
          </p>
        </Card>
      )}

      {visible.map((entry) => {
        const typeLabel =
          TRASHABLE_LABELS[entry.entity_type as TrashableType] ?? entry.entity_type;
        return (
          <Card key={entry.id} className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-700 dark:text-stone-200">
                    {typeLabel}
                  </span>
                </div>
                <p className="mt-1 break-words text-sm text-stone-900 dark:text-stone-100">
                  {entry.entity_label || <span className="italic opacity-60">(etiket yok)</span>}
                </p>
                {entryMeta(entry).map((line, i) => (
                  <p key={i} className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
                    {line}
                  </p>
                ))}
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Silindi: {formatDateTime(entry.deleted_at)}
                  {entry.deleted_by && staffMap.get(entry.deleted_by)
                    ? ` · Silen: ${staffMap.get(entry.deleted_by)}`
                    : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={restoringId === entry.id}
                  onClick={() => handleRestore(entry)}
                >
                  Geri Al
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setPurgeError(null);
                    setToPurge(entry);
                  }}
                >
                  Kalıcı Sil
                </Button>
              </div>
            </div>
          </Card>
        );
      })}

      <ConfirmDialog
        open={toPurge !== null}
        title={toPurge ? 'Bu kayıt kalıcı olarak silinsin mi?' : ''}
        description="Geri alınamaz. Varsa bağlı fotoğraflar da silinir."
        confirmLabel="Kalıcı Sil"
        destructive
        loading={purging}
        error={purgeError}
        onConfirm={handlePurge}
        onCancel={() => {
          setToPurge(null);
          setPurgeError(null);
        }}
      />
    </div>
  );
}

interface FilterChipProps {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}

function FilterChip({ active, label, count, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-4 py-1 text-sm font-medium transition-colors',
        active
          ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
          : 'border border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800',
      )}
    >
      {label} <span className="ml-1 text-xs opacity-70">({count})</span>
    </button>
  );
}
