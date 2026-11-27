// Head Library storage. The library's home is a folder the user picks (File System Access API);
// a key-value cache (IndexedDB) mirrors its JSON so it opens before folder access is confirmed,
// and holds every write made while the folder is not reachable ("pending"), which is written to
// the folder once access is back. Before a folder is chosen everything lives in the cache.
//
// Layout (see format.js): mainlibrary.json at the root; one folder per sub-library holding
// sublibrary.json, patches/<id>.json and samples/<id>.wav + .json. A sub-library registered from
// another folder keeps its own folder handle ("external").

import { MAIN_FORMAT, VERSION, makeSub, indexRow, fileName, isPatch } from './format.js';

// ------------------------------------------------------------------ folder backends
// A backend is a folder: readText/writeText/readBytes/writeBytes/remove/list(dir).

/** A folder in memory (tests). */
export class MemoryFolder {
  constructor() { this.files = new Map(); }
  async readText(p) { const v = this.files.get(p); return v === undefined ? null : typeof v === 'string' ? v : new TextDecoder().decode(v); }
  async writeText(p, s) { this.files.set(p, String(s)); }
  async readBytes(p) { const v = this.files.get(p); return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v) : v; }
  async writeBytes(p, b) { this.files.set(p, Uint8Array.from(b)); }
  async remove(p) { this.files.delete(p); }
  async removeDir(dir) { for (const k of [...this.files.keys()]) if (k.startsWith(`${dir}/`)) this.files.delete(k); }
  async list(dir) {
    const pre = dir ? `${dir}/` : '';
    return [...new Set([...this.files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split('/')[0]))];
  }
}

/** A real folder (FileSystemDirectoryHandle). */
export class DirFolder {
  constructor(handle) { this.handle = handle; }
  async dir(parts, create) {
    let d = this.handle;
    for (const part of parts) d = await d.getDirectoryHandle(part, { create });
    return d;
  }
  async file(path, create) {
    const parts = path.split('/');
    const name = parts.pop();
    const d = await this.dir(parts, create);
    return d.getFileHandle(name, { create });
  }
  async readText(p) { try { return await (await (await this.file(p, false)).getFile()).text(); } catch { return null; } }
  async readBytes(p) { try { return new Uint8Array(await (await (await this.file(p, false)).getFile()).arrayBuffer()); } catch { return null; } }
  async write(p, data) { const w = await (await this.file(p, true)).createWritable(); await w.write(data); await w.close(); }
  async writeText(p, s) { await this.write(p, s); }
  async writeBytes(p, b) { await this.write(p, b); }
  async remove(p) {
    const parts = p.split('/');
    const name = parts.pop();
    try { await (await this.dir(parts, false)).removeEntry(name); } catch { /* already gone */ }
  }
  async removeDir(path) {
    const parts = path.split('/');
    const name = parts.pop();
    try { await (await this.dir(parts, false)).removeEntry(name, { recursive: true }); } catch { /* already gone */ }
  }
  async list(dirPath) {
    const out = [];
    try { for await (const [name] of (await this.dir(dirPath ? dirPath.split('/') : [], false)).entries()) out.push(name); } catch { /* no folder */ }
    return out;
  }
  async permission(request = false) {
    const opts = { mode: 'readwrite' };
    if (!this.handle.queryPermission) return 'granted';
    let state = await this.handle.queryPermission(opts);
    if (state === 'prompt' && request) state = await this.handle.requestPermission(opts);
    return state;
  }
}

// ------------------------------------------------------------------ cache (key-value)
/** Key-value store over IndexedDB 'mainlib' (or a Map for tests). */
export class KvStore {
  constructor(db = null) { this.db = db; this.map = new Map(); }
  async op(mode, fn) {
    if (!this.db) return fn(null);
    return new Promise((resolve, reject) => {
      const t = this.db.transaction('mainlib', mode);
      const s = t.objectStore('mainlib');
      let out;
      Promise.resolve(fn(s)).then((r) => { out = r; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  async get(k) { return this.op('readonly', (s) => (s ? new Promise((r) => { const q = s.get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); }) : this.map.get(k))); }
  async set(k, v) { return this.op('readwrite', (s) => { if (s) s.put(v, k); else this.map.set(k, v); }); }
  async delete(k) { return this.op('readwrite', (s) => { if (s) s.delete(k); else this.map.delete(k); }); }
  async keys(prefix = '') {
    return this.op('readonly', (s) => (s
      ? new Promise((r) => { const q = s.getAllKeys(); q.onsuccess = () => r(q.result.filter((k) => String(k).startsWith(prefix))); q.onerror = () => r([]); })
      : [...this.map.keys()].filter((k) => String(k).startsWith(prefix))));
  }
}

/**
 * A sub-library's folder seen through the cache. Writes go to the cache and, when the folder is
 * reachable, to the folder; otherwise they are kept as pending. Sample audio is only cached
 * while pending, so the browser does not keep a second copy of every WAV.
 */
class CachedFolder {
  constructor(kv, key, folder) { this.kv = kv; this.key = key; this.folder = folder; }
  ck(p) { return `f:${this.key}/${p}`; }
  async readText(p) {
    if (this.folder) { const v = await this.folder.readText(p); if (v !== null) return v; }
    const c = await this.kv.get(this.ck(p));
    return c ? (typeof c.data === 'string' ? c.data : new TextDecoder().decode(c.data)) : null;
  }
  async readBytes(p) {
    if (this.folder) { const v = await this.folder.readBytes(p); if (v !== null) return v; }
    const c = await this.kv.get(this.ck(p));
    return c ? (typeof c.data === 'string' ? new TextEncoder().encode(c.data) : c.data) : null;
  }
  async put(p, data, big) {
    let ok = false;
    if (this.folder) { try { await (typeof data === 'string' ? this.folder.writeText(p, data) : this.folder.writeBytes(p, data)); ok = true; } catch { ok = false; } }
    if (!ok || !big) await this.kv.set(this.ck(p), { data, pending: !ok });
    else await this.kv.delete(this.ck(p));
  }
  writeText(p, s) { return this.put(p, String(s), false); }
  writeBytes(p, b) { return this.put(p, Uint8Array.from(b), true); }
  async remove(p) { await this.kv.delete(this.ck(p)); if (this.folder) await this.folder.remove(p); }
  /** Write every pending file to the folder. Returns the number written. */
  async flush() {
    if (!this.folder) return 0;
    let n = 0;
    for (const k of await this.kv.keys(`f:${this.key}/`)) {
      const c = await this.kv.get(k);
      if (!c?.pending) continue;
      const p = k.slice(`f:${this.key}/`.length);
      await (typeof c.data === 'string' ? this.folder.writeText(p, c.data) : this.folder.writeBytes(p, c.data));
      if (typeof c.data === 'string') await this.kv.set(k, { data: c.data, pending: false }); else await this.kv.delete(k);
      n++;
    }
    return n;
  }
  async pendingCount() {
    let n = 0;
    for (const k of await this.kv.keys(`f:${this.key}/`)) if ((await this.kv.get(k))?.pending) n++;
    return n;
  }
}

// ------------------------------------------------------------------ the library
const ROOT = 'root';

export class MainLibrary {
  /**
   * kv: KvStore. opts.pickFolder(mode) -> FileSystemDirectoryHandle (the browser picker);
   * opts.wrap(handle) -> folder backend (DirFolder by default; tests pass MemoryFolder-like objects).
   */
  constructor(kv, { pickFolder = null, wrap = (h) => (h instanceof MemoryFolder ? h : new DirFolder(h)) } = {}) {
    this.kv = kv;
    this.pickFolder = pickFolder;
    this.wrap = wrap;
    this.root = null; // folder backend of the Head Library folder
    this.state = 'none'; // 'none' (no folder yet) | 'connected' | 'disconnected' (permission needed)
    this.manifest = { format: MAIN_FORMAT, version: VERSION, sublibraries: [] };
    this.externals = new Map(); // sub id -> folder backend
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  /** Open the library: the folder chosen earlier (if access is still granted) and the cached manifest. */
  async load() {
    const cached = await this.kv.get('manifest');
    if (cached) this.manifest = cached;
    const handle = await this.kv.get(`h:${ROOT}`);
    if (handle) {
      const f = this.wrap(handle);
      this.root = f;
      this.state = (await f.permission?.(false)) === 'granted' || !f.permission ? 'connected' : 'disconnected';
      if (this.state === 'connected') await this.refreshFromFolder();
    }
    await this.loadExternals();
    this.emit();
    return this;
  }

  get folderName() { return this.root?.handle?.name || (this.root ? 'folder' : ''); }

  /**
   * Choose the Head Library folder.
   *   'merge' (the first choice): everything made before is written into it, next to any library
   *           already there.
   *   'copy'  (change the location): every sub-library in the current folder is copied to the new
   *           one, which becomes the library's home. The old folder is left as it is.
   *   'open'  (change the location): use the library already in that folder instead. Sub-libraries
   *           of the old folder are no longer listed (their files stay).
   */
  async chooseFolder(mode = 'merge') {
    const handle = await this.pickFolder('readwrite');
    if (!handle) return false;
    const f = this.wrap(handle);
    if (f.permission && (await f.permission(true)) !== 'granted') return false;
    const text = await f.readText('mainlibrary.json');
    const existing = text ? JSON.parse(text) : null;
    const old = this.state === 'connected' ? this.root : null;
    if (mode === 'copy' && !old && this.root) throw new Error('Reconnect the current folder first, so its files can be copied.');
    if (mode === 'open' && (await this.pendingCount())) throw new Error('Some changes are not in the current folder yet. Reconnect it first, so they are not lost.');
    if (mode === 'copy' && old) {
      const used = new Set((existing?.sublibraries || []).map((s) => s.path).filter(Boolean));
      for (const s of this.manifest.sublibraries.filter((x) => !x.external)) {
        let path = s.path;
        for (let i = 2; used.has(path); i++) path = `${s.path} (${i})`;
        used.add(path);
        await copySub(prefixed(old, s.path), prefixed(f, path));
        s.path = path;
      }
    }
    await this.kv.set(`h:${ROOT}`, handle);
    this.root = f;
    this.state = 'connected';
    if (mode === 'open') {
      const keep = new Set((existing?.sublibraries || []).map((s) => s.id));
      for (const s of this.manifest.sublibraries) if (!keep.has(s.id)) for (const k of await this.kv.keys(`f:${s.id}/`)) await this.kv.delete(k);
      this.manifest = existing || { format: MAIN_FORMAT, version: VERSION, sublibraries: [] };
      await this.loadExternals();
    } else if (existing) {
      const known = new Set(existing.sublibraries.map((s) => s.id));
      for (const s of this.manifest.sublibraries) if (!known.has(s.id)) existing.sublibraries.push(s); // keep what was made before
      this.manifest = existing;
    }
    await this.flush();
    await this.saveManifest();
    this.emit();
    return true;
  }

  async loadExternals() {
    this.externals.clear();
    for (const s of this.manifest.sublibraries.filter((x) => x.external)) {
      const h = await this.kv.get(`h:${s.id}`);
      if (h) this.externals.set(s.id, this.wrap(h));
    }
  }

  /** Ask for folder access again (needs a click) and write everything pending. */
  async reconnect() {
    for (const f of this.externals.values()) { try { await f.permission?.(true); } catch { /* asked again later */ } }
    if (!this.root) { await this.flush(); this.emit(); return true; }
    if (this.root.permission && (await this.root.permission(true)) !== 'granted') return false;
    this.state = 'connected';
    await this.flush();
    await this.refreshFromFolder();
    this.emit();
    return true;
  }

  async refreshFromFolder() {
    const t = await this.root.readText('mainlibrary.json');
    if (t) { this.manifest = JSON.parse(t); await this.kv.set('manifest', this.manifest); }
  }

  async saveManifest() {
    await this.kv.set('manifest', this.manifest);
    if (this.state === 'connected') await this.root.writeText('mainlibrary.json', JSON.stringify(this.manifest, null, 1));
  }

  /** The folder (seen through the cache) of sub-library `id`. */
  folderOf(id) {
    const s = this.manifest.sublibraries.find((x) => x.id === id);
    if (!s) throw new Error('No such sub-library.');
    if (s.external) return new CachedFolder(this.kv, id, this.externals.get(id) || null);
    const reachable = this.state === 'connected' ? this.root : null;
    return new CachedFolder(this.kv, id, reachable ? prefixed(reachable, s.path) : null);
  }

  /** Sub-library ids still registered (a loop over them may outlive an unregister). */
  has(id) { return this.manifest.sublibraries.some((s) => s.id === id); }

  async flush() {
    let n = 0;
    for (const s of this.subs()) if (this.has(s.id)) n += await this.folderOf(s.id).flush();
    return n;
  }

  async pendingCount() {
    let n = 0;
    for (const s of this.subs()) if (this.has(s.id)) n += await this.folderOf(s.id).pendingCount();
    return n;
  }

  // -------------------------------------------------------------- sub-libraries
  subs() { return this.manifest.sublibraries.slice(); }

  /** A new sub-library. device: {id, maker, model} when it holds one device's sounds. */
  async createSub(name, { notes = '', device = null } = {}) {
    const sub = makeSub(name || 'Sub-library', { notes, device });
    const used = new Set(this.manifest.sublibraries.map((s) => s.path));
    let path = fileName(sub.name);
    for (let i = 2; used.has(path); i++) path = `${fileName(sub.name)} (${i})`;
    this.manifest.sublibraries.push({ id: sub.id, name: sub.name, path, device });
    await this.folderOf(sub.id).writeText('sublibrary.json', JSON.stringify(sub, null, 1));
    await this.saveManifest();
    this.emit();
    return sub.id;
  }

  /** Register a sub-library that lives in another folder (picked by the user). */
  async registerFolder(handle = null) {
    const h = handle || (await this.pickFolder('readwrite'));
    if (!h) return null;
    const f = this.wrap(h);
    if (f.permission && (await f.permission(true)) !== 'granted') return null;
    const text = await f.readText('sublibrary.json');
    if (!text) throw new Error('That folder holds no sublibrary.json.');
    const sub = JSON.parse(text);
    if (this.manifest.sublibraries.some((s) => s.id === sub.id)) throw new Error(`"${sub.name}" is already registered.`);
    await this.kv.set(`h:${sub.id}`, h);
    this.externals.set(sub.id, f);
    this.manifest.sublibraries.push({ id: sub.id, name: sub.name, external: true, folder: h.name || '' });
    await this.saveManifest();
    this.emit();
    return sub.id;
  }

  /** Remove a sub-library from the Head Library. Its files stay where they are. */
  async unregister(id) {
    this.manifest.sublibraries = this.manifest.sublibraries.filter((s) => s.id !== id);
    for (const k of await this.kv.keys(`f:${id}/`)) await this.kv.delete(k);
    await this.kv.delete(`h:${id}`);
    this.externals.delete(id);
    await this.saveManifest();
    this.emit();
  }

  async renameSub(id, name) { return this.editSub(id, { name }); }

  /** Change a sub-library's name and/or device ({id, maker, model} or null). */
  async editSub(id, changes) {
    const sub = await this.getSub(id);
    const entry = this.manifest.sublibraries.find((s) => s.id === id);
    for (const k of ['name', 'device', 'notes']) {
      if (!(k in changes)) continue;
      sub[k] = changes[k];
      if (k !== 'notes') entry[k] = changes[k];
    }
    await this.folderOf(id).writeText('sublibrary.json', JSON.stringify(sub, null, 1));
    await this.saveManifest();
    this.emit();
  }

  /**
   * Move every patch (with its samples) of sub-libraries `ids` into `targetId`, then remove them:
   * an internal sub-library's folder is deleted, an external one is unregistered.
   */
  async mergeSubs(ids, targetId, { onProgress } = {}) {
    let moved = 0;
    for (const id of ids) {
      if (id === targetId) continue;
      const src = this.folderOf(id);
      const sub = await this.getSub(id);
      const patches = [];
      const samples = new Map();
      for (const r of sub.patches) {
        const p = await this.getPatch(id, r.id);
        if (!p) continue;
        patches.push(p);
        for (const s of p.samples || []) {
          if (samples.has(s.id)) continue;
          const bytes = await src.readBytes(`samples/${s.id}.wav`);
          if (bytes) samples.set(s.id, { id: s.id, bytes, info: JSON.parse((await src.readText(`samples/${s.id}.json`)) || '{}') });
        }
      }
      await this.addPatches(targetId, patches, [...samples.values()], { onProgress });
      moved += patches.length;
      await this.removeSub(id);
    }
    return moved;
  }

  /** Delete a sub-library: its files (internal; external folders are only unregistered) and its entry. */
  async removeSub(id) {
    const s = this.manifest.sublibraries.find((x) => x.id === id);
    if (s && !s.external && this.state === 'connected') await this.root.removeDir?.(s.path);
    await this.unregister(id);
  }

  async getSub(id) {
    const t = await this.folderOf(id).readText('sublibrary.json');
    if (!t) throw new Error('This sub-library\'s files are not reachable. Reconnect its folder.');
    return JSON.parse(t);
  }

  async saveSub(sub) { await this.folderOf(sub.id).writeText('sublibrary.json', JSON.stringify(sub, null, 1)); }

  // -------------------------------------------------------------- patches and samples
  /**
   * Add patches (and their samples: [{id, bytes (WAV), info}]) to a sub-library.
   * opts.onProgress(done, total) is called as files are written.
   */
  async addPatches(subId, patches, samples = [], { onProgress } = {}) {
    const f = this.folderOf(subId);
    const sub = await this.getSub(subId);
    const total = patches.length + samples.length;
    let done = 0;
    for (const s of samples) {
      await f.writeBytes(`samples/${s.id}.wav`, s.bytes);
      await f.writeText(`samples/${s.id}.json`, JSON.stringify(s.info || {}, null, 1));
      onProgress?.(++done, total);
    }
    const rows = new Map(sub.patches.map((r) => [r.id, r]));
    for (const p of patches) {
      if (!isPatch(p)) throw new Error(`Not a Head Library patch: ${p?.name ?? p}`);
      await f.writeText(`patches/${p.id}.json`, JSON.stringify(p, null, 1));
      rows.set(p.id, indexRow(p));
      onProgress?.(++done, total);
    }
    sub.patches = [...rows.values()];
    sub.devices = [...new Set(sub.patches.map((r) => r.device))];
    await this.saveSub(sub);
    this.emit();
    return patches.length;
  }

  async getPatch(subId, id) {
    const t = await this.folderOf(subId).readText(`patches/${id}.json`);
    return t ? JSON.parse(t) : null;
  }

  async updatePatch(subId, patch) { return this.addPatches(subId, [patch]); }

  async deletePatch(subId, id) { return this.deletePatches(subId, [id]); }

  /** Delete patches, and the samples no remaining patch of the sub-library uses. */
  async deletePatches(subId, ids) {
    const f = this.folderOf(subId);
    const sub = await this.getSub(subId);
    const gone = new Set(ids);
    const removed = [];
    for (const id of gone) {
      const p = await this.getPatch(subId, id);
      if (p) removed.push(p);
      await f.remove(`patches/${id}.json`);
    }
    sub.patches = sub.patches.filter((r) => !gone.has(r.id));
    if (removed.some((p) => p.samples?.length)) {
      const used = new Set();
      for (const r of sub.patches) if (r.samples) for (const s of (await this.getPatch(subId, r.id))?.samples || []) used.add(s.id);
      for (const p of removed) {
        for (const s of p.samples || []) {
          if (used.has(s.id)) continue;
          used.add(s.id);
          await f.remove(`samples/${s.id}.wav`);
          await f.remove(`samples/${s.id}.json`);
        }
      }
    }
    sub.devices = [...new Set(sub.patches.map((r) => r.device))];
    await this.saveSub(sub);
    this.emit();
  }

  async movePatch(fromId, toId, id) { return this.movePatches(fromId, toId, [id]); }

  /** Move patches (with their samples) to another sub-library. */
  async movePatches(fromId, toId, ids, { onProgress } = {}) {
    if (fromId === toId) return;
    const src = this.folderOf(fromId);
    const patches = [];
    const samples = new Map();
    for (const id of ids) {
      const p = await this.getPatch(fromId, id);
      if (!p) continue;
      patches.push(p);
      for (const s of p.samples || []) {
        if (samples.has(s.id)) continue;
        const bytes = await src.readBytes(`samples/${s.id}.wav`);
        if (bytes) samples.set(s.id, { id: s.id, bytes, info: JSON.parse((await src.readText(`samples/${s.id}.json`)) || '{}') });
      }
    }
    await this.addPatches(toId, patches, [...samples.values()], { onProgress });
    await this.deletePatches(fromId, patches.map((p) => p.id));
  }

  async getSample(subId, sampleId) {
    const f = this.folderOf(subId);
    const bytes = await f.readBytes(`samples/${sampleId}.wav`);
    if (!bytes) return null;
    return { bytes, info: JSON.parse((await f.readText(`samples/${sampleId}.json`)) || '{}') };
  }

  /** Index rows of every reachable sub-library, each with its sub id: [{sub, ...row}]. */
  async allRows() {
    const out = [];
    for (const s of this.subs()) {
      try { for (const r of (await this.getSub(s.id)).patches) out.push({ sub: s.id, subName: s.name, ...r }); } catch { /* not reachable */ }
    }
    return out;
  }
}

/** Copy one sub-library's files (sublibrary.json, patches/, samples/) between folders. */
async function copySub(from, to) {
  const t = await from.readText('sublibrary.json');
  if (t === null) return;
  await to.writeText('sublibrary.json', t);
  for (const dir of ['patches', 'samples']) {
    for (const name of await from.list(dir)) {
      const b = await from.readBytes(`${dir}/${name}`);
      if (b) await to.writeBytes(`${dir}/${name}`, b);
    }
  }
}

/** A sub-folder of a folder backend. */
function prefixed(folder, prefix) {
  const p = (x) => (x ? `${prefix}/${x}` : prefix);
  return {
    readText: (x) => folder.readText(p(x)), writeText: (x, s) => folder.writeText(p(x), s),
    readBytes: (x) => folder.readBytes(p(x)), writeBytes: (x, b) => folder.writeBytes(p(x), b),
    remove: (x) => folder.remove(p(x)), list: (x) => folder.list(p(x)),
  };
}
