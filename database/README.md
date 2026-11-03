# Nu-7 database

PostgreSQL schema and tools behind the [roster test site](https://einfachmia161.github.io/roster/). Hosted on Supabase.

## Who can do what

| | Visitor | Member (Steam ID + Discord) | Officer (LT and above) | Regimental Command |
| --- | --- | --- | --- | --- |
| Read roster, board, blacklist | yes | yes | yes | yes |
| Log own hours (PVT to CSG) | – | yes | – | – |
| See own file, request LOA/ROA | – | yes | yes | yes |
| Log trainings and tryouts as host (CPL and above) | – | yes | yes | yes |
| CO area, Discord names, change log, officer notes | – | – | yes | yes |
| Edit anything, decide leave requests | – | – | yes | yes |
| Regimental Command-only notes, links and documents | – | – | – | yes |
| Remove an officer login | – | – | – | yes |

Everything is enforced in the database (row-level security and checked functions), not just hidden in the page.
An officer who is demoted below LT or discharged loses edit rights immediately.
Members-area forms lock a Steam ID for 15 minutes after 5 wrong Discord names.

## One-time setup in Supabase

### 1. CO registration code (required for officer logins)

SQL Editor:

```sql
select private.new_co_registration_code();
```

The code is shown once and only its bcrypt hash is stored, in the `private` schema that the API cannot reach.
Send it to your COs privately. Running it again replaces the code; `select private.disable_co_registration();` turns linking off.

### 2. Login redirect (required)

Authentication → URL Configuration: Site URL `https://einfachmia161.github.io/roster/`, and add the same address under Redirect URLs.

### 3. Email alerts (optional)

1. Create a free account at resend.com and an API key ("Sending access").
2. SQL Editor (the key goes straight into Supabase's encrypted Vault):

```sql
select vault.create_secret('re_your_key_here', 'nu7_resend_api_key');
select private.set_alert_email('the address you signed up to Resend with');
```

Without your own domain, Resend only delivers to the address of your Resend account.

### 4. Discord notifications (optional)

Discord: channel settings → Integrations → Webhooks → New webhook → copy URL. Then:

```sql
select vault.create_secret('https://discord.com/api/webhooks/…', 'nu7_discord_webhook');
```

Posts: promotions and demotions, new strikes, new officer logins, leave requests, passed tryouts, and the daily summary.
Mentions are switched off, so no message can ping @everyone.

### 5. Discord login (optional)

1. discord.com/developers/applications → New Application → OAuth2: copy Client ID and Client Secret, add the redirect `https://vkqrvppfwqjmxxtjowbn.supabase.co/auth/v1/callback`.
2. Supabase → Authentication → Sign In / Providers → Discord: switch on, paste ID and secret.

Officers still link their login with the registration code.

To change or remove a stored secret later: Supabase → Project Settings → Vault.

## Daily jobs (pg_cron, UTC)

| Job | When | What |
| --- | --- | --- |
| `nu7-daily-alerts` | 18:00 | Email + Discord report: low hours, trainings/tryouts below goal, NCOs without a training in 14 days, leave requests waiting, leave ending, members ready for promotion. Nothing is sent when there is nothing to report. |
| `nu7-daily-snapshot` | 03:30 | Copies every roster table into `private.snapshot` (kept 14 days). |

Goals are in the `setting` table (`min_trainings_week`, `min_tryouts_week`, `snapshot_keep_days`). The same alerts are on the site under CO area → Alerts.

## Backups

**In the database (protection against mistakes and vandalism)**

```sql
select taken_at, table_name, row_count from private.snapshot order by taken_at desc;
select * from private.snapshot_rows('duty_log', '2026-11-03');   -- rows of one table on one day
```

**Nightly encrypted backup on GitHub (protection against losing the project)**

`.github/workflows/backup.yml` dumps the database every night at 02:15 UTC, encrypts it with AES-256 and keeps it 30 days as a workflow artifact.
Add two repository secrets (Settings → Secrets and variables → Actions):

- `SUPABASE_DB_URL`: the Session pooler connection string with the password filled in
- `BACKUP_PASSPHRASE`: a long random passphrase (20+ characters). Store a copy safely; without it the backups cannot be opened.

Run it once by hand: Actions → Nightly database backup → Run workflow.

Restore into a new, empty Supabase project:

```bash
gpg --decrypt nu7-2026-11-03.sql.gz.gpg | gunzip > nu7.sql
psql "<connection string of the new project>" -f nu7.sql
```

## Files

| File | Purpose |
| --- | --- |
| `schema.sql` | Tables and calculated views (`v_roster`, `v_promotion_board`, `v_overview`, `v_active_blacklist`) |
| `security.sql` | Officer logins, the hashed registration code, rate limits, the hours form and officer actions |
| `features.sql` | CO area, members area (my file, leave requests, trainings, tryouts), alerts, notifications, snapshots, schedules |
| `policies.sql` | Access rules: starts from no rights and grants only what the site needs; private document storage |
| `import_nu7.py` | Reads the Google Sheet export (File → Download → Web page, `.zip`) and writes `out/data.sql` plus `out/import-report.md` |
| `deploy.py` | Loads all SQL files in order. `--reset` drops all Nu-7 tables first |
| `verify_data.py` | Compares the calculated roster with the values in the sheet's Roster tab |
| `test_db.py` | 49 tests run as visitor, login, officer and Regimental Command, including attack cases; each test is rolled back |

`out/` is not in this repository: it contains the full personnel data.

## Rebuild from a new sheet export

```bash
pip install "psycopg[binary]==3.2.3"
python import_nu7.py "[UK] MTF Nu-7 Roster.zip" out
set PGPASSWORD=<database password>
python deploy.py --reset
python verify_data.py "[UK] MTF Nu-7 Roster.zip"
python test_db.py
```

`--reset` replaces all roster data and removes officer links, CO notes, links and documents. The registration code, Vault secrets and snapshots are kept.

## Rules worked out from the sheet

- **Hours**: duty logged in the last 7 days plus today; hours rejected by an officer do not count.
- **Status**: LOA/ROA when a leave period covers today; otherwise by hours. Enlisted are Active from 5 h, NCOs and officers from 6 h, Regimental Command always Active. Very-Active from 25 h, Extremely-Active from 30 h.
- **Cooldown**: 4 days after the last promotion, rank bookkeeping or (re)recruitment.
- **Strikes**: summed until they expire or an appeal is granted.
- **Promotion board**: activity and cooldown are calculated only; hosted trainings (14 days), tryouts and basic training come from the logs; everything else is ticked by officers.
- **Limits**: hours max 12 per entry / 16 per day, dates within the last 6 days; leave max 60 days, one open request at a time; trainings 1–40 attendees.
