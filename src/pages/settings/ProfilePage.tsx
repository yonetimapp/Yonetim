import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { updateOwnFullName } from '@/lib/queries/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PushNotificationsCard } from '@/components/PushNotificationsCard';
import { NotificationPreferencesList } from '@/components/NotificationPreferencesList';
import { formatRole } from '@/lib/utils';

export function ProfilePage() {
  const { profile, user, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successAt, setSuccessAt] = useState<number | null>(null);

  // Seed the input once the profile arrives.
  useEffect(() => {
    if (profile) setFullName(profile.full_name);
  }, [profile]);

  // Auto-clear the success message after a couple seconds.
  useEffect(() => {
    if (successAt === null) return;
    const t = window.setTimeout(() => setSuccessAt(null), 2500);
    return () => window.clearTimeout(t);
  }, [successAt]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = fullName.trim();
    if (!trimmed) {
      setError('Ad boş olamaz.');
      return;
    }
    if (profile && trimmed === profile.full_name) {
      // No-op — nothing to save.
      return;
    }
    setSaving(true);
    try {
      await updateOwnFullName(trimmed);
      await refreshProfile();
      setSuccessAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaydedilemedi');
    } finally {
      setSaving(false);
    }
  };

  if (!profile) {
    return <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Profil
        </h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Görünen adınızı düzenleyin. Rol ve maaş gibi alanlar süper admin tarafından
          yönetilir.
        </p>
      </div>

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Ad Soyad"
            name="full_name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={120}
            autoComplete="name"
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone-600 dark:text-stone-300">
                Rol
              </p>
              <p className="mt-1 text-sm text-stone-900 dark:text-stone-100">
                {formatRole(profile.role)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone-600 dark:text-stone-300">
                E-posta
              </p>
              <p className="mt-1 break-all text-sm text-stone-900 dark:text-stone-100">
                {user?.email ?? '—'}
              </p>
            </div>
          </div>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          {successAt !== null && (
            <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              Profil güncellendi ✓
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" loading={saving}>
              Kaydet
            </Button>
          </div>
        </form>
      </Card>

      <PushNotificationsCard />

      <Card>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Bildirim Ayarları
        </h2>
        <p className="mb-3 mt-1 text-sm text-stone-600 dark:text-stone-300">
          Hangi olaylar için cihazınıza anlık bildirim gönderileceğini seçin.
        </p>
        <NotificationPreferencesList />
      </Card>
    </div>
  );
}
