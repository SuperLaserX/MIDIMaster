import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam, paramRange } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import sn2, * as SN from '../js/devices/defs/novation-supernova2.js';

const LIVE = 'z:/MIDIMaster/re/sn2/live/';
const has = (f) => { try { return fs.statSync(LIVE + f).isFile(); } catch { return false; } };
/** Split a .syx file into messages. */
function split(bytes) {
  const out = [];
  let s = -1;
  bytes.forEach((b, i) => { if (b === 0xf0) s = i; else if (b === 0xf7 && s >= 0) { out.push(Uint8Array.from(bytes.subarray(s, i + 1))); s = -1; } });
  return out;
}
const obj = (key) => sn2.objects.find((o) => o.key === key);
const ctx = { deviceId: 0x7f, channel: 15, names: {} };

/** The bits of each byte that some parameter of the list reaches (probing every value it can take). */
function coverage(params, size) {
  const seen = new Uint8Array(size);
  for (const p of params) {
    const { min, max } = paramRange(p);
    const values = p.options ? p.options.map(([v]) => v) : Array.from({ length: Math.min(256, max - min + 1) }, (_, i) => min + i);
    for (const start of [0x00, 0x7f]) {
      const base = new Uint8Array(size).fill(start);
      for (const v of values) {
        const d = Uint8Array.from(base);
        writeParam(d, p, v);
        for (let i = 0; i < size; i++) seen[i] |= (d[i] ^ base[i]) & 0x7f;
      }
    }
  }
  return seen;
}

test('SuperNova II: messages are built and recognised for every type', () => {
  assert.deepEqual(SN.msg.currentProgramRequest(ctx), [0xf0, 0, 0x20, 0x29, 1, 0x22, 0x7f, 0x03, 0xf7]);
  assert.deepEqual(SN.msg.singleRequest(ctx, 5, 3), [0xf0, 0, 0x20, 0x29, 1, 0x22, 0x7f, 0x13, 5, 3, 0xf7]);
  const prog = SN.initProgram();
  const [m00, m1e] = SN.msg.program(ctx, prog);
  assert.equal(m00.length, 296); assert.equal(m1e.length, 98);
  assert.equal(SN._test.typeOf(m00), 0x00); assert.equal(m00[8], 9);
  assert.deepEqual(Array.from(SN.programFrom(m00, m1e)), Array.from(prog));
  const [s02, s1f] = SN.msg.storeProgram(ctx, 18, 49, prog);
  assert.equal(s02.length, 297); assert.deepEqual([s02[7], s02[8], s02[9]], [0x02, 18, 49]); assert.equal(s1f[7], 0x1f);
  const perf = SN.initPerformance();
  const pm = SN.msg.performance(ctx, perf);
  assert.deepEqual(pm.map((m) => [m[7], m.length]), [[0x05, 381], [0x1b, 25], [0x20, 473]], 'lengths the receiver checks (table 65216)');
  assert.deepEqual(Array.from(SN.performanceFrom(...pm)), Array.from(perf));
  assert.deepEqual(SN.msg.storePerformance(ctx, 2, 0, perf).map((m) => [m[7], m.length]), [[0x07, 383], [0x1c, 27], [0x21, 475]]);
  const g = obj('global').init();
  assert.deepEqual(SN.msg.global(ctx, g).map((m) => [m[7], m.length]), [[0x0f, 281], [0x15, 297]]);
  assert.match(sn2.describe(s02), /Drum map a 50/);
  assert.equal(sn2.describe([0xf0, 0x41, 0xf7]), null);
});

test('SuperNova II: the unit\'s dumps decode and rebuild exactly (skipped when absent)', (t) => {
  if (!has('orig_current_prog.syx')) { t.skip('re/sn2/live not present'); return; }
  const progMsgs = split(new Uint8Array(fs.readFileSync(LIVE + 'orig_current_prog.syx')));
  const p = obj('program').fromSyx(progMsgs);
  const rebuilt = SN.msg.program({ deviceId: progMsgs[0][6] }, p, progMsgs[0][8]).map((m) => m.slice(6));
  assert.deepEqual(rebuilt, progMsgs.map((m) => Array.from(m.slice(6))), 'program 00 + 1E');
  const perfMsgs = split(new Uint8Array(fs.readFileSync(LIVE + 'orig_current_perf.syx')));
  const f = obj('performance').fromSyx(perfMsgs);
  const main = perfMsgs.filter((m) => [0x05, 0x1b, 0x20].includes(m[7]));
  assert.deepEqual(SN.msg.performance({ deviceId: main[0][6] }, f).map((m) => m.slice(6)), main.map((m) => Array.from(m.slice(6))), 'performance 05 + 1B + 20');
  const globMsgs = split(new Uint8Array(fs.readFileSync(LIVE + 'orig_global.syx')));
  const gl = obj('global').fromSyx(globMsgs);
  assert.deepEqual(obj('global').toSyx(gl, { deviceId: globMsgs[0][6] }).map((m) => m.slice(6)), globMsgs.map((m) => Array.from(m.slice(6))), 'global 0F + 15 (the map mirrored)');
  // values as the unit shows them (checked on the Rack's panel and by NRPN probes)
  const gp = (label) => obj('global').params.find((q) => q.label === label);
  const show = (label) => { const q = gp(label); const v = readParam(gl, q); return q.options ? q.options.find(([x]) => x === v)?.[1] : v; };
  assert.equal(show('Arp trans chan'), 'Off');
  assert.equal(show('Sysex transmission'), 'Single program');
  assert.equal(show('Sysex reception'), 'Normal (Rx as sent)');
  assert.equal(show('Power-up mode'), 'Performance');
  assert.equal(show('Power-up performance bank'), 'Perf bank B');
  assert.equal(show('Local control'), 'Off');
  assert.equal(show('Breath sensing'), 'Norm');
  assert.equal(show('Arp pattern editing via MIDI'), 'On');
  assert.equal(show('Sysex Tx delay'), 100);
  assert.equal(show('Gain 1'), 0);
  // the Branch Library groups a performance dump: 8 programs, then the performance
  const items = sn2.libraryItems(perfMsgs);
  assert.equal(items.filter((i) => i.object === 'program').length, 8);
  assert.equal(items.filter((i) => i.object === 'performance').length, 1);
  assert.equal(items.find((i) => i.object === 'performance').name.trim(), 'Energy Rusher!');
});

test('SuperNova II: every bit of the global messages is named', () => {
  const g = obj('global');
  const seen = coverage(g.params, g.size);
  const missing = [];
  for (let i = 0; i < 16; i++) if (seen[i] !== 0x7f) missing.push(`0F ${i}: ${(0x7f & ~seen[i]).toString(16)}`);
  for (let i = 0; i < 32; i++) if (seen[272 + i] !== 0x7f) missing.push(`15 ${i}: ${(0x7f & ~seen[272 + i]).toString(16)}`);
  for (let i = 0; i < 256; i++) if (!seen[272 + 32 + i]) missing.push(`map ${i}`); // 0F's copy is derived from it (mirrorMap)
  assert.deepEqual(missing, []);
});

test('SuperNova II: Sysex transmission/reception and breath settings as the firmware stores them', () => {
  const p = (label) => obj('global').params.find((q) => q.label === label);
  const tx = p('Sysex transmission').options;
  assert.equal(new Set(tx.map(([v]) => v)).size, 62);
  assert.deepEqual(tx[38], [0, 'Drum map a']); // NRPN 120 MSB 126 = 0
  assert.deepEqual(tx[60], [102, 'Total data']);
  assert.deepEqual(tx[14], [104, 'Program bank A']);
  const rx = p('Sysex reception').options;
  assert.deepEqual(rx[10], [80, 'All progs to Dmap a']); // NRPN 120 MSB 125 = 0
  assert.deepEqual(rx[18], [72, 'All perfs to bank A']);
  // after a global write the editor sets breath sensing and mode again (receiver bug at 1C454)
  const d = obj('global').init();
  writeParam(d, p('Breath sensing'), 8); // -3
  writeParam(d, p('Breath mode'), 2); // Mod. -
  assert.deepEqual(SN.globalRepair({ channel: 15 }, d), [[0xbf, 99, 0], [0xbf, 98, 1], [0xbf, 6, 61], [0xbf, 99, 0], [0xbf, 98, 113], [0xbf, 6, 91]]);
  writeParam(d, p('Power-up program bank'), 20);
  assert.equal(readParam(d, p('Power-up program bank')), 20, 'drum map c: 7 and the drum flag');
  assert.equal(d[11] & 15, 7); assert.ok(d[272 + 14] & 0x40);
});

test('SuperNova II: programs, performances and the global against the simulator', async () => {
  const t = new LoopbackTransport({ id: 'novation-supernova2', model: 'SuperNova II', sysex: '00 20 29' }, sn2);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const send = (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); };
  const api = { g: { client: c }, ctx, send };
  const prog = obj('program');
  const p = SN.initProgram();
  p[211] = 99;
  send(SN.msg.program(ctx, p));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await prog.fetch(api))[211], 99, 'edit buffer round trip');
  send(prog.slots.store(6, 10, ctx, p));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await prog.slots.fetch(api, 6, 10))[211], 99, 'store and read back B010');
  const names = [];
  await prog.slots.scanBank(api, 18, (i, n) => names.push([i, n]));
  assert.equal(names.length, 50, 'a drum map holds 50 sounds');
  const perf = await obj('performance').fetch(api);
  assert.equal(perf.length, SN.PERF_DATA);
  const g = await obj('global').fetch(api);
  assert.equal(g.length, 560);
});

test('SuperNova II: MIDI channels page columns exist in every part', () => {
  const f = obj('performance');
  for (let i = 0; i < 8; i++) {
    for (const col of f.multi.columns) for (const label of col.params) assert.ok(f.params.some((q) => q.section === f.multi.section(i) && q.label === label), `part ${i + 1}: ${label}`);
  }
});

test('SuperNova II: programs and performances through the shared model', async () => {
  const prog = obj('program');
  const perf = obj('performance');
  const p = SN.initProgram();
  p[211] = 80; p[221] = 30; p[22] = 1; p[194] = 5;
  const c = prog.toCommon(p);
  assert.equal(c.osc[0].wave, 'saw');
  assert.equal(c.filter.cutoff, 80 / 127);
  const same = prog.fromCommon(c, SN.initProgram());
  assert.deepEqual(Array.from(same.data), Array.from(p), 'same model: exact');
  // from another family: the semantic sections only
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jpPatch = jp.objects.find((o) => o.key === 'patch');
  const jc = jpPatch.toCommon(jpPatch.init());
  const r = prog.fromCommon(jc, SN.initProgram());
  assert.equal(r.data.length, SN.PROG_DATA);
  assert.ok(r.report.mapped.length > 10);
  assert.ok(r.data.every((b) => b <= 127));
  const back = jpPatch.fromCommon(prog.toCommon(r.data), jpPatch.init());
  assert.ok(back.data.length > 0);
  const f = SN.initPerformance();
  f[SN._test.PART(3) + 2] = 9;
  const fc = perf.toCommon(f);
  assert.equal(fc.parts[3].channel, 9);
  assert.deepEqual(Array.from(perf.fromCommon(fc, SN.initPerformance()).data), Array.from(f));
});

test('SuperNova II: arpeggio patterns (format, gates, the unit\'s edit buffer)', () => {
  const o = obj('pattern');
  const p = (label) => o.params.find((q) => q.label === label);
  const d = SN.initPattern(3);
  for (const [gate, vel, byte] of [[0, 90, 90], [1, 128, 0x80], [2, 0, 0], [3, 90, 0xda]]) {
    writeParam(d, p('Step 1 velocity'), 90);
    writeParam(d, p('Step 1 gate'), gate);
    assert.equal(readParam(d, p('Step 1 velocity')), vel, `gate ${gate}`);
    assert.equal(((d[4] & 15) << 4) | (d[5] & 15), byte, `gate ${gate} byte`);
  }
  writeParam(d, p('Step 2 note'), 9);
  assert.equal(SN.patternFixup(d)[1], 9, 'mono: highest sounding note');
  const m = SN.msg.pattern({ deviceId: 0x7f }, d);
  assert.equal(m.length, 204); assert.equal(m[7], 0x0a); assert.equal(m[8], 3);
  assert.deepEqual(Array.from(SN.patternFrom(m)), Array.from(SN.patternFixup(d)));
  assert.equal(SN.msg.storePattern({ deviceId: 0x7f }, 16, 70, d).length, 205);
  const file = 'z:/MIDIMaster/re/sn2/live/s2/pat_0d.syx';
  if (fs.existsSync(file)) {
    const raw = new Uint8Array(fs.readFileSync(file));
    const eb = SN.patternFrom(raw);
    assert.deepEqual(SN.msg.pattern({ deviceId: raw[6] }, eb).slice(6), Array.from(raw.slice(6)), 'the unit\'s edit buffer rebuilds exactly');
    assert.equal(readParam(eb, p('No of steps')), 16);
    assert.equal(GATE(readParam(eb, p('Step 1 gate'))), 'Glide');
  }
  function GATE(v) { return p('Step 1 gate').options.find(([x]) => x === v)[1]; }
});
