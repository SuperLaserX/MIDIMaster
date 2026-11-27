import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import dsp, * as D from '../js/devices/defs/digitech-dsp256.js';

const V = JSON.parse(fs.readFileSync(new URL('./digitech-dsp256.vectors.json', import.meta.url), 'utf8'));
const prog = dsp.objects.find((o) => o.key === 'effect');
const sys = dsp.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (o, d) => o.params.filter((p) => !(p.hidden || view(p, d).hidden));
const textOf = (o, key, d) => { const p = view(o.params.find((x) => x.key === key), d); const v = readParam(d, p); return p.options ? p.options.find(([x]) => x === v)?.[1] : String(v); };

test('DSP-256: configurations, pages and LCD texts', () => {
  assert.equal(D.CONFIGS.length, 27);
  assert.deepEqual([D.CONFIGS[0].name, D.CONFIGS[1].name, D.CONFIGS[6].name, D.CONFIGS[26].name], ['Mute', 'Dry', 'Ultimate Reverb', 'EQ+Flan+4Tap+Mix']);
  assert.deepEqual(D.CONFIGS.map((c) => c.params.length), [0, 0, 6, 7, 5, 15, 11, 8, 7, 7, 9, 14, 14, 13, 12, 13, 12, 11, 10, 21, 21, 20, 21, 20, 21, 20, 21]);
  for (const c of D.CONFIGS) c.params.forEach((pg, i) => {
    assert.equal(pg.p, i + 1, `${c.name}: pages follow the program bytes`);
    const t = D.TABLES[pg.t];
    assert.ok(t.length === pg.max + 1 && t.every((s) => s && /^[\x20-\x7e]+$/.test(s)), `${c.name} ${pg.label}`);
  });
  const cdr = D.CONFIGS[21];
  assert.equal(cdr.name, 'Cho+Dly+Room+Mix');
  const text = (label, v) => D.TABLES[D.findPage(21, label).t][v];
  assert.deepEqual([text('Chorus Delay', 15), text('Delay Time', 0), text('Delay Time', 147), text('Delay Feedback', 11), text('Reverb Filter', 0), text('Reverb Decay', 4)],
    ['15 Millisecs.', '0.000 Seconds', '0.750 Seconds', 'Repeat Hold', 'Bright', '500 Millisec.']);
  assert.equal(D.textOf(21, 1, 15), '15 Millisecs.');
  assert.equal(D.textOf(21, 1, 61), null);
});

test('DSP-256: factory presets and the first power-up memory', () => {
  assert.equal(D.PRESETS.length, 128);
  const p0 = D.factory(0);
  assert.deepEqual([D.titleOf(p0), D.configOf(p0), D.titleOf(D.factory(1))], ['Echoing Chorus', 21, 'City Streets PM']);
  assert.equal(D.FIRST.length, D.DUMP_SIZE);
  for (let i = 0; i < 128; i++) assert.deepEqual(D.programFromDump(D.FIRST, i), D.factory(i), `user ${i + 1} = factory ${129 + i} after the first power-up`);
  // each configuration memory: the first factory preset with that configuration (zeros when none)
  for (const c of D.CONFIGS) {
    const n = D.PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === c.v);
    const want = n >= 0 ? D.factory(n).slice(0, D.PROG) : Uint8Array.from({ length: D.PROG }, (_, i) => (i ? 0 : c.v));
    assert.deepEqual(D.memoryOf(D.FIRST, c.v), want, c.name);
  }
  assert.equal(D.PRESET_NAMES[24], '←-ecapS repyH←--');
  const t = new Uint8Array(D.SIZE);
  D.setTitle(t, D.PRESET_NAMES[24]);
  assert.deepEqual(t.slice(D.PROG), D.factory(24).slice(D.PROG));
  const f = D.FIRST;
  assert.deepEqual([f[D.AT.channel], f[D.AT.transmit], f[D.AT.mode], f[D.AT.contrast], f[D.AT.map], f[D.AT.map + 127]], [1, 1, 0xff, 0x40, 0, 127]);
});

test('DSP-256: messages match what the v1.05 firmware takes and sends', () => {
  const pv = V.program;
  const d = new Uint8Array(D.SIZE);
  d.set(pv.program, 0);
  D.setTitle(d, pv.title);
  assert.deepEqual(D.programMessage(pv.n, d), pv.msg);
  const m = D.parse(Uint8Array.from(pv.msg));
  assert.deepEqual([m.kind, m.n, D.titleOf(m.data)], ['program', 5, 'Vector Program']);
  assert.deepEqual(D.requestAll(), V.all.request);
  // the unit answers the request with its whole memory: after the first power-up that is FIRST
  const all = D.allMessage(D.FIRST);
  assert.equal(all.length, V.all.length);
  assert.deepEqual(all.slice(0, 40), V.all.head);
  assert.deepEqual(all.slice(-9), V.all.tail);
  const back = D.parse(Uint8Array.from(all));
  assert.deepEqual(back.data, D.FIRST);
  // program change through the map, other channels and OMNI (simulator against the firmware's behaviour)
  const sim = dsp.simulate();
  sim.state.dump[D.AT.map + V.programChange.map[0]] = V.programChange.map[1];
  sim.handle([0xc0, V.programChange.map[0]]);
  assert.equal(sim.current, V.programChange.current);
  assert.equal(D.PRESET_NAMES[V.programChange.current - 128], V.programChange.title.trim());
  const other = [...D.programMessage(6, d)];
  other[4] = 3;
  sim.handle(other);
  assert.equal(D.titleOf(D.programFromDump(sim.state.dump, 6)) === 'Vector Program', V.otherChannel.stored);
  sim.state.dump[D.AT.channel] = 17;
  sim.handle(other);
  assert.equal(D.titleOf(D.programFromDump(sim.state.dump, 6)) === 'Vector Program', V.omni.stored);
  const reply = dsp.simulate().handle(D.requestAll());
  assert.deepEqual(Array.from(reply[0]), all);
  assert.ok(dsp.isRequest(D.requestAll()));
  assert.match(dsp.describe(Uint8Array.from(pv.msg)), /program 6 "Vector Program"/);
});

test('DSP-256: program editor pages, configuration switch and live sends', () => {
  const d = D.factory(0);
  const names = visible(prog, d).filter((p) => p.group !== 'Bytes (exact)').map((p) => p.label);
  assert.deepEqual(names.slice(0, 4), ['Configuration', 'Chorus Delay', 'Chorus LFO Speed', 'Chorus LFO Depth']);
  assert.equal(textOf(prog, 'c21p1', d), '15 Millisecs.');
  for (const p of prog.params) {
    const v = view(p, d);
    if (v.hidden || !v.options) continue;
    assert.ok(v.options.some(([x]) => x === readParam(d, v)), `${p.key} value has an option`);
  }
  // switching the configuration loads that configuration's memory, as the panel does (626Dh)
  writeParam(d, D.paramOf('config'), 6);
  assert.deepEqual(d.slice(0, D.PROG), D.memoryOf(D.FIRST, 6));
  assert.equal(D.titleOf(d), 'Echoing Chorus');
  // each change: the program into the target user program, then a program change
  D._test.unit.target = 9;
  const out = prog.sendParam(D.paramOf('c6p1'), 3, d, { channel: 2 });
  assert.deepEqual(out[0], D.programMessage(9, d, 2));
  assert.deepEqual(out[1], [0xc2, 9]);
  D._test.unit.target = 0;
  // an out-of-range byte is shown as such
  d[1] = 200;
  assert.match(textOf(prog, 'c6p1', d), /outside/);
});

test('DSP-256: settings pages', () => {
  const f = Uint8Array.from(D.FIRST);
  assert.deepEqual([textOf(sys, 'channel', f), textOf(sys, 'transmit', f), textOf(sys, 'contrast', f), textOf(sys, 'mode', f)], ['1', 'YES', '5', 'Hand Controller']);
  assert.deepEqual(sys.params.find((p) => p.key === 'channel').options.map(([, t]) => t).filter((t) => !/^\d+$/.test(t)), ['NONE', 'OMNI']);
  assert.equal(textOf(sys, 'map0', f), '1');
  f[D.AT.map + 1] = 200;
  assert.equal(textOf(sys, 'map1', f), `201 (factory ${D.PRESET_NAMES[72]})`);
  const links = sys.params.filter((p) => p.section === 'links' && p.options);
  assert.equal(links.length, 90);
  assert.ok(links.some((p) => p.label === 'Bypass' && p.offset === D.AT.links + 91));
  assert.ok(links.some((p) => p.label === 'Repeat Hold' && p.offset === D.AT.links + 92));
  assert.deepEqual(links[0].options.slice(-2).map(([, t]) => t), ['CC 128', 'ChP (channel pressure)']);
  // every program page's link number names a link byte
  for (const c of D.CONFIGS) for (const pg of c.params) assert.ok(links.some((p) => p.offset === D.AT.links + pg.id), `${c.name} ${pg.label} link ${pg.id}`);
  assert.deepEqual(D.UTILITY.functions.slice(0, 3), ['No Function', 'Program Up', 'Program Down']);
  assert.equal(D.UTILITY.functions.at(-1), 'Patch Select');
  for (const p of sys.params) {
    const v = view(p, f);
    if (v.options && !v.readOnly) assert.ok(v.options.some(([x]) => x === readParam(f, v)), `${p.key} first power-up value has an option`);
  }
});

test('DSP-256: library items and translator', () => {
  const items = dsp.libraryItems([Uint8Array.from(D.allMessage(D.FIRST))]);
  assert.equal(items.filter((i) => i.object === 'effect').length, 128);
  assert.equal(items.find((i) => i.object === 'system').data.length, D.DUMP_SIZE);
  const d = D.factory(0);
  const c = prog.toCommon(d);
  assert.ok(c.effects.reverb && c.effects.delay && c.effects.chorus);
  assert.deepEqual(prog.fromCommon(c).data, d);
  const g = prog.fromCommon({ effects: { reverb: { time: 0.5, level: 1 } } }, D.factory(3));
  assert.ok(D._test.blocks(g.data[0]).reverb);
  assert.equal(D.titleOf(g.data), D.titleOf(D.factory(3)));
  const ch = prog.fromCommon({ effects: { chorus: { rate: 0.25, depth: 1, level: 1 }, delay: { time: 0.2, feedback: 0.5, level: 1 } } });
  const b = D._test.blocks(ch.data[0]);
  assert.ok(b.chorus && b.delay);
});
