# Nu-7 database

PostgreSQL schema and tools behind the [roster test site](https://einfachmia161.github.io/roster/). Hosted on Supabase.

## Who can do what

| | Visitor | Login, not linked | Officer (LT and above) | Regimental Command |
| --- | --- | --- | --- | --- |
| Read roster, board, blacklist | yes | yes | yes | yes |
| Log own hours (PVT to CSG, Steam ID + Discord) | yes | yes | – | – |
| See Discord names and the change log | – | – | yes | yes |
| Edit anything | – | – | yes | yes |
| Remove an officer login | – | – | – | yes |

Everything is enforced in the database (row-level security and officer-only functions), not just hidden in the page.
An officer who is demoted below LT or discharged loses edit rights immediately.

## CO registration code

Officers create a login on the site, then link it to their roster entry with their Steam ID and the CO registration code.

- The code is stored only as a bcrypt hash in the `private` schema. That schema is not exposed by the Supabase API and the website roles have no rights on it.
- 5 failed attempts lock a login for 15 minutes; 30 failed attempts across all logins lock linking for everyone for 15 minutes.
- Every failure gives the same message, so nothing can be learned from it.
- Linking is off until a code exists.

**Create or replace the code** (Supabase → SQL Editor):

```sql
select private.new_co_registration_code();
```

The result is shown once and is never stored in plain text. Copy it straight into a private message to your COs. Running it again replaces the code; already linked logins keep working.

**Turn registration off**:

```sql
select private.disable_co_registration();
```

## One-time Supabase settings

Authentication → URL Configuration:

- Site URL: `https://einfachmia161.github.io/roster/`
- Redirect URLs: add `https://einfachmia161.github.io/roster/`

Without this, the confirmation and password-reset emails link to `localhost`.

## Files

| File | Purpose |
| --- | --- |
| `schema.sql` | Tables and calculated views (`v_roster`, `v_promotion_board`, `v_overview`, `v_active_blacklist`) |
| `security.sql` | Officer logins, the hashed registration code, rate limits, the hours form and all officer actions |
| `policies.sql` | Access rules: starts from no rights and grants only what the site needs |
| `import_nu7.py` | Reads the Google Sheet export (File → Download → Web page, `.zip`) and writes `out/data.sql` plus `out/import-report.md` |
| `deploy.py` | Loads `schema.sql`, `out/data.sql`, `security.sql` and `policies.sql`. `--reset` drops all Nu-7 tables first |
| `verify_data.py` | Compares the calculated roster with the values in the sheet's Roster tab |
| `test_db.py` | 32 tests run as visitor, login, officer and Regimental Command, including attack cases; each test is rolled back |

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

`--reset` replaces all roster data and removes officer links (officers link again with the code). The registration code itself is kept.

## Rules worked out from the sheet

- **Hours**: duty logged in the last 7 days plus today; hours rejected by an officer do not count.
- **Status**: LOA/ROA when a leave period covers today; otherwise by hours. Enlisted are Active from 5 h, NCOs and officers from 6 h, Regimental Command always Active. Very-Active from 25 h, Extremely-Active from 30 h (table `setting`).
- **Cooldown**: 4 days after the last promotion, rank bookkeeping or (re)recruitment.
- **Strikes**: summed until they expire or an appeal is granted.
- **Activity and cooldown requirements** are calculated only; all other requirements can be ticked on the promotion board.
- **Hours form**: max 12 h per entry, 16 h per day, dates within the last 6 days, 10 entries per day; 5 wrong Discord names lock that Steam ID for 15 minutes.
