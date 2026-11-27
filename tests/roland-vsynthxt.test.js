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
  assert.equal(pz('OSC 1 Analog Waveform').options[11][1], 'SUPER-SAW');
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
  assert.equal(show(pz('OSC 2 Analog Waveform'), d), 'SUPER-SAW');
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
  assert.equal(patch.name(d), ml.name.slice(0, 12).trim(), 'the Head Library name is kept');
  const w = ['supersaw', 'triangle-mod', 'noise', 'feedback', 'square', 'saw', 'triangle'][raw[0x1e]];
  const expect = { supersaw: 'SUPER-SAW', 'triangle-mod': 'TRIANGLE', noise: 'NOISE', feedback: 'FBACK-OSC', square: 'SQUARE', saw: 'SAW', triangle: 'TRIANGLE' }[w];
  assert.equal(show(pz('OSC 1 Analog Waveform'), d), expect);
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

test('V-Synth XT: effect values the firmware computes (its display routine, emulated)', () => {
  const slotOf = (kind, typeName, param) => {
    const [a, b] = FX_BLOCKS[kind];
    const t = FX.slice(a, b).findIndex((f) => f[0] === typeName);
    for (let n = 1; n <= 32; n++) {
      const s = fxSlot(kind, n, t);
      if (!s.hidden && s.label === `${typeName}: ${param}`) return s;
    }
    return null;
  };
  const label = (s, v) => (s.options ? s.options.find(([x]) => x === v)?.[1] : s.format(v));
  const rt = slotOf('reverb', 'ROOM2', 'Reverb Time');
  // FUN_89462840: 0.06, 0.10-0.30 by 0.05, then v + 25 hundredths up to 0.46, then 2.00 by 0.25...
  assert.deepEqual([0, 1, 5, 6, 21, 22, 63].map((v) => label(rt, v)), ['0.06 sec', '0.10 sec', '0.30 sec', '0.31 sec', '0.46 sec', '2.00 sec', '32.00 sec']);
  const dt = slotOf('mfx', 'MULTI TAP DELAY', 'Delay 1 Time');
  assert.deepEqual([0, 80, 105, 106, 121].map((v) => label(dt, v)), ['0 ms', '800 ms', '1300 ms', '1/16', '2'], 'milliseconds, then tempo-synced notes');
  const lfo = slotOf('mfx', 'ANALOG PHASER', 'LFO 2 Rate');
  assert.deepEqual([0, 16, 17, 127].map((v) => label(lfo, v)), ['0.2 Hz', '1.8 Hz', '2.0 Hz', '50.0 Hz']);
  // no case for HALL2's id: the XT shows the list of HALL1's Low Rev Time, whose display spec it
  // shares (on the unit: 0.30, then 0.31 ... 0.46 by 0.01, then 2.00)
  const h2 = slotOf('reverb', 'HALL2', 'Reverb Time');
  assert.deepEqual([5, 6, 21, 22, 79].map((v) => label(h2, v)), ['0.30 sec', '0.31 sec', '0.46 sec', '2.00 sec', '64.00 sec']);
  // and a few nothing formats: the step number, as the routine prints it
  assert.equal(label(slotOf('cosm', 'DUAL FILTER', 'Filter 1 Frequency'), 12), '12 Hz');
});

test('V-Synth XT: .p00 patch files (the XT\'s drive)', async () => {
  const { readP00, writeP00, isP00, packedAt, p00FileName, P00_SIZE } = await import('../js/devices/defs/roland-vsynthxt-p00.js');
  const { patchBuilt } = await import('../js/devices/defs/roland-vsynthxt.js');
  // the layout: blocks end to end, the tone block's last 4 bytes in a table of their own
  assert.deepEqual(['c', 'm', 'ch', 'rv', 't0', 'e0', 'l0', 'ca0', 'cb0', 'ar', 'st0', 'sq', 'zk'].map((k) => packedAt(k, 0)), [0, 84, 152, 180, 230, 1478, 3270, 3590, 4134, 4678, 4684, 5292, 5362]);
  assert.equal(packedAt('t15', 77), 230 + 78 * 15 + 77);
  assert.equal(packedAt('t3', 78), 5228 + 12, 'OSC 1 Detune of zone 4');
  // every value survives a write and a read
  const d = patch.init();
  writeParam(d, pz('OSC 1 Wave'), 513);
  writeParam(d, pz('Octave Shift'), 61);
  writeParam(d, pz('Patch Tempo'), 1335);
  writeParam(d, patch.params.find((p) => p.label === 'COSM 2 COSM Type' && p.section === 'z5'), 16);
  for (let i = 0; i < 12; i++) d[i] = 'Test p00 ok '.charCodeAt(i);
  const f = writeP00(d, patchBuilt);
  assert.equal(f.length, P00_SIZE);
  assert.ok(isP00(f));
  assert.deepEqual(Array.from(f.subarray(0, 8)), [0x00, 0x1e, 0x53, 0x56, 0x44, 0x30, 0, 0], '00 1E "SVD0"');
  assert.deepEqual(Array.from(readP00(f, patchBuilt, patch.init())), Array.from(d));
  assert.equal(p00FileName(7, 'Da \'V\' Code '), '007 Da \'V\' Code.p00');
  // the Head Library imports it as a V-Synth patch
  const { importFiles } = await import('../js/core/mainlib/importers.js');
  const r = await importFiles([{ name: '012 Test p00 ok.p00', bytes: f }]);
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].device.id, 'roland-vsynth-xt');
  assert.equal(r.patches[0].name, 'Test p00 ok');
  // files from the factory drive against the unit's SysEx answers for the same patches
  if (has(LIVE('disk_p001.p00')) && has(LIVE('t24_restore.syx'))) {
    for (const [file, syx] of [['disk_p001.p00', 't24_restore.syx'], ['disk_p002.p00', 'user002.syx']]) {
      const bytes = new Uint8Array(fs.readFileSync(LIVE(file)));
      assert.deepEqual(Array.from(readP00(bytes, patchBuilt, patch.init())), Array.from(patch.fromSyx(splitSysex(fs.readFileSync(LIVE(syx))))), `${file} = ${syx}`);
      assert.deepEqual(Array.from(writeP00(readP00(bytes, patchBuilt, patch.init()), patchBuilt)), Array.from(bytes), `${file} written back byte for byte`);
    }
  }
});

test('V-Synth XT: Digital Output Frequency through device 7E (write only)', async () => {
  const { digitalOutMsg, digitalOutAction } = await import('../js/devices/defs/roland-vsynthxt.js');
  assert.deepEqual(digitalOutMsg(0), [0xf0, 0x41, 0x7e, 0x00, 0x53, 0x12, 0, 0, 0, 0, 0, 0x00, 0xf7], 'sub 0 = 44.1 kHz (checked on the unit)');
  assert.deepEqual(digitalOutMsg(1).slice(10, 12), [1, 0x7f], 'sub 1 = 48 kHz');
  assert.ok(system.actions.includes(digitalOutAction), 'offered on the System page');
  const sent = [];
  await digitalOutAction.run({ form: async (_t, fields) => { assert.deepEqual(fields[0].options.map((o) => o.label), ['44.1 kHz', '48 kHz', '96 kHz']); return { f: '2' }; }, send: (m) => sent.push(...m), toast: () => {} });
  assert.deepEqual(sent, [digitalOutMsg(2)]);
});

test('V-Synth XT: wave names through the undocumented model 00 24 (read only)', async () => {
  const { fileRq1, readWaveNames, WAVE_NAMES, MODEL_FILES } = await import('../js/devices/defs/roland-vsynthxt.js');
  // the request the unit answered: kind 4, wave 1, header (16 bytes); address and size are 5 bytes
  assert.deepEqual(fileRq1(0x10, 4, 1, 0, 16), [0xf0, 0x41, 0x10, 0x00, 0x24, 0x11, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x6c, 0xf7]);
  assert.deepEqual(fileRq1(0x10, 4, 3, 0, 16).slice(6, 11), [0x04, 0x00, 0x02, 0x00, 0x00], 'wave n in address bits 14-27');
  // a fake XT with three waves, then empty numbers
  const names = { 1: 'DLP-Crenshaw', 2: 'DLP-Sheryl', 3: 'DLP-Flutterz' };
  const client = {
    request: async (bytes, { collect }) => {
      const n = bytes[7] * 128 + bytes[8] + 1;
      const data = [...(names[n] || '').padEnd(16, '\0')].map((c) => c.charCodeAt(0));
      const body = [...bytes.slice(6, 11), ...data];
      const s = body.reduce((a, b) => a + b, 0);
      collect({}, Uint8Array.from([0xf0, 0x41, 0x10, ...MODEL_FILES, 0x12, ...body, (128 - (s % 128)) % 128, 0xf7]));
    },
  };
  WAVE_NAMES.clear();
  let asked = 0;
  const counting = { request: (b, o) => { asked++; return client.request(b, o); } };
  await readWaveNames({ g: { client: counting }, ctx: { deviceId: 0x10 } });
  assert.deepEqual([...WAVE_NAMES.entries()], [[1, 'DLP-Crenshaw'], [2, 'DLP-Sheryl'], [3, 'DLP-Flutterz']]);
  assert.equal(asked, 5, 'the names end at the count of loaded waves: stops after two empty numbers');
  assert.equal(patch.params.find((p) => p.name === 'OSC 1 Wave Number').format(2), '2 DLP-Sheryl');
  // a second read says what changed, and leaves exactly what the XT has
  names[2] = 'My Sample';
  delete names[3];
  WAVE_NAMES.set(9, 'gone');
  const changes = await readWaveNames({ g: { client }, ctx: { deviceId: 0x10 } });
  assert.deepEqual(changes.map((c) => [c.n, c.old, c.name]), [[2, 'DLP-Sheryl', 'My Sample'], [3, 'DLP-Flutterz', undefined], [9, 'gone', undefined]]);
  assert.deepEqual([...WAVE_NAMES.keys()], [1, 2]);
  WAVE_NAMES.clear();
});

test('V-Synth XT: pages show what applies (oscillators, parts, patterns)', () => {
  const d = patch.init();
  const vis = (label, section = 'z0') => { const p = pz(label, section); const v = p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p; return v.hidden ? null : v.label; };
  // OSC 1 as PCM: the wave list, no analog settings
  writeParam(d, pz('OSC 1 Type'), 1);
  assert.equal(vis('OSC 1 Analog Waveform'), null);
  assert.equal(vis('OSC 1 Pulse Width'), null);
  assert.equal(vis('OSC 1 Wave'), 'OSC 1 Wave');
  const wave = pz('OSC 1 Wave');
  assert.deepEqual(wave.dynamic(d, {}).options.slice(0, 3), [[0, 'OFF'], [1, '001 DLP-Crenshaw'], [2, '002 DLP-Sheryl']]);
  // every number up to 500 can be chosen: user samples copied onto the drive have no name the XT gives
  const opts = wave.dynamic(d, {}).options;
  assert.equal(opts.length, 501);
  assert.deepEqual(opts[225], [225, '225 (user sample)']);
  assert.deepEqual(opts[500], [500, '500 (user sample)']);
  // ANALOG SUPER-SAW: Pulse Width is Detune, Fat is Mix; PCM settings hidden
  writeParam(d, pz('OSC 1 Type'), 0);
  writeParam(d, pz('OSC 1 Analog Waveform'), 11);
  assert.equal(vis('OSC 1 Pulse Width'), 'OSC 1 Detune');
  assert.equal(vis('OSC 1 Fat LFO Depth'), 'OSC 1 Mix LFO Depth');
  assert.equal(vis('OSC 1 Wave'), null);
  assert.equal(vis('OSC 1 Sub Oscillator Octave'), null, 'no sub-oscillator for SUPER-SAW');
  // SAW with the sub-oscillator: Fat is ignored, its Detune applies
  writeParam(d, pz('OSC 1 Analog Waveform'), 0);
  writeParam(d, pz('OSC 1 Sub Oscillator Octave'), 2);
  assert.equal(vis('OSC 1 Fat'), null);
  assert.equal(vis('OSC 1 Sub Oscillator Detune'), 'OSC 1 Sub Oscillator Detune');
  assert.ok(pz('OSC 1 Type').relayout && pz('OSC 1 Analog Waveform').relayout);
  // System: one patch list per part, channels and knob positions as lists, controller names
  const s = system.init();
  const part = system.params.find((p) => p.label === 'Part 1 Patch');
  assert.ok(system.params.find((p) => p.name === 'Part 1 Bank Select MSB (CC# 0)').hidden);
  assert.equal(readParam(s, part), 87 * 16384, '87/0, program 1');
  const names = new Map([['0:0', "Da 'V' Code"]]);
  assert.equal(part.dynamic(s, { names: { patch: names } }).options[0][1], "U001 Da 'V' Code");
  assert.equal(part.dynamic(s, {}).options[511][1], 'U512');
  writeParam(s, part, 87 * 16384 + 2 * 128 + 5);
  assert.deepEqual(Array.from(s.slice(part.offset, part.offset + 3)), [87, 2, 5]);
  assert.deepEqual(part.send(0, { deviceId: 0x10 }, s).slice(5, 13), [0x12, 0x01, 0x00, 0x00, 0x00, 87, 2, 5], 'one DT1 with the three bytes');
  assert.deepEqual(system.params.find((p) => p.name === 'Part 3 Receive Channel').options.slice(0, 2), [[0, '1'], [1, '2']]);
  assert.deepEqual(system.params.find((p) => p.name === 'User Set 1 Knob 1 Parameter Assign').options.filter(([v]) => [0, 7, 16, 23].includes(v)).map(([, l]) => l), ['OSC1-PRM1', 'OSC1-LVL', 'CSM1-PRM1', 'TVA-REL']);
  assert.equal(system.params.find((p) => p.name === 'Knob 1 CC Assign').options[7][1], 'CC07 Volume');
  // pattern editors: four tracks of 16 bipolar steps, an arpeggio pattern of 16 lines x 32 steps
  const seq = patch.groupInfo['Step tracks'].pattern({ data: d });
  assert.deepEqual([seq.length, seq.lanes.length, seq.lanes[0].steps.length, seq.lanes[0].zero], [16, 4, 16, 64]);
  assert.ok(seq.lanes[0].steps.every((p) => /^Track 1 Step \d\d Value$/.test(p.name)));
  const arp = patch.groupInfo['Arpeggio pattern'].pattern({ data: d });
  assert.deepEqual([arp.length, arp.lanes.length, arp.lanes[0].rest, arp.lanes[0].tie], [32, 16, 0, 128]);
  const num = patch.params.find((p) => p.key.startsWith('st0_') && p.name === 'Control Number');
  assert.equal(num.dynamic(d).options[60][1], 'C4', 'a NOTE line names its note');
});

test('V-Synth XT: user samples (WAV with the V-Synth chunks) keep their key, tempo and range', async () => {
  const { parseWav } = await import('../js/core/wav.js');
  const { importFiles } = await import('../js/core/mainlib/importers.js');
  // RIFF WAVE: fmt (mono 16-bit 44.1 kHz), vpsc, vpno, data (100 frames)
  const chunk = (tag, body) => { const b = new Uint8Array(8 + body.length + (body.length & 1)); b.set([...tag].map((c) => c.charCodeAt(0))); new DataView(b.buffer).setUint32(4, body.length, true); b.set(body, 8); return b; };
  const u32 = (...w) => { const b = new Uint8Array(4 * w.length); w.forEach((x, i) => new DataView(b.buffer).setUint32(4 * i, x >>> 0, true)); return b; };
  const fmt = new Uint8Array(16); const fv = new DataView(fmt.buffer);
  fv.setUint16(0, 1, true); fv.setUint16(2, 1, true); fv.setUint32(4, 44100, true); fv.setUint32(8, 88200, true); fv.setUint16(12, 2, true); fv.setUint16(14, 16, true);
  const vpsc = u32(0x0100030b, 100, 0x003fabe0, 0x210000, 10 * 16, 90 * 16, 0, 1080000);
  const vpno = u32(8, 3, 0, 0);
  const parts = [chunk('fmt ', fmt), chunk('vpsc', vpsc), chunk('vpno', vpno), chunk('data', new Uint8Array(200))];
  const body = parts.reduce((n, p) => n + p.length, 4);
  const wav = new Uint8Array(8 + body);
  wav.set([...'RIFF'].map((c) => c.charCodeAt(0))); new DataView(wav.buffer).setUint32(4, body, true); wav.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  let o = 12; for (const p of parts) { wav.set(p, o); o += p.length; }
  const w = parseWav(wav.buffer);
  assert.deepEqual(w.vsynth, { encoded: true, encodeType: 3, stereo: false, frames: 100, originalKey: 63, start: 10, end: 90, tempo: 108, events: 3 });
  const r = await importFiles([{ name: '012 108 Test.wav', bytes: wav }]);
  const s = r.patches[0].settings.Sample;
  assert.equal(s['Original key'], 'D#4 (63)');
  assert.equal(s.Tempo, '108.00 BPM');
  assert.equal(s.Variphrase, 'encoded (type A03, 3 events)');
  assert.equal(r.samples[0].info.rootKey, 63);
  const real = LIVE('user_sample_225.wav');
  if (has(real)) {
    const b = fs.readFileSync(real);
    const rw = parseWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    assert.deepEqual([rw.vsynth.originalKey, rw.vsynth.tempo, rw.vsynth.end, rw.frames], [60, 118.183, 19918, 19918], 'the sample recorded on the unit');
  }
});
