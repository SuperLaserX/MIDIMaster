// Access Virus TI Snow: the TI's single over the Snow's own host OS tables (4 parts, banks of 64, 64 multis holding
// their part singles, its output lists). Mapped from vti_snow.bin; no Snow was connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import def, * as S from '../js/devices/defs/access-virus-snow.js';
import ti, * as V from '../js/devices/defs/access-virus-ti2.js';
import * as SOS from '../js/devices/defs/access-virus-snow-os.js';
import * as TOS from '../js/devices/defs/access-virus-ti2-os.js';

const [single, multi, global] = def.objects;
const ctx = { deviceId: 0x10 };
const apiFor = (sim) => ({
  ctx,
  g: { client: { s: { timeout: 100 }, request: async (bytes, o) => {
    const replies = sim.handle(bytes) || [];
    const messages = replies.filter((m) => o.collect(null, Uint8Array.from(m))).map((m) => ({ raw: m }));
    return { messages };
  } } },
});
const text = (s) => [...s].map((c) => c.charCodeAt(0));

test('Virus TI Snow: the single is the TI\'s; the Snow\'s OS tables differ only in the output selects', () => {
  assert.equal(single.params, ti.objects[0].params);
  assert.deepEqual(SOS.SINGLE, TOS.SINGLE);
  const outs = Object.keys(SOS.PARAM).filter((k) => JSON.stringify(SOS.PARAM[k]) !== JSON.stringify(TOS.PARAM[k]));
  assert.deepEqual(outs.sort(), ['Global Settings/LED Mode', 'Global Surround/pr Output Control2', 'Global Surround/pr Output Control3', 'Multi Part Parameter/pr Output Select Control2', 'Multi Part Parameter/pr Output Select Control3']);
  assert.deepEqual(SOS.PARAM['Multi Part Parameter/pr Output Select Control2'].slice(0, 5), [863, 121, 7, 0, 11]);
  assert.deepEqual(SOS.PARAM['Global Surround/pr Output Control2'].slice(0, 5), [1089, 117, 4, 0, 18]);
  // the part output: Out 1, USB 1-3 (USB 3 greyed), stored values 0-2 and 9-17; Out 2 / Out 3 are not offered
  const out = multi.params.find((p) => p.key === 'p0_41');
  assert.deepEqual(out.options.map(([v]) => v), [0, 1, 2, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(out.options[3][1], 'USB1 L');
  const led = global.params.find((p) => /LED Mode/.test(p.help));
  assert.equal(led.options.length, 5);
});

test('Virus TI Snow: 4 parts on the MIDI channels page; parts 5-16 kept as reserved bytes', () => {
  assert.equal(multi.multi.count, 4);
  assert.equal(multi.size, S.MULTI_DATA);
  assert.equal(S.MULTI_DATA, 256 + 4 * 512);
  assert.ok(!multi.params.some((p) => p.part >= 4));
  const covered = new Set(multi.params.filter((p) => !p.bits || p.shift === 0 || p.key.endsWith('_b4')).map((p) => p.offset));
  for (let o = 0; o < 256; o++) if (!(o >= 4 && o <= 13)) assert.ok(covered.has(o) || multi.params.some((p) => p.offset === o), `multi byte ${o}`);
  assert.ok(multi.params.some((p) => p.label === 'Part 5 (page 32)' && p.readOnly));
  assert.deepEqual(single.target.options().map(([v]) => v), [0x40, 0, 1, 2, 3]);
});

test('Virus TI Snow: banks of 64 named as the screen does, SysEx banks of 128', () => {
  assert.deepEqual(single.slots.banks.map(([, l]) => l), ['RAM 1', 'RAM 2', 'RAM 3', 'RAM 4', 'RAM 5', 'RAM 6', 'RAM 7', 'RAM 8', 'ROM 1', 'ROM 2', 'ROM 3', 'ROM 4', 'ROM 5', 'ROM 6', 'ROM 7', 'ROM 8']);
  assert.equal(single.slots.count, 64);
  assert.deepEqual([S.sysexBank(1), S.sysexSlot(1, 5)], [1, 5]);
  assert.deepEqual([S.sysexBank(2), S.sysexSlot(2, 5)], [1, 69]);
  assert.deepEqual([S.sysexBank(8), S.sysexSlot(8, 63)], [4, 127]);
  assert.deepEqual([S.sysexBank(9), S.sysexSlot(9, 0)], [5, 0]);
  assert.equal(S.slotText(3, 70), 'RAM 6 07');
  assert.deepEqual(single.slots.store(4, 2, ctx, V.initSingle()).slice(5, 9), [0x10, 0x10, 2, 66]);
  assert.ok(single.slots.writable(8) && !single.slots.writable(9));
});

test('Virus TI Snow: multis hold their 4 singles: read with 34 20h+m, stored with 11 32 m and 10 20h+m pp', async () => {
  const sim = def.simulate();
  const m5 = sim.state.multis[5];
  m5.set(text('Snow Multi'), 4);
  m5.set(text('Part Three'), S.PART_SINGLES + 512 * 2 + 240);
  const api = apiFor(sim);
  const d = await multi.slots.fetch(api, 1, 5);
  assert.equal(V.multiNameOf(d), 'Snow Multi');
  assert.equal(multi.params.find((p) => p.key === 'p2_sound').dynamic(d).options[0][1], 'Part Three');
  const out = multi.slots.store(1, 7, ctx, d);
  assert.deepEqual(out.map((m) => m.slice(6, 9)), [[0x11, 0x32, 7], [0x10, 0x27, 0], [0x10, 0x27, 1], [0x10, 0x27, 2], [0x10, 0x27, 3]]);
  for (const m of out) sim.handle(m);
  assert.equal(V.multiNameOf(sim.state.multis[7]), 'Snow Multi');
  assert.equal(V.nameOf(S.partSingle(sim.state.multis[7], 2)), 'Part Three');
  // bank 1 is refused for a store, as by the OS (3791)
  sim.handle(V.msg.multi(ctx, 1, 9, d));
  assert.notEqual(V.multiNameOf(sim.state.multis[9]), 'Snow Multi');
  // the edit buffer: 34 00 -> 11 00 7F and the part singles
  sim.state.multi.set(text('Edit Multi'), 4);
  const e = await multi.fetch(api);
  assert.equal(V.multiNameOf(e), 'Edit Multi');
  const names = [];
  await multi.slots.scanBank(api, 1, (i, n) => { names[i] = n; });
  assert.equal(names.length, 64);
  assert.equal(names[5], 'Snow Multi');
});

test('Virus TI Snow: single banks, parts and refusals in the simulator; Branch Library items', async () => {
  const sim = def.simulate();
  const api = apiFor(sim);
  const got = [];
  await single.slots.scanBank(api, 2, (i, n) => { got[i] = n; });
  assert.equal(got.length, 64);
  assert.equal(got[0], 'RAM2 01');
  assert.deepEqual(sim.handle(V.msg.singleRequest(ctx, 0, 4)), []); // part 5 does not exist
  assert.deepEqual(sim.handle(V.msg.param(ctx, 0x70, 5, 40, 1)), []);
  const msgs = [...multi.toSyx(multi.init(), ctx), V.msg.single(ctx, 1, 3, V.initSingle())];
  const items = def.libraryItems(msgs.map((m) => Uint8Array.from(m)));
  assert.deepEqual(items.map((i) => [i.object, i.msgs.length]), [['multi', 5], ['single', 1]]);
  assert.equal(items[1].label, 'RAM 1 04');
  assert.ok(multi.fromSyx(items[0].msgs.map((m) => Uint8Array.from(m))));
  assert.match(def.describe(Uint8Array.from(V.msg.single(ctx, 0x22, 1, V.initSingle()))), /multi 003 part 2/);
});

test('Virus TI Snow: through the shared model (singles exact within the TI family)', () => {
  const s = V.initSingle();
  s[40] = 99;
  const c = single.toCommon(s);
  assert.equal(c.extra.model, 'access-virus-snow');
  const back = ti.objects[0].fromCommon(c, V.initSingle()).data;
  assert.deepEqual([...back], [...s]);
  const m = multi.init();
  m[32 + 16 * (34 - 32) + 2] = 9;
  const mc = multi.toCommon(m);
  assert.equal(mc.parts.length, 4);
  assert.equal(mc.parts[2].channel, 9);
  assert.deepEqual([...multi.fromCommon(mc, multi.init()).data], [...m]);
  const fromTi = multi.fromCommon(ti.objects[1].toCommon(V.initMulti()), multi.init());
  assert.ok(fromTi.report.dropped.some((x) => /parts 5-16/.test(x)));
});

test('Virus TI Snow: catalog, registry and doc', async () => {
  const { CATALOG_EXTRA } = await import('../js/devices/catalog-extra.js');
  assert.equal(CATALOG_EXTRA.find((e) => e.id === 'access-virus-snow')?.model, 'Virus TI Snow');
  assert.ok(fs.readFileSync('z:/MIDIMaster/js/devices/registry.js', 'utf8').includes("'access-virus-snow'"));
  assert.ok(fs.existsSync('z:/MIDIMaster/docs/devices/access-virus-snow.md'));
});
