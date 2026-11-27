// DX7II from its MIDI code (v1.9, both banks): AMEM packing, system setup, micro tuning, fractional
// scaling, parameter-change numbers (yamaha-dx7ii.js, yamaha-dx7ii-data.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam, byteLength } from '../js/core/model/memmap.js';
import { bulk, bulkHeader, parseBulk } from '../js/devices/defs/yamaha-dx-sysex.js';
import { vcedToVmem, AMEM_KEY, BANK_KEY } from '../js/devices/defs/yamaha-dx.js';
import dx7ii from '../js/devices/defs/yamaha-dx7ii.js';
import dx7s from '../js/devices/defs/yamaha-dx7s.js';
import tx802 from '../js/devices/defs/yamaha-tx802.js';
import * as D2 from '../js/devices/defs/yamaha-dx7ii-data.js';
import * as FW from '../js/devices/defs/yamaha-dx7ii-fw.js';

const objOf = (def, key) => def.objects.find((o) => o.key === key);
/** Every byte of the object covered once (parameters of 2 bytes count both). */
function cover(obj) {
  const n = new Uint8Array(obj.size);
  for (const p of obj.params) for (let i = 0; i < byteLength(p); i++) n[p.offset + i]++;
  return n;
}
const u8 = (m) => Uint8Array.from(m);

test('DX7II AMEM: 35 bytes a voice as the firmware packs (U DCC0/DD40) and unpacks (U E01A/E0D6)', () => {
  const a = new Uint8Array(49);
  a.set([1, 0, 1, 0, 0, 1]); // scaling mode OP6..OP1
  a.set([7, 6, 5, 4, 3, 2], 6); // Ams OP6..OP1
  Object.assign(a, { 12: 3, 13: 1, 14: 1, 15: 2, 16: 12, 17: 9, 18: 3, 19: 7, 20: 1, 21: 12, 47: 5, 48: 1 });
  for (let i = 22; i <= 46; i++) if (i !== 33 && i !== 37) a[i] = i + 40;
  a[33] = 100; a[37] = 50; a[38] = 5;
  const p = D2.packAced(a);
  assert.equal(p.length, 35);
  assert.equal(p[0], 0b100101);
  assert.deepEqual([p[1], p[2], p[3]], [7 | (6 << 3), 5 | (4 << 3), 3 | (2 << 3)]);
  assert.equal(p[4], 3 | 4 | 8 | (7 << 4), 'Peg Rng, LFO mode, Peg Vel, random pitch');
  assert.equal(p[5], 2 | (12 << 2));
  assert.equal(p[6], 9 | (3 << 4));
  assert.equal(p[7], 1 | (12 << 1));
  assert.equal(p[25], 0, 'byte 25 unused');
  assert.equal(p[34], 5 | 8);
  assert.ok(p.every((b) => b < 128));
  assert.deepEqual(D2.unpackAmem(p), a);
  // a value above the maximum table is held to it
  const q = Uint8Array.from(p); q[8] = 127;
  assert.equal(D2.unpackAmem(q)[22], FW.ACED_MAX.items[22]);
  // a voice without additional data: INIT VOICE's, with the operators' DX7 Ams (L BD88)
  const vced = new Uint8Array(155);
  for (let k = 0; k < 6; k++) vced[k * 21 + 14] = k % 4;
  const made = D2.acedFromVoice(vced);
  assert.deepEqual(Array.from(made.subarray(6, 12)), [0, 1, 2, 3, 0, 1]);
  assert.equal(made[16], FW.INIT_ACED.items[16]);
});

test('DX7II bank: the AMEM goes with the VMEM (Branch Library, Store, simulator)', async () => {
  const v = objOf(dx7ii, 'voice');
  const voice = v.init();
  voice[156 + 16] = 7; voice[156 + 47] = 3; // pitch bend range, unison detune
  voice.set([...'AMEM TEST '].map((c) => c.charCodeAt(0)), 145);
  const vmem = new Uint8Array(4096);
  const amem = new Uint8Array(32 * 35);
  for (let i = 0; i < 32; i++) { vmem.set(vcedToVmem(voice), i * 128); amem.set(D2.packAced(voice.subarray(156)), i * 35); }
  const msgs = [u8(bulk(0, 6, amem)), u8(bulk(0, 9, vmem))];
  const items = dx7ii.libraryItems(msgs);
  assert.equal(items.length, 32, 'the AMEM is read with its bank');
  assert.equal(items[5].data[156 + 16], 7);
  assert.equal(items[5].data[156 + 47], 3);
  // without an AMEM the voices get the additional data the DX7II makes
  const alone = dx7ii.libraryItems([msgs[1]]);
  assert.equal(alone[0].data[156 + 16], FW.INIT_ACED.items[16]);
  // Store: the voice into the copies; AMEM first, then the 32 voices
  const data = { [BANK_KEY]: Uint8Array.from(vmem), [AMEM_KEY]: Uint8Array.from(amem) };
  const ctx = { channel: 0, data, loaded: new Set([BANK_KEY]) };
  const nv = Uint8Array.from(voice); nv[156 + 16] = 11;
  const out = v.slots.store(0, 3, ctx, nv);
  assert.deepEqual(out.map((m) => parseBulk(m).format), [6, 9]);
  assert.equal(D2.unpackAmem(parseBulk(out[0]).data.subarray(3 * 35, 4 * 35))[16], 11);
  // the simulator keeps an AMEM received just before the VMEM, and answers format 6
  const sim = dx7ii.simulate();
  msgs.forEach((m) => sim.handle(m));
  sim.handle(u8([0xc0, 2]));
  assert.equal(sim.unit.voice[156 + 47], 3, 'program change recalls the voice with its additional data');
  const ans = sim.handle(u8([0xf0, 0x43, 0x20, 0x06, 0xf7]));
  assert.deepEqual(parseBulk(ans[0]).data, amem);
  const fetched = await v.slots.fetch({ ctx, g: { objectData: data } }, 0, 4);
  assert.equal(fetched[156 + 16], 7);
});

test('DX7II system setup: 85 bytes from the MIDI pages, parameter changes 19h 40h+', () => {
  const sys = objOf(dx7ii, 'system');
  assert.equal(sys.size, 85);
  assert.ok(cover(sys).every((n) => n === 1), 'every byte once');
  const d = sys.init();
  assert.deepEqual(Array.from(d.subarray(0, 21)), [0, 1, 0, 0, 1, 12, 13, 14, 15, 0, 1, 1, 0, 0, 0, 1, 0, 2, 3, 3, 64]);
  const P = (label) => sys.params.find((p) => p.label === label);
  assert.equal(readParam(d, P('Transmit channel')), 0);
  assert.deepEqual(P('Note on/off').options.map(([, t]) => t), ['all', 'odd', 'even']);
  assert.deepEqual(P('PC trns mode').options.map(([, t]) => t), ['off', 'normal', 'programmable']);
  assert.deepEqual(P('Receive block').options.map(([, t]) => t), ['1-32', '33-64']);
  assert.equal(P('MIDI IN control A number').min, 11);
  assert.equal(P('CS1 number').min, 5);
  const ctx = { channel: 2 };
  writeParam(d, P('Transmit channel'), 16);
  assert.deepEqual([d[0], d[1]], [15, 0], 'off as the page stores it');
  assert.deepEqual(sys.sendParam(P('Transmit channel'), 16, d, ctx), [[0xf0, 0x43, 0x12, 0x19, 0x40, 15, 0xf7], [0xf0, 0x43, 0x12, 0x19, 0x41, 0, 0xf7]]);
  writeParam(d, P('Receive block'), 1);
  assert.deepEqual(sys.sendParam(P('Receive block'), 1, d, ctx), [0xf0, 0x43, 0x12, 0x19, 0x4d, 1, 0xf7]);
  assert.deepEqual(sys.sendParam(P('Master tuning'), 64, d, ctx), [0xf0, 0x43, 0x12, 0x04, 0x40, 64, 0xf7]);
  writeParam(d, P('Memory 5'), 99);
  const whole = sys.sendParam(P('Memory 5'), 99, d, ctx);
  assert.equal(parseBulk(whole).header, 'LM  8973S ');
  assert.equal(sys.match(u8(whole)), true);
  assert.equal(sys.receive(u8([0xf0, 0x43, 0x12, 0x19, 0x45, 20, 0xf7]), d, ctx)[5], 20);
  // memory protect off: 19h 53h 0
  const sent = [];
  sys.actions.find((a) => a.label === 'Memory protect off').run({ ctx, send: (m) => sent.push(m), toast: () => {} });
  assert.deepEqual(sent, [[0xf0, 0x43, 0x12, 0x19, 0x53, 0, 0xf7]]);
});

test('DX7II micro tuning: 128 keys in 1/1024 octave, parameter change 18h 7Eh, user tables', async () => {
  const mt = objOf(dx7ii, 'microtuning');
  assert.equal(mt.size, 256);
  assert.ok(cover(mt).every((n) => n === 1));
  const d = mt.init();
  const P = (n) => mt.params[n];
  assert.equal(readParam(d, P(1)), 0, 'C#-2 is 0');
  assert.equal(readParam(d, P(13)), 1024);
  assert.equal(readParam(d, P(69)), 5 * 1024 + 682, 'A3: table 84C0');
  assert.equal(readParam(d, P(0)), readParam(d, P(12)), 'C-2 takes C-1 (L 9C4E)');
  assert.equal(P(69).format(readParam(d, P(69))), 'A3 +0');
  assert.equal(D2.mtText(5 * 1024 + 682 + 10), 'A3 +10');
  assert.equal(D2.mtText(5 * 1024 + 682 - 30), 'A3 -30');
  writeParam(d, P(60), 4200);
  assert.deepEqual(mt.sendParam(P(60), 4200, d, { channel: 1 }), [0xf0, 0x43, 0x11, 0x18, 0x7e, 60, 4200 >> 7, 4200 & 127, 0xf7]);
  assert.equal(readParam(mt.receive(u8([0xf0, 0x43, 0x11, 0x18, 0x7e, 61, 30, 5, 0xf7]), d, { channel: 1 }), P(61)), 30 * 128 + 5);
  const syx = u8(mt.toSyx(d, { channel: 1 }));
  assert.equal(parseBulk(syx).count, 266);
  assert.deepEqual(mt.fromSyx([syx]), d);
  // the table names of the performance (table 859C), the user tables in the Branch Library
  const perf = objOf(dx7ii, 'performance');
  const tbl = perf.params.find((p) => p.label === 'Micro tuning table');
  assert.equal(tbl.options[0][1], 'Preset 1 Equal temperament');
  assert.equal(tbl.options[7][1], 'Preset 8 Vallotti & Young');
  assert.equal(tbl.options[12][1], 'User 2 Programmed tune');
  assert.equal(tbl.options[13][1], 'CRT 1 Cartridge tune');
  const items = dx7ii.libraryItems([u8(bulkHeader(0, D2.mcrym(1), d))]);
  assert.equal(items[0].label, 'Micro tuning user table 2');
  assert.equal(items[0].object, 'microtuning');
  // through the shared model: cents above C-2
  const c = mt.toCommon(d);
  assert.ok(Math.abs(c.cents[69] - 6900) <= 1, 'A3 near 6900 cents (682/1024 octave a step of A)');
  const back = mt.fromCommon({ ...c, extra: undefined });
  assert.equal(readParam(back.data, P(69)), readParam(d, P(69)));
  // the demo unit answers the user table request
  const sim = dx7ii.simulate();
  sim.handle(u8(bulkHeader(0, D2.mcrym(0), d)));
  const ans = sim.handle(u8([0xf0, 0x43, 0x20, 0x7e, ...[...D2.mcrym(0)].map((x) => x.charCodeAt(0)), 0xf7]));
  assert.deepEqual(parseBulk(ans[0]).body, d);
});

test('DX7II fractional scaling: 6 x 41 bytes, two characters a byte, parameter change 18h 7Fh', () => {
  const fk = objOf(dx7ii, 'fractional');
  assert.equal(fk.size, 246);
  assert.ok(cover(fk).every((n) => n === 1));
  assert.deepEqual([0, 1, 2, 39].map(D2.fksKey), [0, 13, 16, 127]);
  const d = fk.init();
  const P = (key) => fk.params.find((p) => p.key === key);
  assert.equal(P('op6_fofs').offset, 0, 'OP6 first');
  assert.equal(P('op1_f39').offset, 245);
  assert.equal(P('op5_f1').label, 'C#-1');
  writeParam(d, P('op6_fofs'), -5);
  assert.equal(d[0], 5);
  writeParam(d, P('op6_fofs'), 20);
  assert.equal(d[0], 148);
  writeParam(d, P('op2_f3'), 200);
  assert.equal(d[4 * 41 + 4], 55, 'stored as 255 minus the level');
  assert.deepEqual(fk.sendParam(P('op2_f3'), 200, d, { channel: 0 }), [0xf0, 0x43, 0x10, 0x18, 0x7f, 4, 4, 0, 55, 0xf7]);
  assert.deepEqual(fk.sendParam(P('op6_fofs'), 20, d, { channel: 0 }), [0xf0, 0x43, 0x10, 0x18, 0x7f, 0, 0, 1, 20, 0xf7]);
  const syx = u8(fk.toSyx(d, { channel: 0 }));
  assert.equal(parseBulk(syx).count, 502);
  assert.deepEqual(Array.from(parseBulk(syx).body.subarray(0, 2)), [0x30 + 9, 0x30 + 4], 'byte 148 as 39h 34h');
  assert.deepEqual(D2.parseFks(syx).body, d);
  assert.deepEqual(fk.fromSyx([syx]), d);
  assert.equal(fk.receive(u8([0xf0, 0x43, 0x10, 0x18, 0x7f, 5, 1, 1, 2, 0xf7]), d, { channel: 0 })[5 * 41 + 1], 130);
  const same = fk.fromCommon(fk.toCommon(d), fk.init());
  assert.deepEqual(same.data, d);
});

test('DX7II performance: foot switch texts, soft pedal range, PCED receive; DX7s and TX802 share it as the firmware says', () => {
  const perf = objOf(dx7ii, 'performance');
  const fs = perf.params.find((p) => p.offset === 10);
  assert.deepEqual(fs.options.map(([, t]) => t), ['Sustain', 'Portamento', 'Key hold', 'Soft']);
  const sr = perf.params.find((p) => p.offset === 12);
  const d = perf.init();
  assert.equal(sr.dynamic(d).hidden, true);
  d[10] = 3;
  assert.equal(sr.dynamic(d).hidden, false);
  assert.equal(perf.receive(u8([0xf0, 0x43, 0x10, 0x19, 15, 70, 0xf7]), d, { channel: 0 })[15], 70);
  assert.ok(objOf(dx7s, 'system') && objOf(dx7s, 'microtuning') && objOf(dx7s, 'fractional'));
  assert.ok(objOf(tx802, 'system').size === 263 && objOf(tx802, 'microtuning').target, 'the TX802 has its own system setup and per-TG micro tuning');
  const tv = objOf(tx802, 'voice');
  const p = tv.params.find((x) => x.key === 'pbr');
  assert.deepEqual(tv.sendParam(p, 2, tv.init(), { channel: 0 }), [0xf0, 0x43, 0x10, 0x18, 16, 2, 0xf7]);
});

test('TX802 system setup: 263 bytes from the SYSTEM pages (v1.5), whole-setup sends', async () => {
  const { _test: T } = await import('../js/devices/defs/yamaha-tx802.js');
  const sys = objOf(tx802, 'system');
  assert.equal(sys.size, 263);
  assert.ok(cover(sys).every((n) => n === 1), 'every byte once');
  const d = sys.init();
  assert.deepEqual(Array.from(d.subarray(0, 13)), [1, 17, 0, 1, 1, 1, 0, 0, 0, 0, 0, 64, 1]);
  assert.equal(d[13 + 64], 64, 'control 64 = Sustain switch');
  assert.equal(d[13 + 3], 0);
  assert.equal(d[135 + 9], 9, 'program 10 selects INT10');
  const P = (label) => sys.params.find((p) => p.label === label);
  assert.equal(P('Control 7').options.find(([v]) => v === d[13 + 7])[1], 'Volume');
  assert.deepEqual(P('Program change').options.slice(0, 3).map(([, t]) => t), ['off', 'norm', 'G1']);
  assert.equal(P('System exclusive device number').options.at(-1)[1], 'all');
  const ctx = { channel: 0 };
  assert.deepEqual(sys.sendParam(P('Voice data receive block'), 1, Object.assign(d, { 2: 1 }), ctx), [0xf0, 0x43, 0x10, 0x19, 0x4d, 1, 0xf7]);
  assert.deepEqual(sys.sendParam(P('Master tuning'), 70, Object.assign(d, { 11: 70 }), ctx), [0xf0, 0x43, 0x10, 0x04, 0x40, 70, 0xf7]);
  const whole = u8(sys.sendParam(P('Control 7'), 0, d, ctx));
  assert.equal(parseBulk(whole).header, 'LM  8952S ');
  assert.equal(parseBulk(whole).count, 273, 'the count includes the header (9FE7: 0211h)');
  const items = tx802.libraryItems([whole]);
  assert.equal(items[0].object, 'system');
  const sim = tx802.simulate();
  sim.handle(whole);
  const ans = sim.handle(u8([0xf0, 0x43, 0x20, 0x7e, ...[...'LM  8952S '].map((x) => x.charCodeAt(0)), 0xf7]));
  assert.deepEqual(parseBulk(ans[0]).body, d);
  assert.deepEqual(T.initSystem(), sys.init());
});

test('TX802 micro tuning and fractional scaling per TG; its AMEM (A974 / A195)', async () => {
  const mt = objOf(tx802, 'microtuning');
  const fk = objOf(tx802, 'fractional');
  assert.ok(mt && fk, 'both edited objects');
  assert.deepEqual(mt.target.options().map(([, l]) => l), ['TG1', 'TG2', 'TG3', 'TG4', 'TG5', 'TG6', 'TG7', 'TG8']);
  const perf = objOf(tx802, 'performance');
  const p = perf.init();
  p[8 + 3] = 5; // TG4 receives on channel 6
  const d = mt.init();
  const key = mt.params[60];
  // without the performance read from the TX802: the plain DX7II key change (to the TG it edits)
  assert.deepEqual(mt.sendParam(key, 0, d, { channel: 0 }), [0xf0, 0x43, 0x10, 0x18, 0x7e, 60, d[120], d[121], 0xf7]);
  // with it: TG4 selected first by re-sending its receive channel unchanged (1Ah 0Bh 05h)
  mt.target.set(3);
  const ctx = { channel: 0, data: { performance: p }, loaded: new Set(['performance']) };
  const out = mt.sendParam(key, 0, d, ctx);
  assert.deepEqual(out[0], [0xf0, 0x43, 0x10, 0x1a, 0x0b, 5, 0xf7]);
  assert.deepEqual(out[1].slice(3, 6), [0x18, 0x7e, 60]);
  assert.equal(fk.sendAll.build(fk.init(), ctx).length, 2);
  // the simulator answers and keeps both; dumps become their objects in the Branch Library
  const sim = tx802.simulate();
  const sent = [];
  const api = { ctx, send: (m) => sent.push(m), request: async (bytes, match) => sim.handle(u8(bytes)).map(u8).find(match) };
  assert.deepEqual(await mt.fetch(api), D2.equalTemperament());
  assert.deepEqual(sent[0], [0xf0, 0x43, 0x10, 0x1a, 0x0b, 5, 0xf7]);
  assert.equal((await fk.fetch(api)).length, D2.FKS_SIZE);
  const items = tx802.libraryItems([u8(mt.toSyx(d, ctx)), u8(fk.toSyx(fk.init(), ctx))]);
  assert.deepEqual(items.map((x) => x.object), ['microtuning', 'fractional']);
  mt.target.set(0);
  // AMEM: the voice bank goes with its additional data, as on the DX7II
  const v = objOf(tx802, 'voice');
  const vmem = new Uint8Array(4096);
  const amem = new Uint8Array(32 * 35);
  const voice = v.init();
  voice[156 + 16] = 9;
  for (let i = 0; i < 32; i++) { vmem.set(vcedToVmem(voice), i * 128); amem.set(D2.packAced(voice.subarray(156)), i * 35); }
  const bankItems = tx802.libraryItems([u8(bulk(0, 6, amem)), u8(bulk(0, 9, vmem))]);
  assert.equal(bankItems.length, 32);
  assert.equal(bankItems[0].data[156 + 16], 9);
  const st = v.slots.store(0, 1, { channel: 0, data: { [BANK_KEY]: Uint8Array.from(vmem), [AMEM_KEY]: Uint8Array.from(amem) }, loaded: new Set([BANK_KEY]) }, voice);
  assert.deepEqual(st.map((m) => parseBulk(m).format), [6, 9]);
});

test('DX7II 64 voices: banks I01-I32, I33-I64 through system bytes 12/13, cartridge C01-C64 by program change', async () => {
  for (const def of [dx7ii, dx7s]) {
    const v = objOf(def, 'voice');
    const s = v.slots;
    assert.deepEqual(s.banks.map(([b]) => b), [0, 1, 2]);
    assert.deepEqual([s.count(0), s.count(1), s.count(2)], [32, 32, 64]);
    assert.deepEqual([s.slotLabel(0, 0), s.slotLabel(1, 0), s.slotLabel(1, 31), s.slotLabel(2, 63)], ['I01', 'I33', 'I64', 'C64']);
    // program change (L A3F6 -> U 8309): 0-63 internal, 64-127 cartridge
    assert.deepEqual(s.recall(1, 4, { channel: 3 }), [0xc3, 36]);
    assert.deepEqual(s.recall(2, 0, { channel: 0 }), [0xc0, 64]);
    assert.equal(v.actions.some((a) => a.label === 'Get 64 voices'), true);
  }
  const v = objOf(dx7ii, 'voice');
  const sim = dx7ii.simulate();
  // the second bank holds other voices
  const other = v.init();
  other.set([...'BANK TWO  '].map((c) => c.charCodeAt(0)), 145);
  other[156 + 16] = 5;
  for (let i = 0; i < 32; i++) sim.unit.banks[1].set(vcedToVmem(other), i * 128);
  sim.unit.amems[1] = new Uint8Array(32 * 35);
  for (let i = 0; i < 32; i++) sim.unit.amems[1].set(D2.packAced(other.subarray(156)), i * 35);
  const sent = [];
  const data = {};
  const loaded = new Set();
  const ctx = { channel: 0, data, loaded };
  const g = { objectData: data, loadedKeys: loaded, connected: true, setObjectData: (k, d) => { data[k] = d; loaded.add(k); }, setBusy: () => {} };
  const api = {
    ctx, g,
    send: (m) => { sent.push(m); sim.handle(u8(m)); },
    request: async (bytes, match) => { sent.push(bytes); return sim.handle(u8(bytes)).map(u8).find(match); },
  };
  // Read names of I33-I64: the system setup first, MIDI out voice bank to 33-64 (19h 4Ch 1), the AMEM and VMEM, back to 1-32
  const names = [];
  await v.slots.scanBank(api, 1, (i, n) => { names[i] = n; });
  assert.equal(names[0], 'BANK TWO');
  assert.deepEqual(sent.filter((m) => m[3] === 0x19), [[0xf0, 0x43, 0x10, 0x19, 0x4c, 1, 0xf7], [0xf0, 0x43, 0x10, 0x19, 0x4c, 0, 0xf7]]);
  assert.equal(sim.unit.sys[12], 0, 'MIDI out voice bank set back');
  assert.ok(loaded.has('system') && loaded.has('voice-bank-2'));
  assert.deepEqual(v.slots.names(1, ctx).slice(0, 1), ['BANK TWO']);
  assert.equal(v.slots.names(0, ctx), null, 'bank 1-32 not read yet');
  // Edit I40: program change 39, then the edit buffer (ACED, VCED)
  sent.length = 0;
  const d = await v.slots.fetch(api, 1, 7);
  assert.deepEqual(sent[0], [0xc0, 39]);
  assert.equal(d[156 + 16], 5);
  // Store into I35: receive block to 33-64 (19h 4Dh 1), AMEM, VMEM, receive block back
  assert.equal(v.slots.writable(1, ctx), true);
  assert.equal(v.slots.writable(2, ctx), false, 'no bulk for the cartridge');
  const nv = Uint8Array.from(other);
  nv.set([...'STORED    '].map((c) => c.charCodeAt(0)), 145);
  const out = v.slots.store(1, 2, ctx, nv);
  assert.deepEqual(out[0], [0xf0, 0x43, 0x10, 0x19, 0x4d, 1, 0xf7]);
  assert.deepEqual(out.slice(1, 3).map((m) => parseBulk(m).format), [6, 9]);
  assert.deepEqual(out[3], [0xf0, 0x43, 0x10, 0x19, 0x4d, 0, 0xf7]);
  out.forEach((m) => sim.handle(u8(m)));
  sim.handle(u8([0xc0, 34]));
  assert.equal(String.fromCharCode(...sim.unit.voice.subarray(145, 155)), 'STORED    ');
  assert.equal(sim.unit.banks[0][2 * 128 + 118], 'I'.charCodeAt(0), 'bank 1-32 untouched');
  // a bulk the unit sends by itself is its MIDI out voice bank's
  data.system[12] = 1;
  v.receive(u8(bulk(0, 9, sim.unit.banks[0])), v.init(), ctx);
  assert.equal(data['voice-bank-2'][118], 'I'.charCodeAt(0));
  // the cartridge: Play and Edit by program change 65-128, names by selecting each
  sent.length = 0;
  await v.slots.fetch(api, 2, 0);
  assert.deepEqual(sent[0], [0xc0, 64]);
  assert.match(v.slots.note(2, ctx), /program change 65-128/);
  assert.equal(v.slots.scannable(2, ctx), true);
});

test('DX7s: its own page labels, value texts, ranges, performance and system pages (v1.3 tables 9B1C / 9BCD)', async () => {
  const { microText, csText, SYS_INIT_DX7S } = await import('../js/devices/defs/yamaha-dx7s-data.js');
  const v = objOf(dx7s, 'voice');
  const P = (k) => v.params.find((p) => p.key === k);
  assert.deepEqual(['als', 'fbl', 'opi', 'trnp', 'op1_pc', 'op1_pf', 'op1_pd', 'op1_rs', 'op1_tl', 'op1_kvs', 'lpms', 'lfw', 'pr1'].map((k) => P(k).label),
    ['Algorithm select', 'Feedback', 'Osc key sync', 'Middle C', 'F-coarse', 'F-fine', 'Osc detune', 'Rate scaling', 'Output level', 'Key velocity', 'P mod sens.', 'LFO wave', 'PEGR1']);
  assert.deepEqual(P('op2_lc').options.map(([, t]) => t), ['-LIN', '-EXP', '+EXP', '+LIN']);
  assert.deepEqual(P('op3_scm').options.map(([, t]) => t), ['nomal', 'frac.']);
  assert.equal(P('op4_ams7').label, 'A mod sens.');
  assert.deepEqual(P('ltrg').options.map(([, t]) => t), ['Single', 'Multi']);
  assert.deepEqual(P('pbm').options.map(([, t]) => t), ['Normal', 'Lowest', 'Highest', 'Key-on']);
  const d = v.init();
  d[156 + 15] = 1; // mono
  assert.deepEqual(P('porm').dynamic(d).options.map(([, t]) => t), ['Fingerd porta', 'Full time porta']);
  assert.equal(P('fc2_vol').label, 'FC2 volume');
  assert.equal(P('at_pbias').max, 100);
  // the DX7II keeps its own
  assert.equal(objOf(dx7ii, 'voice').params.find((p) => p.key === 'als').label, 'Alg');
  // performance: what the DX7s shows; micro tune 0-75 (CRT 1-63), key for tables 1-4
  const pf = objOf(dx7s, 'performance');
  const Q = (k) => pf.params.find((p) => p.key === k);
  assert.equal(Q('p3').max, 75);
  assert.equal(microText(0), '1:Equal');
  assert.equal(microText(11), '12:User1 [INT1]');
  assert.equal(microText(75), '76:User65 [CRT63]');
  const pd = pf.init();
  pd[3] = 2;
  assert.equal(Q('p4').dynamic(pd).options[0][1], 'A', 'Pure(minor) names the minor key');
  pd[3] = 0;
  assert.equal(Q('p4').dynamic(pd).hidden, true);
  assert.equal(csText(22), 'Freq coarse OP1');
  assert.equal(csText(105), 'Total level OP6');
  assert.ok(['p0', 'p2', 'p6', 'p7', 'p15', 'p20', 'p30'].every((k) => Q(k).readOnly));
  assert.equal(objOf(dx7ii, 'performance').params.find((p) => p.key === 'p3').max, 74);
  // system: Trns ch off = 16 (one byte), Exclusive / Device number separate
  const sys = objOf(dx7s, 'system');
  assert.ok(cover(sys).every((n) => n === 1), 'every byte once');
  assert.deepEqual(Array.from(sys.init()), SYS_INIT_DX7S);
  const S = (label) => sys.params.find((p) => p.label === label);
  const sd = sys.init();
  writeParam(sd, S('Trns ch'), 16);
  assert.equal(sd[0], 16);
  assert.deepEqual(sys.sendParam(S('Trns ch'), 16, sd, { channel: 0 }), [0xf0, 0x43, 0x10, 0x19, 0x40, 16, 0xf7]);
  assert.deepEqual(S('PC trns').options.map(([, t]) => t), ['off', 'Normal', 'Memory']);
  assert.equal(S('Byte 19 (DX7II)').readOnly, true);
});

test('TX802 64 voices: blocks I01-I32 / I33-I64 through the Voice data receive block, program changes per TG', async () => {
  const { tx802VoiceByte, tgsOnChannel, _test: T } = await import('../js/devices/defs/yamaha-tx802.js');
  const v = objOf(tx802, 'voice');
  const s = v.slots;
  assert.deepEqual(s.banks.map(([b]) => b), [0, 1, 2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map((b) => s.count(b)), [32, 32, 64, 64, 64]);
  assert.deepEqual([s.slotLabel(0, 0), s.slotLabel(1, 31), s.slotLabel(2, 0), s.slotLabel(3, 63), s.slotLabel(4, 1)], ['I01', 'I64', 'C01', 'A64', 'B02']);
  // the performance's voice byte: bits 7-6 = I, C, A, B (FECF)
  assert.deepEqual([tx802VoiceByte(1, 0), tx802VoiceByte(2, 0), tx802VoiceByte(3, 5), tx802VoiceByte(4, 63)], [32, 0x40, 0x85, 0xff]);
  // without the performance: a program change (the TG keeps its bank, 9A42)
  assert.deepEqual(s.recall(1, 4, { channel: 3 }), [0xc3, 36]);
  assert.deepEqual(s.recall(3, 4, { channel: 3 }), [0xc3, 4]);
  // with it: the voice of each group on the channel through the performance (1Ah 10h + TG, two bytes)
  const perf = T.initPerf();
  perf.set([0, 1, 1, 3, 3, 3, 6, 7], 0); // groups TG1, TG2(+3), TG4(+5,6), TG7, TG8
  perf.set([0, 2, 2, 2, 2, 2, 5, 16], 8); // receive channels
  assert.deepEqual(tgsOnChannel(perf, 2), [1, 3, 7], 'heads on channel 3 and the omni TG');
  const sent = [];
  const data = { performance: perf };
  const loaded = new Set(['performance']);
  const ctx = { channel: 2, data, loaded };
  assert.deepEqual(s.recall(3, 5, ctx), [1, 3, 7].map((t) => [0xf0, 0x43, 0x12, 0x1a, 0x10 + t, 1, 0x05, 0xf7]));
  assert.match(s.note(3, ctx), /TG2, TG4, TG8/);
  // Read names of I33-I64: system setup first, receive block to 33-64 (19h 4Dh 1), AMEM and VMEM, back to 1-32
  const sim = tx802.simulate();
  const other = v.init();
  other.set([...'BLOCK TWO '].map((c) => c.charCodeAt(0)), 145);
  for (let i = 0; i < 32; i++) sim.unit.banks[1].set(vcedToVmem(other), i * 128);
  const g = { objectData: data, loadedKeys: loaded, connected: true, setObjectData: (k, d) => { data[k] = d; loaded.add(k); }, setBusy: () => {} };
  const api = { ctx, g, send: (m) => { const list = Array.isArray(m[0]) ? m : [m]; list.forEach((x) => { sent.push(x); sim.handle(u8(x)); }); }, request: async (bytes, match) => { sent.push(bytes); return sim.handle(u8(bytes)).map(u8).find(match); } };
  const names = [];
  await s.scanBank(api, 1, (i, n) => { names[i] = n; });
  assert.equal(names[0], 'BLOCK TWO');
  assert.deepEqual(sent.filter((m) => m[3] === 0x19), [[0xf0, 0x43, 0x12, 0x19, 0x4d, 1, 0xf7], [0xf0, 0x43, 0x12, 0x19, 0x4d, 0, 0xf7]]);
  assert.equal(sim.unit.sys802[2], 0, 'receive block set back');
  assert.ok(loaded.has('voice-bank-2'));
  // Store into I35: the same switch around the AMEM and VMEM
  const out = s.store(1, 2, ctx, other);
  assert.deepEqual(out[0], [0xf0, 0x43, 0x12, 0x19, 0x4d, 1, 0xf7]);
  assert.deepEqual(out.slice(1, 3).map((m) => parseBulk(m).format), [6, 9]);
  assert.deepEqual(out[3], [0xf0, 0x43, 0x12, 0x19, 0x4d, 0, 0xf7]);
  assert.equal(s.writable(3, ctx), false, 'no bulk for the preset banks');
  // Edit A06: the voice into TG2 (the first group on the channel), then the TG's edit buffer
  sent.length = 0;
  await s.fetch(api, 3, 5);
  assert.deepEqual(sent[0], [0xf0, 0x43, 0x12, 0x1a, 0x11, 1, 0x05, 0xf7]);
  assert.deepEqual(sent.slice(1).map((m) => m[3]), [5, 0], 'ACED then VCED requested');
});
