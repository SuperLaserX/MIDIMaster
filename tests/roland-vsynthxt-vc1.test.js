// Roland V-Synth XT, VC-1 engine (D-50): tables from the firmware, the factory patches kept in the
// image (when re/vsynthxt/img is present), D-50 SysEx dumps in and out, and the translator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import def, { _test, MODEL, A3, memoryPatch, patchNo, nameOf, toneName, pOf, PATCH_SIZE, REVERB } from '../js/devices/defs/roland-vsynthxt-vc1.js';
import { RANGES, LISTS, CHARSET, INIT, PRESETS } from '../js/devices/defs/roland-vsynthxt-vc1-fw.js';
import { readParam, writeParam, formatParam } from '../js/core/model/memmap.js';
import { dt1Chunks, intToAddr, checksum } from '../js/core/midi/roland.js';
import { getDevice } from '../js/devices/registry.js';
import { patchFromObject, objectFromPatch, loadMode } from '../js/devices/patches.js';
import { importFiles } from '../js/core/mainlib/importers.js';

const IMG = new URL('../re/vsynthxt/img/os.3.40001C.bin', import.meta.url);
const has = (u) => fs.existsSync(u);
const patch = def.objects[0];
const show = (p, d) => { const v = readParam(d, p); return p.options ? p.options.find(([x]) => x === v)?.[1] : formatParam(p, v); };
const presets = () => {
  const b = fs.readFileSync(IMG);
  return Array.from({ length: PRESETS.count }, (_, k) => new Uint8Array(b.subarray(PRESETS.offset + k * PATCH_SIZE, PRESETS.offset + (k + 1) * PATCH_SIZE)));
};
/** A D-50 style bulk dump: 256-byte DT1 packets from 02 00 00 over 64 patches. */
const bankDump = (patches, dev = 0, cmd = 0x12) => {
  const all = new Uint8Array(64 * PATCH_SIZE);
  patches.forEach((p, i) => all.set(p, i * PATCH_SIZE));
  const msgs = dt1Chunks(MODEL, dev, intToAddr(A3('02 00 00'), 3), all, 256);
  if (cmd !== 0x12) for (const m of msgs) m[4] = cmd;
  return msgs;
};

test('VC-1: tables and address map from the firmware', () => {
  assert.ok(getDevice('roland-vsynth-xt-vc1'), 'in the catalog (catalog-extra.js)');
  assert.equal(CHARSET.length, 64);
  assert.equal(INIT.length, PATCH_SIZE);
  assert.equal(nameOf(Uint8Array.from(INIT)), 'Initial patch');
  // every D-50 parameter of the seven blocks: 54 per partial, 38 common, 28 patch (incl. 6 VC-1 bytes)
  const per = (blk) => patch.params.filter((p) => p.block === blk).length;
  assert.deepEqual(['u1', 'u2', 'uc', 'l1', 'l2', 'lc', 'pt'].map(per), [54, 54, 38, 54, 54, 38, 28]);
  const offs = (blk) => patch.params.filter((p) => p.block === blk).map((p) => p.offset % 64).sort((a, b) => a - b);
  assert.deepEqual(offs('u1'), Array.from({ length: 0x36 }, (_, i) => i), 'partial 00h-35h, nothing left out');
  assert.deepEqual(offs('uc'), Array.from({ length: 0x30 - 0x0a }, (_, i) => i + 0x0a), 'common 0Ah-2Fh after the 10-character name');
  assert.deepEqual(offs('pt'), Array.from({ length: 0x2e - 0x12 }, (_, i) => i + 0x12), 'patch 12h-2Dh after the 18-character name');
  for (const p of patch.params) {
    const [lo, hi] = RANGES[p.offset >= 0x180 ? 'patch' : [0x80, 0x140].includes(p.offset - (p.offset % 64)) ? 'common' : 'partial'][p.offset % 64];
    assert.deepEqual([p.min, p.max], [lo, hi], p.key);
    if (p.options) assert.equal(p.options.length, hi - lo + 1, `${p.key} ${p.name}: one display per value`);
  }
  assert.equal(memoryPatch(0), A3('02 00 00'));
  assert.equal(memoryPatch(1), A3('02 03 40'));
  assert.equal(memoryPatch(63), A3('03 5c 40'));
  assert.equal(REVERB, A3('03 60 00'));
  assert.equal(patchNo(0), '11');
  assert.equal(patchNo(63), '88');
});

test('VC-1: values shown as on the VC-1', () => {
  const d = patch.init();
  const u1 = (n) => pOf('u1', n);
  writeParam(d, u1('WG Pitch Coarse'), 36);
  assert.equal(show(u1('WG Pitch Coarse'), d), 'C4');
  writeParam(d, u1('WG PCM Wave No.'), 76);
  assert.equal(show(u1('WG PCM Wave No.'), d), '77 Loop01');
  assert.equal(LISTS.pcm.length, 128);
  writeParam(d, u1('TVF Bias Point/Dir'), 64);
  assert.equal(show(u1('TVF Bias Point/Dir'), d), '>A1');
  writeParam(d, u1('WG Pitch Keyfollow'), 16);
  assert.equal(show(u1('WG Pitch Keyfollow'), d), 's2');
  assert.equal(pOf('u1', 'TVF Keyfollow').options.length, 15);
  writeParam(d, u1('TVA Bias Level'), 0);
  assert.equal(show(u1('TVA Bias Level'), d), '-12');
  writeParam(d, pOf('uc', 'High EQ Frequency'), 21);
  assert.equal(show(pOf('uc', 'High EQ Frequency'), d), '9.5 kHz');
  writeParam(d, pOf('pt', 'Key Mode'), 7);
  assert.equal(show(pOf('pt', 'Key Mode'), d), 'SPL-LS');
  writeParam(d, pOf('pt', 'MIDI Transmit Bank Select'), 1);
  assert.equal(show(pOf('pt', 'MIDI Transmit Bank Select'), d), '0', 'OFF, then 0-99');
  writeParam(d, pOf('pt', 'MIDI Transmit Channel'), 0);
  assert.equal(show(pOf('pt', 'MIDI Transmit Channel'), d), 'Basic');
  writeParam(d, pOf('pt', 'Partial Select'), 0b0101);
  assert.equal(show(pOf('pt', 'Partial Select'), d), 'L1 U1');
  // a parameter change is one DT1 to the temporary patch
  const p = pOf('lc', 'Chorus Rate');
  writeParam(d, p, 42);
  const m = p.send(42, { deviceId: 0 }, d);
  assert.deepEqual(m.slice(0, 8), [0xf0, 0x41, 0x00, 0x14, 0x12, 0x00, 0x02, 0x40 + 0x2b]);
  assert.equal(m[8], 42);
  assert.equal(m[9], checksum(m.slice(5, 9)));
});

test('VC-1: the factory patches in the image', { skip: !has(IMG) }, () => {
  const all = presets();
  assert.equal(all.length, 384, 'six preset banks of 64');
  assert.deepEqual([nameOf(all[0]), toneName(all[0], true), toneName(all[0], false)], ['Fantasia', 'Fantasynth', 'FantasyPCM']);
  assert.equal(nameOf(all[383]), 'Big Waves');
  for (const [k, d] of all.entries()) {
    for (const p of patch.params) {
      const v = readParam(d, p);
      assert.ok(v >= p.min && v <= p.max, `preset ${k + 1} ${p.key} = ${v}`);
    }
    const c = patch.toCommon(d);
    assert.ok(c.osc.length === 2 && c.extra.family === 'roland-d50');
    const back = patch.fromCommon(c, patch.init());
    assert.ok(back.report.mapped.length > 5, `preset ${k + 1} translates back`);
  }
  // Fantasia: structure, waves and partial types as the screen shows them
  const f = all[0];
  assert.equal(show(pOf('uc', 'Structure'), f), String(readParam(f, pOf('uc', 'Structure')) + 1));
  assert.equal(show(pOf('pt', 'Key Mode'), f), 'DUAL');
});

test('VC-1: D-50 dumps in and out', { skip: !has(IMG) }, async () => {
  const all = presets().slice(0, 64);
  // one-way DT1 bank dump, 256-byte packets across patch boundaries
  const msgs = bankDump(all);
  assert.equal(msgs.length, 112);
  const items = _test.libraryItems(msgs);
  const pats = items.filter((i) => i.object === 'patch');
  assert.equal(pats.length, 64);
  assert.equal(pats[0].name, 'Fantasia');
  assert.equal(pats[63].label, 'Patch 88');
  for (const [i, item] of pats.entries()) assert.deepEqual(patch.fromSyx(item.msgs), all[i], `patch ${patchNo(i)}`);
  // the same dump recorded from a handshake transfer (DAT, 42h)
  const dat = _test.libraryItems(bankDump(all, 0, 0x42)).filter((i) => i.object === 'patch');
  assert.equal(dat.length, 64);
  assert.deepEqual(patch.fromSyx(dat[5].msgs), all[5]);
  // a temporary-patch dump from the editor reads back exactly
  const out = patch.toSyx(all[7], { deviceId: 3 });
  assert.equal(out[0], 0xf0);
  const { splitSysex } = await import('../js/core/midi/describe.js');
  assert.deepEqual(patch.fromSyx(splitSysex(Uint8Array.from(out))), all[7]);
  assert.match(_test.describe(Uint8Array.from(msgs[0])), /^D-50\/VC-1 DT1 02 00 00 patch 11 \(256 bytes\)$/);
  // the Head Library importer files every patch under the VC-1
  const file = Uint8Array.from(msgs.flat());
  const r = await importFiles([{ name: 'D50 bank.syx', bytes: file }]);
  const vc = r.patches.filter((p) => p.device.id === 'roland-vsynth-xt-vc1');
  assert.equal(vc.length, 64);
  assert.equal(vc[0].name, 'Fantasia');
  assert.ok(vc[0].settings['Upper partial 1 / WG Pitch']);
});

test('VC-1: JP-8080, V-Synth and VC-1 patches through the shared model', async () => {
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jpPatch = jp.objects.find((o) => o.key === 'patch');
  const raw = jpPatch.init();
  raw.set([...'BA Test         '].map((c) => c.charCodeAt(0)));
  raw[0x1e] = 5; // OSC1 SAW
  const ml = patchFromObject(getDevice('roland-jp8080'), jp, jpPatch, raw);
  assert.equal(loadMode(getDevice('roland-vsynth-xt-vc1'), def, patch, ml), 'translate');
  const r = objectFromPatch(getDevice('roland-vsynth-xt-vc1'), def, patch, ml);
  assert.equal(nameOf(r.data), 'BA Test');
  assert.equal(show(pOf('u1', 'WG Waveform'), r.data), 'SAW');
  assert.equal(show(pOf('pt', 'Key Mode'), r.data), 'WHOLE');
  for (const p of patch.params) { const v = readParam(r.data, p); assert.ok(v >= p.min && v <= p.max, p.key); }
  // a VC-1 patch into the V-Synth engine
  const vs = (await import('../js/devices/defs/roland-vsynthxt.js')).default;
  const vsPatch = vs.objects.find((o) => o.key === 'patch');
  const src = has(IMG) ? presets()[58] : patch.init(); // "Synth Bass" when the image is there
  const vml = patchFromObject(getDevice('roland-vsynth-xt-vc1'), def, patch, src);
  assert.equal(vml.common.extra.family, 'roland-d50');
  const toVs = objectFromPatch(getDevice('roland-vsynth-xt'), vs, vsPatch, vml);
  assert.equal(toVs.mode, 'translate');
  assert.equal(vsPatch.name(toVs.data), vml.name.slice(0, 12).trim());
  // and the same model restores byte for byte
  const same = objectFromPatch(getDevice('roland-vsynth-xt-vc1'), def, patch, vml);
  assert.deepEqual(same.data, src);
});

test('VC-1: bank files from the XT\'s drive (.P10)', async () => {
  const { P10_SIZE, isP10 } = await import('../js/devices/defs/roland-vsynthxt-vc1.js');
  assert.equal(P10_SIZE, 36944, 'the size of VC1_I1.P10 ... VC1_I8.P10 on the factory drive');
  // date stamp, 64 patches, reverb data 17-32, 64 records of 35 bytes
  const f = new Uint8Array(P10_SIZE);
  f.set([...'2004/03/23 00003'].map((c) => c.charCodeAt(0)));
  for (let i = 0; i < 64; i++) {
    const d = Uint8Array.from(INIT);
    d[0x180] = 1 + (i % 26); // the first letter of the patch name, A-Z in the D-50 character set
    f.set(d, 16 + i * PATCH_SIZE);
  }
  assert.ok(isP10(f));
  const r = await importFiles([{ name: 'VC1_I3.P10', bytes: f }]);
  assert.equal(r.patches.length, 64);
  assert.equal(r.patches[0].device.id, 'roland-vsynth-xt-vc1');
  assert.equal(r.patches[2].name[0], 'C');
  const real = new URL('../re/vsynthxt/live/VC1_I1.P10', import.meta.url);
  const bank = new URL('../re/vsynthxt/live/vc1_bank.bin', import.meta.url);
  if (has(real) && has(bank)) {
    const items = def.readFile('VC1_I1.P10', new Uint8Array(fs.readFileSync(real)));
    const b = fs.readFileSync(bank);
    assert.equal(items[0].label, 'Int1-11');
    assert.deepEqual(Array.from(items[0].data), Array.from(b.subarray(0, PATCH_SIZE)), 'patch 11 as the unit answered it');
  }
});

test('VC-1: bank files written (.P10): the factory files back byte for byte', async () => {
  const { writeP10, splitP10, p10Stamp, P10_RECORD, P10_SIZE } = await import('../js/devices/defs/roland-vsynthxt-vc1.js');
  assert.equal(p10Stamp(new Date(2026, 10, 24)), '2026/11/24 00003');
  // a made-up bank: stamp, patches, reverb, the factory record
  const patches = Array.from({ length: 64 }, (_, i) => { const d = Uint8Array.from(INIT); d[0x180] = 1 + (i % 26); return d; });
  const reverb = Uint8Array.from({ length: 16 * 0x178 }, (_, i) => i % 16);
  const f = writeP10(patches, reverb, { stamp: '2026/11/24 00003' });
  assert.equal(f.length, P10_SIZE);
  const back = splitP10(f);
  assert.equal(back.stamp, '2026/11/24 00003');
  assert.deepEqual(Array.from(back.patches[5]), Array.from(patches[5]));
  assert.deepEqual(Array.from(back.reverb), Array.from(reverb));
  assert.deepEqual(Array.from(back.records.subarray(35, 70)), P10_RECORD);
  assert.throws(() => writeP10(patches.slice(1), reverb));
  for (let n = 1; n <= 8; n++) {
    const u = new URL(`../re/vsynthxt/live/VC1_I${n}.P10`, import.meta.url);
    if (!has(u)) continue;
    const bytes = new Uint8Array(fs.readFileSync(u));
    const s = splitP10(bytes);
    assert.deepEqual(Array.from(writeP10(s.patches, s.reverb, { stamp: s.stamp })), Array.from(bytes), `VC1_I${n}.P10`);
  }
});

test('VC-1: banks by bank select 87/0-13, their names and the selected bank', async () => {
  const { VC1_BANKS, VC1_BANK_NAMES, TEMP, MEMORY } = await import('../js/devices/defs/roland-vsynthxt-vc1.js');
  const { PRESET_NAMES } = await import('../js/devices/defs/roland-vsynthxt-vc1-fw.js');
  const { dt1, addrToInt } = await import('../js/core/midi/roland.js');
  const s = patch.slots;
  assert.deepEqual([VC1_BANKS.length, VC1_BANKS[0], VC1_BANKS[13]], [14, 'Int1', 'Pre6'], 'as the VC-1 shows them');
  assert.deepEqual([VC1_BANK_NAMES[0], VC1_BANK_NAMES[13]], ['Internal 1', 'Preset 6']);
  assert.deepEqual(s.recall(9, 3, { channel: 0 }), [[0xb0, 0, 87], [0xb0, 32, 8], [0xc0, 3]], 'Preset 1, patch 14');
  assert.deepEqual(s.recall(0, 3, { channel: 0 }), [[0xc0, 3]], 'the current bank: program change only');
  assert.equal(s.slotLabel(14, 63), 'Pre6-88');
  assert.equal(s.slotLabel(10, 0), 'Pre2-11');
  assert.equal(PRESET_NAMES.length, 384);
  assert.equal(s.names(10)[0], 'Brass Tacks', 'Pre2-11, as the unit plays it');
  assert.equal(s.names(3), null, 'internal banks: read from the unit');
  // a fake VC-1: 14 banks, bank select + program change select a patch (into the temporary patch),
  // and SysEx patch memory is the selected bank
  const named = (name) => { const d = patch.init(); patch.setName(d, name); return d; };
  const banks = Array.from({ length: 15 }, (_, b) => Array.from({ length: 64 }, (_, i) => named(b >= 9 ? PRESET_NAMES[(b - 9) * 64 + i] : `Int${b} patch ${i}`)));
  const unit = { selected: 10, lsb: 0, temp: patch.init() };
  const midi = (msgs) => {
    for (const m of typeof msgs[0] === 'number' ? [msgs] : msgs) {
      if ((m[0] & 0xf0) === 0xb0 && m[1] === 32) unit.lsb = m[2];
      if ((m[0] & 0xf0) === 0xc0) { unit.selected = unit.lsb + 1; unit.temp = Uint8Array.from(banks[unit.selected][m[1]]); }
    }
  };
  const client = {
    request: async (bytes, { collect }) => {
      const a = addrToInt(Array.from(bytes.slice(5, 8)));
      const size = addrToInt(Array.from(bytes.slice(8, 11)));
      const mem = a >= MEMORY ? (() => { const all = new Uint8Array(64 * PATCH_SIZE); banks[unit.selected].forEach((d, i) => all.set(d, i * PATCH_SIZE)); return all; })() : unit.temp;
      const off = a >= MEMORY ? a - MEMORY : a - TEMP;
      collect({}, Uint8Array.from(dt1(MODEL, 0, intToAddr(a, 3), Array.from(mem.subarray(off, off + size)))));
    },
  };
  const slotNames = {};
  const g = { client, slotNames, setSlotName: (k, b, i, n) => (slotNames[k] ??= new Map()).set(`${b}:${i}`, n), setBusy() {}, error(e) { throw e; } };
  const api = { g, ctx: { deviceId: 0, channel: 0 }, send: midi, refresh() {} };
  const label0 = () => s.banks()[0][1];
  // on connect: preset names alone may be an internal copy (factory Internal 1-6 = Preset 1-6)
  await s.scanBank(api, 0, () => {});
  assert.equal(label0(), 'Current bank (Preset 2 or a copy?)');
  assert.ok(s.writable(0) && !s.writable(10), 'presets are not written');
  // Edit in Preset 2 selects it (bank select + program change); then it is the current bank
  assert.equal(nameOf(await s.fetch(api, 10, 0)), 'Brass Tacks');
  assert.equal(label0(), 'Current bank (Preset 2)');
  assert.equal(nameOf(await s.fetch(api, 10, 1)), PRESET_NAMES[65], 'the selected bank is read by address');
  // Edit in another bank selects the patch and reads the temporary patch; that bank is then current
  assert.equal(nameOf(await s.fetch(api, 3, 5)), 'Int3 patch 5');
  assert.equal(unit.selected, 3);
  assert.ok(s.writable(3) && s.scannable(3));
  // Play in another internal bank reads its names (in the background), kept under both entries
  await s.play(api, 4, 0);
  for (let t = 0; t < 100 && slotNames.patch?.get('4:63') == null; t++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(slotNames.patch.get('4:63'), 'Int4 patch 63');
  assert.equal(slotNames.patch.get('0:63'), 'Int4 patch 63');
  // the bank changed on the VC-1 itself: the remembered names of Internal 6 identify it
  for (let i = 0; i < 64; i++) g.setSlotName('patch', 6, i, `Int6 patch ${i}`);
  unit.selected = 6;
  await s.scanBank(api, 0, () => {});
  assert.equal(label0(), 'Current bank (Internal 6)');
  await assert.rejects(s.scanBank(api, 2, () => {}), /Play one of its patches first/);
});
