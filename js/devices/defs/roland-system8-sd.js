// Roland SYSTEM-8 SD-card files (OS 1.32): the patch export (.s8p), the performance export (.s8f) and the backup
// (.bin) the unit reads with UTILITY: IMPORT and RESTORE. The editor writes them from its own data into a folder
// the user picks (the SD card), so sounds get onto the unit without MIDI. See docs/devices/roland-system8.md,
// "SD card".
//
// Format (from the OS's file code, master core 0; checked byte for byte on Roland's factory bank
// S8_V120_Pat.s8p, tools/system8/s8files.py):
//   file header 0x30: magic[4] ("S8P ", "S8F ", "SYS8"), u32 0, u32 chunk count, u32 0, 16 spaces, 8 zero bytes,
//                     u32 CRC32 of all chunk headers, u32 CRC32 of header[0..2Bh]
//   chunk header 0x20: tag[4], u32 0, u32 data size, u32 0, u32 count, u32 entry size, u32 CRC32 of the data,
//                     u32 CRC32 of chunk header[0..1Bh]; then the data. CRC32 = the zlib one.
//   .s8p: NAME (n x 16), PLG (n x 32: u16 model id, u16 version, 12 zero bytes, name[16]), PATs (n x 16808)
//   .s8f: NAME (n x 16), PRFs (n x 35360 = the performance + its upper and lower patch)
//   .bin: SYS 2196, PRF 64 x 1744, PAT / PAT2 / PAT3 256 x 512 / 2200 / 14096, TMOD 8 x 3360, PLG 4 x 32
// Entries are the OS's internal structs: one 32-bit little-endian word per OS parameter, the catalog groups back
// to back (OS_GROUPS in roland-system8-fw.js: the rows and the reserved words of each group, in address order).
// A word is the SysEx raw value minus the bias for the values stored with a bias (signed in its nibbles), else the
// raw value.

import { OS_GROUPS } from './roland-system8-fw.js';
import * as M from './roland-system8-mem.js';
import { bankSources, readSlots } from './roland-system8-install.js';
import { startTransfer } from '../generic/dumpjob.js';
import { downloadBlob } from '../../core/ui/dom.js';

const { A, S_PATCH, S_PATCH2, S_PATCH3, S_PERF, FULL_SIZE } = M;
export const SIZE = { PAT: 0x200, PAT2: 0x898, PAT3: 0x3710, PRF: 0x6d0, SYS: 0x894, TMOD: 0xd20, PLG: 0x20 };
export const PATS = SIZE.PAT + SIZE.PAT2 + SIZE.PAT3; // 16808: one .s8p entry
export const PRFS = SIZE.PRF + 2 * PATS; // 35360: one .s8f entry
export const FOLDER = { patch: ['ROLAND', 'SYSTEM-8', 'EXPORT', 'PATCH'], perform: ['ROLAND', 'SYSTEM-8', 'EXPORT', 'PERFORM'], backup: ['ROLAND', 'SYSTEM-8', 'BACKUP'] };
export const EXT = { patch: 's8p', perform: 's8f', backup: 'bin' };
export const MODEL_SYSTEM8 = { model: 5, version: 0x120, name: 'SYSTEM-8' };

// ------------------------------------------------------------------ CRC32 (zlib)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b, from = 0, to = b.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ the file container
const tag4 = (s) => Uint8Array.from(String(s).padEnd(4).slice(0, 4), (c) => c.charCodeAt(0));
const tagOf = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };

/** A file as the OS writes one (FUN_6000CB3E / FUN_6000CC04): chunks [{tag, count, size (entry), data}]. */
export function buildFile(magic, chunks) {
  const total = 0x30 + chunks.reduce((n, c) => n + 0x20 + c.data.length, 0);
  const out = new Uint8Array(total);
  out.set(tag4(magic), 0);
  put32(out, 8, chunks.length);
  out.fill(0x20, 0x10, 0x20);
  const heads = new Uint8Array(chunks.length * 0x20);
  let o = 0x30;
  chunks.forEach((c, k) => {
    const h = new Uint8Array(0x20);
    h.set(tag4(c.tag), 0);
    put32(h, 8, c.data.length);
    put32(h, 0x10, c.count);
    put32(h, 0x14, c.size);
    put32(h, 0x18, crc32(c.data));
    put32(h, 0x1c, crc32(h, 0, 0x1c));
    heads.set(h, k * 0x20);
    out.set(h, o);
    out.set(c.data, o + 0x20);
    o += 0x20 + c.data.length;
  });
  put32(out, 0x28, crc32(heads));
  put32(out, 0x2c, crc32(out, 0, 0x2c));
  return out;
}

/** The chunks of a file: {magic, chunks: [{tag, count, size, data}], problems: [what the OS would refuse]}. */
export function readFile(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const problems = [];
  if (b.length < 0x30) return { magic: '', chunks: [], problems: ['shorter than a file header'] };
  const magic = tagOf(b, 0);
  const count = u32(b, 8);
  if (u32(b, 0x2c) !== crc32(b, 0, 0x2c)) problems.push('the file header checksum is wrong');
  if (u32(b, 4) !== 0) problems.push('file header word 4 is not 0');
  const chunks = [];
  let o = 0x30;
  for (let k = 0; k < count && k < 64; k++) {
    if (o + 0x20 > b.length) { problems.push(`chunk ${k} is missing`); break; }
    const h = b.subarray(o, o + 0x20);
    const size = u32(h, 8);
    if (u32(h, 0x1c) !== crc32(h, 0, 0x1c)) problems.push(`chunk ${k} header checksum is wrong`);
    if (!size) problems.push(`chunk ${k} is empty`);
    if (o + 0x20 + size > b.length) { problems.push(`chunk ${k} is cut short`); break; }
    const data = b.subarray(o + 0x20, o + 0x20 + size);
    chunks.push({ tag: tagOf(h, 0), zero: u32(h, 4), count: u32(h, 0x10), size: u32(h, 0x14), crcOk: u32(h, 0x18) === crc32(data), data });
    o += 0x20 + size;
  }
  if (chunks.length === count && count) {
    const heads = new Uint8Array(count * 0x20);
    let p = 0x30;
    chunks.forEach((c, k) => { heads.set(b.subarray(p, p + 0x20), k * 0x20); p += 0x20 + c.data.length; });
    if (u32(b, 0x28) !== crc32(heads)) problems.push('the chunk list checksum is wrong');
  }
  return { magic, chunks, problems };
}

// What each file kind must hold for the OS's readers (s8p FUN_6000D698, s8f FUN_6000E054, backup FUN_6000B2D0): the
// tags in this order (the readers seek by position), each chunk's entry size; the backup's fixed chunk sizes.
const KINDS = {
  patch: { magic: 'S8P ', max: 3, order: [['NAME', 16], ['PLG ', 32], ['PATs', PATS]] },
  perform: { magic: 'S8F ', max: 2, order: [['NAME', 16], ['PRFs', PRFS]] },
  backup: { magic: 'SYS8', max: 7, table: { 'SYS ': [1, SIZE.SYS], 'PRF ': [64, SIZE.PRF], 'PAT ': [256, SIZE.PAT], PAT2: [256, SIZE.PAT2], PAT3: [256, SIZE.PAT3], TMOD: [8, SIZE.TMOD], 'PLG ': [4, SIZE.PLG] } },
};

/** Why the SYSTEM-8 would refuse file `bytes` of `kind` ('patch' | 'perform' | 'backup'): [] when it takes it. The
 *  checks of its own readers (OS 1.32): header and chunk checksums, the chunk tags and sizes, the data checksums. */
export function osCheck(bytes, kind) {
  const k = KINDS[kind];
  const f = readFile(bytes);
  const out = [...f.problems];
  if (f.magic !== k.magic) out.push(`not a ${k.magic.trim()} file (${JSON.stringify(f.magic)})`);
  if (!f.chunks.length || f.chunks.length > k.max) out.push(`${f.chunks.length} chunks (the SYSTEM-8 takes 1-${k.max})`);
  for (const [i, c] of f.chunks.entries()) {
    if (c.zero) out.push(`chunk ${c.tag}: word 4 is not 0`);
    if (!c.crcOk) out.push(`chunk ${c.tag}: data checksum is wrong`);
    if (k.order) {
      const want = k.order[i];
      if (!want || want[0] !== c.tag) out.push(`chunk ${i} is ${JSON.stringify(c.tag)}, the reader expects ${JSON.stringify(want?.[0])} there`);
      else if (c.size !== want[1] || c.data.length !== c.count * want[1]) out.push(`chunk ${c.tag}: ${c.count} entries of ${c.size} bytes in ${c.data.length} bytes`);
    } else {
      const t = k.table[c.tag];
      if (t && c.data.length !== t[0] * t[1]) out.push(`chunk ${c.tag}: ${c.data.length} bytes, the SYSTEM-8 expects ${t[0] * t[1]}`);
    }
  }
  if (k.order && f.chunks.length === k.order.length && new Set(f.chunks.map((c) => c.count)).size !== 1) out.push('the chunks hold different numbers of entries');
  return out;
}

// ------------------------------------------------------------------ SysEx data <-> the OS's internal structs
/** The words of one OS group in address order: [{p (packed offset in the group), n (nibbles; 1 = one 7-bit byte), bias}]. */
function groupWords(gkey) {
  const g = OS_GROUPS[gkey];
  const words = g.rows.map((r) => ({ p: r[2], n: r[3], bias: r[8] & 2 ? r[7] : null, max: r[5] }));
  for (const [o, n] of g.reserved || []) for (let k = 0; k < n / 8; k++) words.push({ p: o + 8 * k, n: 8, bias: null, max: null });
  return words.sort((a, b) => a.p - b.p);
}
/** A struct map: [{o (internal byte offset), c (compact offset in the editor's data), n, bias}] and its size. */
function structMap(parts) {
  const rows = [];
  let at = 0;
  for (const { gkey, st, area, repeat = 1, stride = 0 } of parts) {
    const words = groupWords(gkey);
    const g = OS_GROUPS[gkey];
    for (let s = 0; s < repeat; s++) {
      for (const [k, w] of words.entries()) rows.push({ o: at + 4 * k, c: st.compact(g.addr - A(area) + w.p + s * stride), n: w.n, bias: w.bias, max: w.max });
      at += 4 * words.length;
    }
  }
  return { rows, size: at };
}
const PAT_GROUPS = ['lfo', 'osc1', 'osc2', 'mix', 'pit', 'flt', 'amp', 'efx', 'ctrl', 'extend', 'pat_name'];
const PAT2_GROUPS = ['pat2_lfo', 'pat2_osc1', 'pat2_osc2', 'pat2_mix', 'pat2_pit', 'pat2_flt', 'pat2_amp', 'pat2_efx', 'pat2_ctrl', 'pat2_name', 'pat2_dly', 'pat2_cho', 'pat2_fl', 'pat2_mfx', 'pat2_rev', 'pat2_chord', 'pat2_extd'];
const PRF_GROUPS = ['pfm_com', 'pfm_upper', 'pfm_lower', 'pfm_cvgate', 'pfm_input', 'pfm_in_dly', 'pfm_in_cho', 'pfm_in_fl', 'pfm_in_mfx', 'pfm_in_rev', 'pfm_name', 'pfm_extd'];
export const MAP = {
  PAT: structMap(PAT_GROUPS.map((gkey) => ({ gkey, st: S_PATCH, area: 3 }))),
  PAT2: structMap(PAT2_GROUPS.map((gkey) => ({ gkey, st: S_PATCH2, area: 5 }))),
  // the step groups repeat step 1's records 64 times, 0x800 apart (one leaf per step)
  PAT3: structMap([{ gkey: 'pat3_seq_com', st: S_PATCH3, area: 6 }, { gkey: 'pat3_seq_step0', st: S_PATCH3, area: 6, repeat: 64, stride: 0x800 }, { gkey: 'g129', st: S_PATCH3, area: 6 }]),
  PRF: structMap(PRF_GROUPS.map((gkey) => ({ gkey, st: S_PERF, area: 4 }))),
};

const rawAt = (d, c, n) => { if (n === 1) return d[c] & 0x7f; let v = 0; for (let i = 0; i < n; i++) v = v * 16 + (d[c + i] & 15); return v; };
const putRaw = (d, c, n, v) => { if (n === 1) { d[c] = v & 0x7f; return; } let x = v >>> 0; for (let i = n - 1; i >= 0; i--) { d[c + i] = x & 15; x >>>= 4; } };
function toWords(map, d, out, at) {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const { o, c, n, bias } of map.rows) {
    const r = rawAt(d, c, n);
    let v = bias === null ? r : r - bias;
    // a biased value is signed in its nibbles: an engine may go past the catalog range (a JUPITER-8 OSC2 Coarse Tune
    // of -12 is FFh with bias 11, +12 is 17h; the unit's own backup holds FFFFFFF4h and 0000000Ch there)
    const bits = n === 1 ? 7 : 4 * n;
    if (bias !== null && v >= 2 ** (bits - 1)) v -= 2 ** bits;
    dv.setUint32(at + o, v >>> 0, true);
  }
}
function fromWords(map, b, at, d) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (const { o, c, n, bias } of map.rows) { const v = dv.getInt32(at + o, true); putRaw(d, c, n, bias === null ? v : v + bias); }
}

/** A sound in the editor's data (patch + patch2 + patch3, 20195 bytes) as the OS keeps it (PAT + PAT2 + PAT3, 16808). */
export function soundToInternal(d) {
  const out = new Uint8Array(PATS);
  toWords(MAP.PAT, d, out, 0);
  toWords(MAP.PAT2, d, out, SIZE.PAT);
  toWords(MAP.PAT3, d, out, SIZE.PAT + SIZE.PAT2);
  return out;
}
/** The reverse; `init` gives the bytes no word covers (none: every byte is a parameter or a reserved word). */
export function internalToSound(b, init = null) {
  const d = init ? Uint8Array.from(init) : new Uint8Array(FULL_SIZE);
  fromWords(MAP.PAT, b, 0, d);
  fromWords(MAP.PAT2, b, SIZE.PAT, d);
  fromWords(MAP.PAT3, b, SIZE.PAT + SIZE.PAT2, d);
  return d;
}
/** A performance (2709 bytes, 12 leaves) as the OS keeps it (1744) and back. */
export function perfToInternal(d) { const out = new Uint8Array(SIZE.PRF); toWords(MAP.PRF, d, out, 0); return out; }
export function internalToPerf(b, init = null) { const d = init ? Uint8Array.from(init) : new Uint8Array(S_PERF.size); fromWords(MAP.PRF, b, 0, d); return d; }

// a name of 4 words (4 characters each, the word's high byte first), as the OS's NAME chunks hold it
const nameWords = (b, at) => { const out = new Uint8Array(16); for (let w = 0; w < 4; w++) { const v = u32(b, at + 4 * w); for (let k = 0; k < 4; k++) out[4 * w + k] = (v >>> (8 * (3 - k))) & 0xff; } return out; };
const ascii = (b) => String.fromCharCode(...b).replace(/[^\x20-\x7e]/g, ' ').trimEnd();
const PRF_NAME_AT = 0x5e0; // pfm_name in the internal performance
const PAT_NAME_AT = 0x100; // pat_name in the internal patch

/** The 32-byte record of the engine a patch belongs to: u16 model id, u16 version, 12 zero bytes, name. */
export function plgRecord({ model, version, name }) {
  const r = new Uint8Array(32);
  r[0] = model & 0xff; r[1] = model >> 8; r[2] = version & 0xff; r[3] = version >> 8;
  for (let i = 0; i < Math.min(16, name.length); i++) r[16 + i] = name.charCodeAt(i) & 0x7f;
  return r;
}
const plgOf = (r) => ({ model: r[0] | (r[1] << 8), version: r[2] | (r[3] << 8), name: ascii(r.subarray(16, 32).filter((x) => x)) });

/** A .s8p file: items [{data (a sound, 20195 bytes), engine: {model, version, name}}] (1-255 patches). */
export function patchFile(items) {
  if (!items.length || items.length > 255) throw new Error('a patch file holds 1-255 patches');
  const pats = new Uint8Array(items.length * PATS);
  const names = new Uint8Array(items.length * 16);
  const plg = new Uint8Array(items.length * 32);
  items.forEach((it, i) => {
    const p = soundToInternal(it.data);
    pats.set(p, i * PATS);
    names.set(nameWords(p, PAT_NAME_AT), i * 16);
    plg.set(plgRecord(it.engine), i * 32);
  });
  return buildFile('S8P ', [{ tag: 'NAME', count: items.length, size: 16, data: names }, { tag: 'PLG ', count: items.length, size: 32, data: plg }, { tag: 'PATs', count: items.length, size: PATS, data: pats }]);
}
/** The patches of a .s8p file: [{name, engine, data}]. */
export function readPatchFile(bytes, init = null) {
  const f = readFile(bytes);
  const ch = Object.fromEntries(f.chunks.map((c) => [c.tag, c]));
  if (f.magic !== 'S8P ' || !ch.PATs) throw new Error('not a SYSTEM-8 patch export (.s8p)');
  return Array.from({ length: ch.PATs.count }, (_, i) => ({
    name: ascii(ch.NAME?.data.subarray(i * 16, i * 16 + 16) ?? []),
    engine: ch['PLG '] ? plgOf(ch['PLG '].data.subarray(i * 32, i * 32 + 32)) : null,
    data: internalToSound(ch.PATs.data.subarray(i * PATS, (i + 1) * PATS), init),
  }));
}

/** A .s8f file: items [{perf (2709 bytes), upper, lower (sounds, 20195 bytes)}]: each performance with the two
 *  patches it plays (the OS writes the patches its parts point at). */
export function perfFile(items) {
  if (!items.length || items.length > 255) throw new Error('a performance file holds 1-255 performances');
  const prfs = new Uint8Array(items.length * PRFS);
  const names = new Uint8Array(items.length * 16);
  items.forEach((it, i) => {
    const p = perfToInternal(it.perf);
    prfs.set(p, i * PRFS);
    prfs.set(soundToInternal(it.upper), i * PRFS + SIZE.PRF);
    prfs.set(soundToInternal(it.lower), i * PRFS + SIZE.PRF + PATS);
    names.set(nameWords(p, PRF_NAME_AT), i * 16);
  });
  return buildFile('S8F ', [{ tag: 'NAME', count: items.length, size: 16, data: names }, { tag: 'PRFs', count: items.length, size: PRFS, data: prfs }]);
}
export function readPerfFile(bytes, { perfInit = null, soundInit = null } = {}) {
  const f = readFile(bytes);
  const ch = Object.fromEntries(f.chunks.map((c) => [c.tag, c]));
  if (f.magic !== 'S8F ' || !ch.PRFs) throw new Error('not a SYSTEM-8 performance export (.s8f)');
  return Array.from({ length: ch.PRFs.count }, (_, i) => {
    const e = ch.PRFs.data.subarray(i * PRFS, (i + 1) * PRFS);
    return {
      name: ascii(ch.NAME?.data.subarray(i * 16, i * 16 + 16) ?? []),
      perf: internalToPerf(e.subarray(0, SIZE.PRF), perfInit),
      upper: internalToSound(e.subarray(SIZE.PRF, SIZE.PRF + PATS), soundInit),
      lower: internalToSound(e.subarray(SIZE.PRF + PATS), soundInit),
    };
  });
}

/** A backup for UTILITY: RESTORE holding the 256 patches (4 slots x 64, slot by slot) and, when given, the 64
 *  performances. Without the SYSTEM settings (the SYSTEM-8 keeps them out of reach of MIDI): the OS's restore takes
 *  the chunks a file has (FUN_6000B2D0) and leaves the rest of its memory as it is. */
export function backupFile({ sounds, perfs = null }) {
  if (sounds.length !== 256) throw new Error('a backup holds the 256 patches of the four slots');
  if (perfs && perfs.length !== 64) throw new Error('a backup holds the 64 performances');
  const pat = new Uint8Array(256 * SIZE.PAT); const pat2 = new Uint8Array(256 * SIZE.PAT2); const pat3 = new Uint8Array(256 * SIZE.PAT3);
  sounds.forEach((d, i) => {
    const p = soundToInternal(d);
    pat.set(p.subarray(0, SIZE.PAT), i * SIZE.PAT);
    pat2.set(p.subarray(SIZE.PAT, SIZE.PAT + SIZE.PAT2), i * SIZE.PAT2);
    pat3.set(p.subarray(SIZE.PAT + SIZE.PAT2), i * SIZE.PAT3);
  });
  const chunks = [];
  if (perfs) {
    const prf = new Uint8Array(64 * SIZE.PRF);
    perfs.forEach((d, i) => prf.set(perfToInternal(d), i * SIZE.PRF));
    chunks.push({ tag: 'PRF ', count: 64, size: SIZE.PRF, data: prf });
  }
  chunks.push({ tag: 'PAT ', count: 256, size: SIZE.PAT, data: pat }, { tag: 'PAT2', count: 256, size: SIZE.PAT2, data: pat2 }, { tag: 'PAT3', count: 256, size: SIZE.PAT3, data: pat3 });
  return buildFile('SYS8', chunks);
}
/** What a backup file holds: {sounds (256 or null), perfs (64 or null), tags}. */
export function readBackupFile(bytes, { perfInit = null, soundInit = null } = {}) {
  const f = readFile(bytes);
  if (f.magic !== 'SYS8') throw new Error('not a SYSTEM-8 backup (.bin)');
  const ch = Object.fromEntries(f.chunks.map((c) => [c.tag, c]));
  const sounds = ch['PAT '] && ch.PAT2 && ch.PAT3 ? Array.from({ length: 256 }, (_, i) => {
    const p = new Uint8Array(PATS);
    p.set(ch['PAT '].data.subarray(i * SIZE.PAT, (i + 1) * SIZE.PAT), 0);
    p.set(ch.PAT2.data.subarray(i * SIZE.PAT2, (i + 1) * SIZE.PAT2), SIZE.PAT);
    p.set(ch.PAT3.data.subarray(i * SIZE.PAT3, (i + 1) * SIZE.PAT3), SIZE.PAT + SIZE.PAT2);
    return internalToSound(p, soundInit);
  }) : null;
  const perfs = ch['PRF '] ? Array.from({ length: 64 }, (_, i) => internalToPerf(ch['PRF '].data.subarray(i * SIZE.PRF, (i + 1) * SIZE.PRF), perfInit)) : null;
  return { sounds, perfs, tags: f.chunks.map((c) => c.tag) };
}

// ------------------------------------------------------------------ writing to the card
/** A file name the SYSTEM-8 shows whole: up to 12 characters (letters, digits, _ and -) + the extension. */
export function cardName(text, kind) {
  const base = String(text || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || { patch: 'sys8_pat', perform: 'sys8_prf', backup: 'sys8_bak' }[kind];
  return `${base}.${EXT[kind]}`;
}

/**
 * Write `bytes` as `name` into the SYSTEM-8's folder for `kind` on a card (or folder) the user picks.
 * opts: pick() -> a directory handle (default: the File System Access folder picker); confirm(text) -> bool (an
 * existing file of that name); download(bytes, name) when the browser cannot write folders.
 * Resolves {path, replaced} or null (cancelled).
 */
export async function saveToCard(kind, name, bytes, { pick, confirm, download } = {}) {
  const picker = pick || (typeof window !== 'undefined' && window.showDirectoryPicker ? () => window.showDirectoryPicker({ mode: 'readwrite', id: 'system8-sd' }) : null);
  if (!picker) {
    if (!download) throw new Error('This browser cannot write into folders. Use Chrome or Edge, or the desktop app.');
    download(bytes, name);
    return { path: `${name} (downloaded: copy it to ${FOLDER[kind].join('/')} on the card)`, downloaded: true };
  }
  let dir;
  try { dir = await picker(); } catch (err) { if (err?.name === 'AbortError') return null; throw err; }
  if (!dir) return null;
  // the card itself, or its ROLAND or SYSTEM-8 folder
  const path = [...FOLDER[kind]];
  const top = String(dir.name || '').toUpperCase();
  if (top === 'SYSTEM-8') path.splice(0, 2); else if (top === 'ROLAND') path.splice(0, 1);
  for (const p of path) dir = await dir.getDirectoryHandle(p, { create: true });
  let exists = false;
  try { await dir.getFileHandle(name); exists = true; } catch { /* a new file */ }
  if (exists && confirm && !(await confirm(`${name} is already in ${FOLDER[kind].join('/')}. Replace it?`))) return null;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
  return { path: `${FOLDER[kind].join('/')}/${name}`, replaced: exists };
}

/** Plain-language steps for the unit, per file kind. */
export const UNIT_STEPS = {
  patch: 'On the SYSTEM-8: press PATCH, then MENU > UTILITY > IMPORT, set Src to EXPORT, press ENTER, choose the file, press the model button the patch is for (SYSTEM-8 or PLUG-OUT 1-3), choose the patch, press ENTER twice. This loads one patch into the edit buffer only: press WRITE to keep it, then import the next one.',
  perform: 'On the SYSTEM-8: press PERFORMANCE, then MENU > UTILITY > IMPORT, set Src to EXPORT, choose the file and the performance, press ENTER twice, then WRITE. The performance brings only its settings: import its two patches in patch mode (Src EXPORT (Perf), same file) and WRITE them into the numbers the performance uses.',
  backup: 'Not offered: a RESTORE of these files is untested on the unit. (MENU > UTILITY > RESTORE would replace every patch of the four slots and the performances; the SYSTEM settings stay.)',
};

// ------------------------------------------------------------------ reading from the unit inside a job
/**
 * Read structs from the unit inside a transfer job (io from startTransfer): reads [{base, st}] one after another
 * (RQ1 of the struct's span, the unit's DT1 leaves collected) and resolves the compact data of each.
 */
export async function readStructs(io, list, { dev = M.DEV, listen, timeout = 4000, label = (i) => `item ${i + 1}` } = {}) {
  const out = [];
  for (const [i, { base, st }] of list.entries()) {
    const d = new Uint8Array(st.size);
    const have = new Uint8Array(st.size);
    await new Promise((resolve, reject) => {
      let timer = null;
      const finish = (err) => { clearTimeout(timer); off(); io.signal?.removeEventListener?.('abort', onAbort); if (err) reject(err); else resolve(); };
      const onAbort = () => finish(new Error('Stopped.'));
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(have.every(Boolean) ? null : new Error(`${label(i)}: the SYSTEM-8 did not send all of it`)), timeout); };
      const off = listen((raw) => {
        const p = M.parse(raw);
        if (!p?.ok || p.cmd !== 0x12) return;
        const rel = p.addr - base;
        if (rel < 0 || rel >= st.span) return;
        p.data.forEach((b, j) => { const c = st.compact(rel + j); if (c >= 0) { d[c - st.at] = b; have[c - st.at] = 1; } });
        if (have.every(Boolean)) finish(null); else arm();
      });
      io.signal?.addEventListener?.('abort', onAbort);
      arm();
      try { io.send(M.rq1(base, st.span, dev)); } catch (err) { finish(err); }
    });
    out.push(d);
    io.progress?.(i + 1, list.length, label(i));
  }
  return out;
}
/** The read list of whole sounds (three structs each): [{slot, patch}] -> flat [{base, st}] (3 per sound). */
export const soundReads = (which) => which.flatMap(({ slot, patch }) => M.FULL.map((st, k) => ({ base: M.slotBases(slot, patch)[k], st })));
/** Join the three struct reads of each sound back into sounds (20195 bytes). */
export function joinSounds(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i += 3) { const d = new Uint8Array(FULL_SIZE); d.set(parts[i], 0); d.set(parts[i + 1], S_PATCH2.at); d.set(parts[i + 2], S_PATCH3.at); out.push(d); }
  return out;
}

// ------------------------------------------------------------------ the page actions ("Save to SD card...")
const BANK = (i) => `${'ABCDEFGH'[i >> 3]}-${(i & 7) + 1}`;
const SLOT_NAME = ['SYSTEM-8', 'PLUG-OUT 1', 'PLUG-OUT 2', 'PLUG-OUT 3'];
const devOf = (api) => (api.ctx?.deviceId ?? M.DEV) & 0x7f;
const listenOn = (api) => (fn) => api.g.transport.on('sysex', fn);
const live = (api) => !!api.g.connected && !(api.g.cannot && !api.g.can('sysex'));
const splitMsgs = (bytes) => { const out = []; let s = -1; for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0xf0) s = i; else if (bytes[i] === 0xf7 && s >= 0) { out.push(bytes.subarray(s, i + 1)); s = -1; } } return out; };
/** The parts' patch numbers of a performance (its internal words: upper slot / number at B0h / B8h, lower at 158h / 160h). */
export function partsOf(perf) {
  const p = perfToInternal(perf);
  return [[0xb0, 0xb8], [0x158, 0x160]].map(([s, m]) => ({ slot: u32(p, s) & 3, patch: u32(p, m) & 63 }));
}
/** The 64 complete performances in DT1 messages, or null. */
export function perfsOf(msgs, init) {
  const d = Array.from({ length: 64 }, () => Uint8Array.from(init));
  const have = Array.from({ length: 64 }, () => new Uint8Array(S_PERF.size));
  for (const m of msgs) {
    const p = M.parse(m);
    const l = p?.ok && p.cmd === 0x12 && M.locate(p.addr);
    if (!l || l.kind !== 'perf') continue;
    const rel = p.addr - l.base;
    p.data.forEach((b, j) => { const c = S_PERF.compact(rel + j); if (c >= 0) { d[l.perf][c] = b; have[l.perf][c] = 1; } });
  }
  return have.every((h) => h.every(Boolean)) ? d : null;
}

/**
 * The definition's "Save to SD card..." action. opts:
 *   page: 'patch' | 'plugout' | 'engine' | 'performance' (which page it is on)
 *   engine: {model, version, name} (engine pages: the PLUG-OUT the page edits)
 *   engines: [{model, version, name}] (the PLUG-OUTs the editor knows, for a patch whose slot is unknown)
 *   initSound(): the editor's default sound (in place of a performance's parts when they cannot be read)
 *   pick, download (tests and browsers without folder access)
 */
export async function saveAction(api, opts) {
  const { page, initSound } = opts;
  const g = api.g;
  const canRead = live(api);
  const lib = g.host?.library;
  const entries = lib ? await lib.list(g.entry.id).catch(() => []) : [];
  const banks = bankSources(entries, splitMsgs).sort((a, b) => (b.entry.created || 0) - (a.entry.created || 0));
  const choices = [];
  if (page === 'performance') {
    choices.push({ value: 'perf', label: canRead ? 'This performance, with the two patches it plays (read from the SYSTEM-8)' : 'This performance (connect the SYSTEM-8 to include the two patches it plays)' });
    if (canRead) choices.push({ value: 'perfs', label: 'All 64 performances, each with its two patches (read from the SYSTEM-8, about 30 seconds)' });
  } else {
    choices.push({ value: 'page', label: 'The patch on this page' });
    const slots = page === 'patch' ? [0] : [1, 2, 3];
    if (canRead) for (const s of slots) choices.push({ value: `read:${s}`, label: `All 64 patches of ${SLOT_NAME[s]} (read from the SYSTEM-8, about 10 seconds)` });
    banks.forEach((b, i) => { if (slots.includes(b.slot)) choices.push({ value: `lib:${i}`, label: `All 64 patches of ${SLOT_NAME[b.slot]} from "${b.entry.name}"` }); });
  }
  // no RESTORE file here: backupFile is written and checked, but a RESTORE of it is untested on the unit
  const fields = [{ key: 'what', label: 'What', type: 'select', value: choices[0].value, options: choices }];
  if (page === 'plugout') fields.push({ key: 'engine', label: 'The patch on this page is for', type: 'select', value: '', options: [{ value: '', label: 'the PLUG-OUT now in its slot (asks the SYSTEM-8)' }, ...opts.engines.map((e, i) => ({ value: String(i), label: e.name }))] });
  fields.push({ key: 'name', label: 'File name (up to 12 letters, digits, _ or -)', type: 'text', value: '', maxlength: 12 });
  const pickForm = await api.form('Save to SD card', fields, 'Next',
    'Writes a file the SYSTEM-8 can load from its SD card. You choose the card (or any folder) next. On the unit, IMPORT loads one patch at a time into the edit buffer; it is kept only after WRITE on the unit.');
  if (!pickForm) return null;
  const what = pickForm.what;
  const dev = devOf(api);
  const readJob = (title, text, list, label) => startJob(g, { title, text, run: (io) => readStructs(io, list, { dev, listen: listenOn(api), label }) });

  let kind; let bytes; let base; let summary;
  if (what === 'page' || what.startsWith('read:') || what.startsWith('lib:')) {
    kind = 'patch';
    let sounds; let slot;
    if (what === 'page') { sounds = [Uint8Array.from(api.data)]; slot = page === 'patch' ? 0 : null; }
    else if (what.startsWith('lib:')) { const b = banks[Number(what.slice(4))]; sounds = b.patches; slot = b.slot; }
    else {
      slot = Number(what.slice(5));
      const parts = await readJob(`Reading ${SLOT_NAME[slot]}`, `The 64 patches of ${SLOT_NAME[slot]} for the SD card.`, soundReads(Array.from({ length: 64 }, (_, i) => ({ slot, patch: i }))), (i) => `${SLOT_NAME[slot]} ${BANK(Math.floor(i / 3))}`);
      if (!parts) return null;
      sounds = joinSounds(parts);
    }
    const engine = await engineFor(api, { page, slot, what, bank: what.startsWith('lib:') ? banks[Number(what.slice(4))] : null, chosen: pickForm.engine, canRead, opts });
    if (!engine) return null;
    bytes = patchFile(sounds.map((data) => ({ data, engine })));
    base = pickForm.name || (sounds.length === 1 ? readPatchFile(bytes)[0].name : `${engine.name.replace(/-/g, '')}_bank`);
    summary = `${sounds.length === 1 ? `"${readPatchFile(bytes)[0].name}"` : `${sounds.length} patches`} for ${engine.name}`;
  } else if (what === 'perf' || what === 'perfs') {
    kind = 'perform';
    let perfs = [];
    if (what === 'perf') perfs = [Uint8Array.from(api.data)];
    else {
      const got = await readJob('Reading the performances', 'The 64 performances for the SD card.', Array.from({ length: 64 }, (_, n) => ({ base: M.perfAddr(n), st: S_PERF })), (i) => `performance ${BANK(i)}`);
      if (!got) return null;
      perfs = got;
    }
    let items;
    if (canRead) {
      const want = [...new Map(perfs.flatMap(partsOf).map((p) => [`${p.slot}:${p.patch}`, p])).values()];
      const parts = await readJob('Reading the patches of the performances', `${want.length} patches the performances play.`, soundReads(want), (i) => { const w = want[Math.floor(i / 3)]; return `${SLOT_NAME[w.slot]} ${BANK(w.patch)}`; });
      if (!parts) return null;
      const by = new Map(joinSounds(parts).map((d, i) => [`${want[i].slot}:${want[i].patch}`, d]));
      items = perfs.map((perf) => { const [u, l] = partsOf(perf); return { perf, upper: by.get(`${u.slot}:${u.patch}`), lower: by.get(`${l.slot}:${l.patch}`) }; });
    } else {
      const none = initSound(); for (let i = 0; i < 16; i++) { const c = 'NOT INCLUDED    '.charCodeAt(i); none[0x80 + 2 * i] = c >> 4; none[0x81 + 2 * i] = c & 15; }
      items = perfs.map((perf) => ({ perf, upper: none, lower: none }));
    }
    bytes = perfFile(items);
    const first = readPerfFile(bytes)[0].name;
    base = pickForm.name || (items.length === 1 ? first : 'sys8_prf');
    summary = items.length === 1 ? `"${first}"${canRead ? ' with its two patches' : ' (without its patches)'}` : `${items.length} performances with their patches`;
  } else return null;
  const problems = osCheck(bytes, kind);
  if (problems.length) throw new Error(`The file did not pass the SYSTEM-8's own checks: ${problems.join('; ')}`);
  const name = cardName(base, kind);
  const res = await saveToCard(kind, name, bytes, {
    pick: opts.pick, confirm: (text) => api.confirm('Replace the file?', text, 'Replace', true),
    download: opts.download || downloadBlob,
  });
  if (!res) return null;
  await api.confirm('Saved for the SD card', `${summary} saved as ${res.path}. ${UNIT_STEPS[kind]}`, 'OK');
  return { kind, name, path: res.path, bytes };
}
const startJob = (g, spec) => startTransfer(g, spec);

/** The engine (PLUG-OUT) the patches of a .s8p belong to: the page's own, the SYSTEM-8, a backup entry's, the slot
 *  record read from the unit, or the user's choice. */
async function engineFor(api, { page, slot, what, bank, chosen, canRead, opts }) {
  if (slot === 0) return MODEL_SYSTEM8;
  if (page === 'engine' && what === 'page') return opts.engine;
  const known = (model) => opts.engines?.find((e) => e.model === model) || null;
  if (bank?.backup) return { ...(known(bank.backup.model) || { name: `model ${bank.backup.model}` }), model: bank.backup.model, version: bank.backup.version };
  if (page === 'plugout' && what === 'page' && chosen !== '' && chosen !== undefined) return opts.engines[Number(chosen)];
  if (!canRead) {
    if (opts.engine) return opts.engine;
    throw new Error('Choose the PLUG-OUT the patch is for (the SYSTEM-8 is not connected to ask it).');
  }
  const u = await readSlots(api);
  let s = slot;
  if (s === null || s === undefined) {
    const pick = await api.form('Which slot?', [{ key: 'slot', label: 'The patch is for the PLUG-OUT in', type: 'select', value: '1', options: [1, 2, 3].map((x) => ({ value: String(x), label: `PLUG-OUT ${x}: ${u.slots[x]?.empty ? 'empty' : u.slots[x]?.name || '?'}` })) }], 'Next');
    if (!pick) return null;
    s = Number(pick.slot);
  }
  const info = u.slots[s];
  if (!info || info.empty) throw new Error(`PLUG-OUT ${s} is empty`);
  if (opts.engine && info.model !== opts.engine.model) throw new Error(`PLUG-OUT ${s} holds ${info.name}, not ${opts.engine.name}`);
  return { model: info.model, version: info.version, name: info.name || known(info.model)?.name || `model ${info.model}` };
}

export const _test = { groupWords, KINDS, nameWords, PRF_NAME_AT, PAT_NAME_AT, splitMsgs };
