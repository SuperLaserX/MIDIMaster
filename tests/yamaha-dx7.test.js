import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { readParam, writeParam, formatParam } from '../js/core/model/memmap.js';
import { patchFromObject, loadMode } from '../js/devices/patches.js';
import { getDevice } from '../js/devices/registry.js';
import def from '../js/devices/defs/yamaha-dx7.js';
import * as FW from '../js/devices/defs/yamaha-dx7-fw.js';
import { ALGORITHMS, vcedToVmem, vmemToVced, bankVoices, voiceName, freqText, opBase, VOICE_SIZE } from '../js/devices/defs/yamaha-dx-voice.js';
import { bulk, parseBulk, paramChange, parseParamChange, checksum } from '../js/devices/defs/yamaha-dx-sysex.js';
import { algorithmLayout, egShape, scalingCurve } from '../js/devices/defs/yamaha-dx-draw.js';
import { BANK_KEY } from '../js/devices/defs/yamaha-dx.js';

const voice = def.objects.find((o) => o.key === 'voice');
const fn = def.objects.find((o) => o.key === 'system');
const P = (label, section) => voice.params.find((p) => p.label === label && (!section || p.section === section));
const show = (p, d) => { const q = p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p; const v = readParam(d, q); return q.options?.find(([x]) => x === v)?.[1] ?? formatParam(q, v); };
const ROM = 're/dx/fw/dx7carts';
const romBank = (f) => (existsSync(`${ROM}/${f}`) ? new Uint8Array(readFileSync(`${ROM}/${f}`)) : null);

test('DX7: every voice byte has one named parameter (operator on/off: one bit each)', () => {
  const bits = new Uint8Array(VOICE_SIZE);
  for (const p of voice.params) {
    const mask = p.bits ? ((1 << p.bits) - 1) << (p.shift || 0) : 0xff;
    assert.equal(bits[p.offset] & mask, 0, `${p.key} overlaps`);
    bits[p.offset] |= mask;
    assert.ok(p.label && !/^Byte/.test(p.label), p.key);
  }
  for (let i = 0; i < 155; i++) assert.equal(bits[i], 0xff, `byte ${i}`);
  assert.equal(bits[155], 0x3f, 'operator on/off bits 0-5');
  const keys = voice.params.map((p) => `${p.section}/${p.label}`);
  assert.equal(new Set(keys).size, keys.length, 'labels unique within a section');
});

test('DX7: labels, ranges and displays from the v1.8 firmware', () => {
  assert.equal(FW.EDIT.params[11].offset, 18); // F COARSE: operator byte 18
  assert.equal(FW.EDIT.params[0].offset, 134); // ALGORITHM
  assert.equal(P('F COARSE', 'op1').offset, opBase(1) + 18);
  assert.equal(P('ALGORITHM SELECT').max, 31);
  assert.equal(P('KEY VELOCITY', 'op3').max, 7);
  assert.equal(P('MIDDLE C').max, 48);
  assert.deepEqual(P('L KEY SCALE', 'op2').options.map(([, t]) => t), ['-LIN', '-EXP', '+EXP', '+LIN']);
  assert.deepEqual(P('LFO WAVE').options.map(([, t]) => t), ['TRIANGL', 'SAW DWN', 'SAW UP', 'SQUARE', 'SINE', 'S/HOLD']);
  assert.deepEqual(P('OSC MODE', 'op6').options.map(([, t]) => t), ['FREQUENCY(RATIO)', 'FIXED FREQ.(Hz)']);
  const d = voice.init();
  assert.equal(voiceName(d), 'INIT VOICE');
  assert.equal(d[134], 0);
  assert.equal(d[opBase(1) + 16], 99, 'OP1 output level 99');
  assert.equal(d[opBase(2) + 16], 0);
  // frequency display (routine F145): ratio and fixed
  const fw = { FIXED: FW.FIXED_FREQ.items };
  assert.equal(freqText(fw, 0, 0, 0), '0.50');
  assert.equal(freqText(fw, 0, 0, 99), '0.99');
  assert.equal(freqText(fw, 0, 1, 0), '1.00');
  assert.equal(freqText(fw, 0, 3, 41), '4.23');
  assert.equal(freqText(fw, 0, 31, 99), '61.69');
  assert.equal(freqText(fw, 1, 0, 0), '1.000Hz');
  assert.equal(freqText(fw, 1, 1, 0), '10.00Hz');
  assert.equal(freqText(fw, 1, 2, 50), '316.2Hz');
  assert.equal(freqText(fw, 1, 3, 99), '9772 Hz');
  assert.equal(freqText(fw, 1, 4, 0), '1.000Hz', 'coarse 4 = coarse 0 in fixed mode');
  const coarse = P('F COARSE', 'op1');
  d[opBase(1) + 19] = 50;
  assert.equal(show(coarse, d), '1.50');
  assert.equal(show(P('OSC DETUNE', 'op1'), d), '0');
  d[opBase(1) + 20] = 14;
  assert.equal(show(P('OSC DETUNE', 'op1'), d), '+7');
  const bp = P('BREAK POINT', 'op1');
  for (const [v, t] of [[0, 'A-1'], [39, 'C3'], [99, 'C8'], [15, 'C1']]) { d[bp.offset] = v; assert.equal(show(bp, d), t); }
  const tr = P('MIDDLE C');
  for (const [v, t] of [[0, 'C1'], [24, 'C3'], [48, 'C5'], [13, 'C#2']]) { d[tr.offset] = v; assert.equal(show(tr, d), t); }
  assert.equal(show(P('ALGORITHM SELECT'), d), '1');
  // function: portamento texts follow POLY/MONO (table F847)
  const f = fn.init();
  const porta = fn.params.find((p) => p.num === 67);
  assert.deepEqual(porta.dynamic(f).options.map(([, t]) => t), ['SUS-KEY P RETAIN', 'SUS-KEY P FOLLOW']);
  f[0] = 1;
  assert.deepEqual(porta.dynamic(f).options.map(([, t]) => t), ['FINGERED PORTA', 'FULL TIME PORTA']);
  assert.deepEqual(fn.params.filter((p) => p.num === 71).map((p) => p.label), ['WHEEL PITCH', 'WHEEL AMP', 'WHEEL EG B.']);
  assert.equal(fn.params.find((p) => p.num === 76).label, 'AFTER RANGE');
});

test('DX7: algorithms as Yamaha draws them', () => {
  assert.equal(ALGORITHMS.length, 32);
  const carriers = ALGORITHMS.map((a) => a.carriers.length);
  assert.deepEqual(carriers, [2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 3, 3, 4, 4, 4, 5, 5, 3, 3, 3, 4, 4, 5, 6]);
  assert.deepEqual(ALGORITHMS[3].fb, [4, 6], 'algorithm 4: OP4 feeds back into OP6');
  assert.deepEqual(ALGORITHMS[5].fb, [5, 6], 'algorithm 6: OP5 into OP6');
  for (const [n, a] of ALGORITHMS.entries()) {
    const l = algorithmLayout(a);
    assert.equal(l.nodes.size, 6, `algorithm ${n + 1}: every operator placed`);
    for (const c of a.carriers) assert.equal(l.nodes.get(c).y, 0, `algorithm ${n + 1}: carrier ${c} on the bottom row`);
    for (const [f, t] of a.mods) assert.ok(l.nodes.get(f).y > l.nodes.get(t).y, `algorithm ${n + 1}: ${f} above ${t}`);
    const spots = new Set([...l.nodes.values()].map((p) => `${p.x},${p.y}`));
    assert.equal(spots.size, 6, `algorithm ${n + 1}: no two operators on one spot`);
  }
  // algorithm 22: OP6 over the middle of 3, 4 and 5
  const l22 = algorithmLayout(ALGORITHMS[21]);
  assert.equal(l22.nodes.get(6).x, l22.nodes.get(4).x);
  // EG shape: L4 -> L1 -> L2 -> L3 (held) -> L4
  const e = egShape([99, 50, 50, 50], [99, 80, 60, 0]);
  assert.deepEqual(e.map((p) => p.l), [0, 99, 80, 60, 60, 0]);
  assert.ok(e[1].t < e[2].t && e[2].t < e[3].t);
  const s = scalingCurve(39, 0, 99, 3, 99);
  assert.ok(s[20] < 0 && s[100] > 0 && s[60] === 0);
});

test('DX7: packed memory format and the factory ROM cartridges (skipped when absent)', (t) => {
  const a = romBank('yamaha_dx7_voicerom1_bank-a.bin');
  if (!a) { t.skip('no ROM cartridge dumps in re/dx'); return; }
  const v = bankVoices(a);
  assert.equal(voiceName(v[0]), 'BRASS   1');
  assert.equal(v[0][134] + 1, 22, 'BRASS 1 algorithm 22');
  assert.equal(v[0][135], 7);
  for (const f of ['yamaha_dx7_voicerom1_bank-a.bin', 'yamaha_dx7_voicerom1_bank-b.bin', 'yamaha_dx7_voicerom2_bank-a.bin', 'yamaha_dx7_voicerom2_bank-b.bin']) {
    const b = romBank(f);
    bankVoices(b).forEach((x, i) => assert.deepEqual(vcedToVmem(x), b.subarray(i * 128, (i + 1) * 128), `${f} voice ${i + 1}`));
  }
  // the 32-voice bulk: library items, then back
  const m = bulk(0, 9, a);
  assert.equal(m.length, 4104);
  assert.equal(def.recognise(m), true);
  const items = def.libraryItems([Uint8Array.from(m)]);
  assert.equal(items.length, 32);
  assert.equal(items[31].name, 'TAKE OFF');
  assert.equal(items[0].object, 'voice');
});

test('DX7: messages, edit buffer, receive and the simulator', () => {
  const ctx = { channel: 2, data: {}, loaded: new Set() };
  const d = voice.init();
  // parameter change for an operator value and for the on/off byte
  const tl = P('OUTPUT LEVEL', 'op2');
  writeParam(d, tl, 77);
  assert.deepEqual(voice.sendParam(tl, 77, d, ctx), [0xf0, 0x43, 0x12, 0x00, opBase(2) + 16, 77, 0xf7]);
  const on3 = P('OP3', 'voice');
  writeParam(d, on3, 0);
  assert.deepEqual(voice.sendParam(on3, 0, d, ctx), [0xf0, 0x43, 0x12, 0x01, 155 - 128, 0x37, 0xf7]); // OP3 = bit 3
  const lfo = P('LFO SPEED');
  assert.deepEqual(parseParamChange(voice.sendParam(lfo, 35, d, ctx)), { channel: 2, group: 0, num: 137, value: 35 });
  // send all: the voice bulk and the on/off byte
  const all = voice.sendAll.build(d, ctx);
  assert.equal(all.length, 2);
  const b = parseBulk(all[0]);
  assert.equal(b.ok, true);
  assert.equal(b.format, 0);
  assert.equal(b.data.length, 155);
  assert.equal(all[0].length, 163);
  assert.equal(all[0][161], checksum(Array.from(b.data)));
  // receive: a voice, a panel edit, the bank
  const got = voice.receive(Uint8Array.from(bulk(2, 0, d.subarray(0, 155))), voice.init(), ctx);
  assert.equal(got[opBase(2) + 16], 77);
  assert.equal(got[155], 0x3f, 'a voice bulk turns every operator on');
  const edited = voice.receive(Uint8Array.from(paramChange(2, 0, 134, 21)), got, ctx);
  assert.equal(edited[134], 21);
  assert.equal(voice.receive(Uint8Array.from(paramChange(3, 0, 134, 5)), got, ctx), null, 'other channel ignored');
  const bank = new Uint8Array(4096);
  for (let i = 0; i < 32; i++) bank.set(vcedToVmem(d), i * 128);
  voice.receive(Uint8Array.from(bulk(2, 9, bank)), got, ctx);
  assert.equal(ctx.data[BANK_KEY].length, 4096);
  assert.ok(ctx.loaded.has(BANK_KEY));
  assert.equal(voice.slots.names(0, ctx)[5], 'INIT VOICE');
  assert.equal(voice.slots.writable(0, ctx), true);
  const stored = voice.slots.store(0, 4, ctx, edited);
  assert.equal(parseBulk(stored[0]).format, 9);
  assert.equal(vmemToVced(ctx.data[BANK_KEY].subarray(4 * 128, 5 * 128))[134], 21);
  // function parameters: group 2, numbers 64-77; the assign bits share one number
  const f = fn.init();
  const amp = fn.params.find((p) => p.key === 'f73_1');
  writeParam(f, amp, 1);
  assert.deepEqual(fn.sendParam(amp, 1, f, ctx), [0xf0, 0x43, 0x12, 0x08, 73, 2, 0xf7]);
  assert.equal(fn.receive(Uint8Array.from(paramChange(2, 2, 70, 55)), f, ctx)[6], 55);
  // the simulator keeps what it gets and ignores requests, as the DX7 does
  const sim = def.simulate();
  sim.handle(Uint8Array.from(paramChange(0, 0, 134, 9)));
  assert.equal(sim.unit.voice[134], 9);
  assert.deepEqual(sim.handle(Uint8Array.from([0xf0, 0x43, 0x20, 0x09, 0xf7])), []);
  sim.handle(Uint8Array.from(bulk(0, 9, bank)));
  sim.handle(Uint8Array.from([0xc0, 4]));
  assert.equal(voiceName(sim.unit.voice), 'INIT VOICE');
  assert.match(def.describe(Uint8Array.from(all[0])), /voice \(VCED\) "INIT VOICE"/);
});

test('DX7: Head Library translation (exact DX to DX, built from another family with a report)', async () => {
  const entry = getDevice('yamaha-dx7');
  const a = romBank('yamaha_dx7_voicerom1_bank-a.bin');
  const d = a ? bankVoices(a)[7] : voice.init(); // PIANO 1
  const patch = patchFromObject(entry, def, voice, d);
  assert.equal(patch.common.extra.family, 'yamaha-dx');
  assert.ok(patch.common.osc.length >= 1);
  const back = voice.fromCommon(patch.common, voice.init());
  assert.deepEqual(back.data, d);
  // from a JP-8080 patch
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jpObj = jp.objects.find((o) => o.key === 'patch');
  const raw = jpObj.init();
  raw.set([...'FM Test         '].map((c) => c.charCodeAt(0)));
  const jpPatch = patchFromObject(getDevice('roland-jp8080'), jp, jpObj, raw);
  assert.equal(loadMode(entry, def, voice, jpPatch), 'translate', 'a Roland patch loads into a DX voice');
  assert.equal(loadMode(getDevice('roland-jp8080'), jp, jpObj, patch), 'translate', 'and a DX voice into a Roland patch');
  const r = voice.fromCommon(jpPatch.common, voice.init());
  assert.ok(r.report.approximated.length > 0);
  for (const p of voice.params) {
    const q = p.dynamic ? { ...p, ...p.dynamic(r.data, {}) } : p;
    const v = readParam(r.data, q);
    if (q.options) assert.ok(q.options.some(([x]) => x === v), `${p.key} = ${v}`);
    else assert.ok(v >= (q.min ?? 0) && v <= q.max, `${p.key} = ${v}`);
  }
  assert.equal(r.data[134], 4, 'algorithm 5');
});

test('DX7: the editor against its own v1.8 OS run in an emulator (skipped when the firmware is absent)', async (t) => {
  if (!existsSync('re/dx/fw/dx7/DX7-V1-8.OBJ')) { t.skip('re/dx/fw/dx7/DX7-V1-8.OBJ not present'); return; }
  const { check } = await import('../tools/yamaha/check_editor.mjs');
  const report = await check('dx7');
  assert.ok(report.length >= 15, 'every step ran');
  assert.deepEqual(report.filter((l) => l.startsWith('FAIL')), []);
});
