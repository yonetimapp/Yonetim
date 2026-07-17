/// <reference lib="webworker" />
/*
 * HomeGuru PMS — Service Worker.
 *
 * Single SW file owned by us (vite-plugin-pwa's injectManifest strategy).
 * Combines:
 *   - Workbox precaching of build assets (replaces the old generateSW path)
 *   - Runtime caching for Supabase REST + Storage
 *   - SKIP_WAITING message handler so PwaUpdatePrompt can promote a new SW
 *   - Web Push + notificationclick handlers for the Phase 1 push system
 *
 * Why a hand-written SW instead of generateSW + importScripts: workbox's
 * generated SW wraps everything in an async define() callback, which means
 * importScripts() runs *after* the SW's synchronous parse — that violates
 * the spec assumption and surfaced as "Failed to execute 'importScripts'"
 * errors on install. Owning the file end to end avoids that whole class of
 * problem and keeps the push-event listener registered at the top level.
 */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

// vite-plugin-pwa replaces __WB_MANIFEST at build time with the precache list.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Runtime caching for Supabase — mirrors the old workbox.runtimeCaching config.
registerRoute(
  ({ url }) =>
    url.host.endsWith('supabase.co') && url.pathname.startsWith('/rest/'),
  new NetworkFirst({ cacheName: 'supabase-api', networkTimeoutSeconds: 5 }),
);
registerRoute(
  ({ url }) =>
    url.host.endsWith('supabase.co') && url.pathname.startsWith('/storage/'),
  new StaleWhileRevalidate({ cacheName: 'supabase-storage' }),
);

// SKIP_WAITING from the page — used by PwaUpdatePrompt to swap in a new SW
// once the operator taps "Yenile" on the update banner.
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// =============================================================================
// Web Push handlers (migration 050 + Phase 2 Edge Function).
// =============================================================================
// Payload shape from the Edge Function:
//   { title, body, url, tag?, icon? }
// Defensive parsing — a malformed payload still surfaces *something* so the
// operator knows the app pinged them.

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  icon?: string;
}

self.addEventListener('push', (event) => {
  let payload: PushPayload = {};
  if (event.data) {
    try {
      payload = event.data.json() as PushPayload;
    } catch {
      payload = { title: 'Yönetim', body: event.data.text() };
    }
  }

  const title = payload.title || 'Yönetim';
  const options: NotificationOptions = {
    body: payload.body || '',
    icon: payload.icon || 'icons/icon-512.png',
    badge: 'icons/icon-512.png',
    data: { url: payload.url || '/' },
    tag: payload.tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const targetUrl = data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Focus an existing HomeGuru tab and tell it where to go — much cheaper
      // than opening a duplicate window.
      for (const client of allClients) {
        if ('focus' in client) {
          await client.focus();
          try {
            client.postMessage({ type: 'PUSH_NAVIGATE', url: targetUrl });
          } catch {
            /* postMessage failures shouldn't block focusing */
          }
          return;
        }
      }
      // No tab open — open one at the deep link.
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
