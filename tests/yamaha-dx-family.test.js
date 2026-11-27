// The DX family models built on the DX7 code (yamaha-dx.js): TX7, ...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { patchFromObject, loadMode } from '../js/devices/patches.js';
import { getDevice } from '../js/devices/registry.js';
import { bulk, parseBulk, paramChange, dumpRequest } from '../js/devices/defs/yamaha-dx-sysex.js';
import dx7 from '../js/devices/defs/yamaha-dx7.js';
import tx7, { _test as TX7 } from '../js/devices/defs/yamaha-tx7.js';
import dx7iiDef from '../js/devices/defs/yamaha-dx7ii.js';

const objOf = (def, key) => def.objects.find((o) => o.key === key);
const cover = (obj) => {
  const bits = new Uint8Array(obj.size);
  for (const p of obj.params) {
    const mask = p.bits ? ((1 << p.bits) - 1) << (p.shift || 0) : 0xff;
    assert.equal(bits[p.offset] & mask, 0, `${obj.key} ${p.key} overlaps`);
    bits[p.offset] |= mask;
  }
  return bits;
};

test('TX7: DX7 voice, function data with the TX7 texts, requests answered', () => {
  const v = objOf(tx7, 'voice');
  assert.deepEqual(v.params.map((p) => p.label), objOf(dx7, 'voice').params.map((p) => p.label), 'the DX7 voice labels');
  const perf = objOf(tx7, 'performance');
  assert.ok(cover(perf).every((b) => b !== 0), 'every function data byte');
  const d = perf.init();
  assert.equal(d.length, 94);
  assert.equal(String.fromCharCode(...d.subarray(64, 94)), ' YAMAHA  TX7  FUNCTION  DATA  ', 'the 30 characters at C87C');
  const porta = perf.params.find((p) => p.label === 'PORTA mode');
  assert.deepEqual(porta.dynamic(d).options.map(([, t]) => t), ['RTN', 'FLW']);
  d[2] = 1;
  assert.deepEqual(porta.dynamic(d).options.map(([, t]) => t), ['FGD', 'FUL']);
  const range = perf.params.find((p) => p.label === 'MW= (range)');
  writeParam(d, range, 12);
  assert.deepEqual(perf.sendParam(range, 12, d, { channel: 1 }), paramChange(1, 1, 9, 12));
  // requests: the simulator answers like the TX7
  const sim = tx7.simulate();
  const [voice] = sim.handle(Uint8Array.from(dumpRequest(0, 0)));
  assert.equal(v.match(Uint8Array.from(voice)), true);
  assert.equal(readParam(v.decode(Uint8Array.from(voice)), v.params.find((p) => p.key === 'trnp')), 24);
  const [bank] = sim.handle(Uint8Array.from(dumpRequest(0, 9)));
  assert.equal(parseBulk(bank).data.length, 4096);
  sim.handle(Uint8Array.from(bulk(0, 1, d)));
  const [back] = sim.handle(Uint8Array.from(dumpRequest(0, 1)));
  assert.equal(perf.match(Uint8Array.from(back)), true);
  assert.equal(perf.decode(Uint8Array.from(back))[9], 12);
  // library: function data is a performance; plain voices prefer the DX7
  const items = tx7.libraryItems([Uint8Array.from(bulk(0, 1, d))]);
  assert.equal(items[0].object, 'performance');
  assert.ok(tx7.prefer([Uint8Array.from(bulk(0, 1, d))]) > dx7.prefer([Uint8Array.from(bulk(0, 1, d))]));
  assert.ok(tx7.prefer([Uint8Array.from(voice)]) < dx7.prefer([Uint8Array.from(voice)]));
});

test('TX7 system: the 7Dh answer "LM  8951  " (E2F7) read, settings sent as parameter changes (DF0F, C85E)', () => {
  const sys = objOf(tx7, 'system');
  assert.ok(sys && !sys.toSyx, 'the TX7 takes no 7Dh bulk');
  const P = (l) => sys.params.find((p) => p.label === l);
  const c = { channel: 2 };
  const d = sys.init();
  assert.equal(d[P('MEM. PROTECT').offset], 0, 'shown off');
  // F0 43 1n 11 pp vv F7: group 4, number 80h + pp
  d[P('MEM. PROTECT').offset] = 1;
  assert.deepEqual(sys.sendParam(P('MEM. PROTECT'), 1, d, c), [0xf0, 0x43, 0x12, 0x11, 0x07, 1, 0xf7]);
  assert.deepEqual(sys.sendParam(P('SP H'), 127, d, c), [0xf0, 0x43, 0x12, 0x11, 0x05, 127, 0xf7]);
  d[P('MIDI RCV.CH.').offset] = 4;
  assert.deepEqual(sys.sendParam(P('MIDI RCV.CH.'), 4, d, c), paramChange(2, 1, 1, 5));
  assert.deepEqual(sys.sendParam(P('MASTER TUNE'), 64, d, c), paramChange(2, 1, 0x40, 64));
  d[P('OMNI MODE').offset] = 1;
  assert.deepEqual(sys.sendParam(P('OMNI MODE'), 1, d, c), [0xb2, 0x7d, 0]);
  assert.equal(P('BATTERY VOLT').readOnly, true);
  assert.equal(P('BATTERY VOLT').format(28), '2.8 V');
  // the simulator answers like E2F7: header, 01 04, flags (bit 6 = 7B68 ... bit 0 = 7B6E), channel, battery, volume
  const sim = tx7.simulate();
  sim.handle(Uint8Array.from(paramChange(0, 4, 0x87, 1))); // MEM. PROTECT on
  sim.handle(Uint8Array.from(paramChange(0, 1, 1, 3))); // MIDI RCV.CH. 3
  const [ans] = sim.handle(Uint8Array.from(dumpRequest(0, 0x7d)));
  const b = parseBulk(ans);
  assert.equal(b.format, 0x7d);
  assert.equal(String.fromCharCode(...b.data.subarray(0, 12)), 'LM  8951  \x01\x04');
  assert.equal(sys.match(Uint8Array.from(ans)), true);
  const got = sys.decode(Uint8Array.from(ans));
  assert.equal(got[P('MEM. PROTECT').offset], 1);
  assert.equal(got[P('MIDI RCV.CH.').offset], 2);
  assert.equal(got[P('CTL.CHNG.RCV.').offset], 1);
  assert.equal(tx7.libraryItems([Uint8Array.from(ans)])[0].object, 'system');
});

test('DX7 <-> TX7: voices load natively, function data through the translator', () => {
  const dv = objOf(dx7, 'voice');
  const data = dv.init();
  data[134] = 21;
  const patch = patchFromObject(getDevice('yamaha-dx7'), dx7, dv, data);
  assert.equal(loadMode(getDevice('yamaha-tx7'), tx7, objOf(tx7, 'voice'), patch), 'native');
  assert.deepEqual(objOf(tx7, 'voice').fromCommon(patch.common, objOf(tx7, 'voice').init()).data, data);
  const perf = objOf(tx7, 'performance');
  const d = perf.init();
  d[0] = 7; d[2] = 1; d[3] = 5;
  const p = patchFromObject(getDevice('yamaha-tx7'), tx7, perf, d);
  assert.equal(p.common.voice.mode, 'mono');
  assert.deepEqual(perf.fromCommon(p.common).data, d);
  const other = perf.fromCommon({ kind: 'performance', parts: [{ program: 3, level: 1 }], voice: { mode: 'poly', bendUp: 2 } });
  assert.equal(other.data[0], 3);
  assert.equal(other.data[3], 2);
});

test('DX7II: voice with its additional data (ACED) and the performance, from the v1.9 firmware', async () => {
  const dx7ii = (await import('../js/devices/defs/yamaha-dx7ii.js')).default;
  const dx7s = (await import('../js/devices/defs/yamaha-dx7s.js')).default;
  const FW2 = await import('../js/devices/defs/yamaha-dx7ii-fw.js');
  const v = objOf(dx7ii, 'voice');
  const perf = objOf(dx7ii, 'performance');
  assert.equal(v.size, 205);
  assert.ok(cover(v).every((b, i) => b !== 0 || i === 155), 'every voice byte');
  assert.ok(cover(perf).every((b) => b !== 0), 'every performance byte');
  const d = v.init();
  assert.equal(String.fromCharCode(...d.subarray(145, 155)), 'INIT VOICE');
  const P = (key) => v.params.find((p) => p.key === key);
  assert.equal(readParam(d, P('pbr')), 2, 'INIT VOICE: pitch bend range 2 (ACED 16)');
  assert.equal(readParam(d, P('bc_pbias')), 50);
  assert.equal(P('pbr').max, 12);
  assert.equal(P('op1_ams7').max, 7);
  assert.deepEqual(P('pmod').options.map(([, t]) => t), ['polyphonic', 'monophonic', 'unison poly', 'unison mono']);
  assert.deepEqual(P('porm').dynamic(d).options.map(([, t]) => t), ['sus-key p retain', 'sus-key p follow']);
  assert.deepEqual(P('op2_lc').options.map(([, t]) => t), ['-lin', '-exp', '+exp', '+lin']);
  assert.equal(P('op3_r2').label, 'R2');
  assert.deepEqual(FW2.HEADERS.items.find((h) => h.header === 'LM  8973PE').count, 61);
  // messages: ACED parameter change (group 6; bytes 39-48 are numbers 40h-49h, U E672), the voice as ACED + VCED
  const ctx = { channel: 0 };
  writeParam(d, P('udtn'), 5);
  assert.deepEqual(v.sendParam(P('udtn'), 5, d, ctx), [0xf0, 0x43, 0x10, 0x18, 0x48, 5, 0xf7]);
  assert.deepEqual(v.sendParam(P('pbr'), 2, d, ctx), [0xf0, 0x43, 0x10, 0x18, 16, 2, 0xf7]);
  assert.equal(v.receive(Uint8Array.from([0xf0, 0x43, 0x10, 0x18, 0x48, 6, 0xf7]), d, ctx)[156 + 47], 6);
  const sent = v.sendAll.build(d, ctx);
  assert.deepEqual(sent.map((m) => parseBulk(m).format), [5, 0]);
  assert.deepEqual(v.fromSyx(sent.map((m) => Uint8Array.from(m))), d);
  const items = dx7ii.libraryItems(sent.map((m) => Uint8Array.from(m)));
  assert.equal(items.length, 1);
  assert.equal(items[0].data[156 + 47], 5);
  // reading it back: the simulator answers the ACED and VCED requests
  const sim = dx7ii.simulate();
  sent.forEach((m) => sim.handle(Uint8Array.from(m)));
  const api = { ctx, request: async (bytes, match) => { const r = sim.handle(Uint8Array.from(bytes)).map((x) => Uint8Array.from(x)).find(match); return r; } };
  assert.deepEqual(await v.fetch(api), d);
  // performance: header LM  8973PE, parameter change 19h (U E6AF)
  const p = perf.init();
  assert.equal(String.fromCharCode(...p.subarray(31, 51)).trim(), 'INIT PERF');
  const mode = perf.params.find((x) => x.label === 'Voice mode');
  assert.deepEqual(mode.options.map(([, t]) => t), ['single', 'dual', 'split']);
  assert.deepEqual(perf.sendParam(perf.params.find((x) => x.label === 'Dual detune'), 3, Object.assign(p, { 6: 3 }), ctx), [0xf0, 0x43, 0x10, 0x19, 6, 3, 0xf7]);
  const pm = Uint8Array.from(perf.toSyx(p, ctx));
  assert.equal(perf.match(pm), true);
  assert.equal(perf.params.find((x) => x.label === 'Continuous slider 1').options[22][1], 'Frequency coarse OP1');
  // DX7 <-> DX7II through the shared model
  const dv = objOf(dx7, 'voice');
  const dx7data = dv.init(); dx7data[134] = 30;
  const fromDx7 = v.fromCommon(patchFromObject(getDevice('yamaha-dx7'), dx7, dv, dx7data).common, v.init());
  assert.deepEqual(fromDx7.data.subarray(0, 156), dx7data);
  assert.ok(fromDx7.report.approximated.some((x) => /ACED/.test(x)));
  const back = dv.fromCommon(patchFromObject(getDevice('yamaha-dx7ii'), dx7ii, v, d).common, dv.init());
  assert.deepEqual(back.data, d.subarray(0, 156));
  assert.ok(back.report.dropped.some((x) => /ACED/.test(x)));
  // the DX7s keeps one voice per performance
  const sp = objOf(dx7s, 'performance');
  const r = sp.fromCommon({ kind: 'performance', keyMode: 'layer', parts: [{ program: 3 }, { program: 9 }] });
  assert.equal(r.data[1], 3);
  assert.equal(r.data[0], 0);
  assert.ok(r.report.dropped.length);
});

test('TX802 and DX9: the DX7II and DX7 voice formats, with their own data kept', async () => {
  const tx802 = (await import('../js/devices/defs/yamaha-tx802.js')).default;
  const dx9 = (await import('../js/devices/defs/yamaha-dx9.js')).default;
  const { bulkHeader } = await import('../js/devices/defs/yamaha-dx-sysex.js');
  assert.deepEqual(tx802.objects.map((o) => o.key), ['voice', 'performance', 'system', 'microtuning', 'fractional'], 'the TX802\'s own performance, not the DX7II\'s; micro tuning and fractional scaling per TG');
  assert.equal(objOf(tx802, 'voice').size, 205);
  const sys = Uint8Array.from(bulkHeader(0, 'LM  8952S ', new Uint8Array(263)));
  assert.equal(tx802.recognise(sys), true);
  assert.equal(tx802.libraryItems([sys])[0].label, 'System setup');
  assert.ok(tx802.prefer([sys]) > 3);
  const v9 = objOf(dx9, 'voice');
  assert.equal(v9.size, 156);
  assert.match(v9.params.find((p) => p.key === 'op1_r1').help, /Not used by the DX9/);
  assert.doesNotMatch(v9.params.find((p) => p.key === 'op6_r1').help || '', /Not used/);
  assert.match(v9.params.find((p) => p.key === 'pr1').help, /Not used by the DX9/, 'no pitch EG');
  assert.doesNotMatch(v9.params.find((p) => p.key === 'als').help || '', /Not used/);
  assert.ok(dx9.prefer([]) < dx7.prefer([]), 'a plain DX7 dump reads as a DX7');
});

test('TX802 performance: eight TGs from the v1.5 firmware, ASCII-hex dumps, links, MIDI channels page', async () => {
  const mod = await import('../js/devices/defs/yamaha-tx802.js');
  const { _test: T } = mod;
  const tx802 = mod.default;
  const perf = objOf(tx802, 'performance');
  assert.ok(cover(perf).every((b) => b === 0xff), 'every one of the 116 bytes is a parameter');
  // INIT (data ROM 0E00): the same twelve values for every TG
  const d = T.initPerf();
  assert.deepEqual(Array.from(d.subarray(0, 96)), [0, 0, 0, 7, 90, 3, 0, 127, 24, 0, 0, 0].flatMap((v) => Array(8).fill(v)));
  assert.equal(String.fromCharCode(...d.subarray(96)), 'Init perf           ');
  // The edit buffer: count 0168h (data only), the checksum over header and data (A9DD / 9FA4)
  d[16 + 3] = 0xc5; // TG4 voice: bits 7-6 = 3 (bank B), bits 5-0 = 5 (B06)
  const m = T.tx802Bulk(5, T.PE, d);
  assert.deepEqual(m.slice(0, 6), [0xf0, 0x43, 5, 0x7e, 0x01, 0x68]);
  assert.equal(String.fromCharCode(...m.slice(6, 16)), 'LM  8952PE');
  assert.equal(String.fromCharCode(...m.slice(16, 20)), '0000');
  assert.deepEqual(Array.from(T.parseTx802(m).body), Array.from(d));
  assert.equal(perf.match(m), true);
  const bad = m.slice(); bad[20] = 0x67; // a lower-case hex digit is not the TX802's
  assert.equal(T.parseTx802(bad), null);
  // The 84-byte packed memory (C84F / C921) round-trips every value at its maximum and minimum
  for (const fill of [0, 1]) {
    const x = T.initPerf();
    perf.params.forEach((p) => { if (!p.hidden && p.offset >= 8) x[p.offset] = fill ? p.max : p.min; });
    assert.deepEqual(Array.from(T.unpackPerf(T.packPerf(x))), Array.from(x));
  }
  const pm = T.tx802Bulk(0, T.PM, T.packPerf(d));
  assert.deepEqual(pm.slice(4, 6), [0x01, 0x28]);
  const items = tx802.libraryItems([pm, pm, m]);
  assert.deepEqual(items.map((i) => i.label), ['01 Init perf', '02 Init perf', 'Performance "Init perf"']);
  assert.deepEqual(Array.from(items[0].data), Array.from(d));
  // Labels and value lists from the screens
  const byKey = (k) => perf.params.find((p) => p.key === k);
  const show = (k, v) => byKey(k).options.find(([x]) => x === v)?.[1];
  assert.equal(show('t3_2', 0xc5), 'B06');
  assert.equal(show('t0_2', 0), 'I01');
  assert.equal(show('t0_2', 64), 'C01');
  assert.equal(show('t0_1', 16), 'omni');
  assert.equal(show('t0_6', 60), 'C3');
  assert.equal(show('t0_5', 3), 'I+II');
  assert.equal(show('t0_11', 0x15), 'Pure/major F');
  assert.equal(show('t0_11', 0x20), 'Pure/minor A');
  assert.equal(show('t0_11', 0xb1), 'Internal 2');
  assert.equal(show('t0_11', 0xfe), 'Cartridge 63');
  assert.equal(byKey('t0_3').format(0), '-7');
  assert.equal(byKey('t0_8').format(48), '+24');
  assert.equal(byKey('t2_6').dynamic(Object.assign(T.initPerf(), { 82: 1 })).readOnly, true, 'note limits do not apply in alternate assign');
  // Parameter changes: number = byte; voice and micro tuning take two data bytes (A6E2 / A35C)
  assert.deepEqual(T.perfParam(1, 0x13, 0xc5), [0xf0, 0x43, 0x11, 0x1a, 0x13, 1, 0x45, 0xf7]);
  assert.deepEqual(T.perfParam(1, 0x22, 99), [0xf0, 0x43, 0x11, 0x1a, 0x22, 99, 0xf7]);
  assert.deepEqual(perf.sendParam(byKey('t1_11'), 0, Object.assign(T.initPerf(), { 89: 0xb0 }), { channel: 0 }), [0xf0, 0x43, 0x10, 0x1a, 0x59, 1, 0x30, 0xf7]);
  // Links (8DED): TG link changes toggle a group start, and the following TGs follow
  const l = T.initPerf();
  T.applyPerfParam(l, 3, 0);
  assert.deepEqual(Array.from(l.subarray(0, 8)), [0, 0, 0, 3, 3, 3, 3, 3]);
  T.applyPerfParam(l, 6, 0);
  assert.deepEqual(Array.from(l.subarray(0, 8)), [0, 0, 0, 3, 3, 3, 6, 6]);
  T.applyPerfParam(l, 3, 0);
  assert.deepEqual(Array.from(l.subarray(0, 8)), [0, 0, 0, 0, 0, 0, 6, 6]);
  const link = byKey('t4_0');
  assert.deepEqual(link.dynamic(l).options.map(([v]) => v), [4, 0]);
  writeParam(l, link, 4);
  assert.deepEqual(Array.from(l.subarray(0, 8)), [0, 0, 0, 0, 4, 4, 6, 6], 'the editor links like the unit');
  assert.deepEqual(perf.sendParam(link, 4, l, { channel: 0 }), [0xf0, 0x43, 0x10, 0x1a, 4, 0, 0xf7]);
  // The demo unit answers like the TX802
  const sim = tx802.simulate();
  sim.handle(T.perfParam(0, 0x13, 0xc5));
  sim.handle(T.perfParam(0, 0x05, 0));
  const [ans] = sim.handle([0xf0, 0x43, 0x20, 0x7e, ...[...T.PE].map((c) => c.charCodeAt(0)), 0xf7]);
  const got = T.parseTx802(ans).body;
  assert.equal(got[0x13], 0xc5);
  assert.deepEqual(Array.from(got.subarray(0, 8)), [0, 0, 0, 0, 0, 5, 5, 5]);
  // MIDI channels page: the group starts play; Head Library round trip
  assert.equal(perf.multi.on(5, got), true);
  assert.equal(perf.multi.on(6, got), false);
  const c = perf.toCommon(got);
  assert.equal(c.parts.length, 2);
  assert.deepEqual(Array.from(perf.fromCommon(c).data), Array.from(got));
  const fromTx81z = perf.fromCommon({ kind: 'performance', keyMode: 'multi', parts: [{ program: 3, channel: 0 }, { program: 70, channel: 1, transpose: 12 }, { program: 9, channel: 2, on: false }] });
  assert.deepEqual(Array.from(fromTx81z.data.subarray(0, 8)), [0, 0, 0, 0, 4, 4, 4, 4]);
  assert.equal(fromTx81z.data[16 + 4], 70);
  assert.equal(fromTx81z.data[64 + 4], 36);
  assert.equal(tx802.describe(T.perfParam(0, 0x5a, 0xc3)), 'TX802 performance parameter ch 1: TG3 parameter 11 = 195');
  // Its voice: ACED bytes 39-48 and the pitch bend mode are not the TX802's; key mode poly / mono
  const v = objOf(tx802, 'voice');
  const aced = (n) => v.params.find((p) => p.aced === n);
  assert.ok([39, 43, 47, 48, 18].every((n) => aced(n).readOnly));
  assert.ok(!aced(38).readOnly && !aced(16).readOnly);
  assert.deepEqual(aced(15).options.slice(0, 2), [[0, 'poly'], [1, 'mono']]);
  assert.ok(!objOf(dx7iiDef, 'voice').params.find((p) => p.aced === 39).readOnly, 'the DX7II keeps them');
  assert.ok(!v.layout.find((l) => l.group === 'Controllers').rows.some((r) => /MIDI IN/.test(r.label)));
});

test('DX5 names for the 94-byte function data: the TX7\'s read-only bytes', () => {
  const perf = objOf(tx7, 'performance');
  const at = (o) => perf.params.filter((p) => p.offset === o);
  assert.equal(at(1)[0].label, 'Source (DX5)');
  assert.equal(at(28)[0].label, 'Sus pdl (DX5)');
  assert.equal(at(29)[0].format(24), '0');
  assert.equal(at(60)[0].label, 'Key assign (DX5)');
  assert.deepEqual(at(60)[0].options.map(([, t]) => t), ['SNGL', 'DUAL', 'SPLT']);
  assert.equal(at(63)[0].options.find(([v]) => v === 39)[1], 'C3', 'the TX7\'s fixed split point 39 is C3');
  assert.match(at(20)[0].help, /DX1/);
  assert.ok([1, 8, 20, 27, 28, 29, 32, 40, 60, 63, 64].every((o) => at(o).every((p) => p.readOnly)));
  assert.ok([2, 3, 9, 10, 26].every((o) => at(o).every((p) => !p.readOnly)), 'the bytes the TX7 reads stay editable');
  assert.equal(at(40).length, 3, 'channel B\'s Mod EAP as three bits');
});

test('TX816: TF1 modules (function data with key limits in the name, Modules page, status)', async () => {
  const { default: tx816, _test: T } = await import('../js/devices/defs/yamaha-tx816.js');
  assert.deepEqual(tx816.objects.map((o) => o.key), ['voice', 'performance', 'modules']);
  const fn = objOf(tx816, 'performance');
  // D826: "NN VOICENAME  Lo:C -2 Hi:G 8 "; the limits are read back from the text (D980)
  const d = T.initFn(4, 'E.PIANO 1');
  assert.equal(String.fromCharCode(...d.subarray(64)), '05 E.PIANO 1   Lo:C -2 Hi:G 8 ');
  const lo = fn.params.find((p) => p.key === 'lo');
  writeParam(d, lo, 36);
  assert.equal(String.fromCharCode(...d.subarray(82, 86)), 'C 1 ');
  assert.equal(readParam(d, lo), 36);
  assert.equal(T.readLimit(Uint8Array.from([...'nonsense'].map((c) => c.charCodeAt(0))), 0, 127), 127, 'no limit text: the TF1 keeps the default');
  assert.deepEqual(lo.send(36, { channel: 2 }), [0xf0, 0x43, 0x12, 0x11, 5, 36, 0xf7], 'group 4 number 5 (ED7C)');
  const p2 = fn.params.find((p) => p.offset === 2);
  assert.equal(p2.label, 'Ply/Mon');
  assert.ok(!p2.readOnly);
  assert.ok(fn.params.find((p) => p.offset === 1).readOnly, 'the TF1 sends 0 as source and never reads it');
  assert.deepEqual(fn.sendParam(p2, 1, Object.assign(T.initFn(), { 2: 1 }), { channel: 0 }), [0xf0, 0x43, 0x10, 0x04, 2, 1, 0xf7]);
  assert.equal(fn.match(bulk(0, 1, d)), true);
  assert.equal(tx816.recognise(bulk(0, 1, d)), true, 'a TF1 name says TX816');
  assert.equal(tx816.recognise(bulk(0, 1, objOf(tx7, 'performance').init())), false, 'a TX7 name does not');
  const c = fn.toCommon(d);
  assert.equal(c.parts[0].low, 36);
  assert.deepEqual(Array.from(fn.fromCommon(c).data), Array.from(d));
  const fromTx7 = fn.fromCommon(objOf(tx7, 'performance').toCommon(objOf(tx7, 'performance').init()));
  assert.equal(T.readLimit(fromTx7.data, 82, -1), 0, 'a TX7 function data gets the TF1 limit text');
  // Status (D49F) and the simulator
  const sim = tx816.simulate();
  const [st] = sim.handle([0xf0, 0x43, 0x25, 0x7d, 0xf7]);
  assert.deepEqual(T.parseStatus(st).channel, 5);
  assert.match(tx816.libraryItems([st])[0].label, /channel 6/);
  // Modules: a channel change goes to the module's old channel (EB44)
  const mods = objOf(tx816, 'modules');
  const rack = T.initRack();
  const chParam = mods.params.find((p) => p.key === 'm2_0');
  writeParam(rack, chParam, 9);
  assert.deepEqual(chParam.send(9, {}, rack), [0xf0, 0x43, 0x12, 0x04, 1, 10, 0xf7]);
  assert.deepEqual(mods.params.find((p) => p.key === 'm2_1').send(5, {}, rack), [0xc9, 5], 'program change on the new channel');
  assert.deepEqual(mods.params.find((p) => p.key === 'm2_6').send(0, {}, rack), [0xf0, 0x43, 0x19, 0x11, 7, 0, 0xf7], 'memory protect off');
  assert.equal(mods.multi.count, 8);
  const rc = mods.toCommon(rack);
  assert.equal(rc.parts[2].channel, 9);
  assert.deepEqual(Array.from(mods.fromCommon(rc).data), Array.from(rack));
  const fromParts = mods.fromCommon({ kind: 'performance', parts: [{ channel: 3, program: 40 }, { channel: 4, program: 2, low: 60 }] });
  assert.deepEqual(Array.from(fromParts.data.subarray(0, 4)), [3, 31, 0, 127]);
  assert.equal(fromParts.data[8 + 2], 60);
});

test('DX5: its voice labels, the 94-byte performance from the v6 firmware, group 1 numbers, MIDI channels', async () => {
  const { default: dx5, _test: T } = await import('../js/devices/defs/yamaha-dx5.js');
  assert.deepEqual(dx5.objects.map((o) => o.key), ['voice', 'performance', 'system']);
  const v = objOf(dx5, 'voice');
  const lab = (k) => v.params.find((p) => p.key === k).label;
  assert.equal(lab('op1_tl'), 'OPL');
  assert.equal(lab('als'), 'ALG');
  assert.equal(lab('lfs'), 'Spd');
  assert.equal(v.params.find((p) => p.key === 'lfw').options[5][1], 'S/H');
  // its own value displays (B8A7): curves B99C, mode B9CC, detune B9B7, Off/On BAFB, transpose BB38
  const vp = (k) => v.params.find((p) => p.key === k);
  assert.deepEqual(vp('op1_lc').options.map(([, t]) => t), ['-L', '-E', '+E', '+L']);
  assert.deepEqual(vp('op1_pm').options.map(([, t]) => t), ['R', 'Hz']);
  assert.deepEqual([0, 7, 14].map((x) => vp('op1_pd').format(x)), ['-7', '+0', '+7']);
  assert.deepEqual(vp('lfks').options.map(([, t]) => t), ['Off', 'On']);
  assert.deepEqual([0, 24, 48].map((x) => vp('trnp').options[x][1]), ['-24', '+0', '+24']);
  // the status message (7Dh "LM  DX5   ", EFA7): read only
  const st = objOf(dx5, 'system');
  const sim = dx5.simulate();
  const [ans] = sim.handle(Uint8Array.from(dumpRequest(0, 0x7d)));
  assert.equal(st.match(Uint8Array.from(ans)), true);
  const sd = st.decode(Uint8Array.from(ans));
  const sv = (l) => readParam(sd, st.params.find((p) => p.label === l));
  assert.equal(sv('MIDI switch'), 1);
  assert.equal(sv('SUBJOB4: System exclu. communication'), 1);
  assert.equal(sv('M prot'), 1);
  assert.equal(sv('SUBJOB6: Transmit channel'), 0);
  assert.ok(st.params.every((p) => p.readOnly), 'the DX5 takes none of them over MIDI');
  assert.equal(readParam(st.init(), st.params.find((p) => p.label === 'M prot')), 0, 'shown off before Get');
  assert.equal(dx5.libraryItems([Uint8Array.from(ans)])[0].object, 'system');
  const rom = 're/dx/fw/dx5/Yamaha DX5 IC12 V6 27256.bin';
  if (existsSync(rom)) {
    const b = readFileSync(rom);
    const at = (a) => b[a - 0x8000];
    assert.equal(String.fromCharCode(at(0xbafb), at(0xbafc), at(0xbafd), at(0xbafe), at(0xbaff)), 'OffOn');
    assert.deepEqual([at(0xb9d0), at(0xb9d5), at(0xb9da)], [0x48, 0x7a, 0x52], '"Hz" / "R" (lda # operands)');
    assert.deepEqual([at(0x8000), at(0x8001)], [6, 0], 'status bytes 10-11');
  }
  const perf = objOf(dx5, 'performance');
  const d = T.initPerf();
  assert.deepEqual(Array.from(d.subarray(1, 30)), [0, 0, 5, 0, 0, 0, 0, 1, 15, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 99, 7, 0, 1, 24], 'D533');
  assert.equal(d[63], 39);
  const at = (o) => perf.params.find((p) => p.offset === o);
  assert.equal(at(2).label, 'Ply/Mon');
  assert.equal(at(31).label, 'Source');
  assert.equal(at(31).section, 'B');
  assert.ok(at(20).readOnly && at(50).readOnly, 'the DX1 bytes');
  assert.ok(!at(61).readOnly);
  assert.deepEqual(at(7).dynamic(Object.assign(T.initPerf(), { 2: 1 })).options.map(([, t]) => t), ['Finger', 'FulTim']);
  // group 1 (C919): the current channel's bytes, 30-33 = bytes 60-63, 34-63 the name
  assert.deepEqual(perf.sendParam(at(3), 0, d, { channel: 0 }), [0xf0, 0x43, 0x10, 0x04, 3, 5, 0xf7]);
  const whole = perf.sendParam(at(33), 0, d, { channel: 0 });
  assert.deepEqual([whole[3], whole.length], [1, 102], 'channel B while A is current: the whole performance (format 1)');
  assert.deepEqual(perf.sendParam(at(33), 0, Object.assign(T.initPerf(), { 61: 1 }), { channel: 0 }), [0xf0, 0x43, 0x10, 0x04, 3, 5, 0xf7]);
  assert.deepEqual(perf.sendParam(at(63), 0, d, { channel: 0 }), [0xf0, 0x43, 0x10, 0x04, 33, 39, 0xf7]);
  assert.equal(at(63).options.find(([x]) => x === 39)[1], 'C3');
  // MIDI channels page: A and B with their Source
  assert.equal(perf.multi.count, 2);
  assert.equal(perf.multi.on(1, d), false, 'single mode on A: B silent');
  assert.equal(perf.multi.on(1, Object.assign(T.initPerf(), { 60: 1 })), true);
  // Head Library
  const c = perf.toCommon(Object.assign(T.initPerf(), { 60: 2, 1: 3, 31: 4 }));
  assert.equal(c.keyMode, 'split');
  assert.deepEqual(c.parts.map((p) => p.channel), [2, 3]);
  assert.deepEqual(Array.from(perf.fromCommon(c).data), Array.from(Object.assign(T.initPerf(), { 60: 2, 1: 3, 31: 4 })));
  const fromDx7ii = perf.fromCommon({ kind: 'performance', keyMode: 'split', splitPoint: 60, parts: [{ program: 3, channel: 0 }, { program: 40, channel: 1 }] });
  assert.equal(fromDx7ii.data[60], 2);
  assert.equal(fromDx7ii.data[63], 39);
  assert.equal(fromDx7ii.data[31], 2);
  // A TX7 performance reads as a TX7, a DX5 one as a DX5
  const tx7Perf = bulk(0, 1, objOf(tx7, 'performance').init());
  assert.ok(dx5.prefer([tx7Perf]) < tx7.prefer([tx7Perf]));
  assert.ok(dx5.prefer([bulk(0, 1, d)]) > tx7.prefer([bulk(0, 1, d)]) - 1);
});

test('Format 2 memories: the DX5 packing (CB27 / F999), as the TX7, TX816 and DX5 Branch Libraries read them', async () => {
  const F = await import('../js/devices/defs/yamaha-dx-fn94.js');
  const dx5 = (await import('../js/devices/defs/yamaha-dx5.js')).default;
  const tx816 = (await import('../js/devices/defs/yamaha-tx816.js')).default;
  const h = new Uint8Array(94);
  const half = [5, 16, 1, 7, 9, 50, 1, 1, 1, 15, 7, 3, 5, 10, 2, 8, 1, 6, 3, 12, 4, 9, 5, 14, 99, 98, 6, 1, 1, 30];
  h.set(half, 0); h.set(half, 30); h[30] = 0x20 | 0x40 | 3; h[33] = 12; h[34] = 0;
  h[60] = 2; h[61] = 1; h[62] = 9; h[63] = 39;
  h.set([...'PACK TEST'.padEnd(30)].map((c) => c.charCodeAt(0)), 64);
  const r = F.packFn94(h);
  assert.equal(r.length, 64);
  assert.ok(r.every((b) => b < 128));
  assert.equal(r[0], 5 | 0x40);
  assert.equal(r[16] & 0x20, 0x20, 'half B marked');
  assert.equal(r[14] & 0x20, 0x20, 'Source 16');
  assert.equal(r[15] & 0x40, 0x40, 'PB stp bit 3');
  assert.equal(r[32], 2 | 4 | (9 << 3));
  const back = F.unpackFn94(r);
  // as the DX5 unpacks: PB rng shows 12 while a step is set
  const want = Uint8Array.from(h); want[3] = 12;
  assert.deepEqual(back, want);
  // a TX7-style record (TX7 E396): voice | mono, Source 1 (8), Sus pdl (10h), key shift 24, split 39
  const t = new Uint8Array(64);
  Object.assign(t, { 0: 3, 1: 2, 2: 20, 3: 8, 12: 99, 13: 99, 14: 0x10 | 5, 15: 24, 16: 3, 17: 2, 18: 20, 19: 8, 28: 99, 29: 99, 30: 0x10 | 5, 31: 24, 33: 39 });
  const p = F.unpackFn94(t);
  assert.deepEqual([p[0], p[1], p[3], p[5], p[26], p[28], p[29], p[30], p[63]], [3, 1, 2, 20, 5, 1, 24, 35, 39]);
  const mem = new Uint8Array(4096);
  for (let i = 0; i < 64; i++) mem.set(i < 32 ? r : t, i * 64);
  const items = dx5.libraryItems([Uint8Array.from(bulk(0, 2, mem))]);
  assert.equal(items.length, 64);
  assert.equal(items[0].name, 'PACK TEST');
  assert.equal(parseBulk(items[0].msgs[0]).format, 1);
  // TX816 / TX7: the 32 memories come twice; listed once
  const twice = new Uint8Array(4096);
  for (let i = 0; i < 64; i++) twice.set(t, i * 64);
  assert.equal(tx816.libraryItems([Uint8Array.from(bulk(0, 2, twice))]).length, 32);
  assert.equal(tx7.libraryItems([Uint8Array.from(bulk(0, 2, twice))]).length, 32);
});

test('DX9: ALGORITHM 1-8 are DX7 algorithms 1, 14, 8, 7, 5, 22, 31, 32 (table D0D4)', async () => {
  const { default: dx9, DX9_ALGS } = await import('../js/devices/defs/yamaha-dx9.js');
  const v = objOf(dx9, 'voice');
  const als = v.params.find((p) => p.key === 'als');
  assert.deepEqual(DX9_ALGS.map((a) => a + 1), [1, 14, 8, 7, 5, 22, 31, 32]);
  assert.equal(als.options[1][1], '2 (DX7 14)');
  assert.equal(als.options.length, 32);
});

test('Format 2 memories written back: TX7 (twice, per voice), DX5 (64), TX816 (one copy per module)', async () => {
  const FN = await import('../js/devices/defs/yamaha-dx-fn94.js');
  const dx5 = (await import('../js/devices/defs/yamaha-dx5.js')).default;
  const tx816 = (await import('../js/devices/defs/yamaha-tx816.js')).default;
  const u8 = (m) => Uint8Array.from(m);
  const fake = (def, channel = 0) => {
    const sim = def.simulate();
    const data = {};
    const loaded = new Set();
    const ctx = { channel, data, loaded };
    return { sim, ctx, api: { ctx, g: { objectData: data, loadedKeys: loaded }, send: (m) => sim.handle(u8(m)), request: async (bytes, match) => sim.handle(u8(bytes)).map(u8).find(match) } };
  };
  for (const [def, count, twice] of [[tx7, 32, true], [dx5, 64, false], [tx816, 32, true]]) {
    const obj = def.objects.find((o) => o.key === 'performance');
    const s = obj.slots;
    assert.equal(s.count, count, def.objects[0].label);
    const { sim, ctx, api } = fake(def, 2);
    assert.equal(s.writable(0, ctx), false, 'not before the memories were read');
    const names = [];
    await s.scanBank(api, 0, (i, n) => { names[i] = n; });
    assert.equal(names.length, count);
    assert.equal(s.writable(0, ctx), true);
    const d = await s.fetch(api, 0, 5);
    assert.equal(d.length, FN.FN_SIZE);
    d[3] = 7; d[5] = 42; // PB rng, P time of channel A
    const out = s.store(0, 5, ctx, d);
    assert.equal(out.length, 1);
    const b = parseBulk(u8(out[0]));
    assert.deepEqual([b.format, b.data.length, b.channel], [2, 4096, 2]);
    const back = FN.unpackFn94(b.data.subarray(5 * 64, 6 * 64));
    assert.deepEqual([back[3], back[5]], [7, 42]);
    if (twice) assert.deepEqual(b.data.subarray(37 * 64, 38 * 64), b.data.subarray(5 * 64, 6 * 64), 'the copy the unit sends twice');
    if (def === tx7) assert.equal(back[0] & 31, 5, 'memory 6 belongs to voice 6');
    sim.handle(u8(out[0]));
    assert.deepEqual(sim.unit.fmem, b.data);
    if (s.recall) assert.deepEqual(s.recall(0, 5, ctx), [0xc2, 5]);
  }
  // the TX816 keeps a copy per module
  const s816 = tx816.objects.find((o) => o.key === 'performance').slots;
  const { ctx } = fake(tx816, 2); // MIDI channel 3
  ctx.data['fmem-bank-ch3'] = new Uint8Array(4096); ctx.loaded.add('fmem-bank-ch3');
  assert.equal(s816.writable(0, ctx), true);
  assert.equal(s816.writable(0, { ...ctx, channel: 4 }), false);
});
