// The 4-operator DX family (yamaha-dx4.js): TX81Z, DX11, DX21, DX100/DX27.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { patchFromObject, loadMode } from '../js/devices/patches.js';
import { getDevice } from '../js/devices/registry.js';
import { parseBulk, dumpRequest, dumpRequestHeader } from '../js/devices/defs/yamaha-dx-sysex.js';
import { ALGORITHMS4, packVoice4, unpackVoice4, ratioText, opBase4 } from '../js/devices/defs/yamaha-dx4.js';
import { algorithmLayout } from '../js/devices/defs/yamaha-dx-draw.js';
import tx81z from '../js/devices/defs/yamaha-tx81z.js';
import dx11 from '../js/devices/defs/yamaha-dx11.js';
import dx21 from '../js/devices/defs/yamaha-dx21.js';
import dx100 from '../js/devices/defs/yamaha-dx100.js';
import dx7 from '../js/devices/defs/yamaha-dx7.js';

const objOf = (def, key) => def.objects.find((o) => o.key === key);
const ROM = 're/dx/fw/tx81z/TX81Z V1.6 03-Feb-88.bin';

test('4-op: voice bytes, labels, algorithms and frequency ratios', () => {
  for (const def of [tx81z, dx11, dx21, dx100]) {
    const v = objOf(def, 'voice');
    const seen = new Uint8Array(v.size);
    for (const p of v.params) { for (let i = 0; i < (p.size || 1); i++) { assert.equal(seen[p.offset + i], 0, `${p.key}`); seen[p.offset + i] = 1; } }
    assert.ok(seen.every(Boolean), `${v.size} bytes covered`);
    assert.equal(String.fromCharCode(...v.init().subarray(77, 87)), 'INIT VOICE');
  }
  assert.equal(objOf(tx81z, 'voice').size, 116);
  assert.equal(objOf(dx21, 'voice').init()[87], 99, 'DX21 INIT VOICE pitch EG rate 1');
  assert.equal(ALGORITHMS4.length, 8);
  ALGORITHMS4.forEach((a, n) => {
    const l = algorithmLayout(a);
    assert.equal(l.nodes.size, 4, `algorithm ${n + 1}`);
    for (const c of a.carriers) assert.equal(l.nodes.get(c).y, 0);
  });
  assert.deepEqual(ALGORITHMS4.map((a) => a.carriers.length), [1, 1, 1, 1, 2, 3, 3, 4]);
  assert.equal(ratioText(0), '0.50');
  assert.equal(ratioText(4), '1.00');
  assert.equal(ratioText(63), '25.95');
  const v = objOf(tx81z, 'voice');
  const P = (k) => v.params.find((p) => p.key === k);
  assert.equal(P('op1_crs').offset, opBase4(1) + 11);
  assert.equal(opBase4(4), 0, 'OP4 first');
  assert.deepEqual(P('lfw').options.map(([, t]) => t), ['saw up', 'square', 'triangl', 'S/Hold']);
  assert.equal(P('op2_osw').options[7][1], 'W8');
});

test('4-op: packed memory matches the TX81Z presets (skipped when absent)', (t) => {
  if (!existsSync(ROM)) { t.skip('no TX81Z firmware in re/dx'); return; }
  const rom = new Uint8Array(readFileSync(ROM));
  // preset records: 57 bytes of packed voice, the name, then the packed additional data (78 bytes)
  const at = Buffer.from(rom).indexOf('LatelyBass') - 57;
  const rec = new Uint8Array(128);
  rec.set(rom.subarray(at, at + 67));
  const u = unpackVoice4(rec);
  assert.equal(String.fromCharCode(...u.vced.subarray(77, 87)), 'LatelyBass');
  assert.equal(u.vced[62], 12, 'transpose an octave down');
  assert.equal(u.vced[60], 5, 'PMS from byte 45');
  assert.deepEqual(packVoice4(u.vced, u.aced).subarray(0, 67), rec.subarray(0, 67));
  // the additional data packing (routine 8431): SHFT<<4|FIX<<3|FIXRG, OSW<<4|FINE
  const a = new Uint8Array(23);
  a.set([1, 5, 9, 6, 2], 0);
  const m = packVoice4(new Uint8Array(93), a);
  assert.deepEqual([m[73], m[74]], [(2 << 4) | (1 << 3) | 5, (6 << 4) | 9]);
  assert.deepEqual(unpackVoice4(m).aced.subarray(0, 5), a.subarray(0, 5));
});

test('TX81Z: messages, requests, performance and its MIDI channels page', async () => {
  const v = objOf(tx81z, 'voice');
  const perf = objOf(tx81z, 'performance');
  const ctx = { channel: 0 };
  const d = v.init();
  const P = (k) => v.params.find((p) => p.key === k);
  writeParam(d, P('op1_out'), 70);
  assert.deepEqual(v.sendParam(P('op1_out'), 70, d, ctx), [0xf0, 0x43, 0x10, 0x12, opBase4(1) + 10, 70, 0xf7]);
  writeParam(d, P('op1_osw'), 3);
  assert.deepEqual(v.sendParam(P('op1_osw'), 3, d, ctx), [0xf0, 0x43, 0x10, 0x13, 15 + 3, 3, 0xf7], 'OP1 is the fourth operator of the additional data');
  const sent = v.sendAll.build(d, ctx).map((m) => Uint8Array.from(m));
  assert.equal(parseBulk(sent[0]).header, 'LM  8976AE');
  assert.equal(parseBulk(sent[1]).format, 3);
  assert.deepEqual(v.fromSyx(sent), d);
  const sim = tx81z.simulate();
  sent.forEach((m) => sim.handle(m));
  const api = { ctx, request: async (bytes, match) => sim.handle(Uint8Array.from(bytes)).map((x) => Uint8Array.from(x)).find(match), g: { objectData: {}, loadedKeys: new Set() } };
  assert.deepEqual(await v.fetch(api), d);
  const [bank] = sim.handle(Uint8Array.from(dumpRequest(0, 4)));
  assert.equal(tx81z.libraryItems([Uint8Array.from(bank)]).length, 32);
  // performance
  const p = perf.init();
  const voice = perf.params.find((x) => x.key === 'i2_voice');
  writeParam(p, voice, 140);
  assert.equal(readParam(p, voice), 140);
  assert.deepEqual([p[25], p[26]], [1, 12]);
  assert.equal(voice.options[140][1], 'D13');
  assert.equal(perf.sendParam(voice, 140, p, ctx).length, 2);
  assert.equal(perf.match(Uint8Array.from(perf.toSyx(p, ctx))), true);
  const m = perf.multi;
  for (let i = 0; i < m.count; i++) for (const col of m.columns) for (const label of col.params) assert.ok(perf.params.some((x) => x.section === m.section(i) && x.label === label), `${label} in instrument ${i + 1}`);
  assert.equal(m.on(0, p), true);
  assert.equal(m.on(1, p), false);
  const [pe] = sim.handle(Uint8Array.from(dumpRequestHeader(0, 'LM  8976PE')));
  assert.equal(perf.match(Uint8Array.from(pe)), true);
});

test('4-op <-> 6-op through the shared model, exact within the 4-op models', () => {
  const v = objOf(tx81z, 'voice');
  const d = v.init();
  d[52] = 2;
  d[opBase4(4) + 10] = 80;
  const patch = patchFromObject(getDevice('yamaha-tx81z'), tx81z, v, d);
  assert.equal(patch.common.extra.ops, 4);
  assert.deepEqual(objOf(dx11, 'voice').fromCommon(patch.common, null).data, d, 'TX81Z to DX11: exact');
  const to21 = objOf(dx21, 'voice').fromCommon(patch.common, null);
  assert.deepEqual(to21.data.subarray(0, 77), d.subarray(0, 77));
  assert.ok(to21.report.dropped.length, 'DX21 has no additional data');
  assert.equal(loadMode(getDevice('yamaha-dx7'), dx7, objOf(dx7, 'voice'), patch), 'translate');
  const six = objOf(dx7, 'voice').fromCommon(patch.common, null);
  assert.equal(six.data[134], 7, 'algorithm 3 -> DX7 algorithm 8');
  assert.ok(six.report.approximated.length);
  const dv = objOf(dx7, 'voice').init();
  const four = v.fromCommon(patchFromObject(getDevice('yamaha-dx7'), dx7, objOf(dx7, 'voice'), dv).common, null);
  assert.equal(four.data[52], 4, 'DX7 algorithm 1 (two carriers) -> 4-op algorithm 5');
  assert.ok(four.report.dropped.includes('two operators'));
  for (const p of v.params) {
    const q = p.dynamic ? { ...p, ...p.dynamic(four.data, {}) } : p;
    const x = readParam(four.data, q);
    assert.ok(x >= (q.min ?? 0) && x <= q.max, `${p.key} = ${x}`);
  }
});

test('DX21 and DX100: labels and value texts from their own screens', async () => {
  const dx21 = (await import('../js/devices/defs/yamaha-dx21.js')).default;
  const dx100 = (await import('../js/devices/defs/yamaha-dx100.js')).default;
  const p21 = (k) => dx21.objects[0].params.find((p) => p.key === k);
  const p100 = (k) => dx100.objects[0].params.find((p) => p.key === k);
  assert.equal(p21('alg').label, 'ALGORITHM SELECT');
  assert.equal(p21('op1_out').label, 'OUTPUT LEVEL');
  assert.deepEqual(p21('lfw').options.map(([, t]) => t), ['SAW UP', 'SQUARE', 'TRIANGL', 'S/HOLD']);
  assert.deepEqual(p21('mo').options.map(([, t]) => t), ['Poly Mode', 'Mono Mode']);
  assert.equal(p21('pr1').label, 'PEG RATE 1');
  assert.equal(p100('fbl').label, 'FBL');
  assert.equal(p100('trps').label, 'MID.C');
  assert.deepEqual(p100('pm').options.map(([, t]) => t), ['Full T.', 'Fingered']);
  // display tokens (print routine A5AA, words at AD7E + token): 80h LF, 83h PM, 86h AM, AAh MW, AEh BC
  assert.deepEqual(['lfs', 'lfd', 'pmd', 'amd', 'pms', 'ams', 'mwa', 'bceb'].map((k) => p100(k).label), ['LFS', 'LFD', 'PMD', 'AMD', 'PMS', 'AMS', 'MW Ampli', 'BC E Bias']);
  assert.equal(p100('bcpb').max, 99, 'maximum table 186B');
  const rom = 're/dx/fw/dx100/DX100 v1.1.bin';
  if (existsSync(rom)) {
    const b = readFileSync(rom);
    const word = (t) => { let s = ''; for (let a = 0xad7e + t - 0x8000; b[a] >= 0x20 && b[a] < 0x80; a++) s += String.fromCharCode(b[a]); return s; };
    assert.deepEqual([0x80, 0x83, 0x86, 0xaa, 0xae, 0xb2, 0xb9, 0xc0].map(word), ['LF', 'PM', 'AM', 'MW ', 'BC ', ' Bias ', 'Ampli ', 'Pitch ']);
  }
});

test('DX11: its after touch data "LM  8023AE" (sender EE02, INIT DFF0)', async () => {
  const dx11 = (await import('../js/devices/defs/yamaha-dx11.js')).default;
  const { parseBulk } = await import('../js/devices/defs/yamaha-dx-sysex.js');
  const ae = dx11.objects.find((o) => o.key === 'aftertouch');
  const d = ae.init();
  assert.deepEqual(Array.from(d.subarray(0, 4)), [0, 0, 50, 0]);
  assert.deepEqual(ae.params.slice(0, 4).map((p) => p.label), ['AT Pitch', 'AT Amplitude', 'AT P. Bias', 'AT EG Bias']);
  const m = Uint8Array.from(ae.toSyx(d, { channel: 0 }));
  assert.equal(parseBulk(m).count, 20);
  assert.equal(ae.match(m), true);
  assert.equal(dx11.libraryItems([m])[0].object, 'aftertouch');
});

test('DX21: function settings as parameter changes 65h-7Ch (receiver E4AF, pages FD2F-FFCF, maxima B653)', async () => {
  const dx21 = (await import('../js/devices/defs/yamaha-dx21.js')).default;
  const { FN_PARAMS, FN_INIT, FN_SIZE, BEND_MODES } = await import('../js/devices/defs/yamaha-dx21.js');
  const fn = dx21.objects.find((o) => o.key === 'system');
  assert.ok(fn && !fn.request && !fn.fetch, 'sent only: the DX21 has no dump of them');
  assert.equal(fn.size, FN_SIZE);
  const seen = new Uint8Array(FN_SIZE);
  for (const p of fn.params) seen[p.offset]++;
  assert.ok(seen.every((n) => n === 1), 'every byte one parameter');
  const P = (k) => fn.params.find((p) => p.key === k);
  assert.deepEqual(['mtune', 'ddet', 'midi', 'chinfo', 'sysinfo', 'rch', 'tch', 'protect', 'kshift', 'bmode'].map((k) => P(k).label),
    ['Master Tune', 'Dual Detune', 'Midi Switch', 'Midi Ch Info', 'Midi Sy Info', 'Midi Recv Ch', 'Midi Trns Ch', 'Mem Protect', 'Key Shift', 'Bend Mode']);
  assert.deepEqual(BEND_MODES, ['Low', 'Hi', 'Kon']);
  assert.equal(P('mtune').format(0), '-64'); assert.equal(P('mtune').format(127), '63');
  assert.equal(P('kshift').format(0), '-24'); assert.equal(P('kshift').format(48), '24');
  assert.equal(P('split').options[60][1], '60 (C3)');
  const d = fn.init();
  assert.equal(d[P('protect').offset], 0, 'Mem Protect shown off');
  assert.equal(d[P('mtune').offset], 64);
  const ctx = { channel: 2 };
  // each change is F0 43 1n 12 pp vv F7; Recv Ch: Omni = 6Ah 1, channel c = 6Ch c-1
  assert.deepEqual(fn.sendParam(P('ddet'), 0, Uint8Array.from([64, 33, 1, 0, 0, 1, 1, 0, 24, 0, 0, 0, 60]), ctx), [0xf0, 0x43, 0x12, 0x12, 0x65, 33, 0xf7]);
  const rc = Uint8Array.from(FN_INIT);
  assert.deepEqual(fn.sendParam(P('rch'), 0, rc, ctx), [0xf0, 0x43, 0x12, 0x12, 0x6a, 1, 0xf7]);
  rc[3] = 16;
  assert.deepEqual(fn.sendParam(P('rch'), 16, rc, ctx), [0xf0, 0x43, 0x12, 0x12, 0x6c, 15, 0xf7]);
  // panel changes it reports itself (E867-E883) come back into the page
  const back = fn.receive([0xf0, 0x43, 0x12, 0x12, 0x78, 30, 0xf7], d, ctx);
  assert.equal(back[P('kshift').offset], 30);
  assert.equal(fn.receive([0xf0, 0x43, 0x12, 0x12, 0x6a, 0, 0xf7], d, ctx)[3], 1, 'Omni off = channel 1');
  assert.equal(fn.receive([0xf0, 0x43, 0x13, 0x12, 0x78, 30, 0xf7], d, ctx), null, 'other channel');
  assert.equal(objOf(dx21, 'voice').params.find((p) => p.key === 'bcpb').max, 99, 'BC Pitch Bias 0-99 (B66F)');
  const rom = 're/dx/fw/dx21/DX21romv15.BIN';
  if (existsSync(rom)) {
    const b = readFileSync(rom);
    const at = (a) => b[a - 0x8000];
    const text = (a) => { let s = ''; for (let x = a - 0x8000; b[x]; x++) s += String.fromCharCode(b[x]); return s; };
    // the maximum of each function page (B653 + page): page 1 Master Tune, 2 Dual Detune, 3 Midi Switch, 4 Recv Ch, 5 Trns Ch, 10h Mem Protect, 2Fh/30h at 21h/22h
    for (const [k, page] of [['mtune', 1], ['ddet', 2], ['midi', 3], ['tch', 5], ['chinfo', 6], ['sysinfo', 7], ['protect', 0x10], ['bmode', 0x21], ['kshift', 0x22]]) assert.equal(at(0xb653 + page), P(k).max, k);
    assert.equal(at(0xb653 + 4), 16, 'Recv Ch 0 (omni) - 16');
    // the RAM address the receiver writes for each parameter number (table E5CE)
    const ram = (pp) => (at(0xe5ce + 2 * (pp - 0x65)) << 8) | at(0xe5cf + 2 * (pp - 0x65));
    assert.deepEqual([0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x77, 0x78, 0x7c].map(ram), [0x2759, 0x1edb, 0x2758, 0x275b, 0x275c, 0x26bf, 0x26c0, 0x26bf, 0x275d, 0x53, 0x275a, 0x1eec]);
    assert.deepEqual([0xfd2f, 0xfd3d, 0xfd49, 0xfd57, 0xfd65, 0xfd73, 0xff94, 0xfec3, 0xffc2, 0xffcf].map(text),
      ['Master Tune =', 'Dual Detune', 'Midi Switch :', 'Midi Ch Info:', 'Midi Sy Info:', 'Midi Recv Ch =', 'Midi Trns Ch =', 'Mem Protect:', 'Bend Mode = ', 'Key Shift = ']);
    assert.deepEqual([0xfbf8, 0xfbfc, 0xfbff].map(text), BEND_MODES);
  }
  // the simulator keeps them
  const sim = dx21.simulate();
  sim.handle([0xf0, 0x43, 0x10, 0x12, 0x67, 70, 0xf7]);
  assert.equal(sim.unit.fn[0], 70);
});
