import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createLedgerEntry,
  type LedgerEntry,
} from '@/lib/queries/ledger';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { NumberInput } from '@/components/ui/NumberInput';

interface Props {
  guestId: string;
  reservationId: string;
  createdByUserId: string;
  onClose: () => void;
  onCreated: (entry: LedgerEntry) => void;
}

/**
 * Adds an extra charge (DEBT ledger entry) to the guest's cari hesap.
 * Typical use: room service, damage fee, late checkout, minibar, etc.
 *
 * For recording money received from the guest, use the PaymentCollectModal
 * instead — it atomically updates the cari, the cash drawer, and the
 * payment_collections audit row.
 */
export function LedgerEntryModal({
  guestId,
  reservationId,
  createdByUserId,
  onClose,
  onCreated,
}: Props) {
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    amountRef.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!amount || amount <= 0) {
      setError('Tutar sıfırdan büyük olmalıdır.');
      return;
    }

    setSaving(true);
    try {
      const created = await createLedgerEntry({
        guest_id: guestId,
        reservation_id: reservationId,
        type: 'DEBT',
        amount,
        note: note.trim() || null,
        created_by: createdByUserId,
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
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Ekstra Ücret
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
          Misafir hesabına ek bir ücret ekler (örn. ek hizmet, hasar, geç çıkış,
          minibar). Misafir borcu bu tutar kadar artar.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <NumberInput
            ref={amountRef}
            label="Tutar (₺)"
            name="amount"
            required
            min={0}
            step={10}
            value={amount}
            onChange={setAmount}
          />

          <Input
            label="Açıklama"
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={250}
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
