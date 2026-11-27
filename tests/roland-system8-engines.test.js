// Roland SYSTEM-8 PLUG-OUT engine editors: one definition per engine, pages and lists from each region 0 image,
// the OS's effects / step sequencer shared, slot read / store in the simulator, the unit's own PLUG-OUT patches
// (backup), translators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { getDevice } from '../js/devices/registry.js';
import { ENGINE_IDS } from '../js/devices/defs/roland-system8-engines.js';
import * as MEM from '../js/devices/defs/roland-system8-mem.js';

const load = async (id) => (await import(`../js/devices/defs/${id}.js`)).default;
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
function inRange(obj, d, what) {
  for (const p0 of obj.params) {
    if (p0.kind === 'char') continue;
    const p = view(p0, d);
    const v = readParam(d, p);
    if (p.options) assert.ok(p.options.some(([x]) => x === v), `${what}: ${p.key} ${p.label} = ${v} is not an option`);
    else assert.ok(v >= p.min && v <= p.max, `${what}: ${p.key} ${p.label} = ${v} outside ${p.min}..${p.max}`);
  }
}
function simClient(sim) {
  return {
    request: (bytes, opts) => new Promise((resolve) => {
      const got = [];
      for (const r of sim.handle(Array.from(bytes)) || []) if (opts.collect({}, r)) { got.push(r); if (opts.complete?.(got)) break; }
      resolve({ messages: got });
    }),
  };
}

test('every PLUG-OUT engine: in the catalog, an editor with its own pages, init values in range, unique keys', async () => {
  assert.equal(Object.keys(ENGINE_IDS).length, 9);
  for (const id of Object.values(ENGINE_IDS)) {
    assert.ok(getDevice(id), `${id} in the catalog`);
    const def = await load(id);
    const o = def.objects[0];
    const d = o.init();
    assert.equal(d.length, MEM.FULL_SIZE);
    assert.equal(new Set(o.params.map((p) => p.key)).size, o.params.length, `${id}: unique keys`);
    inRange(o, d, id);
    assert.ok(o.toCommon && o.fromCommon, `${id}: translator`);
    assert.equal(o.needs, 'sysex');
  }
});

test('JUPITER-8: region 0 labels and lists (VCO MODULATOR page, PWM Source, Sub Range, Assign Mode)', async () => {
  const o = (await load(ENGINE_IDS['JUPITER-8'])).objects[0];
  const P = (k) => o.params.find((p) => p.key === k);
  assert.equal(P('vco_pwm_source').group, 'VCO MODULATOR');
  assert.equal(P('vco_pwm_source').label, 'PWM Source');
  assert.deepEqual(P('vco_pwm_source').options.map(([, t]) => t), ['MAN', 'LFO', 'ENV1+', 'ENV1-', 'ENV2+', 'ENV2-']);
  assert.equal(P('vco2_sub_range').format(36), '0');
  assert.equal(P('vco2_sub_range').format(0), '-36');
  assert.deepEqual(P('assign_mode').options.map(([, t]) => t), ['POLY1', 'MONO', 'UNISON', 'POLY2']);
  assert.equal(P('vco1_range').options[3][1], '8FEET');
});

test('engine patches: slot read and store in the simulator, temporary edits, translator exact', async () => {
  const def = await load(ENGINE_IDS['JUNO-106']);
  const o = def.objects[0];
  const sim = def.simulate();
  const api = { g: { client: simClient(sim) }, ctx: { deviceId: 0x10, channel: 0 } };
  const d = o.init();
  o.setName(d, 'Juno Test');
  const cut = o.params.find((p) => p.offset === MEM.S_PATCH.compact(58));
  writeParam(d, cut, 99);
  for (const m of o.slots.store(3, 12, api.ctx, d)) sim.handle(m);
  const back = await o.slots.fetch(api, 3, 12);
  assert.deepEqual(Array.from(back), Array.from(d));
  assert.equal(await o.slots.fetchName(api, 3, 12), 'Juno Test');
  const msg = o.sendParam(cut, 99, d, {});
  assert.deepEqual(msg.slice(7, 11), [0x03, 0x00, 0x00, 0x3a]);
  const c = o.toCommon(d);
  assert.equal(c.extra.model, 'JUNO-106');
  assert.deepEqual(Array.from(o.fromCommon(c, o.init()).data), Array.from(d));
  const sem = o.fromCommon({ ...c, extra: undefined }, o.init()).data;
  assert.equal(readParam(sem, cut), 99, 'cutoff through the shared model');
});

test('the unit\'s own PLUG-OUT patches (backup, slots 1-3) decode within every engine parameter\'s range', async () => {
  const dir = 're/system8/backup/20261126-initial';
  if (!fs.existsSync(`${dir}/slot1.syx`)) return;
  for (const [slot, engine] of [[1, 'JUPITER-8'], [2, 'SH-101'], [3, 'JUNO-106']]) {
    const def = await load(ENGINE_IDS[engine]);
    const raw = fs.readFileSync(`${dir}/slot${slot}.syx`);
    const msgs = []; let s = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] === 0xf7) { msgs.push(raw.subarray(s, i + 1)); s = i + 1; }
    const items = def.libraryItems(msgs);
    assert.equal(items.length, 64, engine);
    for (const it of items) inRange(def.objects[0], it.data, `${engine} ${it.label} ${it.name}`);
  }
});
