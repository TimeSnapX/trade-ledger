// Pure maths: time zones, P&L, risk, rules, stats. No DOM, runs in Node tests.

export const BNE_OFFSET_H = 10; // Brisbane, UTC+10, no daylight saving

// AUD value of a 1.00 price move for 1.00 lot. Approximate defaults assuming
// 1 USD = 1.54 AUD, USDJPY 148, USDCAD 1.37, USDCHF 0.80, 1 EUR = 1.75 AUD.
// Check each against MT5 (symbol > Specification) and your live rate, then edit.
export const DEFAULT_CONTRACT_VALUES = {
  EURUSD: 154000, GBPUSD: 154000, AUDUSD: 154000, NZDUSD: 154000,
  USDJPY: 1041, USDCAD: 112400, USDCHF: 192500,
  XAUUSD: 154, // 100 oz per lot
  US500: 1.54, US30: 1.54, USTEC: 1.54, // 1 contract per lot, USD 1 per point
  AUS200: 1, // AUD 1 per point
  DE40: 1.75, // EUR 1 per point
};

export const DEFAULT_SETTINGS = {
  maxRiskPerTrade: 100,
  dailyLossStop: 150,
  weeklyLossLimit: 500,
  maxTradesPerDay: 5,
  rrTarget: 2,
  serverOffsetH: 3,
  contractValues: { ...DEFAULT_CONTRACT_VALUES },
};
export const MAX_TRADES_CAP = 20;

export function withDefaults(s = {}) {
  const out = { ...DEFAULT_SETTINGS, ...s };
  out.contractValues = { ...(s.contractValues ?? DEFAULT_CONTRACT_VALUES) };
  out.maxTradesPerDay = Math.min(MAX_TRADES_CAP, Math.max(1, Math.round(out.maxTradesPerDay)));
  return out;
}

/** Canonical time string (server time unless it carries Z/offset) -> UTC epoch ms. */
export function toUtcMs(t, serverOffsetH = 3) {
  if (!t) return null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(t)) return Date.parse(t);
  const [d, tm] = t.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = (tm || "0:0:0").split(":").map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, s) - serverOffsetH * 3600e3;
}

/** Brisbane wall-clock parts for a UTC ms. */
export function bne(ms) {
  const d = new Date(ms + BNE_OFFSET_H * 3600e3);
  const p = (v) => String(v).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return {
    date,
    hour: d.getUTCHours(),
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    weekday: (d.getUTCDay() + 6) % 7, // 0 = Monday
    label: `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

/** Monday (Brisbane date string) of the week containing ms. */
export function weekStart(ms) {
  const b = bne(ms);
  return bne(ms - b.weekday * 86400e3).date;
}

export const net = (t) => (t.profit ?? 0) + (t.commission ?? 0) + (t.swap ?? 0);

export function contractValue(symbol, cv) {
  const s = String(symbol).toUpperCase();
  if (cv[s] != null) return cv[s];
  const base = s.replace(/[^A-Z0-9].*$/, ""); // EURUSD.a, XAUUSD-ECN
  if (cv[base] != null) return cv[base];
  const key = Object.keys(cv).filter((k) => s.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? cv[key] : null;
}

/**
 * Planned risk in AUD from entry to SL. {risk, noSl, unknownSymbol, rr}
 * SL already on the profit side (trailed past entry) = 0 risk.
 */
export function tradeRisk(t, settings) {
  const cv = contractValue(t.symbol, settings.contractValues);
  const res = { risk: null, noSl: !t.sl, unknownSymbol: cv == null, rr: null, cv };
  if (t.sl) {
    const dist = t.side === "buy" ? t.entry - t.sl : t.sl - t.entry;
    const d = Math.max(0, dist);
    if (cv != null) res.risk = round2(d * t.lots * cv);
    if (t.tp && d > 0) {
      const reward = t.side === "buy" ? t.tp - t.entry : t.entry - t.tp;
      res.rr = Math.round((reward / d) * 1e6) / 1e6; // 1.0000000001 noise
    }
  }
  return res;
}

export const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Enrich trades with UTC times, Brisbane labels, net, risk. Sorted by open time. */
export function enrich(trades, settings) {
  return trades
    .map((t) => {
      const openMs = toUtcMs(t.open_time, settings.serverOffsetH);
      const closeMs = t.close_time ? toUtcMs(t.close_time, settings.serverOffsetH) : null;
      return {
        ...t,
        openMs,
        closeMs,
        openB: bne(openMs),
        closeB: closeMs != null ? bne(closeMs) : null,
        net: t.open ? null : round2(net(t)),
        ...riskFields(tradeRisk(t, settings)),
      };
    })
    .sort((a, b) => a.openMs - b.openMs || String(a.ticket).localeCompare(String(b.ticket)));
}
const riskFields = (r) => ({ risk: r.risk, noSl: r.noSl, unknownSymbol: r.unknownSymbol, rr: r.rr });

export const RULE_LABELS = {
  noSl: "No stop loss",
  overRisk: "Risk over max per trade",
  lowRR: "TP under 1:1 R:R",
  overTrades: "Over max trades per day",
  afterDailyStop: "Opened after daily loss stop",
  afterWeeklyLimit: "Opened after weekly loss limit",
};

/**
 * Attach breaches to each enriched trade. Day = Brisbane calendar day, week = Mon-Sun Brisbane.
 * Realised P&L counts trades closed before this trade opened, within the same day/week.
 */
export function applyRules(trades, s) {
  const closed = trades.filter((t) => !t.open);
  const countByDay = {};
  for (const t of trades) {
    const day = t.openB.date;
    countByDay[day] = (countByDay[day] ?? 0) + 1;
    const nth = countByDay[day];
    const wk = weekStart(t.openMs);
    let dayReal = 0;
    let weekReal = 0;
    for (const c of closed) {
      if (c.closeMs > t.openMs || c === t) continue; // closed at or before this open
      if (c.closeB.date === day) dayReal += c.net;
      if (weekStart(c.closeMs) === wk) weekReal += c.net;
    }
    const b = [];
    if (t.noSl) b.push("noSl");
    if (t.risk != null && t.risk > s.maxRiskPerTrade + 0.005) b.push("overRisk");
    if (t.rr != null && t.rr < 1) b.push("lowRR");
    if (nth > s.maxTradesPerDay) b.push("overTrades");
    if (dayReal <= -s.dailyLossStop) b.push("afterDailyStop");
    if (weekReal <= -s.weeklyLossLimit) b.push("afterWeeklyLimit");
    t.breaches = b;
    t.dayIndex = nth;
    t.belowTarget = t.rr != null && t.rr >= 1 && t.rr < s.rrTarget;
  }
  return trades;
}

/** Day and week realised net (by close time) plus open risk, as at nowMs. */
export function todaySummary(trades, s, nowMs) {
  const today = bne(nowMs).date;
  const wk = weekStart(nowMs);
  const closed = trades.filter((t) => !t.open);
  const dayNet = round2(closed.filter((t) => t.closeB.date === today).reduce((a, t) => a + t.net, 0));
  const weekNet = round2(closed.filter((t) => weekStart(t.closeMs) === wk).reduce((a, t) => a + t.net, 0));
  const open = trades.filter((t) => t.open);
  const openRisk = round2(open.reduce((a, t) => a + (t.risk ?? 0), 0));
  const openNoSl = open.filter((t) => t.noSl).length;
  const openUnknown = open.filter((t) => !t.noSl && t.unknownSymbol).length;
  const todayTrades = trades.filter((t) => t.openB.date === today);
  const weekTrades = trades.filter((t) => weekStart(t.openMs) === wk);
  const weekBreaches = weekTrades.reduce((a, t) => a + t.breaches.length, 0);
  const todayBreaches = todayTrades.reduce((a, t) => a + t.breaches.length, 0);

  const red = [];
  const amber = [];
  if (dayNet <= -s.dailyLossStop) red.push(`Daily loss stop hit (${fmtAud(dayNet)} of -${fmtAud(s.dailyLossStop)}). Done for today.`);
  else if (dayNet <= -0.75 * s.dailyLossStop) amber.push(`Near daily loss stop (${fmtAud(dayNet)} of -${fmtAud(s.dailyLossStop)}).`);
  if (weekNet <= -s.weeklyLossLimit) red.push(`Weekly loss limit hit (${fmtAud(weekNet)} of -${fmtAud(s.weeklyLossLimit)}). Done for the week.`);
  else if (weekNet <= -0.75 * s.weeklyLossLimit) amber.push(`Near weekly loss limit (${fmtAud(weekNet)} of -${fmtAud(s.weeklyLossLimit)}).`);
  if (todayTrades.length > s.maxTradesPerDay) red.push(`${todayTrades.length} trades today, max is ${s.maxTradesPerDay}.`);
  else if (todayTrades.length === s.maxTradesPerDay) amber.push(`Max trades reached (${todayTrades.length}/${s.maxTradesPerDay}). No more today.`);
  if (openNoSl) red.push(`${openNoSl} open position${openNoSl > 1 ? "s" : ""} with no SL.`);
  if (todayBreaches) red.push(`${todayBreaches} rule breach${todayBreaches > 1 ? "es" : ""} on today's trades.`);
  const room = s.dailyLossStop + Math.min(0, dayNet);
  if (!openNoSl && openRisk > 0 && openRisk > room + 0.005 && dayNet > -s.dailyLossStop) {
    amber.push(`Open risk ${fmtAud(openRisk)} is more than what's left before the daily stop (${fmtAud(room)}).`);
  }
  const status = red.length ? "red" : amber.length ? "amber" : "green";
  return {
    today, weekStart: wk, dayNet, weekNet, open, openRisk, openNoSl, openUnknown,
    todayCount: todayTrades.length, weekBreaches, todayBreaches, status, reasons: [...red, ...amber],
  };
}

/** Stats over closed trades (ordered by close time for the equity curve). */
export function stats(trades) {
  const closed = trades.filter((t) => !t.open).sort((a, b) => a.closeMs - b.closeMs);
  const n = closed.length;
  const wins = closed.filter((t) => t.net > 0);
  const losses = closed.filter((t) => t.net < 0);
  const grossWin = wins.reduce((a, t) => a + t.net, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.net, 0);
  const total = closed.reduce((a, t) => a + t.net, 0);
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  const curve = [0];
  for (const t of closed) {
    eq += t.net;
    curve.push(round2(eq));
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const group = (keyFn) => {
    const m = {};
    for (const t of closed) {
      const k = keyFn(t);
      m[k] = m[k] ?? { key: k, net: 0, count: 0 };
      m[k].net += t.net;
      m[k].count++;
    }
    const arr = Object.values(m).map((g) => ({ ...g, net: round2(g.net) }));
    arr.sort((a, b) => b.net - a.net);
    return arr;
  };
  const bySymbol = group((t) => t.symbol);
  const byHour = group((t) => t.openB.hour);
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : null,
    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancy: n ? round2(total / n) : null,
    total: round2(total),
    maxDrawdown: round2(maxDd),
    curve,
    bySymbol,
    byHour,
    bestSymbol: bySymbol[0] ?? null,
    worstSymbol: bySymbol.length ? bySymbol[bySymbol.length - 1] : null,
    bestHour: byHour[0] ?? null,
    worstHour: byHour.length ? byHour[byHour.length - 1] : null,
  };
}

export function fmtAud(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? "-$" : "$") + s;
}
