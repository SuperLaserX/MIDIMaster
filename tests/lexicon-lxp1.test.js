import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import lxp, * as L from '../js/devices/defs/lexicon-lxp1.js';

const V = JSON.parse(fs.readFileSync(new URL('./lexicon-lxp1.vectors.json', import.meta.url), 'utf8'));
const eff = lxp.objects.find((o) => o.key === 'effect');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (d) => eff.params.filter((p) => !(p.hidden || view(p, d).hidden));
const byKey = (k) => eff.params.find((p) => p.key === k);
const textOf = (p, d) => { const v = view(p, d); const x = readParam(d, v); return v.options ? v.options.find(([o]) => o === x)?.[1] : v.format ? v.format(x) : String(x); };

test('LXP-1: algorithms, MRC pages and value texts', () => {
  assert.deepEqual(L.ALGS.map((a) => [a.v, a.name]), [[1, 'REVERB'], [2, 'PLATE'], [3, 'CHORUS 1'], [5, 'CHORUS 2'], [8, 'DELAY 1'], [4, 'DELAY 2'], [6, 'INVERSE'], [7, 'GATE']]);
  const rev = L.ALGS[0];
  assert.deepEqual(rev.pages.map((p) => p.label), ['RTIME  SIZE  HICUT FXLVL', ' BASS  PDLY  FDBK  DIFF ']);
  assert.deepEqual(rev.pages[0].items.map((it) => [it.name, it.w, it.steps, it.send]), [['RTIME', 0, 16, 'a'], ['SIZE', 5, 64, 'a'], ['HICUT', 4, 16, 'a'], ['FXLVL', 2, 255, 'a']]);
  const rt = L.findItem(1, 'RTIME');
  assert.deepEqual([L.TABLES[rt.t][0], L.TABLES[rt.t][11], L.TABLES[rt.t][15]], ['0.6s', L.TABLES[rt.t][11], '8.9s']);
  const fx = L.findItem(1, 'FXLVL');
  assert.deepEqual([L.TABLES[fx.t].length, L.TABLES[fx.t][0], L.TABLES[fx.t][127], L.TABLES[fx.t][254]], [255, '0%', '50%', '100%']);
  const bass = L.findItem(1, 'BASS');
  assert.equal(bass.send, 'b');
  assert.deepEqual([L.TABLES[bass.t][0], L.TABLES[bass.t][15]], ['0.35x', '2.40x']);
  // the patch Dest list names words the pages leave out
  assert.equal(L.wordName(3, 0), '-FDBK');
  assert.equal(L.wordName(4, 0), '+FDBK');
  assert.equal(L.wordName(1, 8), null);
  for (const a of L.ALGS) for (const pg of a.pages) for (const it of pg.items) {
    assert.equal(L.TABLES[it.t].length, it.steps, `${a.name} ${it.name}`);
    assert.ok(L.TABLES[it.t].every((t) => t && /^[\x20-\x7e]+$/.test(t)), `${a.name} ${it.name}: a value without text`);
  }
  assert.deepEqual([L.SRC[0], L.SRC[1], L.SRC[32], L.SRC[64], L.SRC[68], L.SRC.at(-1)], [[0, 'CTRL0'], [1, 'MODWH'], [32, 'SUST'], [64, 'NOTE'], [68, 'TEMPO'], [127, 'NONE']]);
  assert.deepEqual([L.SCALE[0], L.SCALE[127], L.SCALE[128], L.SCALE[255]], ['+0%', '+200%', '-200%', '-1%']);
});

test('LXP-1: fader steps to words as the MRC sends them', () => {
  const rt = L.findItem(1, 'RTIME');
  assert.deepEqual([L.stepWord(rt, 0), L.stepWord(rt, 11), L.stepWord(rt, 15)], [0x8000, 0xac00, 0xbc00]);
  const fx = L.findItem(1, 'FXLVL');
  assert.deepEqual([L.stepWord(fx, 0x79), L.stepWord(fx, 0x7a), L.stepWord(fx, 254)], [0x8000 + 0x79 * 0x40, 0x8000 + 0x7b * 0x40, 0xbfc0]);
  const fb = L.findItem(1, 'FDBK');
  assert.deepEqual([L.stepWord(fb, 0), L.stepWord(fb, 127), L.stepWord(fb, 254)], [0x4000, 0x8000, 0xbf80]);
  const bass = L.findItem(1, 'BASS');
  assert.equal(L.stepWord(bass, 6), 0x7000);
  // the ROM presets: every MRC page word on a step, FXLVL BFFEh / BFFFh between steps
  const d = L.romPreset(1);
  assert.equal(L.nameOf(d), 'DUMB HALL');
  assert.equal(L.textOfWord(d, 0), L.TABLES[L.findItem(1, 'RTIME').t][9]);
  assert.match(L.textOfWord(d, 2), /100% \(BFFEh, between MRC steps\)/);
});

test('LXP-1: messages match what the v1.06 firmware sends and takes', () => {
  const d = L.romPreset(1);
  assert.deepEqual(L.setupMessage(d), V.setupIn);
  assert.deepEqual(V.setupOut, V.setupIn); // taken and sent back unchanged
  const m = L.parse(Uint8Array.from(V.setupOut));
  assert.ok(m.ok);
  assert.deepEqual(Array.from(m.data), Array.from(d));
  assert.deepEqual(L.param2Message(0, 0xa400), V.param2);
  assert.deepEqual(L.paramMessage(2, 0xbffe), V.param5);
  assert.deepEqual(L.param2Message(0x20, 0x44), V.paramName);
  assert.deepEqual(L.parse(Uint8Array.from(V.param2)), { kind: 'param', ch: 0, p: 0, v: 0xa400, form: 2 });
  // the edits (5n word, 2n word, name, patch source, patch scale) as the unit stored them
  const after = L.parse(Uint8Array.from(V.afterEdits)).data;
  assert.deepEqual([L.wordOf(after, 0), L.wordOf(after, 1), after[L.NAME_AT + 1], after[L.SRC_AT], after[L.SCALE_AT]], [0xac40, 0x91c0, 0x41, 0x41, 0x80]);
  const sim = lxp.simulate();
  sim.handle(Uint8Array.from(V.setupIn));
  for (const e of V.edits) sim.handle(Uint8Array.from(e));
  assert.deepEqual(Array.from(sim.state.setup), Array.from(after));
  // algorithm change keeps every other byte
  const alg = L.parse(Uint8Array.from(V.algChange)).data;
  assert.deepEqual([alg[0], Array.from(alg.slice(1))], [7, Array.from(after.slice(1))]);
  sim.handle(Uint8Array.from(L.algMessage(7)));
  assert.deepEqual(Array.from(sim.state.setup), Array.from(alg));
  // store 70 05, register request, load 71 05, program change
  assert.deepEqual(L.storeMessage(5), [0xf0, 6, 2, 0x60, 0x70, 5, 0xf7]);
  const r5 = L.parse(Uint8Array.from(V.register5));
  assert.deepEqual([r5.kind, r5.n, r5.ok, Array.from(r5.data)], ['register', 5, true, Array.from(alg)]);
  assert.deepEqual(L.registerMessage(5, alg), V.register5);
  assert.deepEqual(L.parse(Uint8Array.from(V.afterLoad)).data, alg);
  assert.deepEqual(L.parse(Uint8Array.from(V.afterProgramChange)).data, alg);
  // register dump in, all registers out
  assert.deepEqual(L.registerMessage(9, L.romPreset(8)), V.registerIn);
  assert.deepEqual(L.parse(Uint8Array.from(V.register9)).data, L.romPreset(8));
  assert.equal(V.allLength, 6 + 0x1c00 + 2);
  assert.deepEqual(V.allHead, [0xf0, 6, 2, 0x40, 0x38, 0x00]);
  assert.deepEqual(V.allRegister9, Array.from(L.romPreset(8)));
  assert.ok(V.allChecksumOk && V.badChecksumKept);
  const all = new Uint8Array(L.ALL_SIZE);
  all.set(L.romPreset(8), 9 * L.SIZE);
  const am = L.parse(Uint8Array.from(L.allMessage(all)));
  assert.equal(am.kind, 'all');
  assert.ok(am.ok);
  assert.deepEqual(am.data.slice(9 * L.SIZE, 10 * L.SIZE), L.romPreset(8));
});

test('LXP-1: editor parameters, live messages, slots, simulator round trip', async () => {
  const d = L.romPreset(1);
  const vis = visible(d).map((p) => p.key);
  assert.ok(vis.includes('a1w0') && !vis.includes('a3w8'));
  const rt = byKey('a1w0');
  assert.equal(textOf(rt, d), L.TABLES[L.findItem(1, 'RTIME').t][9]);
  // an off-grid ROM preset word has an option of its own (so writes keep it)
  assert.ok(byKey('a1w2').options.some(([w]) => w === 0xbffe));
  writeParam(d, rt, L.stepWord(L.findItem(1, 'RTIME'), 12));
  assert.equal(L.wordOf(d, 0), 0xb000);
  assert.deepEqual(eff.sendParam(rt, 0xb000, d, { channel: 0 }), [0xf0, 6, 2, 0x50, 0, 0xb, 0, 0, 0, 0xf7]);
  assert.deepEqual(eff.sendParam(byKey('alg'), 3, d, { channel: 2 }), [0xf0, 6, 2, 0x52, 0x41, 0, 0, 0, 3, 0xf7]);
  assert.deepEqual(eff.sendParam(byKey('src1'), 0x41, d, {}), [0xf0, 6, 2, 0x50, 0x31, 0, 0, 4, 1, 0xf7]);
  assert.deepEqual(eff.sendParam(byKey('a1dest2'), 5, d, {}), [0xf0, 6, 2, 0x50, 0x36, 0, 0, 0, 5, 0xf7]);
  const w8 = view(byKey('w8'), d);
  assert.equal(w8.label, 'Word 8 (no name on the MRC)');
  assert.equal(view(byKey('w0'), L.romPreset(12)).label, 'Word 0 (-FDBK)');
  // every visible parameter of every algorithm reads a text for its own value
  for (const a of L.ALGS) {
    const x = L.romPreset(Math.max(0, L.PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === a.v)));
    for (const p of visible(x)) assert.ok(textOf(p, x) != null, `${a.name} ${p.key}`);
  }
  // simulator: Get, register fetch, store
  const sim = lxp.simulate();
  const got = sim.handle(Uint8Array.from(eff.request({})));
  assert.deepEqual(eff.decode(got[0]), L.romPreset(0));
  sim.handle(Uint8Array.from(L.registerMessage(3, L.romPreset(5))));
  const reg = sim.handle(Uint8Array.from(L.requestMessage(L.REQ.register, 3)));
  assert.deepEqual(L.parse(reg[0]).data, L.romPreset(5));
  sim.handle(Uint8Array.from(eff.slots.recall(0, 3, {})[0]));
  assert.deepEqual(sim.state.setup, L.romPreset(5));
  sim.handle(Uint8Array.from(eff.slots.recall(1, 10, {})[0]));
  assert.deepEqual(sim.state.setup, L.romPreset(10));
  assert.equal(L.PRESET_NAMES.length, 16);
  assert.equal(L.PRESET_NAMES[1], 'DUMB HALL');
  assert.match(L.PRESET_NAMES[0], /^Preset 1 \(REVERB\)$/);
  // library and monitor
  const items = lxp.libraryItems([Uint8Array.from(V.register9), Uint8Array.from(L.allMessage(new Uint8Array(L.ALL_SIZE)))]);
  assert.equal(items.length, 129);
  assert.match(lxp.describe(Uint8Array.from(V.setupOut)), /active setup "DUMB HALL" \(REVERB\)/);
});

test('LXP-1: translator', () => {
  const d = L.romPreset(1);
  const c = eff.toCommon(d);
  assert.equal(c.kind, 'effect');
  assert.equal(c.effects.reverb.type, 'Hall');
  assert.ok(c.effects.reverb.time > 0.5 && c.effects.reverb.time < 0.7);
  assert.deepEqual(Array.from(eff.fromCommon(c).data), Array.from(d));
  const del = eff.fromCommon({ effects: { delay: { time: 1, feedback: 0.5, level: 1 } } }, L.romPreset(1));
  assert.equal(L.algOf(del.data), 8);
  assert.equal(L.nameOf(del.data), 'DUMB HALL');
  assert.equal(L.wordOf(del.data, 1), L.stepWord(L.findItem(8, 'DELAY'), 254));
  const ch = eff.fromCommon({ effects: { chorus: { rate: 0, depth: 1 } } });
  assert.equal(L.algOf(ch.data), 3);
  assert.equal(eff.fromCommon({ effects: {} }).report.dropped.length, 1);
  const pl = eff.toCommon(L.romPreset(8));
  assert.equal(pl.effects.reverb.type, 'Plate');
});
