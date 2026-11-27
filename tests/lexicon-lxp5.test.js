import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import lxp, * as L from '../js/devices/defs/lexicon-lxp5.js';

const V = JSON.parse(fs.readFileSync(new URL('./lexicon-lxp5.vectors.json', import.meta.url), 'utf8'));
const eff = lxp.objects.find((o) => o.key === 'effect');
const sys = lxp.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (d) => eff.params.filter((p) => !(p.hidden || view(p, d).hidden));
const byKey = (k) => eff.params.find((p) => p.key === k);
const textOf = (p, d) => { const v = view(p, d); const x = readParam(d, v); return v.options ? v.options.find(([o]) => o === x)?.[1] : v.format ? v.format(x) : String(x); };

test('LXP-5: MRC algorithms, pages and value texts', () => {
  assert.deepEqual(L.ALGS.map((a) => [a.v, a.name, a.pages.length]), [[1, 'DLY/RVB', 7], [2, 'PTCH/DLY', 7]]);
  assert.deepEqual(L.ALGS[0].pages.map((p) => p.label.trim()), ['DELAY FINE  FDBK', 'PITCH N/A THIS ALGO', 'HICUT LOCUT LFO-RATE', 'STEREO DLY N/A THIS ALGO', 'RLVL  RTIME  SIZE  DIFF', 'PREDLY FINE TDECAY BASS', 'PAN  INPUT OUTPUT']);
  const delay = L.findItem(1, 'DELAY');
  assert.deepEqual([delay.p, delay.steps, delay.coarseSlot, delay.fineSlot], [0, 78, 0, 1]);
  const t = L.pairTexts(delay.pair);
  assert.deepEqual([t[0], t[1], t[128], t[129], t[10 * 128], t[77 * 128]], ['0us', '64us', '8.19m', '8.25m', '81.9m', '630ms']);
  const pre = L.findItem(1, 'PREDLY');
  assert.deepEqual([L.pairTexts(pre.pair)[0], L.pairTexts(pre.pair)[1], L.pairTexts(pre.pair)[128]], ['0us', '20us', '2.56m']);
  const pitch = L.findItem(2, 'PITCH');
  assert.deepEqual([pitch.p, pitch.send, pitch.steps, L.TABLES[pitch.t][0], L.TABLES[pitch.t][1], L.TABLES[pitch.t][25], L.TABLES[pitch.t][37]], [9, 'pitch', 38, 'OFF', '-2oct', 'unison', '+1oct']);
  const pan = L.findItem(1, 'PAN');
  assert.deepEqual([L.TABLES[pan.t][0], L.TABLES[pan.t][64]], ['100%R', 'Center']);
  for (const a of L.ALGS) for (const pg of a.pages) for (const it of pg.items) {
    if (it.pair != null) assert.equal(L.pairTexts(it.pair).length, L.PAIRS[it.pair].coarse * 128, `${a.name} ${it.name}`);
    else assert.ok(L.TABLES[it.t].length === it.steps && L.TABLES[it.t].every((x) => x && /^[\x20-\x7e]+$/.test(x)), `${a.name} ${it.name}`);
  }
  assert.deepEqual([L.PATCH.src.at(-1), L.PATCH.thresh.length, L.PATCH.scale.length, L.PATCH.dest.length], [[127, 'NONE'], 128, 128, 2]);
});

test('LXP-5: ROM presets and register / setup forms', () => {
  assert.equal(L.PRESETS.length, 65);
  assert.deepEqual([L.PRESET_NAMES[0], L.PRESET_NAMES[56], L.PRESET_NAMES[64]], ['4thDown', 'Slap Room', 'BYPASS']);
  assert.deepEqual([L.algOf(L.romPreset(0)), L.algOf(L.romPreset(56)), L.algOf(L.romPreset(64))], [2, 1, 3]);
  const s = new Uint8Array(L.SETUP_SIZE);
  s.set(L.romPreset(16).slice(0, 24), 0);
  s.set(L.romPreset(16).slice(24, 37), 32);
  s.set(L.romPreset(16).slice(37), 45);
  assert.deepEqual(L.registerOf(s), L.romPreset(16));
  assert.deepEqual([L.offsetOf(0), L.offsetOf(22), L.offsetOf(0x17), L.offsetOf(0x1f), L.offsetOf(0x2c), L.offsetOf(0x3f), L.offsetOf(0x40)], [1, 23, null, 24, 37, 56, null]);
});

test('LXP-5: messages match what the v1.12 firmware sends and takes', () => {
  const reg = L.romPreset(16);
  assert.deepEqual(L.registerMessage(7, reg), V.registerIn);
  assert.deepEqual(V.register7, V.registerIn);
  const after = L.parse(Uint8Array.from(V.afterLoad));
  assert.equal(after.kind, 'setup');
  assert.ok(after.ok);
  assert.deepEqual(L.registerOf(after.data), reg);
  assert.equal(after.data[65], 7);
  assert.deepEqual(V.param0, L.paramMessage(0, reg[1]));
  const e = L.registerOf(L.parse(Uint8Array.from(V.afterEdits)).data);
  assert.deepEqual([e[1], e[9], e[10], e[L.PATCH_AT + 2]], [0x11, 1, 0x0c, 0x2f]);
  const sin = L.parse(Uint8Array.from(V.setupIn));
  assert.equal(sin.kind, 'setup');
  assert.deepEqual(L.setupMessage(sin.data), V.setupIn);
  assert.deepEqual(L.parse(Uint8Array.from(V.afterSetupIn)).data, sin.data);
  const r10 = L.parse(Uint8Array.from(V.register10));
  assert.deepEqual(r10.data, L.registerOf(sin.data));
  assert.deepEqual(L.registerOf(L.parse(Uint8Array.from(V.afterProgramChange)).data), r10.data);
  assert.equal(V.allLength, 6 + L.ALL_SIZE + 2);
  assert.deepEqual(V.allHead, [0xf0, 6, 5, 0x40, 0x39, 0x00]);
  assert.deepEqual(V.allRegister7, Array.from(reg));
  assert.ok(V.allChecksumOk);
});

test('LXP-5: editor parameters, live messages, simulator', () => {
  const d = L.romPreset(16); // Echo Delay, PTCH/DLY
  assert.equal(L.algOf(d), 2);
  const vis = visible(d).map((p) => p.key);
  assert.ok(vis.includes('a2p1s0') && !vis.includes('a1p1s0'));
  const md = byKey('a2p1s0');
  assert.equal(textOf(md, d), L.pairTexts(L.findItem(2, 'MDELAY').pair)[d[1] * 128 + d[2]]);
  const pitch = eff.params.find((p) => p.key.startsWith('a2') && p.label === 'PITCH');
  assert.equal(textOf(pitch, d), 'OFF');
  writeParam(d, pitch, 26);
  assert.deepEqual([d[9], d[10]], [1, 25]);
  assert.deepEqual(pitch.send(26, {}), [[0xf0, 6, 5, 0x20, 8, 1, 0xf7], [0xf0, 6, 5, 0x20, 9, 25, 0xf7]]);
  assert.deepEqual(pitch.send(0, {}), [0xf0, 6, 5, 0x20, 8, 0, 0xf7]);
  assert.deepEqual(eff.sendParam(byKey('alg'), 1, d, { channel: 3 }), [0xf0, 6, 5, 0x23, 0x42, 1, 0xf7]);
  assert.deepEqual(eff.sendParam(byKey('src1'), 5, d, {}), [0xf0, 6, 5, 0x20, 0x31, 5, 0xf7]);
  // Dest options carry the values the MRC sends (23-26 -> patch Scale parameters)
  assert.ok(view(byKey('a2dest0'), d).options.some(([v]) => v === 0x2f));
  for (const i of [0, 30, 56]) {
    const x = L.romPreset(i);
    for (const p of visible(x)) assert.ok(textOf(p, x) != null, `preset ${i} ${p.key}`);
  }
  // simulator: register in, load, setup out
  const sim = lxp.simulate();
  sim.handle(Uint8Array.from(V.registerIn));
  sim.handle(Uint8Array.from(L.loadMessage(7)));
  const got = sim.handle(Uint8Array.from(eff.request({})));
  assert.deepEqual(eff.decode(got[0]), L.romPreset(16));
  sim.handle(Uint8Array.from(L.paramMessage(0x42, 1)));
  assert.equal(sim.state.setup[0], 1);
  const edits = L.editMessages(L.romPreset(30));
  for (const m of edits) sim.handle(Uint8Array.from(m));
  assert.deepEqual(L.registerOf(sim.state.setup).slice(0, 37), L.romPreset(30).slice(0, 37));
  assert.equal(sys.params.find((p) => p.key === 'ms0').label, 'Parameter 0 (DELAY / MDELAY)');
  assert.equal(lxp.libraryItems([Uint8Array.from(V.afterLoad)]).length, 2);
  assert.match(lxp.describe(Uint8Array.from(V.register7)), /register 8 "Echo Delay" \(PTCH\/DLY\)/);
});

test('LXP-5: translator', () => {
  const d = L.romPreset(16);
  const c = eff.toCommon(d);
  assert.equal(c.effects.delay.type, 'PTCH/DLY');
  assert.deepEqual(Array.from(eff.fromCommon(c).data), Array.from(d));
  const r = eff.fromCommon({ effects: { reverb: { time: 1, level: 1 } } }, L.romPreset(0));
  assert.equal(L.algOf(r.data), 1);
  assert.equal(L.nameOf(r.data), '4thDown');
  const p = eff.fromCommon({ effects: { pitch: { level: 1 } } });
  assert.equal(L.algOf(p.data), 2);
  assert.equal(eff.fromCommon({ effects: {} }).report.dropped.length, 1);
});
