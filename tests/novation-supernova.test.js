import { test } from 'node:test';
import assert from 'node:assert/strict';

import sn1, * as S1 from '../js/devices/defs/novation-supernova.js';
import * as SN2 from '../js/devices/defs/novation-supernova2.js';
import { sn1ToSn2Program, sn2ToSn1Program } from '../js/devices/defs/novation-supernova2-translate.js';
import { readParam, writeParam } from '../js/core/model/memmap.js';

const obj = (k) => sn1.objects.find((o) => o.key === k);
const param = (o, label, section) => obj(o).params.find((p) => p.label === label && (!section || p.section === section));

test('SuperNova: model 20 messages with the lengths of its OS 4.1 table (36A7C)', () => {
  const ctx = { deviceId: 0x7f };
  assert.equal(S1.msg.program(ctx, obj('program').init()).length, 296);
  assert.equal(S1.msg.storeProgram(ctx, 5, 1, obj('program').init()).length, 297);
  assert.deepEqual(S1.msg.performance(ctx, obj('performance').init()).map((m) => m.length), [381], 'no vocoder message (1B) on the SuperNova');
  assert.deepEqual(S1.msg.storePerformance(ctx, 1, 1, obj('performance').init()).map((m) => m.length), [383]);
  const g = S1.msg.global(ctx, obj('global').init());
  assert.deepEqual(g.map((m) => [m[7], m.length]), [[0x0f, 281], [0x15, 297]]);
  assert.equal(g[1][8], 0x21, 'message 15 starts with 21h (transmitter 1591E)');
  const m = S1.msg.program(ctx, obj('program').init());
  assert.equal(m[5], 0x20);
  assert.equal(obj('program').fromSyx([m]).length, 286);
  for (const k of ['program', 'performance', 'global']) assert.ok(obj(k).params.every((p) => p.offset < obj(k).size), k);
  const f = obj('performance');
  for (let i = 0; i < 8; i++) for (const c of f.multi.columns) for (const l of c.params) assert.ok(f.params.some((p) => p.section === `part${i}` && p.label === l), `${i} ${l}`);
  assert.deepEqual(obj('program').slots.banks.map((b) => b[0]), [5, 6, 7, 8, 9, 10, 11, 12], 'A-H: the Sysex lists name banks E-H');
});

test('SuperNova: OS 4.1 menus give the labels and lists (not the SuperNova II ones)', () => {
  const d = obj('program').init();
  const fw = param('program', 'Filter width');
  assert.equal(fw.offset, 209);
  assert.equal(fw.bits, 3);
  assert.ok(!fw.readOnly, 'the real filter width on OS 4.1 (the SuperNova II derives this byte)');
  writeParam(d, fw, 5);
  assert.equal(d[209] & 7, 5);
  assert.equal(param('program', 'DCO / VCO mode').shift, 3);
  const chorus = param('program', 'Type', 'fx');
  assert.ok(obj('program').params.some((p) => p.offset === 275 && p.label === 'Type' && p.options[0][1] === 'Quad chorus'));
  assert.ok(chorus);
  assert.ok(param('program', 'Soften level'), 'Soften (SuperNova II: Harden)');
  assert.ok(!param('program', 'Harden level'));
  assert.equal(param('program', 'Category').options.at(-1)[1], 'User 5');
  assert.deepEqual(param('program', 'Fill in').options.map((o) => o[0]), [122, 123, 124, 125, 126, 127]);
  assert.ok(obj('program').params.filter((p) => p.offset === 16).every((p) => p.readOnly), 'byte 16: no OS 4.1 setter (NRPN 102)');
  assert.ok(!obj('program').params.some((p) => /Spare/.test(p.group)));
  // the global: no SuperNova II-only settings
  const labels = obj('global').params.map((p) => p.label);
  for (const l of ['Input/sw 1', 'Gain 1', 'Sysex Tx delay', 'Button clicks', 'Sample rate', 'Pedal mode', 'Trim1']) assert.ok(!labels.includes(l), l);
  assert.deepEqual(param('global', 'MIDI clock').options.map((o) => o[1]), ['Int', 'Ext']);
  const tx = param('global', 'Sysex transmission').options.map((o) => o[0]);
  assert.equal(tx.length, 40);
  assert.ok(tx.every((v) => v >= 88 && v <= 127));
  assert.equal(readParam(obj('global').init(), param('global', 'Sysex transmission')), 102, 'factory: Total data');
});

test('SuperNova: programs convert to and from the SuperNova II as its receiver does (1DE84)', () => {
  const old = obj('program').init();
  old[22] = 1; old[22 + 19] = 10; old[210] = 100; old[236] = 120; old[216] = 0; old[217] = 127; old[259] = 0; old[254] = 64;
  const n = sn1ToSn2Program(old);
  assert.equal(n[22 + 19], 64, 'saw: width centred');
  assert.equal(n[210], 41); assert.equal(n[236], 60); assert.equal(n[216], 0); assert.equal(n[217], 127); assert.equal(n[259], 6);
  assert.deepEqual(Array.from(sn2ToSn1Program(n)).filter((_, i) => [210, 216, 217].includes(i)), [100, 0, 127]);
  // through the shared model: SuperNova -> SuperNova II applies the conversion
  const c = obj('program').toCommon(old);
  const p2 = SN2.default.objects.find((o) => o.key === 'program');
  const r = p2.fromCommon(c, SN2.initProgram());
  assert.equal(r.data[210], 41);
  const back = obj('program').fromCommon(p2.toCommon(r.data), obj('program').init());
  assert.equal(back.data.length, 286);
  assert.deepEqual(Array.from(obj('program').fromCommon(c, obj('program').init()).data), Array.from(old), 'same model: exact');
});
