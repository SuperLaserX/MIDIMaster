// Pattern editor: lanes of steps shown as a step grid or as a tracker (one row per step, one column
// per lane, values typed by number). Generic: it knows nothing of any device. The caller describes
// the pattern and supplies read/write/format for its step values.
//
//   patternEditor({ model, read(step) -> value, write(step, value), format(step, value) -> text,
//                   header(lane) -> Element | null, view: 'grid' | 'tracker', onView(view) })
//   model: {
//     length,                      steps per lane
//     end,                         steps in use (1-based count); later ones are dimmed
//     stepLabel(i) -> text,        column / row label (default i + 1)
//     lanes: [{
//       label,                     lane name (row in the grid, column in the tracker)
//       kind: 'bar' | 'note',      bar: a value drawn from `zero` up or down; note: a cell that is
//                                  empty (rest), a tie, or on with a level
//       steps: [step],             opaque step handles passed to read/write/format
//       min, max, zero,            value range; zero = the bar's base line (bar lanes)
//       rest, tie, on,             note lanes: the values for rest and tie, and the level a click sets
//       muted,                     the lane is switched off (drawn faint)
//       end,                       steps in use in this lane (else model.end)
//       offset,                    the tracker shows and takes value + offset (e.g. -64: 1-127 as -63..+63)
//       names,                     bar lanes: short text per value (array indexed by value - min, or
//                                  { value: text }), e.g. step kinds Norm/Tie/Rest/Glide: shown in the
//                                  grid cell and the tracker, and typed in the tracker; patterns of
//                                  more than 32 steps show the first letter in the grid
//       shortNames,                bar lanes: the same, for the grid cells only (overrides the cut)
//     }],
//   }
// Grid: click or drag on a bar lane to set values (vertical position); on a note lane a click
// toggles rest/on, Shift+click sets a tie, a vertical drag changes the level, right-click rests.
// Tracker: type a number, or a lane name (bar lanes with names), or "-" / "." for a rest, "=" for a
// tie on note lanes; Enter or the arrow keys move between cells.

import { h, clear } from './dom.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** A bar lane's name for value v (lane.names), or null. */
const nameOf = (lane, v) => {
  if (!lane.names) return null;
  const nm = Array.isArray(lane.names) ? lane.names[v - lane.min] : lane.names[v];
  return nm == null ? null : String(nm);
};
/** [[value, name]] of a bar lane's names. */
const namesOf = (lane) => (Array.isArray(lane.names) ? lane.names.map((x, i) => [i + lane.min, String(x)]) : Object.entries(lane.names || {}).map(([k, x]) => [Number(k), String(x)]));

export function patternEditor(opts) {
  const { model } = opts;
  let view = opts.view || 'grid';
  const el = h('div.pattern-editor');
  const body = h('div.pattern-body');
  const tabs = h('div.row.pattern-tabs',
    ['grid', 'tracker'].map((v) => h('button.btn.small', { 'data-view': v, onclick: () => { view = v; opts.onView?.(v); draw(); } }, v === 'grid' ? 'Step grid' : 'Tracker')),
    h('span.small.muted.grow', view === 'grid'
      ? ''
      : ''));
  el.append(tabs, body);

  const inUse = (i, lane) => i < (lane?.end ?? model.end ?? model.length);
  const stepLabel = (i) => (model.stepLabel ? model.stepLabel(i) : String(i + 1));

  function draw() {
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('primary', b.dataset.view === view);
    const notes = model.lanes.some((l) => l.kind === 'note');
    const bars = model.lanes.some((l) => l.kind === 'bar');
    tabs.lastChild.textContent = view === 'grid'
      ? [bars ? 'Click or drag to draw step values.' : '', notes ? 'Click a step for on/rest, Shift+click for a tie, drag up/down for the level, right-click to rest.' : ''].filter(Boolean).join(' ')
      : `Type a value and press Enter${notes ? '; "-" is a rest and "=" a tie' : ''}. Arrow keys move between cells.`;
    clear(body).append(view === 'grid' ? grid() : tracker());
  }

  // ------------------------------------------------------------------ grid
  function grid() {
    const wrap = h('div.pattern-grid', { style: `--steps: ${model.length}` });
    wrap.append(h('div.pg-head'), h('div.pg-steps.pg-numbers', Array.from({ length: model.length }, (_, i) => h('div.pg-num' + (inUse(i) ? '' : '.off'), stepLabel(i)))));
    // a write to one lane can change another (a step kind that rests also clears the velocity):
    // every lane of the step is repainted
    const painters = [];
    const paintStep = (i) => { for (const p of painters) p(i); };
    for (const lane of model.lanes) {
      const head = h('div.pg-head', h('div.pg-label', lane.label), opts.header?.(lane) || null);
      const cells = lane.steps.map((s, i) => h('div.pg-cell' + (inUse(i, lane) ? '' : '.off'), { title: `${lane.label}, step ${stepLabel(i)}` }));
      const row = h('div.pg-steps.lane-' + lane.kind + (lane.muted ? '.muted' : ''), cells);
      const paint = (i) => { if (i < cells.length) paintCell(lane, i, cells[i]); };
      painters.push(paint);
      lane.steps.forEach((_, i) => paint(i));
      attachPointer(row, lane, cells, paintStep);
      wrap.append(head, row);
    }
    return wrap;
  }

  /** The name a grid cell shows: lane.shortNames, else the name, cut to its first letter when the
   *  cells are narrow (more than 32 steps); the cell's tooltip and the tracker give the full name. */
  function gridName(lane, v) {
    if (lane.shortNames) return nameOf({ ...lane, names: lane.shortNames }, v);
    const nm = nameOf(lane, v);
    return nm != null && model.length > 32 ? nm.slice(0, 1) : nm;
  }

  function paintCell(lane, i, cell) {
    const v = opts.read(lane.steps[i]);
    clear(cell);
    cell.title = `${lane.label}, step ${stepLabel(i)}: ${opts.format(lane.steps[i], v)}`;
    if (lane.kind === 'bar') {
      const span = lane.max - lane.min || 1;
      const z = ((lane.zero ?? lane.min) - lane.min) / span;
      const t = (v - lane.min) / span;
      const lo = Math.min(z, t), hi = Math.max(z, t);
      cell.append(h('div.pg-zero', { style: `bottom: ${(z * 100).toFixed(1)}%` }),
        h('div.pg-bar' + (t < z ? '.neg' : ''), { style: `bottom: ${(lo * 100).toFixed(1)}%; height: ${Math.max(1, (hi - lo) * 100).toFixed(1)}%` }));
      const nm = gridName(lane, v);
      if (nm != null) cell.append(h('span.pg-name', nm));
    } else {
      cell.classList.toggle('on', v !== lane.rest && v !== lane.tie);
      cell.classList.toggle('tie', v === lane.tie);
      if (v === lane.tie) cell.append(h('span', '='));
      else if (v !== lane.rest) {
        const t = (v - lane.min) / ((lane.max - lane.min) || 1);
        cell.style.setProperty('--level', clamp(t, 0, 1).toFixed(2));
        cell.append(h('span', String(v)));
      }
    }
  }

  function attachPointer(row, lane, cells, paint) {
    let drag = null;
    const stepAt = (e) => {
      const r = row.getBoundingClientRect();
      return clamp(Math.floor(((e.clientX - r.left) / r.width) * lane.steps.length), 0, lane.steps.length - 1);
    };
    const valueAt = (e) => {
      const r = row.getBoundingClientRect();
      const t = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
      return Math.round(lane.min + t * (lane.max - lane.min));
    };
    const set = (i, v) => {
      if (opts.read(lane.steps[i]) === v) return;
      opts.write(lane.steps[i], v);
      paint(i);
    };
    row.addEventListener('contextmenu', (e) => {
      if (lane.kind !== 'note') return;
      e.preventDefault();
      set(stepAt(e), lane.rest);
    });
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      row.setPointerCapture(e.pointerId);
      const i = stepAt(e);
      if (lane.kind === 'bar') {
        drag = { last: i };
        set(i, valueAt(e));
      } else {
        const v = opts.read(lane.steps[i]);
        if (e.shiftKey) set(i, v === lane.tie ? lane.rest : lane.tie);
        else drag = { i, y: e.clientY, start: v, moved: false };
      }
    });
    row.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (lane.kind === 'bar') {
        const i = stepAt(e);
        const v = valueAt(e);
        const a = Math.min(i, drag.last), b = Math.max(i, drag.last);
        for (let k = a; k <= b; k++) set(k, v);
        drag.last = i;
      } else if (Math.abs(e.clientY - drag.y) > 3) {
        drag.moved = true;
        const base = drag.start === lane.rest || drag.start === lane.tie ? lane.on : drag.start;
        set(drag.i, clamp(Math.round(base + (drag.y - e.clientY) / 2), lane.min, lane.max));
      }
    });
    const end = () => {
      if (drag && lane.kind === 'note' && !drag.moved) {
        const v = opts.read(lane.steps[drag.i]);
        set(drag.i, v === lane.rest ? lane.on : lane.rest);
      }
      drag = null;
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', () => { drag = null; });
  }

  // ------------------------------------------------------------------ tracker
  function tracker() {
    const inputs = [];
    const parse = (lane, text) => {
      const t = text.trim();
      if (lane.kind === 'note' && (t === '' || t === '-' || t === '.' || /^rest$/i.test(t))) return lane.rest;
      if (lane.kind === 'note' && (t === '=' || /^tie$/i.test(t))) return lane.tie;
      const hit = namesOf(lane).find(([, x]) => x.toLowerCase() === t.toLowerCase());
      if (hit) return hit[0];
      const n = Number(t.replace(/^\+/, ''));
      return Number.isFinite(n) ? clamp(Math.round(n) - (lane.offset || 0), lane.min, lane.max) : null;
    };
    const shown = (lane, s) => {
      const v = opts.read(s);
      if (lane.kind === 'note' && (v === lane.rest || v === lane.tie)) return v === lane.rest ? '-' : '=';
      const nm = nameOf(lane, v);
      if (nm != null) return nm;
      const n = v + (lane.offset || 0);
      return lane.offset < 0 && n > 0 ? `+${n}` : String(n);
    };
    const rows = [];
    const shows = []; // per row: each lane's redraw (a write to one lane can change another)
    for (let i = 0; i < model.length; i++) {
      inputs[i] = [];
      shows[i] = [];
      const tds = model.lanes.map((lane, c) => {
        const s = lane.steps[i];
        const out = h('span.small.muted', '');
        const inp = h('input.tr-cell', { value: shown(lane, s), spellcheck: false, 'data-r': i, 'data-c': c });
        const show = () => {
          inp.value = shown(lane, s);
          const text = opts.format(s, opts.read(s));
          out.textContent = text.replace(/\s+/g, '') === inp.value ? '' : text; // only when it says more
        };
        show();
        shows[i].push(show);
        const commit = () => {
          const v = parse(lane, inp.value);
          if (v === null) { show(); return; }
          if (v !== opts.read(s)) opts.write(s, v);
          for (const f of shows[i]) f();
        };
        inp.addEventListener('change', commit);
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('keydown', (e) => {
          const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [1, 0] }[e.key]
            ?? (e.key === 'ArrowLeft' && inp.selectionStart === 0 ? [0, -1] : e.key === 'ArrowRight' && inp.selectionEnd === inp.value.length ? [0, 1] : null);
          if (!move) return;
          e.preventDefault();
          commit();
          const r = clamp(i + move[0], 0, model.length - 1), cc = clamp(c + move[1], 0, model.lanes.length - 1);
          inputs[r][cc]?.focus();
        });
        inputs[i][c] = inp;
        return h('td', h('div.row.tr-wrap', inp, out));
      });
      rows.push(h('tr' + (inUse(i) ? '' : '.off'), h('td.mono.muted', stepLabel(i)), tds));
    }
    return h('div.table-wrap.tracker-wrap', h('table.list.tracker',
      h('thead', h('tr', h('th', 'Step'), model.lanes.map((l) => h('th' + (l.muted ? '.muted' : ''), l.label)))),
      h('tbody', rows)));
  }

  draw();
  return el;
}
