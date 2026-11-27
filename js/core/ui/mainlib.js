// Head Library pieces shared by the global page (js/shell/mainlibrary.js) and the Head Library
// panel of a device's Branch Library: a patch's settings, import and translation reports, sample
// playback, the patch filters and a sub-library chooser.

import { h, toast, dialog } from './dom.js';
import { CATEGORIES, CATEGORY_LABEL } from '../mainlib/categories.js';
import { ALL_TYPES } from '../mainlib/devicetypes.js';
import { DEF_IDS, DEVICES, loadDef, getDevice } from '../../devices/registry.js';
import { niceName, deviceRef } from '../mainlib/format.js';
import { loadMode } from '../../devices/patches.js';

const KIND_LABELS = { patch: 'Patch', performance: 'Performance', program: 'Program', system: 'System', data: 'Data', sample: 'Sample', rhythm: 'Rhythm', motion: 'Motion', combination: 'Combination', global: 'Global', keymap: 'Keymap', setup: 'Setup' };
export const kindLabel = (k) => KIND_LABELS[k] || (k ? k[0].toUpperCase() + k.slice(1) : '');
const plural = (n, word) => `${n} ${word.toLowerCase()}${n === 1 ? '' : 's'}`;

/** A patch's settings: one collapsible block per group, label and shown value. */
export function settingsView(patch, { open = 3 } = {}) {
  const groups = Object.entries(patch.settings || {});
  if (!groups.length) return h('div.small.muted', 'No settings stored.');
  return h('div.ml-settings', groups.map(([g, kv], i) => h('details', { open: i < open },
    h('summary', g, h('span.small.muted', ` ${Object.keys(kv).length}`)),
    h('div.ml-kv', Object.entries(kv).flatMap(([k, v]) => [h('span.muted', k), h('span', String(v))])))));
}

/** The report of an import: what each file held, per device, and what was left out. */
export function importReportView(report) {
  if (!report?.length) return null;
  return h('div.table-wrap.ml-report', h('table.list',
    h('thead', h('tr', h('th', 'File'), h('th', 'Read as'), h('th', 'Contents'), h('th', 'Note'))),
    h('tbody', report.map((e) => h('tr',
      h('td.small', e.file || ''),
      h('td', e.device || ''),
      h('td.small', Object.entries(e.counts || {}).filter(([, n]) => n).map(([k, n]) => plural(n, kindLabel(k))).join(', ')),
      h('td.small' + (e.error ? '.c-bad' : '.muted'), e.error || e.note || ''))))));
}

/** What a translation kept, approximated and left out. */
export function translationView(report, mode) {
  if (!report) return null;
  const list = (title, items, cls) => (items?.length ? h('div.col', h('b' + cls, `${title} (${items.length})`), h('ul.ml-list', items.map((x) => h('li.small', x)))) : null);
  return h('div.col.ml-translation',
    h('div.small.muted', mode === 'native' ? 'Same model: the patch data is loaded exactly as stored.' : 'Another model: the settings went through the shared synth model.'),
    list('Mapped', report.mapped, ''), list('Approximated', report.approximated, '.c-warn'), list('Left out', report.dropped, '.c-bad'));
}

export function categorySelect(value, onchange) {
  const sel = h('select', { onchange: () => onchange(sel.value) }, CATEGORIES.map(([id, label]) => h('option', { value: id, selected: id === value }, label)));
  return sel;
}

export const categoryOf = (id, source = 'manual') => ({ id, label: CATEGORY_LABEL[id] || id, source });

// ------------------------------------------------------------ samples
let playing = null;
/** Play one of a patch's samples (WAV in the sub-library). */
export async function playSample(lib, subId, sample) {
  if (playing) { playing.pause(); playing = null; }
  const s = await lib.getSample(subId, sample.id);
  if (!s) { toast(`The audio of "${sample.name || sample.id}" is not reachable. Reconnect the library folder.`, 'warn'); return; }
  const url = URL.createObjectURL(new Blob([s.bytes], { type: 'audio/wav' }));
  const a = new Audio(url);
  a.onended = () => URL.revokeObjectURL(url);
  playing = a;
  try { await a.play(); } catch (err) { toast(`Cannot play it: ${err.message}`, 'warn'); }
}

export function samplesView(lib, subId, patch) {
  if (!patch.samples?.length) return null;
  return h('div.col',
    h('b', `Samples (${patch.samples.length})`),
    h('div.ml-samples', patch.samples.map((s) => h('div.row',
      h('button.btn.small', { title: 'Play', onclick: () => playSample(lib, subId, s) }, '▶'),
      h('span.grow', s.name || s.id),
      s.rate ? h('span.small.muted', `${s.rate} Hz`) : null))));
}

// ------------------------------------------------------------ where a patch can go
let defsPromise = null;
/** Every mapped device definition: [{id, entry, def}] (shared definitions listed per device). */
export function mappedDefs() {
  defsPromise ??= (async () => {
    const out = [];
    for (const id of DEF_IDS) {
      try { const def = await loadDef(id); if (def) out.push({ id, entry: getDevice(id), def }); } catch { /* skip */ }
    }
    return out;
  })();
  return defsPromise;
}

/** Devices (and their object) a patch can be loaded into: [{id, model, object, label, mode}]. */
export async function targetsFor(patch) {
  const out = [];
  for (const { id, entry, def } of await mappedDefs()) {
    for (const obj of def.objects || []) {
      const mode = loadMode(entry, def, obj, patch);
      if (mode) { out.push({ id, model: entry.model, object: obj.key, label: obj.label, mode }); break; }
    }
  }
  return out;
}

// ------------------------------------------------------------ filters
export function filterRows(rows, f) {
  const words = (f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.sub && r.sub !== f.sub) return false;
    if (f.device && r.device !== f.device) return false;
    if (f.type && !(r.types || []).includes(f.type)) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (!words.length) return true;
    const hay = `${r.name} ${r.model} ${CATEGORY_LABEL[r.category] || ''} ${(r.tags || []).join(' ')} ${r.subName || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Filter controls over `rows` (which decide the choices); onChange() after every change. */
export function filterBar(rows, f, onChange, { subs = null } = {}) {
  const opt = (v, l, cur) => h('option', { value: v, selected: v === cur }, l);
  const uniq = (fn) => [...new Map(rows.map((r) => [fn(r)[0], fn(r)[1]])).entries()].filter(([v]) => v).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const sel = (key, all, choices) => {
    const s = h('select', { onchange: () => { f[key] = s.value; onChange(); } }, opt('', all, f[key]), choices.map(([v, l]) => opt(v, l, f[key])));
    return s;
  };
  const q = h('input', { type: 'search', placeholder: 'Search names, tags...', value: f.q || '', oninput: () => { f.q = q.value; onChange(); } });
  const types = ALL_TYPES.filter((t) => rows.some((r) => (r.types || []).includes(t)));
  return h('div.row.ml-filters', q,
    subs ? sel('sub', 'All sub-libraries', subs.map((s) => [s.id, subLabel(s)])) : null,
    sel('device', 'All devices', uniq((r) => [r.device, r.model])),
    sel('type', 'All device types', types.map((t) => [t, t])),
    sel('category', 'All categories', CATEGORIES.filter(([id]) => rows.some((r) => r.category === id)).map(([id, l]) => [id, l])),
    sel('kind', 'All kinds', uniq((r) => [r.kind, kindLabel(r.kind)])));
}

// ------------------------------------------------------------ devices and sub-libraries
/** A sub-library's name with its device: "Alan M set (JP-8000)". */
export const subLabel = (s) => `${s.name}${s.device?.model ? ` (${s.device.model})` : ''}`;

/**
 * A device picker: devices with an editor first, then every catalog device by maker.
 * first: [value, label] of a leading option (e.g. ['', 'Detect from the data']).
 */
export function deviceSelect(value = '', { first = ['', 'No device (mixed)'], onchange } = {}) {
  const mapped = new Set(DEF_IDS);
  const byMaker = new Map();
  for (const d of DEVICES) {
    if (mapped.has(d.id) || !d.openable) continue;
    if (!byMaker.has(d.maker)) byMaker.set(d.maker, []);
    byMaker.get(d.maker).push(d);
  }
  const opt = (d) => h('option', { value: d.id, selected: d.id === value }, `${d.maker} ${d.model}`);
  const sel = h('select.ml-dev', { onchange: () => onchange?.(sel.value) },
    first ? h('option', { value: first[0], selected: !value }, first[1]) : null,
    h('optgroup', { label: 'Devices with an editor' }, DEF_IDS.map(getDevice).filter(Boolean).map(opt)),
    [...byMaker].sort((a, b) => a[0].localeCompare(b[0])).map(([maker, list]) => h('optgroup', { label: maker }, list.map(opt))));
  return sel;
}

/**
 * Ask for a sub-library: one of the registered ones or (allowNew) a new one with a name.
 * device: the catalog entry the data comes from; a new sub-library gets it as its device, and that
 * device's sub-libraries are listed first. Returns the sub-library id, or null.
 */
export async function chooseSub(lib, title, { allowNew = true, name = '', okLabel = 'OK', note = null, device = null } = {}) {
  const subs = lib.subs().sort((a, b) => (b.device?.id === device?.id && !!device) - (a.device?.id === device?.id && !!device));
  const sel = h('select', [
    ...subs.map((s) => h('option', { value: s.id }, subLabel(s))),
    allowNew ? h('option', { value: '', selected: !subs.length }, 'New sub-library...') : null,
  ]);
  const nameInp = h('input', { type: 'text', value: niceName(name) || 'New sub-library' });
  const nameRow = h('label.field', `Name of the new sub-library${device ? ` (a ${device.model} sub-library)` : ''}`, nameInp);
  const sync = () => { nameRow.hidden = sel.value !== ''; };
  sel.addEventListener('change', sync);
  sync();
  const r = await dialog(title, h('div.col', note ? h('p.small.muted', note) : null, h('label.field', 'Sub-library', sel), allowNew ? nameRow : null), [
    { label: 'Cancel', value: null },
    { label: okLabel, primary: true, value: () => ({ id: sel.value, name: nameInp.value.trim() }) },
  ]);
  if (!r) return null;
  if (r.id) return r.id;
  if (!allowNew) return null;
  return lib.createSub(r.name || niceName(name) || 'New sub-library', { device: deviceRef(device) });
}

/** One line telling where the library is kept, for headers. */
export function folderStatus(lib, pending) {
  if (lib.state === 'connected') return h('span.small', 'Folder: ', h('b', lib.folderName), pending ? h('span.c-warn', ` (${pending} file(s) waiting)`) : null);
  if (lib.state === 'disconnected') return h('span.small.c-warn', `Folder "${lib.folderName}" needs permission again${pending ? `; ${pending} change(s) wait for it` : ''}.`);
  return h('span.small.muted', 'No folder chosen yet: the library is kept in this browser.');
}

