import { supabase } from '@/lib/supabase';

/**
 * Web Push subscription helpers — Phase 1 of the notification system.
 *
 * Lifecycle:
 *   1. The user toggles "Bildirimleri Etkinleştir" in their profile.
 *   2. We ask the browser for Notification permission.
 *   3. We register the current service worker against the project's VAPID
 *      public key, which produces a PushSubscription.
 *   4. We store endpoint + keys in push_subscriptions (RLS scopes each row
 *      to the inserting user).
 *
 * Sending pushes is Phase 2 — an Edge Function uses the stored subscriptions
 * plus the private VAPID half to fan messages out via Web Push.
 */

/** Returns true when the browser has both Service Workers and the Push API. */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Current OS-level permission for notifications, or 'default' if undecided. */
export function getNotificationPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

/**
 * Returns the active PushSubscription for the current browser, if any. Used
 * by the settings UI to render the toggle in the correct state on load.
 * Returns null when push isn't supported, no SW is registered, or the user
 * has never subscribed on this browser.
 *
 * IMPORTANT: uses getRegistration() (which resolves immediately with
 * undefined if no SW is registered) instead of `serviceWorker.ready` (which
 * never resolves in that case and would lock the UI in "checking" state).
 * `ready` is only safe in subscribeToPush where we want to wait for the SW.
 */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Subscribe this browser to push and persist the resulting endpoint + keys
 * to push_subscriptions. Idempotent — calling it when already subscribed
 * just refreshes the DB row's last_seen_at (via upsert-by-endpoint).
 *
 * Throws with a user-friendly Turkish message on every failure mode so the
 * settings UI can surface it directly.
 */
export async function subscribeToPush(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error('Bu tarayıcı bildirimleri desteklemiyor.');
  }
  const vapidPublic = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!vapidPublic) {
    throw new Error(
      'Push servisi yapılandırılmamış. Yöneticiyle iletişime geçin.',
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Bildirim izni reddedilmiş. Tarayıcı ayarlarından açabilirsiniz.'
        : 'Bildirim izni verilmedi.',
    );
  }

  // Verify a SW is actually registered before awaiting `ready` — `ready` never
  // resolves when none exists, which would hang the Etkinleştir button.
  const existingReg = await navigator.serviceWorker.getRegistration();
  if (!existingReg) {
    throw new Error(
      'Service worker bulunamadı. Üretim sürümünü kullanın veya tarayıcıyı yenileyin.',
    );
  }
  const reg = await navigator.serviceWorker.ready;

  // Re-use an existing subscription if one's already on this browser — saves
  // a round-trip to the push service and keeps the DB row stable.
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    // pushManager.subscribe() can hang forever if the browser can't reach the
    // push service (network restriction, browser anti-tracking, VPN, etc.).
    // Race against a 30s timeout so the UI surfaces a clear error instead of
    // an infinite spinner.
    const subscribePromise = reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublic),
    });
    subscription = await Promise.race([
      subscribePromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'Push servisine ulaşılamadı (30 sn zaman aşımı). Tarayıcı, ağ veya VPN engelliyor olabilir.',
              ),
            ),
          30000,
        ),
      ),
    ]);
  }

  const json = subscription.toJSON();
  const endpoint = subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Abonelik anahtarları alınamadı.');
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('Oturum bulunamadı.');
  }

  // Upsert by endpoint: if this browser already had a row, refresh it; if
  // not, insert. ON CONFLICT on the UNIQUE(endpoint) index handles both.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: user.id,
        endpoint,
        p256dh,
        auth,
        user_agent: navigator.userAgent.slice(0, 500),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );
  if (error) {
    throw new Error(
      `Abonelik kaydedilemedi: ${error.message}${error.code ? ` (${error.code})` : ''}`,
    );
  }
}

/**
 * Unsubscribe this browser from push: tears down the browser-side
 * PushSubscription AND deletes the matching row from push_subscriptions so
 * future fan-outs skip this device.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  // Best-effort: tear down the browser-side subscription first. If that
  // fails we still try to delete the DB row to keep state consistent.
  try {
    await subscription.unsubscribe();
  } catch {
    /* swallow — DB cleanup below still runs */
  }
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint);
  if (error) {
    throw new Error(
      `Abonelik silinemedi: ${error.message}${error.code ? ` (${error.code})` : ''}`,
    );
  }
}

/**
 * Base64URL → BufferSource — the format applicationServerKey expects. The
 * VAPID public key from `npx web-push generate-vapid-keys` is base64url
 * (`+/=` swapped to `-_`, no padding); this converts it back to bytes.
 *
 * Returns BufferSource (not bare Uint8Array) because TS 5.7+ tightened
 * `applicationServerKey` to require an ArrayBuffer-backed view — the default
 * `Uint8Array` generic resolves to ArrayBufferLike which includes
 * SharedArrayBuffer and gets rejected. Constructing from an explicit
 * ArrayBuffer and narrowing the return type keeps the call site clean.
 */
function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
