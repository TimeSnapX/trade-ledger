import * as db from "./db.js?v=1";
import { importCsvText, importFrom, sources } from "./sources.js?v=1";
import { sampleTrades } from "./sample.js?v=1";
import {
  DEFAULT_CONTRACT_VALUES, MAX_TRADES_CAP, RULE_LABELS, applyRules, bne, enrich, fmtAud,
  round2, stats, todaySummary, weekStart, withDefaults,
} from "./calc.js?v=1";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PRESET_TAGS = ["planned setup", "revenge", "news"];

const state = {
  view: "today",
  settings: withDefaults(),
  raw: [],
  journal: new Map(),
  trades: [],
  filters: { symbol: "", from: "", to: "", tag: "" },
  journalUntagged: false,
};

const money = (v) => `<span class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${esc(fmtAud(v))}</span>`;
const num = (v) => (v == null ? "—" : String(v));
const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const hourLabel = (h) => `${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59`;
const effTag = (t) => state.journal.get(t.ticket)?.tag || t.tag || "";

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

async function load() {
  state.settings = withDefaults(await db.getMeta("settings", {}));
  state.raw = await db.all("trades");
  state.journal = new Map((await db.all("journal")).map((j) => [j.ticket, j]));
  state.trades = applyRules(enrich(state.raw, state.settings), state.settings);
}

async function refresh() {
  await load();
  render();
}

function render() {
  $("#sample-banner").hidden = !state.raw.some((t) => t.sample);
  for (const b of $$(".bottom-nav .tab")) b.setAttribute("aria-selected", String(b.dataset.view === state.view));
  for (const v of $$(".view")) v.hidden = v.id !== `view-${state.view}`;
  ({ today: renderToday, log: renderLog, stats: renderStats, journal: renderJournal, rules: renderRules, settings: renderSettings })[state.view]();
}

function go(view) {
  state.view = view;
  render();
  window.scrollTo(0, 0);
}

/* ---------- shared bits ---------- */
function badges(t) {
  const out = t.breaches.map((b) => `<span class="badge" data-breach="${b}">${esc(RULE_LABELS[b])}</span>`);
  if (t.belowTarget) out.push(`<span class="badge warn">R:R below ${state.settings.rrTarget}:1 target</span>`);
  if (!t.noSl && t.unknownSymbol) out.push(`<span class="badge warn">No contract value for ${esc(t.symbol)}</span>`);
  const tag = effTag(t);
  if (tag) out.push(`<span class="badge tag">${esc(tag)}</span>`);
  if (t.sample) out.push(`<span class="badge ex">EXAMPLE</span>`);
  return out.length ? `<div class="badges">${out.join("")}</div>` : "";
}

function tradeRow(t) {
  const right = t.open
    ? `<span class="money">${t.profit != null ? money(t.profit) : "open"}<small>${t.profit != null ? "floating (last import)" : ""}</small></span>`
    : `<span class="money">${money(t.net)}<small>${esc(t.closeB.time)} close</small></span>`;
  return `<button class="row trade" type="button" data-ticket="${esc(t.ticket)}">
    <span class="dot ${t.side}"></span>
    <span><b>${esc(t.symbol)} · ${t.side.toUpperCase()} ${t.lots}</b>
      <small>${esc(t.openB.label)} · #${esc(t.ticket)}${t.risk != null ? ` · risk ${esc(fmtAud(t.risk))}` : ""}</small>
      ${badges(t)}</span>
    ${right}
  </button>`;
}

function emptyState() {
  return `<div class="empty">
    <h2>No trades yet</h2>
    <p>Import the <code>mt5-trades.csv</code> file, or load clearly marked example trades to look around.</p>
    <div class="jobs-tools" style="justify-content:center">
      <button class="btn primary" type="button" data-open-import>Import CSV</button>
      <button class="btn" type="button" data-load-sample>Load sample data</button>
    </div>
  </div>`;
}

const card = (label, value, sub = "", attr = "") =>
  `<div class="stat-card" ${attr}><p class="label">${label}</p><p class="stat-value">${value}</p><span class="sub">${sub}</span></div>`;

/* ---------- Today ---------- */
function renderToday() {
  const el = $("#view-today");
  if (!state.trades.length) { el.innerHTML = emptyState(); return; }
  const s = state.settings;
  const sum = todaySummary(state.trades, s, Date.now());
  const todayClosed = state.trades.filter((t) => !t.open && t.closeB.date === sum.today).reverse();
  el.innerHTML = `
    <div class="stats">
      ${card("Today net", money(sum.dayNet), `Brisbane ${esc(sum.today)}`, 'data-k="day-net"')}
      ${card("This week net", money(sum.weekNet), `since Mon ${esc(sum.weekStart)}`, 'data-k="week-net"')}
      ${card("Open risk", esc(fmtAud(sum.openRisk)), sum.openNoSl ? '<span class="neg">+ no-SL position</span>' : `${sum.open.length} open`, 'data-k="open-risk"')}
      ${card("Rules today", `<span class="status-light ${sum.status}" style="display:inline-block;width:22px;height:22px;vertical-align:middle"></span> ${sum.status.toUpperCase()}`, `${sum.todayCount}/${s.maxTradesPerDay} trades`, 'data-k="status"')}
    </div>
    ${sum.openNoSl ? `<div class="warnbox" data-k="no-sl-warning">⚠ ${sum.openNoSl} open position${sum.openNoSl > 1 ? "s have" : " has"} no stop loss. Risk is unlimited until an SL is set.</div>` : ""}
    ${sum.openUnknown ? `<div class="infobox">${sum.openUnknown} open position(s) on a symbol with no contract value, so not counted in open risk. Add it in Settings.</div>` : ""}
    <div class="panel section">
      <div class="panel-head"><div><h2>Open positions</h2><p>Risk = entry to SL × lots × contract value (AUD)</p></div></div>
      <div class="list" id="open-list">${sum.open.length ? sum.open.map(tradeRow).join("") : '<p class="muted">No open positions.</p>'}</div>
    </div>
    <div class="panel section">
      <div class="panel-head"><div><h2>Closed today</h2><p>Net = profit + commission + swap</p></div></div>
      <div class="list">${todayClosed.length ? todayClosed.map(tradeRow).join("") : '<p class="muted">Nothing closed today.</p>'}</div>
    </div>`;
}

/* ---------- Trade log ---------- */
function filteredTrades() {
  const f = state.filters;
  return state.trades.filter((t) => {
    if (f.symbol && t.symbol !== f.symbol) return false;
    if (f.from && t.openB.date < f.from) return false;
    if (f.to && t.openB.date > f.to) return false;
    if (f.tag === "__none" && effTag(t)) return false;
    if (f.tag && f.tag !== "__none" && effTag(t) !== f.tag) return false;
    return true;
  });
}

function renderLog() {
  const el = $("#view-log");
  if (!state.trades.length) { el.innerHTML = emptyState(); return; }
  const f = state.filters;
  const symbols = [...new Set(state.trades.map((t) => t.symbol))].sort();
  const tags = [...new Set(state.trades.map(effTag).filter(Boolean))].sort();
  const list = filteredTrades().slice().reverse();
  const closedNet = round2(list.filter((t) => !t.open).reduce((a, t) => a + t.net, 0));
  el.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        <select class="filter" id="f-symbol" aria-label="Symbol"><option value="">All symbols</option>${symbols.map((s) => `<option ${s === f.symbol ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <select class="filter" id="f-tag" aria-label="Tag"><option value="">All tags</option><option value="__none" ${f.tag === "__none" ? "selected" : ""}>Untagged</option>${tags.map((s) => `<option ${s === f.tag ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <input class="filter" type="date" id="f-from" aria-label="From date" value="${esc(f.from)}" />
        <input class="filter" type="date" id="f-to" aria-label="To date" value="${esc(f.to)}" />
        <button class="btn small" type="button" id="f-reset">Reset filters</button>
      </div>
      <p class="muted" id="log-summary">${list.length} trade${list.length === 1 ? "" : "s"} · closed net ${money(closedNet)}</p>
    </div>
    <div class="list" id="log-list">${list.map(tradeRow).join("") || '<p class="muted">No trades match.</p>'}</div>
    <p class="note">Dates are the open date in Brisbane time. Tap a trade for details and journal.</p>`;
  const bind = (id, key) => $(id).addEventListener("change", (e) => { state.filters[key] = e.target.value; renderLog(); });
  bind("#f-symbol", "symbol"); bind("#f-tag", "tag"); bind("#f-from", "from"); bind("#f-to", "to");
  $("#f-reset").addEventListener("click", () => { state.filters = { symbol: "", from: "", to: "", tag: "" }; renderLog(); });
}

/* ---------- Trade detail ---------- */
function openTrade(ticket) {
  const t = state.trades.find((x) => x.ticket === ticket);
  if (!t) return;
  $("#trade-kicker").textContent = `#${t.ticket}${t.sample ? " · EXAMPLE" : ""}`;
  $("#trade-title").textContent = `${t.symbol} ${t.side.toUpperCase()} ${t.lots}`;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  $("#trade-body").innerHTML = `
    ${t.breaches.length ? `<div class="warnbox" data-k="detail-breaches"><b>Rule breaches:</b> ${t.breaches.map((b) => esc(RULE_LABELS[b])).join(" · ")}</div>` : '<p class="pos" style="margin:0 0 10px">No rule breaches.</p>'}
    <dl class="kv" style="margin-top:12px">
      ${row("Status", t.open ? "Open" : "Closed")}
      ${row("Opened (Brisbane)", esc(t.openB.label))}
      ${row("Closed (Brisbane)", t.closeB ? esc(t.closeB.label) : "—")}
      ${row("Server time (CSV)", esc(t.open_time.replace("T", " ")) + (t.close_time ? ` → ${esc(t.close_time.replace("T", " "))}` : ""))}
      ${row("Entry → exit", `${num(t.entry)} → ${num(t.exit)}`)}
      ${row("SL / TP", `${t.sl ?? '<span class="neg">no SL</span>'} / ${t.tp ?? "none"}`)}
      ${row("Planned risk", t.risk != null ? esc(fmtAud(t.risk)) : t.noSl ? '<span class="neg">unlimited (no SL)</span>' : "unknown (no contract value)")}
      ${row("Planned R:R", t.rr != null ? `${t.rr.toFixed(2)} : 1` : "—")}
      ${row("R multiple", !t.open && t.risk ? `${(t.net / t.risk).toFixed(2)} R` : "—")}
      ${row("Profit", money(t.profit))}
      ${row("Commission", money(t.commission ?? 0))}
      ${row("Swap", money(t.swap ?? 0))}
      ${row("Net", t.open ? "open" : `<b>${money(t.net)}</b>`)}
      ${row("Trade # that day", `${t.dayIndex} of max ${state.settings.maxTradesPerDay}`)}
      ${t.tag ? row("CSV tag", esc(t.tag)) : ""}
      ${t.note ? row("CSV note", esc(t.note)) : ""}
    </dl>
    <h3 style="margin:18px 0 8px;font-size:18px">Journal</h3>
    ${journalEditor(t)}`;
  bindJournal($("#trade-body"));
  $("#dlg-trade").showModal();
}

/* ---------- Journal ---------- */
function journalEditor(t) {
  const j = state.journal.get(t.ticket) ?? {};
  const tag = j.tag ?? "";
  const isCustom = tag && !PRESET_TAGS.includes(tag);
  return `<div class="journal-card" data-journal="${esc(t.ticket)}">
    <div class="jrow">
      <label class="field">Tag
        <select data-j-tag>
          <option value="">— none —</option>
          ${PRESET_TAGS.map((p) => `<option value="${p}" ${p === tag ? "selected" : ""}>${p}</option>`).join("")}
          <option value="__custom" ${isCustom ? "selected" : ""}>custom…</option>
        </select>
      </label>
      <label class="field" ${isCustom ? "" : "hidden"} data-j-custom-wrap>Custom tag
        <input type="text" data-j-custom value="${isCustom ? esc(tag) : ""}" maxlength="40" />
      </label>
    </div>
    <label class="field">Note
      <textarea data-j-note rows="3" maxlength="2000">${esc(j.note ?? "")}</textarea>
    </label>
    <div><button class="btn small primary" type="button" data-j-save>Save journal</button> <span class="saved" data-j-saved>${j.updatedAt ? "Saved" : ""}</span></div>
  </div>`;
}

function bindJournal(root) {
  for (const cardEl of $$("[data-journal]", root)) {
    const sel = $("[data-j-tag]", cardEl);
    sel.addEventListener("change", () => { $("[data-j-custom-wrap]", cardEl).hidden = sel.value !== "__custom"; });
    $("[data-j-save]", cardEl).addEventListener("click", async () => {
      const ticket = cardEl.dataset.journal;
      let tag = sel.value === "__custom" ? $("[data-j-custom]", cardEl).value.trim() : sel.value;
      const note = $("[data-j-note]", cardEl).value.trim();
      if (!tag && !note) await db.del("journal", ticket);
      else await db.put("journal", { ticket, tag, note, updatedAt: new Date().toISOString() });
      await load();
      $("[data-j-saved]", cardEl).textContent = "Saved";
      toast("Journal saved");
    });
  }
}

function renderJournal() {
  const el = $("#view-journal");
  if (!state.trades.length) { el.innerHTML = emptyState(); return; }
  const list = state.trades.slice().reverse().filter((t) => !state.journalUntagged || !effTag(t));
  el.innerHTML = `
    <div class="toolbar">
      <label class="check"><input type="checkbox" id="j-untagged" ${state.journalUntagged ? "checked" : ""} /><span><b>Untagged only</b><small>Tag: planned setup / revenge / news / custom</small></span></label>
      <p class="muted">Stored in this browser by ticket. Re-importing the CSV keeps notes.</p>
    </div>
    <div class="list">${list.map((t) => `<div class="panel">
      <p style="margin:0 0 10px"><b>${esc(t.symbol)} ${t.side.toUpperCase()} ${t.lots}</b> <span class="muted">· ${esc(t.openB.label)} · #${esc(t.ticket)} · ${t.open ? "open" : money(t.net)}</span></p>
      ${journalEditor(t)}</div>`).join("") || '<p class="muted">Every trade is tagged.</p>'}</div>`;
  $("#j-untagged").addEventListener("change", (e) => { state.journalUntagged = e.target.checked; renderJournal(); });
  bindJournal(el);
}

/* ---------- Stats ---------- */
function equitySvg(curve) {
  if (curve.length < 2) return '<p class="muted">Needs closed trades.</p>';
  const w = 600, h = 160, pad = 8;
  const min = Math.min(0, ...curve), max = Math.max(0, ...curve);
  const span = max - min || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (curve.length - 1);
  const y = (v) => h - pad - ((v - min) * (h - 2 * pad)) / span;
  const pts = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Equity curve">
    <line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(244,234,214,0.2)" stroke-dasharray="4 4"/>
    <polyline points="${pts}" fill="none" stroke="#ffd27a" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderStats() {
  const el = $("#view-stats");
  if (!state.trades.length) { el.innerHTML = emptyState(); return; }
  const st = stats(state.trades);
  const pf = st.profitFactor == null ? "—" : st.profitFactor === Infinity ? "∞" : st.profitFactor.toFixed(2);
  const g = (x, fmt) => (x ? `${fmt(x.key)} <span class="muted">·</span> ${money(x.net)}` : "—");
  el.innerHTML = `
    <div class="stats three">
      ${card("Win rate", pct(st.winRate), `${st.wins}W / ${st.losses}L of ${st.n} closed`, 'data-k="win-rate"')}
      ${card("Avg win vs avg loss", `${esc(fmtAud(st.avgWin))} / ${esc(fmtAud(st.avgLoss == null ? null : -st.avgLoss))}`, "", 'data-k="avg"')}
      ${card("Profit factor", pf, "gross win ÷ gross loss", 'data-k="pf"')}
      ${card("Expectancy", money(st.expectancy), "net per trade", 'data-k="expectancy"')}
      ${card("Max drawdown", esc(fmtAud(st.maxDrawdown == null ? null : -st.maxDrawdown)), "peak to trough, closed net", 'data-k="max-dd"')}
      ${card("Total net", money(st.total), "profit + commission + swap", 'data-k="total"')}
    </div>
    <div class="panel section"><div class="panel-head"><div><h2>Equity</h2><p>Cumulative closed net, by close time</p></div></div>${equitySvg(st.curve)}</div>
    <div class="split">
      <div class="panel"><div class="panel-head"><div><h2>Symbols</h2><p>By total net</p></div></div>
        <dl class="kv"><dt>Best symbol</dt><dd data-k="best-symbol">${g(st.bestSymbol, esc)}</dd><dt>Worst symbol</dt><dd data-k="worst-symbol">${g(st.worstSymbol, esc)}</dd></dl></div>
      <div class="panel"><div class="panel-head"><div><h2>Hours</h2><p>Open hour, Brisbane time (UTC+10)</p></div></div>
        <dl class="kv"><dt>Best hour</dt><dd data-k="best-hour">${g(st.bestHour, hourLabel)}</dd><dt>Worst hour</dt><dd data-k="worst-hour">${g(st.worstHour, hourLabel)}</dd></dl></div>
    </div>
    <p class="note">Win = net above $0. Profit factor = gross win ÷ gross loss. Expectancy = total net ÷ closed trades. Open positions are left out.</p>`;
}

/* ---------- Rules ---------- */
function renderRules() {
  const el = $("#view-rules");
  const s = state.settings;
  const sum = todaySummary(state.trades, s, Date.now());
  const weekBreached = state.trades.filter((t) => weekStart(t.openMs) === sum.weekStart && t.breaches.length).reverse();
  const msg = { green: "All clear. Within every rule today.", amber: "Careful. Close to a limit.", red: "Stop. A rule is broken or a limit is hit." }[sum.status];
  el.innerHTML = `
    <div class="panel status-card" data-k="rules-status" data-status="${sum.status}">
      <span class="status-light ${sum.status}"></span>
      <div><h2>Today: ${sum.status.toUpperCase()}</h2><p class="muted">${msg}</p>
        ${sum.reasons.length ? `<ul>${sum.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</div>
    </div>
    <div class="stats section">
      ${card("Today net vs stop", money(sum.dayNet), `stop at -${esc(fmtAud(s.dailyLossStop))}`)}
      ${card("Trades today", `${sum.todayCount} / ${s.maxTradesPerDay}`, "max per day")}
      ${card("Week net vs limit", money(sum.weekNet), `limit -${esc(fmtAud(s.weeklyLossLimit))}`)}
      ${card("Breaches this week", `<span data-k="week-breaches">${sum.weekBreaches}</span>`, `since Mon ${esc(sum.weekStart)}`)}
    </div>
    <div class="panel section">
      <div class="panel-head"><div><h2>This week's breaches</h2><p>Tap a trade for details</p></div></div>
      <div class="list" id="breach-list">${weekBreached.map(tradeRow).join("") || '<p class="muted">No breaches this week.</p>'}</div>
    </div>
    <div class="panel section">
      <div class="panel-head"><div><h2>Your rules</h2><p>All AUD</p></div><button class="btn small" type="button" data-go="settings">Edit rules</button></div>
      <dl class="kv">
        <dt>Max risk per trade</dt><dd>${esc(fmtAud(s.maxRiskPerTrade))}</dd>
        <dt>Daily loss stop</dt><dd>${esc(fmtAud(s.dailyLossStop))}</dd>
        <dt>Weekly loss limit</dt><dd>${esc(fmtAud(s.weeklyLossLimit))}</dd>
        <dt>Max trades per day</dt><dd>${s.maxTradesPerDay}</dd>
        <dt>Reward-to-risk target</dt><dd>${s.rrTarget}:1 (flag under 1:1)</dd>
      </dl>
      <p class="note">Flags per trade: no SL; SL risk over ${esc(fmtAud(s.maxRiskPerTrade))}; TP under 1:1; trade number over ${s.maxTradesPerDay} that day; opened after the day's closed net reached -${esc(fmtAud(s.dailyLossStop))}; opened after the week's closed net reached -${esc(fmtAud(s.weeklyLossLimit))}. Day and week are Brisbane time, week starts Monday. SL/TP come from the CSV, which may be the final (moved) levels, not the original ones.</p>
    </div>`;
}

/* ---------- Settings ---------- */
function renderSettings() {
  const el = $("#view-settings");
  const s = state.settings;
  const cvRows = Object.entries(s.contractValues).sort(([a], [b]) => a.localeCompare(b));
  const missing = [...new Set(state.trades.filter((t) => t.unknownSymbol).map((t) => t.symbol))];
  const numField = (id, label, v, extra = "") => `<label class="field">${label}<input type="number" id="${id}" value="${v}" ${extra} /></label>`;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h2>Rules</h2><p>All AUD. Saved in this browser.</p></div></div>
      <form id="rules-form" class="form-grid" novalidate>
        ${numField("s-maxRisk", "Max risk per trade ($)", s.maxRiskPerTrade, 'min="1" step="1"')}
        ${numField("s-dailyStop", "Daily loss stop ($)", s.dailyLossStop, 'min="1" step="1"')}
        ${numField("s-weeklyLimit", "Weekly loss limit ($)", s.weeklyLossLimit, 'min="1" step="1"')}
        ${numField("s-maxTrades", `Max trades per day (1–${MAX_TRADES_CAP})`, s.maxTradesPerDay, `min="1" max="${MAX_TRADES_CAP}" step="1"`)}
        ${numField("s-rr", "Reward-to-risk target (x:1)", s.rrTarget, 'min="0.5" step="0.1"')}
        ${numField("s-offset", "Broker server time (UTC+)", s.serverOffsetH, 'min="-12" max="14" step="0.5"')}
        <p class="helper full">CSV times are broker server time. IC Markets MT5 server is usually UTC+3 in the northern summer and UTC+2 in winter; check the time in MT5 against UTC. Everything is shown in Brisbane time (UTC+10).</p>
        <div class="full"><button class="btn primary" type="submit">Save settings</button></div>
      </form>
    </div>
    <div class="panel section">
      <div class="panel-head"><div><h2>Contract values</h2><p>AUD value of a 1.00 price move for 1.00 lot</p></div></div>
      ${missing.length ? `<div class="warnbox">No contract value for: ${missing.map(esc).join(", ")}. Risk for these can't be worked out; add them below.</div>` : ""}
      <table class="cv-table"><thead><tr><th>Symbol</th><th>AUD per 1.00 move per lot</th><th></th></tr></thead><tbody>
        ${cvRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td><input type="number" step="any" min="0" data-cv="${esc(k)}" value="${v}" aria-label="${esc(k)} contract value" /></td><td><button class="btn small ghost" type="button" data-cv-del="${esc(k)}">Remove</button></td></tr>`).join("")}
        <tr><td><input type="text" id="cv-new-sym" placeholder="SYMBOL" value="${esc(missing[0] ?? "")}" aria-label="New symbol" /></td><td><input type="number" step="any" min="0" id="cv-new-val" placeholder="e.g. 154000" aria-label="New contract value" /></td><td><button class="btn small" type="button" id="cv-add">Add symbol</button></td></tr>
      </tbody></table>
      <p class="helper">Defaults are rough, assuming 1 USD = 1.54 AUD: FX majors 100,000 units per lot (EURUSD 154,000), XAUUSD 100 oz (154), US500/US30/USTEC 1.54, AUS200 1.00, DE40 1.75. Check MT5 (symbol › Specification) and your AUD rate. A symbol like EURUSD.a uses the EURUSD value.</p>
      <div class="jobs-tools"><button class="btn primary" type="button" id="cv-save">Save contract values</button><button class="btn" type="button" id="cv-reset">Reset to defaults</button></div>
    </div>
    <div class="panel section">
      <div class="panel-head"><div><h2>Backup</h2><p>Journal + settings as JSON (trades come from the CSV)</p></div></div>
      <div class="jobs-tools">
        <button class="btn primary" type="button" id="backup-dl">Download backup (JSON)</button>
        <label class="btn" style="display:inline-block">Restore backup<input type="file" id="backup-file" accept=".json,application/json" hidden /></label>
      </div>
    </div>
    <div class="panel section">
      <div class="panel-head"><div><h2>Data</h2><p>${state.raw.length} trades stored (${state.raw.filter((t) => t.sample).length} sample)</p></div></div>
      <div class="jobs-tools">
        <button class="btn primary" type="button" data-open-import>Import CSV</button>
        <button class="btn" type="button" data-load-sample>Load sample data</button>
        <button class="btn" type="button" data-clear-sample>Clear sample</button>
        <button class="btn danger" type="button" id="clear-all">Delete all trades</button>
      </div>
      <div class="infobox">${esc(sources.drive.note)} It will read <i>mt5-trades.csv</i> from the Drive folder <i>Trade Ledger (auto)</i>.</div>
    </div>`;

  $("#rules-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = (id) => Number($(id).value);
    const vals = { maxRiskPerTrade: n("#s-maxRisk"), dailyLossStop: n("#s-dailyStop"), weeklyLossLimit: n("#s-weeklyLimit"), maxTradesPerDay: n("#s-maxTrades"), rrTarget: n("#s-rr"), serverOffsetH: n("#s-offset") };
    const bad = Object.entries(vals).find(([k, v]) => !Number.isFinite(v) || (k !== "serverOffsetH" && v <= 0));
    if (bad) { toast("Check the numbers: all must be above 0."); return; }
    if (vals.maxTradesPerDay > MAX_TRADES_CAP) { toast(`Max trades per day is capped at ${MAX_TRADES_CAP}.`); vals.maxTradesPerDay = MAX_TRADES_CAP; }
    if (vals.serverOffsetH < -12 || vals.serverOffsetH > 14) { toast("Server offset must be between -12 and +14."); return; }
    await saveSettings({ ...state.settings, ...vals });
    toast("Settings saved");
  });
  $("#cv-save").addEventListener("click", async () => {
    const cv = {};
    for (const inp of $$("[data-cv]")) if (inp.value !== "" && Number(inp.value) >= 0) cv[inp.dataset.cv] = Number(inp.value);
    await saveSettings({ ...state.settings, contractValues: cv });
    toast("Contract values saved");
  });
  $("#cv-add").addEventListener("click", async () => {
    const sym = $("#cv-new-sym").value.trim().toUpperCase();
    const v = Number($("#cv-new-val").value);
    if (!/^[A-Z0-9._-]{2,20}$/.test(sym) || !(v > 0)) { toast("Enter a symbol and a value above 0."); return; }
    await saveSettings({ ...state.settings, contractValues: { ...state.settings.contractValues, [sym]: v } });
    toast(`${sym} added`);
  });
  for (const b of $$("[data-cv-del]")) b.addEventListener("click", async () => {
    const cv = { ...state.settings.contractValues };
    delete cv[b.dataset.cvDel];
    await saveSettings({ ...state.settings, contractValues: cv });
  });
  $("#cv-reset").addEventListener("click", async () => {
    if (!confirm("Reset contract values to the defaults?")) return;
    await saveSettings({ ...state.settings, contractValues: { ...DEFAULT_CONTRACT_VALUES } });
  });
  $("#backup-dl").addEventListener("click", downloadBackup);
  $("#backup-file").addEventListener("change", (e) => e.target.files[0] && restoreBackup(e.target.files[0]));
  $("#clear-all").addEventListener("click", async () => {
    if (!confirm("Delete all stored trades from this browser? Journal notes and settings stay. Re-import the CSV to get trades back.")) return;
    await db.clear("trades");
    await refresh();
    toast("All trades deleted");
  });
}

async function saveSettings(next) {
  await db.setMeta("settings", withDefaults(next));
  await refresh();
}

/* ---------- Backup / restore ---------- */
async function downloadBackup() {
  const data = {
    app: "trade-ledger",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    journal: [...state.journal.values()],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trade-ledger-backup-${bne(Date.now()).date}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Backup downloaded");
}

async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("That file isn't valid JSON."); return; }
  if (data?.app !== "trade-ledger" || !Array.isArray(data.journal) || typeof data.settings !== "object") {
    toast("Not a Trade Ledger backup."); return;
  }
  if (!confirm(`Restore settings and ${data.journal.length} journal entries? Current settings are replaced; journal entries with the same ticket are overwritten.`)) return;
  const entries = data.journal.filter((j) => j && typeof j.ticket === "string").map((j) => ({
    ticket: j.ticket, tag: String(j.tag ?? "").slice(0, 40), note: String(j.note ?? "").slice(0, 2000), updatedAt: j.updatedAt ?? new Date().toISOString(),
  }));
  await db.putMany("journal", entries);
  await saveSettings(data.settings);
  toast(`Restored ${entries.length} journal entries + settings`);
}

/* ---------- Import / sample ---------- */
async function doImport() {
  const out = $("#import-result");
  const file = $("#import-file").files[0];
  const text = $("#import-paste").value;
  if (!file && !text.trim()) { out.textContent = "Choose a CSV file or paste CSV text."; return; }
  try {
    const r = file ? await importFrom("file", file) : await importFrom("paste", text);
    const lines = [`${r.total} trade${r.total === 1 ? "" : "s"} read: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged.`];
    if (r.errors.length) lines.push(`${r.errors.length} row(s) skipped:`, ...r.errors.slice(0, 10).map((e) => `  line ${e.line}: ${e.message}`));
    for (const w of r.warnings) lines.push(`Note: ${w}`);
    out.textContent = lines.join("\n");
    $("#import-file").value = "";
    if (r.total) { $("#import-paste").value = ""; await refresh(); toast(`Imported ${r.added + r.updated} change(s)`); }
  } catch (e) {
    out.textContent = `Import failed: ${e.message}`;
  }
}

async function loadSample() {
  const trades = sampleTrades(Date.now(), state.settings.serverOffsetH);
  await db.upsertTrades(trades, { sample: true, source: "sample" });
  await refresh();
  toast("Sample data loaded (fake trades)");
}

async function clearSample() {
  const sample = state.raw.filter((t) => t.sample).map((t) => t.ticket);
  await db.delMany("trades", sample);
  await db.delMany("journal", [...state.journal.keys()].filter((k) => k.startsWith("EXAMPLE-")));
  await refresh();
  toast("Sample cleared");
}

/* ---------- wiring ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-ticket]");
  if (!t) return;
  if (t.dataset.view) go(t.dataset.view);
  else if (t.dataset.go) go(t.dataset.go);
  else if (t.hasAttribute("data-open-import")) { $("#import-result").textContent = ""; $("#dlg-import").showModal(); }
  else if (t.hasAttribute("data-load-sample")) loadSample();
  else if (t.hasAttribute("data-clear-sample")) clearSample();
  else if (t.hasAttribute("data-close")) t.closest("dialog").close();
  else if (t.dataset.ticket && !t.closest("dialog")) openTrade(t.dataset.ticket);
});
$("#import-go").addEventListener("click", doImport);
$("#dlg-trade").addEventListener("close", () => { if (["journal", "log", "today", "rules"].includes(state.view)) render(); });

refresh().catch((e) => { console.error(e); toast("Couldn't open local storage: " + e.message); });

// For tests / console: pure CSV import without the dialog.
window.tradeLedger = { importCsvText: async (t) => { const r = await importCsvText(t); await refresh(); return r; } };
