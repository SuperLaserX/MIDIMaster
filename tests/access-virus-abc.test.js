// Access Virus A / B / C family (access-virus-abc.js): the B OS 4.9 and Classic OS tables read from the host OS in
// the emulator (tools/virus/abc_tables.py), the dump formats (checked against the dumps Access shipped when present
// in re/virus/dumps), the models built on them. No unit was connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as ABC from '../js/devices/defs/access-virus-abc.js';
import * as TR from '../js/devices/defs/access-virus-abc-translate.js';
import vb from '../js/devices/defs/access-virus-b.js';
import kb from '../js/devices/defs/access-virus-kb.js';
import indigo from '../js/devices/defs/access-virus-indigo.js';
import rack from '../js/devices/defs/access-virus-rack.js';
import classic from '../js/devices/defs/access-virus-classic.js';
import * as BOS from '../js/devices/defs/access-virus-b-os.js';
import * as COS from '../js/devices/defs/access-virus-classic-os.js';
import vc from '../js/devices/defs/access-virus-c.js';
import kc from '../js/devices/defs/access-virus-kc.js';
import indigo2 from '../js/devices/defs/access-virus-indigo2.js';
import * as C66 from '../js/devices/defs/access-virus-c-os.js';
import rxl from '../js/devices/defs/access-virus-rack-xl.js';
import va from '../js/devices/defs/access-virus-a.js';
import * as A28 from '../js/devices/defs/access-virus-a-os.js';
import * as RXL from '../js/devices/defs/access-virus-rack-xl-os.js';
import * as TI from '../js/devices/defs/access-virus-ti2.js';
import { importSysex } from '../js/core/mainlib/importers.js';
import { fullDumpSteps, optionalGroups } from '../js/devices/generic/fulldump.js';

const ctx = { deviceId: 0x10 };
const apiFor = (sim) => ({
  ctx,
  g: { client: { s: { timeout: 100 }, request: async (bytes, o) => {
    const replies = sim.handle(bytes) || [];
    return { messages: replies.filter((m) => o.collect(null, Uint8Array.from(m))).map((m) => ({ raw: m })) };
  } } },
});
const [single, multi, global] = vb.objects;
const param = (obj, key) => obj.params.find((p) => p.key === key);
const textOf = (p, v) => (p.options ? p.options.find(([x]) => x === v)?.[1] : p.format(v));
const listOf = (T, page, i) => { const r = T[`PAGE_${page}`].find(([x]) => x === i); return r && T.LISTS[r[5]]; };

test('Virus B OS 4.9 tables: the screen\'s labels, ranges and value texts', () => {
  assert.match(BOS.OS, /OS 4\.9/);
  assert.deepEqual(BOS.MODES, ['Single mode', 'Multi Single mode', 'Multi mode']);
  // menus: LFO 1 shape, oscillator semitone (-48..+48 over 16-112), filter routing, categories, global device ID
  assert.deepEqual(listOf(BOS, 'A', 68).slice(0, 6), ['Sine', 'Triangle', 'Sawtooth', 'Square', 'S&H', 'S&G']);
  const semi = BOS.PAGE_A.find(([i]) => i === 20);
  assert.deepEqual([semi[1], semi[2], semi[3], semi[4]], ['Semitone', 'OSCILLATOR 1', 16, 112]);
  assert.deepEqual([listOf(BOS, 'A', 20)[0], listOf(BOS, 'A', 20)[48], listOf(BOS, 'A', 20)[96]], ['-48', '+0', '+48']);
  assert.equal(listOf(BOS, 'B', 123)[1], 'Lead');
  assert.equal(listOf(BOS, 'C', 93).at(-1), 'Omni');
  // the assign destinations are shown through the OS's alphabetical remapping: stored 1 is PatchVol
  assert.equal(listOf(BOS, 'B', 65)[1], 'PatchVol');
  // panel knobs: the cutoff knob edits page A 40 (Filter 1, 2 or both: names from the knob display)
  const cutoff = BOS.KNOBS.find(([k]) => k === 4);
  assert.equal(cutoff[1], 'Cutoff');
  assert.ok(cutoff[2].some(([n, o]) => n === 'Cutoff1' && o === 40));
  assert.equal(BOS.CC_NAMES[40], 'Cutoff');
  assert.equal(BOS.CLASS.A1, 'controller');
  assert.equal(BOS.CLASS.C93, 'global');
  assert.equal(BOS.CLASS.C15, 'multi');
});

test('Virus B: every single byte is a parameter (the name aside); knob-only parameters with the knob display', () => {
  const covered = new Set(single.params.map((p) => p.offset));
  for (let o = 0; o < 256; o++) if (o < 240 || o >= 250) assert.ok(covered.has(o), `single byte ${o}`);
  const cut = param(single, 's40');
  assert.equal(cut.label, 'Cutoff');
  assert.equal(cut.section, 'filter');
  assert.equal(textOf(cut, 127), '127');
  const shape = param(single, 's68');
  assert.equal(textOf(shape, 0), 'Sine');
  assert.equal(param(single, 's1').readOnly, true);
  assert.match(param(single, 's1').help, /performance controller/);
  assert.match(textOf(param(single, 's4'), 0x22), /Filter 2; Osc 1 knob Pulse Width; Osc 2 knob Wave/);
  // set with panel buttons, shown by LEDs only: the controller list's names, Access's value names
  assert.deepEqual([param(single, 's53').label, param(single, 's53').options.map(([, t]) => t)], ['FiltRouting', ['Ser4', 'Ser6', 'Par4', 'Split']]);
  assert.equal(param(single, 's28').label, 'Osc2Sync');
  // every value list covers its whole range
  for (const p of single.params) if (p.options && !p.readOnly) assert.equal(p.options.length, p.max - p.min + 1, p.key);
});

test('Virus B: single dumps of 267 bytes with one checksum; the TI reads the same pages A / B', () => {
  const d = single.init();
  assert.equal(d.length, 256);
  d.set([...'Test Sound'].map((c) => c.charCodeAt(0)), 240);
  const m = ABC.abcMsg.single(ctx, 1, 5, d);
  assert.equal(m.length, 267);
  assert.deepEqual(m.slice(0, 9), [0xf0, 0x00, 0x20, 0x33, 0x01, 0x10, 0x10, 1, 5]);
  let s = 0; for (let i = 5; i < 265; i++) s += m[i];
  assert.equal(m[265], s & 0x7f);
  assert.deepEqual(ABC.singleFrom(Uint8Array.from(m)), d);
  assert.equal(ABC.nameOf(d), 'Test Sound');
  assert.deepEqual(single.sendParam(param(single, 's40'), 0, d, ctx), [0xf0, 0x00, 0x20, 0x33, 0x01, 0x10, 0x70, 0x40, 40, d[40], 0xf7]);
  assert.deepEqual(single.sendParam(param(single, 's135'), 0, d, ctx).slice(6, 9), [0x71, 0x40, 7]);
});

test('Virus B: the dumps Access shipped with OS 4.9 (ABM.mid) read back as they are, when present', { skip: !fs.existsSync('re/virus/dumps/b_abm.syx') }, () => {
  const raw = fs.readFileSync('re/virus/dumps/b_abm.syx');
  const msgs = [];
  let at = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0xf7) { if (raw[at] === 0xf0) msgs.push(Uint8Array.from(raw.subarray(at, i + 1))); at = i + 1; }
  const items = vb.libraryItems(msgs);
  assert.ok(items.filter((x) => x.object === 'single').length > 250);
  assert.equal(items.filter((x) => x.object === 'multi').length, 129);
  assert.equal(items.find((x) => x.label === 'RAM A 001').name, 'OvertureCK');
  const m = msgs.find((x) => x[6] === 0x10 && x[7] === 1 && x[8] === 0);
  assert.deepEqual(ABC.abcMsg.single({ deviceId: m[5] }, 1, 0, ABC.singleFrom(m)), Array.from(m));
  const g = msgs.find((x) => x[6] === 0x12);
  assert.equal(ABC.globalFrom(g)[93], 16); // Device ID: Omni
  assert.equal(textOf(param(global, 'g93'), 16), 'Omni');
  const mm = msgs.find((x) => x[6] === 0x11 && x[7] === 1 && x[8] === 1);
  assert.equal(ABC.multiNameOf(ABC.dataFrom(mm, 0x11)), 'Virus OS4');
  assert.deepEqual(ABC.abcMsg.multi({ deviceId: mm[5] }, 1, 1, ABC.dataFrom(mm, 0x11)), Array.from(mm));
});

test('Virus B: multi with 16 parts (TI layout), MIDI channels page, global page from page C', async () => {
  assert.equal(multi.multi.count, 16);
  const ch = multi.params.find((p) => p.key === 'p3_34');
  assert.equal(ch.offset, 32 + 16 * 2 + 3);
  assert.equal(ch.label, 'MIDI channel');
  const en = multi.params.find((p) => p.key === 'p3_72');
  assert.deepEqual([en.offset, en.shift, en.bits], [243, 0, 1]);
  for (const col of multi.multi.columns) for (const name of col.params) assert.ok(multi.params.some((p) => p.part === 0 && p.label === name), `${col.label}: ${name}`);
  assert.ok(param(global, 'g118'));
  assert.ok(!global.params.some((p) => p.offset === 122)); // the play mode is the unit's state
  const sim = vb.simulate();
  const api = apiFor(sim);
  sim.state.parts[2].set([...'Part Three'].map((c) => c.charCodeAt(0)), 240);
  const d = await multi.fetch(api);
  assert.equal(d.length, 256);
  assert.equal(multi.params.find((p) => p.key === 'p2_sound').dynamic(d).options[0][1], 'Part Three');
  sim.state.global[93] = 5;
  assert.equal((await global.fetch(api))[93], 5);
});

test('Virus B: banks RAM A-B stored, ROM C-H read; store and edit buffer through the simulator', async () => {
  assert.deepEqual(single.slots.banks.map(([, n]) => n), ['RAM A', 'RAM B', 'ROM C', 'ROM D', 'ROM E', 'ROM F', 'ROM G', 'ROM H']);
  assert.ok(single.slots.writable(2) && !single.slots.writable(3));
  const sim = vb.simulate();
  const api = apiFor(sim);
  const d = single.init();
  d[40] = 77;
  sim.handle(single.slots.store(1, 9, ctx, d));
  assert.equal((await single.slots.fetch(api, 1, 9))[40], 77);
  sim.handle(single.sendAll.build(d, ctx));
  assert.equal((await single.fetch(api))[40], 77);
});

test('Virus kb, Indigo, Rack and Classic: the same editor over their OS tables', () => {
  for (const def of [kb, indigo, rack]) assert.equal(def.objects[0].params.length, single.params.length);
  assert.match(rack.coverage, /assumed/);
  assert.match(COS.OS, /Classic/);
  assert.deepEqual(listOf(COS, 'A', 68).slice(0, 2), ['Sine', 'Triangle']);
  assert.equal(classic.objects[0].params.filter((p) => !p.readOnly).length, classic.objects[0].params.filter((p) => !p.readOnly).length);
});

test('Virus A / B / C translator: round trip in the family, a TI single gives its pages A / B', () => {
  const d = single.init();
  d[40] = 90; d[38] = 50;
  const c = single.toCommon(d);
  assert.equal(c.extra.family, 'access-virus-abc');
  assert.deepEqual(single.fromCommon(c, single.init()).data, d);
  const ti = new Uint8Array(512);
  ti[40] = 33; ti[50] = 61; ti[504] = 3;
  const r = TR.singleFromCommon({ extra: { family: 'access-virus-ti', single: Buffer.from(ti).toString('base64') } }, d);
  assert.deepEqual([r.data[40], r.data[38], r.data[97], r.data[0]], [33, 61, 3, d[0]]);
  const sem = single.fromCommon({ filter: { cutoff: 1 } }, single.init()).data;
  assert.equal(sem[40], 127);
  const m = multi.init();
  assert.deepEqual(multi.fromCommon(multi.toCommon(m), multi.init()).data, m);
});

// ------------------------------------------------------------------ Virus C / KC / Indigo 2 (C OS 6.6)
const readSyx = (file) => {
  const raw = fs.readFileSync(file);
  const msgs = [];
  let at = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0xf7) { if (raw[at] === 0xf0) msgs.push(Uint8Array.from(raw.subarray(at, i + 1))); at = i + 1; }
  return msgs;
};

test('Virus C OS 6.6 tables: 18 edit modes read in the emulator, with the labels, ranges and value texts of the screen', () => {
  assert.match(C66.OS, /Virus C OS 6\.6/);
  assert.ok(C66.MODES.includes('Mod matrix') && C66.MODES.includes('Multi / global (multi mode)'));
  assert.deepEqual(listOf(C66, 'A', 51), ['LowPass', 'HighPass', 'BandPass', 'BandStop', 'Analog 1P', 'Analog 2P', 'Analog 3P', 'Analog 4P']);
  assert.equal(listOf(C66, 'B', 123).at(-1), 'Digital'); // the C's five new categories
  assert.equal(listOf(C66, 'C', 93).at(-1), 'Omni');
  assert.equal(listOf(C66, 'B', 65)[1], 'PatchVol');
  // LFO 3: its destination is the record edit mode 2 shows (B 11), its amount B 12
  const dest = C66.PAGE_B.find(([i]) => i === 11);
  assert.deepEqual([dest[1], dest[2], listOf(C66, 'B', 11)], ['Dest', 'LFO 3', ['Osc 1', 'Osc 1+2', 'Osc 2', 'Pw 1', 'Pw 1+2', 'Pw 2', 'SyncPhase']]);
  assert.equal(C66.PAGE_B.find(([i]) => i === 12)[1], 'Amount');
  // assign 4-6 (new in the C), the knob-only distortion
  assert.deepEqual(C66.PAGE_B.find(([i]) => i === 103).slice(1, 3), ['Source', 'ASSIGN 4']);
  assert.equal(listOf(C66, 'B', 100)[0], 'Off');
  // knobs: the cutoff knob, the oscillator knob (Wave / PW of Osc 1 and 2, Osc 3's mode)
  assert.deepEqual(C66.KNOBS.find(([k]) => k === 21)[2], [['Cutoff', 40], ['Center', 40]]);
  assert.ok(C66.KNOBS.find(([k]) => k === 3)[2].some(([n, o]) => n === 'Mode' && o === 169));
  assert.equal(C66.CC_NAMES[40], 'Cutoff');
  assert.deepEqual([C66.CLASS.C40, C66.CLASS.C72, C66.CLASS.C15, C66.CLASS.C93, C66.CLASS.A1, C66.CLASS.A0], ['part', 'part', 'multi', 'global', 'controller', 'none']);
});

test('Virus C: every single byte is a parameter; the panel selections B 125-127; format 7', () => {
  const [s] = vc.objects;
  const covered = new Set(s.params.map((p) => p.offset));
  for (let o = 0; o < 256; o++) if (o < 240 || o >= 250) assert.ok(covered.has(o), `single byte ${o}`);
  for (const p of s.params) if (p.options && !p.readOnly) assert.equal(p.options.length, p.max - p.min + 1, p.key);
  assert.equal(s.init()[0], 7);
  const p = (k) => s.params.find((x) => x.key === k);
  assert.deepEqual(p('s255').options.map(([, t]) => t), ['Osc 1', 'Osc 2', 'Osc 3']);
  assert.deepEqual(p('s253').options.map(([, t]) => t), ['Distortion', 'Phaser', 'Chorus']);
  assert.match(p('s4').format(2), /^Filter 2/);
  assert.equal(p('s40').group, 'Filters');
  assert.equal(p('s228').group, 'Distortion');
  assert.equal(p('s169').group, 'Oscillator 3');
  // categories: the C's Organ (17) is offered to the C, not to the B (its list ends at 16)
  const d = s.init();
  s.setCategory(d, 'organ');
  assert.equal(d[251], 17);
  const b = single.init();
  single.setCategory(b, 'organ');
  assert.equal(b[251], 0);
  assert.equal(s.category(d), 'organ');
});

test('Virus C: the dumps Access shipped with OS 6.5 (ABM.mid, Analog Filter Sounds.syx) read back as they are, when present', { skip: !fs.existsSync('re/virus/dumps/c_abm.syx') }, () => {
  const msgs = readSyx('re/virus/dumps/c_abm.syx');
  const items = vc.libraryItems(msgs);
  assert.equal(items.filter((x) => x.object === 'single').length, 256);
  assert.equal(items.filter((x) => x.object === 'multi').length, 128);
  assert.equal(items.find((x) => x.label === 'RAM A 001').name, 'OvertureCK');
  for (const m of msgs.filter((x) => x[6] === 0x10)) {
    const d = ABC.singleFrom(m);
    assert.equal(d[0], 7);
    assert.deepEqual(ABC.abcMsg.single({ deviceId: m[5] }, m[7], m[8], d), Array.from(m));
  }
  const an = readSyx('re/virus/dumps/c_analog.syx');
  assert.equal(an.length, 60);
  assert.equal(ABC.nameOf(ABC.singleFrom(an[0])), '60sSciFiHS');
  // a C single through the translator and back
  const [s] = vc.objects;
  const d = ABC.singleFrom(msgs[0]);
  assert.deepEqual(s.fromCommon(s.toCommon(d), s.init()).data, d);
});

test('Virus C: multi with 16 parts, MIDI channels page, global page; KC and Indigo 2 share the editor', async () => {
  const [, m, g] = vc.objects;
  assert.equal(m.multi.count, 16);
  for (const col of m.multi.columns) for (const name of col.params) assert.ok(m.params.some((p) => p.part === 0 && p.label === name), `${col.label}: ${name}`);
  assert.ok(g.params.some((p) => p.offset === 118 && p.label === 'MemProtect'));
  assert.ok(!g.params.some((p) => p.offset === 122));
  const sim = vc.simulate();
  const api = apiFor(sim);
  sim.state.parts[4].set([...'Part Five'].map((c) => c.charCodeAt(0)), 240);
  const d = await m.fetch(api);
  assert.equal(m.params.find((p) => p.key === 'p4_sound').dynamic(d).options[0][1], 'Part Five');
  for (const def of [kc, indigo2]) {
    assert.equal(def.objects[0].params.length, vc.objects[0].params.length);
    assert.equal(def.objects[0].init()[0], 7);
  }
  assert.match(kc.coverage, /KC/);
  assert.match(indigo2.coverage, /Indigo 2/);
});

test('Virus families: a file read without a device hint goes to the family its messages fit (A / B / C, TI, Snow)', async () => {
  const ctx0 = { deviceId: 0 };
  const read = async (msgs) => (await importSysex(msgs.map((m) => Uint8Array.from(m)))).patches.map((p) => p.device.id);
  assert.deepEqual(await read([ABC.abcMsg.single(ctx0, 1, 0, single.init())]), ['access-virus-b']); // 267 bytes, format 6
  assert.deepEqual(await read([ABC.abcMsg.single(ctx0, 1, 0, vc.objects[0].init())]), ['access-virus-c']); // format 7
  assert.deepEqual(await read([TI.msg.single(ctx0, 1, 0, TI.initSingle())]), ['access-virus-ti2']); // 524 bytes
  assert.deepEqual(await read([TI.msg.single(ctx0, 0x31, 0, TI.initSingle())]), ['access-virus-snow']); // part single of multi 17
  assert.deepEqual(await read([ABC.abcMsg.single(ctx0, 1, 0, single.init()), ABC.abcMsg.global(ctx0, new Uint8Array(256))]), ['access-virus-b', 'access-virus-b']);
  assert.ok(vb.isRequest(ABC.abcMsg.singleBankRequest(ctx0, 1)) && !vb.recognise(ABC.abcMsg.singleBankRequest(ctx0, 1)));
});

test('Virus A / B / C complete dump: each step expects its dumps; the ROM banks are an optional group', () => {
  const steps = fullDumpSteps(vb);
  assert.ok(steps.every((s) => s.expect && s.seconds));
  assert.equal(steps.find((s) => s.label === 'RAM A singles').expect, 128);
  const groups = optionalGroups(steps);
  assert.equal(groups.length, 1);
  assert.match(groups[0].group, /ROM banks C-H/);
  assert.equal(groups[0].steps.length, 6);
});

test('Virus Rack XL OS 6.5 x079: its 11 edit modes and four parameter knobs read in the emulator', () => {
  assert.match(RXL.OS, /Rack XL/);
  assert.ok(RXL.MODES.includes('Oscillators') && RXL.MODES.includes('Multi parts (multi mode)'));
  assert.deepEqual(listOf(RXL, 'A', 51).slice(-1), ['Analog 4P']);
  assert.equal(listOf(RXL, 'C', 32).at(-1), 'H');
  // the oscillator page shows the shapes and pulse widths (knob-only on the B / C)
  assert.deepEqual(RXL.PAGE_A.find(([i]) => i === 17).slice(1, 3), ['Shape', 'OSCILLATOR 1']);
  // the vocoder page reinterprets filter parameters: they keep the name of the knob that edits them
  assert.deepEqual(RXL.PAGE_A.find(([i]) => i === 55).slice(1, 3), ['Decay', 'FILTERENVELOPE']);
  // parameter knobs 1-4 follow the menu page: knob 1 edits the cutoff on the filter page
  const k1 = RXL.KNOBS.find(([k]) => k === 1);
  assert.equal(k1[1], 'Parameter knob 1');
  assert.ok(k1[2].some(([n, o]) => n === 'Cutoff1' && o === 40));
  // C 43: the part's pan (the RANDOM menu shows the same index as ParaDepth)
  assert.equal(RXL.PAGE_C.find(([i]) => i === 43)[1], 'PartPan');
  assert.deepEqual([RXL.CLASS.B126, RXL.CLASS.C43, RXL.CLASS.C44], ['alias', 'part', 'global']);
});

test('Virus Rack XL: every single byte is a parameter; format 7; multi, global, banks', () => {
  const [s, m, g] = rxl.objects;
  const covered = new Set(s.params.map((p) => p.offset));
  for (let o = 0; o < 256; o++) if (o < 240 || o >= 250) assert.ok(covered.has(o), `single byte ${o}`);
  for (const p of s.params) if (p.options && !p.readOnly) assert.equal(p.options.length, p.max - p.min + 1, p.key);
  assert.equal(s.init()[0], 7);
  assert.match(s.params.find((p) => p.offset === 254).help, /resonance/);
  for (const col of m.multi.columns) for (const name of col.params) assert.ok(m.params.some((p) => p.part === 0 && p.label === name), `${col.label}: ${name}`);
  assert.ok(g.params.some((p) => p.offset === 93));
  assert.deepEqual(s.slots.banks.map(([, n]) => n).slice(0, 2), ['RAM A', 'RAM B']);
  assert.deepEqual(s.fromCommon(s.toCommon(s.init()), s.init()).data, s.init());
});

test('Virus A OS 2.8: three play-mode tables and the 32 panel knobs read in the emulator', () => {
  assert.match(A28.OS, /Virus A OS 2\.8/);
  assert.deepEqual(A28.MODES, ['Single mode', 'Multi Single mode', 'Multi mode']);
  assert.deepEqual(listOf(A28, 'A', 68).slice(0, 2), ['Sinus', 'Triangle']);
  assert.deepEqual(listOf(A28, 'C', 32), ['A', 'B', 'C', 'D']);
  assert.deepEqual(listOf(A28, 'C', 116), ['Easy', 'Expert']);
  assert.deepEqual(A28.KNOBS.find(([k]) => k === 4)[2], [['Cutoff1', 40], ['Cutoff', 40], ['Center', 40]]);
  assert.deepEqual([A28.CLASS.B122, A28.CLASS.C33, A28.CLASS.C43], ['panel', 'part', 'global']);
});

test('Virus A: every single byte is a parameter; banks A-D; panel buttons and shared knobs named', () => {
  const [s, m] = va.objects;
  const covered = new Set(s.params.map((p) => p.offset));
  for (let o = 0; o < 256; o++) if (o < 240 || o >= 250) assert.ok(covered.has(o), `single byte ${o}`);
  for (const p of s.params) { assert.ok(p.label, p.key); if (p.options && !p.readOnly) assert.equal(p.options.length, p.max - p.min + 1, p.key); }
  assert.deepEqual([s.params.find((p) => p.offset === 42).label, s.params.find((p) => p.offset === 43).label], ['Reso1', 'Reso2']);
  assert.equal(s.params.find((p) => p.offset === 28).label, 'Osc2Sync');
  assert.deepEqual(s.slots.banks.map(([, n]) => n), ['RAM A', 'RAM B', 'ROM C', 'ROM D']);
  for (const col of m.multi.columns) for (const name of col.params) assert.ok(m.params.some((p) => p.part === 0 && p.label === name), `${col.label}: ${name}`);
  assert.deepEqual(s.fromCommon(s.toCommon(s.init()), s.init()).data, s.init());
});
