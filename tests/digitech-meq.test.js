import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import meq, * as M from '../js/devices/defs/digitech-meq.js';

const V = JSON.parse(fs.readFileSync(new URL('./digitech-meq.vectors.json', import.meta.url), 'utf8'));
const prog = meq.objects.find((o) => o.key === 'effect');
const sys = meq.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (o, d) => o.params.filter((p) => !(p.hidden || view(p, d).hidden));
const textOf = (o, key, d) => { const p = view(o.params.find((x) => x.key === key), d); const v = readParam(d, p); return p.options ? p.options.find(([x]) => x === v)?.[1] : String(v); };
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const u = M._test.unit;
const withModel = (m, fn) => { const k = u.model; u.model = m; try { return fn(); } finally { u.model = k; } };

test('MEQ: the three models from the firmware, the manual\'s band layout matches its column map', () => {
  assert.deepEqual(M.MODELS.map((x) => [x.name, x.byte, x.boot.trim(), x.sections, x.bootError]), [['MEQ 28', 7, '28', 1, 'E1'], ['MEQ 14', 8, '14', 2, 'E1'], ['MEQ 7', 9, '7', 4, 'E1']]);
  assert.deepEqual(M.MODELS.map((x) => x.masks), [[0x0f], [0x0c, 0x03], [8, 4, 2, 1]]);
  for (let m = 0; m < 3; m++) {
    const used = M.MODELS[m].columns.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
    assert.deepEqual(M.bandsOf(m).map((b) => b.col).sort((a, b) => a - b), used, `${M.MODELS[m].name}: the bands are the columns with a filter`);
    assert.equal(M.bandsOf(m).length, 28);
  }
  assert.equal(M.bandLabel(0, M.bandsOf(0)[0]), '31.5 Hz');
  assert.equal(M.bandLabel(1, M.bandsOf(1)[14]), 'Ch2 40 Hz');
  assert.equal(M.bandLabel(2, M.bandsOf(2)[27]), 'Ch4 16 kHz');
  // program change loads per channel set (bit i = channel i + 1)
  assert.deepEqual(M.MODELS[1].loads['1'], [...Array.from({ length: 14 }, (_, i) => i + 1), 31]);
  assert.deepEqual(M.MODELS[1].loads['2'], [...Array.from({ length: 14 }, (_, i) => i + 16), 32]);
  assert.equal(M.MODELS[1].loads['3'].length, 33);
  assert.equal(Object.keys(M.MODELS[2].loads).length, 15);
  assert.equal(M.MODELS[0].loads['1'].length, 32);
});

test('MEQ: display texts from the firmware', () => {
  const T = M.TEXTS;
  assert.deepEqual([T.program[0], T.program[8], T.program[98]], ['1', '9', '99']);
  assert.deepEqual(T.level, ['-14', '-12', '-10', '-8', '-6', '-4', '-2', '0', '2', '4', '6', '8', '10', '12', '14', '16']);
  assert.deepEqual([T.channel[0], T.channel[1], T.channel[16], T.channel[17]], ['--', ' 1', '16', 'oi']);
  assert.deepEqual([T.link[0], T.link[7], T.link[99]], ['--', ' 7', '99']);
  assert.deepEqual([T.bypassLink[0], T.bypassLink[5], T.bypassLink[42]], ['-.-', ' .5', '4.2']);
  assert.deepEqual([T.dump[0], T.dump[1], T.dump[99]], ['≡≡', ' 1', '99']);
  assert.deepEqual(T.led[0], [1]);
  assert.deepEqual(T.led[12], [7]);
  assert.deepEqual(T.led[13], [8, 7]);
  assert.deepEqual(T.led[24], [13]);
  for (let v = 0; v < 25; v++) assert.equal(T.ledSelected[v].length + T.led[v].length, 13, 'a selected band shows its column inverted');
  assert.deepEqual([M.bandText(0), M.bandText(12), M.bandText(17)], ['-12 dB (LED 1)', '0 dB (LED 7)', '+5 dB (LEDs 9+10)']);
});

test('MEQ: first power-up memory and factory programs', () => {
  for (let m = 0; m < 3; m++) {
    const f = M.first(m);
    assert.equal(f.length, M.DUMP_SIZE);
    assert.equal(f[M.AT.program], 0);
    for (let s = 0; s < M.MODELS[m].sections; s++) assert.equal(f[M.AT.channels + s], 17, 'every channel');
    assert.deepEqual(Array.from(f.slice(M.AT.bandLinks, M.AT.lock + 1)), new Array(37).fill(0), 'no controllers, no lock');
    for (let i = 0; i < 10; i++) assert.deepEqual(M.programFromDump(f, i), M.factory(i, m));
    assert.deepEqual(Array.from(M.programFromDump(f, 50)), [...new Array(31).fill(12), 7, 7, 7, 7], 'flat programs 11-99');
  }
  assert.deepEqual(M.MODELS[0].factory, M.MODELS[1].factory, 'the MEQ 28 and MEQ 14 share their factory programs');
  assert.notDeepEqual(M.MODELS[2].factory, M.MODELS[1].factory);
});

test('MEQ: messages match what the v1.06 firmware takes and sends (MEQ 14)', () => withModel(1, () => {
  const before = hex(V.dumpBefore);
  assert.deepEqual(M.requestAll(0), V.request.msg);
  const all = M.allMessage(before, 0);
  assert.equal(Buffer.from(all).toString('hex'), V.request.reply);
  assert.equal(V.requestOmni.reply, '', 'no answer while channel 1 receives every channel');
  // 42h stores; the edit buffer and the program loaded stay
  const p = V.program;
  const d = hex(p.stored);
  assert.deepEqual(M.programMessage(6, d, 1), p.msg);
  assert.deepEqual([p.edit, p.current], [p.editBefore, 0]);
  const back = M.parse(Uint8Array.from(p.msg));
  assert.deepEqual([back.kind, back.n, Array.from(back.data)], ['program', 6, Array.from(d)]);
  // the simulator against the firmware
  const sim = meq.simulate();
  sim.state.dump.set(before);
  assert.deepEqual(Array.from(sim.handle(M.requestAll(0))[0]), all);
  sim.handle(p.msg);
  assert.deepEqual(M.programFromDump(sim.state.dump, 6), d);
  sim.state.edit.set(hex(p.edit));
  sim.handle(V.pcSection2.msg);
  assert.equal(Buffer.from(sim.state.edit).toString('hex'), V.pcSection2.edit);
  sim.handle(V.pcSection1.msg);
  assert.equal(Buffer.from(sim.state.edit).toString('hex'), V.pcSection1.edit);
  sim.handle(V.pcOther.msg);
  assert.equal(sim.current, V.pcOther.current);
  sim.handle(V.pcRange.msg);
  assert.equal(sim.current, V.pcRange.current, 'program change 99 and above is ignored');
  const c = V.control;
  sim.state.dump[M.AT.bandLinks + c.band] = c.cc;
  sim.state.dump[M.AT.bandLinks + c.level] = c.levelCc;
  for (const [val, band, level] of c.values) {
    sim.handle([0xb0, c.cc, val]);
    sim.handle([0xb1, c.levelCc, val]);
    assert.deepEqual([sim.state.edit[c.band], sim.state.edit[c.level]], [band, level], `controller value ${val}`);
  }
  const keep = M.programFromDump(sim.state.dump, 0);
  sim.handle(V.wrongModel.msg);
  assert.ok(V.wrongModel.unchanged);
  assert.deepEqual(M.programFromDump(sim.state.dump, 0), keep);
  // 41h: the memory, the unit loads byte 0's program and restarts
  const a = V.all;
  assert.equal(a.after, a.mem);
  sim.handle(M.allMessage(hex(a.mem), 0));
  assert.equal(sim.current, a.current);
  assert.equal(Buffer.from(sim.state.edit.slice(0, 33)).toString('hex'), a.edit.slice(0, 66));
  assert.equal(a.shown.trim(), M.TEXTS.program[a.current]);
  assert.match(V.request01, /illegal opcode 42 at 0042/);
  assert.match(meq.describe(Uint8Array.from([0xf0, 0, 0, 0x10, 0, 8, 1, 0, 5, 0xf7])), /restarts/);
  assert.equal(M.isMeq([0xf0, 0, 0, 0x10, 0, 0x03, 0x41, 0xf7]), false, 'the DSP-128 Plus (model 03) is not this unit');
  assert.ok(meq.isRequest(M.requestAll()));
}));

test('MEQ: program editor per model and live sends', () => {
  const names = (m) => withModel(m, () => visible(prog, M.factory(0)).filter((p) => p.group !== 'Bytes (exact)').map((p) => `${p.group}/${p.label}`));
  assert.equal(names(0).length, 29);
  assert.deepEqual(names(0).slice(0, 2), ['Bands/31.5 Hz', 'Bands/40 Hz']);
  assert.equal(names(1).length, 30);
  assert.ok(names(1).includes('Channel 2/Ch2 Level'));
  assert.equal(names(2).length, 32);
  withModel(1, () => {
    const d = M.factory(0);
    assert.equal(textOf(prog, 'm1b1', d), M.bandText(d[1]));
    assert.equal(textOf(prog, 'm1l0', d), '0');
    for (const p of prog.params) {
      const v = view(p, d);
      if (!v.hidden && v.options) assert.ok(v.options.some(([x]) => x === readParam(d, v)), `${p.key} value has an option`);
    }
    assert.match(view(M.paramOf('byte0'), d).label, /unused on the MEQ 14/);
    // each change: 42h into the target program, then program changes on the channels the unit receives on
    u.target = 4;
    u.dump = null;
    writeParam(d, M.paramOf('m1b3'), 20);
    let out = prog.sendParam(M.paramOf('m1b3'), 20, d, { channel: 2 });
    assert.deepEqual(out, [M.programMessage(4, d, 2), [0xc2, 4]]);
    u.dump = M.first(1);
    u.dump[M.AT.channels] = 1;
    u.dump[M.AT.channels + 1] = 5;
    out = prog.sendParam(M.paramOf('m1b3'), 20, d, { channel: 2 });
    assert.deepEqual(out.slice(1), [[0xc0, 4], [0xc4, 4]]);
    assert.deepEqual(M.programFromDump(u.dump, 4), d, 'the editor\'s copy of the memory follows');
    u.dump[M.AT.channels + 1] = 17;
    assert.deepEqual(prog.sendParam(M.paramOf('m1b3'), 20, d, { channel: 2 }).slice(1), [[0xc0, 4], [0xc2, 4]]);
    u.dump = null;
    u.target = 0;
    d[3] = 40;
    assert.match(textOf(prog, 'm1b3', d), /above 24/);
  });
});

test('MEQ: settings pages', () => withModel(2, () => {
  const f = M.first(2);
  assert.equal(textOf(sys, 'channel0', f), 'oi (every channel)');
  assert.equal(textOf(sys, 'lock', f), 'Off');
  const shown = visible(sys, f);
  assert.equal(shown.filter((p) => p.key.startsWith('channel')).length, 4);
  assert.equal(shown.filter((p) => /^m2link/.test(p.key)).length, 28);
  assert.equal(shown.filter((p) => /^m2xlink/.test(p.key)).length, 3);
  for (const p of sys.params) {
    const v = view(p, f);
    if (!v.hidden && v.options) assert.ok(v.options.some(([x]) => x === readParam(f, v)), `${p.key} first power-up value has an option`);
  }
  const covered = new Set();
  for (const p of shown) covered.add(p.offset);
  for (let i = 0; i < M.AT.programs; i++) assert.ok(covered.has(i), `settings byte ${i} shown`);
  f[M.AT.lock] = 0xa5;
  assert.match(sys.warning({ data: { system: f } }), /full lockout/);
}));

test('MEQ: library items and translator', () => withModel(1, () => {
  const items = meq.libraryItems([Uint8Array.from(M.allMessage(M.first(1)))]);
  assert.equal(items.filter((i) => i.object === 'effect').length, 99);
  assert.equal(items.find((i) => i.object === 'system').data.length, M.DUMP_SIZE);
  const d = M.factory(3);
  const c = prog.toCommon(d);
  assert.equal(c.effects.eq.sections.length, 2);
  assert.equal(c.effects.eq.bands[0].hz, 40);
  assert.deepEqual(prog.fromCommon(c).data, d);
  // into the MEQ 28: every band from the nearest MEQ 14 band of channel 1
  const r = withModel(0, () => prog.fromCommon(c, M.factory(0, 0)));
  const b28 = M.bandsOf(0);
  const at = (h) => r.data[b28.find((b) => b.hz === h).col];
  assert.equal(at(40), d[1]);
  assert.equal(at(16000), d[14]);
  assert.equal(at(1000), d[8]);
  assert.ok(r.report.approximated.length);
  // and a generic EQ with a few bands
  const g = prog.fromCommon({ effects: { eq: { bands: [{ hz: 100, gain: -6 }, { hz: 4000, gain: 30 }] } } });
  assert.equal(g.data[3], 6);
  assert.equal(g.data[11], 24);
  assert.equal(g.data[16 + 2], 6, 'channel 2 takes the same bands');
}));
