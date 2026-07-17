import { useEffect, useState, type FormEvent } from 'react';
import { setPriceRange, deletePrice } from '@/lib/queries/property_nightly_prices';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { NumberInput } from '@/components/ui/NumberInput';

interface Props {
  propertyId: string;
  unitId: string;
  unitName: string;
  /** YYYY-MM-DD that was clicked — defaults to both start and end of the range. */
  dateStr: string;
  /** Optional end-of-range when the modal is opened from a range-select. */
  dateEnd?: string;
  /** Existing override id at the clicked cell, if any — surfaces a Sil button. */
  existingId: string | null;
  /** Existing price at the clicked cell, if any — pre-fills the input. */
  existingPrice: number | null;
  /** Unit's base nightly price — shown as fallback context. */
  unitBasePrice: number;
  onClose: () => void;
  /** Fires after successful save / delete. Parent should refresh. */
  onSaved: () => void;
}

/**
 * Set a nightly-price override for a single date or a date range. Backed by
 * the set_nightly_price_range RPC (migration 047), which upserts one row per
 * night in [start, end] inclusive — so "weekend premium 2026-06-05 to
 * 2026-06-07 @ 1500₺" is a single call that touches 3 nights.
 */
export function NightlyPriceModal({
  propertyId,
  unitId,
  unitName,
  dateStr,
  dateEnd,
  existingId,
  existingPrice,
  unitBasePrice,
  onClose,
  onSaved,
}: Props) {
  const [start, setStart] = useState(dateStr);
  const [end, setEnd] = useState(dateEnd ?? dateStr);
  const [price, setPrice] = useState<number>(existingPrice ?? unitBasePrice);
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
    if (end < start) {
      setError('Bitiş tarihi başlangıçtan önce olamaz.');
      return;
    }
    if (price < 0 || !Number.isFinite(price)) {
      setError('Geçerli bir fiyat giriniz.');
      return;
    }
    setSaving(true);
    try {
      await setPriceRange(propertyId, unitId, start, end, price);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existingId) return;
    setError(null);
    setDeleting(true);
    try {
      await deletePrice(existingId);
      onSaved();
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
              Gecelik Fiyat
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              {unitName} · Birim ücreti: <strong>{unitBasePrice} ₺</strong>
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
            Tek bir gün için aynı tarihi seçin. Bir aralık (örn. hafta sonu, sezon)
            için bitiş tarihini değiştirin — aralıktaki her gece bu fiyata ayarlanır.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <DateInput
              label="Başlangıç"
              name="price_start"
              required
              value={start}
              onChange={setStart}
            />
            <DateInput
              label="Bitiş (dahil)"
              name="price_end"
              required
              value={end}
              onChange={setEnd}
            />
          </div>

          <NumberInput
            label="Gecelik Fiyat (₺)"
            name="price"
            min={0}
            step={50}
            required
            value={price}
            onChange={setPrice}
          />

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            {existingId ? (
              <Button
                type="button"
                variant="danger"
                onClick={handleDelete}
                loading={deleting}
                disabled={saving}
              >
                Bu Geceyi Sıfırla
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
