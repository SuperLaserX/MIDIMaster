import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import alpha, * as A from '../js/devices/defs/art-multiverb-alpha2.js';

const eff = alpha.objects.find((o) => o.key === 'effect');
const sys = alpha.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const param = (key) => eff.params.find((p) => p.key === key);
const visible = (d) => eff.params.filter((p) => !(p.hidden || view(p, d).hidden));
const groups = (d) => [...new Set(visible(d).map((p) => p.group))];
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const ctx = { channel: 0 };
const VECTORS = JSON.parse(fs.readFileSync(new URL('./art-multiverb-alpha2.vectors.json', import.meta.url), 'utf8')).vectors;

test('Alpha 2: effect types, configurations and LCD texts from the v2.02 tables', () => {
  assert.equal(A.TYPES.length, 28);
  assert.equal(A.CONFIGS.length, 54);
  assert.deepEqual(A.TYPES.map((t) => t.params.length), [1, 5, 5, 6, 2, 2, 1, 6, 6, 7, 5, 5, 5, 6, 6, 4, 4, 7, 7, 6, 6, 9, 4, 5, 9, 3, 7, 1]);
  assert.deepEqual(A.TYPES.slice(0, 4).map((t) => t.name), ['LOW-PASS', 'FLANGER', 'CHORUS', 'PITCH-TRANS']);
  assert.deepEqual(A.TYPES.slice(13, 19).map((t) => t.name), ["TAP'D-DDL-S", "TAP'D-DDL-L", 'REGEN-DDL-S', 'REGEN-DDL-L', 'STREO-DDL-S', 'STREO-DDL-L']);
  assert.equal(A.CONFIG_NAMES[0], 'LOW-PASS > STREO-DDL-L > FLANGER > PANNER');
  assert.equal(A.CONFIG_NAMES[53], 'LOW-PASS > STREO-DDL-S > DUAL PTr');
  assert.ok(A.CONFIGS.every((c) => c[0] === 0 && c.reduce((n, t) => n + A.sizeOf(t), 0) <= A.FX_SIZE));
  const tx = (t, i) => A.textsOf(t, i);
  assert.deepEqual([tx(0, 0)[0], tx(0, 0).at(-1)], ['630Hz', 'THRU']);
  assert.deepEqual([tx(9, 0)[0], tx(9, 0).at(-1), tx(9, 2)[0], tx(9, 2).at(-1)], ['HALL-3', 'OFF', '0.1s', '25.0s']);
  assert.deepEqual([A.labelOf(9, 1), tx(9, 1)], ['IN', ['PRE DDL', 'POST DDL']], 'INVERT shows as the reverb input');
  assert.deepEqual(tx(1, 0).slice(0, 3), ['FLANGER OFF', 'POST REVERB', 'POST, INV L']);
  assert.deepEqual([tx(26, 0)[0], tx(26, 0)[6], tx(26, 0)[12], A.labelOf(26, 4)], ['-15dB', '0dB', '+15dB', '1.6KHz']);
  assert.deepEqual([tx(27, 0)[0], tx(27, 0)[1], tx(27, 0).at(-1)], ['OFF', 'DEAD ROOM', 'OPEN AMBNCE']);
  assert.deepEqual([tx(18, 0).at(-1), tx(16, 0).at(-1), tx(13, 2).at(-1), tx(13, 0).at(-1)], ['1.30s', '1.10s', '960ms', 'SLOPE3s']);
  assert.deepEqual([tx(3, 1)[0], tx(3, 2)[0], tx(3, 2).at(-1), tx(3, 3)[0], A.labelOf(3, 3)], ['-12', '-4.00', '+4.00', 'OFF', 'BASE KEY']);
  assert.deepEqual([tx(22, 1).slice(0, 3), tx(22, 1).at(-1), tx(25, 0).at(-1)], [['OFF', 'E  82', 'A 110'], 'AUTO', '100%']);
  // the tuner's reference notes follow its TYPE (32DC)
  const tn = A.initEdit(46);
  tn[A.E.present] = 3;
  tn[A.fxOffset(46, 22, 0)] = 0;
  assert.deepEqual(A.textsOf(22, 1, tn).slice(0, 3), ['OFF', 'B  31', 'E  41']);
  assert.equal(view(param('t22p1'), tn).options[1][1], 'B  31');
  assert.deepEqual([A.UTIL.bypassLevel.values.at(-1), A.UTIL.remote1.values[2], A.UTIL.remote2.values[3], A.UTIL.autoPm.values[2]], ['MIX DRY LEVEL', 'INCR PROGS   2', 'DECR PROGS', 'ALWAYS DISPLAYED']);
  assert.deepEqual([A.UTIL.channel.values[0], A.UTIL.channel.values[16], A.UTIL.lock.values, A.UTIL.pm.values], ['OFF', '16', ['UNLOCKED', 'LOCKED'], ['OFF', 'ON']]);
  assert.deepEqual([A.UTIL.prog.values, A.UTIL.fxEnable.values, A.UTIL.omni.values], [['OFF', 'ON'], ['OFF', 'ON'], ['OFF', 'ON']]);
  assert.deepEqual([A.CTRL[4], A.CTRL[64], A.CTRL[124], A.CTRL[127], A.CTRL[128]], ['MC  4:FOOT CTLR.', 'MC 64:DAMPER PED', 'NOTE ON VELOCITY', 'PITCH BEND WHEEL', 'OFF']);
  assert.deepEqual([A.X15[0], A.X15[4], A.X15[10]], ['#0 BYPASS', '#4 EQUALIZER', '#10 SPECL FX']);
  assert.deepEqual([A.PM_TITLES.param, A.PM_TITLES.controller, A.PM_TITLES.none], ['#1 IS CONTROLING', '#1 CONTROLLER IS', 'MIDI DataMONITOR']);
  assert.equal(A.FACTORY.length, 115);
  assert.deepEqual([A.FACTORY_TITLES[0], A.FACTORY_TITLES[99], A.FACTORY_TITLES[114]], ['OPEN CHAMBER REV', ' '.repeat(16), 'ORIENTAL SWEEP  ']);
  // the descriptors' "off" values: the reverb goes silent while X-15 switch #6 is off
  assert.deepEqual([A.TYPES[9].params[6].off, A.TYPES[9].params[6].x15, A.TYPES[25].params[0].off], [0, 6, 0x80]);
});

test('Alpha 2 packed presets: the firmware\'s own packing (6CDB) and recall (6A38), from the emulator', () => {
  assert.equal(VECTORS.length, 115 + 1 + 54);
  for (const v of VECTORS) {
    const p = hex(v.packed);
    const what = v.n !== undefined ? `preset ${v.n + 1}` : `configuration ${v.cfg}`;
    assert.deepEqual(Array.from(A.unpack(p)), Array.from(hex(v.expanded)), `${what} recalls`);
    assert.deepEqual(Array.from(A.pack(hex(v.source || v.expanded))), Array.from(p), `${what} packs`);
    assert.equal(A.packedLength(p), p.length);
    assert.ok(p.length >= 22 && p.length <= 80);
  }
  assert.deepEqual(Array.from(A.factoryEdit(0)), Array.from(hex(VECTORS[0].expanded)));
  const e = A.emptyEdit();
  assert.ok(A.isEmptyPreset(e));
  assert.equal(A.nameOf(e), '');
  assert.equal(A.summary(e), '<no effects>');
  assert.equal(A.summary(A.factoryEdit(0)), '4 EQL+AES+LPF+REV');
  assert.equal(A.nameOf(A.factoryEdit(0)), 'OPEN CHAMBER REV');
  for (let n = 0; n < 115; n++) assert.equal(A.fitEdit(A.factoryEdit(n)), 0, `factory preset ${n + 1} in range`);
});

test('Alpha 2 messages: header, pairs, presets, all presets, recall', () => {
  const d = A.factoryEdit(3);
  const m = A.msg.edit(d, { channel: 4 });
  assert.deepEqual(m.slice(0, 5), [0xf0, 0x1a, 4, 0x11, 0x05]);
  assert.equal(m.length, 202);
  assert.deepEqual(A.msg.recall(150, ctx), [0xf0, 0x1a, 0, 0x11, 0x09, 0x16, 0x01, 0xf7]);
  assert.deepEqual(A.msg.recallFactory(5, ctx), [0xf0, 0x1a, 0, 0x11, 0x09, 0x05, 0x40, 0xf7]);
  assert.deepEqual(A.msg.presetRom(199, ctx), [0xf0, 0x1a, 0, 0x11, 0x06, 0x47, 0x01, 0x02, 0x47, 0x01, 0xf7], 'manual: preset 200 is 47h 01h');
  assert.deepEqual(A.msg.setting(A.S.bypass, 1, ctx), [0xf0, 0x1a, 0, 0x11, 0x03, 0x00, 0x01, 0xf7], 'Set Bypass ON');
  const pk = A.pack(d);
  const one = A.presetFrom(Uint8Array.from(A.msg.preset(130, pk, ctx)));
  assert.equal(one.n, 130);
  assert.deepEqual(Array.from(one.packed), Array.from(pk));
  assert.equal(A.presetFrom(Uint8Array.from(A.msg.presetRom(7, ctx))).rom, true);
  const list = Array(200).fill(null);
  list[120] = pk;
  const all = A.presetsFrom(Uint8Array.from(A.msg.all(list, ctx)));
  assert.equal(all.length, 200);
  assert.deepEqual([all[0].rom, all[199].rom, Array.from(all[120].packed)], [true, true, Array.from(pk)]);
  // an empty preset from 116 on is written as "empty" (02), anything else packed
  assert.equal(A.storeMessage(130, A.emptyEdit(), ctx)[7], 2);
  assert.equal(A.storeMessage(130, d, ctx)[7], pk.length);
  assert.match(alpha.describe(Uint8Array.from(A.msg.preset(130, pk, ctx))), /preset 131 "AMBIENT TALK REV"/);
  assert.match(alpha.describe(Uint8Array.from(A.msg.getSetting(0x20, ctx))), /request MIDI CHANNEL/);
  assert.ok(alpha.isRequest(Uint8Array.from(A.msg.getAll(ctx))) && !alpha.isRequest(Uint8Array.from(m)));
});

test('Alpha 2 preset editor: chain, effects in use, configuration changes, Performance MIDI', () => {
  const d = A.factoryEdit(0); // OPEN CHAMBER REV: LOW-PASS > REGEN-DDL-S > REVERB-3, the delay not in use
  assert.equal(A.cfgOf(d), 27);
  assert.deepEqual(groups(d), ['Chain', 'X-15 FX ON/OFF', 'MIX', 'EQUALIZER', 'A.E.S.', 'LOW-PASS', 'REVERB-3',
    'PERFORMANCE MIDI #1', 'PERFORMANCE MIDI #2', 'PERFORMANCE MIDI #3', 'PERFORMANCE MIDI #4', 'PERFORMANCE MIDI #5', 'PERFORMANCE MIDI #6', 'PERFORMANCE MIDI #7', 'PERFORMANCE MIDI #8', 'PERFORMANCE MIDI runtime']);
  assert.deepEqual(['use0', 'use1', 'use2', 'use3'].map((k) => view(param(k), d).hidden ? null : view(param(k), d).label), ['LOW-PASS in the preset', 'REGEN-DDL-S in the preset', 'REVERB-3 in the preset', null]);
  // the reverb's DECAY follows the configuration's layout (byte 15 + 1 + 4 + 2)
  const decay = param('t9p2');
  assert.equal(decay.label, 'DECAY');
  assert.equal(readParam(d, decay), d[22]);
  assert.equal(view(decay, d).options.find(([v]) => v === readParam(d, decay))[1], '2.4s');
  // ADD EFFECT: the delay comes in with its defaults and X-15 switch #7 DELAY on
  d[19] = 99;
  writeParam(d, param('use1'), 1);
  assert.equal(readParam(d, param('t15p0')), A.TYPES[15].params[0].def);
  assert.equal(readParam(d, param('x15_7')), 1);
  assert.ok(groups(d).includes('REGEN-DDL-S'));
  // REVERB-3 is only in configuration 27: another chain drops it with the assignment on its LEVEL
  assert.equal(A.paramList(27)[d[A.E.pm + 3] - 1].t, 9);
  assert.equal(view(param('pm0l'), d).options.find(([v]) => v === readParam(d, param('pm0l')))[1], '40%');
  const ddl = readParam(d, param('t15p2'));
  writeParam(d, param('config'), 28); // LOW-PASS > REGEN-DDL-S > GATE-VERB-3
  assert.ok(A.inUse(d, 12) && A.inUse(d, 15) && !A.inUse(d, 9));
  assert.equal(readParam(d, param('t15p2')), ddl);
  assert.equal(readParam(d, param('t12p2')), A.TYPES[12].params[2].def);
  assert.equal(d[A.E.pmUsed] & 1, 0);
  // FLANGER moves from byte 26 (configuration 9) to 20 (configuration 21): its values and assignment follow
  const g = A.initEdit(9);
  g[A.E.present] = 0x1f;
  writeParam(g, param('t1p1'), 7);
  writeParam(g, param('pm0'), 1);
  const speed = A.paramList(9).find((p) => p.t === 1 && p.i === 2).n;
  writeParam(g, param('pm0p'), speed);
  assert.equal(A.fxOffset(9, 1, 1), 27);
  writeParam(g, param('config'), 21);
  assert.equal(A.fxOffset(21, 1, 1), 21);
  assert.deepEqual([g[21], readParam(g, param('t1p1'))], [7, 7]);
  assert.equal(g[A.E.pm + 3], A.paramList(21).find((p) => p.t === 1 && p.i === 2).n);
  assert.match(view(param('pm0p'), g).options.find(([v]) => v === g[A.E.pm + 3])[1], /FLA:SPEED/);
  assert.ok(A.inUse(g, 11), 'GATE-VERB-2 comes in');
  // choosing another parameter opens LOW / HIGH to its range (1195)
  writeParam(d, param('pm0'), 1);
  const p1 = param('pm0p');
  writeParam(d, p1, 1);
  assert.deepEqual([d[A.E.pm + 1], d[A.E.pm + 2]], [0, 31]);
  assert.equal(view(param('pm0h'), d).options.at(-1)[1], '100%');
  // a new assignment: MC 4 on the first parameter in use, its full range (1158)
  writeParam(d, param('pm1'), 1);
  assert.deepEqual(Array.from(d.slice(A.E.pm + 6, A.E.pm + 12)), [4, 0, 31, 1, d[4], 0xff]);
  // DELETE EFFECT takes the assignments on its parameters with it
  writeParam(d, param('pm2'), 1);
  writeParam(d, param('pm2p'), A.paramList(28).find((p) => p.t === 12).n);
  writeParam(d, param('use2'), 0);
  assert.equal((d[A.E.pmUsed] >> 2) & 1, 0);
  assert.deepEqual(Array.from(d.slice(A.E.pm + 12, A.E.pm + 18)), [4, 0, 0x7f, 0, 0, 0xff]);
  // sending sets each assignment's recalled value as the unit expects for STORE (6AEE)
  const sent = A.prepare(d);
  assert.equal(sent[A.E.pm + 6 + 4], sent[4]);
  A.setName(d, 'My Alpha Preset!!');
  assert.equal(eff.name(d), 'My Alpha Preset!');
  // every visible parameter of every factory preset shows a text for its value
  for (let n = 0; n < 115; n++) {
    const f = A.factoryEdit(n);
    for (const p of visible(f)) {
      const v = view(p, f);
      if (v.readOnly) continue;
      const x = readParam(f, v);
      assert.ok(v.options?.some(([o]) => o === x), `preset ${n + 1} ${p.key} = ${x}`);
    }
  }
});

test('Alpha 2 against its simulator: edit buffer, presets, store, settings', async () => {
  const t = new LoopbackTransport({ id: 'art-multiverb-alpha2', model: 'Multiverb Alpha 2', sysex: '1A' }, alpha);
  const c = new DeviceClient(t, { minGap: 1, timeout: 800 });
  const sim = t.sim.state;
  const api = {
    ctx,
    data: null,
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const d = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.equal(A.nameOf(d), 'OPEN CHAMBER REV');
  // a live edit sends the whole edit buffer
  const lvl = param('t9p6');
  writeParam(d, lvl, 40);
  await c.send(Uint8Array.from(lvl.send(40, ctx, d)));
  await c.drain();
  assert.equal(readParam(sim.edit, lvl), 40);
  // Store as preset: 05 then 0A
  api.data = d;
  api.form = async () => ({ n: '150' });
  await eff.actions[0].run(api);
  await c.drain();
  assert.equal(A.nameOf(A.unpack(sim.presets[149])), 'OPEN CHAMBER REV');
  assert.equal(readParam(A.unpack(sim.presets[149]), lvl), 40);
  // a preset written packed (06) and read back (46)
  const f = A.factoryEdit(20);
  await c.send(Uint8Array.from(eff.slots.store(0, 160, ctx, f)));
  await c.drain();
  assert.deepEqual(Array.from(await eff.slots.fetch(api, 0, 160)), Array.from(f));
  assert.deepEqual(Array.from(await eff.slots.fetch(api, 0, 7)), Array.from(A.factoryEdit(7)), 'a factory preset in ROM');
  assert.equal(A.nameOf(await eff.slots.fetch(api, 0, 170)), '', 'empty from 116 on');
  // names of all 200 presets from one 4B request
  const names = [];
  await eff.slots.scanBank(api, 0, (i, s) => { names[i] = s; });
  assert.deepEqual([names[0], names[149], names[160], names[199]], ['OPEN CHAMBER REV', 'OPEN CHAMBER REV', 'DEEP GATED SNARE', '']);
  // recall
  await c.send(Uint8Array.from(eff.slots.recall(0, 160, ctx)[0]));
  await c.drain();
  assert.equal(sim.sys[A.SYS.current], 160);
  // settings: every 43 request, the store status and the program table
  sim.sys[A.S.bypassLevel] = 32;
  sim.sys[A.SYS.map + 5] = 120;
  const s = await sys.fetch(api);
  assert.equal(s[A.S.bypassLevel], 32);
  assert.equal(s[A.SYS.map + 5], 120);
  assert.equal(s[A.SYS.current], 160);
  assert.equal(view(sys.params.find((p) => p.key === 'version'), s).format(readParam(s, sys.params.find((p) => p.key === 'version'))), 'v2.02');
  const omni = sys.params.find((p) => p.key === 'omni');
  writeParam(s, omni, 0);
  await c.send(Uint8Array.from(omni.send(0, ctx, s)));
  const map9 = sys.params.find((p) => p.key === 'map9');
  await c.send(Uint8Array.from(map9.send(199, ctx, s)));
  await c.drain();
  assert.deepEqual([sim.sys[A.S.omni], sim.sys[A.SYS.map + 9]], [0, 199]);
  // SysEx on another channel is ignored
  await c.send(Uint8Array.from(A.msg.setting(A.S.omni, 1, { channel: 3 })));
  await c.drain();
  assert.equal(sim.sys[A.S.omni], 0);
  c.dispose();
});

test('Alpha 2: library items, complete dump steps and the shared model', () => {
  const sim = A._test.simulate();
  sim.state.presets[130] = A.pack(A.factoryEdit(5));
  const out = [
    ...sim.handle(Uint8Array.from(A.msg.getAll(ctx))),
    ...sim.handle(Uint8Array.from(A.msg.getMap(ctx))),
    ...A.SETTINGS.flatMap((k) => sim.handle(Uint8Array.from(A.msg.getSetting(k, ctx)))),
    ...sim.handle(Uint8Array.from(A.msg.getEdit(ctx))),
  ].map((m) => Uint8Array.from(m));
  assert.ok(out.every((m) => alpha.recognise(m)));
  const items = alpha.libraryItems(out);
  const presets = items.filter((x) => x.object === 'effect' && x.label.startsWith('Preset'));
  assert.equal(presets.length, 200);
  assert.equal(presets[130].name, A.FACTORY_TITLES[5].trim());
  assert.equal(presets[0].name, 'OPEN CHAMBER REV');
  const s = items.find((x) => x.object === 'system');
  assert.equal(s.msgs.length, 1 + A.SETTINGS.length - 1);
  assert.ok(items.some((x) => x.label === 'Edit buffer'));
  assert.equal(alpha.fullDump.find((x) => x.request === 'Settings').expect, A.SETTINGS.length + 2);
  // translator: exact within the family; other effects to a configuration that has them
  for (let n = 0; n < 115; n += 9) {
    const d = A.prepare(A.factoryEdit(n));
    assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), null).data), Array.from(d));
  }
  const c = eff.toCommon(A.factoryEdit(0));
  assert.deepEqual([c.kind, c.effects.reverb.type, c.extra.family], ['effect', 'HALL', 'art-multiverb']);
  const r = eff.fromCommon({ model: 1, kind: 'effect', effects: { reverb: { type: 'Plate', time: 0.2, level: 1 }, delay: { time: 0.2, feedback: 0.5, level: 0.5 }, chorus: { type: 'Chorus', rate: 0.3, depth: 0.5, level: 1 } } }, null);
  const cfg = A.cfgOf(r.data);
  assert.match(A.CONFIG_NAMES[cfg], /REGEN-DDL-S > REVERB-1 > CHORUS/);
  assert.deepEqual(A.CONFIGS[cfg].filter((t) => A.inUse(r.data, t)), [15, 7, 2], 'the delay, reverb and chorus; LOW-PASS and PANNER left out');
  const rv = A.CONFIGS[cfg].find((t) => t >= 7 && t <= 9);
  assert.match(A.valueText(rv, 0, r.data[A.fxOffset(cfg, rv, 0)]), /PLATE/);
  assert.equal(A.fitEdit(Uint8Array.from(r.data)), 0);
});

test('Alpha 2: registry, catalog and doc', () => {
  assert.ok(fs.readFileSync(new URL('../js/devices/registry.js', import.meta.url), 'utf8').includes("'art-multiverb-alpha2'"));
  assert.ok(fs.readFileSync(new URL('../js/devices/catalog-data.js', import.meta.url), 'utf8').includes('"id": "art-multiverb-alpha2"'));
  const doc = fs.readFileSync(new URL('../docs/devices/art-multiverb-alpha2.md', import.meta.url), 'utf8');
  assert.match(doc, /not checked on hardware/i);
  assert.equal(sys.params.filter((p) => p.section === 'map').length, 128);
});
