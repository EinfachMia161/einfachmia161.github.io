#!/usr/bin/env python3
"""Load schema.sql, out/data.sql, security.sql, features.sql and policies.sql into the Supabase database.

Usage:  set PGPASSWORD, then  python deploy.py [--reset]
--reset drops every Nu-7 table and view first (all data and officer logins are lost;
the CO registration code in the private schema is kept).
"""
import os
import sys
from pathlib import Path

import psycopg

DSN = ("host=aws-0-eu-west-1.pooler.supabase.com port=5432 dbname=postgres sslmode=require "
       "user=postgres.vkqrvppfwqjmxxtjowbn")
HERE = Path(__file__).parent

RESET = """
drop view if exists v_overview, v_promotion_board, v_roster, v_active_blacklist cascade;
drop table if exists co_document, co_link, co_note, leave_request, member_note,
  officer_account, audit_log, setting, memorial_entry, fund_transaction, unit_role, unit, battalion_member,
  battalion, medal_award, medal_type, blacklist_appeal, blacklist, leave, infraction, strike, rank_change,
  tryout_quiz, tryout, training_attendee, training, training_type, duty_log, member_requirement, requirement,
  person_qualification, qualification, membership, person_alias, person, rank, rank_category cascade;
drop function if exists audit_change(), app_today(), change_rank(uuid,text,text,text,text),
  add_member(text,text,text,text,boolean), discharge_member(uuid,text,text,text), is_officer(), is_regcom(),
  my_officer(), claim_officer(text,text), member_discord(), submit_duty(text,text,date,numeric,text),
  my_file(text,text), request_leave(text,text,text,date,date,text), decide_leave_request(bigint,boolean,text),
  log_training(text,text,int,date,uuid[],text,text), log_tryout(text,text,text,text,text,text,int,text),
  co_alerts() cascade;
"""


def main():
    with psycopg.connect(DSN, password=os.environ["PGPASSWORD"], autocommit=True) as con:
        if "--reset" in sys.argv:
            con.execute(RESET)
            print("reset done")
        for f in (HERE / "schema.sql", HERE / "out" / "data.sql", HERE / "security.sql", HERE / "features.sql",
                  HERE / "policies.sql"):
            con.execute(f.read_text(encoding="utf-8"))
            print("loaded", f.name)
        con.execute("notify pgrst, 'reload schema'")


if __name__ == "__main__":
    main()
