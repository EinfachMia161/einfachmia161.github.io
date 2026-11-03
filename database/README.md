# Nu-7 database

PostgreSQL schema and tools behind the [roster test site](https://einfachmia161.github.io/roster/). Hosted on Supabase.

## Files

| File | Purpose |
| --- | --- |
| `schema.sql` | Tables, calculated views (`v_roster`, `v_promotion_board`, `v_overview`, `v_active_blacklist`) and the actions the site calls (`change_rank`, `add_member`, `discharge_member`) |
| `policies.sql` | Access rules for the test site: everyone can read; roster tables can be edited; only log entries and requirement ticks can be deleted; every change is written to `audit_log` |
| `import_nu7.py` | Reads the Google Sheet export (File → Download → Web page, `.zip`) and writes `out/data.sql` plus `out/import-report.md` with every decision it had to make |
| `deploy.py` | Loads `schema.sql`, `out/data.sql` and `policies.sql`. `--reset` drops all Nu-7 tables first |
| `verify_data.py` | Compares the database's calculated roster with the values in the sheet's Roster tab |
| `test_db.py` | 25 tests that run as the website's role; each test is rolled back |

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

`--reset` replaces everything, including changes made on the website since the last import.

## Rules worked out from the sheet

- **Hours**: duty logged in the last 7 days plus today.
- **Status**: LOA/ROA when a leave period covers today; otherwise by hours. Enlisted are Active from 5 h, NCOs and officers from 6 h, Regimental Command always Active. Very-Active from 25 h, Extremely-Active from 30 h (table `setting`).
- **Cooldown**: 4 days after the last promotion, rank bookkeeping or (re)recruitment.
- **Strikes**: summed until they expire or an appeal is granted.
- **Activity and cooldown requirements** are calculated only; all other requirements can be ticked on the promotion board.

## Before real use

The test site lets anyone with the link edit. Replace the write policies in `policies.sql` with ones for signed-in officers (Supabase Auth with Discord) before using it for the live roster.
