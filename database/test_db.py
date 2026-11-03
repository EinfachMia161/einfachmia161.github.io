#!/usr/bin/env python3
"""Database tests, run with the same roles the website uses.

Every test runs in its own transaction and is rolled back, so nothing is left behind - including the
registration code that some tests create (the real code is untouched). Logins are simulated by setting
the JWT claims Supabase would set; no accounts are created.
"""
import json
import os
import sys
import uuid

import psycopg

import deploy

PASS, FAIL = [], []


def test(name):
    def wrap(fn):
        with psycopg.connect(deploy.DSN, password=os.environ["PGPASSWORD"]) as con:
            try:
                with con.transaction(force_rollback=True):
                    con.execute("set local nu7.today = '2026-11-03'")
                    fn(con)
                PASS.append(name)
                print("PASS", name)
            except Exception as e:  # noqa: BLE001
                FAIL.append((name, e))
                print("FAIL", name, "->", (str(e).splitlines() or [repr(e)])[0])
        return fn
    return wrap


# ---- roles

def as_admin(con):
    con.execute("reset role")


def as_anon(con):
    con.execute("reset role")
    con.execute("select set_config('request.jwt.claims', '', true)")
    con.execute("set local role anon")


def as_user(con, uid):
    con.execute("reset role")
    con.execute("select set_config('request.jwt.claims', %s, true)",
                (json.dumps({"sub": str(uid), "role": "authenticated"}),))
    con.execute("set local role authenticated")


def officer(con, name):
    """Link a fresh simulated login to the named member and switch to it."""
    as_admin(con)
    uid = uuid.uuid4()
    con.execute("delete from officer_account where person_id = (select person_id from v_roster where display_name = %s)", (name,))
    con.execute("insert into officer_account (user_id, person_id) select %s, person_id from v_roster where display_name = %s",
                (uid, name))
    as_user(con, uid)
    return uid


# ---- helpers

def one(con, q, *a):
    return con.execute(q, a).fetchone()


def expect_error(con, q, a, contains):
    try:
        with con.transaction():
            con.execute(q, a)
    except psycopg.Error as e:
        assert contains.lower() in str(e).lower(), f"wrong error: {e}"
        return
    raise AssertionError(f"expected an error containing '{contains}'")


def member(con, name):
    return one(con, "select membership_id, person_id, rank, rank_id from v_roster where display_name = %s", name)


def new_code(con):
    as_admin(con)
    return one(con, "select private.new_co_registration_code()")[0]


# ================================================================ secrets and access

@test("registration code is stored only as a bcrypt hash")
def _(con):
    code = new_code(con)
    h = one(con, "select value_hash from private.app_secret where name = 'co_registration_code'")[0]
    assert h.startswith("$2") and code not in h and len(code) == 38, (h[:7], len(code))


@test("visitors and logins cannot reach the private schema or the code functions")
def _(con):
    for role in ("anon", "user"):
        as_anon(con) if role == "anon" else as_user(con, uuid.uuid4())
        expect_error(con, "select * from private.app_secret", (), "permission denied")
        expect_error(con, "select * from private.attempt", (), "permission denied")
        expect_error(con, "select private.new_co_registration_code()", (), "permission denied")
        expect_error(con, "select private.disable_co_registration()", (), "permission denied")


@test("visitors can read the roster but not Discord names, logins or the change log")
def _(con):
    as_anon(con)
    assert one(con, "select count(*) from v_roster")[0] == 46
    assert one(con, "select count(*) from person")[0] > 0
    expect_error(con, "select discord_username from person", (), "permission denied")
    expect_error(con, "select * from audit_log", (), "permission denied")
    expect_error(con, "select * from officer_account", (), "permission denied")
    expect_error(con, "select * from member_discord()", (), "permission denied")


@test("visitors cannot write anything or call officer actions")
def _(con):
    mid, pid, *_ = member(con, "Krater J.")
    as_anon(con)
    expect_error(con, "insert into duty_log (person_id, logged_on, hours) values (%s, '2026-11-02', 1)", (pid,), "permission denied")
    expect_error(con, "update membership set status_override = 'x'", (), "permission denied")
    expect_error(con, "delete from strike where true", (), "permission denied")
    expect_error(con, "select change_rank(%s, 'SPC', 'promoted')", (mid,), "permission denied")
    expect_error(con, "select add_member('STEAM_0:1:999000111', 'X')", (), "permission denied")
    expect_error(con, "select claim_officer('STEAM_0:1:1', 'x')", (), "permission denied")


@test("a login that is not linked to an officer cannot edit")
def _(con):
    mid, pid, *_ = member(con, "Krater J.")
    as_user(con, uuid.uuid4())
    assert one(con, "select is_officer()")[0] is False
    expect_error(con, "insert into strike (person_id, weight, reason, issued_on) values (%s, 1, 'x', '2026-11-03')", (pid,), "row-level security")
    assert con.execute("update membership set status_override = 'hacked' where id = %s", (mid,)).rowcount == 0
    assert con.execute("update person set display_name = 'hacked' where id = %s", (pid,)).rowcount == 0
    assert con.execute("delete from duty_log where person_id = %s", (pid,)).rowcount == 0
    expect_error(con, "select change_rank(%s, 'SPC', 'promoted')", (mid,), "only signed-in officers")
    expect_error(con, "select add_member('STEAM_0:1:999000111', 'X')", (), "only signed-in officers")
    expect_error(con, "insert into officer_account (user_id, person_id) values (gen_random_uuid(), %s)", (pid,), "permission denied")
    assert one(con, "select count(*) from member_discord()")[0] == 0
    assert one(con, "select count(*) from audit_log")[0] == 0


# ================================================================ registration

@test("claim: correct code + officer Steam ID links the login")
def _(con):
    code = new_code(con)
    uid = uuid.uuid4()
    as_user(con, uid)
    r = one(con, "select claim_officer('STEAM_0:0:202215689', %s)", code)[0]   # Mason R. Holt, CPT
    assert r["ok"] is True, r
    assert one(con, "select is_officer()")[0] is True
    assert one(con, "select display_name, rank from my_officer()") == ("Mason R. Holt", "CPT")


@test("claim: code is checked case- and space-insensitively")
def _(con):
    code = new_code(con)
    as_user(con, uuid.uuid4())
    r = one(con, "select claim_officer(' steam_0:0:202215689 ', %s)", " " + code.lower().replace("-", "- ") + " ")[0]
    assert r["ok"] is True, r


@test("claim: wrong code, non-officer Steam ID, taken officer and second link are refused")
def _(con):
    code = new_code(con)
    as_user(con, uuid.uuid4())
    assert one(con, "select claim_officer('STEAM_0:0:202215689', 'NU7-WRONG-WRONG')")[0]["ok"] is False
    assert one(con, "select claim_officer('STEAM_0:1:111662696', %s)", code)[0]["ok"] is False   # Krater, PVT
    assert one(con, "select claim_officer('STEAM_0:0:501737251', %s)", code)[0]["ok"] is False   # Tom Hans, CSG
    first = uuid.uuid4()
    as_user(con, first)
    assert one(con, "select claim_officer('STEAM_0:0:202215689', %s)", code)[0]["ok"] is True
    assert one(con, "select claim_officer('STEAM_0:1:526725088', %s)", code)[0]["message"].startswith("This login is already linked")
    as_user(con, uuid.uuid4())
    assert one(con, "select claim_officer('STEAM_0:0:202215689', %s)", code)[0]["ok"] is False   # already taken


@test("claim: all failures give the same message")
def _(con):
    code = new_code(con)
    as_user(con, uuid.uuid4())
    msgs = {one(con, "select claim_officer(%s, %s)", sid, c)[0]["message"]
            for sid, c in [("STEAM_0:0:202215689", "NU7-BAD-BAD-BAD"), ("STEAM_0:1:111662696", code), ("STEAM_0:1:1", code)]}
    assert len(msgs) == 1, msgs


@test("claim: 5 failures lock the login for 15 minutes, even with the right code")
def _(con):
    code = new_code(con)
    as_user(con, uuid.uuid4())
    for _ in range(5):
        assert one(con, "select claim_officer('STEAM_0:0:202215689', 'NU7-GUESS-GUESS')")[0]["ok"] is False
    r = one(con, "select claim_officer('STEAM_0:0:202215689', %s)", code)[0]
    assert r["ok"] is False and "too many" in r["message"].lower(), r


@test("claim: 30 failures across many logins lock registration for everyone")
def _(con):
    code = new_code(con)
    for _ in range(6):
        as_user(con, uuid.uuid4())
        for _ in range(5):
            one(con, "select claim_officer('STEAM_0:0:202215689', 'NU7-GUESS-GUESS')")
    as_user(con, uuid.uuid4())
    r = one(con, "select claim_officer('STEAM_0:0:202215689', %s)", code)[0]
    assert r["ok"] is False and "too many" in r["message"].lower(), r


@test("claim: no code set means registration is off")
def _(con):
    as_admin(con)
    con.execute("select private.disable_co_registration()")
    as_user(con, uuid.uuid4())
    assert one(con, "select claim_officer('STEAM_0:0:202215689', 'NU7-ANYTHING-AT-ALL')")[0]["ok"] is False


@test("a new code replaces the old one; existing links stay")
def _(con):
    old = new_code(con)
    uid = uuid.uuid4()
    as_user(con, uid)
    assert one(con, "select claim_officer('STEAM_0:0:202215689', %s)", old)[0]["ok"] is True
    new = new_code(con)
    as_user(con, uuid.uuid4())
    assert one(con, "select claim_officer('STEAM_0:1:526725088', %s)", old)[0]["ok"] is False
    assert one(con, "select claim_officer('STEAM_0:1:526725088', %s)", new)[0]["ok"] is True
    as_user(con, uid)
    assert one(con, "select is_officer()")[0] is True


@test("officer rights end when the officer is demoted below LT")
def _(con):
    uid = officer(con, "Simon Black")
    _m, pid, *_ = member(con, "Krater J.")
    con.execute("insert into strike (person_id, weight, reason, issued_on) values (%s, 1, 'ok', '2026-11-03')", (pid,))
    as_admin(con)
    con.execute("""update membership set rank_id = (select id from rank where code = 'CSG')
                   where left_at is null and person_id = (select person_id from officer_account where user_id = %s)""", (uid,))
    as_user(con, uid)
    assert one(con, "select is_officer()")[0] is False
    expect_error(con, "insert into strike (person_id, weight, reason, issued_on) values (%s, 1, 'no', '2026-11-03')", (pid,), "row-level security")


@test("officer rights end when the officer is discharged")
def _(con):
    uid = officer(con, "Simon Black")
    as_admin(con)
    con.execute("update membership set left_at = '2026-11-03' where left_at is null and person_id = (select person_id from officer_account where user_id = %s)", (uid,))
    as_user(con, uid)
    assert one(con, "select is_officer()")[0] is False


@test("Regimental Command can remove officer logins, other officers cannot")
def _(con):
    officer(con, "Mason R. Holt")
    as_admin(con)
    target = uuid.uuid4()
    con.execute("insert into officer_account (user_id, person_id) select %s, person_id from v_roster where display_name = 'Simon Black'", (target,))
    officer(con, 'Andrew "Sterben" Spencer')
    assert con.execute("delete from officer_account where user_id = %s", (target,)).rowcount == 0
    officer(con, "Jess 'Hare' Cottontail")
    assert one(con, "select is_regcom()")[0] is True
    assert con.execute("delete from officer_account where user_id = %s", (target,)).rowcount == 1


@test("officers see Discord names and the change log, with who made each change")
def _(con):
    uid = officer(con, "Mason R. Holt")
    assert one(con, "select count(*) from member_discord()")[0] > 40
    _m, pid, *_ = member(con, "Krater J.")
    con.execute("update person set discord_username = 'audit-test' where id = %s", (pid,))
    row = one(con, "select table_name, action, actor from audit_log order by id desc limit 1")
    assert row == ("person", "UPDATE", uid), row


@test("officers cannot change Steam IDs or other locked person columns")
def _(con):
    officer(con, "Mason R. Holt")
    _m, pid, *_ = member(con, "Krater J.")
    expect_error(con, "update person set steam_id = 'STEAM_0:0:1' where id = %s", (pid,), "permission denied")


# ================================================================ hours form (PVT - CSG)

@test("hours form: matching Steam ID + Discord logs hours for a PVT")
def _(con):
    mid, *_ = member(con, "Krater J.")
    before = float(one(con, "select hours from v_roster where membership_id = %s", mid)[0])
    as_anon(con)
    r = one(con, "select submit_duty(' steam_0:1:111662696 ', ' KRATER_ ', '2026-11-03', 2.5, 'patrol')")[0]
    assert r["ok"] is True and float(r["week_hours"]) == before + 2.5, r
    assert float(one(con, "select hours from v_roster where membership_id = %s", mid)[0]) == before + 2.5
    as_admin(con)
    assert one(con, "select source from duty_log order by id desc limit 1")[0] == "self"


@test("hours form: wrong Discord, officers and unknown Steam IDs are refused")
def _(con):
    as_anon(con)
    assert one(con, "select submit_duty('STEAM_0:1:111662696', 'someone_else', '2026-11-03', 1)")[0]["ok"] is False
    assert one(con, "select submit_duty('STEAM_0:0:202215689', 'Berkoham', '2026-11-03', 1)")[0]["ok"] is False   # CPT
    assert one(con, "select submit_duty('STEAM_0:1:1', 'x', '2026-11-03', 1)")[0]["ok"] is False
    assert one(con, "select submit_duty('STEAM_0:0:501737251', '0x4e554c4c5f5441494d', '2026-11-03', 1)")[0]["ok"] is True  # CSG


@test("hours form: date, hour, daily and comment limits")
def _(con):
    as_anon(con)
    q = "select submit_duty('STEAM_0:1:111662696', 'krater_', %s::date, %s::numeric)"
    assert one(con, q, "2026-11-04", 1)[0]["ok"] is False      # future
    assert one(con, q, "2026-10-27", 1)[0]["ok"] is False      # 7 days ago
    assert one(con, q, "2026-10-28", 1)[0]["ok"] is True       # 6 days ago
    assert one(con, q, "2026-11-03", 0)[0]["ok"] is False
    assert one(con, q, "2026-11-03", 12.5)[0]["ok"] is False
    assert one(con, q, "2026-11-03", 12)[0]["ok"] is True
    assert one(con, q, "2026-11-03", 4.5)[0]["ok"] is False    # 16.5 h on one day
    assert one(con, "select submit_duty('STEAM_0:1:111662696', 'krater_', '2026-11-02', 1, %s)", "x" * 301)[0]["ok"] is False


@test("hours form: 5 wrong Discord names lock that Steam ID")
def _(con):
    as_anon(con)
    for i in range(5):
        one(con, "select submit_duty('STEAM_0:1:111662696', %s, '2026-11-03', 1)", f"guess{i}")
    r = one(con, "select submit_duty('STEAM_0:1:111662696', 'krater_', '2026-11-03', 1)")[0]
    assert r["ok"] is False and "too many" in r["message"].lower(), r


@test("hours form: an officer can reject self-logged hours")
def _(con):
    mid, *_ = member(con, "Krater J.")
    as_anon(con)
    assert one(con, "select submit_duty('STEAM_0:1:111662696', 'krater_', '2026-11-03', 3)")[0]["ok"] is True
    officer(con, "Mason R. Holt")
    before = float(one(con, "select hours from v_roster where membership_id = %s", mid)[0])
    con.execute("update duty_log set rejected = true where source = 'self' and logged_on = '2026-11-03' and hours = 3")
    assert float(one(con, "select hours from v_roster where membership_id = %s", mid)[0]) == before - 3


# ================================================================ roster logic (as an officer)

@test("logging duty raises hours and status")
def _(con):
    officer(con, "Mason R. Holt")
    mid, pid, _r, rid = member(con, "Jay 'Ghost' bank")
    before = one(con, "select hours from v_roster where membership_id = %s", mid)[0]
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-11-02', 6, %s)", (pid, rid))
    after = one(con, "select hours, status from v_roster where membership_id = %s", mid)
    assert float(after[0]) == float(before) + 6 and after[1] == "Active", after


@test("duty logged today counts; 8+ days ago does not; negative hours rejected")
def _(con):
    officer(con, "Mason R. Holt")
    mid, pid, _r, rid = member(con, "Orca Masa")
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-11-03', 4, %s)", (pid, rid))
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-10-26', 9, %s)", (pid, rid))
    assert float(one(con, "select hours from v_roster where membership_id = %s", mid)[0]) == 4
    expect_error(con, "insert into duty_log (person_id, logged_on, hours) values (%s, '2026-11-02', -1)", (pid,), "check")


@test("strikes count until expiry and not after an appeal; LOA sets the status")
def _(con):
    officer(con, "Mason R. Holt")
    mid, pid, *_ = member(con, "Krater J.")
    con.execute("insert into strike (person_id, weight, reason, issued_on, expires_on) values (%s, 1, 'test', '2026-11-03', '2026-11-20')", (pid,))
    assert float(one(con, "select strikes from v_roster where membership_id = %s", mid)[0]) == 1
    con.execute("update strike set appeal_status = 'granted' where person_id = %s and reason = 'test'", (pid,))
    assert float(one(con, "select strikes from v_roster where membership_id = %s", mid)[0]) == 0
    con.execute("insert into leave (person_id, type, starts_on, ends_on) values (%s, 'LOA', '2026-11-01', '2026-11-10')", (pid,))
    assert one(con, "select status from v_roster where membership_id = %s", mid)[0] == "LOA"


@test("promotion and demotion rules")
def _(con):
    officer(con, "Mason R. Holt")
    mid, pid, *_ = member(con, "Krater J.")
    con.execute("select change_rank(%s, 'SPC', 'promoted', 'Tester', 'unit test')", (mid,))
    r = one(con, "select rank, on_cooldown, last_promotion from v_roster where membership_id = %s", mid)
    assert r[0] == "SPC" and r[1] is True and str(r[2]) == "2026-11-03", r
    expect_error(con, "select change_rank(%s, 'SPC', 'promoted')", (mid,), "already holds")
    expect_error(con, "select change_rank(%s, 'PVT', 'promoted')", (mid,), "higher rank")
    expect_error(con, "select change_rank(%s, 'LCPL', 'demoted')", (mid,), "lower rank")
    con.execute("select change_rank(%s, 'PVT', 'demoted')", (mid,))
    assert one(con, "select rank from v_roster where membership_id = %s", mid)[0] == "PVT"


@test("add_member: new, already serving, bad input, blacklist + override")
def _(con):
    officer(con, "Mason R. Holt")
    mid = one(con, "select add_member('steam_1:0:999000222', 'Test Recruit', 'tester')")[0]
    assert one(con, "select steam_id, rank from v_roster where membership_id = %s", mid) == ("STEAM_0:0:999000222", "PVT")
    expect_error(con, "select add_member('STEAM_0:1:111662696', 'Krater again')", (), "already on the roster")
    expect_error(con, "select add_member('12345', 'Bad')", (), "steam id must look like")
    sid = one(con, "select steam_id from v_active_blacklist where steam_id is not null and steam_id not in (select steam_id from v_roster) limit 1")[0]
    expect_error(con, "select add_member(%s, 'Blocked')", (sid,), "blacklisted")
    assert one(con, "select add_member(%s, 'Blocked', null, 'PVT', true)", sid)[0]


@test("revoked blacklist entries are not active (J. 'GHOST' Ken)")
def _(con):
    as_anon(con)
    assert one(con, "select count(*) from v_active_blacklist where steam_id = 'STEAM_0:0:634558185'")[0] == 0
    officer(con, "Mason R. Holt")
    bid = one(con, "select id from v_active_blacklist limit 1")[0]
    con.execute("insert into blacklist_appeal (blacklist_id, decision, reason) values (%s, 'revoked', 'test')", (bid,))
    assert one(con, "select count(*) from v_active_blacklist where id = %s", bid)[0] == 0


@test("discharge removes the member; they can be re-added with their history")
def _(con):
    officer(con, "Mason R. Holt")
    mid, pid, *_ = member(con, "Orca Masa")
    con.execute("select discharge_member(%s, 'honourable', 'test', 'Tester')", (mid,))
    assert one(con, "select count(*) from v_roster where membership_id = %s", mid)[0] == 0
    new = one(con, "select add_member('STEAM_0:0:617061850', 'Orca Masa')")[0]
    assert one(con, "select person_id from membership where id = %s", new)[0] == pid


@test("promotion board: ticks count except for activity and cooldown")
def _(con):
    officer(con, "Mason R. Holt")
    mid = member(con, "Orca Masa")[0]
    for kind in ("activity", "cooldown", "qualification"):
        rid, auto = one(con, "select requirement_id, auto_met from v_promotion_board where membership_id = %s and kind = %s", mid, kind)
        con.execute("""insert into member_requirement (membership_id, requirement_id, done) values (%s, %s, true)
                       on conflict (membership_id, requirement_id) do update set done = true""", (mid, rid))
        met = one(con, "select met from v_promotion_board where membership_id = %s and requirement_id = %s", mid, rid)[0]
        assert met == (auto if kind in ("activity", "cooldown") else True), (kind, auto, met)
    n = one(con, "select count(*) from v_promotion_board where membership_id = %s", mid)[0]
    con.execute("update requirement set is_active = false where id = %s", (rid,))
    assert one(con, "select count(*) from v_promotion_board where membership_id = %s", mid)[0] == n - 1


@test("overview numbers add up")
def _(con):
    as_anon(con)
    o = one(con, "select members, active, semi_active, inactive, on_loa, on_roa from v_overview")
    assert o[0] == 46 and sum(o[1:]) == 46, o


# ================================================================ CO area

@test("CO area and member notes are invisible to visitors and plain logins")
def _(con):
    as_anon(con)
    for t in ("co_note", "co_link", "co_document", "member_note", "leave_request"):
        expect_error(con, f"select * from {t}", (), "permission denied")
    expect_error(con, "select co_alerts()", (), "permission denied")
    as_user(con, uuid.uuid4())
    for t in ("co_note", "co_link", "co_document", "member_note", "leave_request"):
        assert one(con, f"select count(*) from {t}")[0] == 0, t
    expect_error(con, "select co_alerts()", (), "only signed-in officers")


@test("imported member notes are officer-only and gone from the public roster")
def _(con):
    as_anon(con)
    expect_error(con, "select notes from v_roster", (), "does not exist")
    officer(con, "Mason R. Holt")
    assert one(con, "select count(*) from member_note")[0] == 3


@test("officers write notes and links; Regimental Command-only entries stay hidden from other officers")
def _(con):
    uid = officer(con, "Mason R. Holt")
    con.execute("insert into co_note (title, body, author_id) values ('Meeting', 'Agenda', %s)", (uid,))
    con.execute("insert into co_link (title, url, category, author_id) values ('Handbook', 'https://example.org/h', 'Docs', %s)", (uid,))
    expect_error(con, "insert into co_note (title, visibility, author_id) values ('Secret', 'regcom', %s)", (uid,), "row-level security")
    expect_error(con, "insert into co_note (title, author_id) values ('Spoofed', gen_random_uuid())", (), "row-level security")
    reg = officer(con, "Jess 'Hare' Cottontail")
    con.execute("insert into co_note (title, visibility, author_id) values ('RegCom only', 'regcom', %s)", (reg,))
    assert one(con, "select count(*) from co_note where title = 'RegCom only'")[0] == 1
    officer(con, "Mason R. Holt")
    assert one(con, "select count(*) from co_note where title = 'RegCom only'")[0] == 0
    assert one(con, "select count(*) from co_note where title = 'Meeting'")[0] == 1


@test("links must be plain https (no javascript: or data: links)")
def _(con):
    uid = officer(con, "Mason R. Holt")
    for bad in ("javascript:alert(1)", "http://example.org", "data:text/html,x", "https://ex ample.org", 'https://x.org/"onmouseover=1'):
        expect_error(con, "insert into co_link (title, url, author_id) values ('x', %s, %s)", (bad, uid), "check")


@test("document storage: officers upload to officers/, only Regimental Command to regcom/")
def _(con):
    off = officer(con, "Mason R. Holt")
    con.execute("insert into storage.objects (bucket_id, name, owner_id) values ('co-documents', %s, %s)", (f"officers/{uuid.uuid4()}/a.pdf", str(off)))
    expect_error(con, "insert into storage.objects (bucket_id, name, owner_id) values ('co-documents', %s, %s)",
                 (f"regcom/{uuid.uuid4()}/b.pdf", str(off)), "row-level security")
    as_user(con, uuid.uuid4())
    expect_error(con, "insert into storage.objects (bucket_id, name) values ('co-documents', %s)", (f"officers/{uuid.uuid4()}/c.pdf",), "row-level security")
    assert one(con, "select count(*) from storage.objects where bucket_id = 'co-documents'")[0] == 0
    as_anon(con)
    assert one(con, "select count(*) from storage.objects where bucket_id = 'co-documents'")[0] == 0


@test("member notes: officers add them, the author cannot be faked")
def _(con):
    uid = officer(con, "Mason R. Holt")
    _m, pid, *_ = member(con, "Krater J.")
    con.execute("insert into member_note (person_id, body, author_id, author_name) values (%s, 'Good attitude', %s, 'Mason')", (pid, uid))
    expect_error(con, "insert into member_note (person_id, body, author_id) values (%s, 'x', gen_random_uuid())", (pid,), "row-level security")


# ================================================================ members area

@test("my file: shows own hours and requirements, needs the right Discord name")
def _(con):
    as_anon(con)
    r = one(con, "select my_file('STEAM_0:1:111662696', 'krater_')")[0]
    assert r["ok"] and r["name"] == "Krater J." and r["requirements"] and "duty" in r, r
    assert one(con, "select my_file('STEAM_0:1:111662696', 'wrong')")[0]["ok"] is False


@test("leave request: one pending at a time, limits, officer approval creates the LOA")
def _(con):
    as_anon(con)
    q = "select request_leave('STEAM_0:1:111662696', 'krater_', %s, %s::date, %s::date, 'exams')"
    assert one(con, q, "LOA", "2026-11-03", "2027-01-10")[0]["ok"] is False     # > 60 days
    assert one(con, q, "LOA", "2026-11-05", "2026-11-04")[0]["ok"] is False     # backwards
    assert one(con, q, "XYZ", "2026-11-03", "2026-11-05")[0]["ok"] is False
    assert one(con, q, "LOA", "2026-11-03", "2026-11-09")[0]["ok"] is True
    assert one(con, q, "ROA", "2026-11-10", "2026-11-12")[0]["ok"] is False     # already pending
    as_user(con, uuid.uuid4())
    expect_error(con, "select decide_leave_request(1, true)", (), "only signed-in officers")
    officer(con, "Mason R. Holt")
    rid = one(con, "select id from leave_request where status = 'pending'")[0]
    assert one(con, "select decide_leave_request(%s, true, 'ok')", rid)[0]["ok"] is True
    assert one(con, "select status from v_roster where display_name = 'Krater J.'")[0] == "LOA"
    expect_error(con, "select decide_leave_request(%s, false)", (rid,), "already been decided")


@test("leave request: an officer can decline; nothing is added to the roster")
def _(con):
    as_anon(con)
    assert one(con, "select request_leave('STEAM_0:1:111662696', 'krater_', 'ROA', '2026-11-04', '2026-11-06')")[0]["ok"]
    officer(con, "Mason R. Holt")
    rid = one(con, "select id from leave_request where status = 'pending'")[0]
    one(con, "select decide_leave_request(%s, false, 'not now')", rid)
    assert one(con, "select status, leave_id from leave_request where id = %s", rid) == ("declined", None)


@test("training form: an NCO logs a training; it satisfies the hosting requirement")
def _(con):
    as_admin(con)
    att = [r[0] for r in con.execute("select person_id from v_roster where rank = 'PVT' limit 2").fetchall()]
    tid = one(con, "select id from training_type where name = 'Hacking'")[0]
    as_anon(con)
    r = one(con, "select log_training('STEAM_0:0:803597514', 'cancer6551', %s, '2026-11-03', %s::uuid[], null, 'went well')", tid, att)[0]
    assert r["ok"] is True, r
    assert one(con, "select auto_met from v_promotion_board where display_name = 'Winston ''Duke'' Barns' and kind = 'hosted_training'")[0] is True
    assert one(con, "select count(*) from training_attendee ta join training t on t.id = ta.training_id where t.comment = 'went well'")[0] == 2


@test("training form: PVT hosts, future dates, host-only lists and missing descriptions are refused")
def _(con):
    as_admin(con)
    att = [r[0] for r in con.execute("select person_id from v_roster where rank = 'PVT' limit 2").fetchall()]
    hack = one(con, "select id from training_type where name = 'Hacking'")[0]
    unl = one(con, "select id from training_type where name = 'Unlisted'")[0]
    host_pid = one(con, "select person_id from v_roster where display_name = 'Winston ''Duke'' Barns'")[0]
    as_anon(con)
    q = "select log_training(%s, %s, %s, %s::date, %s::uuid[], %s, null)"
    assert one(con, q, "STEAM_0:1:111662696", "krater_", hack, "2026-11-03", att, None)[0]["ok"] is False      # PVT host
    assert one(con, q, "STEAM_0:0:803597514", "cancer6551", hack, "2026-11-04", att, None)[0]["ok"] is False   # future
    assert one(con, q, "STEAM_0:0:803597514", "cancer6551", hack, "2026-11-03", [host_pid], None)[0]["ok"] is False  # only host
    assert one(con, q, "STEAM_0:0:803597514", "cancer6551", unl, "2026-11-03", att, None)[0]["ok"] is False    # unlisted, no text
    assert one(con, q, "STEAM_0:0:803597514", "cancer6551", unl, "2026-11-03", att, "Vehicle drill")[0]["ok"] is True


@test("tryout form: an NCO logs a pass; blacklisted passes need an officer")
def _(con):
    as_anon(con)
    r = one(con, "select log_tryout('STEAM_0:1:588896009', 'subnaticka69_95731', 'New Guy', 'STEAM_0:1:999000777', 'newguy', 'passed', 11, null)")[0]
    assert r["ok"] is True, r
    assert one(con, "select auto_met from v_promotion_board where display_name = 'Ryley Roberson' and kind = 'hosted_tryout'")[0] is True
    as_admin(con)
    sid = one(con, "select steam_id from v_active_blacklist where steam_id is not null and steam_id not in (select steam_id from v_roster) limit 1")[0]
    as_anon(con)
    r = one(con, "select log_tryout('STEAM_0:1:588896009', 'subnaticka69_95731', 'Banned', %s, null, 'passed', 12, null)", sid)[0]
    assert r["ok"] is False and "blacklisted" in r["message"], r
    assert one(con, "select log_tryout('STEAM_0:1:588896009', 'subnaticka69_95731', 'Krater', 'STEAM_0:1:111662696', null, 'passed', 12, null)")[0]["ok"] is False
    officer(con, "Mason R. Holt")
    r = one(con, "select log_tryout('STEAM_0:1:588896009', null, 'Banned', %s, null, 'passed', 12, 'officer decision')", sid)[0]
    assert r["ok"] is True and r["blacklisted"] is True, r


@test("members area: 5 wrong Discord names lock that Steam ID for every form")
def _(con):
    as_anon(con)
    for i in range(5):
        one(con, "select my_file('STEAM_0:1:111662696', %s)", f"guess{i}")
    r = one(con, "select request_leave('STEAM_0:1:111662696', 'krater_', 'LOA', '2026-11-04', '2026-11-06')")[0]
    assert r["ok"] is False and "too many" in r["message"].lower(), r


# ================================================================ alerts, notifications, backups

@test("alerts list low hours, training numbers and requests; the text report is built")
def _(con):
    officer(con, "Mason R. Holt")
    a = one(con, "select co_alerts()")[0]
    for k in ("low_hours", "trainings_7d", "tryouts_7d", "training_overdue", "pending_requests", "leave_ending", "ready_for_promotion"):
        assert k in a, k
    assert all(float(x["hours"]) < float(x["required"]) for x in a["low_hours"])
    as_admin(con)
    text = one(con, "select private.alerts_text()")[0]
    assert "LOW HOURS" in text, text[:200]


@test("daily report runs without email or Discord set up (nothing sent, no error)")
def _(con):
    as_admin(con)
    r = one(con, "select private.send_daily_alerts()")[0]
    assert r["email"] is False, r
    con.execute("select private.discord_post('test')")


@test("visitors cannot read snapshots, settings or call the report and backup functions")
def _(con):
    for fn in ("private.take_snapshot()", "private.send_daily_alerts()", "private.alerts()", "private.set_alert_email('a@b.co')"):
        as_anon(con)
        expect_error(con, f"select {fn}", (), "permission denied")
    as_anon(con)
    expect_error(con, "select * from private.snapshot", (), "permission denied")
    expect_error(con, "select * from private.config", (), "permission denied")


@test("daily snapshot stores every table and can be read back")
def _(con):
    as_admin(con)
    assert one(con, "select private.take_snapshot()")[0] == 25
    n = one(con, "select row_count from private.snapshot where table_name = 'membership' order by id desc limit 1")[0]
    assert n == one(con, "select count(*) from membership")[0]
    assert one(con, "select count(*) from private.snapshot_rows('membership', current_date)")[0] == n


# ================================================================ undo and half strikes

def separate(con, uid):
    """Tests run in one transaction; give the rows logged so far their own action, as separate clicks would."""
    as_admin(con)
    con.execute("update audit_log set tx = -id where tx = txid_current()")
    as_user(con, uid)


def last_change(con, table, action):
    return one(con, "select id from audit_log where table_name = %s and action = %s order by id desc limit 1", table, action)[0]


@test("strikes come in steps of 0.5, from 0.5 up to 10")
def _(con):
    _, pid, *_ = member(con, "Krater J.")
    officer(con, "Mason R. Holt")
    for w in (0.5, 1.5, 2, 10):
        con.execute("insert into strike (person_id, weight, reason, issued_on) values (%s, %s, 'x', '2026-11-03')", (pid, w))
    for w in (0.3, 1.25, 10.5, -1):
        expect_error(con, "insert into strike (person_id, weight, reason, issued_on) values (%s, %s, 'x', '2026-11-03')", (pid, w), "check")


@test("undo: an edit is reverted, the undo is logged and can itself be undone")
def _(con):
    _, pid, *_ = member(con, "Krater J.")
    uid = officer(con, "Mason R. Holt")
    sid = one(con, "insert into strike (person_id, weight, reason, issued_on) values (%s, 1.5, 'first', '2026-11-03') returning id", pid)[0]
    separate(con, uid)
    con.execute("update strike set reason = 'second', weight = 2 where id = %s", (sid,))
    separate(con, uid)
    first = last_change(con, "strike", "UPDATE")
    r = one(con, "select undo_change(%s)", first)[0]
    assert r["ok"], r
    assert one(con, "select reason, weight from strike where id = %s", sid) == ("first", 1.5)
    assert one(con, "select undo_change(%s)", first)[0]["message"] == "This action was already undone."
    separate(con, uid)
    redo = last_change(con, "strike", "UPDATE")
    assert redo != first
    assert one(con, "select actor from audit_log where id = %s", redo)[0] == uid
    assert one(con, "select undo_change(%s)", redo)[0]["ok"]
    assert one(con, "select reason from strike where id = %s", sid)[0] == "second"


@test("undo: new entries are removed, deleted ones come back with the same id")
def _(con):
    _, pid, *_ = member(con, "Krater J.")
    uid = officer(con, "Mason R. Holt")
    did = one(con, "insert into duty_log (person_id, logged_on, hours, source) values (%s, '2026-11-03', 3, 'officer') returning id", pid)[0]
    separate(con, uid)
    assert one(con, "select undo_change(%s)", last_change(con, "duty_log", "INSERT"))[0]["ok"]
    assert one(con, "select count(*) from duty_log where id = %s", did)[0] == 0
    old = one(con, "select id, hours from duty_log where person_id = %s order by id limit 1", pid)
    con.execute("delete from duty_log where id = %s", (old[0],))
    separate(con, uid)
    assert one(con, "select undo_change(%s)", last_change(con, "duty_log", "DELETE"))[0]["ok"]
    assert one(con, "select id, hours from duty_log where id = %s", old[0]) == old


@test("undo: a later edit is never overwritten")
def _(con):
    _, pid, *_ = member(con, "Krater J.")
    uid = officer(con, "Mason R. Holt")
    sid = one(con, "insert into strike (person_id, weight, reason, issued_on) values (%s, 1, 'a', '2026-11-03') returning id", pid)[0]
    separate(con, uid)
    ins = last_change(con, "strike", "INSERT")
    con.execute("update strike set reason = 'b' where id = %s", (sid,))
    separate(con, uid)
    r = one(con, "select undo_change(%s)", ins)[0]
    assert not r["ok"] and "changed again" in r["message"], r
    assert one(con, "select reason from strike where id = %s", sid)[0] == "b"
    assert one(con, "select undone_at from audit_log where id = %s", ins)[0] is None


@test("undo: one click undoes a whole action (adding a member)")
def _(con):
    separate(con, officer(con, "Mason R. Holt"))
    before = one(con, "select count(*) from v_roster")[0]
    con.execute("select add_member('STEAM_0:1:999000333', 'Undo Recruit', 'undo')")
    assert one(con, "select count(*) from v_roster")[0] == before + 1
    rows = one(con, "select count(*) from audit_log where tx = txid_current()")[0]
    r = one(con, "select undo_change(%s)", last_change(con, "person_alias", "INSERT"))[0]
    assert r["ok"] and r["message"] == f"{rows} changes undone.", r
    assert one(con, "select count(*) from v_roster")[0] == before
    as_admin(con)
    assert one(con, "select count(*) from person where steam_id = 'STEAM_0:1:999000333'")[0] == 0


@test("undo: only officers; officer logins and Regimental Command entries are protected")
def _(con):
    uid = officer(con, "Mason R. Holt")
    con.execute("update strike set reason = reason where id = (select min(id) from strike)")
    separate(con, uid)
    aid = last_change(con, "strike", "UPDATE")
    as_anon(con)
    expect_error(con, "select undo_change(%s)", (aid,), "permission denied")
    as_user(con, uuid.uuid4())
    expect_error(con, "select undo_change(%s)", (aid,), "only signed-in officers")
    as_user(con, uid)
    assert "Officer logins" in one(con, "select undo_change(%s)", last_change(con, "officer_account", "INSERT"))[0]["message"]
    reg = officer(con, "Jess 'Hare' Cottontail")
    con.execute("insert into co_note (title, visibility, author_id) values ('RegCom undo', 'regcom', %s)", (reg,))
    separate(con, reg)
    nid = last_change(con, "co_note", "INSERT")
    officer(con, "Mason R. Holt")
    assert one(con, "select count(*) from audit_log where id = %s", nid)[0] == 0
    assert one(con, "select undo_change(%s)", nid)[0]["message"] == "Change not found."
    officer(con, "Jess 'Hare' Cottontail")
    assert one(con, "select undo_change(%s)", nid)[0]["ok"]
    assert one(con, "select count(*) from co_note where title = 'RegCom undo'")[0] == 0


print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
