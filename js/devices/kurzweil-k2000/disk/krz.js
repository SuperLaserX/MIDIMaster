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

/** Why a program cannot be sent to a K2000 unchanged, or null if it can. */
export function programIssue(data) {
  if (!data.length || data[0] !== TAG.PROGRAM) return 'not a program';
  const mode = data[1];
  const prog = new Program(data);
  if (prog.warnings.length) return prog.warnings[0];
  const foreign = prog.segments.filter((s) => !K2000_TAGS.has(s.tag));
  if (mode !== 2) return `made on a ${mode === 4 ? 'K2600' : mode === 3 ? 'K2500' : `model ${mode}`} (program mode ${mode})`;
  if (foreign.length) return `uses ${foreign.length} segment(s) the K2000 does not have`;
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
  if (dropped) notes.push(`dropped ${dropped} segment(s) the K2000 does not have`);
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
