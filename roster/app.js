"use strict";
// Nu-7 roster test site. Reading is public; every change is checked by the database
// (row-level security + officer-only functions), the hiding of buttons here is only for convenience.

const SUPABASE_URL = "https://vkqrvppfwqjmxxtjowbn.supabase.co";
const SUPABASE_KEY = "sb_publishable_mgskScP9EMFntMzC8adX-A_qw_z9zYz";  // publishable key: safe to be public
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "nu7-roster-auth" }
});

const KIND_LABEL = { activity: "auto", cooldown: "auto", qualification: "licence", attended_basic: "auto", hosted_training: "auto", hosted_tryout: "auto", manual: "manual" };
const state = { roster: [], ranks: [], stage: null, board: [], reqs: [], discord: new Map(), me: null, session: null, view: "roster" };
const isOfficer = () => !!state.me?.is_officer;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = d => d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-GB") : "–";
const num = v => (v === null || v === undefined) ? "–" : (+v % 1 ? (+v).toFixed(1) : String(+v));
const slug = s => String(s || "").toLowerCase().replace(/\s+/g, "-");
const pill = s => `<span class="pill s-${slug(s)}">${esc(s)}</span>`;
const isoDay = (offset = 0) => { const d = new Date(Date.now() + offset * 864e5); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

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
const VIEWS = ["roster", "hours", "board", "blacklist", "recruit", "changes", "officers"];
const OFFICER_VIEWS = ["recruit", "changes", "officers"];
function show(view) {
  if (!VIEWS.includes(view) || (OFFICER_VIEWS.includes(view) && !isOfficer())) view = "roster";
  state.view = view;
  VIEWS.forEach(v => { $("view-" + v).hidden = v !== view; });
  document.querySelectorAll("nav button").forEach(b => { if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  if (view === "board") loadBoard();
  if (view === "blacklist") loadBlacklist();
  if (view === "changes") loadChanges();
  if (view === "officers") loadOfficers();
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
  if (state.session) {
    const who = state.me ? `${esc(state.me.display_name)} <span class="mono">${esc(state.me.rank || "no rank")}</span>${isOfficer() ? "" : " · no edit rights"}`
                         : `${esc(state.session.user.email)} · not linked`;
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
  const tabs = state.session ? "" : `<div class="authtabs" role="tablist">
      <button role="tab" data-mode="signin" aria-selected="${mode === "signin"}">Sign in</button>
      <button role="tab" data-mode="register" aria-selected="${mode === "register"}">Create login</button>
      <button role="tab" data-mode="reset" aria-selected="${mode === "reset"}">Forgot password</button></div>`;
  const forms = {
    signin: `<form class="card form" id="authForm">
        <label class="f wide">Email<input type="email" id="a-email" autocomplete="username" required></label>
        <label class="f wide">Password<input type="password" id="a-pass" autocomplete="current-password" required></label>
        <div class="wide"><button class="btn primary" type="submit">Sign in</button></div></form>`,
    register: `<form class="card form" id="authForm">
        <p class="note wide">Step 1 of 2: create a login. Step 2: link it to your roster entry with your Steam ID and the CO registration code from Regimental Command. Only LT and above can be linked.</p>
        <label class="f wide">Email<input type="email" id="a-email" autocomplete="username" required></label>
        <label class="f wide">Password (at least 12 characters)<input type="password" id="a-pass" autocomplete="new-password" minlength="12" required></label>
        <label class="f wide">Repeat password<input type="password" id="a-pass2" autocomplete="new-password" minlength="12" required></label>
        <div class="wide"><button class="btn primary" type="submit">Create login</button></div></form>`,
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
    account: `<div class="card"><p>Signed in as <b>${esc(state.me?.display_name || "")}</b> (${esc(state.me?.rank || "no rank")}) with ${esc(state.session?.user.email || "")}.</p>
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
  const msg = (text, ok) => { $("a-msg").innerHTML = `<div class="${ok ? "okbox" : "errbox"}">${esc(text)}</div>`; };
  const form = $("authForm");
  if (!form) return;
  form.querySelector("input")?.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const email = $("a-email")?.value.trim(), pass = $("a-pass")?.value;
      const here = location.origin + location.pathname;
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
  state.ranks = check(await db.from("rank").select("id, code, name, category_id, sort_order, max_slots, weekly_hours_required, cooldown_days").order("sort_order"), "Loading ranks");
  $("r-rank").innerHTML = state.ranks.map(r => `<option value="${r.code}" ${r.code === "PVT" ? "selected" : ""}>${esc(r.name)} (${r.code})</option>`).join("");
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
  const [aliases, ranks, strikes, leaves, duty, medals, trainings, member] = await Promise.all([
    db.from("person_alias").select("name, first_seen").eq("person_id", pid).order("first_seen", { ascending: false, nullsFirst: false }),
    db.from("rank_change").select("id, kind, effective_on, officer_raw, comment, from:from_rank_id(code), to:to_rank_id(code)").eq("person_id", pid).order("effective_on", { ascending: false }).order("id", { ascending: false }),
    db.from("strike").select("*").eq("person_id", pid).order("issued_on", { ascending: false }),
    db.from("leave").select("*").eq("person_id", pid).order("starts_on", { ascending: false }),
    db.from("duty_log").select("id, logged_on, hours, comment, source, rejected").eq("person_id", pid).order("logged_on", { ascending: false }).order("id", { ascending: false }).limit(15),
    db.from("medal_award").select("awarded_on, issuer_raw, medal_type(name)").eq("person_id", pid).order("awarded_on", { ascending: false }),
    db.from("training_attendee").select("training(held_on, training_type(name))").eq("person_id", pid),
    db.from("membership").select("id, status_override, notes, recruited_at").eq("id", membershipId).single()
  ]);
  const al = check(aliases, "Loading names"), rc = check(ranks, "Loading rank history"), st = check(strikes, "Loading strikes"),
    lv = check(leaves, "Loading leave"), du = check(duty, "Loading duty logs"), me = check(medals, "Loading medals"),
    tr = check(trainings, "Loading trainings"), ms = check(member, "Loading membership");
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
      <label class="f wide">Notes<textarea id="e-notes">${esc(ms.notes || "")}</textarea></label>
      <div class="wide"><button class="btn primary" type="submit">Save details</button></div>
    </form>` : (ms.notes ? `<div class="card"><h3>Notes</h3><p>${esc(ms.notes)}</p></div>` : "")}

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
        <label class="f">Weight<select id="s-weight"><option value="0.5">0.5</option><option value="1" selected>1</option></select></label>
        <label class="f">Expires<input type="date" id="s-exp" value="${isoDay(14)}"></label>
        <label class="f wide">Reason<input type="text" id="s-reason" required></label>
        <div><button class="btn primary" type="submit">Add strike</button></div>
      </form>` : ""}
      <div class="list">${st.length ? st.map(s => {
        const active = s.appeal_status !== "granted" && (!s.expires_on || s.expires_on > today);
        return `<div><span class="d">${fmtDate(s.issued_on)}</span><span class="grow">${num(s.weight)} · ${esc(s.reason || "")} <small class="mono">${s.appeal_status === "granted" ? "appealed" : active ? "active until " + fmtDate(s.expires_on) : "expired"}</small></span>
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
    check(await db.from("membership").update({ status_override: $("e-override").value || null, notes: $("e-notes").value.trim() || null }).eq("id", membershipId), "Saving details");
    await refreshMe();
    await after("Details saved");
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
    check(await db.from("strike").insert({ person_id: pid, weight: +$("s-weight").value, reason, issued_on: today,
      expires_on: $("s-exp").value || null, officer_raw: officerName }), "Adding the strike");
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

/* ---------- log hours (PVT - CSG) ---------- */
function resetHoursForm() {
  $("h-date").value = isoDay(); $("h-date").max = isoDay(); $("h-date").min = isoDay(-6);
}
$("hoursForm").onsubmit = async e => {
  e.preventDefault();
  const out = (text, ok) => { $("h-result").innerHTML = `<div class="${ok ? "okbox" : "errbox"}">${esc(text)}</div>`; };
  if ($("h-website").value) return out("Logged.", true);  // bot trap: real people never see this field
  const steam = $("h-steam").value.trim(), discord = $("h-discord").value.trim(), hours = parseFloat($("h-hours").value);
  if (!steam || !discord) return out("Enter your Steam ID and Discord username.");
  if (!(hours > 0 && hours <= 12)) return out("Hours must be more than 0 and at most 12.");
  $("h-submit").disabled = true;
  try {
    const r = check(await db.rpc("submit_duty", { p_steam_id: steam, p_discord: discord, p_date: $("h-date").value,
      p_hours: hours, p_comment: $("h-comment").value.trim() || null }), "Logging hours");
    if (!r.ok) return out(r.message);
    out(`${r.message} · your hours in the last 7 days: ${num(r.week_hours)}`, true);
    $("h-hours").value = "1"; $("h-comment").value = "";
    loadRoster();
  } finally { $("h-submit").disabled = false; }
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
  const by = r => r.actor ? esc(names.get(r.actor) || "removed login") : (r.table_name === "duty_log" && r.new_data?.source === "self" ? "hours form" : "admin");
  $("changesBody").innerHTML = list.length ? list.map(r => `<tr><td class="mono">${new Date(r.at).toLocaleString("en-GB")}</td><td>${by(r)}</td><td>${esc(r.table_name)}</td><td>${esc(r.action.toLowerCase())}</td><td style="font-size:12px">${describe(r)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No changes yet.</td></tr>`;
}
$("changesReload").onclick = loadChanges;

/* ---------- officer logins ---------- */
async function loadOfficers() {
  const rows = check(await db.from("officer_account").select("user_id, linked_at, person_id, person!officer_account_person_id_fkey(display_name)").order("linked_at"), "Loading officer logins");
  const regcom = !!state.me?.is_regcom;
  $("officersBody").innerHTML = rows.length ? rows.map(r => {
    const m = state.roster.find(x => x.person_id === r.person_id);
    const mine = r.user_id === state.session?.user.id;
    return `<tr><td>${esc(r.person?.display_name)}${mine ? ' <span class="tag">you</span>' : ""}</td><td>${esc(m?.rank || "not serving")}</td>
      <td class="mono">${fmtDate(r.linked_at.slice(0, 10))}</td>
      <td>${regcom && !mine ? `<button class="btn small danger" data-unlink="${r.user_id}">Remove</button>` : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="empty">No officer logins yet.</td></tr>`;
  $("officersBody").querySelectorAll("[data-unlink]").forEach(b => confirmClick(b, async () => {
    const res = check(await db.from("officer_account").delete().eq("user_id", b.dataset.unlink).select(), "Removing the login");
    toast(res.length ? "Login removed" : "Only Regimental Command can remove logins", !res.length);
    loadOfficers();
  }, "Remove"));
}

/* ---------- start ---------- */
(async () => {
  resetHoursForm();
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
