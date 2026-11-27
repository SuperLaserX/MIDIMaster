// Roland V-Synth XT, VC-1 engine ("D-50"): the D-50's MIDI implementation as the XT's VC-1
// application (OS 2.02, "VAPP3") answers it. Tables by tools/roland/vc1_fw.py; see
// docs/devices/roland-vsynth-xt.md. Roland SysEx, model 14h, 3-byte addresses:
//
//   F0 41 dev 14 cmd aa bb cc ... sum F7     dev = MIDI basic channel - 1
//   cmd 11 RQ1, 12 DT1 (one way); 40 WSD, 41 RQD, 42 DAT, 43 ACK, 45 EOD, 4E ERR, 4F RJC (handshake)
//
//   00 00 00  temporary patch, 448 bytes: upper partial 1 (+00 00), upper partial 2 (+00 40),
//             upper common (+01 00), lower partial 1 (+01 40), lower partial 2 (+02 00),
//             lower common (+02 40), patch (+03 00), 64 bytes each
//   02 00 00 + n x 1C0h   patch memory 11-88 (n = 0-63) of the current bank
//   03 60 00 + k x 178h   reverb data 17-32 (k = 0-15) of the current bank, 188 values in nibbles
//
// Every byte is range-checked by the firmware (table in the image); names and value displays
// are the firmware's screen strings. The VC-1 adds six patch bytes to the D-50's (28h-2Dh); the
// rest of each block is "Extension" (kept, not used).

import { readParam, writeParam } from '../../core/model/memmap.js';
import { dt1, dt1Chunks, parseDt1, readBlock, intToAddr, addrToInt, checksum } from '../../core/midi/roland.js';
import { RANGES, LISTS, CHARSET, NAMES, LABELS, INIT, PRESET_NAMES } from './roland-vsynthxt-vc1-fw.js';
import { vc1Translator } from './roland-vsynthxt-vc1-translate.js';

export const MODEL = [0x14];
const ALEN = 3;
const CMDS = [0x12, 0x42]; // DT1 and the handshake DAT carry the same address + data
export const A3 = (s) => addrToInt(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const hex3 = (a) => intToAddr(a, ALEN).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
export const PATCH_SIZE = 448;
export const TEMP = 0;
export const MEMORY = A3('02 00 00');
export const REVERB = A3('03 60 00');
export const REVERB_SIZE = 0x178;
export const memoryPatch = (n) => MEMORY + n * PATCH_SIZE;
/** D-50 patch numbers 11-88: bank 1-8, number 1-8. */
export const patchNo = (n) => `${(n >> 3) + 1}${(n & 7) + 1}`;
/** The VC-1's banks in bank select LSB order (MSB 87): 0-7 internal, 8-13 preset, as the VC-1 shows
 *  them (Int1-Int8, Pre1-Pre6). */
export const VC1_BANKS = [...Array.from({ length: 8 }, (_, i) => `Int${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `Pre${i + 1}`)];
/** The same, written out for the bank list. */
export const VC1_BANK_NAMES = [...Array.from({ length: 8 }, (_, i) => `Internal ${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `Preset ${i + 1}`)];

// ------------------------------------------------------------------ names and values
const LONG = new Set(NAMES.map((x) => x[1]));
/** A parameter name the firmware shows (control-assign list); throws if it is not in the image. */
const N = (long) => {
  if (!LONG.has(long)) throw new Error(`VC-1 name "${long}" is not in the firmware list`);
  return long;
};
/** A name for a byte the assign list leaves out: its edit-page label must be in the image. */
const L = (label, name) => {
  if (!LABELS.includes(label)) throw new Error(`VC-1 label "${label}" is not in the firmware list`);
  return name;
};
const opts = (list, first = 0) => list.map((t, i) => [first + i, t]);
const signed = (centre) => ({ format: (v) => { const x = v - centre; return x > 0 ? `+${x}` : String(x); } });
const plain = {};
const numbered = (from, n, first = 1) => ({ options: Array.from({ length: n }, (_, i) => [from + i, String(first + i)]) });
const V = {
  notes: { options: opts(LISTS.notes) },
  keyfollow: { options: opts(LISTS.keyfollow) },
  tvfKeyfollow: { options: opts(LISTS.keyfollow.slice(0, 15)) },
  lfoMode: { options: opts(LISTS.lfoMode) },
  penvMode: { options: opts(LISTS.lfoMode.slice(0, 3)) },
  bendMode: { options: opts(LISTS.bendMode) },
  waveform: { options: opts(LISTS.waveform) },
  pcm: { options: LISTS.pcm.map((t, i) => [i, `${i + 1} ${t}`]) },
  lfoSelect: { options: opts(LISTS.lfoSelect) },
  bias: { options: opts(LISTS.bias) },
  endLevel: { options: [[0, '0'], [1, '100']] },
  lfoWave: { options: opts(LISTS.lfoWave) },
  sync3: { options: opts(LISTS.sync) },
  sync2: { options: opts(LISTS.sync.slice(0, 2)) },
  eqLow: { options: LISTS.eqLow.map((t, i) => [i, `${t} Hz`]) },
  eqHigh: { options: LISTS.eqHigh.map((t, i) => [i, /k$/.test(t) ? `${t.slice(0, -1)} kHz` : `${t} Hz`]) },
  eqQ: { options: opts(LISTS.eqQ) },
  keyMode: { options: opts(LISTS.keyMode) },
  split: { options: opts(LISTS.split) },
  ul: { options: opts(LISTS.ul) },
  chaseMode: { options: opts(LISTS.chaseMode) },
  offOn: { options: opts(LISTS.offOn) },
  txCh: { options: [[0, LISTS.basic[0]], ...Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1)])] },
  offCh: { options: [[0, LISTS.off[0]], ...Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1)])] },
  txPc: { options: [[0, LISTS.off[0]], ...Array.from({ length: 100 }, (_, i) => [i + 1, String(i + 1)])] },
  txBs: { options: [[0, LISTS.off[0]], ...Array.from({ length: 100 }, (_, i) => [i + 1, String(i)])] },
  // Partial Mute (common 2Eh): bit 0 = partial 1, bit 1 = partial 2, set = sounding
  mute: { options: [[0, '1 Off, 2 Off'], [1, '1 On, 2 Off'], [2, '1 Off, 2 On'], [3, '1 On, 2 On']] },
  // Tone Select (patch 2Ch): bit 0 = lower, bit 1 = upper; Partial Select (2Dh): bits L1, L2, U1, U2
  toneSelect: { options: [[0, 'Upper Off, Lower Off'], [1, 'Upper Off, Lower On'], [2, 'Upper On, Lower Off'], [3, 'Upper On, Lower On']] },
  partialSelect: {
    options: Array.from({ length: 16 }, (_, v) => {
      const on = ['L1', 'L2', 'U1', 'U2'].filter((_, k) => v & (1 << k));
      return [v, on.length ? on.join(' ') : 'none'];
    }),
  },
};

// offset, name, display, group (the edit page)
const PARTIAL = [
  [0x00, N('WG Pitch Coarse'), V.notes, 'WG Pitch'],
  [0x01, N('WG Pitch Fine'), signed(50), 'WG Pitch'],
  [0x02, N('WG Pitch Keyfollow'), V.keyfollow, 'WG Pitch'],
  [0x03, N('WG Mod LFO Mode'), V.lfoMode, 'WG Modulation'],
  [0x04, N('WG Mod P-ENV Mode'), V.penvMode, 'WG Modulation'],
  [0x05, N('WG Mod Bend Mode'), V.bendMode, 'WG Modulation'],
  [0x06, N('WG Waveform'), V.waveform, 'WG Waveform'],
  [0x07, N('WG PCM Wave No.'), V.pcm, 'WG Waveform'],
  [0x08, N('WG Pulse Width'), plain, 'WG Pulse Width'],
  [0x09, N('WG PW Velocity Range'), signed(7), 'WG Pulse Width'],
  [0x0a, N('WG PW LFO Select'), V.lfoSelect, 'WG Pulse Width'],
  [0x0b, N('WG PW LFO Depth'), plain, 'WG Pulse Width'],
  [0x0c, N('WG PW Aftertouch Range'), signed(7), 'WG Pulse Width'],
  [0x0d, N('TVF Cutoff Frequency'), plain, 'TVF'],
  [0x0e, N('TVF Resonance'), plain, 'TVF'],
  [0x0f, N('TVF Keyfollow'), V.tvfKeyfollow, 'TVF'],
  [0x10, N('TVF Bias Point/Dir'), V.bias, 'TVF'],
  [0x11, N('TVF Bias Level'), signed(7), 'TVF'],
  [0x12, N('TVF ENV Depth'), plain, 'TVF ENV'],
  [0x13, N('TVF ENV Velocity Range'), plain, 'TVF ENV'],
  [0x14, N('TVF ENV Depth Keyfollow'), plain, 'TVF ENV'],
  [0x15, N('TVF ENV Time Keyfollow'), plain, 'TVF ENV'],
  ...[1, 2, 3, 4, 5].map((k) => [0x15 + k, N(`TVF ENV Time ${k}`), plain, 'TVF ENV Time']),
  ...[1, 2, 3].map((k) => [0x1a + k, N(`TVF ENV Level ${k}`), plain, 'TVF ENV Level']),
  [0x1e, N('TVF ENV Sustain Level'), plain, 'TVF ENV Level'],
  [0x1f, N('TVF ENV End Level'), V.endLevel, 'TVF ENV Level'],
  [0x20, N('TVF Mod LFO Select'), V.lfoSelect, 'TVF Modulation'],
  [0x21, N('TVF Mod LFO Depth'), plain, 'TVF Modulation'],
  [0x22, N('TVF Mod Aftertouch Range'), signed(7), 'TVF Modulation'],
  [0x23, N('TVA Level'), plain, 'TVA'],
  [0x24, N('TVA Velocity Range'), signed(50), 'TVA'],
  [0x25, N('TVA Bias Point/Dir'), V.bias, 'TVA'],
  [0x26, N('TVA Bias Level'), signed(12), 'TVA'],
  ...[1, 2, 3, 4, 5].map((k) => [0x26 + k, N(`TVA ENV Time ${k}`), plain, 'TVA ENV Time']),
  ...[1, 2, 3].map((k) => [0x2b + k, N(`TVA ENV Level ${k}`), plain, 'TVA ENV Level']),
  [0x2f, N('TVA ENV Sustain Level'), plain, 'TVA ENV Level'],
  [0x30, N('TVA ENV End Level'), V.endLevel, 'TVA ENV Level'],
  [0x31, N('TVA ENV Velocity Follow'), plain, 'TVA ENV'],
  [0x32, N('TVA ENV Time Keyfollow'), plain, 'TVA ENV'],
  [0x33, N('TVA Mod LFO Select'), V.lfoSelect, 'TVA Modulation'],
  [0x34, N('TVA Mod LFO Depth'), plain, 'TVA Modulation'],
  [0x35, N('TVA Mod Aftertouch Range'), signed(7), 'TVA Modulation'],
];
const lfo = (n, at, sync) => [
  [at, N(`LFO-${n} Waveform`), V.lfoWave, `LFO-${n}`],
  [at + 1, N(`LFO-${n} Rate`), plain, `LFO-${n}`],
  [at + 2, N(`LFO-${n} Delay Time`), plain, `LFO-${n}`],
  [at + 3, N(`LFO-${n} Sync`), sync, `LFO-${n}`],
];
const COMMON = [
  [0x0a, L('Structure', 'Structure'), numbered(0, 7), 'Structure'],
  [0x2e, L('Structure', 'Partial Mute'), V.mute, 'Structure'],
  [0x2f, N('Partial Balance'), plain, 'Structure'],
  [0x0b, N('P-ENV Velocity Range'), plain, 'P-ENV'],
  [0x0c, N('P-ENV Time Keyfollow'), plain, 'P-ENV'],
  ...[1, 2, 3, 4].map((k) => [0x0c + k, N(`P-ENV Time ${k}`), plain, 'P-ENV Time']),
  ...[0, 1, 2].map((k) => [0x11 + k, N(`P-ENV Level ${k}`), signed(50), 'P-ENV Level']),
  [0x14, N('P-ENV Sustain Level'), signed(50), 'P-ENV Level'],
  [0x15, N('P-ENV End Level'), signed(50), 'P-ENV Level'],
  [0x16, N('P-Mod LFO Depth'), plain, 'Pitch Mod'],
  [0x17, N('P-Mod Lever'), plain, 'Pitch Mod'],
  [0x18, N('P-Mod Aftertouch'), plain, 'Pitch Mod'],
  ...lfo(1, 0x19, V.sync3), ...lfo(2, 0x1d, V.sync2), ...lfo(3, 0x21, V.sync2),
  [0x25, L('LowFreq', 'Low EQ Frequency'), V.eqLow, 'EQ'],
  [0x26, N('Low EQ Gain'), signed(12), 'EQ'],
  [0x27, L('HiFreq', 'High EQ Frequency'), V.eqHigh, 'EQ'],
  [0x28, L('HiQ', 'High EQ Q'), V.eqQ, 'EQ'],
  [0x29, N('High EQ Gain'), signed(12), 'EQ'],
  [0x2a, L('Type', 'Chorus Type'), numbered(0, 8), 'Chorus'],
  [0x2b, N('Chorus Rate'), plain, 'Chorus'],
  [0x2c, N('Chorus Depth'), plain, 'Chorus'],
  [0x2d, N('Chorus Balance'), plain, 'Chorus'],
];
const PATCH_PARAMS = [
  [0x12, L('KEYMODE', 'Key Mode'), V.keyMode, 'Key mode'],
  [0x13, L('SPLIT', 'Split Point'), V.split, 'Key mode'],
  [0x21, N('Tone Balance'), plain, 'Key mode'],
  [0x20, N('Total Volume'), plain, 'Key mode'],
  [0x16, N('Upper Tone Key Shift'), signed(24), 'Tone tune'],
  [0x17, N('Lower Tone Key Shift'), signed(24), 'Tone tune'],
  [0x18, N('Upper Tone Fine Tune'), signed(50), 'Tone tune'],
  [0x19, N('Lower Tone Fine Tune'), signed(50), 'Tone tune'],
  [0x1a, N('Bender Range'), plain, 'Control'],
  [0x1b, N('Aftertouch Bend Range'), signed(12), 'Control'],
  [0x15, L('Hold', 'Hold Mode'), V.ul, 'Control'],
  [0x29, L('Portamento Edit', 'Portamento Switch'), V.offOn, 'Portamento'],
  [0x1c, N('Portamento Time'), plain, 'Portamento'],
  [0x14, N('Portamento Mode'), V.ul, 'Portamento'],
  [0x1d, L('Output Mode', 'Output Mode'), numbered(0, 4), 'Output'],
  [0x1e, L('RevType', 'Reverb Type'), numbered(0, 32), 'Output'],
  [0x1f, N('Reverb Balance'), plain, 'Output'],
  [0x28, L('Chase Edit', 'Chase Switch'), V.offOn, 'Chase'],
  [0x22, L('Chase Edit', 'Chase Mode'), V.chaseMode, 'Chase'],
  [0x23, N('Chase Level'), plain, 'Chase'],
  [0x24, N('Chase Time'), plain, 'Chase'],
  [0x25, L('TxCH', 'MIDI Transmit Channel'), V.txCh, 'MIDI'],
  [0x27, L('TxPC', 'MIDI Transmit Program Change'), V.txPc, 'MIDI'],
  [0x2b, L('TxBS', 'MIDI Transmit Bank Select'), V.txBs, 'MIDI'],
  [0x2a, L('MIDI', 'Separate Switch'), V.offOn, 'MIDI'],
  [0x26, L('SepCH', 'MIDI Separate Receive Channel'), V.offCh, 'MIDI'],
  [0x2c, L('UPPER', 'Tone Select'), V.toneSelect, 'Edit select'],
  [0x2d, L('UPPER', 'Partial Select'), V.partialSelect, 'Edit select'],
];

// The seven blocks in address (and data) order.
export const BLOCKS = [
  { key: 'u1', at: 0x000, kind: 'partial', section: 'u1', label: 'Upper partial 1' },
  { key: 'u2', at: 0x040, kind: 'partial', section: 'u2', label: 'Upper partial 2' },
  { key: 'uc', at: 0x080, kind: 'common', section: 'upper', label: 'Upper tone' },
  { key: 'l1', at: 0x0c0, kind: 'partial', section: 'l1', label: 'Lower partial 1' },
  { key: 'l2', at: 0x100, kind: 'partial', section: 'l2', label: 'Lower partial 2' },
  { key: 'lc', at: 0x140, kind: 'common', section: 'lower', label: 'Lower tone' },
  { key: 'pt', at: 0x180, kind: 'patch', section: 'patch', label: 'Patch' },
];
const SPECS = { partial: PARTIAL, common: COMMON, patch: PATCH_PARAMS };

export const params = [];
for (const blk of BLOCKS) {
  for (const [off, name, disp, group] of SPECS[blk.kind]) {
    const [min, max] = RANGES[blk.kind][off];
    params.push({
      key: `${blk.key}_${off.toString(16)}`, label: name, name, block: blk.key, section: blk.section, group,
      offset: blk.at + off, at: blk.at + off, min, max, default: INIT[blk.at + off], ...disp,
    });
  }
}
/** The parameter of block `blk` (u1 u2 uc l1 l2 lc pt) named `name`. */
export const pOf = (blk, name) => {
  const p = params.find((x) => x.block === blk && x.name === name);
  if (!p) throw new Error(`VC-1 parameter ${blk} ${name} not found`);
  return p;
};

// ------------------------------------------------------------------ names (D-50 character set)
const decodeText = (d, at, n) => Array.from(d.subarray(at, at + n), (x) => CHARSET[x] ?? ' ').join('').trimEnd();
const encodeChar = (c) => Math.max(0, CHARSET.indexOf(c));
export const nameOf = (d) => decodeText(d, 0x180, 18);
export const toneName = (d, upper) => decodeText(d, upper ? 0x80 : 0x140, 10);
export function writeName(d, at, n, name) {
  const s = String(name ?? '');
  for (let i = 0; i < n; i++) d[at + i] = encodeChar(s[i] ?? ' ');
}
export const patchDefaults = () => Uint8Array.from(INIT);

// ------------------------------------------------------------------ SysEx
const parse = (raw) => parseDt1(raw, MODEL, ALEN, CMDS);
export const rq1Msg = (dev, addr, size) => {
  const body = [...intToAddr(addr, ALEN), ...intToAddr(size, ALEN)];
  return [0xf0, 0x41, dev & 0x7f, ...MODEL, 0x11, ...body, checksum(body), 0xf7];
};
/** DT1 messages for `data` at `addr`, 256 bytes per message as the D-50 sends them. */
const dt1s = (dev, addr, data) => dt1Chunks(MODEL, dev, intToAddr(addr, ALEN), data, 256);

/**
 * Bytes of a patch assembled from DT1/DAT messages: picks the patch (temporary area or memory
 * slot) the messages cover most, since a D-50 dump sends 256-byte packets that run across patch
 * boundaries. Returns {base, data, have} or null.
 */
function assemble(msgs, base = null) {
  const cover = new Map();
  const parsed = [];
  for (const m of msgs) {
    const p = parse(m);
    if (!p?.ok) continue;
    const a = addrToInt(p.addr);
    parsed.push([a, p.data]);
    for (let i = 0; i < p.data.length; i++) {
      const b = baseOf(a + i);
      if (b !== null) cover.set(b, (cover.get(b) || 0) + 1);
    }
  }
  if (base === null) {
    let best = 0;
    for (const [b, n] of cover) if (n > best) { best = n; base = b; }
  }
  if (base === null || !cover.has(base)) return null;
  const data = patchDefaults();
  let have = 0;
  for (const [a, d] of parsed) {
    for (let i = 0; i < d.length; i++) {
      const k = a + i - base;
      if (k >= 0 && k < PATCH_SIZE) { data[k] = d[i]; have++; }
    }
  }
  return { base, data, have };
}
/** The patch an address belongs to: 0 (temporary area) or a memory slot's address. */
function baseOf(a) {
  if (a >= TEMP && a < TEMP + PATCH_SIZE) return TEMP;
  if (a >= MEMORY && a < MEMORY + 64 * PATCH_SIZE) return memoryPatch(Math.floor((a - MEMORY) / PATCH_SIZE));
  return null;
}

function libraryItems(msgs) {
  const items = [];
  const byKey = new Map();
  const add = (key, label, object, m) => {
    let item = byKey.get(key);
    if (!item) { item = { key, label, object, name: '', msgs: [] }; byKey.set(key, item); items.push(item); }
    if (!item.msgs.includes(m)) item.msgs.push(m);
    return item;
  };
  for (const m of msgs) {
    const p = parse(m);
    if (!p?.ok) {
      add('other', 'Other VC-1 messages', null, m);
      continue;
    }
    const a = addrToInt(p.addr);
    const end = a + p.data.length;
    let placed = false;
    // a packet can hold the end of one patch and the start of the next
    for (let x = a; x < end; x++) {
      const b = baseOf(x);
      if (b === null) continue;
      const key = b === TEMP ? 'temp' : `p${(b - MEMORY) / PATCH_SIZE}`;
      add(key, b === TEMP ? 'Temporary patch' : `Patch ${patchNo((b - MEMORY) / PATCH_SIZE)}`, 'patch', m);
      placed = true;
      x = b + PATCH_SIZE - 1;
    }
    if (a >= REVERB && a < REVERB + 16 * REVERB_SIZE) { add('reverb', 'Reverb data 17-32', null, m); placed = true; }
    if (!placed) add(`x${a >> 14}`, `Data at ${hex3(a & ~0x3fff)}`, null, m);
  }
  for (const item of items) {
    if (item.object !== 'patch') continue;
    const base = item.key === 'temp' ? TEMP : memoryPatch(Number(item.key.slice(1)));
    const r = assemble(item.msgs, base);
    if (r) item.name = nameOf(r.data);
  }
  return items;
}

function describe(raw) {
  if (raw[1] !== 0x41 || raw[3] !== MODEL[0]) return null;
  const cmd = raw[4];
  const CMD = { 0x11: 'RQ1', 0x12: 'DT1', 0x40: 'WSD', 0x41: 'RQD', 0x42: 'DAT', 0x43: 'ACK', 0x45: 'EOD', 0x4e: 'ERR', 0x4f: 'RJC' }[cmd];
  if (!CMD) return null;
  if (raw.length < 10) return `D-50/VC-1 ${CMD}`;
  const a = addrToInt(Array.from(raw.slice(5, 8)));
  const b = baseOf(a);
  const where = b === TEMP ? 'temporary patch' : b !== null ? `patch ${patchNo((b - MEMORY) / PATCH_SIZE)}`
    : a >= REVERB && a < REVERB + 16 * REVERB_SIZE ? `reverb data ${17 + Math.floor((a - REVERB) / REVERB_SIZE)}` : '';
  if (cmd === 0x12 || cmd === 0x42) return `D-50/VC-1 ${CMD} ${hex3(a)} ${where} (${raw.length - 10} bytes)`;
  if (cmd === 0x11 || cmd === 0x41 || cmd === 0x40) return `D-50/VC-1 ${CMD} ${hex3(a)} ${where} size ${addrToInt(Array.from(raw.slice(8, 11)))}`;
  return `D-50/VC-1 ${CMD}`;
}

/** Apply a DT1 the VC-1 sent (TxEdit) to the edited temporary patch. */
function receive(raw, data) {
  const p = parse(raw);
  if (!p?.ok) return null;
  const a = addrToInt(p.addr);
  let d = null;
  for (let i = 0; i < p.data.length; i++) {
    const k = a + i - TEMP;
    if (k >= 0 && k < PATCH_SIZE) { d ??= Uint8Array.from(data); d[k] = p.data[i]; }
  }
  return d;
}

for (const p of params) p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(TEMP + p.at, ALEN), [data[p.offset]]);

const TR = vc1Translator({ params, pOf, defaults: patchDefaults, nameOf, toneName, writeName, LISTS });
const renameAction = (label, at, n, title) => ({
  label, title,
  run: async (api) => {
    const r = await api.form(title, [{ key: 'name', label: `Name (${n} characters: A-Z a-z 0-9 - and space)`, value: decodeText(api.data, at, n), maxlength: n }]);
    if (!r) return;
    const d = Uint8Array.from(api.data);
    writeName(d, at, n, r.name);
    api.send(dt1(MODEL, api.ctx.deviceId, intToAddr(TEMP + at, ALEN), Array.from(d.slice(at, at + n))));
    api.setData(d);
  },
});
const channelOf = (ctx) => (ctx.channel ?? ctx.deviceId ?? 0) & 15;

// ------------------------------------------------------------------ bank files on the XT's drive
// VC1_I1.P10 ... VC1_I8.P10 in the drive's root (USB storage mode), 36944 bytes: a 16-character date
// stamp ("2004/03/23 00003"), the bank's 64 patches as patch memory holds them (448 bytes each,
// 11-88: what 02 00 00 answers), the reverb data 17-32 (16 x 178h nibbles, as at 03 60 00) and 64
// records of 35 bytes (the same in every factory file; not mapped). Checked against the bank read
// from the unit: the patches are byte for byte what it answered.
export const P10_SIZE = 16 + 64 * PATCH_SIZE + 16 * REVERB_SIZE + 64 * 35;
export const isP10 = (bytes) => bytes?.length === P10_SIZE && /^\d{4}\/\d\d\/\d\d \d{5}$/.test(String.fromCharCode(...bytes.subarray(0, 16)));
export function readP10(name, bytes) {
  if (!isP10(bytes)) return null;
  const bank = /VC1_(I\d)/i.exec(String(name))?.[1]?.toUpperCase();
  return Array.from({ length: 64 }, (_, i) => ({
    object: 'patch', data: Uint8Array.from(bytes.subarray(16 + i * PATCH_SIZE, 16 + (i + 1) * PATCH_SIZE)),
    label: `${bank ? `Int${bank.slice(1)}-` : ''}${patchNo(i)}`,
  }));
}

// The 35-byte record each patch has at the end of a bank file: the same in all 512 factory patches.
export const P10_RECORD = [0x00, 0x00, 0x04, 0x14, 0x14, 0x67, 0x68, 0x69, 0x67, 0x64, 0x65, 0x35, 0x30, 0x2e, 0x1a, 0x5f, 0x62, 0x1e, 0x4e, 0x0a, 0x0b, 0x2f, 0x34, 0x29, 0x2a, 0x22, 0x0e, 0x3b, 0x06, 0x3c, 0x2d, 0x54, 0x55, 0x5c, 0x58];
/** "2004/03/23 00003": the date and the field every factory file has after it. */
export const p10Stamp = (date = new Date()) => `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} 00003`;
/** A bank file from 64 patches (448 bytes each, patch-memory layout) and the reverb data 17-32. */
export function writeP10(patches, reverb, { stamp = p10Stamp(), records = null } = {}) {
  if (patches.length !== 64 || reverb.length !== 16 * REVERB_SIZE) throw new Error('A bank file needs 64 patches and the reverb data 17-32');
  const out = new Uint8Array(P10_SIZE);
  out.set([...stamp.padEnd(16).slice(0, 16)].map((ch) => ch.charCodeAt(0)));
  patches.forEach((d, i) => out.set(d.subarray(0, PATCH_SIZE), 16 + i * PATCH_SIZE));
  out.set(reverb, 16 + 64 * PATCH_SIZE);
  const rec = 16 + 64 * PATCH_SIZE + 16 * REVERB_SIZE;
  for (let i = 0; i < 64; i++) out.set(records ? records.subarray(i * 35, i * 35 + 35) : P10_RECORD, rec + i * 35);
  return out;
}
/** The patches, reverb data and records of a bank file. */
export function splitP10(bytes) {
  if (!isP10(bytes)) return null;
  const rev = 16 + 64 * PATCH_SIZE;
  return {
    stamp: String.fromCharCode(...bytes.subarray(0, 16)),
    patches: Array.from({ length: 64 }, (_, i) => bytes.subarray(16 + i * PATCH_SIZE, 16 + (i + 1) * PATCH_SIZE)),
    reverb: bytes.subarray(rev, rev + 16 * REVERB_SIZE),
    records: bytes.subarray(rev + 16 * REVERB_SIZE),
  };
}
const saveP10Action = {
  label: 'Save bank .P10',
  title: 'Read the current bank (64 patches and reverb data 17-32) from the VC-1 and save it as a bank file for the XT drive',
  run: async (api) => {
    const r = await api.form('Save the current bank as a .P10 file', [{
      key: 'n', label: 'File (the XT bank it will replace)', type: 'select', value: '1',
      options: Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `VC1_I${i + 1}.P10 (bank I${i + 1})` })),
    }], 'Read and save', 'Reads the 64 patches of the bank selected on the VC-1 and its reverb data (about 30 s), then saves VC1_In.P10. Copy it to the root of the XT drive in USB storage mode.');
    if (!r) return;
    try {
      api.g?.setBusy?.(1, 'Reading the bank (64 patches)');
      const bank = await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(memoryPatch(0), ALEN), 64 * PATCH_SIZE, { quiet: 1500 });
      api.g?.setBusy?.(1, 'Reading reverb data 17-32');
      const reverb = await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(REVERB, ALEN), 16 * REVERB_SIZE, { quiet: 1500 });
      const patches = Array.from({ length: 64 }, (_, i) => bank.subarray(i * PATCH_SIZE, (i + 1) * PATCH_SIZE));
      const { downloadBlob } = await import('../../core/ui/dom.js');
      downloadBlob(writeP10(patches, reverb), `VC1_I${r.n}.P10`);
    } finally { api.g?.setBusy?.(0); }
  },
};

// ------------------------------------------------------------------ banks
// SysEx reaches the patch memory of the bank selected on the VC-1 (02 00 00). The editor follows
// which bank that is: Play or Edit of a bank selects it (bank select 87/n + program change), and on
// connect the current bank's names are matched against the names known for each bank (the presets'
// from the firmware, the internal banks' from earlier reads, remembered by the editor).
// Checked on the unit (2026-11-25): from Int1-11, bank select 87/9 + program 0 (Pre2-11) made 02 00 00
// answer Pre2's patches. The factory internal banks 1-6 are copies of the presets 1-6 (and 7-8 hold
// "Initial patch"), so names alone tell a bank only when they are unique; the last bank the editor
// selected is remembered per device and preferred.
const vc1 = { current: 0, candidates: [], copy: false }; // current: as in the bank list (1-14), 0 = not known
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const presetNames = (bank) => PRESET_NAMES.slice((bank - 9) * 64, (bank - 8) * 64);
const recallMsgs = (bank, i, ctx) => (bank ? [[0xb0 | channelOf(ctx), 0, 87], [0xb0 | channelOf(ctx), 32, bank - 1], [0xc0 | channelOf(ctx), i]] : [[0xc0 | channelOf(ctx), i]]);
const readName = async (api, i) => decodeText(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(memoryPatch(i) + 0x180, ALEN), 18), 0, 18);
/** Make `bank` the one SysEx reaches, and remember it for the next session. */
function setCurrent(api, bank) {
  vc1.current = bank;
  vc1.candidates = [];
  if (bank) api?.g?.host?.device?.update?.({ vc1Bank: bank });
}
/** Which bank these 64 names are: {bank} when it is sure, else {bank: 0, candidates, copy}. */
function identifyBank(names, known, last) {
  const same = (list) => list.length === 64 && list.every((n, i) => n === names[i]);
  const presets = [];
  for (let b = 9; b <= 14; b++) if (same(presetNames(b))) presets.push(b);
  const internals = [];
  for (let b = 1; b <= 8; b++) {
    const list = Array.from({ length: 64 }, (_, i) => known?.get(`${b}:${i}`));
    if (list.every((n) => n != null) && same(list)) internals.push(b);
  }
  const sure = [...internals, ...presets];
  if (last && sure.includes(last)) return { bank: last };
  if (!presets.length && internals.length === 1) return { bank: internals[0] };
  return { bank: 0, candidates: sure, copy: presets.length > 0 };
}
/** Read the current bank's 64 names; they are also the names of the bank it is, when known. */
async function scanCurrent(api, onName, shouldStop) {
  const names = [];
  for (let i = 0; i < 64 && !shouldStop?.(); i++) { names.push(await readName(api, i)); onName?.(i, names[i]); }
  if (names.length < 64) return names;
  // a bank the editor selected in this session stands, unless the names show the bank was changed
  // on the VC-1: a preset's (fixed) names differ, or an internal bank's remembered names differ and
  // the names are those of one other known bank
  let kept = !!vc1.current;
  if (kept && vc1.current >= 9) kept = presetNames(vc1.current).every((n, i) => n === names[i]);
  else if (kept) {
    const known = api.g?.slotNames?.patch;
    const mine = Array.from({ length: 64 }, (_, i) => known?.get(`${vc1.current}:${i}`));
    if (mine.every((n) => n != null) && mine.some((n, i) => n !== names[i])) {
      const r = identifyBank(names, known, 0);
      if (r.bank && r.bank !== vc1.current) kept = false;
    }
  }
  if (!kept) {
    const r = identifyBank(names, api.g?.slotNames?.patch, api.g?.host?.device?.value?.vc1Bank);
    if (r.bank) setCurrent(api, r.bank);
    else Object.assign(vc1, { current: 0, candidates: r.candidates, copy: r.copy });
  }
  if (vc1.current >= 1 && vc1.current <= 8) names.forEach((n, i) => api.g?.setSlotName?.('patch', vc1.current, i, n));
  return names;
}
const currentLabel = () => {
  if (vc1.current) return `Current bank (${VC1_BANK_NAMES[vc1.current - 1]})`;
  if (vc1.candidates.length) return `Current bank (${vc1.candidates.map((b) => VC1_BANK_NAMES[b - 1]).join(' or ')}${vc1.copy ? ' or a copy' : ''}?)`;
  return 'Current bank';
};
const followed = (bank) => bank === 0 || (bank === vc1.current && bank > 0);

export default {
  coverage: 'The VC-1 ("D-50") engine of the V-Synth XT OS 2.02: every byte of the 448-byte D-50 patch (patch, upper and lower tone common, four partials) with the firmware\'s ranges, names and value displays, plus the VC-1\'s six extra patch bytes; the temporary patch, the 64 patches of the current bank and the reverb data 17-32 by address (DT1/RQ1, D-50 model 14h). D-50 SysEx files (one-way DT1 or handshake DAT) and the XT bank files VC1_I1-I8.P10 import as VC-1 patches; the current bank saves as a .P10 file.',
  sysex: { manufacturer: [0x41], model: MODEL, deviceIdDefault: 0x00 },
  minGap: 30,
  describe,
  recognise: (raw) => !!parse(raw)?.ok,
  isOwn: (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === MODEL[0] && raw.length >= 6,
  isRequest: (raw) => raw?.[1] === 0x41 && raw[3] === MODEL[0] && (raw[4] === 0x11 || raw[4] === 0x41),
  libraryItems,
  readFile: readP10,
  fullDump: ['Temporary patch', 'Patches 11-88 (current bank)', 'Reverb data 17-32 (current bank)'],
  requests: [
    { label: 'Temporary patch', bytes: (ctx) => rq1Msg(ctx.deviceId, TEMP, PATCH_SIZE) },
    { label: 'Patches 11-88 (current bank)', bytes: (ctx) => rq1Msg(ctx.deviceId, MEMORY, 64 * PATCH_SIZE), quiet: 2500, timeout: 8000 },
    { label: 'Reverb data 17-32 (current bank)', bytes: (ctx) => rq1Msg(ctx.deviceId, REVERB, 16 * REVERB_SIZE), quiet: 2500, timeout: 8000 },
  ],
  objects: [
    {
      key: 'patch', page: 'Patch', icon: '◆', label: 'Patch', size: PATCH_SIZE, autoLoad: true,
      init: patchDefaults,
      fetch: (api) => readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(TEMP, ALEN), PATCH_SIZE),
      params,
      receive,
      sections: [
        { key: 'patch', label: 'Patch' }, { key: 'upper', label: 'Upper tone' }, { key: 'u1', label: 'Upper partial 1' }, { key: 'u2', label: 'Upper partial 2' },
        { key: 'lower', label: 'Lower tone' }, { key: 'l1', label: 'Lower partial 1' }, { key: 'l2', label: 'Lower partial 2' },
      ],
      cols: 3,
      name: nameOf,
      setName: (d, name) => writeName(d, 0x180, 18, name),
      toCommon: (d) => TR.patchToCommon(d),
      fromCommon: (c, base) => TR.patchFromCommon(c, base),
      actions: [
        renameAction('Rename', 0x180, 18, 'Patch name'),
        renameAction('Rename upper tone', 0x80, 10, 'Upper tone name'),
        renameAction('Rename lower tone', 0x140, 10, 'Lower tone name'),
        saveP10Action,
      ],
      note: 'Edits the VC-1 temporary patch (00 00 00); changes are heard at once. The XT must be in VC-1 mode, and its device ID is the MIDI basic channel - 1. Store writes into patch memory of the current bank.',
      sendAll: { label: 'Send to VC-1', title: 'Write the whole patch to the temporary patch', build: (data, ctx) => dt1s(ctx.deviceId, TEMP, data) },
      toSyx: (data, ctx) => dt1s(ctx.deviceId, TEMP, data).flat(),
      fromSyx: (msgs) => assemble(msgs)?.data ?? null,
      slots: {
        label: 'Patches',
        // Bank 0: the bank selected on the VC-1, which SysEx reads and writes (02 00 00). Internal 1-8
        // and Preset 1-6: the VC-1's 14 banks by bank select 87/0-13 and program change 0-63
        // (FUN_89313B70 in VAPP3: patch = (program & 3Fh | LSB << 6) + 1, taken only with MSB 87 and
        // LSB < 14). The presets' names are the factory patches' (the firmware keeps them in order).
        banks: () => [[0, currentLabel()], ...VC1_BANK_NAMES.map((b, i) => [i + 1, b])],
        count: 64,
        slotLabel: (bank, i) => (bank ? `${VC1_BANKS[bank - 1]}-${patchNo(i)}` : patchNo(i)),
        names: (bank) => (bank >= 9 ? presetNames(bank) : null),
        name: nameOf,
        recall: recallMsgs,
        // Play selects the patch; a bank change makes that bank the one SysEx reaches, so its names
        // are read (in the background) and remembered under both entries
        play: async (api, bank, i) => {
          api.send(recallMsgs(bank, i, api.ctx));
          if (!bank || bank === vc1.current) return;
          setCurrent(api, bank);
          api.refresh?.();
          if (bank >= 9) return; // the presets' names are known
          await sleep(300);
          scanCurrent(api, (k, n) => { api.g?.setSlotName?.('patch', 0, k, n); api.g?.setBusy?.(1, `Reading ${VC1_BANK_NAMES[bank - 1]} names ${k + 1}/64`); })
            .catch((err) => api.g?.error?.(err, 'Reading names'))
            .finally(() => api.g?.setBusy?.(0));
        },
        // the selected bank is read by address; another bank's patch is selected first and read as
        // the temporary patch (the VC-1 then plays it)
        fetch: async (api, bank, i) => {
          if (followed(bank)) return readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(memoryPatch(i), ALEN), PATCH_SIZE);
          api.send(recallMsgs(bank, i, api.ctx));
          setCurrent(api, bank);
          await sleep(400);
          return readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(TEMP, ALEN), PATCH_SIZE);
        },
        fetchName: (api, _bank, i) => readName(api, i),
        scanBank: async (api, bank, onName, shouldStop) => {
          if (!followed(bank)) throw new Error(`${VC1_BANK_NAMES[bank - 1]} is not the bank selected on the VC-1: Play one of its patches first.`);
          const names = await scanCurrent(api, onName, shouldStop);
          if (bank) names.forEach((n, i) => api.g?.setSlotName?.('patch', 0, i, n));
        },
        scannable: (bank) => followed(bank),
        store: (_bank, i, ctx, data) => dt1s(ctx.deviceId, memoryPatch(i), data),
        writable: (bank) => bank === 0 || (bank === vc1.current && bank <= 8),
        autoNames: [0],
        scanNote: null,
        note: (bank, ctx) => (bank
          ? `Play sends bank select 87/${bank - 1} and a program change on channel ${channelOf(ctx) + 1}; the bank then becomes the one SysEx reaches, and its names are read. Edit of a patch in another bank selects it on the VC-1 first.`
          : `SysEx reaches the 64 patches (11-88) of the bank selected on the VC-1${vc1.current ? ` (${VC1_BANK_NAMES[vc1.current - 1]})` : ''}. Play sends a program change on channel ${channelOf(ctx) + 1}. Store writes the editor into patch memory by address.${!vc1.current && vc1.candidates.length ? ' Which bank it is cannot be told from its names (the factory Internal 1-6 are copies of Preset 1-6): Play a patch in the list of its bank to select it.' : ''}`),
      },
    },
  ],
};

export const _test = { params, libraryItems, assemble, baseOf, describe, TR, decodeText, writeParam, readParam };
