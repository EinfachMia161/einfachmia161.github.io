#!/usr/bin/env python3
"""Compare the database's calculated roster with the values typed into the sheet's Roster tab."""
import os
import sys

import psycopg

import deploy
import import_nu7 as imp

zip_path = sys.argv[1]
tabs = imp.load_tabs(zip_path)
sheet, _slots = imp.read_roster(tabs["Roster"])

with psycopg.connect(deploy.DSN, password=os.environ["PGPASSWORD"]) as con:
    con.execute("set nu7.today = '2026-11-02'")  # date of the sheet export
    cur = con.execute("""select steam_id, display_name, rank, status, strikes, hours, last_promotion, on_cooldown
                         from v_roster""")
    db = {r[0]: r for r in cur.fetchall()}
    print(f"members: sheet {len(sheet)}, database {len(db)}")
    cooldown_sheet = {m["steam"]: m for m in sheet}
    diffs = {"rank": 0, "strikes": 0, "hours": 0, "status": 0, "last_promotion": 0, "cooldown": 0}
    for m in sheet:
        r = db.get(m["steam"])
        if not r:
            print("MISSING", m["name"]); continue
        _sid, name, rank, status, strikes, hours, last_promo, cooldown = r
        sheet_promo = imp.parse_date(m["last_promo_raw"])
        checks = [("rank", m["rank"], rank),
                  ("strikes", m["strikes"] or 0, float(strikes)),
                  ("hours", m["hours"], float(hours) if m["hours"] is not None else None),
                  ("status", m["status"], status),
                  ("last_promotion", sheet_promo, last_promo),
                  ("cooldown", m["cooldown"], cooldown)]
        for key, want, got in checks:
            if key == "hours" and want is None:
                continue
            if want != got:
                diffs[key] += 1
                print(f"  {key:15} {name:32} sheet={want!s:12} db={got}")
    print("differences:", diffs)
    print("roster rank vs latest rank in the promotion log:")
    for row in con.execute("""
        select ro.display_name, ro.rank, tr.code, rc.effective_on from v_roster ro
        join lateral (select * from rank_change where person_id = ro.person_id and kind <> 'bookkeeping'
                      order by effective_on desc limit 1) rc on true
        join rank tr on tr.id = rc.to_rank_id
        where tr.code <> ro.rank and rc.effective_on >= coalesce(ro.recruited_at, '1900-01-01')"""):
        print("  ", row)
    for q in ["select count(*) from v_promotion_board",
              "select count(*) from v_active_blacklist",
              "select * from v_overview"]:
        print(q, "->", con.execute(q).fetchall())
