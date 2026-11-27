// Roland JV-2080: rhythm sets on part 10 (presets from the flash, expansion boards), the bytes named
// from Roland's address map, wave and patch group lists limited to what can be installed, and the
// rhythm set banks against the simulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { readParam } from '../js/core/model/memmap.js';
import { parseDt1, addrToInt } from '../js/core/midi/roland.js';
import { asList } from '../js/devices/generic/objects.js';
import jv, { _test as T } from '../js/devices/defs/roland-jv2080.js';
import { PRESET_RHYTHM_SETS, FACTORY_USER_RHYTHM_SETS, BOARD_RHYTHM_SETS } from '../js/devices/defs/roland-jv2080-rhythm.js';

const obj = (key) => jv.objects.find((o) => o.key === key);
const param = (o, section, label) => o.params.find((p) => p.section === section && p.label === label);
const BOARDS = [5, 19, 97, 0, 0, 0, 0, 0]; // World (1 rhythm set), House (4), Experience III (none)

test('JV-2080 rhythm sets: presets from the flash, board sets from the board ROMs', () => {
  // decoded by tools/roland/jv2080_rhythm.py, equal to Roland's PrA-PrE rhythm dumps byte for byte
  assert.deepEqual(PRESET_RHYTHM_SETS['PR-A'], ['PopDrumSet 1', 'PopDrumSet 2']);
  assert.deepEqual(PRESET_RHYTHM_SETS['PR-D'], ['GM Drum Set ', 'BrushDrumSet']);
  assert.deepEqual(PRESET_RHYTHM_SETS['PR-E'], ['PowerDrmSet2', 'PowerRaveSet']);
  assert.deepEqual(FACTORY_USER_RHYTHM_SETS, ['HouseDrumSet', 'JazzDrumSet1']);
  // JV-80 format sets have no name: the JV-2080 names each "JV rhythm"
  assert.deepEqual(BOARD_RHYTHM_SETS[5], ['JV rhythm']);
  assert.equal(BOARD_RHYTHM_SETS[6].length, 4);
  assert.deepEqual(BOARD_RHYTHM_SETS[1], [], 'SR-JV80-01 Pop has no rhythm sets');
});

test('JV-2080 part 10 chooses rhythm sets; other parts patches from installed boards', () => {
  const perf = obj('performance');
  const ctx = { names: { rhythm: new Map([['0:0', 'My Kit 1']]) }, settings: { jvBoards: BOARDS } };
  const d = T.defaults(T.perfBuilt);
  const P = (s, l) => param(perf, s, l);
  const opts = (s, l) => P(s, l).dynamic(d, ctx).options;

  // group type: INT or EXP (PCM is a JV-1080 card)
  assert.deepEqual(opts('p9', 'Patch group type'), [[0, 'INT'], [2, 'EXP']]);
  // INT groups: USER, CARD, PR-A..PR-E; two rhythm sets each, named
  d[P('p9', 'Patch group type').offset] = 0;
  d[P('p9', 'Patch group ID').offset] = 3;
  assert.deepEqual(opts('p9', 'Patch number'), [[0, '001 PopDrumSet 1'], [1, '002 PopDrumSet 2']]);
  d[P('p9', 'Patch group ID').offset] = 1;
  assert.deepEqual(opts('p9', 'Patch number'), [[0, '001 My Kit 1'], [1, '002']], 'user sets by the names read');
  // EXP: only installed boards that hold rhythm sets
  d[P('p9', 'Patch group type').offset] = 2;
  d[P('p9', 'Patch group ID').offset] = 19;
  assert.deepEqual(opts('p9', 'Patch group ID'), [[5, 'SR-JV80-05 World (slot A)'], [19, 'SR-JV80-19 House (slot B)']]);
  assert.deepEqual(opts('p9', 'Patch number').map(([, l]) => l), ['001 JV rhythm', '002 JV rhythm', '003 JV rhythm', '004 JV rhythm']);
  // the MIDI channels page shows the set by name
  assert.ok(perf.multi.columns.find((c) => c.role === 'patch').params.includes('Patch number'));

  // a melodic part: installed boards only; a board in the data but not installed is marked
  d[P('p0', 'Patch group type').offset] = 2;
  d[P('p0', 'Patch group ID').offset] = 6;
  assert.deepEqual(opts('p0', 'Patch group ID').map(([v]) => v), [5, 6, 19, 97]);
  assert.equal(opts('p0', 'Patch group ID').find(([v]) => v === 6)[1], 'SR-JV80-06 Dance (not installed)');
  // before Find boards has run, every known board is offered
  assert.equal(P('p0', 'Patch group ID').dynamic(d, { settings: {} }).options.length, 22);
  // PCM is shown only when the data holds it
  d[P('p0', 'Patch group type').offset] = 1;
  assert.deepEqual(opts('p0', 'Patch group type').map(([v]) => v), [0, 1, 2]);
});

test('JV-2080 wave lists: INT-A/B and the installed boards', () => {
  const patch = obj('patch');
  const ctx = { settings: { jvBoards: BOARDS } };
  const d = T.defaults(T.patchBuilt);
  const tone = (l) => param(patch, 't0', l);
  d[tone('Wave group type').offset] = 2;
  d[tone('Wave group ID').offset] = 5;
  assert.deepEqual(tone('Wave group type').dynamic(d, ctx).options, [[0, 'INT'], [2, 'EXP']]);
  assert.deepEqual(tone('Wave group ID').dynamic(d, ctx).options.map(([v]) => v), [5, 19, 97]);
  const rhythm = obj('rhythm');
  const rd = T.defaults(T.rhythmBuilt);
  const key = (l) => param(rhythm, 'k36', l);
  rd[key('Wave group type').offset] = 2;
  rd[key('Wave group ID').offset] = 19;
  assert.deepEqual(key('Wave group ID').dynamic(rd, ctx).options.map(([v]) => v), [5, 19, 97]);
});

test('JV-2080 bytes named from Roland\'s address map', () => {
  const sys = obj('system');
  const perf = obj('performance');
  const S = (l) => param(sys, 'common', l);
  assert.deepEqual([S('Transmit program change').offset, S('Pedal 1 assign').offset, S('Bank select group 7 LSB').offset, S('Pedal 3 assign').offset, S('Arpeggio part number').offset],
    [0x28, 0x31, 0x51, 0x52, 0x5f]);
  assert.equal(S('Pedal 1 assign').options.find(([v]) => v === 7)[1], 'CC07');
  assert.equal(S('Pedal 3 assign').options.find(([v]) => v === 100)[1], 'START/STOP');
  assert.ok(!S('Pedal 1 assign').options.some(([v]) => v === 6 || (v >= 32 && v <= 63)), 'CC06 and CC32-63 are not assignable');
  // pedal 3 / 4 defaults come from IDs 6Dh / 70h, where the firmware keeps 52h-57h (a unit reports 7 and 11)
  assert.deepEqual([S('Pedal 3 assign').default, S('Pedal 4 assign').default], [7, 11]);
  // 60h-61h: System Tempo in two nibbles
  const tempo = S('System tempo');
  assert.deepEqual([tempo.offset, tempo.nibbles, tempo.min, tempo.max, tempo.default], [0x60, 2, 20, 250, 120]);
  assert.equal(sys.params.filter((p) => p.group === 'JV-1080 / XP-80 settings').length, 0x60 - 0x28);

  assert.equal(param(perf, 'common', 'Keyboard mode').offset, 0x40);
  const part = (l) => param(perf, 'p3', l);
  const base = part('Receive switch').offset;
  assert.deepEqual(['Octave shift', 'Local switch', 'Transmit switch', 'Transmit bank select group', 'Transmit volume', 'Output select'].map((l) => part(l).offset - base),
    [0x13, 0x14, 0x15, 0x16, 0x17, 0x19]);
  assert.ok(['Octave shift', 'Local switch', 'Transmit volume'].every((l) => part(l).readOnly), 'not stored by the JV-2080');
  const d = T.defaults(T.perfBuilt);
  assert.equal(part('Transmit volume').format(readParam(d, part('Transmit volume'))), 'OFF', 'default 128 = OFF, as a unit reports it');
  assert.deepEqual(part('Output select').options, [[0, 'A'], [1, 'B'], [2, 'C']]);
  for (const o of jv.objects) for (const p of o.params) assert.ok(!/^[0-9A-F]{2}h$/.test(p.label) && !/unknown/i.test(`${p.label} ${p.help || ''}`), `${o.key} ${p.label}`);
});

test('JV-2080 rhythm set banks against the simulator: play, edit and store', async () => {
  const t = new LoopbackTransport({ id: 'roland-jv2080', model: 'JV-2080', sysex: '41' }, jv);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const sent = [];
  const ctx = { deviceId: 0x10, channel: 0, data: {}, loaded: new Set(), names: {}, settings: { jvBoards: BOARDS } };
  const api = { g: { client: c, demo: true }, ctx, send: (out) => { for (const b of asList(out)) { sent.push(Array.from(b)); c.send(Uint8Array.from(b)); } }, toast: () => {} };
  const rhythm = obj('rhythm');
  const perf = obj('performance');
  const s = rhythm.slots;
  const banks = s.banks(ctx);
  const bank = (l) => banks.findIndex(([, x]) => x.startsWith(l));
  assert.deepEqual(banks.slice(0, 7).map(([, l]) => l), ['USER', 'PR-A', 'PR-B', 'PR-C', 'PR-D (GM)', 'PR-E', 'CARD']);
  assert.deepEqual(banks.slice(7, 10).map(([, l]) => l), ['XP-A (SR-JV80-05 World)', 'XP-B (SR-JV80-19 House)', 'XP-C (SR-JV80-97 Experience III)']);
  assert.deepEqual(['USER', 'PR-A', 'XP-A', 'XP-B', 'XP-C', 'XP-D'].map((l) => s.count(bank(l), ctx)), [2, 2, 1, 4, 0, 0]);
  assert.equal(s.names(bank('PR-B'), ctx)[1], 'RaveDrumSet');
  assert.equal(s.names(bank('USER'), ctx), null, 'user names are read');
  assert.ok(s.writable(bank('USER')) && !s.writable(bank('PR-A')));

  // the performance is read first; Edit keeps its part 10 in step
  ctx.data.system = T.defaults(T.sysBuilt);
  ctx.loaded.add('system');
  ctx.data.performance = await perf.fetch(api);
  ctx.loaded.add('performance');

  // Edit PR-B 002: performance mode, a DT1 to part 10 bytes 02-05, then 02 09 00 00
  const rd = await s.fetch(api, bank('PR-B'), 1);
  assert.equal(rhythm.name(rd).trim(), 'RaveDrumSet');
  assert.equal(t.sim.mem.get(0), 0, 'performance mode');
  const sel = sent.map((m) => parseDt1(m, [0x6a])).filter((p) => p?.ok && addrToInt(p.addr) === addrToInt([1, 0, 0x19, 2]));
  assert.deepEqual(sel.at(-1).data, [0, 4, 0, 1], 'INT, PR-B, 002');
  const part10 = (l) => readParam(ctx.data.performance, param(perf, 'p9', l));
  assert.deepEqual([part10('Patch group type'), part10('Patch group ID'), part10('Patch number')], [0, 4, 1], 'editor copy of the performance follows');

  // a board set: group type EXP, the board number as group ID
  const rb = await s.fetch(api, bank('XP-B'), 3);
  assert.equal(rhythm.name(rb).trim(), 'JV rhythm');
  assert.deepEqual([2, 3, 4, 5].map((k) => t.sim.mem.get(addrToInt([1, 0, 0x19, k]))), [2, 19, 0, 3]);
  await assert.rejects(s.fetch(api, bank('XP-D'), 0), /No expansion board/);

  // user sets: names by RQ1, Edit through part 10, Store into memory
  assert.equal((await s.fetchName(api, bank('USER'), 1)).trim(), 'User Drums 2');
  const ud = await s.fetch(api, bank('USER'), 1);
  assert.equal(rhythm.name(ud).trim(), 'User Drums 2');
  'Kit Stored  '.split('').forEach((ch, i) => { ud[i] = ch.charCodeAt(0); });
  api.send(s.store(bank('USER'), 0, ctx, ud));
  await c.drain();
  assert.equal((await s.fetchName(api, bank('USER'), 0)).trim(), 'Kit Stored');
  // recall messages for Play without waiting
  assert.deepEqual(parseDt1(s.recall(bank('PR-A'), 0, ctx).at(-1), [0x6a]).data, [0, 3, 0, 0]);
  assert.equal(s.recall(bank('XP-D'), 0, ctx), null, 'empty slot');
  c.dispose();
});

test('JV-2080 data card performances: bank select 82/0, performance numbers 32-63', () => {
  const perf = obj('performance');
  const ctx = { channel: 0, data: {}, loaded: new Set(), names: {} };
  const card = perf.slots.banks.findIndex(([, l]) => l === 'CARD');
  assert.ok(card > 0);
  assert.deepEqual(perf.slots.recall(card, 4, ctx).slice(-3), [[0xb0, 0, 82], [0xb0, 32, 0], [0xc0, 4]]);
  const sysPerf = obj('system').params.find((p) => p.label === 'Current performance');
  assert.equal(sysPerf.dynamic(T.defaults(T.sysBuilt), ctx).options[36][1], 'CARD 05');
});

test('JV-2080 performance translator: part transpose is the coarse tune', () => {
  const perf = obj('performance');
  const d = T.defaults(T.perfBuilt);
  d[param(perf, 'p2', 'Coarse tune').offset] = 48 + 7;
  const c = perf.toCommon(d);
  assert.equal(c.parts[2].transpose, 7);
  assert.equal(c.parts[9].rhythm, true);
  const back = perf.fromCommon({ ...c, extra: undefined }, T.defaults(T.perfBuilt));
  assert.equal(readParam(back.data, param(perf, 'p2', 'Coarse tune')), 55);
});

test('JV-2080 part Output assign: the unit resets Output select to A, the editor copy follows', () => {
  const perf = obj('performance');
  const d = T.defaults(T.perfBuilt);
  const out = param(perf, 'p4', 'Output assign');
  const sel = param(perf, 'p4', 'Output select');
  d[sel.offset] = 2;
  d[out.offset] = 4;
  assert.equal(out.after(d, 4, {}), null);
  assert.equal(d[sel.offset], 0);
});
