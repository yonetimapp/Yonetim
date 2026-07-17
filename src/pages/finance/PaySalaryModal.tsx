import { useEffect, useState, type FormEvent } from 'react';
import {
  payStaffSalary,
  type StaffSalaryPayment,
} from '@/lib/queries/staff_salary_payments';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateInput } from '@/components/ui/DateInput';
import { NumberInput } from '@/components/ui/NumberInput';
import { istanbulToday } from '@/lib/utils';

interface Props {
  staffUserId: string;
  staffName: string;
  defaultSalary: number | null;
  onClose: () => void;
  onPaid: (payment: StaffSalaryPayment) => void;
}

/**
 * Manual salary payment — pays from the singleton general kasa. Defaults the
 * pay period to the first of the current Istanbul month so the operator can
 * just tap Öde without picking anything. The backend RPC (pay_staff_salary,
 * migration 049) catches duplicate-period attempts with a friendly Turkish
 * message via the unique constraint.
 */
export function PaySalaryModal({
  staffUserId,
  staffName,
  defaultSalary,
  onClose,
  onPaid,
}: Props) {
  const [amount, setAmount] = useState<number>(defaultSalary ?? 0);
  /** First of the current Istanbul month — what auto-pay would use too. */
  const [payPeriod, setPayPeriod] = useState<string>(() => {
    const today = istanbulToday(); // YYYY-MM-DD
    return `${today.slice(0, 7)}-01`;
  });
  const [note, setNote] = useState('');
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
    if (amount < 0) {
      setError('Tutar negatif olamaz.');
      return;
    }
    setSaving(true);
    try {
      const payment = await payStaffSalary({
        userId: staffUserId,
        amount,
        payPeriod,
        note: note.trim() || null,
      });
      onPaid(payment);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ödeme başarısız');
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
            Maaş Öde
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
          için maaş ödemesi — tutar genel kasadan düşülür.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <NumberInput
            label="Tutar (₺)"
            name="amount"
            required
            min={0}
            step={100}
            value={amount}
            onChange={setAmount}
          />

          <DateInput
            label="Dönem (ay)"
            name="pay_period"
            required
            value={payPeriod}
            onChange={setPayPeriod}
          />
          <p className="-mt-2 text-xs text-stone-500 dark:text-stone-400">
            Aynı ay için ikinci bir maaş ödenemez. Genelde ayın 1'i seçilir.
          </p>

          <div>
            <label
              htmlFor="pay_note"
              className="block text-sm font-medium text-stone-700 dark:text-stone-300"
            >
              Not (opsiyonel)
            </label>
            <textarea
              id="pay_note"
              name="pay_note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Örn: Mart maaşı (gecikmeli)"
              className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder-stone-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder-stone-500"
            />
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
              Öde
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
