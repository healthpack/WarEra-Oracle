/**
 * localStore.js — Palantirish "Local DB" (Option A: a real file you pick on disk).
 *
 * The DB is a single append-only NDJSON file the user chooses via the Chrome File System
 * Access API (e.g. Desktop/palantirish.ndjson). One JSON record per line:
 *     {"k": <cacheKey>, "e": <endpoint>, "d": <responseData>, "t": <fetchedAtMs>}
 * keyed exactly like smartFetch's deduper (`endpoint + JSON.stringify(payload)`).
 *
 * • Append-only ⇒ "supplement, never prune": re-fetching a key appends a newer line;
 *   nothing is rewritten or deleted. On load we replay lines into an in-memory Map,
 *   last line per key wins. (A future "compact" can rewrite to drop superseded lines.)
 * • The file handle is remembered in a tiny IndexedDB so the DB reconnects next session
 *   with one permission click. The file itself lives wherever the user put it — delete it
 *   to start a fresh DB.
 *
 * Chromium-only (Chrome/Edge) — `isSupported()` guards the UI.
 */

// ── handle persistence (a tiny IndexedDB holding only the FileSystemFileHandle) ────────
const META_DB = 'palantirish_meta', META_STORE = 'kv', HANDLE_KEY = 'dbFileHandle';
function metaDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveHandle(h) {
  try { const db = await metaDb(); await new Promise((res, rej) => { const tx = db.transaction(META_STORE, 'readwrite'); tx.objectStore(META_STORE).put(h, HANDLE_KEY); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch { /* ignore */ }
}
async function loadHandle() {
  try { const db = await metaDb(); return await new Promise((res) => { const tx = db.transaction(META_STORE, 'readonly'); const r = tx.objectStore(META_STORE).get(HANDLE_KEY); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch { return null; }
}

// ── in-memory state ───────────────────────────────────────────────────────────────────
let handle = null;            // FileSystemFileHandle of the open DB file
let map = new Map();          // key -> { data, fetchedAt, endpoint }  (latest per key)
let fileSize = 0;             // byte length on disk, for append seeking
let buffer = [];              // pending NDJSON lines not yet flushed
let flushTimer = null, flushing = false;
let newestAt = 0;             // most recent fetchedAt in the store (data-freshness reference)

// The freshest fetch time in the DB — used as the "as of" reference for staleness-sensitive
// checks (e.g. inactivity) when reading an old DB, so 10-day-old data isn't judged against now.
export function newestFetchedAt() { return newestAt || null; }

// When a specific stored record was fetched — used as the per-user "as of" reference for
// staleness-sensitive checks (inactivity), so an old record isn't judged against fresher ones.
export function fetchedAtFor(key) { const r = map.get(key); return r ? r.fetchedAt : null; }

export function isSupported() { return typeof window !== 'undefined' && 'showSaveFilePicker' in window; }
export function isOpen() { return !!handle; }

async function loadFromHandle(h) {
  const file = await h.getFile();
  fileSize = file.size;
  map = new Map(); newestAt = 0;
  let lines = 0;
  const ingest = (line) => {
    if (!line) return;
    try { const r = JSON.parse(line); if (r && r.k) { map.set(r.k, { data: r.d, fetchedAt: r.t, endpoint: r.e }); if (r.t > newestAt) newestAt = r.t; lines++; } } catch { /* skip bad line */ }
  };
  // Stream + decode in chunks rather than reading the whole file into one string.
  // A multi-GB NDJSON file would otherwise allocate the full text AND the split-line
  // array at once (2–3× the file size) and could blow past V8's max string length →
  // "out of memory". Streaming keeps peak memory at (deduped Map + one chunk); because
  // the file is append-only, superseded lines collapse into the Map as we go.
  if (file.size) {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    let tail = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tail += value;
      let nl;
      while ((nl = tail.indexOf('\n')) >= 0) { ingest(tail.slice(0, nl)); tail = tail.slice(nl + 1); }
    }
    ingest(tail);   // final line (no trailing newline)
  }
  handle = h; buffer = [];
  return { records: map.size, lines };
}

// Create a brand-new (empty) DB file at a user-chosen location.
export async function createNew() {
  const h = await window.showSaveFilePicker({ suggestedName: 'palantirish.ndjson', types: [{ description: 'Palantirish DB', accept: { 'application/x-ndjson': ['.ndjson'] } }] });
  const w = await h.createWritable(); await w.close();   // truncate to empty
  await saveHandle(h); handle = h; map = new Map(); fileSize = 0; buffer = []; newestAt = 0;
  return { records: 0, lines: 0 };
}

// Open an existing DB file the user picks.
export async function openExisting() {
  const [h] = await window.showOpenFilePicker({ types: [{ description: 'Palantirish DB', accept: { 'application/x-ndjson': ['.ndjson'] } }] });
  await saveHandle(h);
  return await loadFromHandle(h);
}

// Silently reconnect to the previously-used file (needs a permission grant on return).
export async function reconnect() {
  const h = await loadHandle();
  if (!h) return null;
  try {
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { perm = await h.requestPermission({ mode: 'readwrite' }); if (perm !== 'granted') return null; }
    return await loadFromHandle(h);
  } catch { return null; }
}

// True if a previous file handle is remembered (so the UI can offer "Reconnect").
export async function hasRemembered() { return !!(await loadHandle()); }

export function close() { handle = null; map = new Map(); fileSize = 0; buffer = []; newestAt = 0; }

export function get(key) { const r = map.get(key); return r ? r.data : undefined; }

// Record a response: update the in-memory map and queue an append line. Never blocks the
// scan — writes are batched and flushed on a short timer.
export function put(key, endpoint, data, payload) {
  if (!handle) return;
  const t = Date.now();
  map.set(key, { data, fetchedAt: t, endpoint }); newestAt = t;
  buffer.push(JSON.stringify({ k: key, e: endpoint, d: data, t }) + '\n');
  scheduleFlush();
}

function scheduleFlush() { if (flushTimer || flushing) return; flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1500); }

async function flush() {
  if (flushing || !handle || !buffer.length) return;
  flushing = true;
  const chunk = buffer.join(''); buffer = [];
  try {
    const w = await handle.createWritable({ keepExistingData: true });
    await w.seek(fileSize);
    await w.write(chunk);
    await w.close();
    fileSize += new Blob([chunk]).size;
  } catch (e) {
    buffer.unshift(chunk);   // re-queue on failure
  }
  flushing = false;
  if (buffer.length) scheduleFlush();
}

// Force any pending writes to disk (call before showing "saved" / on scan end).
export async function flushNow() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } await flush(); }

export async function stats() {
  let oldest = null, newest = null;
  for (const r of map.values()) { if (oldest == null || r.fetchedAt < oldest) oldest = r.fetchedAt; if (newest == null || r.fetchedAt > newest) newest = r.fetchedAt; }
  let size = fileSize;
  try { if (handle) size = (await handle.getFile()).size; } catch { /* ignore */ }
  return { records: map.size, oldest, newest, size, pending: buffer.length, name: handle?.name || null };
}
