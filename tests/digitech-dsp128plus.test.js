import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import dsp, * as D from '../js/devices/defs/digitech-dsp128plus.js';

const V = JSON.parse(fs.readFileSync(new URL('./digitech-dsp128plus.vectors.json', import.meta.url), 'utf8'));
const prog = dsp.objects.find((o) => o.key === 'effect');
const sys = dsp.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (o, d) => o.params.filter((p) => !(p.hidden || view(p, d).hidden));
const textOf = (o, key, d) => { const p = view(o.params.find((x) => x.key === key), d); const v = readParam(d, p); return p.options ? p.options.find(([x]) => x === v)?.[1] : String(v); };
const labels = (c) => D.CONFIGS[c].params.map((p) => p.label).join(' ');

test('DSP-128 Plus: configurations, pages and display texts', () => {
  assert.equal(D.CONFIGS.length, 15);
  assert.deepEqual(D.CONFIGS.map((c) => c.name), Array.from({ length: 15 }, (_, i) => `A${String(i).padStart(3, ' ')}`));
  assert.deepEqual(D.CONFIGS.map((c) => c.params.length), [0, 10, 11, 10, 11, 10, 11, 11, 11, 8, 9, 11, 11, 10, 9]);
  assert.equal(labels(1), 'LP rL rd dL d F CL Cd SP DE');
  assert.equal(labels(7), 'LP CL Cd SP DE dL b c d E F');
  assert.equal(labels(13), 'EL SL rF rv dP En St Sd Et Ed');
  for (const c of D.CONFIGS) c.params.forEach((pg, i) => {
    assert.equal(pg.p, i + 1, `${c.name}: pages follow the program bytes`);
    const t = D.TABLES[pg.t];
    assert.ok(t.length === pg.max + 1 && t.every((s) => s && /^[\x20-\x7e]+$/.test(s)), `${c.name} ${pg.label}`);
    assert.ok(pg.link >= 1 && pg.link <= 44, `${c.name} ${pg.label}: a link with a MIDI page`);
  });
  const t = (c, label, v) => D.TABLES[D.findPage(c, label).t][v];
  assert.deepEqual([t(1, 'LP', 0), t(1, 'LP', 11), t(1, 'rd', 1), t(1, 'd', 0), t(1, 'd', 182), t(1, 'F', 11), t(1, 'Cd', 60)],
    ['LP.40', 'LP20', 'rd1.4', 'd.000', 'd.750', 'hold', 'Cd60']);
  assert.deepEqual([t(3, 'rd', 0), t(10, 'AE', 0), t(10, 'AE', 10), t(14, '1L', 0), t(13, 'rv', 0), t(7, 'b', 252)],
    ['rd .8', 'AE-5', 'AE 5', '1L-6', 'rv .1', 'b1.25']);
  // the delay time of configurations 9 and 10 follows "dr" (the record keeps the range in RAM for the next one)
  for (const c of [9, 10]) {
    const d = D.findPage(c, 'd');
    assert.equal(d.by, D.findPage(c, 'dr').p);
    assert.deepEqual(d.ts.map((x) => [D.TABLES[x][0], D.TABLES[x][249]]), [['d.000', 'd.249'], ['d.250', 'd.499'], ['d.500', 'd.749']]);
  }
  assert.equal(D.textOf(1, 1, 3), 'LP1.2');
  assert.equal(D.textOf(1, 1, 12), null);
  assert.equal(D.textOf(9, 7, 0, Uint8Array.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'd.000');
});

test('DSP-128 Plus: factory programs, start programs and the first power-up memory', () => {
  assert.equal(D.FACTORY.length, 128);
  assert.equal(D.FIRST.length, D.DUMP_SIZE);
  for (let i = 0; i < 128; i++) assert.deepEqual(D.programFromDump(D.FIRST, i), D.factory(i), `user ${i + 1} = factory ${i + 1}`);
  assert.deepEqual(Array.from(D.FIRST.slice(D.AT.settings)), new Array(51).fill(0), 'channel 1, no controllers');
  D.STARTS.forEach((h, c) => assert.equal(D.start(c)[0], c));
  // every factory and start program value is within its page's range
  for (const d of [...D.FACTORY, ...D.STARTS].map((h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16))))) {
    for (const pg of D.CONFIGS[d[0]].params) assert.ok(d[pg.p] <= pg.max, `${D.CONFIGS[d[0]].name} ${pg.label} ${d[pg.p]}`);
  }
});

test('DSP-128 Plus: messages match what the v2.00 firmware takes and sends', () => {
  assert.deepEqual(D.requestAll(), V.request.msg);
  const all = D.allMessage(D.FIRST);
  assert.equal(all.length, V.request.length);
  assert.deepEqual(all.slice(0, 24), V.request.head);
  assert.deepEqual(all.slice(-7), V.request.tail);
  const back = D.parse(Uint8Array.from(all));
  assert.deepEqual([back.kind, back.complete, back.programs], ['all', true, 128]);
  assert.deepEqual(back.data, D.FIRST);
  // a 41h message cut after program 2 writes programs 1-2 only (the firmware kept the rest)
  const cut = V.cut;
  const d1 = Uint8Array.from(cut.programs[0]);
  const d2 = Uint8Array.from(cut.programs[1]);
  assert.deepEqual(D.writeMessage(d2, 1, 0, Uint8Array.from([...d1, ...D.FIRST.slice(12)])), cut.msg);
  assert.deepEqual(D.writeMessage(d1, 0, 0, null).slice(0, 8), [0xf0, 0, 0, 0x10, 0, 3, 0x41, 0]);
  assert.equal(D.writeMessage(d2, 1, 0, null), null, 'no message that would overwrite program 1 unread');
  const m = D.parse(Uint8Array.from(cut.msg));
  assert.deepEqual([m.complete, m.programs], [false, 2]);
  assert.match(dsp.describe(Uint8Array.from(cut.msg)), /programs 1-2/);
  // simulator against the firmware's vectors
  const sim = dsp.simulate();
  const reply = sim.handle(D.requestAll());
  assert.deepEqual(Array.from(reply[0]), all);
  sim.handle(cut.msg);
  assert.deepEqual(D.programFromDump(sim.state.dump, 1), d2);
  assert.deepEqual(D.programFromDump(sim.state.dump, 2), D.factory(2));
  const mem = Uint8Array.from(D.FIRST);
  D.programIntoDump(mem, 5, Uint8Array.from(V.dump.program6));
  mem[D.AT.channel] = V.dump.channel;
  mem[D.AT.links + 23] = 64;
  sim.handle(D.allMessage(mem));
  sim.handle(V.programChange.msg);
  assert.equal(sim.current, V.programChange.loaded);
  sim.handle(V.otherChannel.msg);
  assert.equal(sim.current, V.otherChannel.loaded);
  sim.handle([0xb4, 64, 127]);
  assert.equal(sim.state.bypass, true);
  // a controller moves the linked page of the current program as the firmware scales it
  const c = V.control;
  const s2 = dsp.simulate();
  s2.state.dump[D.AT.links + c.link] = c.cc;
  s2.handle([0xc0, 5]);
  D.programIntoDump(s2.state.dump, 5, Uint8Array.from(V.dump.program6));
  s2.handle([0xb0, c.cc, c.value]);
  assert.equal(D.programFromDump(s2.state.dump, 5)[1], c.byte1);
  assert.ok(dsp.isRequest(D.requestAll()));
  assert.equal(dsp.recognise(Uint8Array.from(all)), true);
  assert.equal(D.isDsp128([0xf0, 0, 0, 0x10, 0, 0x06, 0x41, 0xf7]), false, 'the DSP-256 (model 06) is not this unit');
});

test('DSP-128 Plus: program editor pages, configuration switch and live sends', () => {
  const d = D.factory(0);
  assert.equal(d[0], 1);
  const names = visible(prog, d).filter((p) => p.group !== 'Bytes (exact)').map((p) => p.label);
  assert.deepEqual(names, ['Configuration', 'LP', 'rL', 'rd', 'dL', 'd', 'F', 'CL', 'Cd', 'SP', 'DE']);
  assert.equal(textOf(prog, 'config', d), 'A  1');
  assert.equal(textOf(prog, 'c1p1', d), 'LP12');
  for (const p of prog.params) {
    const v = view(p, d);
    if (v.hidden || !v.options) continue;
    assert.ok(v.options.some(([x]) => x === readParam(d, v)), `${p.key} value has an option`);
  }
  // switching the configuration loads its start program, as the panel does (E8AF)
  writeParam(d, D.paramOf('config'), 9);
  assert.deepEqual(d, D.start(9));
  assert.equal(textOf(prog, 'c9p7', d), D.TABLES[D.findPage(9, 'd').ts[d[6]]][d[7]]);
  // each change: programs 1..n through a cut 41h message, then a program change; program 1 needs no read
  const u = D._test.unit;
  u.target = 0;
  u.dump = null;
  let out = prog.sendParam(D.paramOf('c9p1'), 3, d, { channel: 2 });
  assert.deepEqual(out, [D.writeMessage(d, 0, 2, null), [0xc2, 0]]);
  u.target = 4;
  assert.deepEqual(prog.sendParam(D.paramOf('c9p1'), 3, d, { channel: 2 }), [], 'programs 1-4 unknown: nothing sent');
  u.dump = Uint8Array.from(D.FIRST);
  out = prog.sendParam(D.paramOf('c9p1'), 3, d, { channel: 2 });
  assert.equal(out[0].length, 8 + 2 * 12 * 5);
  assert.deepEqual(out[1], [0xc2, 4]);
  assert.deepEqual(D.programFromDump(u.dump, 4), d, 'the editor\'s copy of the memory follows');
  u.target = 0;
  u.dump = null;
  // an out-of-range byte is shown as such
  d[1] = 200;
  assert.match(textOf(prog, 'c9p1', d), /outside/);
});

test('DSP-128 Plus: MIDI settings pages', () => {
  const f = Uint8Array.from(D.FIRST);
  assert.equal(textOf(sys, 'channel', f), 'CH 1');
  assert.deepEqual(sys.params.find((p) => p.key === 'channel').options.slice(-2).map(([, t]) => t), ['CH o', 'CH n']);
  const links = sys.params.filter((p) => p.section === 'links' && p.options);
  assert.equal(links.length, 44);
  assert.deepEqual([links[0].label, links[0].options[0][1], links[0].options[7][1], links[0].options[100][1]], ['rd', 'rd n', 'rd 7', 'rdCP']);
  assert.equal(links.find((p) => p.offset === D.AT.links + 23).label, 'bY');
  // every program page's link number has its MIDI page
  for (const c of D.CONFIGS) for (const pg of c.params) assert.ok(links.some((p) => p.offset === D.AT.links + pg.link), `${c.name} ${pg.label} link ${pg.link}`);
  for (const p of sys.params) {
    const v = view(p, f);
    if (v.options) assert.ok(v.options.some(([x]) => x === readParam(f, v)), `${p.key} first power-up value has an option`);
  }
});

test('DSP-128 Plus: library items and translator', () => {
  const items = dsp.libraryItems([Uint8Array.from(D.allMessage(D.FIRST))]);
  assert.equal(items.filter((i) => i.object === 'effect').length, 128);
  assert.equal(items.find((i) => i.object === 'system').data.length, D.DUMP_SIZE);
  const d = D.factory(0);
  const c = prog.toCommon(d);
  assert.ok(c.effects.reverb && c.effects.delay && c.effects.chorus);
  assert.deepEqual(prog.fromCommon(c).data, d);
  const g = prog.fromCommon({ effects: { reverb: { time: 0.5, level: 1 } } });
  assert.ok(D.blocks(g.data[0]).reverb);
  const fl = prog.fromCommon({ effects: { modulation: { type: 'FLANGER', rate: 0.25, depth: 1, level: 1 }, delay: { time: 0.2, feedback: 0.5, level: 1 } } });
  const b = D.blocks(fl.data[0]);
  assert.ok(b.flange && b.delay);
  assert.equal(fl.data[D.findPage(fl.data[0], 'DE').p], D.findPage(fl.data[0], 'DE').max);
  for (const p of prog.params) {
    const v = view(p, fl.data);
    if (!v.hidden && v.options) assert.ok(v.options.some(([x]) => x === readParam(fl.data, v)), `${p.key} translated value has an option`);
  }
});
