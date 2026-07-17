import { useEffect, useRef, useState, type FormEvent } from 'react';
import { updateStaffSalary } from '@/lib/queries/staff';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { NumberInput } from '@/components/ui/NumberInput';
import { Select } from '@/components/ui/Select';

/** Dropdown options for the salary auto-pay day. Empty value = manual only. */
const SALARY_DAY_OPTIONS = [
  { value: '', label: 'Yok (elle ödeme)' },
  ...Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: `Her ayın ${i + 1}. günü`,
  })),
];

interface Props {
  staffUserId: string;
  staffName: string;
  currentSalary: number | null;
  currentSalaryDay: number | null;
  onClose: () => void;
  /** Fires with the new payroll settings — parent updates its local snapshot. */
  onUpdated: (next: { salary: number; salary_day: number | null }) => void;
}

export function EditSalaryModal({
  staffUserId,
  staffName,
  currentSalary,
  currentSalaryDay,
  onClose,
  onUpdated,
}: Props) {
  const [salary, setSalary] = useState<number>(currentSalary ?? 0);
  /**
   * salary_day uses '' for "manual only" so the input can be cleared. We
   * convert to int on submit. The DB CHECK keeps it in 1..31 if set.
   */
  const [salaryDay, setSalaryDay] = useState<string>(
    currentSalaryDay != null ? String(currentSalaryDay) : '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const salaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    salaryRef.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (salary < 0) {
      setError('Maaş negatif olamaz.');
      return;
    }
    let parsedDay: number | null = null;
    if (salaryDay !== '') {
      const n = Number(salaryDay);
      if (!Number.isInteger(n) || n < 1 || n > 31) {
        setError('Ödeme günü 1 ile 31 arasında olmalıdır.');
        return;
      }
      parsedDay = n;
    }

    setSaving(true);
    try {
      await updateStaffSalary(staffUserId, salary, parsedDay);
      onUpdated({ salary, salary_day: parsedDay });
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
            Maaş ve Ödeme Günü
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
          için aylık maaşı ve otomatik ödeme gününü belirleyin.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <NumberInput
            ref={salaryRef}
            label="Aylık Maaş (₺)"
            name="salary"
            required
            min={0}
            step={100}
            value={salary}
            onChange={setSalary}
          />

          <div>
            <Select
              label="Otomatik Ödeme Günü"
              name="salary_day"
              value={salaryDay}
              onChange={setSalaryDay}
              options={SALARY_DAY_OPTIONS}
              searchable
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Seçilen gün geldiğinde maaş kasadan otomatik düşülür.
              "Yok" seçerseniz yalnızca elle ödeme yapılır.
            </p>
            {/* The cron has a "salary_day > month length" fallback that pays on
                the last day of the month so nobody misses February etc. Surface
                it inline when the user picks 29 / 30 / 31 so they aren't
                surprised by the behavior. */}
            {Number(salaryDay) >= 29 && (
              <p className="mt-1 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                Not: Bu sayının olmadığı aylarda (örn. Şubat) ödeme ayın son
                gününde otomatik yapılır.
              </p>
            )}
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
              Kaydet
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
