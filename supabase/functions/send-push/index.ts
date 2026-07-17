// HomeGuru PMS — send-push Edge Function.
//
// POST /functions/v1/send-push
// Auth: requires the project's service_role key in the Authorization header
//       (DB triggers via pg_net + the app's own admin code can call this).
//
// Body shape:
//   {
//     "user_ids"?:   string[],          // explicit recipient list
//     "roles"?:      string[],          // OR resolve recipients by staff role
//     "title":       string,            // required
//     "body"?:       string,
//     "url"?:        string,
//     "kind":        'issue' | 'payment' | 'reservation' | 'system',
//     "event_type"?: string,            // fine-grained key for opt-in filter
//                                        // (matches notification_preferences)
//     "data"?:       Record<string, unknown>
//   }
//
// What it does:
//   1. Resolve recipients from user_ids + roles (deduped).
//   2. Filter out recipients who opted out of this event_type (migration 052).
//   3. Insert an audit row into `notifications` per recipient.
//   4. Look up active push_subscriptions for those users.
//   5. Send Web Push to each in parallel via VAPID.
//   6. Delete subscriptions the push service rejects with 404/410 (gone).

import { createClient } from 'npm:@supabase/supabase-js@2';
import webPush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
// Shared secret required on every request (x-push-secret header). The DB side
// sends it from the vault (`push_shared_secret`, migration 132). Set with:
//   supabase secrets set PUSH_SHARED_SECRET='<same value as the vault secret>'
const PUSH_SHARED_SECRET = Deno.env.get('PUSH_SHARED_SECRET') ?? '';

/** Constant-time string comparison so the secret can't be guessed byte-by-byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

interface SendPushBody {
  user_ids?: string[];
  roles?: string[];
  /**
   * Optional region gate for role-resolved recipients. When set, a user matched
   * by `roles` is kept only if they are SUPER_ADMIN, see all regions, or their
   * home region equals this value. Explicit `user_ids` are never region-filtered.
   */
  region?: string;
  title: string;
  body?: string;
  url?: string;
  kind: 'issue' | 'payment' | 'reservation' | 'system';
  /** Fine-grained event key — matches notification_preferences.event_type. */
  event_type?: string;
  data?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  // Auth gate — two layers:
  //  1. A Bearer-prefixed Authorization header for the gateway (any project
  //     JWT passes it, so it is NOT the security boundary on its own — the
  //     public anon key also mints valid JWTs).
  //  2. The x-push-secret shared secret (migration 132), which only the DB
  //     vault and this function's secrets hold. This is the real gate and is
  //     key-format-agnostic (avoids the legacy-JWT vs sb_secret_ trap that a
  //     strict service-key equality check fell into). Fails closed when the
  //     PUSH_SHARED_SECRET env is not configured.
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!PUSH_SHARED_SECRET) {
    console.error('[send-push] PUSH_SHARED_SECRET is not set — refusing all requests');
    return new Response('Push secret not configured', { status: 503 });
  }
  const pushSecret = req.headers.get('x-push-secret') ?? '';
  if (!timingSafeEqual(pushSecret, PUSH_SHARED_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: SendPushBody;
  try {
    payload = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (!payload.title || !payload.kind) {
    return new Response('Missing title/kind', { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Resolve recipients. Explicit user_ids are taken as-is; role-resolved users
  // are region-gated when payload.region is set (a region-scoped staffer only
  // gets their own region's push; SUPER_ADMIN + all_regions always pass).
  const recipientSet = new Set<string>(payload.user_ids ?? []);
  if (payload.roles && payload.roles.length > 0) {
    const { data: rows } = await supabase
      .from('staff_profiles')
      .select('user_id, role, all_regions, region')
      .in('role', payload.roles)
      .is('deleted_at', null);
    for (const r of rows ?? []) {
      if (
        !payload.region ||
        r.role === 'SUPER_ADMIN' ||
        r.all_regions === true ||
        r.region === payload.region
      ) {
        recipientSet.add(r.user_id);
      }
    }
  }
  let recipients = [...recipientSet];

  if (recipients.length === 0) {
    return Response.json({ sent: 0, reason: 'no recipients' });
  }

  // Apply per-user opt-outs from notification_preferences. Missing rows mean
  // "enabled" (default ON), so we only need to subtract users with an explicit
  // disabled=true row for this event_type.
  if (payload.event_type) {
    const { data: prefs } = await supabase
      .from('notification_preferences')
      .select('user_id, enabled')
      .eq('event_type', payload.event_type)
      .in('user_id', recipients);
    const disabled = new Set(
      (prefs ?? []).filter((p) => p.enabled === false).map((p) => p.user_id),
    );
    if (disabled.size > 0) {
      recipients = recipients.filter((uid) => !disabled.has(uid));
    }
  }

  if (recipients.length === 0) {
    return Response.json({ sent: 0, reason: 'all opted out' });
  }

  // Audit log (one row per recipient).
  await supabase.from('notifications').insert(
    recipients.map((uid) => ({
      user_id: uid,
      title: payload.title,
      body: payload.body ?? null,
      url: payload.url ?? null,
      kind: payload.kind,
      event_type: payload.event_type ?? null,
      data: payload.data ?? null,
    })),
  );

  // Active subscriptions for those users.
  const { data: subs, error: subsErr } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_id')
    .in('user_id', recipients);

  if (subsErr) {
    return new Response(`subs lookup failed: ${subsErr.message}`, { status: 500 });
  }
  if (!subs || subs.length === 0) {
    return Response.json({ sent: 0, reason: 'no subscriptions' });
  }

  // Build the push payload. `tag` collapses repeat notifications of the same
  // kind+entity so a flurry of triggers doesn't stack 10 banners.
  const tag =
    payload.data && typeof payload.data === 'object' && 'id' in payload.data
      ? `${payload.kind}:${String((payload.data as Record<string, unknown>).id)}`
      : payload.kind;
  const pushPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag,
  });

  const expiredSubIds: string[] = [];
  let successCount = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          pushPayload,
        );
        successCount++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Subscription is gone (user uninstalled / browser purged).
          expiredSubIds.push(sub.id);
        }
        console.warn('[send-push] failed', sub.endpoint, status, err);
      }
    }),
  );

  if (expiredSubIds.length > 0) {
    await supabase.from('push_subscriptions').delete().in('id', expiredSubIds);
  }

  return Response.json({
    sent: successCount,
    total: subs.length,
    expired: expiredSubIds.length,
  });
});
