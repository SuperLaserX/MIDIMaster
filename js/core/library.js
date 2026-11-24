// Patch library: SysEx dumps kept in the browser (IndexedDB), per device.
// Entries: {id, device, name, kind, bytes (Uint8Array), created, notes}.

const DB = 'midimaster';
const STORE = 'library';
let dbPromise = null;
const memory = new Map(); // fallback when IndexedDB is unavailable

/** The app's IndexedDB database. Version 2 adds 'mainlib' (Main Library cache and folder handles). */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('device', 'device');
      }
      if (!db.objectStoreNames.contains('mainlib')) db.createObjectStore('mainlib');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}
const open = openDb;

async function tx(mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const library = {
  async list(device) {
    return tx('readonly', async (s) => {
      if (!s) return [...memory.values()].filter((e) => e.device === device);
      return req(s.index('device').getAll(device));
    });
  },

  async put(entry) {
    const e = { created: Date.now(), kind: 'sysex', notes: '', ...entry, bytes: Uint8Array.from(entry.bytes) };
    return tx('readwrite', async (s) => {
      if (!s) { e.id = e.id || memory.size + 1; memory.set(e.id, e); return e.id; }
      return req(s.put(e));
    });
  },

  async remove(id) {
    return tx('readwrite', async (s) => { if (!s) { memory.delete(id); return; } return req(s.delete(id)); });
  },

  async update(id, patch) {
    return tx('readwrite', async (s) => {
      if (!s) { Object.assign(memory.get(id) || {}, patch); return; }
      const e = await req(s.get(id));
      if (e) await req(s.put({ ...e, ...patch }));
    });
  },

  async count() {
    return tx('readonly', async (s) => (s ? req(s.count()) : memory.size));
  },

  async clear() {
    return tx('readwrite', async (s) => { if (!s) { memory.clear(); return; } return req(s.clear()); });
  },
};
