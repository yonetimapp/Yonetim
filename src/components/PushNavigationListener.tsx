import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Completes the notification-tap deep link: the service worker's
 * `notificationclick` handler focuses an existing tab and posts
 * `{ type: 'PUSH_NAVIGATE', url }` — this listener is the receiving end,
 * routing the focused tab to the push's target (e.g. /finance/pending).
 *
 * Rendered once inside BrowserRouter, so navigate() resolves against the
 * GitHub Pages basename rather than the domain root.
 */
export function PushNavigationListener() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; url?: string } | undefined;
      if (msg?.type === 'PUSH_NAVIGATE' && typeof msg.url === 'string') {
        navigate(msg.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  return null;
}
