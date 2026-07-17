import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import {
  createGuest,
  updateGuest,
  getGuestDecrypted,
  type GuestInput,
} from '@/lib/queries/guests';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { maskPhoneInput, phoneForSave } from '@/lib/utils';

export function GuestFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const location = useLocation();

  const [fullName, setFullName] = useState('');
  const [tcKimlik, setTcKimlik] = useState('');
  const [passport, setPassport] = useState('');
  // Default to "+90 " on the new-guest form so most operators (typing a TR
  // number) don't have to add it manually. Edit mode overwrites with the
  // stored value in the load effect below.
  const [phone, setPhone] = useState('+90 ');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [nationality, setNationality] = useState('Türkiye');
  /**
   * Sorunlu Misafir flag + note are NOT editable from this form — the
   * warning-triangle modal on the detail page owns that. We still load them
   * here so we can pass them through on update, otherwise updateGuest would
   * clobber an existing flag back to false on every form save.
   */
  const [isProblematic, setIsProblematic] = useState(false);
  const [problematicNote, setProblematicNote] = useState<string | null>(null);

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id) return;
    getGuestDecrypted(id)
      .then((g) => {
        if (!g) {
          setError('Misafir bulunamadı');
          return;
        }
        setFullName(g.full_name);
        setTcKimlik(g.tc_kimlik ?? '');
        setPassport(g.passport ?? '');
        setPhone(g.phone ?? '');
        setEmail(g.email ?? '');
        setAddress(g.address ?? '');
        setNationality(g.nationality ?? '');
        setIsProblematic(g.is_problematic);
        setProblematicNote(g.problematic_note);
      })
      .catch((e) => setError(e?.message ?? 'Yüklenemedi'))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  // Strip every non-digit character — paranoid against invisible/zero-width chars
  const onlyDigits = (v: string) => v.replace(/\D/g, '');

  const validateTc = (v: string): string | null => {
    if (!v) return null; // optional
    if (v.length !== 11) return `TC kimlik 11 haneli olmalıdır (girilen: ${v.length} hane).`;
    return null;
  };

  const validateEmail = (v: string): string | null => {
    if (!v) return null; // optional
    // Lenient: just needs something@something.something
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Geçerli bir e-posta adresi giriniz.';
    return null;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate name
    if (!fullName.trim()) {
      setError('Ad Soyad alanı zorunludur.');
      return;
    }

    // Sanitize before validating (digits only)
    const cleanTc = onlyDigits(tcKimlik);
    if (cleanTc !== tcKimlik) {
      setTcKimlik(cleanTc); // visually correct what we're about to save
    }

    const tcError = validateTc(cleanTc);
    if (tcError) {
      setError(tcError);
      return;
    }

    const emailError = validateEmail(email.trim());
    if (emailError) {
      setError(emailError);
      return;
    }

    const input: GuestInput = {
      full_name: fullName.trim(),
      tc_kimlik: cleanTc || null,
      passport: passport.trim() || null,
      phone: phoneForSave(phone),
      email: email.trim() || null,
      address: address.trim() || null,
      nationality: nationality.trim() || null,
      // Pass through the persisted Sorunlu Misafir state so an unrelated
      // form save doesn't clear a flag set via the warning-triangle modal.
      is_problematic: isProblematic,
      problematic_note: problematicNote,
    };

    setSaving(true);
    try {
      if (isEdit && id) {
        await updateGuest(id, input);
        navigate(`/guests/${id}`, { replace: true });
      } else {
        const created = await createGuest(input);
        navigate(`/guests/${created.id}`, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <button
        type="button"
        onClick={() =>
          location.key === 'default'
            ? navigate(isEdit && id ? `/guests/${id}` : '/guests')
            : navigate(-1)
        }
        className="inline-block text-sm text-emerald-600 hover:underline dark:text-emerald-500"
      >
        ← Geri
      </button>
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
        {isEdit ? 'Misafir Düzenle' : 'Yeni Misafir'}
      </h1>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Input
            label="Ad Soyad"
            name="full_name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={100}
          />

          <Input
            label="TC Kimlik"
            name="tc_kimlik"
            value={tcKimlik}
            // Strip non-digits as user types — bulletproof against pasted whitespace etc.
            onChange={(e) => setTcKimlik(e.target.value.replace(/\D/g, '').slice(0, 11))}
            placeholder="11 haneli"
            inputMode="numeric"
            maxLength={11}
            hint={tcKimlik ? `${tcKimlik.length}/11 hane` : undefined}
          />

          <Input
            label="Pasaport No"
            name="passport"
            value={passport}
            onChange={(e) => setPassport(e.target.value)}
            placeholder="Yabancı misafirler için"
            maxLength={20}
          />

          <Input
            label="Telefon"
            name="phone"
            value={phone}
            // Live-masked: strips illegal chars + auto-prepends +90 for local-format
            // Turkish numbers. Foreign numbers starting with `+` pass through unchanged.
            onChange={(e) => setPhone(maskPhoneInput(e.target.value))}
            placeholder="+90 5xx xxx xx xx"
            type="tel"
            inputMode="tel"
            maxLength={25}
          />

          <Input
            label="E-posta"
            name="email"
            type="email"
            value={email}
            // Only standard email characters: letters, digits, and . @ _ + -
            onChange={(e) => setEmail(e.target.value.replace(/[^a-zA-Z0-9.@_+-]/g, ''))}
            placeholder="ornek@email.com"
            maxLength={254}
          />

          <Input
            label="Adres"
            name="address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Mahalle, İlçe, İl"
            maxLength={250}
          />

          <Input
            label="Uyruk"
            name="nationality"
            value={nationality}
            onChange={(e) => setNationality(e.target.value)}
            placeholder="Örn: Türkiye"
            maxLength={60}
          />

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Link to={isEdit && id ? `/guests/${id}` : '/guests'}>
              <Button type="button" variant="secondary" disabled={saving}>
                İptal
              </Button>
            </Link>
            <Button type="submit" loading={saving}>
              {isEdit ? 'Kaydet' : 'Oluştur'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
