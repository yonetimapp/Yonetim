import { useEffect, useState, type FormEvent } from 'react';
import {
  createCompanion,
  updateCompanion,
  type CompanionInput,
} from '@/lib/queries/companions';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import type { DecryptedCompanion } from '@/types/database';

interface Props {
  guestId: string;
  /** The companion to edit, or null to add a new one. */
  companion: DecryptedCompanion | null;
  onClose: () => void;
  onSaved: () => void;
}

const RELATIONSHIP_OPTIONS = [
  { value: '', label: '— Seçiniz —' },
  { value: 'Eş', label: 'Eş' },
  { value: 'Çocuk', label: 'Çocuk' },
  { value: 'Anne', label: 'Anne' },
  { value: 'Baba', label: 'Baba' },
  { value: 'Kardeş', label: 'Kardeş' },
  { value: 'Diğer', label: 'Diğer' },
];

/**
 * Add / edit an Ek Misafir (companion). TC kimlik and passport are sent to the
 * create_companion / update_companion RPCs, which encrypt them server-side.
 */
export function CompanionModal({ guestId, companion, onClose, onSaved }: Props) {
  const isEdit = companion !== null;

  const [fullName, setFullName] = useState(companion?.full_name ?? '');
  const [relationship, setRelationship] = useState(companion?.relationship ?? '');
  const [birthDate, setBirthDate] = useState(companion?.birth_date ?? '');
  const [nationality, setNationality] = useState(companion?.nationality ?? '');
  const [tcKimlik, setTcKimlik] = useState(companion?.tc_kimlik ?? '');
  const [passport, setPassport] = useState(companion?.passport ?? '');
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
    if (!fullName.trim()) {
      setError('Ad soyad zorunludur.');
      return;
    }
    const input: CompanionInput = {
      fullName: fullName.trim(),
      relationship: relationship || null,
      birthDate: birthDate || null,
      nationality: nationality.trim() || null,
      tcKimlik: tcKimlik.trim() || null,
      passport: passport.trim() || null,
    };
    setSaving(true);
    try {
      if (isEdit && companion) {
        await updateCompanion(companion.id, input);
      } else {
        await createCompanion(guestId, input);
      }
      onSaved();
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
            {isEdit ? 'Ek Misafir Düzenle' : 'Ek Misafir Ekle'}
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

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Input
            label="Ad Soyad"
            name="full_name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={120}
          />
          <Select
            label="Yakınlık"
            name="relationship"
            value={relationship}
            onChange={setRelationship}
            options={RELATIONSHIP_OPTIONS}
          />
          <DateInput
            label="Doğum Tarihi"
            name="birth_date"
            value={birthDate}
            onChange={setBirthDate}
          />
          <Input
            label="Uyruk"
            name="nationality"
            value={nationality}
            onChange={(e) => setNationality(e.target.value)}
            maxLength={60}
          />
          <Input
            label="TC Kimlik"
            name="tc_kimlik"
            value={tcKimlik}
            onChange={(e) => setTcKimlik(e.target.value)}
            maxLength={20}
          />
          <Input
            label="Pasaport No"
            name="passport"
            value={passport}
            onChange={(e) => setPassport(e.target.value)}
            maxLength={30}
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
