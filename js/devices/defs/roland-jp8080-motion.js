// JP-8080 / JP-8000 Motion page: the four motions (A[1] A[2] B[1] B[2]) as knob events in time, read from
// and written to the unit by address (09 00 / 09 40 / 0A 00 / 0A 40). See the motion notes in
// roland-jp8080.js and docs/devices/roland-jp8080.md.

import { h, svg, clear, toast, confirmDialog, downloadBlob, pickFiles, splitSysex, concatBytes } from '../../core/ui/dom.js';
import { sendOut } from '../generic/objects.js';
import { parseDt1, addrToInt } from '../../core/midi/roland.js';
import { sysexMessages } from '../../core/midi/smf.js';
import { MODEL, A, MOTION_TICKS, motionTimeline, buildMotion, pack7, readMotion, motionMessages, motionAddr } from './roland-jp.js';

const NAMES = ['A[1]', 'A[2]', 'B[1]', 'B[2]'];
const state = {
  m: 0, motions: [null, null, null, null], slot: null, // motions[m] = {total, points, dirty}
  draw: { slot: 16, tool: 'free', step: 48, shape: 'sine', cycles: 4, lo: 0, hi: 127, from: 0, to: 100 },
};
let MOTION_SLOTS = [];
const slotName = (s) => MOTION_SLOTS[s]?.[1] ?? `Slot ${s}`;
const pct = (t, total) => `${((100 * t) / total).toFixed(1)}%`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Drawing: a stroke becomes events every `step` ticks between its ends, dropping repeats.
const STEPS = [[12, '12 ticks (fine)'], [24, '24 ticks'], [48, '48 ticks'], [96, '96 ticks'], [192, '192 ticks (coarse)']];
const SHAPES = [['up', 'Ramp up'], ['down', 'Ramp down'], ['tri', 'Triangle'], ['sine', 'Sine'], ['square', 'Square'], ['random', 'Random steps']];

/** Events for one knob from a value function v(tick), every `step` ticks in [t0, t1]; consecutive repeats dropped. */
export function sampleCurve(slot, t0, t1, step, v) {
  const out = [];
  let last = -1;
  for (let t = t0; t <= t1; t += step) {
    const value = clamp(Math.round(v(t)), 0, 127);
    if (value !== last) out.push({ tick: t, slot, value });
    last = value;
  }
  if (out.length && out[out.length - 1].tick !== t1) {
    const value = clamp(Math.round(v(t1)), 0, 127);
    if (value !== last) out.push({ tick: t1, slot, value });
  }
  return out;
}
/** Replace one knob's events in [t0, t1] (inclusive) with `events`; other knobs are untouched. */
export function replaceRange(points, slot, t0, t1, events) {
  const kept = points.filter((p) => p.slot !== slot || p.tick < t0 || p.tick > t1);
  return [...kept, ...events].sort((a, b) => a.tick - b.tick || a.slot - b.slot);
}
/** Piecewise-linear function through stroke samples [{tick, value}] (the latest sample wins at a tick). */
export function strokeFunction(samples) {
  const byTick = new Map();
  for (const s of samples) byTick.set(s.tick, s.value);
  const pts = [...byTick].sort((a, b) => a[0] - b[0]);
  return (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const [t0, v0] = pts[i - 1]; const [t1, v1] = pts[i];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return pts[pts.length - 1][1];
  };
}
/** A shape as v(tick) over [t0, t1] between lo and hi. */
export function shapeFunction(shape, t0, t1, cycles, lo, hi, seed = 1) {
  const len = Math.max(1, t1 - t0);
  const phase = (t) => (((t - t0) / len) * cycles) % 1;
  let r = seed;
  const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const steps = new Map();
  switch (shape) {
    case 'up': return (t) => lo + ((hi - lo) * (t - t0)) / len;
    case 'down': return (t) => hi - ((hi - lo) * (t - t0)) / len;
    case 'tri': return (t) => { const p = phase(t); return lo + (hi - lo) * (p < 0.5 ? p * 2 : 2 - p * 2); };
    case 'sine': return (t) => lo + ((hi - lo) * (1 - Math.cos(2 * Math.PI * phase(t)))) / 2;
    case 'square': return (t) => (phase(t) < 0.5 ? hi : lo);
    case 'random': return (t) => {
      const k = Math.floor(((t - t0) / len) * cycles * 4);
      if (!steps.has(k)) steps.set(k, lo + (hi - lo) * rnd());
      return steps.get(k);
    };
    default: return () => lo;
  }
}

export function motionView(root, g) {
  MOTION_SLOTS = g.def.motionSlots;
  const cur = () => state.motions[state.m];

  async function read(m = state.m) {
    g.setBusy?.(1, `Reading motion ${NAMES[m]}`);
    try {
      const raw = await readMotion(g.client, g.deviceId, m);
      const t = raw.length ? motionTimeline(raw) : { total: MOTION_TICKS, points: [] };
      state.motions[m] = { total: t.total || MOTION_TICKS, points: t.points, dirty: false };
      toast(raw.length ? `Motion ${NAMES[m]}: ${t.points.length} knob events` : `Motion ${NAMES[m]} is empty`, 'good', 2500);
    } catch (err) { g.error(err, `Motion ${NAMES[m]}`); } finally { g.setBusy?.(0); }
    render();
  }

  async function send(m = state.m) {
    const mo = state.motions[m];
    if (!mo) return;
    if (!(await confirmDialog('Send motion', `Write motion ${NAMES[m]} (${mo.points.length} knob events) to the ${g.entry.model}? It replaces the motion stored there.`, 'Send', true))) return;
    sendOut(g, motionMessages(g.deviceId, m, pack7(buildMotion(mo.points, mo.total))));
    mo.dirty = false;
    toast(`Motion ${NAMES[m]} sent`, 'good', 2000);
    render();
  }

  function save() {
    const msgs = [];
    state.motions.forEach((mo, m) => { if (mo) msgs.push(...motionMessages(g.deviceId, m, pack7(buildMotion(mo.points, mo.total)))); });
    if (!msgs.length) { toast('Read a motion first.', 'warn'); return; }
    downloadBlob(concatBytes(msgs.map((x) => Uint8Array.from(x))), `${g.entry.model} motions.syx`);
  }

  async function load() {
    const [file] = await pickFiles('.syx,.mid', false);
    if (!file) return;
    const msgs = sysexMessages(new Uint8Array(await file.arrayBuffer())); // .syx or a MIDI file
    const raws = [[], [], [], []];
    for (const raw of msgs) {
      const p = parseDt1(raw, MODEL);
      if (!p?.ok) continue;
      const a = addrToInt(p.addr);
      const m = [0, 1, 2, 3].find((k) => a >= motionAddr(k) && a < motionAddr(k) + A('00 40 00 00'));
      if (m !== undefined) raws[m].push([a - motionAddr(m), p.data]);
    }
    let n = 0;
    raws.forEach((parts, m) => {
      if (!parts.length) return;
      const bytes = [];
      for (const [, d] of parts.sort((x, y) => x[0] - y[0])) bytes.push(...d);
      const t = motionTimeline(Uint8Array.from(bytes));
      state.motions[m] = { total: t.total || MOTION_TICKS, points: t.points, dirty: true };
      n++;
    });
    toast(n ? `Loaded ${n} motion${n > 1 ? 's' : ''} from ${file.name}; send to put them on the unit.` : 'No motion data in that file.', n ? 'good' : 'warn', 4000);
    render();
  }

  function change(fn) { const mo = cur(); if (!mo) return; fn(mo); mo.dirty = true; render(); }

  function curve(mo, slot) {
    const W = 600; const H = 60;
    const pts = mo.points.filter((p) => p.slot === slot);
    if (!pts.length) return null;
    const xy = pts.map((p) => `${((p.tick / mo.total) * W).toFixed(1)},${(H - (p.value / 127) * H).toFixed(1)}`);
    return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'motion-curve', preserveAspectRatio: 'none', style: 'width:100%;height:60px' },
      svg('polyline', { points: xy.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }));
  }

  function knobTable(mo) {
    const used = [...new Set(mo.points.map((p) => p.slot))].sort((a, b) => a - b);
    if (!used.length) return h('p.small.muted', 'No knob events. Draw them above or add them below.');
    return h('table.list', h('thead', h('tr', h('th', 'Knob'), h('th', 'Events'), h('th', 'Curve (whole motion)'), h('th', ''))),
      h('tbody', used.map((s) => h('tr', { class: state.slot === s ? 'sel' : '' },
        h('td', h('a', { href: '#', title: 'Show its events and draw it', onclick: (e) => { e.preventDefault(); state.slot = s; state.draw.slot = s; render(); } }, slotName(s))),
        h('td.mono', String(mo.points.filter((p) => p.slot === s).length)),
        h('td', { style: 'width:60%' }, curve(mo, s)),
        h('td', h('button.btn.small', { title: 'Remove every event of this knob (Motion Erase)', onclick: () => change((x) => { x.points = x.points.filter((p) => p.slot !== s); }) }, 'Erase'))))));
  }

  function eventTable(mo) {
    const rows = mo.points.map((p, i) => [p, i]).filter(([p]) => state.slot === null || p.slot === state.slot);
    const slotSel = (p) => h('select', { onchange: (e) => change(() => { p.slot = Number(e.target.value); }) },
      MOTION_SLOTS.map(([v, l]) => h('option', { value: v, selected: v === p.slot }, l)));
    const num = (p, key, max) => h('input', { type: 'number', min: 0, max, value: p[key], style: 'width:6em',
      onchange: (e) => change(() => { p[key] = Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))); }) });
    return h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Tick'), h('th', 'Position'), h('th', 'Knob'), h('th', 'Value'), h('th', ''))),
      h('tbody', rows.slice(0, 2000).map(([p, i]) => h('tr',
        h('td', num(p, 'tick', mo.total - 1)), h('td.small.muted', pct(p.tick, mo.total)), h('td', slotSel(p)), h('td', num(p, 'value', 127)),
        h('td', h('button.btn.small', { onclick: () => change((x) => { x.points.splice(i, 1); }) }, 'Delete')))))));
  }

  // ---------------------------------------------------------------- drawing
  function drawCard(mo) {
    const D = state.draw;
    const W = 960; const H = 256;
    const X = (t) => (t / mo.total) * W;
    const Y = (v) => H - (v / 127) * H;
    const polyFor = (slot) => mo.points.filter((p) => p.slot === slot).map((p) => `${X(p.tick).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
    const grid = [];
    for (let i = 1; i < 16; i++) grid.push(svg('line', { x1: (i * W) / 16, x2: (i * W) / 16, y1: 0, y2: H, class: i % 4 ? 'grid-minor' : 'grid-major' }));
    for (const v of [32, 64, 96]) grid.push(svg('line', { x1: 0, x2: W, y1: Y(v), y2: Y(v), class: v === 64 ? 'grid-major' : 'grid-minor' }));
    const others = [...new Set(mo.points.map((p) => p.slot))].filter((s) => s !== D.slot)
      .map((s) => svg('polyline', { points: polyFor(s), class: 'curve-other' }));
    const mine = svg('polyline', { points: polyFor(D.slot), class: 'curve-mine' });
    const dots = mo.points.filter((p) => p.slot === D.slot).length <= 400
      ? mo.points.filter((p) => p.slot === D.slot).map((p) => svg('circle', { cx: X(p.tick), cy: Y(p.value), r: 2.5, class: 'curve-dot' })) : [];
    const live = svg('polyline', { points: '', class: 'curve-live' });
    const band = svg('rect', { x: 0, y: 0, width: 0, height: H, class: 'curve-band' });
    const readout = h('span.small.mono.muted', 'Drag on the canvas to draw.');
    const canvas = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'motion-draw' }, ...grid, ...others, band, mine, ...dots, live);

    // Pointer position -> {tick, value}
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        tick: clamp(Math.round(((e.clientX - r.left) / r.width) * mo.total), 0, mo.total - 1),
        value: clamp(Math.round((1 - (e.clientY - r.top) / r.height) * 127), 0, 127),
      };
    };
    let stroke = null;
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      stroke = [at(e)];
      move(e);
    });
    const move = (e) => {
      const p = at(e);
      readout.textContent = `tick ${p.tick} (${pct(p.tick, mo.total)}), value ${p.value}`;
      if (!stroke) return;
      if (D.tool === 'line') stroke = [stroke[0], p]; else stroke.push(p);
      if (D.tool === 'erase') {
        const a = Math.min(...stroke.map((s) => s.tick)); const b = Math.max(...stroke.map((s) => s.tick));
        band.setAttribute('x', X(a)); band.setAttribute('width', Math.max(1, X(b) - X(a)));
      } else {
        const pts = D.tool === 'line' ? stroke : stroke.slice().sort((x, y) => x.tick - y.tick);
        live.setAttribute('points', pts.map((s) => `${X(s.tick).toFixed(1)},${Y(s.value).toFixed(1)}`).join(' '));
      }
    };
    canvas.addEventListener('pointermove', move);
    const finish = () => {
      if (!stroke) return;
      const s = stroke; stroke = null;
      const t0 = Math.min(...s.map((p) => p.tick)); const t1 = Math.max(...s.map((p) => p.tick));
      if (D.tool === 'erase') { change((x) => { x.points = replaceRange(x.points, D.slot, t0, t1, []); }); return; }
      if (t1 === t0) { change((x) => { x.points = replaceRange(x.points, D.slot, t0, t0, [{ tick: t0, slot: D.slot, value: s[s.length - 1].value }]); }); return; }
      const f = D.tool === 'line'
        ? (t) => s[0].value + ((s[1].value - s[0].value) * (t - s[0].tick)) / (s[1].tick - s[0].tick)
        : strokeFunction(s);
      change((x) => { x.points = replaceRange(x.points, D.slot, t0, t1, sampleCurve(D.slot, t0, t1, D.step, f)); });
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { stroke = null; live.setAttribute('points', ''); });

    const sel = (key, options, onchange) => h('select', { onchange: (e) => { D[key] = isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value); onchange?.(); } },
      options.map(([v, l]) => h('option', { value: v, selected: v === D[key] }, l)));
    const num = (key, min, max, w = '5em') => h('input', { type: 'number', min, max, value: D[key], style: `width:${w}`, onchange: (e) => { D[key] = clamp(Number(e.target.value) || 0, min, max); } });
    const tools = [['free', 'Freehand'], ['line', 'Line'], ['erase', 'Erase']].map(([v, l]) => h('button.btn.small' + (D.tool === v ? '.primary' : ''), { onclick: () => { D.tool = v; render(); } }, l));
    const fill = () => {
      const t0 = Math.round((D.from / 100) * (mo.total - 1)); const t1 = Math.round((D.to / 100) * (mo.total - 1));
      if (t1 <= t0) { toast('The end must be after the start.', 'warn'); return; }
      const f = shapeFunction(D.shape, t0, t1, Math.max(1, D.cycles), Math.min(D.lo, D.hi), Math.max(D.lo, D.hi), Date.now() % 100000);
      change((x) => { x.points = replaceRange(x.points, D.slot, t0, t1, sampleCurve(D.slot, t0, t1, D.step, f)); });
    };
    const count = mo.points.filter((p) => p.slot === D.slot).length;
    return h('div.card',
      h('div.card-head', h('h2', 'Draw'),
        h('span.small.muted', `${slotName(D.slot)}: ${count} event${count === 1 ? '' : 's'}`)),
      h('div.row', 'Knob ', sel('slot', MOTION_SLOTS, render), ...tools, ' Resolution ', sel('step', STEPS), readout),
      canvas,
      h('p.small.muted', 'Freehand draws what you drag; Line draws a straight ramp from where you press to where you release; Erase removes this knob\'s events across the range you drag. Each stroke replaces only this knob\'s events inside the range it covers, as one event every "Resolution" ticks (repeated values are left out). Vertical lines divide the motion into 16ths; horizontal lines mark values 32, 64 and 96. The other knobs are shown faintly.'),
      h('div.row', 'Fill with ', sel('shape', SHAPES), ' cycles ', num('cycles', 1, 64), ' from value ', num('lo', 0, 127), ' to ', num('hi', 0, 127),
        ' over ', num('from', 0, 99), '% to ', num('to', 1, 100), '% of the motion ',
        h('button.btn', { onclick: fill, title: 'Replace this knob\'s events in that range with the shape' }, 'Fill')));
  }

  function addRow(mo) {
    const f = { tick: 0, slot: state.slot ?? 16, value: 64 };
    const tick = h('input', { type: 'number', min: 0, max: mo.total - 1, value: 0, style: 'width:7em', onchange: (e) => { f.tick = Number(e.target.value); } });
    const slot = h('select', { onchange: (e) => { f.slot = Number(e.target.value); } }, MOTION_SLOTS.map(([v, l]) => h('option', { value: v, selected: v === f.slot }, l)));
    const val = h('input', { type: 'number', min: 0, max: 127, value: 64, style: 'width:6em', onchange: (e) => { f.value = Number(e.target.value); } });
    return h('div.row', 'Add at tick ', tick, slot, ' value ', val,
      h('button.btn', { onclick: () => change((x) => { x.points.push({ tick: Math.max(0, Math.min(x.total - 1, Math.round(f.tick))), slot: f.slot, value: Math.max(0, Math.min(127, Math.round(f.value))) }); x.points.sort((a, b) => a.tick - b.tick); }) }, 'Add event'));
  }

  function render() {
    clear(root);
    const mo = cur();
    root.append(
      h('div.row.obj-head',
        h('h1.grow', 'Motion control', h('span.muted', `  Motion ${NAMES[state.m]}${mo?.dirty ? ' (edited, not sent)' : ''}`)),
        h('select', { onchange: (e) => { state.m = Number(e.target.value); state.slot = null; render(); } }, NAMES.map((n, i) => h('option', { value: i, selected: i === state.m }, `Motion ${n}`))),
        h('button.btn.primary', { onclick: () => read() }, 'Get from device'),
        mo ? h('button.btn', { onclick: () => send() }, `Send to ${g.entry.model}`) : null,
        h('button.btn', { onclick: save }, 'Save .syx'),
        h('button.btn', { onclick: load }, 'Load .syx'),
        mo ? h('button.btn', { onclick: () => change((x) => { x.points = []; }) }, 'Clear') : null),
      h('p.small.muted', 'A motion records knob moves against time: each event sets one knob (one of the 40 Tx/Rx knob slots) to a value at a tick. The length is fixed by the recording (10368 ticks for a 4-measure loop on the unit this was built with). Motion Set and the loop length of each motion are on the System page. RPS patterns cannot be transferred by MIDI: the unit keeps them on its own memory card only.'));
    if (!mo) {
      root.append(h('div.row', h('p.grow', 'Read the motion from the unit, load a .syx, or start an empty motion and draw it.'),
        h('button.btn', { onclick: () => { state.motions[state.m] = { total: MOTION_TICKS, points: [], dirty: true }; render(); } }, 'New empty motion')));
      return;
    }
    root.append(
      drawCard(mo),
      h('div.card', h('div.card-head', h('h2', `Knobs (${mo.points.length} events, ${mo.total} ticks)`)), knobTable(mo)),
      h('div.card', h('div.card-head', h('h2', state.slot === null ? 'All events' : `${slotName(state.slot)} events`),
        state.slot !== null ? h('button.btn.small', { onclick: () => { state.slot = null; render(); } }, 'Show all') : null),
      addRow(mo), eventTable(mo)));
  }

  render();
  return { destroy() {} };
}
