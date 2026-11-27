// Program editor: every parameter of a program on one screen, edited live.
// The pages, parameter names, value ranges and value texts all come from the
// K2000 OS (model/fwmodel.js), so the editor shows what the K2000 shows.
// Each change is sent as a LOAD of the changed byte(s) at their offset in the
// stored program. The K2000 swaps in the edited object and marks any channel
// playing it as changed, so the next notes use the new values.

import { h, clear, toast, formDialog, confirmDialog, downloadBlob, safeFileName } from '../../../core/ui/dom.js';
import { hexRow } from '../../../core/ui/controls.js';
import { envelopeEditor } from '../envelope.js';
import { Program, TAG, segmentLength, segmentName } from '../model/program.js';
import {
  ProgramMap, pageEntries, paramValues, paramRange, algorithmSelectors, algorithmParam, ALGORITHMS,
  blocksForAlgorithm, DSP_FUNCTIONS,
} from '../model/fwmodel.js';
import { algorithmDiagram, describeAlgorithm } from '../model/algorithms.js';
import { fwCard, fwControl } from './fwpage.js';
import { T } from '../model/types.js';
import { fmt, noteName } from '../model/tables.js';
import { build } from '../protocol.js';
import { K2Error } from '../client.js';

const MAX_LAYERS = 3;
const LAST_KEY = 'midimaster.k2000.lastProgram';

// Firmware page ids (title objects) of the K2000 Program Editor.
const PG = {
  COMMON: 0x51, LAYER: 0x52, KEYMAP: 0x53, OUTPUT: 0x54, PITCH: 0x55, AMPENV: 0x56, ENV2: 0x57,
  ENV3: 0x58, ENVCTL: 0x59, LFO: 0x5a, ASR: 0x5b, VTRIG: 0x5c, FUN: 0x5d, EFFECT: 0x5e,
};

// LAYER page row "S" holds the enable control's sense and its low/high window.
const LAYER_NAMES = { '9:2': 'Enable sense', '1:0': 'Enable low', '11:0': 'Enable high' };

// The OUTPUT page overlays layouts for one- and two-output algorithms; name its fields by block.
const OUTPUT_NAMES = {
  '286:14:3:2': 'Pair', '286:15:4:4': 'Pan', '286:15:2:2': 'Mode', '286:14:0:3': 'Gain', '286:3:4:4': 'Pan 2',
  '285:14:3:2': 'Upper Pair', '285:15:4:4': 'Upper Pan', '285:15:2:2': 'Upper Mode', '285:14:0:3': 'Upper Gain', '285:3:4:4': 'Upper Pan 2',
};

export function programView(root, app, params = {}) {
  const st = {
    prog: null, map: null, layer: 0, live: true, dirty: false, undo: [], redo: [],
    list: [], listBank: 127, editorLock: false,
  };
  let stored = 0;
  try { stored = Number(localStorage.getItem(LAST_KEY) || 0); } catch { /* storage unavailable */ }
  const lastId = params.id ?? (stored || null);

  const listEl = h('div.table-wrap', { style: { maxHeight: 'calc(100vh - 230px)' } });
  const editor = h('div.grow', { style: { minWidth: 0 } });
  root.append(h('div.row', { style: { alignItems: 'flex-start', gap: '16px', flexWrap: 'nowrap' } },
    h('div', { style: { width: '250px', flex: '0 0 250px' } }, programListHeader(), listEl),
    editor));

  if (!app.connected || !app.online) {
    editor.append(h('div.notice.warn', 'Connect to the K2000 first. ', h('button.btn.small', { onclick: () => app.nav('connect') }, 'Connect')));
  }

  const names = (type, id) => {
    const n = app.nameOf(type, id);
    if (n === undefined) app.lookupName(type, id).then((x) => { if (x) scheduleRedraw(); });
    return n;
  };
  let redrawTimer = null;
  function scheduleRedraw() {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { if (st.prog) { renderCommon(); renderLayerStrip(); renderLayerArea(); } }, 300);
  }

  // ------------------------------------------------------------ program list
  function programListHeader() {
    const bankSel = h('select', { onchange: () => { st.listBank = Number(bankSel.value); loadList(); } },
      h('option', { value: 127 }, 'All banks'),
      Array.from({ length: 10 }, (_, b) => h('option', { value: b }, `Bank ${b} (${b * 100 || 1}-${b * 100 + 99})`)));
    const filter = h('input', { type: 'text', placeholder: 'Filter', oninput: () => renderList(filter.value) });
    return h('div.col', { style: { marginBottom: '8px' } },
      h('div.row', h('h2.grow', 'Programs'), h('button.btn.small', { onclick: loadList }, 'Refresh')),
      h('div.row', bankSel, filter));
  }

  async function loadList(useStandard = false) {
    if (!app.online) return;
    clear(listEl).append(h('div.empty', 'Loading program list...'));
    try {
      // The list read when the K2000 connected covers all banks.
      const cached = useStandard && st.listBank === 127 ? app.standard?.programs : null;
      if (cached) app.standard.programs = null; // used once; later visits read it again
      const infos = cached || await app.client.dirBank(T.PROGRAM, st.listBank, false);
      infos.forEach((i) => app.rememberInfo(i));
      st.list = infos.filter((i) => i.size > 0).sort((a, b) => a.id - b.id);
      renderList('');
    } catch (err) { clear(listEl).append(h('div.empty', err.message)); }
  }

  function renderList(filterText) {
    const f = (filterText || '').toLowerCase();
    const rows = st.list.filter((i) => !f || i.objName.toLowerCase().includes(f) || String(i.id).startsWith(f));
    clear(listEl).append(h('table.list', h('tbody', rows.map((i) => h('tr' + (st.prog && st.prog.id === i.id ? '.sel' : ''), {
      style: { cursor: 'pointer' }, onclick: () => openProgram(i.id),
    }, h('td.mono.muted', String(i.id)), h('td', i.objName), h('td', h('span.badge.' + (i.inRam ? 'ram' : 'rom'), i.inRam ? 'RAM' : 'ROM')))))));
    if (!rows.length) listEl.append(h('div.empty', 'No programs'));
  }

  // ------------------------------------------------------------ open / save
  async function openProgram(id) {
    if (st.dirty && !(await confirmDialog('Discard changes?', 'This program has unsaved changes that were not sent live.', 'Discard', true))) return;
    clear(editor).append(h('div.empty', `Reading program ${id}...`));
    try {
      const obj = await app.client.fetchObject(T.PROGRAM, id);
      setProgram(new Program(obj.data, { id, name: obj.name, inRam: obj.inRam }));
      st.layer = 0; st.undo = []; st.redo = []; st.dirty = false; st.editorLock = false;
      st.live = obj.inRam;
      localStorage.setItem(LAST_KEY, String(id));
      renderEditor();
      renderList(document.querySelector('input[placeholder=Filter]')?.value || '');
    } catch (err) {
      clear(editor).append(h('div.notice.bad', `Could not read program ${id}: ${err.message}`));
    }
  }

  function setProgram(prog) {
    st.prog = prog;
    st.map = new ProgramMap(prog);
  }

  async function saveAs(defaultId) {
    const p = st.prog;
    const r = await formDialog('Save program', [
      { key: 'id', label: 'Program ID (200-999 for RAM)', type: 'number', value: defaultId ?? p.id, min: 1, max: 999 },
      { key: 'name', label: 'Name', value: p.name, maxlength: 16 },
    ], 'Save', 'Saving writes the whole program into K2000 RAM, replacing any RAM program at that ID.');
    if (!r) return;
    try {
      await app.client.writeObject(T.PROGRAM, r.id, r.name, p.data);
      toast(`Saved as program ${r.id}`, 'good');
      app.refreshMemory();
      await loadList();
      await openProgram(r.id);
    } catch (err) { app.error(err, 'Save'); }
  }

  async function saveInPlace() {
    const p = st.prog;
    try {
      await app.client.writeObject(T.PROGRAM, p.id, p.name, p.data);
      st.dirty = false;
      toast(`Program ${p.id} saved`, 'good');
      renderHeader();
    } catch (err) { app.error(err, 'Save'); }
  }

  // ------------------------------------------------------------ live edits
  function sendPatch(patch, ctl) {
    const p = st.prog;
    if (!st.live || !app.online) { st.dirty = true; renderHeader(); return; }
    ctl?.setState?.('pending');
    app.client.load(T.PROGRAM, p.id, patch.offset, patch.bytes, { key: `p${p.id}:${patch.offset}` })
      .then((r) => { if (!r.superseded) ctl?.setState?.(null); if (st.editorLock) { st.editorLock = false; renderHeader(); } })
      .catch((err) => {
        ctl?.setState?.('error');
        st.dirty = true;
        if (err instanceof K2Error && err.reply?.code === 1) {
          st.editorLock = true;
          renderHeader();
        } else app.error(err, 'Live edit');
      });
  }

  function commit(patches, ctl) {
    const list = patches.filter(Boolean);
    if (!list.length) return;
    // Merge continuous drags on the same offset into one undo step.
    const top = st.undo[st.undo.length - 1];
    if (top && top.length === list.length && top.every((t, i) => t.offset === list[i].offset) && Date.now() - top.time < 800) {
      top.forEach((t, i) => { t.bytes = list[i].bytes; });
      top.time = Date.now();
    } else {
      list.time = Date.now();
      st.undo.push(list);
      if (st.undo.length > 200) st.undo.shift();
    }
    st.redo = [];
    for (const patch of list) sendPatch(patch, ctl);
    renderUndoButtons();
  }

  function undo(redo = false) {
    const from = redo ? st.redo : st.undo;
    const to = redo ? st.undo : st.redo;
    const group = from.pop();
    if (!group) return;
    for (const patch of group) {
      st.prog.applyPatch(patch, !redo);
      sendPatch({ offset: patch.offset, bytes: redo ? patch.bytes : patch.before });
    }
    to.push(group);
    renderCommon();
    renderLayerStrip();
    renderLayerArea();
    renderUndoButtons();
  }

  // ------------------------------------------------------------ rendering
  const headEl = h('div');
  const layerStrip = h('div.layer-strip');
  const commonArea = h('div');
  const layerArea = h('div');
  let undoBtn = null;
  let redoBtn = null;

  function renderEditor() {
    clear(editor).append(headEl, commonArea, h('div.section-title', 'Layers'), layerStrip, layerArea);
    renderHeader();
    renderCommon();
    renderLayerStrip();
    renderLayerArea();
  }

  function renderUndoButtons() {
    if (undoBtn) undoBtn.disabled = !st.undo.length;
    if (redoBtn) redoBtn.disabled = !st.redo.length;
  }

  function renderHeader() {
    const p = st.prog;
    if (!p) return;
    const nameInput = h('input.pname', {
      value: p.name, maxlength: 16, title: 'Rename (sent to the K2000 when you press Enter)',
      onkeydown: (e) => { if (e.key === 'Enter') nameInput.blur(); },
      onchange: async () => {
        const name = nameInput.value.slice(0, 16);
        p.name = name;
        if (!p.inRam) { st.dirty = true; renderHeader(); return; }
        try { await app.client.rename(T.PROGRAM, p.id, name); toast('Renamed', 'good', 1500); loadList(); } catch (err) { app.error(err, 'Rename'); }
      },
    });
    const liveBtn = h('button.btn.toggle' + (st.live ? '.on' : ''), {
      title: 'Send each change to the K2000 immediately',
      onclick: () => { st.live = !st.live; renderHeader(); if (st.live && st.dirty) toast('Live editing on. Earlier unsent changes need Save.', 'warn'); },
    }, st.live ? '● Live' : '○ Live');
    undoBtn = h('button.btn', { onclick: () => undo(false), disabled: !st.undo.length, title: 'Undo (Ctrl+Z)' }, 'Undo');
    redoBtn = h('button.btn', { onclick: () => undo(true), disabled: !st.redo.length, title: 'Redo (Ctrl+Y)' }, 'Redo');
    clear(headEl).append(
      h('div.prog-head',
        h('span.mono.muted', `#${p.id}`), nameInput,
        h('span.badge.' + (p.inRam ? 'ram' : 'rom'), p.inRam ? 'RAM' : 'ROM'),
        h('span.badge', `${p.layerCount} layer${p.layerCount === 1 ? '' : 's'}`),
        h('span.badge', `${p.data.length} bytes`),
        st.dirty ? h('span.badge.warn', 'unsaved') : null,
        h('span.grow'),
        liveBtn, undoBtn, redoBtn,
        h('button.btn', { onclick: () => app.client.selectProgram(p.id).then(() => toast(`Selected program ${p.id} on the K2000`, 'info', 1500)), title: 'Select this program on the K2000 so the audition keyboard plays it' }, 'Select on K2000'),
        h('button.btn', { onclick: () => openProgram(p.id) }, 'Revert'),
        p.inRam && st.dirty ? h('button.btn.primary', { onclick: saveInPlace }, 'Save') : null,
        h('button.btn' + (p.inRam ? '' : '.primary'), { onclick: () => saveAs(p.inRam ? p.id : suggestRamId(p.id)) }, p.inRam ? 'Save as...' : 'Copy to RAM...'),
        h('button.btn', { onclick: exportSyx, title: 'Export as a .syx file' }, 'Export')),
      !p.inRam ? h('div.notice', 'This is a factory ROM program. Changes stay in the editor until you copy it to a RAM ID; after that every change is sent live.') : null,
      st.editorLock ? h('div.notice.bad', 'The K2000 refused the change because this program is open in its own Program Editor. Press Exit on the K2000, then change the value again.') : null,
      p.warnings.length ? h('div.notice.warn', p.warnings.join(' ')) : null,
    );
  }

  function suggestRamId(id) { return id < 200 ? id + 200 : id; }

  function exportSyx() {
    const p = st.prog;
    const msg = build.write(0, T.PROGRAM, p.id, 0, p.name, p.data);
    downloadBlob(msg, `${safeFileName(p.name)}_${p.id}.syx`, 'application/octet-stream');
  }

  // ------------------------------------------------------------ firmware pages
  /** Card for a firmware page in the context of `layer` (and DSP `block` for function pages). */
  function pageCard(pageId, title, { layer = st.layer, block = null, group = null, rename = null, onChanged = null, subtitle, extra } = {}) {
    const map = st.map;
    let entries = pageEntries(pageId, group).map((e) => ({ ...e, block }));
    if (rename) entries = entries.map((e) => ({ ...e, name: rename(e) ?? e.name }));
    return fwCard(title, entries, {
      names, subtitle, extra,
      read: (e) => map.read(e.p, layer, e.block),
      write: (e, v, ctl) => {
        commit([map.write(e.p, layer, e.block, v)], ctl);
        onChanged?.(e, v);
      },
    });
  }

  function renderCommon() {
    clear(commonArea);
    if (!st.prog) return;
    const relayout = (e) => { if (e.p.loc === 0x107 && e.p.off === 3 && e.p.sh === 2) { renderCommon(); renderLayerArea(); } };
    const cards = [
      pageCard(PG.COMMON, 'Common', { layer: null, onChanged: relayout }),
      pageCard(PG.EFFECT, 'Effect', { layer: null, rename: effectName, subtitle: 'FX mod targets depend on the effect' }),
    ].filter(Boolean);
    if (cards.length) commonArea.append(h('div.section-title', 'Program'), h('div.grid.cols-2', cards));
  }

  function effectName(e) {
    const { loc, off } = e.p;
    if (loc === 0x113 && off === 2) return 'Effect';
    if (loc === 0x113 && off === 3) return 'Wet/Dry';
    // Page rows: Wet/Dry (value, Source, Depth), then two FX mods (target, Adjust, Source, Depth).
    const mods = {
      6: 'Wet/Dry Source', 7: 'Wet/Dry Depth',
      11: 'Mod 1 Target', 8: 'Mod 1 Adjust', 9: 'Mod 1 Source', 10: 'Mod 1 Depth',
      15: 'Mod 2 Target', 12: 'Mod 2 Adjust', 13: 'Mod 2 Source', 14: 'Mod 2 Depth',
    };
    return loc === 0x107 ? mods[off] : null;
  }

  function renderLayerStrip() {
    const p = st.prog;
    clear(layerStrip);
    p.layers.forEach((_, i) => {
      const s = p.layerSummary(i);
      const kmName = s.keymap ? (app.nameOf(T.KEYMAP, s.keymap) ?? '') : '';
      const tab = h('button.layer-tab' + (i === st.layer ? '.active' : ''), { onclick: () => { st.layer = i; renderLayerStrip(); renderLayerArea(); } },
        h('div.lt-name', `Layer ${i + 1}`),
        h('div.lt-info', `${noteName(s.loKey)}-${noteName(s.hiKey)}  vel ${fmt.velMark(s.loVel)}-${fmt.velMark(s.hiVel)}`),
        h('div.lt-info', `Alg ${s.algorithm}${ALGORITHMS[s.algorithm] ? ` ${ALGORITHMS[s.algorithm]}` : ''}  KM ${s.keymap} ${kmName}`),
        h('div.range-bar', h('div', { style: { left: `${(s.loKey / 127) * 100}%`, width: `${Math.max(1, ((s.hiKey - s.loKey) / 127) * 100)}%` } })));
      layerStrip.append(tab);
      if (s.keymap && app.nameOf(T.KEYMAP, s.keymap) === undefined) {
        app.lookupName(T.KEYMAP, s.keymap).then((n) => { if (n) renderLayerStrip(); });
      }
    });
    const canAdd = p.layerCount < MAX_LAYERS;
    layerStrip.append(h('div.col', { style: { justifyContent: 'center' } },
      h('button.btn.small', { onclick: duplicateLayer, disabled: !canAdd, title: canAdd ? 'Duplicate the selected layer' : `The K2000 allows ${MAX_LAYERS} layers` }, 'Duplicate layer'),
      h('button.btn.small.danger', { onclick: deleteLayer, disabled: p.layerCount <= 1 }, 'Delete layer')));
    const s = p.layerSummary(st.layer);
    if (s) app.keyboard?.highlight([s.loKey, s.hiKey]);
  }

  function renderLayerArea() {
    const p = st.prog;
    clear(layerArea);
    if (!p) return;
    if (!p.layers[st.layer]) { layerArea.append(h('div.empty', 'This program has no layers.')); return; }
    const L = st.layer;
    const keysChanged = (e) => { if (e.p.loc === 0x108 && e.p.off <= 6) renderLayerStrip(); };
    const kmChanged = (e) => { if (e.p.loc === 0x11f) renderLayerStrip(); };

    const section = (title, cards, cols) => {
      const list = cards.filter(Boolean);
      if (list.length) layerArea.append(h('div.section-title', title), h('div.grid.' + cols, list));
    };

    section('Layer, keymap and pitch', [
      pageCard(PG.LAYER, 'Layer', { onChanged: keysChanged, rename: (e) => LAYER_NAMES[`${e.p.off}:${e.p.sh}`] }),
      pageCard(PG.KEYMAP, 'Keymap', { onChanged: kmChanged }),
      pageCard(PG.PITCH, 'Pitch'),
      pageCard(PG.OUTPUT, 'Output', { rename: (e) => OUTPUT_NAMES[`${e.p.loc}:${e.p.off}:${e.p.sh}:${e.p.w}`] }),
      pageCard(PG.VTRIG, 'Velocity triggers'),
    ], 'cols-3');

    section('DSP', dspCards(L), 'cols-3');

    section('Envelopes', [
      envelopeCard(PG.AMPENV, 'AMPENV', 0x10f),
      envelopeCard(PG.ENV2, 'ENV2', 0x110),
      envelopeCard(PG.ENV3, 'ENV3', 0x111),
      pageCard(PG.ENVCTL, 'Envelope control'),
    ], 'cols-2');

    section('Modulation', [
      pageCard(PG.LFO, 'LFOs'),
      pageCard(PG.ASR, 'ASRs'),
      pageCard(PG.FUN, 'FUNs'),
    ], 'cols-3');

    layerArea.append(rawSection(L));
  }

  // ------------------------------------------------------------ DSP
  function dspCards(L) {
    const map = st.map;
    const alg = map.algorithm(L);
    const algP = algorithmParam(alg);
    const redraw = () => { renderLayerStrip(); renderLayerArea(); };
    const cards = [];
    // Algorithm page: algorithm number and the function chosen for each block.
    const algControls = [];
    if (algP) {
      const ctl = fwControl({
        p: algP, name: 'Algorithm', value: alg,
        names: () => null,
        // the new algorithm's blocks get functions it takes (kept where possible), so its pages appear
        onChange: (v) => {
          const patches = [map.write(algP, L, null, v)];
          const changed = blocksForAlgorithm(map, L, v);
          for (const c of changed) patches.push(map.write(c.p, L, c.block, c.value));
          commit(patches, ctl);
          if (changed.length) toast(`Algorithm ${v}: ${changed.map((c) => `F${c.block} set to ${DSP_FUNCTIONS[c.value]?.name || c.value}`).join(', ')}`, 'info', 4000);
          redraw();
        },
      });
      algControls.push(ctl);
    }
    for (const { block, p } of algorithmSelectors(alg)) {
      const v = map.read(p, L, block);
      if (v === null) continue;
      const ctl = fwControl({
        p, name: blockName(block), value: v, names,
        onChange: (nv) => { commit([map.write(p, L, block, nv)], ctl); redraw(); },
      });
      algControls.push(ctl);
    }
    const blocks = map.dspBlocks(L).filter((b) => b.block === b.start).map((b) => ({ block: b.block, name: b.name }));
    cards.push(h('div.card.fw-card.wide',
      h('div.card-head', h('h2', 'Algorithm'), h('span.tag', ALGORITHMS[alg] ? `${alg}: ${ALGORITHMS[alg]}` : `${alg}`)),
      algorithmDiagram(alg, blocks),
      h('p.small.muted', describeAlgorithm(alg, Object.fromEntries(blocks.map((b) => [b.block, b.name])))),
      h('div.params', algControls)));
    // One card per DSP block, with the page the K2000 shows for its function.
    for (const b of map.dspBlocks(L)) {
      if (!b.page) continue;
      const span = b.width > 1 ? ` (block ${b.block - b.start + 1} of ${b.width})` : '';
      cards.push(pageCard(b.page, `${blockName(b.block)} ${b.label}`, { block: b.block, group: b.group, subtitle: `${b.name}${span}` }));
    }
    return cards;
  }

  function blockName(block) { return ['F1', 'F2', 'F3', 'F4 AMP'][block - 1] || `F${block}`; }

  // ------------------------------------------------------------ envelopes
  function envelopeCard(pageId, title, loc) {
    const map = st.map;
    const L = st.layer;
    const entries = pageEntries(pageId);
    const stage = (k) => entries.find((e) => e.p.loc === loc && e.p.off === 3 + 2 * k);   // time
    const level = (k) => entries.find((e) => e.p.loc === loc && e.p.off === 2 + 2 * k);  // level
    if (map.base(loc, L) === null) return null;
    const times = [];
    const levels = [];
    for (let k = 0; k < 7; k++) {
      times.push(stage(k) ? map.read(stage(k).p, L) : 0);
      levels.push(level(k) ? map.read(level(k).p, L) : 0);
    }
    let card = null;
    const graph = envelopeEditor({
      times, levels,
      onChange: (k, { time, level: lvl }) => {
        const tp = stage(k)?.p;
        const lp = level(k)?.p;
        const patches = [];
        if (tp) patches.push(map.write(tp, L, null, snap(tp, time)));
        if (lp) { const { min, max } = paramRange(lp); patches.push(map.write(lp, L, null, Math.max(min, Math.min(max, lvl)))); }
        commit(patches);
        refreshControls();
      },
    });
    const refreshControls = () => {
      const fresh = pageCard(pageId, title, { extra: graph, onChanged: () => updateGraph(), rename: envName });
      if (card && fresh) { card.replaceWith(fresh); card = fresh; }
    };
    const updateGraph = () => {
      graph.update(Array.from({ length: 7 }, (_, k) => (stage(k) ? map.read(stage(k).p, L) : 0)),
        Array.from({ length: 7 }, (_, k) => (level(k) ? map.read(level(k).p, L) : 0)));
    };
    card = pageCard(pageId, title, { extra: graph, onChanged: () => updateGraph(), rename: envName });
    return card;
  }

  function envName(e) {
    if (e.p.off === 1 && e.p.sh === 3) return 'Loop count';
    if (e.p.loc === 0x112 && e.p.off === 2) return 'Mode';
    return null;
  }

  function snap(p, v) {
    const vals = paramValues(p);
    if (!vals) return v;
    let best = vals[0];
    for (const x of vals) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
    return best;
  }

  // ------------------------------------------------------------ raw bytes
  function rawSection(L) {
    const p = st.prog;
    const body = h('div.col');
    const details = h('details.card', h('summary', 'Raw segment bytes (this layer and the program header)'), body);
    details.addEventListener('toggle', () => {
      if (!details.open || body.childElementCount) return;
      for (const seg of [...p.common, ...p.layers[L].segments]) {
        body.append(h('div.row', h('span.tag', `${segmentName(seg.tag)} (tag ${seg.tag.toString(16).padStart(2, '0')}) @${seg.offset}`)),
          hexRow({
            bytes: p.data.slice(seg.offset, seg.offset + seg.length),
            known: new Set(),
            onChange: (idx, v) => { commit([p.writeRaw(seg.offset + 1 + idx, v)]); },
          }));
      }
    });
    return details;
  }

  // ------------------------------------------------------------ structure edits
  async function duplicateLayer() {
    const p = st.prog;
    const layer = p.layers[st.layer];
    if (!(await confirmDialog('Duplicate layer', `Copy layer ${st.layer + 1} and write the whole program to the K2000?`, 'Duplicate'))) return;
    const start = layer.segments[0].offset;
    const endSeg = layer.segments[layer.segments.length - 1];
    const end = endSeg.offset + endSeg.length;
    const copy = p.data.slice(start, end);
    const data = new Uint8Array(p.data.length + copy.length);
    data.set(p.data.subarray(0, end));
    data.set(copy, end);
    data.set(p.data.subarray(end), end + copy.length);
    await rewrite(data, +1);
  }

  async function deleteLayer() {
    const p = st.prog;
    const layer = p.layers[st.layer];
    if (!(await confirmDialog('Delete layer', `Delete layer ${st.layer + 1} and write the program to the K2000?`, 'Delete', true))) return;
    const start = layer.segments[0].offset;
    const endSeg = layer.segments[layer.segments.length - 1];
    const end = endSeg.offset + endSeg.length;
    const data = new Uint8Array(p.data.length - (end - start));
    data.set(p.data.subarray(0, start));
    data.set(p.data.subarray(end), start);
    st.layer = Math.max(0, st.layer - 1);
    await rewrite(data, -1);
  }

  async function rewrite(data, layerDelta) {
    const p = st.prog;
    const pg = p.common.find((s) => s.tag === TAG.PROGRAM);
    if (pg && segmentLength(TAG.PROGRAM)) data[pg.offset + 2] = Math.max(1, data[pg.offset + 2] + layerDelta);
    setProgram(new Program(data, { id: p.id, name: p.name, inRam: p.inRam }));
    st.undo = []; st.redo = [];
    if (p.inRam && app.online) {
      try { await app.client.writeObject(T.PROGRAM, p.id, p.name, data); toast('Program written', 'good', 1500); } catch (err) { app.error(err, 'Write'); st.dirty = true; }
    } else st.dirty = true;
    renderEditor();
  }

  // ------------------------------------------------------------ keys
  const onKey = (e) => {
    if (!st.prog || e.target.closest('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); }
  };
  window.addEventListener('keydown', onKey);

  // ------------------------------------------------------------ start
  const begin = (useStandard) => {
    loadList(useStandard);
    if (lastId) openProgram(lastId);
    else clear(editor).append(h('div.empty', 'Pick a program from the list.'));
  };
  const offs = [];
  if (app.online && app.standard?.programs) begin(true);
  else if (app.online && !app.loadingStandard) begin(false);
  else {
    // Wait for the list read at connect time (or for the connection, or a failed read).
    const done = (useStandard) => { offs.splice(0).forEach((o) => o()); begin(useStandard); };
    offs.push(
      app.on('standard', (what) => { if (what === 'programs' || what === 'failed') done(what === 'programs'); }),
      app.on('online', (ok) => { if (ok && !app.loadingStandard) done(false); }),
    );
  }

  return { destroy() { offs.forEach((o) => o()); window.removeEventListener('keydown', onKey); clearTimeout(redrawTimer); app.keyboard?.highlight(null); } };
}
