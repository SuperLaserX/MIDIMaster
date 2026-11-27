import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import mv, * as V from '../js/devices/defs/alesis-microverb4.js';
import * as MV4 from '../js/devices/defs/alesis-midiverb4.js';

const eff = mv.objects.find((o) => o.key === 'effect');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const ctx = { channel: 0 };

test('Microverb 4: configurations, Edit A / B targets and their LED texts (C4C v1.02 tables)', () => {
  assert.equal(V.ALGORITHMS.length, 32);
  assert.equal(V.PRESETS.length, 100);
  assert.equal(V.USER_BASE.length, 100);
  const hall = V.ALGORITHMS.find((a) => a.name === 'CONCERT HALL');
  assert.deepEqual([V.knobInfo(hall, 0).label, V.knobInfo(hall, 1).label], ['REVERB DECAY TIME', 'INPUT LOWPASS FILTER']);
  assert.equal(V.knobInfo(hall, 0).texts[0], '1.97');
  assert.equal(V.knobInfo(hall, 1).texts.at(-1), 'OFF');
  const pitch = V.ALGORITHMS.find((a) => a.name === 'PITCH SHIFT');
  assert.deepEqual([V.knobInfo(pitch, 0).texts[0], V.knobInfo(pitch, 0).texts[12], V.knobInfo(pitch, 1).texts.at(-1)], ['-12', '00', '50']);
  const taps = V.ALGORITHMS.find((a) => a.name === 'MULTI TAP DELAY');
  assert.ok(V.knobInfo(taps, 0).params.length === 3 && /together/.test(V.knobInfo(taps, 0).label));
  for (const a of V.ALGORITHMS) for (const k of [0, 1]) assert.ok(V.knobInfo(a, k).texts.every((t) => t && !/\?/.test(t)), `${a.name} ${k}`);
  // every factory program's own Edit A / B fits its knobs
  for (let n = 0; n < 100; n++) for (const d of [V.presetProgram(n), V.userFactoryProgram(n)]) {
    assert.equal(V.fitProgram(Uint8Array.from(d)), 0, `${n} ${d[1]}`);
  }
  assert.equal(V.nameOf(V.presetProgram(0)), 'Typical');
  assert.deepEqual(Array.from(V.presetProgram(0)), [0, 0, 0x2e, 0x4e], 'C0A2');
  assert.equal(V.nameOf(V.userFactoryProgram(0)), 'Pno Hall', 'C1A2 bit 7: builds on CFA2');
});

test('Microverb 4 against its simulator: current program, user programs, store', async () => {
  const t = new LoopbackTransport({ id: 'alesis-microverb4', model: 'Microverb 4', sysex: '00 00 0E' }, mv);
  const c = new DeviceClient(t, { minGap: 1, timeout: 600 });
  const api = {
    ctx,
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const id = await c.identity(0x7f, 400);
  assert.deepEqual([...id.slice(5, 16)], [0, 0, 0x0e, 0, 0, 0x12, 0, 0x01, 0, 0x02, 0]);
  const d = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.equal(V.nameOf(d), 'Pno Hall');
  const a = eff.params.find((p) => p.key === 'editA');
  assert.match(view(a, d).label, /^Edit A: /);
  writeParam(d, a, 10);
  await c.send(Uint8Array.from(a.send(10, ctx, d)));
  await c.drain();
  assert.equal(t.sim.state.current[2], 10);
  await c.send(Uint8Array.from(eff.slots.store(0, 7, ctx, d)));
  await c.drain();
  const back = await eff.slots.fetch(api, 0, 7);
  assert.deepEqual(Array.from(back), [7, d[1], 10, d[3]]);
  assert.equal(readParam(back, eff.params.find((p) => p.key === 'config')), V.baseRecord(7, d[1])[1]);
  c.dispose();
});

test('Microverb 4: library items and the shared model', () => {
  const all = V._test.simulate().handle(Uint8Array.from(V.msg.request(ctx, 0x7f)));
  const items = mv.libraryItems(all.map((m) => Uint8Array.from(m)), ctx);
  assert.equal(items.filter((i) => i.object === 'effect').length, 101);
  const d = V.presetProgram(3);
  assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), d).data), Array.from(d));
  const c = eff.toCommon(V.presetProgram(2));
  assert.ok(c.effects.reverb, 'a reverb preset');
  // from another model: a program whose configuration holds the wanted effect
  const hall = MV4.default.objects.find((o) => o.key === 'effect').toCommon(MV4.presetData(1));
  const r = eff.fromCommon(hall);
  assert.ok(/HALL|ROOM|REVERB|PLATE/.test(V.ALGORITHMS[V.baseRecord(r.data[0], r.data[1])[1]].name));
  assert.equal(V.fitProgram(Uint8Array.from(r.data)), 0);
  assert.ok(r.report.approximated[0].includes('only Edit A and Edit B'));
});
