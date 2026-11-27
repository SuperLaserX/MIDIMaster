import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import qv, * as Q from '../js/devices/defs/alesis-quadraverb.js';

const eff = qv.objects.find((o) => o.key === 'effect');
const glob = qv.objects.find((o) => o.key === 'global');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const param = (key) => eff.params.find((p) => p.key === key);

test('Quadraverb: configurations, pages and LCD texts from the v1.07 tables', () => {
  assert.equal(Q.CONFIGS.length, 5);
  assert.equal(Q.CONFIGS[0], 'EQ→PCH→DL→REVERB');
  assert.equal(Q.PRESETS.length, 90);
  assert.equal(Q.nameOf(Q.presetData(0)), 'EQ+CRS+DLY+RVB');
  const d = Q.presetData(0);
  assert.equal(d[0x44], 0);
  // reverb decay: function 1, page 7 of a plate in configuration 1
  d[0x32] = 0;
  const at = Q.locate(d, 0x39, 1);
  assert.deepEqual([at.func, at.page, at.desc.label], [1, 6, 'REVERB DECAY']);
  assert.equal(Q.formatValue(at.desc, 50), '50');
  // reverse reverb: the same byte is REVERB REVERSE TIME and the gate pages go
  d[0x32] = 4;
  assert.equal(Q.locate(d, 0x39, 1).desc.label, 'REVERB REVERSE TIME');
  assert.equal(Q.locate(d, 0x3e, 1), null);
  // 16-bit pages and their texts
  const lo = Q.locate(d, 0x00, 2).desc;
  assert.deepEqual([lo.label, Q.formatValue(lo, 20), Q.formatValue(lo, 999)], ['LOW EQ FREQUENCY', '020Hz', '999Hz']);
  const amp = Q.locate(d, 0x02, 2).desc;
  assert.deepEqual([Q.formatValue(amp, 0), Q.formatValue(amp, 560)], ['-14.00dB', '+14.00dB']);
  const hi = Q.locate(d, 0x09, 2).desc;
  assert.deepEqual([Q.formatValue(hi, 2000), Q.formatValue(hi, 18000)], ['02000Hz', '18000Hz']);
  const time = Q.locate(d, 0x2a, 2).desc;
  assert.equal(Q.formatValue(time, 1), '001 milliseconds');
  // graphic EQ configuration: bytes 01-0B are the eleven bands, byte 00 is on no page
  d[0x44] = 2;
  assert.equal(Q.locate(d, 0x00, 2), null);
  assert.match(Q.locate(d, 0x01, 1).desc.label, /16Hz/);
  assert.equal(Q.pageList(d, 1), null, 'no reverb in GEQ→DELAY');
  // every page of every configuration and variant has a label and a text for every value
  for (const ds of Q.DESCS) {
    assert.ok(ds.label, `label ${ds.at}`);
    for (const v of [ds.min, ds.max, (ds.min + ds.max) >> 1]) assert.ok(Q.formatValue(ds, v) && !/\?/.test(Q.formatValue(ds, v)), `${ds.at} ${v}`);
  }
});

test('Quadraverb: 7-bit packing, page edit values and the factory programs', () => {
  const d = Uint8Array.from({ length: 128 }, (_, i) => (i * 37 + 11) & 0xff);
  const p = Q.pack(d);
  assert.equal(p.length, Q.PACKED);
  assert.ok(p.every((b) => b < 128));
  assert.deepEqual(Array.from(Q.unpack(p, 0)), Array.from(d));
  assert.deepEqual(Q.pack(new Uint8Array(128).fill(0xff)).slice(0, 3), [0x7f, 0x7f, 0x7f]);
  for (const v of [0, 1, 99, 127, 128, 255, 256, 999, 1500, 18000, 0xffff]) assert.equal(Q.valueOf(...Q.valueBytes(v)), v);
  assert.deepEqual(Q.valueBytes(50), [25, 0, 0]);
  assert.deepEqual(Q.msg.param(1, 6, 50), [0xf0, 0, 0, 0x0e, 0x02, 0x01, 1, 6, 25, 0, 0, 0xf7]);
  assert.equal(Q.msg.edit(d).length, 8 + Q.PACKED);
  for (let n = 0; n < 90; n++) {
    const x = Q.presetData(n);
    assert.equal(Q.fitProgram(Uint8Array.from(x)), 0, `Alesis program ${n} fits its pages`);
    for (const b of Q.SPARE) assert.equal(x[b], 0, `spare byte ${b.toString(16)} of program ${n}`);
    for (let k = 0; k < 8; k++) assert.ok(Q.targetName(x, x[0x51 + 3 * k]), `program ${n} MOD ${k + 1} TARGET`);
  }
});

test('Quadraverb: parameters follow the configuration and variant', () => {
  const d = Q.presetData(0);
  const decay = param('b39');
  assert.equal(view(decay, d).label, 'REVERB DECAY');
  const geq = param('b01g');
  assert.equal(view(geq, d).hidden, true);
  const cfg = param('b44');
  writeParam(d, cfg, 2);
  assert.equal(view(geq, d).hidden, undefined);
  assert.equal(view(decay, d).hidden, true);
  // the configuration goes out as the whole program, a page value as opcode 01
  assert.equal(cfg.send(2, {}, d)[5], 0x02);
  const fb = param('b2c');
  const out = fb.send(40, {}, d);
  assert.deepEqual(out.slice(5, 8), [0x01, 2, Q.pageList(d, 2).findIndex((id) => Q.DESCS[id].off === 0x2c)]);
  // mod sources and targets are named lists
  const src = view(param('b50'), d);
  assert.ok(src.options.length > 100 && src.options.some(([, t]) => /BEND/.test(t)), 'mod 1 source names');
  // MOD TARGET names follow the configuration: GRAPHIC EQ→DELAY has no reverb, its EQ group is the bands
  const tgt = view(param('b51'), d);
  assert.ok(!tgt.options.some(([, t]) => /REVERB/.test(t)));
  assert.deepEqual(tgt.options.find(([v]) => v === 48), [48, '16Hz BOOST/CUT']);
  assert.equal(Q.targetName(Q.presetData(0), 3), 'REVERB DECAY');
});

test('Quadraverb against its simulator: edit buffer, page edits, programs, all-data dump', async () => {
  const t = new LoopbackTransport({ id: 'alesis-quadraverb', model: 'Quadraverb', sysex: '00 00 0E' }, qv);
  const c = new DeviceClient(t, { minGap: 1, timeout: 1500 });
  const ctx = { channel: 0 };
  const api = {
    ctx,
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const d = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.equal(Q.nameOf(d), 'EQ+CRS+DLY+RVB');
  const decay = param('b39');
  writeParam(d, decay, 77);
  await c.send(Uint8Array.from(decay.send(77, ctx, d)));
  const time = param('b2aw');
  writeParam(d, time, 333);
  await c.send(Uint8Array.from(time.send(333, ctx, d)));
  await c.drain();
  assert.equal(t.sim.state.edit[0x39], 77);
  assert.equal((t.sim.state.edit[0x2a] << 8) | t.sim.state.edit[0x2b], 333);
  // write and read back a memory program
  Q.setName(d, 'MIDIMASTER 1');
  await c.send(Uint8Array.from(eff.slots.store(0, 42, ctx, d)));
  await c.drain();
  const back = await eff.slots.fetch(api, 0, 42);
  assert.equal(Q.nameOf(back), 'MIDIMASTER 1');
  assert.equal(back[0x39], 77);
  const names = [];
  await eff.slots.scanBank(api, 0, (i, n) => { names[i] = n; });
  assert.equal(names.length, 100);
  assert.equal(names[42], 'MIDIMASTER 1');
  assert.equal(names[1], Q.nameOf(Q.presetData(1)));
  // MIDI page: the program change table goes out as two page edits
  const tbl = glob.params.find((p) => p.key === 't5');
  for (const m of tbl.send(17)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(t.sim.state.midi[_tableAt() + 5], 17);
  c.dispose();
});

function _tableAt() { return Q._test.TABLE_AT; }

test('Quadraverb programs through the shared model', () => {
  const d = Q.presetData(0);
  const common = eff.toCommon(d);
  assert.equal(common.kind, 'effect');
  assert.ok(common.effects.reverb && common.effects.delay && common.effects.modulation);
  const back = eff.fromCommon(common, null);
  assert.deepEqual(Array.from(back.data), Array.from(d));
  // a reverb-only sound from elsewhere lands in EQ→REVERB
  const other = eff.fromCommon({ kind: 'effect', effects: { reverb: { type: 'HALL', time: 0.6, preDelay: 0.2, level: 0.8 } } }, d);
  assert.equal(other.data[0x44], 4);
  assert.equal(other.data[0x32], 3);
  assert.equal(other.data[0x39], Math.round(0.6 * 99));
  assert.equal(Q.nameOf(other.data), Q.nameOf(d));
  assert.equal(Q.fitProgram(Uint8Array.from(other.data)), 0);
});
