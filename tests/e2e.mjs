// Headless Chrome e2e at 390x844 (phone) + one desktop pass.
// Serve the repo so the app is at /trade-ledger/, then:
//   TL_SHOTS=<dir, default test-results> BASE=http://127.0.0.1:4180/trade-ledger/ PLAYWRIGHT_DIR=/workspace/tools CHROME=/usr/bin/google-chrome node tests/e2e.mjs
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || here, "package.json"));
let pw;
try { pw = req("playwright-core"); } catch { pw = req("playwright"); }
const BASE = process.env.BASE || "http://127.0.0.1:4180/trade-ledger/";
const SHOTS = process.env.TL_SHOTS || path.join(here, "..", "test-results");
await mkdir(SHOTS, { recursive: true });
const FIXTURE = path.join(here, "fixtures", "trades.csv");
const NOW = new Date(Date.UTC(2026, 9, 7, 10, 0, 0)); // Wed 2026-10-07 20:00 Brisbane

const browser = await pw.chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const errors = [];
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message.split("\n").slice(0, 4).join("\n       ")); process.exitCode = 1; }
};

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE);
  await page.waitForSelector("#view-today .empty, #view-today .stats");
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true });
const text = (page, sel) => page.locator(sel).first().innerText();
const nav = (page, label) => page.locator(".bottom-nav .tab", { hasText: label }).click();

const { page } = await newPage({ width: 390, height: 844 });
console.log("Phone 390x844");

await check("empty state shows Import CSV + Load sample data", async () => {
  await page.getByRole("button", { name: "Load sample data" }).waitFor();
  assert.equal(await page.locator("#sample-banner").isHidden(), true);
  await shot(page, "01-empty");
});

await check("sample data: banner, open positions, no-SL warning, EXAMPLE badges", async () => {
  await page.getByRole("button", { name: "Load sample data" }).click();
  await page.locator("#sample-banner").waitFor({ state: "visible" });
  assert.match(await text(page, "#sample-banner"), /Sample data, not real trades/);
  assert.equal(await page.locator("#open-list .row").count(), 2);
  await page.locator('[data-k="no-sl-warning"]').waitFor();
  assert.ok((await page.locator(".badge.ex").count()) >= 2);
  await shot(page, "02-sample-today");
  for (const v of ["Trade log", "Stats", "Journal", "Rules"]) { await nav(page, v); await page.waitForTimeout(50); }
  await nav(page, "Stats");
  assert.match(await text(page, '[data-k="win-rate"]'), /%/);
  await shot(page, "03-sample-stats");
});

await check("Clear sample removes all sample trades and the banner", async () => {
  await page.locator("#sample-banner").getByRole("button", { name: "Clear sample" }).click();
  await page.locator("#sample-banner").waitFor({ state: "hidden" });
  await nav(page, "Today");
  await page.locator("#view-today .empty").waitFor();
});

await check("Import CSV (file): 12 read, 1 bad row reported", async () => {
  await page.locator(".top-actions").getByRole("button", { name: "Import CSV" }).click();
  assert.match(await text(page, "#drive-note"), /Drive auto-load coming once statements start/);
  assert.equal(await page.getByRole("button", { name: "Load from Drive" }).isDisabled(), true);
  await page.setInputFiles("#import-file", FIXTURE);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.locator("#import-result", { hasText: "added" }).waitFor();
  const r = await text(page, "#import-result");
  assert.match(r, /12 trades read: 12 added, 0 updated, 0 unchanged\./);
  assert.match(r, /1 row\(s\) skipped/);
  assert.match(r, /line 15: side must be buy or sell, got "long"/);
  await shot(page, "04-import");
  await page.locator("#dlg-import").getByRole("button", { name: "Close" }).click();
});

await check("Today: day/week net, open risk, status, no-SL warning (Wed 20:00 AEST)", async () => {
  await nav(page, "Today");
  assert.match(await text(page, '[data-k="day-net"]'), /-\$63\.59/);
  assert.match(await text(page, '[data-k="week-net"]'), /-\$207\.81/);
  assert.match(await text(page, '[data-k="open-risk"]'), /\$77\.00/);
  assert.match(await text(page, '[data-k="status"]'), /RED/);
  assert.match(await text(page, '[data-k="no-sl-warning"]'), /1 open position has no stop loss/);
  assert.equal(await page.locator("#open-list .row").count(), 2);
  await shot(page, "05-today");
});

await check("Trade log filters: symbol, date range, tag", async () => {
  await nav(page, "Trade log");
  const count = () => page.locator("#log-list .row").count();
  assert.equal(await count(), 12);
  await page.selectOption("#f-symbol", "EURUSD");
  assert.equal(await count(), 5);
  await page.click("#f-reset");
  await page.fill("#f-from", "2026-10-06");
  await page.fill("#f-to", "2026-10-06");
  assert.equal(await count(), 2);
  assert.match(await text(page, "#log-summary"), /2 trades · closed net \$8\.24/);
  await page.click("#f-reset");
  await page.selectOption("#f-tag", "planned setup");
  assert.equal(await count(), 2);
  await page.selectOption("#f-tag", "__none");
  assert.equal(await count(), 9);
  await page.click("#f-reset");
  await shot(page, "06-log");
});

await check("Trade detail shows breaches, Brisbane + server time, risk, R:R", async () => {
  await page.locator('#log-list [data-ticket="5002"]').click();
  const b = await text(page, "#trade-body");
  assert.match(b, /Risk over max per trade/);
  assert.match(b, /TP under 1:1 R:R/);
  assert.match(b, /2026-10-05 21:00/); // Brisbane
  assert.match(b, /2026-10-05 14:00:00/); // server
  assert.match(b, /\$154\.00/);
  assert.match(b, /0\.50 : 1/);
  assert.match(b, /-\$123\.90/);
  await shot(page, "07-detail");
  await page.locator("#dlg-trade").getByRole("button", { name: "Close" }).click();
});

await check("Stats match hand-computed values", async () => {
  await nav(page, "Stats");
  assert.match(await text(page, '[data-k="win-rate"]'), /40\.0%[\s\S]*4W \/ 6L of 10 closed/);
  assert.match(await text(page, '[data-k="avg"]'), /\$27\.73 \/ -\$45\.54/);
  assert.match(await text(page, '[data-k="pf"]'), /0\.41/);
  assert.match(await text(page, '[data-k="expectancy"]'), /-\$16\.23/);
  assert.match(await text(page, '[data-k="max-dd"]'), /-\$230\.56/);
  assert.match(await text(page, '[data-k="total"]'), /-\$162\.31/);
  assert.match(await text(page, '[data-k="best-symbol"]'), /AUDUSD · \$45\.50/);
  assert.match(await text(page, '[data-k="worst-symbol"]'), /XAUUSD · -\$196\.77/);
  assert.match(await text(page, '[data-k="best-hour"]'), /18:00–18:59 · \$46\.73/);
  assert.match(await text(page, '[data-k="worst-hour"]'), /21:00–21:59 · -\$123\.90/);
  assert.equal(await page.locator("svg.equity polyline").count(), 1);
  await shot(page, "08-stats");
});

await check("Rules: RED today, 6 breaches this week, breach list", async () => {
  await nav(page, "Rules");
  assert.equal(await page.locator('[data-k="rules-status"]').getAttribute("data-status"), "red");
  assert.equal(await text(page, '[data-k="week-breaches"]'), "6");
  assert.equal(await page.locator("#breach-list .row").count(), 5);
  assert.match(await text(page, "#breach-list"), /Opened after daily loss stop/);
  assert.match(await text(page, "#breach-list"), /No stop loss/);
  await shot(page, "09-rules");
});

await check("Journal: tag + note saved and persist across reload; tag filter uses it", async () => {
  await nav(page, "Journal");
  const c4 = page.locator('#view-journal [data-journal="5004"]');
  await c4.locator("[data-j-tag]").selectOption("revenge");
  await c4.locator("[data-j-note]").fill("Chased the move after Monday's loss");
  await c4.getByRole("button", { name: "Save journal" }).click();
  await c4.locator("[data-j-saved]", { hasText: "Saved" }).waitFor();
  const c3 = page.locator('#view-journal [data-journal="5003"]');
  await c3.locator("[data-j-tag]").selectOption("__custom");
  await c3.locator("[data-j-custom]").fill("london open");
  await c3.getByRole("button", { name: "Save journal" }).click();
  await shot(page, "10-journal");
  await page.reload();
  await page.waitForSelector("#view-today .stats");
  await nav(page, "Journal");
  assert.equal(await page.locator('#view-journal [data-journal="5004"] [data-j-tag]').inputValue(), "revenge");
  assert.equal(await page.locator('#view-journal [data-journal="5004"] [data-j-note]').inputValue(), "Chased the move after Monday's loss");
  assert.equal(await page.locator('#view-journal [data-journal="5003"] [data-j-custom]').inputValue(), "london open");
  await page.check("#j-untagged");
  assert.equal(await page.locator("#view-journal [data-journal]").count(), 8);
  await page.uncheck("#j-untagged");
  await nav(page, "Trade log");
  await page.selectOption("#f-tag", "revenge");
  assert.equal(await page.locator("#log-list .row").count(), 1);
  await page.click("#f-reset");
});

await check("Settings: max trades 3 adds over-limit breaches; cap at 20; server offset moves times", async () => {
  await page.locator(".top-actions").getByRole("button", { name: "Settings" }).click();
  await page.fill("#s-maxTrades", "3");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.locator("#toast", { hasText: "Settings saved" }).waitFor();
  await nav(page, "Rules");
  assert.equal(await text(page, '[data-k="week-breaches"]'), "9");
  assert.match(await text(page, "#breach-list"), /Over max trades per day/);
  await page.getByRole("button", { name: "Edit rules" }).click();
  await page.fill("#s-maxTrades", "25");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#s-maxTrades").inputValue(), "20");
  await page.fill("#s-maxTrades", "5");
  await page.fill("#s-offset", "2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(150);
  await nav(page, "Trade log");
  assert.match(await text(page, '#log-list [data-ticket="5001"]'), /2026-10-05 19:00/);
  await page.locator(".top-actions").getByRole("button", { name: "Settings" }).click();
  await page.fill("#s-offset", "3");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(150);
  await shot(page, "11-settings");
});

await check("Contract value edit changes risk; unknown symbol warns", async () => {
  await page.locator('[data-cv="XAUUSD"]').fill("100");
  await page.getByRole("button", { name: "Save contract values" }).click();
  await page.waitForTimeout(150);
  await nav(page, "Trade log");
  await page.locator('#log-list [data-ticket="5002"]').click();
  const b = await text(page, "#trade-body");
  assert.match(b, /\$100\.00/);
  assert.doesNotMatch(b, /Risk over max per trade/);
  await page.locator("#dlg-trade").getByRole("button", { name: "Close" }).click();
  await page.locator(".top-actions").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-cv="XAUUSD"]').inputValue(), "154");
});

await check("Paste import upserts by ticket (open -> closed), journal kept", async () => {
  await page.locator(".top-actions").getByRole("button", { name: "Import CSV" }).click();
  await page.fill("#import-paste", "ticket,open_time,close_time,symbol,side,lots,entry,exit,sl,tp,commission,swap,profit,tag,note\n5008,2026.10.07 12:00:00,2026.10.07 12:50:00,EURUSD,buy,0.10,1.0800,1.0850,1.0750,1.0850,-0.70,0,77.00,,hit TP\n5004,2026.10.06 13:00:00,2026.10.06 14:00:00,EURUSD,sell,0.10,1.0900,1.0920,,1.0850,-0.70,0,-30.80,,no SL\n");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.locator("#import-result", { hasText: "read" }).waitFor();
  assert.match(await text(page, "#import-result"), /2 trades read: 0 added, 1 updated, 1 unchanged\./);
  await page.locator("#dlg-import").getByRole("button", { name: "Close" }).click();
  await nav(page, "Today");
  assert.equal(await page.locator("#open-list .row").count(), 1);
  assert.match(await text(page, '[data-k="day-net"]'), /\$12\.71/);
  await nav(page, "Journal");
  assert.equal(await page.locator('#view-journal [data-journal="5004"] [data-j-tag]').inputValue(), "revenge");
});

await check("JSON backup + restore of journal and settings", async () => {
  await page.locator(".top-actions").getByRole("button", { name: "Settings" }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download backup (JSON)" }).click()]);
  const file = path.join(SHOTS, "backup.json");
  await dl.saveAs(file);
  const data = JSON.parse(await readFile(file, "utf8"));
  assert.equal(data.app, "trade-ledger");
  assert.equal(data.journal.length, 2);
  assert.equal(data.settings.maxRiskPerTrade, 100);
  // wipe journal + change a setting, then restore
  await page.fill("#s-maxRisk", "250");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(150);
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("trade-ledger"); r.onsuccess = () => { const tx = r.result.transaction("journal", "readwrite"); tx.objectStore("journal").clear(); tx.oncomplete = () => { r.result.close(); res(); }; }; }));
  await page.setInputFiles("#backup-file", file);
  await page.locator("#toast", { hasText: "Restored 2 journal entries" }).waitFor();
  assert.equal(await page.locator("#s-maxRisk").inputValue(), "100");
  await nav(page, "Journal");
  assert.equal(await page.locator('#view-journal [data-journal="5003"] [data-j-custom]').inputValue(), "london open");
});

await check("Load sample alongside real trades, then Clear sample keeps real ones", async () => {
  await page.locator(".top-actions").getByRole("button", { name: "Settings" }).click();
  await page.locator("#view-settings").getByRole("button", { name: "Load sample data" }).click();
  await page.locator("#sample-banner").waitFor({ state: "visible" });
  await page.locator("#sample-banner").getByRole("button", { name: "Clear sample" }).click();
  await page.locator("#sample-banner").waitFor({ state: "hidden" });
  await nav(page, "Trade log");
  assert.equal(await page.locator("#log-list .row").count(), 12);
});

console.log("Desktop 1280x900");
const d = await newPage({ width: 1280, height: 900 });
await check("desktop renders all screens", async () => {
  await d.page.evaluate(async (csv) => window.tradeLedger.importCsvText(csv), await readFile(FIXTURE, "utf8"));
  await d.page.locator('[data-k="day-net"]').waitFor();
  await shot(d.page, "12-desktop-today");
  for (const v of ["Trade log", "Stats", "Journal", "Rules"]) { await nav(d.page, v); await d.page.waitForTimeout(60); }
  await shot(d.page, "13-desktop-rules");
});

await check("no console errors / page errors", async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}`);
