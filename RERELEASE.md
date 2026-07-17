# Re-release runbook

How to stand this codebase up as an **independent app for a new operator**: new
GitHub account, new Supabase project, new branding, and **zero shared data** with
the original HomeGuru deployment.

Work top to bottom. Nothing here touches the existing HomeGuru project — but the
whole point is that the two installs must never share a key, a bucket, or a row,
so the key-rotation step (§4) is not optional.

---

## 0. What is already done in the code

These landed before this runbook and need no action from you:

- Google reservation sync removed (frontend, tables, cron, edge functions).
- Regions are a first-class, admin-managed entity (**Finans → Bölgeler**), each
  with its own kasa. A default region `Genel` is seeded.
- Roles are the core seven: `SUPER_ADMIN`, `PROPERTY_MANAGER`, `RECEPTION`,
  `HOUSEKEEPING`, `YETKILI`, `TEKNIK_PERSONEL`, `PENDING`.
- New signups land as `PENDING` and see **nothing** until approved.
- Photos: 1 per mülk, 1 per sorun, none on birim.
- Backups land in a private `backups` bucket, browsable in-app under **Yedekler**.

---

## 1. Create the accounts

1. **GitHub** — create the new account, then a new repository for this code.
   The repo can be private; GitHub Pages works either way on a free account for
   public repos, and Pages on private repos needs a paid plan. If in doubt, make
   it public — no secret lives in the repo (see §4).
2. **Supabase** — create a new project in the **EU (Frankfurt)** region, on the
   free tier. Save the database password somewhere safe immediately; the
   dashboard will not show it again.

Do **not** reuse the HomeGuru organisation, project, or repo for any of this.

---

## 2. Push the code

This directory is a standalone git repo with no remote. From
`C:\Users\Lrx\Yönetim`:

```bash
git add -A
git commit -m "Initial commit"
git remote add origin https://github.com/<new-account>/<new-repo>.git
git branch -M main
git push -u origin main
```

---

## 3. Stand up the database

Follow [SETUP.md](SETUP.md) §1–§5 against the **new** project:

- enable `pgcrypto`, `btree_gist`, `pg_cron`, `pg_net`;
- run **every** migration in `supabase/migrations/` in numeric order — either by
  pasting them in the SQL editor or, easier, with the CLI:
  `supabase link --project-ref <ref>` then `supabase db push`. The whole chain
  is db-push-safe: `005_seed.sql` is a deliberate no-op (it used to hold
  HomeGuru dev sample data whose kasa rows broke migration 094's
  one-kasa-per-region index — see the comment inside the file);
- set a **fresh** encryption key (§4 below);
- create the first `SUPER_ADMIN`.

> If a push already failed at 094 on this project (seed data applied before
> 005 was neutralized): run `supabase/FIX_SEED_CLEANUP.sql` once in the SQL
> editor, then `supabase db push` again — it resumes from 094.

Then run `supabase/tests/rls_smoke_test.sql` and confirm `ALL TESTS PASSED`.

---

## 4. Rotate every key — never reuse HomeGuru's

Each of these is a **new random value** for the new project. Reusing one would
link the two installs, which is exactly what this re-release exists to avoid.

| Key | Where it lives | How to generate |
|---|---|---|
| KVKK/pgcrypto encryption key | Supabase vault, `pms_encryption_key` | `openssl rand -base64 48` |
| VAPID keypair (web push) | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` function secrets + `VITE_VAPID_PUBLIC_KEY` repo secret | `npx web-push generate-vapid-keys` |
| Push shared secret | `PUSH_SHARED_SECRET` function secret **and** the `push_shared_secret` vault secret — the two must match | `openssl rand -base64 32` |
| Backup GPG passphrase | `BACKUP_GPG_PASSPHRASE` repo secret | `openssl rand -base64 32` |
| Database password | Supabase dashboard | set at project creation |

> The encryption key is unrecoverable. If it is lost, every TC kimlik and
> passport in the database is permanently unreadable. Put it in a password
> manager before you go any further.

### Repo secrets (Settings → Secrets and variables → Actions)

| Name | Notes |
|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` — baked into the bundle |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public by design; RLS is the security boundary |
| `VITE_VAPID_PUBLIC_KEY` | Public half of the new VAPID pair |
| `SUPABASE_DB_URL` | Session pooler URI, port **5432** (see SETUP.md §10) |
| `SUPABASE_URL` | Same as `VITE_SUPABASE_URL`; used by the backup upload |
| `SUPABASE_SERVICE_ROLE_KEY` | **Never** in the client bundle — Actions only |
| `BACKUP_GPG_PASSPHRASE` | The new passphrase from the table above |

---

## 5. Storage buckets

Migration `129` creates the `backups` bucket for you. Create the other two by
hand under **Storage → New bucket**:

| Bucket | Public? | Used by |
|---|---|---|
| `property-photos` | **public** | the single mülk photo |
| `housekeeping-issues` | **public** | the single sorun photo |
| `backups` | **private** — created by migration 129 | the Yedekler screen |

The two photo buckets must be **public**: the app renders them through
`getPublicUrl()` (`src/lib/photos.ts`), which only resolves for a public bucket.
Anyone with the exact URL can therefore open a photo — the paths are random, but
treat the images as semi-public and keep guest documents out of them. `backups`
is the opposite: strictly private, read only by a SUPER_ADMIN through a
short-lived signed URL.

There is **no `unit-photos` bucket** any more — birim photos were removed. Do not
create one.

---

## 6. Deploy the edge function

Only `send-push` remains. It must be deployed **without** JWT verification,
because the database calls it via pg_net with its own shared-secret header:

```bash
supabase functions deploy send-push --no-verify-jwt
supabase secrets set VAPID_SUBJECT='mailto:<your-address>'
supabase secrets set VAPID_PUBLIC_KEY='<new public key>'
supabase secrets set VAPID_PRIVATE_KEY='<new private key>'
supabase secrets set PUSH_SHARED_SECRET='<new shared secret>'
```

Then give the database its three vault secrets, so `_send_push_async` can reach
the function and prove who it is. The shared secret must be **byte-identical** to
the `PUSH_SHARED_SECRET` you just set:

```sql
SELECT vault.create_secret('https://<ref>.supabase.co/functions/v1/send-push', 'send_push_url');
SELECT vault.create_secret('<service_role key>', 'service_role_key');
SELECT vault.create_secret('<new shared secret>', 'push_shared_secret');
```

Both sides fail closed: the function refuses every request while
`PUSH_SHARED_SECRET` is unset, and `_send_push_async` skips with a NOTICE while
any vault secret is missing. Push simply stays off until all of it is in place —
nothing else breaks.

There is **no dashboard webhook to configure**: the database triggers call the
function directly through pg_net using the vault's `send_push_url`. (The
`notifications` table is written BY the function as an audit log — do not put a
webhook on it.)

---

## 7. Branding

The app still ships HomeGuru's name and icons. Before launch:

- `index.html` — `<title>` and meta description
- `vite.config.ts` — the PWA manifest `name` / `short_name` / `theme_color`
- `public/icons/` — replace every icon (see SETUP.md §11)
- `README.md`, and the headings in this file if you like

---

## 8. First run

1. Sign in as the `SUPER_ADMIN` you created.
2. **Finans → Bölgeler** — rename `Genel` if you want, and add the operator's
   real regions. Each one gets its own kasa automatically.
3. **Mülkler → Yeni Mülk** — assign each mülk to its region.
4. Have the staff sign up; approve each from **Personel**, assigning a role and
   either a single region or all regions.
5. **Personel → Rol Bilgisi** explains what each role can do, in plain Turkish —
   worth reading once with the operator.

---

## 9. Before you call it live

- [ ] `rls_smoke_test.sql` → `ALL TESTS PASSED`
- [ ] A manual walkthrough per role, **including a fresh `PENDING` signup** (it
      must see nothing) and a one-region vs all-regions user
- [ ] Money check: a region manager's gider, an avans and a maaş each land in the
      **right region's kasa**
- [ ] The **Database backup** action runs green and the file appears in Yedekler
- [ ] Restore tested once from a real backup (SETUP.md §10)
- [ ] PWA installs on a real iOS and a real Android device
- [ ] Push arrives on both, and a region-scoped manager does **not** get another
      region's notifications
- [ ] Icons and name replaced
- [ ] The wider pre-launch checklist in
      [ARCHITECTURE.md § 18](ARCHITECTURE.md#18-pre-launch-checklist-dont-skip)
      (KVKK review, VERBİS, DPA) — the legal items are not optional in Turkey

---

## Known gaps

- **KBS submission is a stub.** There is no edge function submitting check-ins to
  the police system. If the new operator is legally required to file KBS, this
  must be built before launch.
- **Photo auto-delete is deliberately not implemented** — storage grows forever.
  Watch it weekly on the free tier.
