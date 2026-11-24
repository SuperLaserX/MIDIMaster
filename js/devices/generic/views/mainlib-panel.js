// The Main Library panel of a device's Librarian: browse the registered sub-libraries, load a
// patch into this device's editor (exactly for the same model, translated for another model of a
// family with a translator), store it into a memory slot, send stored SysEx, and add the editor's
// data or a recorded dump to the Main Library.

import { h, clear, toast, dialog } from '../../../core/ui/dom.js';
import { splitSysex } from '../../../core/midi/describe.js';
import { importSysex } from '../../../core/mainlib/importers.js';
import { CATEGORY_LABEL } from '../../../core/mainlib/categories.js';
import { patchFromObject, objectFromPatch, dataPatch, dataMessages } from '../../patches.js';
import { asList } from '../objects.js';
import { translationView, filterRows, filterBar, chooseSub, folderStatus, kindLabel, settingsView } from '../../../core/ui/mainlib.js';

const PAGE = 200;

/**
 * g: the device module; sendMessages(title, msgs): the Librarian's sender (progress, pacing).
 * Returns {el, addMessages(name, msgs), destroy()}.
 */
export function mainLibraryPanel(g, { sendMessages }) {
  const el = h('div.card.col.ml-panel');
  const st = { lib: null, rows: [], f: { q: '', sub: '', device: '', type: '', category: '', kind: '' }, onlyLoadable: true, limit: PAGE, open: null, destroyed: false };
  const def = g.def;
  const same = (id) => id === g.entry.id || (def?.deviceIds || []).includes(id);
  let off = null;
  const guard = (fn, context) => async (...a) => { try { await fn(...a); } catch (err) { g.error(err, context); } };

  const shell = g.host.shell;
  shell.mainLibrary().then((lib) => {
    if (st.destroyed) return;
    st.lib = lib;
    off = lib.on(() => refresh());
    refresh();
  }).catch((err) => { clear(el).append(h('h2', 'Main Library'), h('div.notice.bad', `The Main Library could not be opened: ${err.message}`)); });

  async function refresh() {
    st.rows = await st.lib.allRows();
    render();
  }

  /** How row `r` fits this device: {obj, mode: 'native'|'translate'} | {mode: 'data'} | null. */
  function fit(r) {
    if (r.kind === 'data') return same(r.device) ? { mode: 'data' } : null;
    for (const obj of def?.objects || []) {
      if (!(obj.patchKinds || [obj.key]).includes(r.kind)) continue;
      if (same(r.device) && r.native !== false) return { obj, mode: 'native' };
      if (r.hasCommon && obj.fromCommon) return { obj, mode: 'translate' };
    }
    return null;
  }

  function render() {
    const lib = st.lib;
    const subs = lib.subs();
    const base = st.onlyLoadable ? st.rows.filter((r) => fit(r)) : st.rows;
    const shown = filterRows(base, st.f);
    const page = shown.slice(0, st.limit);
    const subName = new Map(subs.map((s) => [s.id, s.name]));
    const only = h('label.row.small', h('input', { type: 'checkbox', checked: st.onlyLoadable, onchange: (e) => { st.onlyLoadable = e.target.checked; st.limit = PAGE; render(); } }), `Only what the ${g.entry.model} can load`);
    clear(el).append(
      h('div.card-head.row', h('h2.grow', 'Main Library'),
        h('button.btn.small', { title: `Save what the editor pages hold (read from the ${g.entry.model} or loaded) as Main Library patches`, onclick: guard(addEditorData, 'Add to Main Library') }, 'Add editor data...'),
        h('a.btn.small', { href: '#/library', title: 'Import files, manage sub-libraries and the library folder' }, 'Open Main Library')),
      folderStatus(lib, 0),
      subs.length ? null : h('div.small.muted', 'No sub-libraries yet. Import files on the Main Library page, or add this device\'s data with "Add editor data" or a dump\'s "Add to Main Library".'),
      subs.length ? h('div.row', only) : null,
      subs.length ? filterBar(base, st.f, () => { st.limit = PAGE; render(); }, { subs }) : null,
      subs.length ? (page.length ? h('div.table-wrap.ml-table', h('table.list',
        h('thead', h('tr', h('th', 'Name'), h('th', 'Category'), h('th', 'From'), h('th', 'Kind'), h('th', 'Loads as'), h('th', ''))),
        h('tbody', page.map((r) => row(r, subName))))) : h('div.empty', st.rows.length ? 'Nothing matches.' : 'The Main Library is empty.')) : null,
      shown.length > page.length ? h('button.btn.small', { onclick: () => { st.limit += PAGE * 3; render(); } }, `Show more (${shown.length - page.length} not shown)`) : null,
      st.open ? detail() : null);
  }

  function row(r, subName) {
    const m = fit(r);
    const badge = !m ? h('span.badge', 'no translator')
      : m.mode === 'native' ? h('span.badge.live', `${m.obj.label}`)
        : m.mode === 'translate' ? h('span.badge.ram', { title: `From the ${r.model} through the shared synth model` }, `${m.obj.label}, translated`)
          : h('span.badge', 'SysEx');
    const canStore = m?.obj?.slots?.store;
    return h('tr' + (st.open?.row.id === r.id && st.open?.row.sub === r.sub ? '.sel' : ''), { onclick: guard(() => openRow(r), 'Open') },
      h('td', r.name, h('div.small.muted', subName.get(r.sub) || '')),
      h('td.small', CATEGORY_LABEL[r.category] || r.category),
      h('td.small', r.model),
      h('td.small', kindLabel(r.kind)),
      h('td', badge),
      h('td.row', { onclick: (ev) => ev.stopPropagation() },
        m && m.mode !== 'data' ? h('button.btn.small.primary', { title: 'Put it in the editor (nothing is sent)', onclick: guard(() => load(r), 'Load') }, 'Load') : null,
        canStore ? h('button.btn.small', { title: `Write it into a ${g.entry.model} memory slot`, onclick: guard(() => storeTo(r), 'Store') }, 'Store to...') : null,
        m?.mode === 'data' ? h('button.btn.small', { title: `Send the stored SysEx to the ${g.entry.model}`, onclick: guard(() => sendData(r), 'Send') }, 'Send') : null));
  }

  function detail() {
    const { row: r, patch } = st.open;
    return h('div.card.col',
      h('div.card-head.row', h('h2.grow', patch.name, h('span.small.muted', `  ${patch.device.model}, ${kindLabel(patch.kind)}`)), h('button.btn.small', { onclick: () => { st.open = null; render(); } }, 'Close')),
      settingsView(patch, { open: 2 }),
      r.samples ? h('div.small.muted', `${r.samples} sample(s): play them on the Main Library page.`) : null);
  }

  async function openRow(r) {
    const patch = await st.lib.getPatch(r.sub, r.id);
    if (!patch) { toast('That patch file is not reachable. Reconnect the library folder.', 'warn'); return; }
    st.open = { row: r, patch };
    render();
  }

  /** The patch converted for this device: {patch, obj, data, mode, report} or null. */
  async function convert(r) {
    const m = fit(r);
    const patch = await st.lib.getPatch(r.sub, r.id);
    if (!patch) { toast('That patch file is not reachable. Reconnect the library folder.', 'warn'); return null; }
    const res = m?.obj ? objectFromPatch(g.entry, def, m.obj, patch) : null;
    if (!res) { toast(`The ${g.entry.model} cannot load "${patch.name}".`, 'warn'); return null; }
    return { patch, obj: m.obj, ...res };
  }

  const lossy = (rep) => rep.approximated.length || rep.dropped.length;

  async function load(r) {
    const c = await convert(r);
    if (!c) return;
    if (c.mode === 'translate' && lossy(c.report)) {
      const ok = await dialog(`Load "${c.patch.name}" from the ${c.patch.device.model}`, translationView(c.report, c.mode), [
        { label: 'Cancel', value: false }, { label: 'Load', value: true, primary: true }]);
      if (!ok) return;
    }
    g.setObjectData(c.obj.key, c.data);
    toast(`"${c.patch.name}" is in the ${c.obj.page || c.obj.label} page${c.mode === 'translate' ? ` (translated from the ${c.patch.device.model})` : ''}. Nothing was sent: use its send or store buttons to put it on the ${g.entry.model}.`, 'info', 6000);
    g.nav(c.obj.key);
  }

  async function storeTo(r) {
    const c = await convert(r);
    if (!c) return;
    const s = c.obj.slots;
    const banks = (typeof s.banks === 'function' ? s.banks(g.ctx) : s.banks).filter(([b]) => s.writable?.(b, g.ctx) !== false);
    if (!banks.length) { toast(`The ${g.entry.model} has no writable ${s.label || c.obj.label} bank.`, 'warn'); return; }
    const bankSel = h('select', banks.map(([v, l]) => h('option', { value: v }, l)));
    const slotSel = h('select');
    const fillSlots = () => {
      const b = Number(bankSel.value);
      const count = typeof s.count === 'function' ? s.count(b, g.ctx) : s.count;
      const names = g.slotNames?.[c.obj.key];
      clear(slotSel).append(...Array.from({ length: count }, (_, i) => {
        const n = names?.get(`${b}:${i}`);
        return h('option', { value: i }, `${s.slotLabel ? s.slotLabel(b, i) : i + 1}${n ? `  ${n}` : ''}`);
      }));
    };
    bankSel.addEventListener('change', fillSlots);
    fillSlots();
    const ok = await dialog(`Store "${c.patch.name}"`, h('div.col',
      h('div.row', h('label.field', 'Bank', bankSel), h('label.field', 'Slot', slotSel)),
      h('p.small.c-warn', 'This replaces what is in that slot on the device.'),
      c.mode === 'translate' ? translationView(c.report, c.mode) : null), [
      { label: 'Cancel', value: false }, { label: 'Store', value: true, danger: true }]);
    if (!ok) return;
    if (!g.connected) { toast('Choose the MIDI output on the Connect page first.', 'warn'); return; }
    const bank = Number(bankSel.value);
    const i = Number(slotSel.value);
    const label = s.slotLabel ? s.slotLabel(bank, i) : String(i + 1);
    await sendMessages(`"${c.patch.name}" to ${label}`, asList(s.store(bank, i, g.ctx, c.data)).map((m) => Uint8Array.from(m)));
    if (s.name) g.setSlotName(c.obj.key, bank, i, s.name(c.data) ?? '');
  }

  async function sendData(r) {
    const patch = await st.lib.getPatch(r.sub, r.id);
    if (!patch) return;
    await sendMessages(`"${patch.name}"`, splitSysex(dataMessages(patch)));
  }

  // ------------------------------------------------------------ adding to the library
  async function addEditorData() {
    const objs = (def?.objects || []).filter((o) => g.loadedKeys.has(o.key) && g.objectData[o.key] && o.params?.length);
    if (!objs.length) { toast(`Nothing is in the editor yet: read the ${g.entry.model} on the Connect page, or open a patch.`, 'warn'); return; }
    const boxes = objs.map((o) => h('input', { type: 'checkbox', checked: true }));
    const r = await dialog('Add editor data to the Main Library', h('div.col',
      h('p.small.muted', 'Each chosen object becomes one Main Library patch with all its settings.'),
      objs.map((o, i) => h('label.row', boxes[i], `${o.label}${o.name ? `: ${o.name(g.objectData[o.key])}` : ''}`))), [
      { label: 'Cancel', value: false }, { label: 'Next', value: true, primary: true }]);
    if (!r) return;
    const chosen = objs.filter((_, i) => boxes[i].checked);
    if (!chosen.length) return;
    const patches = chosen.map((o) => patchFromObject(g.entry, def, o, g.objectData[o.key], { source: { file: `${g.entry.model} editor`, slot: o.label } }));
    await addTo(patches, [], `${g.entry.model} sounds`);
  }

  /** Add SysEx messages (a recorded dump or part of one) to the Main Library. */
  async function addMessages(name, msgs) {
    if (!st.lib) { toast('The Main Library is still opening.', 'warn'); return; }
    let patches;
    // the dump came from this device: its unreadable SysEx stays its data, its sub-library is a device one
    if (def?.recognise) patches = (await importSysex(msgs, { file: name, hint: g.entry.id, device: g.entry.id })).patches;
    else patches = [dataPatch(g.entry, name, msgs, { source: { file: name } })];
    if (!patches.length) { toast('Nothing in it to add.', 'warn'); return; }
    await addTo(patches, [], name);
  }

  async function addTo(patches, samples, name) {
    const counts = {};
    for (const p of patches) counts[p.kind] = (counts[p.kind] || 0) + 1;
    const what = Object.entries(counts).map(([k, n]) => `${n} ${kindLabel(k).toLowerCase()}${n === 1 ? '' : 's'}`).join(', ');
    const sub = await chooseSub(st.lib, 'Add to the Main Library', { name, okLabel: 'Add', note: `${what}.`, device: g.entry });
    if (!sub) return;
    await st.lib.addPatches(sub, patches, samples);
    toast(`Added ${what} to "${st.lib.subs().find((s) => s.id === sub)?.name}".`, 'good');
  }

  return { el, addMessages: guard(addMessages, 'Add to Main Library'), destroy() { st.destroyed = true; off?.(); } };
}
