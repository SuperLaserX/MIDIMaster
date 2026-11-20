import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readParam, writeParam, paramRange, formatParam, named } from '../js/core/model/memmap.js';
import { DeviceClient } from '../js/core/midi/device-client.js';
import { LoopbackTransport } from '../js/core/midi/loopback.js';
import m1000, { msg as mx, initPatch, unnibble, patchName, _test as mxTest } from '../js/devices/defs/oberheim-matrix1000.js';

test('memmap: bytes, bit fields, signed values, nibbles and bias', () => {
  const d = new Uint8Array(8);
  const s7 = { offset: 0, signed: true, min: -63, max: 63 };
  assert.deepEqual(writeParam(d, s7, -5), { offset: 0, length: 1 });
  assert.equal(d[0], 0xfb);
  assert.equal(readParam(d, s7), -5);
  assert.equal(writeParam(d, s7, -5), null, 'no change gives no patch');
  assert.equal(readParam(d, s7), -5);
  const hi = { offset: 1, shift: 7, bits: 1 };
  const lo = { offset: 1, bits: 4, max: 9 };
  writeParam(d, lo, 7); writeParam(d, hi, 1);
  assert.equal(d[1], 0x87);
  writeParam(d, lo, 12);
  assert.equal(readParam(d, lo), 9, 'clamped to max');
  assert.equal(readParam(d, hi), 1, 'neighbouring bits kept');
  const nib = { offset: 2, nibbles: 2 };
  writeParam(d, nib, 0xa5);
  assert.deepEqual([d[2], d[3]], [0x0a, 0x05]);
  const bias = { offset: 4, bias: 64, min: -64, max: 63 };
  writeParam(d, bias, -10);
  assert.equal(d[4], 54);
  assert.equal(readParam(d, bias), -10);
  assert.deepEqual(paramRange({ offset: 0, signed: true, bits: 6 }), { min: -32, max: 31 });
  assert.equal(formatParam({ options: named(['Off', 'On']) }, 1), 'On');
});

test('Matrix-1000 definition covers every remote parameter at the firmware offsets', () => {
  const nums = new Set(mxTest.PATCH.map((r) => r[0]));
  for (let n = 0; n < 100; n++) assert.equal(nums.has(n), ![39, 49, 89, 99].includes(n), `param ${n}`);
  const offsets = new Set(mxTest.PATCH.map((r) => r[1]));
  for (let o = 8; o < 104; o++) assert.ok(offsets.has(o), `byte ${o}`);
  // Spot checks against the 0xDE13 table: VCF frequency (21) -> byte 26, keyboard mode (48) -> byte 8.
  assert.equal(mxTest.PATCH.find((r) => r[0] === 21)[1], 26);
  assert.equal(mxTest.PATCH.find((r) => r[0] === 48)[1], 8);
  const p = initPatch('TEST');
  const sx = mx.patch(5, p);
  assert.equal(sx.length, 5 + 268 + 2);
  const back = unnibble(sx, 5, 134);
  assert.ok(back.ok);
  assert.equal(patchName(back.data), 'TEST');
});

test('Matrix-1000 against its simulator: read, live edits, matrix, store and master', async () => {
  const entry = { id: 'oberheim-matrix1000', model: 'Matrix-1000', sysex: '10' };
  const t = new LoopbackTransport(entry, m1000);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const patch = m1000.objects.find((o) => o.key === 'patch');
  const master = m1000.objects.find((o) => o.key === 'master');

  const id = await c.identity(0x7f, 400);
  assert.deepEqual([...id.slice(5, 10)], [0x10, 0x06, 0x00, 0x02, 0x00], 'Oberheim, family 6, member 2');
  assert.equal(String.fromCharCode(...id.slice(10, 13)), '113');

  const raw = (await c.request(Uint8Array.from(patch.request()), { match: (_m, r) => patch.match(r) })).raw;
  const data = patch.decode(raw);
  assert.equal(data.length, 134);

  // Live edit through the definition: VCF frequency (param 21, 7 bits) and DCO2 detune (signed).
  const vcf = patch.params.find((p) => p.num === 21);
  writeParam(data, vcf, 120);
  await c.send(Uint8Array.from(vcf.send(120, {}, data)));
  const det = patch.params.find((p) => p.num === 12);
  writeParam(data, det, -7);
  await c.send(Uint8Array.from(det.send(-7, {}, data)));
  const slot = patch.params.find((p) => p.key === 'm3amt');
  writeParam(data, patch.params.find((p) => p.key === 'm3src'), 4);
  writeParam(data, slot, -20);
  writeParam(data, patch.params.find((p) => p.key === 'm3dst'), 9);
  await c.send(Uint8Array.from(slot.send(-20, {}, data)));
  await c.drain();
  const sim = t.sim.state;
  assert.equal(sim.edit[26], 120);
  assert.equal((sim.edit[19] << 24) >> 24, -7);
  assert.deepEqual([sim.edit[113], (sim.edit[114] << 24) >> 24, sim.edit[115]], [4, -20, 9]);

  // Store into 105 (bank 1, slot 5), then read that slot back through the slot browser.
  await c.send(Uint8Array.from(patch.slots.store(1, 5)));
  await c.drain();
  assert.equal(sim.patches[105][26], 120);
  const api = {
    send: (out) => { for (const b of (Array.isArray(out[0]) ? out : [out])) c.send(Uint8Array.from(b)); },
    request: async (bytes, match, decode) => decode((await c.request(Uint8Array.from(bytes), { match: (_m, r) => match(r) })).raw),
  };
  const fetched = await patch.slots.fetch(api, 1, 5);
  assert.equal(fetched[26], 120);
  assert.equal(patchName(fetched), 'BNK1: 05');

  // Master: change bend range and send the whole table back.
  const mraw = (await c.request(Uint8Array.from(master.request()), { match: (_m, r) => master.match(r) })).raw;
  const mdata = master.decode(mraw);
  assert.equal(mdata[164], 2, 'factory bend range');
  const bend = master.params.find((p) => p.key === 'bendRange');
  writeParam(mdata, bend, 12);
  await c.send(Uint8Array.from(bend.send(12, {}, mdata)));
  await c.drain();
  assert.equal(sim.master[164], 12);
  assert.match(m1000.describe(Uint8Array.from(mx.param(21, 64))), /VCF frequency = 64/);
  c.dispose();
});

test('Roland DT1/RQ1 helpers', async () => {
  const { checksum, addAddr, rq1, dt1, parseDt1 } = await import('../js/core/midi/roland.js');
  // Roland's manual example: F0 41 10 6A 12 03 00 00 03 01 79 F7 sets patch common byte 3.
  assert.equal(checksum([0x03, 0x00, 0x00, 0x03, 0x01]), 0x79);
  assert.deepEqual(addAddr([0x03, 0x00, 0x7f, 0x7f], 2), [0x03, 0x01, 0x00, 0x01]);
  const m = dt1([0x6a], 0x10, [0x03, 0x00, 0x00, 0x03], [0x01]);
  assert.deepEqual(m, [0xf0, 0x41, 0x10, 0x6a, 0x12, 0x03, 0x00, 0x00, 0x03, 0x01, 0x79, 0xf7]);
  assert.equal(parseDt1(Uint8Array.from(m), [0x6a]).ok, true);
  assert.equal(rq1([0x6a], 0x10, [0, 0, 0, 0], 0x62).at(-2), checksum([0, 0, 0, 0, 0, 0, 0, 0x62]));
});

test('JV-2080 against its simulator: read the patch, live edit, store and read a user patch', async () => {
  const jv = (await import('../js/devices/defs/roland-jv2080.js')).default;
  const { _test: T } = await import('../js/devices/defs/roland-jv2080.js');
  const { asList } = await import('../js/devices/generic/objects.js');
  const entry = { id: 'roland-jv2080', model: 'JV-2080', sysex: '41' };
  const t = new LoopbackTransport(entry, jv);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const patch = jv.objects.find((o) => o.key === 'patch');
  const ctx = { deviceId: 0x10, channel: 0 };
  const api = { g: { client: c }, ctx, send: (out) => { for (const b of asList(out)) c.send(Uint8Array.from(b)); }, toast: () => {} };
  const data = await patch.fetch(api);
  assert.equal(data.length, 590);
  assert.equal(patch.name(data), 'Demo Patch');
  assert.equal(data[0x2c] * 16 + data[0x2d], 120, 'firmware default tempo');
  const cutoff = patch.params.find((p) => p.label === 'Cutoff frequency' && p.section === 't2');
  writeParam(data, cutoff, 77);
  await c.send(Uint8Array.from(cutoff.send(77, ctx, data)));
  await c.drain();
  assert.equal(t.sim.mem.get(T.PATCH_BASE + 0x800 + 2 * 0x100 + 0x51), 77, 'tone 3 cutoff at 03 00 14 51');
  for (const m of patch.slots.store(0, 4, ctx, data)) await c.send(Uint8Array.from(m));
  await c.drain();
  const back = await patch.slots.fetch(api, 0, 4);
  assert.equal(back[cutoff.offset], 77);
  assert.equal(patch.name(back), 'Demo Patch');
  const perf = jv.objects.find((o) => o.key === 'performance');
  const pd = await perf.fetch(api);
  assert.equal(pd.length, 68 + 16 * 26);
  assert.equal(perf.name(pd), 'Demo Perform');
  c.dispose();
});

test('readBlock asks again for bytes that did not arrive', async () => {
  const { readBlock, dt1, addrToInt, intToAddr } = await import('../js/core/midi/roland.js');
  const mem = Array.from({ length: 200 }, (_, i) => i & 127);
  const calls = [];
  const client = {
    async request(bytes, opts) {
      const a = addrToInt(Array.from(bytes.slice(5, 9)));
      const size = addrToInt(Array.from(bytes.slice(9, 13)));
      calls.push([a, size]);
      const msgs = [];
      for (let o = 0; o < size; o += 64) msgs.push(dt1([0x6a], 0x10, intToAddr(a + o), mem.slice(a + o, a + Math.min(size, o + 64))));
      const deliver = calls.length === 1 ? msgs.slice(0, 1) : msgs; // the first reply loses its second message
      for (const m of deliver) { opts.collect(null, Uint8Array.from(m)); if (opts.complete?.()) return { complete: true }; }
      return { partial: true };
    },
  };
  const out = await readBlock(client, [0x6a], 0x10, [0, 0, 0, 0], 129);
  assert.deepEqual(Array.from(out), mem.slice(0, 129));
  assert.deepEqual(calls, [[0, 129], [64, 65]], 'second request covers only the missing bytes');
  await assert.rejects(readBlock({ request: async () => { throw new Error('timeout'); } }, [0x6a], 0x10, [0, 0, 0, 0], 4, { retries: 1 }), /No reply/);
});

test('JV-2080: presets, performances, names, live updates, part patches and files', async () => {
  const mod = await import('../js/devices/defs/roland-jv2080.js');
  const { asList, sendOut } = await import('../js/devices/generic/objects.js');
  const { dt1, parseDt1, addrToInt } = await import('../js/core/midi/roland.js');
  const jv = mod.default;
  const T = mod._test;
  const t = new LoopbackTransport({ id: 'roland-jv2080', model: 'JV-2080', sysex: '41' }, jv);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const ctx = { deviceId: 0x10, channel: 0, data: {}, loaded: new Set(), names: {} };
  const api = { g: { client: c }, ctx, send: (out) => { for (const b of asList(out)) c.send(Uint8Array.from(b)); }, toast: () => {} };
  const patch = jv.objects.find((o) => o.key === 'patch');
  const perf = jv.objects.find((o) => o.key === 'performance');
  const sys = jv.objects.find((o) => o.key === 'system');

  // Bank select decoding (0x0E1230BC) and the banks offered.
  assert.deepEqual(T.PATCH_BANKS.slice(0, 7).map((b) => [b.label, b.msb, b.lsb]),
    [['USER', 80, 0], ['PR-A', 81, 0], ['PR-B', 81, 1], ['PR-C', 81, 2], ['PR-D (GM)', 81, 3], ['PR-E', 81, 4], ['CARD', 82, 0]]);
  assert.deepEqual(T.PATCH_BANKS.slice(7, 10).map((b) => [b.label, b.msb, b.lsb]), [['XP-A 1-128', 84, 0], ['XP-A 129-256', 84, 1], ['XP-B 1-128', 84, 2]]);
  assert.deepEqual(T.currentPatchSelect([1, 0, 0, 5, 0, 7], {}), [81, 2, 7], 'PR-C 8');
  assert.deepEqual(T.currentPatchSelect([1, 0, 2, 19, 8, 2], { settings: { jvBoards: [11, 19] } }), [84, 3, 2], 'board 19 in slot B, patch 131');
  assert.equal(patch.slots.names(1)[0], '64voicePiano');
  assert.equal(perf.slots.names(2)[31], 'Drone / Pipe');

  // System first: it gives the channels used to select patches and performances.
  ctx.data.system = await sys.fetch(api);
  ctx.loaded.add('system');
  ctx.data.system[0x1d] = 2; // patch receive channel 3
  const recall = patch.slots.recall(1, 5, ctx);
  assert.deepEqual(recall.slice(-3), [[0xb2, 0, 81], [0xb2, 32, 0], [0xc2, 5]]);
  t.sim.mem.set(0x1d, 2);

  // Edit a preset: patch mode, bank select + program change, then the temporary patch.
  const pa = await patch.slots.fetch(api, 1, 0);
  assert.equal(patch.name(pa), '64voicePiano');
  assert.deepEqual([t.sim.mem.get(2), t.sim.mem.get(3)], [0, 3], 'PR-A is group type 0, ID 3');
  // User names by RQ1, without selecting anything.
  const names = [];
  await patch.slots.scanBank(api, 0, (i, n) => { names[i] = n; }, () => names.length >= 3);
  assert.deepEqual(names, ['User 001', 'User 002', 'User 003']);
  // Performances: performance mode and the control channel.
  ctx.data.system[0x1c] = 15;
  t.sim.mem.set(0x1c, 15);
  const pd = await perf.slots.fetch(api, 1, 0);
  assert.equal(perf.name(pd), 'Seq:Template');
  assert.equal(t.sim.mem.get(0), 0, 'performance mode');

  // EFX parameters take their names from the EFX type.
  const efx1 = patch.params.find((p) => p.key === 'c_13');
  const d = T.defaults(T.patchBuilt);
  d[12] = 23; // REVERB
  assert.equal(efx1.dynamic(d, ctx).label, 'Type');
  assert.ok(patch.params.find((p) => p.key === 'c_24').dynamic(d, ctx).hidden, 'REVERB has 8 parameters');

  // Panel edits the JV-2080 sends (Tx Edit Data) update the editor's copy.
  const upd = patch.receive(Uint8Array.from(dt1([0x6a], 0x10, [3, 0, 0x10, 0x51], [99])), d, ctx);
  assert.equal(upd[74 + 0x51], 99, 'tone 1 cutoff');
  assert.equal(patch.receive(Uint8Array.from(dt1([0x6a], 0x10, [1, 0, 0, 0], [65])), d, ctx), null, 'not this object');

  // The patch a performance part plays: same layout at 02 pp 00 00.
  patch.target.set('p2');
  const cut = patch.params.find((p) => p.label === 'Cutoff frequency' && p.section === 't0');
  assert.deepEqual(parseDt1(cut.send(0, ctx, d), [0x6a]).addr, [2, 2, 0x10, 0x51]);
  patch.target.set('patch');
  assert.deepEqual(parseDt1(cut.send(0, ctx, d), [0x6a]).addr, [3, 0, 0x10, 0x51]);

  // A user patch dump loads into the editor layout.
  d[0] = 0x51;
  const dump = patch.slots.store(0, 7, ctx, d).map((m) => Uint8Array.from(m));
  const loaded = patch.fromSyx(dump);
  assert.deepEqual(Array.from(loaded), Array.from(d));
  assert.equal(addrToInt(parseDt1(dump[0], [0x6a]).addr), addrToInt([0x11, 7, 0, 0]));

  // Channel messages queue behind SysEx sent with them, so the order holds.
  const order = [];
  const g = { client: { pending: 0, send: async (b) => { order.push(['q', b[0]]); }, sendNow: (b) => order.push(['now', b[0]]) }, error: () => {} };
  sendOut(g, [[0xf0, 0x41, 0xf7], [0xb0, 0, 80], [0xc0, 1]]);
  sendOut(g, [0xc0, 2]);
  assert.deepEqual(order, [['q', 0xf0], ['q', 0xb0], ['q', 0xc0], ['now', 0xc0]]);
  c.dispose();
});

test('Generic module: standard information is read when the device connects', async () => {
  const { GenericContext } = await import('../js/devices/generic/module.js');
  const jv = (await import('../js/devices/defs/roland-jv2080.js')).default;
  const errors = [];
  const host = {
    demo: true, transport: null, useTransport(tr) { this.transport = tr; },
    settings: { on: () => () => {}, value: { midi: { sysexGap: 0, replyTimeout: 500, bytesPerSecond: 3000 } } },
    device: { value: {}, update(v) { Object.assign(this.value, v); } },
    setBusy() {}, error: (e) => errors.push(e), setStatus() {}, setOnline() {}, connectPorts: async () => {}, shell: { real: {} },
  };
  const g = new GenericContext(host, { id: 'roland-jv2080', model: 'JV-2080', sysex: '41' }, jv);
  g.client.setSettings({ minGap: 1 });
  g.renderStatus = () => {}; // no DOM in tests
  const done = new Promise((r) => g.on('standard-loaded', r));
  await g.connect();
  await done;
  assert.deepEqual(errors, []);
  assert.deepEqual([...g.loadedKeys], ['system', 'patch', 'performance']);
  assert.equal(g.slotNames.patch.get('0:127'), 'User 128');
  assert.equal(g.slotNames.performance.get('0:31'), 'Perform 32');
  assert.deepEqual(host.device.value.jvBoards, [5, 19, 97, 0, 0, 0, 0, 0], 'expansion boards found when connecting');
  g.destroy();
});

test('JV-2080 expansion boards: ROM names, bank sizes, wave lists, detection and cached names', async () => {
  const mod = await import('../js/devices/defs/roland-jv2080.js');
  const { SRJV80_BOARDS: B } = await import('../js/devices/defs/roland-srjv80.js');
  const { asList } = await import('../js/devices/generic/objects.js');
  const jv = mod.default;
  const T = mod._test;

  // Data from the board ROMs (tools/roland/srjv80_rom.py).
  assert.equal(B[5].code, 'ETH100');
  assert.equal(B[5].waves[0], 'Sitar A');
  assert.equal(B[5].patches[0], 'World Tour!');
  assert.equal(B[1].patches.length, 145);
  assert.equal(B[98].patchSource, 'list');
  assert.equal(B[98].patches[0], '*Dy.Rhodes 1');
  assert.equal(B[97].patches, null, 'Experience III patches are not on the board');

  const t = new LoopbackTransport({ id: 'roland-jv2080', model: 'JV-2080', sysex: '41' }, jv);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const settings = {};
  const ctx = { deviceId: 0x10, channel: 0, data: {}, loaded: new Set(), names: {}, settings };
  const toasts = [];
  const api = {
    g: { client: c, demo: true, setBusy() {}, host: { device: { update(v) { for (const [k, x] of Object.entries(v)) settings[k] = x && typeof x === 'object' && !Array.isArray(x) ? { ...settings[k], ...x } : x; } } } },
    ctx, quiet: true, send: (out) => { for (const b of asList(out)) c.send(Uint8Array.from(b)); }, toast: (m) => toasts.push(m), refresh() {}, confirm: async () => true,
  };
  const patch = jv.objects.find((o) => o.key === 'patch');
  const bank = (label) => T.PATCH_BANKS.findIndex((b) => b.label === label);

  // Detection keeps the temporary patch, edits included, and the previous selection.
  t.sim.mem.set(T.PATCH_BASE, 'M'.charCodeAt(0)); // an unsaved edit: "Memo Patch"
  await jv.connectTasks[0].run(api);
  assert.deepEqual(settings.jvBoards, [5, 19, 97, 0, 0, 0, 0, 0]);
  await c.drain();
  assert.equal(patch.name(await patch.fetch({ ...api, ctx })), 'Memo Patch', 'temporary patch put back');
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => t.sim.mem.get(a) ?? 0).slice(1), [0, 1, 0, 0], 'USER 001 selected again');
  assert.match(toasts[0], /XP-A: SR-JV80-05 World, XP-B: SR-JV80-19 House, XP-C: SR-JV80-97 Experience III/);

  // Bank sizes and names come from the board data: no scan needed.
  assert.equal(patch.slots.count(bank('XP-A 1-128'), ctx), 128);
  assert.equal(patch.slots.count(bank('XP-B 129-256'), ctx), 156 - 128, 'House holds 156 patches');
  assert.equal(patch.slots.names(bank('XP-A 1-128'), ctx)[0], 'World Tour!');
  assert.equal(patch.slots.names(bank('XP-B 129-256'), ctx)[0], B[19].patches[128]);
  assert.equal(patch.slots.names(bank('XP-C 1-128'), ctx), null, 'Experience III: names read from the unit');

  // A board without ROM names is read once; the names and count are kept in the settings.
  const read = [];
  await patch.slots.scanBank(api, bank('XP-C 1-128'), (i, n) => { read[i] = n; });
  assert.equal(read.length, 40);
  assert.equal(settings.jvBoardCounts[97], 40);
  assert.equal(patch.slots.count(bank('XP-C 1-128'), ctx), 40);
  assert.equal(patch.slots.names(bank('XP-C 1-128'), ctx)[39], 'Exp III 040');
  assert.equal(patch.slots.count(bank('XP-C 129-256'), ctx), 0);

  // Wave and patch selections are lists, named from the boards.
  const d = T.defaults(T.patchBuilt);
  const tone = (label) => patch.params.find((p) => p.label === label && p.section === 't0');
  d[tone('Wave group type').offset] = 2;
  d[tone('Wave group ID').offset] = 5;
  const groups = tone('Wave group ID').dynamic(d, ctx).options;
  assert.deepEqual(groups.find(([v]) => v === 5), [5, 'SR-JV80-05 World (slot A)']);
  const waves = tone('Wave number').dynamic(d, ctx).options;
  assert.equal(waves.length, 255);
  assert.deepEqual(waves[0], [0, '001 Sitar A']);
  d[tone('Wave group type').offset] = 0;
  d[tone('Wave group ID').offset] = 1;
  assert.deepEqual(tone('Wave group ID').dynamic(d, ctx).options, [[1, 'INT-A'], [2, 'INT-B']]);
  assert.equal(tone('Wave number').dynamic(d, ctx).options.length, 256);
  const perf = jv.objects.find((o) => o.key === 'performance');
  const pd = T.defaults(T.perfBuilt);
  const part = (label) => perf.params.find((p) => p.label === label && p.section === 'p0');
  pd[part('Patch group type').offset] = 2;
  pd[part('Patch group ID').offset] = 19;
  assert.equal(part('Patch number').dynamic(pd, ctx).options[0][1], `001 ${B[19].patches[0]}`);
  const sys = jv.objects.find((o) => o.key === 'system');
  const sysPerf = sys.params.find((p) => p.label === 'Current performance');
  assert.equal(sysPerf.dynamic(T.defaults(T.sysBuilt), ctx).options[64][1].slice(0, 8), 'PR-A 01 ');
  assert.equal(sys.params.filter((p) => p.input === 'number').length, 0x62 - 0x28, 'unused bytes are typed values');

  // Library: a dump splits into the objects it holds.
  'Lib Test'.split('').forEach((ch, i) => { d[i] = ch.charCodeAt(0); });
  const dump = [...patch.slots.store(0, 2, ctx, d), ...patch.slots.store(0, 3, ctx, d)].map((m) => Uint8Array.from(m));
  const items = jv.libraryItems(dump);
  assert.deepEqual(items.map((x) => [x.label, x.object, x.name]), [['User patch 003', 'patch', 'Lib Test'], ['User patch 004', 'patch', 'Lib Test']]);
  assert.equal(items[0].msgs.length + items[1].msgs.length, dump.length);
  await c.drain();
  c.dispose();
});

test('Korg M1: packing, program and combination dumps, store, bulk names, library and real dumps', async () => {
  const mod = await import('../js/devices/defs/korg-m1.js');
  const { asList } = await import('../js/devices/generic/objects.js');
  const m1 = mod.default;
  const { unpack, pack, msg, _test: T } = mod;
  const bytes = Uint8Array.from({ length: 143 }, (_, i) => (i * 37) & 255);
  assert.deepEqual(Array.from(unpack(pack(bytes))), Array.from(bytes), '7-in-8 packing round trip');
  assert.equal(pack(bytes).length, 164);

  const t = new LoopbackTransport({ id: 'korg-m1r', model: 'M1R', sysex: '42' }, m1);
  const c = new DeviceClient(t, { minGap: 1, timeout: 400 });
  const ctx = { deviceId: 0, channel: 0, names: {} };
  const api = { g: { client: c }, ctx, send: (out) => { for (const b of asList(out)) c.send(Uint8Array.from(b)); }, request: () => { throw new Error('unused'); } };
  api.request = async (b, match, decode) => decode((await c.request(Uint8Array.from(b), { match: (_m, r) => match(r) })).raw);
  const prog = m1.objects.find((o) => o.key === 'program');
  const combi = m1.objects.find((o) => o.key === 'combination');

  // Program: read, edit (whole-program dump), store, read back through a slot.
  const d = await prog.fetch(api);
  assert.equal(prog.name(d), 'Program 00');
  const cutoff = prog.params.find((p) => p.label === 'Cutoff' && p.section === 'osc1');
  assert.equal(cutoff.offset, 71);
  writeParam(d, cutoff, 42);
  for (const m of asList(prog.sendParam(cutoff, 42, d, ctx))) await c.send(Uint8Array.from(m));
  for (const m of prog.slots.store(0, 7, ctx, d)) await c.send(Uint8Array.from(m));
  await c.drain();
  assert.equal(t.sim.programs[7][71], 42, 'stored into I07');
  const back = await prog.slots.fetch(api, 0, 7);
  assert.equal(back[71], 42);
  const names = [];
  await prog.slots.scanBank(api, 0, (i, n) => { names[i] = n; });
  assert.equal(names.length, 100);
  assert.equal(names[99], 'Program 99');

  // Bit fields and the oscillator 2 block at +40.
  const mg = prog.params.find((p) => p.group === 'Pitch MG' && p.label === 'OSC select');
  const x = new Uint8Array(143);
  x[19] = 0b11100011;
  assert.equal(readParam(x, mg), 3);
  assert.equal(readParam(x, prog.params.find((p) => p.group === 'Pitch MG' && p.label === 'Key sync')), 1);
  assert.equal(prog.params.find((p) => p.label === 'Cutoff' && p.section === 'osc2').offset, 111);

  // Combination: needs combination mode, which the fetch switches to.
  const cd = await combi.fetch(api);
  assert.equal(combi.name(cd), 'Combi 00');
  assert.equal(t.sim.state.mode, 0);
  assert.equal(combi.params.filter((p) => p.label === 'MIDI channel').length, 8);

  // Timbres: Program OFF is bit 4 of +10, the MIDI channel its low bits; changing the type to
  // SPLIT rebuilds the timbres as the M1 does (split at C4), MULTI keeps them.
  const cp = (sec, label) => combi.params.find((p) => p.section === sec && p.label === label);
  const cx = Uint8Array.from(cd);
  writeParam(cx, cp('t2', 'Program'), 17);
  writeParam(cx, cp('t2', 'MIDI channel'), 5);
  assert.deepEqual([cx[58], cx[68]], [17, 5], 'timbre 3 program and channel');
  writeParam(cx, cp('t2', 'Program'), -1);
  assert.equal(cx[68], 0x15, 'OFF sets bit 4 and keeps the channel');
  assert.equal(readParam(cx, cp('t2', 'Program')), -1);
  writeParam(cx, cp('common', 'Combination type'), 2);
  assert.deepEqual([cx[41], cx[53], cx[57] & 0x10, cx[68] & 0x10], [59, 60, 0, 0x10], 'SPLIT: C4 split, timbre 2 on, timbre 3 off');
  assert.equal(combi.multi.columns.find((c) => c.role === 'channel').params[0], 'MIDI channel');
  assert.equal(combi.multi.on(2, cx), false);

  // Effects: type 0 is Hall, 33 No Effect; choosing a type loads its defaults; Waveform is bit 0.
  const fxType = prog.params.find((p) => p.label === 'Effect 1 type');
  const pd = Uint8Array.from(d);
  writeParam(pd, fxType, 11);
  assert.deepEqual(Array.from(pd.subarray(47, 55)), [60, 9, 3, 0, 10, 0, 0, 0], 'Chorus 1 defaults');
  const wave = prog.params.find((p) => p.offset === 49 && p.group === 'Effect 1');
  assert.deepEqual([wave.dynamic(pd).label, readParam(pd, wave)], ['Waveform', 1]);
  writeParam(pd, wave, 0);
  assert.equal(pd[49], 2, 'only bit 0 changes');
  assert.equal(fxType.options.find(([v]) => v === 33)[1], 'No Effect');

  // EG time switches: bit n on, bit n+4 negative.
  const at = prog.params.find((p) => p.section === 'osc1' && p.label === 'VDF kbd track AT');
  const dt = prog.params.find((p) => p.section === 'osc1' && p.label === 'VDF kbd track DT');
  const sw = new Uint8Array(143);
  writeParam(sw, at, 0); writeParam(sw, dt, 2);
  assert.equal(sw[99], 0b00010011);
  assert.deepEqual([readParam(sw, at), readParam(sw, dt)], [0, 2]);

  // Library: an all-programs dump splits into programs that each write their own slot.
  const all = Uint8Array.from(msg.allProgramsRequest(ctx));
  assert.deepEqual(Array.from(all), [0xf0, 0x42, 0x30, 0x19, 0x1c, 0, 0xf7]);
  const dump = (await c.request(all, { match: (_m, r) => r[4] === 0x4c, timeout: 3000 })).raw;
  const items = m1.libraryItems([dump], ctx);
  assert.equal(items.length, 100);
  assert.deepEqual([items[3].label, items[3].name, items[3].object], ['Program I03', 'Program 03', 'program']);
  assert.deepEqual(Array.from(items[3].msgs[2]), [0xf0, 0x42, 0x30, 0x19, 0x11, 0, 3, 0xf7], 'write request for I03');
  assert.equal(T.nameOf(prog.fromSyx([dump])), 'Program 00');
  await c.drain();
  c.dispose();
});

test('Korg M1: dumps from an M1R decode (skipped when absent)', async (tt) => {
  const fs = await import('node:fs');
  const path = new URL('../re/m1/live_allprog.syx', import.meta.url);
  if (!fs.existsSync(path)) { tt.skip('re/m1/live_allprog.syx not present'); return; }
  const mod = await import('../js/devices/defs/korg-m1.js');
  const prog = mod.default.objects.find((o) => o.key === 'program');
  const raw = fs.readFileSync(path);
  const all = mod.unpack(raw.subarray(6, raw.length - 1));
  const p = (n) => all.subarray(n * 143, (n + 1) * 143);
  const val = (d, label) => { const q = prog.params.find((x) => x.label === label); return formatParam({ ...q, ...(q.dynamic?.(d, {}) || {}) }, readParam(d, q)); };
  assert.equal(prog.name(p(2)), 'Brass 1');
  assert.equal(val(p(2), 'OSC1 Multisound'), '32 Brass  1');
  assert.equal(val(p(9), 'OSC mode'), 'DRUMS');
  assert.equal(val(p(9), 'OSC1 Multisound'), 'Drum Kit 1');
  assert.equal(val(p(16), 'OSC1 Octave'), "16'");
  const fx = (d, label) => { const q = prog.params.find((x) => x.label === label); return q.options.find(([v]) => v === readParam(d, q))[1]; };
  assert.deepEqual([fx(p(2), 'Effect 1 type'), fx(p(2), 'Effect 2 type')], ['Ensemble Hall', 'Chorus 1'], 'Brass 1 effects');
  assert.equal(fx(p(15), 'Effect 2 type'), 'Tremolo 1', 'Vibes');
  const glob = mod.default.objects.find((o) => o.key === 'global');
  const gpath = new URL('../re/m1/live_req0e.syx', import.meta.url);
  if (fs.existsSync(gpath)) {
    const graw = fs.readFileSync(gpath);
    const g = mod.unpack(graw.subarray(6, graw.length - 1));
    const gv = (label) => { const q = glob.params.find((x) => x.label === label); const v = { ...q, ...(q.dynamic?.(g, {}) || {}) }; return v.options ? v.options.find(([x]) => x === readParam(g, v))[1] : readParam(g, v); };
    assert.equal(gv('Memory allocation'), '100PROG/100COMBI/4400SEQ');
    assert.equal(gv('1 Sound'), '00 Kick 1', 'kit 1 instrument 1');
    assert.equal(gv('Scale type'), 'Equal Temp');
  }
});

test('MIDI channels pages: every column names parameters that exist in each part', async () => {
  for (const id of ['korg-m1', 'roland-jv2080']) {
    const def = (await import(`../js/devices/defs/${id}.js`)).default;
    for (const obj of def.objects.filter((o) => o.multi)) {
      const m = obj.multi;
      const n = typeof m.count === 'function' ? m.count(obj.init(), {}) : m.count;
      for (let i = 0; i < n; i++) {
        for (const col of m.columns) {
          for (const label of col.params) {
            assert.ok(obj.params.some((p) => p.section === m.section(i) && p.label === label), `${id} ${obj.key} part ${i + 1}: ${label}`);
          }
        }
      }
      if (m.mode) assert.ok(obj.params.some((p) => p.label === m.mode.param), `${id} mode parameter`);
    }
  }
});
