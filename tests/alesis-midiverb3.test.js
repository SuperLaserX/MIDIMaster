import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import mv3, * as M from '../js/devices/defs/alesis-midiverb3.js';
import qv, * as Q from '../js/devices/defs/alesis-quadraverb.js';

const eff = mv3.objects.find((o) => o.key === 'effect');
const sys = mv3.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const param = (key) => eff.params.find((p) => p.key === key);
const texts = (n) => M.FORMATS[M.DESCRIPTORS[n].fmt].texts;
const ctx = { channel: 0 };

test('MIDIVerb III: descriptors, button positions and LED texts from the v1.01 tables', () => {
  assert.equal(M.DESCRIPTORS.length, 21);
  assert.equal(M.PAGES.length, 15);
  assert.equal(M.FACTORY.length, 100);
  assert.deepEqual([M.DELAY_MAX[0], M.DELAY_MAX[12], M.DELAY_MAX[13], M.DELAY_MAX[14]], [100, 100, 490, 490]);
  // EQ: the -3 dB point in kHz, OFF last (manual figure 7)
  assert.deepEqual([texts(8)[0], texts(8)[17], texts(8)[29], texts(8)[30]], ['0.16', '4.11', '13.8', 'OFF']);
  assert.deepEqual(texts(5).slice(0, 5), ['ro1', 'ro2', 'ro3', 'ro4', 'HL1']);
  assert.deepEqual(texts(5).slice(16), ['gt1', 'gt2', 'rE1', 'rE2']);
  assert.deepEqual([texts(7)[0], texts(7)[5], texts(7)[7], texts(7)[13], texts(7)[24]], ['OFF', 'C5', 'SC1', 'F1', 'SF6']);
  assert.deepEqual([texts(11)[0], texts(11)[1], texts(11)[6], texts(11)[25], texts(11)[48]], ['OFF', 'Prd', 'Srd', 'Pcs', '7dL']);
  assert.deepEqual([texts(16)[0], texts(16)[98], texts(16)[99], texts(16)[198]], ['-99', '-01', '00', '99']);
  assert.deepEqual([texts(6)[80], texts(17)[256], texts(17)[490]], ['080', '256', '490']);
  assert.deepEqual([texts(10)[0], texts(10)[14], texts(2)[0], texts(2)[98]], ['01', '15', '01', '99']);
  assert.deepEqual([texts(14)[0], texts(14)[15], texts(15)[1], texts(19)[0], texts(20)[0], texts(18)[0]], ['c01', 'c16', 'Pon', 'EoF', 'Snd', '---']);
  for (const f of M.FORMATS) assert.ok(f.texts.every((t) => t && !/\?/.test(t)), f.routine);
  // configurations 14 and 15: no reverb pages, the long delay (descriptor 17, 1-490 ms)
  assert.ok(M.hasReverb(0) && M.hasReverb(12) && !M.hasReverb(13) && !M.hasReverb(14));
  assert.equal(M.PAGES[13][6], 17);
  assert.deepEqual([M.DESCRIPTORS[17].min, M.DESCRIPTORS[17].max, M.DESCRIPTORS[17].def], [1, 490, 250]);
  // every factory program is within the recall limits and its configuration's delay
  for (let n = 0; n < 100; n++) assert.equal(M.fitProgram(M.factoryProgram(n)), 0, `factory ${n}`);
  assert.equal(M.nameOf(M.factoryProgram(0)), 'Config 05 PL4 SC2 100ms');
  // SysEx parameter numbers: 4 = delay time over bytes 4 / 5, then one byte further on
  assert.deepEqual([0, 3, 4, 5, 10, 12, 14].map(M.paramOffset), [0, 3, 4, 6, 11, 13, 15]);
  assert.deepEqual(M.msg.param(4, 490), [0xf0, 0, 0, 0x0e, 0x03, 0x03, 4, 0x6a, 0x03, 0xf7]);
  assert.deepEqual(M.msg.param(12, 198), [0xf0, 0, 0, 0x0e, 0x03, 0x03, 12, 0x46, 0x01, 0xf7]);
});

test('MIDIVerb III: the editor pages follow the configuration', () => {
  const d = M.factoryProgram(0);
  const time = param('dlTime');
  assert.deepEqual([view(time, d).max, readParam(d, time)], [100, 100]);
  d[11] = 13;
  assert.equal(view(time, d).max, 490);
  assert.ok(view(param('rvAlg'), d).hidden && view(param('rvDecay'), d).hidden && view(param('rvMix'), d).hidden);
  writeParam(d, time, 300);
  assert.deepEqual([d[4], d[5]], [1, 44]);
  d[11] = 0;
  assert.ok(param('config').after(d));
  assert.equal(M.delayOf(d), 100);
  assert.match(view(time, d).label, /pre-delay/);
  assert.ok(!view(param('rvAlg'), d).hidden);
  assert.ok(param('spare14').readOnly);
});

test('MIDIVerb III against its simulator: all data, parameter edits, program writes', async () => {
  const t = new LoopbackTransport({ id: 'alesis-midiverb3', model: 'MIDIVerb III', sysex: '00 00 0E' }, mv3);
  const c = new DeviceClient(t, { minGap: 1, timeout: 800 });
  const api = {
    ctx,
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const d = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.deepEqual(Array.from(d), Array.from(M.factoryProgram(0)));
  // live edits (opcode 03)
  for (const [key, v] of [['rvDecay', 77], ['dlTime', 64], ['modAmp', 150], ['chAlg', 19]]) {
    const p = param(key);
    writeParam(d, p, v);
    await c.send(Uint8Array.from(p.send(readParam(d, p), ctx, d)));
  }
  await c.drain();
  const s = t.sim.state.mem;
  assert.deepEqual([s[M.MEM.edit + 8], M.delayOf(s.slice(M.MEM.edit)), s[M.MEM.edit + 13], s[M.MEM.edit + 2], s[M.MEM.edited]], [77, 64, 150, 19, 1]);
  // configuration 15 and a long delay, then back to 1: the delay is limited (11AF)
  writeParam(d, param('config'), 14);
  await c.send(Uint8Array.from(param('config').send(14, ctx, d)));
  writeParam(d, param('dlTime'), 450);
  await c.send(Uint8Array.from(param('dlTime').send(450, ctx, d)));
  await c.drain();
  assert.equal(M.delayOf(s.slice(M.MEM.edit)), 450);
  await c.send(Uint8Array.from(M.msg.param(10, 0)));
  await c.drain();
  assert.equal(M.delayOf(s.slice(M.MEM.edit)), 100);
  // a user program (opcode 01, n < 100) is stored and selected
  const p = M.factoryProgram(40);
  await c.send(Uint8Array.from(eff.slots.store(0, 7, ctx, p)));
  await c.drain();
  assert.deepEqual([s[M.MEM.current], s[M.MEM.edited]], [107, 0]);
  assert.deepEqual(Array.from(await eff.slots.fetch(api, 0, 7)), Array.from(p));
  // the memory object: MIDI settings and the map go out in the all-data dump
  const mem = await sys.fetch(api);
  writeParam(mem, sys.params.find((x) => x.key === 'channel'), 9);
  writeParam(mem, sys.params.find((x) => x.key === 'map5'), 199);
  await c.send(Uint8Array.from(sys.toSyx(mem, ctx)));
  await c.drain();
  assert.deepEqual([s[M.MEM.channel], s[M.MEM.map + 5], t.sim.state.restarts], [9, 199, 1]);
  c.dispose();
});

test('MIDIVerb III: library items and the shared model', () => {
  const sim = M._test.simulate();
  const [dump] = sim.handle(Uint8Array.from(M.msg.request()));
  assert.equal(dump.length, 3507);
  assert.ok(mv3.recognise(Uint8Array.from(dump)) && mv3.isRequest(Uint8Array.from(M.msg.request())));
  const items = mv3.libraryItems([Uint8Array.from(dump)], ctx);
  assert.equal(items.filter((i) => i.object === 'effect').length, 101);
  assert.equal(items.filter((i) => i.object === 'system').length, 1);
  assert.equal(items[0].label, 'User 100');
  assert.deepEqual(Array.from(items[0].data), Array.from(M.factoryProgram(0)));
  // the same family is exact, spare bytes included
  for (const n of [0, 4, 80, 96]) {
    const d = M.factoryProgram(n);
    assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), d).data), Array.from(d), `factory ${n}`);
  }
  const c = eff.toCommon(M.factoryProgram(0));
  assert.equal(c.kind, 'effect');
  assert.equal(c.effects.reverb.type, 'VOCAL PLATE');
  assert.ok(c.effects.chorus && c.effects.delay);
  // from a Quadraverb program: a configuration with reverb, starting from a factory program
  const qe = qv.objects.find((o) => o.key === 'effect');
  const r = eff.fromCommon(qe.toCommon(Q.presetData(0)));
  assert.ok(M.hasReverb(r.data[11]));
  assert.equal(M.fitProgram(Uint8Array.from(r.data)), 0);
  assert.ok(r.report.approximated.some((l) => l.startsWith('Configuration ')));
  // nothing usable keeps the base program
  const base = M.factoryProgram(9);
  assert.deepEqual(Array.from(eff.fromCommon({ model: 1, kind: 'effect', effects: {} }, base).data), Array.from(base));
});
