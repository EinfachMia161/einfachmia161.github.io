#!/usr/bin/env python3
"""Database tests run as the website's role (anon). Every test runs in its own transaction and is rolled back."""
import os
import sys

import psycopg

import deploy

PASS, FAIL = [], []


def test(name):
    def wrap(fn):
        with psycopg.connect(deploy.DSN, password=os.environ["PGPASSWORD"]) as con:
            try:
                with con.transaction(force_rollback=True):
                    con.execute("set local role anon")
                    con.execute("set local nu7.today = '2026-11-03'")
                    fn(con)
                PASS.append(name)
                print("PASS", name)
            except Exception as e:  # noqa: BLE001
                FAIL.append((name, e))
                print("FAIL", name, "->", str(e).splitlines()[0])
        return fn
    return wrap


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


@test("anon can read the roster view (46 members)")
def _(con):
    assert one(con, "select count(*) from v_roster")[0] == 46


@test("anon cannot delete people, memberships or rank history")
def _(con):
    for t in ("person", "membership", "rank_change", "blacklist"):
        expect_error(con, f"delete from {t} where true", (), "permission denied")


@test("anon cannot write to read-only tables (rank, medal_award, audit_log)")
def _(con):
    expect_error(con, "update rank set max_slots = 1", (), "permission denied")
    expect_error(con, "insert into medal_award (person_id, medal_type_id) select id, 1 from person limit 1", (), "permission denied")
    expect_error(con, "delete from audit_log", (), "permission denied")


@test("logging duty raises hours and status (Semi-Active -> Active)")
def _(con):
    mid, pid, _r, rid = member(con, "Jay 'Ghost' bank")
    before = one(con, "select hours, status from v_roster where membership_id = %s", mid)
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-11-02', 3, %s)", (pid, rid))
    after = one(con, "select hours, status from v_roster where membership_id = %s", mid)
    assert float(after[0]) == float(before[0]) + 3, (before, after)
    assert after[1] in ("Active", "Semi-Active"), after
    if float(after[0]) >= 5:
        assert after[1] == "Active", after


@test("duty logged today counts straight away; 8+ days ago does not")
def _(con):
    mid, pid, _r, rid = member(con, "Orca Masa")
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-11-03', 4, %s)", (pid, rid))
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-10-26', 9, %s)", (pid, rid))
    assert float(one(con, "select hours from v_roster where membership_id = %s", mid)[0]) == 4


@test("activity and cooldown ignore ticks; other requirements accept them")
def _(con):
    mid = member(con, "Orca Masa")[0]
    for kind, expect_met in (("activity", False), ("cooldown", None), ("qualification", True)):
        rid, auto = one(con, "select requirement_id, auto_met from v_promotion_board where membership_id = %s and kind = %s", mid, kind)
        con.execute("""insert into member_requirement (membership_id, requirement_id, done) values (%s, %s, true)
                       on conflict (membership_id, requirement_id) do update set done = true""", (mid, rid))
        met = one(con, "select met from v_promotion_board where membership_id = %s and requirement_id = %s", mid, rid)[0]
        assert met == (auto if kind in ("activity", "cooldown") else True), (kind, auto, met)


@test("negative duty hours are rejected")
def _(con):
    _m, pid, _r, rid = member(con, "Orca Masa")
    expect_error(con, "insert into duty_log (person_id, logged_on, hours) values (%s, '2026-11-02', -1)", (pid,), "check")


@test("a strike counts until it expires, and not after an appeal")
def _(con):
    mid, pid, *_ = member(con, "Krater J.")
    con.execute("insert into strike (person_id, weight, reason, issued_on, expires_on) values (%s, 1, 'test', '2026-11-03', '2026-11-20')", (pid,))
    assert float(one(con, "select strikes from v_roster where membership_id = %s", mid)[0]) == 1
    con.execute("update strike set appeal_status = 'granted' where person_id = %s and reason = 'test'", (pid,))
    assert float(one(con, "select strikes from v_roster where membership_id = %s", mid)[0]) == 0
    con.execute("insert into strike (person_id, weight, reason, issued_on, expires_on) values (%s, 0.5, 'old', '2026-10-01', '2026-10-15')", (pid,))
    assert float(one(con, "select strikes from v_roster where membership_id = %s", mid)[0]) == 0


@test("an LOA covering today sets the status to LOA; ending before start is rejected")
def _(con):
    mid, pid, *_ = member(con, "Krater J.")
    con.execute("insert into leave (person_id, type, starts_on, ends_on) values (%s, 'LOA', '2026-11-01', '2026-11-10')", (pid,))
    assert one(con, "select status from v_roster where membership_id = %s", mid)[0] == "LOA"
    expect_error(con, "insert into leave (person_id, type, starts_on, ends_on) values (%s, 'ROA', '2026-11-10', '2026-11-01')", (pid,), "check")


@test("promotion moves the rank, logs it and starts the cooldown")
def _(con):
    mid, pid, rank, _rid = member(con, "Krater J.")
    assert rank == "PVT"
    con.execute("select change_rank(%s, 'SPC', 'promoted', 'Tester', 'unit test')", (mid,))
    r = one(con, "select rank, on_cooldown, last_promotion from v_roster where membership_id = %s", mid)
    assert r[0] == "SPC" and r[1] is True and str(r[2]) == "2026-11-03", r
    assert one(con, "select count(*) from rank_change where person_id = %s and comment = 'unit test'", pid)[0] == 1


@test("promotion rules: no same rank, no downward promotion, no upward demotion")
def _(con):
    mid, *_ = member(con, "Walee")  # SPC
    expect_error(con, "select change_rank(%s, 'SPC', 'promoted')", (mid,), "already holds")
    expect_error(con, "select change_rank(%s, 'PVT', 'promoted')", (mid,), "higher rank")
    expect_error(con, "select change_rank(%s, 'LCPL', 'demoted')", (mid,), "lower rank")
    expect_error(con, "select change_rank(%s, 'XYZ', 'promoted')", (mid,), "unknown rank")


@test("demotion works and is logged as demoted")
def _(con):
    mid, pid, *_ = member(con, "Walee")
    con.execute("select change_rank(%s, 'PVT', 'demoted')", (mid,))
    assert one(con, "select rank from v_roster where membership_id = %s", mid)[0] == "PVT"
    assert one(con, "select kind from rank_change where person_id = %s order by id desc limit 1", pid)[0] == "demoted"


@test("add_member: new recruit appears as PVT with a recruit date")
def _(con):
    mid = one(con, "select add_member('STEAM_0:1:999000111', 'Test Recruit', 'tester', 'PVT')")[0]
    r = one(con, "select rank, recruited_at, status from v_roster where membership_id = %s", mid)
    assert r[0] == "PVT" and str(r[1]) == "2026-11-03" and r[2] == "Inactive", r


@test("add_member: STEAM_1 is normalised and bad Steam IDs are rejected")
def _(con):
    mid = one(con, "select add_member('steam_1:0:999000222', 'Lowercase Tester')")[0]
    assert one(con, "select steam_id from v_roster where membership_id = %s", mid)[0] == "STEAM_0:0:999000222"
    expect_error(con, "select add_member('12345', 'Bad')", (), "steam id must look like")
    expect_error(con, "select add_member('STEAM_0:1:999000333', '  ')", (), "enter a name")


@test("add_member: someone already serving is refused")
def _(con):
    expect_error(con, "select add_member('STEAM_0:1:111662696', 'Krater again')", (), "already on the roster")


@test("add_member: active blacklist blocks, override allows")
def _(con):
    sid = one(con, "select steam_id from v_active_blacklist where steam_id is not null and steam_id not in (select steam_id from v_roster) limit 1")[0]
    expect_error(con, "select add_member(%s, 'Blocked Person')", (sid,), "blacklisted")
    mid = one(con, "select add_member(%s, 'Blocked Person', null, 'PVT', true)", sid)[0]
    assert mid is not None


@test("revoked blacklist entry (J. 'GHOST' Ken) is not active")
def _(con):
    assert one(con, "select count(*) from v_active_blacklist where steam_id = 'STEAM_0:0:634558185'")[0] == 0
    assert one(con, """select count(*) from blacklist_appeal a join blacklist b on b.id = a.blacklist_id
                       join person p on p.id = b.person_id where p.steam_id = 'STEAM_0:0:634558185' and a.decision = 'revoked'""")[0] >= 1


@test("revoking a blacklist entry removes it from the active list")
def _(con):
    bid, sid = one(con, "select id, steam_id from v_active_blacklist where steam_id is not null limit 1")
    con.execute("insert into blacklist_appeal (blacklist_id, decision, reason) values (%s, 'revoked', 'test')", (bid,))
    assert one(con, "select count(*) from v_active_blacklist where id = %s", bid)[0] == 0


@test("returning member keeps their person record and history")
def _(con):
    pid, sid = one(con, """select p.id, p.steam_id from person p where p.steam_id is not null
        and exists (select 1 from membership m where m.person_id = p.id and m.left_at is not null)
        and not exists (select 1 from membership m where m.person_id = p.id and m.left_at is null)
        and not exists (select 1 from v_active_blacklist b where b.person_id = p.id) limit 1""")
    before = one(con, "select count(*) from rank_change where person_id = %s", pid)[0]
    mid = one(con, "select add_member(%s, 'Returning Tester')", sid)[0]
    assert one(con, "select person_id from membership where id = %s", mid)[0] == pid
    assert one(con, "select count(*) from rank_change where person_id = %s", pid)[0] == before


@test("discharge takes the member off the roster and they can be re-added")
def _(con):
    mid, pid, *_ = member(con, "Orca Masa")
    expect_error(con, "select discharge_member(%s, 'fired')", (mid,), "honourable")
    con.execute("select discharge_member(%s, 'honourable', 'test', 'Tester')", (mid,))
    assert one(con, "select count(*) from v_roster where membership_id = %s", mid)[0] == 0
    expect_error(con, "select discharge_member(%s, 'honourable')", (mid,), "not on the roster")
    sid = one(con, "select steam_id from person where id = %s", pid)[0]
    new = one(con, "select add_member(%s, 'Orca Masa')", sid)[0]
    assert one(con, "select count(*) from v_roster where membership_id = %s", new)[0] == 1


@test("promotion board: ticking a manual requirement and switching requirements off")
def _(con):
    mid, *_ = member(con, "Orca Masa")
    rid = one(con, "select requirement_id from v_promotion_board where membership_id = %s and kind = 'qualification' limit 1", mid)[0]
    con.execute("""insert into member_requirement (membership_id, requirement_id, done) values (%s, %s, true)
                   on conflict (membership_id, requirement_id) do update set done = excluded.done""", (mid, rid))
    assert one(con, "select ticked from v_promotion_board where membership_id = %s and requirement_id = %s", mid, rid)[0] is True
    con.execute("update member_requirement set done = false where membership_id = %s and requirement_id = %s", (mid, rid))
    assert one(con, "select ticked from v_promotion_board where membership_id = %s and requirement_id = %s", mid, rid)[0] is False
    n = one(con, "select count(*) from v_promotion_board where membership_id = %s", mid)[0]
    con.execute("update requirement set is_active = false where id = %s", (rid,))
    assert one(con, "select count(*) from v_promotion_board where membership_id = %s", mid)[0] == n - 1


@test("promotion board: activity and cooldown are calculated automatically")
def _(con):
    rows = con.execute("""select display_name, kind, auto_met, hours, weekly_hours_required, on_cooldown
                          from v_promotion_board where kind in ('activity','cooldown')""").fetchall()
    assert rows
    for name, kind, met, hours, req, cd in rows:
        expected = float(hours) >= float(req) if kind == "activity" else not cd
        assert met == expected, (name, kind, met, hours, req, cd)


@test("promotion board: hosting a training satisfies the bi-weekly training requirement")
def _(con):
    row = one(con, "select membership_id, person_id from v_promotion_board where kind = 'hosted_training' and not auto_met limit 1")
    assert row, "no member without a hosted training"
    mid, pid = row
    con.execute("reset role")  # trainings are logged outside the test site
    con.execute("insert into training (host_id, type_id, held_on) values (%s, 1, '2026-11-02')", (pid,))
    con.execute("set local role anon")
    assert one(con, "select auto_met from v_promotion_board where membership_id = %s and kind = 'hosted_training'", mid)[0] is True


@test("every change made by the site lands in the audit log")
def _(con):
    _m, pid, _r, rid = member(con, "Krater J.")
    n = one(con, "select count(*) from audit_log")[0]
    con.execute("insert into duty_log (person_id, logged_on, hours, rank_id) values (%s, '2026-11-02', 1, %s)", (pid, rid))
    con.execute("update person set discord_username = 'audit-test' where id = %s", (pid,))
    rows = con.execute("select table_name, action from audit_log order by id desc limit 2").fetchall()
    assert one(con, "select count(*) from audit_log")[0] == n + 2
    assert ("person", "UPDATE") in rows and ("duty_log", "INSERT") in rows, rows


@test("overview numbers add up")
def _(con):
    o = one(con, "select members, active, semi_active, inactive, on_loa, on_roa from v_overview")
    assert o[0] == 46
    assert sum(o[1:]) == 46, o


print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
