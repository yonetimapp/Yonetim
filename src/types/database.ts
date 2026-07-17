/**
 * Type-safe Database shape for the Supabase client.
 *
 * ⚠️ This file is a manual scaffold. After running migrations in Supabase,
 * regenerate it with the Supabase CLI for fully accurate types:
 *
 *   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
 *
 * Shape must match what `@supabase/supabase-js` expects — use a top-level
 * `type Database = { ... }` alias (NOT interface) and inline all returns.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Role =
  | 'SUPER_ADMIN'
  | 'PROPERTY_MANAGER'
  | 'RECEPTION'
  | 'HOUSEKEEPING'
  | 'YETKILI'
  // Technical staff — read-only reservation Liste + issue reporting only, across
  // ALL regions (server: auth_role() normalises to HOUSEKEEPING, sees every
  // property via an auth_sees_property bypass). Region access is the all_regions
  // flag; this role is all-regions by default.
  | 'TEKNIK_PERSONEL'
  | 'PENDING';
/** Which properties a staff member works across (branch isolation, migration 033). */
export type AccessScope = 'ALL' | 'HOTELS' | 'APARTMENTS';
export type PropertyType = 'HOTEL' | 'APARTMENT';
export type RoomType =
  | '1+0' | '1+1' | '2+1'         // Apartment layouts
  | 'SINGLE' | 'DOUBLE' | 'TRIPLE' | 'QUAD'; // Hotel rooms (capacity-named)
export type ReservationStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'upcoming';
/** OVERNIGHT (multi-night, midnight-aligned) vs. DAYUSE (same-day 2-4h). */
export type StayType = 'OVERNIGHT' | 'DAYUSE';
export type LedgerEntryType = 'DEBT' | 'PAYMENT';
export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CARD';
export type AccountType = 'CASH' | 'BANK' | 'CARD';
export type TxDirection = 'IN' | 'OUT';
export type PaymentStatus = 'UNCONFIRMED' | 'CONFIRMED' | 'DISPUTED';
export type HousekeepingStatus = 'DIRTY' | 'IN_PROGRESS' | 'CLEAN';
export type KbsStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export type Database = {
  public: {
    Tables: {
      properties: {
        Row: {
          id: string;
          name: string;
          type: PropertyType;
          address: string | null;
          manager_user_id: string | null;
          photo_paths: string[];
          /** Region this mülk belongs to (regions.name). Defaults to 'Genel'. */
          region: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          type: PropertyType;
          address?: string | null;
          manager_user_id?: string | null;
          photo_paths?: string[];
          region?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          type?: PropertyType;
          address?: string | null;
          manager_user_id?: string | null;
          photo_paths?: string[];
          region?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      units: {
        Row: {
          id: string;
          property_id: string;
          name: string;
          room_type: RoomType;
          capacity: number;
          base_price: number;
          catalog_url: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          name: string;
          room_type: RoomType;
          capacity: number;
          base_price: number;
          catalog_url?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string;
          name?: string;
          room_type?: RoomType;
          capacity?: number;
          base_price?: number;
          catalog_url?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      regions: {
        Row: {
          id: string;
          name: string;
          is_default: boolean;
          created_at: string;
        };
        // Writes go through the create_region / rename_region / delete_region
        // RPCs (SUPER_ADMIN only) — there is no direct-write RLS policy.
        Insert: {
          id?: string;
          name: string;
          is_default?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          is_default?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      staff_profiles: {
        Row: {
          user_id: string;
          full_name: string;
          role: Role;
          property_id: string | null;
          access_scope: AccessScope;
          /** Home region (regions.name). Decides which kasa pays maaş/avans. */
          region: string;
          /** true = sees every region; false = scoped to `region`. */
          all_regions: boolean;
          salary: number | null;
          salary_day: number | null;
          hire_date: string | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          user_id: string;
          full_name: string;
          role: Role;
          property_id?: string | null;
          access_scope?: AccessScope;
          region?: string;
          all_regions?: boolean;
          salary?: number | null;
          salary_day?: number | null;
          hire_date?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          user_id?: string;
          full_name?: string;
          role?: Role;
          property_id?: string | null;
          access_scope?: AccessScope;
          region?: string;
          all_regions?: boolean;
          salary?: number | null;
          salary_day?: number | null;
          hire_date?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: string;
          last_seen_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
          created_at?: string;
          last_seen_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          endpoint?: string;
          p256dh?: string;
          auth?: string;
          user_agent?: string | null;
          created_at?: string;
          last_seen_at?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          body: string | null;
          url: string | null;
          kind: 'issue' | 'payment' | 'reservation' | 'system';
          event_type: string | null;
          data: Json | null;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          body?: string | null;
          url?: string | null;
          kind: 'issue' | 'payment' | 'reservation' | 'system';
          event_type?: string | null;
          data?: Json | null;
          read_at?: string | null;
          created_at?: string;
        };
        Update: {
          // Client only flips read_at; full shape kept for type completeness.
          id?: string;
          user_id?: string;
          title?: string;
          body?: string | null;
          url?: string | null;
          kind?: 'issue' | 'payment' | 'reservation' | 'system';
          event_type?: string | null;
          data?: Json | null;
          read_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      notification_preferences: {
        Row: {
          user_id: string;
          event_type: string;
          enabled: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          event_type: string;
          enabled?: boolean;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          event_type?: string;
          enabled?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      staff_salary_payments: {
        Row: {
          id: string;
          user_id: string;
          amount: number;
          paid_at: string;
          source: 'AUTO' | 'MANUAL';
          pay_period: string; // DATE → "YYYY-MM-01"
          cash_account_id: string | null;
          cash_tx_id: string | null;
          note: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          amount: number;
          paid_at?: string;
          source: 'AUTO' | 'MANUAL';
          pay_period: string;
          cash_account_id?: string | null;
          cash_tx_id?: string | null;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          // Append-only by RLS — shape kept for type completeness only.
          id?: string;
          user_id?: string;
          amount?: number;
          paid_at?: string;
          source?: 'AUTO' | 'MANUAL';
          pay_period?: string;
          cash_account_id?: string | null;
          cash_tx_id?: string | null;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      guests: {
        Row: {
          id: string;
          full_name: string;
          tc_kimlik_encrypted: string | null;
          passport_encrypted: string | null;
          phone: string | null;
          email: string | null;
          address: string | null;
          nationality: string | null;
          is_problematic: boolean;
          problematic_note: string | null;
          consent_given_at: string | null;
          consent_version: string | null;
          created_at: string;
          created_by: string | null;
        };
        // NOTE: tc_kimlik_encrypted and passport_encrypted are intentionally
        // omitted from Insert/Update — use the create_guest / update_guest RPCs
        // which handle encryption server-side.
        Insert: {
          id?: string;
          full_name: string;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          nationality?: string | null;
          is_problematic?: boolean;
          problematic_note?: string | null;
          consent_given_at?: string | null;
          consent_version?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string;
          phone?: string | null;
          email?: string | null;
          address?: string | null;
          nationality?: string | null;
          is_problematic?: boolean;
          problematic_note?: string | null;
          consent_given_at?: string | null;
          consent_version?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      guest_companions: {
        Row: {
          id: string;
          guest_id: string;
          full_name: string;
          relationship: string | null;
          birth_date: string | null;
          nationality: string | null;
          tc_kimlik_encrypted: string | null;
          passport_encrypted: string | null;
          created_at: string;
        };
        // Encrypted fields omitted from Insert/Update — use the
        // create_companion / update_companion RPCs which encrypt server-side.
        Insert: {
          id?: string;
          guest_id: string;
          full_name: string;
          relationship?: string | null;
          birth_date?: string | null;
          nationality?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          guest_id?: string;
          full_name?: string;
          relationship?: string | null;
          birth_date?: string | null;
          nationality?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      reservations: {
        Row: {
          id: string;
          property_id: string;
          unit_id: string;
          guest_id: string;
          stay_start: string;
          stay_end: string;
          status: ReservationStatus;
          stay_type: StayType;
          total_amount: number;
          deposit: number;
          auto_debit: boolean;
          created_by: string;
          created_at: string;
          notified_2d_before: string | null;
          late_checkout_hours: number;
          cari_blocked: boolean;
          deleted_property_name: string | null;
          deleted_unit_name: string | null;
          note: string | null;
        };
        Insert: {
          id?: string;
          property_id: string;
          unit_id: string;
          guest_id: string;
          stay_start: string;
          stay_end: string;
          status: ReservationStatus;
          stay_type?: StayType;
          total_amount: number;
          deposit?: number;
          auto_debit?: boolean;
          created_by: string;
          created_at?: string;
          notified_2d_before?: string | null;
          late_checkout_hours?: number;
          cari_blocked?: boolean;
          deleted_property_name?: string | null;
          deleted_unit_name?: string | null;
          note?: string | null;
        };
        Update: {
          id?: string;
          property_id?: string;
          unit_id?: string;
          guest_id?: string;
          stay_start?: string;
          stay_end?: string;
          status?: ReservationStatus;
          stay_type?: StayType;
          total_amount?: number;
          deposit?: number;
          auto_debit?: boolean;
          created_by?: string;
          created_at?: string;
          notified_2d_before?: string | null;
          late_checkout_hours?: number;
          cari_blocked?: boolean;
          deleted_property_name?: string | null;
          deleted_unit_name?: string | null;
          note?: string | null;
        };
        Relationships: [];
      };
      reservation_deletion_requests: {
        Row: {
          id: string;
          reservation_id: string;
          property_id: string | null;
          requested_by: string | null;
          reason: string | null;
          status: 'pending' | 'approved' | 'denied';
          resolved_by: string | null;
          resolved_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          reservation_id: string;
          property_id?: string | null;
          requested_by?: string | null;
          reason?: string | null;
          status?: 'pending' | 'approved' | 'denied';
          resolved_by?: string | null;
          resolved_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          reservation_id?: string;
          property_id?: string | null;
          requested_by?: string | null;
          reason?: string | null;
          status?: 'pending' | 'approved' | 'denied';
          resolved_by?: string | null;
          resolved_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      property_nightly_prices: {
        Row: {
          id: string;
          property_id: string;
          unit_id: string;
          price_date: string; // DATE column → "YYYY-MM-DD"
          price: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          unit_id: string;
          price_date: string;
          price: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string;
          unit_id?: string;
          price_date?: string;
          price?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      property_date_notes: {
        Row: {
          id: string;
          property_id: string;
          unit_id: string;
          note_date: string; // DATE column → "YYYY-MM-DD"
          note: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          unit_id: string;
          note_date: string;
          note: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string;
          unit_id?: string;
          note_date?: string;
          note?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      property_blocks: {
        Row: {
          id: string;
          property_id: string;
          unit_id: string;
          block_start: string;
          block_end: string;
          reason: string | null;
          created_by: string | null;
          created_at: string;
          // block_range is a server-side generated tstzrange — not surfaced
          // to JS callers, the start/end columns are the source of truth.
        };
        Insert: {
          id?: string;
          property_id: string;
          unit_id: string;
          block_start: string;
          block_end: string;
          reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string;
          unit_id?: string;
          block_start?: string;
          block_end?: string;
          reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      cash_accounts: {
        Row: {
          id: string;
          /** NULL for a region kasa — it belongs to a region, not a mülk. */
          property_id: string | null;
          name: string;
          account_type: AccountType;
          currency: string;
          /** The region this kasa belongs to (regions.name). One kasa per region. */
          region: string;
          created_at: string;
        };
        // Created by the create_region RPC alongside its region — not directly.
        Insert: {
          id?: string;
          property_id?: string | null;
          name: string;
          account_type: AccountType;
          currency?: string;
          region?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string | null;
          name?: string;
          account_type?: AccountType;
          currency?: string;
          region?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      ledger_entries: {
        Row: {
          id: string;
          guest_id: string;
          reservation_id: string | null;
          type: LedgerEntryType;
          amount: number;
          currency: string;
          note: string | null;
          created_by: string | null;
          created_at: string;
          payment_collection_id: string | null;
        };
        Insert: {
          id?: string;
          guest_id: string;
          reservation_id?: string | null;
          type: LedgerEntryType;
          amount: number;
          currency?: string;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
          payment_collection_id?: string | null;
        };
        Update: {
          // ledger_entries are append-only by RLS — no UPDATE/DELETE policies.
          // Shape here is for type-completeness only.
          id?: string;
          guest_id?: string;
          reservation_id?: string | null;
          type?: LedgerEntryType;
          amount?: number;
          currency?: string;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
          payment_collection_id?: string | null;
        };
        Relationships: [];
      };
      housekeeping_issues: {
        Row: {
          id: string;
          task_id: string | null;
          property_id: string;
          unit_id: string;
          description: string;
          photo_paths: string[];
          status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
          reported_by: string | null;
          created_at: string;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          task_id?: string | null;
          property_id: string;
          unit_id: string;
          description: string;
          photo_paths?: string[];
          status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
          reported_by?: string | null;
          created_at?: string;
          resolved_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string | null;
          property_id?: string;
          unit_id?: string;
          description?: string;
          photo_paths?: string[];
          status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
          reported_by?: string | null;
          created_at?: string;
          resolved_at?: string | null;
        };
        Relationships: [];
      };
      housekeeping_tasks: {
        Row: {
          id: string;
          property_id: string;
          unit_id: string;
          status: HousekeepingStatus;
          notes: string | null;
          updated_by: string | null;
          updated_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id: string;
          unit_id: string;
          status: HousekeepingStatus;
          notes?: string | null;
          updated_by?: string | null;
          updated_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string;
          unit_id?: string;
          status?: HousekeepingStatus;
          notes?: string | null;
          updated_by?: string | null;
          updated_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      message_templates: {
        Row: {
          id: string;
          name: string;
          content: string;
          is_default: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          content: string;
          is_default?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          content?: string;
          is_default?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      trash_entries: {
        Row: {
          id: string;
          entity_type: string;
          entity_id: string;
          entity_label: string | null;
          branch_id: string | null;
          payload: Json;
          deleted_by: string | null;
          deleted_at: string;
        };
        Insert: {
          id?: string;
          entity_type: string;
          entity_id: string;
          entity_label?: string | null;
          branch_id?: string | null;
          payload: Json;
          deleted_by?: string | null;
          deleted_at?: string;
        };
        Update: {
          id?: string;
          entity_type?: string;
          entity_id?: string;
          entity_label?: string | null;
          branch_id?: string | null;
          payload?: Json;
          deleted_by?: string | null;
          deleted_at?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          user_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          metadata: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          metadata?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          action?: string;
          entity_type?: string;
          entity_id?: string | null;
          metadata?: Json | null;
          created_at?: string;
        };
        Relationships: [];
      };
      staff_advances: {
        Row: {
          id: string;
          user_id: string;
          amount: number;
          note: string | null;
          given_at: string;
          created_by: string;
          settled_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          amount: number;
          note?: string | null;
          given_at?: string;
          created_by: string;
          settled_at?: string | null;
        };
        Update: {
          // Append-only by convention; UI doesn't expose update/delete.
          id?: string;
          user_id?: string;
          amount?: number;
          note?: string | null;
          given_at?: string;
          created_by?: string;
          settled_at?: string | null;
        };
        Relationships: [];
      };
      expenses: {
        Row: {
          id: string;
          property_id: string | null;
          deleted_property_name: string | null;
          category: string;
          amount: number;
          description: string | null;
          expense_date: string; // DATE column → "YYYY-MM-DD"
          is_recurring: boolean;
          paid_from_kasa: boolean;
          recurring_source_id: string | null;
          recurring_day: number | null;
          /** Region this gider belongs to (regions.name). Defaults to 'Genel'. */
          region: string;
          unit_id: string | null;
          approval_status: 'pending' | 'approved' | 'rejected';
          reviewed_by: string | null;
          reviewed_at: string | null;
          rejection_reason: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          property_id?: string | null;
          deleted_property_name?: string | null;
          category: string;
          amount: number;
          description?: string | null;
          expense_date: string;
          is_recurring?: boolean;
          paid_from_kasa?: boolean;
          recurring_source_id?: string | null;
          recurring_day?: number | null;
          region?: string;
          unit_id?: string | null;
          approval_status?: 'pending' | 'approved' | 'rejected';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          rejection_reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          property_id?: string | null;
          deleted_property_name?: string | null;
          category?: string;
          amount?: number;
          description?: string | null;
          expense_date?: string;
          is_recurring?: boolean;
          paid_from_kasa?: boolean;
          recurring_source_id?: string | null;
          recurring_day?: number | null;
          region?: string;
          unit_id?: string | null;
          approval_status?: 'pending' | 'approved' | 'rejected';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          rejection_reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      payment_collections: {
        Row: {
          id: string;
          reservation_id: string;
          property_id: string;
          collected_by_user_id: string;
          amount: number;
          method: PaymentMethod;
          receipt_photo_path: string | null;
          status: PaymentStatus;
          confirmed_by: string | null;
          confirmed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          reservation_id: string;
          property_id: string;
          collected_by_user_id: string;
          amount: number;
          method: PaymentMethod;
          receipt_photo_path?: string | null;
          status?: PaymentStatus;
          confirmed_by?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          reservation_id?: string;
          property_id?: string;
          collected_by_user_id?: string;
          amount?: number;
          method?: PaymentMethod;
          receipt_photo_path?: string | null;
          status?: PaymentStatus;
          confirmed_by?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      cash_transactions: {
        Row: {
          id: string;
          cash_account_id: string;
          amount: number;
          direction: TxDirection;
          description: string | null;
          ref_type: string | null;
          ref_id: string | null;
          created_by: string | null;
          created_at: string;
          payment_collection_id: string | null;
          approval_status: 'pending' | 'approved' | 'rejected';
          submitted_by: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
          rejection_reason: string | null;
          property_id: string | null;
          deleted_property_name: string | null;
        };
        Insert: {
          id?: string;
          cash_account_id: string;
          amount: number;
          direction: TxDirection;
          description?: string | null;
          ref_type?: string | null;
          ref_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          payment_collection_id?: string | null;
          approval_status?: 'pending' | 'approved' | 'rejected';
          submitted_by?: string | null;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          rejection_reason?: string | null;
          property_id?: string | null;
          deleted_property_name?: string | null;
        };
        Update: {
          // Direct UPDATE on cash_transactions has no RLS policy — admin
          // status flips go through approve_cash_tx / reject_cash_tx RPCs,
          // which are SECURITY DEFINER. This shape is for type-completeness.
          id?: string;
          cash_account_id?: string;
          amount?: number;
          direction?: TxDirection;
          description?: string | null;
          ref_type?: string | null;
          ref_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          payment_collection_id?: string | null;
          approval_status?: 'pending' | 'approved' | 'rejected';
          submitted_by?: string | null;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          rejection_reason?: string | null;
          property_id?: string | null;
          deleted_property_name?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_guest: {
        Args: {
          _full_name: string;
          _tc_kimlik?: string | null;
          _passport?: string | null;
          _phone?: string | null;
          _email?: string | null;
          _address?: string | null;
          _nationality?: string | null;
          _is_problematic?: boolean;
          _problematic_note?: string | null;
        };
        Returns: Database['public']['Tables']['guests']['Row'];
      };
      update_guest: {
        Args: {
          _id: string;
          _full_name: string;
          _tc_kimlik?: string | null;
          _passport?: string | null;
          _phone?: string | null;
          _email?: string | null;
          _address?: string | null;
          _nationality?: string | null;
          _is_problematic?: boolean;
          _problematic_note?: string | null;
        };
        Returns: Database['public']['Tables']['guests']['Row'];
      };
      get_guest_decrypted: {
        Args: { _id: string };
        Returns: {
          id: string;
          full_name: string;
          tc_kimlik: string | null;
          passport: string | null;
          phone: string | null;
          email: string | null;
          address: string | null;
          nationality: string | null;
          is_problematic: boolean;
          problematic_note: string | null;
          consent_given_at: string | null;
          consent_version: string | null;
          created_at: string;
        }[];
      };
      set_guest_problematic: {
        Args: {
          _id: string;
          _is_problematic: boolean;
          _note?: string | null;
        };
        Returns: Database['public']['Tables']['guests']['Row'];
      };
      set_cari_blocked: {
        Args: { _reservation_id: string; _blocked: boolean };
        Returns: undefined;
      };
      delete_property: {
        Args: { _property_id: string };
        Returns: undefined;
      };
      set_nightly_price_range: {
        Args: {
          _property_id: string;
          _unit_id: string;
          _start_date: string;
          _end_date: string;
          _price: number;
        };
        Returns: number; // count of nights upserted
      };
      pay_staff_salary: {
        Args: {
          _user_id: string;
          _amount: number;
          _pay_period: string; // DATE
          _note?: string | null;
        };
        Returns: Database['public']['Tables']['staff_salary_payments']['Row'];
      };
      collect_payment: {
        Args: {
          _reservation_id: string;
          _amount: number;
          _method: PaymentMethod;
          _cash_account_id?: string | null;
          _note?: string | null;
        };
        Returns: string; // payment_collections.id
      };
      confirm_payment: {
        Args: { _payment_id: string };
        Returns: Database['public']['Tables']['payment_collections']['Row'];
      };
      dispute_payment: {
        Args: { _payment_id: string };
        Returns: Database['public']['Tables']['payment_collections']['Row'];
      };
      soft_delete_entity: {
        Args: { p_type: string; p_id: string };
        Returns: string; // trash_entries.id
      };
      delete_advance_cascade: {
        Args: { p_advance_id: string };
        Returns: undefined;
      };
      restore_trash: {
        Args: { _trash_id: string };
        Returns: string; // trash_entries.id (renamed param + uuid return in migration 065)
      };
      /** SUPER_ADMIN only — creates the region AND its one kasa atomically. */
      create_region: {
        Args: { p_name: string };
        Returns: Database['public']['Tables']['regions']['Row'];
      };
      /** SUPER_ADMIN only — rename fans out to every reference (ON UPDATE CASCADE). */
      rename_region: {
        Args: { p_id: string; p_name: string };
        Returns: Database['public']['Tables']['regions']['Row'];
      };
      /** SUPER_ADMIN only — refuses the default region or one still in use. */
      delete_region: {
        Args: { p_id: string };
        Returns: undefined;
      };
      update_own_full_name: {
        Args: { p_full_name: string };
        Returns: Database['public']['Tables']['staff_profiles']['Row'];
      };
      cash_account_balances: {
        Args: Record<PropertyKey, never>;
        Returns: { cash_account_id: string; balance: number }[];
      };
      record_expense: {
        Args: {
          _property_id: string | null;
          _category: string;
          _amount: number;
          _description: string | null;
          _expense_date: string;
          _is_recurring: boolean;
          _paid_from_kasa: boolean;
          _recurring_day?: number | null;
          /**
           * Region for a GENEL (mülksüz) gider; null lets the server use the
           * caller's own. Ignored for a mülk gider — set_expense_region() takes
           * the region from the mülk. Migration 099.
           */
          _region?: string | null;
          /** Optional birim within the mülk. Null = Tüm birimler. Migration 105. */
          _unit_id?: string | null;
        };
        Returns: Database['public']['Tables']['expenses']['Row'];
      };
      stop_recurring_expense: {
        Args: { _template_id: string };
        Returns: void;
      };
      post_recurring_instance_now: {
        Args: { _template_id: string };
        Returns: Database['public']['Tables']['expenses']['Row'];
      };
      request_reservation_deletion: {
        Args: { _reservation_id: string; _reason?: string | null };
        Returns: Database['public']['Tables']['reservation_deletion_requests']['Row'];
      };
      approve_reservation_deletion: {
        Args: { _request_id: string };
        Returns: void;
      };
      deny_reservation_deletion: {
        Args: { _request_id: string };
        Returns: void;
      };
      submit_cash_tx: {
        Args: {
          _cash_account_id: string;
          _amount: number;
          _direction: string;
          _description: string | null;
        };
        Returns: Database['public']['Tables']['cash_transactions']['Row'];
      };
      approve_expense: {
        Args: { _expense_id: string };
        Returns: Database['public']['Tables']['expenses']['Row'];
      };
      reject_expense: {
        Args: { _expense_id: string; _reason?: string | null };
        Returns: Database['public']['Tables']['expenses']['Row'];
      };
      approve_cash_tx: {
        Args: { _cash_tx_id: string };
        Returns: Database['public']['Tables']['cash_transactions']['Row'];
      };
      reject_cash_tx: {
        Args: { _cash_tx_id: string; _reason?: string | null };
        Returns: Database['public']['Tables']['cash_transactions']['Row'];
      };
      delete_staff: {
        Args: { _user_id: string };
        Returns: Database['public']['Tables']['staff_profiles']['Row'];
      };
      list_staff_directory: {
        Args: Record<PropertyKey, never>;
        Returns: { user_id: string; full_name: string }[];
      };
      create_companion: {
        Args: {
          _guest_id: string;
          _full_name: string;
          _relationship?: string | null;
          _birth_date?: string | null;
          _nationality?: string | null;
          _tc_kimlik?: string | null;
          _passport?: string | null;
        };
        Returns: Database['public']['Tables']['guest_companions']['Row'];
      };
      update_companion: {
        Args: {
          _id: string;
          _full_name: string;
          _relationship?: string | null;
          _birth_date?: string | null;
          _nationality?: string | null;
          _tc_kimlik?: string | null;
          _passport?: string | null;
        };
        Returns: Database['public']['Tables']['guest_companions']['Row'];
      };
      get_companions_decrypted: {
        Args: { _guest_id: string };
        Returns: {
          id: string;
          guest_id: string;
          full_name: string;
          relationship: string | null;
          birth_date: string | null;
          nationality: string | null;
          tc_kimlik: string | null;
          passport: string | null;
          created_at: string;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// Convenience exports — handy to import where Row/RPC return shapes are referenced
export type GuestRow = Database['public']['Tables']['guests']['Row'];
export type DecryptedGuest = Database['public']['Functions']['get_guest_decrypted']['Returns'][number];
export type DecryptedCompanion =
  Database['public']['Functions']['get_companions_decrypted']['Returns'][number];
