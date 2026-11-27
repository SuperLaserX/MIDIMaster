// Roland SYSTEM-8: SysEx framing, the address map, the three patch structs, performances, the simulator, the
// Branch Library items, connections and the translators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import S8, * as M from '../js/devices/defs/roland-system8.js';
import * as MEM from '../js/devices/defs/roland-system8-mem.js';
import * as OS from '../js/devices/defs/roland-system8-os.js';
import { OS_GROUPS, OS_CC } from '../js/devices/defs/roland-system8-fw.js';
import { readParam, writeParam } from '../js/core/model/memmap.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(' ');
const obj = (k) => S8.objects.find((o) => o.key === k);
const patchObj = obj('patch');
const P = (key) => patchObj.params.find((p) => p.key === key);
const PP = (key) => obj('performance').params.find((p) => p.key === key);
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);

/** A client over the simulator, as GenericContext's DeviceClient.request is used by the definition. */
function simClient(sim) {
  return {
    request: (bytes, opts) => new Promise((resolve) => {
      const got = [];
      for (const r of sim.handle(Array.from(bytes)) || []) if (opts.collect({}, r)) { got.push(r); if (opts.complete?.(got)) break; }
      resolve({ messages: got });
    }),
  };
}
const api = (sim) => ({ g: { client: simClient(sim) }, ctx: { deviceId: 0x10, channel: 0 } });

test('SysEx framing: DT1/RQ1 with model 00 00 7E and the Roland checksum', () => {
  assert.equal(hex(M.dt1(M.A(0x70, 0, 2, 0), [0])), 'f0 41 10 00 00 7e 12 70 00 02 00 00 0e f7');
  const p = M.parse([0xf0, 0x41, 0x10, 0x00, 0x00, 0x7e, 0x12, 0x71, 0x00, 0x02, 0x00, 0x02, 0x0b, 0xf7]);
  assert.ok(p.ok);
  assert.deepEqual([p.cmd, p.addr, p.data], [0x12, M.A(0x71, 0, 2, 0), [2]]);
  assert.equal(hex(M.rq1(M.A(0x20), 640)), 'f0 41 10 00 00 7e 11 20 00 00 00 00 00 05 00 5b f7');
  assert.equal(S8.sysex.deviceIdDefault, 0x10, 'the unit answers device ID 10h only');
});

test('address map: patch / patch2 / patch3 of every slot, performances, and locate() back', () => {
  const s = (a) => hex(M.a28(a));
  assert.deepEqual(M.slotBases(0, 9).map(s), ['21 01 00 00', '29 10 00 00', '49 10 00 00']);
  assert.deepEqual(M.slotBases(3, 63).map(s), ['0f 77 00 00', '6f 70 00 00', '67 70 00 00']);
  assert.equal(s(M.slotPatchAddr(2, 9)), '0e 11 00 00');
  assert.equal(s(M.perfAddr(0)), '10 00 00 00');
  assert.equal(s(M.perfAddr(63)), '17 70 00 00');
  for (const [slot, p] of [[0, 0], [1, 17], [2, 40], [3, 63]]) {
    M.slotBases(slot, p).forEach((a, k) => {
      const l = MEM.locate(a + 0x10);
      assert.deepEqual([l.kind, l.slot, l.patch, l.struct], ['slot', slot, p, MEM.FULL[k]], `slot ${slot} patch ${p} struct ${k}`);
    });
  }
  assert.deepEqual(MEM.locate(M.A(0x06, 0x22, 0x10, 0)), { kind: 'temp', temp: 1, struct: MEM.S_PATCH3, base: M.A(0x06, 0x20) });
  assert.equal(MEM.locate(M.A(0x15, 0x30, 0x10)).perf, 43);
  assert.equal(MEM.S_PATCH2.size, 3975);
  assert.equal(MEM.S_PATCH3.size, 15580);
  assert.equal(MEM.S_PERF.size, 2709);
  assert.equal(MEM.FULL_SIZE, 20195);
});

test('full patch: every value in range at init, unique keys, steps replicated, names', () => {
  const d = patchObj.init();
  assert.equal(d.length, 20195);
  assert.equal(M.nameOf(d), 'INIT PATCH');
  for (const p0 of patchObj.params) {
    if (p0.kind === 'char') continue;
    const p = view(p0, d);
    const v = readParam(d, p);
    assert.ok(v >= p.min && v <= p.max, `${p.key} = ${v}`);
    if (p.options) assert.ok(p.options.some(([x]) => x === v), `${p.key} = ${v} is not an option`);
  }
  assert.equal(new Set(patchObj.params.map((p) => p.key)).size, patchObj.params.length);
  assert.deepEqual(Array.from(d.slice(4, 6)), [5, 4], 'LFO RATE default 84');
  writeParam(d, P('octave_shift'), -2);
  assert.equal(readParam(d, P('octave_shift')), -2);
  // step 64's gate sits in the last step leaf (patch3 leaf 64), OS default 50 (%)
  assert.equal(readParam(d, P('s64_gate_voice_1')), 50);
  assert.equal(P('s64_gate_voice_1').offset, MEM.S_PATCH3.compact(64 * 0x800 + 16));
  assert.equal(readParam(d, P('delay_feedback')), 120);
  assert.equal(readParam(d, P('reverb_high_cut')), 11);
  assert.equal(view(P('reverb_high_cut'), d).options[11][1], '8kHz');
  assert.equal(P('chorus_low_cut').options[2][1], '25Hz');
  assert.equal(P('patch_tempo').format(1200), '120.0', 'OS: Tempo 40.0-300.0, one decimal');
});

test('value lists come from the unit\'s region 0 tables and follow the variations', () => {
  const d = patchObj.init();
  const wave = (p) => view(p, d).options.map(([, t]) => t);
  assert.deepEqual(wave(P('osc1_wave')), ['SAW', 'SQR', 'TRI', 'SAW2', 'SQR2', 'TRI2']);
  writeParam(d, P('osc1_variation'), 2);
  assert.deepEqual(wave(P('osc1_wave')), ['FM 1:1', 'FM 1:1.5', 'FM 1:2', 'FM 1:3.5', 'FM 1:15', 'FM 6:1']);
  writeParam(d, P('filter_variation'), 1);
  assert.deepEqual(wave(P('filter_type')), ['SBF1', 'SBF2', 'SBF3', 'SBF4', 'SBF5', 'SBF6']);
  assert.deepEqual(P('osc1_variation').options.map(([, t]) => t), ['1', '2', '3', '4']);
  assert.equal(P('lfo_cv_in').options[0][1], '(OPEN)');
});

test('simulator: full patches read and stored in every slot, names by the quick name read', async () => {
  const sim = S8.simulate();
  const a = api(sim);
  const d = await patchObj.slots.fetch(a, 0, 9);
  assert.equal(M.nameOf(d), 'SYSTEM-8 B-2');
  assert.equal(await patchObj.slots.fetchName(a, 0, 10), 'SYSTEM-8 B-3');
  M.setName(d, 'Stored');
  writeParam(d, P('s33_note_voice_2'), 72);
  writeParam(d, P('chord_memory_note_voice_3'), -1);
  for (const m of patchObj.slots.store(0, 0, a.ctx, d)) sim.handle(m);
  const back = await patchObj.slots.fetch(a, 0, 0);
  assert.deepEqual(Array.from(back), Array.from(d), 'all three structs come back');
  const plug = obj('plugoutpatch');
  assert.equal(await plug.slots.fetchName(a, 3, 63), 'PLG3 H-8');
  for (const m of plug.slots.store(2, 5, a.ctx, d)) sim.handle(m);
  assert.equal(M.nameOf(await plug.slots.fetch(a, 2, 5)), 'Stored');
  const perf = obj('performance');
  assert.equal(M.perfNameOf(await perf.slots.fetch(a, 0, 8)), 'Perf B-1');
});

test('live edits go to the temporary struct of the value, in the chosen temporary area', () => {
  const d = patchObj.init();
  writeParam(d, P('filter_cutoff'), 0x9c);
  assert.equal(hex(patchObj.sendParam(P('filter_cutoff'), 0x9c, d, {})), hex(M.dt1(M.A(0x03, 0, 0, 0x3a), [9, 12])));
  // patch2 DELAY FEEDBACK: leaf 10 (01 20 ..) + 1, two nibbles
  assert.equal(hex(patchObj.sendParam(P('delay_feedback'), 120, d, {})), hex(M.dt1(M.A(0x05, 0x01, 0x20, 0x01), [7, 8])));
  M._test.unit.target = 1;
  writeParam(d, P('s2_note_voice_1'), 60);
  assert.equal(hex(patchObj.sendParam(P('s2_note_voice_1'), 60, d, {})), hex(M.dt1(M.A(0x06, 0x20, 0x20, 0x00), [60])));
  M._test.unit.target = 0;
});

test('performance: factory layout (parts, ranges, tempo), INPUT effects reuse the patch2 effect layouts', () => {
  const d = obj('performance').init();
  assert.equal(d.length, 2709);
  for (const p of obj('performance').params) {
    if (p.kind === 'char') continue;
    const v = readParam(d, p);
    assert.ok(v >= p.min && v <= p.max, `${p.key} = ${v}`);
  }
  assert.equal(PP('perf_tempo').format(readParam(d, PP('perf_tempo'))), '120.0');
  const txt = (p, v) => p.options.find(([x]) => x === v)[1];
  assert.equal(txt(PP('up_level'), 107), '0.0dB');
  assert.equal(txt(PP('up_level'), 2), '-50.9dB', 'the OS level table is not linear');
  assert.equal(PP('in_high_cut').offset, MEM.S_PERF.starts[9] + 2);
  assert.equal(readParam(d, PP('in_dlyfeedback')), 120);
  assert.equal(readParam(d, PP('up_octave')), 0);
  assert.equal(d[PP('up_octave').offset], 3, 'part Octave is stored with the bias 3');
  assert.equal(M.perfNameOf(d), 'INIT PERFORM');
  // the factory A-1 "Fat Split" from the unit's backup, when present
  const f = 're/system8/backup/20261126-initial/perf.syx';
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f);
    const msgs = []; let s = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] === 0xf7) { msgs.push(raw.subarray(s, i + 1)); s = i + 1; }
    const items = S8.libraryItems(msgs);
    assert.equal(items.length, 64);
    assert.equal(items[0].name, 'Fat Split');
    const fat = items[0].data;
    assert.equal(readParam(fat, PP('up_range_lower')), 52);
    assert.equal(txt(PP('up_range_lower'), 52), 'E 3');
    assert.equal(txt(PP('up_part_model'), readParam(fat, PP('up_part_model'))), 'SYSTEM-8');
    assert.equal(txt(PP('octave'), readParam(fat, PP('octave'))), '0', 'common Octave 0-6 shown -3..+3 (the OS text offset)');
    assert.equal(readParam(fat, PP('lw_range_upper')), 51);
    assert.equal(PP('perf_tempo').format(readParam(fat, PP('perf_tempo'))), '128.0');
    const c = obj('performance').toCommon(fat);
    assert.equal(c.keyMode, 'split');
    assert.equal(c.tempo, 128);
    assert.deepEqual(Array.from(obj('performance').fromCommon(c, obj('performance').init()).data), Array.from(fat));
    const sem = { ...c, extra: undefined };
    const back = obj('performance').fromCommon(sem, obj('performance').init()).data;
    for (const k of ['up_part_memory', 'lw_part_memory', 'up_range_lower', 'lw_range_upper', 'up_level', 'perf_tempo', 'up_transpose', 'up_octave']) assert.equal(readParam(back, PP(k)), readParam(fat, PP(k)), k);
  }
});

test('Branch Library items from a complete dump of the simulator; recognise', () => {
  const sim = S8.simulate();
  const msgs = [];
  assert.deepEqual(S8.fullDump.map((s) => s.label), ['System', 'Performances (64)', 'SYSTEM-8 patches (64)', 'PLUG-OUT 1 patches (64)', 'PLUG-OUT 2 patches (64)', 'PLUG-OUT 3 patches (64)']);
  const counts = [];
  for (const step of S8.fullDump.filter((s) => /^(System|Performances|SYSTEM-8 patches|PLUG-OUT 2)/.test(s.label))) {
    const out = step.bytes({ deviceId: 0x10 });
    let n = 0;
    for (const r of Array.isArray(out[0]) ? out : [out]) for (const m of sim.handle(r)) if (step.accept(m)) { msgs.push(m); n++; }
    counts.push([step.label, n, step.expect]);
  }
  for (const [label, n, expect] of counts) assert.equal(n, expect, label);
  const items = S8.libraryItems(msgs);
  const pick = (k) => items.find((i) => i.key === k);
  assert.deepEqual(['sys', 'p0', 's0:1', 's2:63'].map((k) => [pick(k).object, pick(k).label, pick(k).name]), [
    ['system', 'System', ''], ['performance', 'Performance A-1', 'Perf A-1'], ['patch', 'SYSTEM-8 A-2', 'SYSTEM-8 A-2'], ['plugoutpatch', 'PLUG-OUT 2 H-8', 'PLG2 H-8'],
  ]);
  assert.equal(items.length, 1 + 64 + 64 + 64);
  assert.equal(pick('s0:1').msgs.length, 13 + 17 + 66);
  assert.ok(msgs.every((m) => S8.recognise(m)));
});

test('connections: what each port carries', () => {
  const L = (output) => S8.link({ input: output, output });
  assert.deepEqual(L('SYSTEM-8 CTRL').can.sort(), ['cc', 'notes', 'pc', 'sysex']);
  assert.ok(!L('SYSTEM-8').can.includes('sysex'));
  assert.equal(L('SYSTEM-8').key, 'usb');
  assert.equal(L('MIDI (OCTA-CAPTURE)').key, 'din');
  assert.ok(!L('MIDI (OCTA-CAPTURE)').can.includes('sysex'));
  for (const o of S8.objects) assert.equal(o.needs, 'sysex', o.key);
});

test('translator: exact within the SYSTEM-8 (all three structs), valid values from another synth', () => {
  const d = patchObj.init();
  writeParam(d, P('osc1_wave'), 1); writeParam(d, P('filter_cutoff'), 100); writeParam(d, P('amp_release'), 77);
  writeParam(d, P('s5_velo_voice_1'), 99);
  M.setName(d, 'Round Trip');
  const c = patchObj.toCommon(d);
  assert.equal(c.osc[0].wave, 'square');
  assert.equal(c.tempo, 120);
  assert.deepEqual(Array.from(patchObj.fromCommon(c, patchObj.init()).data), Array.from(d));
  // a library entry of phase 1 (640-byte patch struct only) still loads
  const old = { ...c, extra: { ...c.extra, data: hex(d.slice(0, 640)).replace(/ /g, '') } };
  assert.equal(M.nameOf(patchObj.fromCommon(old, patchObj.init()).data), 'Round Trip');
  const foreign = { ...c, extra: undefined, osc: [{ wave: 'triangle', coarse: 12, fine: 10, level: 1 }, { wave: 'noise', coarse: -24 }], filter: { type: 'hpf', slope: 12, cutoff: 0.5, resonance: 0.3, env: { attack: 0, decay: 0.5, sustain: 1, release: 0.2 } } };
  const { data, report } = patchObj.fromCommon(foreign, patchObj.init());
  assert.equal(readParam(data, P('osc1_wave')), 2);
  assert.equal(readParam(data, P('filter_type')), 3);
  assert.ok(report.approximated.some((x) => /OSC2 wave noise/.test(x)));
  const plug = obj('plugoutpatch');
  assert.deepEqual(Array.from(plug.fromCommon(plug.toCommon(d), plug.init()).data), Array.from(d));
  assert.ok(plug.fromCommon(c, plug.init()).report.dropped.length);
});

test('OS catalog: the value formatter (FUN_6005032e) and its tag tables', () => {
  assert.equal(OS.osText('-128\x02127 \x06(-128)', 128), '0');
  assert.equal(OS.osText('-128\x02127 \x06(-128)', 255), '+127');
  assert.equal(OS.osText('-40dB\x020dB\x02+40dB \x06(-40) \x05{dB}', 0), '-40dB');
  assert.equal(OS.osText('OFF\x041min\x0210min \x05{min}', 0), 'OFF');
  assert.equal(OS.osText('OFF\x041min\x0210min \x05{min}', 5), '5min');
  assert.equal(OS.osText('40.0\x02300.0 \x07<1>', 1285), '128.5');
  assert.equal(OS.osText('-12\x020\x02+12', 5, -12), '+5');
  assert.equal(OS.TAGS.KEY(60), 'C 4');
  assert.equal(OS.TAGS.KEY(0), 'C -');
  assert.equal(OS.TAGS.DMP(3), '-1.5dB');
  assert.equal(OS.TAGS.PRE_DLY(41), '20.5ms');
  assert.equal(OS.TAGS.TUNE(0), '440.0Hz');
  assert.equal(OS.TAGS.VOC_BAL(255), 'W127');
  assert.deepEqual(OS.osOptions('1\x0210\x01USER', 0, 10).map(([, t]) => t), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'USER']);
  assert.deepEqual(OS.osOptions('NONE\x04C-1\x02G9', -1, 127).slice(0, 2), [[-1, 'NONE'], [0, 'C -']]);
  assert.ok(OS.scaleOnly('x0.0\x02x1.0\x02x2.0', 0, 255));
  assert.ok(!OS.scaleOnly('0%\x02100% \x05{%}', 0, 100));
  assert.equal(OS_CC.length, 85, 'the OS CC map: 85 controllers');
  assert.deepEqual(OS_CC.find(([cc]) => cc === 3).slice(1), ['flt', 1770, 'Cutoff']);
});

test('patch values: OS texts (MONO, envelope variations, chord memory), region-0 lists stay for the engine', () => {
  const d = patchObj.init();
  const t = (k, v) => view(P(k), d).options.find(([x]) => x === v)[1];
  assert.equal(t('mono_sw', 2), 'UNISON');
  assert.equal(t('f_env_variation', 0), 'TYPE1');
  assert.equal(t('chord_memory_form', 10), 'USER');
  assert.equal(t('chord_memory_note_voice_1', readParam(d, P('chord_memory_note_voice_1'))), 'C 4', 'plugin default 61 = C4 (stored note + 1, 0 = NONE)');
  assert.equal(t('chorus_lfo_source', 1), 'EXT');
  assert.equal(t('mfx_assign_1_target', 15), 'PARAMETER 16');
  assert.equal(t('delay_type', 1), 'PAN');
  assert.equal(t('step_seq_smooth', 0), 'AUTO');
  assert.equal(t('osc1_coarse_tune', 11), '0');
  assert.deepEqual(view(P('osc1_wave'), d).options.map(([, x]) => x).slice(0, 3), ['SAW', 'SQR', 'TRI'], 'region 0');
  assert.equal(P('lfo_cv_gain').format(128), '128');
  assert.match(P('lfo_cv_gain').help, /x0\.0 … x1\.0 … x2\.0/);
});

test('system block 01 50 = Setup Common (current state), decoded from the backup', () => {
  const sys = obj('system');
  const d = sys.init();
  assert.equal(d.length, 336);
  const f = 're/system8/backup/20261126-initial/system.syx';
  if (!fs.existsSync(f)) return;
  const raw = fs.readFileSync(f);
  const msgs = []; let s0 = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0xf7) { msgs.push(raw.subarray(s0, i + 1)); s0 = i + 1; }
  const u = sys.fromSyx(msgs);
  const SP = (k) => sys.params.find((p) => p.key === k);
  const t = (k) => SP(k).options.find(([x]) => x === readParam(u, SP(k)))[1];
  assert.equal(t('model_read_only'), 'SYSTEM-8');
  assert.equal(t('cur_patch_num_upper'), 'PLUG-OUT 0 A-3');
  assert.equal(t('cur_patch_num_lower'), 'PLUG-OUT 0 D-7');
  assert.equal(t('current_bank_perform_lower'), 'D');
  assert.ok(SP('model_read_only').readOnly);
});

test('every byte of every struct is a parameter or a slot the OS reserves', () => {
  const A = MEM.A;
  function cover(o, size, structs) {
    const c = new Uint8Array(size);
    for (const p of o.params) for (let i = 0; i < (p.nibbles || p.size || 1); i++) c[p.offset + i] = 1;
    for (const [st, b0] of structs) for (const g of Object.values(OS_GROUPS)) {
      if ((g.addr >>> 21) !== b0 || (b0 === 1 && ((g.addr >>> 14) & 0x7f) !== 0x50)) continue;
      const base = b0 === 1 ? A(1, 0x50) : A(b0);
      const reps = g.addr === A(6, 0, 0x10) ? 64 : 1; // the steps share step 1's layout
      for (let r = 0; r < reps; r++) for (const [o2, n] of g.reserved) for (let i = 0; i < n; i++) { const k = st.compact(g.addr - base + r * 0x800 + o2 + i); if (k >= 0) c[k] = 1; }
    }
    return c.indexOf(0);
  }
  assert.equal(cover(patchObj, MEM.FULL_SIZE, [[MEM.S_PATCH, 3], [MEM.S_PATCH2, 5], [MEM.S_PATCH3, 6]]), -1, 'patch');
  assert.equal(cover(obj('performance'), MEM.S_PERF.size, [[MEM.S_PERF, 4]]), -1, 'performance');
  assert.equal(cover(obj('system'), MEM.S_SYSTEM.size, [[MEM.S_SYSTEM, 1]]), -1, 'system');
});

test('the editor\'s leaves are the OS\'s SysEx leaf map (0x600D2988)', async () => {
  const { OS_LEAVES } = await import('../js/devices/defs/roland-system8-fw.js');
  const sizes = (b0) => OS_LEAVES.filter(([a]) => a >>> 21 === b0).map(([, n]) => n);
  assert.deepEqual(MEM.PERF_LEAVES.map(([, n]) => n), sizes(4));
  assert.deepEqual(MEM.PATCH2_LEAVES.map(([, n]) => n), sizes(5));
  assert.deepEqual(MEM.PATCH3_LEAVES.map(([, n]) => n), sizes(6));
  assert.deepEqual(OS_LEAVES.filter(([a]) => a >>> 21 === 4).map(([a]) => a - MEM.A(4)), MEM.PERF_LEAVES.map(([p]) => p));
  assert.equal(sizes(3).reduce((a, b) => a + b), MEM.S_PATCH.size, 'patch struct: the panel blocks + 512 bytes from 03 00 01 00');
  assert.deepEqual(sizes(1), [MEM.S_SYSTEM.size]);
});

test('performance: the parts page (upper / lower) finds every column, the part channels are documented as unit-only', () => {
  const o = obj('performance');
  assert.equal(o.multi.count, 2);
  for (const i of [0, 1]) for (const c of o.multi.columns) for (const l of c.params) assert.ok(o.params.find((p) => p.section === o.multi.section(i) && p.label === l), `${i} ${l}`);
  const d = o.init();
  writeParam(d, PP('lw_part_sw'), 1);
  assert.equal(o.multi.on(1, d), true);
  assert.match(o.multi.note, /no editor can read or set them/);
  assert.ok(o.sections.some((s) => s.key === 'upper') && o.sections.some((s) => s.key === 'lower'));
});

test('Store notes say what the unit keeps: DT1 into user memory is lost at power-off (checked with two power cycles)', () => {
  for (const k of ['patch', 'plugoutpatch', 'performance']) assert.match(obj(k).slots.note(), /until it is switched off/, k);
});
