import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import wedge, * as W from '../js/devices/defs/alesis-wedge.js';

const obj = (k) => wedge.objects.find((o) => o.key === k);
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const ctx = { channel: 0 };

test('Wedge: 28 configurations, presets and user defaults within their maxima (W1 v1.02 tables)', () => {
  assert.equal(W.ALGORITHMS.length, 28);
  assert.deepEqual(W.ALGORITHMS.slice(0, 4).map((a) => a.name), ['ROOM+CHORUS', 'ROOM+HALL', 'PLATE', 'HALL REVERB']);
  for (const list of [W.PRESETS, W.USER_FACTORY]) {
    assert.equal(list.length, 128);
    for (const h of list) {
      const d = Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
      const a = W.ALGORITHMS[d[1]];
      assert.ok(a, h);
      a.max.forEach((m, i) => assert.ok(d[14 + i] <= m, `${W.nameOf(d)} parameter ${i}`));
    }
  }
  assert.equal(W.nameOf(W.presetData(0)), 'Concert Hall');
  assert.equal(W.nameOf(W.userFactoryData(127)), 'BlankProgram', '6FE3 copied into users 100-127');
  // every parameter in use has a display text for each value 0..max
  for (const a of W.ALGORITHMS) {
    for (let i = 0; i < 24; i++) {
      const p = W.paramInfo(a, i);
      if (p) assert.ok(p.texts.length >= p.max + 1 && p.texts.every((t) => t && !/\?/.test(t)), `${a.name} ${i}`);
    }
  }
});

test('Wedge: program parameters read as the LCD shows them', () => {
  const eff = obj('effect');
  const d = eff.init(); // preset 000 Concert Hall, LARGE HALL
  const p = (label) => view(eff.params.find((x) => view(x, d).label === label), d);
  assert.equal(W.ALGORITHMS[d[1]].name, 'LARGE HALL');
  const show = (label) => { const q = p(label); return q.options.find((o) => o[0] === readParam(d, q))[1]; };
  assert.equal(show('Decay'), '2.93 s');
  assert.equal(show('LPF'), '2.83 kHz');
  assert.equal(show('PDly'), '067 ms');
  assert.equal(show('Dens'), '093%');
  assert.equal(show('LDamp'), 'OFF');
  // a two-effect configuration names each effect's parameters after it
  const rc = Uint8Array.from(d);
  rc[1] = 0;
  W.fitProgram(rc);
  const labels = eff.params.map((x) => view(x, rc)).filter((x) => !x.hidden).map((x) => x.label);
  assert.ok(labels.includes('ROOM Decay') && labels.includes('CHORUS CMix'), labels.join());
  // unused bytes of a configuration are hidden
  const nl = Uint8Array.from(d); nl[1] = 6; W.fitProgram(nl);
  assert.equal(eff.params.filter((x) => /^p\d+$/.test(x.key) && !view(x, nl).hidden).length, 8, 'NONLINEAR: two pages');
  // Mod sources and amounts from the Util page routines
  const sys = obj('global');
  const sp = (k) => sys.params.find((x) => x.key === k);
  assert.equal(sp('modX').options[0][1], 'Pitch bend (bnd)');
  assert.equal(sp('modX').options[5][1], 'Controller 001');
  assert.equal(sp('ampX').options[99][1], '00');
  assert.equal(sp('ampX').options[0][1], '-99');
});

test('Wedge: message formats (receiver 194D, transmitters 1B07-1C8B)', () => {
  const d = W.presetData(3);
  const e = W.msg.edit(ctx, d);
  assert.equal(e.length, 70);
  assert.deepEqual(e.slice(0, 7), [0xf0, 0x00, 0x00, 0x0e, 0x15, 0x00, 0x02]);
  assert.deepEqual(Array.from(W.decodeProgram(e, 7)), Array.from(d));
  assert.equal(W.msg.global(ctx, W.initSystem()).length, 19);
  assert.equal(W.msg.table(ctx, W.initSystem()).length, 264);
  assert.equal(W.msg.bank(ctx, Array.from({ length: 128 }, () => d)).length, 7 + 128 * 62 + 1);
  assert.deepEqual(W.msg.param({ channel: 2 }, 20, 5, 0xab), [0xf0, 0, 0, 0x0e, 0x15, 2, 6, 20, 5, 0x0a, 0x0b, 0xf7]);
  assert.match(wedge.describe(Uint8Array.from(W.msg.param(ctx, 20, 0, 50))), /LARGE HALL: Decay = /);
  assert.ok(wedge.isRequest(Uint8Array.from(W.msg.request(ctx, 0x7f))));
});

test('Wedge against its simulator: read, live edit, configuration change, store, user bank and system', async () => {
  const entry = { id: 'alesis-wedge', model: 'Wedge', sysex: '00 00 0E' };
  const t = new LoopbackTransport(entry, wedge);
  const c = new DeviceClient(t, { minGap: 1, timeout: 600 });
  const eff = obj('effect');
  const api = {
    ctx,
    get data() { return eff.init(); },
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const id = await c.identity(0x7f, 400);
  assert.deepEqual([...id.slice(5, 16)], [0x00, 0x00, 0x0e, 0x00, 0x00, 0x15, 0x00, 0x01, 0x00, 0x02, 0x00]);

  const data = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.equal(W.nameOf(data), 'Concert Hall');
  // live edit: Decay (parameter 0) through the definition's own send and after
  const decay = eff.params.find((p) => p.key === 'p0');
  writeParam(data, decay, 77);
  await c.send(Uint8Array.from(decay.send(77, ctx, data)));
  decay.after(data, 77, ctx);
  const mix = eff.params.find((p) => p.key === 'p15');
  writeParam(data, mix, 40);
  await c.send(Uint8Array.from(mix.send(40, ctx, data)));
  mix.after(data, 40, ctx);
  await c.drain();
  const sim = t.sim.state;
  assert.equal(sim.edit[14], 77);
  assert.equal(sim.edit[29], 40);
  assert.equal(sim.edit[0], 15, 'the Wedge moves its edit position to the changed parameter');
  assert.deepEqual(Array.from(sim.edit), Array.from(data));

  // configuration change: the whole program goes out, limited to the new maxima
  const cfg = eff.params.find((p) => p.key === 'config');
  writeParam(data, cfg, 8); // MONO DELAY
  await c.send(Uint8Array.from(cfg.send(8, ctx, data)));
  cfg.after(data, 8, ctx);
  await c.drain();
  assert.equal(sim.edit[1], 8, 'refused if any value were above the MONO DELAY maxima');
  assert.deepEqual(Array.from(sim.edit), Array.from(data));

  // store into user 5, then read the user bank back through the slot browser
  await c.send(Uint8Array.from(eff.slots.store(0, 5, ctx, data)));
  await c.drain();
  const fetched = await eff.slots.fetch(api, 0, 5);
  assert.deepEqual(Array.from(fetched), Array.from(data));
  assert.equal(W.nameOf(await eff.slots.fetch(api, 1, 0)), 'Concert Hall', 'presets come from the firmware');
  const names = [];
  await eff.slots.scanBank(api, 0, (i, n) => { names[i] = n; });
  assert.equal(names[0], W.nameOf(W.userFactoryData(0)));
  assert.equal(names[127], 'BlankProgram');
  assert.deepEqual(eff.slots.recall(1, 33, ctx), [[0xb0, 0, 0], [0xc0, 33]]);

  // system: read, change a level, the table, and the flags
  const sys = obj('global');
  const s = await sys.fetch({ ...api, get data() { return sys.init(); } });
  assert.equal(s[0], 90);
  const lvl = sys.params.find((p) => p.key === 'lvl2');
  writeParam(s, lvl, 64);
  await c.send(Uint8Array.from(lvl.send(64, ctx, s)));
  const t5 = sys.params.find((p) => p.key === 't5');
  writeParam(s, t5, 0x21); // MIDI 005 -> Preset 033
  await c.send(Uint8Array.from(t5.send(0x21, ctx, s)));
  const omni = sys.params.find((p) => p.key === 'omni');
  writeParam(s, omni, 1);
  await c.send(Uint8Array.from(omni.send(1, ctx, s)));
  await c.drain();
  assert.equal(sim.system[2], 64);
  assert.equal(sim.system[W._test.TABLE_AT + 5], 0x21);
  assert.equal(sim.system[8] & 2, 2);
  assert.equal(t5.options[0x21][1], 'Pset 033');
  c.dispose();
});

test('Wedge: complete dump splits into the Head Library items', () => {
  const sim = W._test.simulate();
  const all = sim.handle(Uint8Array.from(W.msg.request(ctx, 0x7f)));
  assert.equal(all.length, 4);
  const items = wedge.libraryItems(all.map((m) => Uint8Array.from(m)), ctx);
  assert.equal(items.filter((i) => i.object === 'effect').length, 129, '128 user programs and the edit buffer');
  assert.equal(items.filter((i) => i.object === 'global').length, 2);
  const one = items.find((i) => i.key === 'u7');
  assert.equal(one.name, W.nameOf(W.userFactoryData(7)));
  assert.deepEqual(Array.from(obj('effect').fromSyx(one.msgs)), Array.from(one.data));
  const s = obj('global').fromSyx(all.slice(0, 2).map((m) => Uint8Array.from(m)));
  assert.equal(s[W._test.TABLE_AT + 3], 0x83);
});

test('Wedge programs through the shared model: exact for the Wedge, a matching configuration otherwise', () => {
  const eff = obj('effect');
  for (const n of [0, 40, 60, 91, 127]) {
    const d = W.presetData(n);
    const back = eff.fromCommon(eff.toCommon(d), d);
    assert.deepEqual(Array.from(back.data), Array.from(d), W.nameOf(d));
  }
  const hall = eff.toCommon(W.presetData(0));
  assert.equal(hall.effects.reverb.type, 'LARGE HALL');
  assert.ok(hall.effects.reverb.time > 0 && hall.effects.reverb.level > 0);
  const valid = (d) => W.ALGORITHMS[d[1]].max.every((m, i) => d[14 + i] <= m);
  const cases = [
    [{ reverb: { type: 'PLATE', time: 0.7, level: 0.5 } }, 'PLATE'],
    [{ reverb: { type: 'Hall 1', time: 0.5, level: 0.4 }, chorus: { type: 'Chorus', rate: 0.3, depth: 0.6, level: 0.5 } }, 'ROOM+CHORUS'],
    [{ reverb: { type: 'Room', level: 0.3 }, delay: { type: 'mono-long', time: 0.2, feedback: 0.4, level: 0.3 } }, 'ROOM+DELAY'],
    [{ delay: { type: 'delay', time: 0.1, feedback: 0.5, level: 0.5 } }, 'MONO DELAY'],
    [{ modulation: { type: 'FLANGER', level: 0.6, rate: 0.2 } }, 'CHRS/FLANGE'],
  ];
  for (const [effects, name] of cases) {
    const r = eff.fromCommon({ model: 1, kind: 'patch', effects });
    assert.equal(W.ALGORITHMS[r.data[1]].name, name);
    assert.ok(valid(r.data), name);
    assert.ok(r.report.approximated.length > 0);
  }
  const dly = eff.fromCommon({ effects: { delay: { time: 0.1, level: 1 } } }).data;
  assert.equal(dly[14] * 100 + dly[15] * 10 + dly[16], 250, 'MONO DELAY 100mS/10mS/1mS digits');
});
