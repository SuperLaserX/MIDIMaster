import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import efx, * as E from '../js/devices/defs/viscount-efx10.js';

const eff = efx.objects.find((o) => o.key === 'effect');
const sys = efx.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (obj, d) => obj.params.filter((p) => !(p.hidden || view(p, d).hidden));
const textOf = (p, d) => { const v = view(p, d); const x = readParam(d, v); return v.options ? v.options.find(([o]) => o === x)?.[1] : v.format ? v.format(x) : String(x); };
const page = (a, block, label) => E.findPage(a, block, label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const texts = (a, pg) => E.pageInfo(a, pg).texts;

test('EFX-10: algorithms, ROM presets and pages from the v1.02 tables', () => {
  assert.equal(E.ALGOS.length, 27);
  assert.deepEqual(E.ALGOS.slice(0, 5).map((x) => x.name), ['LARGE HALL', 'MEDIUM HALL', 'LARGE ROOM', 'MEDIUM ROOM', 'SMALL ROOM']);
  assert.deepEqual(E.ALGOS.slice(-2).map((x) => x.name), ['HUM  CANCELLER', 'VOCAL  CANCELLER']);
  assert.deepEqual([E.ROM_PRESETS[0].line1, E.ROM_PRESETS[26].line1], ['001 Large Hall  ', '027 Voc. Canc.  ']);
  // the page count each ROM record ends with (1D6A2 + 50h) is what the unit steps through
  E.ALGOS.forEach((x, a) => assert.equal(x.pageCount, E.ROM_PRESETS[a].pages, x.name));
  // every page of every algorithm was shown and walked
  E.ALGOS.forEach((x) => assert.equal(x.pages.length, x.pageCount, x.name));
  const hall = E.ALGOS[0].pages;
  assert.deepEqual(hall.map((p) => p.label).slice(0, 9), ['SIZE', 'REV TIME', 'REV DELAY', 'REV TONE', 'E.R. DELAY', 'E.R. TONE', 'E.R. LEVEL', 'REV HF GATE', 'REV ATTACK']);
  const rt = page(0, 'REVERB', '^REV TIME$');
  assert.deepEqual([rt.off, texts(0, rt)[0], texts(0, rt).at(-1), texts(0, rt).length], [18, '0.1s', '20.0s', 200]);
  const rd = page(0, 'REVERB', '^REV DELAY$');
  assert.deepEqual([rd.off, rd.size, texts(0, rd).at(-1)], [19, 2, '500ms']);
  assert.deepEqual(texts(0, page(0, 'REVERB', 'E.R. TONE')), ['FLAT', 'LOW', 'MID', 'HIGH']);
  // MULTI TAP DELAY: the tap time is 12 bits, the pan the top nibble of the same byte
  const tt = page(11, 'DELAY TAP 1$', 'D. TIME');
  const tp = page(11, 'DELAY TAP 1$', 'PAN');
  assert.deepEqual([tt.off, tt.size, tt.bits, tp.off, tp.bits, tp.shift], [17, 2, 12, 17, 4, 4]);
  assert.deepEqual([texts(11, tt).at(-1), texts(11, tp)[0], texts(11, tp).at(-1)], ['2980ms', 'L  0:R 10', 'L 10:R  0']);
  // signed values: bit 7 = plus
  const fine = page(14, 'P. SHIFTER', 'FINE A');
  const info = E.pageInfo(14, fine);
  assert.deepEqual([info.map.get(100), info.map.get(0x80 | 100), info.texts.length], ['-100', '+100', 201]);
  // the controllers MIDI CTRL 1/2 listen to: OFF, PB, #00-#31, #64-#95
  const cc = E.ALGOS[0].pages.find((p) => p.kind === 'cc');
  const cct = E.pageInfo(0, cc);
  assert.deepEqual([cct.map.get(0x80), cct.map.get(0x60), cct.map.get(0), cct.map.get(31), cct.map.get(64), cct.raws.length], ['OFF', 'PB', '#00', '#31', '#64', 66]);
  const tgt = E.ALGOS[0].pages.find((p) => p.kind === 'ctrl');
  assert.deepEqual(E.pageInfo(0, tgt).texts.slice(0, 3), ['HALL SIZE', 'REV TIME', 'REV DELAY']);
  assert.equal(E.USER_PRESETS.length, 101);
  assert.deepEqual([E.nameOf(E.factoryUser(0)), E.nameOf(E.factoryUser(100))], ['Dark Cave', 'Crunched']);
  assert.deepEqual(E.IDENTITY, [0xf0, 0x7e, 0x0f, 0x06, 0x02, 0x31, 0x00, 0x1c, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf7]);
});

test('EFX-10 blocks: nibbles, XOR checksum, numbers', () => {
  const d = E.factoryUser(3);
  const m = E.blockMessage(0x1e, d, 4);
  assert.equal(m.length, 137);
  assert.deepEqual(m.slice(0, 7), [0xf0, 0x31, 0x14, 0x02, 0x12, 0x01, 0x0e]);
  const b = E.parseBlock(m);
  assert.ok(b.ok);
  assert.equal(b.block, 0x1e);
  assert.deepEqual(Array.from(b.data), Array.from(d));
  const bad = Uint8Array.from(m);
  bad[20] ^= 1;
  assert.equal(E.parseBlock(bad).ok, false);
  const s = E.initialSystem();
  assert.deepEqual(E.systemBlocks(s).map((x) => [x[5], x[6]]), [[0x0f, 0x00], [0x0f, 0x01], [0x0f, 0x02]]);
  assert.deepEqual(E.endMessage(2), [0xf0, 0x31, 0x12, 0x02, 0x45, 0xf7]);
  // the checksum byte 62 a recall checks
  const x = E.withChecksum(d);
  assert.equal(x[62], E.checksum(x));
  assert.equal(E.checksum(E.factoryUser(50)), E.factoryUser(50)[62]);
  assert.match(efx.describe(Uint8Array.from(m)), /preset 031 "Old Library" \(LARGE ROOM\)/);
});

test('EFX-10 preset editor: pages per algorithm, every value of every preset has its text', () => {
  const d = E.romPreset(0);
  assert.equal(E.nameOf(d), 'Large Hall');
  assert.deepEqual([...new Set(visible(eff, d).map((p) => p.group))], ['Preset', 'HALL', 'REVERB', 'LEVELS', 'MIDI CTRL']);
  const alg = eff.params.find((p) => p.key === 'alg');
  writeParam(d, alg, 9);
  assert.match(alg.after(d), /ROM preset 010/);
  assert.deepEqual(Array.from(d.subarray(16, 62)), Array.from(Uint8Array.from(E.ROM_PRESETS[9].data.match(/../g).map((h) => parseInt(h, 16)))).slice(0, 46));
  assert.equal(d[62], E.checksum(d));
  assert.deepEqual([...new Set(visible(eff, d).map((p) => p.group))], ['Preset', 'MONO DELAY', 'LEVELS', 'MIDI CTRL']);
  for (const src of [...Array.from({ length: 27 }, (_, a) => E.romPreset(a)), ...Array.from({ length: 101 }, (_, n) => E.factoryUser(n))]) {
    for (const p of visible(eff, src)) {
      const t = textOf(p, src);
      assert.ok(t !== undefined, `${E.nameOf(src)} ${p.group} ${p.label} ${readParam(src, p)}`);
    }
  }
  E.setName(d, 'My Echo');
  assert.equal(E.titleOf(d), 'My Echo     ');
});

test('EFX-10 MIDI EDIT EXC. messages', () => {
  const d = E.romPreset(0);
  E.unit.program = 5;
  const P = (a, block, label) => E.paramOf(a, page(a, block, label).n);
  const msg = (p, v) => efx.objects[0].sendParam(p, v, d, { channel: 2 });
  assert.deepEqual(msg(P(0, 'HALL', 'SIZE'), 3), [0xf0, 0x31, 0x12, 0x02, 0x03, 0x00, 0x05, 0x01, 0x00, 0x2d, 0x03, 0xf7]);
  assert.deepEqual(msg(P(0, 'REVERB', '^REV TIME$'), 150).slice(7, -1), [0x01, 0x00, 0x0c, 0x01, 0x16]);
  assert.deepEqual(msg(P(0, 'REVERB', '^E.R. LEVEL$'), 80).slice(7, -1), [0x0d, 0x00, 0x02, 80]);
  const cc = E.ALGOS[0].pages.find((p) => p.kind === 'cc');
  assert.deepEqual(msg(E.paramOf(0, cc.n), 0x80).slice(7, -1), [0x00, 0x01, 0x64, 0x7f, d[60]]);
  const fl = E.romPreset(15);
  const res = E.paramOf(15, page(15, 'FLANGER', 'RESONANCE').n);
  assert.deepEqual(efx.objects[0].sendParam(res, 0x80 | 30, fl, {}).slice(7, -1), [0x1e, 0x00, 0x23, 0x40, 30]);
  assert.deepEqual(efx.objects[0].sendParam(res, 4, fl, {}).slice(7, -1), [0x1e, 0x00, 0x23, 0x3f, 124]);
  // the hum canceller's frequency goes through the parser's own scale (table)
  const hc = page(25, 'HUM CANC', 'HC FREQ');
  assert.equal(hc.msg[3], 4);
  const hum = E.romPreset(25);
  const body = efx.objects[0].sendParam(E.paramOf(25, hc.n), 105, hum, {}).slice(7, -1);
  assert.equal(hc.msg[4][body[3]], 105);
  // 100 (55.0 Hz) is not among the values the parser stores: the nearest one is sent
  assert.equal(hc.msg[4][efx.objects[0].sendParam(E.paramOf(25, hc.n), 100, hum, {})[10]], 95);
  // every page with a value has a message (the MIDI CTRL target goes with its controller), except GUITAR
  // MULTI's two PRE DELAY pages: v1.02's parser stores those one byte early (01 00 18 into 52-53, 1B 00 18 into 43)
  const none = [];
  E.ALGOS.forEach((x, a) => x.pages.forEach((pg) => { if (!pg.msg && pg.kind !== 'ctrl') none.push(`${a} ${pg.block} ${pg.label}`); }));
  assert.deepEqual(none, ['20 MODULATION PRE DELAY', '20 REVERB PRE DELAY']);
  assert.equal(efx.objects[0].sendParam(E.paramOf(20, page(20, 'REVERB', 'PRE DELAY').n), 5, E.romPreset(20), {}), null);
});

test('EFX-10 against its simulator: blocks, bulk load, edit buffer, edits, program change, panel dumps', async () => {
  const t = new LoopbackTransport({ id: 'viscount-efx10', model: 'EFX-10', sysex: '31' }, efx);
  const c = new DeviceClient(t, { minGap: 1, timeout: 600 });
  const sim = t.sim;
  const api = { g: { transport: t }, toast: () => {} };
  // identity
  const id = await c.request(Uint8Array.from(E.IDENTITY_REQUEST), { match: (_m, r) => E.isIdentityReply(r) });
  assert.deepEqual(Array.from(id.raw), E.IDENTITY);
  // MIDI EDIT EXC. OFF: a preset block is refused; ON: stored
  const d = E.romPreset(12);
  E.setName(d, 'SENT');
  await c.send(Uint8Array.from(eff.slots.store(0, 3, {}, d)[0]));
  await c.drain();
  assert.notEqual(E.nameOf(sim.state.presets[3]), 'SENT');
  sim.state.system[E.SET_AT + E.S.flags] |= 2;
  for (const m of eff.slots.store(0, 3, {}, d)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(E.nameOf(sim.state.presets[3]), 'SENT');
  assert.equal(sim.state.presets[3][62], E.checksum(sim.state.presets[3]));
  // write and recall: the program change goes through the map
  for (const m of E.writeAndRecall(d, 40, 0)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(sim.state.current, 40);
  assert.equal(E.nameOf(sim.state.edit), 'SENT');
  // MIDI EDIT EXC.: one parameter of the program shown
  E.unit.program = 40;
  const fb = E.paramOf(12, page(12, 'DELAY LEFT', 'FEED').n);
  await c.send(Uint8Array.from(eff.sendParam(fb, 77, d, {})));
  await c.drain();
  assert.equal(readParam(sim.state.edit, fb), 77);
  const time = E.paramOf(12, page(12, 'DELAY LEFT', 'TIME').n);
  await c.send(Uint8Array.from(eff.sendParam(time, 1234, d, {})));
  await c.drain();
  assert.equal(readParam(sim.state.edit, time), 1234);
  // in EDIT, a preset block goes to the edit buffer
  sim.state.mode = 'edit';
  E.setName(d, 'EDITBUF');
  await c.send(Uint8Array.from(E.blockMessage(50, E.withChecksum(d))));
  await c.drain();
  assert.equal(E.nameOf(sim.state.edit), 'EDITBUF');
  assert.notEqual(E.nameOf(sim.state.presets[50 - 27]), 'EDITBUF');
  // MIDI BULK LOAD waiting takes data with MIDI EDIT EXC. OFF
  sim.state.mode = 'bulkload';
  sim.state.system[E.SET_AT + E.S.flags] &= ~2;
  const s = E.initialSystem();
  s[E.MAP_AT + 5] = 60;
  s[E.SET_AT + E.S.flags] = 0x42;
  for (const m of [...E.systemBlocks(s), E.endMessage()]) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(sim.state.system[E.MAP_AT + 5], 60);
  assert.equal(sim.state.display, 'DATA RECEIVED');
  await c.send(Uint8Array.from([0xc0, 5]));
  await c.drain();
  assert.equal(sim.state.current, 60);
  // panel dumps reach the editor's listeners
  const one = eff.slots.fetch(api, 0, 3);
  await sleep(5);
  for (const m of sim.panel('BULK DUMP', 30, 30)) t._reply(m, 1);
  assert.equal(E.nameOf(await one), 'SENT');
  const set = sys.fetch(api);
  await sleep(5);
  sim.panel('BULK DUMP', 0, 0).forEach((m, i) => t._reply(m, 1 + i));
  assert.equal((await set)[E.MAP_AT + 5], 60);
  const names = [];
  const scan = eff.slots.scanBank(api, 0, (i, n) => { names[i] = n; });
  await sleep(5);
  const all = sim.panel('BULK DUMP', 0, 127);
  assert.equal(all.length, efx.panelDump.expect);
  all.forEach((m, i) => t._reply(m, 1 + i));
  await scan;
  assert.deepEqual([names[0], names[3], names[100]], ['Dark Cave', 'SENT', 'Crunched']);
  // the Branch Library splits a complete dump
  const items = efx.libraryItems(all.map((m) => Uint8Array.from(m)));
  assert.equal(items.filter((x) => x.object === 'effect').length, 101);
  assert.equal(items.filter((x) => x.object === 'system').length, 1);
  assert.equal(items.find((x) => x.object === 'system').data[E.MAP_AT + 5], 60);
  c.dispose();
});

test('EFX-10 translator: exact within the family, effects to an algorithm that has them', () => {
  for (let n = 0; n < 101; n += 9) {
    const d = E.factoryUser(n);
    assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), null).data), Array.from(d));
  }
  for (let a = 0; a < 27; a++) assert.equal(eff.toCommon(E.romPreset(a)).kind, 'effect');
  const rv = eff.fromCommon({ model: 1, kind: 'effect', effects: { reverb: { type: 'Plate', time: 0.1, level: 0.5 } } }, E.factoryUser(0));
  assert.equal(E.algOf(rv.data), 7);
  assert.equal(E.pageText(7, page(7, 'REVERB', '^REV TIME$'), rv.data), '2.0s');
  assert.equal(E.nameOf(rv.data), 'Dark Cave');
  const dl = eff.fromCommon({ model: 1, kind: 'effect', effects: { delay: { time: 0.5, feedback: 0.3, level: 1 } } }, null);
  assert.equal(E.algOf(dl.data), 9);
  assert.equal(E.pageText(9, page(9, 'MONO DELAY', '^TIME$'), dl.data), '1490ms');
  assert.equal(E.pickAlgorithm({ chorus: { level: 1 }, reverb: { level: 1 } }), 22);
  assert.equal(E.pickAlgorithm({ modulation: { type: 'PITCH SHIFT' } }), 14);
  assert.equal(E.pickAlgorithm({}), -1);
  const c = eff.toCommon(E.romPreset(21));
  assert.deepEqual([Object.keys(c.effects).sort(), c.extra.family], [['delay', 'reverb'], 'viscount-efx10']);
});

test('EFX-10: registry, catalog and doc', () => {
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/registry.js', 'utf8').includes("'viscount-efx10'"));
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/catalog-data.js', 'utf8').includes('"id": "viscount-efx10"'));
  const doc = fs.readFileSync('z:/MIDIMaster/docs/devices/viscount-efx10.md', 'utf8');
  assert.match(doc, /not checked on hardware/i);
  assert.equal(sys.params.filter((p) => p.key.startsWith('map')).length, 128);
  assert.equal(efx.panelDump.expect, 105);
  assert.equal(efx.isRequest(Uint8Array.from(E.IDENTITY_REQUEST)), false);
});
