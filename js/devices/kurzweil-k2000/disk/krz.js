// Kurzweil object files: .KRZ (K2000), .K25 (K2500) and .K26 (K2600).
//
// Layout (all big-endian):
//   0  "PRAM"
//   4  u32 file offset of the sample data (16-bit PCM)
//   18 u16 OS version x100 that saved the file, 20 u8 format number
//   32 blocks: s32 negative block size (including this field), then objects:
//        u16 hash   bit 15 set: file type = hash >> 10, ID = hash & 1023
//                   otherwise:  type = hash >> 8, ID = hash & 255
//        u16 size   of the whole object entry; entries are padded to even sizes
//        u16 nameOffset, then the NUL-terminated name; object data starts at entry + 4 + nameOffset
//   The data is the same object format the K2000 sends over SysEx. Soundblock
//   sample pointers are word offsets from the sample data offset.

import { u16be, s32be, u32be, readCString } from '../../../core/bits.js';
import { findFiles } from '../../../core/disk/image.js';

/** Kurzweil object file names. */
export const KURZWEIL_FILE = /\.(krz|k25|k26)$/i;

/** Every .KRZ/.K25/.K26 file in a disk volume. */
export const findKurzweilFiles = (volume, opts) => findFiles(volume, KURZWEIL_FILE, opts);
import { Program, TAG, segmentLength } from '../model/program.js';
import { DEFAULT_PROGRAM } from '../model/fwparams.js';

export function decodeHash(hash) {
  if (hash & 0x8000) {
    const fileType = hash >> 10;
    return { fileType, id: hash & 1023, type: fileType + 96 };
  }
  return { fileType: hash >> 8, id: hash & 255, type: hash >> 8 };
}

/** Object types only the K2500/K2600 understand (KDFX studios/presets, KB3...). */
export const K2600_ONLY_TYPES = new Set([140, 141, 142, 143, 144, 145, 146, 147]);

/**
 * Parse a Kurzweil object file from a byte source (see source.js).
 * Reads only the object area; sample audio is read later with readAudio().
 */
export async function readKrz(src) {
  const head = await src.read(0, 32);
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'PRAM') throw new Error(`${src.name || 'File'} is not a Kurzweil object file (no PRAM header).`);
  const sampleOffset = u32be(head, 4);
  const hasAudio = sampleOffset >= 32 && sampleOffset < src.size;
  const objEnd = sampleOffset >= 32 && sampleOffset <= src.size ? sampleOffset : src.size;
  const bytes = await src.read(0, objEnd);
  const objects = [];
  const warnings = [];
  let p = 32;
  while (p + 4 <= bytes.length) {
    const bs = s32be(bytes, p);
    if (bs >= 0) break; // end of blocks
    const end = Math.min(bytes.length, p - bs);
    let o = p + 4;
    while (o + 6 <= end) {
      const hash = u16be(bytes, o);
      const size = u16be(bytes, o + 2);
      if (!size) break;
      const nameOffset = u16be(bytes, o + 4);
      const ds = o + 4 + nameOffset;
      const de = o + size;
      if (de > end || ds > de) { warnings.push(`Damaged object entry at byte ${o}; the rest of that block was skipped.`); break; }
      const [name] = readCString(bytes.subarray(0, ds), o + 6);
      objects.push({ hash, ...decodeHash(hash), name: name.trim(), data: bytes.slice(ds, de), fileOffset: o });
      o += size + (size & 1);
    }
    p -= bs;
  }
  return {
    name: src.name,
    size: src.size,
    source: src,
    sampleOffset: hasAudio ? sampleOffset : src.size,
    audioBytes: hasAudio ? src.size - sampleOffset : 0,
    osVersion: u16be(head, 18) / 100,
    format: head[20],
    objects,
    warnings,
  };
}

/** Read `count` 16-bit samples starting at word `start` of the sample data. */
export async function readAudio(krz, start, count) {
  const n = Math.max(0, Math.min(count, Math.floor((krz.size - krz.sampleOffset) / 2) - start));
  const bytes = await krz.source.read(krz.sampleOffset + start * 2, n * 2);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i * 2] << 24 >> 16) | bytes[i * 2 + 1];
  return out;
}

// ------------------------------------------------------------ programs from other models

const K2000_TAGS = new Set([
  TAG.PROGRAM, TAG.LAYER, 0x0f, 0x10, 0x11, 0x14, 0x15, 0x18, 0x19, 0x1a, 0x1b,
  0x20, 0x21, 0x22, 0x23, 0x40, 0x50, 0x51, 0x52, 0x53,
]);
// Normal programs use up to 3 layers; drum programs up to 32.
export const K2000_MAX_LAYERS = 32;

// ------------------------------------------------------------ complete segment set
// The K2000 (OS 3.87J, checked 2026-11-25) keeps every program with all its segments in one order:
// program, the four program-level controls (GASR2, GFUN2, GLFO2, GFUN4), effect, then per layer
// layer, ASR1, ASR2, FUN1, FUN2, LFO1, LFO2, FUN3, FUN4, env control, AMPENV, ENV2, ENV3,
// keymap/pitch, F1-F4. A program written by SysEx without the complete set is not taken: the unit
// stores an empty program instead (algorithm 0, no keymap, no sound). Program files (.KRZ) leave out
// the segments a program does not use: none of 1080 programs in 23 files had the complete set. The
// K2000's own disk loader fills them in; completeProgram does the same, with the values the OS gives
// a new program (DEFAULT_PROGRAM in its ROM) and zeros for the program-level controls (as in every
// ROM program). Nothing present is changed.
export const PROGRAM_GLOBALS = [0x11, 0x19, 0x15, 0x1b];
export const LAYER_ORDER = [0x09, 0x10, 0x11, 0x18, 0x19, 0x14, 0x15, 0x1a, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x40, 0x50, 0x51, 0x52, 0x53];
let defaultSegments = null;
function defaults() {
  if (defaultSegments) return defaultSegments;
  const d = Uint8Array.from(DEFAULT_PROGRAM.match(/../g), (x) => parseInt(x, 16));
  const p = new Program(d);
  defaultSegments = new Map();
  for (const s of p.segments) defaultSegments.set(s.layer === null ? `g${s.tag}` : s.tag, d.slice(s.offset, s.offset + s.length));
  for (const t of PROGRAM_GLOBALS) defaultSegments.set(`g${t}`, Uint8Array.from([t, ...new Array(segmentLength(t) - 1).fill(0)]));
  return defaultSegments;
}

/** Segments a K2000 program lacks for the K2000 to take it: {global: [tags], layers: [[tags]]}. */
export function missingSegments(data) {
  const p = new Program(data);
  const have = new Set(p.common.map((s) => s.tag));
  return {
    global: [...PROGRAM_GLOBALS, 0x0f].filter((t) => !have.has(t)),
    layers: p.layers.map((L) => { const tags = new Set(L.segments.map((s) => s.tag)); return LAYER_ORDER.filter((t) => !tags.has(t)); }),
  };
}

/**
 * The program with the complete segment set in the K2000's order (missing segments at their
 * default values). Returns {data, added} (added = number of segments filled in).
 */
export function completeProgram(data) {
  const p = new Program(data);
  if (p.warnings.length) throw new Error(p.warnings[0]);
  const D = defaults();
  const seg = (s) => data.slice(s.offset, s.offset + s.length);
  const out = [];
  let added = 0;
  const head = p.common.find((s) => s.tag === TAG.PROGRAM);
  out.push(head ? seg(head) : D.get(`g${TAG.PROGRAM}`));
  for (const t of [...PROGRAM_GLOBALS, 0x0f]) {
    const s = p.common.find((x) => x.tag === t);
    if (s) out.push(seg(s)); else { out.push(D.get(`g${t}`)); added++; }
  }
  // program-level segments of other kinds stay, after the effect
  for (const s of p.common) if (s.tag !== TAG.PROGRAM && ![...PROGRAM_GLOBALS, 0x0f].includes(s.tag)) out.push(seg(s));
  for (const L of p.layers) {
    for (const t of LAYER_ORDER) {
      const s = L.segments.find((x) => x.tag === t);
      if (s) out.push(seg(s)); else { out.push(D.get(t)); added++; }
    }
    for (const s of L.segments) if (!LAYER_ORDER.includes(s.tag)) out.push(seg(s));
  }
  const total = out.reduce((n, b) => n + b.length, 0) + 2;
  const res = new Uint8Array(total);
  let o = 0;
  for (const b of out) { res.set(b, o); o += b.length; }
  return { data: res, added };
}

/** Why a program cannot be sent to a K2000 unchanged, or null if it can. */
export function programIssue(data) {
  if (!data.length || data[0] !== TAG.PROGRAM) return 'not a program';
  const mode = data[1];
  const prog = new Program(data);
  if (prog.warnings.length) return prog.warnings[0];
  const foreign = prog.segments.filter((s) => !K2000_TAGS.has(s.tag));
  if (mode !== 2) return `made on a ${mode === 4 ? 'K2600' : mode === 3 ? 'K2500' : 'different Kurzweil model'}`;
  if (foreign.length) return `uses ${foreign.length} setting group(s) the K2000 does not have`;
  if (prog.layers.length > K2000_MAX_LAYERS) return `has ${prog.layers.length} layers (the K2000 plays at most ${K2000_MAX_LAYERS})`;
  return null;
}

/**
 * Experimental: reduce a K2500/K2600 program to what a K2000 understands. Drops
 * segments with tags the K2000 lacks (KDFX, KB3...), keeps at most 32 layers and
 * sets the program mode to K2000. Returns {data, notes} or throws if the program cannot be parsed.
 */
export function convertProgramForK2000(data) {
  const prog = new Program(data);
  if (prog.warnings.length) throw new Error(prog.warnings[0]);
  const notes = [];
  const kept = [];
  let dropped = 0;
  for (const s of prog.segments) {
    if (s.layer !== null && s.layer >= K2000_MAX_LAYERS) continue;
    if (!K2000_TAGS.has(s.tag)) { dropped++; continue; }
    kept.push(prog.data.subarray(s.offset, s.offset + segmentLength(s.tag)));
  }
  if (dropped) notes.push(`dropped ${dropped} setting group(s) the K2000 does not have`);
  if (prog.layers.length > K2000_MAX_LAYERS) notes.push(`kept ${K2000_MAX_LAYERS} of ${prog.layers.length} layers`);
  const total = kept.reduce((a, b) => a + b.length, 0) + 2;
  const out = new Uint8Array(total);
  let o = 0;
  for (const k of kept) { out.set(k, o); o += k.length; }
  if (out[1] !== 2) notes.push(`program mode ${out[1]} changed to K2000`);
  out[1] = 2;
  out[2] = Math.min(prog.layers.length, K2000_MAX_LAYERS);
  return { data: out, notes };
}
