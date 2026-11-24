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
