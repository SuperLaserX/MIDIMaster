// Graphical 7-stage envelope editor (Att1-3, Dec1, sustain, Rel1-3).
// Drag a point horizontally to change the stage time, vertically for its level.

import { svg, h } from '../../core/ui/dom.js';
import { envTimeMs, fmt } from './model/tables.js';

const W = 420;
const H = 110;
const PAD = 10;
const SUSTAIN_W = 34;

/** Map ms to a display width with compression so short and long stages both fit. */
function timeWidth(ms) { return Math.log1p(ms / 25) * 14; }

/**
 * opts: {times:[7 raw bytes], levels:[7 signed], onChange(stage, {time, level}), readOnly}
 */
export function envelopeEditor(opts) {
  const times = opts.times.slice();
  const levels = opts.levels.slice();
  const root = svg('svg', { class: 'env-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  const readout = h('div.small.muted.mono', ' ');
  const el = h('div', root, readout);

  const yOf = (lvl) => PAD + (1 - (lvl + 100) / 200) * (H - 2 * PAD);
  const lvlOf = (y) => Math.round(100 - ((y - PAD) / (H - 2 * PAD)) * 200);

  let scale = 1;
  function layout() {
    const widths = times.map((t) => timeWidth(envTimeMs[t]));
    const total = widths.reduce((a, b) => a + b, 0) + SUSTAIN_W;
    scale = Math.min(3, (W - 2 * PAD) / Math.max(total, 1));
    const pts = [];
    let x = PAD;
    let prev = 0;
    for (let i = 0; i < 7; i++) {
      if (i === 4) x += SUSTAIN_W * scale; // sustain plateau after Dec1
      x += widths[i] * scale;
      // A stage with zero time and zero level is unused and holds the previous level.
      const used = !(times[i] <= 3 && levels[i] === 0);
      const lvl = used ? levels[i] : prev;
      pts.push({ x, y: yOf(lvl), stage: i, used });
      prev = lvl;
    }
    return pts;
  }

  function draw() {
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(svg('line', { class: 'env-axis', x1: PAD, x2: W - PAD, y1: yOf(0), y2: yOf(0) }));
    const pts = layout();
    let d = `M${PAD} ${yOf(0)}`;
    pts.forEach((p, i) => {
      if (i === 4) d += ` H${(p.x - timeWidth(envTimeMs[times[4]]) * scale).toFixed(1)}`;
      d += ` L${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    });
    root.appendChild(svg('path', { class: 'env-line', d: d + ` L${pts[6].x.toFixed(1)} ${yOf(0)} Z` }));
    const names = ['A1', 'A2', 'A3', 'D1', 'R1', 'R2', 'R3'];
    pts.forEach((p) => {
      const c = svg('circle', { class: 'env-pt', cx: p.x, cy: p.y, r: 5, opacity: p.used ? 1 : 0.4 });
      c.appendChild(svg('title', {}, document.createTextNode(names[p.stage])));
      root.appendChild(c);
      root.appendChild(svg('text', { x: p.x - 5, y: H - 2 }, document.createTextNode(names[p.stage])));
      attachDrag(c, p.stage);
    });
  }

  function show(i) {
    readout.textContent = `${['Att1', 'Att2', 'Att3', 'Dec1', 'Rel1', 'Rel2', 'Rel3'][i]}: ${fmt.envTime(times[i])} → ${levels[i]}%`;
  }

  function attachDrag(c, i) {
    c.addEventListener('pointerenter', () => show(i));
    if (opts.readOnly) return;
    let start = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const r = root.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, t: times[i], l: levels[i], sx: W / r.width, sy: H / r.height };
    });
    c.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = (e.clientX - start.x) * start.sx;
      const dy = (e.clientY - start.y) * start.sy;
      const t = Math.max(0, Math.min(255, Math.round(start.t + dx / (1.6 * scale))));
      const l = Math.max(-100, Math.min(100, lvlOf(yOf(start.l) + dy)));
      if (t !== times[i] || l !== levels[i]) {
        times[i] = t; levels[i] = l;
        draw(); show(i);
        opts.onChange?.(i, { time: t, level: l });
      }
    });
    c.addEventListener('pointerup', () => { start = null; });
  }

  draw();
  el.update = (t, l) => { t.forEach((v, i) => { times[i] = v; }); l.forEach((v, i) => { levels[i] = v; }); draw(); };
  return el;
}
