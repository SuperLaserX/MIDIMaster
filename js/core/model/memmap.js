// Generic parameter model for device objects (patches, performances, system settings).
// A definition describes each parameter's place in the object's bytes; this module
// reads, writes and formats values the same way for every device.
//
// Parameter fields:
//   key, label, group           identity and layout
//   offset                      byte offset in the object data
//   size = 1 | 2 | 4            bytes (big-endian unless littleEndian), or
//   nibbles = n                 value spread over n bytes holding 4 bits each (Roland style), high first
//   shift, bits                 bit field inside the value
//   signed                      two's complement in `bits` (or the full size)
//   bias                        stored = value + bias (Roland "-64..63 stored as 0..127")
//   min, max                    allowed values
//   options: [[value, label]]   named values
//   format(v) / unit            display text
//   get(data) / set(data, v)    custom access for anything else

export function paramBits(p) {
  if (p.bits) return p.bits;
  if (p.nibbles) return p.nibbles * 4;
  return (p.size || 1) * 8;
}

function rawRead(data, p) {
  const o = p.offset;
  if (p.nibbles) {
    let v = 0;
    for (let i = 0; i < p.nibbles; i++) v = (v << 4) | (data[o + i] & 15);
    return v;
  }
  const size = p.size || 1;
  let v = 0;
  for (let i = 0; i < size; i++) {
    const b = data[p.littleEndian ? o + size - 1 - i : o + i] ?? 0;
    v = v * 256 + b;
  }
  return v;
}

function rawWrite(data, p, v) {
  const o = p.offset;
  if (p.nibbles) {
    for (let i = p.nibbles - 1; i >= 0; i--) { data[o + i] = v & 15; v >>>= 4; }
    return;
  }
  const size = p.size || 1;
  for (let i = size - 1; i >= 0; i--) {
    data[p.littleEndian ? o + size - 1 - i : o + i] = v & 0xff;
    v = Math.floor(v / 256);
  }
}

/** Value of parameter p in data. */
export function readParam(data, p) {
  if (p.get) return p.get(data);
  let v = rawRead(data, p);
  if (p.shift || p.bits) v = (v >>> (p.shift || 0)) & ((2 ** paramBits(p)) - 1);
  const bits = paramBits(p);
  if (p.signed && v >= 2 ** (bits - 1)) v -= 2 ** bits;
  if (p.bias) v -= p.bias;
  return v;
}

/** Set parameter p to v. Returns {offset, length} of the changed bytes, or null when nothing changed. */
export function writeParam(data, p, v) {
  v = clampParam(p, v);
  const before = Array.from(data.slice(p.offset, p.offset + byteLength(p)));
  if (p.set) p.set(data, v);
  else {
    let stored = v + (p.bias || 0);
    const bits = paramBits(p);
    stored &= (2 ** bits) - 1;
    if (p.shift || p.bits) {
      const mask = ((2 ** bits) - 1) * (2 ** (p.shift || 0));
      const word = rawRead(data, { ...p, bits: undefined, shift: undefined, signed: false });
      stored = (word & ~mask) | ((stored * (2 ** (p.shift || 0))) & mask);
    }
    rawWrite(data, p, stored >>> 0);
  }
  const after = data.slice(p.offset, p.offset + byteLength(p));
  if (after.every((b, i) => b === before[i])) return null;
  return { offset: p.offset, length: byteLength(p) };
}

export function byteLength(p) { return p.nibbles || p.size || 1; }

export function paramRange(p) {
  if (p.options) {
    const vals = p.options.map(([v]) => v);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }
  const bits = paramBits(p);
  const min = p.min ?? (p.signed ? -(2 ** (bits - 1)) : 0) - (p.bias || 0);
  const max = p.max ?? (p.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1) - (p.bias || 0);
  return { min, max };
}

export function clampParam(p, v) {
  const { min, max } = paramRange(p);
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function formatParam(p, v) {
  if (p.format) return p.format(v);
  if (p.options) {
    const o = p.options.find(([x]) => x === v);
    if (o) return o[1];
  }
  return p.unit ? `${v}${p.unit}` : String(v);
}

/** Options list built from an array of names: [[0, names[0]], ...]. */
export const named = (names, first = 0) => names.map((n, i) => [i + first, n]);

/** Plain string stored one character per byte. */
export function readText(data, offset, length, decode = (b) => b) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(decode(data[offset + i] ?? 32));
  return s.replace(/[\x00-\x1f]/g, ' ').trimEnd();
}
