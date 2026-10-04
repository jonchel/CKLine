// Офлайн-хранилище на телефоне: IndexedDB + очередь синхронизации (outbox).
// Каждая запись замера генерируется локально с uuid — при появлении сети
// outbox выгружается в Supabase (идемпотентно, primary key = client_uuid).
import { v4 as uuidv4 } from "uuid";

const DB_NAME = "detali-uchet";
const DB_VERSION = 1;
const STORE_ENTRIES = "production_entries"; // локальные замеры (в т.ч. не отправленные)
const STORE_CACHE = "cache";                // справочники для офлайн-режима

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const s = db.createObjectStore(STORE_ENTRIES, { keyPath: "client_uuid" });
        s.createIndex("by_synced", "synced");
        s.createIndex("by_session", "session_id");
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: "table" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Добавить замер со счётчика (или простой/переналадку) — работает без интернета. */
export async function addEntry({ session_id, machine_id, operation, part_id = null,
  kind = "counter", counter_value = null, reason = null, note = null,
  recorded_by, recorded_at = new Date().toISOString() }) {
  const db = await openDb();
  const rec = {
    client_uuid: uuidv4(), session_id, machine_id, operation, part_id,
    kind, counter_value, reason, note, recorded_by, recorded_at,
    synced: false,
  };
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    tx.objectStore(STORE_ENTRIES).add(rec);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  return rec;
}

/** Все замеры смены (локальные + синхронизированные) для расчётов и отчёта. */
export async function getEntries(sessionId) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ENTRIES, "readonly");
    const idx = tx.objectStore(STORE_ENTRIES).index("by_session");
    const rq = idx.getAll(sessionId);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

/** Очередь на отправку. */
export async function getPending() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ENTRIES, "readonly");
    const idx = tx.objectStore(STORE_ENTRIES).index("by_synced");
    const rq = idx.getAll(false);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

/** Выгрузка outbox в Supabase. supabaseClient — из lib/supabase.js. */
export async function flushOutbox(supabaseClient) {
  const pending = await getPending();
  if (!pending.length) return { sent: 0 };
  const rows = pending.map(({ synced, ...r }) => r); // сервер ждёт колонки схемы
  const { error } = await supabaseClient
    .from("production_entries")
    .upsert(rows, { onConflict: "client_uuid" });
  if (error) throw error; // сеть пропала — попробуем при следующем подключении
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    const st = tx.objectStore(STORE_ENTRIES);
    for (const p of pending) st.put({ ...p, synced: true });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  return { sent: pending.length };
}

/** Кэш справочников для офлайна (machines, people, parts, plans...). */
export async function cacheTable(table, rows) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE_CACHE, "readwrite");
    tx.objectStore(STORE_CACHE).put({ table, rows, cached_at: new Date().toISOString() });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

export async function readCache(table) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_CACHE, "readonly");
    const rq = tx.objectStore(STORE_CACHE).get(table);
    rq.onsuccess = () => res(rq.result?.rows ?? []);
    rq.onerror = () => rej(rq.error);
  });
}

/** Фоновая синхронизация: стартует при загрузке приложения и при возврате в сеть. */
export function startSyncLoop(supabaseClient, onFlushed) {
  const tryFlush = async () => {
    if (!navigator.onLine) return;
    try {
      const r = await flushOutbox(supabaseClient);
      if (r.sent && onFlushed) onFlushed(r.sent);
    } catch {
      /* тихо повторим по таймеру/событию */
    }
  };
  window.addEventListener("online", tryFlush);
  setInterval(tryFlush, 60_000);
  tryFlush();
}
