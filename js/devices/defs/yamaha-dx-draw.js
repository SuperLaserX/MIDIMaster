// Yamaha DX graphics for the voice editor's cards (groupInfo.draw): the algorithm as an operator
// diagram (carriers on the output bus, modulators above, the feedback loop), the 32 (or 8)
// algorithms to pick from, operator and pitch EGs (drag the points), and keyboard level scaling.
// Layout and shape functions are pure (tested); the SVG builders need a DOM.

import { svg, h } from '../../core/ui/dom.js';
import { egSeconds } from './yamaha-dx-voice.js';

// ------------------------------------------------------------------ algorithm layout
/**
 * Positions of an algorithm's operators: carriers on row 0 (left to right by number), each
 * modulator one row above the highest operator it modulates, over the middle of its targets; a
 * modulator feeding one operator takes its own column(s), one feeding several sits between them.
 * Returns {nodes: Map(op -> {x, y, carrier}), width, height}.
 */
export function algorithmLayout(alg) {
  const targets = (op) => alg.mods.filter(([f]) => f === op).map(([, t]) => t);
  const mods = (op) => alg.mods.filter(([, t]) => t === op).map(([f]) => f).sort((a, b) => a - b);
  const depthMemo = new Map();
  const depth = (op) => {
    if (depthMemo.has(op)) return depthMemo.get(op);
    const t = targets(op);
    const d = t.length ? Math.max(...t.map(depth)) + 1 : 0;
    depthMemo.set(op, d);
    return d;
  };
  const own = (op) => mods(op).filter((m) => targets(m).length === 1);
  const widthMemo = new Map();
  const width = (op) => {
    if (!widthMemo.has(op)) widthMemo.set(op, Math.max(1, own(op).reduce((a, m) => a + width(m), 0)));
    return widthMemo.get(op);
  };
  const nodes = new Map();
  const place = (op, left) => {
    const w = width(op);
    nodes.set(op, { x: left + w / 2 - 0.5, y: depth(op), carrier: alg.carriers.includes(op) });
    let l = left + (w - own(op).reduce((a, m) => a + width(m), 0)) / 2;
    for (const m of own(op)) { place(m, l); l += width(m); }
  };
  let left = 0;
  for (const c of [...alg.carriers].sort((a, b) => a - b)) { place(c, left); left += width(c); }
  // modulators shared by several operators: over the middle of their targets, then their own modulators
  const ops = Array.from({ length: alg.ops }, (_, i) => i + 1);
  for (let guard = 0; guard < 8 && nodes.size < ops.length; guard++) {
    for (const op of ops) {
      if (nodes.has(op)) continue;
      const t = targets(op);
      if (!t.length || !t.every((x) => nodes.has(x))) continue;
      const x = t.reduce((a, x2) => a + nodes.get(x2).x, 0) / t.length;
      const w = width(op);
      place(op, x + 0.5 - w / 2);
    }
  }
  const xs = [...nodes.values()].map((n) => n.x);
  const minX = Math.min(...xs);
  for (const n of nodes.values()) n.x -= minX;
  return { nodes, width: Math.max(...xs) - minX + 1, height: Math.max(...[...nodes.values()].map((n) => n.y)) + 1 };
}

const ACCENT = 'var(--accent)';
const MUTED = 'var(--muted)';
const LINE = 'var(--line)';
const TEXT = 'var(--text)';

/**
 * SVG of an algorithm. opts: {number (1-based, shown), on(op) -> bool, level(op) -> 0..1, small,
 * selected, onClick}.
 */
export function algorithmSvg(alg, opts = {}) {
  const { nodes, width, height } = algorithmLayout(alg);
  const box = opts.small ? 13 : 26;
  const gapX = opts.small ? 17 : 40;
  const gapY = opts.small ? 20 : 44;
  const pad = opts.small ? 6 : 14;
  const W = pad * 2 + (width - 1) * gapX + box + (opts.small ? 6 : 14);
  const H = pad * 2 + (height - 1) * gapY + box + (opts.small ? 8 : 18) + (opts.small ? 0 : 10);
  const cx = (n) => pad + n.x * gapX + box / 2;
  const cy = (n) => pad + (opts.small ? 0 : 10) + (height - 1 - n.y) * gapY + box / 2;
  const kids = [];
  if (!opts.small && opts.number) kids.push(svg('text', { x: 2, y: 11, style: `fill:${MUTED};font-size:10px` }, document.createTextNode(`ALGORITHM ${opts.number}`)));
  const stroke = opts.small ? 1 : 1.5;
  for (const [f, t] of alg.mods) {
    const a = nodes.get(f);
    const b = nodes.get(t);
    kids.push(svg('line', { x1: cx(a), y1: cy(a) + box / 2, x2: cx(b), y2: cy(b) - box / 2, style: `stroke:${MUTED};stroke-width:${stroke}` }));
  }
  // feedback: from the output of fb[0] round to the input of fb[1]
  if (alg.fb) {
    const a = nodes.get(alg.fb[0]);
    const b = nodes.get(alg.fb[1]);
    const off = opts.small ? 4 : 8;
    const xr = Math.max(cx(a), cx(b)) + box / 2 + off;
    const yb = cy(a) + box / 2 + off / 2;
    const yt = cy(b) - box / 2 - off;
    kids.push(svg('path', { d: `M${cx(a)} ${cy(a) + box / 2} V${yb} H${xr} V${yt} H${cx(b)} V${cy(b) - box / 2}`, style: `fill:none;stroke:${ACCENT};stroke-width:${stroke}` }));
  }
  // output bus
  const carriers = [...nodes.entries()].filter(([, n]) => n.carrier).map(([, n]) => n);
  const busY = cy(carriers[0]) + box / 2 + (opts.small ? 5 : 10);
  kids.push(svg('line', { x1: Math.min(...carriers.map(cx)), y1: busY, x2: Math.max(...carriers.map(cx)), y2: busY, style: `stroke:${TEXT};stroke-width:${stroke}` }));
  for (const n of carriers) kids.push(svg('line', { x1: cx(n), y1: cy(n) + box / 2, x2: cx(n), y2: busY, style: `stroke:${TEXT};stroke-width:${stroke}` }));
  for (const [op, n] of nodes) {
    const on = opts.on ? opts.on(op) : true;
    const lvl = opts.level ? Math.max(0, Math.min(1, opts.level(op))) : 0;
    const x = cx(n) - box / 2;
    const y = cy(n) - box / 2;
    kids.push(svg('rect', { x, y, width: box, height: box, rx: 2, style: `fill:var(--panel);stroke:${n.carrier ? ACCENT : TEXT};stroke-width:${stroke};${on ? '' : 'stroke-dasharray:3 2;opacity:.45'}` }));
    if (lvl > 0 && !opts.small) kids.push(svg('rect', { x: x + 1, y: y + box - 1 - (box - 2) * lvl, width: box - 2, height: (box - 2) * lvl, style: `fill:${n.carrier ? ACCENT : MUTED};opacity:.28` }));
    kids.push(svg('text', { x: cx(n), y: cy(n) + (opts.small ? 3.5 : 4.5), 'text-anchor': 'middle', style: `fill:${TEXT};font-size:${opts.small ? 8.5 : 13}px;font-family:var(--mono)` }, document.createTextNode(String(op))));
  }
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W * (opts.scale || 1), height: H * (opts.scale || 1), style: opts.selected ? `outline:2px solid ${ACCENT};border-radius:4px` : '' }, ...kids);
  if (opts.title) el.appendChild(svg('title', {}, document.createTextNode(opts.title)));
  return el;
}

const ALG_TITLE = 'Boxes: operators (outlined in the accent colour: carriers, on the output line); lines: modulation; the accent loop: feedback. Shading: output level; dashed: operator off.';

/** The algorithm card's graphic: the current algorithm (all of them are on the Algorithm tab). */
export function algorithmCard({ algorithms, current, on, level }) {
  return h('div',
    h('div.dx-alg', algorithmSvg(algorithms[current], { number: current + 1, on, level, title: ALG_TITLE })),
    h('div.small.muted', 'Choose another on the Algorithm tab (after Voice), which shows every algorithm\'s diagram.'));
}

/** One algorithm for the Algorithm tab (a gallery button; views/gallery.js), with the voice's levels. */
export const algorithmTile = (alg, { on, level } = {}) => algorithmSvg(alg, { on, level, scale: 0.85, title: ALG_TITLE });

/** The Algorithm gallery of a voice object: every algorithm as "Algorithm n" and its diagram, as a tab of
 *  the voice page after its Voice section (views/gallery.js). */
export function algorithmGallery({ algorithms, param, on, level, note, after = 'voice' }) {
  return {
    key: 'algorithm', page: 'Algorithm', icon: '⋔', param, note, after,
    label: (v) => `Algorithm ${v + 1}`,
    draw: ({ value, data }) => algorithmTile(algorithms[value], { on: on?.(data), level: level ? (op) => level(data, op) : undefined }),
  };
}

// ------------------------------------------------------------------ envelopes
/**
 * Points of a DX EG (4 rates, 4 levels 0-99): from L4 to L1 (R1), L2 (R2), L3 (R3), held while the
 * key is down, then to L4 (R4). Times in seconds (approximate; egSeconds) with the hold as `hold`.
 */
export function egShape(rates, levels, hold = 0.5) {
  const pts = [{ t: 0, l: levels[3] }];
  let t = 0;
  let from = levels[3];
  for (let i = 0; i < 3; i++) {
    t += egSeconds(rates[i], from, levels[i]);
    pts.push({ t, l: levels[i], stage: i });
    from = levels[i];
  }
  t += hold;
  pts.push({ t, l: levels[2], hold: true });
  t += egSeconds(rates[3], levels[2], levels[3]);
  pts.push({ t, l: levels[3], stage: 3 });
  return pts;
}

const W = 300;
const HH = 96;
const PAD = 9;
/** Display width of a time: compressed so short and long segments both show. */
const tw = (s) => Math.log1p(s / 0.02) * 12;

/**
 * An EG graph you can drag: vertical moves a stage's level, horizontal its rate (longer = slower).
 * opts: {rates, levels, keys: {r: [4 param keys], l: [4 keys]}, set(key, v), center (pitch EG: 50 = no
 * change), prev, label}.
 */
export function egGraph(opts) {
  const { rates, levels } = opts;
  const shape = egShape(rates, levels);
  const xs = [];
  let x = PAD;
  shape.forEach((p, i) => { if (i) x += tw(p.t - shape[i - 1].t) + (p.hold ? 0 : 0); xs.push(x); });
  const scale = Math.min(1, (W - 2 * PAD) / Math.max(1, xs[xs.length - 1] - PAD));
  const X = (i) => PAD + (xs[i] - PAD) * scale;
  const Y = (l) => PAD + (1 - l / 99) * (HH - 2 * PAD);
  let el = opts.prev?.dxEg ? opts.prev : null;
  if (!el) {
    const root = svg('svg', { class: 'env-svg', viewBox: `0 0 ${W} ${HH}`, preserveAspectRatio: 'none', style: 'height:96px' });
    const readout = h('div.small.muted.mono', ' ');
    el = h('div', root, readout);
    const st = { root, readout, drag: null, opts: null };
    el.dxEg = st;
    // Dragging is handled on the graph itself, so it survives the redraw after each change.
    root.addEventListener('pointerdown', (ev) => {
      const s = Number(ev.target?.getAttribute?.('data-stage'));
      if (!Number.isInteger(s) || !st.opts.set || !st.opts.keys) return;
      ev.preventDefault();
      root.setPointerCapture?.(ev.pointerId);
      st.drag = { s, x: ev.clientX, y: ev.clientY, rate: st.opts.rates[s], level: st.opts.levels[s], rect: root.getBoundingClientRect() };
    });
    root.addEventListener('pointermove', (e) => {
      const g = st.drag;
      if (!g) return;
      const o = st.opts;
      const dy = ((e.clientY - g.y) / (g.rect.height || HH)) * HH;
      const dx = ((e.clientX - g.x) / (g.rect.width || W)) * W;
      const level = Math.max(0, Math.min(99, Math.round(g.level - (dy / (HH - 2 * PAD)) * 99)));
      const rate = Math.max(0, Math.min(99, Math.round(g.rate - dx / 3)));
      if (level !== o.levels[g.s]) o.set(o.keys.l[g.s], level);
      if (rate !== st.opts.rates[g.s]) st.opts.set(st.opts.keys.r[g.s], rate);
      st.readout.textContent = `stage ${g.s + 1}: rate ${rate}, level ${level}`;
    });
    const end = () => { st.drag = null; };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  }
  el.dxEg.opts = opts;
  const { root, readout } = el.dxEg;
  while (root.firstChild) root.removeChild(root.firstChild);
  if (opts.center) root.appendChild(svg('line', { class: 'env-axis', x1: 0, x2: W, y1: Y(50), y2: Y(50) }));
  const hi = shape.findIndex((p) => p.hold);
  root.appendChild(svg('line', { class: 'env-axis', x1: X(hi - 1), x2: X(hi - 1), y1: 0, y2: HH, 'stroke-dasharray': '2 3' }));
  root.appendChild(svg('line', { class: 'env-axis', x1: X(hi), x2: X(hi), y1: 0, y2: HH, 'stroke-dasharray': '2 3' }));
  const d = shape.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.l).toFixed(1)}`).join(' ');
  root.appendChild(svg('path', { class: 'env-line', d: `${d} L${X(shape.length - 1).toFixed(1)} ${HH} L${PAD} ${HH} Z` }));
  root.appendChild(svg('text', { x: X(hi - 1) + 3, y: HH - 3 }, document.createTextNode('key off')));
  // one handle per stage end: L1 (point 1), L2 (2), L3 (3), L4 (5)
  for (const [i, s] of [[1, 0], [2, 1], [3, 2], [5, 3]]) {
    const pt = svg('circle', { class: 'env-pt', cx: X(i), cy: Y(shape[i].l), r: 5, 'data-stage': s });
    pt.appendChild(svg('title', {}, document.createTextNode(`${opts.label || 'EG'} stage ${s + 1}: rate ${rates[s]}, level ${levels[s]} (drag: up/down level, left/right rate)`)));
    root.appendChild(pt);
  }
  if (el.dxEg.drag) return el;
  readout.textContent = `${opts.label || 'EG'}  R ${rates.join(' ')}   L ${levels.join(' ')}`;
  return el;
}

// ------------------------------------------------------------------ keyboard level scaling
/**
 * Level change (in 0-99 output level steps, negative = quieter) across the keyboard for a break
 * point (0 = A-1 .. 99 = C8, key = bp + 21), the left and right curves (0 -LIN, 1 -EXP, 2 +EXP,
 * 3 +LIN) and depths. Shape as in Yamaha's charts: linear grows with the distance from the break
 * point, exponential slowly at first; both reach the depth about four octaves out (approximate).
 */
export function scalingCurve(bp, lc, ld, rc, rd, keys = 128) {
  const bk = bp + 21;
  const amount = (curve, depth, dist) => {
    const u = Math.min(1, dist / 48);
    const shape = curve === 1 || curve === 2 ? (2 ** (u * 4) - 1) / 15 : u;
    return (curve >= 2 ? 1 : -1) * depth * shape;
  };
  return Array.from({ length: keys }, (_, k) => (k < bk ? amount(lc, ld, bk - k) : amount(rc, rd, k - bk)));
}

/** A small chart of the scaling curve, middle line = no change. */
export function scalingGraph({ bp, lc, ld, rc, rd, bpText }) {
  const c = scalingCurve(bp, lc, ld, rc, rd);
  const w = 300;
  const hgt = 64;
  const y = (v) => hgt / 2 - (v / 99) * (hgt / 2 - 4);
  const x = (k) => (k / 127) * w;
  const d = c.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const bk = bp + 21;
  return h('div', svg('svg', { class: 'env-svg', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', style: 'height:64px' },
    svg('line', { class: 'env-axis', x1: 0, x2: w, y1: hgt / 2, y2: hgt / 2 }),
    svg('line', { class: 'env-axis', x1: x(bk), x2: x(bk), y1: 0, y2: hgt, 'stroke-dasharray': '2 3' }),
    svg('path', { d, style: 'fill:none;stroke:var(--accent);stroke-width:2' }),
    svg('text', { x: Math.min(w - 40, x(bk) + 3), y: 10 }, document.createTextNode(bpText ? bpText(bp) : String(bp)))),
  h('div.small.muted', 'Level across the keyboard (shape only): up = louder, down = quieter; dashed line = break point.'));
}

// ------------------------------------------------------------------ values across the keyboard
/**
 * A step line of values over key ranges: points [{key, value}] in key order (each holds to the next
 * point's key), value 0..max; `caption` goes under it. Used by the DX7II fractional scaling.
 */
export function keyCurveGraph({ points, max, caption }) {
  const w = 300;
  const hgt = 64;
  const x = (k) => (k / 128) * w;
  const y = (v) => hgt - 3 - (v / max) * (hgt - 6);
  let d = '';
  points.forEach((p, i) => {
    const end = points[i + 1]?.key ?? 128;
    d += `${i ? 'L' : 'M'}${x(p.key).toFixed(1)} ${y(p.value).toFixed(1)} L${x(end).toFixed(1)} ${y(p.value).toFixed(1)} `;
  });
  return h('div', svg('svg', { class: 'env-svg', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', style: 'height:64px' },
    svg('line', { class: 'env-axis', x1: 0, x2: w, y1: hgt - 3, y2: hgt - 3 }),
    svg('path', { d: d.trim(), style: 'fill:none;stroke:var(--accent);stroke-width:2' })),
  caption ? h('div.small.muted', caption) : null);
}
