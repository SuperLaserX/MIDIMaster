import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam, formatParam } from '../js/core/model/memmap.js';
import { rq1, dt1, parseDt1, intToAddr } from '../js/core/midi/roland.js';
import def, { _test as T, NOTE } from '../js/devices/defs/roland-jp8080.js';

const obj = (key) => def.objects.find((o) => o.key === key);
const hexs = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const addr = (n) => intToAddr(n).map((b) => b.toString(16).padStart(2, '0')).join(' ');
const show = (p, d) => { const v = readParam(d, p); return p.options?.find(([x]) => x === v)?.[1] ?? formatParam(p, v); };

// Every byte has a name: from the firmware screens, the JP-8000 menus or Roland's address map.
const UNTRACED = { system: [], patch: [], performance: [] };

test('JP-8080: every byte of system, performance and patch has one parameter with a firmware label', () => {
  for (const o of def.objects) {
    const seen = new Uint8Array(o.size);
    for (const p of o.params) {
      for (let i = 0; i < (p.size || 1); i++) {
        assert.equal(seen[p.offset + i], 0, `${o.key} ${p.key} overlaps`);
        seen[p.offset + i] = 1;
      }
    }
    assert.ok(seen.every(Boolean), `${o.key}: every byte covered`);
    const unl = o.params.filter((p) => p.label.startsWith('Byte')).map((p) => p.label);
    assert.deepEqual(unl, UNTRACED[o.key], `${o.key}: only the untraced bytes lack a label`);
  }
  assert.equal(obj('patch').params.length, 168);
});

test('JP-8080: addresses follow the firmware address decoder', () => {
  const at = (built, off) => addr(T.addressOf(built, off));
  assert.equal(at(T.patchBuilt, 0x29), '01 00 40 29');
  T.patchTarget.key = 'lower';
  T.patchTarget.base = T.A('01 00 42 00');
  assert.equal(at(T.patchBuilt, 0xf7), '01 00 43 77', 'F8h bytes run past 42 7F in 7-bit arithmetic');
  T.patchTarget.key = 'upper';
  T.patchTarget.base = T.A('01 00 40 00');
  assert.equal(at(T.sysBuilt, 0x1d), '00 00 30 00');
  assert.equal(at(T.sysBuilt, 0x19), '00 00 20 00');
  assert.equal(at(T.perfBuilt, 0x25), '01 00 08 00');
  assert.equal(at(T.perfBuilt, 0x56 + 2), '01 00 11 02');
  assert.equal(addr(T.userPatch(5)), '02 00 0a 00');
  assert.equal(addr(T.userPatch(64)), '02 01 00 00');
  assert.equal(addr(T.userPatch(127)), '02 01 7e 00');
  assert.equal(addr(T.userPerf(63)), '03 3f 00 00');
  const p = obj('patch').params.find((x) => x.label === 'FLT CUTOFF FREQ' && x.section === 'main');
  const d = obj('patch').init();
  d[0x29] = 99;
  const cs = (128 - ((1 + 0x40 + 0x29 + 99) % 128)) % 128;
  assert.deepEqual(p.send(99, { deviceId: 0x10 }, d), [0xf0, 0x41, 0x10, 0x00, 0x06, 0x12, 0x01, 0x00, 0x40, 0x29, 99, cs, 0xf7]);
});

test('JP-8080: value displays from the firmware formats', () => {
  const P = (o, label, section) => obj(o).params.find((x) => x.label === label && (!section || x.section === section));
  const d = obj('patch').init();
  const depth = P('patch', 'FLT CUTOFF FREQ', 'control');
  assert.equal(depth.size, 2);
  d[depth.offset] = 1;
  d[depth.offset + 1] = 12;
  assert.equal(readParam(d, depth), 140);
  assert.equal(show(depth, d), '+13', 'two-byte depth: hi*128 + lo, centre 127');
  writeParam(d, depth, 0);
  assert.deepEqual([d[depth.offset], d[depth.offset + 1]], [0, 0]);
  assert.equal(show(depth, d), '-127');
  const range = P('patch', 'OSC2 RANGE');
  d[range.offset] = 0; assert.equal(show(range, d), '-WIDE');
  d[range.offset] = 50; assert.equal(show(range, d), '+WIDE');
  d[range.offset] = 37; assert.equal(show(range, d), '+12');
  const fine = P('patch', 'OSC2 FINE');
  d[fine.offset] = 0; assert.equal(show(fine, d), '-50');
  const mfx = P('patch', 'Multi-FX Type');
  d[mfx.offset] = 12; assert.equal(show(mfx, d), 'DISTORTION');
  const pf = obj('performance').init();
  const ch = obj('performance').params.find((x) => x.label === 'Part MIDI CH' && x.part === 1);
  pf[ch.offset] = 16; assert.equal(show(ch, pf), 'OFF');
  pf[ch.offset] = 1; assert.equal(show(ch, pf), 'Ch 2');
  const lfo = obj('performance').params.find((x) => x.label === 'LFO Sync' && x.part === 0);
  pf[lfo.offset] = 22; assert.equal(show(lfo, pf), '8 MEASURES');
  pf[lfo.offset] = 7; assert.equal(show(lfo, pf), '1/4');
  const split = P('performance', 'Split Point');
  pf[split.offset] = 60; assert.equal(show(split, pf), 'C4');
  assert.equal(NOTE(0), 'C-1');
  const tempo = P('performance', 'TEMPO');
  pf[tempo.offset] = 0; pf[tempo.offset + 1] = 120;
  assert.equal(readParam(pf, tempo), 120);
  const sys = obj('system').init();
  const tune = obj('system').params.find((x) => x.label === 'Master Tune');
  sys[tune.offset] = 50; assert.equal(show(tune, sys), '440.0Hz');
  const slot = obj('system').params.find((x) => x.offset === 0x1d);
  assert.equal(slot.label, 'LFO1 RATE');
  assert.equal(show(slot, sys), 'GENERAL1:CC16', 'factory MODE2 CC from the firmware table');
});

test('JP-8080: identity quirk, simulator reads and writes, library split', () => {
  assert.ok(T.isJP8080Identity(hexs('f0 7e 10 06 02 06 01 00 00 00 03 00 00 f7')), 'the firmware sends no 41h');
  const sim = def.simulate();
  const reply = sim.handle(rq1(T.MODEL, 0x10, intToAddr(T.A('01 00 40 00')), 0xf8));
  const got = reply.map((m) => parseDt1(Uint8Array.from(m), T.MODEL));
  assert.ok(got.every((p) => p.ok));
  assert.equal(got.reduce((n, p) => n + p.data.length, 0), 0xf8);
  assert.equal(String.fromCharCode(...got[0].data.slice(0, 10)), 'Demo Upper');
  const more = [...sim.handle(rq1(T.MODEL, 0x10, intToAddr(T.userPatch(3)), 0x10)), ...sim.handle(rq1(T.MODEL, 0x10, intToAddr(T.userPerf(2)), 0x10))];
  const items = T.libraryItems([...reply, ...more]);
  assert.deepEqual(items.map((i) => i.label), ['Temporary patch (upper)', 'User patch A14', 'User performance 13']);
  assert.equal(items[1].name, 'User A14');
});

test('JP-8080: objects read, edit, store and select through the device client (simulator)', async () => {
  const { LoopbackTransport } = await import('../js/core/midi/loopback.js');
  const { DeviceClient } = await import('../js/core/midi/device-client.js');
  const { asList } = await import('../js/devices/generic/objects.js');
  const t = new LoopbackTransport({ id: 'roland-jp8080', model: 'JP-8080', sysex: '41' }, def);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const ctx = { deviceId: 0x10, channel: 0, data: {}, loaded: new Set(), names: {} };
  const api = { g: { client: c, demo: true }, ctx, send: (out) => { for (const b of asList(out)) c.send(Uint8Array.from(b)); }, toast: () => {} };
  ctx.data.system = await obj('system').fetch(api); ctx.loaded.add('system');
  assert.equal(ctx.data.system[2], 15, 'Perform Ctrl CH 16');
  ctx.data.performance = await obj('performance').fetch(api); ctx.loaded.add('performance');
  assert.equal(obj('performance').name(ctx.data.performance), 'Demo Perform');
  const patch = await obj('patch').fetch(api);
  assert.equal(obj('patch').name(patch), 'Demo Upper');
  // A live edit goes to the temporary patch address.
  const cut = obj('patch').params.find((p) => p.label === 'FLT CUTOFF FREQ' && p.section === 'main');
  writeParam(patch, cut, 33);
  api.send(cut.send(33, ctx, patch));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.sim.mem.get(T.A('01 00 40 29')), 33);
  // Store into user patch A12, read its name back, select it on the upper part's channel.
  api.send(obj('patch').slots.store(0, 1, ctx, patch));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await obj('patch').slots.fetchName(api, 0, 1), 'Demo Upper');
  assert.deepEqual(obj('patch').slots.recall(1, 9, ctx), [[0xb0, 0, 0x51], [0xb0, 32, 0], [0xc0, 9]], 'preset 1, upper part on channel 1');
  assert.deepEqual(obj('performance').slots.recall(0, 3, ctx), [[0xbf, 0, 0x50], [0xbf, 32, 0], [0xcf, 3]], 'performance on the Perform Ctrl channel');
  const up = await obj('performance').slots.fetch(api, 0, 2);
  assert.equal(obj('performance').name(up), 'Perform U:13');
});

test('JP-8080: switches, JP-8000 bytes and presets follow the firmware and Roland\'s address map', () => {
  const lab = (o, key) => obj(o).params.find((p) => p.key === key);
  const opt = (p) => p.options.map(([, l]) => l);
  assert.deepEqual(opt(lab('patch', 'PATCH_49')), ['-2 oct', '-1 oct', '0', '+1 oct', '+2 oct'], 'Oscillator shift');
  assert.deepEqual(opt(lab('patch', 'PATCH_21')), ['SQUARE', 'TRIANGLE', 'SAW', 'NOISE'], 'OSC2 waveform');
  assert.deepEqual(opt(lab('patch', 'PATCH_3a')), ['OFF', 'AUTO PAN', 'MANUAL PAN']);
  assert.equal(lab('patch', 'PATCH_f3').label, 'Unison switch');
  assert.equal(lab('patch', 'PATCH_ec').readOnly, true, 'active indicators are not received');
  assert.equal(lab('performance', 'PERF_24').label, 'Vocal/upper input jack');
  assert.equal(lab('performance', 'PERF_1c').label, 'Pedal Assign (JP-8000)');
  assert.equal(lab('performance', 'PERF_1c').options[45][1], 'RIBBON DOWN');
  assert.equal(lab('performance', 'VMOD_1').label, 'Voice modulator panel mode');
  assert.equal(lab('system', 'SYSTEM_d').label, 'Motion Set');
  assert.deepEqual(opt(lab('system', 'SYSTEM_d')), ['SET A', 'SET B']);
  const depth = obj('patch').params.find((p) => p.offset === 0x62);
  assert.deepEqual([depth.min, depth.max], [0x4d, 0xb1], 'OSC2 range depth -50..+50');
  const pb = obj('patch').slots;
  assert.equal(pb.names(1)[0], "Spit'n Slide Bs", 'PRESET 1 A11 (checked on the unit)');
  assert.equal(pb.names(1)[127], 'Template 2');
  assert.equal(pb.names(3)[127], 'Pulsing Sweep', 'PRESET 3 B88 (checked on the unit)');
  assert.equal(pb.names(0), null, 'user names are read from the unit');
  const fb = obj('performance').slots;
  assert.deepEqual([fb.names(1)[0], fb.names(2)[0], fb.names(3)[63]], ['Chariots', 'Sand Storm', 'Octopus Garden']);
  assert.deepEqual(fb.recall(3, 5, { channel: 2 }), [[0xb2, 0, 0x51], [0xb2, 32, 2], [0xc2, 5]]);
});

test('JP-8080: motion and RPS pattern data in the librarian', () => {
  assert.deepEqual(T.unpack7([0x06, 0x03, 0x7f, 0x00, 0x02, 0x0e, 0x2a]), [[0x03, 0xff, 0x80, 0x02, 0x0e, 0x2a]]);
  assert.equal(addr(T.patternAddr(47)), '08 2f 00 00');
  assert.equal(T.PATTERN_KEYS[0], 'C#2');
  assert.equal(T.PATTERN_KEYS[47], 'C6');
  const msg = (a, n) => dt1(T.MODEL, 0x10, hexs(a), new Array(n).fill(0));
  const items = T.libraryItems([msg('09 00 00 00', 7), msg('09 00 01 67', 7), msg('0a 40 00 00', 7), msg('08 05 00 00', 7)]);
  assert.deepEqual(items.map((i) => [i.label, i.msgs.length]), [['Motion A[1]', 2], ['Motion B[2]', 1], ['RPS pattern F#2', 1]]);
  const req = def.requests.find((r) => r.label.startsWith('Motion sets')).bytes({ deviceId: 0x10 });
  assert.equal(req.length, 4);
  assert.ok(!def.requests.some((r) => /pattern/i.test(r.label)), 'RPS patterns have no SysEx in OS 1.04');
});

test('JP-8080: motion events: timeline, rebuild and data from the unit', async () => {
  const { motionTimeline, buildMotion, pack7, unpack7, MOTION_TICKS, MOTION_SLOTS } = await import('../js/devices/defs/roland-jp8080.js');
  assert.equal(MOTION_SLOTS[4][1], 'OSC BALANCE');
  assert.equal(MOTION_SLOTS[16][1], 'FLT CUTOFF FREQ');
  const pts = [{ tick: 3, slot: 4, value: 1 }, { tick: 5, slot: 4, value: 3 }, { tick: 600, slot: 16, value: 127 }];
  const ev = buildMotion(pts, MOTION_TICKS);
  assert.deepEqual(ev[0], [3, 0xff, 0x80, 0x02, 0x0e, 0x2a], 'header waits until the first event');
  assert.deepEqual(ev[1], [2, 0x02, 0x81, 4, 1, 0]);
  assert.ok(ev.every((e) => e[0] <= 0xc0), 'long gaps are split into empty events');
  assert.equal(ev.reduce((n, e) => n + e[0], 0), MOTION_TICKS);
  const raw = pack7(ev);
  assert.deepEqual(unpack7(raw), ev);
  const t = motionTimeline(raw);
  assert.equal(t.total, MOTION_TICKS);
  assert.deepEqual(t.points, pts);
  // A motion read from the unit (re/jp8080/live, skipped when absent): rebuilt, it keeps its events and length.
  const fs = await import('node:fs');
  const file = new URL('../re/jp8080/live/motion_b1.bin', import.meta.url);
  if (fs.existsSync(file)) {
    const unit = motionTimeline(fs.readFileSync(file));
    assert.equal(unit.total, 10368);
    const again = motionTimeline(pack7(buildMotion(unit.points, unit.total)));
    assert.deepEqual(again, { ...unit, header: again.header });
  }
});

test('JP-8080: a temporary patch read from the unit decodes', () => {
  // 01 00 40 00, first 78h bytes, read from a JP-8080 (preset performance "Den").
  const raw = hexs(`44 65 6e 20 55 20 20 20 20 20 20 20 20 20 20 20 00 20 00 46 00 01 56 40 02 40 4c 40 31 38 03 25
    7f 00 01 19 2b 23 28 02 00 39 2a 51 33 40 60 5a 77 52 68 59 6e 40 36 4a 55 52 01 7f 40 07 7f 01
    65 62 7f 02 02 01 1f 00 01 01 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f
    00 7f 00 7f 00 7f 00 7f 00 7f 01 0c 00 7f 00 7f 00 7f 00 7f 00 7f 00 7f`);
  const d = obj('patch').init();
  d.set(raw, 0);
  assert.equal(obj('patch').name(d), 'Den U');
  const P = (label, section = 'main') => obj('patch').params.find((x) => x.label === label && x.section === section);
  assert.equal(show(P('OSC1 waveform'), d), 'FEEDBACK OSC');
  assert.equal(show(P('Multi-FX Type'), d), 'DEEP PHASING SLW');
  assert.equal(show(P('Delay Type'), d), 'PANNING R->L');
  assert.equal(show(P('Bend Range Up'), d), '+2');
  assert.equal(show(P('Bend Range Down'), d), '-2');
  assert.equal(show(P('PITCH LFO2 DEPTH'), d), '+12');
  assert.equal(show(P('FLT CUTOFF FREQ', 'control'), d), '+13');
});

test('JP-8080: identity reply without 41h names Roland, generically and in the definition', async () => {
  const { describeUniversal, identityInfo } = await import('../js/core/midi/describe.js');
  const raw = Uint8Array.from([0xf0, 0x7e, 0x10, 0x06, 0x02, 0x06, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0xf7]);
  assert.match(def.describeIdentity(raw), /^Identity reply: Roland JP-8080/);
  assert.match(describeUniversal(raw, '41'), /^Identity reply: Roland \(the reply leaves out/);
  assert.deepEqual(Array.from(identityInfo(raw, '41').version), [0, 3, 0, 0]);
  const jv = Uint8Array.from([0xf0, 0x7e, 0x10, 0x06, 0x02, 0x41, 0x6a, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf7]);
  assert.match(describeUniversal(jv, '41'), /^Identity reply: Roland, family 6a 00/, 'a normal Roland reply is unchanged');
});

test('JP-8080 Motion page: drawn strokes and shapes become knob events', async () => {
  const v = await import('../js/devices/defs/roland-jp8080-motion.js');
  const { buildMotion, pack7, motionTimeline, MOTION_TICKS } = await import('../js/devices/defs/roland-jp8080.js');
  const line = v.sampleCurve(16, 0, 480, 48, (t) => (t / 480) * 127);
  assert.equal(line[0].value, 0);
  assert.equal(line.at(-1).tick, 480);
  assert.equal(line.at(-1).value, 127);
  assert.ok(line.every((p, i) => !i || p.tick - line[i - 1].tick === 48));
  const flat = v.sampleCurve(4, 0, 960, 48, () => 64);
  assert.equal(flat.length, 1, 'repeated values are left out');
  const f = v.strokeFunction([{ tick: 100, value: 0 }, { tick: 300, value: 127 }, { tick: 600, value: 127 }]);
  assert.equal(f(200), 63.5);
  let pts = [{ tick: 50, slot: 16, value: 1 }, { tick: 200, slot: 16, value: 2 }, { tick: 200, slot: 17, value: 3 }];
  pts = v.replaceRange(pts, 16, 100, 300, [{ tick: 150, slot: 16, value: 99 }]);
  assert.deepEqual(pts, [{ tick: 50, slot: 16, value: 1 }, { tick: 150, slot: 16, value: 99 }, { tick: 200, slot: 17, value: 3 }], 'only that knob, only inside the range');
  const sine = v.sampleCurve(16, 0, MOTION_TICKS - 1, 48, v.shapeFunction('sine', 0, MOTION_TICKS - 1, 4, 10, 120));
  assert.equal(Math.min(...sine.map((p) => p.value)), 10);
  assert.equal(Math.max(...sine.map((p) => p.value)), 120);
  const back = motionTimeline(pack7(buildMotion(sine, MOTION_TICKS)));
  assert.deepEqual(back.points, sine);
  assert.equal(back.total, MOTION_TICKS);
  for (const s of ['up', 'down', 'tri', 'square', 'random']) assert.ok(v.sampleCurve(0, 0, 1000, 24, v.shapeFunction(s, 0, 1000, 2, 0, 127)).length > 1, s);
});

test('Complete dump: requests in turn, replies recorded, silent steps noted', async () => {
  const { LoopbackTransport } = await import('../js/core/midi/loopback.js');
  const { DeviceClient } = await import('../js/core/midi/device-client.js');
  const { fullDumpSteps, runFullDump } = await import('../js/devices/generic/fulldump.js');
  const steps = fullDumpSteps(def);
  assert.deepEqual(steps.map((s) => s.label).slice(0, 6), ['System', 'Temporary performance (common, voice modulator, parts)', 'Temporary patch, upper', 'Temporary patch, lower', 'All user patches', 'All user performances']);
  assert.equal(steps.at(-1).timeout, 3000, 'per-step options carry over');
  const t = new LoopbackTransport({ id: 'roland-jp8080', model: 'JP-8080', sysex: '41' }, def);
  const client = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const quick = [steps[0], steps[2], { label: 'Nothing answers this', bytes: () => [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7], timeout: 200 }].map((s) => ({ ...s, quiet: 150 }));
  const seen = [];
  const r = await runFullDump({ transport: t, client, ctx: { deviceId: 0x10 } }, quick, { onStep: (i) => seen.push(i) });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(r.results.map((x) => x.count > 0), [true, true, false]);
  const data = r.messages.reduce((n, m) => n + parseDt1(m, T.MODEL).data.length, 0);
  assert.equal(data, 0x19 + 4 + 0x2a + 0xf8, 'system blocks and one patch');
  for (const id of ['roland-jv2080', 'korg-m1', 'oberheim-matrix1000', 'roland-jp8000']) {
    const d = (await import(`../js/devices/defs/${id}.js`)).default;
    const st = fullDumpSteps(d);
    assert.equal(st.length, d.fullDump.length, `${id}: every complete-dump step resolves`);
    for (const s of st) assert.ok(s.bytes({ deviceId: 0x10, channel: 0 }).length, `${id}: ${s.label}`);
  }
});
