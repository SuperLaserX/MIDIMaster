// Object editor: shows a device object (patch, performance, system settings) with
// the values read from the device, sends each change live, and offers the object's
// own actions (send, store, recall) and a slot browser for its memory banks.
//
// Definition (def.objects[]):
//   key, page, label, size
//   notLive: true                        changes are not sent as they are made (an action sends them)
//   init() -> Uint8Array                 default contents before anything is fetched
//   request(ctx) -> bytes, match(raw) -> bool, decode(raw, ctx) -> Uint8Array
//   fetch(api) -> Promise<Uint8Array>      instead of request/match/decode, for multi-message reads
//   autoLoad: true                       read when the device connects (see GenericContext.loadStandard);
//                                        otherwise read when its page is first shown (after the connect reads)
//   slots.namesOnOpen: true              a bank's names are read the first time the bank is shown
//                                        (slots.autoNames: read when the device connects instead)
//   sections: [{key, label}]             params with `section` are shown one section at a time;
//   emptySection(section, data) -> text  shown when every parameter of a section is hidden
//   warning: text | (ctx) -> text        shown as a warning at the top of the page (e.g. a screen the
//                                        device must show for the page's messages to be taken)
//   galleries: [{..., after: section}]   a gallery with `after` is a tab of this page after that
//                                        section (views/gallery.js); the others are pages of their own
//   params: [...]                        see core/model/memmap.js; plus send(v, ctx, data) -> message(s)
//                                        and dynamic(data, ctx) -> {label, options, format, max, hidden}
//                                        for parameters whose meaning depends on other values.
//                                        Parameters with options show as a list; input: 'number' as a
//                                        typed number; the rest as knobs (click the value to type it).
//                                        readOnly: true shows the value without letting it change.
//                                        after(data, value, ctx) -> message?  runs once a change is sent: other
//                                        values the device changes with it (e.g. the VC-2 loading an
//                                        algorithm's INIT PATCH); a returned message is shown.
//   groupInfo: {[group]: {note, table, wide, pattern}}  a note under a card's title; table: one row per
//                                        parameter with a typed value (for raw or undocumented bytes);
//                                        pattern({data, params, ctx}) -> a pattern model (core/ui/stepgrid.js)
//                                        whose lanes hold step parameters and header parameters: the
//                                        card shows a step grid / tracker instead of controls;
//                                        draw({data, params, ctx, set(key, value), prev}) -> Element: a
//                                        graphic (algorithm diagram, envelope...) above the card's
//                                        controls, redrawn after every change; prev is the element it
//                                        returned last time (update it in place to keep a drag going);
//                                        set changes a parameter as its control would
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
import { patternEditor } from '../../../core/ui/stepgrid.js';
import { readParam, writeParam, paramRange, formatParam } from '../../../core/model/memmap.js';
import { sysexMessages } from '../../../core/midi/smf.js';
import { sendOut, isEcho, objectApi, loadObject, canFetch, bankNames, canScan, readBankNames } from '../objects.js';
import { importFromMainLibrary } from './mainlib-pick.js';
import { galleryGrid, galleryNote } from './gallery.js';

export function editorView(root, g, params = {}, obj) {
  const st = { bank: obj.slots?.banks?.[0]?.[0] ?? 0, section: obj.sections?.[0]?.key, scanning: false, patternView: {} };
  g.activeObject = obj.key; // mapped controllers (MIDI inputs) change the page shown last first
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
    const said = p.after?.(d, value, g.ctx);
    if (said) toast(said, 'info');
    if (p.relayout || p.after) render();
    else { renderHead(); for (const name of drawn.keys()) paint(name); }
  }

  // ------------------------------------------------------------ controls
  const view = (p) => (p.dynamic ? { ...p, ...p.dynamic(data(), g.ctx) } : p);

  // Inside a card the card's title is not repeated: "Part 1 Receive Channel" in "Part 1" reads
  // "Receive Channel" (the tooltip keeps the full name).
  const shortLabel = (label, group) => (group && label.length > group.length + 1 && label.startsWith(`${group} `) ? label.slice(group.length + 1) : label);

  function control(p0, group) {
    const p = view(p0);
    const value = readParam(data(), p);
    const label = shortLabel(p.label, group);
    let el;
    if (p.options) {
      const opts = p.options.map(([v, l]) => ({ value: v, label: l }));
      if (!opts.some((o) => o.value === value)) opts.push({ value, label: String(value) });
      el = selectField({ label, value, options: opts, readOnly: p.readOnly, onChange: (v) => change(p0, v, el) });
      el.title = p.help || p.label;
    } else if (p.input === 'number' || p.readOnly) {
      const { min, max } = paramRange(p);
      el = numberField({ label, value, min, max, readOnly: p.readOnly, format: p.format || p.unit ? (v) => formatParam(p, v) : null, onChange: (v) => change(p0, v, el) });
      el.title = p.help || `${p.label}: ${min}-${max}`;
    } else {
      const { min, max } = paramRange(p);
      el = knob({ label, value, min, max, format: (v) => formatParam(p, v), onChange: (v) => change(p0, v, el), title: p.help || p.label });
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

  // Graphics a card draws from the data (groupInfo.draw), redrawn after every change.
  const drawn = new Map(); // group -> {el, info, holder}
  function paint(name) {
    const d = drawn.get(name);
    if (!d) return;
    const el = d.info.draw({
      data: data(), params: obj.params, ctx: g.ctx, prev: d.el,
      set: (key, v) => { const p = obj.params.find((x) => x.key === key); if (p) change(p, v); },
    });
    if (el && el !== d.el) { clear(d.holder).append(el); d.el = el; }
  }

  function groupCard(name, ps, rows, wide) {
    const byKey = new Map(ps.map((p) => [p.key, p]));
    const info = obj.groupInfo?.[name];
    let content;
    if (info?.table) content = paramTable(ps);
    else if (info?.pattern) {
      const model = info.pattern({ data: data(), params: obj.params, ctx: g.ctx });
      content = patternEditor({
        model,
        view: st.patternView[name],
        onView: (v) => { st.patternView[name] = v; },
        read: (p) => readParam(data(), view(p)),
        write: (p, v) => change(p, v),
        format: (p, v) => formatParam(view(p), v),
        header: (lane) => (lane.header?.length ? h('div.params', lane.header.map((p) => control(p))) : null),
      });
    }
    else if (rows) {
      content = h('div.col.rows', rows.map((r) => h('div.row.param-row', h('div.row-label', r.label),
        h('div.params', r.keys.map((k) => byKey.get(k)).filter(Boolean).map((p) => control(p, name))))));
    } else content = h('div.params', ps.map((p) => control(p, name)));
    return h('div.card' + (wide || info?.wide ? '.wide' : ''), h('div.card-head', h('h2', name)),
      info?.note ? h('p.small.muted', info.note) : null,
      info?.draw ? (() => { const holder = h('div.card-draw'); drawn.set(name, { el: null, info, holder }); paint(name); return holder; })() : null,
      content);
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
      obj.fromSyx ? h('button.btn', { onclick: importSyx }, 'Import .syx') : null,
      obj.init && obj.params?.length && g.host?.shell?.mainLibrary ? h('button.btn', { title: `Load a Head Library patch into this page (another model's through its translator), send it to the edit buffer or store it`, onclick: () => importFromMainLibrary(g, obj).catch((err) => g.error(err, 'Import from Head Library')) }, 'Import from Head Library...') : null),
    !loaded() && canFetch(obj)
      ? h('div.notice', g.loading.has(obj.key) ? `Reading the ${obj.label.toLowerCase()} from the ${g.entry.model}...`
        : `Showing default values. Press Get from device to load the ${obj.label.toLowerCase()} from the ${g.entry.model}${obj.notLive ? '.' : '; every change is sent as you make it.'}`)
      : null,
    obj.warning ? h('div.notice.warn', h('b', 'Note: '), typeof obj.warning === 'function' ? obj.warning(g.ctx) : obj.warning) : null,
    obj.note ? h('p.small.muted', typeof obj.note === 'function' ? obj.note(g.ctx) : obj.note) : null);
  }

  // Sections (tones, parts, keys...): params carry `section`; one section is shown at a time. A gallery
  // with `after` is a tab of its own after that section (the DX voice: Voice, Algorithm, OP1...).
  const tabGalleries = (obj.galleries || []).filter((x) => x.after !== undefined);
  const sections = obj.sections ? obj.sections.flatMap((x) => [x, ...tabGalleries.filter((gal) => gal.after === x.key).map((gal) => ({ key: `gallery:${gal.key}`, label: gal.page, gallery: gal }))]) : null;
  const galleryTab = () => sections?.find((x) => x.key === st.section)?.gallery || null;
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
    drawn.clear();
    clear(body);
    const bar = sectionBar();
    if (bar) body.append(bar);
    const gal = galleryTab();
    if (gal) {
      body.append(h('div.sub', galleryNote(g, obj, gal)), galleryGrid(g, obj, gal) || h('div.notice.bad', `No parameter ${gal.param} in ${obj.label}.`));
      if (obj.slots) renderSlots();
      return;
    }
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
    if (!cards.length && sections) body.append(h('div.notice', obj.emptySection?.(st.section, d) || 'Nothing in this section applies to the current settings.'));
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
    const bankSel = h('select', { onchange: () => { st.bank = Number(bankSel.value); renderSlots(); autoNames(); } },
      banks.map(([v, l]) => h('option', { value: v, selected: v === st.bank }, l)));
    const names = bankNames(g, obj, st.bank);
    const count = typeof s.count === 'function' ? s.count(st.bank, g.ctx) : s.count;
    const writable = s.store && s.writable?.(st.bank, g.ctx) !== false;
    const rows = [];
    for (let i = 0; i < count; i++) {
      // a name remembered from an earlier session, not read from the device again yet
      const old = !names.fixed && g.nameUnconfirmed?.(obj.key, st.bank, i);
      rows.push(h('tr',
        h('td.mono.muted', s.slotLabel ? s.slotLabel(st.bank, i) : String(i + 1)),
        h('td.small' + (old ? '.muted' : ''), old ? { title: 'Remembered from the last time; not read from the device again yet' } : {}, names.get(i) ?? ''),
        h('td.row.slot-btns',
          s.recall || s.play ? h('button.btn.small', { title: 'Select this slot on the device', onclick: () => playSlot(i) }, 'Play') : null,
          s.fetch ? h('button.btn.small', { title: 'Read this slot into the editor', onclick: () => loadSlot(i) }, 'Edit') : null,
          writable ? h('button.btn.small', { title: 'Save the editor contents into this slot', onclick: () => storeSlot(i) }, 'Store') : null)));
    }
    const note = typeof s.note === 'function' ? s.note(st.bank, g.ctx) : s.note;
    // names still on their way (read in the background when the device connected)
    const pending = (s.autoNames || []).includes(st.bank) && (names.get(count - 1) == null || !!g.namesPending?.(obj.key, st.bank));
    const reading = pending && g.loadingStandard ? h('div.small.c-info', 'Reading names from the device...') : null;
    clear(slotsEl).append(h('div.card.slots',
      h('div.card-head', h('h2', s.label || 'Memory'), bankSel),
      note ? h('div.small.muted', note) : null,
      reading,
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

  async function scanNames({ ask = true } = {}) {
    const bank = st.bank;
    const note = obj.slots.scanNote?.(bank, g.ctx);
    if (ask && note && !(await confirmDialog('Read names', note, 'Read names'))) return;
    st.scanning = true;
    renderSlots();
    try {
      await readBankNames(g, obj, bank, { onProgress: (n, total) => g.setBusy(1, `Reading ${n}/${total}`), shouldStop: () => !g.connected });
      g.reportNameChanges?.();
    } catch (err) { g.error(err, 'Read names'); } finally { st.scanning = false; g.setBusy(0); renderSlots(); }
  }

  async function storeSlot(i) {
    const label = obj.slots.slotLabel?.(st.bank, i) ?? String(i + 1);
    if (!(await confirmDialog('Store', `Store the editor contents into ${label}? This replaces what is there.`, 'Store', true))) return;
    send(obj.slots.store(st.bank, i, g.ctx, data()));
    if (!bankNames(g, obj, st.bank).fixed) g.setSlotName(obj.key, st.bank, i, obj.slots.name?.(data()) ?? '');
    toast(`Stored into ${label}`, 'good', 1500);
  }

  // slots.namesOnOpen: the bank shown has its names read the first time it is shown in this session
  // (when none were read or remembered names wait to be confirmed); one bank at a time, in the background
  function autoNames() {
    const s = obj.slots;
    if (!s?.namesOnOpen || st.scanning || !g.connected || g.loadingStandard || g.job || !canScan(obj, st.bank, g.ctx)) return;
    const names = bankNames(g, obj, st.bank);
    if (names.fixed) return;
    const count = typeof s.count === 'function' ? s.count(st.bank, g.ctx) : s.count;
    if (names.get(count - 1) != null && !g.namesPending?.(obj.key, st.bank)) return;
    const done = (g.namesOpened ??= new Set());
    const key = `${obj.key}:${st.bank}`;
    if (done.has(key)) return;
    done.add(key);
    scanNames({ ask: false });
  }

  // read what this page shows: now, or once the reads started when the device connected are done
  let alive = true;
  const openReads = () => {
    if (!alive || g.job) return; // a dump in the background: no reads until it is done
    if (!loaded() && canFetch(obj) && g.connected && !g.loading.has(obj.key) && params.autoFetch !== false) fetchObject().then(() => alive && autoNames());
    else autoNames();
  };
  render();
  if (g.loadingStandard) offs.push(g.on('standard-loaded', openReads));
  else openReads();
  return { destroy() { alive = false; for (const off of offs) off?.(); } };
}
