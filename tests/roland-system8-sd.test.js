// Roland SYSTEM-8 SD-card files (js/devices/defs/roland-system8-sd.js): the file container and its checksums, the
// SysEx <-> internal conversion (byte for byte against Roland's own factory bank when the files are on this PC),
// the .s8p / .s8f / backup files and the OS's own checks, writing into the card's folders, the page action against
// the simulator, the MIDI bank keep (the OS's save rule in the simulator) and the Head Library PLUG-OUT install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import S8, { _test as T, setName } from '../js/devices/defs/roland-system8.js';
import * as SD from '../js/devices/defs/roland-system8-sd.js';
import * as I from '../js/devices/defs/roland-system8-install.js';
import * as M from '../js/devices/defs/roland-system8-mem.js';
import { fitFor } from '../js/devices/generic/sendto.js';
import { toBase64 } from '../js/core/mainlib/format.js';
import { buildContainer, device, FAST } from './roland-system8-fixtures.js';

const FACTORY = 're/system8/soundbank/sb/S8_V120_Pat.s8p';
const PRESETS = 'C:/Program Files/Common Files/VST3/Roland/SYSTEM-8/Patch/2 Preset.bin';
const BACKUP = 're/system8/backup/20261127-flag0-after';
const obj = (k) => S8.objects.find((o) => o.key === k);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test('CRC32 and the file container: header, chunk headers and data checksums as the OS writes them', () => {
  assert.equal(SD.crc32(Uint8Array.from('123456789', (c) => c.charCodeAt(0))), 0xcbf43926);
  const f = SD.buildFile('S8P ', [{ tag: 'NAME', count: 2, size: 16, data: new Uint8Array(32).fill(65) }]);
  assert.equal(f.length, 0x30 + 0x20 + 32);
  const r = SD.readFile(f);
  assert.deepEqual([r.magic, r.problems, r.chunks.length, r.chunks[0].tag, r.chunks[0].count, r.chunks[0].crcOk], ['S8P ', [], 1, 'NAME', 2, true]);
  assert.equal(String.fromCharCode(...f.subarray(0x10, 0x20)), ' '.repeat(16));
  const bad = Uint8Array.from(f); bad[0x30 + 0x20 + 3] ^= 1;
  assert.match(SD.osCheck(bad, 'patch').join(), /data checksum/);
  const bad2 = Uint8Array.from(f); bad2[0x30 + 8] ^= 1;
  assert.match(SD.readFile(bad2).problems.join(), /chunk 0 header checksum/);
});

test('internal structs: the OS catalog groups give PAT 512, PAT2 2200, PAT3 14096, PRF 1744; every byte of a sound and of a performance is one word', () => {
  assert.deepEqual([SD.MAP.PAT.size, SD.MAP.PAT2.size, SD.MAP.PAT3.size, SD.MAP.PRF.size], [0x200, 0x898, 0x3710, 0x6d0]);
  const cover = (maps, size) => { const seen = new Uint8Array(size); for (const m of maps) for (const r of m.rows) for (let k = 0; k < (r.n === 1 ? 1 : r.n); k++) seen[r.c + k]++; return seen; };
  const s = cover([SD.MAP.PAT, SD.MAP.PAT2, SD.MAP.PAT3], M.FULL_SIZE);
  assert.ok(s.every((x) => x === 1), 'each sound byte once');
  const p = cover([SD.MAP.PRF], M.S_PERF.size);
  assert.ok(p.every((x) => x === 1), 'each performance byte once');
  // round trips: the editor defaults, and every word at a value of its own
  const d = T.initPatch();
  assert.ok(eq(SD.internalToSound(SD.soundToInternal(d)), d));
  const v = Uint8Array.from(d);
  for (const m of [SD.MAP.PAT, SD.MAP.PAT2, SD.MAP.PAT3]) for (const [k, r] of m.rows.entries()) { if (r.n === 1) v[r.c] = (k * 37) & 0x7f; else for (let i = 0; i < r.n; i++) v[r.c + i] = (k + i * 5) & 15; }
  assert.ok(eq(SD.internalToSound(SD.soundToInternal(v)), v), 'any raw value survives');
  const pf = T.initPerf();
  assert.ok(eq(SD.internalToPerf(SD.perfToInternal(pf)), pf));
  // a biased value: chord memory note NONE (raw 0) is -1 in the OS's word, a signed 8-nibble word stays its pattern
  const chord = T.PARAMS.find((x) => /CHORD MEMORY Note \(voice 1\)/.test(x.osLabel || ''));
  const row = SD.MAP.PAT2.rows.find((r) => r.c === chord.offset);
  assert.equal(row.bias, 1);
});

test('Roland factory bank S8_V120_Pat.s8p (when present): passes the OS checks, reads and rebuilds byte for byte', { skip: !fs.existsSync(FACTORY) }, () => {
  const sb = fs.readFileSync(FACTORY);
  assert.deepEqual(SD.osCheck(sb, 'patch'), []);
  const items = SD.readPatchFile(sb, T.initPatch());
  assert.equal(items.length, 64);
  assert.equal(items[0].name, 'KY FM Chorus EP');
  assert.deepEqual(items[0].engine, { model: 5, version: 0x120, name: 'SYSTEM-8' });
  const again = SD.patchFile(items.map((x) => ({ data: x.data, engine: x.engine })));
  assert.ok(eq(again, sb), 'rebuilt byte for byte');
});

test('the plugin preset bank (SysEx layout) converts to the factory .s8p entries byte for byte (when both are present)', { skip: !fs.existsSync(FACTORY) || !fs.existsSync(PRESETS) }, () => {
  const kb = fs.readFileSync(PRESETS);
  const rec = 16 + 12 + M.FULL_SIZE;
  const byName = new Map();
  for (let i = 0; 26 + (i + 1) * rec <= kb.length; i++) byName.set(String.fromCharCode(...kb.subarray(26 + i * rec, 26 + i * rec + 16)).trimEnd(), kb.subarray(26 + i * rec + 28, 26 + (i + 1) * rec));
  const f = SD.readFile(fs.readFileSync(FACTORY));
  const pats = f.chunks.find((c) => c.tag === 'PATs').data;
  const names = f.chunks.find((c) => c.tag === 'NAME').data;
  let same = 0;
  for (let i = 0; i < 64; i++) {
    const sx = byName.get(String.fromCharCode(...names.subarray(i * 16, i * 16 + 16)).trimEnd());
    if (sx && eq(SD.soundToInternal(sx), pats.subarray(i * SD.PATS, (i + 1) * SD.PATS))) same++;
  }
  assert.equal(same, 64);
});

test('a backup the SYSTEM-8 wrote itself (sys8_bak.bin, when present): the OS checks pass, all seven chunks read', { skip: !fs.existsSync('re/system8/sdcard-user/sys8_bak.bin') }, () => {
  const b = fs.readFileSync('re/system8/sdcard-user/sys8_bak.bin');
  assert.deepEqual(SD.osCheck(b, 'backup'), []);
  const f = SD.readFile(b);
  assert.deepEqual(f.chunks.map((c) => [c.tag, c.count, c.size]), [['SYS ', 1, 2196], ['PRF ', 64, 1744], ['PAT ', 256, 512], ['PAT2', 256, 2200], ['PAT3', 256, 14096], ['TMOD', 8, 3360], ['PLG ', 4, 32]]);
  const plg = f.chunks.at(-1).data;
  assert.deepEqual([plg[0], plg[2] | (plg[3] << 8)], [5, 0x120], 'slot 0: SYSTEM-8 1.20, as plgRecord writes it');
  assert.ok(eq(plg.subarray(0, 32), SD.plgRecord(SD.MODEL_SYSTEM8)));
  const r = SD.readBackupFile(b, { soundInit: T.initPatch(), perfInit: T.initPerf() });
  assert.equal(r.sounds.length, 256);
  // every patch of the unit's backup goes back to the same internal words
  const pat = f.chunks[2].data;
  assert.ok(r.sounds.every((d, i) => eq(SD.soundToInternal(d).subarray(0, 512), pat.subarray(i * 512, (i + 1) * 512))));
});

test('the unit backup (when present): a bank as .s8p reads back to the same 64 patches', { skip: !fs.existsSync(`${BACKUP}/slot0.syx`) }, () => {
  const b = I.bankOf(I._test.splitter(fs.readFileSync(`${BACKUP}/slot0.syx`)));
  assert.equal(b.slot, 0);
  const file = SD.patchFile(b.patches.map((data) => ({ data, engine: SD.MODEL_SYSTEM8 })));
  assert.deepEqual(SD.osCheck(file, 'patch'), []);
  const back = SD.readPatchFile(file);
  assert.ok(back.every((x, i) => eq(x.data, b.patches[i])));
  assert.equal(back[0].name, 'Ctrl Alt Future');
});

test('.s8f: each performance with the two patches its parts point at; backup: PRF and PAT chunks the restore takes', () => {
  const perf = T.initPerf();
  const parts = obj('performance').params;
  const set = (key, v) => { const p = parts.find((x) => x.key === key); const raw = v + (p.bias ?? 0); if (p.nibbles) for (let i = 0; i < p.nibbles; i++) perf[p.offset + i] = (raw >> (4 * (p.nibbles - 1 - i))) & 15; else perf[p.offset] = raw; };
  set('up_part_slot', 2); set('up_part_memory', 9); set('lw_part_slot', 0); set('lw_part_memory', 63);
  assert.deepEqual(SD.partsOf(perf), [{ slot: 2, patch: 9 }, { slot: 0, patch: 63 }]);
  const up = T.initPatch(); setName(up, 'UPPER ONE'); const lw = T.initPatch(); setName(lw, 'LOWER ONE');
  const f = SD.perfFile([{ perf, upper: up, lower: lw }]);
  assert.deepEqual(SD.osCheck(f, 'perform'), []);
  const r = SD.readPerfFile(f)[0];
  assert.equal(r.name, 'INIT PERFORM');
  assert.ok(eq(r.perf, perf) && eq(r.upper, up) && eq(r.lower, lw));
  const sounds = Array.from({ length: 256 }, (_, i) => { const d = T.initPatch(); setName(d, `P${i}`); return d; });
  const bak = SD.backupFile({ sounds, perfs: Array.from({ length: 64 }, () => perf) });
  assert.deepEqual(SD.osCheck(bak, 'backup'), []);
  const rb = SD.readBackupFile(bak);
  assert.deepEqual(rb.tags, ['PRF ', 'PAT ', 'PAT2', 'PAT3']);
  assert.ok(rb.sounds.every((d, i) => eq(d, sounds[i])) && eq(rb.perfs[5], perf));
  assert.throws(() => SD.backupFile({ sounds: sounds.slice(1) }), /256/);
  // a chunk out of order is what the s8p reader (it seeks by position) would misread
  const p1 = SD.patchFile([{ data: up, engine: SD.MODEL_SYSTEM8 }]);
  const ch = SD.readFile(p1).chunks;
  const swapped = SD.buildFile('S8P ', [ch[1], ch[0], ch[2]].map((c) => ({ tag: c.tag, count: c.count, size: c.size, data: c.data })));
  assert.match(SD.osCheck(swapped, 'patch').join(), /the reader expects "NAME"/);
});

test('card names and the folders on the card (a picked card, its SYSTEM-8 folder, a file there, no folder access)', async () => {
  assert.equal(SD.cardName('Ctrl Alt Future!', 'patch'), 'Ctrl_Alt_Fut.s8p');
  assert.equal(SD.cardName('', 'backup'), 'sys8_bak.bin');
  const fsMock = () => {
    const files = new Map();
    const dir = (name, path) => ({
      name,
      getDirectoryHandle: async (n) => dir(n, `${path}${n}/`),
      getFileHandle: async (n, o = {}) => {
        const k = `${path}${n}`;
        if (!files.has(k) && !o.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        if (!files.has(k)) files.set(k, null);
        return { createWritable: async () => ({ write: async (b) => files.set(k, Uint8Array.from(b)), close: async () => {} }) };
      },
    });
    return { files, root: (name = 'SDCARD') => dir(name, '') };
  };
  const m = fsMock();
  const r = await SD.saveToCard('patch', 'a.s8p', Uint8Array.of(1, 2), { pick: async () => m.root() });
  assert.equal(r.path, 'ROLAND/SYSTEM-8/EXPORT/PATCH/a.s8p');
  assert.ok(m.files.has('ROLAND/SYSTEM-8/EXPORT/PATCH/a.s8p'));
  await SD.saveToCard('backup', 'b.bin', Uint8Array.of(3), { pick: async () => m.root('SYSTEM-8') });
  assert.ok(m.files.has('BACKUP/b.bin'), 'a picked SYSTEM-8 folder is used as it is');
  assert.equal(await SD.saveToCard('patch', 'a.s8p', Uint8Array.of(9), { pick: async () => m.root(), confirm: async () => false }), null, 'an existing file is kept unless replaced');
  const dl = [];
  const d = await SD.saveToCard('perform', 'c.s8f', Uint8Array.of(4), { pick: null, download: (b, n) => dl.push(n) });
  assert.ok(d.downloaded && dl[0] === 'c.s8f');
});

/** The simulated unit with a card folder, connected. */
function unit() {
  const dv = device();
  const written = new Map();
  const dir = (name, path) => ({ name, getDirectoryHandle: async (n) => dir(n, `${path}${n}/`), getFileHandle: async (n, o = {}) => { const k = `${path}${n}`; if (!written.has(k) && !o.create) throw new Error('none'); return { createWritable: async () => ({ write: async (b) => written.set(k, Uint8Array.from(b)), close: async () => {} }) }; } });
  dv.g.connected = true;
  dv.pick = async () => dir('SD', '');
  dv.written = written;
  return dv;
}

test('Save to SD card (simulator): the SYSTEM-8 bank read from the unit, a PLUG-OUT bank, a performance with its patches; no RESTORE file offered', async () => {
  const u = unit();
  const { api, choices, sim } = u;
  const engines = [{ model: 7, version: 0x107, name: 'JUNO-106' }];
  // the 64 SYSTEM-8 patches
  choices.form = { what: 'read:0', name: 'MyBank' };
  const r = await SD.saveAction(api, { page: 'patch', engines, initSound: T.initPatch, pick: u.pick });
  assert.ok(r, u.errors.map((e) => e.message).join());
  assert.equal(r.path, 'ROLAND/SYSTEM-8/EXPORT/PATCH/MyBank.s8p');
  const pats = SD.readPatchFile(u.written.get(r.path));
  assert.equal(pats.length, 64);
  assert.equal(pats[9].name, 'SYSTEM-8 B-2');
  assert.deepEqual(pats[0].engine, SD.MODEL_SYSTEM8);
  // a PLUG-OUT 3 bank: the engine is the slot's (JUNO-106 1.07 in the simulator)
  choices.form = { what: 'read:3', name: '', engine: '' };
  const r3 = await SD.saveAction(api, { page: 'plugout', engines, initSound: T.initPatch, pick: u.pick });
  assert.deepEqual(SD.readPatchFile(u.written.get(r3.path))[0].engine, { model: 7, version: 0x107, name: 'JUNO-106' });
  // the performance on the page, with the two patches its parts play
  const perf = T.initPerf();
  const P = (k) => obj('performance').params.find((x) => x.key === k);
  perf[P('up_part_slot').offset] = 3; perf[P('up_part_memory').offset] = 4;
  api.data = perf;
  choices.form = { what: 'perf', name: '' };
  const rp = await SD.saveAction(api, { page: 'performance', engines, initSound: T.initPatch, pick: u.pick });
  assert.equal(rp.path, 'ROLAND/SYSTEM-8/EXPORT/PERFORM/INIT_PERFORM.s8f');
  const e = SD.readPerfFile(u.written.get(rp.path))[0];
  assert.equal(e.upper[0x80] * 16 + e.upper[0x81], 'P'.charCodeAt(0));
  assert.ok(SD.readPerfFile(u.written.get(rp.path)).length === 1);
  // no RESTORE choice (untested on the unit)
  let offered = null;
  choices.form = null;
  const form = api.form;
  api.form = async (_t, fields) => { offered = fields[0].options.map((o) => o.value); return null; };
  await SD.saveAction(api, { page: 'patch', engines, initSound: T.initPatch, pick: u.pick });
  api.form = form;
  assert.deepEqual(offered, ['page', 'read:0']);
  void sim;
});

test('keepBank against the simulator modelling the OS code (the receive screen did not open on the unit, 2026-11-27): the markers around the 64 patches save the bank; a write into another slot stops it', async () => {
  const { g, sim, api } = device();
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const nameAddr = M.slotPatchAddr(0, 5) + 0x80;
  const rename = (addr, text) => sim.handle(Uint8Array.from(M.dt1(addr, [...text.padEnd(16)].flatMap((c) => [c.charCodeAt(0) >> 4, c.charCodeAt(0) & 15]))));
  const nameAt = (addr) => { let s = ''; for (let i = 0; i < 16; i++) s += String.fromCharCode((sim.state.mem.get(addr + 2 * i) << 4) | sim.state.mem.get(addr + 2 * i + 1)); return s.trimEnd(); };
  const keep = (slot) => startTransfer(g, { title: 'Keep', run: (io) => I.keepBank(io, slot, { listen: (fn) => g.transport.on('sysex', fn), wait: 0, sleep: async () => {}, readTimeout: 500 }) });
  // a plain Store is lost at power-off
  rename(nameAddr, 'STORED ONLY');
  sim.state.powerCycle();
  assert.equal(nameAt(nameAddr), 'SYSTEM-8 A-6');
  // Store, then keep the bank: saved
  rename(nameAddr, 'KEPT');
  const r = await keep(0);
  assert.ok(r);
  assert.equal(r.messages, 64 * 96 + 2);
  assert.deepEqual(sim.state.saves, [0]);
  sim.state.powerCycle();
  assert.equal(nameAt(nameAddr), 'KEPT');
  // a write into PLUG-OUT 1 since the last save: the OS refuses to save the SYSTEM-8 bank
  rename(M.slotPatchAddr(1, 0) + 0x80, 'OTHER SLOT');
  rename(nameAddr, 'NOT KEPT');
  await keep(0);
  assert.deepEqual(sim.state.refused.at(-1), { slots: [0, 1], count: 65, expected: 64 });
  sim.state.powerCycle();
  assert.equal(nameAt(nameAddr), 'KEPT');
  assert.ok(api);
});

test('Head Library PLUG-OUTs: a container row no longer loads as a patch; "Install a PLUG-OUT from the Head Library" installs it', async () => {
  const { g, sim, api, choices } = device();
  const row = { sub: 's1', subName: 'PlugOuts', id: 'p1', name: 'JUNO-106 1.07 for PLUG-OUT 3', kind: 'plugout', device: 'roland-system8', native: true };
  assert.equal(fitFor(g, row), null, 'the PLUG-OUT patch object takes kind plugoutpatch, not the containers');
  assert.equal(fitFor(g, { ...row, kind: 'plugoutpatch' })?.obj.key, 'plugoutpatch');
  const cont = buildContainer({ slot: 3 });
  g.host.shell = { mainLibrary: async () => ({ allRows: async () => [row, { ...row, id: 'x', kind: 'patch', name: 'a patch' }], getPatch: async () => ({ name: row.name, notes: '', native: { object: 'plugout-container', bytes: toBase64(cont) } }) }) };
  sim.state.slots[3] = { model: 0xffff, version: 0, name: '' };
  const forms = [{ row: '0' }, { slot: '3', bank: '' }];
  Object.defineProperty(choices, 'form', { get: () => forms.shift() });
  const r = await I.installFromHeadLibraryAction(api, FAST);
  assert.ok(r);
  assert.deepEqual(sim.state.slots[3], { model: 7, version: 0x107, name: 'JUNO-106' });
  g.host.shell = { mainLibrary: async () => ({ allRows: async () => [] }) };
  await assert.rejects(I.installFromHeadLibraryAction(api, FAST), /no SYSTEM-8 PLUG-OUT files/);
});

test('the pages offer Save to SD card (and the Head Library install on the PLUG-OUT page)', () => {
  assert.deepEqual(obj('patch').actions.map((a) => a.label), ['Save to SD card...']);
  assert.deepEqual(obj('plugoutpatch').actions.map((a) => a.label), ['Install a PLUG-OUT from the Head Library...', 'Save to SD card...', 'Back up a PLUG-OUT slot...', 'Show the PLUG-OUT slots']);
  assert.deepEqual(obj('performance').actions.map((a) => a.label), ['Save to SD card...']);
  for (const k of ['patch', 'plugoutpatch', 'performance']) assert.match(obj(k).slots.note(), /only until it is switched off: to keep a patch or performance, select it on the unit and press WRITE/);
  assert.match(SD.UNIT_STEPS.patch, /UTILITY > IMPORT/);
  assert.match(SD.UNIT_STEPS.patch, /one patch into the edit buffer only/);
});
