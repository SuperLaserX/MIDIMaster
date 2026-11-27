// Branch Library: list, rename, copy, move, delete, export and import K2000 objects.

import { h, clear, toast, formDialog, confirmDialog, dialog, downloadBlob, pickFiles, splitSysex, concatBytes, safeFileName } from '../../../core/ui/dom.js';
import { sleep } from '../../../core/bits.js';
import { SampleDump, sdsSampleNumber } from '../../../core/midi/sds.js';
import { chooseSub } from '../../../core/ui/mainlib.js';
import { TYPES, TYPE_BY_ID, T, typeName } from '../model/types.js';
import { Soundblock } from '../model/soundblock.js';
import { build, parse, MSG } from '../protocol.js';
import { sysexMessages } from '../../../core/midi/smf.js';
import { programFromK2000, k2000Patch, k2000Sample, krzFromPatches } from '../disk/mainlib.js';
import { addMemorySource } from './diskimport.js';

export function libraryView(root, app) {
  const st = { type: T.PROGRAM, bank: 127, ramOnly: false, items: [], selected: new Set(), filter: '' };
  const tabs = h('div.tabs');
  const tableWrap = h('div.table-wrap');
  const info = h('div.small.muted');
  const bankSel = h('select', { onchange: () => { st.bank = Number(bankSel.value); refresh(); } },
    h('option', { value: 127 }, 'All banks'),
    Array.from({ length: 10 }, (_, b) => h('option', { value: b }, `Bank ${b}`)));
  const ramToggle = h('button.btn.toggle', { onclick: () => { st.ramOnly = !st.ramOnly; ramToggle.classList.toggle('on', st.ramOnly); refresh(); } }, 'RAM only');
  const filter = h('input', { type: 'text', placeholder: 'Filter by name or ID', oninput: () => { st.filter = filter.value.toLowerCase(); renderTable(); } });
  const drop = h('div.dropzone', 'Drop .syx files here to send them to the K2000');

  root.append(
    h('h1', 'Library'),
    h('div.sub', 'Every object type on the K2000. RAM objects can be renamed, moved and deleted; any object can be copied to RAM or exported.'),
    tabs,
    h('div.row', { style: { marginBottom: '10px' } },
      bankSel, ramToggle, filter,
      h('button.btn', { onclick: refresh }, 'Refresh'),
      h('span.grow'),
      h('button.btn', { title: 'Send K2000 programs (with their keymaps and samples) from a Head Library sub-library, through the Disk Import page', onclick: loadFromMainLibrary }, 'Load from Head Library...'),
      h('button.btn', { onclick: importSyx }, 'Import .syx...'),
      h('button.btn', { onclick: () => backup(st.type) }, 'Export this type (RAM)'),
      h('button.btn.primary', { onclick: () => backup(0) }, 'Back up all RAM')),
    h('div.row', { style: { marginBottom: '8px' } }, info, h('span.grow'),
      h('button.btn.small', { title: 'Save the selected objects (programs with the RAM keymaps and samples they use) in the Head Library', onclick: addToMainLibrary }, 'Add to Head Library'),
      h('button.btn.small', { onclick: bulkExport }, 'Export selected'),
      h('button.btn.small.danger', { onclick: bulkDelete }, 'Delete selected'),
      h('button.btn.small', { onclick: moveBankDialog }, 'Move bank...'),
      h('button.btn.small.danger', { onclick: deleteBankDialog }, 'Delete bank...')),
    tableWrap,
    h('div', { style: { marginTop: '12px' } }, drop),
  );

  for (const t of TYPES) {
    tabs.append(h('button', { dataset: { type: t.type }, onclick: () => { st.type = t.type; st.selected.clear(); renderTabs(); refresh(); } }, t.name));
  }
  function renderTabs() { for (const b of tabs.children) b.classList.toggle('active', Number(b.dataset.type) === st.type); }
  renderTabs();

  async function refresh() {
    if (!app.online) { clear(tableWrap).append(h('div.empty', 'Not connected.')); return; }
    clear(tableWrap).append(h('div.empty', 'Reading directory...'));
    try {
      const items = await app.client.dirBank(st.type, st.bank, st.ramOnly);
      items.forEach((i) => app.rememberInfo(i));
      st.items = items.filter((i) => i.size > 0).sort((a, b) => a.id - b.id);
      renderTable();
    } catch (err) { clear(tableWrap).append(h('div.empty', err.message)); }
  }

  function renderTable() {
    const rows = st.items.filter((i) => !st.filter || i.objName.toLowerCase().includes(st.filter) || String(i.id).startsWith(st.filter));
    const t = TYPE_BY_ID[st.type];
    info.textContent = `${rows.length} ${t?.name.toLowerCase() || 'objects'}${st.selected.size ? `, ${st.selected.size} selected` : ''}`;
    const all = h('input', { type: 'checkbox', onchange: () => { rows.forEach((r) => (all.checked ? st.selected.add(r.id) : st.selected.delete(r.id))); renderTable(); } });
    clear(tableWrap).append(h('table.list',
      h('thead', h('tr', h('th', all), h('th', 'ID'), h('th', 'Name'), h('th', 'Size'), h('th', 'Memory'), h('th', ''))),
      h('tbody', rows.map((i) => {
        const cb = h('input', { type: 'checkbox', checked: st.selected.has(i.id), onchange: () => { cb.checked ? st.selected.add(i.id) : st.selected.delete(i.id); info.textContent = `${rows.length} objects, ${st.selected.size} selected`; } });
        return h('tr' + (st.selected.has(i.id) ? '.sel' : ''),
          h('td', cb),
          h('td.mono', String(i.id)),
          h('td', i.objName),
          h('td.mono.muted', `${i.size}`),
          h('td', h('span.badge.' + (i.inRam ? 'ram' : 'rom'), i.inRam ? 'RAM' : 'ROM')),
          h('td', h('div.row', { style: { justifyContent: 'flex-end' } },
            t?.editable ? h('button.btn.small', { onclick: () => openEditor(i) }, 'Edit') : null,
            h('button.btn.small', { onclick: () => exportOne(i) }, 'Export'),
            h('button.btn.small', { onclick: () => copyTo(i) }, 'Copy to...'),
            i.inRam ? h('button.btn.small', { onclick: () => rename(i) }, 'Rename') : null,
            i.inRam ? h('button.btn.small', { onclick: () => moveTo(i) }, 'Move') : null,
            i.inRam ? h('button.btn.small.danger', { onclick: () => del(i) }, 'Delete') : null)));
      }))));
    if (!rows.length) tableWrap.append(h('div.empty', 'No objects.'));
  }

  function openEditor(i) {
    if (i.type === T.PROGRAM) app.nav('program', { id: i.id });
    else if (i.type === T.KEYMAP) app.nav('keymaps', { id: i.id });
    else if (i.type === T.SOUNDBLOCK) app.nav('samples', { id: i.id });
  }

  async function exportOne(i) {
    try {
      const obj = await app.client.readObject(i.type, i.id, i.size);
      downloadBlob(build.write(0, i.type, i.id, 0, obj.name, obj.data), `${typeName(i.type)}_${i.id}_${safeFileName(obj.name)}.syx`);
    } catch (err) { app.error(err, 'Export'); }
  }

  // ------------------------------------------------------------ Head Library
  async function addToMainLibrary() {
    const ids = [...st.selected];
    if (!ids.length) { toast('Select objects first', 'warn'); return; }
    const lib = await app.host.shell.mainLibrary();
    const programs = st.type === T.PROGRAM;
    const audio = h('input', { type: 'checkbox' });
    const what = programs
      ? `${ids.length} program(s), each with the RAM keymaps and soundblocks it uses. ROM keymaps and samples are only referenced: every K2000 has them.`
      : `${ids.length} ${TYPE_BY_ID[st.type].name.toLowerCase()} object(s).`;
    const go = await dialog('Add to Head Library', h('div.col', h('p', what),
      programs || st.type === T.SOUNDBLOCK ? h('label.row', audio, 'Include RAM sample audio (Sample Dump: about 45 s per second of 44.1 kHz audio)') : null), [
      { label: 'Cancel', value: false }, { label: 'Next', value: true, primary: true }]);
    if (!go) return;
    const sub = await chooseSub(lib, 'Add to the Head Library', { name: 'K2000 sounds', okLabel: 'Add', device: app.host.entry });
    if (!sub) return;
    const t = toast('Reading from the K2000...', 'info', 600000);
    const say = (x) => { if (t) t.textContent = x; };
    const patches = [];
    const files = [];
    let sds = null;
    const receive = audio.checked ? async (sid, index, label) => {
      while (app.client.pending) await sleep(100);
      await sleep(app.settings.minGap);
      sds ??= new SampleDump(app.transport, app.settings.deviceId);
      app.exclusive = true; // keeps the front panel from polling during the transfer
      try {
        say(`${label}: waiting for the K2000...`);
        return await sds.receive(sdsSampleNumber(sid, index), (f) => say(`${label}: ${Math.round(f * 100)}%`));
      } catch (err) { app.error(err, `Sample ${sid}`); return null; } finally { app.exclusive = false; await sleep(200); }
    } : null;
    try {
      for (const id of ids) {
        if (programs) {
          const r = await programFromK2000(app.client, app.host.entry, id, { receive, onStep: say });
          patches.push(r.patch);
          files.push(...r.samples);
          continue;
        }
        const o = await app.client.fetchObject(st.type, id);
        const samples = [];
        if (st.type === T.SOUNDBLOCK && receive) {
          const block = new Soundblock(o.data, { id, name: o.name });
          for (const hd of block.headers.filter((x) => x.inRam && x.end >= x.start)) {
            const r = await receive(id, hd.index, `${o.name} ${hd.index + 1}/${block.headers.length}`);
            if (!r?.samples?.length) continue;
            const smp = k2000Sample(r.samples, { rate: r.sampleRate || hd.rate || 44100, name: o.name, soundblock: id, lo: hd.start, source: `K2000 soundblock ${id}`, loop: r.loop ? { start: r.loopStart, end: r.loopEnd } : null });
            samples.push(smp.ref);
            files.push(smp.file);
          }
        }
        patches.push(k2000Patch(app.host.entry, {
          name: o.name || `${typeName(st.type)} ${id}`, kind: st.type === T.SOUNDBLOCK ? 'sample' : typeName(st.type).toLowerCase(),
          file: 'K2000', slot: `${typeName(st.type)} ${id}`, objs: [{ type: st.type, id, name: o.name, data: o.data }], samples,
        }));
      }
      say('Saving...');
      await lib.addPatches(sub, patches, files);
      t?.remove();
      toast(`Added ${patches.length} item(s)${files.length ? ` with ${files.length} sample(s)` : ''} to the Head Library.`, 'good');
    } catch (err) { t?.remove(); app.error(err, 'Add to Head Library'); }
  }

  async function loadFromMainLibrary() {
    const lib = await app.host.shell.mainLibrary();
    if (!lib.subs().length) { toast('The Head Library has no sub-libraries yet.', 'warn'); return; }
    const sub = await chooseSub(lib, 'Load from the Head Library', { allowNew: false, okLabel: 'Next' });
    if (!sub) return;
    const rows = (await lib.getSub(sub)).patches.filter((r) => r.device === 'kurzweil-k2000');
    if (!rows.length) { toast('That sub-library has no K2000 items.', 'warn'); return; }
    const boxes = rows.map((r) => h('input', { type: 'checkbox', checked: r.kind === 'program' }));
    const ok = await dialog('Load from the Head Library', h('div.col',
      h('p.small.muted', 'The chosen items open on the Disk Import page, where you choose the IDs and send them (samples go by Sample Dump).'),
      h('div.col.ml-samples', rows.map((r, i) => h('label.row', boxes[i], r.name, h('span.small.muted', `  ${r.kind}${r.samples ? `, ${r.samples} sample(s)` : ''}`))))), [
      { label: 'Cancel', value: false }, { label: 'Open in Disk Import', value: true, primary: true }]);
    if (!ok) return;
    const chosen = rows.filter((_, i) => boxes[i].checked);
    if (!chosen.length) return;
    const patches = [];
    for (const r of chosen) { const p = await lib.getPatch(sub, r.id); if (p?.native?.objects) patches.push(p); }
    const name = `${lib.subs().find((x) => x.id === sub)?.name || 'Head Library'} (${patches.length})`;
    const krz = await krzFromPatches(patches, (id) => lib.getSample(sub, id), name);
    for (const w of krz.warnings) toast(w, 'warn', 6000);
    addMemorySource(name, krz);
    app.nav('import');
  }

  async function bulkExport() {
    const ids = [...st.selected];
    if (!ids.length) { toast('Select objects first', 'warn'); return; }
    const chunks = [];
    for (const id of ids) {
      const i = st.items.find((x) => x.id === id);
      try {
        const obj = await app.client.readObject(st.type, id, i?.size || 4096);
        chunks.push(build.write(0, st.type, id, 0, obj.name, obj.data));
      } catch (err) { app.error(err, `Export ${id}`); }
    }
    if (chunks.length) downloadBlob(concatBytes(chunks), `${typeName(st.type)}_selection.syx`);
  }

  async function backup(type) {
    const label = type ? typeName(type) : 'All';
    const t = toast(`Reading RAM objects (${label})...`, 'info', 120000);
    let count = 0;
    try {
      const res = await app.client.readBank(type, 127, true, () => { count++; t.textContent = `Received ${count} objects...`; });
      t.remove();
      if (!res.raws.length) { toast('No RAM objects to back up', 'warn'); return; }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadBlob(concatBytes(res.raws), `K2000_${safeFileName(label)}_RAM_${stamp}.syx`);
      toast(`Backed up ${res.raws.length} objects`, 'good');
    } catch (err) { t.remove(); app.error(err, 'Backup'); }
  }

  async function copyTo(i) {
    const r = await formDialog(`Copy ${typeName(i.type)} ${i.id}`, [
      { key: 'id', label: 'Destination ID', type: 'number', value: i.id < 200 ? i.id + 200 : i.id + 1, min: 1, max: 999 },
      { key: 'name', label: 'Name', value: i.objName, maxlength: 16 },
    ], 'Copy', 'An existing RAM object at the destination is replaced.');
    if (!r) return;
    try { await app.client.copyObject(i.type, i.id, r.id, r.name); toast(`Copied to ${r.id}`, 'good'); app.refreshMemory(); refresh(); } catch (err) { app.error(err, 'Copy'); }
  }

  async function rename(i) {
    const r = await formDialog(`Rename ${typeName(i.type)} ${i.id}`, [{ key: 'name', label: 'Name (16 characters)', value: i.objName, maxlength: 16 }], 'Rename');
    if (!r) return;
    try { await app.client.rename(i.type, i.id, r.name); refresh(); } catch (err) { app.error(err, 'Rename'); }
  }

  async function moveTo(i) {
    const r = await formDialog(`Move ${typeName(i.type)} ${i.id}`, [{ key: 'id', label: 'New ID', type: 'number', value: i.id, min: 1, max: 999 }], 'Move',
      'Moving replaces any object already at the new ID. References from programs or keymaps are not updated.');
    if (!r || r.id === i.id) return;
    try { await app.client.moveObject(i.type, i.id, r.id); refresh(); } catch (err) { app.error(err, 'Move'); }
  }

  async function del(i) {
    if (!(await confirmDialog('Delete object', `Delete ${typeName(i.type)} ${i.id} "${i.objName}" from RAM?`, 'Delete', true))) return;
    try { await app.client.deleteObject(i.type, i.id); app.refreshMemory(); refresh(); } catch (err) { app.error(err, 'Delete'); }
  }

  async function bulkDelete() {
    const ids = [...st.selected].filter((id) => st.items.find((x) => x.id === id)?.inRam);
    if (!ids.length) { toast('Select RAM objects first', 'warn'); return; }
    if (!(await confirmDialog('Delete objects', `Delete ${ids.length} RAM objects?`, 'Delete', true))) return;
    for (const id of ids) { try { await app.client.deleteObject(st.type, id); } catch (err) { app.error(err, `Delete ${id}`); } }
    st.selected.clear();
    app.refreshMemory();
    refresh();
  }

  async function moveBankDialog() {
    const r = await formDialog('Move bank', [
      { key: 'bank', label: 'From bank (0-9)', type: 'number', value: 2, min: 0, max: 9 },
      { key: 'to', label: 'To bank (0-9)', type: 'number', value: 3, min: 0, max: 9 },
      { key: 'all', label: 'Object types', type: 'select', value: 'this', options: [{ value: 'this', label: `Only ${TYPE_BY_ID[st.type].name}` }, { value: 'all', label: 'All types' }] },
    ], 'Move');
    if (!r) return;
    try { await app.client.moveBank(r.all === 'all' ? 0 : st.type, r.bank, r.to); toast('Bank moved', 'good'); refresh(); } catch (err) { app.error(err, 'Move bank'); }
  }

  async function deleteBankDialog() {
    const r = await formDialog('Delete bank', [
      { key: 'bank', label: 'Bank (0-9)', type: 'number', value: 2, min: 0, max: 9 },
      { key: 'all', label: 'Object types', type: 'select', value: 'this', options: [{ value: 'this', label: `Only ${TYPE_BY_ID[st.type].name}` }, { value: 'all', label: 'All types' }] },
    ], 'Delete', 'This deletes RAM objects without further confirmation on the K2000. Do not send other MIDI while it works.');
    if (!r) return;
    if (!(await confirmDialog('Really delete?', `Delete ${r.all === 'all' ? 'all RAM objects' : TYPE_BY_ID[st.type].name} in bank ${r.bank}?`, 'Delete', true))) return;
    await app.client.deleteBank(r.all === 'all' ? 0 : st.type, r.bank);
    toast('Bank deleted', 'good');
    app.refreshMemory();
    refresh();
  }

  async function sendSyxFiles(files) {
    let sent = 0;
    let failed = 0;
    for (const f of files) {
      const msgs = sysexMessages(new Uint8Array(await f.arrayBuffer()));
      for (const m of msgs) {
        const p = parse(m);
        if (!p || p.msg !== MSG.WRITE) continue;
        try { await app.client.sendWriteMessage(m); sent++; } catch (err) { failed++; app.error(err, `${typeName(p.type)} ${p.id}`); }
      }
    }
    toast(`Sent ${sent} objects${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'good');
    app.refreshMemory();
    refresh();
  }

  async function importSyx() {
    const files = await pickFiles('.syx,.SYX', true);
    if (files.length) sendSyxFiles(files);
  }

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); sendSyxFiles([...e.dataTransfer.files]); });

  refresh();
  return null;
}
