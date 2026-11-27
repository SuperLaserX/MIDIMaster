// Access Virus TI2: the tables from Virus Control's description, dumps, parameter messages, the
// multi, the simulator and the translator. Dumps read from the unit (re/virusti/live) are used
// when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as FW from '../js/devices/defs/access-virus-ti2-fw.js';
import def, * as V from '../js/devices/defs/access-virus-ti2.js';
import * as SN2 from '../js/devices/defs/novation-supernova2.js';
import SN2DEF from '../js/devices/defs/novation-supernova2.js';

const single = def.objects.find((o) => o.key === 'single');
const multi = def.objects.find((o) => o.key === 'multi');
const global = def.objects.find((o) => o.key === 'global');
const LIVE = 'z:/MIDIMaster/re/virusti/live/before';
const ctx = { deviceId: 0x10 };

test('Virus TI2: tables from Virus Control cover the 512-byte single', () => {
  const described = FW.SINGLE.map(([o]) => o);
  assert.equal(described.length + FW.SINGLE_UNMAPPED.length, 512);
  assert.equal(new Set([...described, ...FW.SINGLE_UNMAPPED]).size, 512);
  for (const [, ...vs] of FW.SINGLE) {
    for (const [key, label, group, min, max, , list, cond] of vs) {
      assert.ok(label && group && key.startsWith(`${group}/`), key);
      assert.ok(min <= max, key);
      assert.ok(!list || FW.LISTS[list] || FW.BIAS[list], `${key}: list ${list}`);
      assert.ok(!cond || FW.CONDS[cond], `${key}: condition ${cond}`);
    }
  }
  // every byte of the single has exactly one parameter on the page (several meanings share one)
  const offs = single.params.map((p) => p.offset);
  assert.equal(new Set(offs).size, offs.length);
  assert.equal(offs.length + 10, 512); // the 10 name bytes are the name, not parameters
  // the multi: every byte is a parameter, a name byte or a part switch
  const mo = new Set(multi.params.filter((p) => !p.bits).map((p) => p.offset));
  for (let o = 0; o < 240; o++) assert.ok(mo.has(o) || (o >= 4 && o <= 13), `multi byte ${o}`);
  assert.equal(global.params.length, new Set(FW.GLOBAL.map((r) => r[0])).size);
});

test('Virus TI2: single and multi dumps decode and rebuild exactly, with both checksums', () => {
  const d = V.initSingle();
  assert.equal(V.nameOf(d), 'Init');
  const m = Uint8Array.from(V.msg.single(ctx, 0, V.SINGLE_PART, d));
  assert.equal(m.length, 524);
  assert.ok(V.checksumOk(m));
  assert.deepEqual(V.singleFrom(m), d);
  const mm = Uint8Array.from(V.msg.multi(ctx, 0, 0x7f, V.initMulti()));
  assert.equal(mm.length, 267);
  assert.ok(V.checksumOk(mm));
  assert.deepEqual(V.multiFrom(mm), V.initMulti());
  assert.equal(V.multiNameOf(V.initMulti()), 'Init Multi');
  // a Virus A/B/C single (pages A and B) loads into pages A and B
  const c = [...V.msg.single(ctx, 0, 0x40, d).slice(0, 266), 0xf7];
  assert.deepEqual(V.singleFrom(Uint8Array.from(c)).subarray(0, 256), d.subarray(0, 256));
  for (const f of ['single_eb.syx', 'part_00.syx', 'multi_eb.syx']) {
    if (!fs.existsSync(`${LIVE}/${f}`)) continue;
    const raw = Uint8Array.from(fs.readFileSync(`${LIVE}/${f}`));
    assert.ok(V.checksumOk(raw), f);
    const back = raw[6] === 0x10 ? V.msg.single({ deviceId: raw[5] }, raw[7], raw[8], V.singleFrom(raw)) : V.msg.multi({ deviceId: raw[5] }, raw[7], raw[8], V.multiFrom(raw));
    assert.deepEqual(Uint8Array.from(back), raw, f);
  }
});

test('Virus TI2: a single parameter goes to its page (70 71 6E 6F) and the chosen edit buffer', () => {
  const d = V.initSingle();
  const send = (o, v) => { d[o] = v; return single.sendParam(single.params.find((p) => p.offset === o), v, d, ctx); };
  assert.deepEqual(send(40, 20), [0xf0, 0, 0x20, 0x33, 0x01, 0x10, 0x70, 0x40, 40, 20, 0xf7]); // Filter 1 Cutoff (checked on a TI2)
  assert.deepEqual(send(130, 5).slice(6), [0x71, 0x40, 2, 5, 0xf7]); // Arpeggiator Pattern
  assert.deepEqual(send(260, 33).slice(6), [0x6e, 0x40, 4, 33, 0xf7]); // Reverb Time
  assert.deepEqual(send(505, 77).slice(6), [0x6f, 0x40, 121, 77, 0xf7]); // Unison Detune
  V._test.unit.part = 15;
  assert.deepEqual(send(40, 21).slice(6), [0x70, 15, 40, 21, 0xf7]);
  V._test.unit.part = V.SINGLE_PART;
  // a parameter message from the Virus lands in the data
  const r = single.receive(Uint8Array.from([0xf0, 0, 0x20, 0x33, 0x01, 0x00, 0x6e, 0x40, 4, 99, 0xf7]), d, ctx);
  assert.equal(r[260], 99);
});

test('Virus TI2: shared bytes follow the oscillator model and the vocoder, as in Virus Control', () => {
  const d = V.initSingle();
  const p17 = single.params.find((p) => p.offset === 17);
  const model = V.singleOffset('Oscillator 1/Mode');
  d[model] = 0;
  assert.match(p17.dynamic(d).label, /Shape/);
  d[model] = 1;
  assert.match(p17.dynamic(d).label, /Density/);
  d[model] = 2;
  assert.match(p17.dynamic(d).label, /Wavetable Index/);
  const p40 = single.params.find((p) => p.offset === 40);
  assert.match(p40.dynamic(d).label, /Cutoff/);
  d[V.singleOffset('Vocoder/Mode')] = 1;
  assert.match(p40.dynamic(d).label, /Vocoder/);
  // value texts are the TI2 screen's (the same as Virus Control's for these)
  const shape = single.params.find((p) => p.offset === V.singleOffset('LFO 1/Shape'));
  assert.deepEqual(shape.options.slice(0, 4).map((x) => x[1]), ['Sine', 'Triangle', 'Sawtooth', 'Square']);
  const clock = single.params.find((p) => p.offset === V.singleOffset('LFO 1/Clock'));
  assert.equal(clock.options.find(([v]) => v === 3)[1], '1/16');
});

test('Virus TI2: value lists are the OS screen\'s, in its order and range (display lists, reordering tables, range routines)', async () => {
  const OS = await import('../js/devices/defs/access-virus-ti2-os.js');
  // every parameter Virus Control describes on pages A-D, 72 and 73 has its OS display list
  for (const [, ...vs] of FW.SINGLE) for (const v of vs) assert.ok(OS.PARAM[v[0]], v[0]);
  for (const r of FW.GLOBAL) assert.ok(OS.PARAM[r[1]], r[1]);
  // modulation destinations: the screen's alphabetical order (reordering table 3), positions 0-121: the six
  // reserved values are not offered, 122-127 are (Virus Control's range 0-121 is in stored values)
  const dest = single.params.find((p) => p.offset === V.singleOffset('Assign Slot 1/Destination 1'));
  assert.equal(dest.options.length, 122);
  assert.deepEqual(dest.options.slice(0, 3), [[0, 'Off'], [38, 'Amp Env Attack'], [39, 'Amp Env Decay']]);
  const text = (p, v) => p.options.find(([x]) => x === v)?.[1];
  assert.equal(text(dest, 122), 'Slot 6 Amount 1');
  assert.equal(text(dest, 127), 'Distortion Mix');
  assert.equal(text(dest, 96), 'FreqShifter Freq'); // Virus Control: "Filterbank Freq"
  assert.equal(text(dest, 73), undefined); // "-reserved (73)-"
  for (const p of single.params.filter((x) => /Destination|Dest Assign/.test(x.help) && x.options?.length === 122)) assert.deepEqual(p.options, dest.options);
  // soft knob destinations: reordering table 9, all 128 values
  const knob = single.params.find((p) => p.offset === V.singleOffset('Soft Knobs/Destination 1'));
  assert.equal(knob.options.length, 128);
  assert.deepEqual(knob.options.slice(0, 2), [[0, 'Off'], [64, 'Aftertouch']]);
  assert.equal(text(knob, 88), 'FreqShifter Frequency');
  assert.equal(text(knob, 127), 'Freq Shifter Mix');
  assert.deepEqual(global.params.find((p) => p.help.startsWith('Global Soft Knob Configuration/Destination 1')).options, knob.options);
  // Reverb Predelay: the screen's last value follows Reverb Type (range routine C493)
  const d = V.initSingle();
  const pre = single.params.find((p) => p.offset === V.singleOffset('Reverb/Predelay'));
  const type = V.singleOffset('Reverb/Type');
  for (const [t, last] of [[0, 92], [1, 74], [2, 55], [3, 28]]) { d[type] = t; assert.equal(pre.dynamic(d).max, last); assert.equal(pre.dynamic(d).options.at(-1)[0], last); }
  // amounts show the screen's text; the degree sign is the font's "^"
  const angle = single.params.find((p) => p.offset === 278);
  assert.equal((angle.dynamic ? { ...angle, ...angle.dynamic(V.initSingle()) } : angle).format?.(0) ?? text(angle, 0), '-180°');
  // multi: banks RAM-A ... ROM-Z (0-29), outputs with USB3 greyed (Virus Control's "Output Select Control2")
  const bank = multi.params.find((p) => p.key === 'p0_32');
  assert.deepEqual([bank.options.length, bank.options[0][1], bank.options[29][1]], [30, 'RAM-A', 'ROM-Z']);
  const out = multi.params.find((p) => p.key === 'p0_41');
  assert.equal(text(out, 15), 'USB3 L (greyed)');
});

test('Virus TI2: multi parts, switches and their messages (72 pp ii vv, checked on a TI2)', () => {
  const d = V.initMulti();
  const vol = multi.params.find((p) => p.part === 15 && p.page === 39);
  assert.equal(vol.offset, 159);
  V._test.writeParam(d, vol, 80);
  assert.deepEqual(multi.sendParam(vol, 80, d, ctx).slice(6), [0x72, 15, 39, 80, 0xf7]);
  const on = multi.params.find((p) => p.part === 15 && p.page === 72);
  assert.equal(on.offset, 255);
  V._test.writeParam(d, on, 0);
  assert.equal(d[255] & 1, 0);
  assert.deepEqual(multi.sendParam(on, 0, d, ctx).slice(6), [0x72, 15, 72, 0, 0xf7]);
  assert.equal(multi.multi.on(15, d), false);
  assert.equal(multi.multi.on(0, d), true);
  // the MIDI channels page finds its columns in every part
  for (let i = 0; i < 16; i++) {
    for (const col of multi.multi.columns) for (const label of col.params) assert.ok(multi.params.some((p) => p.section === `part${i}` && p.label === label), `${label} in part ${i + 1}`);
  }
});

test('Virus TI2: the simulator answers requests and keeps edits', () => {
  const sim = def.simulate();
  const [eb] = sim.handle(V.msg.singleRequest(ctx, 0, 0x40));
  assert.equal(V.nameOf(V.singleFrom(Uint8Array.from(eb))), 'Init');
  sim.handle(V.msg.param(ctx, 0x70, 0x40, 40, 11));
  assert.equal(sim.state.single[40], 11);
  const bank = sim.handle(V.msg.singleBankRequest(ctx, 5));
  assert.equal(bank.length, 128);
  assert.equal(V.nameOf(V.singleFrom(Uint8Array.from(bank[3]))), 'A004 Sgl');
  sim.handle(V.msg.param(ctx, 0x72, 3, 34, 9));
  assert.equal(sim.state.multi[32 + 16 * 2 + 3], 9);
  const items = V._test.libraryItems([...bank.slice(0, 2), ...sim.handle(V.msg.multiRequest(ctx, 0, 0))].map((x) => Uint8Array.from(x)));
  assert.deepEqual(items.map((i) => i.object), ['single', 'single', 'multi']);
});

test('Virus TI2: single and multi through the shared model', () => {
  const d = V.initSingle();
  d[40] = 77;
  const c = single.toCommon(d);
  assert.equal(c.kind, 'patch');
  const back = single.fromCommon(c, V.initSingle());
  assert.deepEqual(back.data, d);
  // another family: only the semantic sections
  const sn2 = SN2DEF.objects.find((o) => o.key === 'program').toCommon(SN2.initProgram());
  const r = single.fromCommon(sn2, V.initSingle());
  assert.ok(r.report.mapped.length > 10);
  assert.ok(r.data.every((x) => x <= 127));
  const m = V.initMulti();
  const mc = multi.toCommon(m);
  assert.equal(mc.parts.length, 16);
  assert.deepEqual(multi.fromCommon(mc, V.initMulti()).data, m);
  const fromOther = multi.fromCommon({ ...mc, extra: undefined, parts: [{ on: true, channel: 4, program: 9, level: 1 }] }, V.initMulti());
  assert.equal(fromOther.data[32 + 16 * 2], 4);
  assert.equal(fromOther.data[48], 9);
});

import * as OS from '../js/devices/defs/access-virus-ti2-os.js';

test('Virus TI2: bytes without a parameter in the TI2 OS are named reserved, read-only entries', () => {
  // the OS's own tables (tools/virus/os_tables.py) hold Virus Control's bytes, the format byte and nothing else
  const vc = new Set(FW.SINGLE.map(([o]) => o));
  for (let o = 0; o < 512; o++) {
    const sound = OS.SINGLE[o].filter(([id]) => id < 0x500);
    assert.equal(sound.length > 0, (vc.has(o) && o !== 123) || o === 0, `byte ${o}`);
  }
  for (const p of single.params) {
    assert.doesNotMatch(p.label, /^Byte \d/, p.key);
    if (p.section === 'reserved') { assert.ok(p.readOnly && p.group === 'Reserved bytes', p.key); assert.equal(OS.SINGLE[p.offset].filter(([id]) => id < 0x500).length, 0, p.key); }
  }
  assert.equal(single.params.filter((p) => p.section === 'reserved').length, 124); // Virus Control's 124 undescribed bytes less byte 0 (the Format, under Common), plus 123 (All Notes Off)
  assert.equal(single.params.find((p) => p.offset === 97).label, 'Unison Mode (formats 8-9)');
  assert.equal(single.params.find((p) => p.offset === 11).label, 'Controller 11 (Expression)');
  assert.equal(single.params.find((p) => p.offset === 1).format(0x11), '11h: edited, part of a multi');
  assert.deepEqual(single.params.find((p) => p.offset === 386).options, [[0, 'Off'], [1, 'On']]);
  for (const p of multi.params) assert.doesNotMatch(p.label, /^Byte \d/, p.key);
  assert.equal(multi.params.find((p) => p.offset === 1 && !p.bits).format(5), '05h: edited, loaded by SysEx');
  // the multi indexes the OS has parameters for are the ones Virus Control describes
  const idx = new Set(Object.keys(OS.MULTI).map(Number));
  for (const i of [0, 2, 14, 16, 28, 30, 31, 42, 44, 76]) assert.ok(!idx.has(i), `multi index ${i}`);
  for (const i of [1, 3, 4, 13, 15, 29, 32, 41, 43, 72, 75, 77, 78]) assert.ok(idx.has(i), `multi index ${i}`);
});

test('Virus TI2: older sounds (formats 8, 9, 11) are converted as the OS does when they arrive', () => {
  const d = V.initSingle();
  d[0] = 9; d[97] = 1; d[98] = 80; d[99] = 127; d[100] = 64; d[102] = 1; d[38] = 11; d[129] = 4; d[255] = 127; d[128] = 1;
  const u = V.upgradeSingle(d);
  assert.equal(u[0], 12);
  assert.deepEqual([...u.slice(504, 510)], [1, 80, 127, 64, 0, 1]);
  assert.deepEqual([u[50], u[143], u[128], u[255], u[103], u[104], u[336]], [11, 4, 64, 0, 1, 127, 20]);
  assert.equal(u[97], 1, 'the old place is left as it was');
  assert.deepEqual(V.upgradeSingle(u), u, 'format 12 is left alone');
  // sounds sent to the unit and read back (re/virusti/p2/t_conv*.json, when present): identical but bytes 1-3
  for (const f of ['z:/MIDIMaster/re/virusti/p2/t_conv.json', 'z:/MIDIMaster/re/virusti/p2/t_conv9.json']) {
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const pair of j.old ? [j] : Object.values(j)) {
      const got = V.upgradeSingle(Uint8Array.from(pair.old));
      for (let o = 0; o < 512; o++) if (o < 1 || o > 3) assert.equal(got[o], pair.conv[o], `${f} byte ${o}`);
    }
  }
});

test('Virus TI2: the multi comes with its part names (arrangement), remote template requests', async () => {
  assert.deepEqual(V.msg.remoteTemplateRequest(ctx, 2, 31), [0xf0, 0x00, 0x20, 0x33, 0x01, 0x10, 0x38, 0x02, 0x1f, 0xf7]);
  assert.equal(def.requests.filter((r) => r.label.startsWith('Remote template')).length, 32);
  const sim = def.simulate();
  sim.state.parts[3].set([..."Part Four "].map((c) => c.charCodeAt(0)), 240);
  const api = {
    ctx,
    g: { client: { s: { timeout: 100 }, request: async (bytes, o) => {
      const replies = sim.handle(bytes) || [];
      const messages = replies.filter((m) => o.collect(null, Uint8Array.from(m))).map((m) => ({ raw: m }));
      return { messages };
    } } },
  };
  const d = await multi.fetch(api);
  assert.equal(d.length, V.MULTI_SIZE);
  const sound = multi.params.find((p) => p.key === 'p3_sound');
  assert.equal(sound.dynamic(d).options[0][1], 'Part Four');
  assert.equal(def.describe(Uint8Array.from([0xf0, 0, 0x20, 0x33, 1, 0, 0x13, 0, 2, ...[..."Remote 22"].map((c) => c.charCodeAt(0)), 0, ...new Array(44).fill(15), 0, 0xf7])), 'Virus remote template 00 knob 2 "Remote 22"');
});

test('Virus TI2: remote templates (38 tt kk -> 13 tt kk): name record, knobs, ranges and MIDI strings', async () => {
  const tpl = def.objects.find((o) => o.key === 'setup');
  // edits stay in the editor (no per-parameter send); "Write to the Virus" sends the records
  assert.ok(!tpl.sendParam && !tpl.sendAll && !tpl.slots);
  assert.deepEqual(tpl.params.filter((p) => !p.readOnly).map((p) => p.key.replace(/^k\d+_/, 'k_')).filter((k, i, a) => a.indexOf(k) === i), ['t_channel', 'k_range', 'k_vc']);
  assert.deepEqual(tpl.actions.map((a) => a.label), ['Edit knob...', 'Rename template...', 'Import .vrt...', 'Write to the Virus']);
  // the full dump reads every record of the 32 templates (16 is the name record and gets no answer)
  const steps = def.fullDump.filter((s) => /^Remote template/.test(s.label || ''));
  assert.equal(steps.length, 32 * 32);
  assert.deepEqual(steps[0].bytes(ctx).slice(6, 9), [0x38, 0x00, 0x20]);
  // the unit's answers when captured (re/virusti/p3/templates_all.syx: every template as the OS initialises them)
  const file = 'z:/MIDIMaster/re/virusti/p3/templates_all.syx';
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    const msgs = [];
    for (let i = 0; i < raw.length; i++) if (raw[i] === 0xf0) { const j = raw.indexOf(0xf7, i); msgs.push(Uint8Array.from(raw.subarray(i, j + 1))); i = j; }
    assert.equal(msgs.length, 32 * 32);
    for (const tt of [0, 1, 31]) {
      const d = V.templateFrom(msgs, tt);
      assert.deepEqual(d, V.initTemplate(tt), `template ${tt}`);
      for (const m of msgs.filter((x) => x[7] === tt)) assert.deepEqual(V.templateMessage({ deviceId: m[5] }, tt, m[8], d), Array.from(m));
    }
    assert.equal(V.templateNameOf(V.templateFrom(msgs, 0)), 'Init Template');
    assert.equal(V.templateNameOf(V.templateFrom(msgs, 5)), 'Template Set 05');
  }
  // the simulator answers like the unit; Get from device reads one template
  const sim = def.simulate();
  const api = { ctx, g: { client: { s: { timeout: 100 }, request: async (bytes, o) => ({ messages: (sim.handle(bytes) || []).filter((m) => o.collect(null, Uint8Array.from(m))).map((m) => ({ raw: m })) }) } } };
  assert.deepEqual(sim.handle([0xf0, 0, 0x20, 0x33, 1, 0x10, 0x38, 0, 16, 0xf7]), []);
  const d = await tpl.fetch(api);
  assert.equal(d.length, V.TEMPLATE_SIZE);
  const view = (key) => { const p = tpl.params.find((x) => x.key === key); return { ...p, ...(p.dynamic ? p.dynamic(d) : {}) }; };
  assert.equal(view('k0_name').options[0][1], 'Remote 20');
  assert.equal(view('k31_midi').options[0][1], 'B0 3F * (Control Change ch 1 CC 63)');
  assert.equal(view('k0_range').options[0][1], '0-127 (Virus Control: Unipolar 0-127)');
  assert.match(view('k0_range').options[64][1], /^0-127 \(Virus Control: Bipolar -64 - \+63\)$/);
  assert.equal(view('k0_range').options[52][1], '0-12 (Virus Control: Unipolar 0-12)');
  assert.equal(view('t_name').options[0][1], 'Init Template');
  assert.equal(tpl.params.filter((p) => p.key.endsWith('_name')).length, 32);
  // a Virus Control template file record: SysEx string with the value in the middle, channel switch on
  const e = V.initTemplate(0);
  e.set([0x40, 0x01, 0xf0, 0x41, 0x32, 0x00, 0x0e, 0xff, 0xf7, 0xfe], 32 * 3 + 10);
  assert.equal(V.midiStringText(e, 32 * 3 + 12), 'F0 41 32 00 0E * F7 (SysEx)');
  assert.equal(V.midiStringInput(e, 32 * 3 + 12), 'F0 41 32 00 0E * F7');
});

test('Virus TI2: template records are the panel knobs (OS knob table), written with 13 tt kk', async () => {
  const OS = await import('../js/devices/defs/access-virus-ti2-os.js');
  // knob table: 32 knobs, every one remote except 16 (Master Volume: its record holds the template name)
  assert.equal(OS.PANEL_KNOBS.length, 32);
  assert.deepEqual(OS.PANEL_KNOBS.map((k, i) => (k[0] ? -1 : i)).filter((i) => i >= 0), [V.TEMPLATE_NAME_RECORD]);
  assert.deepEqual(OS.PANEL_KNOBS[16][2], ['Master Volume']);
  assert.deepEqual(OS.PANEL_KNOBS.map((k, i) => [i, k[1]]).filter(([, s]) => s), [[0, 1], [12, 2], [26, 3]]);
  assert.deepEqual(OS.PANEL_KNOBS[6][2], ['Vocoder Center Frequency', 'Filter 1 Cutoff']);
  // every record has a label taken from the OS's names for its knob, and the areas hold each record once
  const areas = V.PANEL_AREAS.flatMap(([, , ks]) => ks).sort((a, b) => a - b);
  assert.deepEqual(areas, V.TEMPLATE_KNOBS);
  for (const k of V.TEMPLATE_KNOBS) {
    const p = V.panelKnob(k);
    assert.ok(p.soft ? p.label === `Soft Knob ${p.soft}` : p.funcs.includes(p.label), `record ${k}: ${p.label}`);
  }
  assert.equal(V.panelKnob(19).label, 'Lfo 1 Rate');
  const tpl = def.objects.find((o) => o.key === 'setup');
  assert.equal(tpl.params.find((p) => p.key === 'k6_name').group, 'Filter 1 Cutoff (record 6)');
  assert.deepEqual(tpl.sections.map((s) => s.label), ['Template', 'Soft knobs', 'LFO and oscillators', 'Mixer', 'Filters', 'Envelopes', 'Effects']);
  // Virus Control's knob behaviour numbers -> the OS's range types with the same values
  assert.equal(V.vcBehaviourToOs(0), 0);
  assert.equal(V.vcBehaviourToOs(1), 4);
  assert.equal(V.vcBehaviourToOs(52), 64);
  assert.equal(V.vcBehaviourToOs(61), 77);
  // MIDI strings typed in the editor
  assert.deepEqual(V.parseMidiString('b0 46 *'), [0xb0, 0x46, 0xff, ...Array(17).fill(0xfe)]);
  assert.throws(() => V.parseMidiString('B0 FE'));
  assert.throws(() => V.parseMidiString('B0 4G'));
  assert.throws(() => V.parseMidiString(Array(21).fill('00').join(' ')));
  // a write: 32 messages (name first), read back from the simulator identical
  const d = V.initTemplate(31);
  d.set(V.parseMidiString('F0 41 32 00 0E * F7'), 32 * 6 + 12);
  d[32 * 6 + 10] = 64;
  d[32 * V.TEMPLATE_NAME_RECORD + 16] = 1;
  const w = V.templateWrite(ctx, 31, d);
  assert.equal(w.length, 32);
  assert.deepEqual(w[0].slice(6, 9), [0x13, 31, 0x20]);
  assert.ok(w.slice(1).every((m) => m.length === 65 && m[8] !== V.TEMPLATE_NAME_RECORD));
  const sim = def.simulate();
  for (const m of w) sim.handle(m);
  const api = { ctx, g: { client: { s: { timeout: 100 }, request: async (bytes, o) => ({ messages: (sim.handle(bytes) || []).filter((m) => o.collect(null, Uint8Array.from(m))).map((m) => ({ raw: m })) }) } } };
  const keep = V._test.unit.template;
  V._test.unit.template = 31;
  try {
    assert.deepEqual(await tpl.fetch(api), d);
    assert.deepEqual(tpl.toSyx(d, ctx), w);
    assert.deepEqual(tpl.fromSyx(w.map((m) => Uint8Array.from(m))), d);
  } finally { V._test.unit.template = keep; }
  // a bad checksum is ignored (as the OS's state 23)
  const bad = V.templateMessage(ctx, 30, 3, d); bad[bad.length - 2] ^= 1;
  sim.handle(bad);
  assert.deepEqual(sim.state.templates[30], V.initTemplate(30));
  // a Virus Control file: its records (template 0 in the file) for the chosen template, behaviours converted
  const vc = V.initTemplate(0);
  vc[32 * 2 + 10] = 52;
  const f = V.templateFromFile(V.templateWrite(ctx, 0, vc).map((m) => Uint8Array.from(m)), 7, true);
  assert.equal(f[32 * 2 + 10], 64);
  assert.equal(V.templateNameOf(f), 'Init Template');
});

test('Virus TI2: a multi store goes to bank 32h for slots 1-16 and bank 1 for 17-128 (checked on RAM multi 001)', () => {
  const d = V.initMulti();
  assert.deepEqual(multi.slots.store(1, 0, ctx, d).slice(6, 9), [0x11, 0x32, 0x00]);
  assert.deepEqual(multi.slots.store(1, 15, ctx, d).slice(6, 9), [0x11, 0x32, 0x0f]);
  assert.deepEqual(multi.slots.store(1, 16, ctx, d).slice(6, 9), [0x11, 0x01, 0x10]);
  const sim = def.simulate();
  sim.state.global[118] = 0;
  const named = Uint8Array.from(d); named.set([..."Stored M  "].map((c) => c.charCodeAt(0)), 4);
  sim.handle(V.msg.multi(ctx, 1, 0, named)); // bank 1 slot 0: refused, as by the OS
  assert.notEqual(V.multiNameOf(sim.state.multis.get('1:0')), 'Stored M');
  sim.handle(multi.slots.store(1, 0, ctx, named));
  assert.equal(V.multiNameOf(sim.state.multis.get('1:0')), 'Stored M');
});

test('Virus TI family: the TI and TI2 Desktop, Keyboard and Polar share the TI2 editor (one host OS)', async () => {
  const { CATALOG_EXTRA } = await import('../js/devices/catalog-extra.js');
  const ids = { 'access-virus-ti2-keyboard': 'Virus TI2 Keyboard', 'access-virus-ti2-polar': 'Virus TI2 Polar', 'access-virus-ti-desktop': 'Virus TI Desktop', 'access-virus-ti-keyboard': 'Virus TI Keyboard', 'access-virus-ti-polar': 'Virus TI Polar' };
  for (const [id, model] of Object.entries(ids)) {
    const m = (await import(`../js/devices/defs/${id}.js`)).default;
    assert.equal(m.model, model);
    assert.equal(m.objects, def.objects, id); // the same objects, parameters and messages
    assert.ok(m.coverage.startsWith(`${model}: `) && /Not checked on this model/.test(m.coverage), id);
    assert.equal(CATALOG_EXTRA.find((e) => e.id === id)?.model, model);
    assert.ok(fs.existsSync(`z:/MIDIMaster/docs/devices/${id}.md`), `doc for ${id}`);
  }
  // the evidence: the first TI's host OS image differs from the TI2's in one byte (when the extracted sections are present)
  const a = 'z:/MIDIMaster/re/virusti/fw/ti1/F000.bin', b = 'z:/MIDIMaster/re/virusti/fw/ti2/F000.bin';
  if (fs.existsSync(a) && fs.existsSync(b)) {
    const x = fs.readFileSync(a), y = fs.readFileSync(b);
    const diff = [...x.keys()].filter((i) => x[i] !== y[i]);
    assert.deepEqual(diff.map((i) => [i, x[i], y[i]]), [[0x0a, 7, 5]]);
    for (let n = 1; n <= 13; n++) { const f = `F${String(n).padStart(3, '0')}.bin`; assert.ok(fs.readFileSync(a.replace('F000.bin', f)).equals(fs.readFileSync(b.replace('F000.bin', f))), f); }
  }
});
