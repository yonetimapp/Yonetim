import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { createIssue } from '@/lib/queries/housekeepingIssues';
import { listProperties, sortHotelsFirst, type Property } from '@/lib/queries/properties';
import { listUnitsForProperty, type Unit } from '@/lib/queries/units';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { XMarkIcon } from '@/components/icons/ActionIcons';

interface Props {
  onClose: () => void;
  /** Fires after a successful create so the Dashboard can refresh its counts. */
  onCreated?: () => void;
}

/**
 * Dashboard "Sorunlar" quick-action modal: pick any mülk, then a birim within it,
 * and file a problem report — no active reservation required (a unit can have a
 * fault while empty). Skips photo upload on purpose — the full IssuesModal on the
 * Temizlik page is the place for that; this entry point is optimised for a fast
 * "I see a problem, log it" flow.
 *
 * Writes into housekeeping_issues via the same createIssue path the IssuesModal
 * uses, so RLS, audit, and the open-issue counter all stay in sync. Both the
 * mülk list and the birim list are RLS-filtered to what the caller may see.
 */
export function QuickIssueModal({ onClose, onCreated }: Props) {
  const { user } = useAuth();
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [propertyId, setPropertyId] = useState('');
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the mülk list once.
  useEffect(() => {
    setLoadError(null);
    listProperties()
      .then((rows) => setProperties(sortHotelsFirst(rows)))
      .catch((e) => setLoadError(e?.message ?? 'Mülkler yüklenemedi'));
  }, []);

  // Load the chosen mülk's birimler; reset the birim pick whenever the mülk changes.
  useEffect(() => {
    setUnitId('');
    setUnits(null);
    if (!propertyId) return;
    setUnitsLoading(true);
    setError(null);
    listUnitsForProperty(propertyId)
      .then((rows) => setUnits(rows))
      .catch((e) => setError(e?.message ?? 'Birimler yüklenemedi'))
      .finally(() => setUnitsLoading(false));
  }, [propertyId]);

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
    if (!propertyId) {
      setError('Bir mülk seçin.');
      return;
    }
    if (!unitId) {
      setError('Bir birim seçin.');
      return;
    }
    if (!description.trim()) {
      setError('Sorun açıklaması zorunludur.');
      return;
    }
    if (!user) {
      setError('Oturum bulunamadı.');
      return;
    }
    setSaving(true);
    try {
      await createIssue({
        property_id: propertyId,
        unit_id: unitId,
        description: description.trim(),
        photo_paths: [],
        reported_by: user.id,
      });
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  const propertyOptions = (properties ?? []).map((p) => ({ value: p.id, label: p.name }));
  const unitOptions = (units ?? []).map((u) => ({ value: u.id, label: u.name }));

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
              Sorun Bildir
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Bir mülk ve birim seçip sorunu kısaca yazın.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700"
            aria-label="Kapat"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {loadError && (
          <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {loadError}
          </p>
        )}

        {!loadError && properties === null && (
          <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
        )}

        {properties !== null && properties.length === 0 && (
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Görüntüleyebileceğiniz bir mülk yok.
          </p>
        )}

        {properties !== null && properties.length > 0 && (
          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <Select
              label="Mülk"
              name="issue_property"
              required
              searchable
              value={propertyId}
              onChange={setPropertyId}
              options={propertyOptions}
              placeholder="Mülk seçin"
            />

            <Select
              label="Birim"
              name="issue_unit"
              required
              searchable
              disabled={!propertyId}
              value={unitId}
              onChange={setUnitId}
              options={unitOptions}
              placeholder={
                !propertyId
                  ? 'Önce mülk seçin'
                  : unitsLoading
                    ? 'Yükleniyor…'
                    : unitOptions.length === 0
                      ? 'Bu mülkte birim yok'
                      : 'Birim seçin'
              }
            />

            <div>
              <label
                htmlFor="quick_issue_desc"
                className="block text-sm font-medium text-stone-700 dark:text-stone-300"
              >
                Sorun Açıklaması<span className="ml-0.5 text-red-500">*</span>
              </label>
              <textarea
                id="quick_issue_desc"
                name="quick_issue_desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Örn: Klima çalışmıyor, duşta sızıntı var."
                className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder-stone-500"
              />
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Fotoğraf eklemek için Temizlik sayfasındaki birim kartından ilerleyin.
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
                Sorun Bildir
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
