import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import mv4, * as M from '../js/devices/defs/alesis-midiverb4.js';
import wedge, * as W from '../js/devices/defs/alesis-wedge.js';

const obj = (k) => mv4.objects.find((o) => o.key === k);
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const ctx = { channel: 0 };

test('MIDIVerb 4: 32 configurations, presets and user defaults within their maxima (v1.04 tables)', () => {
  assert.equal(M.ALGORITHMS.length, 32);
  assert.equal(M.ALGORITHMS[3].name, 'CONCERT HALL');
  for (const list of [M.PRESETS, M.USER_FACTORY]) {
    assert.equal(list.length, 128);
    for (const h of list) {
      const d = Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
      M.ALGORITHMS[d[1]].max.forEach((m, i) => assert.ok(d[10 + i] <= m, `${M.nameOf(d)} ${i}`));
    }
  }
  assert.equal(M.nameOf(M.presetData(0)), 'Bypass');
  assert.equal(M.nameOf(M.userFactoryData(1)), 'Basilica');
  for (const a of M.ALGORITHMS) {
    for (let i = 0; i < 16; i++) {
      const p = M.paramInfo(a, i);
      if (p) assert.ok(p.texts.length >= p.max + 1 && p.texts.every((t) => t && !/\?/.test(t)), `${a.name} ${i}`);
    }
  }
});

test('MIDIVerb 4: parameters and system settings read as the LCD shows them', () => {
  const eff = obj('effect');
  const d = M.presetData(1); // Classicl
  const shown = eff.params.map((p) => view(p, d)).filter((p) => !p.hidden && /^p\d+$/.test(p.key));
  assert.ok(shown.length >= 8);
  for (const p of shown) assert.ok(p.options.some((o) => o[0] === readParam(d, p)), `${p.label} = ${readParam(d, p)}`);
  const sys = obj('global');
  const sp = (k) => sys.params.find((x) => x.key === k);
  assert.deepEqual(sp('foot').options.map((o) => o[1]), ['Adu', 'byP']);
  assert.equal(sp('modY').options[11][1], 'Controller 007');
  assert.equal(sp('lvl0').format(100), '100');
  // the message: 6 levels, Mod#X, AmpX (2 nibbles), Mod#Y, AmpY (2 nibbles), footswitch, flags
  const g = M.msg.global(ctx, M.initSystem());
  assert.equal(g.length, 22);
  assert.equal(M.msg.edit(ctx, d).length, 50);
  assert.equal(M.msg.bank(ctx, Array.from({ length: 128 }, () => d)).length, 7 + 128 * 42 + 1);
  assert.deepEqual(Array.from(M.decodeProgram(M.msg.edit(ctx, d), 7)), Array.from(d));
});

test('MIDIVerb 4 against its simulator: read, edit, configuration change, store, user bank and system', async () => {
  const entry = { id: 'alesis-midiverb4', model: 'MIDIVerb 4', sysex: '00 00 0E' };
  const t = new LoopbackTransport(entry, mv4);
  const c = new DeviceClient(t, { minGap: 1, timeout: 600 });
  const eff = obj('effect');
  const api = {
    ctx,
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const id = await c.identity(0x7f, 400);
  assert.deepEqual([...id.slice(5, 16)], [0, 0, 0x0e, 0, 0, 0x11, 0, 0x01, 0, 0x04, 0]);
  const data = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.equal(M.nameOf(data), 'Classicl');
  const p0 = eff.params.find((p) => p.key === 'p0');
  writeParam(data, p0, 20);
  await c.send(Uint8Array.from(p0.send(20, ctx, data)));
  const cfg = eff.params.find((p) => p.key === 'config');
  writeParam(data, cfg, 8); // MONO DELAY
  await c.send(Uint8Array.from(cfg.send(8, ctx, data)));
  cfg.after(data, 8, ctx);
  await c.drain();
  const sim = t.sim.state;
  assert.deepEqual(Array.from(sim.edit), Array.from(data), 'accepted: every value within the MONO DELAY maxima');
  await c.send(Uint8Array.from(eff.slots.store(0, 9, ctx, data)));
  await c.drain();
  assert.deepEqual(Array.from(await eff.slots.fetch(api, 0, 9)), Array.from(data));
  const sys = obj('global');
  const s = await sys.fetch(api);
  const foot = sys.params.find((p) => p.key === 'foot');
  writeParam(s, foot, 1);
  await c.send(Uint8Array.from(foot.send(1, ctx, s)));
  await c.drain();
  assert.equal(sim.system[10], 1);
  c.dispose();
});

test('MIDIVerb 4: complete dump items, and programs through the shared model (also to and from the Wedge)', () => {
  const sim = M._test.simulate();
  const all = sim.handle(Uint8Array.from(M.msg.request(ctx, 0x7f)));
  const items = mv4.libraryItems(all.map((m) => Uint8Array.from(m)), ctx);
  assert.equal(items.filter((i) => i.object === 'effect').length, 129);
  const eff = obj('effect');
  for (const n of [1, 30, 70, 120]) {
    const d = M.presetData(n);
    assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), d).data), Array.from(d), M.nameOf(d));
  }
  // a Wedge hall becomes a MIDIVerb 4 CONCERT HALL and back to a Wedge LARGE HALL
  const wEff = wedge.objects.find((o) => o.key === 'effect');
  const toMv = eff.fromCommon(wEff.toCommon(W.presetData(0)));
  assert.equal(M.ALGORITHMS[toMv.data[1]].name, 'CONCERT HALL');
  const back = wEff.fromCommon(eff.toCommon(toMv.data));
  assert.equal(W.ALGORITHMS[back.data[1]].name, 'LARGE HALL');
  const room = eff.fromCommon({ effects: { reverb: { type: 'Room', level: 0.4 }, delay: { time: 0.2, feedback: 0.3, level: 0.3 } } });
  assert.equal(M.ALGORITHMS[room.data[1]].name, 'REALROOM+DELAY');
  assert.ok(M.ALGORITHMS[room.data[1]].max.every((m, i) => room.data[10 + i] <= m));
});
