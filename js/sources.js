// Trade sources. Every source ends in the same place: CSV text -> parseTradesCsv -> upsert.
// To add Google Drive later: implement `drive.fetchCsv()` (e.g. find 'mt5-trades.csv' in the
// 'Trade Ledger (auto)' folder and return its text), set `available: true`. Nothing else changes.
import { parseTradesCsv } from "./csv.js?v=1";
import { upsertTrades } from "./db.js?v=1";

export const sources = {
  file: { label: "CSV file", available: true, fetchCsv: (file) => file.text() },
  paste: { label: "Pasted CSV", available: true, fetchCsv: async (text) => text },
  drive: {
    label: "Google Drive: Trade Ledger (auto)/mt5-trades.csv",
    available: false,
    note: "Drive auto-load coming once statements start.",
    fetchCsv: async () => { throw new Error("Drive loading isn't switched on yet."); },
  },
};

/** Load from a named source. Returns {added, updated, unchanged, errors, warnings, total}. */
export async function importFrom(sourceKey, input) {
  const src = sources[sourceKey];
  if (!src?.available) throw new Error(src?.note || `Unknown source ${sourceKey}`);
  const text = await src.fetchCsv(input);
  return importCsvText(text, sourceKey);
}

export async function importCsvText(text, source = "csv") {
  const { trades, errors, warnings } = parseTradesCsv(text);
  const res = trades.length ? await upsertTrades(trades, { source }) : { added: 0, updated: 0, unchanged: 0 };
  return { ...res, total: trades.length, errors, warnings };
}
