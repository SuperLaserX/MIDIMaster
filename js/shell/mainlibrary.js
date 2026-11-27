// Head Library: patches of every device in one place, as readable JSON in a folder the user picks
// (js/core/mainlib/). Sub-libraries are created by importing files (.syx .mid .krz .wav .json and
// disk images .iso .bin/.cue .img), or registered from another folder; any device's Branch Library can
// open them, and a patch loads into another model when a translator exists.

import { h, clear, toast, confirmDialog, dialog, downloadBlob, pickFiles, safeFileName } from '../core/ui/dom.js';
import { importFiles, importSysex, IMPORTABLE } from '../core/mainlib/importers.js';
import { fromBase64, niceName, deviceRef } from '../core/mainlib/format.js';
import { findDuplicates, applyDedup } from '../core/mainlib/dedup.js';
import { splitSysex } from '../core/midi/describe.js';
import { dataMessages } from '../devices/patches.js';
import { CATEGORY_LABEL } from '../core/mainlib/categories.js';
import { loadDef, getDevice } from '../devices/registry.js';
import { sendToDevice, fitFor } from '../devices/generic/sendto.js';
import {
  settingsView, importReportView, categorySelect, categoryOf, samplesView, targetsFor, filterRows, filterBar,
  chooseSub, folderStatus, kindLabel, subLabel, deviceSelect,
} from '../core/ui/mainlib.js';

const STORE = 'midimaster.mainlibFilter';
const SUB_STORE = 'midimaster.mainlibSubSearch';
const SUB_SORTS = [
  ['name', 'Name'], ['device', 'Device'], ['count', 'Most patches'], ['matches', 'Most matches'],
  ['newest', 'Newest first'], ['oldest', 'Oldest first'],
];
const PAGE = 300;
const canPickFolders = typeof window !== 'undefined' && !!window.showDirectoryPicker;

export function mainLibraryView(root, shell) {
  let saved = {};
  let savedSubs = {};
  try { saved = JSON.parse(sessionStorage.getItem(STORE) || '{}'); } catch { /* ignore */ }
  try { savedSubs = JSON.parse(sessionStorage.getItem(SUB_STORE) || '{}'); } catch { /* ignore */ }
  const st = {
    lib: null, rows: [], subInfo: new Map(), pending: 0,
    f: { q: '', sub: '', device: '', type: '', category: '', kind: '', ...saved },
    // the sub-library search: patch criteria looked for in every sub-library, and the list order
    sf: { q: '', device: '', type: '', category: '', kind: '', ...(savedSubs.sf || {}) },
    subSort: savedSubs.sort || 'name',
    open: null, // {row, patch}
    checked: new Set(), // `${sub}:${id}`
    limit: PAGE, busy: false, report: null, destroyed: false,
    subChecked: new Set(), // sub-libraries ticked for merging
    importDevice: '', // device the imported files are from ('' = detect)
    dedup: null, // {sub, mode, sameDevice, prefer, groups, running}
  };
  const saveFilter = () => { try { sessionStorage.setItem(STORE, JSON.stringify(st.f)); } catch { /* ignore */ } };
  const saveSubSearch = () => { try { sessionStorage.setItem(SUB_STORE, JSON.stringify({ sf: st.sf, sort: st.subSort })); } catch { /* ignore */ } };
  const keyOf = (r) => `${r.sub}:${r.id}`;

  const folderBox = h('div.card.col');
  const subsBox = h('div.card.col');
  const importBox = h('div.card.col');
  const browseBox = h('div.card.col');
  const dedupBox = h('div.card.col', { hidden: true });
  const detailBox = h('div.ml-detail', { hidden: true });

  root.append(
    h('h1', 'Head Library'),
    h('div.sub', 'Patches from every device in one place. A patch can be sent to its own device, or to another model through its translator.'),
    folderBox, subsBox, importBox, dedupBox,
    h('div.row.editor-split', h('div.grow', browseBox), detailBox));

  // ------------------------------------------------------------ loading
  let off = null;
  shell.mainLibrary().then((lib) => {
    if (st.destroyed) return;
    st.lib = lib;
    off = lib.on(() => refresh());
    refresh();
  }).catch((err) => { clear(folderBox).append(h('div.notice.bad', `The Head Library could not be opened: ${err.message}`)); });

  let refreshing = null;
  async function refresh() {
    if (refreshing) { refreshing.again = true; return; }
    refreshing = { again: false };
    try {
      const lib = st.lib;
      st.pending = await lib.pendingCount();
      st.rows = [];
      st.subInfo = new Map();
      for (const s of lib.subs()) {
        let sub = null;
        try { sub = await lib.getSub(s.id); } catch { /* not reachable */ }
        const rows = (sub?.patches || []).map((r) => ({ sub: s.id, subName: s.name, ...r }));
        st.rows.push(...rows);
        st.subInfo.set(s.id, { count: rows.length, devices: [...new Set(rows.map((r) => r.model))], reachable: !!sub, created: sub?.created || '' });
      }
      if (st.f.sub && !st.subInfo.has(st.f.sub)) st.f.sub = '';
      for (const k of [...st.checked]) if (!st.rows.some((r) => keyOf(r) === k)) st.checked.delete(k);
      for (const k of [...st.subChecked]) if (!st.subInfo.has(k)) st.subChecked.delete(k);
      if (st.open && !st.rows.some((r) => keyOf(r) === keyOf(st.open.row))) st.open = null;
      renderFolder(); renderSubs(); renderImport(); renderDedup(); renderBrowse(); renderDetail();
      st.refreshErrors = 0;
    } catch (err) {
      // the library changed while it was being read (e.g. a merge removing a sub-library): read it again
      st.refreshErrors = (st.refreshErrors || 0) + 1;
      if (st.refreshErrors <= 3) refreshing.again = true; else shell.error(err, 'Head Library');
    } finally {
      const again = refreshing.again;
      refreshing = null;
      if (again && !st.destroyed) refresh();
    }
  }

  const guard = (fn, context) => async (...a) => { try { await fn(...a); } catch (err) { shell.error(err, context); } };

  // ------------------------------------------------------------ folder
  function renderFolder() {
    const lib = st.lib;
    const btns = [];
    if (!canPickFolders) {
      clear(folderBox).append(h('h2', 'Library folder'), h('div.notice.warn', 'This browser cannot save to a folder, so the library is kept in this browser only. Use Chrome or Edge to keep it in a folder of your choice.'));
      return;
    }
    if (lib.state === 'none') btns.push(h('button.btn.primary', { onclick: guard(chooseFirst, 'Library folder') }, 'Choose library folder'));
    if (lib.state === 'disconnected') btns.push(h('button.btn.primary', { onclick: guard(reconnect, 'Reconnect') }, 'Reconnect folder'));
    if (lib.state !== 'none') btns.push(h('button.btn', { onclick: guard(changeLocation, 'Library folder') }, 'Change location...'));
    else if (st.pending) btns.push(h('span.small.muted', `${st.pending} file(s) will be written into it.`));
    clear(folderBox).append(
      h('div.card-head.row', h('h2.grow', 'Library folder'), ...btns),
      folderStatus(lib, st.pending),
      h('div.small.muted', lib.state === 'none'
        ? 'Choose (or create) a folder for the Head Library. Every patch is saved there as a JSON file you can read, back up or share; samples as WAV files.'
        : 'Changes are saved to this folder as you make them.'));
  }

  async function chooseFirst() {
    if (await st.lib.chooseFolder('merge')) toast(`The Head Library is in "${st.lib.folderName}".`, 'good');
  }

  async function reconnect() {
    if (await st.lib.reconnect()) toast('Folder reconnected; pending changes are written.', 'good');
    else toast('The browser did not allow the folder.', 'warn');
  }

  async function changeLocation() {
    const how = await dialog('Change location', h('div.col',
      h('p', 'Move the library to another folder, or open a Head Library that is already in another folder.'),
      h('p.small.muted', 'Moving copies the library to the new folder and leaves the old one as it is.')), [
      { label: 'Cancel', value: null },
      { label: 'Open a library there', value: 'open' },
      { label: 'Move the library there', value: 'copy', primary: true },
    ]);
    if (!how) return;
    if (how === 'copy' && st.lib.state !== 'connected' && !(await st.lib.reconnect())) { toast('Allow the current folder first, so its files can be copied.', 'warn'); return; }
    setBusy(how === 'copy' ? 'Copying the library...' : 'Opening the library...');
    try {
      if (await st.lib.chooseFolder(how)) toast(how === 'copy' ? `The library is now in "${st.lib.folderName}".` : `Opened the library in "${st.lib.folderName}".`, 'good');
    } finally { setBusy(null); }
  }

  // ------------------------------------------------------------ sub-libraries
  /** True when the sub-library search has any criterion. */
  const searching = () => Object.values(st.sf).some(Boolean);

  /** The sub-libraries in the chosen order; while searching, only those with matching patches. */
  function listedSubs() {
    const info = (s) => st.subInfo.get(s.id) || {};
    const matches = new Map();
    if (searching()) for (const r of filterRows(st.rows, st.sf)) matches.set(r.sub, (matches.get(r.sub) || 0) + 1);
    let list = st.lib.subs();
    if (searching()) list = list.filter((s) => matches.get(s.id));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      device: (a, b) => (a.device?.model || '\uffff').localeCompare(b.device?.model || '\uffff') || by.name(a, b),
      count: (a, b) => (info(b).count || 0) - (info(a).count || 0) || by.name(a, b),
      matches: (a, b) => (matches.get(b.id) || 0) - (matches.get(a.id) || 0) || by.name(a, b),
      newest: (a, b) => String(info(b).created).localeCompare(String(info(a).created)) || by.name(a, b),
      oldest: (a, b) => String(info(a).created).localeCompare(String(info(b).created)) || by.name(a, b),
    };
    return { list: list.sort(by[st.subSort] || by.name), matches };
  }

  /** Open the patches of sub-library `id` ('' = all) that match the sub-library search. */
  function showMatches(id) {
    st.f = { ...st.f, ...st.sf, sub: id };
    st.limit = PAGE;
    saveFilter();
    renderSubs();
    renderBrowse();
    browseBox.scrollIntoView?.({ block: 'start' });
  }

  function renderSubs() {
    const lib = st.lib;
    const { list: subs, matches } = listedSubs();
    const all = lib.subs();
    const ticked = all.filter((s) => st.subChecked.has(s.id));
    const total = [...matches.values()].reduce((a, b) => a + b, 0);
    const sortSel = h('select', { title: 'Order of the list', onchange: () => { st.subSort = sortSel.value; saveSubSearch(); renderSubs(); } },
      SUB_SORTS.map(([v, l]) => h('option', { value: v, selected: v === st.subSort }, `Sort: ${l}`)));
    const search = all.length ? h('div.col.ml-subsearch',
      h('div.row',
        filterBar(st.rows, st.sf, () => { saveSubSearch(); renderSubs(); }),
        sortSel),
      searching() ? h('div.row.small',
        h('span', `${total} matching patch(es) in ${subs.length} of ${all.length} sub-libraries.`),
        total ? h('a.link', { href: '#', onclick: (ev) => { ev.preventDefault(); showMatches(''); } }, 'Show them all') : null,
        h('a.link', { href: '#', onclick: (ev) => { ev.preventDefault(); st.sf = { q: '', device: '', type: '', category: '', kind: '' }; saveSubSearch(); renderSubs(); } }, 'Clear search')) : null) : null;
    clear(subsBox).append(
      h('div.card-head.row', h('h2.grow', 'Sub-libraries', h('span.small.muted', ` ${all.length}`)),
        ticked.length >= 2 ? h('button.btn.primary', { title: 'Put the ticked sub-libraries together into one', onclick: guard(() => mergeSubs(ticked), 'Merge') }, `Merge ${ticked.length} sub-libraries...`) : null,
        h('button.btn', { onclick: guard(newSub, 'New sub-library') }, 'New sub-library'),
        canPickFolders ? h('button.btn', { title: 'Add a sub-library folder from somewhere else (it stays where it is)', onclick: guard(registerFolder, 'Register') }, 'Register a folder...') : null),
      search,
      subs.length ? h('div.table-wrap', h('table.list',
        h('thead', h('tr', h('th', { title: 'Tick two or more to merge them' }, ''), h('th', 'Name'), h('th', 'Device'), h('th', 'Patches'), searching() ? h('th', 'Matches') : null, h('th', 'Patches from'), h('th', 'Where'), h('th', ''))),
        h('tbody', subs.map((s) => {
          const info = st.subInfo.get(s.id) || {};
          const box = h('input', { type: 'checkbox', checked: st.subChecked.has(s.id), title: 'Tick two or more to merge them', onchange: () => { if (box.checked) st.subChecked.add(s.id); else st.subChecked.delete(s.id); renderSubs(); } });
          return h('tr' + (st.f.sub === s.id ? '.sel' : ''),
            h('td', box),
            h('td', h('a.link', { href: '#', title: searching() ? 'Show its matching patches' : 'Show its patches', onclick: (ev) => { ev.preventDefault(); if (searching()) showMatches(s.id); else { st.f.sub = st.f.sub === s.id ? '' : s.id; saveFilter(); renderSubs(); renderBrowse(); } } }, s.name),
              info.reachable === false ? h('div.small.c-warn', 'Files not reachable: reconnect the folder.') : null),
            h('td', s.device ? h('span.badge.live', s.device.model) : h('span.small.muted', 'mixed')),
            h('td.mono', String(info.count ?? '')),
            searching() ? h('td.mono', h('a.link', { href: '#', onclick: (ev) => { ev.preventDefault(); showMatches(s.id); } }, String(matches.get(s.id) || 0))) : null,
            h('td.small', (info.devices || []).join(', ')),
            h('td.small.muted', s.external ? `Own folder: ${s.folder || 'elsewhere'}` : lib.state === 'none' ? 'This browser (no folder yet)' : `${lib.folderName}/${s.path}`),
            h('td.row',
              h('button.btn.small', { title: 'Name and device', onclick: guard(() => editSub(s), 'Edit') }, 'Edit'),
              h('button.btn.small', { title: 'Save every patch of this sub-library in one JSON file', onclick: guard(() => exportSub(s), 'Export') }, 'Export'),
              h('button.btn.small.danger', { onclick: guard(() => unregister(s), 'Unregister') }, 'Unregister')));
        })))) : h('div.empty', all.length ? 'No sub-library has patches that match.' : 'No sub-libraries yet. Import files below to make one, or register a sub-library folder.'),
      progressBox('subs'));
  }

  /** Name and device of a sub-library: {name, device} or null. */
  async function subDialog(title, { name = '', device = null } = {}, okLabel = 'OK') {
    const nameInp = h('input', { type: 'text', value: name });
    const devSel = deviceSelect(device?.id || '', { first: ['', 'No device (mixed)'] });
    setTimeout(() => nameInp.focus(), 30);
    const r = await dialog(title, h('div.col',
      h('label.field', 'Name', nameInp),
      h('label.field', 'Device', devSel),
      h('p.small.muted', 'The device the sub-library holds sounds for. Sub-libraries added from a device\'s Branch Library get that device.')), [
      { label: 'Cancel', value: null },
      { label: okLabel, primary: true, value: () => ({ name: nameInp.value.trim(), device: deviceRef(getDevice(devSel.value)) }) },
    ]);
    return r?.name ? r : null;
  }

  async function newSub() {
    const r = await subDialog('New sub-library', {}, 'Create');
    if (!r) return;
    st.f.sub = await st.lib.createSub(r.name, { device: r.device });
    saveFilter();
  }

  async function editSub(s) {
    const r = await subDialog(`Edit "${s.name}"`, { name: s.name, device: s.device }, 'Save');
    if (r) await st.lib.editSub(s.id, r);
  }

  async function mergeSubs(subs) {
    const largest = subs.slice().sort((a, b) => (st.subInfo.get(b.id)?.count || 0) - (st.subInfo.get(a.id)?.count || 0))[0];
    const target = h('select', subs.map((s) => h('option', { value: s.id, selected: s === largest }, `${subLabel(s)}, ${st.subInfo.get(s.id)?.count ?? 0} patches`)));
    const nameInp = h('input', { type: 'text', value: largest.name });
    target.addEventListener('change', () => { nameInp.value = subs.find((s) => s.id === target.value)?.name || ''; });
    const ok = await dialog(`Merge ${subs.length} sub-libraries`, h('div.col',
      h('label.field', 'Into', target),
      h('label.field', 'Name of the merged sub-library', nameInp),
      h('p.small.muted', 'The patches and samples of the others are moved into it, and the others are removed (an external sub-library\'s folder is only unregistered). Run "Find duplicates" afterwards to clear out patches that were in more than one.')), [
      { label: 'Cancel', value: false }, { label: 'Merge', value: true, primary: true }]);
    if (!ok) return;
    const into = target.value;
    const others = subs.filter((s) => s.id !== into).map((s) => s.id);
    setBusy(`Merging ${subs.length} sub-libraries...`, 0, 'subs');
    let moved = 0;
    try {
      moved = await st.lib.mergeSubs(others, into, { onProgress: (d, n) => setBusy(`Moving ${d}/${n}`, d / n, 'subs') });
      const name = nameInp.value.trim();
      if (name && name !== st.lib.subs().find((s) => s.id === into)?.name) await st.lib.editSub(into, { name });
    } finally { setBusy(null); }
    st.subChecked.clear();
    st.f.sub = into;
    saveFilter();
    toast(`Merged: ${moved} item(s) moved.`, 'good');
  }

  async function registerFolder() {
    const id = await st.lib.registerFolder();
    if (id) { st.f.sub = id; saveFilter(); toast('Sub-library registered.', 'good'); }
  }

  async function exportSub(s) {
    const sub = await st.lib.getSub(s.id);
    const patches = [];
    for (const r of sub.patches) { const p = await st.lib.getPatch(s.id, r.id); if (p) patches.push(p); }
    downloadBlob(JSON.stringify(patches, null, 1), `${safeFileName(s.name)}.json`, 'application/json');
  }

  async function unregister(s) {
    const local = !s.external && st.lib.state === 'none';
    const msg = local
      ? `"${s.name}" is only kept in this browser (no library folder is chosen yet). Unregistering it deletes it. Continue?`
      : `Remove "${s.name}" from the Head Library? Its files stay ${s.external ? `in "${s.folder || 'its folder'}"` : `in "${st.lib.folderName}/${s.path}"`}; register that folder again to bring it back.`;
    if (!(await confirmDialog('Unregister sub-library', msg, local ? 'Delete' : 'Unregister', true))) return;
    await st.lib.unregister(s.id);
    toast(`"${s.name}" unregistered.`, 'good');
  }

  // ------------------------------------------------------------ import
  const progress = { text: h('div.small.mono'), bar: h('div') };
  /** Progress of a long job, shown in the card it belongs to ('import', 'dedup' or 'subs'). */
  function setBusy(text, frac = null, where = 'import') {
    const was = st.busy;
    st.busy = !!text;
    if (text) st.busyWhere = where;
    progress.text.textContent = text || '';
    progress.bar.style.width = frac === null ? '0' : `${Math.round(frac * 100)}%`;
    if (was !== st.busy) { renderImport(); renderDedup(); renderSubs(); }
  }
  const progressBox = (where) => (st.busy && st.busyWhere === where ? h('div.col', h('div.progress', progress.bar), progress.text) : null);
  const controls = h('div.row');
  function renderImportControls() {
    const subs = st.lib?.subs() || [];
    const into = h('select.ml-into', [h('option', { value: '' }, 'into a new sub-library'), ...subs.map((s) => h('option', { value: s.id, selected: s.id === st.f.sub }, `into "${subLabel(s)}"`))]);
    const dev = deviceSelect(st.importDevice, { first: ['', 'from: detect the device'], onchange: (v) => { st.importDevice = v; } });
    dev.title = 'The device the files are from. Detect reads it from the data; choosing one also keeps its SysEx that no editor reads as its data, and gives a new sub-library that device.';
    clear(controls).append(
      h('button.btn.primary', { disabled: st.busy, onclick: guard(async () => { const files = await pickFiles('.syx,.mid,.midi,.krz,.k25,.k26,.wav,.json,.j8k,.pat,.pfm,.zip,.iso,.bin,.cue,.img,.ima', true); if (files?.length) await runImport([...files], into.value); }, 'Import') }, 'Choose files...'),
      canPickFolders ? h('button.btn', { disabled: st.busy, title: 'Import every supported file in a folder and its sub-folders', onclick: guard(async () => { const r = await pickFolderFiles(); if (r) await runImport(r.files, into.value, r.name); }, 'Import') }, 'Choose a folder...') : null,
      into, dev,
      h('span.grow'));
    controls.into = into;
  }
  function renderImport() {
    renderImportControls();
    const drop = h('div.dropzone', { title: 'SysEx (.syx, .mid), Kurzweil .krz/.k25/.k26, .wav, .json, JP-8000/8080 .pat .pfm .j8k, V-Synth XT .p00 .p02 .P10, .zip archives, and disk or CD images (.iso, .bin with its .cue, .img)' }, st.busy ? 'Importing...' : 'Drop patch files, folders, archives or disk images here');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', guard(async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (st.busy) return;
      const r = await filesFromDrop(e.dataTransfer);
      if (r.files.length) await runImport(r.files, controls.into?.value || '', r.name);
    }, 'Import'));
    clear(importBox).append(
      h('div.card-head.row', h('h2.grow', 'Import'), st.report ? h('button.btn.small', { onclick: () => { st.report = null; renderImport(); } }, 'Hide report') : null),
      controls, drop,
      progressBox('import'),
      st.report ? h('div.col', h('b', st.report.title), importReportView(st.report.rows)) : null,
      h('div.small.muted', 'Each patch, performance, program or sample becomes one entry with all its settings; anything no editor reads is kept as data.'));
  }

  async function runImport(files, into, label = '') {
    if (st.busy) return;
    const usable = files.filter((f) => IMPORTABLE.test(f.name));
    const skipped = files.filter((f) => !IMPORTABLE.test(f.name));
    if (!usable.length) { toast('None of these files is a format the Head Library reads.', 'warn'); return; }
    setBusy(`Reading ${usable.length} file(s)...`);
    let r;
    try {
      const device = st.importDevice || undefined;
      r = await importFiles(usable, { onProgress: (t) => setBusy(`Reading ${t}`), hint: device, device });
    } catch (err) { setBusy(null); throw err; }
    const rows = [...r.report, ...skipped.slice(0, 50).map((f) => ({ file: f.name, note: 'not a patch file: skipped' }))];
    if (skipped.length > 50) rows.push({ file: `${skipped.length - 50} more`, note: 'skipped' });
    if (!r.patches.length) {
      setBusy(null);
      st.report = { title: 'Nothing to import', rows };
      renderImport();
      return;
    }
    try {
      const name = niceName(label || (usable.length === 1 ? usable[0].name.replace(/\.[^.]+$/, '') : `Import ${new Date().toLocaleDateString()}`));
      // a new sub-library's device: the one chosen, else the only device the files held
      const found = [...new Set(r.patches.map((p) => p.device.id).filter((id) => getDevice(id)))];
      const device = deviceRef(getDevice(st.importDevice || (found.length === 1 ? found[0] : '')));
      const subId = into || (await st.lib.createSub(name, { device }));
      setBusy(`Saving ${r.patches.length} item(s)${r.samples.length ? ` and ${r.samples.length} sample(s)` : ''}...`, 0);
      await st.lib.addPatches(subId, r.patches, r.samples, { onProgress: (d, n) => setBusy(`Saving ${d}/${n}`, d / n) });
      st.f.sub = subId;
      saveFilter();
      st.report = { title: `Imported ${r.patches.length} item(s)${r.samples.length ? ` with ${r.samples.length} sample(s)` : ''} into "${st.lib.subs().find((s) => s.id === subId)?.name}"`, rows };
      toast(`${r.patches.length} item(s) imported.`, 'good');
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  // ------------------------------------------------------------ browsing
  /** The device that is open (its module), if it can take Head Library patches. */
  const openDevice = () => { const g = shell.device?.instance?.context; return g?.def?.objects ? g : null; };

  function renderBrowse() {
    const lib = st.lib;
    const dev = openDevice();
    const shown = filterRows(st.rows, st.f);
    const page = shown.slice(0, st.limit);
    const subName = new Map(lib.subs().map((s) => [s.id, s.name]));
    const checkedShown = shown.filter((r) => st.checked.has(keyOf(r)));
    const all = h('input', {
      type: 'checkbox', checked: !!page.length && page.every((r) => st.checked.has(keyOf(r))), title: 'Select all shown',
      onchange: () => { for (const r of page) { if (all.checked) st.checked.add(keyOf(r)); else st.checked.delete(keyOf(r)); } renderBrowse(); },
    });
    const bulk = checkedShown.length ? h('div.row.ml-bulk',
      h('b', `${checkedShown.length} selected`),
      dev
        ? h('button.btn.small.primary', { title: `Load or store them on the ${dev.entry.model} (translated when they are from another model)`, onclick: guard(() => sendToDevice(dev, lib, checkedShown), 'Send') }, `Send to the ${dev.entry.model}...`)
        : h('button.btn.small', { disabled: true, title: 'Open a device (Devices page) to send patches to it' }, 'Send to a device...'),
      h('button.btn.small', { onclick: guard(() => bulkMove(checkedShown), 'Move') }, 'Move to...'),
      h('button.btn.small', { onclick: guard(() => bulkCategory(checkedShown), 'Category') }, 'Set category...'),
      h('button.btn.small', { onclick: guard(() => bulkExport(checkedShown), 'Export') }, 'Export JSON'),
      checkedShown.some((r) => r.kind === 'data') ? h('button.btn.small', { title: 'Read the stored SysEx again with the current editors (e.g. after an update, or entries from a MIDI file read as raw SysEx)', onclick: guard(() => rereadData(checkedShown), 'Re-read') }, 'Re-read SysEx') : null,
      h('button.btn.small.danger', { onclick: guard(() => bulkDelete(checkedShown), 'Delete') }, 'Delete'),
      h('button.btn.small', { onclick: () => { st.checked.clear(); renderBrowse(); } }, 'Clear selection')) : null;
    clear(browseBox).append(
      h('div.card-head.row', h('h2.grow', 'Patches', h('span.small.muted', ` ${shown.length} of ${st.rows.length}`)),
        h('button.btn', { title: 'Find patches that are in the library more than once', onclick: () => { st.dedup ??= { sub: st.f.sub || '', mode: 'name', sameDevice: true, prefer: '', groups: null }; renderDedup(); dedupBox.scrollIntoView?.({ block: 'nearest' }); } }, 'Find duplicates...')),
      filterBar(st.rows, st.f, () => { st.limit = PAGE; saveFilter(); renderBrowse(); renderSubs(); }, { subs: lib.subs() }),
      bulk,
      st.rows.length ? h('div.table-wrap.ml-table', h('table.list',
        h('thead', h('tr', h('th', all), h('th', 'Name'), h('th', 'Category'), h('th', 'Device'), h('th', 'Kind'), h('th', 'Sub-library'))),
        h('tbody', page.map((r) => {
          const box = h('input', { type: 'checkbox', checked: st.checked.has(keyOf(r)), onclick: (ev) => ev.stopPropagation(), onchange: () => { if (box.checked) st.checked.add(keyOf(r)); else st.checked.delete(keyOf(r)); renderBrowse(); } });
          return h('tr' + (st.open && keyOf(st.open.row) === keyOf(r) ? '.sel' : ''), { onclick: guard(() => openPatch(r), 'Open') },
            h('td', box),
            h('td', r.name, r.samples ? h('span.small.muted', `  ${r.samples} smp`) : null),
            h('td.small', CATEGORY_LABEL[r.category] || r.category),
            h('td.small', r.model),
            h('td.small', kindLabel(r.kind)),
            h('td.small.muted', subName.get(r.sub) || ''));
        })))) : h('div.empty', 'The library is empty. Import some files to start.'),
      shown.length > page.length ? h('button.btn.small', { onclick: () => { st.limit += PAGE * 3; renderBrowse(); } }, `Show more (${shown.length - page.length} not shown)`) : null);
  }

  async function bulkMove(rows) {
    const to = await chooseSub(st.lib, `Move ${rows.length} item(s)`, { okLabel: 'Move' });
    if (!to) return;
    setBusy(`Moving ${rows.length} item(s)...`, 0);
    try {
      for (const [sub, ids] of groupBySub(rows)) if (sub !== to) await st.lib.movePatches(sub, to, ids, { onProgress: (d, n) => setBusy(`Moving ${d}/${n}`, d / n) });
    } finally { setBusy(null); }
    st.checked.clear();
    toast(`${rows.length} item(s) moved.`, 'good');
  }

  async function bulkCategory(rows) {
    let pick = rows[0].category;
    const r = await dialog(`Category of ${rows.length} item(s)`, h('label.field', 'Category', categorySelect(pick, (v) => { pick = v; })), [
      { label: 'Cancel', value: null }, { label: 'Set', value: true, primary: true }]);
    if (!r) return;
    setBusy(`Setting the category of ${rows.length} item(s)...`, 0);
    try {
      for (const [sub, ids] of groupBySub(rows)) {
        const patches = [];
        for (const id of ids) { const p = await st.lib.getPatch(sub, id); if (p) { p.category = categoryOf(pick); patches.push(p); } }
        await st.lib.addPatches(sub, patches, [], { onProgress: (d, n) => setBusy(`Saving ${d}/${n}`, d / n) });
      }
    } finally { setBusy(null); }
    if (st.open) await openPatch(st.open.row);
  }

  async function bulkExport(rows) {
    const out = [];
    for (const r of rows) { const p = await st.lib.getPatch(r.sub, r.id); if (p) out.push(p); }
    downloadBlob(JSON.stringify(out, null, 1), `main-library-${out.length}-items.json`, 'application/json');
  }

  async function bulkDelete(rows) {
    if (!(await confirmDialog('Delete', `Delete ${rows.length} item(s) from the Head Library? Their JSON files (and samples no other patch uses) are removed from the folder.`, 'Delete', true))) return;
    setBusy(`Deleting ${rows.length} item(s)...`);
    try { for (const [sub, ids] of groupBySub(rows)) await st.lib.deletePatches(sub, ids); } finally { setBusy(null); }
    st.checked.clear();
  }

  /**
   * Read 'data' patches again with the current editors. Every data patch of the same sub-library
   * and source file is read together (a dump's messages may have been split between several).
   */
  async function rereadData(rows) {
    const lib = st.lib;
    const files = new Map(); // "sub|file" -> data patches
    for (const subId of new Set(rows.filter((r) => r.kind === 'data').map((r) => r.sub))) {
      for (const r of (await lib.getSub(subId)).patches.filter((x) => x.kind === 'data')) {
        const p = await lib.getPatch(subId, r.id);
        if (!p) continue;
        const k = `${subId}|${p.source?.file || ''}`;
        if (!files.has(k)) files.set(k, []);
        files.get(k).push(p);
      }
    }
    const wanted = new Set(rows.map(keyOf));
    let read = 0;
    let made = 0;
    setBusy('Reading the stored SysEx again...', 0);
    try {
      for (const [k, patches] of files) {
        const [subId, file] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
        if (!patches.some((p) => wanted.has(`${subId}:${p.id}`))) continue;
        const sub = lib.subs().find((s) => s.id === subId);
        const msgs = patches.flatMap((p) => splitSysex(dataMessages(p)));
        const r = await importSysex(msgs, { file, device: sub?.device?.id });
        if (r.patches.every((p) => p.kind === 'data') && r.patches.length === patches.length) continue; // nothing new
        for (const p of r.patches) p.source = { ...patches[0].source, ...p.source, file };
        await lib.addPatches(subId, r.patches);
        await lib.deletePatches(subId, patches.map((p) => p.id));
        read += patches.length;
        made += r.patches.length;
      }
    } finally { setBusy(null); }
    st.checked.clear();
    toast(read ? `${read} data item(s) read again: now ${made} item(s).` : 'Nothing new: the editors read these the same way as before.', read ? 'good' : 'info', 6000);
  }

  // ------------------------------------------------------------ duplicates
  function renderDedup() {
    const d = st.dedup;
    clear(dedupBox);
    dedupBox.hidden = !d;
    if (!d) return;
    const lib = st.lib;
    const scope = h('select', { onchange: () => { d.sub = scope.value; d.groups = null; renderDedup(); } },
      h('option', { value: '' }, 'All sub-libraries'), lib.subs().map((s) => h('option', { value: s.id, selected: s.id === d.sub }, subLabel(s))));
    const radio = (mode, label, help) => h('label.row.small', h('input', { type: 'radio', name: 'ml-dedup-mode', checked: d.mode === mode, onchange: () => { d.mode = mode; d.groups = null; renderDedup(); } }), h('span', h('b', label), ` ${help}`));
    const same = h('input', { type: 'checkbox', checked: d.sameDevice, onchange: () => { d.sameDevice = same.checked; d.groups = null; renderDedup(); } });
    const prefer = deviceSelect(d.prefer, { first: ['', 'keep: the first imported'], onchange: (v) => { d.prefer = v; } });
    dedupBox.append(
      h('div.card-head.row', h('h2.grow', 'Find duplicates'), h('button.btn.small', { onclick: () => { st.dedup = null; renderDedup(); } }, 'Close')),
      h('div.row', h('label.field', 'Look in', scope)),
      radio('name', 'Same name', '(case and spacing ignored). Fast; groups whose settings differ are marked and left unticked.'),
      radio('settings', 'Same settings', '(deep scan): every parameter is compared and the name is ignored, so renamed copies are found too.'),
      h('label.row.small', same, d.mode === 'name' ? 'Only on the same device' : 'Only on the same device (untick to also match the same sound on another model, where a translator exists, e.g. JP-8000 and JP-8080)'),
      !d.sameDevice ? h('label.field', 'In each group, keep', prefer) : null,
      h('div.row', h('button.btn.primary', { disabled: st.busy, onclick: guard(runDedup, 'Find duplicates') }, 'Find duplicates')),
      progressBox('dedup'),
      d.groups ? dedupResults() : null);
  }

  async function runDedup() {
    const d = st.dedup;
    setBusy('Looking for duplicates...', 0, 'dedup');
    try {
      d.groups = await findDuplicates(st.lib, { sub: d.sub || null, mode: d.mode, sameDevice: d.sameDevice, prefer: d.prefer || null, onProgress: (n, total) => setBusy(`Comparing ${n}/${total}`, n / total, 'dedup') });
      for (const g of d.groups) g.apply = !g.differs;
    } finally { setBusy(null); }
    renderDedup();
  }

  function dedupResults() {
    const d = st.dedup;
    const groups = d.groups;
    if (!groups.length) return h('div.notice', 'No duplicates found.');
    const chosen = groups.filter((g) => g.apply);
    const count = chosen.reduce((n, g) => n + g.members.length - 1, 0);
    const subName = new Map(st.lib.subs().map((s) => [s.id, s.name]));
    const SHOW = 200;
    const differing = groups.filter((g) => g.differs).length;
    return h('div.col',
      h('div.row',
        h('b.grow', `${groups.length} group(s), ${groups.reduce((n, g) => n + g.members.length - 1, 0)} duplicate(s).`),
        h('button.btn.small', { onclick: () => { for (const g of groups) g.apply = true; renderDedup(); } }, 'Tick all'),
        h('button.btn.small', { onclick: () => { for (const g of groups) g.apply = false; renderDedup(); } }, 'Untick all'),
        h('button.btn.danger', { disabled: !count || st.busy, onclick: guard(() => runApply(chosen, count), 'Delete duplicates') }, `Delete ${count} duplicate(s)`)),
      differing ? h('div.small.c-warn', `${differing} group(s) share a name but not their settings: they are different sounds and are left unticked.`) : null,
      h('div.small.muted', 'In each ticked group the chosen patch is kept and the others are deleted. Performances that used a deleted patch are pointed at the kept one.'),
      h('div.table-wrap.ml-table', h('table.list',
        h('thead', h('tr', h('th', ''), h('th', 'Keep'), h('th', 'Name'), h('th', 'Device'), h('th', 'Kind'), h('th', 'Sub-library'), h('th', 'From'))),
        h('tbody', groups.slice(0, SHOW).flatMap((g, gi) => {
          const tick = h('input', { type: 'checkbox', checked: g.apply, onchange: () => { g.apply = tick.checked; renderDedup(); } });
          return g.members.map((m, mi) => h('tr' + (mi === 0 ? '.ml-group' : ''),
            h('td', mi === 0 ? tick : null),
            h('td', h('input', { type: 'radio', name: `ml-keep-${gi}`, checked: g.keep === `${m.sub}:${m.id}`, onchange: () => { g.keep = `${m.sub}:${m.id}`; } })),
            h('td', m.name, mi === 0 && g.differs ? h('span.small.c-warn', '  settings differ') : null),
            h('td.small', m.model),
            h('td.small', kindLabel(m.kind)),
            h('td.small', subName.get(m.sub) || ''),
            h('td.small.muted', [m.source?.file, m.source?.slot].filter(Boolean).join(', '))));
        })))),
      groups.length > SHOW ? h('div.small.muted', `The first ${SHOW} groups are shown; the ticked ones among all ${groups.length} are applied.`) : null);
  }

  async function runApply(groups, count) {
    if (!(await confirmDialog('Delete duplicates', `Delete ${count} duplicate(s) in ${groups.length} group(s)? Their JSON files (and samples nothing else uses) are removed from the folder.`, 'Delete', true))) return;
    setBusy(`Deleting ${count} duplicate(s)...`, 0, 'dedup');
    let r;
    try { r = await applyDedup(st.lib, groups, { onProgress: (n, total) => setBusy(`Deleting ${n}/${total}`, n / total, 'dedup') }); } finally { setBusy(null); }
    st.dedup.groups = null;
    toast(`${r.deleted} duplicate(s) deleted${r.relinked ? `; ${r.relinked} performance(s) now use the kept patches` : ''}.`, 'good', 6000);
    renderDedup();
  }

  function groupBySub(rows) {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.sub)) m.set(r.sub, []); m.get(r.sub).push(r.id); }
    return m;
  }

  // ------------------------------------------------------------ one patch
  async function openPatch(row) {
    const patch = await st.lib.getPatch(row.sub, row.id);
    if (!patch) { toast('That patch file is not reachable. Reconnect the folder.', 'warn'); return; }
    st.open = { row, patch, targets: null };
    renderBrowse();
    renderDetail();
    const targets = await targetsFor(patch);
    if (st.open?.patch === patch) { st.open.targets = targets; renderDetail(); }
  }

  function renderDetail() {
    clear(detailBox);
    if (!st.open) { detailBox.hidden = true; return; }
    detailBox.hidden = false;
    const { row, patch, targets } = st.open;
    const lib = st.lib;
    const name = h('input', { type: 'text', value: patch.name });
    let cat = patch.category.id;
    const tags = h('input', { type: 'text', value: (patch.tags || []).join(', '), placeholder: 'tags, comma separated' });
    const notes = h('textarea', { rows: 2, placeholder: 'Notes' });
    notes.value = patch.notes || '';
    const save = guard(async () => {
      patch.name = name.value.trim() || patch.name;
      if (cat !== patch.category.id) patch.category = categoryOf(cat);
      patch.tags = tags.value.split(',').map((t) => t.trim()).filter(Boolean);
      patch.notes = notes.value;
      await lib.updatePatch(row.sub, patch);
      toast('Saved.', 'good');
    }, 'Save');
    const src = patch.source || {};
    const info = [
      ['Device', `${patch.device.maker} ${patch.device.model}`.trim()],
      ['Device type', (patch.device.types || []).join(', ')],
      ['Kind', kindLabel(patch.kind)],
      ['Category from', { device: 'the device', 'name-prefix': 'the name prefix', 'name-word': 'a word in the name', manual: 'set by hand', none: '-' }[patch.category.source] || patch.category.source],
      ['From', [src.file, src.bank, src.slot].filter(Boolean).join(', ')],
      ['Imported', src.imported ? new Date(src.imported).toLocaleString() : ''],
      ['Shared model', patch.common ? 'yes: can be translated' : 'no'],
      ...(patch.links || []).map((l) => [`${l.role} ${kindLabel(l.kind).toLowerCase()}`, l.name]),
    ].filter(([, v]) => v);
    detailBox.append(h('div.card.col',
      h('div.card-head.row', h('h2.grow', patch.name), h('button.btn.small', { onclick: () => { st.open = null; renderDetail(); renderBrowse(); } }, 'Close')),
      h('label.field', 'Name', name),
      h('label.field', 'Category', categorySelect(cat, (v) => { cat = v; })),
      h('label.field', 'Tags', tags),
      notes,
      h('div.row', h('button.btn.primary', { onclick: save }, 'Save changes'),
        openDevice() && fitFor(openDevice(), row)?.obj
          ? h('button.btn', { title: `Load it into the editor, send it to the edit buffer or store it on the ${openDevice().entry.model}`, onclick: guard(() => sendToDevice(openDevice(), lib, [row]), 'Send') }, `Send to the ${openDevice().entry.model}...`)
          : null,
        h('span.grow'),
        h('button.btn.small', { onclick: guard(() => moveOne(row), 'Move') }, 'Move to...'),
        h('button.btn.small', { onclick: () => downloadBlob(JSON.stringify(patch, null, 1), `${safeFileName(patch.name)}.json`, 'application/json') }, 'JSON'),
        patch.native?.bytes || patch.native?.syx ? h('button.btn.small', { title: 'The patch as SysEx for its device', onclick: guard(() => exportSyx(patch), 'Export') }, '.syx') : null,
        h('button.btn.small.danger', { onclick: guard(async () => { if (await confirmDialog('Delete', `Delete "${patch.name}"?`, 'Delete', true)) await lib.deletePatch(row.sub, row.id); }, 'Delete') }, 'Delete')),
      h('div.ml-kv', info.flatMap(([k, v]) => [h('span.muted', k), h('span', v)])),
      h('div.col',
        h('b', 'Loads into'),
        targets === null ? h('div.small.muted', 'Checking...') : targets.length
          ? h('div.row', targets.map((t) => h('a.badge' + (t.mode === 'native' ? '.live' : '.ram'), {
            href: `#/d/${encodeURIComponent(t.id)}/librarian`, title: `Open the ${t.model} Branch Library (Head Library panel) to load it`,
          }, `${t.model}${t.mode === 'native' ? '' : ' (translated)'}`)))
          : h('div.small.muted', patch.kind === 'data' ? 'Stored SysEx: send it from its device\'s Branch Library (Export .syx).' : 'No editor can load it yet.')),
      samplesView(lib, row.sub, patch),
      h('b', 'Settings'),
      settingsView(patch)));
  }

  async function moveOne(row) {
    const to = await chooseSub(st.lib, 'Move to', { okLabel: 'Move' });
    if (to && to !== row.sub) { await st.lib.movePatch(row.sub, to, row.id); toast('Moved.', 'good'); }
  }

  async function exportSyx(patch) {
    let bytes;
    if (patch.native?.syx) bytes = fromBase64(patch.native.syx);
    else {
      const def = await loadDef(patch.device.id);
      const obj = def?.objects?.find((o) => o.key === patch.native.object);
      if (!obj?.toSyx) { toast(`The ${patch.device.model} editor cannot write this as SysEx.`, 'warn'); return; }
      const entry = getDevice(patch.device.id);
      const data = obj.init();
      data.set(fromBase64(patch.native.bytes).subarray(0, data.length));
      // toSyx gives the messages as one byte list (as the editor's own .syx export uses it)
      bytes = flatBytes(obj.toSyx(data, { deviceId: def.sysex?.deviceIdDefault ?? 0x10, channel: 0, entry, data: {}, names: {}, loaded: new Set(), settings: {} }));
    }
    downloadBlob(bytes, `${safeFileName(patch.name)}.syx`, 'application/octet-stream');
  }

  return { destroy() { st.destroyed = true; off?.(); } };
}

/** Bytes from a message list in any nesting (numbers, arrays, Uint8Arrays). */
function flatBytes(x) {
  const out = [];
  const walk = (v) => { if (typeof v === 'number') out.push(v); else for (const y of v) walk(y); };
  walk(x);
  return Uint8Array.from(out);
}

// ------------------------------------------------------------ files from folders
/** Every file in a folder the user picks (and its sub-folders): {name, files}. */
async function pickFolderFiles() {
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'read', id: 'midimaster-import' }); } catch { return null; }
  const files = [];
  async function walk(d, depth) {
    for await (const [, hd] of d.entries()) {
      if (hd.kind === 'file') files.push(await hd.getFile());
      else if (depth < 8) await walk(hd, depth + 1);
    }
  }
  await walk(dir, 0);
  return { name: dir.name, files };
}

/** Files dropped on the page, folders included: {name, files}. */
async function filesFromDrop(dt) {
  const entries = [...(dt?.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return { name: '', files: [...(dt?.files || [])] };
  const files = [];
  const fileOf = (e) => new Promise((res) => e.file(res, () => res(null)));
  const readAll = (r) => new Promise((res) => { const out = []; const next = () => r.readEntries((b) => { if (!b.length) res(out); else { out.push(...b); next(); } }, () => res(out)); next(); });
  async function walk(e, depth) {
    if (e.isFile) { const f = await fileOf(e); if (f) files.push(f); } else if (e.isDirectory && depth < 8) for (const c of await readAll(e.createReader())) await walk(c, depth + 1);
  }
  for (const e of entries) await walk(e, 0);
  const folder = entries.length === 1 && entries[0].isDirectory ? entries[0].name : '';
  return { name: folder, files };
}
