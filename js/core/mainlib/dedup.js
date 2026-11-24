// Duplicate patches in the Main Library.
//
//   'name'      the same name (case and spacing ignored) and kind; by default on the same device
//   'settings'  a deep scan: the same settings whatever the name. Same device: every parameter but
//               the name bytes (found by testing which bytes change obj.name()). Any model: the
//               translator's match string (common.extra.match: the bytes the family's models share),
//               else the shared synth model's semantic fields.
//
// findDuplicates() returns groups; applyDedup() deletes every member but the one kept, and points
// performance links (patch.links) at the kept patch.

import { DEF_IDS, loadDef } from '../../devices/registry.js';
import { toBase64 } from './format.js';
import { jpMatch } from '../../devices/defs/roland-jp-common.js';

export const normName = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** A 53-bit hash of a string (cyrb53), as a base-36 string. */
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** JSON with object keys sorted, so equal values give equal strings. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// Patches stored before translators wrote extra.match: what their family's models share.
const LEGACY_MATCH = { 'roland-jp': jpMatch };

/** The string equal for the same sound on any model of a family, or null. */
export function familyMatch(common) {
  const x = common?.extra;
  if (!x) return null;
  return x.match ?? LEGACY_MATCH[x.family]?.(x) ?? null;
}

// Parameter keys holding an object's name, per device and object.
const nameKeyCache = new Map();
async function nameKeys(deviceId, objectKey) {
  const k = `${deviceId}|${objectKey}`;
  if (nameKeyCache.has(k)) return nameKeyCache.get(k);
  let keys = new Set();
  try {
    const id = DEF_IDS.includes(deviceId) ? deviceId : null;
    const def = id ? await loadDef(id) : null;
    const obj = def?.objects?.find((o) => o.key === objectKey);
    if (obj?.name && obj.init) {
      const d = obj.init();
      const base = obj.name(d);
      const bytes = new Set();
      for (let i = 0; i < Math.min(d.length, 96); i++) {
        const t = Uint8Array.from(d);
        t[i] = t[i] === 0x41 ? 0x42 : 0x41;
        let n = base;
        try { n = obj.name(t); } catch { /* unreadable */ }
        if (n !== base) bytes.add(i);
      }
      keys = new Set((obj.params || []).filter((p) => p.offset !== undefined && [...Array(p.size || 1).keys()].some((j) => bytes.has(p.offset + j))).map((p) => p.key));
    }
  } catch { /* no definition */ }
  nameKeyCache.set(k, keys);
  return keys;
}

const withoutNames = (settings) => Object.fromEntries(Object.entries(settings || {}).map(([g, kv]) => [g, Object.fromEntries(Object.entries(kv).filter(([k]) => !/name/i.test(k)))]));

/**
 * The deep-scan key of a patch: equal for the same settings whatever the name.
 * opts.anyModel: match the same sound on another model (through the translator); opts.sampleHash(id)
 * -> hash of a sample's audio (for sample-only patches).
 */
export async function fingerprint(patch, { anyModel = false, sampleHash = null } = {}) {
  const kind = patch.kind;
  if (anyModel) {
    const fm = familyMatch(patch.common);
    if (fm) return `${kind}|${patch.common.extra.family}|${hash(fm)}`;
    if (patch.common) {
      const { extra, name, ...rest } = patch.common;
      return `${kind}|common|${hash(stable(rest))}`;
    }
  }
  const dev = anyModel ? '' : patch.device.id;
  const n = patch.native || {};
  if (n.syx) return `${dev}|${kind}|syx|${hash(n.syx)}`;
  if (n.objects) return `${dev}|${kind}|krz|${hash(n.objects.map((o) => `${o.type}:${o.data}`).join(','))}|${patch.samples?.length || 0}`;
  if (n.bytes && patch.params && Object.keys(patch.params).length) {
    const skip = await nameKeys(patch.device.id, n.object);
    const p = Object.fromEntries(Object.entries(patch.params).filter(([k]) => !skip.has(k)));
    return `${patch.device.id}|${kind}|params|${hash(stable(p))}`;
  }
  if (kind === 'sample' && patch.samples?.length && sampleHash) return `sample|${(await Promise.all(patch.samples.map((s) => sampleHash(s.id)))).join(',')}`;
  return `${dev}|${kind}|settings|${hash(stable(withoutNames(patch.settings)))}`;
}

/**
 * Groups of duplicates: [{key, label, members: [row + {subName, source}], keep: "sub:id", differs}],
 * members[0] (earliest sub-library, then import order; `prefer`'s device first) suggested to keep.
 * opts: sub (one sub-library id, or all), mode 'name' | 'settings', sameDevice (default true),
 * prefer (a device id), onProgress(done, total). In 'name' mode each group's members are also
 * compared by settings: `differs` is true when the same name holds different sounds.
 */
export async function findDuplicates(lib, { sub = null, mode = 'name', sameDevice = true, prefer = null, onProgress } = {}) {
  const rows = (await lib.allRows()).filter((r) => !sub || r.sub === sub);
  const keyed = new Map();
  const prints = new Map(); // "sub:id" -> settings fingerprint
  const print = async (r) => {
    const p = await lib.getPatch(r.sub, r.id);
    if (!p) return null;
    r.source = p.source;
    const sampleHash = async (id) => { const smp = await lib.getSample(r.sub, id); return smp ? hash(toBase64(smp.bytes)) : id; };
    const f = await fingerprint(p, { anyModel: !sameDevice, sampleHash });
    prints.set(`${r.sub}:${r.id}`, f);
    return f;
  };
  for (const [i, r] of rows.entries()) {
    let key;
    if (mode === 'name') {
      const n = normName(r.name);
      if (!n) continue;
      key = `${r.kind}|${sameDevice ? r.device : ''}|${n}`;
    } else {
      key = await print(r);
      onProgress?.(i + 1, rows.length);
      if (!key) continue;
    }
    if (!keyed.has(key)) keyed.set(key, []);
    keyed.get(key).push(r);
  }
  const groups = [...keyed].filter(([, m]) => m.length > 1);
  if (mode === 'name') {
    const total = groups.reduce((n, [, m]) => n + m.length, 0);
    let done = 0;
    for (const [, members] of groups) for (const r of members) { await print(r); onProgress?.(++done, total); }
  }
  return groups.map(([key, members]) => {
    if (prefer) members.sort((a, b) => (b.device === prefer) - (a.device === prefer));
    const differs = mode === 'name' && new Set(members.map((r) => prints.get(`${r.sub}:${r.id}`))).size > 1;
    return { key, label: members[0].name, members, keep: `${members[0].sub}:${members[0].id}`, differs };
  });
}

/**
 * Delete every member of each group except its `keep` ("sub:id"). Links in performances that
 * pointed at a deleted patch are moved to the kept one. Returns {deleted, relinked}.
 */
export async function applyDedup(lib, groups, { onProgress } = {}) {
  const remap = new Map(); // "sub:id" deleted -> {sub, id, name} kept
  const bySub = new Map();
  for (const g of groups) {
    const keep = g.members.find((m) => `${m.sub}:${m.id}` === g.keep) || g.members[0];
    for (const m of g.members) {
      if (m === keep) continue;
      remap.set(`${m.sub}:${m.id}`, { sub: keep.sub, id: keep.id, name: keep.name });
      if (!bySub.has(m.sub)) bySub.set(m.sub, []);
      bySub.get(m.sub).push(m.id);
    }
  }
  let done = 0;
  for (const [sub, ids] of bySub) {
    await lib.deletePatches(sub, ids);
    done += ids.length;
    onProgress?.(done, remap.size);
  }
  // performances whose linked patches were deleted
  let relinked = 0;
  for (const r of await lib.allRows()) {
    if (!r.links && r.kind !== 'performance') continue;
    const p = await lib.getPatch(r.sub, r.id);
    if (!p?.links?.length) continue;
    let changed = false;
    for (const l of p.links) {
      const to = remap.get(`${l.sub || r.sub}:${l.id}`);
      if (!to) continue;
      l.id = to.id;
      l.name = to.name;
      if (to.sub !== r.sub) l.sub = to.sub; else delete l.sub;
      changed = true;
    }
    if (changed) { await lib.updatePatch(r.sub, p); relinked++; }
  }
  return { deleted: remap.size, relinked };
}
