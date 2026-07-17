import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createGuest, type GuestInput, type GuestSummary } from '@/lib/queries/guests';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { maskPhoneInput, phoneForSave } from '@/lib/utils';

interface Props {
  onClose: () => void;
  onCreated: (guest: GuestSummary) => void;
}

export function QuickAddGuestModal({ onClose, onCreated }: Props) {
  const [fullName, setFullName] = useState('');
  const [tcKimlik, setTcKimlik] = useState('');
  const [passport, setPassport] = useState('');
  const [phone, setPhone] = useState('+90 ');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [nationality, setNationality] = useState('Türkiye');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
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
      setError('Ad Soyad zorunludur.');
      return;
    }
    const cleanTc = tcKimlik.replace(/\D/g, '');
    if (cleanTc && cleanTc.length !== 11) {
      setError(`TC kimlik 11 haneli olmalıdır (girilen: ${cleanTc.length} hane).`);
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Geçerli bir e-posta adresi giriniz.');
      return;
    }

    setSaving(true);
    try {
      const input: GuestInput = {
        full_name: fullName.trim(),
        tc_kimlik: cleanTc || null,
        passport: passport.trim() || null,
        phone: phoneForSave(phone),
        email: email.trim() || null,
        address: address.trim() || null,
        nationality: nationality.trim() || null,
      };
      const row = await createGuest(input);
      const summary: GuestSummary = {
        id: row.id,
        full_name: row.full_name,
        phone: row.phone,
        email: row.email,
        nationality: row.nationality,
        is_problematic: row.is_problematic,
        created_at: row.created_at,
        created_by: row.created_by,
      };
      onCreated(summary);
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
            Yeni Misafir
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

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <Input
            ref={firstInputRef}
            label="Ad Soyad"
            name="qag_full_name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={100}
          />

          <Input
            label="TC Kimlik"
            name="qag_tc_kimlik"
            value={tcKimlik}
            onChange={(e) => setTcKimlik(e.target.value.replace(/\D/g, '').slice(0, 11))}
            placeholder="11 haneli"
            inputMode="numeric"
            maxLength={11}
            hint={tcKimlik ? `${tcKimlik.length}/11 hane` : undefined}
          />

          <Input
            label="Pasaport No"
            name="qag_passport"
            value={passport}
            onChange={(e) => setPassport(e.target.value)}
            placeholder="Yabancı misafirler için"
            maxLength={20}
          />

          <Input
            label="Telefon"
            name="qag_phone"
            type="tel"
            inputMode="tel"
            value={phone}
            // Live-masked: strips illegal chars + auto-prepends +90 for local-format
            // Turkish numbers. Foreign numbers starting with `+` pass through unchanged.
            onChange={(e) => setPhone(maskPhoneInput(e.target.value))}
            placeholder="+90 5xx xxx xx xx"
            maxLength={25}
          />

          <Input
            label="E-posta"
            name="qag_email"
            type="email"
            value={email}
            // Only standard email characters: letters, digits, and . @ _ + -
            onChange={(e) => setEmail(e.target.value.replace(/[^a-zA-Z0-9.@_+-]/g, ''))}
            placeholder="ornek@email.com"
            maxLength={254}
          />

          <Input
            label="Adres"
            name="qag_address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Mahalle, İlçe, İl"
            maxLength={250}
          />

          <Input
            label="Uyruk"
            name="qag_nationality"
            value={nationality}
            onChange={(e) => setNationality(e.target.value)}
            maxLength={60}
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
              Oluştur
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
