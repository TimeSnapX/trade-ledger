// IndexedDB storage: trades (by ticket), journal (by ticket), meta (settings etc.).
const DB_NAME = "trade-ledger";
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("trades")) db.createObjectStore("trades", { keyPath: "ticket" });
      if (!db.objectStoreNames.contains("journal")) db.createObjectStore("journal", { keyPath: "ticket" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        let result;
        const r = fn(os);
        if (r && "onsuccess" in r) r.onsuccess = () => { result = r.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const all = (store) => run(store, "readonly", (os) => os.getAll());
export const get = (store, key) => run(store, "readonly", (os) => os.get(key));
export const put = (store, value) => run(store, "readwrite", (os) => os.put(value));
export const del = (store, key) => run(store, "readwrite", (os) => os.delete(key));
export const clear = (store) => run(store, "readwrite", (os) => os.clear());
export const putMany = (store, values) => run(store, "readwrite", (os) => { for (const v of values) os.put(v); });
export const delMany = (store, keys) => run(store, "readwrite", (os) => { for (const k of keys) os.delete(k); });

export async function getMeta(key, fallback = null) {
  const r = await get("meta", key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => put("meta", { key, value });

/**
 * Upsert parsed trades by ticket. Returns {added, updated, unchanged}.
 * Journal entries are stored separately, so re-importing never touches them.
 */
export async function upsertTrades(trades, { sample = false, source = "csv" } = {}) {
  const existing = new Map((await all("trades")).map((t) => [t.ticket, t]));
  let added = 0, updated = 0, unchanged = 0;
  const now = new Date().toISOString();
  const rows = [];
  for (const t of trades) {
    const prev = existing.get(t.ticket);
    const rec = { ...t, sample, source, importedAt: now };
    if (!prev) added++;
    else if (sameTrade(prev, rec)) { unchanged++; continue; }
    else updated++;
    rows.push(rec);
  }
  await putMany("trades", rows);
  return { added, updated, unchanged };
}

const KEYS = ["open_time", "close_time", "symbol", "side", "lots", "entry", "exit", "sl", "tp", "commission", "swap", "profit", "tag", "note", "sample"];
const sameTrade = (a, b) => KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
