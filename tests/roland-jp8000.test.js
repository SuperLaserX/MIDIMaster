import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, formatParam } from '../js/core/model/memmap.js';
import { rq1, parseDt1, intToAddr } from '../js/core/midi/roland.js';
import def, { _test as T } from '../js/devices/defs/roland-jp8000.js';

const obj = (key) => def.objects.find((o) => o.key === key);
const addr = (n) => intToAddr(n).map((b) => b.toString(16).padStart(2, '0')).join(' ');
const show = (p, d) => { const v = readParam(d, p); return p.options?.find(([x]) => x === v)?.[1] ?? formatParam(p, v); };
const P = (o, label, section) => obj(o).params.find((x) => x.label === label && (!section || x.section === section));

test('JP-8000: every byte of system, performance and patch has one named parameter', () => {
  for (const o of def.objects) {
    const seen = new Uint8Array(o.size);
    for (const p of o.params) for (let i = 0; i < (p.size || 1); i++) { assert.equal(seen[p.offset + i], 0, `${o.key} ${p.key}`); seen[p.offset + i] = 1; }
    assert.ok(seen.every(Boolean), `${o.key}: every byte covered`);
    assert.deepEqual(o.params.filter((p) => p.label.startsWith('Byte')).map((p) => p.key), [], `${o.key}: all labelled`);
  }
  assert.deepEqual(def.objects.map((o) => o.size), [0x75, 0xf0, 0x32]);
  assert.ok(!obj('performance').sections.some((s) => s.key === 'vmod'), 'no voice modulator');
});

test('JP-8000: addresses, labels and displays from its own firmware', () => {
  assert.equal(addr(T.addressOf(T.sysBuilt, 0x17)), '00 00 10 00', 'pattern loop lengths');
  assert.equal(addr(T.addressOf(T.sysBuilt, 0x4b)), '00 00 30 00', 'Tx/Rx table');
  assert.equal(addr(T.addressOf(T.perfBuilt, 0x2b + 2)), '01 00 11 02', 'lower part channel');
  assert.equal(addr(T.addressOf(T.patchBuilt, 0xef)), '01 00 41 6f');
  const d = obj('patch').init();
  const ribbon = P('patch', 'FLT CUTOFF FREQ', 'control');
  assert.equal(ribbon.group, 'Ribbon depth (per knob)');
  d[ribbon.offset] = 1; d[ribbon.offset + 1] = 12;
  assert.equal(show(ribbon, d), '+13');
  const range = P('patch', 'OSC2 RANGE');
  d[range.offset] = 0; assert.equal(show(range, d), '-WIDE');
  d[range.offset] = 37; assert.equal(show(range, d), '+12');
  const chorus = P('patch', 'Chorus Type');
  assert.equal(chorus.options.length, 12);
  assert.deepEqual(P('patch', 'OSC2 waveform').options.map(([, l]) => l), ['SQUARE', 'TRIANGLE', 'SAW']);
  assert.equal(P('patch', 'Env Type in Mono').options[1][1], 'FLOWING');
  const s = obj('system').init();
  const rc = P('system', 'Remote Ctrl CH');
  s[rc.offset] = 16; assert.equal(show(rc, s), 'ALL');
  s[rc.offset] = 17; assert.equal(show(rc, s), 'OFF');
  const loop = P('system', 'Pattern C#2 loop length');
  s[loop.offset] = 4; assert.equal(show(loop, s), '4 meas.');
  assert.equal(P('system', 'Motion A[1] loop length').max, 8);
  assert.equal(P('performance', 'Pedal Assign').options[45][1], 'RIBBON DOWN');
  assert.equal(def.motionSlots[16][1], 'FLT CUTOFF FREQ');
});

test('JP-8000: presets, simulator and requests', () => {
  assert.equal(obj('patch').slots.names(1)[0], "Spit'n Slide Bs");
  assert.equal(obj('patch').slots.names(1)[127], 'Template 2');
  assert.equal(obj('performance').slots.names(1)[0], 'Chariots');
  assert.equal(obj('patch').slots.names(0), null);
  const sim = def.simulate();
  const reply = sim.handle(rq1(T.MODEL, 0x10, intToAddr(T.A('01 00 40 00')), 0xf0));
  const got = reply.map((m) => parseDt1(Uint8Array.from(m), T.MODEL));
  assert.ok(got.every((p) => p.ok));
  assert.equal(got.reduce((n, p) => n + p.data.length, 0), 0xf0);
  assert.ok(def.pages.some((p) => p.key === 'motion'));
});

test('JP-8000: system 12h-16h, Input Quantize and the Tx/Rx CC list from its own manual and OS', () => {
  const opt = (p) => p.options.map(([, l]) => l);
  const sys = (off) => obj('system').params.find((p) => p.offset === off);
  // Roland's JP-8000 address map names them; the lists are the Initialize / Bulk Dump pages' (option lists 16, 17)
  assert.equal(sys(0x12).label, 'Factory Preset Menu');
  assert.deepEqual([opt(sys(0x12)).length, opt(sys(0x12))[0], opt(sys(0x12))[13]], [14, 'PATCH: TEMP', 'FACTORY PRESET']);
  assert.equal(sys(0x13).label, 'Bulk Dump Menu');
  assert.deepEqual([opt(sys(0x13)).length, opt(sys(0x13))[0], opt(sys(0x13))[6], opt(sys(0x13))[17]], [18, 'ALL', 'PATCH:TEMP UP&LO', 'MOTION: SET B-2']);
  assert.deepEqual(opt(sys(0x14)), ['-2 oct', '-1 oct', '0', '+1 oct', '+2 oct'], 'Keyboard Shift (system 14h 2 = 0 after FACTORY PRESET)');
  assert.deepEqual([sys(0x15).label, sys(0x16).label], ['Ribbon Relative', 'Ribbon Hold']);
  assert.ok(obj('system').params.every((p) => !p.input || p.options), 'no typed-only system values');
  // format 0Fh is the input quantize display (handler 31A18: OFF, then note glyphs)
  assert.deepEqual(opt(P('system', 'Input Quantize')), ['OFF', '1/16 triplet', '1/16', '1/8 triplet', '1/8', '1/4 triplet', '1/4']);
  // Tx/Rx CCs: option list 10 of the JP-8000 OS (OFF, CC1-31, AFTERTOUCH, CC33-95, EXCLUSIVE)
  const cut = obj('system').params.find((p) => p.offset === 0x4b + 0x10);
  assert.equal(cut.label, 'FLT CUTOFF FREQ');
  assert.deepEqual([cut.options.length, cut.options[1][1], cut.options[32][1], cut.options[96][1]], [97, 'MODULATION:CC01', 'AFTERTOUCH', 'EXCLUSIVE']);
  assert.deepEqual([P('system', 'Ribbon Up').max, P('system', 'Ribbon Down').options[95][1]], [95, 'PHASER:CC95']);
});

test('JP-8000: RPS patterns are read and written by address (08 nn 00 00) and in the complete dump', () => {
  assert.equal(addr(T.patternAddr(1)), '08 01 00 00');
  const req = def.requests.find((r) => /RPS patterns/.test(r.label));
  assert.ok(req, 'request');
  assert.equal(Array.from(req.bytes({ deviceId: 0x10 })).map((b) => b.toString(16).padStart(2, '0')).join(' '), 'f0 41 10 00 06 11 08 00 00 00 00 30 00 00 48 f7');
  assert.ok(def.fullDump.some((s) => s.request === req.label), 'complete dump step');
  const msgs = T.patternMessages(0x10, 2, new Uint8Array(500));
  assert.deepEqual(msgs.map((m) => parseDt1(Uint8Array.from(m), T.MODEL).data.length), [0xe7, 0xe7, 500 - 2 * 0xe7]);
  assert.deepEqual(def.libraryItems(msgs).map((i) => i.label), ['RPS pattern Eb2']);
  // factory pattern C#2 (OS 1.05, read from the emulated unit): 7-in-8 packed notes, then the end event
  const raw = Uint8Array.from([0x00, 0x00, 0x00, 0x21, 0x5c, 0x00, 0x0a, 0x00, 0x06, 0x00, 0x34, 0x32, 0x00, 0x04, 0x05, 0x40, 0x00, 0x00, 0x16, 0x00, 0x00]);
  const tl = T.patternTimeline(raw);
  assert.deepEqual(tl.notes, [{ tick: 0, note: 0x21, velocity: 0x5c, gate: 10 }, { tick: 0, note: 0x34, velocity: 0x32, gate: 4 }]);
  assert.equal(tl.total, 6 + 0xc0);
  assert.deepEqual(tl.end, [0xc0, 0, 0x80, 0x16, 0, 0]);
});
