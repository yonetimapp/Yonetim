import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from '@/components/ui/Button';

/**
 * Bottom banner shown when a new deployed version has been picked up by the
 * service worker. Pairs with `registerType: 'prompt'` in vite.config.ts.
 *
 * "Yenile" activates the waiting SW and reloads the page onto the new build.
 * "Sonra" dismisses the banner for this session — the update still applies on
 * the next natural full reload.
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))', paddingTop: '0.75rem' }}
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-lg border border-stone-300 bg-white px-4 py-3 shadow-lg dark:border-stone-600 dark:bg-stone-800">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
            Yeni sürüm hazır
          </p>
          <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">
            Güncellemeyi uygulamak için yenileyin.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setNeedRefresh(false)}
          className="rounded-md px-2 py-1.5 text-sm text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-700"
        >
          Sonra
        </button>
        <Button size="sm" onClick={() => updateServiceWorker(true)}>
          Yenile
        </Button>
      </div>
    </div>
  );
}
