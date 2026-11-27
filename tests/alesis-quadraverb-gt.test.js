import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeParam, readParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import gt, * as G from '../js/devices/defs/alesis-quadraverb-gt.js';
import qv, * as Q from '../js/devices/defs/alesis-quadraverb.js';

const eff = gt.objects.find((o) => o.key === 'effect');
const glob = gt.objects.find((o) => o.key === 'global');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const param = (label, d) => eff.params.find((p) => !view(p, d).hidden && view(p, d).label === label);

test('Quadraverb GT: v1.03 tables (configurations, preamp packing, factory programs)', () => {
  assert.equal(G.FIRMWARE, 'Quadraverb GT v1.03');
  assert.equal(G.CONFIGS.length, 8);
  assert.equal(G.PRESETS.length, 90);
  assert.deepEqual(G.SPARE, []);
  // 1476: COMPRESSION 7C bits 6-4, DISTORTION 7C bits 3-0, EQ MODE 7C bit 7, OVERDRIVE 7E bits 7-5,
  // NOISE GATE 7E bits 4-0, DIRECT LEVEL 45 bits 7-1, EQ PRESET 1C bits 7-1
  assert.deepEqual(G.PACK[0xa8], [0x7c, 4, 3]);
  assert.deepEqual(G.PACK[0xa9], [0x7c, 0, 4]);
  assert.deepEqual(G.PACK[0xaf], [0x7c, 7, 1]);
  assert.deepEqual(G.PACK[0xad], [0x7e, 5, 3]);
  assert.deepEqual(G.PACK[0xae], [0x7e, 0, 5]);
  assert.deepEqual(G.PACK[0xb1], [0x45, 1, 7]);
  assert.deepEqual(G.PACK[0xb2], [0x1c, 1, 7]);
  assert.deepEqual(G.INDEXED[0xff], [0x4a, 0x78, 0x79, 0xc8, 0xc9]);
  const d = G.presetData(0);
  assert.equal(G.nameOf(d), 'GUITARBYALESIS');
  const ng = view(param('NOISE GATE', d), d);
  assert.deepEqual([ng.offset, ng.shift, ng.bits], [0x7e, 0, 5]);
  assert.deepEqual([0, 1, 17].map((v) => ng.options.find(([k]) => k === v)[1]), ['AUTO', 'OFF', '16']);
  // PREAMP SIGNAL keeps only bit 0 of byte 45 (DIRECT LEVEL is in bits 7-1)
  const ps = param('PREAMP SIGNAL', d);
  assert.deepEqual([ps.offset, ps.shift, ps.bits], [0x45, 0, 1]);
  const x = Uint8Array.from(d);
  writeParam(x, param('DIRECT LEVEL', d), 77);
  assert.equal(x[0x45] >> 1, 77);
  assert.equal(readParam(x, ps), d[0x45] & 1);
  // factory programs within their pages' ranges, except four the unit stores as they are
  for (let n = 0; n < 90; n++) {
    const p = G.presetData(n);
    assert.equal(G.fitProgram(Uint8Array.from(p)), [5, 62, 68, 72].includes(n) ? 1 : 0, `Alesis program ${n}`);
  }
  for (const ds of G.DESCS) for (const v of [ds.min, ds.max]) assert.ok(G.formatValue(ds, v) && !/\?/.test(G.formatValue(ds, v)), `${ds.at} ${v}`);
});

test('Quadraverb GT: EQ MODE switches the EQ pages; the 5 resonators of 5BAND EQ', () => {
  const d = G.presetData(0);
  d[0x44] = 3; // 5BAND EQ→PCH→DLY
  d[0x7c] &= 0x7f; // EQ MODE 5 BAND EQ
  assert.ok(param('LOW MID EQ FREQ', d));
  assert.equal(param('RESONATOR 1 TUNE', d), undefined);
  const mode = param('EQ MODE', d);
  // the unit loads the mode's defaults (9E98): the editor writes the same and sends the whole program
  const out = mode.send(1, {}, Uint8Array.from(d));
  assert.equal(out[5], 0x02);
  const x = Uint8Array.from(d);
  writeParam(x, mode, 1);
  mode.send(1, {}, x);
  assert.deepEqual([x[0x0e], x[0x0f], x[0x16], x[0x17]], [24, 50, 32, 50]);
  for (let n = 1; n <= 5; n++) assert.ok(param(`RESONATOR ${n} AMP`, x), `resonator ${n}`);
  const r5 = param('RESONATOR 5 AMP', x);
  assert.deepEqual([r5.offset, r5.shift, r5.bits], [0x28, 1, 7]); // work byte C9h, kept in 28h bits 7-1
  const msgs = r5.send(40, {}, x);
  assert.equal(msgs.length, 2); // RESONATOR NUMB 5, then the value
  assert.deepEqual(msgs[0].slice(5, 9), [0x01, 4, G.pageList(x, 4).findIndex((id) => G.DESCS[id].off === 0x69), G.valueBytes(4)[0]]);
});

test('Quadraverb GT against its simulator: preamp page edits land in the packed bytes', async () => {
  const t = new LoopbackTransport({ id: 'alesis-quadraverb-gt', model: 'Quadraverb GT', sysex: '00 00 0E' }, gt);
  const c = new DeviceClient(t, { minGap: 1, timeout: 1500 });
  const ctx = { channel: 0 };
  const d = G.presetData(10);
  await c.send(Uint8Array.from(eff.sendAll.build(d, ctx)));
  for (const [label, v] of [['OVERDRIVE', 5], ['NOISE GATE', 9], ['CAB SIMULATOR', 2], ['DIRECT LEVEL', 61]]) {
    const p = param(label, d);
    writeParam(d, p, v);
    const out = p.send(v, ctx, d);
    assert.equal(out[4], 0x07);
    await c.send(Uint8Array.from(out));
  }
  await c.drain();
  const back = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.deepEqual(Array.from(back), Array.from(d));
  // the global cab simulator: page 6 edits 8591 while page 5 is GLOBAL
  const g = glob.init();
  const src = glob.params.find((p) => p.key === 'cabsrc');
  const cab = glob.params.find((p) => p.key === 'cabglobal');
  g[cab.offset] = 1;
  for (const m of src.send(1, ctx, g)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.deepEqual([t.sim.state.midi[0x90], t.sim.state.midi[0x91]], [1, 1]);
  assert.equal(t.sim.state.edit[0x7d] & 3, 2); // the program's own cabinet is untouched
  assert.deepEqual(cab.options.map(([, l]) => l), ['OFF', 'CABINET 1', 'CABINET 2']);
  c.dispose();
});

test('Quadraverb GT programs through the shared model; Quadraverb programs converted as the GT does', () => {
  const d = G.presetData(62);
  const common = eff.toCommon(d);
  assert.equal(common.extra.family, 'alesis-quadraverb-gt');
  assert.equal(common.effects.distortion?.type, 'OVERDRIVE');
  assert.deepEqual(Array.from(eff.fromCommon(common, null).data), Array.from(d));
  // B92D: preamp cleared, NOISE GATE OFF, PREAMP OUT 99; a PRE-EQ direct signal becomes DIRECT LEVEL
  const qeff = qv.objects.find((o) => o.key === 'effect');
  const q = Q.presetData(0);
  q[0x45] = 0; q[0x46] = 70;
  const r = eff.fromCommon(qeff.toCommon(q), null);
  assert.deepEqual([r.data[0x7c], r.data[0x7d], r.data[0x7e], r.data[0x7f], r.data[0x45], r.data[0x46]], [0, 0, 1, 99, 140, 0]);
  assert.equal(readParam(r.data, param('DIRECT LEVEL', r.data)), 70);
  assert.deepEqual(Array.from(r.data.slice(0, 0x45)), Array.from(q.slice(0, 0x45)));
  // GT and Quadraverb dumps do not mix up
  assert.equal(qv.recognise(G.msg.edit(d)), false);
  assert.equal(gt.recognise(Q.msg.edit(q)), false);
});
