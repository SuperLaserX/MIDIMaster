import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import lxp, * as L from '../js/devices/defs/lexicon-lxp15.js';

const V = JSON.parse(fs.readFileSync(new URL('./lexicon-lxp15.vectors.json', import.meta.url), 'utf8'));
const eff = lxp.objects.find((o) => o.key === 'effect');
const sys = lxp.objects.find((o) => o.key === 'system');
const map = lxp.objects.find((o) => o.key === 'global');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (obj, d) => obj.params.filter((p) => !(p.hidden || view(p, d).hidden));
const textOf = (p, d) => { const v = view(p, d); const x = readParam(d, v); return v.options ? v.options.find(([o]) => o === x)?.[1] : v.format ? v.format(x) : String(x); };
const hexOf = (a) => Buffer.from(Uint8Array.from(a)).toString('hex');
const item = (a, name) => L.findItem(a, name);
const texts = (it) => Array.from({ length: it.max - it.min + 1 }, (_, i) => L.itemText(it, it.min + i));

test('LXP-15: algorithms, pages and value texts from the v2.00 display routines', () => {
  assert.deepEqual(L.ALGS.map((a) => [a.v, a.name]), [[1, 'Dly/Rvb'], [2, 'Pch/Dly'], [3, 'Gate'], [4, 'Plate'], [5, 'ChorDly']]);
  const p3 = L.ALGS[0].pages.find((p) => p.page === 3);
  assert.deepEqual(p3.names, ['Decay', 'Treble', 'BassMpy', 'Size', 'Diffus']);
  const decay = item(1, 'Decay Time');
  assert.deepEqual([decay.p, decay.min, decay.max, L.itemText(decay, 7), L.itemText(decay, 8), L.itemText(decay, 15)], [12, 0, 15, '1.5s', '1.7s', 'Infinit']);
  const d2 = item(1, 'Delay 2');
  assert.deepEqual([d2.p, d2.form, d2.min, d2.max], [4, 2, 0, 8959]);
  assert.deepEqual([L.itemText(d2, 0), L.itemText(d2, 840), L.itemText(d2, 4743), L.itemText(d2, 5000), L.itemText(d2, 8959)], ['0us', '16.8ms', '94.7ms', '100ms', '179ms']);
  const size = item(1, 'Room Size');
  assert.deepEqual([size.p, size.max, L.itemText(size, 59)], [15, 63, '67Meter']);
  const pan = item(1, 'Wet Pan');
  assert.deepEqual([L.itemText(pan, 0), L.itemText(pan, 63), L.itemText(pan, 126)].map((t) => t.replace(/\s+/g, ' ')), ['100%L', 'Center', '100%R'].map((t) => t));
  // patches: Src (sources), Dest (the algorithm's parameters), Scale 9 bits, Offset signed 14 bits
  const src = item(1, 'Patch Src 1');
  assert.deepEqual([src.p, src.min, src.max, L.valuesOf(src).length, L.valuesOf(src).at(-2)], [27, 0, 127, 79, 77]);
  assert.deepEqual([L.itemText(src, 0), L.itemText(src, 1), L.itemText(src, 77), L.itemText(src, 127)], ['0', 'Mod Whl', 'InLevel', 'Off']);
  const dest = item(1, 'Patch Dest 1');
  assert.deepEqual([dest.p, L.valuesOf(dest).at(-1), L.itemText(dest, 1), L.itemText(dest, 25), L.itemText(dest, 127)], [29, 127, 'Glidely', 'LFO Rat', '-']);
  const off = item(1, 'Offset Pch 1');
  assert.deepEqual([off.p, off.form, off.signed, off.min, off.max], [32, 2, 1, -8192, 8191]);
  assert.equal(L.ALGS.length, 5);
  for (const a of L.ALGS) for (const pg of a.pages) for (const it of pg.items) if (!it.none) {
    assert.ok(it.t != null, `${a.name} page ${pg.page} ${it.name}: no texts`);
    assert.ok(texts(it).every((t) => t != null && t.length), `${a.name} ${it.name}: a value without text`);
  }
});

test('LXP-15: ROM presets, first power-up setup, program map values', () => {
  assert.equal(L.PRESETS.length, 128);
  assert.deepEqual([L.PRESET_NAMES[0], L.PRESET_NAMES[1], L.PRESET_NAMES[127]], ['Large Hall', 'Bright Hall', 'Bypass']);
  assert.equal(L.algOf(L.romPreset(0)), 1);
  assert.equal(L.SETUP0.length, 129);
  assert.deepEqual(Array.from(L.SETUP0.slice(0, L.SIZE)), Array.from(L.romPreset(0)));
  assert.deepEqual([L.MAPVALS.length, L.MAPVALS[0], L.MAPVALS[127], L.MAPVALS[128], L.MAPVALS[255], L.MAPVALS[256]], [257, 'Reg  1', 'Reg128', 'Pre  1', 'Pre128', 'OFF']);
  const m = new Uint8Array(L.MAP_SIZE);
  L.setMapEntry(m, 2, 129);
  assert.deepEqual([m[4], m[5], L.mapEntry(m, 2), L.mapEntry(m, 3)], [1, 0x10, 129, 256]);
  L.setMapEntry(m, 3, 5);
  assert.deepEqual([m[6], m[7]], [5, 0x20]);
});

test('LXP-15 messages: byte for byte what the firmware sends (emulator vectors)', () => {
  const setup = Uint8Array.from(L.SETUP0);
  assert.equal(hexOf(L.setupDumpMessage(setup)), V.setup);
  assert.equal(hexOf(L.registerMessage(0, L.romPreset(0))), V.register0);
  assert.equal(hexOf(L.registerMessage(127, L.romPreset(127))), V.register127);
  assert.equal(hexOf(L.mapMessage(new Uint8Array(256))), V.map);
  assert.equal(hexOf(L.paramMessage(12, setup[12])), V.param12);
  assert.equal(hexOf(L.paramMessage(4, setup[4] | (setup[5] << 7), 2)), V.param4w);
  const all = L.allRegistersMessage(L.PRESETS.flatMap((_, i) => Array.from(L.romPreset(i))));
  assert.equal(all.length, V.all_len);
  assert.equal(crypto.createHash('sha1').update(Uint8Array.from(all)).digest('hex'), V.all_sha1);
  // parsing
  const r = L.parse(Buffer.from(V.register0, 'hex'));
  assert.deepEqual([r.kind, r.n, r.ok, L.nameOf(r.data)], ['register', 0, true, 'Large Hall']);
  const s = L.parse(Buffer.from(V.setup, 'hex'));
  assert.deepEqual([s.kind, s.count, s.ok], ['setup', 125, true]);
  assert.deepEqual(L.parse(Uint8Array.from(L.requestMessage(L.REQ.register, 9))), { kind: 'request', ch: 0, req: 0x61, arg: 9 });
  assert.deepEqual(L.parse(Uint8Array.from(L.paramMessage(32, -961, 2))), { kind: 'param', ch: 0, p: 32, v: 16384 - 961, form: 2 });
  assert.deepEqual(L.storeMessage(9, 2), [0xf0, 6, 6, 0x62, 0x70, 9, 0xf7]);
  assert.deepEqual(L.loadMessage(9), [0xf0, 6, 6, 0x60, 0x71, 9, 0xf7]);
  assert.equal(lxp.isRequest(Uint8Array.from(L.requestMessage(L.REQ.setup))), true);
  assert.match(lxp.describe(Buffer.from(V.register0, 'hex')), /register 1 "Large Hall" \(Dly\/Rvb\)/);
  // the receiver as the emulator showed it
  assert.equal(V.other_channel, '');
  assert.equal(V.reg_rx_ok, true);
  assert.equal(V.reg_rx_protected_kept, true);
  assert.deepEqual([V.setup_rx_7d, V.setup_rx_81], ['Large Hall  ', 'Large Hall  ']);
});

test('LXP-15 setup editor: parameters per algorithm, every ROM preset value has a text', () => {
  const d = L.romPreset(0);
  const groups = [...new Set(visible(eff, d).map((p) => p.group))];
  assert.deepEqual(groups, ['Algorithm', 'Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5', 'Patch 1', 'Patch 2', 'Patch 3', 'Patch 4']);
  assert.equal(textOf(eff.params.find((p) => p.key === 'alg'), d), '1 Dly/Rvb');
  let missing = 0;
  for (let i = 0; i < 128; i++) {
    const x = L.romPreset(i);
    for (const p of visible(eff, x)) if (textOf(p, x) == null) { missing++; if (missing < 5) console.log('no text', i, L.PRESET_NAMES[i], p.label, readParam(x, p)); }
  }
  assert.equal(missing, 0);
  // 14-bit values: low 7 bits first; the signed offset
  const dl = L.paramOf(1, 4);
  const x = Uint8Array.from(d);
  writeParam(x, dl, 5000);
  assert.deepEqual([x[4], x[5], readParam(x, dl)], [5000 & 0x7f, 5000 >> 7, 5000]);
  const off = L.paramOf(1, 32);
  writeParam(x, off, -961);
  assert.deepEqual([x[32], x[33], readParam(x, off)], [(16384 - 961) & 0x7f, (16384 - 961) >> 7, -961]);
  assert.deepEqual(eff.sendParam(dl, 5000, x, { channel: 3 }), [0xf0, 6, 6, 0x53, 4, 5000 & 0x7f, 5000 >> 7, 0xf7]);
  assert.deepEqual(eff.sendParam(L.paramOf(1, 12), 9, x, {}), [0xf0, 6, 6, 0x20, 12, 9, 0xf7]);
  // the whole register as parameter messages, the algorithm first, 14-bit pairs as 5n
  const msgs = L.editMessages(x);
  assert.deepEqual(msgs[0], [0xf0, 6, 6, 0x20, 0, 1, 0xf7]);
  assert.ok(msgs.some((m) => m[3] === 0x50 && m[4] === 4));
  assert.ok(!msgs.some((m) => m[4] === 5));
  // settings and map pages
  assert.ok(sys.params.some((p) => p.label === 'MIDI Channel'));
  assert.equal(map.params.length, 128);
});

test('LXP-15 against its simulator: requests, parameters, dumps, store and load', async () => {
  const t = new LoopbackTransport({ id: 'lexicon-lxp15', model: 'LXP-15', sysex: '06' }, lxp);
  const c = new DeviceClient(t, { minGap: 1, timeout: 800 });
  const sim = t.sim;
  const ask = async (bytes, match) => (await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw;
  // the replies are the firmware's own (vectors)
  assert.equal(hexOf(await ask(L.requestMessage(L.REQ.setup), (r) => L.parse(r)?.kind === 'setup')), V.setup);
  assert.equal(hexOf(await ask(L.requestMessage(L.REQ.register, 127), (r) => L.parse(r)?.kind === 'register')), V.register127);
  assert.equal(hexOf(await ask(L.requestMessage(L.REQ.param, 12), (r) => L.parse(r)?.kind === 'param')), V.param12);
  // the objects fetch through their requests
  const setupData = eff.decode(await ask(eff.request({}), eff.match));
  assert.equal(L.nameOf(setupData), 'Large Hall');
  // a parameter message changes the active setup
  await c.send(Uint8Array.from(L.paramMessage(4, 1234, 2)));
  await c.drain();
  assert.equal(sim.state.setup[4] | (sim.state.setup[5] << 7), 1234);
  // register dump stored (Memory Protect Off), refused when On
  const d = L.romPreset(40);
  L.setName(d, 'SENT');
  for (const m of eff.slots.store(0, 7, {}, d)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(L.nameOf(sim.state.registers[7]), 'SENT');
  sim.state.setup[L.P.memProt] = 1;
  L.setName(d, 'REFUSED');
  for (const m of eff.slots.store(0, 8, {}, d)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.notEqual(L.nameOf(sim.state.registers[8]), 'REFUSED');
  sim.state.setup[L.P.memProt] = 0;
  // the setup sent as parameter messages, then stored and loaded
  const e = L.romPreset(90);
  for (const m of L.editMessages(e)) await c.send(Uint8Array.from(m));
  await c.send(Uint8Array.from(L.storeMessage(20)));
  await c.drain();
  assert.deepEqual(Array.from(sim.state.registers[20]), Array.from(e));
  for (const m of eff.slots.recall(0, 7, {})) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(L.nameOf(sim.state.setup), 'SENT');
  for (const m of eff.slots.recall(1, 5, {})) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(L.nameOf(sim.state.setup), L.PRESET_NAMES[5]);
  // a setup dump is not taken (count 7D refused, 81 cannot arrive)
  await c.send(Uint8Array.from(L.setupDumpMessage(L.romPreset(3))));
  await c.drain();
  assert.equal(L.nameOf(sim.state.setup), L.PRESET_NAMES[5]);
  // program map
  const m = new Uint8Array(256);
  L.setMapEntry(m, 0, 130);
  await c.send(Uint8Array.from(L.mapMessage(m)));
  await c.drain();
  assert.equal(L.mapEntry(sim.state.map, 0), 130);
  // another channel is ignored
  await c.send(Uint8Array.from(L.paramMessage(12, 3, 1, 5)));
  await c.drain();
  assert.notEqual(sim.state.setup[12], 3);
});

test('LXP-15 translator: exact within the family, effects to an algorithm that has them', () => {
  for (let n = 0; n < 128; n += 11) {
    const d = L.romPreset(n);
    assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), null).data), Array.from(d));
    assert.equal(eff.toCommon(d).kind, 'effect');
  }
  assert.equal(L.pickAlgorithm({ reverb: { type: 'Plate', level: 1 } }), 4);
  assert.equal(L.pickAlgorithm({ chorus: { level: 1 } }), 5);
  assert.equal(L.pickAlgorithm({ modulation: { type: 'PITCH SHIFT' } }), 2);
  assert.equal(L.pickAlgorithm({}), -1);
  const r = eff.fromCommon({ model: 1, kind: 'effect', effects: { reverb: { type: 'Plate', time: 1, level: 0.5 } } }, L.romPreset(0));
  assert.equal(L.algOf(r.data), 4);
  assert.equal(L.nameOf(r.data), 'Large Hall');
  const c = eff.toCommon(L.romPreset(0));
  assert.deepEqual([Object.keys(c.effects).sort(), c.extra.family], [['delay', 'reverb'], 'lexicon-lxp15']);
});

test('LXP-15: registry, catalog and doc', () => {
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/registry.js', 'utf8').includes("'lexicon-lxp15'"));
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/catalog-data.js', 'utf8').includes('"id": "lexicon-lxp15"'));
  const doc = fs.readFileSync('z:/MIDIMaster/docs/devices/lexicon-lxp15.md', 'utf8');
  assert.match(doc, /not checked on hardware/i);
  const items = lxp.libraryItems([Buffer.from(V.register0, 'hex'), Buffer.from(V.setup, 'hex'), Buffer.from(V.map, 'hex')]);
  assert.deepEqual(items.map((i) => i.object), ['effect', 'effect', 'system', 'global']);
});
