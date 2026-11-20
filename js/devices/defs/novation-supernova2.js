// Novation SuperNova II (Rack and Keyboard): MIDI implementation from the Rack OS 2.0 firmware
// (one 27C801, Hitachi H8/300H in advanced mode, image linear from 000000) and checked against a
// SuperNova II Rack over MIDI. See docs/devices/novation-supernova2.md.
//
// SysEx F0 00 20 29 01 mm dd tt ... F7: mm 22 Keyboard / 24 Rack (both accepted), dd the global
// MIDI channel 0-15 or 7F (accepted by any unit), tt the message type. The receive dispatcher is
// at 1B6B0 (types 00-22, handler table 1B6E6); types 01 02 06 07 0B 0C 0F 15 16 1C 1F 21 write
// memory and are refused while memory protect is on (check at 1B69C). Transmission codes at 1CE06.
//   00 pp <286>   current program of part pp (0-7, 9 = the current part)     edit buffer
//   1E pp <88>    the rest of that program (OS 2 parameters)                  edit buffer
//   02 bb nn <286> + 1F bb nn <88>   program nn of bank bb (5-12 A-H, 18-25 drum maps a-h)   memory
//   05 <372> + 1B <16> + 20 <464>    current performance                     edit buffer
//   07 bb nn <372> + 1C bb nn <16> + 21 bb nn <464>   performance nn of bank bb (1-4 A-D)   memory
//   03 current program request (-> 00 09, 1E 09)     08 current performance request (-> 8 x (00, 1E), 05, 1B, 20)
//   10 global request (-> 0F, 15)    12 bb bank request    13 bb nn single request (-> 02/1F or 07/1C/21)
// Data bytes are plain 7-bit values (no packing).
//
// Program layout: the controller map at 6525C gives the program byte of every CC (0-127) and
// NRPN (0-127); the menu pages (6B000-72200) give each parameter's label, the CC/NRPN it edits
// (resolved per oscillator/LFO/envelope by the switch at 2193A) and its display descriptor
// [min, max, flags, width, option list]. Packed NRPN values (NRPN 0, 1, 84, 100, 109, 110, 113)
// and the NRPN 120/122 families were placed by sending them to a unit's edit buffer.

import { named, readText } from '../../core/model/memmap.js';

export const PROGRAM_SIZE = 286;
export const PROGRAM_EXT_SIZE = 88;
export const PROG_DATA = PROGRAM_SIZE + PROGRAM_EXT_SIZE; // the program object: 00 data, then 1E data
export const PERF_SIZE = 372;
export const PERF_EXT_SIZE = 16;
export const PERF_FX_SIZE = 464;
export const PERF_DATA = PERF_SIZE + PERF_EXT_SIZE + PERF_FX_SIZE;
export const GLOBAL_SIZE = 272;
export const GLOBAL_EXT_SIZE = 288;

const MAKER = [0x00, 0x20, 0x29, 0x01];
export const MODELS = { 0x22: 'SuperNova II Keyboard', 0x24: 'SuperNova II Rack' };
const unit = { model: 0x22 };

// ------------------------------------------------------------------ messages
const dev = (ctx) => (ctx?.deviceId ?? 0x7f) & 0x7f;
const hdr = (ctx, type) => [0xf0, ...MAKER, unit.model, dev(ctx), type];
const body = (d) => Array.from(d, (x) => x & 0x7f);
export const msg = {
  currentProgramRequest: (ctx) => [...hdr(ctx, 0x03), 0xf7],
  currentPerformanceRequest: (ctx) => [...hdr(ctx, 0x08), 0xf7],
  globalRequest: (ctx) => [...hdr(ctx, 0x10), 0xf7],
  allProgramsRequest: (ctx) => [...hdr(ctx, 0x04), 0xf7],
  allPerformancesRequest: (ctx) => [...hdr(ctx, 0x09), 0xf7],
  arpPatternsRequest: (ctx) => [...hdr(ctx, 0x0e), 0xf7],
  totalRequest: (ctx) => [...hdr(ctx, 0x11), 0xf7],
  bankRequest: (ctx, bank) => [...hdr(ctx, 0x12), bank, 0xf7],
  singleRequest: (ctx, bank, slot) => [...hdr(ctx, 0x13), bank, slot, 0xf7],
  /** Program into a part's edit buffer (part 9 = the current part). */
  program: (ctx, data, part = 9) => [
    [...hdr(ctx, 0x00), part, ...body(data.slice(0, PROGRAM_SIZE)), 0xf7],
    [...hdr(ctx, 0x1e), part, ...body(data.slice(PROGRAM_SIZE, PROG_DATA)), 0xf7],
  ],
  /** Program into memory: bank 5-12 (A-H) or 18-25 (drum maps a-h). */
  storeProgram: (ctx, bank, slot, data) => [
    [...hdr(ctx, 0x02), bank, slot, ...body(data.slice(0, PROGRAM_SIZE)), 0xf7],
    [...hdr(ctx, 0x1f), bank, slot, ...body(data.slice(PROGRAM_SIZE, PROG_DATA)), 0xf7],
  ],
  performance: (ctx, data) => [
    [...hdr(ctx, 0x05), ...body(data.slice(0, PERF_SIZE)), 0xf7],
    [...hdr(ctx, 0x1b), ...body(data.slice(PERF_SIZE, PERF_SIZE + PERF_EXT_SIZE)), 0xf7],
    [...hdr(ctx, 0x20), ...body(data.slice(PERF_SIZE + PERF_EXT_SIZE, PERF_DATA)), 0xf7],
  ],
  storePerformance: (ctx, bank, slot, data) => [
    [...hdr(ctx, 0x07), bank, slot, ...body(data.slice(0, PERF_SIZE)), 0xf7],
    [...hdr(ctx, 0x1c), bank, slot, ...body(data.slice(PERF_SIZE, PERF_SIZE + PERF_EXT_SIZE)), 0xf7],
    [...hdr(ctx, 0x21), bank, slot, ...body(data.slice(PERF_SIZE + PERF_EXT_SIZE, PERF_DATA)), 0xf7],
  ],
  global: (ctx, data) => [
    [...hdr(ctx, 0x0f), ...body(data.slice(0, GLOBAL_SIZE)), 0xf7],
    [...hdr(ctx, 0x15), ...body(data.slice(GLOBAL_SIZE, GLOBAL_SIZE + GLOBAL_EXT_SIZE)), 0xf7],
  ],
};

export const isSN2 = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x00 && raw[2] === 0x20 && raw[3] === 0x29 && raw[4] === 0x01 && (raw[5] === 0x22 || raw[5] === 0x24);
export const typeOf = (raw) => (isSN2(raw) ? raw[7] : -1);
/** Bytes before the data: 8 + part (00, 1E), bank and slot (02, 1F, 07, 1C, 21). */
const DATA_AT = { 0x00: 9, 0x1e: 9, 0x02: 10, 0x1f: 10, 0x07: 10, 0x1c: 10, 0x21: 10, 0x05: 8, 0x1b: 8, 0x20: 8, 0x0f: 8, 0x15: 8 };
export const dataOf = (raw) => Uint8Array.from(raw.slice(DATA_AT[typeOf(raw)] ?? 8, -1));

const TYPE_NAMES = {
  0x00: 'current program', 0x01: 'program select', 0x02: 'program (memory)', 0x03: 'current program request', 0x04: 'all programs request',
  0x05: 'current performance', 0x06: 'performance select', 0x07: 'performance (memory)', 0x08: 'current performance request', 0x09: 'all performances request',
  0x0a: 'arpeggio pattern', 0x0b: 'arpeggio pattern (memory)', 0x0c: 'user arpeggio pattern (memory)', 0x0d: 'arpeggio pattern request', 0x0e: 'all arpeggio patterns request',
  0x0f: 'global data', 0x10: 'global request', 0x11: 'total data request', 0x12: 'bank request', 0x13: 'single request', 0x14: 'pattern bank', 0x15: 'global data (2)',
  0x16: 'user pattern bank', 0x1b: 'current performance (2)', 0x1c: 'performance (2, memory)', 0x1e: 'current program (2)', 0x1f: 'program (2, memory)',
  0x20: 'current performance effects', 0x21: 'performance effects (memory)', 0x22: 'user arpeggio pattern',
};
function describe(raw) {
  if (!isSN2(raw)) return null;
  const t = raw[7];
  const where = [0x02, 0x1f, 0x07, 0x1c, 0x21].includes(t) ? ` ${bankName(raw[8])} ${raw[9] + 1}` : [0x00, 0x1e].includes(t) ? ` part ${raw[8] === 9 ? 'current' : raw[8] + 1}` : '';
  return `${MODELS[raw[5]]} ${TYPE_NAMES[t] || `type ${t.toString(16)}`}${where} (${raw.length} bytes)`;
}

// Bank numbers: the bank select LSB values the SuperNova II uses (CC 32), also in its SysEx.
export const PROG_BANKS = [5, 6, 7, 8, 9, 10, 11, 12].map((b, i) => [b, `Prog bank ${'ABCDEFGH'[i]}`]);
export const DRUM_BANKS = [18, 19, 20, 21, 22, 23, 24, 25].map((b, i) => [b, `Drum map ${'abcdefgh'[i]}`]);
export const PERF_BANKS = [1, 2, 3, 4].map((b, i) => [b, `Perf bank ${'ABCD'[i]}`]);
function bankName(b) {
  return [...PROG_BANKS, ...DRUM_BANKS, ...PERF_BANKS].find(([v]) => v === b)?.[1] ?? `bank ${b}`;
}
const bankSize = (b) => (b >= 18 ? 50 : 128);

// ------------------------------------------------------------------ value displays
// Display descriptors (8 bytes: min, max, flags, width, list pointer); the formatter at 21654
// reads the flags: bit 2 signed around 64 (+/-), bits 4/3 hundreds/tens digits, bit 1 shows the
// value minus the minimum, bit 6 hexadecimal; a list pointer names value - min.
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
export const NOTE = (v) => `${NOTE_NAMES[v % 12]}${Math.floor(v / 12) - 2}`; // firmware list at 692CC: C-2 ... G8
const plus = (v) => `${v > 0 ? '+' : ''}${v}`;
const SYNC_RATES = ['32nd triplet', '32nd', '16th triplet', '16th', '8th triplet', '16th dotted', '8th', '4th triplet', '8th dotted', '4th', '2nd triplet', '4th dotted', '2nd', '1 bar triplet', '2nd dotted', '1 bar', '2 bar triplet', '1 bar dotted', '2 bars', '4 bar triplet', '3 bars', '5 bar triplet', '4 bars', '3 bar dotted', '7 bar triplet', '5 bars', '8 bar triplet', '6 bars', '7 bars', '5 bar dotted', '8 bars', '6 bar dotted', '7 bar dotted', '8 bar dotted'];
const O = {
  sync: named(['Off', ...SYNC_RATES]),
  onoff: named(['Off', 'On']),
  notes: Array.from({ length: 128 }, (_, v) => [v, NOTE(v)]),
};

const P = (offset, label, group, section, extra = {}) => ({ offset, label, group, section, ...extra });
/** 0-127 shown as is (descriptor 694DC: flags 98h). */
const U = (o, l, g, s, x = {}) => P(o, l, g, s, { min: 0, max: 127, ...x });
/** 0-127 shown -64..+63 (descriptor 694EC: flags 8Ch). */
const S = (o, l, g, s, x = {}) => P(o, l, g, s, { bias: 64, min: -64, max: 63, format: plus, ...x });
/** A list stored as the values first..first+n-1 (packed NRPN data values). */
const L = (o, l, g, s, names, first = 0, x = {}) => P(o, l, g, s, { options: named(names, first), ...x });
/** One bit of a flag byte. */
const BIT = (o, bit, l, g, s, names = ['Off', 'On'], x = {}) => P(o, l, g, s, { shift: bit, bits: 1, options: named(names), ...x });

// ------------------------------------------------------------------ program
// The mod. parameters of each section follow the source buttons (LEDs, no display text); the
// names are those of Novation's controller tables: wheel, Env 2, Env 3, LFO 1, LFO 2.
const MODS = ['Wheel', 'Env 2', 'Env 3', 'LFO 1', 'LFO 2'];
const mods = (o, what, g, s) => MODS.map((m, i) => S(o + i, `${what} mod. ${m}`, g, s));

/** Oscillator n (0-2): 34 bytes from 22 + 34n (receive fix-up at 1CB8A uses the same stride). */
function oscillator(n) {
  const b = 22 + 34 * n;
  const g = `Osc ${n + 1}`;
  const s = 'osc';
  return [
    // packed NRPN 0: wave 10n+0..4, octave 30+5n.., semitone 45+25n..; the bytes keep the NRPN value
    L(b, 'Wave', g, s, ['Square', 'Saw', 'Audio input (1)', 'Audio input (2)', 'Double saw'], 10 * n),
    P(b + 1, 'Octave', g, s, { bias: 32 + 5 * n, min: -2, max: 2, format: plus }),
    P(b + 2, 'Semitone', g, s, { bias: 57 + 25 * n, min: -12, max: 12, format: plus }),
    S(b + 3, 'Fine tune', g, s),
    P(b + 4, 'Pitch bend range', g, s, { bias: 64, min: -12, max: 12, format: plus }), // packed NRPN 84: 25n + 0..24
    U(b + 5, 'Pitch level', g, s),
    ...mods(b + 6, 'Pitch', g, s),
    S(b + 11, 'MWheel LFO 1 amt', g, s),
    S(b + 12, 'ATouch LFO 1 amt', g, s),
    U(b + 13, 'Harden level', g, s),
    ...mods(b + 14, 'Harden', g, s),
    S(b + 19, 'Width level', g, s),
    ...mods(b + 20, 'Width', g, s),
    U(b + 25, 'Sync level', g, s),
    ...mods(b + 26, 'Sync', g, s),
    U(b + 31, 'Sync key follow', g, s),
    S(b + 32, 'Sync skew', g, s),
    U(b + 33, 'Formant width', g, s),
  ];
}

/** Mixer: osc 1-3, ring mod 1*3, ring mod 2*3, noise; each a level and its five mod. amounts. */
const MIX_SOURCES = ['Osc 1', 'Osc 2', 'Osc 3', 'Ring 1*3', 'Ring 2*3', 'Noise'];
const mixer = () => MIX_SOURCES.flatMap((src, i) => [U(124 + 6 * i, `${src} mix level`, src, 'mix'), ...mods(125 + 6 * i, `${src} mix`, src, 'mix')]);
