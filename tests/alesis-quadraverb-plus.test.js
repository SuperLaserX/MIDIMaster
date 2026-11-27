import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeParam, readParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import plus, * as P from '../js/devices/defs/alesis-quadraverb-plus.js';
import qv from '../js/devices/defs/alesis-quadraverb.js';

const eff = plus.objects.find((o) => o.key === 'effect');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const param = (key) => eff.params.find((p) => p.key === key);

test('Quadraverb Plus: v2.03 tables (eight configurations, new pages, multi-tap storage)', () => {
  assert.equal(P.FIRMWARE, 'Quadraverb Plus v2.03');
  assert.deepEqual(P.CONFIGS.slice(5), ['RING→DL→REVERB', 'RESONATOR→DL→REV', 'SAMPLING']);
  assert.equal(P.PRESETS.length, 90);
  assert.equal(P.TAP_MAP.length, 40);
  assert.deepEqual(P.SPARE, [0x7c, 0x7d, 0x7e, 0x7f]);
  const d = P.presetData(0);
  d[0x44] = 6; // RESONATOR→DL→REV
  const tune = P.locate(d, 0x4b, 1).desc;
  assert.deepEqual([tune.label, P.formatValue(tune, 0), P.formatValue(tune, 60)], ['RESONATOR 1 TUNE', '-24 SEMI TONE', '+36 SEMI TONE']);
  d[0x44] = 7; // SAMPLING: delay pages are the sampler, no reverb, pitch or modulation
  assert.equal(P.locate(d, 0x19, 1).desc.label, 'SAMPLE LENGTH');
  assert.equal(P.pageList(d, 1), null);
  assert.equal(P.pageList(d, 9), null);
  for (let n = 0; n < 90; n++) {
    const x = P.presetData(n);
    // program 84 (FLASHBACK) holds LOW MID EQ FREQ 600, above its page's 500: the unit stores dumps unchecked
    assert.equal(P.fitProgram(Uint8Array.from(x)), n === 84 ? 1 : 0, `Alesis program ${n}`);
    if (P.pageList(x, 9)) for (let k = 0; k < 8; k++) assert.ok(P.targetName(x, x[0x51 + 3 * k]), `program ${n} MOD ${k + 1} TARGET`);
  }
  for (const ds of P.DESCS) for (const v of [ds.min, ds.max]) assert.ok(P.formatValue(ds, v) && !/\?/.test(P.formatValue(ds, v)), `${ds.at} ${v}`);
});

test('Quadraverb Plus: multi-tap delay taps live in the program bytes of TAP_MAP', () => {
  const d = P.presetData(84);
  assert.equal(P.nameOf(d), '  FLASHBACK');
  const t1 = view(param('tap1_0'), d);
  assert.equal(t1.label, 'TAP 1 DELAY TIME');
  assert.equal(readParam(d, param('tap1_0')), (d[P.TAP_MAP[0]] << 8) | d[P.TAP_MAP[1]]);
  assert.equal(t1.format(329), '0329 millisecs');
  // a tap change selects the tap first (TAP NUMBER page), then sets the field
  const vol = param('tap3_2');
  const out = vol.send(70, {}, d);
  assert.equal(out.length, 2);
  const list = P.pageList(d, 2);
  assert.deepEqual(out[0].slice(5, 9), [0x01, 2, list.findIndex((id) => P.DESCS[id].off === 0x69), P.valueBytes(2)[0]]);
  assert.deepEqual(out[1].slice(5, 8), [0x01, 2, list.findIndex((id) => P.DESCS[id].off === 0x82)]);
  // no taps outside the multi-tap delay
  assert.equal(view(param('tap1_0'), P.presetData(0)).hidden, true);
});

test('Quadraverb Plus against its simulator, and telling its dumps from a Quadraverb\'s', async () => {
  const t = new LoopbackTransport({ id: 'alesis-quadraverb-plus', model: 'Quadraverb Plus', sysex: '00 00 0E' }, plus);
  const c = new DeviceClient(t, { minGap: 1, timeout: 1500 });
  const ctx = { channel: 0 };
  const d = P.presetData(84);
  await c.send(Uint8Array.from(eff.sendAll.build(d, ctx)));
  const vol = param('tap3_2');
  writeParam(d, vol, 70);
  vol.after(d); // the unit's TAP NUMBER follows the edited tap
  for (const m of vol.send(70, ctx, d)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(t.sim.state.edit[P.TAP_MAP[5 * 2 + 2]], 70);
  assert.equal(t.sim.state.edit[0x69], 2);
  const back = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.deepEqual(Array.from(back), Array.from(d));
  c.dispose();
  // a RESONATOR program can only be a Plus's
  const res = P.presetData(0); res[0x44] = 6;
  const m = [P.msg.edit(res)];
  assert.ok(plus.prefer(m) > qv.prefer(m));
});

test('Quadraverb Plus programs through the shared model (exact within the family)', () => {
  const d = P.presetData(84);
  const common = eff.toCommon(d);
  assert.deepEqual(Array.from(eff.fromCommon(common, null).data), Array.from(d));
  // a Quadraverb program is a Plus program
  const qeff = qv.objects.find((o) => o.key === 'effect');
  const q = qeff.init();
  assert.deepEqual(Array.from(eff.fromCommon(qeff.toCommon(q), null).data), Array.from(q));
  // a RESONATOR program goes to the Quadraverb through the effects only
  const res = P.presetData(0); res[0x44] = 6;
  assert.ok(qeff.fromCommon(eff.toCommon(res), null).data[0x44] < 5);
});
