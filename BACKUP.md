# HomeGuru PMS — Backup Guide (simple)

A plain-language reference for the database backup. Keep it; future-you will thank you.

---

## What it is

- A GitHub Action (`.github/workflows/backup.yml`) backs up the whole database **automatically every day** (02:30 UTC).
- Each backup is **encrypted** (AES-256) and stored as a GitHub **artifact** for **30 days**.
- You don't have to do anything for it to run. It just works in the background.

**Where to see backups:** GitHub repo → **Actions** tab → **Database backup** → open any run → **Artifacts** → `db-backup-<date>`.

**Run one manually anytime:** Actions → Database backup → **Run workflow**.

---

## The two secrets (set once, in GitHub → Settings → Secrets and variables → Actions)

| Secret | What it is |
|---|---|
| `SUPABASE_DB_URL` | Supabase **Session pooler** connection URI (port 5432) with the DB password in it |
| `BACKUP_GPG_PASSPHRASE` | The password that encrypts/decrypts every backup |

> ⚠️ **Save `BACKUP_GPG_PASSPHRASE` in your password manager.** Without it the backups can never be decrypted. (Different from the KVKK/pgcrypto encryption key — don't confuse them.)

---

## If a backup ever fails (red ❌ in Actions)

Open the failed step and match the message:

- **"empty connection string" / socket error** → `SUPABASE_DB_URL` secret is missing/misnamed.
- **host/timeout error** → wrong connection: must be **Session pooler, port 5432** (not Direct, not Transaction pooler 6543).
- **"password authentication failed"** → DB password wrong, or a special char in it needs URL-encoding.
- **"Invalid passphrase"** → `BACKUP_GPG_PASSPHRASE` secret is empty/missing.

Fix the secret, then re-run the workflow.

---

## How to restore a backup (disaster recovery)

You only do this if you actually lose data. Steps are for **Windows + PowerShell + Docker** (no extra installs).

### 1. Download & unzip the backup
GitHub → Actions → a successful Database backup run → Artifacts → download `db-backup-<date>` (a `.zip`).
Then in PowerShell:
```powershell
cd "$env:USERPROFILE\Downloads"
Get-ChildItem db-backup*                                   # find the exact zip name
Expand-Archive ".\db-backup-<date>.zip" -DestinationPath ".\backup-test" -Force
cd ".\backup-test"
Get-ChildItem                                              # you should see backup.dump.gpg
```

### 2. Decrypt it (turns .gpg into a usable .dump)
Replace `YOUR_PASSPHRASE` with your `BACKUP_GPG_PASSPHRASE` value:
```powershell
docker run --rm -e PASS='YOUR_PASSPHRASE' -v ${PWD}:/work -w /work alpine sh -c 'apk add --no-cache gnupg >/dev/null 2>&1 && gpg --batch --pinentry-mode loopback --passphrase "$PASS" -o backup.dump -d backup.dump.gpg'
```
Result: a `backup.dump` file (this is the real database backup — binary, don't open in an editor).

### 3. Check the backup is valid (lists tables, changes nothing)
```powershell
docker run --rm -v ${PWD}:/work -w /work postgres:17-alpine pg_restore -l backup.dump
```
You should see your tables: `reservations`, `guests`, `expenses`, `ledger_entries`, etc.

### 4. Restore into a database
Point `PGCONN` at the **Session pooler URI of the target project** and run:
```powershell
docker run --rm -i -e PGCONN="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" -v ${PWD}:/work -w /work postgres:17-alpine sh -c 'pg_restore --clean --if-exists --no-owner --schema=public -d "$PGCONN" backup.dump'
```
> ⚠️ `--clean --if-exists` **wipes the existing `public` schema first**. Only run it against the project you intend to overwrite (ideally a fresh/empty project). Never test-restore onto your live database.

Staff logins live in Supabase's `auth` schema (not in this dump) — recreate the staff accounts manually after a restore to a fresh project.

---

## The easy alternative (if you ever stop wanting to manage this)

Upgrade to **Supabase Pro (~$25/mo)** → managed daily backups, restore from the dashboard with one click, no GitHub Action, no gpg. Then you can delete `backup.yml` entirely.

---

## Quick reminders

- Backups run automatically — no daily effort needed.
- Keep `BACKUP_GPG_PASSPHRASE` safe; it's the only key to your backups.
- Test a restore (steps above) **once before going live** — a backup you've never decrypted is a risk.
