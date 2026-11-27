import { test } from 'node:test';
import assert from 'node:assert/strict';

import nova, * as NV from '../js/devices/defs/novation-nova.js';
import sn1 from '../js/devices/defs/novation-supernova.js';
import nova2, { _test as N2 } from '../js/devices/defs/novation-nova2.js';
import * as SN2 from '../js/devices/defs/novation-supernova2.js';
import { readParam, writeParam } from '../js/core/model/memmap.js';

const obj = (def, k) => def.objects.find((o) => o.key === k);
const param = (def, o, label, section) => obj(def, o).params.find((p) => p.label === label && (!section || p.section === section));

test('Nova: model 21, the performance carries the vocoder block (1B / 1C), 6 parts', () => {
  const ctx = { deviceId: 0x7f };
  const perf = obj(nova, 'performance');
  assert.equal(perf.size, 388);
  assert.deepEqual(NV.msg.performance(ctx, perf.init()).map((m) => [m[5], m[7], m.length]), [[0x21, 0x05, 381], [0x21, 0x1b, 25]]);
  assert.deepEqual(NV.msg.storePerformance(ctx, 1, 3, perf.init()).map((m) => [m[7], m[8], m[9], m.length]), [[0x07, 1, 3, 383], [0x1c, 1, 3, 27]]);
  assert.equal(perf.multi.count, 6);
  assert.ok(param(nova, 'performance', 'Program', 'part6').readOnly, 'parts 7-8: not on a Nova');
  const back = perf.fromSyx(NV.msg.performance(ctx, perf.init()));
  assert.deepEqual(Array.from(back), Array.from(perf.init()));
  // vocoder settings (Nova menus 18-25 / 28-33)
  const vin = param(nova, 'performance', 'Voc input');
  assert.equal(vin.offset, 372 + 1);
  assert.deepEqual(vin.options.map((o) => o[0]), [18, 19, 20, 21, 22, 23, 24, 25]);
  assert.deepEqual(param(nova, 'performance', 'Voc insert').options.map((o) => o[1]), ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6']);
  // Expression pedal: part byte 10 bit 5 (setter B492)
  const d = perf.init();
  writeParam(d, param(nova, 'performance', 'Expression pedal', 'part2'), 1);
  assert.equal(d[20 + 44 * 2 + 10] & 0x20, 0x20);
});

test('Nova: OS 4.1 global settings of its own (message 15 bytes 12, 13, 24, 25)', () => {
  const g = obj(nova, 'global');
  const d = g.init();
  assert.equal(readParam(d, param(nova, 'global', 'Pedal mode')), 11, '0Bh = Off');
  assert.equal(readParam(d, param(nova, 'global', 'Headphones out')), 95, '5Fh = Mix');
  assert.equal(param(nova, 'global', 'Trim1').offset, 272 + 24);
  assert.equal(readParam(d, param(nova, 'global', 'Trim1')), 0, '40h = 0');
  assert.ok(!param(sn1, 'global', 'Pedal mode'), 'the SuperNova has none');
  assert.ok(param(nova, 'program', 'Constant gate'));
  assert.ok(!param(sn1, 'program', 'Constant gate'));
  assert.deepEqual(obj(nova, 'program').slots.banks.map((b) => b[0]), [5, 6]);
  assert.deepEqual(obj(nova, 'performance').slots.banks.map((b) => b[0]), [1]);
});

test('Nova: the same OS 4.1 program format as the SuperNova (exact copy between them)', () => {
  const p = obj(nova, 'program').init();
  p[210] = 77; p[17] = 19;
  const c = obj(nova, 'program').toCommon(p);
  assert.equal(c.extra.model, 'novation-nova');
  assert.deepEqual(Array.from(obj(sn1, 'program').fromCommon(c, obj(sn1, 'program').init()).data), Array.from(p));
  const r = obj({ objects: SN2.default.objects }, 'program').fromCommon(c, SN2.initProgram());
  assert.equal(r.data[210], (77 >> 2) + 16, 'a SuperNova II converts Nova programs too (1DE84)');
});

test('Nova II: the SuperNova II definition with model 23 and the Nova II menus', () => {
  const ctx = { deviceId: 0x7f, entry: { id: 'novation-nova2' } };
  const prog = obj(nova2, 'program');
  assert.deepEqual(SN2.msg.program(ctx, prog.init()).map((m) => [m[5], m.length]), [[0x23, 296], [0x23, 98]]);
  assert.deepEqual(SN2.msg.program({ deviceId: 0x7f, entry: { id: 'novation-supernova2' } }, prog.init()).map((m) => m[5]).filter((x) => x === 0x23), [], 'the SuperNova II keeps 22/24');
  assert.ok(SN2.isSN2([0xf0, 0, 0x20, 0x29, 1, 0x23, 0x7f, 0x00, 0xf7]));
  assert.equal(nova2.sysex.model, 0x23);
  assert.deepEqual(prog.slots.banks.map((b) => b[0]), [5, 6, 7, 8, 18, 19, 20, 21]);
  assert.deepEqual(obj(nova2, 'performance').slots.banks.map((b) => b[0]), [1, 2]);
  assert.deepEqual(obj(nova2, 'pattern').slots.banks.map((b) => b[0]), [15, 16]);
  assert.equal(obj(nova2, 'performance').multi.count, 6);
  assert.ok(!obj(nova2, 'global').params.some((p) => p.group === 'Digital I/O option'), 'no option card handlers (NRPN 122 MSB 49-57)');
  assert.deepEqual(param(nova2, 'program', 'Pattern bank').options.map((o) => o[1]), ['Mono', 'Poly', 'User(U)', 'User(V)']);
  assert.deepEqual(param(nova2, 'program', 'Unison mode').options.map((o) => o[1]), ['2 voice', '3 voice', '4 voice', '5 voice', '6 voice']);
  assert.deepEqual(param(nova2, 'performance', 'Part outputs', 'part0').options.map((o) => o[1]), ['1 & 2', '3 & 4', '5 & 6']);
  assert.ok(!obj(nova2, 'performance').target, 'no Rack/Keyboard choice');
  assert.ok(N2.objects.every((o) => o.params.every((p) => !p.options || !p.options.some(([, n]) => N2.MISSING.test(String(n))))));
  // the SuperNova II's own lists are untouched
  assert.equal(SN2.programParams.find((p) => p.label === 'Unison mode').options.length, 7);
});

test('OS 4.1 arpeggio patterns (SuperNova II format, bank U) and the Nova message 1D', () => {
  const ctx = { deviceId: 0x7f, channel: 15 };
  for (const def of [nova, sn1]) {
    const pat = obj(def, 'pattern');
    const m = pat.toSyx(pat.init(), ctx)[0];
    assert.deepEqual([m[5], m[7], m.length], [def.sysex.model, 0x0a, 204]);
    assert.deepEqual(Array.from(pat.fromSyx([m])), Array.from(pat.init()));
    assert.deepEqual(pat.slots.banks.map((b) => b[0]), [15]);
    assert.deepEqual(pat.slots.store(15, 70, ctx, pat.init()).slice(7, 9), [0x0c, 70]);
    assert.ok(pat.groupInfo.Steps.pattern, 'the generic step grid model');
  }
  assert.deepEqual(NV.msg.copyBanks(ctx), [[0xbf, 99, 127], [0xf0, 0, 0x20, 0x29, 1, 0x21, 0x7f, 0x1d, 0x7f, 0xf7]]);
  assert.ok(obj(nova, 'global').actions.some((a) => /1D/.test(a.label)));
  assert.ok(!obj(sn1, 'global').actions.some((a) => /1D/.test(a.label)));
});

test('Nova II: 6 External Parts; SuperNova II: program polyphony and no typed spare bytes', () => {
  const perf = obj(nova2, 'performance');
  assert.ok(perf.params.filter((p) => /^Ext [78] /.test(p.label)).every((p) => p.readOnly));
  assert.ok(perf.params.filter((p) => /^Ext [1-6] /.test(p.label)).some((p) => !p.readOnly));
  const poly = SN2.programParams.find((p) => p.label === 'Polyphony');
  assert.deepEqual([poly.offset, poly.bits, poly.options.map((o) => o[0])], [238, 2, [1, 2]]);
  for (const list of [SN2.programParams, SN2.performanceParams]) assert.ok(!list.some((p) => p.group === 'Spare bytes'));
  assert.ok(SN2.programParams.filter((p) => p.group === 'Reserved' && p.offset >= 286 + 9 && p.offset <= 286 + 12).every((p) => p.readOnly && /new program/.test(p.help)));
});
