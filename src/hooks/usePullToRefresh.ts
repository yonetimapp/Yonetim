import { useEffect, useRef, useState } from 'react';

/** Pull distance (px) at which releasing fires a refresh. */
export const PULL_TRIGGER = 70;
/** Hard cap on the rubber-band travel so the indicator can't fly off-screen. */
const PULL_MAX = 110;
/** <1 so the finger out-travels the indicator — the usual elastic feel. */
const RESISTANCE = 0.5;

/**
 * Pull-to-refresh for the whole app. Returns the current pull distance (0 when
 * idle) so a fixed indicator can follow the finger; releasing past PULL_TRIGGER
 * reloads the page (`window.location.reload`) which re-runs every page's
 * on-mount data fetch — the simplest reliable "refresh".
 *
 * Guards:
 *   - Only starts when the document is scrolled to the very top.
 *   - Skips while any full-screen overlay (modal / mobile drawer — they use
 *     Tailwind `fixed inset-0`) is open, so pulling inside a sheet can't
 *     accidentally reload the page behind it.
 */
export function usePullToRefresh(): number {
  const [distance, setDistance] = useState(0);
  const distanceRef = useRef(0);
  const startY = useRef<number | null>(null);
  const tracking = useRef(false);

  useEffect(() => {
    const setD = (d: number) => {
      distanceRef.current = d;
      setDistance(d);
    };

    // The app scrolls inside <body>, not the window: index.css pins
    // html/body/#root to height:100% and sets overflow-x:hidden, which makes
    // overflow-y compute to `auto` on body. So window.scrollY stays 0 and the
    // real offset lives on body.scrollTop. Read all three roots so the
    // "are we at the very top?" check is correct whatever owns the scroll —
    // without this, window.scrollY===0 made the guard below never fire and
    // every downward swipe got hijacked into a pull-to-refresh.
    const scrollTop = () =>
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;

    // True when the touch begins inside an element that scrolls vertically on
    // its own (the FullCalendar timeline, a long modal body, a table wrapper).
    // Those own the gesture — pull-to-refresh must stay out of their way.
    const startsInScrollable = (target: EventTarget | null): boolean => {
      let el = target instanceof Element ? target : null;
      while (el && el !== document.body && el !== document.documentElement) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    };

    const onStart = (e: TouchEvent) => {
      tracking.current = false;
      startY.current = null;
      if (e.touches.length !== 1) return;
      if (scrollTop() > 0) return;
      // A modal / drawer is open — let it own the gesture.
      if (document.querySelector('.fixed.inset-0')) return;
      if (startsInScrollable(e.target)) return;
      startY.current = e.touches[0].clientY;
      tracking.current = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking.current || startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) {
        if (distanceRef.current !== 0) setD(0);
        return;
      }
      // We're pulling down from the top — claim the gesture from the browser.
      if (e.cancelable) e.preventDefault();
      setD(Math.min(PULL_MAX, dy * RESISTANCE));
    };

    const onEnd = () => {
      const shouldRefresh = tracking.current && distanceRef.current >= PULL_TRIGGER;
      tracking.current = false;
      startY.current = null;
      if (shouldRefresh) {
        window.location.reload();
        return; // page is reloading — leave the indicator visible until it does
      }
      if (distanceRef.current !== 0) setD(0);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  return distance;
}
