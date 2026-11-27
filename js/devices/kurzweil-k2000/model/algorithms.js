// K2000 algorithms: the signal flow of each of the 31 algorithms, and a diagram of it.
//
// The flow is read from the algorithm diagrams of the K2000 Reference Guide (chapter 26, "DSP
// Algorithms"; the Musician's Guide, "Algorithm Basics", explains the drawing: boxes are DSP
// functions, wires run left to right, a wire may split and run under or over blocks to rejoin later,
// two wires at the end make a double-output algorithm). The diagrams are drawn in a symbol font; each
// was decoded glyph by glyph (8 characters per block). Block widths (a function spanning 2 or 3 of
// F1-F4) are the algorithm's own; the functions each block takes come from the OS (fwmodel.js).
//
// Nodes: 'P' = PITCH (the keymap's samples at their pitch), 1-4 = F1-F4 (a wide function is named by
// its first block), 'O' = the output. Edges: [from, to, route], route 'main' (next box), 'low' (a wire
// under the blocks between), 'high' (a wire over them), 'pair' (two wires: a stereo pair), 'sync'
// (hard sync: the slave oscillator restarts with the master; no audio).

import { svg } from '../../../core/ui/dom.js';
import { ALGORITHMS } from './fwmodel.js';

const E = (s) => s.split(' ').map((e) => {
  const m = /^(\w)(>|=|~)(\w)(\^|_)?$/.exec(e);
  const route = m[2] === '=' ? 'pair' : m[2] === '~' ? 'sync' : m[4] === '^' ? 'high' : m[4] === '_' ? 'low' : 'main';
  return [m[1] === 'P' || m[1] === 'O' ? m[1] : Number(m[1]), m[3] === 'P' || m[3] === 'O' ? m[3] : Number(m[3]), route];
});

/** alg -> {widths: {block: width}, edges: [[from, to, route]]}  (">" wire, "=" two wires, "~" sync, "_" under, "^" over) */
export const ALG_FLOW = {
  1: { widths: { 1: 3, 4: 1 }, edges: E('P>1 1>4 4>O') },
  2: { widths: { 1: 2, 3: 1, 4: 1 }, edges: E('P>1 1>3 3=4 4=O') },
  3: { widths: { 1: 2, 3: 2 }, edges: E('P>1 1>3 P>3_ 3=O') },
  4: { widths: { 1: 2, 3: 1, 4: 1 }, edges: E('P>1 1>3 3>4 4>O') },
  5: { widths: { 1: 2, 3: 1, 4: 1 }, edges: E('P>1 1>3 3>4 4>O') },
  6: { widths: { 1: 2, 3: 1, 4: 1 }, edges: E('P>1 1>3 3>4 P>4_ 4>O') },
  7: { widths: { 1: 2, 3: 1, 4: 1 }, edges: E('P>1 P>3_ 1>4^ 3>4 4>O') },
  8: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 2>3 3>4 4>O') },
  9: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 2>3 3>4 4>O') },
  10: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 P>2_ 1>3^ 2>4_ 3>4 4>O') },
  11: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 1>3^ 2>4_ 3>4 4>O') },
  12: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 2>3 3>4 1>4_ 4>O') },
  13: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 2>3 3=4 4=O') },
  14: { widths: { 1: 1, 2: 1, 3: 2 }, edges: E('P>1 P>2_ 1>3^ 2>3 3=O') },
  15: { widths: { 1: 1, 2: 1, 3: 2 }, edges: E('P>1 1>2 1>3_ 2>3 3=O') },
  16: { widths: { 1: 1, 2: 2, 4: 1 }, edges: E('P>1 1>2 2>4 4>O') },
  17: { widths: { 1: 1, 2: 2, 4: 1 }, edges: E('P>1 1>2 2>4 4>O') },
  18: { widths: { 1: 1, 2: 2, 4: 1 }, edges: E('P>1 1>2 P>2_ 2>4 4>O') },
  19: { widths: { 1: 1, 2: 2, 4: 1 }, edges: E('P>1 1>2 2>4 4>O') },
  20: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 P>2_ 2>3 3>4 4>O') },
  21: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 P>2_ 2>3 3>4 4>O') },
  22: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 P>2_ 1>3^ 2>4_ 3>4 4>O') },
  23: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 P>2_ 2>3 2>4_ 3>4 4>O') },
  24: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('P>1 1>2 P>2_ 2>3 3=4 4=O') },
  25: { widths: { 1: 1, 2: 1, 3: 2 }, edges: E('P>1 1>2 P>2_ 1>3^ 2>3 3=O') },
  26: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('1~2 2>3 3=4 4=O') },
  27: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('1~2 2>3 3>4 4>O') },
  28: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('1~2 2>3 3>4 4>O') },
  29: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('1~2 1>3_ 2>4^ 3>4 4>O') },
  30: { widths: { 1: 1, 2: 1, 3: 1, 4: 1 }, edges: E('1~2 2>3 1>3_ 3>4 1>4_ 4>O') },
  31: { widths: { 1: 1, 2: 1, 3: 2 }, edges: E('1~2 2>3 1>3_ 3=O') },
};

const nodeName = (n, names) => (n === 'P' ? 'PITCH' : n === 'O' ? 'the output' : `F${n}${names?.[n] ? ` ${names[n]}` : ''}`);

/** A plain-words description of algorithm `alg`'s signal flow. names: {block: function name}. */
export function describeAlgorithm(alg, names = {}) {
  const f = ALG_FLOW[alg];
  if (!f) return '';
  const parts = [];
  const sync = f.edges.find((e) => e[2] === 'sync');
  if (sync) parts.push(`F1 is the master oscillator and F2 the slave, hard-synced to it`);
  const into = new Map();
  for (const [a, b, route] of f.edges) if (route !== 'sync') { if (!into.has(b)) into.set(b, []); into.get(b).push([a, route]); }
  const order = [1, 2, 3, 4, 'O'].filter((n) => into.has(n));
  for (const n of order) {
    const ins = into.get(n);
    const src = ins.map(([a, route]) => `${nodeName(a, names)}${route === 'pair' ? ' (two wires)' : route === 'low' || route === 'high' ? ' (bypassing the blocks between)' : ''}`);
    if (n === 'O') parts.push(`${src.join(' and ')} ${ins.some(([, r]) => r === 'pair') ? 'gives two outputs' : 'is the output'}`);
    else if (ins.length > 1) parts.push(`${nodeName(n, names)} combines ${src.join(' and ')}`);
    else parts.push(`${nodeName(n, names)} takes ${src[0]}`);
  }
  return `${parts.join('; ')}.`;
}

/**
 * SVG diagram of algorithm `alg`. blocks: [{block, name}] (the current function of each block, from
 * ProgramMap.dspBlocks); the boxes are drawn from the algorithm's own widths.
 */
export function algorithmDiagram(alg, blocks = []) {
  const f = ALG_FLOW[alg];
  if (!f) return null;
  const U = 96, H = 44, TOP = 46, GAP = 22, X0 = 8;
  const sync = f.edges.some((e) => e[2] === 'sync');
  const nodes = []; // {id, x, w, label, title}
  let x = X0;
  if (!sync) { nodes.push({ id: 'P', x, w: U - GAP, label: 'PITCH', title: 'PITCH' }); x += U; }
  for (const b of [1, 2, 3, 4]) {
    const w = f.widths[b];
    if (!w) continue;
    const fn = blocks.find((k) => k.block === b)?.name || '';
    nodes.push({ id: b, x, w: w * U - GAP, label: fn, title: w > 1 ? `F${b}-F${b + w - 1}` : `F${b}` });
    x += w * U;
  }
  const W = x + 30;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const els = [];
  const mid = TOP + H / 2;
  const arrow = (x1, y1, x2, y2, cls = 'alg-wire') => svg('path', { d: `M${x1},${y1} L${x2},${y2}`, class: cls, 'marker-end': 'url(#alg-arrow)' });
  for (const n of nodes) {
    // control inputs: one arrow per block the function spans (PITCH has one)
    const k = Math.max(1, Math.round((n.w + GAP) / U));
    for (let i = 0; i < k; i++) { const ax = n.x + (n.w * (i + 0.5)) / k; els.push(arrow(ax, TOP - 16, ax, TOP - 2, 'alg-ctl')); }
    els.push(svg('rect', { x: n.x, y: TOP, width: n.w, height: H, rx: 4, class: 'alg-box' }));
    els.push(svg('text', { x: n.x + 5, y: TOP + 13, class: 'alg-title' }, document.createTextNode(n.title)));
    const words = String(n.label).split(/\s+/);
    const lines = [];
    for (const w of words) { const last = lines[lines.length - 1]; if (last && (last + ' ' + w).length * 6.2 < n.w - 8) lines[lines.length - 1] = `${last} ${w}`; else lines.push(w); }
    lines.slice(0, 2).forEach((l, i) => els.push(svg('text', { x: n.x + 5, y: TOP + 26 + i * 11, class: 'alg-fn' }, document.createTextNode(l))));
  }
  let lowY = TOP + H + 14, highY = TOP - 24;
  for (const [a, b, route] of f.edges) {
    const A = byId.get(a);
    const ax = A.x + A.w;
    if (b === 'O') {
      if (route === 'pair') { els.push(arrow(ax, mid - 6, ax + 24, mid - 6)); els.push(arrow(ax, mid + 6, ax + 24, mid + 6)); } else els.push(arrow(ax, mid, ax + 24, mid));
      continue;
    }
    const B = byId.get(b);
    if (route === 'sync') { els.push(svg('path', { d: `M${ax},${mid} L${B.x},${mid}`, class: 'alg-sync' })); els.push(svg('text', { x: ax + 2, y: mid - 4, class: 'alg-fn' }, document.createTextNode('sync'))); continue; }
    if (route === 'pair') { els.push(arrow(ax, mid - 6, B.x, mid - 6)); els.push(arrow(ax, mid + 6, B.x, mid + 6)); continue; }
    if (route === 'main') { els.push(arrow(ax, mid, B.x, mid)); continue; }
    // bypass: from the gap after A, under/over the blocks between, up/down into B's left side
    const sx = ax + GAP / 2, ex = B.x - 6;
    const y = route === 'low' ? lowY : highY;
    const ey = route === 'low' ? mid + 10 : mid - 10;
    if (route === 'low') lowY += 8; else highY -= 8;
    els.push(svg('path', { d: `M${sx},${mid} L${sx},${y} L${ex},${y} L${ex},${ey} L${B.x},${ey}`, class: 'alg-wire', 'marker-end': 'url(#alg-arrow)' }));
  }
  const height = Math.max(TOP + H + 30, lowY + 6);
  const top = Math.min(0, highY - 6);
  return svg('svg', { viewBox: `0 ${top} ${W} ${height - top}`, class: 'alg-diagram', role: 'img', 'aria-label': `Algorithm ${alg} ${ALGORITHMS[alg] || ''}` },
    svg('defs', {}, svg('marker', { id: 'alg-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      svg('path', { d: 'M0,0 L8,4 L0,8 z', class: 'alg-head' }))),
    ...els);
}
