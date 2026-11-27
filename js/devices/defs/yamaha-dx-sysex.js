// Yamaha DX/TX SysEx (maker 43h): the messages the whole DX family shares.
//
//   bulk data        F0 43 0n ff bh bl <data> cs F7   n = channel, ff = format, bh bl = byte count
//                                                      (7 bits each), cs = (-sum of data) & 7Fh
//   parameter change F0 43 1n gh pp vv F7             gh = 0ggggghh: g = group, hh = parameter
//                                                      number bits 8-7; pp = bits 6-0
//   dump request     F0 43 2n ff F7
//
// Formats: 0 one 6-operator voice (VCED, 155 bytes), 9 32 voices (VMEM, 4096 bytes), 1 TX7 / DX7
// function data (94 bytes), 2 TX7 function memories (32 x 64 bytes), 3 one 4-operator voice (VCED,
// 93 bytes), 4 32 4-operator voices (VMEM, 4096 bytes). Later models also use format 7Eh, whose data
// starts with a 10-character ASCII header ("LM  8976AE" ...) that names what follows.
// Group numbers: 0 6-op voice, 2 function, 18 (12h) 4-op voice (TX81Z / DX21 VCED), 19 (13h) 4-op
// ACED / function... (each model's config lists the ones it uses).

export const YAMAHA = 0x43;

export const checksum = (data) => (-data.reduce((a, b) => a + b, 0)) & 0x7f;

/** A bulk dump message. */
export function bulk(ch, format, data) {
  const n = data.length;
  return [0xf0, YAMAHA, ch & 0x0f, format & 0x7f, (n >> 7) & 0x7f, n & 0x7f, ...Array.from(data, (b) => b & 0x7f), checksum(Array.from(data, (b) => b & 0x7f)), 0xf7];
}

/** A format 7Eh bulk dump: the 10-character header is part of the counted, checksummed data. */
export function bulkHeader(ch, header, data) {
  return bulk(ch, 0x7e, [...[...header].map((c) => c.charCodeAt(0)), ...data]);
}

/** {channel, format, count, data, ok, header} of a bulk dump, or null. `ok`: checksum and length right. */
export function parseBulk(raw) {
  if (!raw || raw[0] !== 0xf0 || raw[1] !== YAMAHA || (raw[2] & 0xf0) !== 0x00 || raw.length < 8) return null;
  const count = ((raw[4] & 0x7f) << 7) | (raw[5] & 0x7f);
  const data = Uint8Array.from(raw.slice(6, raw.length - 2));
  const ok = raw[raw.length - 1] === 0xf7 && data.length === count && checksum(Array.from(data)) === raw[raw.length - 2];
  const out = { channel: raw[2] & 0x0f, format: raw[3], count, data, ok };
  if (raw[3] === 0x7e && data.length >= 10) {
    out.header = String.fromCharCode(...data.slice(0, 10));
    out.body = data.slice(10);
  }
  return out;
}

/** Parameter change: group 0-31, parameter 0-511, value 0-127. */
export const paramChange = (ch, group, num, value) => [0xf0, YAMAHA, 0x10 | (ch & 0x0f), ((group & 0x1f) << 2) | ((num >> 7) & 3), num & 0x7f, value & 0x7f, 0xf7];

/** {channel, group, num, value} of a parameter change, or null. */
export function parseParamChange(raw) {
  if (!raw || raw.length !== 7 || raw[0] !== 0xf0 || raw[1] !== YAMAHA || (raw[2] & 0xf0) !== 0x10 || raw[6] !== 0xf7) return null;
  return { channel: raw[2] & 0x0f, group: (raw[3] >> 2) & 0x1f, num: ((raw[3] & 3) << 7) | raw[4], value: raw[5] };
}

export const dumpRequest = (ch, format) => [0xf0, YAMAHA, 0x20 | (ch & 0x0f), format & 0x7f, 0xf7];
/** A format 7Eh dump request names the data by its header (e.g. "LM  8976AE"). */
export const dumpRequestHeader = (ch, header) => [0xf0, YAMAHA, 0x20 | (ch & 0x0f), 0x7e, ...[...header].map((c) => c.charCodeAt(0)), 0xf7];

export const isYamaha = (raw) => raw?.[0] === 0xf0 && raw[1] === YAMAHA;
export const isRequest = (raw) => isYamaha(raw) && (raw[2] & 0xf0) === 0x20;
