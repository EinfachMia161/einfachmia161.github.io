"use strict";
// Nu-7 roster test site. Reading is public; every change is checked by the database
// (row-level security + officer-only functions), the hiding of buttons here is only for convenience.

const SUPABASE_URL = "https://vkqrvppfwqjmxxtjowbn.supabase.co";
const SUPABASE_KEY = "sb_publishable_mgskScP9EMFntMzC8adX-A_qw_z9zYz";  // publishable key: safe to be public
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "nu7-roster-auth" }
});

const KIND_LABEL = { activity: "auto", cooldown: "auto", qualification: "licence", attended_basic: "auto", hosted_training: "auto", hosted_tryout: "auto", manual: "manual" };
const state = { roster: [], ranks: [], stage: null, board: [], reqs: [], discord: new Map(), me: null, session: null,
                view: "roster", mtab: "hours", co: "alerts", trainingTypes: [], attendees: new Set() };
const isOfficer = () => !!state.me?.is_officer;
const isRegcom = () => !!state.me?.is_regcom;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = d => d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-GB") : "–";
const fmtTime = d => d ? new Date(d).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "–";
const num = v => (v === null || v === undefined) ? "–" : (+v % 1 ? (+v).toFixed(1) : String(+v));
const slug = s => String(s || "").toLowerCase().replace(/\s+/g, "-");
const pill = s => `<span class="pill s-${slug(s)}">${esc(s)}</span>`;
const isoDay = (offset = 0) => { const d = new Date(Date.now() + offset * 864e5); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const box = (text, ok) => `<div class="${ok ? "okbox" : "errbox"}">${esc(text)}</div>`;

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast" + (isErr ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2800);
}
function check(res, what) {
  if (res.error) {
    const msg = res.error.message || String(res.error);
    toast(`${what} failed: ${msg}`, true);
    throw Object.assign(new Error(msg), { shown: true });
  }
  return res.data;
}
// Errors already shown in a toast stop the handler on purpose; anything else still gets a toast.
window.addEventListener("unhandledrejection", e => {
  e.preventDefault();
  if (!e.reason?.shown) toast("Something went wrong: " + (e.reason?.message || e.reason), true);
});
// Two-step delete: the first click asks, a second click within 4 seconds acts.
function confirmClick(btn, action, label = "Delete") {
  btn.onclick = async () => {
    if (btn.dataset.armed) { btn.disabled = true; return action(); }
    btn.dataset.armed = "1"; btn.textContent = "Confirm";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 4000);
  };
}
function setConn(ok, text) {
  $("conn").className = "conn " + (ok ? "ok" : "bad");
  $("conn").querySelector("span").textContent = text;
}

/* ---------- navigation ---------- */
const VIEWS = ["roster", "members", "board", "strikes", "blacklist", "co", "recruit", "changes"];
const OFFICER_VIEWS = ["co", "recruit", "changes"];
function show(view) {
  if (!VIEWS.includes(view) || (OFFICER_VIEWS.includes(view) && !isOfficer())) view = "roster";
  state.view = view;
  VIEWS.forEach(v => { $("view-" + v).hidden = v !== view; });
  document.querySelectorAll("nav button").forEach(b => { if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  if (view === "board") loadBoard();
  if (view === "strikes") loadStrikes();
  if (view === "blacklist") loadBlacklist();
  if (view === "changes") loadChanges();
  if (view === "co") loadCo();
  if (view === "members") showMemberTab(state.mtab);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => show(b.dataset.view));

/* ---------- auth ---------- */
async function refreshMe() {
  state.session = (await db.auth.getSession()).data.session;
  state.me = null;
  if (state.session) {
    const res = await db.rpc("my_officer");
    state.me = res.error ? null : (res.data?.[0] || null);
  }
  state.discord = new Map();
  if (isOfficer()) {
    const d = await db.rpc("member_discord");
    if (!d.error) d.data.forEach(r => state.discord.set(r.person_id, r.discord_username));
  }
  document.querySelectorAll("[data-officer]").forEach(el => { el.hidden = !isOfficer(); });
  document.querySelectorAll("[data-officer-col]").forEach(el => { el.hidden = !isOfficer(); });
  $("m-officer-hint").hidden = !isOfficer();
  if (state.session) {
    const who = state.me ? `${esc(state.me.display_name)} <span class="mono">${esc(state.me.rank || "no rank")}</span>${isOfficer() ? "" : " · no edit rights"}`
                         : `${esc(state.session.user.email || "Discord login")} · not linked`;
    $("userBox").innerHTML = who;
    $("authBtn").textContent = "Account";
  } else {
    $("userBox").textContent = "";
    $("authBtn").textContent = "Officer sign in";
  }
  if (OFFICER_VIEWS.includes(state.view) && !isOfficer()) show("roster");
}
$("authBtn").onclick = () => openAuth(state.session ? (state.me ? "account" : "link") : "signin");

function openAuth(mode) {
  $("panel").hidden = false; $("scrim").hidden = false;
  const here = location.origin + location.pathname;
  const tabs = state.session ? "" : `<div class="authtabs" role="tablist">
      <button role="tab" data-mode="signin" aria-selected="${mode === "signin"}">Sign in</button>
      <button role="tab" data-mode="register" aria-selected="${mode === "register"}">Create login</button>
      <button role="tab" data-mode="reset" aria-selected="${mode === "reset"}">Forgot password</button></div>`;
  const discordBtn = `<div class="wide row"><button class="btn discord-btn" type="button" id="discordLogin">Sign in with Discord</button>
      <span class="note">Works once Discord login is switched on in Supabase.</span></div>`;
  const forms = {
    signin: `<form class="card form" id="authForm">
        <label class="f wide">Email<input type="email" id="a-email" autocomplete="username" required></label>
        <label class="f wide">Password<input type="password" id="a-pass" autocomplete="current-password" required></label>
        <div class="wide"><button class="btn primary" type="submit">Sign in</button></div>${discordBtn}</form>`,
    register: `<form class="card form" id="authForm">
        <p class="note wide">Step 1 of 2: create a login (or use Discord). Step 2: link it to your roster entry with your Steam ID and the CO registration code from Regimental Command. Only LT and above can be linked.</p>
        <label class="f wide">Email<input type="email" id="a-email" autocomplete="username" required></label>
        <label class="f wide">Password (at least 12 characters)<input type="password" id="a-pass" autocomplete="new-password" minlength="12" required></label>
        <label class="f wide">Repeat password<input type="password" id="a-pass2" autocomplete="new-password" minlength="12" required></label>
        <div class="wide"><button class="btn primary" type="submit">Create login</button></div>${discordBtn}</form>`,
    reset: `<form class="card form" id="authForm">
        <label class="f wide">Email<input type="email" id="a-email" autocomplete="username" required></label>
        <div class="wide"><button class="btn primary" type="submit">Send reset link</button></div></form>`,
    link: `<form class="card form" id="authForm">
        <p class="note wide">Step 2 of 2: link this login to your roster entry. Ask Regimental Command for the CO registration code. 5 wrong attempts lock linking for 15 minutes.</p>
        <label class="f wide">Your Steam ID<input type="text" id="a-steam" placeholder="STEAM_0:1:12345678" autocomplete="off" required></label>
        <label class="f wide">CO registration code<input type="password" id="a-code" autocomplete="off" spellcheck="false" required></label>
        <div class="wide"><button class="btn primary" type="submit">Link login</button></div></form>`,
    newpass: `<form class="card form" id="authForm">
        <label class="f wide">New password (at least 12 characters)<input type="password" id="a-pass" autocomplete="new-password" minlength="12" required></label>
        <div class="wide"><button class="btn primary" type="submit">Save new password</button></div></form>`,
    account: `<div class="card"><p>Signed in as <b>${esc(state.me?.display_name || "")}</b> (${esc(state.me?.rank || "no rank")}) with ${esc(state.session?.user.email || "Discord")}.</p>
        ${isOfficer() ? "" : '<p class="warnbox">This roster entry is not LT or above any more, so this login has no edit rights.</p>'}</div>`
  };
  $("panel").innerHTML = `
    <header><div class="who" style="flex:1"><b>${mode === "account" ? "Account" : "Officer access"}</b></div>
      <button class="btn" id="closePanel">Close</button></header>
    ${tabs}
    <div id="a-msg" aria-live="polite"></div>
    ${forms[mode]}
    ${state.session ? '<div><button class="btn danger" id="signOut">Sign out</button></div>' : ""}`;
  $("closePanel").onclick = closePanel;
  $("panel").querySelectorAll("[data-mode]").forEach(b => b.onclick = () => openAuth(b.dataset.mode));
  if ($("signOut")) $("signOut").onclick = async () => { await db.auth.signOut(); closePanel(); await refreshMe(); renderRoster(); toast("Signed out"); };
  if ($("discordLogin")) $("discordLogin").onclick = async () => {
    const { error } = await db.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: here, scopes: "identify email" } });
    if (error) msg(error.message);
  };
  const msg = (text, ok) => { $("a-msg").innerHTML = box(text, ok); };
  const form = $("authForm");
  if (!form) return;
  form.querySelector("input")?.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const email = $("a-email")?.value.trim(), pass = $("a-pass")?.value;
      if (mode === "signin") {
        const { error } = await db.auth.signInWithPassword({ email, password: pass });
        if (error) return msg(error.message === "Invalid login credentials" ? "Email or password is wrong." : error.message);
        await refreshMe(); renderRoster();
        if (!state.me) return openAuth("link");
        closePanel(); toast(`Signed in as ${state.me.display_name}`);
      } else if (mode === "register") {
        if ((pass || "").length < 12) return msg("Use at least 12 characters for the password.");
        if (pass !== $("a-pass2").value) return msg("The passwords do not match.");
        const { data, error } = await db.auth.signUp({ email, password: pass, options: { emailRedirectTo: here } });
        if (error) return msg(error.message);
        if (data.session) { await refreshMe(); return openAuth("link"); }
        msg("Check your email and confirm the address, then sign in here to link your roster entry.", true);
      } else if (mode === "reset") {
        const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: here });
        if (error) return msg(error.message);
        msg("If that email has a login, a reset link is on its way.", true);
      } else if (mode === "newpass") {
        if ((pass || "").length < 12) return msg("Use at least 12 characters for the password.");
        const { error } = await db.auth.updateUser({ password: pass });
        if (error) return msg(error.message);
        msg("Password changed.", true);
      } else if (mode === "link") {
        const r = check(await db.rpc("claim_officer", { p_steam_id: $("a-steam").value, p_code: $("a-code").value }), "Linking");
        $("a-code").value = "";
        if (!r.ok) return msg(r.message);
        await refreshMe(); renderRoster(); closePanel(); toast(r.message);
      }
    } finally { btn.disabled = false; }
  };
}
db.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") setTimeout(() => openAuth("newpass"), 0);
  if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "TOKEN_REFRESHED") setTimeout(() => refreshMe().then(renderRoster), 0);
});

/* ---------- roster ---------- */
async function loadRanks() {
  const [ranks, types] = await Promise.all([
    db.from("rank").select("id, code, name, category_id, sort_order, max_slots, weekly_hours_required, cooldown_days").order("sort_order"),
    db.from("training_type").select("id, name").order("name")
  ]);
  state.ranks = check(ranks, "Loading ranks");
  state.trainingTypes = check(types, "Loading training types");
  $("r-rank").innerHTML = state.ranks.map(r => `<option value="${r.code}" ${r.code === "PVT" ? "selected" : ""}>${esc(r.name)} (${r.code})</option>`).join("");
  $("t-type").innerHTML = state.trainingTypes.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
}
async function loadRoster() {
  const [roster, overview] = await Promise.all([
    db.from("v_roster").select("*").order("rank_order", { ascending: false }).order("display_name"),
    db.from("v_overview").select("*").single()
  ]);
  state.roster = check(roster, "Loading the roster");
  const o = check(overview, "Loading the overview");
  $("stats").innerHTML = [
    [o.members + " / " + o.slots, "members / slots"], [o.active, "active"], [o.semi_active, "semi-active"],
    [o.inactive, "inactive"], [o.on_loa + " / " + o.on_roa, "on LOA / ROA"], [o.trainings_7d, "trainings, 7 days"],
    [o.tryouts_7d, "tryouts, 7 days"], ["$" + Number(o.fund_balance).toLocaleString("en-GB"), "fund balance"]
  ].map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
  renderRoster();
  renderPicker();
  setConn(true, "Connected");
}
function renderRoster() {
  const q = $("q").value.trim().toLowerCase(), sf = $("statusFilter").value, off = isOfficer();
  const cols = off ? 7 : 6;
  const rows = state.roster.filter(m => (!sf || m.status === sf) &&
    (!q || [m.display_name, m.steam_id, off ? state.discord.get(m.person_id) : ""].some(v => (v || "").toLowerCase().includes(q))));
  if (!rows.length) { $("rosterBody").innerHTML = `<tr><td colspan="${cols}" class="empty">No members match.</td></tr>`; return; }
  let html = "", cat = null, rank = null;
  for (const m of rows) {
    if (m.category !== cat) { cat = m.category; rank = null; html += `<tr class="group"><td colspan="${cols}">${esc(cat)}</td></tr>`; }
    if (m.rank !== rank) {
      rank = m.rank;
      const r = state.ranks.find(x => x.code === rank), n = state.roster.filter(x => x.rank === rank).length;
      html += `<tr class="rankrow"><td colspan="${cols}">${esc(m.rank_name)} · ${n}${r && r.max_slots ? " / " + r.max_slots : ""}</td></tr>`;
    }
    html += `<tr class="member" tabindex="0" data-id="${m.membership_id}">
      <td><div class="who"><span>${esc(m.display_name)}</span><small>${esc(m.steam_id)}</small></div></td>
      ${off ? `<td class="hide-sm">${esc(state.discord.get(m.person_id) || "–")}</td>` : ""}
      <td>${pill(m.status)}${m.leave_ends_on ? ` <small class="mono">until ${fmtDate(m.leave_ends_on)}</small>` : ""}</td>
      <td class="n">${num(m.strikes)}</td>
      <td class="n">${num(m.hours)}${+m.weekly_hours_required ? " / " + num(m.weekly_hours_required) : ""}</td>
      <td>${m.on_cooldown ? '<span class="pill p-bad">running</span>' : '<span class="pill p-no">clear</span>'}</td>
      <td class="hide-sm mono">${fmtDate(m.last_promotion)}</td></tr>`;
  }
  $("rosterBody").innerHTML = html;
  $("rosterBody").querySelectorAll("tr.member").forEach(tr => {
    tr.onclick = () => openPerson(tr.dataset.id);
    tr.onkeydown = e => { if (e.key === "Enter") openPerson(tr.dataset.id); };
  });
}
$("q").oninput = renderRoster;
$("statusFilter").onchange = renderRoster;
$("reload").onclick = () => loadRoster().then(() => toast("Roster reloaded"));

/* ---------- person file ---------- */
async function openPerson(membershipId) {
  const m = state.roster.find(x => x.membership_id === membershipId);
  if (!m) return;
  const off = isOfficer();
  $("panel").innerHTML = `<p class="note">Loading ${esc(m.display_name)}…</p>`;
  $("panel").hidden = false; $("scrim").hidden = false;
  const pid = m.person_id;
  const [aliases, ranks, strikes, leaves, duty, medals, trainings, member, notes] = await Promise.all([
    db.from("person_alias").select("name, first_seen").eq("person_id", pid).order("first_seen", { ascending: false, nullsFirst: false }),
    db.from("rank_change").select("id, kind, effective_on, officer_raw, comment, from:from_rank_id(code), to:to_rank_id(code)").eq("person_id", pid).order("effective_on", { ascending: false }).order("id", { ascending: false }),
    db.from("strike").select("*").eq("person_id", pid).order("issued_on", { ascending: false }),
    db.from("leave").select("*").eq("person_id", pid).order("starts_on", { ascending: false }),
    db.from("duty_log").select("id, logged_on, hours, comment, source, rejected").eq("person_id", pid).order("logged_on", { ascending: false }).order("id", { ascending: false }).limit(15),
    db.from("medal_award").select("awarded_on, issuer_raw, medal_type(name)").eq("person_id", pid).order("awarded_on", { ascending: false }),
    db.from("training_attendee").select("training(held_on, training_type(name))").eq("person_id", pid),
    db.from("membership").select("id, status_override, recruited_at").eq("id", membershipId).single(),
    off ? db.from("member_note").select("id, body, author_name, created_at").eq("person_id", pid).order("created_at", { ascending: false }) : Promise.resolve({ data: [] })
  ]);
  const al = check(aliases, "Loading names"), rc = check(ranks, "Loading rank history"), st = check(strikes, "Loading strikes"),
    lv = check(leaves, "Loading leave"), du = check(duty, "Loading duty logs"), me = check(medals, "Loading medals"),
    tr = check(trainings, "Loading trainings"), ms = check(member, "Loading membership"), mn = check(notes, "Loading notes");
  const today = isoDay();
  const nextRank = state.ranks.find(r => r.sort_order === m.rank_order + 1)?.code;
  const rankOpts = state.ranks.map(r => `<option value="${r.code}" ${r.code === m.rank ? "disabled" : ""} ${r.code === nextRank ? "selected" : ""}>${esc(r.name)}</option>`).join("");
  const discord = state.discord.get(pid) || "";

  const dutyList = du.length ? du.map(d => `<div class="${d.rejected ? "rejected" : ""}"><span class="d">${fmtDate(d.logged_on)}</span>
      <span class="grow">${num(d.hours)} h ${d.comment ? "· " + esc(d.comment) : ""}${d.source === "self" ? '<span class="tag">self-logged</span>' : ""}${d.rejected ? '<span class="tag">rejected</span>' : ""}</span>
      ${off ? `${d.source === "self" ? `<button class="btn small" data-reject="${d.id}" data-val="${!d.rejected}">${d.rejected ? "Restore" : "Reject"}</button>` : ""}<button class="btn small danger" data-del-duty="${d.id}">Delete</button>` : ""}</div>`).join("")
    : '<p class="note">No duty logged yet.</p>';

  $("panel").innerHTML = `
    <header>
      <div class="who" style="flex:1"><b>${esc(m.display_name)}</b><small>${esc(m.rank_name)} · ${esc(m.steam_id)}${off && discord ? " · " + esc(discord) : ""}</small></div>
      <button class="btn" id="closePanel" aria-label="Close member file">Close</button>
    </header>
    <div class="card kv">
      <div><span>Status</span>${pill(m.status)}</div>
      <div><span>Hours, last 7 days</span><b>${num(m.hours)}${+m.weekly_hours_required ? " / " + num(m.weekly_hours_required) : ""}</b></div>
      <div><span>Active strikes</span><b>${num(m.strikes)}</b></div>
      <div><span>Cooldown</span><b>${m.on_cooldown ? "Running" : "Clear"}</b></div>
      <div><span>Last promotion</span><b>${fmtDate(m.last_promotion)}</b></div>
      <div><span>Recruited</span><b>${fmtDate(ms.recruited_at)}</b></div>
    </div>
    ${off ? `
    <form class="card form" id="editForm">
      <h3 class="wide">Details</h3>
      <label class="f">Name<input type="text" id="e-name" value="${esc(m.display_name)}"></label>
      <label class="f">Discord username<input type="text" id="e-discord" value="${esc(discord)}"></label>
      <label class="f">Status override<select id="e-override">
        ${["", "Touch Grass", "Active", "Inactive"].map(s => `<option value="${s}" ${s === (ms.status_override || "") ? "selected" : ""}>${s || "None (calculated)"}</option>`).join("")}
      </select></label>
      <div class="wide"><button class="btn primary" type="submit">Save details</button></div>
    </form>
    <div class="card">
      <h3>Officer notes <span class="tag">officers only</span></h3>
      <form class="form" id="noteForm">
        <label class="f wide">New note<textarea id="n-body" maxlength="5000"></textarea></label>
        <div><button class="btn primary" type="submit">Add note</button></div>
      </form>
      <div class="list">${mn.length ? mn.map(n => `<div><span class="d">${fmtDate(n.created_at.slice(0, 10))}</span><span class="grow" style="white-space:pre-wrap">${esc(n.body)}${n.author_name ? ` <small class="mono">· ${esc(n.author_name)}</small>` : ""}</span><button class="btn small danger" data-del-note="${n.id}">Delete</button></div>`).join("") : '<p class="note">No notes yet.</p>'}</div>
    </div>` : ""}

    <div class="card">
      <h3>Duty</h3>
      ${off ? `<form class="form" id="dutyForm">
        <label class="f">Date<input type="date" id="d-date" value="${today}" max="${today}"></label>
        <label class="f">Hours<input type="number" id="d-hours" min="0" max="24" step="0.5" value="1"></label>
        <label class="f">Comment<input type="text" id="d-comment"></label>
        <div><button class="btn primary" type="submit">Add hours</button></div>
      </form>` : ""}
      <div class="list">${dutyList}</div>
    </div>

    <div class="card">
      <h3>Rank history</h3>
      ${off ? `<form class="form" id="rankForm">
        <label class="f">New rank<select id="k-rank">${rankOpts}</select></label>
        <label class="f">Comment<input type="text" id="k-comment"></label>
        <div class="row"><button class="btn primary" type="submit" data-kind="promoted">Promote</button><button class="btn" type="submit" data-kind="demoted">Demote</button></div>
      </form>` : ""}
      <div class="list">${rc.length ? rc.map(r => `<div><span class="d">${fmtDate(r.effective_on)}</span><span class="grow">${esc(r.kind)}: ${esc(r.from?.code || "–")} → ${esc(r.to?.code)}${r.officer_raw ? " · by " + esc(r.officer_raw) : ""}${r.comment ? " · " + esc(r.comment) : ""}</span></div>`).join("") : '<p class="note">No rank changes logged.</p>'}</div>
    </div>

    <div class="card">
      <h3>Strikes</h3>
      ${off ? `<form class="form" id="strikeForm">
        <label class="f">Weight<input type="number" id="s-weight" min="0.5" max="10" step="0.5" value="1" required></label>
        <label class="f">Expires<input type="date" id="s-exp" value="${isoDay(14)}"></label>
        <label class="f wide">Reason<input type="text" id="s-reason" required></label>
        <label class="f wide">Appealable to<input type="text" id="s-appeal-to" maxlength="120" placeholder="e.g. Regimental Command"></label>
        <div><button class="btn primary" type="submit">Add strike</button></div>
      </form>` : ""}
      <div class="list">${st.length ? st.map(s => {
        const active = s.appeal_status !== "granted" && (!s.expires_on || s.expires_on > today);
        return `<div><span class="d">${fmtDate(s.issued_on)}</span><span class="grow">${num(s.weight)} · ${esc(s.reason || "")}${s.appealable_to ? " · appeal to " + esc(s.appealable_to) : ""} <small class="mono">${s.appeal_status === "granted" ? "appealed" : active ? "active until " + fmtDate(s.expires_on) : "expired"}</small></span>
          ${off ? `${active ? `<button class="btn small" data-appeal="${s.id}">Mark appealed</button>` : ""}<button class="btn small danger" data-del-strike="${s.id}">Delete</button>` : ""}</div>`;
      }).join("") : '<p class="note">No strikes.</p>'}</div>
    </div>

    <div class="card">
      <h3>LOA / ROA</h3>
      ${off ? `<form class="form" id="leaveForm">
        <label class="f">Type<select id="l-type"><option>LOA</option><option>ROA</option></select></label>
        <label class="f">From<input type="date" id="l-start" value="${today}"></label>
        <label class="f">Until<input type="date" id="l-end" value="${isoDay(7)}"></label>
        <label class="f">Reason<input type="text" id="l-reason"></label>
        <div><button class="btn primary" type="submit">Add leave</button></div>
      </form>` : ""}
      <div class="list">${lv.length ? lv.map(l => `<div><span class="d">${fmtDate(l.starts_on)}</span><span class="grow">${esc(l.type)} until ${fmtDate(l.ends_on)} ${l.reason ? "· " + esc(l.reason) : ""}</span>${off ? `<button class="btn small danger" data-del-leave="${l.id}">Delete</button>` : ""}</div>`).join("") : '<p class="note">No leave logged.</p>'}</div>
    </div>

    <details class="card"><summary>Medals (${me.length}), trainings attended (${tr.length}), previous names (${al.length})</summary>
      <div class="list">${me.map(x => `<div><span class="d">${fmtDate(x.awarded_on)}</span><span class="grow">${esc(x.medal_type?.name)}${x.issuer_raw ? " · by " + esc(x.issuer_raw) : ""}</span></div>`).join("")}</div>
      <div class="list">${tr.filter(x => x.training).sort((a, b) => b.training.held_on.localeCompare(a.training.held_on)).slice(0, 20).map(x => `<div><span class="d">${fmtDate(x.training.held_on)}</span><span class="grow">${esc(x.training.training_type?.name)}</span></div>`).join("")}</div>
      <p class="note">${al.map(a => esc(a.name)).join(" · ")}</p>
    </details>

    ${off ? `<div class="card">
      <h3>Discharge</h3>
      <form class="form" id="dischargeForm">
        <label class="f">Type<select id="x-type"><option value="honourable">Honourable</option><option value="dishonourable">Dishonourable</option></select></label>
        <label class="f wide">Reason<input type="text" id="x-reason"></label>
        <div class="wide row"><label class="row" style="gap:6px"><input type="checkbox" id="x-confirm"> I want to remove this member from the roster</label>
          <button class="btn danger" type="submit">Discharge</button></div>
      </form>
    </div>` : `<p class="note">Sign in as an officer to make changes.</p>`}`;

  $("closePanel").onclick = closePanel;
  if (!off) return;
  const officerName = state.me?.display_name || null;
  const after = async msg => { toast(msg); await loadRoster(); await openPerson(membershipId); };

  $("editForm").onsubmit = async e => {
    e.preventDefault();
    const name = $("e-name").value.trim();
    if (!name) return toast("Enter a name.", true);
    check(await db.from("person").update({ display_name: name, discord_username: $("e-discord").value.trim() || null }).eq("id", pid), "Saving details");
    check(await db.from("membership").update({ status_override: $("e-override").value || null }).eq("id", membershipId), "Saving details");
    await refreshMe();
    await after("Details saved");
  };
  $("noteForm").onsubmit = async e => {
    e.preventDefault();
    const body = $("n-body").value.trim();
    if (!body) return toast("Write the note first.", true);
    check(await db.from("member_note").insert({ person_id: pid, body, author_id: state.session.user.id, author_name: officerName }), "Saving the note");
    await after("Note added");
  };
  $("dutyForm").onsubmit = async e => {
    e.preventDefault();
    const hours = parseFloat($("d-hours").value);
    if (!(hours > 0 && hours <= 24)) return toast("Hours must be between 0.5 and 24.", true);
    if (!$("d-date").value) return toast("Pick a date.", true);
    check(await db.from("duty_log").insert({ person_id: pid, logged_on: $("d-date").value, hours, rank_id: m.rank_id, comment: $("d-comment").value.trim() || null, source: "officer" }), "Logging duty");
    await after(`Logged ${hours} h`);
  };
  $("rankForm").onsubmit = async e => {
    e.preventDefault();
    const kind = e.submitter?.dataset.kind || "promoted";
    check(await db.rpc("change_rank", { p_membership: membershipId, p_to_rank: $("k-rank").value, p_kind: kind,
      p_officer: officerName, p_comment: $("k-comment").value }), kind === "promoted" ? "Promotion" : "Demotion");
    await after(kind === "promoted" ? "Promoted" : "Demoted");
  };
  $("strikeForm").onsubmit = async e => {
    e.preventDefault();
    const reason = $("s-reason").value.trim();
    if (!reason) return toast("Enter a reason for the strike.", true);
    const weight = +$("s-weight").value;
    if (!(weight >= 0.5 && weight <= 10 && weight * 2 === Math.trunc(weight * 2))) return toast("Strikes go in steps of 0.5, from 0.5 to 10.", true);
    check(await db.from("strike").insert({ person_id: pid, weight, reason, issued_on: today,
      expires_on: $("s-exp").value || null, officer_raw: officerName,
      appealable_to: $("s-appeal-to").value.trim() || null }), "Adding the strike");
    await after("Strike added");
  };
  $("leaveForm").onsubmit = async e => {
    e.preventDefault();
    const s = $("l-start").value, en = $("l-end").value;
    if (!s || !en) return toast("Pick both dates.", true);
    if (en < s) return toast("The end date is before the start date.", true);
    check(await db.from("leave").insert({ person_id: pid, type: $("l-type").value, requested_on: today, starts_on: s, ends_on: en,
      reason: $("l-reason").value.trim() || null, approved_by_raw: officerName }), "Adding leave");
    await after(`${$("l-type").value} added`);
  };
  $("dischargeForm").onsubmit = async e => {
    e.preventDefault();
    if (!$("x-confirm").checked) return toast("Tick the confirmation box first.", true);
    check(await db.rpc("discharge_member", { p_membership: membershipId, p_type: $("x-type").value,
      p_reason: $("x-reason").value, p_officer: officerName }), "Discharge");
    toast(`${m.display_name} discharged`); closePanel(); await loadRoster();
  };
  $("panel").querySelectorAll("[data-del-note]").forEach(b => confirmClick(b, async () => {
    check(await db.from("member_note").delete().eq("id", b.dataset.delNote), "Deleting the note"); await after("Note deleted"); }));
  $("panel").querySelectorAll("[data-del-duty]").forEach(b => confirmClick(b, async () => {
    check(await db.from("duty_log").delete().eq("id", b.dataset.delDuty), "Deleting the duty entry"); await after("Duty entry deleted"); }));
  $("panel").querySelectorAll("[data-reject]").forEach(b => b.onclick = async () => {
    const val = b.dataset.val === "true";
    check(await db.from("duty_log").update({ rejected: val }).eq("id", b.dataset.reject), "Updating the entry"); await after(val ? "Hours rejected" : "Hours restored"); });
  $("panel").querySelectorAll("[data-del-strike]").forEach(b => confirmClick(b, async () => {
    check(await db.from("strike").delete().eq("id", b.dataset.delStrike), "Deleting the strike"); await after("Strike deleted"); }));
  $("panel").querySelectorAll("[data-appeal]").forEach(b => b.onclick = async () => {
    check(await db.from("strike").update({ appeal_status: "granted" }).eq("id", b.dataset.appeal), "Marking the appeal"); await after("Strike marked as appealed"); });
  $("panel").querySelectorAll("[data-del-leave]").forEach(b => confirmClick(b, async () => {
    check(await db.from("leave").delete().eq("id", b.dataset.delLeave), "Deleting leave"); await after("Leave deleted"); }));
}
function closePanel() { $("panel").hidden = true; $("scrim").hidden = true; }
$("scrim").onclick = closePanel;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("panel").hidden) closePanel(); });

/* ---------- members area (no login) ---------- */
function showMemberTab(tab) {
  state.mtab = tab;
  document.querySelectorAll("#memberTabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.mtab === tab));
  document.querySelectorAll("[data-mpanel]").forEach(p => { p.hidden = p.dataset.mpanel !== tab; });
  $("m-result").innerHTML = "";
}
document.querySelectorAll("#memberTabs button").forEach(b => b.onclick = () => showMemberTab(b.dataset.mtab));
function resetMemberDates() {
  for (const id of ["h-date", "t-date"]) { $(id).value = isoDay(); $(id).max = isoDay(); $(id).min = isoDay(-6); }
  $("lr-start").value = isoDay(); $("lr-start").min = isoDay(-1); $("lr-start").max = isoDay(90);
  $("lr-end").value = isoDay(7); $("lr-end").min = isoDay(-1);
}
// Returns {steam, discord} or null (with a message shown). Discord may be empty only for officers logging for a host.
function identity(allowOfficerHost = false) {
  const steam = $("m-steam").value.trim(), discord = $("m-discord").value.trim();
  if ($("m-website").value) { $("m-result").innerHTML = box("Done.", true); return null; }  // bot trap
  if (!steam) { $("m-result").innerHTML = box("Enter the Steam ID at the top."); return null; }
  if (!discord && !(allowOfficerHost && isOfficer())) { $("m-result").innerHTML = box("Enter the Discord username at the top."); return null; }
  return { steam, discord: discord || null };
}
async function memberCall(btn, fn, args) {
  if (btn) btn.disabled = true;
  try {
    const r = check(await db.rpc(fn, args), "Sending");
    $("m-result").innerHTML = box(r.message, r.ok);
    return r;
  } finally { if (btn) btn.disabled = false; }
}
$("hoursForm").onsubmit = async e => {
  e.preventDefault();
  const id = identity(); if (!id) return;
  const hours = parseFloat($("h-hours").value);
  if (!(hours > 0 && hours <= 12)) { $("m-result").innerHTML = box("Hours must be more than 0 and at most 12."); return; }
  const r = await memberCall(e.submitter || $("h-submit"), "submit_duty", { p_steam_id: id.steam, p_discord: id.discord,
    p_date: $("h-date").value, p_hours: hours, p_comment: $("h-comment").value.trim() || null });
  if (r.ok) { $("m-result").innerHTML = box(`${r.message} · your hours in the last 7 days: ${num(r.week_hours)}`, true); $("h-hours").value = "1"; $("h-comment").value = ""; loadRoster(); }
};
$("f-load").onclick = async () => {
  const id = identity(); if (!id) return;
  $("f-load").disabled = true;
  try {
    const r = check(await db.rpc("my_file", { p_steam_id: id.steam, p_discord: id.discord }), "Loading your file");
    if (!r.ok) { $("m-result").innerHTML = box(r.message); $("f-out").innerHTML = ""; return; }
    $("m-result").innerHTML = "";
    $("f-out").innerHTML = `
      <div class="kv" style="margin-top:12px">
        <div><span>Name</span><b>${esc(r.name)}</b></div><div><span>Rank</span><b>${esc(r.rank)}</b></div>
        <div><span>Status</span>${pill(r.status)}</div>
        <div><span>Hours, last 7 days</span><b>${num(r.hours)}${+r.required ? " / " + num(r.required) : ""}</b></div>
        <div><span>Active strikes</span><b>${num(r.strikes)}</b></div><div><span>Cooldown</span><b>${r.on_cooldown ? "Running" : "Clear"}</b></div>
      </div>
      <h3 style="margin-top:14px">Next promotion</h3>
      <div class="list">${r.requirements.length ? r.requirements.map(q => `<div><span class="grow">${esc(q.title)}</span><span class="pill ${q.met ? "p-yes" : "p-no"}">${q.met ? "done" : "open"}</span></div>`).join("") : '<p class="note">No requirements for your rank.</p>'}</div>
      <h3 style="margin-top:14px">Recent duty</h3>
      <div class="list">${r.duty.length ? r.duty.map(d => `<div class="${d.rejected ? "rejected" : ""}"><span class="d">${fmtDate(d.logged_on)}</span><span class="grow">${num(d.hours)} h ${d.comment ? "· " + esc(d.comment) : ""}${d.rejected ? '<span class="tag">rejected</span>' : ""}</span></div>`).join("") : '<p class="note">No duty logged.</p>'}</div>
      ${r.strike_list.length ? `<h3 style="margin-top:14px">Active strikes</h3><div class="list">${r.strike_list.map(s => `<div><span class="d">${fmtDate(s.issued_on)}</span><span class="grow">${num(s.weight)} · ${esc(s.reason || "")} · until ${fmtDate(s.expires_on)}</span></div>`).join("")}</div>` : ""}
      ${r.requests.length ? `<h3 style="margin-top:14px">Leave requests</h3><div class="list">${r.requests.map(q => `<div><span class="d">${fmtDate(q.starts_on)}</span><span class="grow">${esc(q.type)} until ${fmtDate(q.ends_on)}${q.decision_note ? " · " + esc(q.decision_note) : ""}</span><span class="pill ${q.status === "approved" ? "p-yes" : q.status === "declined" ? "p-bad" : "p-no"}">${esc(q.status)}</span></div>`).join("")}</div>` : ""}`;
  } finally { $("f-load").disabled = false; }
};
$("leaveReqForm").onsubmit = async e => {
  e.preventDefault();
  const id = identity(); if (!id) return;
  const r = await memberCall(e.submitter, "request_leave", { p_steam_id: id.steam, p_discord: id.discord, p_type: $("lr-type").value,
    p_starts: $("lr-start").value, p_ends: $("lr-end").value, p_reason: $("lr-reason").value.trim() || null });
  if (r.ok) $("lr-reason").value = "";
};
function renderPicker() {
  const q = $("t-search").value.trim().toLowerCase();
  $("t-picker").innerHTML = state.roster.filter(m => !q || m.display_name.toLowerCase().includes(q))
    .map(m => `<label><input type="checkbox" value="${m.person_id}" ${state.attendees.has(m.person_id) ? "checked" : ""}> ${esc(m.display_name)} <small>${esc(m.rank)}</small></label>`).join("");
  $("t-picker").querySelectorAll("input").forEach(i => i.onchange = () => {
    if (i.checked) state.attendees.add(i.value); else state.attendees.delete(i.value);
    $("t-count").textContent = `${state.attendees.size} selected`;
  });
  $("t-count").textContent = `${state.attendees.size} selected`;
}
$("t-search").oninput = renderPicker;
$("trainingForm").onsubmit = async e => {
  e.preventDefault();
  const id = identity(true); if (!id) return;
  if (!state.attendees.size) { $("m-result").innerHTML = box("Pick at least one attendee."); return; }
  const r = await memberCall(e.submitter, "log_training", { p_host_steam_id: id.steam, p_host_discord: id.discord,
    p_type_id: +$("t-type").value, p_held_on: $("t-date").value, p_attendees: [...state.attendees],
    p_description: $("t-desc").value.trim() || null, p_comment: $("t-comment").value.trim() || null });
  if (r.ok) { state.attendees.clear(); $("t-desc").value = ""; $("t-comment").value = ""; $("t-search").value = ""; renderPicker(); loadRoster(); }
};
$("tryoutForm").onsubmit = async e => {
  e.preventDefault();
  const id = identity(true); if (!id) return;
  const score = $("y-score").value === "" ? null : parseInt($("y-score").value, 10);
  const r = await memberCall(e.submitter, "log_tryout", { p_host_steam_id: id.steam, p_host_discord: id.discord,
    p_recruit_name: $("y-name").value.trim(), p_recruit_steam_id: $("y-steam").value.trim(), p_recruit_discord: $("y-discord").value.trim() || null,
    p_result: $("y-result").value, p_score: score, p_comment: $("y-comment").value.trim() || null });
  if (r.ok) {
    if (r.blacklisted) $("m-result").innerHTML += box("Note: this Steam ID has an active blacklist entry.");
    ["y-name", "y-steam", "y-discord", "y-score", "y-comment"].forEach(i => { $(i).value = ""; });
  }
};

/* ---------- promotion board ---------- */
async function loadBoard() {
  const [board, reqs] = await Promise.all([
    db.from("v_promotion_board").select("*").order("display_name"),
    db.from("requirement").select("id, from_rank_id, title, kind, sort_order, is_active").order("sort_order")
  ]);
  state.board = check(board, "Loading the promotion board");
  state.reqs = check(reqs, "Loading requirements");
  $("boardNote").textContent = isOfficer()
    ? "Tick manual requirements with a click. Activity and cooldown are calculated from the logs; other automatic checks can be overridden with a tick. The switches turn a requirement on or off for everyone at that rank."
    : "Read-only. Officers can tick requirements after signing in.";
  const stages = state.ranks.filter(r => state.reqs.some(q => q.from_rank_id === r.id));
  if (!state.stage || !stages.some(s => s.id === state.stage)) state.stage = stages[0]?.id;
  $("stageTabs").innerHTML = stages.map(r => {
    const next = state.ranks.find(x => x.sort_order === r.sort_order + 1);
    const n = state.roster.filter(m => m.rank === r.code).length;
    return `<button role="tab" aria-selected="${r.id === state.stage}" data-stage="${r.id}">${r.code} → ${next?.code || "?"} <span class="mono">(${n})</span></button>`;
  }).join("");
  $("stageTabs").querySelectorAll("button").forEach(b => b.onclick = () => { state.stage = +b.dataset.stage; loadBoard(); });
  renderBoard();
}
function renderBoard() {
  const off = isOfficer();
  const reqs = state.reqs.filter(q => q.from_rank_id === state.stage);
  $("reqToggles").innerHTML = reqs.map(q => `<label class="req-toggle${q.is_active ? "" : " off"}"><input type="checkbox" data-req="${q.id}" ${q.is_active ? "checked" : ""} ${off ? "" : "disabled"}> ${esc(q.title)} <span class="kind">${KIND_LABEL[q.kind] || q.kind}</span></label>`).join("");
  $("reqToggles").querySelectorAll("input").forEach(inp => inp.onchange = async () => {
    inp.disabled = true;
    try {
      check(await db.from("requirement").update({ is_active: inp.checked }).eq("id", inp.dataset.req), "Switching the requirement");
      toast(inp.checked ? "Requirement switched on" : "Requirement switched off");
    } finally { await loadBoard(); }
  });
  const active = reqs.filter(q => q.is_active);
  const members = state.roster.filter(m => m.rank_id === state.stage);
  if (!members.length) { $("boardTable").innerHTML = `<tbody><tr><td class="empty">Nobody holds this rank.</td></tr></tbody>`; return; }
  let html = `<thead><tr><th>Member</th>${active.map(q => `<th title="${esc(q.title)}">${esc(q.title.replace("Maintain Activity Requirement", "Activity").replace("Cooldown expired", "Cooldown"))}</th>`).join("")}<th>Ready?</th></tr></thead><tbody>`;
  for (const m of members) {
    let ready = true;
    const cells = active.map(q => {
      const b = state.board.find(x => x.membership_id === m.membership_id && x.requirement_id === q.id);
      const ticked = !!b?.ticked, auto = !!b?.auto_met, met = !!b?.met;
      if (!met) ready = false;
      const calcOnly = q.kind === "activity" || q.kind === "cooldown";
      const autoTxt = q.kind === "activity" ? `${num(m.hours)} / ${num(m.weekly_hours_required)} h` : q.kind === "cooldown" ? (m.on_cooldown ? "running" : "clear") : (auto ? "done" : "not yet");
      const autoHtml = q.kind === "manual" || q.kind === "qualification" ? "" : `<span class="auto ${auto ? "yes" : "no"}"><i></i>${autoTxt}</span>`;
      const tick = calcOnly ? "" : `<button class="tick" aria-pressed="${ticked}" data-m="${m.membership_id}" data-q="${q.id}" aria-label="${esc(q.title)} for ${esc(m.display_name)}" ${off ? "" : "disabled"}>✓</button>`;
      return `<td><span class="cellwrap">${tick}${autoHtml}</span></td>`;
    }).join("");
    html += `<tr><td><div class="who"><span>${esc(m.display_name)}</span><small>${esc(m.status)}${+m.strikes ? " · " + num(m.strikes) + " strikes" : ""}</small></div></td>${cells}
      <td>${ready ? `<span class="pill p-yes">Ready</span>` : `<span class="pill p-no">Pending</span>`}</td></tr>`;
  }
  $("boardTable").innerHTML = html + "</tbody>";
  if (!off) return;
  $("boardTable").querySelectorAll(".tick").forEach(b => b.onclick = async () => {
    const done = b.getAttribute("aria-pressed") !== "true";
    b.disabled = true;
    try {
      check(await db.from("member_requirement").upsert({ membership_id: b.dataset.m, requirement_id: +b.dataset.q, done,
        done_at: done ? new Date().toISOString() : null }, { onConflict: "membership_id,requirement_id" }), "Saving the tick");
    } finally { await loadBoard(); }
  });
}
$("boardReload").onclick = () => loadBoard().then(() => toast("Board reloaded"));

/* ---------- CO area ---------- */
document.querySelectorAll("#coTabs button").forEach(b => b.onclick = () => { state.co = b.dataset.co; loadCo(); });
const visSelect = () => `<label class="f">Visible to<select id="co-vis"><option value="officers">All officers</option>${isRegcom() ? '<option value="regcom">Regimental Command only</option>' : ""}</select></label>`;
const visTag = v => v === "regcom" ? '<span class="tag">RegCom only</span>' : "";
async function loadCo() {
  if (!isOfficer()) return;
  document.querySelectorAll("#coTabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.co === state.co));
  $("coBody").innerHTML = '<p class="note">Loading…</p>';
  const loaders = { alerts: coAlerts, requests: coRequests, tryouts: coTryouts, notes: coNotes, links: coLinks, docs: coDocs, logins: coLogins };
  await loaders[state.co]();
}
async function coAlerts() {
  const a = check(await db.rpc("co_alerts"), "Loading alerts");
  const sec = (title, items, render, okText) => `<div class="card alert-sec ${items.length ? "warn" : "ok"}"><h3>${esc(title)} (${items.length})</h3>
    ${items.length ? `<div class="list">${items.map(render).join("")}</div>` : `<p class="note">${esc(okText)}</p>`}</div>`;
  const low = +a.trainings_7d < +a.min_trainings, lowT = +a.tryouts_7d < +a.min_tryouts;
  $("coBody").innerHTML = `<div class="co-grid">
    <p class="note">The same report is emailed and posted to Discord every day at 18:00 UTC once email and Discord are set up.</p>
    <div class="stats">
      <div class="stat"><b>${esc(a.trainings_7d)}</b><span>trainings, 7 days (goal ${esc(a.min_trainings)})${low ? " · below goal" : ""}</span></div>
      <div class="stat"><b>${esc(a.tryouts_7d)}</b><span>tryouts, 7 days (goal ${esc(a.min_tryouts)})${lowT ? " · below goal" : ""}</span></div>
    </div>
    ${sec("Low hours", a.low_hours, x => `<div><span class="grow">${esc(x.name)} <small class="mono">${esc(x.rank)}</small></span><span class="mono">${num(x.hours)} / ${num(x.required)} h</span></div>`, "Everyone meets their weekly hours.")}
    ${sec("Ready for promotion", a.ready_for_promotion, x => `<div><span class="grow">${esc(x.name)} <small class="mono">${esc(x.rank)}</small></span></div>`, "Nobody has all requirements met yet.")}
    ${sec("NCOs without a training in 14 days", a.training_overdue, x => `<div><span class="grow">${esc(x.name)} <small class="mono">${esc(x.rank)}</small></span></div>`, "All NCOs have hosted recently.")}
    ${sec("Leave requests waiting", a.pending_requests, x => `<div><span class="grow">${esc(x.name)}: ${esc(x.type)} ${fmtDate(x.starts_on)} – ${fmtDate(x.ends_on)}</span></div>`, "No requests waiting.")}
    ${sec("Leave ending today or tomorrow", a.leave_ending, x => `<div><span class="grow">${esc(x.name)}: ${esc(x.type)} ends ${fmtDate(x.ends_on)}</span></div>`, "No leave ending soon.")}
  </div>`;
}
async function coRequests() {
  const rows = check(await db.from("leave_request").select("id, type, starts_on, ends_on, reason, status, requested_at, decided_by_name, decision_note, person!leave_request_person_id_fkey(display_name)")
    .order("requested_at", { ascending: false }).limit(40), "Loading leave requests");
  const pending = rows.filter(r => r.status === "pending"), done = rows.filter(r => r.status !== "pending");
  $("coBody").innerHTML = `<div class="co-grid">
    <div class="card"><h3>Waiting (${pending.length})</h3>
      ${pending.length ? pending.map(r => `<div class="note-card"><div><b>${esc(r.person?.display_name)}</b> · ${esc(r.type)} ${fmtDate(r.starts_on)} – ${fmtDate(r.ends_on)}</div>
        ${r.reason ? `<div class="body">${esc(r.reason)}</div>` : ""}
        <div class="row"><input type="text" placeholder="Note to the member (optional)" data-note="${r.id}" style="flex:1 1 200px">
          <button class="btn small primary" data-decide="${r.id}" data-ok="1">Approve</button><button class="btn small danger" data-decide="${r.id}" data-ok="0">Decline</button></div></div>`).join("") : '<p class="note">No requests waiting.</p>'}
    </div>
    <div class="card"><h3>Decided</h3><div class="list">${done.map(r => `<div><span class="d">${fmtDate(r.starts_on)}</span><span class="grow">${esc(r.person?.display_name)} · ${esc(r.type)} until ${fmtDate(r.ends_on)} · by ${esc(r.decided_by_name || "–")}${r.decision_note ? " · " + esc(r.decision_note) : ""}</span><span class="pill ${r.status === "approved" ? "p-yes" : "p-bad"}">${esc(r.status)}</span></div>`).join("") || '<p class="note">Nothing yet.</p>'}</div></div></div>`;
  $("coBody").querySelectorAll("[data-decide]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    const note = $("coBody").querySelector(`[data-note="${b.dataset.decide}"]`).value;
    const r = check(await db.rpc("decide_leave_request", { p_id: +b.dataset.decide, p_approve: b.dataset.ok === "1", p_note: note || null }), "Deciding");
    toast(r.message); await loadRoster(); coRequests();
  });
}
async function coTryouts() {
  const rows = check(await db.from("tryout").select("id, held_on, result, comment, recruit:person!tryout_recruit_id_fkey(id, display_name, steam_id), host:person!tryout_host_id_fkey(display_name), tryout_quiz(score)")
    .order("held_on", { ascending: false }).order("id", { ascending: false }).limit(40), "Loading tryouts");
  const serving = new Set(state.roster.map(m => m.person_id));
  $("coBody").innerHTML = `<div class="frame"><table><thead><tr><th>Date</th><th>Recruit</th><th>Host</th><th>Result</th><th>Quiz</th><th></th></tr></thead><tbody>
    ${rows.map(t => `<tr><td class="mono">${fmtDate(t.held_on)}</td>
      <td><div class="who"><span>${esc(t.recruit?.display_name)}</span><small>${esc(t.recruit?.steam_id || "")}</small></div></td>
      <td>${esc(t.host?.display_name || "–")}</td><td><span class="pill ${t.result === "passed" ? "p-yes" : "p-bad"}">${esc(t.result)}</span></td>
      <td class="n">${(Array.isArray(t.tryout_quiz) ? t.tryout_quiz[0] : t.tryout_quiz)?.score ?? "–"}</td>
      <td>${t.result === "passed" && t.recruit && !serving.has(t.recruit.id) && t.recruit.steam_id ? `<button class="btn small primary" data-add="${t.id}">Add to roster</button>` : (serving.has(t.recruit?.id) ? '<span class="note">on roster</span>' : "")}</td></tr>`).join("")}
    </tbody></table></div>`;
  $("coBody").querySelectorAll("[data-add]").forEach(b => b.onclick = async () => {
    const t = rows.find(x => x.id === +b.dataset.add);
    b.disabled = true;
    check(await db.rpc("add_member", { p_steam_id: t.recruit.steam_id, p_name: t.recruit.display_name, p_discord: null, p_rank: "PVT", p_override: false }), "Adding to the roster");
    toast(`${t.recruit.display_name} added as PVT`); await refreshMe(); await loadRoster(); coTryouts();
  });
}
async function coNotes() {
  const rows = check(await db.from("co_note").select("*").order("pinned", { ascending: false }).order("updated_at", { ascending: false }), "Loading notes");
  $("coBody").innerHTML = `<div class="co-grid">
    <form class="card form" id="coNoteForm">
      <label class="f wide">Title<input type="text" id="co-title" maxlength="200" required></label>
      <label class="f wide">Text<textarea id="co-body" maxlength="20000" style="min-height:110px"></textarea></label>
      ${visSelect()}
      <label class="row" style="gap:6px"><input type="checkbox" id="co-pin"> Pin to the top</label>
      <div class="wide"><button class="btn primary" type="submit">Add note</button></div>
    </form>
    ${rows.map(n => `<div class="note-card ${n.pinned ? "pinned" : ""}">
      <div class="row"><b style="flex:1">${esc(n.title)}</b>${n.pinned ? '<span class="tag">pinned</span>' : ""}${visTag(n.visibility)}</div>
      ${n.body ? `<div class="body">${esc(n.body)}</div>` : ""}
      <div class="meta"><span>${esc(n.author_name || "–")} · ${fmtTime(n.updated_at)}</span><span class="spacer"></span>
        <button class="btn small" data-pin="${n.id}" data-val="${!n.pinned}">${n.pinned ? "Unpin" : "Pin"}</button>
        <button class="btn small danger" data-del="${n.id}">Delete</button></div></div>`).join("") || '<p class="note">No notes yet.</p>'}
  </div>`;
  $("coNoteForm").onsubmit = async e => {
    e.preventDefault();
    const title = $("co-title").value.trim();
    if (!title) return toast("Give the note a title.", true);
    check(await db.from("co_note").insert({ title, body: $("co-body").value, visibility: $("co-vis").value, pinned: $("co-pin").checked,
      author_id: state.session.user.id, author_name: state.me.display_name }), "Saving the note");
    toast("Note added"); coNotes();
  };
  $("coBody").querySelectorAll("[data-pin]").forEach(b => b.onclick = async () => {
    check(await db.from("co_note").update({ pinned: b.dataset.val === "true", updated_at: new Date().toISOString() }).eq("id", b.dataset.pin), "Updating the note"); coNotes(); });
  $("coBody").querySelectorAll("[data-del]").forEach(b => confirmClick(b, async () => {
    check(await db.from("co_note").delete().eq("id", b.dataset.del), "Deleting the note"); toast("Note deleted"); coNotes(); }));
}
async function coLinks() {
  const rows = check(await db.from("co_link").select("*").order("category").order("title"), "Loading links");
  const groups = {};
  rows.forEach(l => { (groups[l.category || "Other"] ||= []).push(l); });
  $("coBody").innerHTML = `<div class="co-grid">
    <form class="card form" id="coLinkForm">
      <label class="f">Title<input type="text" id="cl-title" maxlength="200" required></label>
      <label class="f">Link (https://…)<input type="url" id="cl-url" maxlength="2000" required></label>
      <label class="f">Category<input type="text" id="cl-cat" maxlength="60" placeholder="e.g. Handbooks"></label>
      ${visSelect()}
      <div class="wide"><button class="btn primary" type="submit">Add link</button></div>
    </form>
    ${Object.entries(groups).map(([cat, ls]) => `<div class="card"><h3>${esc(cat)}</h3><div class="list">${ls.map(l => `<div>
      <span class="grow"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a> ${visTag(l.visibility)}<br><small class="mono">${esc(l.url)}</small></span>
      <button class="btn small danger" data-del="${l.id}">Delete</button></div>`).join("")}</div></div>`).join("") || '<p class="note">No links yet.</p>'}
  </div>`;
  $("coLinkForm").onsubmit = async e => {
    e.preventDefault();
    const url = $("cl-url").value.trim(), title = $("cl-title").value.trim();
    if (!title) return toast("Give the link a title.", true);
    if (!/^https:\/\/[^\s<>"'`]+$/.test(url)) return toast("Only https:// links are allowed.", true);
    check(await db.from("co_link").insert({ title, url, category: $("cl-cat").value.trim() || null, visibility: $("co-vis").value,
      author_id: state.session.user.id, author_name: state.me.display_name }), "Saving the link");
    toast("Link added"); coLinks();
  };
  $("coBody").querySelectorAll("[data-del]").forEach(b => confirmClick(b, async () => {
    check(await db.from("co_link").delete().eq("id", b.dataset.del), "Deleting the link"); toast("Link deleted"); coLinks(); }));
}
const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"];
async function coDocs() {
  const rows = check(await db.from("co_document").select("*").order("created_at", { ascending: false }), "Loading documents");
  $("coBody").innerHTML = `<div class="co-grid">
    <form class="card form" id="coDocForm">
      <label class="f">Title<input type="text" id="cd-title" maxlength="200" required></label>
      <label class="f">File (PDF, image, Word, Excel, PowerPoint, text · max 10 MB)<input type="file" id="cd-file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.docx,.xlsx,.pptx" required></label>
      ${visSelect()}
      <div class="wide"><button class="btn primary" type="submit" id="cd-submit">Upload</button></div>
    </form>
    <div class="card"><div class="list">${rows.map(d => `<div><span class="d">${fmtDate(d.created_at.slice(0, 10))}</span>
      <span class="grow">${esc(d.title)} ${visTag(d.visibility)}<br><small class="mono">${esc(d.file_name)} · ${(d.size_bytes / 1048576).toFixed(2)} MB · ${esc(d.author_name || "")}</small></span>
      <button class="btn small" data-get="${d.id}">Download</button><button class="btn small danger" data-del="${d.id}">Delete</button></div>`).join("") || '<p class="note">No documents yet.</p>'}</div></div>
  </div>`;
  $("coDocForm").onsubmit = async e => {
    e.preventDefault();
    const file = $("cd-file").files[0], title = $("cd-title").value.trim(), vis = $("co-vis").value;
    if (!title || !file) return toast("Give a title and choose a file.", true);
    if (file.size > 10485760) return toast("The file is larger than 10 MB.", true);
    if (!ALLOWED_TYPES.includes(file.type)) return toast("This file type is not allowed.", true);
    const safeName = file.name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(-120) || "file";
    const path = `${vis}/${crypto.randomUUID()}/${safeName}`;
    $("cd-submit").disabled = true;
    try {
      check(await db.storage.from("co-documents").upload(path, file, { contentType: file.type, upsert: false }), "Uploading");
      const ins = await db.from("co_document").insert({ title, storage_path: path, file_name: file.name.slice(0, 200), mime_type: file.type,
        size_bytes: file.size, visibility: vis, author_id: state.session.user.id, author_name: state.me.display_name });
      if (ins.error) { await db.storage.from("co-documents").remove([path]); check(ins, "Saving the document"); }
      toast("Document uploaded"); coDocs();
    } finally { $("cd-submit").disabled = false; }
  };
  $("coBody").querySelectorAll("[data-get]").forEach(b => b.onclick = async () => {
    const d = rows.find(x => x.id === +b.dataset.get);
    const blob = check(await db.storage.from("co-documents").download(d.storage_path), "Downloading");
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = d.file_name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  $("coBody").querySelectorAll("[data-del]").forEach(b => confirmClick(b, async () => {
    const d = rows.find(x => x.id === +b.dataset.del);
    check(await db.storage.from("co-documents").remove([d.storage_path]), "Deleting the file");
    check(await db.from("co_document").delete().eq("id", d.id), "Deleting the document");
    toast("Document deleted"); coDocs();
  }));
}
async function coLogins() {
  const rows = check(await db.from("officer_account").select("user_id, linked_at, person_id, person!officer_account_person_id_fkey(display_name)").order("linked_at"), "Loading officer logins");
  $("coBody").innerHTML = `<p class="note">Logins linked to a roster entry. Rights end automatically when an officer is demoted below LT or discharged. Regimental Command can remove a login.</p>
    <div class="frame"><table><thead><tr><th>Officer</th><th>Rank</th><th>Linked</th><th></th></tr></thead><tbody>
    ${rows.map(r => {
      const m = state.roster.find(x => x.person_id === r.person_id), mine = r.user_id === state.session?.user.id;
      return `<tr><td>${esc(r.person?.display_name)}${mine ? ' <span class="tag">you</span>' : ""}</td><td>${esc(m?.rank || "not serving")}</td>
        <td class="mono">${fmtDate(r.linked_at.slice(0, 10))}</td><td>${isRegcom() && !mine ? `<button class="btn small danger" data-unlink="${r.user_id}">Remove</button>` : ""}</td></tr>`;
    }).join("") || '<tr><td colspan="4" class="empty">No officer logins yet.</td></tr>'}</tbody></table></div>`;
  $("coBody").querySelectorAll("[data-unlink]").forEach(b => confirmClick(b, async () => {
    const res = check(await db.from("officer_account").delete().eq("user_id", b.dataset.unlink).select(), "Removing the login");
    toast(res.length ? "Login removed" : "Only Regimental Command can remove logins", !res.length);
    coLogins();
  }, "Remove"));
}

/* ---------- add member ---------- */
let checkTimer;
$("r-steam").oninput = () => { clearTimeout(checkTimer); checkTimer = setTimeout(checkSteam, 350); };
$("r-name").oninput = () => { delete $("r-name").dataset.auto; };  // typed by hand: never overwrite
async function checkSteam() {
  const sid = $("r-steam").value.trim().toUpperCase().replace(/^STEAM_1/, "STEAM_0");
  $("r-override-wrap").hidden = true; $("r-override").checked = false;
  if (!sid) { $("r-check").innerHTML = ""; return; }
  if (!/^STEAM_0:[01]:\d+$/.test(sid)) { $("r-check").innerHTML = `<div class="warnbox">Steam ID must look like STEAM_0:1:12345678.</div>`; return; }
  const [bl, person] = await Promise.all([
    db.from("v_active_blacklist").select("reason, issued_on, appealable_to").eq("steam_id", sid),
    db.from("person").select("display_name, membership!membership_person_id_fkey(left_at)").eq("steam_id", sid).maybeSingle()
  ]);
  const b = check(bl, "Checking the blacklist"), p = check(person, "Checking the Steam ID");
  const msgs = [];
  if (b.length) {
    msgs.push(`<div class="errbox"><b>Blacklisted</b> since ${fmtDate(b[0].issued_on)}: ${esc(b[0].reason || "no reason given")} (appeal to ${esc(b[0].appealable_to || "–")}).</div>`);
    $("r-override-wrap").hidden = false;
  }
  if (p) {
    const serving = (p.membership || []).some(x => !x.left_at);
    msgs.push(serving ? `<div class="errbox">${esc(p.display_name)} is already on the roster.</div>`
                      : `<div class="warnbox">Known as ${esc(p.display_name)} (former member or recruit). Their history will be kept.</div>`);
    if (!$("r-name").value || $("r-name").dataset.auto) { $("r-name").value = p.display_name; $("r-name").dataset.auto = "1"; }
  }
  if (!p && $("r-name").dataset.auto) { $("r-name").value = ""; delete $("r-name").dataset.auto; }
  if (!b.length && !p) msgs.push(`<div class="note">New Steam ID, not blacklisted.</div>`);
  $("r-check").innerHTML = msgs.join("");
}
$("recruitForm").onsubmit = async e => {
  e.preventDefault();
  $("r-submit").disabled = true;
  try {
    check(await db.rpc("add_member", { p_steam_id: $("r-steam").value, p_name: $("r-name").value, p_discord: $("r-discord").value,
      p_rank: $("r-rank").value, p_override: $("r-override").checked }), "Adding the member");
    toast(`${$("r-name").value.trim()} added to the roster`);
    $("recruitForm").reset(); $("r-check").innerHTML = ""; $("r-override-wrap").hidden = true;
    await refreshMe(); await loadRoster(); show("roster");
  } finally { $("r-submit").disabled = false; }
};

/* ---------- blacklist ---------- */
async function loadBlacklist() {
  const [all, appeals] = await Promise.all([
    db.from("blacklist").select("id, reason, appealable_to, issued_on, expires_on, officer_raw, person!blacklist_person_id_fkey(display_name, steam_id)").order("issued_on", { ascending: false }),
    db.from("blacklist_appeal").select("blacklist_id, decision, reason, decided_by_raw")
  ]);
  const list = check(all, "Loading the blacklist"), ap = check(appeals, "Loading appeals");
  const today = isoDay(), showAll = $("showRevoked").checked, off = isOfficer();
  const rows = list.map(b => {
    const rev = ap.find(a => a.blacklist_id === b.id && a.decision === "revoked");
    const expired = b.expires_on && b.expires_on <= today;
    return { ...b, rev, stateTxt: rev ? "Revoked" : expired ? "Expired" : "Active" };
  }).filter(b => showAll || b.stateTxt === "Active");
  $("blBody").innerHTML = rows.length ? rows.map(b => `<tr>
      <td><div class="who"><span>${esc(b.person?.display_name)}</span><small>${esc(b.person?.steam_id || "no Steam ID")}</small></div></td>
      <td class="mono">${fmtDate(b.issued_on)}</td><td>${esc(b.reason || "–")}</td><td class="hide-sm">${esc(b.appealable_to || "–")}</td>
      <td><span class="pill ${b.stateTxt === "Active" ? "p-bad" : "p-no"}" title="${esc(b.rev?.reason || "")}">${b.stateTxt}</span></td>
      <td>${off && b.stateTxt === "Active" ? `<button class="btn small" data-revoke="${b.id}">Revoke</button>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">No entries.</td></tr>`;
  $("blBody").querySelectorAll("[data-revoke]").forEach(btn => btn.onclick = async () => {
    const row = btn.closest("tr");
    row.querySelector("td:last-child").innerHTML = `<form class="row" data-f><input type="text" placeholder="Reason" required aria-label="Revocation reason"><button class="btn small primary">Confirm</button></form>`;
    const f = row.querySelector("[data-f]");
    f.querySelector("input").focus();
    f.onsubmit = async e => {
      e.preventDefault();
      const reason = f.querySelector("input").value.trim();
      if (!reason) return toast("Enter a reason.", true);
      check(await db.from("blacklist_appeal").insert({ blacklist_id: +btn.dataset.revoke, decision: "revoked",
        decided_on: today, decided_by_raw: state.me?.display_name || null, reason }), "Revoking");
      toast("Blacklist entry revoked"); loadBlacklist();
    };
  });
}
$("showRevoked").onchange = loadBlacklist;

/* ---------- change log ---------- */
async function loadChanges() {
  const [rows, accounts] = await Promise.all([
    db.from("audit_log").select("*").order("id", { ascending: false }).limit(100),
    db.from("officer_account").select("user_id, person!officer_account_person_id_fkey(display_name)")
  ]);
  const list = check(rows, "Loading the change log"), acc = check(accounts, "Loading officer names");
  const names = new Map(acc.map(a => [a.user_id, a.person?.display_name]));
  const describe = r => {
    const o = r.old_data || {}, n = r.new_data || {};
    if (r.action === "UPDATE") {
      const keys = Object.keys(n).filter(k => JSON.stringify(n[k]) !== JSON.stringify(o[k]));
      return keys.map(k => `${esc(k)}: ${esc(JSON.stringify(o[k]))} → ${esc(JSON.stringify(n[k]))}`).join("<br>");
    }
    const d = r.action === "DELETE" ? o : n;
    return Object.entries(d).filter(([k, v]) => v !== null && !k.endsWith("_id") && k !== "id").slice(0, 5).map(([k, v]) => `${esc(k)}: ${esc(JSON.stringify(v))}`).join(" · ");
  };
  const by = r => r.actor ? esc(names.get(r.actor) || "removed login") : "members area / admin";
  // One action (e.g. adding a member) can log several rows; the button sits on its newest row and undoes all of them.
  const seen = new Set(), size = new Map();
  list.forEach(r => { if (r.tx !== null) size.set(r.tx, (size.get(r.tx) || 0) + 1); });
  const fixed = t => t === "officer_account" || t === "co_document";
  const undoCell = r => {
    if (r.undone_at) return `<span class="pill p-no" title="${esc(fmtTime(r.undone_at))}">undone</span>`;
    if (fixed(r.table_name)) return "";
    if (r.tx !== null && seen.has(r.tx)) return `<span class="note" title="Undone together with the row above">same action</span>`;
    if (r.tx !== null) seen.add(r.tx);
    const n = r.tx !== null ? size.get(r.tx) : 1;
    return `<button class="btn small" data-undo="${r.id}" title="${n > 1 ? `Undoes all ${n} changes of this action` : "Undo this change"}">Undo${n > 1 ? " (" + n + ")" : ""}</button>`;
  };
  $("changesBody").innerHTML = list.length ? list.map(r => `<tr${r.undone_at ? ' class="undone"' : ""}><td class="mono">${new Date(r.at).toLocaleString("en-GB")}</td><td>${by(r)}</td><td>${esc(r.table_name)}</td><td>${esc(r.action.toLowerCase())}</td><td style="font-size:12px">${describe(r)}</td><td>${undoCell(r)}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">No changes yet.</td></tr>`;
  $("changesBody").querySelectorAll("[data-undo]").forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    const r = check(await db.rpc("undo_change", { p_id: +btn.dataset.undo }), "Undo");
    toast(r.message, !r.ok);
    if (r.ok) { await loadRoster(); loadChanges(); } else btn.disabled = false;
  });
}
$("changesReload").onclick = loadChanges;

/* ---------- strikes ---------- */
const APPEAL_LABEL = { none: "–", pending: "Pending", granted: "Granted", denied: "Denied" };
async function loadStrikes() {
  const list = check(await db.from("strike")
    .select("id, person_id, weight, reason, issued_on, expires_on, officer_raw, appeal_status, appealable_to, appeal_reason, person!strike_person_id_fkey(display_name, steam_id)")
    .order("issued_on", { ascending: false }).order("id", { ascending: false }), "Loading strikes");
  const today = isoDay(), q = $("strikeQ").value.trim().toLowerCase(), filter = $("strikeFilter").value;
  const onRoster = new Map(state.roster.map(m => [m.person_id, m.membership_id]));
  const rows = list.map(s => {
    const appealed = s.appeal_status === "granted", expired = s.expires_on && s.expires_on <= today;
    return { ...s, active: !appealed && !expired, stateTxt: appealed ? "Appealed" : expired ? "Expired" : "Active" };
  }).filter(s => (filter === "all" || (filter === "active" ? s.active : s.stateTxt === "Appealed" || s.appeal_status !== "none"))
    && (!q || `${s.person?.display_name} ${s.person?.steam_id} ${s.reason}`.toLowerCase().includes(q)));
  const activePoints = list.filter(s => s.appeal_status !== "granted" && !(s.expires_on && s.expires_on <= today)).reduce((a, s) => a + +s.weight, 0);
  $("strikeStats").textContent = `${rows.length} shown · ${num(activePoints)} active strike points across the regiment`;
  $("strikeBody").innerHTML = rows.length ? rows.map(s => {
    const mid = onRoster.get(s.person_id);
    return `<tr${mid ? ` class="member" data-mid="${mid}"` : ""}>
      <td><div class="who"><span>${esc(s.person?.display_name)}</span><small>${mid ? esc(s.person?.steam_id || "") : "not on the roster"}</small></div></td>
      <td class="mono">${fmtDate(s.issued_on)}</td><td class="n">${num(s.weight)}</td><td>${esc(s.reason || "–")}</td>
      <td class="hide-sm">${esc(s.officer_raw || "–")}</td><td class="mono hide-sm">${s.expires_on ? fmtDate(s.expires_on) : "no expiry"}</td>
      <td><span class="pill ${s.active ? "p-bad" : "p-no"}">${s.stateTxt}</span></td>
      <td><span title="${esc(s.appeal_reason || "")}">${APPEAL_LABEL[s.appeal_status] || esc(s.appeal_status)}</span></td>
      <td>${esc(s.appealable_to || "–")}</td></tr>`;
  }).join("") : `<tr><td colspan="9" class="empty">No strikes match.</td></tr>`;
  $("strikeBody").querySelectorAll("tr[data-mid]").forEach(tr => tr.onclick = () => openPerson(tr.dataset.mid));
}
$("strikeQ").oninput = loadStrikes;
$("strikeFilter").onchange = loadStrikes;

/* ---------- start ---------- */
(async () => {
  resetMemberDates();
  try {
    await refreshMe();
    await loadRanks();
    await loadRoster();
    show(location.hash.slice(1) || "roster");
  } catch (e) {
    setConn(false, "Not connected");
    $("rosterBody").innerHTML = `<tr><td colspan="7" class="empty">Could not reach the database: ${esc(e.message)}</td></tr>`;
  }
})();
