// Device objects <-> Head Library patches (js/core/mainlib/format.js).
//
// patchFromObject: an object's data (a patch, performance, program...) becomes a patch file with
// every setting by its label and shown value, the raw values, the exact data (for a bit-exact
// restore on the same model) and, when the definition has a translator, the shared synth model.
// objectFromPatch: the reverse, natively for the same model, or through the shared model
// (obj.fromCommon) for another model of the same family.
//
// Definition hooks used here (all optional):
//   def.deviceIds: [catalog ids that share this definition's native format]
//   obj.category(data) -> category id (core/mainlib/categories.js)
//   obj.toCommon(data) -> shared model;  obj.fromCommon(common, base) -> {data, report}
//   obj.patchKinds: [patch kinds this object accepts] (default: [obj.key]; patch and program,
//                   performance and combination are taken as the same, see kindsOf)
//   obj.setName(data, name): write a name (a translated patch keeps the Head Library patch's name)
//   obj.setCategory(data, categoryId): write the device's nearest category

import { readParam, formatParam } from '../core/model/memmap.js';
import { makePatch, toBase64, fromBase64 } from '../core/mainlib/format.js';
import { categorize } from '../core/mainlib/categories.js';
import { deviceTypes } from '../core/mainlib/devicetypes.js';

/** Label -> shown value for every parameter, grouped (section and group). */
export function settingsOf(obj, data, ctx = {}) {
  const out = {};
  const sections = new Map((obj.sections || []).map((s) => [s.key, s.label]));
  const first = obj.sections?.[0]?.key;
  const multi = sections.size > 1;
  for (const p0 of obj.params || []) {
    if (p0.hidden || p0.kind === 'char') continue;
    let p = p0;
    try { if (p0.dynamic) p = { ...p0, ...p0.dynamic(data, ctx) }; } catch { /* needs device context */ }
    if (p.hidden) continue;
    let v;
    try { v = readParam(data, p); } catch { continue; }
    const shown = p.options?.find(([x]) => x === v)?.[1] ?? formatParam(p, v);
    const group = `${multi && p.section && p.section !== first && sections.get(p.section) ? `${sections.get(p.section)} / ` : ''}${p.group || 'Settings'}`;
    const g = (out[group] ??= {});
    let label = p.label || p.key;
    if (label in g) label = `${label} (${p.key})`;
    g[label] = String(shown);
  }
  return out;
}

/** Raw parameter values by key. */
export function paramsOf(obj, data) {
  const out = {};
  for (const p of obj.params || []) { try { out[p.key] = readParam(data, p); } catch { /* skip */ } }
  return out;
}

/** A Head Library patch from an object's data. meta: {name, source: {file, bank, slot}, tags}. */
export function patchFromObject(entry, def, obj, data, meta = {}) {
  const d = Uint8Array.from(data);
  const name = (meta.name || obj.name?.(d) || entry.model).trim() || entry.model;
  let devCat = null;
  try { devCat = obj.category?.(d) ?? null; } catch { /* none */ }
  let common = null;
  try { common = obj.toCommon?.(d) ?? null; } catch { /* no translation */ }
  return makePatch({
    name, kind: obj.key,
    device: { id: entry.id, maker: entry.maker, model: entry.model, types: deviceTypes(entry) },
    category: categorize(name, devCat),
    tags: meta.tags || [],
    source: meta.source || {},
    settings: settingsOf(obj, d),
    params: paramsOf(obj, d),
    native: { object: obj.key, bytes: toBase64(d) },
    common,
  });
}

/** A patch holding SysEx that no editor object reads (motions, sequences, all-data dumps): kept as is. */
export function dataPatch(entry, label, msgs, meta = {}) {
  const bytes = new Uint8Array(msgs.reduce((n, m) => n + m.length, 0));
  let o = 0;
  for (const m of msgs) { bytes.set(m, o); o += m.length; }
  return makePatch({
    name: meta.name || label, kind: 'data',
    device: { id: entry.id, maker: entry.maker, model: entry.model, types: deviceTypes(entry) },
    category: { id: 'none', label: 'No category', source: 'none' },
    source: meta.source || {},
    settings: { Data: { Contents: label, Messages: String(msgs.length), Bytes: String(bytes.length) } },
    native: { object: null, syx: toBase64(bytes) },
  });
}

/** Kinds that name the same thing on different makers' instruments (a Korg "program", a Yamaha
 *  "voice" and an Access "single" are a Roland "patch"; a "combination" or a "multi" is a "performance"). */
const SAME_KIND = [['patch', 'program', 'voice', 'single'], ['performance', 'combination', 'multi']];
/** Patch kinds an object takes: its own (obj.patchKinds or obj.key) and their equivalents. */
export const kindsOf = (obj) => [...new Set((obj.patchKinds || [obj.key]).flatMap((k) => SAME_KIND.find((g) => g.includes(k)) || [k]))];

/** How (if at all) `patch` can be loaded into object `obj` of device `entry`: 'native' | 'translate' | null. */
export function loadMode(entry, def, obj, patch) {
  const kinds = kindsOf(obj);
  if (!kinds.includes(patch.kind)) return null;
  const native = patch.device.id === entry.id || (def.deviceIds || []).includes(patch.device.id);
  if (native && patch.native?.bytes) return 'native';
  if (patch.common && obj.fromCommon) return 'translate';
  return null;
}

/** {data, mode, report: {mapped, approximated, dropped}} for loading `patch` into `obj`, or null. */
export function objectFromPatch(entry, def, obj, patch) {
  const mode = loadMode(entry, def, obj, patch);
  if (mode === 'native') {
    const raw = fromBase64(patch.native.bytes);
    const data = obj.init();
    data.set(raw.subarray(0, data.length), 0);
    const report = { mapped: ['all settings (native data)'], approximated: [], dropped: raw.length > data.length ? [`${raw.length - data.length} bytes beyond this object`] : [] };
    return { data, mode, report };
  }
  if (mode === 'translate') {
    const { data, report } = obj.fromCommon(patch.common, obj.init());
    // the shared model carries no name: the patch's own (obj.setName(data, name) when the object has one)
    if (obj.setName && patch.name) obj.setName(data, patch.name);
    if (obj.setCategory && patch.category?.id) obj.setCategory(data, patch.category.id);
    return { data, mode, report };
  }
  return null;
}

/** The SysEx of a 'data' patch. */
export function dataMessages(patch) { return patch.native?.syx ? fromBase64(patch.native.syx) : new Uint8Array(0); }
