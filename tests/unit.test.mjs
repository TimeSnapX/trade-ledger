// Unit tests: CSV parser + maths. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTradesCsv, parseTime, parseNum, parseSide, splitRows, tradesToCsv } from "../js/csv.js";
import { applyRules, bne, enrich, stats, todaySummary, toUtcMs, tradeRisk, weekStart, withDefaults, contractValue } from "../js/calc.js";
import { sampleTrades } from "../js/sample.js";

const fixture = readFileSync(new URL("./fixtures/trades.csv", import.meta.url), "utf8");
const S = withDefaults();
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0); // Wed 2026-10-07 20:00 Brisbane
const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("parseTime: MT5 dotted, ISO, slashes, zones, blanks", () => {
  assert.equal(parseTime("2026.10.05 11:00:00"), "2026-10-05T11:00:00");
  assert.equal(parseTime("2026.10.05 11:00"), "2026-10-05T11:00:00");
  assert.equal(parseTime("2026-10-05T11:00:00"), "2026-10-05T11:00:00");
  assert.equal(parseTime("2026-10-05T11:00:00.123Z"), "2026-10-05T11:00:00Z");
  assert.equal(parseTime("2026-10-05 11:00:00+0300"), "2026-10-05T11:00:00+03:00");
  assert.equal(parseTime("2026/1/5 9:05"), "2026-01-05T09:05:00");
  assert.equal(parseTime("2026.10.05"), "2026-10-05T00:00:00");
  assert.equal(parseTime("  "), null);
  assert.throws(() => parseTime("yesterday"));
  assert.throws(() => parseTime("2026.13.01 00:00"));
});

test("parseNum / parseSide", () => {
  assert.equal(parseNum(""), null);
  assert.equal(parseNum(" -12.5 "), -12.5);
  assert.equal(parseNum("1,234.50"), 1234.5);
  assert.equal(parseNum("(3.20)"), -3.2);
  assert.equal(parseNum("\u22125"), -5);
  assert.throws(() => parseNum("abc"));
  assert.equal(parseSide("BUY"), "buy");
  assert.equal(parseSide(" Sell "), "sell");
  assert.throws(() => parseSide("long"));
});

test("splitRows handles quotes, embedded commas/newlines, CRLF", () => {
  const rows = splitRows('a,b\r\n1,"x, ""y""\nz"\r\n\r\n2,3');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].fields, ["1", 'x, "y"\nz']);
  assert.deepEqual(rows[2].fields, ["2", "3"]);
});

test("parseTradesCsv on fixture", () => {
  const { trades, errors, warnings } = parseTradesCsv(fixture);
  assert.equal(trades.length, 12);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /side must be buy or sell/);
  assert.equal(errors[0].line, 15);
  assert.equal(warnings.length, 0);
  const by = Object.fromEntries(trades.map((t) => [t.ticket, t]));
  assert.equal(by["5002"].side, "sell");
  assert.equal(by["5002"].note, "oversized, TP too close");
  assert.equal(by["5005"].symbol, "XAUUSD");
  assert.equal(by["5003"].open_time, "2026-10-06T10:30:00");
  assert.equal(by["5004"].sl, null);
  assert.equal(by["5009"].sl, null, "SL 0 means none");
  assert.equal(by["5008"].open, true);
  assert.equal(by["5008"].close_time, null);
  assert.equal(by["5001"].open, false);
  assert.equal(by["5001"].tag, "planned setup");
});

test("parseTradesCsv: BOM, reordered/case header, semicolons, missing optional cols, duplicates", () => {
  const txt = "\uFEFFSymbol;Ticket;Side;Lots;Entry;Open_Time\nEURUSD;1;buy;0.1;1.1;2026.10.05 10:00:00\nEURUSD;1;sell;0.2;1.2;2026.10.05 11:00:00\n";
  const r = parseTradesCsv(txt);
  assert.equal(r.errors.length, 0);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, "sell");
  assert.equal(r.trades[0].open, true);
  assert.ok(r.warnings.some((w) => /appears twice/.test(w)));
  assert.ok(r.warnings.some((w) => /not in file/.test(w)));
  const bad = parseTradesCsv("ticket,symbol\n1,EURUSD");
  assert.equal(bad.trades.length, 0);
  assert.match(bad.errors[0].message, /missing: open_time, side, lots, entry/);
  assert.equal(parseTradesCsv("").errors.length, 1);
});

test("close_time without exit (or vice versa) = open", () => {
  const r = parseTradesCsv("ticket,open_time,close_time,symbol,side,lots,entry,exit\n1,2026.10.05 10:00,2026.10.05 11:00,EURUSD,buy,1,1.1,\n");
  assert.equal(r.trades[0].open, true);
});

test("CSV round trip", () => {
  const { trades } = parseTradesCsv(fixture);
  const again = parseTradesCsv(tradesToCsv(trades));
  assert.deepEqual(again.trades, trades);
});

test("time zones: server UTC+3 -> Brisbane UTC+10, explicit zones honoured", () => {
  assert.equal(bne(toUtcMs("2026-10-05T11:00:00", 3)).label, "2026-10-05 18:00");
  assert.equal(bne(toUtcMs("2026-10-05T11:00:00", 2)).label, "2026-10-05 19:00");
  assert.equal(bne(toUtcMs("2026-10-04T17:00:00", 3)).label, "2026-10-05 00:00");
  assert.equal(bne(toUtcMs("2026-10-05T11:00:00Z", 3)).label, "2026-10-05 21:00");
  assert.equal(bne(toUtcMs("2026-10-05T11:00:00+10:00", 3)).label, "2026-10-05 11:00");
  assert.equal(weekStart(NOW), "2026-10-05");
  assert.equal(weekStart(toUtcMs("2026-10-04T16:59:00", 3)), "2026-09-28"); // Sun 23:59 BNE
});

test("risk, R:R, contract values", () => {
  near(tradeRisk({ symbol: "EURUSD", side: "buy", entry: 1.085, sl: 1.083, tp: 1.089, lots: 0.05 }, S).risk, 15.4);
  const x = tradeRisk({ symbol: "XAUUSD", side: "sell", entry: 2400, sl: 2410, tp: 2395, lots: 0.1 }, S);
  near(x.risk, 154); near(x.rr, 0.5);
  near(tradeRisk({ symbol: "USDJPY", side: "buy", entry: 150, sl: 149.5, lots: 0.1 }, S).risk, 52.05);
  assert.equal(tradeRisk({ symbol: "EURUSD", side: "buy", entry: 1.1, sl: null, lots: 1 }, S).noSl, true);
  assert.equal(tradeRisk({ symbol: "EURUSD", side: "buy", entry: 1.1, sl: 1.12, lots: 1 }, S).risk, 0, "SL trailed past entry");
  assert.equal(contractValue("EURUSD.a", S.contractValues), 154000);
  assert.equal(contractValue("XAUUSD-ECN", S.contractValues), 154);
  assert.equal(contractValue("BTCUSD", S.contractValues), null);
  assert.equal(tradeRisk({ symbol: "BTCUSD", side: "buy", entry: 1, sl: 0.5, lots: 1 }, S).unknownSymbol, true);
  assert.equal(withDefaults({ maxTradesPerDay: 50 }).maxTradesPerDay, 20);
});

function fixtureTrades(settings = S) {
  return applyRules(enrich(parseTradesCsv(fixture).trades, settings), settings);
}

test("stats match hand-computed values", () => {
  const st = stats(fixtureTrades());
  assert.equal(st.n, 10);
  assert.equal(st.wins, 4);
  assert.equal(st.losses, 6);
  near(st.winRate, 0.4);
  near(st.avgWin, 27.73);
  near(st.avgLoss, 45.54);
  near(st.profitFactor, 110.93 / 273.24, 1e-9);
  near(st.expectancy, -16.23);
  near(st.total, -162.31);
  near(st.maxDrawdown, 230.56);
  assert.deepEqual(st.curve, [0, 45.5, 68.25, -55.65, -109.9, -106.96, -67.22, -98.72, -117.34, -140.79, -162.31]);
  assert.equal(st.bestSymbol.key, "AUDUSD"); near(st.bestSymbol.net, 45.5);
  assert.equal(st.worstSymbol.key, "XAUUSD"); near(st.worstSymbol.net, -196.77);
  assert.equal(st.bestHour.key, 18); near(st.bestHour.net, 46.73);
  assert.equal(st.worstHour.key, 21); near(st.worstHour.net, -123.9);
});

test("stats edge cases: none / all wins", () => {
  const e = stats([]);
  assert.equal(e.winRate, null); assert.equal(e.profitFactor, null); assert.equal(e.maxDrawdown, 0);
  const w = stats(fixtureTrades().filter((t) => t.ticket === "5001"));
  assert.equal(w.profitFactor, Infinity);
});

test("rule breaches per trade (defaults)", () => {
  const by = Object.fromEntries(fixtureTrades().map((t) => [t.ticket, t.breaches]));
  assert.deepEqual(by["5000"], []);
  assert.deepEqual(by["5001"], []);
  assert.deepEqual(by["5002"], ["overRisk", "lowRR"]);
  assert.deepEqual(by["5010"], []);
  assert.deepEqual(by["5011"], ["afterDailyStop"]);
  assert.deepEqual(by["5003"], []);
  assert.deepEqual(by["5004"], ["noSl"]);
  assert.deepEqual(by["5005"], []);
  assert.deepEqual(by["5006"], ["lowRR"]);
  assert.deepEqual(by["5007"], []);
  assert.deepEqual(by["5008"], []);
  assert.deepEqual(by["5009"], ["noSl"]);
});

test("rules respond to edited settings", () => {
  const s = withDefaults({ maxTradesPerDay: 3, weeklyLossLimit: 200, maxRiskPerTrade: 50 });
  const by = Object.fromEntries(fixtureTrades(s).map((t) => [t.ticket, t.breaches]));
  assert.deepEqual(by["5011"], ["overTrades", "afterDailyStop"]);
  assert.deepEqual(by["5003"], ["overRisk"]); // 52.05 > 50
  // Week realised before 5008 opens (Wed 19:00): -207.81 <= -200
  assert.ok(by["5008"].includes("afterWeeklyLimit"));
  assert.ok(by["5008"].includes("overTrades")); // 4th trade Wed
  assert.ok(!by["5007"].includes("afterWeeklyLimit")); // -186.29 before it
});

test("today summary at Wed 20:00 Brisbane", () => {
  const sum = todaySummary(fixtureTrades(), S, NOW);
  assert.equal(sum.today, "2026-10-07");
  near(sum.dayNet, -63.59);
  near(sum.weekNet, -207.81);
  near(sum.openRisk, 77);
  assert.equal(sum.openNoSl, 1);
  assert.equal(sum.todayCount, 5);
  assert.equal(sum.weekBreaches, 6);
  assert.equal(sum.status, "red");
  const green = todaySummary(fixtureTrades().filter((t) => ["5000", "5001"].includes(t.ticket)), S, NOW);
  assert.equal(green.status, "green");
  const amber = todaySummary(fixtureTrades().filter((t) => !["5009", "5006"].includes(t.ticket) && t.ticket !== "5099"), withDefaults({ maxTradesPerDay: 3 }), NOW);
  assert.deepEqual(amber.reasons, ["Max trades reached (3/3). No more today."]);
  assert.equal(amber.status, "amber");
});

test("sample trades are obviously fake and parse cleanly", () => {
  const tr = sampleTrades(NOW, 3);
  assert.ok(tr.length >= 10);
  assert.ok(tr.every((t) => t.ticket.startsWith("EXAMPLE-") && /EXAMPLE/.test(t.note)));
  const back = parseTradesCsv(tradesToCsv(tr));
  assert.equal(back.errors.length, 0);
  assert.equal(back.trades.length, tr.length);
  const en = applyRules(enrich(tr, S), S);
  assert.ok(en.every((t) => t.openMs <= NOW));
  assert.equal(en.filter((t) => t.open).length, 2);
});
