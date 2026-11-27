// Roland SYSTEM-8 PLUG-OUT containers and their install (js/devices/defs/roland-system8-install.js): the container
// format, the Branch Library identity, the install protocol against the simulator (the OS handler's behaviour),
// flow control, a missing reply, a refused record, Stop, the patch bank, and a slot backup restored byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import S8 from '../js/devices/defs/roland-system8.js';
import * as I from '../js/devices/defs/roland-system8-install.js';
import * as M from '../js/devices/defs/roland-system8-mem.js';
import { FAST, buildContainer, device, addr, sentTo } from './roland-system8-fixtures.js';

const JUNO = 're/system8/plugins/JUNO-106/Script/Code8_3.Dat';

test('container: header, records, image sum, regions, the slot it is built for', () => {
  const c = I.readContainer(buildContainer({ slot: 2 }));
  assert.equal(c.name, 'JUNO-106');
  assert.deepEqual([c.model, c.versionText, c.slot, c.count], [7, '1.07', 2, 4096]);
  assert.deepEqual(c.syn, { name: 'JUNO-106', model: 7, version: 0x107 });
  assert.ok(c.dataBlocks >= 2 && c.dataBlocks + c.fillBlocks === 4096);
  assert.equal(I.identify(buildContainer({ slot: 2 }), 'Code8_2.Dat').name, 'JUNO-106 1.07 for PLUG-OUT 2');
  // not a container, a damaged one, mixed slots, slot 0
  assert.equal(I.identify(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 'x.dat'), null);
  assert.equal(I.identify(new Uint8Array(4096), 'Code8_1.Dat'), null);
  const bad = buildContainer({ slot: 1 });
  bad[0xc0 + 40] ^= 0x10; // one byte of record 0 (a flash block) (the chained XOR spreads it over two words)
  assert.throws(() => I.readContainer(bad), /damaged/);
  assert.throws(() => I.readContainer(buildContainer({ slot: 1, slot1: 2 })), /without a slot/);
  assert.throws(() => I.identify(buildContainer({ slot: 0 }), 'Code8_0.Dat'), /slot 0/);
});

test('the Roland Cloud containers on this PC (when present): identity, slot of each build, SYSTEM-1 builds refused', { skip: !fs.existsSync(JUNO) }, () => {
  const c = I.readContainer(fs.readFileSync(JUNO));
  assert.deepEqual([c.name, c.model, c.versionText, c.slot, c.dataBlocks], ['JUNO-106', 7, '1.07', 3, 647]);
  for (const s of [1, 2]) assert.equal(I.readContainer(fs.readFileSync(`re/system8/plugins/JUNO-106/Script/Code8_${s}.Dat`)).slot, s);
  if (fs.existsSync('re/system8/plugins/JX-3P/Script/Code1.Dat')) assert.throws(() => I.readContainer(fs.readFileSync('re/system8/plugins/JX-3P/Script/Code1.Dat')), /SYSTEM-1/);
  if (fs.existsSync('re/system8/plugins/SYSTEM-1/Script/Code1.Dat')) assert.throws(() => I.readContainer(fs.readFileSync('re/system8/plugins/SYSTEM-1/Script/Code1.Dat')), /not a PLUG-OUT install/);
});

test('def.files: a PLUG-OUT container kind with Install and Back up actions over SYSTEM-8 CTRL', () => {
  const k = S8.files.find((f) => f.kind === 'plugout');
  assert.ok(k && /\.dat/i.test(k.accept));
  assert.deepEqual(k.actions.map((a) => [a.label, a.needs]), [['Install...', 'sysex'], ['Back up this slot', 'sysex']]);
  assert.equal(k.identify(buildContainer({ slot: 3 }), 'Code8_3.Dat').name, 'JUNO-106 1.07 for PLUG-OUT 3');
});

test('install: START, records with flow control every 32 (the OS record counter checked), END, the slot record', async () => {
  const { g, sim, sent } = device();
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const c = I.readContainer(buildContainer({ name: 'JX-3P', model: 8, version: 0x101, slot: 3 }));
  const r = await startTransfer(g, { title: 'Install', run: (io) => I.installPlugout(io, c, 3, { listen: (fn) => g.transport.on('sysex', fn), sendRaw: g.transport.send, ...FAST }) });
  assert.ok(r, 'the install finished');
  assert.deepEqual([r.info.name, r.info.model, I.versionText(r.info.version)], ['JX-3P', 8, '1.01']);
  assert.equal(r.flows.length, 4096 / 32);
  assert.ok(r.flows.every((n, k) => n === 32 * k + 31), 'the counter equals the records sent');
  assert.deepEqual(sim.state.slots[3], { model: 8, version: 0x101, name: 'JX-3P' });
  // the order on the wire: START [slot 3], 31 records, flow, 32 records, flow ..., END
  const plug = sent.filter((m) => (addr(m) >>> 21) === 0x70);
  assert.deepEqual(Array.from(plug[0]), M.dt1(I.ADDR.start, [3]));
  assert.equal(addr(plug[32]), I.ADDR.flow);
  assert.equal(addr(plug[65]), I.ADDR.flow);
  assert.equal(sentTo(sent, I.ADDR.flow).length, 128);
  assert.equal(sentTo(sent, I.ADDR.end).length, 1);
  assert.equal(sentTo(sent, I.ADDR.abort).length, 0);
  assert.equal(g.job, null);
});

test('install: a missing flow-control reply stops at once (power-cycle message, no retry, the slot kept)', async () => {
  const { g, sim, sent, errors } = device();
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const c = I.readContainer(buildContainer({ slot: 3, name: 'JX-3P', model: 8, version: 0x101 }));
  sim.state.hangAfter = 63;
  const r = await startTransfer(g, { title: 'Install', run: (io) => I.installPlugout(io, c, 3, { listen: (fn) => g.transport.on('sysex', fn), sendRaw: g.transport.send, ...FAST }) });
  assert.equal(r, null);
  assert.match(errors[0].message, /the SYSTEM-8 did not answer: power-cycle it, then install again/);
  assert.equal(sentTo(sent, I.ADDR.flow).length, 2, 'no second try');
  assert.equal(sent.filter((m) => (addr(m) & ~0x7f) === I.ADDR.data || (addr(m) & ~0x7f) === I.ADDR.fill).length, 63, 'nothing after the unanswered query');
  assert.equal(sentTo(sent, I.ADDR.end).length, 0);
  assert.equal(sentTo(sent, I.ADDR.abort).length, 1, 'the transfer is dropped on the unit');
  assert.deepEqual(sim.state.slots[3], { model: 7, version: 0x107, name: 'JUNO-106' }, 'the slot keeps its PLUG-OUT');
});

test('install: a refused record, a wrong slot, START codes, and Stop', async () => {
  const { g, sim, sent, errors } = device();
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const c3 = I.readContainer(buildContainer({ slot: 3 }));
  const run = (c, slot, extra = {}) => startTransfer(g, { title: 'Install', run: (io) => I.installPlugout(io, c, slot, { listen: (fn) => g.transport.on('sysex', fn), sendRaw: g.transport.send, ...FAST, ...extra }) });
  sim.state.refuseAt = 40;
  assert.equal(await run(c3, 3), null);
  assert.match(errors.at(-1).message, /refused record/);
  sim.state.refuseAt = null;
  assert.equal(await run(c3, 2), null);
  assert.match(errors.at(-1).message, /built for PLUG-OUT 3/);
  assert.match(I.installProblem(c3, 1, null), /built for PLUG-OUT 3/);
  // the same PLUG-OUT in another slot (Roland's plugin refuses it too), an old OS
  const unit = { os: 0x132, slots: S8.simulate().state.slots.map((s, slot) => ({ slot, ...s, empty: false })) };
  assert.equal(I.installProblem(c3, 3, unit), null);
  const sh = I.readContainer(buildContainer({ name: 'SH-101', model: 1, version: 0x107, slot: 3 }));
  assert.match(I.installProblem(sh, 3, unit), /already in PLUG-OUT 2/);
  assert.match(I.installProblem(c3, 3, { ...unit, os: 0x130 }), /OS 1.30/);
  // START answered 64h: an earlier transfer was still running
  sim.handle(Uint8Array.from(M.dt1(I.ADDR.start, [3])));
  assert.equal(await run(c3, 3), null);
  assert.match(errors.at(-1).message, /code 64h/);
  // Stop: the job ends at once and the unit is told to drop the transfer
  const before = sentTo(sent, I.ADDR.abort).length;
  const p = run(c3, 3, { rate: 20000 });
  setTimeout(() => g.job.stop(), 50);
  assert.equal(await p, null);
  assert.equal(sentTo(sent, I.ADDR.abort).length, before + 1);
  assert.equal(sim.state.xfer.mode, 0);
  assert.deepEqual(sim.state.slots[3], { model: 7, version: 0x107, name: 'JUNO-106' });
});

test('backup of a slot (container + 64 patches) and install with that patch bank: slot memory restored byte for byte', async () => {
  const { g, sim, entries, api, choices, toasts } = device();
  // a recognisable patch bank in slot 3
  const orig = new Map();
  for (let p = 0; p < 64; p++) M.slotBases(3, p).forEach((b, k) => M.FULL[k].leaves.forEach(([o, n]) => { for (let i = 0; i < n; i++) { const a = b + o + i; sim.state.mem.set(a, (p * 7 + k * 3 + i) & 0x7f); orig.set(a, sim.state.mem.get(a)); } }));
  const cont = buildContainer({ slot: 3 });
  await g.host.library.put({ device: 'roland-system8', name: 'JUNO-106 1.07 for PLUG-OUT 3', bytes: cont, kind: 'plugout', notes: I.identify(cont).notes });
  const b = await I.backupAction(api, 3, { timeout: 500 });
  assert.ok(b && b.container, toasts.join(' / '));
  const bank = entries.find((e) => /\(64 patches\)/.test(e.name));
  assert.ok(bank, 'the patches entry');
  assert.equal(I.backupOf(bank.notes).model, 7);
  const src = I.bankSources(await g.host.library.list('roland-system8'), I._test.splitter);
  assert.equal(src.length, 1);
  assert.equal(src[0].slot, 3);
  // the slot's memory gets lost (another PLUG-OUT's bank), then the install writes the backup back
  for (const a of orig.keys()) sim.state.mem.set(a, 0);
  choices.form = { slot: '3', bank: '0' };
  const r = await I.installAction(api, entries.find((e) => e.kind === 'plugout'), FAST);
  assert.ok(r, 'installed');
  assert.equal(r.bank, 64 * 96 + 2);
  assert.deepEqual(sim.state.banks, [[1, 64], [2, 0]], 'the patch-bank brackets as Roland sends them');
  let diff = 0;
  for (const [a, v] of orig) if (sim.state.mem.get(a) !== v) diff++;
  assert.equal(diff, 0, 'every byte of the 64 patches restored');
  // a container built for another slot is refused before anything is sent
  choices.form = { slot: '2', bank: '' };
  await assert.rejects(I.installAction(api, entries.find((e) => e.kind === 'plugout'), FAST), /built for PLUG-OUT 3/);
});

test('the Roland JUNO-106 1.07 container installs into slot 3 of the simulator (when present)', { skip: !fs.existsSync(JUNO) }, async () => {
  const { g, sim, sent } = device();
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const c = I.readContainer(fs.readFileSync(JUNO));
  sim.state.slots[3] = { model: 0xffff, version: 0, name: '' };
  const r = await startTransfer(g, { title: 'Install', run: (io) => I.installPlugout(io, c, 3, { listen: (fn) => g.transport.on('sysex', fn), sendRaw: g.transport.send, ...FAST }) });
  assert.ok(r);
  assert.deepEqual(sim.state.slots[3], { model: 7, version: 0x107, name: 'JUNO-106' });
  assert.equal(sent.filter((m) => (addr(m) >>> 21) === 0x70).length, 1 + 4096 + 128 + 1 + 1);
});
