// Object editor: shows a device object (patch, performance, system settings) with
// the values read from the device, sends each change live, and offers the object's
// own actions (send, store, recall) and a slot browser for its memory banks.
//
// Definition (def.objects[]):
//   key, page, label, size
//   init() -> Uint8Array                 default contents before anything is fetched
//   request(ctx) -> bytes, match(raw) -> bool, decode(raw, ctx) -> Uint8Array
//   fetch(api) -> Promise<Uint8Array>      instead of request/match/decode, for multi-message reads
//   autoLoad: true                       read when the device connects (see GenericContext.loadStandard)
//   sections: [{key, label}]             params with `section` are shown one section at a time
//   params: [...]                        see core/model/memmap.js; plus send(v, ctx, data) -> message(s)
//                                        and dynamic(data, ctx) -> {label, options, format, max, hidden}
//                                        for parameters whose meaning depends on other values.
//                                        Parameters with options show as a list; input: 'number' as a
//                                        typed number; the rest as knobs (click the value to type it).
//                                        readOnly: true shows the value without letting it change.
//   groupInfo: {[group]: {note, table, wide}}  a note under a card's title; table: one row per
//                                        parameter with a typed value (for raw or undocumented bytes)
//   sendParam(p, v, data, ctx)           used when a parameter has no send()
//   layout: [{group, rows?: [{label, keys}], wide?}]  optional card order, row layout, full-width cards
//   sendAll: {label, build(data, ctx)}   sends the whole object (e.g. to the edit buffer)
//   actions: [{label, title, run(api)}]  extra buttons (store, initialise...)
//   target: {label, options(ctx) -> [[value, label]], value(), set(value)}
//                                        which copy on the device is edited (e.g. patch mode or a part)
//   receive(raw, data, ctx) -> Uint8Array | null   apply a message the device sent on its own
//   name(data) -> string                 display name
//   toSyx(data, ctx) / fromSyx(msgs)     .syx export and import
//   slots: {label, banks: [[value, label]], count, slotLabel(bank, i),
//           fetch(api, bank, slot) -> Promise<Uint8Array>, recall(bank, slot, ctx),
//           store(bank, slot, ctx, data), writable(bank), name(data),
//           play(api, bank, slot) (async Play, instead of sending recall())}  (more in ../objects.js)

import { h, clear, toast, confirmDialog, downloadBlob, pickFiles, safeFileName } from '../../../core/ui/dom.js';
import { knob, selectField, numberField } from '../../../core/ui/controls.js';
import { readParam, writeParam, paramRange, formatParam } from '../../../core/model/memmap.js';
import { sysexMessages } from '../../../core/midi/smf.js';
import { sendOut, isEcho, objectApi, loadObject, canFetch, bankNames, canScan, readBankNames } from '../objects.js';

export function editorView(root, g, params = {}, obj) {
  const st = { bank: obj.slots?.banks?.[0]?.[0] ?? 0, section: obj.sections?.[0]?.key, scanning: false };
  const data = () => g.objectData[obj.key] || (g.objectData[obj.key] = obj.init());
  const loaded = () => !!g.loadedKeys?.has(obj.key);
  const head = h('div');
  const body = h('div');
  const slotsEl = h('div');
  root.append(head, obj.slots ? h('div.row.editor-split', h('div.grow', body), slotsEl) : body);

  const send = (out, key) => sendOut(g, out, key);
  const api = objectApi(g, obj, { refresh: () => render() });

  // ------------------------------------------------------------ device I/O
  async function fetchObject() {
    if (!canFetch(obj)) return;
    try {
      g.setBusy(1, `Reading ${obj.label}`);
      g.loading.add(obj.key);
      await loadObject(g, obj, api);
      toast(`${obj.label} received`, 'good', 1500);
    } catch (err) { g.error(err, `Read ${obj.label}`); } finally { g.loading.delete(obj.key); g.setBusy(0); }
  }

  const offs = [
    g.on('object', (key) => { if (key === obj.key) render(); }),
    g.on('names', (key) => { if (key === obj.key && obj.slots) renderSlots(); }),
    g.on('refresh', () => render()),
  ];
  if (obj.receive) {
    const onMsg = (_msg, raw) => {
      if (!raw || isEcho(g, raw)) return;
      const next = obj.receive(raw, data(), g.ctx);
      if (next) { g.objectData[obj.key] = Uint8Array.from(next); render(); }
    };
    g.client.on('unsolicited', onMsg);
    offs.push(() => g.client.off?.('unsolicited', onMsg));
  }

  function change(p, v, ctl) {
    const d = data();
    if (!writeParam(d, p, v)) return;
    const value = readParam(d, p);
    const out = p.send ? p.send(value, g.ctx, d) : obj.sendParam?.(p, value, d, g.ctx);
    if (out) send(out, `${obj.key}:${p.sendKey || p.key}`);
    ctl?.setState?.(null);
    if (p.relayout) render();
    else renderHead();
  }

  // ------------------------------------------------------------ controls
  const view = (p) => (p.dynamic ? { ...p, ...p.dynamic(data(), g.ctx) } : p);

  function control(p0) {
    const p = view(p0);
    const value = readParam(data(), p);
    let el;
    if (p.options) {
      const opts = p.options.map(([v, l]) => ({ value: v, label: l }));
      if (!opts.some((o) => o.value === value)) opts.push({ value, label: String(value) });
      el = selectField({ label: p.label, value, options: opts, readOnly: p.readOnly, onChange: (v) => change(p0, v, el) });
      if (p.help) el.title = p.help;
    } else if (p.input === 'number' || p.readOnly) {
      const { min, max } = paramRange(p);
      el = numberField({ label: p.label, value, min, max, readOnly: p.readOnly, format: p.format || p.unit ? (v) => formatParam(p, v) : null, onChange: (v) => change(p0, v, el) });
      el.title = p.help || `${p.label}: ${min}-${max}`;
    } else {
      const { min, max } = paramRange(p);
      el = knob({ label: p.label, value, min, max, format: (v) => formatParam(p, v), onChange: (v) => change(p0, v, el), title: p.help || p.label });
    }
    return el;
  }

  /** A table row per parameter: label and description, a typed value, its reading and range. */
  function paramTable(ps) {
    return h('div.table-wrap', h('table.list.param-table',
      h('thead', h('tr', h('th', 'Byte'), h('th', 'Probable use'), h('th', 'Value'), h('th', 'Reads as'), h('th', 'Range'))),
      h('tbody', ps.map((p0) => {
        const p = view(p0);
        const { min, max } = paramRange(p);
        const shown = h('td.small');
        const show = (v) => { shown.textContent = p.format || p.options ? formatParam(p, v) : ''; };
        const inp = h('input', {
          type: 'number', min, max, value: readParam(data(), p),
          onchange: () => {
            const v = Math.max(min, Math.min(max, Math.round(Number(inp.value) || 0)));
            inp.value = v;
            show(v);
            change(p0, v);
          },
        });
        show(readParam(data(), p));
        return h('tr', h('td.mono', p.label), h('td.small', p.help || ''), h('td', inp), shown, h('td.small.muted.mono', `${min}-${max}`));
      }))));
  }

  function groupCard(name, ps, rows, wide) {
    const byKey = new Map(ps.map((p) => [p.key, p]));
    const info = obj.groupInfo?.[name];
    let content;
    if (info?.table) content = paramTable(ps);
    else if (rows) {
      content = h('div.col.rows', rows.map((r) => h('div.row.param-row', h('div.row-label', r.label),
        h('div.params', r.keys.map((k) => byKey.get(k)).filter(Boolean).map(control)))));
    } else content = h('div.params', ps.map(control));
    return h('div.card' + (wide || info?.wide ? '.wide' : ''), h('div.card-head', h('h2', name)),
      info?.note ? h('p.small.muted', info.note) : null, content);
  }

  function targetSelect() {
    const t = obj.target;
    if (!t) return null;
    const sel = h('select', {
      title: t.title || '',
      onchange: () => { t.set(sel.value); g.loadedKeys?.delete(obj.key); render(); if (g.connected) fetchObject(); },
    }, t.options(g.ctx).map(([v, l]) => h('option', { value: v, selected: String(v) === String(t.value()) }, l)));
    return h('label.row.target', h('span.muted', t.label), sel);
  }

  function renderHead() {
    const name = obj.name?.(data());
    clear(head).append(h('div.row.obj-head',
      h('h1.grow', obj.label, name ? h('span.muted', `  ${name}`) : null),
      targetSelect(),
      canFetch(obj) ? h('button.btn.primary', { onclick: fetchObject, title: `Read the ${obj.label.toLowerCase()} from the ${g.entry.model}` }, 'Get from device') : null,
      obj.sendAll ? h('button.btn', { onclick: () => send(obj.sendAll.build(data(), g.ctx)), title: obj.sendAll.title || '' }, obj.sendAll.label) : null,
      ...(obj.actions || []).map((a) => h('button.btn', { title: a.title || '', onclick: () => Promise.resolve(a.run(api)).catch((err) => g.error(err, a.label)) }, a.label)),
      obj.toSyx ? h('button.btn', { onclick: exportSyx }, 'Export .syx') : null,
      obj.fromSyx ? h('button.btn', { onclick: importSyx }, 'Import .syx') : null),
    !loaded() && canFetch(obj)
      ? h('div.notice', g.loading.has(obj.key) ? `Reading the ${obj.label.toLowerCase()} from the ${g.entry.model}...`
        : `Showing default values. Press Get from device to load the ${obj.label.toLowerCase()} from the ${g.entry.model}; every change is sent as you make it.`)
      : null,
    obj.note ? h('p.small.muted', typeof obj.note === 'function' ? obj.note(g.ctx) : obj.note) : null);
  }

  // Sections (tones, parts, keys...): params carry `section`; one section is shown at a time.
  const sections = obj.sections || null;
  function sectionBar() {
    if (!sections) return null;
    const pick = (key) => { st.section = key; render(); };
    if (sections.length > 12) {
      const sel = h('select', { onchange: () => pick(sel.value) }, sections.map((x) => h('option', { value: x.key, selected: x.key === st.section }, x.label)));
      return h('div.row.section-bar', h('span.muted', obj.sectionLabel || 'Section'), sel);
    }
    return h('div.row.section-bar', sections.map((x) => h('button.btn.small' + (x.key === st.section ? '.primary' : ''), { onclick: () => pick(x.key) }, x.label)));
  }

  function render() {
    renderHead();
    clear(body);
    const bar = sectionBar();
    if (bar) body.append(bar);
    const groups = new Map();
    const d = data();
    for (const p of obj.params) {
      if (p.hidden || (p.dynamic && p.dynamic(d, g.ctx).hidden)) continue;
      if (sections && p.section !== undefined && p.section !== st.section) continue;
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group).push(p);
    }
    const layout = obj.layout || [...groups.keys()].map((group) => ({ group }));
    const cards = layout.map((l) => (groups.get(l.group) ? groupCard(l.group, groups.get(l.group), l.rows, l.wide) : null)).filter(Boolean);
    body.append(h('div.grid.cols-' + (obj.cols || 3), cards));
    if (obj.slots) renderSlots();
  }

  // ------------------------------------------------------------ files
  function exportSyx() {
    const bytes = obj.toSyx(data(), g.ctx);
    downloadBlob(Uint8Array.from(bytes), `${safeFileName(`${g.entry.model} ${obj.name?.(data()) || obj.label}`)}.syx`, 'application/octet-stream');
  }

  async function importSyx() {
    const files = await pickFiles('.syx,.mid', false);
    if (!files?.length) return;
    const msgs = sysexMessages(new Uint8Array(await files[0].arrayBuffer())); // .syx or a MIDI file
    const d = obj.fromSyx(msgs);
    if (!d) { toast(`No ${obj.label.toLowerCase()} found in that file.`, 'warn'); return; }
    g.setObjectData(obj.key, d);
    toast('Loaded into the editor. Use the send button to put it on the device.', 'info');
  }

  // ------------------------------------------------------------ slots
  function renderSlots() {
    const s = obj.slots;
    const banks = typeof s.banks === 'function' ? s.banks(g.ctx) : s.banks;
    const bankSel = h('select', { onchange: () => { st.bank = Number(bankSel.value); renderSlots(); } },
      banks.map(([v, l]) => h('option', { value: v, selected: v === st.bank }, l)));
    const names = bankNames(g, obj, st.bank);
    const count = typeof s.count === 'function' ? s.count(st.bank, g.ctx) : s.count;
    const writable = s.store && s.writable?.(st.bank, g.ctx) !== false;
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(h('tr',
        h('td.mono.muted', s.slotLabel ? s.slotLabel(st.bank, i) : String(i + 1)),
        h('td.small', names.get(i) ?? ''),
        h('td.row.slot-btns',
          s.recall || s.play ? h('button.btn.small', { title: 'Select this slot on the device', onclick: () => playSlot(i) }, 'Play') : null,
          s.fetch ? h('button.btn.small', { title: 'Read this slot into the editor', onclick: () => loadSlot(i) }, 'Edit') : null,
          writable ? h('button.btn.small', { title: 'Save the editor contents into this slot', onclick: () => storeSlot(i) }, 'Store') : null)));
    }
    const note = typeof s.note === 'function' ? s.note(st.bank, g.ctx) : s.note;
    clear(slotsEl).append(h('div.card.slots',
      h('div.card-head', h('h2', s.label || 'Memory'), bankSel),
      note ? h('div.small.muted', note) : null,
      canScan(obj, st.bank, g.ctx)
        ? h('button.btn.small', { onclick: scanNames, disabled: st.scanning, title: 'Read every name in this bank' }, st.scanning ? 'Reading...' : 'Read names')
        : null,
      h('div.table-wrap.slot-table', h('table.list', h('tbody', rows)))));
  }

  async function playSlot(i) {
    const s = obj.slots;
    if (!s.play) { send(s.recall(st.bank, i, g.ctx)); return; }
    try { g.setBusy(1, `Selecting ${s.slotLabel?.(st.bank, i) ?? i + 1}`); await s.play(api, st.bank, i); } catch (err) { g.error(err, 'Play'); } finally { g.setBusy(0); }
  }

  async function loadSlot(i) {
    try {
      g.setBusy(1, `Reading ${obj.slots.slotLabel?.(st.bank, i) ?? i + 1}`);
      const d = await obj.slots.fetch(api, st.bank, i);
      if (!bankNames(g, obj, st.bank).fixed) g.setSlotName(obj.key, st.bank, i, obj.slots.name?.(d) ?? '');
      g.setObjectData(obj.key, d);
    } catch (err) { g.error(err, 'Read slot'); } finally { g.setBusy(0); }
  }

  async function scanNames() {
    const bank = st.bank;
    const note = obj.slots.scanNote?.(bank, g.ctx);
    if (note && !(await confirmDialog('Read names', note, 'Read names'))) return;
    st.scanning = true;
    renderSlots();
    try {
      await readBankNames(g, obj, bank, { onProgress: (n, total) => g.setBusy(1, `Reading ${n}/${total}`), shouldStop: () => !g.connected });
    } catch (err) { g.error(err, 'Read names'); } finally { st.scanning = false; g.setBusy(0); renderSlots(); }
  }

  async function storeSlot(i) {
    const label = obj.slots.slotLabel?.(st.bank, i) ?? String(i + 1);
    if (!(await confirmDialog('Store', `Store the editor contents into ${label}? This replaces what is there.`, 'Store', true))) return;
    send(obj.slots.store(st.bank, i, g.ctx, data()));
    if (!bankNames(g, obj, st.bank).fixed) g.setSlotName(obj.key, st.bank, i, obj.slots.name?.(data()) ?? '');
    toast(`Stored into ${label}`, 'good', 1500);
  }

  render();
  if (!loaded() && canFetch(obj) && g.connected && !g.loading.has(obj.key) && !g.loadingStandard && params.autoFetch !== false) fetchObject();
  return { destroy() { for (const off of offs) off?.(); } };
}
