import { supabase } from '@/lib/supabase';
import type { Role } from '@/types/database';

/**
 * The set of event keys the ring-icon settings modal toggles. Must stay in
 * sync with the CHECK constraint on notification_preferences.event_type
 * (migration 052) and the literals the DB triggers pass to _send_push_async
 * (migration 053).
 */
export type NotificationEventType =
  | 'new_issue'
  | 'payment_unconfirmed'
  | 'pending_approval'
  | 'new_reservation'
  | 'reservation_auto_completed'
  | 'salary_auto_paid'
  | 'upcoming_reservation_2d';

export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'new_issue',
  'payment_unconfirmed',
  'pending_approval',
  'new_reservation',
  'upcoming_reservation_2d',
  'reservation_auto_completed',
  'salary_auto_paid',
] as const;

/** Human-readable Turkish labels shown in the settings modal. */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  new_issue: 'Yeni sorun bildirimi',
  payment_unconfirmed: 'Onay bekleyen tahsilat',
  pending_approval: 'Onay bekleyen gider / kasa hareketi',
  new_reservation: 'Yeni rezervasyon',
  upcoming_reservation_2d: 'Yaklaşan rezervasyon (2 gün önce)',
  reservation_auto_completed: 'Rezervasyon otomatik tamamlandı',
  salary_auto_paid: 'Otomatik maaş ödemesi',
};

/** Short helper line under each toggle. Optional cosmetic detail. */
export const NOTIFICATION_EVENT_HINTS: Record<NotificationEventType, string> = {
  new_issue: 'Bir personel yeni sorun bildirdiğinde.',
  payment_unconfirmed: 'Onay bekleyen yeni bir tahsilat girildiğinde.',
  pending_approval: 'Yetkili olmayan bir personel gider veya kasa hareketi gönderdiğinde.',
  new_reservation: 'Sisteme yeni bir rezervasyon eklendiğinde.',
  upcoming_reservation_2d: 'Bir rezervasyonun girişine 2 gün kala.',
  reservation_auto_completed: 'Sistem bir rezervasyonu otomatik tamamladığında.',
  salary_auto_paid: 'Sistem otomatik maaş ödemesi yaptığında.',
};

/**
 * Which staff roles actually RECEIVE each event's push, by RAW role — mirrors the
 * trigger recipient lists (migrations 070 / 072 / 114 / 115). The settings modal
 * uses this to show a role only the toggles it can act on. KEEP IN SYNC WITH THE DB.
 */
export const EVENT_RECIPIENT_ROLES: Record<NotificationEventType, Role[]> = {
  new_issue: ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'TEKNIK_PERSONEL'],
  payment_unconfirmed: ['SUPER_ADMIN', 'PROPERTY_MANAGER'],
  pending_approval: ['SUPER_ADMIN'],
  new_reservation: ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING', 'YETKILI'],
  reservation_auto_completed: ['SUPER_ADMIN', 'PROPERTY_MANAGER'],
  salary_auto_paid: ['SUPER_ADMIN'],
  upcoming_reservation_2d: ['SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING', 'YETKILI'],
};

/** Event types the given (raw) role can actually receive — drives the role-aware
 *  settings modal so no one sees a toggle for a push they'll never get. */
export function eventsForRole(role: Role | undefined): NotificationEventType[] {
  if (!role) return [];
  return NOTIFICATION_EVENT_TYPES.filter((k) => EVENT_RECIPIENT_ROLES[k].includes(role));
}

/**
 * Load this user's per-event preferences. Returns a fully-populated map: any
 * event type without an explicit row defaults to enabled=true (matches the
 * Edge Function's filter logic in send-push).
 */
export async function listNotificationPreferences(): Promise<
  Record<NotificationEventType, boolean>
> {
  const defaults: Record<NotificationEventType, boolean> = {
    new_issue: true,
    payment_unconfirmed: true,
    pending_approval: true,
    new_reservation: true,
    upcoming_reservation_2d: true,
    reservation_auto_completed: true,
    salary_auto_paid: true,
  };
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('event_type, enabled');
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    if (row.event_type in defaults) {
      defaults[row.event_type as NotificationEventType] = row.enabled;
    }
  }
  return defaults;
}

/**
 * Upsert this user's preference for a single event. The composite PK
 * (user_id, event_type) is what onConflict drives; user_id is derived from
 * the authenticated session so the RLS WITH CHECK on insert/update passes.
 */
export async function setNotificationPreference(
  event_type: NotificationEventType,
  enabled: boolean,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Oturum bulunamadı.');
  const { error } = await supabase
    .from('notification_preferences')
    .upsert(
      { user_id: user.id, event_type, enabled, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,event_type' },
    );
  if (error) throw new Error(error.message);
}
