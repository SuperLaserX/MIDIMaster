import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readParam, writeParam } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import se, * as A from '../js/devices/defs/art-multiverb-alpha2-se.js';
import alpha2, * as A2 from '../js/devices/defs/art-multiverb-alpha2.js';

const eff = se.objects.find((o) => o.key === 'effect');
const sys = se.objects.find((o) => o.key === 'system');
const view = (p, d) => (p.dynamic ? { ...p, ...p.dynamic(d, {}) } : p);
const param = (key) => eff.params.find((p) => p.key === key);
const visible = (d) => eff.params.filter((p) => !(p.hidden || view(p, d).hidden));
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const ctx = { channel: 0 };
const VECTORS = JSON.parse(fs.readFileSync(new URL('./art-multiverb-alpha2-se.vectors.json', import.meta.url), 'utf8')).vectors;

test('Alpha 2 SE: tables from the v1.03 image, what differs from the Alpha 2', () => {
  assert.match(A.FIRMWARE, /Alpha 2 SE v1\.03/);
  assert.equal(A.TYPES.length, 28);
  assert.deepEqual(A.CONFIGS, A2.CONFIGS, 'the same 54 configurations');
  assert.deepEqual(A.BROKEN, []);
  // TUNER TYPE has four values and REFRNC four note lists
  assert.deepEqual(A.textsOf(22, 0), ['BASS', 'GUITAR', 'BASS12F', 'GTR 12F']);
  assert.equal(A.TEXTS[22][1].length, 4);
  const tn = A.initEdit(46);
  tn[A.E.present] = 3;
  for (const [ty, first] of [[0, 'B  31'], [1, 'E  82'], [2, 'B  62'], [3, 'E 164']]) {
    tn[A.fxOffset(46, 22, 0)] = ty;
    assert.equal(A.textsOf(22, 1, tn)[1], first, `TYPE ${ty}`);
    assert.equal(view(param('t22p1'), tn).options[1][1], first);
  }
  // REGEN-DDL-L DELAY reaches further, PHASER moved to X-15 switch #9 FLNG/CHOR
  assert.deepEqual([A.TYPES[16].params[0].max, A2.TYPES[16].params[0].max], [125, 122]);
  assert.deepEqual([A.TYPES[23].params[0].x15, A2.TYPES[23].params[0].x15], [9, 10]);
  assert.equal(A.textsOf(16, 0).at(-1), A.valueText(16, 0, 125));
  // the four ROM banks
  assert.deepEqual(A.BANKS.map((b) => [b.name, b.presets.length]), [['CLASSIC', 112], ['STUDIO', 103], ['PERFORMANCE', 103], ['PRODUCTION', 86]]);
  assert.equal(A.N_FACTORY, 112);
  assert.equal(A.UTIL.lock.title, 'PRESET 1..112');
  assert.deepEqual(A.BANK_UTIL, { title: 'BANK', values: ['A "CLASSIC"', 'B "STUDIO"', 'C "PERFORMANCE"', 'D "PRODUCTION"'] });
  assert.deepEqual(A.PAGES.utility.slice(0, 3), ['SLOT', 'BANK', 'BYPASS LEVEL']);
  assert.deepEqual([A.SLOT_PAGE.ram[0], A.SLOT_PAGE.open[0], A.SLOT_PAGE.bank2[0], A.SLOT_PAGE.bank4[0]], ['USER RAM (U)', 'OPEN', 'BANK B, #  6', 'BANK   4, #  6']);
  assert.deepEqual([A.slotText(null), A.slotText({ h: 0, l: 3 }), A.slotText({ h: 2, l: 5 }), A.slotText({ h: 4, l: 5 })], ['USER RAM (U)', 'OPEN', 'BANK B, #  6', 'BANK   4, #  6']);
  assert.equal(A.DEFAULT_BANK, 0, 'v1.03 resets to bank A');
  assert.match(A.UTIL.version, /Alpha 2 SE\s+1\.03/);
  assert.deepEqual([A.UTIL.bypassLevel.values[31], A.UTIL.lcdAngle.values.length], ['100%', 8]);
});

test('Alpha 2 SE packed presets: the firmware\'s bit fields (6C27) and recall (7062), from the emulator', () => {
  const banks = VECTORS.filter((v) => v.bank !== undefined);
  assert.equal(banks.length, 112 + 103 + 103 + 86);
  assert.equal(VECTORS.filter((v) => v.cfg !== undefined).length, 54);
  for (const v of VECTORS) {
    const p = hex(v.packed);
    const what = v.cfg !== undefined ? `configuration ${v.cfg}` : v.bank !== undefined ? `bank ${v.bank} preset ${v.n + 1}` : 'empty';
    assert.deepEqual(Array.from(A.unpack(p)), Array.from(hex(v.expanded)), `${what} recalls`);
    assert.deepEqual(Array.from(A.pack(hex(v.source || v.expanded))), Array.from(p), `${what} packs`);
    assert.equal(A.packedLength(p), p.length);
  }
  // the ROM banks are the packed presets the tables hold
  A.BANKS.forEach((b, k) => b.presets.forEach((h, i) => assert.equal(h, VECTORS.find((v) => v.bank === k && v.n === i).packed)));
  const e = A.emptyEdit();
  assert.ok(A.isEmptyPreset(e));
  assert.deepEqual(Array.from(e.slice(4, 7)), [0, 0x17, 0x17], 'the SE\'s empty preset: DRY 0%, EFX and DRYEQ 75%');
  assert.equal(A.nameOf(A.factoryEdit(0)), 'DREAM CHAMBER');
  assert.equal(A.nameOf(A.bankEdit(3, 85)), A.BANKS[3].titles[85].trim());
  assert.ok(A.isEmptyPreset(A.bankEdit(1, 103)), 'past the bank\'s last preset: empty');
  assert.deepEqual(Array.from(A.romPreset(5, { h: 0, l: 5 }, 2)), Array.from(A.bankEdit(2, 5)), 'OPEN follows the selected bank');
  assert.deepEqual(Array.from(A.romPreset(5, { h: 4, l: 7 }, 2)), Array.from(A.bankEdit(3, 7)));
  for (let b = 0; b < 4; b++) for (let n = 0; n < A.BANKS[b].presets.length; n++) assert.equal(A.fitEdit(A.bankEdit(b, n)), 0, `bank ${b} preset ${n + 1} in range`);
  // the 98-byte edit buffer is the Alpha 2's: an Alpha 2 preset packs the SE way and back unchanged
  for (let n = 0; n < 115; n += 7) {
    const d = A2.factoryEdit(n);
    const back = A.unpack(A.pack(d));
    for (const { t, offset } of A.paramList(A.cfgOf(d))) if (A.inUse(d, t)) assert.equal(back[offset], d[offset], `Alpha 2 preset ${n + 1} byte ${offset}`);
    assert.equal(A.nameOf(back), A2.nameOf(d));
  }
});

test('Alpha 2 SE messages: all presets (12), program table (13 / 11), recall, store', () => {
  const list = Array.from({ length: 200 }, (_, n) => ({ rom: { h: 0, l: n } }));
  list[3] = { rom: { h: 2, l: 9 } };
  list[150] = { packed: A.pack(A.bankEdit(1, 4)) };
  const m = A.msg.all(list, ctx);
  assert.deepEqual(m.slice(0, 5), [0xf0, 0x1a, 0, 0x11, 0x12]);
  const back = A.presetsFrom(Uint8Array.from(m));
  assert.equal(back.length, 200);
  assert.deepEqual([back[0].rom, back[3].rom, back[199].rom], [{ h: 0, l: 0 }, { h: 2, l: 9 }, { h: 0, l: 199 }]);
  assert.deepEqual(Array.from(back[150].packed), Array.from(list[150].packed));
  // 0B (the Alpha 2's form) is taken and converted: 02 n n = OPEN n
  const a2 = A.presetsFrom(Uint8Array.from(A2.msg.all(Array(200).fill(null).map((_, n) => (n === 7 ? A2.pack(A2.factoryEdit(9)) : null)), ctx)));
  assert.deepEqual([a2[0].rom, a2[7].data && A.nameOf(a2[7].data)], [{ h: 0, l: 0 }, A2.nameOf(A2.factoryEdit(9))]);
  assert.deepEqual(A.msg.mapEntry(150, 199, ctx), [0xf0, 0x1a, 0, 0x11, 0x11, 0x16, 0x01, 0x47, 0x01, 0xf7]);
  assert.deepEqual(A.msg.getMapEntry(5, ctx), [0xf0, 0x1a, 0, 0x11, 0x51, 0x05, 0xf7]);
  assert.equal(A.msg.map(new Uint8Array(200), ctx).length, 5 + 400 + 1);
  assert.deepEqual(A.msg.setting(A.S.bank, 2, ctx), [0xf0, 0x1a, 0, 0x11, 0x03, 0x09, 0x02, 0xf7]);
  assert.deepEqual(A.msg.recallFactory(5, ctx), [0xf0, 0x1a, 0, 0x11, 0x09, 0x05, 0x40, 0xf7]);
  // a preset is written through the edit buffer: 05 then STORE (0A)
  const st = A.storeMessage(160, A.bankEdit(0, 3), ctx);
  assert.deepEqual(st.map((x) => x[4]), [0x05, 0x0a]);
  assert.equal(A.msg.getAll(ctx)[4], 0x52);
  assert.match(se.describe(Uint8Array.from(A.msg.mapEntry(3, 9, ctx))), /Alpha 2 SE .* MIDI program 3 -> preset 10/);
  assert.match(se.describe(Uint8Array.from(A.msg.getSetting(0x09, ctx))), /request BANK/);
  assert.ok(se.isRequest(Uint8Array.from(A.msg.getMap(ctx))) && !se.isRequest(Uint8Array.from(m)));
});

test('Alpha 2 SE editor: tuner types, ROM banks as slot pages, settings with BANK and 200 program table entries', () => {
  const d = A.factoryEdit(0);
  assert.ok(visible(d).length > 20);
  for (let b = 0; b < 4; b++) {
    for (let n = 0; n < A.BANKS[b].presets.length; n += 5) {
      const f = A.bankEdit(b, n);
      for (const p of visible(f)) {
        const v = view(p, f);
        if (v.readOnly) continue;
        const x = readParam(f, v);
        assert.ok(v.options?.some(([o]) => o === x), `bank ${b} preset ${n + 1} ${p.key} = ${x}`);
      }
    }
  }
  const s = eff.slots;
  const banks = s.banks;
  assert.deepEqual(banks.map(([v]) => v), [0, 1, 2, 3, 4]);
  assert.match(banks[2][1], /STUDIO/);
  assert.deepEqual([s.count(0), s.count(1), s.count(4)], [200, 112, 86]);
  assert.equal(s.names(2)[0], A.BANKS[1].titles[0].trim());
  assert.equal(s.names(0), null);
  assert.ok(s.writable(0) && !s.writable(3));
  assert.deepEqual(s.recall(0, 9, ctx), [A.msg.recall(9, ctx)]);
  assert.equal(s.recall(2, 9, ctx)[0][4], 0x05, 'a ROM bank preset goes to the edit buffer');
  const bank = sys.params.find((p) => p.key === 'bank');
  assert.deepEqual(bank.options.map(([, l]) => l), A.BANK_UTIL.values);
  assert.deepEqual(bank.send(3, ctx), A.msg.setting(0x09, 3, ctx));
  assert.equal(sys.params.filter((p) => p.section === 'map').length, 200);
  assert.equal(sys.params.find((p) => p.key === 'map150').send(7, ctx)[4], 0x11);
  const s0 = A.initSystem();
  assert.deepEqual([s0[A.SYS.map + 199], s0[A.S.bank], s0[A.S.channel]], [199, 0, 1]);
  const ver = sys.params.find((p) => p.key === 'version');
  assert.equal(ver.format(readParam(s0, ver)), 'v2.03');
});

test('Alpha 2 SE against its simulator: edit buffer, all presets, store with ROM references, settings', async () => {
  const t = new LoopbackTransport({ id: 'art-multiverb-alpha2-se', model: 'Multiverb Alpha 2 SE', sysex: '1A' }, se);
  const c = new DeviceClient(t, { minGap: 1, timeout: 800 });
  const sim = t.sim.state;
  const api = {
    ctx,
    data: null,
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw, ctx),
  };
  const d = eff.decode((await c.request(Uint8Array.from(eff.request(ctx)), { match: (_m, r) => eff.match(r) })).raw);
  assert.equal(A.nameOf(d), 'DREAM CHAMBER');
  // a live edit sends the whole edit buffer
  const lvl = visible(d).find((p) => p.label === 'LEVEL' && p.group !== 'MIX');
  writeParam(d, lvl, 10);
  await c.send(Uint8Array.from(lvl.send(10, ctx, d)));
  await c.drain();
  assert.equal(readParam(sim.edit, lvl), 10);
  // Store: 05 + 0A; an edited preset goes to user RAM
  const store = s => s.map((m) => c.send(Uint8Array.from(m)));
  store(eff.slots.store(0, 150, ctx, d));
  await c.drain();
  assert.ok(sim.presets[150].packed);
  assert.equal(readParam(A.unpack(sim.presets[150].packed), lvl), 10);
  // a preset equal to a ROM preset becomes a reference to it; an empty one leaves the slot empty
  store(eff.slots.store(0, 151, ctx, A.bankEdit(2, 6)));
  store(eff.slots.store(0, 152, ctx, A.emptyEdit()));
  await c.drain();
  assert.deepEqual([sim.presets[151].rom, sim.presets[152].rom], [{ h: 3, l: 6 }, { h: 0, l: 0xff }]);
  // reading a slot asks for all presets (52) and the BANK (43 09)
  sim.sys[A.S.bank] = 1;
  assert.equal(A.nameOf(await eff.slots.fetch(api, 0, 4)), A.BANKS[1].titles[4].trim(), 'OPEN: the selected bank');
  assert.equal(A.nameOf(await eff.slots.fetch(api, 0, 151)), A.BANKS[2].titles[6].trim());
  assert.equal(A.nameOf(await eff.slots.fetch(api, 0, 152)), '');
  assert.equal(readParam(await eff.slots.fetch(api, 0, 150), lvl), 10);
  assert.equal(A.nameOf(await eff.slots.fetch(api, 3, 10)), A.BANKS[2].titles[10].trim(), 'ROM banks come from the tables');
  const names = [];
  await eff.slots.scanBank(api, 0, (i, s) => { names[i] = s; });
  assert.deepEqual([names[0], names[150], names[199]], [A.BANKS[1].titles[0].trim(), 'DREAM CHAMBER', '']);
  // recall factory preset: the selected bank's
  api.data = d;
  api.setData = (x) => { api.data = x; };
  api.form = async () => ({ n: '3' });
  await eff.actions[2].run(api);
  await c.drain();
  assert.deepEqual(Array.from(sim.edit), Array.from(A.bankEdit(1, 2)));
  assert.deepEqual(Array.from(api.data), Array.from(A.bankEdit(1, 2)));
  // settings: every 43 request, the store status and the 200-entry program table (53)
  sim.sys[A.SYS.map + 180] = 3;
  const s = await sys.fetch(api);
  assert.deepEqual([s[A.S.bank], s[A.SYS.map + 180]], [1, 3]);
  const map9 = sys.params.find((p) => p.key === 'map190');
  await c.send(Uint8Array.from(map9.send(42, ctx, s)));
  await c.drain();
  assert.equal(sim.sys[A.SYS.map + 190], 42);
  c.dispose();
});

test('Alpha 2 SE: library items, complete dump, model choice and translator', () => {
  const sim = A._test.simulate();
  sim.state.presets[130] = { packed: A.pack(A.bankEdit(3, 5)) };
  sim.state.presets[7] = { rom: { h: 2, l: 1 } };
  sim.state.sys[A.S.bank] = 2;
  const out = [
    ...sim.handle(Uint8Array.from(A.msg.getAll(ctx))),
    ...sim.handle(Uint8Array.from(A.msg.getMap(ctx))),
    ...A.SETTINGS.flatMap((k) => sim.handle(Uint8Array.from(A.msg.getSetting(k, ctx)))),
    ...sim.handle(Uint8Array.from(A.msg.getEdit(ctx))),
  ].map((m) => Uint8Array.from(m));
  assert.ok(out.every((m) => se.recognise(m)));
  const items = se.libraryItems(out);
  const presets = items.filter((x) => x.object === 'effect' && x.label.startsWith('Preset'));
  assert.equal(presets.length, 200);
  assert.equal(presets[130].name, A.BANKS[3].titles[5].trim());
  assert.equal(presets[7].name, A.BANKS[1].titles[1].trim());
  assert.equal(presets[0].name, A.BANKS[2].titles[0].trim(), 'OPEN slots follow the BANK in the same dump');
  assert.deepEqual(presets[0].msgs.map((m) => m[4]), [0x05, 0x0a]);
  const s = items.find((x) => x.object === 'system');
  assert.equal(s.data[A.S.bank], 2);
  assert.equal(se.fullDump.find((x) => x.request === 'Settings').expect, A.SETTINGS.length + 2);
  // the shared header: SE-only messages pick the SE, Alpha 2-only ones the Alpha 2, an edit buffer fits both
  const a2dump = [Uint8Array.from(A2.msg.all(Array(200).fill(null), ctx))];
  assert.ok(se.prefer(out) > alpha2.prefer(out));
  assert.ok(alpha2.prefer(a2dump) > se.prefer(a2dump));
  const edit = [Uint8Array.from(A.msg.edit(A.factoryEdit(0), ctx))];
  assert.equal(se.prefer(edit), alpha2.prefer(edit));
  // translator: exact within the family (the same 98 bytes as the Alpha 2)
  for (let n = 0; n < 112; n += 9) {
    const d = A.prepare(A.factoryEdit(n));
    assert.deepEqual(Array.from(eff.fromCommon(eff.toCommon(d), null).data), Array.from(d));
  }
  const c = eff.toCommon(A.factoryEdit(0));
  assert.deepEqual([c.kind, c.extra.family, c.extra.model], ['effect', 'art-multiverb', 'art-multiverb-alpha2-se']);
  const a2eff = alpha2.objects.find((o) => o.key === 'effect');
  const x = a2eff.fromCommon(c, null);
  assert.deepEqual(Array.from(x.data), Array.from(A.prepare(A.factoryEdit(0))), 'an SE preset loads into the Alpha 2 editor as it is');
  const r = eff.fromCommon({ model: 1, kind: 'effect', effects: { reverb: { type: 'Hall', time: 0.3, level: 1 }, delay: { time: 0.3, feedback: 0.4, level: 0.6 } } }, null);
  assert.equal(A.fitEdit(Uint8Array.from(r.data)), 0);
  assert.ok(A.CONFIGS[A.cfgOf(r.data)].some((t) => A.inUse(r.data, t) && t >= 7 && t <= 9));
});

test('Alpha 2 SE: registry, catalog and doc', () => {
  const reg = fs.readFileSync(new URL('../js/devices/registry.js', import.meta.url), 'utf8');
  assert.ok(reg.includes("'art-multiverb-alpha2-se'") && reg.includes("'art-multiverb-alpha-se'"));
  const cat = fs.readFileSync(new URL('../js/devices/catalog-data.js', import.meta.url), 'utf8');
  assert.ok(cat.includes('"id": "art-multiverb-alpha2-se"') && cat.includes('"id": "art-multiverb-alpha-se"'));
  const doc = fs.readFileSync(new URL('../docs/devices/art-multiverb-alpha2-se.md', import.meta.url), 'utf8');
  assert.match(doc, /not checked on hardware/i);
});
