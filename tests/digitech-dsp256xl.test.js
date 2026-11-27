import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import xl, * as X from '../js/devices/defs/digitech-dsp256xl.js';
import dsp, * as D from '../js/devices/defs/digitech-dsp256.js';

const V = JSON.parse(fs.readFileSync(new URL('./digitech-dsp256xl.vectors.json', import.meta.url), 'utf8'));
const prog = xl.objects.find((o) => o.key === 'effect');
const sys = xl.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const textOf = (o, key, d) => { const p = view(o.params.find((x) => x.key === key), d); const v = readParam(d, p); return p.options ? p.options.find(([x]) => x === v)?.[1] : String(v); };

test('DSP-256XL: layout found by code pattern and its configurations', () => {
  assert.equal(X.LAYOUT.model, 0x0b);
  assert.equal(X.DUMP_SIZE, 5744);
  assert.equal(X.LAYOUT.address.dump, 0x08dc);
  assert.equal(X.CONFIGS.length, 28);
  assert.deepEqual(X.CONFIGS.map((c) => c.name), [...D.CONFIGS.slice(0, 7).map((c) => c.name), 'Room Simulator', ...D.CONFIGS.slice(7).map((c) => c.name)]);
  for (const c of X.CONFIGS) c.params.forEach((pg, i) => {
    assert.equal(pg.p, i + 1);
    for (const t of pg.ts ?? [pg.t]) assert.ok(X.TABLES[t].length === pg.max + 1 && X.TABLES[t].every((s) => s && /^[\x20-\x7e]+$/.test(s)), `${c.name} ${pg.label}`);
  });
  // Room Simulator: the Decay Time texts follow the Room Size (byte 1)
  const rs = X.CONFIGS[7];
  assert.deepEqual(rs.params.map((p) => p.label), ['Room Size', 'Decay Time', 'Position', 'Damping Factor', 'Reverb Level', 'Dry Level']);
  const decay = X.findPage(7, 'Decay Time');
  assert.equal(decay.by, 1);
  assert.equal(decay.ts.length, X.findPage(7, 'Room Size').max + 1);
  const d = new Uint8Array(X.SIZE);
  d[0] = 7;
  d[1] = 0;
  assert.equal(X.textOf(7, 2, 0, d), '.20  Seconds');
  d[1] = 1;
  assert.equal(X.textOf(7, 2, 0, d), '.30  Seconds');
  assert.equal(view(prog.params.find((p) => p.key === 'c7p2'), d).options[0][1], '.30  Seconds');
  // the other configurations are the DSP-256's, page for page
  for (const c of X.CONFIGS.filter((x) => x.name !== 'Room Simulator')) {
    const o = D.CONFIGS.find((x) => x.name === c.name);
    assert.deepEqual(c.params.map((p) => [p.label, p.max]), o.params.map((p) => [p.label, p.max]), c.name);
  }
});

test('DSP-256XL: factory presets, first power-up memory and messages', () => {
  assert.equal(X.PRESETS.length, 128);
  assert.deepEqual(X.PRESET_NAMES.slice(0, 2), ['Left in Hall', 'Fat Animation']);
  for (let i = 0; i < 128; i++) assert.deepEqual(X.programFromDump(X.FIRST, i), X.factory(i));
  for (const c of X.CONFIGS) {
    const n = X.PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === c.v);
    const want = n >= 0 ? X.factory(n).slice(0, X.PROG) : Uint8Array.from({ length: X.PROG }, (_, i) => (i ? 0 : c.v));
    assert.deepEqual(X.memoryOf(X.FIRST, c.v), want, c.name);
  }
  const pv = V.program;
  const d = new Uint8Array(X.SIZE);
  d.set(pv.program, 0);
  X.setTitle(d, pv.title);
  assert.deepEqual(X.programMessage(pv.n, d), pv.msg);
  assert.deepEqual(X.requestAll(), V.all.request);
  const all = X.allMessage(X.FIRST);
  assert.deepEqual([all.length, all.slice(0, 40), all.slice(-9)], [V.all.length, V.all.head, V.all.tail]);
  const sim = xl.simulate();
  sim.state.dump[X.AT.map + V.programChange.map[0]] = V.programChange.map[1];
  sim.handle([0xc0, V.programChange.map[0]]);
  assert.equal(sim.current, V.programChange.current);
  assert.equal(X.PRESET_NAMES[V.programChange.current - 128], V.programChange.title.trim());
  assert.deepEqual(Array.from(xl.simulate().handle(X.requestAll())[0]), all);
  // the two models do not take each other's messages
  assert.equal(X.parse(Uint8Array.from(D.programMessage(1, D.factory(0)))), null);
  assert.equal(dsp.recognise(Uint8Array.from(pv.msg)), false);
});

test('DSP-256XL: editor pages, settings and translator', () => {
  const d = X.factory(0);
  writeParam(d, X.paramOf('config'), 7);
  assert.deepEqual(d.slice(0, X.PROG), X.memoryOf(X.FIRST, 7));
  const f = Uint8Array.from(X.FIRST);
  assert.deepEqual([textOf(sys, 'channel', f), textOf(sys, 'transmit', f), textOf(sys, 'contrast', f), textOf(sys, 'mode', f)], ['1', 'YES', '5', 'Foot Controller']); // the XL starts with the foot controller mapping (D1CF)
  const links = sys.params.filter((p) => p.section === 'links' && p.options);
  assert.equal(links.length, 94);
  for (const c of X.CONFIGS) for (const pg of c.params) assert.ok(links.some((p) => p.offset === X.AT.links + pg.id), `${c.name} ${pg.label}`);
  for (const p of sys.params) {
    const v = view(p, f);
    if (v.options && !v.readOnly) assert.ok(v.options.some(([x]) => x === readParam(f, v)), `${p.key}`);
  }
  const c = prog.toCommon(d);
  assert.deepEqual(prog.fromCommon(c).data, d);
  // a DSP-256 program comes over exactly when the XL has its configuration with the same pages
  const src = D.factory(0);
  const r = prog.fromCommon(dsp.objects[0].toCommon(src));
  assert.equal(X.CONFIGS[r.data[0]].name, D.CONFIGS[src[0]].name);
  assert.deepEqual(r.data.slice(1), src.slice(1));
  assert.match(r.report.mapped.join(), /other model/);
});
