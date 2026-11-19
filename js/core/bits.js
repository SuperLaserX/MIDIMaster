// Low-level encoders used by the Kurzweil K2000 SysEx protocol.
// All multi-byte numeric fields are right-justified 7-bit chunks, MSB first.

/** Encode an unsigned integer into `count` 7-bit MIDI bytes (MSB first). */
export function enc7(value, count) {
  if (value < 0) throw new RangeError(`enc7: negative value ${value}`);
  const out = new Array(count);
  let v = value;
  for (let i = count - 1; i >= 0; i--) {
    out[i] = v & 0x7f;
    v = Math.floor(v / 128);
  }
  if (v !== 0) throw new RangeError(`enc7: ${value} does not fit in ${count} 7-bit bytes`);
  return out;
}

/** Decode `count` 7-bit bytes starting at `pos`. */
export function dec7(bytes, pos, count) {
  let v = 0;
  for (let i = 0; i < count; i++) v = v * 128 + (bytes[pos + i] & 0x7f);
  return v;
}

/**
 * Bit-stream format (form = 1): the 8-bit data is treated as one long bit
 * string and sliced into 7-bit groups starting from the most significant bit.
 * Trailing bits of the final group are zero (the stream is LEFT aligned).
 * Example from the Kurzweil manual: 4F D8 01 29 -> 27 76 00 12 48.
 */
export function encodeBitstream(data) {
  const outLen = Math.ceil((data.length * 8) / 7);
  const out = new Uint8Array(outLen);
  let acc = 0, accBits = 0, o = 0;
  for (let i = 0; i < data.length; i++) {
    acc = (acc << 8) | data[i];
    accBits += 8;
    while (accBits >= 7) {
      accBits -= 7;
      out[o++] = (acc >> accBits) & 0x7f;
    }
    acc &= (1 << accBits) - 1;
  }
  if (accBits > 0) out[o++] = (acc << (7 - accBits)) & 0x7f;
  return out;
}

/** Inverse of encodeBitstream. `size` is the number of 8-bit bytes expected. */
export function decodeBitstream(midi, size) {
  const out = new Uint8Array(size);
  let acc = 0, accBits = 0, o = 0;
  for (let i = 0; i < midi.length && o < size; i++) {
    acc = (acc << 7) | (midi[i] & 0x7f);
    accBits += 7;
    if (accBits >= 8) {
      accBits -= 8;
      out[o++] = (acc >> accBits) & 0xff;
      acc &= (1 << accBits) - 1;
    }
  }
  if (o < size) throw new Error(`bit-stream underrun: got ${o} of ${size} bytes`);
  return out;
}

/** Nibble format (form = 0): each byte becomes high nibble, then low nibble. */
export function encodeNibbles(data) {
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    out[2 * i] = data[i] >> 4;
    out[2 * i + 1] = data[i] & 0x0f;
  }
  return out;
}

export function decodeNibbles(midi, size) {
  if (midi.length < size * 2) throw new Error(`nibble underrun: ${midi.length} < ${size * 2}`);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = ((midi[2 * i] & 0x0f) << 4) | (midi[2 * i + 1] & 0x0f);
  return out;
}

export function encodedLength(size, form) {
  return form === 0 ? size * 2 : Math.ceil((size * 8) / 7);
}

export function encodeData(data, form) {
  return form === 0 ? encodeNibbles(data) : encodeBitstream(data);
}

export function decodeData(midi, size, form) {
  return form === 0 ? decodeNibbles(midi, size) : decodeBitstream(midi, size);
}

/** Checksum = low 7 bits of the sum of the encoded data bytes. */
export function checksum(encoded) {
  let s = 0;
  for (let i = 0; i < encoded.length; i++) s += encoded[i];
  return s & 0x7f;
}

export function asciiBytes(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    out.push(c >= 0x20 && c < 0x7f ? c : 0x3f);
  }
  return out;
}

/** Read a NUL-terminated ASCII string; returns [string, indexAfterNul]. */
export function readCString(bytes, pos, end = bytes.length) {
  let s = '';
  let i = pos;
  for (; i < end && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i] & 0x7f);
  return [s, Math.min(i + 1, end)];
}

export function toS8(v) { return v & 0x80 ? v - 256 : v; }
export function fromS8(v) { return v < 0 ? (v + 256) & 0xff : v & 0xff; }
export function toS16(v) { return v & 0x8000 ? v - 65536 : v; }
export function u16be(b, p) { return (b[p] << 8) | b[p + 1]; }
export function s16be(b, p) { return toS16(u16be(b, p)); }
export function u32be(b, p) { return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; }
export function s32be(b, p) { return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]; }
export function put16be(b, p, v) { b[p] = (v >> 8) & 0xff; b[p + 1] = v & 0xff; }
export function put32be(b, p, v) { b[p] = (v >>> 24) & 0xff; b[p + 1] = (v >>> 16) & 0xff; b[p + 2] = (v >>> 8) & 0xff; b[p + 3] = v & 0xff; }

export function hex(bytes, sep = ' ') {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(sep);
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
