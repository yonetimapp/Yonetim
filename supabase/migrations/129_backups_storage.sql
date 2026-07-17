-- =============================================================================
-- Yönetim PMS — migration 129
-- Private "backups" storage bucket for the browsable cloud backup.
-- =============================================================================
-- Re-release change #3 (DB side). The daily job (GitHub Action) uploads a full
-- DB dump + per-table CSVs here using the SERVICE key (bypasses RLS). Only a
-- SUPER_ADMIN may list/download them — from the in-app Yedekler screen (signed
-- URLs) or the Supabase dashboard. The CSVs contain guest PII, so the bucket is
-- strictly private (public = false) and there is NO authenticated INSERT/UPDATE/
-- DELETE policy — writes come only from the service key.
--
-- NOTE: if the SQL editor lacks rights to modify the storage schema on some
-- projects, create the bucket in Dashboard → Storage (Public: OFF) and add the
-- SELECT policy below via Dashboard → Storage → Policies. See SETUP.md.
-- =============================================================================

-- 1. The private bucket.
INSERT INTO storage.buckets (id, name, public)
VALUES ('backups', 'backups', false)
ON CONFLICT (id) DO NOTHING;

-- 2. SUPER_ADMIN-only read (covers list() + createSignedUrl()). No write policy:
--    the daily job's service key bypasses RLS, and no one else may upload.
-- auth_role() is schema-qualified: storage-schema RLS is not guaranteed to have
-- `public` on its search_path (unlike public-table policies).
DROP POLICY IF EXISTS backups_super_admin_read ON storage.objects;
CREATE POLICY backups_super_admin_read ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'backups' AND public.auth_role() = 'SUPER_ADMIN');
