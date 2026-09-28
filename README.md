# Trade Ledger

Read-only MT5 trade tracker. Import a CSV of trades, see today's P&L and open risk, stats, a journal, and a check against your own trading rules.

Live page: https://timesnapx.github.io/trade-ledger/

- **Read-only.** No broker connection, no logins, no order buttons. Trades come only from CSV you import.
- **Local.** Data stays in this browser (IndexedDB). Back up journal + settings with *Settings › Download backup (JSON)*.
- Times shown in **Brisbane (AEST, UTC+10)**. Money in **AUD**.

## CSV format

`mt5-trades.csv`, header (order doesn't matter, case-insensitive):

```
ticket,open_time,close_time,symbol,side,lots,entry,exit,sl,tp,commission,swap,profit,tag,note
```

- Blank `close_time` or `exit` = open position.
- Times are **broker server time** (set the offset in Settings, default UTC+3): `YYYY.MM.DD HH:MM:SS` (MT5 style) or ISO `YYYY-MM-DDTHH:MM:SS`. A time ending in `Z` or `+HH:MM` is used as-is.
- `side` is `buy` or `sell`, any case. `sl`/`tp` blank or `0` = none.
- Net P&L = `profit + commission + swap`.
- Comma, semicolon or tab separated; quoted fields fine. Bad rows are skipped and listed with their line number.
- Importing again **upserts by ticket**: new tickets are added, changed ones updated. Journal notes are kept.

See `tests/fixtures/trades.csv` for an example.

## Screens

| Screen | What it shows |
| --- | --- |
| Today | Today / this week net, open risk (entry→SL × lots × contract value), open positions, no-SL warning, closed today |
| Trade log | Every trade, filter by symbol, date range (Brisbane open date), tag; tap for detail + journal |
| Stats | Win rate, avg win vs avg loss, profit factor, expectancy, max drawdown + equity chart, best/worst symbol and hour |
| Journal | Tag (planned setup / revenge / news / custom) + note per trade, stored by ticket |
| Rules | Today GREEN / AMBER / RED, breaches this week, breach list |

**Rules** (Settings, all AUD): max risk per trade $100, daily loss stop $150, weekly loss limit $500, max trades per day 5 (up to 20), reward-to-risk target 2:1.
Per-trade flags: no SL; SL risk over the max; TP under 1:1; trade number over the daily max; opened after the day's closed net hit the daily stop; opened after the week's closed net hit the weekly limit. Week = Monday to Sunday, Brisbane.

**Contract values** (Settings): AUD value of a 1.00 price move for 1 lot. Defaults are rough (1 USD = 1.54 AUD): FX majors, XAUUSD (100 oz), US500/US30/USTEC, AUS200, DE40. Check against MT5 symbol specification and edit.

## Data sources

`js/sources.js` holds the sources. All of them end in the same path: CSV text → `parseTradesCsv` (`js/csv.js`) → upsert by ticket.
Google Drive (`Trade Ledger (auto)/mt5-trades.csv`) is a placeholder: implement `sources.drive.fetchCsv()` and set `available: true` once statements start.

**Load sample data** adds obviously fake trades (tickets `EXAMPLE-…`, banner "Sample data, not real trades"). **Clear sample** removes only those.

## Develop

```
npm start              # http://localhost:4180
npm test               # parser + maths unit tests (node --test)
BASE=http://127.0.0.1:4180/trade-ledger/ PLAYWRIGHT_DIR=<dir with playwright-core> CHROME=<chrome> node tests/e2e.mjs
```

Plain HTML/CSS/JS modules, no build step. Look borrowed from Pay Ledger.
