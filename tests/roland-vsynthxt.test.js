// Roland V-Synth XT (V-Synth engine, OS 2.02): tables from the firmware, the address map, displays,
// effect slots, the translator, and (when present) the dumps read from the unit in re/vsynthxt/live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import def, { _test, MODEL, A, userPatch, fxSlot } from '../js/devices/defs/roland-vsynthxt.js';
import { P, E, FX, FX_BLOCKS, MUSICAL, CATEGORIES } from '../js/devices/defs/roland-vsynthxt-fw.js';
import { readParam, writeParam, formatParam } from '../js/core/model/memmap.js';
import { splitSysex } from '../js/core/midi/describe.js';
import { getDevice } from '../js/devices/registry.js';
import { patchFromObject, objectFromPatch, loadMode } from '../js/devices/patches.js';

const LIVE = (f) => new URL(`../re/vsynthxt/live/${f}`, import.meta.url);
const has = (u) => fs.existsSync(u);
const patch = def.objects.find((o) => o.key === 'patch');
const system = def.objects.find((o) => o.key === 'system');
const pz = (label, section = 'z0') => patch.params.find((p) => p.label === label && p.section === section) || patch.params.find((p) => p.label === label);
const show = (p, d) => { const v = readParam(d, p); return p.options ? p.options.find(([x]) => x === v)?.[1] : p.format ? p.format(v) : formatParam(p, v); };

test('V-Synth XT: tables and address map from the firmware', () => {
  assert.equal(P.filter(Boolean).length, 986);
  assert.equal(E.filter(Boolean).length, 993);
  assert.equal(FX.length, 98);
  assert.deepEqual(FX_BLOCKS, { mfx: [0, 51], chorus: [51, 62], reverb: [62, 81], cosm: [81, 98] });
  assert.equal(MUSICAL.length, 17);
  assert.equal(CATEGORIES.length, 16);
  assert.ok(getDevice('roland-vsynth-xt'), 'in the catalog (catalog-extra.js)');
  // block sizes as the XT answers them (one RQ1 over a patch: 103 DT1 of these sizes)
  const sizes = _test.patchBuilt.parts.map((p) => p.size);
  assert.deepEqual(sizes.slice(0, 7), [0x72, 0x84, 0x33, 0x62, 0x0d, 0x10, 0x62]);
  assert.equal(sizes.length, 7 + 16 * 5 + 16);
  assert.equal(patch.size, 9082);
  assert.equal(userPatch(0), A('20 00 00 00'));
  assert.equal(userPatch(511), A('23 7f 00 00'));
  assert.deepEqual(_test.sysBuilt.parts.map((p) => p.size), [0x37, 0x38, 0x1b, 0x48]);
});

test('V-Synth XT: values shown as on the XT', () => {
  const d = patch.init();
  assert.equal(show(pz('Octave Shift'), d), '0');
  writeParam(d, pz('Octave Shift'), 61);
  assert.equal(show(pz('Octave Shift'), d), '-3', 'SysEx 61-67 (centre 64)');
  writeParam(d, pz('Patch Tempo'), 1200);
  assert.equal(show(pz('Patch Tempo'), d), '120.0');
  assert.equal(pz('Patch Tempo').nibbles, 4);
  assert.deepEqual(pz('Mono/Poly').options, [[0, 'MONO'], [1, 'POLY']]);
  assert.equal(pz('OSC 1 Analog Wavefrom').options[11][1], 'SUPER-SAW');
  const atk = pz('Env 1 Attack Time');
  assert.equal(atk.nibbles, 2);
  writeParam(d, atk, 135);
  assert.equal(show(atk, d), '1/4', 'tempo-synced values after 0-127');
  writeParam(d, pz('Patch Category'), 4);
  assert.equal(show(pz('Patch Category'), d), 'Vox/Choir');
  assert.equal(show(pz('TVA Pan'), d), '0');
  const eq = system.params.find((p) => p.label === 'EQ Low Freq');
  assert.deepEqual(eq.options.slice(0, 4).map(([, l]) => l.replace(/\s+/g, ' ')), ['50 Hz', '63 Hz', '80 Hz', '100 Hz'], 'a firmware value list (1/3 octaves), not a straight line');
});

test('V-Synth XT: effect parameters follow the effect type', () => {
  assert.equal(fxSlot('mfx', 1, 1).label, 'PARAMETRIC EQ: Low Freq');
  assert.equal(fxSlot('mfx', 1, 0).hidden, true, 'THRU has no parameters');
  const tvf = FX.slice(81, 98).findIndex((f) => f[0] === 'TVF Mode0');
  assert.equal(fxSlot('cosm', 5, tvf).label, 'TVF Mode0: Cutoff');
  assert.equal(fxSlot('reverb', 1, 10).label.startsWith('DELAY:'), true);
  const d = patch.init();
  writeParam(d, pz('MFX Type'), 1);
  const p1 = patch.params.find((p) => p.key === 'm_7');
  assert.equal(p1.dynamic(d).label, 'PARAMETRIC EQ: Low Freq');
  writeParam(d, p1, 5);
  assert.equal(readParam(d, p1), 5);
  assert.deepEqual(Array.from(d.slice(p1.offset, p1.offset + 4)), [8, 0, 0, 5], 'value + 32768 in 4 nibbles');
});

test('V-Synth XT: dumps from the unit decode and rebuild bit for bit (skipped when absent)', { skip: !has(LIVE('before.syx')) }, () => {
  const msgs = splitSysex(fs.readFileSync(LIVE('before.syx')));
  assert.equal(msgs.length, 103);
  const d = patch.fromSyx(msgs);
  assert.equal(patch.name(d), "Da 'V' Code");
  assert.equal(show(pz('Patch Tempo'), d), '87.3');
  assert.equal(show(pz('OSC 2 Analog Wavefrom'), d), 'SUPER-SAW');
  // the editor's own writes reproduce the dump exactly
  const out = patch.sendAll.build(d, { deviceId: 0x10 });
  const back = patch.fromSyx(out.map((m) => Uint8Array.from(m)));
  assert.deepEqual(Array.from(back), Array.from(d));
  const items = _test.libraryItems(msgs);
  assert.deepEqual(items.map((i) => [i.label, i.object, i.name]), [['Temporary patch', 'patch', "Da 'V' Code"]]);
  if (has(LIVE('system.syx'))) {
    const s = system.fromSyx(splitSysex(fs.readFileSync(LIVE('system.syx'))));
    assert.equal(show(system.params.find((p) => p.label === 'Part 1 Bank Select MSB (CC# 0)'), s), '87');
  }
});

test('V-Synth XT: JP-8080 and V-Synth patches through the shared model', async () => {
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jpPatch = jp.objects.find((o) => o.key === 'patch');
  const raw = has(new URL('../re/jp8080/live/stored_patch_upper.bin', import.meta.url))
    ? new Uint8Array(fs.readFileSync(new URL('../re/jp8080/live/stored_patch_upper.bin', import.meta.url)))
    : (() => { const x = jpPatch.init(); x.set([...'BA Test         '].map((c) => c.charCodeAt(0))); x[0x1e] = 3; x[0x29] = 80; x[0x27] = 2; return x; })();
  const ml = patchFromObject(getDevice('roland-jp8080'), jp, jpPatch, raw);
  assert.equal(loadMode(getDevice('roland-vsynth-xt'), def, patch, ml), 'translate');
  const r = objectFromPatch(getDevice('roland-vsynth-xt'), def, patch, ml);
  const d = r.data;
  assert.equal(patch.name(d), ml.name.slice(0, 12).trim(), 'the Main Library name is kept');
  const w = ['supersaw', 'triangle-mod', 'noise', 'feedback', 'square', 'saw', 'triangle'][raw[0x1e]];
  const expect = { supersaw: 'SUPER-SAW', 'triangle-mod': 'TRIANGLE', noise: 'NOISE', feedback: 'FBACK-OSC', square: 'SQUARE', saw: 'SAW', triangle: 'TRIANGLE' }[w];
  assert.equal(show(pz('OSC 1 Analog Wavefrom'), d), expect);
  assert.equal(show(pz('COSM 1 COSM Type'), d), 'TVF Mode0', 'the filter becomes COSM 1 TVF');
  assert.equal(readParam(d, pz('COSM 1 COSM Parameter 5')), Math.round((raw[0x29] / 127) * 126), 'cutoff');
  assert.ok(r.report.mapped.length > 10);
  assert.ok(!r.report.dropped.some((x) => /Unison detune/.test(x)) || raw[0xf3], 'unison detune only when unison is on');
  // and back: the V-Synth patch read by a JP
  const vsMl = patchFromObject(getDevice('roland-vsynth-xt'), def, patch, d);
  assert.equal(vsMl.common.extra.family, 'roland-vsynth');
  const toJp = objectFromPatch(getDevice('roland-jp8080'), jp, jpPatch, vsMl);
  assert.equal(toJp.mode, 'translate');
  assert.equal(toJp.data[0x1e], raw[0x1e] === 1 ? 6 : raw[0x1e], 'the waveform comes back (TRIANGLE MOD came back as TRIANGLE)');
});
