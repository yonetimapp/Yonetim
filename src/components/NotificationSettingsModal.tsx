import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { XMarkIcon } from '@/components/icons/ActionIcons';
import { NotificationPreferencesList } from '@/components/NotificationPreferencesList';

interface Props {
  onClose: () => void;
}

/**
 * Bell-icon modal wrapper around the shared per-event notification toggle list
 * (NotificationPreferencesList). The same list also renders as a card under
 * Profil › Bildirim Ayarları.
 */
export function NotificationSettingsModal({ onClose }: Props) {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

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

        <NotificationPreferencesList />

        <div className="mt-4 flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Kapat
          </Button>
        </div>
      </Card>
    </div>
  );
}
