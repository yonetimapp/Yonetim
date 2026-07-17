import { useEffect, useState } from 'react';
import {
  listNotificationPreferences,
  setNotificationPreference,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENT_HINTS,
  eventsForRole,
  type NotificationEventType,
} from '@/lib/queries/notification_preferences';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { XMarkIcon } from '@/components/icons/ActionIcons';

interface Props {
  onClose: () => void;
}

/**
 * Per-device bell-icon settings modal. Each row is an event type the push
 * pipeline supports; toggling a row upserts a notification_preferences row
 * (RLS scopes it to the current user). Defaults are ON server-side, so an
 * untouched preference reads as enabled.
 */
export function NotificationSettingsModal({ onClose }: Props) {
  const [prefs, setPrefs] = useState<Record<NotificationEventType, boolean> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Per-event row spinner so toggles feel responsive without a global lock. */
  const [savingKey, setSavingKey] = useState<NotificationEventType | null>(null);
  const { profile } = useAuth();
  // Show only the toggles this role can actually receive a push for (mirrors the
  // trigger recipient lists). Roles that receive nothing get an empty-state note.
  const visibleEventTypes = eventsForRole(profile?.role);

  useEffect(() => {
    listNotificationPreferences()
      .then(setPrefs)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Tercihler yüklenemedi'));
  }, []);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const toggle = async (event_type: NotificationEventType) => {
    if (!prefs || savingKey) return;
    const next = !prefs[event_type];
    // Optimistic flip so the switch responds instantly.
    setPrefs({ ...prefs, [event_type]: next });
    setSavingKey(event_type);
    setSaveError(null);
    try {
      await setNotificationPreference(event_type, next);
    } catch (err) {
      // Revert on failure.
      setPrefs({ ...prefs, [event_type]: !next });
      setSaveError(err instanceof Error ? err.message : 'Tercih kaydedilemedi.');
    } finally {
      setSavingKey(null);
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
              Bildirim Ayarları
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Hangi olaylar için cihazınıza anlık bildirim gönderileceğini seçin.
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

        {!loadError && prefs === null && (
          <p className="text-sm text-stone-600 dark:text-stone-300">Yükleniyor…</p>
        )}

        {prefs && (
          <>
            {visibleEventTypes.length === 0 ? (
              <p className="py-2 text-sm text-stone-600 dark:text-stone-300">
                Rolünüz için yapılandırılabilir bir bildirim yok.
              </p>
            ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-700">
              {visibleEventTypes.map((key) => {
                const enabled = prefs[key];
                const busy = savingKey === key;
                return (
                  <li key={key} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                        {NOTIFICATION_EVENT_LABELS[key]}
                      </p>
                      <p className="text-xs text-stone-500 dark:text-stone-400">
                        {NOTIFICATION_EVENT_HINTS[key]}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={NOTIFICATION_EVENT_LABELS[key]}
                      onClick={() => toggle(key)}
                      disabled={busy}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-60 ${
                        enabled
                          ? 'bg-emerald-600'
                          : 'bg-stone-300 dark:bg-stone-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                          enabled ? 'translate-x-5' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
            )}

            {saveError && (
              <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                {saveError}
              </p>
            )}

            <div className="mt-4 flex justify-end">
              <Button type="button" variant="secondary" onClick={onClose}>
                Kapat
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
