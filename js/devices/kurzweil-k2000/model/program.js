// K2000 program object: a list of tagged segments terminated by a zero word.
// Each segment = 1 tag byte + fixed-length data. Segment lengths come from the
// tag group (verified against ConvertWithMoss and offsets measured on hardware).
// Segments after a LAYER segment (tag 9) belong to that layer.

import { toS8, fromS8, u16be, put16be } from '../../../core/bits.js';

export const TAG = Object.freeze({
  PROGRAM: 0x08, LAYER: 0x09, FX: 0x0f,
  ASR1: 0x10, ASR2: 0x11, LFO1: 0x14, LFO2: 0x15,
  FUN1: 0x18, FUN2: 0x19, FUN3: 0x1a, FUN4: 0x1b,
  ENVCTL: 0x20, AMPENV: 0x21, ENV2: 0x22, ENV3: 0x23,
  CAL: 0x40, F1: 0x50, F2: 0x51, F3: 0x52, AMP: 0x53,
});

/** Total segment length (tag byte included), or 0 for an unknown tag. */
export function segmentLength(tag) {
  if (tag === TAG.PROGRAM || tag === TAG.LAYER) return 16;
  if (tag === TAG.FX) return 8;
  switch (tag & 0xf8) {
    case 0x10: return 8; // ASR / LFO
    case 0x18: return 4; // FUN
    case 0x20: return 16; // envelope control / envelopes
    case 0x40: return 32; // calibration: keymaps + pitch
    case 0x50: return 16; // DSP output blocks
    case 0x68: return 8; // KDFX (K2500 objects)
    case 0x78: return 32; // KB3 (K2500/2600 objects)
    default: return 0;
  }
}

const SEGMENT_NAMES = {
  0x08: 'Program', 0x09: 'Layer', 0x0f: 'Effect', 0x10: 'ASR 1', 0x11: 'ASR 2', 0x14: 'LFO 1', 0x15: 'LFO 2',
  0x18: 'FUN 1', 0x19: 'FUN 2', 0x1a: 'FUN 3', 0x1b: 'FUN 4', 0x20: 'Env control', 0x21: 'AMPENV',
  0x22: 'ENV2', 0x23: 'ENV3', 0x40: 'Keymap / pitch', 0x50: 'F1', 0x51: 'F2', 0x52: 'F3', 0x53: 'F4 AMP',
};

export function segmentName(tag) {
  return SEGMENT_NAMES[tag] || `Segment 0x${tag.toString(16)}`;
}

export class Program {
  /** @param {Uint8Array} data object data as returned by READ/DUMP */
  constructor(data, { id = 0, name = '', inRam = true } = {}) {
    this.id = id;
    this.name = name;
    this.inRam = inRam;
    this.data = Uint8Array.from(data);
    this.parse();
  }

  parse() {
    const d = this.data;
    this.segments = [];
    this.layers = [];
    this.warnings = [];
    let p = 0;
    let layer = null;
    while (p < d.length) {
      const tag = d[p];
      if (tag === 0) break; // terminator word
      const len = segmentLength(tag);
      if (!len) { this.warnings.push(`Unknown segment tag 0x${tag.toString(16)} at offset ${p}; rest kept as raw bytes.`); break; }
      if (p + len > d.length) { this.warnings.push(`Truncated segment at offset ${p}.`); break; }
      const seg = { tag, offset: p, length: len, layer: null };
      if (tag === TAG.LAYER) {
        layer = { index: this.layers.length, segments: [] };
        this.layers.push(layer);
      }
      if (layer) { seg.layer = layer.index; layer.segments.push(seg); }
      this.segments.push(seg);
      p += len;
    }
    this.end = p;
    this.common = this.segments.filter((s) => s.layer === null);
  }

  segment(layerIndex, tag) {
    const list = layerIndex === null ? this.common : this.layers[layerIndex]?.segments;
    return list?.find((s) => s.tag === tag) || null;
  }

  /** Absolute object offset of a field inside a segment (field offsets exclude the tag byte). */
  abs(seg, fieldOffset) { return seg.offset + 1 + fieldOffset; }

  byte(seg, off) { return this.data[this.abs(seg, off)]; }

  /** Read a field value according to its definition. */
  read(seg, f) {
    const a = this.abs(seg, f.off);
    const d = this.data;
    switch (f.type) {
      case 's8': return toS8(d[a]);
      case 'u16': return u16be(d, a);
      case 'bits': return (d[a] >> f.shift) & f.mask;
      case 'bitsInv': return f.mask - ((d[a] >> f.shift) & f.mask);
      default: return d[a];
    }
  }

  /**
   * Write a field value. Returns the patch {offset, bytes, before} to send with LOAD,
   * or null if the value did not change.
   */
  write(seg, f, value) {
    const a = this.abs(seg, f.off);
    const d = this.data;
    const size = f.type === 'u16' ? 2 : 1;
    const before = d.slice(a, a + size);
    switch (f.type) {
      case 's8': d[a] = fromS8(value); break;
      case 'u16': put16be(d, a, value); break;
      case 'bits': d[a] = (d[a] & ~(f.mask << f.shift)) | ((value & f.mask) << f.shift); break;
      case 'bitsInv': d[a] = (d[a] & ~(f.mask << f.shift)) | (((f.mask - value) & f.mask) << f.shift); break;
      default: d[a] = value & 0xff;
    }
    const bytes = d.slice(a, a + size);
    if (bytes.every((b, i) => b === before[i])) return null;
    return { offset: a, bytes, before };
  }

  /** Write a raw byte (hex editor). */
  writeRaw(offset, value) {
    const before = this.data.slice(offset, offset + 1);
    this.data[offset] = value & 0xff;
    return before[0] === (value & 0xff) ? null : { offset, bytes: this.data.slice(offset, offset + 1), before };
  }

  applyPatch(patch, useBefore = false) {
    this.data.set(useBefore ? patch.before : patch.bytes, patch.offset);
  }

  get layerCount() { return this.layers.length; }

  /**
   * Key range / velocity summary for the layer overview. Offsets come from the
   * K2000 parameter table (they count the segment's tag byte).
   */
  layerSummary(i) {
    const lyr = this.segment(i, TAG.LAYER);
    if (!lyr) return null;
    const d = this.data;
    const cal = this.segment(i, TAG.CAL);
    return {
      loKey: d[lyr.offset + 4], hiKey: d[lyr.offset + 5],
      loVel: (d[lyr.offset + 6] >> 3) & 7, hiVel: 7 - (d[lyr.offset + 6] & 7), // stored as 7 - mark
      keymap: cal ? u16be(d, cal.offset + 12) : 0,
      algorithm: cal ? d[cal.offset + 30] : 0,
    };
  }
}
