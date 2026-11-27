// V-Synth XT patch files (.p00): the user patches on the XT's internal drive,
// V:\Internal.prj\Patch\nnn <name>.p00, which a computer reads and writes in USB storage mode.
//
// A file is 5402 bytes: a 32-byte header (the same in every file: 00 1E "SVD0", ten zero bytes,
// chunk "PATa" "KATE" at 20h, 14FAh bytes long) and the firmware's own bit-packed patch, 5370 bytes.
// Each value sits at the [byte offset, bits, bit position from the MSB] the firmware's parameter
// table gives for its id (PACK, generated with the other tables), counted from its block's start:
//
//   common 0, MFX 84, chorus 152, reverb 180, tone 230 + 78z, envelopes 1478 + 112z, LFOs 3270 + 20z,
//   COSM 1 3590 + 34z, COSM 2 4134 + 34z, beam/pad/arpeggio 4678, arpeggio steps 4684 + 34n,
//   the tone block's last 4 bytes (OSC 1/2 Detune and Sub Oscillator, offsets 78-81) 5228 + 4z,
//   step sequencer 5292, zone knob sets 5362 (z = zone 0-15, n = step pattern 0-15).
//
// A value takes the SysEx value less the editor's shift (two's complement in its width when it can
// go below zero); 8/16/32-bit values (sent as 2/4/8 nibbles) hold the SysEx value itself. Checked
// on all 5791 values of the factory patches 001 and 002 against the unit's SysEx answers. The only
// bits no parameter covers are 12 at the end of each envelope block (some factory files hold stray
// values there; SysEx does not carry them, so they are written as zeros) and bits 1-4 of each COSM
// block, an older 4-bit copy of the COSM Type (written as the type, see writeP00).

import { P, PACK } from './roland-vsynthxt-fw.js';

export const P00_SIZE = 5402;
const PAYLOAD = 5370;
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
export const P00_HEADER = Uint8Array.from([0x00, 0x1e, ...ascii('SVD0'), ...Array(10).fill(0), ...ascii('PATaKATE'), 0, 0, 0, 0x20, 0, 0, 0x14, 0xfa]);

const FIXED = { c: 0, m: 84, ch: 152, rv: 180, ar: 4678, sq: 5292, zk: 5362 };
const STRIDED = { t: [230, 78], e: [1478, 112], l: [3270, 20], ca: [3590, 34], cb: [4134, 34], st: [4684, 34] };

/** Byte position in the payload of offset `off` of the editor block `key` (c, m, t0, e3, st15...). */
export function packedAt(key, off) {
  if (key in FIXED) return FIXED[key] + off;
  const m = /^([a-z]+)(\d+)$/.exec(key);
  if (!m || !STRIDED[m[1]]) return -1;
  const n = Number(m[2]);
  if (m[1] === 't' && off >= 78) return 5228 + 4 * n + off - 78;
  const [base, stride] = STRIDED[m[1]];
  return base + stride * n + off;
}

function getBits(buf, pos, bp, w) {
  let v = 0;
  for (let j = 0; j < w; j++) {
    const bit = pos * 8 + bp + j;
    v = v * 2 + ((buf[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return v;
}
function setBits(buf, pos, bp, w, v) {
  for (let j = w - 1; j >= 0; j--) {
    const bit = pos * 8 + bp + j;
    const mask = 1 << (7 - (bit & 7));
    buf[bit >> 3] = (v % 2) ? buf[bit >> 3] | mask : buf[bit >> 3] & ~mask;
    v = Math.floor(v / 2);
  }
}

/** Each editor value with where it sits in the file: [param, payload byte, bit position, bits, nibbles, shift, signed]. */
function fieldsOf(built) {
  const keyOf = new Map();
  for (const part of built.parts) keyOf.set(part.offset, part.key);
  const starts = built.parts.map((p) => p.offset);
  const out = [];
  for (const p of built.params) {
    const pk = PACK[p.fwId];
    const f = P[p.fwId];
    if (!pk || !f) continue;
    const partStart = starts.filter((s) => s <= p.offset).pop();
    const pos = packedAt(keyOf.get(partStart), pk[0]);
    if (pos < 0) continue;
    const [, nib, min, , , , , shift] = f;
    out.push([p, pos, pk[2], pk[1], nib, shift, min - shift < 0]);
  }
  return out;
}
const FIELDS = new WeakMap();
const fields = (built) => { if (!FIELDS.has(built)) FIELDS.set(built, fieldsOf(built)); return FIELDS.get(built); };

export function isP00(bytes) {
  return bytes?.length >= P00_SIZE && P00_HEADER.every((x, i) => bytes[i] === x);
}

/** The editor's patch data (SysEx layout) from a .p00 file, on top of `base` (the patch defaults). */
export function readP00(bytes, built, base) {
  if (!isP00(bytes)) return null;
  const pay = bytes.subarray(0x20, 0x20 + PAYLOAD);
  const d = Uint8Array.from(base ?? new Uint8Array(built.size));
  for (const [p, pos, bp, w, nib, shift, signed] of fields(built)) {
    let v = getBits(pay, pos, bp, w);
    if (nib > 1) {
      for (let j = nib - 1; j >= 0; j--) { d[p.offset + j] = v & 15; v = Math.floor(v / 16); }
    } else {
      if (signed && v >= 2 ** (w - 1)) v -= 2 ** w;
      d[p.offset] = Math.max(0, Math.min(127, v + shift));
    }
  }
  return d;
}

/** A .p00 file from the editor's patch data. */
export function writeP00(d, built) {
  const out = new Uint8Array(P00_SIZE);
  out.set(P00_HEADER);
  const pay = out.subarray(0x20);
  for (const [p, pos, bp, w, nib, shift] of fields(built)) {
    let v;
    if (nib > 1) {
      v = 0;
      for (let j = 0; j < nib; j++) v = v * 16 + (d[p.offset + j] & 15);
    } else v = d[p.offset] - shift;
    setBits(pay, pos, bp, w, ((v % 2 ** w) + 2 ** w) % 2 ** w);
    // bits 1-4 of a COSM block's first byte: the COSM Type again in 4 bits (the OS 1 field; the
    // type itself is 7 bits at offset 32). Factory files hold the type there (0 for type 16).
    if (p.fwId === COSM_TYPE) setBits(pay, pos - PACK[COSM_TYPE][0], 1, 4, v < 16 ? v : 0);
  }
  return out;
}
const COSM_TYPE = 0x3e8;

/** "nnn Name.p00", the name the XT gives user patch n (1-512). */
export const p00FileName = (n, name) => `${String(n).padStart(3, '0')} ${String(name).trimEnd().replace(/[\\/:*?"<>|]/g, '_')}.p00`;
