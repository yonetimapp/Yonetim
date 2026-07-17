-- =============================================================================
-- HomeGuru PMS — Schema migration 001
-- =============================================================================
-- Prerequisites (must be enabled in Supabase dashboard → Database → Extensions):
--   • pgcrypto    — for TC kimlik / passport encryption
--   • btree_gist  — required for the EXCLUDE constraint on reservations
--   • pg_cron     — used by 004_cron.sql for nightly auto-debit
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Properties: hotels (have rooms) or apartments (standalone units)
-- -----------------------------------------------------------------------------
CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('HOTEL', 'APARTMENT')),
  address         text,
  manager_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Units: rooms inside hotels OR the apartment itself
-- For APARTMENT properties, the app enforces exactly 1 unit (no DB constraint
-- because we'd need a trigger; keeping it light at MVP).
-- -----------------------------------------------------------------------------
CREATE TABLE units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name        text NOT NULL,
  room_type   text NOT NULL CHECK (room_type IN ('1+0', '1+1', '2+1', 'ROOM', 'SUITE')),
  capacity    int NOT NULL CHECK (capacity > 0),
  base_price  numeric(10, 2) NOT NULL CHECK (base_price >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX units_property_idx ON units(property_id);

-- -----------------------------------------------------------------------------
-- Staff profiles: extends auth.users with HR + RBAC data
-- -----------------------------------------------------------------------------
CREATE TABLE staff_profiles (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  role        text NOT NULL CHECK (role IN ('SUPER_ADMIN', 'PROPERTY_MANAGER', 'RECEPTION', 'HOUSEKEEPING')),
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  salary      numeric(10, 2),
  hire_date   date,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staff_profiles_property_idx ON staff_profiles(property_id);

-- Staff advances (payroll module)
CREATE TABLE staff_advances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount      numeric(10, 2) NOT NULL CHECK (amount > 0),
  note        text,
  given_at    timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES auth.users(id)
);

-- -----------------------------------------------------------------------------
-- Guests: KVKK-sensitive fields encrypted via pgcrypto
-- TC kimlik + passport are encrypted; phone/email/address are plaintext
-- (not özel nitelikli under KVKK Article 6).
-- -----------------------------------------------------------------------------
CREATE TABLE guests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name            text NOT NULL,
  tc_kimlik_encrypted  bytea,
  passport_encrypted   bytea,
  phone                text,
  email                text,
  address              text,
  nationality          text,
  consent_given_at     timestamptz,
  consent_version      text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX guests_phone_idx ON guests(phone);
CREATE INDEX guests_name_idx ON guests(full_name);

-- -----------------------------------------------------------------------------
-- Reservations: the EXCLUDE constraint makes double-booking impossible
-- at the database level. This is the single most important safety net.
-- -----------------------------------------------------------------------------
-- Source-of-truth columns are stay_start + stay_end; `stay` is a GENERATED
-- tstzrange so the EXCLUDE constraint can use it. supabase-js works cleanly
-- with the two timestamptz columns instead of an awkward range string.
CREATE TABLE reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id       uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  stay_start    timestamptz NOT NULL,
  stay_end      timestamptz NOT NULL,
  stay          tstzrange GENERATED ALWAYS AS (tstzrange(stay_start, stay_end, '[)')) STORED,
  status        text NOT NULL CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  total_amount  numeric(10, 2) NOT NULL CHECK (total_amount >= 0),
  deposit       numeric(10, 2) NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  auto_debit    boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (stay_end > stay_start),
  -- The crown jewel: DB-level overlap prevention per unit
  EXCLUDE USING gist (
    unit_id WITH =,
    stay WITH &&
  ) WHERE (status != 'cancelled')
);

CREATE INDEX reservations_property_idx ON reservations(property_id);
CREATE INDEX reservations_unit_stay_idx ON reservations USING gist (unit_id, stay);
CREATE INDEX reservations_guest_idx ON reservations(guest_id);
CREATE INDEX reservations_stay_start_idx ON reservations(stay_start);

-- -----------------------------------------------------------------------------
-- Guest ledger: append-only debt/payment entries
-- Balance is always computed as SUM(payments) - SUM(debts) — never stored.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id        uuid NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  reservation_id  uuid REFERENCES reservations(id) ON DELETE SET NULL,
  type            text NOT NULL CHECK (type IN ('DEBT', 'PAYMENT')),
  amount          numeric(10, 2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL DEFAULT 'TRY',
  note            text,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_guest_idx ON ledger_entries(guest_id);
CREATE INDEX ledger_reservation_idx ON ledger_entries(reservation_id);

-- -----------------------------------------------------------------------------
-- Cash accounts: per-property tills (cash / bank / card)
-- -----------------------------------------------------------------------------
CREATE TABLE cash_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name         text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('CASH', 'BANK', 'CARD')),
  currency     text NOT NULL DEFAULT 'TRY',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT,
  amount          numeric(10, 2) NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  description     text,
  ref_type        text,
  ref_id          uuid,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cash_tx_account_idx ON cash_transactions(cash_account_id);

-- -----------------------------------------------------------------------------
-- Expenses (per property): fixed (rent/utilities) and variable (repairs)
-- -----------------------------------------------------------------------------
CREATE TABLE expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category     text NOT NULL,
  amount       numeric(10, 2) NOT NULL CHECK (amount >= 0),
  description  text,
  expense_date date NOT NULL,
  is_recurring boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expenses_property_date_idx ON expenses(property_id, expense_date);

-- -----------------------------------------------------------------------------
-- Housekeeping tasks (per unit, color-coded status)
-- -----------------------------------------------------------------------------
CREATE TABLE housekeeping_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('DIRTY', 'IN_PROGRESS', 'CLEAN')),
  notes       text,
  updated_by  uuid REFERENCES auth.users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hk_tasks_property_idx ON housekeeping_tasks(property_id);
CREATE INDEX hk_tasks_unit_idx ON housekeeping_tasks(unit_id);

-- Issues / arıza reports (with photos uploaded to Storage)
CREATE TABLE housekeeping_issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid REFERENCES housekeeping_tasks(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id      uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  description  text NOT NULL,
  photo_paths  text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
  reported_by  uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX hk_issues_property_idx ON housekeeping_issues(property_id);

-- -----------------------------------------------------------------------------
-- Payment collections: cash collected by housekeepers at apartment delivery
-- Requires manager reconciliation (UNCONFIRMED → CONFIRMED).
-- -----------------------------------------------------------------------------
CREATE TABLE payment_collections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id        uuid NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  collected_by_user_id  uuid NOT NULL REFERENCES auth.users(id),
  amount                numeric(10, 2) NOT NULL CHECK (amount > 0),
  method                text NOT NULL CHECK (method IN ('CASH', 'TRANSFER', 'CARD')),
  receipt_photo_path    text,
  status                text NOT NULL DEFAULT 'UNCONFIRMED' CHECK (status IN ('UNCONFIRMED', 'CONFIRMED', 'DISPUTED')),
  confirmed_by          uuid REFERENCES auth.users(id),
  confirmed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_collections_property_idx ON payment_collections(property_id);
CREATE INDEX payment_collections_status_idx ON payment_collections(status);

-- -----------------------------------------------------------------------------
-- KBS submissions (Identity Notification System — Emniyet)
-- -----------------------------------------------------------------------------
CREATE TABLE kbs_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  uuid NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
  response_code   text,
  response_body   text,
  retry_count     int NOT NULL DEFAULT 0,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kbs_status_idx ON kbs_submissions(status);

-- -----------------------------------------------------------------------------
-- Audit log: every access to encrypted fields + every financial state change
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_user_idx ON audit_log(user_id);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX audit_created_idx ON audit_log(created_at);

-- -----------------------------------------------------------------------------
-- WhatsApp message templates (Phase 1: wa.me link content)
-- -----------------------------------------------------------------------------
CREATE TABLE message_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  content     text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
