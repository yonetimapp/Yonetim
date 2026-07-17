# HomeGuru PMS — Architecture

> *"Forget the hotel, be our guest."*

Property Management System for HomeGuru — a multi-property short-term rental operation covering hotels (with rooms) and standalone apartments. This document is the canonical technical reference: stack, data model, security, compliance, deployment, and delivery plan.

---

## 1. Business context

HomeGuru rents serviced accommodations under two operational models:

| Property type | How it operates | Who handles money |
|---|---|---|
| **HOTEL** | Multiple rooms in one building, front-desk model | Reception staff |
| **APARTMENT** | Standalone unit, no front desk | Housekeeper does cleaning **AND** collects payment on delivery |

The system must support **any number** of properties of either type. The owner can add new properties at will, each with a name.

**Compliance:**
- **KBS** (Identity Notification System) — legal obligation, must export guest IDs to Emniyet.
- **KVKK** (Turkish GDPR) — applies to all guest personal data.

---

## 2. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| **Frontend** | Vite + React 18 + TypeScript | Static-buildable SPA — required because GitHub Pages can't run a server |
| **UI** | Tailwind CSS + shadcn/ui | Fast iteration, accessible primitives, no design lock-in |
| **Calendar** | FullCalendar — `resource-timeline` plugin | Gantt-style scheduler battle-tested for booking systems |
| **PWA** | `vite-plugin-pwa` (Workbox under the hood) | One codebase installable on iOS and Android browsers |
| **Backend** | Supabase (managed) | Postgres + Auth + Storage + Edge Functions + Realtime in one service |
| **Database** | PostgreSQL 15 (via Supabase) | `tstzrange` + exclusion constraint for double-booking; RLS for isolation |
| **Auth** | Supabase Auth (email + password) | Staff-only; signups disabled; admins create users manually |
| **Background jobs** | `pg_cron` (in Postgres) for scheduled SQL; Edge Functions for HTTP-dependent jobs | Nightly auto-debit, KBS submissions, photo cleanup |
| **File storage** | Supabase Storage (S3-compatible) | Housekeeping issue photos, ID document scans |
| **Realtime** | Supabase Realtime | Calendar live updates across staff devices |
| **WhatsApp (MVP)** | `wa.me` deep links | Free, no API, no Meta approval needed |
| **WhatsApp (post-MVP)** | Twilio WhatsApp Business API | Adds outbound automation + inbound routing; costs $0.005–$0.10 per message |
| **Excel export** | `xlsx` library, client-side | Internal scale doesn't need server-side generation |
| **Frontend hosting** | GitHub Pages (free) | Source already on GitHub; static SPA fits perfectly |
| **CI/CD** | GitHub Actions | Build, deploy, keepalive cron — all in the same repo |

### Stack choice summary

One language (TypeScript), one framework (React/Vite), one backend service (Supabase). Minimal moving parts. No servers to maintain. The whole stack runs **free** for the first 2 months (with the mitigations below); ~$25/mo for Supabase Pro thereafter.

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│           Browsers / iOS Safari PWA / Android Chrome PWA      │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────────┐│
│  │ Super Admin│ │ Property Mgr│ │ Reception│ │ Housekeeping ││
│  └─────┬──────┘ └──────┬─────┘ └─────┬────┘ └──────┬───────┘│
└────────┼───────────────┼──────────────┼─────────────┼───────┘
         └───────────────┴──────────────┴─────────────┘
                                │
                       HTTPS (CDN — GitHub Pages)
                                │
                  ┌─────────────▼─────────────┐
                  │ Static SPA bundle         │
                  │  (Vite + React + PWA SW)  │
                  │  Includes Supabase client │
                  └─────────────┬─────────────┘
                                │
                       HTTPS to api.supabase.co
                                │
       ┌────────────────────────┼────────────────────────┐
       │                        │                        │
 ┌─────▼──────┐         ┌───────▼───────┐       ┌────────▼────────┐
 │ Supabase   │         │ Supabase Edge │       │ Supabase Storage│
 │ Postgres   │         │ Functions     │       │ (photos, IDs)   │
 │  + RLS     │         │ (KBS, jobs)   │       │                 │
 │  + pgcrypto│         │               │       │                 │
 │  + pg_cron │         │               │       │                 │
 │  + Realtime│         │               │       │                 │
 └────────────┘         └───────────────┘       └─────────────────┘
                                │
                                ▼
                   ┌─────────────────────────┐
                   │ External: KBS endpoint  │
                   │ (Emniyet identity API)  │
                   └─────────────────────────┘
```

---

## 4. Multi-property model

The system supports **unlimited** properties. Each is either a **HOTEL** or an **APARTMENT**.

```
properties
  ├─ Hotel "Alsancak Otel"
  │   └─ units: Room 101, Room 102, Suite 301, ...
  ├─ Hotel "Konak Otel"
  │   └─ units: Room 201, Room 202, ...
  ├─ Apartment "Karşıyaka 1+1 Daire 3"
  │   └─ unit: (itself — exactly 1)
  └─ Apartment "Bostanlı 2+1 Stüdyo"
      └─ unit: (itself — exactly 1)
```

### Tables

**`properties`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | "Alsancak Otel", "Karşıyaka 1+1 Daire 3" |
| `type` | enum | `HOTEL` \| `APARTMENT` |
| `address` | text | |
| `manager_user_id` | uuid FK → `auth.users` | nullable — property's assigned manager |
| `created_at` | timestamptz | |

**`units`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `property_id` | uuid FK → `properties` | |
| `name` | text | "Room 101", "Daire 3" |
| `room_type` | enum | `1+0` \| `1+1` \| `2+1` \| `ROOM` \| `SUITE` |
| `capacity` | int | |
| `base_price` | numeric(10,2) | nightly rate, TRY |
| `created_at` | timestamptz | |

**Constraint:** For `APARTMENT` properties, the application enforces `count(units) = 1` (no multi-unit apartments). For `HOTEL`, multiple units are expected.

### Isolation model (replaces "branch isolation")

- Reservations, ledger, cash accounts, expenses, etc. all have `property_id`.
- Users belong to a property (or are Super Admin = all properties).
- Postgres **Row-Level Security (RLS)** policies enforce that non-Super-Admin users only see rows where `property_id = (the user's property)`.

```sql
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY reservations_property_scope ON reservations
  USING (
    auth.uid() IN (
      SELECT user_id FROM property_members WHERE property_id = reservations.property_id
    )
    OR
    (SELECT role FROM staff_profiles WHERE user_id = auth.uid()) = 'SUPER_ADMIN'
  );
```

---

## 5. RBAC

Four staff roles. **Guests are not users** — they have no login and never access the app.

| Role | Scope | Permissions |
|---|---|---|
| **SUPER_ADMIN** | All properties | All actions, all reports, settings, user management, total revenue |
| **PROPERTY_MANAGER** | One property | All actions within property; payroll, expenses, reports for own property |
| **RECEPTION** | One property | Reservations + guest records; **cannot see** financial reports, payroll, or other properties |
| **HOUSEKEEPING** | One property | Read/update unit cleaning status, log issues with photos. **Also collects payment** when `property.type = APARTMENT`. |

### Property-type-conditional permissions

```ts
function canCollectPayment(user: User, property: Property): boolean {
  if (user.role === 'SUPER_ADMIN' || user.role === 'PROPERTY_MANAGER') return true;
  if (user.role === 'RECEPTION' && property.type === 'HOTEL') return true;
  if (user.role === 'HOUSEKEEPING' && property.type === 'APARTMENT') return true;
  return false;
}
```

Enforced both client-side (hides UI) **and** server-side (RLS + Edge Function checks).

### Auth setup

- Supabase Auth provider: Email + Password only.
- **Signups disabled** in Supabase dashboard. Admins create staff accounts via Supabase dashboard or an admin-only Edge Function.
- Sessions: persisted in localStorage, auto-refreshed (`persistSession: true, autoRefreshToken: true`).
- Roles stored in `staff_profiles` table linked to `auth.users.id`.

---

## 6. Data model (high-level)

```
auth.users (Supabase)
  └── staff_profiles (role, property_id, salary, advances)

properties
  ├── units
  ├── property_members (user_id, property_id) — for non-Super-Admin
  ├── reservations
  │     ├── ledger_entries (guest debt/credit, append-only)
  │     └── payment_collections (housekeeper-collected, needs reconciliation)
  ├── guests (KVKK-sensitive fields encrypted)
  ├── cash_accounts (cash / bank / card per property)
  ├── expenses (fixed/variable)
  ├── housekeeping_tasks (unit, status, photos)
  ├── kbs_submissions (audit log of police reports)
  └── audit_log (every sensitive read/write)
```

### Key tables in detail

**`guests`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `full_name` | text | |
| `tc_kimlik_encrypted` | bytea | `pgcrypto.pgp_sym_encrypt(tc, key)` |
| `passport_encrypted` | bytea | encrypted if used instead of TC |
| `phone` | text | **plaintext** — not özel nitelikli under KVKK; needed for wa.me |
| `email` | text | plaintext |
| `address` | text | plaintext |
| `nationality` | text | for KBS |
| `consent_given_at` | timestamptz | açık rıza timestamp |
| `consent_version` | text | which version of the aydınlatma metni they consented to |
| `created_at` | timestamptz | |

**`reservations`** — uses `tstzrange` + EXCLUDE constraint so the DB itself prevents double-booking:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id),
  unit_id       uuid NOT NULL REFERENCES units(id),
  guest_id      uuid NOT NULL REFERENCES guests(id),
  stay          tstzrange NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','active','completed','cancelled')),
  total_amount  numeric(10,2) NOT NULL,
  deposit       numeric(10,2) NOT NULL DEFAULT 0,
  auto_debit    boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  EXCLUDE USING gist (
    unit_id WITH =,
    stay WITH &&
  ) WHERE (status != 'cancelled')
);

CREATE INDEX reservations_unit_stay_idx ON reservations USING gist (unit_id, stay);
```

That EXCLUDE constraint is **the single most important safety net** in the system. The database itself refuses to accept two overlapping reservations on the same unit.

**`ledger_entries`** — append-only:

```
id | guest_id | reservation_id | type (DEBT|PAYMENT) | amount | currency | note | created_by | created_at
```

Guest balance = `SUM(payments) − SUM(debts)`. Never store a derived balance column. Append-only → full audit trail.

**`payment_collections`** — for apartment housekeepers collecting cash:

```
id | reservation_id | collected_by_user_id | amount | method (CASH|TRANSFER) | 
   receipt_photo_url | status (UNCONFIRMED|CONFIRMED|DISPUTED) | confirmed_by | confirmed_at | created_at
```

State machine: `UNCONFIRMED → CONFIRMED` (manager reconciles end-of-day) or `UNCONFIRMED → DISPUTED` (variance found).

**`audit_log`** — every access to KVKK-sensitive fields and every financial state change:

```
id | user_id | action | entity_type | entity_id | metadata (jsonb) | created_at
```

---

## 7. Critical algorithms

### 7.1 Availability search (conflict check)

```sql
SELECT u.*, p.name AS property_name, p.type AS property_type
FROM units u
JOIN properties p ON p.id = u.property_id
WHERE ($property_id IS NULL OR u.property_id = $property_id)
  AND ($room_type IS NULL OR u.room_type = $room_type)
  AND NOT EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.unit_id = u.id
      AND r.status != 'cancelled'
      AND r.stay && tstzrange($checkin, $checkout, '[)')
  );
```

Index already created above.

### 7.2 Smart alternatives ("shift by N days")

If zero units match the exact window, try shifts of ±1, ±2, ±3 days at either end. Rank by:
1. Smallest shift
2. Same room type preference
3. Same property preference

Return top 3 suggestions. Implemented client-side after a single batched query.

### 7.3 Auto-debit

> **Updated (migration 077):** auto-debit no longer accrues nightly. The full
> `total_amount` is now posted to the guest's cari **once, when the reservation
> becomes `active`** (at check-in), via the `reservations_auto_debit_trg`
> trigger. The nightly `pg_cron` job below was unscheduled. The original design
> is kept here for history.

Postgres scheduler runs in UTC. Turkey = UTC+3 year-round (no DST since 2016). So `00:00 Istanbul = 21:00 UTC`. Schedule at `21:05 UTC` for clock-drift safety:

```sql
SELECT cron.schedule(
  'nightly-auto-debit',
  '5 21 * * *',
  $$
  INSERT INTO ledger_entries (guest_id, reservation_id, type, amount, note, created_by)
  SELECT
    r.guest_id, r.id, 'DEBT',
    r.total_amount / GREATEST(1, (upper(r.stay)::date - lower(r.stay)::date)),
    'Auto-debit ' || to_char(now() AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD'),
    '00000000-0000-0000-0000-000000000000'::uuid -- system user
  FROM reservations r
  WHERE r.auto_debit = true
    AND r.status = 'active'
    AND (now() AT TIME ZONE 'Europe/Istanbul')::date >= lower(r.stay)::date
    AND (now() AT TIME ZONE 'Europe/Istanbul')::date < upper(r.stay)::date
    AND NOT EXISTS (
      SELECT 1 FROM ledger_entries le
      WHERE le.reservation_id = r.id
        AND (le.created_at AT TIME ZONE 'Europe/Istanbul')::date = (now() AT TIME ZONE 'Europe/Istanbul')::date
        AND le.type = 'DEBT'
        AND le.note LIKE 'Auto-debit%'
    );
  $$
);
```

**Idempotent** — safe to re-run; the `NOT EXISTS` clause prevents duplicate debits.

---

## 8. PWA (iOS + Android)

### Plugin

```ts
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';

VitePWA({
  registerType: 'autoUpdate',
  manifest: {
    name: 'HomeGuru PMS',
    short_name: 'HomeGuru',
    description: 'Property management for HomeGuru',
    theme_color: '#1a73e8',
    background_color: '#ffffff',
    display: 'standalone',
    start_url: '/homeguru-pms/',
    scope: '/homeguru-pms/',
    icons: [
      { src: 'icons/192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    runtimeCaching: [
      {
        urlPattern: ({ url }) => url.host.endsWith('supabase.co') && url.pathname.startsWith('/rest/'),
        handler: 'NetworkFirst',
        options: { cacheName: 'supabase-api', networkTimeoutSeconds: 5 },
      },
      {
        urlPattern: ({ url }) => url.host.endsWith('supabase.co') && url.pathname.startsWith('/storage/'),
        handler: 'StaleWhileRevalidate',
        options: { cacheName: 'supabase-storage' },
      },
    ],
  },
});
```

### iOS-specific `index.html` meta tags

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="HomeGuru">
<link rel="apple-touch-icon" sizes="180x180" href="/homeguru-pms/icons/apple-touch-180.png">
```

### Housekeeping camera

Use native file input with `capture` attribute (works on iOS Safari + Android Chrome PWAs):

```html
<input type="file" accept="image/*" capture="environment">
```

Compress before upload using `browser-image-compression`:

```ts
import imageCompression from 'browser-image-compression';

const compressed = await imageCompression(file, {
  maxSizeMB: 0.3,
  maxWidthOrHeight: 1280,
  useWebWorker: true,
});

await supabase.storage.from('housekeeping-photos').upload(path, compressed);
```

### iOS PWA limitations (known)

| Limitation | Impact on HomeGuru | Mitigation |
|---|---|---|
| No push notifications < iOS 16.4 | Staff won't get pushes on older iPhones | Foreground UI badge + manual refresh; not blocking |
| ~50 MB localStorage quota | Limits offline cache | Cache only working set (current week's reservations) |
| No background sync | Photo upload must happen while app is foregrounded | UX: show upload progress; never hide it |
| WebSocket disconnects on background | Realtime calendar may briefly lag | supabase-js auto-reconnects on focus |
| Service worker eviction under pressure | Re-fetches on next open | Acceptable; non-issue for daily-use |

---

## 9. Supabase setup checklist

One-time operations in the Supabase dashboard:

1. **Create project**
   - Region: **Frankfurt (EU Central)** — closest to Turkey, GDPR/KVKK-friendly
   - Strong DB password — save in password manager
2. **Settings → API** — copy `URL` and `anon public` key
3. **Settings → Auth → Providers**
   - Email: enabled
   - **Signups: disabled**
4. **Database → Extensions** — enable:
   - `pgcrypto` (sensitive field encryption)
   - `btree_gist` (required for EXCLUDE constraint)
   - `pg_cron` (scheduled jobs)
5. **SQL Editor** — run migrations in order:
   - `001_schema.sql` (tables, indexes, constraints)
   - `002_rls.sql` (RLS policies for every tenanted table)
   - `003_functions.sql` (Postgres functions used by RLS / triggers)
   - `004_cron.sql` (pg_cron schedules)
   - `005_seed.sql` (initial admin user, sample property)
6. **Storage** — create buckets:
   - `housekeeping-photos` — RLS: authenticated users can upload within own property
   - `id-documents` — RLS: only RECEPTION + PROPERTY_MANAGER + SUPER_ADMIN can read; encrypted-at-rest
7. **Edge Functions** — deploy:
   - `kbs-submit` (formats and posts to KBS)
   - `manage-staff` (admin-only Edge Function for creating staff accounts)
8. **GitHub Secrets** (in repo Settings → Secrets and variables → Actions):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY` (only used by Edge Function deploys; never in client bundle)

---

## 10. Frontend ↔ Supabase wiring

```ts
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

const url            = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error('Supabase env vars missing — check .env.local or GitHub secrets');
}

export const supabase = createClient(url, publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
```

`.env.local` (gitignored):
```
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

**Security note:** the publishable key in the bundle is **by design**. Security comes from RLS, not from hiding the key. The `secret` key never ships to the client — only used in Edge Functions.

---

## 11. KVKK compliance

### Classification

| Field | Class | Protection |
|---|---|---|
| TC kimlik | Personal data (high identity-theft value) | **Encrypted** with `pgp_sym_encrypt` |
| Passport | Personal data (high identity-theft value) | **Encrypted** with `pgp_sym_encrypt` |
| Phone | Personal data, NOT özel nitelikli | Plaintext + RBAC + audit log |
| Email | Personal data | Plaintext + RBAC + audit log |
| Address | Personal data | Plaintext + RBAC + audit log |
| Nationality | Personal data | Plaintext + RBAC + audit log |

The `pgcrypto` symmetric key is stored as a Supabase Vault secret, retrieved at query time via a database function.

### Process (legal — owner's responsibility)

| Item | Owner | Notes |
|---|---|---|
| **Aydınlatma metni** drafted | KVKK lawyer | Mention cross-border transfer to Supabase EU servers |
| **Açık rıza** UI at check-in | I build | Tablet UI; tick + signature stored in `guests.consent_given_at` |
| **DPA signed with Supabase** | Business owner | One-time; available on Supabase site |
| **VERBİS registration** | Business owner | If data volume requires it (most accommodation businesses do) |
| **Retention policy** | I build | Auto-delete guest records N years after last reservation |
| **Right-to-erasure endpoint** | I build | Admin UI to delete a guest record on request |
| **Audit log** | I build | Every access to encrypted fields logged |

### Açık rıza flow

1. Guest arrives.
2. Reception opens the reservation in the app.
3. Tablet/screen shows the aydınlatma metni (current version).
4. Guest reads + ticks consent checkbox + optionally signs on tablet.
5. App records: `consent_given_at`, `consent_version`, `signature_blob` (if signed).
6. Without consent → reservation cannot move to `active` status.

---

## 12. KBS compliance (Identity Notification System)

Every check-in produces a `kbs_submissions` row:

| Column | Notes |
|---|---|
| `reservation_id` | |
| `payload` (jsonb) | KBS-formatted data |
| `status` | `PENDING` → `SUBMITTED` → `CONFIRMED` (or `FAILED` with retry) |
| `submitted_at` | |
| `response_code` | from KBS endpoint |
| `retry_count` | for exponential backoff |

The `kbs-submit` Edge Function:
1. Picks up `PENDING` submissions
2. Formats per current KBS spec
3. Posts to the KBS endpoint with credentials (stored as Edge Function secrets)
4. Records response
5. On failure: schedules retry; on repeated failure: alerts Property Manager

**Runs on a cron schedule** every 15 minutes (configurable).

**Audit:** every submission is preserved indefinitely. If Emniyet asks, the records are there.

---

## 13. WhatsApp (MVP = Phase 1 only)

### Phase 1: `wa.me` deep links

A "WhatsApp" button next to each available unit in the search results. Click → opens WhatsApp with pre-filled message:

```
https://wa.me/<phone>?text=<urlencoded message>
```

Message template stored in DB (`message_templates` table), supports placeholders:
- `{daire_no}` / `{oda_no}`
- `{checkin_date}` / `{checkout_date}`
- `{katalog_link}` (Supabase Storage signed URL)
- Plus the slogan: *"Forget the hotel, be our guest ✨"*

No API, no Meta approval, **free forever**.

### Phase 2 (post-MVP): Twilio WhatsApp Business API

Deferred. Requires:
- Meta Business approval (2–4 weeks)
- Twilio account ($0.005–$0.10 per message — adds up at scale)
- Açık rıza specifically for automated WhatsApp messaging (cross-border data transfer to Meta US)
- Webhook endpoint (Edge Function)

Not in MVP.

---

## 14. Payment-on-delivery flow (apartment properties)

Highest operational risk → strictest audit trail.

1. Housekeeper marks task `COMPLETED` in PWA.
2. Records payment: amount, method (cash / transfer), photo of receipt or transfer confirmation.
3. Entry created in `payment_collections` with status `UNCONFIRMED`.
4. Property Manager dashboard shows all unconfirmed collections for the day.
5. Manager reconciles at end-of-day → marks `CONFIRMED` → balance posts to the appropriate `cash_account`.
6. If variance detected (reported cash ≠ deposited cash) → flagged `DISPUTED` → investigation.

Every state change is logged in `audit_log` with `user_id`, `timestamp`, `device_fingerprint` (rough — browser fingerprint, not perfect).

---

## 15. Free-tier constraints & mitigations (first 2 months)

| Limit | Threshold | Risk | Mitigation |
|---|---|---|---|
| **Project auto-pauses after 7 days inactivity** | 7 days | Critical | **#1 GitHub Action keepalive ping** every 6 days |
| **File storage** | 1 GB | Medium | **#2 Image compression** before upload (max 1280px, ~200 KB JPEG) |
| **Database storage** | 500 MB | Low | Text-only data; well within limit |
| **Bandwidth** | 5 GB/mo | Low | Aggressive PWA caching; paginated queries |
| **Edge Function invocations** | 500K/mo | Low | KBS submission + auto-debit + keepalive — far below |
| **Max file upload** | 50 MB | Low | Compressed photos << 1 MB |

### Deferred features (MVP)

| Feature | Why |
|---|---|
| **Video uploads** | Eats storage; not in spec |
| **WhatsApp Phase 2 (Twilio)** | Cost + Meta approval; Phase 1 suffices |
| **iyzico online payments** | All money is cash/transfer recorded by staff |
| **Channel managers (Booking, Airbnb)** | Out of scope for MVP |
| **e-Arşiv Fatura / e-Fatura** | Handled externally for MVP |
| **Public landing page** | Easy to add post-MVP (one HTML file at site root) |
| **Multi-currency** | TRY only for MVP |
| **English UI** | Turkish only; i18n hooks present so EN can be added later |
| **Auto-delete old photos** | Skipped per business decision — see known risk below |

### ⚠️ Known risk: photo storage growth

Without auto-delete, housekeeping photos accumulate. Math:

```
200 KB × 3 photos × N tasks/day × 60 days = total storage
```

| Tasks/day | 60-day total |
|---|---|
| 10 | 360 MB ✓ |
| 20 | 720 MB ✓ |
| 28 | 1.0 GB ⚠️ at limit |
| 40 | 1.44 GB ❌ over |

**Plan:** monitor storage in Supabase dashboard weekly. If approaching 800 MB, either:
- Upgrade to Supabase Pro ($25/mo, 100 GB), or
- Manually delete old reconciled photos, or
- Add the auto-delete Edge Function we deferred.

---

## 16. Deployment

### Frontend → GitHub Pages

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
        env:
          VITE_BASE: /${{ github.event.repository.name }}/
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.VITE_SUPABASE_PUBLISHABLE_KEY }}
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Repo Settings → Pages → Source = GitHub Actions** (one-time setup).

Site URL: `https://<user>.github.io/homeguru-pms/`. Custom domain (`.com.tr`) can be added later via CNAME — no architectural change.

### Supabase keepalive

`.github/workflows/keepalive.yml`:

```yaml
name: Supabase keepalive
on:
  schedule:
    - cron: '0 9 */6 * *'  # every 6 days at 09:00 UTC
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS "$URL/rest/v1/properties?select=id&limit=1" \
            -H "apikey: $KEY" \
            -H "Authorization: Bearer $KEY"
        env:
          URL: ${{ secrets.VITE_SUPABASE_URL }}
          KEY: ${{ secrets.VITE_SUPABASE_PUBLISHABLE_KEY }}
```

### Edge Function deployments

Deployed via Supabase CLI from a separate workflow when Edge Function code changes.

---

## 17. Phased delivery plan

| Sprint | Duration | Deliverables |
|---|---|---|
| **0 — Foundation** | 2 wks | Repo scaffold (Vite + React + TS + Tailwind + shadcn/ui), Supabase project provisioned, schema + RLS migrations, Supabase Auth wired, RBAC middleware, property/unit CRUD, seed admin user, deploy pipeline, keepalive workflow |
| **1 — Reservations MVP** | 3 wks | FullCalendar resource-timeline Gantt view, quick reservation form, guest CRUD with açık rıza flow, availability search, EXCLUDE-constraint conflict prevention, KVKK encryption for TC/passport, smart alternatives |
| **2 — Finance** | 3 wks | Guest ledger, property cash accounts, expenses (fixed + variable), staff profiles with payroll + advances, nightly auto-debit cron |
| **3 — Operations** | 3 wks | Housekeeping PWA (full flow), unit status workflow, photo upload with compression, payment-on-delivery + reconciliation, WhatsApp Phase 1 (wa.me) |
| **4 — Compliance & polish** | 2 wks | KBS export Edge Function + retries, Excel exports across all modules, property-level dashboards, audit log UI, retention policy implementation, right-to-erasure endpoint |
| **Post-MVP** | ongoing | Public landing page, WhatsApp Phase 2 (Twilio), advanced reports, channel manager integrations, e-Fatura, custom domain, English UI |

**Total to MVP: ~13 weeks** for one developer.

---

## 18. Pre-launch checklist (DON'T skip)

- [ ] **KVKK lawyer review** of aydınlatma metni and consent flow
- [ ] **DPA signed** with Supabase
- [ ] **VERBİS registration** complete (if required by data volume)
- [ ] **All RLS policies tested** with a tenancy fuzz test suite
- [ ] **KBS submission tested** against real KBS endpoint, not mock
- [ ] **Backup strategy** — free tier has NO automated backups; the `Database backup` GitHub Action (encrypted daily `pg_dump`) covers the gap until Supabase Pro. Test the restore procedure (SETUP.md §10) before launch
- [ ] **Audit log working** — try every sensitive action, confirm log entry created
- [ ] **Encryption verified** — TC/passport unreadable in raw SQL without decryption function
- [ ] **3 weeks of fake-data testing** with real users (staff dry-run)
- [ ] **Disaster recovery plan** — what if Supabase goes down? What if account is suspended?
- [ ] **Custom domain** (optional) configured with CNAME

---

## 19. Out of scope (explicit non-goals)

- Guest-facing booking portal (channel = WhatsApp)
- Loyalty programs / points
- POS for in-property minibar / kitchen
- Native iOS/Android apps (PWA covers it)
- BI / data warehouse (Postgres + Excel exports suffice)
- Multi-organization SaaS (single-tenant product for HomeGuru only)
- Hotel-style room service / restaurant management
- Channel manager integrations (Booking.com, Airbnb) — for MVP

---

## 20. Open items to revisit

| Item | When to revisit |
|---|---|
| Photo auto-delete | When storage approaches 800 MB |
| WhatsApp Phase 2 | When budget allows + consent flow is mature |
| Multi-currency | When first foreign-currency guest needs it |
| English UI | When first non-Turkish-speaking staff hired |
| Channel managers | When listing on Booking.com / Airbnb becomes a business goal |
| Custom domain | After 1 month of stable operation on GitHub Pages URL |
| Supabase Pro upgrade ($25/mo) | After 2 months of free-tier operation |

---

*Last updated: 2026-05-11 · Stack: Vite + React + TypeScript + Supabase + GitHub Pages · Compliance: KBS + KVKK*
