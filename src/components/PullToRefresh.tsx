import { PULL_TRIGGER, usePullToRefresh } from '@/hooks/usePullToRefresh';

/**
 * Visual half of pull-to-refresh: a classic circular refresh arrow that drops
 * in from the top edge and follows the finger. It spins a half-turn once you've
 * pulled far enough ("bırak → yenile"). The actual reload is fired by the hook
 * on release. Renders nothing when idle, so it has zero cost on the
 * (mouse-driven) desktop path.
 */
export function PullToRefresh() {
  const distance = usePullToRefresh();
  if (distance <= 0) return null;

  const ready = distance >= PULL_TRIGGER;
  const progress = Math.min(1, distance / PULL_TRIGGER);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center"
      style={{ transform: `translateY(${distance}px)`, opacity: progress }}
      aria-hidden="true"
    >
      <div className="-mt-7 flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white shadow-md dark:border-stone-600 dark:bg-stone-800">
        <svg
          className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
          viewBox="0 0 24 24"
          fill="none"
          style={{
            transform: `rotate(${ready ? 180 : 0}deg)`,
            transition: 'transform 0.15s ease',
          }}
        >
          <polyline
            points="23 4 23 10 17 10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
