// TX81Z own items: frequency display, performance memories and templates, system setup, program
// change table, effects, micro tuning (yamaha-tx81z.js, yamaha-dx4.js). Firmware checks skip when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { parseBulk, dumpRequestHeader } from '../js/devices/defs/yamaha-dx-sysex.js';
import { ratio4, ratio4Text, fixHz, CRS_STEP, RATIOS, FIX_RANGES } from '../js/devices/defs/yamaha-dx4.js';
import tx81z, { packPerf, unpackPerf, PERF_TEMPLATES, PMEM_REC, _test as T } from '../js/devices/defs/yamaha-tx81z.js';
import dx11 from '../js/devices/defs/yamaha-dx11.js';
import dx21 from '../js/devices/defs/yamaha-dx21.js';

const objOf = (def, key) => def.objects.find((o) => o.key === key);
const ROM = 're/dx/fw/tx81z/TX81Z V1.6 03-Feb-88.bin';

test('TX81Z: its own frequency display (A1E0: table B4EA, multipliers A2A8; fix range A494)', (t) => {
  for (let c = 0; c < 64; c++) assert.equal(ratio4(c, 0), RATIOS[c], `CRS ${c} with FIN 0 is the DX21 ratio`);
  assert.deepEqual(Array.from({ length: 16 }, (_, f) => ratio4Text(4, f)), ['1.00', '1.06', '1.12', '1.18', '1.25', '1.31', '1.37', '1.43', '1.50', '1.56', '1.62', '1.68', '1.75', '1.81', '1.87', '1.93']);
  assert.equal(ratio4Text(0, 7), '0.93');
  assert.equal(fixHz(0, 0, 0), 8);
  assert.equal(fixHz(63, 15, 7), 32640);
  assert.equal(fixHz(27, 8, 1), ((24 << 2) + 8) << 1);
  assert.deepEqual(FIX_RANGES, ['255Hz', '510Hz', '1KHz', '2KHz', '4KHz', '8KHz', '16KHz', '32KHz']);
  const v = objOf(tx81z, 'voice');
  const P = (k) => v.params.find((p) => p.key === k);
  const d = v.init();
  const crs = P('op1_crs');
  const fin = P('op1_fin');
  assert.equal(crs.dynamic(d).label, 'CRS(RATIO)');
  writeParam(d, P('op1_fin'), 1);
  assert.equal(crs.dynamic(d).options[4][1], '1.06');
  writeParam(d, P('op1_fix'), 1);
  writeParam(d, P('op1_fixrg'), 2);
  assert.equal(fin.dynamic(d).label, 'FIN(FIX)');
  assert.equal(crs.dynamic(d).options[27][1], `${fixHz(27, 1, 2)}Hz (27)`);
  assert.equal(P('op1_fixrg').options[7][1], '32KHz');
  assert.equal(objOf(dx11, 'voice').params.find((p) => p.key === 'op1_crs').dynamic(d).label, 'CRS(FIX)', 'the DX11 has the same display (its lower bank 3600)');
  assert.equal(objOf(dx21, 'voice').params.find((p) => p.key === 'op1_crs').dynamic(d).options[4][1], '1.00');
  if (!existsSync(ROM)) { t.skip('no TX81Z firmware in re/dx'); return; }
  const rom = new Uint8Array(readFileSync(ROM));
  assert.deepEqual(Array.from(rom.subarray(0x34ea, 0x34ea + 64)), CRS_STEP);
  assert.deepEqual(Array.from(rom.subarray(0x22a8, 0x22ac)), [100, 141, 157, 173]);
});

test('TX81Z: performance memories (PMEM) and the Init templates', (t) => {
  const perf = objOf(tx81z, 'performance');
  for (const tp of PERF_TEMPLATES) assert.deepEqual(packPerf(unpackPerf(tp.record)), tp.record, tp.key);
  const p = perf.init();
  assert.equal(String.fromCharCode(...p.subarray(100, 110)), 'SINGLE    ');
  assert.deepEqual(Array.from(p.subarray(0, 12)), [8, 0, 0, 0, 0, 127, 7, 24, 99, 3, 1, 0]);
  const p2 = Uint8Array.from(p);
  p2.set([3, 1, 12, 5, 30, 90, 9, 30, 80, 2, 3, 1], 12);
  p2.set([7, 1, 2, 9], 96);
  assert.deepEqual(unpackPerf(packPerf(p2)), p2, 'every PCED byte survives the memory packing');
  if (!existsSync(ROM)) { t.skip('no TX81Z firmware in re/dx'); return; }
  const rom = new Uint8Array(readFileSync(ROM));
  for (const [i, tp] of PERF_TEMPLATES.entries()) assert.deepEqual(rom.subarray(0x07a6 + i * PMEM_REC, 0x07a6 + (i + 1) * PMEM_REC), tp.record, `${tp.key} template`);
  assert.deepEqual(rom.subarray(0xaf13, 0xaf13 + PMEM_REC), PERF_TEMPLATES[0].record, 'memories 25-32 of the bulk (upper bank AF13)');
  assert.deepEqual(Array.from(rom.subarray(0x19c9, 0x19c9 + 55)), T.FX_INIT, 'effects at cold start (99C9)');
});

test('TX81Z: memory slots, Branch Library items and the simulator', async () => {
  const perf = objOf(tx81z, 'performance');
  const sim = tx81z.simulate();
  const [pm] = sim.handle(Uint8Array.from(dumpRequestHeader(2, 'LM  8976PM')));
  assert.equal(parseBulk(Uint8Array.from(pm)).body.length, 32 * PMEM_REC);
  const items = tx81z.libraryItems([Uint8Array.from(pm)]);
  assert.equal(items.length, 24);
  assert.equal(items[0].object, 'performance');
  assert.equal(items[0].label, 'PF01 SINGLE');
  const g = { objectData: {}, loadedKeys: new Set() };
  const api = { ctx: { channel: 2, data: g.objectData, loaded: g.loadedKeys }, g, request: async (bytes, match) => sim.handle(Uint8Array.from(bytes)).map((x) => Uint8Array.from(x)).find(match) };
  const p = perf.init();
  assert.deepEqual(await perf.slots.fetch(api, 0, 3), p);
  assert.equal(perf.slots.writable(0, api.ctx), true);
  const p2 = Uint8Array.from(p);
  p2[0] = 4; p2[12] = 4;
  const [st] = perf.slots.store(0, 5, api.ctx, p2);
  assert.equal(parseBulk(Uint8Array.from(st)).header, 'LM  8976PM');
  assert.deepEqual(unpackPerf(parseBulk(Uint8Array.from(st)).body.subarray(5 * PMEM_REC, 6 * PMEM_REC)), p2);
});

test('TX81Z: system, program change table, effects and micro tuning objects', () => {
  const ctx = { channel: 2 };
  const sim = tx81z.simulate();
  const sys = objOf(tx81z, 'system');
  const s = sys.init();
  assert.equal(sys.name(s), '<Good morning!!>');
  const S = (l) => sys.params.find((x) => x.label === l);
  assert.equal(readParam(s, S('Mem Protect')), 0, 'kept off');
  assert.equal(S('Basic Rcv.Ch').options[16][1], 'omn');
  assert.equal(S('Cont.Change').options[17][1], 'G16');
  assert.equal(S('Master Tune').format(64), '0');
  assert.deepEqual(sys.sendParam(S('Exclusive'), 1, s, ctx), [0xf0, 0x43, 0x12, 0x10, 0x7b, 7, 1, 0xf7]);
  const pc = objOf(tx81z, 'pctable');
  const c = pc.init();
  const pg = pc.params[9];
  writeParam(c, pg, 0xa0 + 3);
  assert.equal(readParam(c, pg), 163);
  assert.equal(pg.options[163][1], 'PF04');
  assert.deepEqual(pc.sendParam(pg, 163, c, ctx), [0xf0, 0x43, 0x12, 0x10, 0x7f, 9, 1, 0x23, 0xf7]);
  const fx = objOf(tx81z, 'effects');
  const e = fx.init();
  const E = (k) => fx.params.find((x) => x.key === k);
  assert.equal(E('e0').format(e[0]), '0.09s');
  assert.equal(E('e7').options[24][1], 'C3');
  assert.equal(E('e7').options[49][1], '*');
  assert.equal(E('e11').options[24][1], 'C#3');
  assert.deepEqual(fx.sendParam(E('e3'), 73, e, ctx), [0xf0, 0x43, 0x12, 0x10, 0x7c, 3, 73, 0xf7]);
  const mo = objOf(tx81z, 'microtune-oct');
  const mf = objOf(tx81z, 'microtune-full');
  const eqo = mo.toCommon(mo.init());
  assert.deepEqual(eqo.cents.slice(13, 109), Array.from({ length: 96 }, (_, i) => (i + 13) * 100));
  assert.deepEqual(mf.toCommon(mf.init()).cents.slice(13, 109), eqo.cents.slice(13, 109));
  const tuned = mf.init();
  tuned[2 * 64] = 64; tuned[2 * 64 + 1] = 32;
  assert.deepEqual(mf.fromCommon(mf.toCommon(tuned)).data, tuned);
  const x = mf.fromCommon({ ...mf.toCommon(tuned), extra: {} }).data;
  assert.deepEqual([x[128], x[129]], [64, 32], 'from cents: 6450 = E3 + 32/64');
  assert.deepEqual(mo.sendParam(mo.params[1], 0, mo.init(), ctx), [0xf0, 0x43, 0x12, 0x10, 0x7d, 0, 60, 0, 0xf7]);
  for (const o of [sys, pc, fx, mo, mf]) {
    const m = Uint8Array.from(o.toSyx(o.init(), ctx));
    assert.equal(o.match(m), true);
    assert.equal(tx81z.recognise(m), true);
    assert.equal(tx81z.libraryItems([m])[0].object, o.key);
    const [back] = sim.handle(Uint8Array.from(o.request(ctx)));
    assert.equal(o.match(Uint8Array.from(back)), true, `${o.key} answered by the simulator`);
    const seen = new Uint8Array(o.size);
    for (const q of o.params) for (let i = 0; i < (q.size || 1); i++) seen[q.offset + i]++;
    assert.ok(seen.every((n) => n === 1), `${o.key}: every byte once`);
  }
  assert.match(tx81z.describe(Uint8Array.from(T.longChange(0, 0x7b, 8, 0))), /system change 8 0/);
  assert.equal(objOf(dx11, 'system'), undefined, 'the DX11 keeps these as data (not checked against its firmware)');
});
