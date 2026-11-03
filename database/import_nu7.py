#!/usr/bin/env python3
"""Import the MTF Nu-7 Google Sheet (File > Download > Web page, .zip) into SQL.

Usage:  python import_nu7.py "[UK] MTF Nu-7 Roster.zip" out/
Writes  out/data.sql (load after schema.sql) and out/import-report.md (everything that needed a decision).
"""
import datetime as dt
import json
import re
import sys
import uuid
import zipfile
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path

# ---------------------------------------------------------------- reference data

CATEGORIES = [(1, "Regimental Command", 1), (2, "Commissioned Officers", 2),
              (3, "Non-Commissioned Officers", 3), (4, "Enlisted", 4)]
# code, name, category, aliases (lowercase letters only)
RANKS = [
    ("PVT", "Private", 4, ["private", "pvt", "pte"]),
    ("SPC", "Specialist", 4, ["specialist", "spc", "spec"]),
    ("LCPL", "Lance Corporal", 4, ["lancecorporal", "lcpl"]),
    ("CPL", "Corporal", 3, ["corporal", "cpl"]),
    ("SGT", "Sergeant", 3, ["sergeant", "sgt"]),
    ("CSG", "Command Sergeant", 3, ["commandsergeant", "csg", "cmdsgt"]),
    ("LT", "Lieutenant", 2, ["lieutenant", "lt", "lieu"]),
    ("CPT", "Captain", 2, ["captain", "cpt", "capt"]),
    ("MAJ", "Major", 1, ["major", "maj"]),
    ("LTCOM", "Lieutenant Commander", 1, ["lieutenantcommander", "ltcommander", "ltcom", "ltcmdr", "ltcomm"]),
    ("COM", "Commander", 1, ["commander", "com", "cmdr"]),
]
RANK_ID = {code: i + 1 for i, (code, *_rest) in enumerate(RANKS)}
RANK_ALIAS = {a: code for code, _n, _c, aliases in RANKS for a in aliases}

# Weekly duty hours per rank category, derived from the Roster tab (2026-11-02 export):
# Regimental Command shows "-" and is always Active; enlisted count as Active from 5 h; NCOs/officers from 6 h.
WEEKLY_HOURS = {1: 0, 2: 6, 3: 6, 4: 5}
# Cooldown TRUE for promotions on 30/10-01/11 and FALSE from 29/10 back, as of 02/11 -> 4 days.
COOLDOWN_DAYS = 4

STANDARD_STATUSES = {"active", "very-active", "extremely-active", "semi-active", "inactive", "loa", "roa"}

# Facts confirmed outside the sheet.
MANUAL_REVOCATIONS = {
    "STEAM_0:0:634558185": "Blacklist revoked (confirmed by EinfachMia on 2026-11-03; not recorded in the sheet)",
}

TODAY = dt.date.today()

# ---------------------------------------------------------------- HTML sheet parsing


class SheetParser(HTMLParser):
    """Turns one Google Sheets HTML export into a list of rows (row-number column dropped, merges expanded)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell = [], None, None
        self.spans = {}  # column -> rows still covered by a rowspan above
        self.skip_row = False

    def _fill_spans(self):
        while len(self.row) in self.spans:
            col = len(self.row)
            self.row.append("")
            self.spans[col] -= 1
            if self.spans[col] == 0:
                del self.spans[col]

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self.row, self.skip_row, self.first = [], False, True
        elif tag in ("td", "th") and self.row is not None:
            if "freezebar" in (a.get("class") or ""):
                self.cell = None
                self.freeze = True
                return
            self.freeze = False
            if tag == "th":  # row number / column letters
                if "freezebar" in (a.get("class") or ""):
                    self.skip_row = True
                self.cell = None
                self.header_cell = True
                return
            self.header_cell = False
            self._fill_spans()
            self.cell = []
            self.colspan = int(a.get("colspan") or 1)
            self.rowspan = int(a.get("rowspan") or 1)
        elif tag == "br" and self.cell is not None:
            self.cell.append("\n")
        elif tag == "use" and self.cell is not None:
            href = a.get("href") or a.get("xlink:href") or ""
            if "unchecked-checkbox" in href:
                self.cell.append("FALSE")
            elif "checked-checkbox" in href:
                self.cell.append("TRUE")

    def handle_endtag(self, tag):
        if tag in ("td",) and self.cell is not None and self.row is not None:
            text = re.sub(r"[ \t ]+", " ", "".join(self.cell)).strip()
            start = len(self.row)
            self.row.append(text)
            self.row.extend([""] * (self.colspan - 1))
            if self.rowspan > 1:
                for c in range(start, start + self.colspan):
                    self.spans[c] = self.rowspan - 1
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self._fill_spans()
            if not self.skip_row and any(self.row):
                self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def load_tabs(zip_path):
    tabs = {}
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if name.endswith(".html") and "/" not in name:
                p = SheetParser()
                p.feed(z.read(name).decode("utf-8"))
                tabs[name[:-5]] = p.rows
    return tabs


def hnorm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def find_header(rows, *required):
    """Index of the first row containing all required header names, plus name -> [columns]."""
    req = [hnorm(r) for r in required]
    for i, row in enumerate(rows):
        cols = defaultdict(list)
        for c, v in enumerate(row):
            cols[hnorm(v)].append(c)
        if all(r in cols for r in req):
            return i, cols
    raise ValueError(f"header {required} not found")


def cell(row, cols, name, n=0):
    idx = cols.get(hnorm(name), [])
    if len(idx) <= n:
        return ""
    c = idx[n]
    return row[c].strip() if c < len(row) else ""


# ---------------------------------------------------------------- value cleaning

report = defaultdict(list)  # section -> lines


def note(section, text):
    report[section].append(text)


def steam(s):
    m = re.search(r"STEAM_[0-5]:([01]):(\d+)", (s or "").upper().replace(" ", ""))
    return f"STEAM_0:{m.group(1)}:{m.group(2)}" if m else None


def parse_date(s, where=""):
    s = (s or "").strip()
    if not s or s.upper() in ("N/A", "NONE", "NO START", "NO END", "-"):
        return None
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        d, mo, y = map(int, m.groups())
        if 1020 <= y <= 1030:  # typo seen in the sheet: 1026 for 2026
            note("Dates with a corrected year", f"{where or 'date'}: `{s}` read as {d:02d}/{mo:02d}/{y + 1000}")
            y += 1000
        try:
            value = dt.date(y, mo, d)
            if 2020 <= y <= 2030:
                return value
        except ValueError:
            pass
    if where:
        note("Unreadable dates (left empty)", f"{where}: `{s}`")
    return None


def parse_ts(s):
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})", (s or "").strip())
    if not m:
        return None
    d, mo, y, h, mi, se = map(int, m.groups())
    return dt.datetime(y, mo, d, h, mi, se)


def parse_num(s):
    s = (s or "").replace(",", "").replace("$", "").replace("£", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def rank_code(s):
    s = re.sub(r"\(.*?\)", "", s or "")
    return RANK_ALIAS.get(re.sub(r"[^a-z]", "", s.lower()))


def is_true(s):
    return (s or "").strip().upper() == "TRUE"


def clean(s):
    s = (s or "").strip()
    return None if s in ("", "N/A", "#N/A", "#REF!", "-") else s


# ---------------------------------------------------------------- people

QUOTES = "'\"‘’“”`"


def name_tokens(name):
    n = re.sub(r"\[.*?\]", " ", name.lower())
    n = re.sub(f"[{QUOTES}.]", " ", n)
    return [t for t in re.split(r"[^a-z0-9À-ɏ]+", n) if t]


def nicknames(name):
    return [" ".join(name_tokens(m)) for m in re.findall(f"[{QUOTES}]([^{QUOTES}]+)[{QUOTES}]", name)]


class Person:
    def __init__(self, steam_id):
        self.id = str(uuid.uuid4())
        self.steam = steam_id
        self.names = {}          # name -> first seen date
        self.latest = (dt.date.min, None)
        self.discord = (dt.date.min, None)
        self.roster_name = None

    @property
    def display(self):
        return self.roster_name or self.latest[1] or next(iter(self.names), "Unknown")


class People:
    def __init__(self):
        self.by_steam, self.legacy, self.all = {}, {}, []
        self.index = None

    def see(self, steam_id, name, when=None, discord=None):
        if not steam_id:
            return None
        p = self.by_steam.get(steam_id)
        if not p:
            p = self.by_steam[steam_id] = Person(steam_id)
            self.all.append(p)
        self._name(p, name, when)
        if discord and (when or dt.date.min) >= p.discord[0]:
            p.discord = (when or dt.date.min, discord)
        return p

    def _name(self, p, name, when):
        name = (name or "").strip()
        if not name or name.upper() in ("N/A", "#N/A", "#REF!"):
            return
        when_key = when or dt.date.min
        if name not in p.names or (when and (p.names[name] is None or when < p.names[name])):
            p.names[name] = when
        if when_key >= p.latest[0]:
            p.latest = (when_key, name)

    def build_index(self):
        self.index = {"full": defaultdict(set), "nick": defaultdict(set), "token": defaultdict(set), "tokens": []}
        for p in self.all:
            for n in p.names:
                toks = name_tokens(n)
                self.index["full"][" ".join(toks)].add(p)
                for k in nicknames(n):
                    self.index["nick"][k].add(p)
                for t in toks:
                    self.index["token"][t].add(p)
                self.index["tokens"].append((set(toks), p))

    def match(self, name):
        """Resolve a name without a Steam ID. Returns a Person only when the match is unambiguous."""
        toks = name_tokens(name or "")
        if not toks:
            return None
        key = " ".join(toks)
        for bucket in ("full", "nick"):
            hit = self.index[bucket].get(key)
            if hit and len(hit) == 1:
                return next(iter(hit))
        if len(toks) == 1:
            hit = self.index["token"].get(toks[0])
            return next(iter(hit)) if hit and len(hit) == 1 else None
        hits = {p for tokset, p in self.index["tokens"] if set(toks) <= tokset}
        return next(iter(hits)) if len(hits) == 1 else None

    def resolve(self, steam_id, name, where, create=True):
        """Steam ID first, then name; creates a legacy person (no Steam ID) as last resort."""
        if not steam_id and steam(name):  # Steam ID typed into the name column
            steam_id = steam(name)
            if steam_id not in self.by_steam:
                return self.see(steam_id, name, None) if create else None
        if steam_id and steam_id in self.by_steam:
            return self.by_steam[steam_id]
        p = self.match(name)
        if p:
            return p
        if not create:
            return None
        if not clean(name):
            if steam_id:  # Steam ID only seen here, no name given
                return self.see(steam_id, steam_id, None)
            name = f"Unknown ({where})"
        key = " ".join(name_tokens(name))
        if key not in self.legacy:
            lp = Person(None)
            self._name(lp, name, None)
            self.legacy[key] = lp
            self.all.append(lp)
            note("People without a Steam ID (created as legacy entries)", f"`{name}` ({where})")
        return self.legacy[key]


people = People()

# ---------------------------------------------------------------- tab readers (rows -> dicts)


def rows_after(rows, idx, cols, key="steamid", n=0):
    for row in rows[idx + 1:]:
        if any(c.strip() for c in row):
            yield row


def read_roster(rows):
    i, cols = find_header(rows, "Rank*", "Name", "Steam ID", "Status", "Cooldown")
    members, slots, rank = [], defaultdict(int), None
    for row in rows[i + 1:]:
        r = cell(row, cols, "Rank*")
        if r:
            rank = rank_code(r)
        name, sid = cell(row, cols, "Name"), steam(cell(row, cols, "Steam ID"))
        joined = " ".join(row)
        if "Hammer Down" in joined:
            continue
        if rank and (cell(row, cols, "Cooldown") in ("TRUE", "FALSE") or name or cell(row, cols, "Status")):
            slots[rank] += 1
        if rank and sid:
            members.append(dict(rank=rank, name=name, steam=sid, discord=clean(cell(row, cols, "Discord Username")),
                                status=cell(row, cols, "Status"), strikes=parse_num(cell(row, cols, "Strikes")),
                                hours=parse_num(cell(row, cols, "Hours")),
                                cooldown=is_true(cell(row, cols, "Cooldown")),
                                last_promo_raw=cell(row, cols, "Last Promotion Date"),
                                notes=clean(cell(row, cols, "Notes"))))
    return members, slots


def read_simple(rows, *required):
    i, cols = find_header(rows, *required)
    return cols, [r for r in rows[i + 1:] if any(x.strip() for x in r)]


# ---------------------------------------------------------------- main import


def main(zip_path, out_dir):
    tabs = load_tabs(zip_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    roster, slots = read_roster(tabs["Roster"])
    db_cols, db_rows = read_simple(tabs["Database"], "SteamID", "Last Recruited")
    duty_cols, duty_rows = read_simple(tabs["Duty Logs"], "Date", "Name", "SteamID", "Hours")
    tr_cols, tr_rows = read_simple(tabs["Training Logs"], "Date", "Name", "Steam ID", "Type of Training", "Attendees")
    to_cols, to_rows = read_simple(tabs["Tryout Logs"], "Date", "Name", "Steam ID", "Status", "Host Name")
    qz_cols, qz_rows = read_simple(tabs["RAW_TRYOUT_QUIZ"], "Timestamp", "Score", "Your Steam ID")
    pr_cols, pr_rows = read_simple(tabs["Promotion & Demotion Logs"], "Date", "Steam ID", "Previous Rank", "New Rank")
    st_cols, st_rows = read_simple(tabs["Strike Logs"], "Date", "Expiry Date", "Steam ID", "Strike Weight")
    in_cols, in_rows = read_simple(tabs["Infraction Logs"], "Date", "Steam ID", "Punishment")
    lo_cols, lo_rows = read_simple(tabs["LOA & ROA"], "Date", "SteamID", "LOA or ROA", "Start Date", "End Date")
    di_cols, di_rows = read_simple(tabs["Discharges"], "Date", "Steam ID", "Rank", "Status", "Officer SteamID")
    bl_cols, bl_rows = read_simple(tabs["Blacklists"], "Date", "SteamID", "Reason", "Appealable to", "Expires")
    me_cols, me_rows = read_simple(tabs["Medal Logs"], "Date", "Recipients Name", "Medal Type")
    fu_cols, fu_rows = read_simple(tabs["Funds Logs"], "Date", "SteamID", "Reason")

    def d(row, cols, name="Date", n=0, where=""):
        return parse_date(cell(row, cols, name, n), where)

    # ---- pass 1: everyone with a Steam ID
    for m in roster:
        p = people.see(m["steam"], m["name"], TODAY, m["discord"])
        p.roster_name = m["name"]
    for row in db_rows:
        people.see(steam(cell(row, db_cols, "SteamID")), cell(row, db_cols, "Name"), TODAY,
                   clean(cell(row, db_cols, "Discord Username")))
    for row in duty_rows:
        people.see(steam(cell(row, duty_cols, "SteamID")), cell(row, duty_cols, "Name"), d(row, duty_cols))
    for row in tr_rows:
        people.see(steam(cell(row, tr_cols, "Steam ID")), cell(row, tr_cols, "Name"), d(row, tr_cols))
    for row in to_rows:
        when = d(row, to_cols)
        people.see(steam(cell(row, to_cols, "Steam ID")), cell(row, to_cols, "Name"), when,
                   clean(cell(row, to_cols, "Discord Username")))
        people.see(steam(cell(row, to_cols, "Host Steam ID")), cell(row, to_cols, "Host Name"), when)
    for row in pr_rows:
        people.see(steam(cell(row, pr_cols, "Steam ID")), cell(row, pr_cols, "Name"), d(row, pr_cols))
    for row in st_rows:
        people.see(steam(cell(row, st_cols, "Steam ID")), cell(row, st_cols, "Name"), d(row, st_cols))
    for row in in_rows:
        people.see(steam(cell(row, in_cols, "Steam ID")), cell(row, in_cols, "Name"), d(row, in_cols))
    for row in lo_rows:
        people.see(steam(cell(row, lo_cols, "SteamID")), cell(row, lo_cols, "Name"), d(row, lo_cols))
    for row in di_rows:
        when = d(row, di_cols)
        people.see(steam(cell(row, di_cols, "Steam ID")), cell(row, di_cols, "Name"), when)
        people.see(steam(cell(row, di_cols, "Officer SteamID")), cell(row, di_cols, "Officer Name"), when)
    for row in bl_rows:
        when = d(row, bl_cols)
        people.see(steam(cell(row, bl_cols, "SteamID")), cell(row, bl_cols, "Name"), when)
        people.see(steam(cell(row, bl_cols, "SteamID", 1)), cell(row, bl_cols, "Name", 1), when)
    for row in me_rows:
        when = d(row, me_cols)
        people.see(steam(cell(row, me_cols, "Recipients SteamID")), cell(row, me_cols, "Recipients Name"), when)
        people.see(steam(cell(row, me_cols, "Issuer SteamID")), cell(row, me_cols, "Issuer Name"), when)
    for row in fu_rows:
        people.see(steam(cell(row, fu_cols, "SteamID")), cell(row, fu_cols, "Name"), d(row, fu_cols))
    for row in qz_rows:
        ts = parse_ts(cell(row, qz_cols, "Timestamp"))
        people.see(steam(cell(row, qz_cols, "Your Steam ID")), cell(row, qz_cols, "Your character's name"),
                   ts.date() if ts else None)
    people.build_index()

    sql = SqlWriter()

    # ---- reference tables
    sql.insert("rank_category", ["id", "name", "sort_order"], CATEGORIES)
    sql.insert("rank", ["id", "code", "name", "category_id", "sort_order", "max_slots",
                        "weekly_hours_required", "cooldown_days"],
               [(RANK_ID[c], c, n, cat, RANK_ID[c], slots.get(c) or None, WEEKLY_HOURS[cat], COOLDOWN_DAYS)
                for c, n, cat, _a in RANKS])

    # ---- rank changes (needed before memberships for recruit dates)
    rank_changes = []
    for row in pr_rows:
        sid = steam(cell(row, pr_cols, "Steam ID"))
        name = cell(row, pr_cols, "Name")
        when = d(row, pr_cols, where=f"Promotion log, {name}")
        status = cell(row, pr_cols, "Status").lower()
        kind = {"promoted": "promoted", "demoted": "demoted", "bookkeeping": "bookkeeping"}.get(status)
        to_rank, from_rank = rank_code(cell(row, pr_cols, "New Rank")), rank_code(cell(row, pr_cols, "Previous Rank"))
        if not (when and kind and to_rank):
            note("Skipped promotion log rows", f"{cell(row, pr_cols, 'Date')} `{name}`: "
                 f"{cell(row, pr_cols, 'Previous Rank')} → {cell(row, pr_cols, 'New Rank')} ({status or 'no status'})")
            continue
        p = people.resolve(sid, name, "promotion log")
        officer_raw = clean(cell(row, pr_cols, "Officer Information"))
        officer = people.match(officer_raw) if officer_raw else None
        rank_changes.append((p.id, RANK_ID.get(from_rank), RANK_ID[to_rank], kind, when,
                             officer.id if officer else None, officer_raw, clean(cell(row, pr_cols, "Comments"))))

    # ---- memberships
    recruited = {}
    for row in db_rows:
        sid = steam(cell(row, db_cols, "SteamID"))
        if sid:
            recruited[sid] = d(row, db_cols, "Last Recruited", where=f"Database tab, {cell(row, db_cols, 'Name')}")
    first_seen = defaultdict(lambda: None)
    for pid, _f, _t, _k, when, *_ in rank_changes:
        if first_seen[pid] is None or when < first_seen[pid]:
            first_seen[pid] = when

    memberships, current = [], {}
    for m in roster:
        p = people.by_steam[m["steam"]]
        status = (m["status"] or "").strip()
        override = status if status and status.lower() not in STANDARD_STATUSES else None
        if override:
            note("Statuses kept as a manual override", f"{m['name']}: `{status}`")
        mid = str(uuid.uuid4())
        current[p.id] = mid
        memberships.append((mid, p.id, RANK_ID[m["rank"]], recruited.get(m["steam"]) or first_seen[p.id],
                            None, None, None, None, None, override, m["notes"]))
        parse_date(m["last_promo_raw"], where=f"Roster, {m['name']} (Last Promotion Date)")

    for row in di_rows:
        sid = steam(cell(row, di_cols, "Steam ID"))
        name = cell(row, di_cols, "Name")
        when = d(row, di_cols, where=f"Discharges, {name}")
        rank = rank_code(cell(row, di_cols, "Rank"))
        if not (when and rank):
            note("Skipped discharge rows", f"`{name}` {cell(row, di_cols, 'Date')} rank `{cell(row, di_cols, 'Rank')}`")
            continue
        p = people.resolve(sid, name, "discharges")
        if p.id in current:
            note("Discharged but on the current roster (kept as an earlier membership)", f"{name} ({sid}), discharged {when}")
        officer_raw = clean(cell(row, di_cols, "Officer Name"))
        officer = people.resolve(steam(cell(row, di_cols, "Officer SteamID")), officer_raw, "discharges", create=False)
        dtype = cell(row, di_cols, "Status").lower()
        memberships.append((str(uuid.uuid4()), p.id, RANK_ID[rank], None, when,
                            dtype if dtype in ("honourable", "dishonourable") else None,
                            clean(cell(row, di_cols, "Comments")), officer.id if officer else None, officer_raw,
                            None, None))

    # ---- duty logs
    duty = []
    for row in duty_rows:
        name = cell(row, duty_cols, "Name")
        when = d(row, duty_cols, where=f"Duty log, {name}")
        hours = parse_num(cell(row, duty_cols, "Hours"))
        if when is None or hours is None:
            note("Skipped duty log rows", f"{cell(row, duty_cols, 'Date')} `{name}` hours `{cell(row, duty_cols, 'Hours')}`")
            continue
        p = people.resolve(steam(cell(row, duty_cols, "SteamID")), name, "duty log")
        raw_rank = cell(row, duty_cols, "Rank")
        duty.append((p.id, when, hours, RANK_ID.get(rank_code(raw_rank)), clean(raw_rank),
                     clean(cell(row, duty_cols, "Comments"))))

    # ---- trainings
    type_ids, trainings, attendees = {}, [], []
    for row in tr_rows:
        host_name = cell(row, tr_cols, "Name")
        when = d(row, tr_cols, where=f"Training log, host {host_name}")
        ttype = clean(cell(row, tr_cols, "Type of Training")) or "Unlisted"
        if ttype.lower().startswith("unlisted"):
            ttype = "Unlisted"
        if when is None:
            continue
        if ttype not in type_ids:
            type_ids[ttype] = len(type_ids) + 1
        host = people.resolve(steam(cell(row, tr_cols, "Steam ID")), host_name, "training host")
        tid = len(trainings) + 1
        trainings.append((tid, host.id, None, type_ids[ttype], when,
                          clean(cell(row, tr_cols, "If unlisted, Explain here:")), clean(cell(row, tr_cols, "Comments"))))
        seen = set()
        for raw in re.split(r",|&|/|;|\n|\band\b|\+", cell(row, tr_cols, "Attendees")):
            raw = raw.strip(" .-")
            if not raw or len(raw) < 2:
                continue
            p = people.match(raw)
            if p and p.id in seen:
                continue
            if p:
                seen.add(p.id)
            else:
                note("Training attendees without a match (kept as text)", f"`{raw}` ({when}, host {host_name})")
            attendees.append((tid, p.id if p else None, raw))

    # ---- tryouts + quiz
    tryouts = []
    tryout_index = defaultdict(list)  # recruit id -> [(date, tryout id)]
    for row in to_rows:
        name = cell(row, to_cols, "Name")
        sid = steam(cell(row, to_cols, "Steam ID"))
        when = d(row, to_cols, where=f"Tryout log, {name}")
        result = cell(row, to_cols, "Status").lower()
        if name.lower().startswith("test") and not sid:
            note("Skipped tryout rows", f"test entry `{name}`")
            continue
        if when is None or result not in ("passed", "failed"):
            note("Skipped tryout rows", f"{cell(row, to_cols, 'Date')} `{name}` status `{result}`")
            continue
        recruit = people.resolve(sid, name, "tryout recruit")
        if recruit is None:
            note("Skipped tryout rows", f"{cell(row, to_cols, 'Date')} no recruit name or Steam ID")
            continue
        host_raw = clean(cell(row, to_cols, "Host Name"))
        host = people.resolve(steam(cell(row, to_cols, "Host Steam ID")), host_raw, "tryout host", create=False)
        tid = len(tryouts) + 1
        tryouts.append((tid, recruit.id, host.id if host else None, None if host else host_raw, when, result,
                        parse_num(cell(row, to_cols, "Strikes")) or 0, clean(cell(row, to_cols, "Comments"))))
        tryout_index[recruit.id].append((when, tid))

    question_cols = [(c, h) for h, idxs in qz_cols.items() for c in idxs if h[:1].isdigit()]
    header_row = next(r for r in tabs["RAW_TRYOUT_QUIZ"] if "Timestamp" in r)
    quizzes = {}
    for row in qz_rows:
        ts = parse_ts(cell(row, qz_cols, "Timestamp"))
        sid = steam(cell(row, qz_cols, "Your Steam ID"))
        p = people.by_steam.get(sid) if sid else people.match(cell(row, qz_cols, "Your character's name"))
        if not (ts and p and tryout_index.get(p.id)):
            note("Quiz answers without a matching tryout", f"{cell(row, qz_cols, 'Timestamp')} "
                 f"`{cell(row, qz_cols, 'Your character' + chr(39) + 's name')}`")
            continue
        when, tid = min(tryout_index[p.id], key=lambda x: abs((x[0] - ts.date()).days))
        if abs((when - ts.date()).days) > 2:
            note("Quiz answers without a matching tryout", f"{ts:%d/%m/%Y} {p.display}: nearest tryout {when}")
            continue
        sm = re.match(r"(\d+)\s*/\s*(\d+)", cell(row, qz_cols, "Score"))
        answers = {header_row[c]: row[c] for c, _h in sorted(question_cols) if c < len(row) and row[c].strip()}
        quizzes[tid] = (tid, ts, int(sm.group(1)) if sm else None, int(sm.group(2)) if sm else None, answers)

    # ---- strikes, infractions, leave
    strikes = []
    for row in st_rows:
        name = cell(row, st_cols, "Name")
        when = d(row, st_cols, where=f"Strike log, {name}")
        weight = parse_num(cell(row, st_cols, "Strike Weight"))
        if when is None or weight is None:
            note("Skipped strike rows", f"`{name}` {cell(row, st_cols, 'Date')}")
            continue
        p = people.resolve(steam(cell(row, st_cols, "Steam ID")), name, "strike log")
        officer_raw = clean(cell(row, st_cols, "Officers Name"))
        officer = people.match(officer_raw) if officer_raw else None
        appealed = cell(row, st_cols, "Expiry").lower() == "appealed" or is_true(cell(row, st_cols, "Appealed?"))
        strikes.append((p.id, weight, clean(cell(row, st_cols, "Reason")), when,
                        d(row, st_cols, "Expiry Date", where=f"Strike log expiry, {name}"),
                        officer.id if officer else None, officer_raw, "granted" if appealed else "none",
                        clean(cell(row, st_cols, "Appealed To*")), clean(cell(row, st_cols, "Appealed Reason"))))

    infractions = []
    for row in in_rows:
        name = cell(row, in_cols, "Name")
        when = d(row, in_cols, where=f"Infraction log, {name}")
        if when is None:
            continue
        p = people.resolve(steam(cell(row, in_cols, "Steam ID")), name, "infraction log")
        off_raw = clean(cell(row, in_cols, "Officers Name"))
        ex_raw = clean(cell(row, in_cols, "Executed By"))
        off, ex = (people.match(off_raw) if off_raw else None), (people.match(ex_raw) if ex_raw else None)
        infractions.append((p.id, when, clean(cell(row, in_cols, "Reason")), clean(cell(row, in_cols, "Punishment")),
                            off.id if off else None, off_raw, is_true(cell(row, in_cols, "Executed?")),
                            ex.id if ex else None, ex_raw, parse_date(cell(row, in_cols, "Becomes Strike On")),
                            clean(cell(row, in_cols, "Appealed?"))))

    leaves = []
    for row in lo_rows:
        name = cell(row, lo_cols, "Name")
        start = d(row, lo_cols, "Start Date", where=f"LOA/ROA start, {name}")
        end = d(row, lo_cols, "End Date", where=f"LOA/ROA end, {name}")
        ltype = cell(row, lo_cols, "LOA or ROA").upper()
        if not (start and end and ltype in ("LOA", "ROA")):
            note("Skipped LOA/ROA rows", f"`{name}` {cell(row, lo_cols, 'Start Date')}–{cell(row, lo_cols, 'End Date')} `{ltype}`")
            continue
        if end < start:
            note("LOA/ROA with end before start (dates swapped)", f"{name}: {start} → {end}")
            start, end = end, start
        p = people.resolve(steam(cell(row, lo_cols, "SteamID")), name, "LOA/ROA")
        off_raw = clean(cell(row, lo_cols, "Officer"))
        off = people.match(off_raw) if off_raw else None
        leaves.append((p.id, ltype, d(row, lo_cols), start, end, clean(cell(row, lo_cols, "Reason")),
                       off.id if off else None, off_raw, clean(cell(row, lo_cols, "Officers note"))))

    # ---- blacklists
    blacklists, appeals = [], []
    for row in bl_rows:
        name = cell(row, bl_cols, "Name")
        sid = steam(cell(row, bl_cols, "SteamID"))
        when = d(row, bl_cols, where=f"Blacklist, {name}")
        if when is None or not clean(name):
            continue
        p = people.resolve(sid, name, "blacklist")
        off_raw = clean(cell(row, bl_cols, "Name", 1))
        off = people.resolve(steam(cell(row, bl_cols, "SteamID", 1)), off_raw, "blacklist officer", create=False)
        expires_raw = cell(row, bl_cols, "Expires")
        expires = None if expires_raw.lower().startswith("appeal") else parse_date(expires_raw, f"Blacklist expiry, {name}")
        bid = len(blacklists) + 1
        blacklists.append((bid, p.id, clean(cell(row, bl_cols, "Reason")), clean(cell(row, bl_cols, "Appealable to")),
                           off.id if off else None, off_raw, when, expires))
        to_raw = clean(cell(row, bl_cols, "Appealed to"))
        if is_true(cell(row, bl_cols, "Appealed / Unblacklisted")):
            by = people.match(to_raw) if to_raw else None
            appeals.append((bid, None, "revoked", None, by.id if by else None, to_raw, "Ticked as appealed / unblacklisted in the sheet"))
        elif sid in MANUAL_REVOCATIONS:
            appeals.append((bid, None, "revoked", None, None, None, MANUAL_REVOCATIONS[sid]))
            note("Blacklist entries revoked from outside the sheet", f"{name} ({sid}) – {MANUAL_REVOCATIONS[sid]}")

    # ---- medals
    family_criteria = read_medal_criteria(tabs.get("Medals", []))
    medal_ids, awards = {}, []
    for row in me_rows:
        mname = clean(cell(row, me_cols, "Medal Type"))
        rname = cell(row, me_cols, "Recipients Name")
        if not mname or not clean(rname):
            continue
        if mname not in medal_ids:
            medal_ids[mname] = len(medal_ids) + 1
        p = people.resolve(steam(cell(row, me_cols, "Recipients SteamID")), rname, "medal recipient")
        iss_raw = clean(cell(row, me_cols, "Issuer Name"))
        iss = people.resolve(steam(cell(row, me_cols, "Issuer SteamID")), iss_raw, "medal issuer", create=False)
        awards.append((p.id, medal_ids[mname], d(row, me_cols, where=f"Medal log, {rname}"),
                       iss.id if iss else None, iss_raw))
    medal_rows = []
    for mname, mid in medal_ids.items():
        grade = mname.split()[0] if mname.split()[0] in ("Bronze", "Silver", "Gold", "Ruby", "Sapphire", "Diamond") else None
        family = mname[len(grade) + 1:] if grade else mname
        crit = next((v for k, v in family_criteria.items() if hnorm(k).rstrip("s") in hnorm(family) or hnorm(family) in hnorm(k)), None)
        medal_rows.append((mid, mname, family, grade, crit))

    # ---- funds
    funds = []
    for row in fu_rows:
        amount = parse_num(cell(row, fu_cols, "Amount (CA$)"))
        if amount is None:
            continue
        name = cell(row, fu_cols, "Name")
        p = people.resolve(steam(cell(row, fu_cols, "SteamID")), name, "funds")
        funds.append((p.id, amount, clean(cell(row, fu_cols, "Reason")), d(row, fu_cols, where=f"Funds, {name}")))

    # ---- requirements and their ticks
    quals, reqs, ticks = {}, [], []
    for stage in read_requirements(tabs["Promotion Requirements"]):
        frm = RANK_ID.get(stage["from"])
        if not frm:
            continue
        for n, title in stage["reqs"]:
            kind, params, qual = classify_requirement(title)
            if kind is None:
                continue
            if kind == "qualification":
                qname = re.sub(r"^(get|complete)\s+(an?\s+)?", "", title, flags=re.I).strip()
                quals.setdefault(qname, len(quals) + 1)
                qual = quals[qname]
            rid = len(reqs) + 1
            reqs.append((rid, frm, title, kind, qual, json.dumps(params), n))
            stage["req_ids"][f"Req. {n}"] = rid
        if stage["has_cd"]:
            rid = len(reqs) + 1
            reqs.append((rid, frm, "Cooldown expired", "cooldown", None, "{}", 9))
            stage["req_ids"]["Cd"] = rid
        for sid, name, values in stage["members"]:
            p = people.by_steam.get(sid)
            mid = current.get(p.id) if p else None
            if not mid:
                note("Requirement ticks for people not on the roster (skipped)", f"{name} ({stage['from']} → {stage['to']})")
                continue
            for col, val in values.items():
                rid = stage["req_ids"].get(col)
                # activity and cooldown are calculated live; a stored tick would go stale
                if rid and val == "TRUE" and reqs[rid - 1][3] not in ("activity", "cooldown"):
                    ticks.append((mid, rid, True))

    # ---- battalions, units, memorial
    battalions, bat_members = read_battalions(tabs["Battalions"])
    units, unit_roles = read_units(tabs["Management"])
    memorial = read_memorial(tabs["Memorial Hall"])

    # ---- people and aliases (after everything above may have added legacy people)
    identity_issues = []
    for p in people.all:
        distinct = {" ".join(name_tokens(n)) for n in p.names}
        if p.steam and len(distinct) >= 3:
            identity_issues.append(f"{p.steam}: " + ", ".join(f"`{n}`" for n in sorted(p.names)))
    for line in identity_issues:
        note("Steam IDs used under 3+ different names (check these are the same person)", line)

    sql.insert("person", ["id", "steam_id", "discord_username", "display_name"],
               [(p.id, p.steam, p.discord[1], p.display) for p in people.all])
    sql.insert("person_alias", ["person_id", "name", "first_seen"],
               [(p.id, n, w) for p in people.all for n, w in p.names.items()])
    sql.insert("membership", ["id", "person_id", "rank_id", "recruited_at", "left_at", "discharge_type",
                              "discharge_reason", "discharged_by", "discharged_by_raw", "status_override", "notes"],
               memberships)
    sql.insert("rank_change", ["person_id", "from_rank_id", "to_rank_id", "kind", "effective_on",
                               "officer_id", "officer_raw", "comment"], rank_changes)
    sql.insert("qualification", ["id", "name"], [(i, n) for n, i in quals.items()])
    sql.insert("requirement", ["id", "from_rank_id", "title", "kind", "qualification_id", "params", "sort_order"], reqs)
    sql.insert("member_requirement", ["membership_id", "requirement_id", "done"], ticks)
    sql.insert("duty_log", ["person_id", "logged_on", "hours", "rank_id", "rank_raw", "comment", "source"],
               [d + ("import",) for d in duty])
    sql.insert("training_type", ["id", "name", "is_basic_training"],
               [(i, n, "basic training" in n.lower()) for n, i in type_ids.items()])
    sql.insert("training", ["id", "host_id", "host_raw", "type_id", "held_on", "description", "comment"], trainings)
    sql.insert("training_attendee", ["training_id", "person_id", "raw_name"], attendees)
    sql.insert("tryout", ["id", "recruit_id", "host_id", "host_raw", "held_on", "result", "strikes", "comment"], tryouts)
    sql.insert("tryout_quiz", ["tryout_id", "taken_at", "score", "max_score", "answers"],
               [(t, ts, s, mx, json.dumps(a, ensure_ascii=False)) for t, ts, s, mx, a in quizzes.values()])
    sql.insert("strike", ["person_id", "weight", "reason", "issued_on", "expires_on", "officer_id", "officer_raw",
                          "appeal_status", "appealable_to", "appeal_reason"], strikes)
    sql.insert("infraction", ["person_id", "issued_on", "reason", "punishment", "officer_id", "officer_raw",
                              "executed", "executed_by", "executed_by_raw", "becomes_strike_on", "appeal_status"],
               infractions)
    sql.insert("leave", ["person_id", "type", "requested_on", "starts_on", "ends_on", "reason",
                         "approved_by", "approved_by_raw", "officer_note"], leaves)
    sql.insert("blacklist", ["id", "person_id", "reason", "appealable_to", "officer_id", "officer_raw",
                             "issued_on", "expires_on"], blacklists)
    sql.insert("blacklist_appeal", ["blacklist_id", "appealed_on", "decision", "decided_on", "decided_by",
                                    "decided_by_raw", "reason"], appeals)
    sql.insert("medal_type", ["id", "name", "family", "grade", "criteria"], medal_rows)
    sql.insert("medal_award", ["person_id", "medal_type_id", "awarded_on", "issuer_id", "issuer_raw"], awards)
    sql.insert("fund_transaction", ["person_id", "amount", "reason", "booked_on"], funds)
    sql.insert("battalion", ["id", "name", "specialisation", "min_rank_id"], battalions)
    sql.insert("battalion_member", ["battalion_id", "person_id"], bat_members)
    sql.insert("unit", ["id", "name", "lead_min_rank_id", "assistant_min_rank_id"], units)
    sql.insert("unit_role", ["unit_id", "person_id", "role"], unit_roles)
    sql.insert("memorial_entry", ["id", "person_id", "section", "rank_code", "name", "quote"], memorial)
    for table in ("training", "tryout", "blacklist"):
        sql.lines.append(f"select setval(pg_get_serial_sequence('{table}', 'id'), (select coalesce(max(id), 1) from {table}));")

    (out / "data.sql").write_text("begin;\n" + "\n".join(sql.lines) + "\ncommit;\n", encoding="utf-8")
    write_report(out / "import-report.md", sql.counts, roster)
    print("\n".join(f"{t:20} {n:6}" for t, n in sql.counts.items()))


# ---------------------------------------------------------------- structured tabs


def classify_requirement(title):
    t = title.lower()
    if t.strip() in ("none", ""):
        return None, None, None
    if "activity" in t:
        return "activity", {}, None
    if "basic training" in t:
        return "attended_basic", {}, None
    if "training" in t:
        return "hosted_training", {"count": 1, "days": 14}, None
    if "tryout" in t:
        return "hosted_tryout", {"count": 1}, None
    if "license" in t or "hack" in t:
        return "qualification", {}, None
    return "manual", {}, None


def read_requirements(rows):
    stages = []
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            m = re.match(r"\s*([A-Z]+)\s*->\s*([A-Z]+)", v)
            if not m:
                continue
            st = dict(**{"from": rank_code(m.group(1)), "to": rank_code(m.group(2))}, reqs=[], members=[],
                      req_ids={}, has_cd=False)
            hdr = None
            for rr in range(r + 1, len(rows)):
                val = rows[rr][c] if c < len(rows[rr]) else ""
                rm = re.match(r"Requirement\s*(\d+)\s*:\s*(.+)", val)
                if rm:
                    st["reqs"].append((int(rm.group(1)), rm.group(2).strip()))
                elif val.strip() == "Name":
                    hdr = rr
                    break
            if hdr is None:
                continue
            cols = {}
            for cc in range(c + 2, len(rows[hdr])):
                h = rows[hdr][cc].strip()
                if not (h.startswith("Req.") or h == "Cd"):
                    break
                cols[h] = cc
            st["has_cd"] = "Cd" in cols
            for rr in range(hdr + 1, len(rows)):
                rw = rows[rr]
                sid = steam(rw[c + 1]) if c + 1 < len(rw) else None
                if sid:
                    st["members"].append((sid, rw[c], {h: (rw[cc] if cc < len(rw) else "") for h, cc in cols.items()}))
            stages.append(st)
    return stages


def read_medal_criteria(rows):
    crit = {}
    for r, row in enumerate(rows):
        if any(v.strip() == "Nu-7 Cross" for v in row) and r + 1 < len(rows):
            for c, v in enumerate(row):
                if v.strip() and c < len(rows[r + 1]) and rows[r + 1][c].strip():
                    crit[v.strip()] = rows[r + 1][c].strip().replace("\n", " ")
            break
    return crit


def read_battalions(rows):
    hdr = next(i for i, r in enumerate(rows) if [hnorm(x) for x in r].count("steamid") >= 2)
    names_row = next((r for r in rows[:hdr] if any("Iron Vanguards" in x for x in r)), [])
    names_idx = rows.index(names_row) if names_row else None
    battalions, members = [], []
    for c, v in enumerate(rows[hdr]):
        if hnorm(v) != "name":
            continue
        name = names_row[c].strip() if c < len(names_row) else ""
        spec = rows[names_idx + 1][c].strip() if names_idx is not None and c < len(rows[names_idx + 1]) else None
        mem = [(r[c], steam(r[c + 1])) for r in rows[hdr + 1:] if c + 1 < len(r) and steam(r[c + 1])]
        if not name:
            if mem:
                name = f"Unnamed battalion (column {c + 1})"
                note("Battalions without a name in the sheet", f"{name}: {len(mem)} members")
            else:
                continue
        bid = len(battalions) + 1
        battalions.append((bid, name, spec or None, RANK_ID["PVT"]))
        seen = set()
        for mname, sid in mem:
            p = people.by_steam.get(sid)
            if p and p.id not in seen:
                seen.add(p.id)
                members.append((bid, p.id))
    return battalions, members


def read_units(rows):
    units, roles = [], []
    title_row = next(r for r in rows if any("Roster Management" in x for x in r))
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            m = re.match(r"(Lead Manager|Assistant Managers)\s*-\s*([A-Z]+)\+?", v.strip())
            if not m:
                continue
            title = title_row[c].strip() if c < len(title_row) else ""
            if not title:
                title = "Activity Management"
                note("Management blocks without a title", "4th block named `Activity Management` (its description mentions regimental activity)")
            unit = next((u for u in units if u[1] == title), None)
            if not unit:
                unit = [len(units) + 1, title, None, None]
                units.append(unit)
            min_rank = rank_code(m.group(2)) or ("LT" if m.group(2) == "CO" else None)
            role = "lead" if m.group(1).startswith("Lead") else "assistant"
            unit[2 if role == "lead" else 3] = RANK_ID.get(min_rank)
            for rr in range(r + 2, len(rows)):
                cellv = rows[rr][c] if c < len(rows[rr]) else ""
                if re.match(r"(Lead Manager|Assistant Managers)", cellv) or (cellv and len(cellv) > 60):
                    break
                sid = steam(rows[rr][c + 1]) if c + 1 < len(rows[rr]) else None
                if sid:
                    p = people.by_steam.get(sid)
                    if p:
                        roles.append((unit[0], p.id, role))
                    else:
                        note("Management entries with an unknown Steam ID", f"{title}: {sid}")
    return [tuple(u) for u in units], list(dict.fromkeys((u, p, r) for u, p, r in roles))


def read_memorial(rows):
    entries = []
    hdr = next(i for i, r in enumerate(rows) if [hnorm(x) for x in r].count("notesquotes") >= 2)
    sec_row = next(r for r in rows[:hdr] if any("Regimental Command" in x for x in r))
    for c, v in enumerate(rows[hdr]):
        if hnorm(v) != "rank":
            continue
        section = (sec_row[c] if c < len(sec_row) else "").replace("MTF Nu-7", "").strip() or "Other"
        for r in rows[hdr + 1:]:
            name = r[c + 1].strip() if c + 1 < len(r) else ""
            if not name:
                continue
            p = people.match(name)
            entries.append((len(entries) + 1, p.id if p else None, section, clean(r[c]),
                            name, clean(r[c + 2]) if c + 2 < len(r) else None))
    return entries


# ---------------------------------------------------------------- output


def lit(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return f"'{v.isoformat()}'"
    return "'" + str(v).replace("'", "''") + "'"


class SqlWriter:
    def __init__(self):
        self.lines, self.counts = [], {}

    def insert(self, table, columns, rows, batch=500):
        rows = list(rows)
        self.counts[table] = len(rows)
        for i in range(0, len(rows), batch):
            values = ",\n".join("(" + ", ".join(lit(v) for v in r) + ")" for r in rows[i:i + batch])
            self.lines.append(f"insert into {table} ({', '.join(columns)}) values\n{values};")


def write_report(path, counts, roster):
    lines = ["# Nu-7 import report", "", f"Generated {dt.datetime.now():%Y-%m-%d %H:%M}.", "",
             "## Rows imported", "", "| Table | Rows |", "| --- | ---: |"]
    lines += [f"| {t} | {n} |" for t, n in counts.items()]
    lines += ["", f"Current roster: {len(roster)} members.", ""]
    for section in sorted(report):
        items = list(dict.fromkeys(report[section]))
        lines += [f"## {section} ({len(items)})", ""] + [f"- {x}" for x in items] + [""]
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
