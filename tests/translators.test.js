// Translators of the definitions made before translators were required (Matrix-1000, M1/M1R,
// JV-2080, K2000): exact within a family, values always within each parameter's range across
// models, names carried over.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam } from '../js/core/model/memmap.js';
import { patchFromObject, objectFromPatch, loadMode } from '../js/devices/patches.js';
import { getDevice } from '../js/devices/registry.js';

const objOf = async (file, key) => {
  const def = (await import(`../js/devices/defs/${file}.js`)).default;
  return { def, obj: def.objects.find((o) => o.key === key) };
};

/** Every parameter of `obj` holds a value its range or option list allows. */
function assertInRange(obj, data, what) {
  for (const p0 of obj.params) {
    let p = p0;
    try { if (p0.dynamic) p = { ...p0, ...p0.dynamic(data, {}) }; } catch { /* needs device context */ }
    if (p.hidden && p.kind !== 'char') continue;
    const v = readParam(data, p);
    if (Array.isArray(p.options) && p.options.length && !p.readOnly) assert.ok(p.options.some(([x]) => x === v), `${what}: ${p.key} ${p.label} = ${v} is not an option`);
    else {
      if (p.min !== undefined) assert.ok(v >= p.min, `${what}: ${p.key} ${p.label} = ${v} < ${p.min}`);
      if (p.max !== undefined) assert.ok(v <= p.max, `${what}: ${p.key} ${p.label} = ${v} > ${p.max}`);
    }
  }
}

/** A JP-8080 patch with things to translate: SAW + SQUARE, sync, filter, effects, a name. */
async function jpPatch() {
  const { def, obj } = await objOf('roland-jp8080', 'patch');
  const raw = obj.init();
  raw.set([...'BA Translate    '].map((c) => c.charCodeAt(0)));
  raw[0x1e] = 5; raw[0x21] = 0; raw[0x22] = 1; raw[0x23] = 37; // SAW, SQUARE an octave up, sync
  raw[0x29] = 70; raw[0x2a] = 90; raw[0x2e] = 100; // cutoff, resonance, env depth
  raw[0x3d] = 1; raw[0x3e] = 80; raw[0x42] = 60; // chorus-ish multi-FX, delay level
  raw[0x47] = 1; // mono
  return patchFromObject(getDevice('roland-jp8080'), def, obj, raw);
}

test('Matrix-1000 patch: exact within the family, JP-8080 and back', async () => {
  const { def, obj } = await objOf('oberheim-matrix1000', 'patch');
  const e = getDevice('oberheim-matrix1000');
  const d = obj.init();
  d[9] = 12; d[14] = 19; d[19] = 0x100 - 5; d[18] = 4; d[26] = 77; d[104] = 3; d[105] = 20; d[106] = 1; // DCO 2 noise, a matrix slot
  const patch = patchFromObject(e, def, obj, d);
  assert.equal(patch.common.extra.family, 'oberheim-matrix');
  assert.equal(patch.common.osc[1].wave, 'noise');
  assert.equal(patch.common.osc[1].coarse, 7);
  assert.deepEqual(Array.from(objectFromPatch(e, def, obj, patch).data), Array.from(d), 'native: bit exact');
  // another model of the family (e.g. a Matrix-6 dump filed under its own id) restores exactly too
  const other = objectFromPatch(e, def, obj, { ...patch, device: { ...patch.device, id: 'oberheim-matrix6' } });
  assert.equal(other.mode, 'translate');
  assert.deepEqual(Array.from(other.data), Array.from(d));
  // the semantic sections alone rebuild the sound's main settings
  const sem = { ...patch.common };
  delete sem.extra;
  const back = obj.fromCommon(sem, obj.init()).data;
  for (const o of [16, 18, 20, 21, 24, 26, 27]) assert.equal(back[o], d[o], `semantic byte ${o}`);
  assert.equal(back[14] - back[9], d[14] - d[9], 'the DCO interval (DCO 1 keeps the base frequency)');

  const jp = await jpPatch();
  assert.equal(loadMode(e, def, obj, jp), 'translate');
  const r = objectFromPatch(e, def, obj, jp);
  assertInRange(obj, r.data, 'JP-8080 → Matrix-1000');
  assert.equal(obj.name(r.data), 'BA TRANS');
  assert.equal(r.data[13], 2, 'DCO 1 wave (sawtooth)');
  assert.equal(r.data[18], 1, 'DCO 2 pulse');
  assert.equal(r.data[14] - r.data[9], 12, 'DCO 2 an octave above DCO 1');
  assert.ok(r.report.approximated.some((x) => /Mono/.test(x)));
  assert.ok(r.report.dropped.some((x) => /no effects/.test(x)));
  // and the Matrix sound into a JP-8080: valid values, the waves kept
  const { def: jd, obj: jo } = await objOf('roland-jp8080', 'patch');
  const toJp = objectFromPatch(getDevice('roland-jp8080'), jd, jo, patchFromObject(e, def, obj, r.data));
  assert.equal(toJp.data[0x1e], 5, 'OSC1 SAW');
  assert.equal(toJp.data[0x21], 0, 'OSC2 SQUARE');
  assert.equal(toJp.data[0x23], 37, 'OSC2 an octave up');
});

test('M1 program and combination: exact within the family, JP-8080 patches and performances', async () => {
  const { def, obj } = await objOf('korg-m1', 'program');
  const e = getDevice('korg-m1');
  const d = obj.init();
  d[10] = 1; d[12] = 31; d[14] = 91; d[15] = 1; d[16] = 0x100 - 5; d[38] = 0; d[40] = 30; d[41] = 30; d[46] = 3; // DOUBLE Strings + Saw Wave 4' -5, Hall
  const patch = patchFromObject(e, def, obj, d);
  assert.deepEqual(patch.common.osc.map((o) => o.wave), ['rom:Strings', 'saw']);
  assert.equal(patch.common.osc[1].coarse, 7);
  assert.equal(patch.common.effects.reverb.type, 'Hall');
  assert.deepEqual(Array.from(objectFromPatch(e, def, obj, patch).data), Array.from(d), 'native: bit exact');
  // the M1R takes M1 programs natively (same definition, deviceIds)
  assert.equal(loadMode(getDevice('korg-m1r'), def, obj, patch), 'native');
  const sem = { ...patch.common };
  delete sem.extra;
  const back = obj.fromCommon(sem, obj.init());
  assertInRange(obj, back.data, 'M1 semantic');
  for (const o of [10, 12, 14, 15, 16, 38, 40, 46]) assert.equal(back.data[o], d[o], `semantic byte ${o}`);

  const jp = await jpPatch();
  assert.equal(loadMode(e, def, obj, jp), 'translate', 'a JP patch loads into an M1 program');
  const r = objectFromPatch(e, def, obj, jp);
  assertInRange(obj, r.data, 'JP-8080 → M1 program');
  assert.equal(obj.name(r.data), 'BA Transla');
  assert.equal(r.data[10], 1, 'DOUBLE');
  assert.equal(r.data[12], 91, 'OSC1 Saw Wave');
  assert.equal(r.data[14], 89, 'OSC2 SquareWave');
  assert.deepEqual([r.data[15], r.data[16]], [1, 0], "OSC2 4' (an octave up)");
  assert.ok(r.report.dropped.some((x) => /sync/.test(x)));
  assert.ok(r.report.dropped.some((x) => /resonance/.test(x)));
  // the M1 program into the JP-8080: valid, saw and square kept
  const { def: jd, obj: jo } = await objOf('roland-jp8080', 'patch');
  const mp = patchFromObject(e, def, obj, r.data);
  assert.equal(loadMode(getDevice('roland-jp8080'), jd, jo, mp), 'translate', 'an M1 program loads into a JP patch');
  const toJp = objectFromPatch(getDevice('roland-jp8080'), jd, jo, mp);
  assert.equal(toJp.data[0x1e], 5, 'OSC1 SAW');
  assert.equal(toJp.data[0x21], 0, 'OSC2 SQUARE');

  // combinations: exact, and a JP-8080 performance (upper and lower parts, dual) as LAYER
  const { obj: co } = await objOf('korg-m1', 'combination');
  const cd = co.init();
  const cp = patchFromObject(e, def, co, cd);
  assert.equal(cp.common.keyMode, 'single');
  assert.deepEqual(Array.from(objectFromPatch(e, def, co, cp).data), Array.from(cd));
  const { def: jd2, obj: jperf } = await objOf('roland-jp8080', 'performance');
  const pd = jperf.init();
  pd[0x10] = 1; // dual
  const jpp = patchFromObject(getDevice('roland-jp8080'), jd2, jperf, pd);
  assert.equal(loadMode(e, def, co, jpp), 'translate', 'a performance loads into a combination');
  const rc = objectFromPatch(e, def, co, jpp);
  assertInRange(co, rc.data, 'JP-8080 performance → M1 combination');
  assert.equal(rc.data[10], 1, 'LAYER');
  assert.ok(rc.report.approximated.some((x) => /programs/.test(x)));
});

test('JV-2080 patch, performance and rhythm set: exact within the family, other models in range', async () => {
  const { def, obj } = await objOf('roland-jv2080', 'patch');
  const e = getDevice('roland-jv2080');
  const { _test: jv } = await import('../js/devices/defs/roland-jv2080.js');
  const P = (s, l) => jv.patchBuilt.params.find((p) => p.section === s && p.label === l);
  const d = obj.init();
  const put = (s, l, v) => { d[P(s, l).offset] = v; };
  put('t0', 'Tone switch', 1); put('t0', 'Wave group ID', 2); // INT-B
  d[P('t0', 'Wave number').offset] = 1; d[P('t0', 'Wave number').offset + 1] = 13; // two nibbles: 29 = INT-B 030 "JP-8 Saw A"
  put('t0', 'Filter type', 1); put('t0', 'Cutoff frequency', 80); put('t0', 'Resonance', 30);
  put('common', 'Category', 13); // SYNTH BASS
  const patch = patchFromObject(e, def, obj, d);
  assert.equal(patch.common.osc.length, 1);
  assert.equal(patch.common.osc[0].wave, 'saw', 'INT-B JP-8 Saw A reads as a saw');
  assert.equal(patch.category.id, 'synth-bass', 'the category hook works (readParam imported)');
  assert.deepEqual(Array.from(objectFromPatch(e, def, obj, patch).data), Array.from(d), 'native: bit exact');
  const sem = { ...patch.common };
  delete sem.extra;
  const back = obj.fromCommon(sem, obj.init()).data;
  for (const l of ['Tone switch', 'Wave group ID', 'Wave number', 'Filter type', 'Cutoff frequency', 'Resonance']) assert.equal(readParam(back, P('t0', l)), readParam(d, P('t0', l)), l);
  // the internal wave names are on the Tone page's wave list now
  const wn = P('t0', 'Wave number');
  assert.match(wn.dynamic(d, {}).options[29][1], /030 JP-8 Saw A/);

  const jp = await jpPatch();
  const r = objectFromPatch(e, def, obj, jp);
  assert.equal(r.mode, 'translate');
  assertInRange(obj, r.data, 'JP-8080 → JV-2080 patch');
  assert.equal(obj.name(r.data), 'BA Translate');
  assert.deepEqual(['t0', 't1', 't2', 't3'].map((s) => readParam(r.data, P(s, 'Tone switch'))), [1, 1, 0, 0]);
  assert.equal(readParam(r.data, P('t1', 'Coarse tune')), 60, 'tone 2 an octave up');
  assert.equal(readParam(r.data, P('common', 'Key assign mode')), 1, 'SOLO');
  // a JV patch into the M1 and into the JP-8080
  const { def: md, obj: mo } = await objOf('korg-m1', 'program');
  const jvp = patchFromObject(e, def, obj, r.data);
  const toM1 = objectFromPatch(getDevice('korg-m1'), md, mo, jvp);
  assertInRange(mo, toM1.data, 'JV-2080 → M1');
  assert.equal(toM1.data[12], 91, 'saw → Saw Wave');
  // an M1 program with a ROM multisound finds the nearest JV wave
  const m1 = mo.init();
  m1[12] = 31; // Strings
  const toJv = objectFromPatch(e, def, obj, patchFromObject(getDevice('korg-m1'), md, mo, m1));
  assertInRange(obj, toJv.data, 'M1 → JV-2080');
  assert.ok(toJv.report.approximated.some((x) => /Strings →/.test(x)));

  // performance: exact; an M1 MULTI combination with 3 timbres sets parts and channels
  const { obj: po } = await objOf('roland-jv2080', 'performance');
  const pd = po.init();
  assert.deepEqual(Array.from(objectFromPatch(e, def, po, patchFromObject(e, def, po, pd)).data), Array.from(pd));
  const { obj: co } = await objOf('korg-m1', 'combination');
  const cd = co.init();
  cd[10] = 4;
  for (let t = 0; t < 3; t++) { cd[36 + t * 11 + 10] = t; cd[36 + t * 11 + 2] = t * 12; }
  const rp = objectFromPatch(e, def, po, patchFromObject(getDevice('korg-m1'), md, co, cd));
  assert.equal(rp.mode, 'translate');
  assertInRange(po, rp.data, 'M1 combination → JV-2080 performance');
  const FPm = (s, l) => readParam(rp.data, jv.perfBuilt.params.find((p) => p.section === s && p.label === l));
  assert.deepEqual([FPm('p0', 'Receive channel'), FPm('p1', 'Receive channel'), FPm('p2', 'Receive channel')], [0, 1, 2]);
  assert.equal(FPm('p1', 'Coarse tune') - 48, 12, 'timbre 2 transposed an octave (coarse tune; the part octave shift is not stored by the JV-2080)');

  // rhythm set: exact; the notes through the shared model
  const { obj: ro } = await objOf('roland-jv2080', 'rhythm');
  const rd = ro.init();
  const R = (k, l) => jv.rhythmBuilt.params.find((p) => p.section === `k${k}` && p.label === l);
  rd[R(36, 'Tone switch').offset] = 1; rd[R(36, 'Tone level').offset] = 100; rd[R(38, 'Tone switch').offset] = 1;
  const rp2 = patchFromObject(e, def, ro, rd);
  assert.deepEqual(rp2.common.notes.map((n) => n.note), [36, 38]);
  assert.deepEqual(Array.from(objectFromPatch(e, def, ro, rp2).data), Array.from(rd));
  const sem2 = { ...rp2.common };
  delete sem2.extra;
  const rb = ro.fromCommon(sem2, ro.init());
  assertInRange(ro, rb.data, 'JV rhythm semantic');
  for (const k of [36, 38]) for (const l of ['Tone switch', 'Wave number', 'Tone level', 'Source key']) assert.equal(readParam(rb.data, R(k, l)), readParam(rd, R(k, l)), `key ${k} ${l}`);
});
