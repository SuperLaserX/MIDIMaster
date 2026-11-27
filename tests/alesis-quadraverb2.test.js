import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import qv2, * as E from '../js/devices/defs/alesis-quadraverb2.js';

const prog = qv2.objects.find((o) => o.key === 'effect');
const sys = qv2.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (obj, d) => obj.params.filter((p) => !(p.hidden || view(p, d).hidden));
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const byKey = (obj, k) => obj.params.find((p) => p.key === k);
const texts = (pg) => E.pageValues(pg).texts;
const page = (cfg, label) => E.typeOf(cfg).pages.find((p) => p.label === label);

test('Quadraverb 2: block types, pages and presets from the v2.01e tables', () => {
  assert.equal(E.TYPES.length, 53);
  assert.deepEqual([1, 2, 3, 4].map((f) => E.TYPES.filter((t) => t.f === f).length), [19, 13, 7, 14]);
  assert.deepEqual(['LOWPASS FILTER', 'MONO CHORUS', 'MONO DELAY', 'MONO ROOM'].map((n, i) => E.TYPES.find((t) => t.cfg === (i + 1) << 5).name), ['LOWPASS FILTER', 'MONO CHORUS', 'MONO DELAY', 'MONO ROOM']);
  // a type's block data: one byte per page, two for 16-bit pages (pack routine 74C3)
  for (const t of E.TYPES) {
    assert.equal(Math.max(...t.pages.map((p) => p.off + (p.w ? 2 : 1))), t.size, t.name);
    assert.equal(t.def.length, 2 * t.size, t.name);
    for (const pg of t.pages) if (!pg.stub && !pg.raw) assert.equal(texts(pg).length, E.pageValues(pg).raws.length, `${t.name} ${pg.label}`);
  }
  const lr = E.typeOf(0x8a);
  assert.deepEqual([lr.name, lr.size], ['LARGE ROOM', 18]);
  assert.deepEqual(lr.pages.slice(0, 6).map((p) => p.label), ['DECAY', 'DAMPING HI', 'LO', 'DENSITY', 'DIFFUSION', 'INPUT HIGH FREQ ROLL OFF']);
  const roll = page(0x8a, 'INPUT HIGH FREQ ROLL OFF');
  assert.deepEqual([roll.off, roll.w, roll.step, texts(roll)[0], texts(roll).at(-1)], [5, 1, 50, '200Hz', '20000Hz']);
  assert.deepEqual([texts(page(0x8a, 'DECAY'))[0], texts(page(0x8a, 'DECAY')).at(-1)], ['2.10s', '32.3s']);
  assert.deepEqual(texts(page(0x8a, 'GATE TRIG')), ['OFF', 'LEFT', 'RIGHT', 'L&R']);
  const gain = E.typeOf(0x28).pages.find((p) => p.mod === 'BANDPASS GAIN');
  assert.deepEqual([gain.min, gain.max, texts(gain)[0], texts(gain).at(-1)], [-140, 140, '-14.0dB', '+14.0dB']);
  const dly = E.typeOf(0x60);
  assert.deepEqual(dly.pages.map((p) => [p.label, p.mod ?? null]), [['DELAY', 'DELAY TIME'], ['DELAY (2)', null], ['FEEDBACK', 'FEEDBACK']]);
  assert.deepEqual([texts(dly.pages[0])[0], texts(dly.pages[0]).at(-1), texts(dly.pages[1])[4]], ['0.1mS', '5000.0mS', '1/4']);
  // the trigger types: bytes 0 / 1 have no page, only a MOD target name
  assert.deepEqual(E.typeOf(0x31).pages.filter((p) => p.stub).map((p) => [p.off, p.mod]), [[0, 'PANNING TRIGGER 1'], [1, 'PANNING TRIGGER 2']]);
  // stereo outputs: LEFT / RIGHT route sources
  assert.deepEqual([E.typeOf(0x8a).outs, E.typeOf(0x40).outs], [['INMIX', 'MIX', 'LEFT', 'RIGHT'], ['INMIX', 'MIX', 'MIX', 'MIX']]);
  assert.equal(E.PRESETS.length, 100);
  assert.deepEqual([E.PRESET_NAMES[0], E.PRESET_NAMES[3], E.PRESET_NAMES[99]], ['Concert Hall', 'Rich Delays', '*** Bypass ***']);
  assert.deepEqual([E.MOD_SOURCES.length, E.MOD_SOURCES[0], E.MOD_SOURCES[129]], [130, 'PITCH BEND', 'LOCAL GENERATOR 2']);
  assert.deepEqual([E.ROUTE_LEVELS.length, E.ROUTE_LEVELS[0], E.ROUTE_LEVELS[58]], [59, 'OFF', '+0.0dB']);
  assert.deepEqual(E.GENS.map((g) => g.name), ['ENVELOPE', 'PEAK FOLLOWER', 'RAMP', 'LOW FREQ. OSCILLATOR', 'FOOTSWITCH']);
});

test('Quadraverb 2 programs: layout, routes, SysEx codecs as the firmware checked them', () => {
  const d = E.presetData(3);
  const lay = E.layout(d);
  assert.deepEqual(lay.blocks.map((b) => [b.k, b.type.name, b.off]), [[0, 'MONO CHORUS', 92], [1, 'PLATE   1', 97], [2, 'PLATE   1', 112], [3, 'MONO DELAY', 127], [4, 'MONO DELAY', 131]]);
  const rs = E.readRoutes(d);
  assert.equal(rs.length, 14);
  const name = (r) => `${E.sourceName(d, r.cell % 34)} -> ${E.destName(d, Math.floor(r.cell / 34))} ${E.ROUTE_LEVELS[r.level]}`;
  assert.deepEqual([name(rs[0]), name(rs[8])], ['INPUT LEFT -> PCH 1 -9.5dB', 'RVB 2 LEFT -> OUT L -3.0dB']);
  const w = Uint8Array.from(d);
  E.writeRoutes(w, rs);
  assert.deepEqual(Array.from(w), Array.from(d));
  // 7-bit stream: the global dump the firmware sent, a program round trip
  assert.equal(Buffer.from(E.unpack7(E.CHECKS.globalMsg.slice(6, -1), 14)).toString('hex'), E.CHECKS.global);
  const m = E.programMessage(E.EDIT_BUFFER, d);
  assert.equal(m.length, 301);
  assert.deepEqual(m.slice(0, 7), [0xf0, 0, 0, 0x0e, 0x0f, 0x02, 0x64]);
  assert.deepEqual(Array.from(E.parseProgram(m).data), Array.from(d));
  assert.deepEqual(E.programMessage(105, d).slice(5, 7), [0x0c, 5]);
  assert.deepEqual(E.requestMessage(105), [0xf0, 0, 0, 0x0e, 0x0f, 0x0d, 5, 0xf7]);
  // the page value message the firmware applied (DECAY of block 1 to 7)
  assert.deepEqual(E.editMessage(0, 1, 1, 1, 7), E.CHECKS.edit01);
  assert.equal(E.CHECKS.edit01Result, 7);
  // what CONFIG does to a program: every case the firmware took, byte for byte
  let n = 0;
  for (const c of E.CHECKS.config) {
    const b = hex(c.before);
    const a = hex(c.after);
    if (b[E.P.cfg + c.block] === a[E.P.cfg + c.block] && c.cfg !== b[E.P.cfg + c.block]) continue; // refused (DSP)
    assert.deepEqual(Array.from(E.setBlockTypes(b, { [c.block]: c.cfg })), Array.from(a), `${c.preset} ${c.block} ${c.cfg}`);
    n++;
  }
  assert.equal(n, 8);
});

test('Quadraverb 2 parameters: blocks, pages, MODs, routes, name, globals', () => {
  const d = E.presetData(3);
  const vis = visible(prog, d).map((p) => view(p, d).label);
  assert.ok(vis.includes('PCH 1: MONO CHORUS'));
  assert.ok(vis.includes('SPEED'));
  assert.ok(!visible(prog, d).some((p) => p.key === 'b5p0'));
  // a block page reads and writes its bytes in the block's data
  const sp = byKey(prog, 'b0p0');
  assert.equal(view(sp, d).label, 'SPEED');
  assert.equal(readParam(d, sp), 0x24);
  writeParam(d, sp, 50);
  assert.equal(d[92], 50);
  assert.deepEqual(sp.send(50, {}, d), E.editMessage(0, 1, 1, 1, 50));
  // 16-bit page: PLATE 1 INPUT HIGH FREQ ROLL OFF of block 2
  const i = E.typeOf(0x83).pages.findIndex((p) => p.label === 'INPUT HIGH FREQ ROLL OFF');
  const roll = byKey(prog, `b1p${i}`);
  writeParam(d, roll, 5000);
  assert.deepEqual([d[97 + 5], d[97 + 6]], [0x13, 0x88]);
  // a type change through the parameter moves the following blocks
  const cfg = byKey(prog, 'b0cfg');
  writeParam(d, cfg, 0x41);
  assert.equal(E.layout(d).blocks[1].off, 98);
  assert.equal(E.readRoutes(d).length, 14);
  // MOD target lists follow the blocks and routes
  const tg = E.modTargets(d, 2).map(([, s]) => s);
  assert.equal(tg[0], 'DECAY');
  assert.ok(tg.includes('PCH 1 MIX LEVEL'));
  assert.equal(E.modTargets(d, 11).at(-1)[1], 'MSTR EFFECT LEVEL');
  // routes: delete, add
  const r0 = byKey(prog, 'r0c');
  writeParam(d, r0, 0xffff);
  assert.equal(E.readRoutes(d).length, 13);
  const add = byKey(prog, 'r13c');
  assert.ok(!view(add, d).hidden);
  writeParam(d, add, E.cellOf(9, 0));
  assert.equal(E.readRoutes(d).length, 14);
  assert.equal(E.readRoutes(d)[0].cell, 0x301 - 0x300);
  // name
  E.setName(d, 'Edited');
  assert.equal(prog.name(d), 'Edited');
  // globals: footswitch range (9 bits split over two bytes), the program table
  const s = sys.init();
  const fs = sys.params.find((p) => p.key === 'gl1');
  assert.equal(readParam(s, fs), 0);
  writeParam(s, fs, 260);
  assert.deepEqual([s[1], s[13] & 1], [4, 1]);
  writeParam(s, byKey(sys, 't5'), 205);
  const t = E.tableMessage(s);
  assert.deepEqual(t.slice(0, 6), E.CHECKS.tableMsg.slice(0, 6));
  assert.deepEqual(t.slice(6 + 10, 6 + 12), [205 & 0x7f, 1]); // low 7 bits, then bit 8 << 1 | bit 7
  const back = sys.receive(Uint8Array.from(t), sys.init());
  assert.equal(readParam(back, byKey(sys, 't5')), 205);
  assert.deepEqual(Array.from(sys.receive(Uint8Array.from(E.globalsMessage(s)), sys.init()).slice(0, 14)), Array.from(s.slice(0, 14)));
});

test('Quadraverb 2 against its simulator: requests, stores, page values, globals', async () => {
  const t = new LoopbackTransport({ id: 'alesis-quadraverb2', model: 'Quadraverb 2', sysex: '00 00 0E' }, qv2);
  const c = new DeviceClient(t, { minGap: 1, timeout: 800 });
  const sim = t.sim;
  const got = await c.request(Uint8Array.from(prog.request()), { match: (_m, r) => prog.match(r) });
  assert.equal(E.nameOf(prog.decode(got.raw)), 'Concert Hall');
  const d = E.presetData(4);
  E.setName(d, 'STORED');
  for (const m of prog.slots.store(1, 7, {}, d)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(E.nameOf(sim.state.users[107]), 'STORED');
  const back = await c.request(Uint8Array.from(E.requestMessage(107)), { match: (_m, r) => E.parseProgram(r)?.n === 107 });
  assert.equal(E.nameOf(E.parseProgram(back.raw).data), 'STORED');
  // a page value goes into the edit buffer
  await c.send(Uint8Array.from(byKey(prog, 'b0p0').send(9, {}, sim.state.edit)));
  await c.drain();
  assert.equal(sim.state.edit[92], 9);
  await c.send(Uint8Array.from(byKey(prog, 'lv1').send(40, {}, sim.state.edit)));
  await c.drain();
  assert.equal(sim.state.edit[E.P.levels + 1], 40);
  // globals
  const g = await c.request(Uint8Array.from([...E.HEAD, 0x08, 0xf7]), { match: (_m, r) => E.isQv2(r) && r[5] === 0x07 });
  assert.equal(sys.receive(g.raw, sys.init())[0], 6);
});

test('Quadraverb 2 translator, monitor and library', () => {
  const d = E.presetData(48);
  const c = prog.toCommon(d);
  assert.equal(c.kind, 'effect');
  assert.ok(c.effects.reverb && c.effects.delay);
  assert.deepEqual(Array.from(prog.fromCommon(c).data), Array.from(d));
  const f = prog.fromCommon({ effects: { reverb: { type: 'HALL', time: 0.5, level: 1 } } });
  assert.ok(E.layout(f.data).blocks.some((b) => b.type.f === 4));
  assert.ok(f.report.approximated.length > 0);
  const m = E.programMessage(3, d);
  assert.match(qv2.describe(m), /User 0-03/);
  const items = qv2.libraryItems([Uint8Array.from(m), Uint8Array.from(E.globalsMessage(sys.init()))]);
  assert.deepEqual(items.map((x) => x.object), ['effect', 'system']);
});
