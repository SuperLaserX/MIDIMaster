import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import ifx, * as I from '../js/devices/defs/rocktron-intellifex.js';

const eff = ifx.objects.find((o) => o.key === 'effect');
const sys = ifx.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const visible = (obj, d) => obj.params.filter((p) => !(p.hidden || view(p, d).hidden));
const byLabel = (d, group, label) => visible(eff, d).find((p) => p.group === group && p.label === label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Intellifex LTD: configurations, pages and display texts from the v1.0 tables', () => {
  assert.deepEqual(I.CONFIGS.map((c) => c.name), ['HUSH>CHORUS>DLY>REV', 'HUSH>PSHIFT>DLY>REV', 'HUSH>REVERB', 'HUSH>DELAY>DUCKER', 'HUSH>8V-CHORUS>DLY', 'HUSH>PSHIFT>DELAY']);
  // 320F lists; their lengths are the PARA maxima + 1 (3209: 28 21 11 16 30 1C)
  assert.deepEqual(I.CONFIGS.map((c) => c.params.length), [41, 34, 18, 23, 49, 29]);
  assert.deepEqual(I.CONFIGS.map((_, c) => I.paraMax(c)), [0x28, 0x21, 0x11, 0x16, 0x30, 0x1c]);
  assert.deepEqual(I.CONFIGS[2].blocks.map((b) => b.title), ['MIXER', 'HUSH', 'REVERB']);
  assert.deepEqual(I.CONFIGS[0].blocks.at(-1).pages.map((p) => I.PAGES[p].label), ['REV INPUT', 'DIRIN PAN', 'MIX DIR', 'REVERB LVL', 'REVERB DECAY', 'RV HF DAMP']);
  const P = I.PAGES;
  assert.deepEqual([P[0x02].texts[0], P[0x02].texts[19], P[0x02].texts.at(-1), P[0x06].texts.at(-1)], ['-oo', '-13.5', '+ 6.0', '0.0']);
  assert.deepEqual(P[0x37].texts, ['PLATE A', 'PLATE B', 'ROOM A', 'ROOM B', 'HALL A', 'HALL B', 'STADIUM', 'DUAL']);
  assert.deepEqual(P[0x23].texts, ['STEREO', 'PING-PONG', '2-TAP']);
  assert.deepEqual([P[0x0f].label, P[0x0f].texts[0], P[0x0f].texts[50], P[0x0f].texts[100]], ['PAN 1', 'L< 0 R', 'L<50>R', 'L100>R']);
  assert.deepEqual([P[0x1d].texts.at(-1), I.TWO_TAP_TIMES.at(-1), P[0x40].texts.at(-1), P[0x39].texts.at(-1)], ['750MS', '1500MS', '418MS', '209MS']);
  assert.deepEqual([P[0x2e].texts[0], P[0x2e].texts[120], P[0x2e].texts.at(-1), P[0x26].texts[0], P[0x0b].texts.at(-1)], ['-2400', '00', '+1200', '.2', '800MS']);
  assert.equal(P[0x12].texts, null, 'RATE shows the plain number');
  assert.equal(P[0x12].count, 255);
  assert.deepEqual(I.UTIL.midiChannel.slice(-3), ['16', 'OMNI', 'OFF']);
  assert.deepEqual([I.UTIL.numb[120], I.UTIL.numb[121], I.UTIL.mapTo[160], I.UTIL.footswitch[1]], ['120', 'OFF', 'OFF', 'MOMNTARY']);
  assert.equal(I.ROM_NAMES.length, 80);
  assert.deepEqual([I.ROM_NAMES[0], I.ROM_NAMES[79]], [' CRS PAN VERB', ' BYPASS      ']);
  for (let n = 0; n < 80; n++) assert.equal(I.fitPreset(I.factoryPreset(n)), 0, `factory preset ${81 + n}`);
  assert.equal(I.configOf(I.factoryPreset(79)), 0, '160 BYPASS (configuration 14) loads as 0');
});

test('Intellifex messages: 7+1-bit pairs, XOR checksum, user data sequence', () => {
  const d = I.factoryPreset(2);
  const m = I.presetMessage(d);
  assert.deepEqual(m.slice(0, 6), [0xf0, 0x00, 0x00, 0x29, 0x02, 0x28]);
  assert.equal(m.length, 6 + 200 + 2);
  const u = I.unpack(m);
  assert.ok(u.ok);
  assert.deepEqual(Array.from(u.data), Array.from(d));
  const bad = Uint8Array.from(m);
  bad[10] ^= 1;
  assert.equal(I.unpack(bad).ok, false);
  // a byte with bit 7 set travels as (low 7 bits, 1)
  assert.deepEqual(I.message(0x2b, [0xa0]), [0xf0, 0, 0, 0x29, 0x02, 0x2b, 0x20, 0x01, 0x21, 0xf7]);
  const s = I.restoredUserData(10);
  const msgs = I.userDataMessages(s);
  assert.equal(msgs.length, 82);
  assert.deepEqual(msgs.map((x) => x[5]).slice(0, 3), [0x2a, 0x2b, 0x2b]);
  assert.deepEqual(msgs.slice(-2).map((x) => x.length), [6 + 256 + 2, 6 + 12 + 2]);
  assert.deepEqual(Array.from(I.userDataFrom(msgs)), Array.from(s));
  assert.equal(I.userDataFrom(msgs.slice(1)), null, 'must start with 2Ah');
  assert.deepEqual(Array.from(s.subarray(0, 6)), [0x0a, 1, 0, 0, 0, 0]);
  assert.equal(s[I.MAP_AT + 30], 0x6e, 'code 10 maps program 31 to preset 111');
  assert.deepEqual(Array.from(I.restoredUserData(249).subarray(0, 6)), [0x17, 0, 0, 0, 0, 16]);
  assert.match(ifx.describe(m), /PRESET DUMP: preset "STADIUM" \(HUSH>REVERB\)/);
  assert.match(ifx.describe(Uint8Array.from(msgs[81])), /USER DATA: globals/);
});

test('Intellifex preset editor: pages per configuration, D TYPE times, controller assignments', () => {
  const d = I.factoryPreset(3); // SPARE CHANGE: HUSH>DELAY>DUCKER
  assert.equal(I.configOf(d), 3);
  assert.deepEqual([...new Set(visible(eff, d).map((p) => p.group))], ['Preset', 'MIXER', 'HUSH', 'DELAY', 'DUCKER', 'CONTROLLER ASSIG']);
  const time = byLabel(d, 'DELAY', 'DLY TIME1');
  const type = byLabel(d, 'DELAY', 'D TYPE');
  writeParam(d, type, 0);
  writeParam(d, time, 150);
  assert.equal(view(time, d).format(150), '750MS');
  writeParam(d, type, 2);
  assert.equal(view(time, d).format(150), '1500MS');
  assert.equal(time.offset, I.byteOf(3, 0x1d));
  // PARA picks one of the configuration's parameters; the unit then opens ULIM / LLIM to its range
  const para = eff.params.find((p) => p.key === 'ctrl0p');
  assert.equal(view(para, d).options.length, 23);
  writeParam(d, para, I.CONFIGS[3].params.indexOf(0x1d));
  assert.match(para.after(d), /ULIM C1/);
  assert.deepEqual([d[I.CTRL_AT + 2], d[I.CTRL_AT + 3]], [150, 0]);
  const ulim = eff.params.find((p) => p.key === 'ctrl0u');
  assert.equal(view(ulim, d).options.length, 151);
  assert.equal(view(eff.params.find((p) => p.key === 'ctrl0n'), d).options.at(-1)[1], 'OFF');
  // configuration change: values the new configuration cannot hold go to 0, as the unit loads them
  const cfg = eff.params.find((p) => p.key === 'config');
  writeParam(d, cfg, 2);
  cfg.after(d);
  assert.equal(I.fitPreset(Uint8Array.from(d)), 0);
  assert.deepEqual([...new Set(visible(eff, d).map((p) => p.group))], ['Preset', 'MIXER', 'HUSH', 'REVERB', 'CONTROLLER ASSIG']);
  I.setName(d, 'my verb');
  assert.equal(I.titleOf(d), ' MY VERB     ');
  assert.equal(eff.name(d), 'MY VERB');
  // every visible page of every factory preset shows a text for its value
  for (let n = 0; n < 80; n++) {
    const f = I.factoryPreset(n);
    for (const p of visible(eff, f)) {
      const v = view(p, f);
      const x = readParam(f, v);
      const t = v.options ? v.options.find(([o]) => o === x)?.[1] : v.format ? v.format(x) : String(x);
      assert.ok(t !== undefined && !/\?/.test(t), `${n} ${p.key} ${x}`);
    }
  }
});

test('Intellifex against its simulator: PRESET LOAD, LOAD USER DATA, panel dumps into the editor', async () => {
  const t = new LoopbackTransport({ id: 'rocktron-intellifex', model: 'Intellifex', sysex: '00 00 29' }, ifx);
  const c = new DeviceClient(t, { minGap: 1, timeout: 600 });
  const sim = t.sim;
  const api = { g: { transport: t }, toast: () => {} };
  // PRESET LOAD stores into the preset chosen on the unit
  sim.state.presetTarget = 5;
  const d = I.factoryPreset(10);
  I.setName(d, 'SENT');
  await c.send(Uint8Array.from(eff.slots.store(0, 5, {}, d)));
  await c.drain();
  assert.equal(I.nameOf(I.userPreset(sim.state.user, 5)), 'SENT');
  // the unit refuses a preset while another page is shown
  sim.state.loadPage = 'LOAD USER DATA';
  I.setName(d, 'REFUSED');
  await c.send(Uint8Array.from(I.presetMessage(d)));
  await c.drain();
  assert.equal(I.nameOf(I.userPreset(sim.state.user, 5)), 'SENT');
  // the whole user data
  const s = I.restoredUserData(10);
  s[I.G.channel] = 3;
  for (const m of I.userDataMessages(s)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.deepEqual(Array.from(sim.state.user), Array.from(s));
  // PRESET DUMP and DUMP USER DATA from the panel reach the editor's listeners
  const got = eff.fetch(api);
  await sleep(5);
  for (const m of sim.panel('PRESET DUMP', 5)) t._reply(m, 1);
  assert.equal(I.nameOf(await got), I.nameOf(I.userPreset(s, 5)));
  const all = sys.fetch(api);
  await sleep(5);
  sim.panel('DUMP USER DATA').forEach((m, i) => t._reply(m, 1 + i));
  assert.deepEqual(Array.from(await all), Array.from(s));
  // receive: a preset the unit sends on its own replaces the editor's
  assert.equal(I.nameOf(eff.receive(Uint8Array.from(sim.panel('PRESET DUMP', 0)[0]))), I.nameOf(I.userPreset(s, 0)));
  let cur = I.restoredUserData(249);
  for (const m of sim.panel('DUMP USER DATA')) cur = sys.receive(Uint8Array.from(m), cur) || cur;
  assert.deepEqual(Array.from(cur), Array.from(s));
  // the Branch Library splits a dump into the 80 presets and the user data
  const items = ifx.libraryItems(sim.panel('DUMP USER DATA').map((m) => Uint8Array.from(m)));
  assert.equal(items.filter((x) => x.object === 'effect').length, 80);
  assert.equal(items.at(-1).object, 'system');
  assert.equal(items.at(-1).msgs.length, 82);
  assert.equal(items[0].msgs[0][5], 0x28, 'a preset alone is sent through PRESET LOAD');
  assert.equal(ifx.isRequest(items[0].msgs[0]), false);
  // program change follows PROG MAPPING (code 10: ON, channel 1 -> MIDI CHANNL 3 = channel 4 here)
  await c.send(Uint8Array.from([0xc3, 30]));
  await c.drain();
  assert.equal(sim.state.current, 0x6e);
  c.dispose();
});

test('Intellifex translator: exact within the family, effects to the configuration that has them', () => {
  for (let n = 0; n < 80; n += 7) {
    const d = I.factoryPreset(n);
    const back = eff.fromCommon(eff.toCommon(d), null);
    assert.deepEqual(Array.from(back.data), Array.from(d));
  }
  const rv = eff.fromCommon({ model: 1, kind: 'effect', effects: { reverb: { type: 'Large Hall', time: 0.5, preDelay: 0.25, level: 0.5 } } }, I.factoryPreset(0));
  assert.equal(I.configOf(rv.data), 2);
  assert.equal(I.formatValue(0x37, I.valueOf(rv.data, 0x37), rv.data), 'HALL A');
  assert.equal(I.valueOf(rv.data, 0x2a), 50);
  assert.equal(I.formatValue(0x39, I.valueOf(rv.data, 0x39), rv.data), '52MS');
  assert.equal(I.formatValue(0x32, I.valueOf(rv.data, 0x32), rv.data), '- 6.0');
  assert.equal(I.nameOf(rv.data), 'CRS PAN VERB', 'keeps the title of the preset it replaces');
  const dl = eff.fromCommon({ model: 1, kind: 'effect', effects: { delay: { time: 0.25, feedback: 0.5, level: 1 } } }, null);
  assert.equal(I.configOf(dl.data), 3);
  assert.equal(I.formatValue(0x1d, I.valueOf(dl.data, 0x1d), dl.data), '375MS');
  assert.equal(I._test.pickConfig({ chorus: { level: 1 } }), 4);
  assert.equal(I._test.pickConfig({ chorus: { level: 1 }, reverb: { level: 1 } }), 0);
  assert.equal(I._test.pickConfig({ modulation: { type: 'PITCH SHIFT', level: 1 } }), 5);
  assert.equal(I._test.pickConfig({}), -1);
  const c = eff.toCommon(I.factoryPreset(2));
  assert.deepEqual([c.kind, c.effects.reverb.type, c.extra.family], ['effect', 'STADIUM', 'rocktron-intellifex']);
});

test('Intellifex: registry, catalog and doc', () => {
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/registry.js', 'utf8').includes("'rocktron-intellifex'"));
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/catalog-data.js', 'utf8').includes('"id": "rocktron-intellifex"'));
  const doc = fs.readFileSync('z:/MIDIMaster/docs/devices/rocktron-intellifex.md', 'utf8');
  assert.match(doc, /not checked on hardware/i);
  assert.equal(sys.params.filter((p) => p.key.startsWith('map')).length, 129);
  assert.ok(ifx.objects.every((o) => o.notLive));
  assert.equal(ifx.panelDump.expect, 82);
});
