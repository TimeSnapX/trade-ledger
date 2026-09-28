// MT5 trade CSV parser. Pure module (no DOM) so it runs in the browser and in Node tests.
// Header: ticket, open_time, close_time, symbol, side, lots, entry, exit, sl, tp,
//         commission, swap, profit, tag, note
// Tolerant: column order free, header case/space-insensitive, extra columns ignored,
// comma / semicolon / tab delimiters, quoted fields, BOM, CRLF, blanks allowed.

export const COLUMNS = [
  "ticket", "open_time", "close_time", "symbol", "side", "lots", "entry", "exit",
  "sl", "tp", "commission", "swap", "profit", "tag", "note",
];
export const REQUIRED = ["ticket", "open_time", "symbol", "side", "lots", "entry"];

/** Split CSV text into rows of fields (RFC 4180-ish). Returns [{line, fields}]. */
export function splitRows(text, delim = ",") {
  const rows = [];
  let field = "";
  let fields = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field.trim() === "") {
      field = "";
      inQuotes = true;
    } else if (c === delim) {
      fields.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      fields.push(field);
      rows.push({ line: rowLine, fields });
      fields = []; field = ""; line++; rowLine = line;
    } else {
      field += c;
    }
  }
  if (field !== "" || fields.length) { fields.push(field); rows.push({ line: rowLine, fields }); }
  return rows.filter((r) => r.fields.some((f) => f.trim() !== ""));
}

function detectDelimiter(headerLine) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of headerLine) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
}

const normKey = (s) => s.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Parse a time. Accepts 'YYYY.MM.DD HH:MM[:SS]', 'YYYY-MM-DD HH:MM[:SS]', 'YYYY/MM/DD ...',
 * ISO 'YYYY-MM-DDTHH:MM[:SS[.sss]][Z|+HH:MM]', or a date alone (midnight).
 * Returns a canonical string 'YYYY-MM-DDTHH:MM:SS' (broker server time) or the same with
 * 'Z' / '+HH:MM' when the source carried an explicit zone. null for blank; throws on garbage.
 */
export function parseTime(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = s.match(
    /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (!m) throw new Error(`unreadable time "${s}"`);
  const [, y, mo, d, h = "0", mi = "0", se = "0", zone] = m;
  const n = [+mo, +d, +h, +mi, +se];
  if (n[0] < 1 || n[0] > 12 || n[1] < 1 || n[1] > 31 || n[2] > 23 || n[3] > 59 || n[4] > 59) {
    throw new Error(`out-of-range time "${s}"`);
  }
  const p = (v) => String(v).padStart(2, "0");
  let out = `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se)}`;
  if (zone) out += zone.toUpperCase() === "Z" ? "Z" : zone.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  return out;
}

/** Parse a number. Blank -> null. Handles thousands commas, spaces, unicode minus, (1.23). */
export function parseNum(raw) {
  let s = String(raw ?? "").trim().replace(/\u2212/g, "-").replace(/\s+/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) throw new Error(`not a number "${raw}"`);
  const v = Number(s);
  return neg ? -v : v;
}

export function parseSide(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "buy") return "buy";
  if (s === "sell") return "sell";
  throw new Error(`side must be buy or sell, got "${String(raw ?? "").trim()}"`);
}

/**
 * Parse CSV text into trades.
 * @returns {{trades: object[], errors: {line:number, message:string}[], warnings: string[]}}
 */
export function parseTradesCsv(text) {
  const errors = [];
  const warnings = [];
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const rows = splitRows(src, detectDelimiter(firstLine));
  if (!rows.length) return { trades: [], errors: [{ line: 0, message: "No rows found." }], warnings };

  const header = rows[0].fields.map(normKey);
  const idx = {};
  header.forEach((h, i) => { if (COLUMNS.includes(h) && !(h in idx)) idx[h] = i; });
  const missing = REQUIRED.filter((c) => !(c in idx));
  if (missing.length) {
    return {
      trades: [],
      errors: [{ line: rows[0].line, message: `Header is missing: ${missing.join(", ")}. Expected: ${COLUMNS.join(", ")}` }],
      warnings,
    };
  }
  const absent = COLUMNS.filter((c) => !(c in idx));
  if (absent.length) warnings.push(`Columns not in file (left blank): ${absent.join(", ")}`);

  const byTicket = new Map();
  for (const { line, fields } of rows.slice(1)) {
    const get = (c) => (c in idx ? String(fields[idx[c]] ?? "").trim() : "");
    try {
      const ticket = get("ticket");
      if (!ticket) throw new Error("ticket is blank");
      const symbol = get("symbol").toUpperCase();
      if (!symbol) throw new Error("symbol is blank");
      const open_time = parseTime(get("open_time"));
      if (!open_time) throw new Error("open_time is blank");
      const lots = parseNum(get("lots"));
      if (lots == null || lots <= 0) throw new Error("lots must be > 0");
      const entry = parseNum(get("entry"));
      if (entry == null) throw new Error("entry is blank");
      const close_time = parseTime(get("close_time"));
      const exit = parseNum(get("exit"));
      const sl = parseNum(get("sl"));
      const tp = parseNum(get("tp"));
      const trade = {
        ticket,
        open_time,
        close_time: close_time && exit != null ? close_time : null,
        symbol,
        side: parseSide(get("side")),
        lots,
        entry,
        exit: close_time && exit != null ? exit : null,
        sl: sl ? sl : null, // MT5 writes 0 for "no SL"
        tp: tp ? tp : null,
        commission: parseNum(get("commission")),
        swap: parseNum(get("swap")),
        profit: parseNum(get("profit")),
        tag: get("tag"),
        note: get("note"),
      };
      trade.open = trade.close_time == null;
      if (byTicket.has(ticket)) warnings.push(`Ticket ${ticket} appears twice; line ${line} wins.`);
      byTicket.set(ticket, trade);
    } catch (e) {
      errors.push({ line, message: e.message });
    }
  }
  return { trades: [...byTicket.values()], errors, warnings };
}

/** Serialise trades back to CSV with the canonical header (used for sample export / round-trips). */
export function tradesToCsv(trades) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLUMNS.join(","), ...trades.map((t) => COLUMNS.map((c) => esc(t[c])).join(","))].join("\n") + "\n";
}
