import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-safe class composer. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTRY(amount: number): string {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
  }).format(amount);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium',
  }).format(d);
}

/** Short Turkish date + time, e.g. "18.05.2026 11:25". */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}

// Turkey is UTC+3 year-round. "Today" must be the Europe/Istanbul calendar
// date — deriving it from UTC or browser-local time drifts by a day between
// 00:00 and 03:00 Istanbul. This is the single source of truth for "today".
const istanbulDayFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar date in Europe/Istanbul as 'YYYY-MM-DD'. */
export function istanbulToday(): string {
  // formatToParts gives locale-stable named parts regardless of join order.
  const parts = istanbulDayFmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Yönetici',
  PROPERTY_MANAGER: 'Alt Yönetici',
  RECEPTION: 'Resepsiyon',
  HOUSEKEEPING: 'Temizlik',
  YETKILI: 'Personel',
  TEKNIK_PERSONEL: 'Teknik Personel',
  PENDING: 'Onay Bekliyor',
};

/** Friendly label for a staff role. Falls back to the raw value for unknown roles. */
export function formatRole(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

const SCOPE_LABELS: Record<string, string> = {
  ALL: 'Tüm Mülkler',
  HOTELS: 'Binalar',
  APARTMENTS: 'Daireler',
};

/** Friendly label for a staff access scope (migration 033). */
export function formatScope(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

const ROOM_TYPE_LABELS: Record<string, string> = {
  SINGLE: 'Tek Kişilik',
  DOUBLE: 'Çift Kişilik',
  TRIPLE: 'Üç Kişilik',
  QUAD: 'Dört Kişilik',
};

/** Friendly label for a room type. Falls back to raw value for unknown types. */
export function formatRoomType(roomType: string): string {
  return ROOM_TYPE_LABELS[roomType] ?? roomType;
}

/**
 * Normalize a Turkish-or-international phone number into the digits-only
 * country-code-prefixed form wa.me expects (e.g. "905551234567").
 * Returns null when the input is missing or clearly invalid.
 */
export function toWhatsAppPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('90')) {
    // "90" country code, possibly followed by a stray trunk "0" — operators
    // sometimes type "+90 05xx" instead of "+90 5xx". Collapse "90" + "0…" to
    // "90" + "5…" so the call/WhatsApp number is valid.
    digits = '90' + digits.slice(2).replace(/^0+/, '');
  } else if (digits.startsWith('0')) {
    // Turkish local format "0555…" → drop the leading 0.
    digits = digits.slice(1);
  }
  // 10-digit national number with no country code → assume Turkey (+90).
  if (digits.length === 10 && !digits.startsWith('90')) {
    digits = '90' + digits;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/**
 * Build a `tel:` href from a stored phone number, normalized to E.164
 * (e.g. "tel:+905551234567"). Reuses toWhatsAppPhone so a number saved as
 * "+90 05xx" still dials correctly. Falls back to the raw digits (+ any leading
 * +) when the number isn't a recognizable TR/international one.
 */
export function toTelHref(phone: string | null | undefined): string {
  const normalized = toWhatsAppPhone(phone);
  if (normalized) return `tel:+${normalized}`;
  return `tel:${(phone ?? '').replace(/[^\d+]/g, '')}`;
}

/**
 * Live-mask a phone field as the user types. Strips characters that aren't
 * digits / + / space / parens / dash, then auto-prepends "+90 " when the
 * input has digits but no leading country code (covers fresh typing AND
 * pasting a Turkish-local "0555…" or "555…"). The user can still type "+1…"
 * etc. for foreign numbers — those start with `+` and are left alone.
 */
export function maskPhoneInput(raw: string): string {
  const cleaned = raw.replace(/[^\d+ ()-]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) {
    // Collapse a stray trunk "0" typed right after the +90 country code
    // (operators type "+90 05xx" instead of "+90 5xx"). ONLY the +90-then-0
    // position is touched: foreign numbers (+1…) don't match, and a 0 anywhere
    // else in the number (e.g. "+90 50…") is left alone — a TR mobile never
    // starts with 0 after the country code, so this can't corrupt a real number.
    return cleaned.replace(/^\+90\s*0+/, '+90 ');
  }
  // Local-format Turkish numbers (with or without leading 0) → add +90.
  return '+90 ' + cleaned.replace(/^0+/, '');
}

/**
 * Trim a phone string for DB save. Treat a leftover "+90" / "+90 " prefix
 * with no actual number as empty so we don't store dangling country codes.
 */
export function phoneForSave(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (/^\+?9?0?$/.test(t.replace(/\s/g, ''))) return null;
  return t;
}

/**
 * Standard overnight-stay checkout hour, Istanbul-local. Reservations carry
 * a `late_checkout_hours` offset (0–4) that the operator bumps when a guest
 * asks to stay a little longer; the displayed time is base + offset.
 */
export const DEFAULT_CHECKOUT_HOUR = 11;

/**
 * Render the checkout-time label for an overnight reservation, e.g. "11:00"
 * for the standard hour or "13:00" when late_checkout_hours = 2.
 */
export function checkoutTimeLabel(lateCheckoutHours: number | null | undefined): string {
  const hour = DEFAULT_CHECKOUT_HOUR + (lateCheckoutHours ?? 0);
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * Translate raw payment_method codes (CASH / TRANSFER / CARD) embedded in
 * RPC-generated description / note strings into Turkish for display. Word
 * boundaries keep us from mangling unrelated text. Used by the kasa list,
 * the cari ledger rows, and anywhere else the operator sees these strings.
 */
export function tPaymentMethods(raw: string | null | undefined): string {
  if (!raw) return '—';
  return raw
    .replace(/\bCASH\b/g, 'Nakit')
    .replace(/\bTRANSFER\b/g, 'Havale/EFT')
    .replace(/\bCARD\b/g, 'Kart');
}

/** Build a wa.me URL with the message URL-encoded. */
export function whatsAppUrl(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/**
 * Build a wa.me URL with NO recipient — opens WhatsApp and lets the user
 * pick which chat to send to. Used when the guest has no saved phone or
 * the message is going to someone not in the guest record.
 */
export function whatsAppShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
