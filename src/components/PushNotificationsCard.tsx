import { useEffect, useState } from 'react';
import {
  getCurrentSubscription,
  getNotificationPermission,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

/** UI state for the push subscription toggle. */
type Status = 'checking' | 'unsupported' | 'blocked' | 'disabled' | 'enabled';

/**
 * Settings card for enabling/disabling Web Push notifications on this device.
 * Lives in the profile page. Each browser/device subscribes independently;
 * disabling here only affects the current device.
 */
export function PushNotificationsCard() {
  const [status, setStatus] = useState<Status>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isPushSupported()) {
        if (!cancelled) setStatus('unsupported');
        return;
      }
      if (getNotificationPermission() === 'denied') {
        if (!cancelled) setStatus('blocked');
        return;
      }
      const sub = await getCurrentSubscription();
      if (cancelled) return;
      setStatus(sub ? 'enabled' : 'disabled');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      await subscribeToPush();
      setStatus('enabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirim açılamadı.');
      // If the user just hit "Block" in the permission prompt, reflect that
      // back into the visible state so the button doesn't keep offering it.
      if (getNotificationPermission() === 'denied') setStatus('blocked');
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush();
      setStatus('disabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirim kapatılamadı.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
        Bildirimler
      </h2>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
        Yeni sorun bildirimi, ödeme onayları ve rezervasyon gibi olaylar için
        cihazınıza anlık bildirim alın. Her cihaz için ayrı açılır.
      </p>

      <div className="mt-4">
        {status === 'checking' && (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Durum kontrol ediliyor…
          </p>
        )}

        {status === 'unsupported' && (
          <p className="rounded bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-300">
            Bu tarayıcı bildirimleri desteklemiyor. iPhone'da kullanmak için
            uygulamayı Safari'den ana ekrana eklemeniz (iOS 16.4+) gerekir.
          </p>
        )}

        {status === 'blocked' && (
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Bildirim izni tarayıcı tarafından engellenmiş. Tarayıcı/cihaz
            ayarlarından bu site için bildirimleri tekrar açabilirsiniz.
          </p>
        )}

        {status === 'disabled' && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-700 dark:text-stone-300">
              Bu cihazda bildirimler <strong>kapalı</strong>.
            </p>
            <Button onClick={handleEnable} loading={busy}>
              Bildirimleri Etkinleştir
            </Button>
          </div>
        )}

        {status === 'enabled' && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              Bu cihazda bildirimler <strong>açık</strong>.
            </p>
            <Button variant="secondary" onClick={handleDisable} loading={busy}>
              Devre Dışı Bırak
            </Button>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
