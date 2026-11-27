// Human-readable descriptions of MIDI messages for the monitor and the Branch Library.

import { hex } from '../bits.js';
import { ccName, noteName } from '../music.js';

/** MMA manufacturer IDs (one byte, or three bytes starting with 00). */
export const MANUFACTURERS = {
  '01': 'Sequential', '02': 'IDP', '03': 'Octave-Plateau / Voyetra', '04': 'Moog', '05': 'Passport', '06': 'Lexicon',
  '07': 'Kurzweil', '08': 'Fender', '09': 'Gulbransen', '0A': 'AKG', '0B': 'Voyce', '0C': 'Waveframe', '0D': 'ADA',
  '0E': 'Garfield', '0F': 'Ensoniq', 10: 'Oberheim', 11: 'Apple', 12: 'Grey Matter', 13: 'Digidesign', 14: 'Fairlight',
  15: 'JL Cooper', 16: 'Lowrey', 17: 'Adams-Smith', 18: 'E-mu', 19: 'Harmony Systems', '1A': 'ART', '1B': 'Baldwin',
  '1C': 'Eventide', '1D': 'Inventronics', '1F': 'Clarity', 20: 'Passac', 21: 'Siel', 22: 'Synthaxe', 24: 'Hohner',
  25: 'Twister', 26: 'Solton', 27: 'Jellinghaus', 28: 'Southworth', 29: 'PPG', '2A': 'JEN', '2B': 'SSL', '2C': 'Audio Veritrieb',
  '2F': 'Elka', 30: 'Dynacord', 31: 'Viscount', 33: 'Clavia', 36: 'Cheetah', 39: 'Soundcraft', '3E': 'Waldorf',
  '3F': 'Quasimidi', 40: 'Kawai', 41: 'Roland', 42: 'Korg', 43: 'Yamaha', 44: 'Casio', 46: 'Kamiya', 47: 'Akai',
  48: 'Victor', 49: 'Mesosha', '4A': 'Hoshino Gakki', '4B': 'Fujitsu', '4C': 'Sony', '4D': 'Nisshin Onpa', '4E': 'TEAC',
  50: 'Matsushita (Technics)', 51: 'Fostex', 52: 'Zoom', 54: 'Matsushita', 55: 'Suzuki', 56: 'Fuji Sound', 57: 'Acoustic Technical Lab',
  '7D': 'Non-commercial', '7E': 'Universal non-real-time', '7F': 'Universal real-time',
  '00 00 0E': 'Alesis', '00 00 10': 'DOD / DigiTech', '00 00 16': 'Opcode', '00 00 1B': 'Peavey', '00 00 29': 'Rocktron',
  '00 00 3B': 'MOTU', '00 00 7F': 'Studiologic', '00 01 05': 'M-Audio / Midiman', '00 01 0C': 'Line 6', '00 20 0C': 'Generalmusic',
  '00 20 1D': 'Drawmer', '00 20 1F': 'TC Electronic', '00 20 20': 'Doepfer', '00 20 21': 'Creative', '00 20 29': 'Novation',
  '00 20 31': 'Emagic', '00 20 32': 'Behringer', '00 20 33': 'Access',
};

/** Manufacturer ID of a SysEx message as a hex string ('41' or '00 20 33'). */
export function manufacturerId(data) {
  if (data[0] !== 0xf0 || data.length < 3) return '';
  if (data[1] !== 0) return data[1].toString(16).toUpperCase().padStart(2, '0');
  return hex(data.slice(1, 4)).toUpperCase();
}

export function manufacturerName(id) {
  if (!id) return '';
  return MANUFACTURERS[id] || MANUFACTURERS[id.replace(/^0/, '')] || MANUFACTURERS[parseInt(id, 16)] || `ID ${id}`;
}

const UNIVERSAL_NRT = {
  0x01: 'Sample Dump header', 0x02: 'Sample Dump packet', 0x03: 'Sample Dump request', 0x04: 'MIDI Time Code setup',
  0x05: 'Sample Dump extensions', 0x06: 'General information', 0x07: 'File dump', 0x08: 'MIDI tuning standard',
  0x09: 'General MIDI', 0x0a: 'Downloadable sounds', 0x7b: 'End of file', 0x7c: 'Wait', 0x7d: 'Cancel', 0x7e: 'NAK', 0x7f: 'ACK',
};
const UNIVERSAL_RT = { 0x01: 'MIDI Time Code', 0x02: 'Show control', 0x03: 'Notation', 0x04: 'Device control', 0x05: 'Cueing', 0x06: 'MMC command', 0x07: 'MMC response', 0x08: 'MIDI tuning', 0x09: 'Controller destination', 0x0a: 'Key-based instrument control' };

/**
 * Fields of an identity reply (F0 7E dev 06 02 id family(2) model(2) version(4) F7).
 * `expect` is the manufacturer the device should have (catalog ID such as '41'): some firmware
 * leaves the ID out (the Roland JP-8000/JP-8080 send F0 7E dev 06 02 06 01 ...), which shows as a
 * reply one byte short whose first byte is not the expected maker; it is then read without an ID.
 */
export function identityInfo(d, expect = '') {
  let id = manufacturerId([0xf0, ...d.slice(5, 8)]);
  let at = id.length > 2 ? 8 : 6;
  let missingId = false;
  const norm = (x) => x.toUpperCase().padStart(2, '0');
  const want = expect ? norm(expect) : '';
  // Without the ID the reply is F0 7E dev 06 02, family, model, version, F7: 14 bytes.
  if (want && norm(id) !== want && d.length === 14) { id = want; at = 5; missingId = true; }
  return { id, family: d.slice(at, at + 2), model: d.slice(at + 2, at + 4), version: d.slice(at + 4, Math.min(at + 8, d.length - 1)), missingId };
}

export function describeUniversal(d, expect = '') {
  if (d[1] === 0x7e) {
    if (d[3] === 0x06 && d[4] === 0x01) return `Identity request (device ${d[2]})`;
    if (d[3] === 0x06 && d[4] === 0x02) {
      const i = identityInfo(d, expect);
      return `Identity reply: ${manufacturerName(i.id)}${i.missingId ? ` (the reply leaves out the manufacturer ID ${i.id})` : ''}, family ${hex(i.family)}, model ${hex(i.model)}, version ${hex(i.version)}`;
    }
    if (d[3] === 0x09) return d[4] === 0x01 ? 'General MIDI System On' : d[4] === 0x02 ? 'General MIDI System Off' : 'General MIDI';
    const name = UNIVERSAL_NRT[d[3]] || 'Universal non-real-time';
    return d[3] === 0x02 ? `${name} #${d[4]}` : d[3] === 0x01 || d[3] === 0x03 ? `${name} sample ${d[4] | (d[5] << 7)}` : name;
  }
  return UNIVERSAL_RT[d[3]] || 'Universal real-time';
}

/** One-line description. `decode(data)` from the device module is tried first for SysEx. */
export function describeMessage(data, decode) {
  const s = data[0];
  if (s === 0xf0) {
    if (data[1] === 0x7e || data[1] === 0x7f) return describeUniversal(data);
    if (decode) {
      try { const r = decode(data); if (r) return r; } catch { /* fall through */ }
    }
    return `SysEx ${manufacturerName(manufacturerId(data))} (${data.length} bytes)`;
  }
  const ch = (s & 15) + 1;
  switch (s & 0xf0) {
    case 0x80: return `Note off ch${ch} ${noteName(data[1])}`;
    case 0x90: return data[2] ? `Note on ch${ch} ${noteName(data[1])} vel ${data[2]}` : `Note off ch${ch} ${noteName(data[1])}`;
    case 0xa0: return `Poly pressure ch${ch} ${noteName(data[1])} ${data[2]}`;
    case 0xb0: return `CC ch${ch} ${data[1]} ${ccName(data[1])} = ${data[2]}`;
    case 0xc0: return `Program change ch${ch} ${data[1] + 1}`;
    case 0xd0: return `Channel pressure ch${ch} ${data[1]}`;
    case 0xe0: return `Pitch bend ch${ch} ${(data[1] | (data[2] << 7)) - 8192}`;
    default: break;
  }
  const sys = { 0xf1: 'MTC quarter frame', 0xf2: 'Song position', 0xf3: 'Song select', 0xf6: 'Tune request', 0xf8: 'Clock', 0xfa: 'Start', 0xfb: 'Continue', 0xfc: 'Stop', 0xfe: 'Active sensing', 0xff: 'Reset' };
  return sys[s] || `MIDI ${hex(data)}`;
}

/** Split a buffer holding several SysEx messages into separate messages. */
export function splitSysex(bytes) {
  const out = [];
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) start = i;
    else if (bytes[i] === 0xf7 && start >= 0) { out.push(bytes.slice(start, i + 1)); start = -1; }
  }
  return out;
}
