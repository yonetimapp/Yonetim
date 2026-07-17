-- =============================================================================
-- HomeGuru PMS — migration 076
-- Explicit Data-API grants for the public schema (Supabase policy change).
-- =============================================================================
-- Supabase is changing the default: from 2026-05-30 NEW projects, and from
-- 2026-10-30 new tables in ALL existing projects, are no longer auto-granted
-- to the Data API roles. Our migrations never granted tables explicitly — they
-- relied on that auto-grant — so without this:
--   • after 2026-10-30 any new table we add would be invisible to supabase-js;
--   • rebuilding the schema into a fresh project (disaster recovery / staging)
--     would lock the frontend out entirely, since new projects already enforce
--     the new default today.
--
-- Fix: grant the two roles the app actually uses — `authenticated` (logged-in
-- staff via PostgREST) and `service_role` (Edge Functions) — on existing
-- tables, and set DEFAULT PRIVILEGES so every future table in `public` inherits
-- the grant automatically.
--
-- `anon` is intentionally EXCLUDED: no pre-login screen reads a table directly
-- (the public unit gallery goes through a SECURITY DEFINER RPC). This is tighter
-- than Supabase's old default, which also granted anon. RLS remains the real
-- security boundary — these grants are only the API-surface ceiling, and a
-- self-registered PENDING account is still denied every row by RLS.
--
-- Idempotent: re-granting existing privileges is a no-op, safe to re-run.
-- =============================================================================

-- Existing tables + sequences.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;

-- Future tables + sequences created by the migration role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
