// Head Library file formats (version 1). See docs/HEAD_LIBRARY.md.
//
//   mainlibrary.json  {format: 'midimaster-library', version, sublibraries: [{id, name, path | external}]}
//   sublibrary.json   {format: 'midimaster-sublibrary', version, id, name, created, notes, patches: [index rows]}
//   patches/<id>.json a patch (below)        samples/<id>.wav + samples/<id>.json (sample info)
//
// Patch: {format: 'midimaster-patch', version, id, name, kind, device: {id, maker, model, types},
//         category: {id, label, source}, tags, source: {file, bank, slot, imported},
//         settings: {group: {label: shown value}}, params: {key: raw value},
//         native: {object, bytes (base64)}, common?, samples: [{id, file, name, root, loop}], notes}

export const PATCH_FORMAT = 'midimaster-patch';
export const SUB_FORMAT = 'midimaster-sublibrary';
export const MAIN_FORMAT = 'midimaster-library';
export const VERSION = 1;

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// base64 without Buffer (browser and Node alike)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1]; const c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? '=' : B64[c & 63]);
  }
  return s;
}
export function fromBase64(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0));
    const v = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length && i + 2 < clean.length) out[o++] = (v >> 8) & 255;
    if (o < out.length && i + 3 < clean.length) out[o++] = v & 255;
  }
  return out;
}

/** A patch file with defaults filled in. */
export function makePatch(p) {
  return {
    format: PATCH_FORMAT, version: VERSION, id: p.id || newId(), name: p.name || 'Untitled', kind: p.kind || 'patch',
    device: p.device, category: p.category || { id: 'none', label: 'No category', source: 'none' }, tags: p.tags || [],
    source: { imported: new Date().toISOString(), ...(p.source || {}) },
    settings: p.settings || {}, params: p.params || {}, native: p.native || null,
    ...(p.common ? { common: p.common } : {}), samples: p.samples || [], notes: p.notes || '',
    ...(p.links?.length ? { links: p.links } : {}),
  };
}

export function isPatch(o) { return o && o.format === PATCH_FORMAT && o.id && o.device?.id; }

/** The row kept for a patch in sublibrary.json (enough to list and filter without opening it). */
export function indexRow(p) {
  return { id: p.id, name: p.name, kind: p.kind, device: p.device.id, model: p.device.model, types: p.device.types, category: p.category.id, tags: p.tags, samples: p.samples.length, native: !!p.native?.bytes, hasCommon: !!p.common, links: p.links?.length || 0 };
}

export function makeSub(name, extra = {}) {
  return { format: SUB_FORMAT, version: VERSION, id: newId(), name, created: new Date().toISOString(), notes: '', patches: [], ...extra };
}

/** A default name from a file, folder or dump name: underscores become spaces. */
export function niceName(s) { return String(s ?? '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim(); }

/** {id, maker, model} of a catalog entry, as kept on a sub-library. */
export const deviceRef = (e) => (e ? { id: e.id, maker: e.maker, model: e.model } : null);

/** A safe file or folder name. */
export function fileName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
}
