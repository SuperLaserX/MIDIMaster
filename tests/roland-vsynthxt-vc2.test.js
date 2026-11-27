// Roland V-Synth XT, VC-2 engine (Vocal Designer): its own model 00 00 0D map, every byte of each
// block, values from the VC-2's screen lists, the dumps read from the unit (re/vsynthxt/live when
// present), the Head Library import and the translator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import def, { _test, patchBuilt, sysBuilt, nameOf, pOf, MODEL, A, userPatch, USER_PATCHES, fxSlot } from '../js/devices/defs/roland-vsynthxt-vc2.js';
import { LISTS } from '../js/devices/defs/roland-vsynthxt-vc2-lists.js';
import { readParam, writeParam, formatParam } from '../js/core/model/memmap.js';
import { splitSysex } from '../js/core/midi/describe.js';
import { getDevice } from '../js/devices/registry.js';
import { patchFromObject, objectFromPatch } from '../js/devices/patches.js';
import { importFiles } from '../js/core/mainlib/importers.js';

const LIVE = (f) => new URL(`../re/vsynthxt/live/${f}`, import.meta.url);
const has = (u) => fs.existsSync(u);
const patch = def.objects.find((o) => o.key === 'patch');
const system = def.objects.find((o) => o.key === 'system');
const show = (p, d) => { const v = readParam(d, p); const q = p.dynamic ? { ...p, ...p.dynamic(d) } : p; return q.options ? q.options.find(([x]) => x === v)?.[1] : q.format ? q.format(v) : formatParam(q, v); };

test('VC-2: model 00 00 0D and its address map', () => {
  assert.ok(getDevice('roland-vsynth-xt-vc2'), 'in the catalog (catalog-extra.js)');
  assert.deepEqual(MODEL, [0x00, 0x00, 0x0d]);
  assert.deepEqual(patchBuilt.parts.map((p) => [p.at, p.size]), [[0, 0x14b], [A('00 03 00'), 0x43], [A('00 04 00'), 0x0f], [A('00 05 00'), 0x0e]]);
  assert.equal(patch.size, 427);
  assert.deepEqual(sysBuilt.parts.map((p) => p.size), [0x0c, 0x91, ...Array(8).fill(0x1d)]);
  assert.equal(sysBuilt.parts[3].at, A('03 00 01 00'));
  assert.equal(userPatch(USER_PATCHES - 1), A('23 3f 00 00'), 'U448');
  // every byte of every block is a parameter (or one nibble of one)
  for (const built of [patchBuilt, sysBuilt]) {
    const covered = new Uint8Array(built.size);
    for (const p of built.params.filter((x) => !x.get)) for (let i = 0; i < (p.nibbles || 1); i++) { assert.equal(covered[p.offset + i], 0, `${p.key} overlaps`); covered[p.offset + i] = 1; }
    assert.equal(covered.indexOf(0), -1, `byte ${covered.indexOf(0)} has no parameter`);
  }
  assert.equal(pOf('c', 'Chorus Type').at, A('00 01 36'));
  assert.equal(pOf('c', 'Reverb Type').at, A('00 01 69'));
  assert.equal(pOf('c', 'Reverb Parameter 24').at, A('00 02 47'));
  assert.equal(pOf('ca', 'TVA Pan Mod Depth').at, A('00 03 42'));
  assert.equal(pOf('sy', 'Chord Memory B Key 4').at, A('02 00 00 00') + 0x8f);
});

test('VC-2: values as the VC-2 shows them', () => {
  assert.equal(LISTS.algorithm.length, 12);
  assert.equal(LISTS.mfx.length, 42);
  assert.equal(pOf('c', 'Reverb Type').options.length, 15, 'reverb types 0-14 (the unit refuses 15 and 17)');
  assert.equal(pOf('ca', 'Vibrato Control').options[32][1], 'OFF', 'CC32 shows OFF');
  assert.equal(pOf('ca', 'Vibrato Control').options[109][1], 'BREATH');
  assert.ok(!pOf('mo', 'OSC Pitch Control').options.some(([, l]) => l === 'VELO' || l === 'KEYF'), 'modulator controls without VELO and KEYF');
  const d = patch.init();
  writeParam(d, pOf('c', 'Algorithm'), 11);
  assert.equal(show(pOf('c', 'Algorithm'), d), 'Process Type2');
  writeParam(d, pOf('ca', 'OSC1 Formant Style'), 9);
  assert.equal(show(pOf('ca', 'OSC1 Formant Style'), d), 'MANHATTN');
  writeParam(d, pOf('vo', 'Formant Type'), 15);
  assert.equal(show(pOf('vo', 'Formant Type'), d), 'STFEM2');
  writeParam(d, pOf('ca', 'TVA Pan'), 0);
  assert.equal(show(pOf('ca', 'TVA Pan'), d), 'L64');
  writeParam(d, pOf('ca', 'OSC1 Formant KF'), 84);
  assert.equal(show(pOf('ca', 'OSC1 Formant KF'), d), '+200');
  writeParam(d, pOf('c', 'Reverb Type'), 6);
  assert.match(pOf('c', 'Reverb Parameter 1').dynamic(d).label, /^Stereo Cathedral: /, 'effect parameters named per type, with the screen name');
  // value lists the firmware computes, from the VC-2's own display routine (894FA070, emulated)
  const echo = fxSlot('reverb', 2, 4);
  assert.deepEqual([0, 5, 6, 41].map((v) => echo.options.find(([x]) => x === v)[1]), ['0.06 S', '0.30 S', '0.40 S', '10.00 S'], 'ST_ECHO Rev Time');
  const s = system.init();
  writeParam(s, pOf('sy', 'Master Tune'), 1024);
  assert.equal(show(pOf('sy', 'Master Tune'), s), '440.0 Hz');
  writeParam(s, pOf('sy', 'Chord Memory C Key 1'), 60);
  assert.equal(show(pOf('sy', 'Chord Memory C Key 1'), s), 'C4');
  // a parameter change is one DT1 with the 3-byte model
  const p = pOf('vo', 'Vocoder Level');
  writeParam(d, p, 99);
  const m = p.send(99, { deviceId: 0x10 }, d);
  assert.deepEqual(m.slice(0, 11), [0xf0, 0x41, 0x10, 0x00, 0x00, 0x0d, 0x12, 0x10, 0x00, 0x05, 0x02]);
  assert.equal(m[11], 99);
});

test('VC-2: dumps from the unit decode and rebuild exactly', { skip: !has(LIVE('vc2_before.syx')) }, async () => {
  const msgs = splitSysex(fs.readFileSync(LIVE('vc2_before.syx')));
  const d = patch.fromSyx(msgs);
  assert.equal(nameOf(d), 'LargeChoir 1');
  assert.equal(show(pOf('c', 'Algorithm'), d), 'Modeling Choir');
  assert.equal(show(pOf('c', 'Reverb Type'), d), 'Stereo Cathedral');
  assert.equal(show(pOf('ca', 'Growl Control'), d), 'BREATH');
  const again = patch.fromSyx(splitSysex(Uint8Array.from(patch.toSyx(d, { deviceId: 0x10 }))));
  assert.deepEqual(again, d);
  for (const p of patch.params) { if (p.fxSlot) continue; const v = readParam(d, p); assert.ok(v >= p.min && v <= p.max, `${p.key} ${p.name} = ${v}`); }
  if (has(LIVE('vc2_system.syx')) && has(LIVE('vc2_setup.syx')) && has(LIVE('vc2_templates.syx'))) {
    const all = ['vc2_setup.syx', 'vc2_system.syx', 'vc2_templates.syx'].flatMap((f) => splitSysex(fs.readFileSync(LIVE(f))));
    const s = system.fromSyx(all);
    for (const p of system.params) { const v = readParam(s, p); assert.ok(v >= p.min && v <= p.max, `${p.key} ${p.name} = ${v}`); }
    const back = system.fromSyx(splitSysex(Uint8Array.from(system.toSyx(s, { deviceId: 0x10 }))));
    assert.deepEqual(back, s);
  }
  if (has(LIVE('vc2_u001.syx'))) {
    const file = fs.readFileSync(LIVE('vc2_u001.syx'));
    const items = _test.libraryItems(splitSysex(file));
    assert.equal(items[0].label, 'User patch U001');
    assert.ok(items[0].name.length > 0);
    const r = await importFiles([{ name: 'vc2.syx', bytes: file }]);
    const vc = r.patches.filter((x) => x.device.id === 'roland-vsynth-xt-vc2');
    assert.equal(vc.length, 1);
    assert.ok(vc[0].settings['Vocoder / Vocoder']);
  }
});

test('VC-2: JP-8080, V-Synth and VC-2 patches through the shared model', async () => {
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jpPatch = jp.objects.find((o) => o.key === 'patch');
  const raw = jpPatch.init();
  raw.set([...'PD Choir        '].map((c) => c.charCodeAt(0)));
  const ml = patchFromObject(getDevice('roland-jp8080'), jp, jpPatch, raw);
  const r = objectFromPatch(getDevice('roland-vsynth-xt-vc2'), def, patch, ml);
  assert.equal(r.mode, 'translate');
  assert.equal(nameOf(r.data), 'PD Choir');
  assert.ok(r.report.mapped.length > 5);
  for (const p of patch.params) { if (p.fxSlot) continue; const v = readParam(r.data, p); assert.ok(v >= p.min && v <= p.max, `${p.key} ${p.name} = ${v}`); }
  // VC-2 -> V-Synth engine
  const vs = (await import('../js/devices/defs/roland-vsynthxt.js')).default;
  const vsPatch = vs.objects.find((o) => o.key === 'patch');
  const src = has(LIVE('vc2_before.syx')) ? patch.fromSyx(splitSysex(fs.readFileSync(LIVE('vc2_before.syx')))) : r.data;
  const vml = patchFromObject(getDevice('roland-vsynth-xt-vc2'), def, patch, src);
  assert.equal(vml.common.extra.family, 'roland-vc2');
  const toVs = objectFromPatch(getDevice('roland-vsynth-xt'), vs, vsPatch, vml);
  assert.equal(toVs.mode, 'translate');
  assert.equal(vsPatch.name(toVs.data), vml.name.slice(0, 12).trim());
  assert.deepEqual(objectFromPatch(getDevice('roland-vsynth-xt-vc2'), def, patch, vml).data, src, 'same model: byte for byte');
});

test('VC-2: .p02 patch files', async () => {
  const { readP02, writeP02, isP02, p02FileName, P02_SIZE } = await import('../js/devices/defs/roland-vsynthxt-vc2-p02.js');
  const { VC2_MAP } = await import('../js/devices/defs/roland-vsynthxt-vc2-map.js');
  // every byte of the patch has a place in the file
  for (const p of patch.params.filter((x) => !x.get)) assert.ok(VC2_MAP[p.key], `${p.key} ${p.name} has no place in a .p02`);
  const d = patch.init();
  writeParam(d, pOf('ca', 'OSC1 Pitch Octave Shift'), 66);
  writeParam(d, pOf('ca', 'Growl Intensity'), 99);
  writeParam(d, pOf('mo', 'OSC Wave'), 90);
  writeParam(d, pOf('c', 'Reverb Parameter 3'), -1234);
  const f = writeP02(d, patch.params);
  assert.equal(f.length, P02_SIZE);
  assert.ok(isP02(f));
  assert.equal(String.fromCharCode(...f.slice(2, 12)), 'VC20Rev008');
  assert.deepEqual(readP02(f, patch.params, patch.init()), d, 'written and read back');
  assert.equal(p02FileName(7, 'Talkin\'Box 1'), '007 Talkin\'Box 1.p02');
  assert.equal(def.readFile('x.p02', f)[0].object, 'patch');
  assert.equal(def.readFile('x.p02', new Uint8Array(10)), null);
  // the factory files read as the unit answers for the same patches (U001-U016)
  if (has(LIVE('vc2_u001-016.json')) && has(LIVE('vc2p02/001.p02'))) {
    const users = Object.values(JSON.parse(fs.readFileSync(LIVE('vc2_u001-016.json'), 'utf8')));
    users.forEach((u, i) => {
      const file = fs.readFileSync(LIVE(`vc2p02/${String(i + 1).padStart(3, '0')}.p02`));
      assert.deepEqual(readP02(file, patch.params, patch.init()), Uint8Array.from(u), `factory ${i + 1}`);
    });
    const r = await importFiles([{ name: '002 FairyWhisper.p02', bytes: fs.readFileSync(LIVE('vc2p02/002.p02')) }]);
    const vc = r.patches.filter((x) => x.device.id === 'roland-vsynth-xt-vc2');
    assert.equal(vc.length, 1);
    assert.equal(vc[0].name, 'FairyWhisper');
  }
});

test('VC-2: what each algorithm takes', async () => {
  const { ALG_GROUPS, ALG_WAVES } = await import('../js/devices/defs/roland-vsynthxt-vc2-map.js');
  const { algorithmInit } = await import('../js/devices/defs/roland-vsynthxt-vc2.js');
  assert.equal(ALG_GROUPS.length, 12);
  const hidden = (d, block, name) => !!pOf(block, name).dynamic?.(d)?.hidden;
  const d = algorithmInit(0); // Modeling Choir: carrier, no modulator
  assert.equal(nameOf(d), 'INIT PATCH');
  assert.equal(readParam(d, pOf('c', 'Algorithm')), 0);
  assert.ok(!hidden(d, 'ca', 'OSC1 Wave') && hidden(d, 'mo', 'OSC Wave') && hidden(d, 'ca', 'OSC1 Formant Style'));
  const range = (o) => [o[0][0], o[o.length - 1][0]];
  assert.deepEqual(range(pOf('ca', 'OSC1 Wave').dynamic(d).options), [1, 24]);
  assert.equal(pOf('ca', 'OSC1 Wave').dynamic(d).options[0][1], '1 LargeCho A S', 'the factory wave names');
  assert.deepEqual(range(pOf('ca', 'OSC2 Wave').dynamic(d).options), [0, 52]);
  assert.equal(pOf('ca', 'OSC2 Wave').dynamic(d).options[0][1], 'OFF');
  const v = algorithmInit(7); // Vocoder Choir: the modulator too
  assert.equal(readParam(v, pOf('c', 'Algorithm')), 7);
  assert.ok(!hidden(v, 'mo', 'OSC Wave') && !hidden(v, 'vo', 'Hold Dump Time'));
  assert.ok(pOf('ca', 'OSC2 Wave').dynamic(algorithmInit(1)).readOnly, 'no OSC 2 wave under algorithm 1');
  assert.ok(hidden(algorithmInit(11), 'ca', 'OSC1 Level'), 'Process Type2: no carrier');
  assert.ok(!hidden(algorithmInit(11), 'c', 'Reverb Type'), 'group 0 always');
  // choosing an algorithm loads its INIT PATCH, as the unit does
  const e = patch.init();
  writeParam(e, pOf('c', 'Algorithm'), 3);
  assert.match(pOf('c', 'Algorithm').after(e, 3), /INIT PATCH/);
  assert.deepEqual(e, algorithmInit(3));
  for (const a of ALG_WAVES) for (const w of [a.osc1, a.osc2, a.mod]) if (w) assert.ok(w[0] <= w[1]);
});

test('VC-2: modulator waves by name, in the order the VC-2 lists them (value = wave number + 82, mod 128)', async () => {
  const m = await import('../js/devices/defs/roland-vsynthxt-vc2.js');
  const obj = m.default.objects.find((o) => o.params.some((p) => p.key === 'mo_1'));
  const p = obj.params.find((x) => x.key === 'mo_1');
  const list = p.dynamic(m.algorithmInit(7), {}).options; // algorithm 7 has a modulator
  assert.deepEqual(list.slice(0, 2), [[83, '1 LargeCho A S'], [84, '2 LargeCho B S']], 'the screen\'s first two');
  assert.equal(list.length, 128);
  assert.equal(m.modWave(0), 46);
  assert.equal(m.modWave(82), 0);
  assert.equal(p.format(83), '1 LargeCho A S');
});
