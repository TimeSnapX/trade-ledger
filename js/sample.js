// Obviously fake EXAMPLE trades, generated relative to today so every screen has something to show.
// Tickets start with "EXAMPLE-" and every note says so. Stored with sample: true.
import { DEFAULT_SETTINGS } from "./calc.js?v=1";

export function sampleTrades(nowMs = Date.now(), serverOffsetH = DEFAULT_SETTINGS.serverOffsetH) {
  // Build times in Brisbane, write them in broker server time like MT5 does.
  const bneMidnight = Math.floor((nowMs + 10 * 3600e3) / 86400e3) * 86400e3 - 10 * 3600e3;
  // Past days use Brisbane clock times; day 0 rows use "hours, minutes ago" so they are never in the future.
  const at = (day, h, m) => (day < 0 ? bneMidnight + day * 86400e3 + (h * 60 + m) * 60e3 : nowMs - (h * 60 + m) * 60e3);
  const srv = (ms) => {
    const d = new Date(Math.floor(ms / 60e3) * 60e3 + serverOffsetH * 3600e3);
    const p = (v) => String(v).padStart(2, "0");
    return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
  };
  // [day, openH, openM, durMin, symbol, side, lots, entry, exit, sl, tp, profit, tag]
  const rows = [
    [-9, 18, 5, 95, "EURUSD", "buy", 0.05, 1.0850, 1.0874, 1.0838, 1.0880, 18.48, "planned setup"],
    [-9, 22, 30, 40, "XAUUSD", "sell", 0.02, 2400.0, 2405.5, 2406.0, 2388.0, -16.94, ""],
    [-8, 19, 10, 120, "GBPUSD", "buy", 0.05, 1.2700, 1.2734, 1.2685, 1.2740, 26.18, "planned setup"],
    [-7, 23, 45, 15, "US500", "buy", 1, 5200, 5190, 5185, 5260, -15.4, "news"],
    [-6, 18, 0, 60, "EURUSD", "sell", 0.1, 1.0900, 1.0912, 1.0910, 1.0880, -18.48, ""],
    [-6, 19, 20, 20, "EURUSD", "sell", 0.2, 1.0915, 1.0921, 1.0925, 1.0900, -18.48, "revenge"],
    [-5, 17, 30, 180, "AUDUSD", "buy", 0.1, 0.6600, 0.6625, 0.6588, 0.6630, 38.5, "planned setup"],
    [-2, 18, 15, 90, "XAUUSD", "buy", 0.01, 2410.0, 2422.0, 2404.0, 2425.0, 18.48, "planned setup"],
    [-1, 20, 0, 45, "USDJPY", "sell", 0.1, 150.00, 150.20, 150.25, 149.60, -20.82, ""],
    [0, 2, 30, 30, "EURUSD", "buy", 0.05, 1.0800, 1.0815, 1.0788, 1.0830, 11.55, "planned setup"],
    [0, 1, 0, null, "XAUUSD", "buy", 0.02, 2415.0, null, 2409.0, 2427.0, null, ""],
    [0, 0, 20, null, "GBPUSD", "sell", 0.03, 1.2750, null, null, 1.2720, null, ""],
  ];
  return rows
    .map(([day, h, m, dur, symbol, side, lots, entry, exit, sl, tp, profit, tag], i) => {
      const openMs = at(day, h, m);
      const openStr = srv(openMs);
      const closed = dur != null;
      return {
        ticket: `EXAMPLE-${1001 + i}`,
        open_time: openStr.replace(/^(\d{4})\.(\d{2})\.(\d{2}) /, "$1-$2-$3T"),
        close_time: closed ? srv(openMs + dur * 60e3).replace(/^(\d{4})\.(\d{2})\.(\d{2}) /, "$1-$2-$3T") : null,
        symbol, side, lots, entry,
        exit: closed ? exit : null,
        sl, tp,
        commission: closed ? -Math.round(lots * 7 * 100) / 100 : null,
        swap: closed ? 0 : null,
        profit,
        tag,
        note: "EXAMPLE, fake trade for demo only",
        open: !closed,
      };
    });
}
