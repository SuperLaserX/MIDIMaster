// Standard MIDI File reader, enough to pull out SysEx: patch sets are often shipped as .mid files
// that send their dumps (F0 ... F7 events, sometimes split with F7 continuation events).

const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u16 = (b, p) => (b[p] << 8) | b[p + 1];

function varLen(b, p) {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const x = b[p++];
    v = (v << 7) | (x & 0x7f);
    if (!(x & 0x80)) break;
  }
  return [v, p];
}

export const isSmf = (bytes) => bytes.length > 14 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;

/** Every complete SysEx message in a Standard MIDI File, in track order. */
export function smfSysex(bytes) {
  if (!isSmf(bytes)) return [];
  const tracks = u16(bytes, 10);
  let p = 8 + u32(bytes, 4);
  const out = [];
  for (let t = 0; t < tracks && p + 8 <= bytes.length; t++) {
    const len = u32(bytes, p + 4);
    const isTrack = bytes[p] === 0x4d && bytes[p + 1] === 0x54 && bytes[p + 2] === 0x72 && bytes[p + 3] === 0x6b;
    const end = Math.min(bytes.length, p + 8 + len);
    if (isTrack) {
      let q = p + 8;
      let status = 0;
      let pending = null; // a SysEx being continued by F7 events
      while (q < end) {
        [, q] = varLen(bytes, q); // delta time
        let s = bytes[q];
        if (s & 0x80) q++; else s = status;
        if (s === 0xf0 || s === 0xf7) {
          let n;
          [n, q] = varLen(bytes, q);
          const data = bytes.subarray(q, q + n);
          q += n;
          if (s === 0xf0) pending = [0xf0, ...data];
          else if (pending) pending.push(...data);
          else if (data[0] === 0xf0) pending = [...data]; // "escape" event holding a whole message
          if (pending && pending[pending.length - 1] === 0xf7) { out.push(Uint8Array.from(pending)); pending = null; }
        } else if (s === 0xff) {
          q++;
          let n;
          [n, q] = varLen(bytes, q);
          q += n;
        } else {
          status = s;
          const hi = s & 0xf0;
          q += hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        }
      }
    }
    p = end;
  }
  return out;
}

/** The SysEx messages in a file's bytes: a Standard MIDI File or raw SysEx (.syx). */
export function sysexMessages(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return isSmf(b) ? smfSysex(b) : splitRaw(b);
}

function splitRaw(b) {
  const out = [];
  let start = -1;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0xf0) start = i;
    else if (b[i] === 0xf7 && start >= 0) { out.push(b.slice(start, i + 1)); start = -1; }
  }
  return out;
}

/** Where the data starts when `m` is F0 <MIDI-file length> <data...> F7 with a matching length; else 0. */
function lengthPrefix(m) {
  let v = 0;
  for (let p = 1; p < Math.min(5, m.length); p++) {
    v = (v << 7) | (m[p] & 0x7f);
    if (!(m[p] & 0x80)) return v === m.length - (p + 1) ? p + 1 : 0;
  }
  return 0;
}

/**
 * Messages cut out of a MIDI file as if it were raw SysEx carry each event's length after F0, in
 * place of the manufacturer ID (a 19-byte message reads as maker 13h, a 48-byte one as 30h...).
 * Removes those lengths when every message has one that matches its size, and accept(message)
 * (e.g. "a definition reads it") then holds for more messages than before; without accept, when
 * there are at least 3 messages. Returns the same array when nothing changes.
 */
export function repairSmfLengths(msgs, accept = null) {
  if (!msgs.length) return msgs;
  const cut = msgs.map(lengthPrefix);
  if (cut.some((c) => !c)) return msgs;
  const fixed = msgs.map((m, i) => { const out = new Uint8Array(m.length - cut[i] + 1); out[0] = 0xf0; out.set(m.subarray(cut[i]), 1); return out; });
  if (accept) return fixed.filter(accept).length > msgs.filter(accept).length ? fixed : msgs;
  return msgs.length >= 3 ? fixed : msgs;
}
