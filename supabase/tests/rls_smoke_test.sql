-- =============================================================================
-- Yönetim PMS — RLS / finance / region smoke test
-- =============================================================================
-- WHAT: an automated, self-rolling-back check of the invariants that must hold
--       once the 001–137 migration chain has been applied to a fresh project.
--       It covers the re-release changes (regions, 7 roles, PENDING signup, photo
--       caps, Google removal, backups bucket) plus the money-routing, recurring
--       gider and isolation rules those changes touch.
--
-- HOW:  paste the WHOLE file into the Supabase SQL editor and run it once.
--       Expect a final `ALL TESTS PASSED` notice; any failure raises and aborts.
--       Everything runs in one transaction that ends in ROLLBACK, so the database
--       is left exactly as found — safe to run against a live project.
--
-- WHY the role juggling: the SQL editor connects as `postgres`, which BYPASSES
--       RLS. Section C therefore switches to the `authenticated` role and sets a
--       JWT claim (what auth.uid() reads). The fixtures and the routing checks
--       stay as `postgres`, where RLS is out of the way — triggers still fire, so
--       money routing is exercised for real, independently of the policies.
-- =============================================================================

BEGIN;

SET LOCAL search_path = public;

-- -----------------------------------------------------------------------------
-- Harness
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.ok(p_cond boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_label;
  END IF;
  RAISE NOTICE 'PASS  %', p_label;
END;
$fn$;

-- Asserts a statement is REFUSED (by RLS WITH CHECK, a CHECK constraint, an FK, or
-- a RAISE inside an RPC). The EXCEPTION block is an implicit savepoint, so the
-- caught error does not poison the outer transaction.
CREATE OR REPLACE FUNCTION pg_temp.refuses(p_sql text, p_label text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS  % (refused: %)', p_label, replace(SQLERRM, E'\n', ' ');
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % — statement was ALLOWED, expected a refusal', p_label;
END;
$fn$;

-- Impersonate a user for the statements that follow.
CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true);
END;
$fn$;

-- Drop the JWT claim entirely: auth.uid() → NULL, auth_region() → NULL. This is
-- what a pg_cron job sees, and several bugs only appear in that context.
CREATE OR REPLACE FUNCTION pg_temp.act_as_cron()
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
END;
$fn$;

-- -----------------------------------------------------------------------------
-- Fixtures (as postgres — RLS bypassed)
-- -----------------------------------------------------------------------------
-- Ids are fixed constants so a failure is easy to trace and so section C can name
-- them without reading a table it may not have rights to.

CREATE TEMP TABLE t_ids (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t_ids (k, v) VALUES
  ('admin',       '00000000-0000-4000-a000-000000000001'),  -- SUPER_ADMIN
  ('mgr_a',       '00000000-0000-4000-a000-000000000002'),  -- manager, SmokeA only
  ('mgr_all',     '00000000-0000-4000-a000-000000000003'),  -- manager, all regions
  ('pending',     '00000000-0000-4000-a000-000000000004'),  -- PENDING signup
  ('hk_a',        '00000000-0000-4000-a000-000000000005'),  -- housekeeping, SmokeA
  ('yetkili_all', '00000000-0000-4000-a000-000000000006');  -- YETKILI + all_regions

CREATE TEMP TABLE t_props (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t_props (k, v) VALUES
  ('a', '00000000-0000-4000-b000-000000000001'),            -- mülk in SmokeA
  ('b', '00000000-0000-4000-b000-000000000002');            -- mülk in SmokeB

-- Section C runs as `authenticated`, which does not own these temp tables.
GRANT SELECT ON t_ids, t_props TO PUBLIC;

CREATE OR REPLACE FUNCTION pg_temp.uid(p_k text) RETURNS uuid
LANGUAGE sql STABLE AS $fn$ SELECT v FROM pg_temp.t_ids WHERE k = p_k $fn$;

CREATE OR REPLACE FUNCTION pg_temp.prop(p_k text) RETURNS uuid
LANGUAGE sql STABLE AS $fn$ SELECT v FROM pg_temp.t_props WHERE k = p_k $fn$;

-- The kasa of a region, by name — the expected value in the routing checks.
CREATE OR REPLACE FUNCTION pg_temp.kasa(p_region text) RETURNS uuid
LANGUAGE sql STABLE AS $fn$ SELECT id FROM cash_accounts WHERE region = p_region $fn$;

-- auth.users — a minimal insert; every other column defaults. If handle_new_user()
-- is installed it also creates a PENDING staff_profiles row per user, which the
-- upserts below then settle into the intended shape.
INSERT INTO auth.users (id, email)
SELECT v, k || '@smoketest.invalid' FROM t_ids
ON CONFLICT (id) DO NOTHING;

-- The admin must exist AND be impersonated before create_region, which checks
-- auth_role() = 'SUPER_ADMIN'.
SELECT pg_temp.act_as(pg_temp.uid('admin'));

INSERT INTO staff_profiles (user_id, full_name, role, region, all_regions, access_scope)
VALUES (pg_temp.uid('admin'), 'Smoke Admin', 'SUPER_ADMIN', 'Genel', true, 'ALL')
ON CONFLICT (user_id) DO UPDATE
  SET role = EXCLUDED.role, region = EXCLUDED.region,
      all_regions = EXCLUDED.all_regions, full_name = EXCLUDED.full_name,
      access_scope = EXCLUDED.access_scope, deleted_at = NULL;

-- Two test regions, created through the RPC so the real path is exercised.
SELECT create_region('SmokeA');
SELECT create_region('SmokeB');

INSERT INTO staff_profiles (user_id, full_name, role, region, all_regions, access_scope, salary)
VALUES
  (pg_temp.uid('mgr_a'),       'Smoke Mgr A',   'PROPERTY_MANAGER', 'SmokeA', false, 'ALL', NULL),
  (pg_temp.uid('mgr_all'),     'Smoke Mgr All', 'PROPERTY_MANAGER', 'Genel',  true,  'ALL', NULL),
  (pg_temp.uid('pending'),     'Smoke Pending', 'PENDING',          'Genel',  false, 'ALL', NULL),
  (pg_temp.uid('hk_a'),        'Smoke HK A',    'HOUSEKEEPING',     'SmokeA', false, 'ALL', 1000),
  (pg_temp.uid('yetkili_all'), 'Smoke Yetkili', 'YETKILI',          'SmokeA', true,  'ALL', NULL)
ON CONFLICT (user_id) DO UPDATE
  SET role = EXCLUDED.role, region = EXCLUDED.region,
      all_regions = EXCLUDED.all_regions, full_name = EXCLUDED.full_name,
      access_scope = EXCLUDED.access_scope, salary = EXCLUDED.salary, deleted_at = NULL;

-- One mülk per test region.
INSERT INTO properties (id, name, type, region) VALUES
  (pg_temp.prop('a'), 'Smoke Mülk A', 'APARTMENT', 'SmokeA'),
  (pg_temp.prop('b'), 'Smoke Mülk B', 'APARTMENT', 'SmokeB');

-- =============================================================================
-- A. Structure — the re-release changes actually landed
-- =============================================================================

SELECT pg_temp.ok(
  (SELECT count(*) FROM regions WHERE is_default) = 1,
  'A1  exactly one default region');

SELECT pg_temp.ok(
  (SELECT is_default FROM regions WHERE name = 'Genel'),
  'A2  Genel is the seeded default region');

-- 7 roles: the two _BORNOVA variants are gone. Probed through the constraint so
-- this fails if the CHECK is ever widened by hand.
SELECT pg_temp.refuses(format($sql$
  UPDATE staff_profiles SET role = 'YONETICI_BORNOVA' WHERE user_id = %L
$sql$, pg_temp.uid('hk_a')), 'A3  role YONETICI_BORNOVA is rejected');

SELECT pg_temp.refuses(format($sql$
  UPDATE staff_profiles SET role = 'PERSONEL_BORNOVA' WHERE user_id = %L
$sql$, pg_temp.uid('hk_a')), 'A4  role PERSONEL_BORNOVA is rejected');

-- ...and every one of the 7 intended roles is accepted.
DO $do$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['SUPER_ADMIN','PROPERTY_MANAGER','RECEPTION',
                           'HOUSEKEEPING','YETKILI','TEKNIK_PERSONEL','PENDING'] LOOP
    UPDATE staff_profiles SET role = r WHERE user_id = pg_temp.uid('hk_a');
  END LOOP;
  -- restore the fixture for the later sections
  UPDATE staff_profiles SET role = 'HOUSEKEEPING', all_regions = false
   WHERE user_id = pg_temp.uid('hk_a');
  PERFORM pg_temp.ok(true, 'A5  all 7 intended roles are accepted');
END;
$do$;

-- Google feature fully removed.
SELECT pg_temp.ok(to_regclass('public.pending_google_reservations') IS NULL,
  'A6  pending_google_reservations table is gone');
SELECT pg_temp.ok(to_regclass('public.google_oauth_tokens') IS NULL,
  'A7  google_oauth_tokens table is gone');
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = '_run_google_pull'),
  'A8  _run_google_pull() is gone');

-- Guarded: pg_cron may not be installed on every project.
DO $do$
DECLARE n int := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$ SELECT count(*) FROM cron.job WHERE jobname = 'homeguru-google-pull' $q$ INTO n;
  END IF;
  PERFORM pg_temp.ok(n = 0, 'A9  the google pull cron job is unscheduled');
END;
$do$;

-- Photos: the unit gallery is unwound, the caps are in place.
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'units'
                 AND column_name = 'photo_paths'),
  'A10 units.photo_paths is dropped');
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'get_public_unit_gallery'),
  'A11 get_public_unit_gallery() is gone');

SELECT pg_temp.refuses($sql$
  INSERT INTO properties (name, type, region, photo_paths)
  VALUES ('Smoke 2 foto', 'APARTMENT', 'SmokeA', ARRAY['a.jpg','b.jpg'])
$sql$, 'A12 a mülk with 2 photos is rejected');

DO $do$
BEGIN
  INSERT INTO properties (name, type, region, photo_paths)
  VALUES ('Smoke 1 foto', 'APARTMENT', 'SmokeA', ARRAY['a.jpg']);
  PERFORM pg_temp.ok(true, 'A13 a mülk with 1 photo is accepted');
END;
$do$;

-- Region columns are mandatory and referential.
SELECT pg_temp.ok(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'region' AND is_nullable = 'NO'
      AND table_name IN ('properties','staff_profiles','cash_accounts','expenses')) = 4,
  'A14 region is NOT NULL on all four region-carrying tables');

SELECT pg_temp.ok(
  (SELECT count(*) FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'regions'::regclass) >= 4,
  'A15 all four tables carry an FK to regions');

SELECT pg_temp.refuses($sql$
  INSERT INTO properties (name, type, region)
  VALUES ('Smoke yok bölge', 'APARTMENT', 'YokBoyleBirBolge')
$sql$, 'A16 a mülk in a non-existent region is rejected');

-- Backups bucket: present and private.
SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'backups' AND public = false),
  'A17 the backups bucket exists and is private');

-- =============================================================================
-- B. Region RPCs
-- =============================================================================

SELECT pg_temp.ok(
  (SELECT count(*) FROM cash_accounts WHERE region = 'SmokeA') = 1
  AND (SELECT name FROM cash_accounts WHERE region = 'SmokeA') = 'SmokeA',
  'B1  create_region made exactly one kasa, named after the region');

SELECT pg_temp.refuses(format($sql$ SELECT delete_region(%L) $sql$,
  (SELECT id FROM regions WHERE is_default)),
  'B2  delete_region refuses the default region');

-- (There is no B3 any more: since migration 136, a mülk-holding region is
-- deletable — the mülks' ties break and they move to the default region. That
-- behaviour, plus the kasa-movement and active-staff refusals, is covered in
-- section G with a throwaway region, so SmokeB survives for sections C/D.)

-- A rename fans out through the ON UPDATE CASCADE FK and re-labels the kasa.
SELECT rename_region((SELECT id FROM regions WHERE name = 'SmokeB'), 'SmokeB2');
SELECT pg_temp.ok(
  (SELECT region FROM properties WHERE id = pg_temp.prop('b')) = 'SmokeB2',
  'B4  rename_region cascades to properties.region');
SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM cash_accounts WHERE region = 'SmokeB2' AND name = 'SmokeB2'),
  'B5  rename_region re-labels the region kasa');
SELECT rename_region((SELECT id FROM regions WHERE name = 'SmokeB2'), 'SmokeB');

-- Only the admin may manage regions.
SELECT pg_temp.act_as(pg_temp.uid('mgr_all'));
SELECT pg_temp.refuses($sql$ SELECT create_region('SmokeHack') $sql$,
  'B6  an all-region PROPERTY_MANAGER cannot create a region');
SELECT pg_temp.act_as(pg_temp.uid('admin'));

-- =============================================================================
-- C. Isolation — real RLS, as the `authenticated` role
-- =============================================================================

SET LOCAL ROLE authenticated;

-- A PENDING signup sees nothing at all. This is the gate the whole open-signup
-- model rests on, so it is checked table by table rather than in aggregate.
SELECT pg_temp.act_as(pg_temp.uid('pending'));
SELECT pg_temp.ok((SELECT count(*) FROM properties)    = 0, 'C1  PENDING sees zero mülk');
SELECT pg_temp.ok((SELECT count(*) FROM guests)        = 0, 'C2  PENDING sees zero misafir');
SELECT pg_temp.ok((SELECT count(*) FROM reservations)  = 0, 'C3  PENDING sees zero rezervasyon');
SELECT pg_temp.ok((SELECT count(*) FROM expenses)      = 0, 'C4  PENDING sees zero gider');
SELECT pg_temp.ok((SELECT count(*) FROM cash_accounts) = 0, 'C5  PENDING sees zero kasa');

-- A region-scoped manager sees their own region only.
SELECT pg_temp.act_as(pg_temp.uid('mgr_a'));
SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM properties WHERE id = pg_temp.prop('a')),
  'C6  region manager sees their own region''s mülk');
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM properties WHERE id = pg_temp.prop('b')),
  'C7  region manager does NOT see another region''s mülk');
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM cash_accounts WHERE region = 'SmokeB'),
  'C8  region manager does NOT see another region''s kasa');

-- ...and cannot push money into a region they don't own (expenses_insert, 102).
SELECT pg_temp.refuses($sql$
  INSERT INTO expenses (property_id, category, amount, expense_date, region,
                        approval_status, is_recurring, paid_from_kasa)
  VALUES (NULL, 'Smoke', 10, current_date, 'SmokeB', 'pending', false, true)
$sql$, 'C9  region manager cannot file a gider into another region');

-- An all-region manager sees every region.
SELECT pg_temp.act_as(pg_temp.uid('mgr_all'));
SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM properties WHERE id = pg_temp.prop('a'))
  AND EXISTS (SELECT 1 FROM properties WHERE id = pg_temp.prop('b')),
  'C10 all-region manager sees every region''s mülk');
SELECT pg_temp.ok(
  (SELECT count(*) FROM cash_accounts WHERE region IN ('SmokeA','SmokeB')) = 2,
  'C11 all-region manager sees every region''s kasa');

-- all_regions is VISIBILITY only — it must not hand a non-manager the kasa.
-- (auth_sees_all_regions stays manager-gated; auth_all_regions does not.)
SELECT pg_temp.act_as(pg_temp.uid('yetkili_all'));
SELECT pg_temp.ok((SELECT count(*) FROM cash_accounts) = 0,
  'C12 an all-region YETKILI still sees zero kasa');

SELECT pg_temp.act_as(pg_temp.uid('hk_a'));
SELECT pg_temp.ok((SELECT count(*) FROM cash_accounts) = 0,
  'C13 HOUSEKEEPING sees zero kasa');

RESET ROLE;

-- =============================================================================
-- D. Money routing — every lira lands in the right region's kasa
-- =============================================================================

-- A region manager's GENEL (mülksüz) gider → THEIR region's kasa. This is the one
-- a column DEFAULT on expenses.region would silently break: the default would
-- arrive before set_expense_region()'s BEFORE trigger and defeat its
-- COALESCE(NEW.region, auth_region()), sending the gider to Genel instead.
SELECT pg_temp.act_as(pg_temp.uid('mgr_a'));
CREATE TEMP TABLE t_exp_genel AS
  SELECT * FROM record_expense(
    NULL::uuid, 'Smoke Genel', 100::numeric, 'smoke genel gider',
    current_date, false, true, NULL::smallint, NULL::text);

SELECT pg_temp.ok(
  (SELECT region FROM t_exp_genel) = 'SmokeA',
  'D1  a region manager''s genel gider is stamped with THEIR region');

SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT approve_expense((SELECT id FROM t_exp_genel));
SELECT pg_temp.ok(
  (SELECT ct.cash_account_id FROM cash_transactions ct
    WHERE ct.ref_type = 'expense' AND ct.ref_id = (SELECT id FROM t_exp_genel))
  = pg_temp.kasa('SmokeA'),
  'D2  the approved genel gider hits the manager''s region kasa');

-- A MÜLK gider follows the mülk's region, whoever files it (the admin is 'Genel').
CREATE TEMP TABLE t_exp_mulk AS
  SELECT * FROM record_expense(
    pg_temp.prop('b'), 'Smoke Mülk', 250::numeric, 'smoke mülk gider',
    current_date, false, true, NULL::smallint, NULL::text);

SELECT pg_temp.ok(
  (SELECT region FROM t_exp_mulk) = 'SmokeB',
  'D3  a mülk gider inherits the mülk''s region, not the filer''s');

SELECT approve_expense((SELECT id FROM t_exp_mulk));
SELECT pg_temp.ok(
  (SELECT ct.cash_account_id FROM cash_transactions ct
    WHERE ct.ref_type = 'expense' AND ct.ref_id = (SELECT id FROM t_exp_mulk))
  = pg_temp.kasa('SmokeB'),
  'D4  the approved mülk gider hits the mülk''s region kasa');

-- AVANS → the RECIPIENT's home-region kasa, not the payer's. The admin sits in
-- 'Genel' and pays a SmokeA staffer: the money must leave SmokeA.
CREATE TEMP TABLE t_adv AS
  WITH ins AS (
    INSERT INTO staff_advances (user_id, amount, note, created_by)
    VALUES (pg_temp.uid('hk_a'), 500, 'smoke avans', pg_temp.uid('admin'))
    RETURNING id
  ) SELECT id FROM ins;

SELECT pg_temp.ok(
  (SELECT ct.cash_account_id FROM cash_transactions ct
    WHERE ct.ref_type = 'staff_advance' AND ct.ref_id = (SELECT id FROM t_adv))
  = pg_temp.kasa('SmokeA'),
  'D5  avans comes out of the RECIPIENT''s region kasa');

-- MAAŞ → likewise (the reroute trigger from migration 112).
CREATE TEMP TABLE t_sal AS
  SELECT * FROM pay_staff_salary(
    pg_temp.uid('hk_a'), 1000::numeric,
    date_trunc('month', current_date)::date, 'smoke maaş');

SELECT pg_temp.ok(
  (SELECT ct.cash_account_id
     FROM staff_salary_payments ssp
     JOIN cash_transactions ct ON ct.id = ssp.cash_tx_id
    WHERE ssp.id = (SELECT id FROM t_sal))
  = pg_temp.kasa('SmokeA'),
  'D6  maaş comes out of the RECIPIENT''s region kasa');

SELECT pg_temp.ok(
  (SELECT cash_account_id FROM t_sal) = pg_temp.kasa('SmokeA'),
  'D7  the salary row''s denormalised kasa matches the cash_tx');

-- kasa_for_region falls back to the DEFAULT region's kasa — not to a NULL-region
-- kasa (which no longer exists) and not to whichever row happens to sort first.
SELECT pg_temp.ok(
  kasa_for_region('YokBoyleBirBolge')
  = (SELECT ca.id FROM cash_accounts ca JOIN regions r ON r.name = ca.region
      WHERE r.is_default),
  'D8  kasa_for_region falls back to the default region''s kasa');

-- =============================================================================
-- E. Region assignment guards (migration 131)
-- =============================================================================

UPDATE staff_profiles
   SET role = 'TEKNIK_PERSONEL', all_regions = false
 WHERE user_id = pg_temp.uid('hk_a');

SELECT pg_temp.ok(
  (SELECT all_regions FROM staff_profiles WHERE user_id = pg_temp.uid('hk_a')),
  'E1  TEKNIK_PERSONEL is pinned to all_regions whatever the write path');

-- =============================================================================
-- F. Düzenli (recurring) giderler (migration 133)
-- =============================================================================

SELECT pg_temp.act_as(pg_temp.uid('admin'));

-- F1 — the template's date always carries its tekrar günü. Asked for the 10th
-- with tekrar günü 15, the row must store the 15th of that same month.
CREATE TEMP TABLE t_tpl_day AS
  SELECT * FROM record_expense(
    NULL::uuid, 'Smoke Kira', 500::numeric, 'gün hizalama',
    make_date(EXTRACT(YEAR FROM current_date)::int, EXTRACT(MONTH FROM current_date)::int, 10),
    true, true, 15::smallint, 'SmokeA'::text);

SELECT pg_temp.ok(
  (SELECT EXTRACT(DAY FROM expense_date)::int FROM t_tpl_day) = 15,
  'F1  a düzenli template''s date is pinned to its tekrar günü');

-- F5 — a düzenli created by someone who could approve it anyway is born APPROVED
-- with its kasa OUT already written: no onay click for month 1 (migration 134).
SELECT pg_temp.ok(
  (SELECT approval_status FROM t_tpl_day) = 'approved',
  'F5a a Yönetici''s düzenli gider is born approved, not pending');

SELECT pg_temp.ok(
  (SELECT ct.cash_account_id FROM cash_transactions ct
    WHERE ct.ref_type = 'expense' AND ct.ref_id = (SELECT id FROM t_tpl_day))
  = pg_temp.kasa('SmokeA'),
  'F5b its kasa OUT is written immediately, into its own region''s kasa');

-- F2 — the cron regression. A GENEL (mülksüz) düzenli gider whose start month has
-- passed must generate this month's instance IN THE TEMPLATE'S REGION. Before
-- migration 133 the instance carried no region, set_expense_region() fell back to
-- auth_region() — NULL under the cron — and the NOT NULL from migration 124 made
-- every run raise, so no düzenli gider posted at all.
CREATE TEMP TABLE t_tpl_past AS
  SELECT * FROM record_expense(
    NULL::uuid, 'Smoke Düzenli', 300::numeric, 'geçmiş ayda başlayan',
    (date_trunc('month', current_date) - interval '1 month')::date,
    true, true, 1::smallint, 'SmokeA'::text);

-- F3 — a template that starts NEXT month must not be back-posted into this one.
CREATE TEMP TABLE t_tpl_future AS
  SELECT * FROM record_expense(
    NULL::uuid, 'Smoke Gelecek', 400::numeric, 'gelecek ayda başlayan',
    (date_trunc('month', current_date) + interval '1 month')::date,
    true, true, 1::smallint, 'SmokeA'::text);

-- F6 — a YETKILI cannot review, so their düzenli still goes to onay once. Dated
-- last month with tekrar günü 1, so ONLY its pending status can keep the
-- generator away from it.
SELECT pg_temp.act_as(pg_temp.uid('yetkili_all'));
CREATE TEMP TABLE t_tpl_yetkili AS
  SELECT * FROM record_expense(
    NULL::uuid, 'Smoke Personel Düzenli', 200::numeric, 'onaya düşmeli',
    (date_trunc('month', current_date) - interval '1 month')::date,
    true, true, 1::smallint, 'SmokeA'::text);
SELECT pg_temp.act_as(pg_temp.uid('admin'));

SELECT pg_temp.ok(
  (SELECT approval_status FROM t_tpl_yetkili) = 'pending',
  'F6  a YETKILI''s düzenli gider still goes to onay');

-- Run the generator exactly as pg_cron does: no JWT, no auth.uid(), no region.
SELECT pg_temp.act_as_cron();
SELECT generate_recurring_expenses();
SELECT pg_temp.act_as(pg_temp.uid('admin'));

SELECT pg_temp.ok(
  (SELECT count(*) FROM expenses
    WHERE recurring_source_id = (SELECT id FROM t_tpl_past)
      AND date_trunc('month', expense_date)::date = date_trunc('month', current_date)::date) = 1,
  'F2a the cron generates this month''s instance for a started düzenli');

SELECT pg_temp.ok(
  (SELECT region FROM expenses
    WHERE recurring_source_id = (SELECT id FROM t_tpl_past)
      AND date_trunc('month', expense_date)::date = date_trunc('month', current_date)::date)
  = 'SmokeA',
  'F2b the generated instance carries the TEMPLATE''s region, not NULL');

SELECT pg_temp.ok(
  (SELECT ct.cash_account_id FROM cash_transactions ct
    JOIN expenses e ON e.id = ct.ref_id
   WHERE ct.ref_type = 'expense'
     AND e.recurring_source_id = (SELECT id FROM t_tpl_past)
     AND date_trunc('month', e.expense_date)::date = date_trunc('month', current_date)::date)
  = pg_temp.kasa('SmokeA'),
  'F2c the generated instance''s kasa movement hits the template''s region kasa');

SELECT pg_temp.ok(
  (SELECT count(*) FROM expenses
    WHERE recurring_source_id = (SELECT id FROM t_tpl_future)) = 0,
  'F3  a düzenli that starts next month is NOT back-posted into this one');

-- F7 — the money bug (migration 134). An unapproved template is otherwise fully
-- due, so if the generator ignored approval_status it would charge the kasa here.
-- The same guard is what makes a REJECTED template stop costing money.
SELECT pg_temp.ok(
  (SELECT count(*) FROM expenses
    WHERE recurring_source_id = (SELECT id FROM t_tpl_yetkili)) = 0,
  'F7  an unapproved template never materialises a kasa gider');

-- F4 — "Kasaya işle" refuses the not-yet-started template with its own message.
SELECT pg_temp.refuses(format($sql$ SELECT post_recurring_instance_now(%L) $sql$,
  (SELECT id FROM t_tpl_future)),
  'F4  Kasaya işle refuses a düzenli that starts later');

-- =============================================================================
-- G. Bölge silme (migration 136) — kasa movement blocks; mülk ties break
-- =============================================================================

SELECT pg_temp.act_as(pg_temp.uid('admin'));

-- G1 — SmokeA's kasa has movements (section D posted giderler into it), so the
-- region must refuse deletion with the kasa-hareketi message.
SELECT pg_temp.refuses(format($sql$ SELECT delete_region(%L) $sql$,
  (SELECT id FROM regions WHERE name = 'SmokeA')),
  'G1  a region whose kasa has movements cannot be deleted');

-- G2 — a mülk does NOT block: the delete breaks its tie, parks it on the
-- default region, and returns its name for the UI's re-pick notice. A pending
-- gider in the region must move with it (no kasa movement involved).
SELECT create_region('SmokeSil');
INSERT INTO properties (name, type, region)
VALUES ('Smoke Sil Mülk', 'APARTMENT', 'SmokeSil');

CREATE TEMP TABLE t_exp_sil AS
  SELECT * FROM record_expense(
    NULL::uuid, 'Smoke Sil Gider', 50::numeric, 'bölgeyle taşınmalı',
    current_date, false, true, NULL::smallint, 'SmokeSil'::text);

CREATE TEMP TABLE t_del AS
  SELECT delete_region((SELECT id FROM regions WHERE name = 'SmokeSil')) AS moved;

SELECT pg_temp.ok(
  (SELECT moved FROM t_del) = ARRAY['Smoke Sil Mülk']::text[],
  'G2a deleting a mülk-holding region succeeds and returns the mülk names');

SELECT pg_temp.ok(
  (SELECT region FROM properties WHERE name = 'Smoke Sil Mülk')
  = (SELECT name FROM regions WHERE is_default),
  'G2b the freed mülk is parked on the DEFAULT region');

SELECT pg_temp.ok(
  (SELECT region FROM expenses WHERE id = (SELECT id FROM t_exp_sil))
  = (SELECT name FROM regions WHERE is_default),
  'G2c the region''s pending gider moved to the default region with it');

-- G3 — the region and its kasa are fully gone.
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM regions WHERE name = 'SmokeSil')
  AND NOT EXISTS (SELECT 1 FROM cash_accounts WHERE region = 'SmokeSil'),
  'G3  the deleted region and its kasa no longer exist');

-- G4 — ACTIVE staff still block (their home region routes maaş/avans money).
SELECT create_region('SmokeStaffBolge');
UPDATE staff_profiles SET region = 'SmokeStaffBolge'
 WHERE user_id = pg_temp.uid('pending');

SELECT pg_temp.refuses(format($sql$ SELECT delete_region(%L) $sql$,
  (SELECT id FROM regions WHERE name = 'SmokeStaffBolge')),
  'G4  a region with active staff cannot be deleted');

UPDATE staff_profiles SET region = 'Genel'
 WHERE user_id = pg_temp.uid('pending');

-- G5 — the default region itself can never be deleted.
SELECT pg_temp.refuses(format($sql$ SELECT delete_region(%L) $sql$,
  (SELECT id FROM regions WHERE is_default)),
  'G5  the default region cannot be deleted');

-- =============================================================================

DO $do$
BEGIN
  RAISE NOTICE '%', repeat('=', 60);
  RAISE NOTICE 'ALL TESTS PASSED';
  RAISE NOTICE '%', repeat('=', 60);
END;
$do$;

-- Nothing above survives: the fixtures, both Smoke regions and their kasa, and
-- every test gider / avans / maaş disappear with this ROLLBACK.
ROLLBACK;
