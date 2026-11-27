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

import { named, readText, readParam, writeParam } from '../../core/model/memmap.js';
import * as FW from './novation-supernova2-fw.js';
import * as TR from './novation-supernova2-translate.js';

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
export const MODELS = { 0x22: 'SuperNova II Keyboard', 0x23: 'Nova II Keyboard', 0x24: 'SuperNova II Rack' };
const unit = { model: 0x22 };
/** The Nova II editor (novation-nova2.js) is this definition with model byte 23: the device being edited decides. */
export const NOVA2_ID = 'novation-nova2';
const modelOf = (ctx) => (ctx?.entry?.id === NOVA2_ID ? 0x23 : unit.model);

// ------------------------------------------------------------------ messages
const dev = (ctx) => (ctx?.deviceId ?? 0x7f) & 0x7f;
const hdr = (ctx, type) => [0xf0, ...MAKER, modelOf(ctx), dev(ctx), type];
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

export const isSN2 = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x00 && raw[2] === 0x20 && raw[3] === 0x29 && raw[4] === 0x01 && (raw[5] === 0x22 || raw[5] === 0x23 || raw[5] === 0x24);
export const typeOf = (raw) => (isSN2(raw) ? raw[7] : -1);
/** Bytes before the data: 8 + part (00, 1E), bank and slot (02, 1F, 07, 1C, 21). */
const DATA_AT = { 0x00: 9, 0x1e: 9, 0x02: 10, 0x1f: 10, 0x07: 10, 0x1c: 10, 0x21: 10, 0x05: 8, 0x1b: 8, 0x20: 8, 0x0f: 8, 0x15: 8 };
export const dataOf = (raw) => Uint8Array.from(raw.slice(DATA_AT[typeOf(raw)] ?? 8, -1));

const TYPE_NAMES = {
  0x00: 'current program', 0x01: 'program select', 0x02: 'program (memory)', 0x03: 'current program request', 0x04: 'all programs request',
  0x05: 'current performance', 0x06: 'performance select', 0x07: 'performance (memory)', 0x08: 'current performance request', 0x09: 'all performances request',
  0x0a: 'user arpeggio pattern (edit buffer)', 0x0b: 'write user pattern', 0x0c: 'user arpeggio pattern (memory)', 0x0d: 'arpeggio pattern request', 0x0e: 'all arpeggio patterns request',
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
  adRepeat: Array.from({ length: 128 }, (_, v) => [v, v === 0 ? 'Off' : v === 127 ? 'Inf' : String(v).padStart(3, '0')]),
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
/** Shown only for a SuperNova II Keyboard (model 22): the Rack neither shows nor uses it. */
const KBD_ONLY = { dynamic: (_d, ctx) => ({ hidden: modelOf(ctx) === 0x24 }) };
/** A byte OS 2.0 never uses: read-only, kept so a backup restores exactly. */
const RES = (o, l, s, help) => P(o, l, 'Reserved', s, { input: 'number', readOnly: true, min: 0, max: 127, help });
/** Pass to effects with the digital I/O card: 1-16 continue the list after "Program & input (2)" (getter at 14C04). */
const DIGITAL_PASS = [[0, 'None (the setting above)'], ...Array.from({ length: 16 }, (_, i) => [i + 1, i & 1 ? `Prog & digital (${(i >> 1) + 1})` : `Digital in (${(i >> 1) + 1}) only`])];

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

/** LFO n (0-1): 10 bytes from 160 + 10n, range at 180 + n, slew and fade bits in the second block. */
function lfo(n) {
  const b = 160 + 10 * n;
  const g = `LFO ${n + 1}`;
  const s = 'lfo';
  return [
    U(b + 3, 'Speed', g, s),
    U(b, 'Delay', g, s),
    // packed NRPN 1: wave 16+4n.., triggering 24+2n, range 28+3n (front-panel LEDs; names from Novation's tables)
    L(b + 1, 'Wave', g, s, ['Square', 'Saw', 'Triangle', 'S/H'], 16 + 4 * n),
    L(b + 8, 'Triggering', g, s, ['Freewheel', 'Keysync'], 24 + 2 * n),
    L(180 + n, 'LFO range', g, s, ['Slow', 'Norm', 'Fast'], 28 + 3 * n),
    U(b + 2, 'Offset amount', g, s),
    S(b + 4, 'Env 3 speed mod', g, s),
    S(b + 5, 'MWh speed mod', g, s),
    S(b + 6, 'AT speed mod', g, s),
    P(b + 7, 'Sync', g, s, { options: O.sync }), // packed NRPN 110: 40+40n + 0..34
    U(PROGRAM_SIZE + n, 'LFO slew amount', g, s), // NRPN 120, MSB 1+n
    BIT(PROGRAM_SIZE + 3, 3 + n, 'LFO delay fade', g, s, ['In', 'Out']), // NRPN 120, MSB 114+n
    BIT(PROGRAM_SIZE + 41, n, 'LFO delay mode', g, s, ['Fade', 'Gate']), // NRPN 122, MSB 112+n
    P(PROGRAM_SIZE + 39 + n, 'LFO delay sync', g, s, { options: O.sync }), // NRPN 122, MSB 60+n
    L(b + 9, 'Delay trigger', g, s, ['Multi', 'Single'], 124 + 2 * n), // packed NRPN 0: 124+2n
  ];
}

/** Envelopes: Env 1 (amplitude) 194-200, Env 2 188-193, Env 3 182-187; OS 2 settings in the second block. */
function envelope(n) {
  const b = [194, 188, 182][n];
  const g = `Env ${n + 1}`;
  const s = 'env';
  const e = PROGRAM_SIZE;
  return [
    ...(n ? [U(b + 5, 'Delay', g, s)] : []),
    U(b, 'Attack', g, s), U(b + 1, 'Decay', g, s), U(b + 2, 'Sustain', g, s), U(b + 3, 'Release', g, s),
    S(b + 4, 'Velocity', g, s),
    ...(n ? [] : [S(199, 'Env 1 MWheel', g, s), S(200, 'Env 1 ATouch', g, s)]),
    S(e + 4 + n, 'Key track', g, s), // NRPN 120, MSB 8+n
    P(e + 13 + n, 'A-D repeat', g, s, { options: O.adRepeat }), // NRPN 120, MSB 118+n (list at 6A088: Off, 001-126, Inf)
    U(e + 16 + n, 'Sust time', g, s), // NRPN 120, MSB 121+n
    S(e + 19 + n, 'Sust rate', g, s), // NRPN 122, MSB 4+n
    S(e + 22 + n, 'Lev track', g, s), // NRPN 122, MSB 1+n
    P(e + 25 + n, 'Lev note', g, s, { options: O.notes }), // NRPN 122, MSB 7+n
  ];
}

/** Filter: 207-230 and the OS 2 width / bypass settings. */
const FILTER_TYPES = [[3, 'LPF'], [4, 'BPF'], [5, 'HPF'], ...named(['Res LPF', 'Res BPF', 'Res HPF', 'Notch', 'LPF+LPF', 'BPF+BPF', 'HPF+HPF', 'LPF+BPF', 'BPF+HPF'], 6)];
function filter() {
  const g = 'Filter';
  const s = 'filter';
  const mod = (o, what, src) => S(o, `${what} mod. ${src}`, `${g} modulation`, s);
  return [
    U(211, 'Filter cutoff', g, s), U(221, 'Filter resonance', g, s), U(210, 'Filter overdrive', g, s),
    P(207, 'Filter type', g, s, { options: FILTER_TYPES }), // packed NRPN 1, 3-14 (the OS 2 list at 6A758 names 6-14)
    L(208, 'Slope', g, s, ['12dB', '18dB', '24dB']), // packed NRPN 1, 0-2 (front-panel LEDs)
    U(220, 'Filter tracking', g, s), U(PROGRAM_SIZE + 7, 'Filter width', g, s), U(230, 'Q norm amount', g, s),
    BIT(PROGRAM_SIZE + 3, 5, 'Oscs filt bypass', g, s), // NRPN 122, MSB 18
    S(PROGRAM_SIZE + 30, 'Overdrive curve', g, s), // NRPN 122, MSB 17 (menu field 713BC)
    mod(212, 'Freq', 'Wheel'), mod(214, 'Freq', 'Env 2'), mod(215, 'Freq', 'Env 3'), mod(216, 'Freq', 'LFO 1'), mod(217, 'Freq', 'LFO 2'),
    S(213, 'Fq AT amt', `${g} modulation`, s), S(218, 'Fq MWh LFO2 amt', `${g} modulation`, s), S(219, 'Fq AT LFO2 amt', `${g} modulation`, s),
    // the menu calls these "res" or "width" (dual filter types) mod.: one set of bytes
    mod(222, 'Res/width', 'Wheel'), mod(224, 'Res/width', 'Env 2'), mod(225, 'Res/width', 'Env 3'), mod(226, 'Res/width', 'LFO 1'), mod(227, 'Res/width', 'LFO 2'),
    S(223, 'Res/wid AT amt', `${g} modulation`, s), S(228, 'Res/wid MWh LFO2 amt', `${g} modulation`, s), S(229, 'Res/wid AT LFO2 amt', `${g} modulation`, s),
    // Derived by the firmware when Filter width / VCO drift change (NRPN 120 handler); kept for exact backups.
    P(209, 'Filter width step (derived)', g, s, { bits: 3, input: 'number', readOnly: true, help: 'Set by the SuperNova from Filter width: width / 8, at most 7. Not shown on its display; kept so a backup restores exactly. On the SuperNova and Nova (OS 4.1) this is the filter width itself (menu 00-56).' }),
  ];
}

/** Voice: portamento, glide, triggering, unison, modes (232-238 and the second block). */
function voice() {
  const g = 'Voice';
  const s = 'voice';
  const e = PROGRAM_SIZE;
  return [
    U(236, 'Program level', g, s, { help: 'Program level (pre effects); CC 7 in program mode, NRPN 120 MSB 3' }),
    BIT(237, 0, 'Osc mode', g, s, ['Percussive', 'Ensemble']), // packed NRPN 84: 84/85
    BIT(237, 1, 'Poly mode', g, s, ['1', '2']), // packed NRPN 84: 86/87
    BIT(238, 5, 'Unison', g, s), // packed NRPN 100: 81/82
    P(238, 'Polyphony', g, s, { bits: 2, options: named(['Mono', 'Poly'], 1), help: 'Mono or Poly in program mode (menu "polyphony"); in performance mode each part has its own Part polyphony.' }),
    P(238, 'Unison mode', g, s, { shift: 2, bits: 3, options: named(['2 voice', '3 voice', '4 voice', '5 voice', '6 voice', '7 voice', '8 voice']) }), // 83-89
    U(e + 2, 'Unison detune', g, s), // NRPN 120 MSB 6
    U(e + 8, 'VCO drift', g, s), // NRPN 120 MSB 14
    U(e + 28, 'Oscs start phase', g, s), // NRPN 122 MSB 11
    BIT(237, 2, 'Drum one-shot', g, s), // packed NRPN 100: 115/116
    U(231, 'Portamento', 'Portamento', s),
    L(233, 'Porta type', 'Portamento', s, ['Normal', 'Glissando'], 120), // packed NRPN 0: 120/121
    L(234, 'Porta mode', 'Portamento', s, ['Lin', 'Exp'], 122), // packed NRPN 0: 122/123
    L(232, 'Glide', 'Portamento', s, ['Normal glide', 'Auto glide', '2 semitones down', '2 semitones up', '5 semitones down', '5 semitones up', '7 semitones down', '7 semitones up', '12 semitones down', '12 semitones up'], 42), // packed NRPN 1
    // packed NRPN 1, 34-41: single/multi triggering of envelopes 1, 2, 3 (front-panel LEDs; Novation's table names)
    L(235, 'Envs triggering', 'Envelope triggering', s, ['Multi, Multi, Multi', 'Multi, Multi, Single', 'Multi, Single, Multi', 'Multi, Single, Single', 'Single, Multi, Multi', 'Single, Multi, Single', 'Single, Single, Multi', 'Single, Single, Single'], 34),
    P(e + 37, 'Env 2 delay sync', 'Envelope triggering', s, { options: O.sync }), // NRPN 122 MSB 58
    P(e + 38, 'Env 3 delay sync', 'Envelope triggering', s, { options: O.sync }), // NRPN 122 MSB 59
    P(209, 'VCO drift on (derived)', g, s, { shift: 3, bits: 1, options: O.onoff, readOnly: true, help: 'Set by the SuperNova when VCO drift is above 0; not shown on its display. On the SuperNova and Nova (OS 4.1) this is DCO / VCO mode.' }),
    BIT(e + 3, 0, '1*3 FM', 'Ring / FM', s), BIT(e + 3, 1, '2*3 FM', 'Ring / FM', s), BIT(e + 3, 2, 'Noise FM', 'Ring / FM', s), // NRPN 120 MSB 7: 0-2 on, 3-5 off
  ];
}

/** Arpeggiator: 239-253 and the second block. */
function arpeggiator() {
  const g = 'Arpeggiator';
  const s = 'arp';
  const e = PROGRAM_SIZE;
  const ord = 244; // packed NRPN 1, 122-127: fill-in (bit 0) and note ordering (bits 1-2) together
  return [
    P(240, 'Pattern bank', g, s, { options: named(['Mono', 'Poly', 'User(U)', 'User(V)', 'User(W)'], 76) }), // NRPN 1: 76-78, NRPN 122 MSB 43 for V/W
    U(241, 'Pattern no.', g, s, { help: 'CC 3' }),
    P(e + 32, 'Arp gate time', g, s, { min: 1, max: 99, format: (v) => `${v}%` }), // NRPN 122 MSB 48
    L(253, 'Arp gate time (OS 1)', g, s, ['25%', '50%', '75%', '99%'], 0, { help: 'The 25/50/75/99% gate earlier operating systems use; the SuperNova updates it with Arp gate time' }),
    L(248, 'Latch type', g, s, ['Constant', 'Pattern'], 79),
    L(245, 'Quantize', g, s, ['Off', 'Mode 1', 'Mode 2', 'Mode 3', 'Mode 4'], 81),
    L(242, 'Velocity', g, s, ['Played', 'Full (127)', 'Half (63)', 'Programmed'], 86),
    P(246, 'Octave range', g, s, { min: 1, max: 4 }), // packed NRPN 109: 1-4
    P(ord, 'Fill in', g, s, { min: 0, max: 1, options: O.onoff, get: (d) => (d[ord] - 122) & 1, set: (d, v) => { d[ord] = 122 + (((d[ord] - 122) >> 1) & 3) * 2 + (v & 1); } }),
    P(ord, 'Note ordering', g, s, { options: named(['Up', 'Down', 'Played']), get: (d) => Math.min(2, ((d[ord] - 122) >> 1) & 3), set: (d, v) => { d[ord] = 122 + v * 2 + ((d[ord] - 122) & 1); } }),
    P(252, 'Sync', g, s, { options: O.sync, help: 'Packed NRPN 110 0-33, stored + 1' }),
    L(243, 'Keysync', g, s, ['On', 'Off'], 74), // packed NRPN 1: 74/75 (front-panel; Novation's table)
    L(251, 'Real time trans', g, s, ['On', 'Off'], 92), // packed NRPN 1: 92/93
    BIT(209, 5, 'Constant pitch', g, s), // packed NRPN 1: 70/71
    BIT(209, 6, 'Output ranging', g, s, ['On', 'Off']), // packed NRPN 110: 78/79
    BIT(249, 0, 'Arp mute', g, s), // packed NRPN 1: 90/91
    P(249, 'Arpeggio notes to', g, s, { shift: 5, bits: 2, options: [[0, 'Program only'], [2, 'Program & MIDI'], [1, 'MIDI only']] }), // packed NRPN 1: 102-104
    P(e + 31, 'Output MIDI ch', g, s, { options: named(['Input', ...Array.from({ length: 16 }, (_, i) => String(i + 1))]) }), // NRPN 122 MSB 42
  ];
}

/** Front-panel selections the SuperNova keeps with each program (read through 1E408 by the menus). */
function panelState() {
  const g = 'Panel selections (saved with the program)';
  const s = 'voice';
  return [
    P(17, 'Category', 'Program', s, { options: named(['Bass', 'Hard bass', 'Soft lead', 'Hard lead', 'Portalead', 'Arpeggio', 'Motion', 'Bell', 'Pad', 'Strings', 'Keyboard', 'SFX', 'Drums', 'Pianos', 'Organ', 'Brass', 'User 1', 'User 2', 'User 3', 'User 4']) }), // list at 69BE8, read by 1E436
    L(18, 'Selected oscillator / mix source', g, s, ['Osc 1', 'Osc 2', 'Osc 3', 'Ring 1*3', 'Ring 2*3', 'Noise']),
    P(19, 'Osc mod. source', g, s, { shift: 3, bits: 3, options: named(['Env 2', 'Env 3', 'LFO 1', 'LFO 2', 'Wheel']) }),
    P(20, 'Filter mod. source', g, s, { shift: 4, bits: 3, options: named(['LFO 1', 'LFO 2', 'Env 2', 'Env 3', 'Wheel']) }),
    P(21, 'Selected LFO', g, s, { shift: 2, bits: 2, options: named(['LFO 1', 'LFO 2']) }),
    P(21, 'Selected envelope', g, s, { shift: 4, bits: 2, options: named(['Env 2', 'Env 3', 'Env 1']) }),
    // Pages of panel sections, kept with the program and restored when it loads. Named from what the
    // display shows after each button, found by pressing every switch in the OS's own code run in an
    // emulator (tools/novation/h8; docs/devices/novation-supernova2.md, "Panel selections").
    L(19, 'Osc page', g, s, ['Pitch', 'Width', 'Sync', 'Mix', 'Harden'], 0, { bits: 3, help: 'The oscillator parameter pair the knobs and display show: "Pitch level / Pitch mod.", "Width level / Width mod.", "Sync level / Sync mod.", "Mix level / Mix mod.", "Harden level / Harden mod." (the five osc buttons; stored with the program)' }),
    L(20, 'Filter mod. page', g, s, ['Freq', 'Res/width'], 0, { bits: 4, help: 'SuperNova (OS 4.1) only: which mods its single "Filter mod." knob edits, Freq mod. or Res/width mod. The SuperNova II and Nova II show both ("Filter freq mod" / "Filter res mod") and do not use this.' }),
    L(21, 'Tune page', g, s, ['Fine tune', 'Coarse tune', 'Octave'], 0, { bits: 2, help: 'SuperNova (OS 4.1) only: what its tune knob edits, "Fine tune (cents)", "Coarse tune (semitones)" or "Octave (octaves)". The SuperNova II and Nova II do not use this.' }),
    L(237, 'Effects page', g, s, ['Distortion', 'Reverb', 'Chorus', 'Delay', 'Pan', 'Fx config', 'Vocoder'], 0, { shift: 4, bits: 3, help: 'Nova and Nova II: which effect the effects knobs edit (the knob shows "Distortion drive", "Reverb send", "Chorus send", "Delay send", "Pan position", "Fx config", "Vocoder balance"). The SuperNova II has a button per effect and does not use this.' }),
  ];
}

/**
 * Effects: the same 32 bytes in a program (254-285, used when the part's Effects used is
 * Program) and in each performance part (part byte 12 on). The controller map gives them the
 * ids 2710h + n, n the byte (table 6525C); labels and displays are the effect menu fields.
 */
function effects(at, section, prefix = '') {
  const g = (x) => `${prefix}${x}`;
  return [
    U(at + 0, 'Distortion drive', g('Distortion'), section), S(at + 1, 'Distortion wheel', g('Distortion'), section),
    S(at + 3, 'EQ treble', g('EQ'), section), S(at + 2, 'EQ bass', g('EQ'), section),
    U(at + 4, 'Comb frequency', g('Comb filter'), section), S(at + 5, 'Comb boost', g('Comb filter'), section),
    P(at + 7, 'Pan position', g('Panning'), section, { options: named(FW.PAN) }),
    U(at + 8, 'Pan speed', g('Panning'), section), U(at + 9, 'Pan depth', g('Panning'), section), U(at + 6, 'Dry level', g('Panning'), section),
    U(at + 11, 'Reverb send', g('Reverb'), section), S(at + 12, 'Reverb wheel', g('Reverb'), section),
    P(at + 15, 'Type', g('Reverb'), section, { shift: 3, bits: 4, options: named(FW.REVERB_TYPES) }), // CC 100 bits 3-6
    P(at + 15, 'Early ref level', g('Reverb'), section, { bits: 3, min: 0, max: 7 }), // CC 100 bits 0-2
    U(at + 13, 'Reverb decay', g('Reverb'), section), U(at + 14, 'Reverb HF damp', g('Reverb'), section),
    U(at + 16, 'Chorus send', g('Chorus'), section), S(at + 17, 'Wheel level', g('Chorus'), section),
    U(at + 18, 'Speed 1', g('Chorus'), section), U(at + 19, 'Mod depth', g('Chorus'), section), S(at + 20, 'Feedback', g('Chorus'), section),
    U(at + 22, 'Delay send', g('Delay'), section), S(at + 23, 'Delay wheel', g('Delay'), section),
    U(at + 24, 'Delay time', g('Delay'), section), U(at + 25, 'Feedback', g('Delay'), section), U(at + 26, 'Delay HF damp', g('Delay'), section),
    U(at + 28, 'Stereo width', g('Delay'), section),
    U(at + 31, 'Config morph', g('Configuration'), section),
    L(at + 10, 'Pan type', g('Panning'), section, FW.PAN_TYPES, 55), // packed NRPN 1: 55-58
    BIT(at + 21, 4, 'Pan effects', g('Panning'), section, ['No', 'Yes']), // packed NRPN 100: 100/101
    P(at + 27, 'Delay ratio', g('Delay'), section, { options: named(FW.DELAY_RATIOS, 96) }), // packed NRPN 109: 96-108
    P(at + 29, 'Sync', g('Delay'), section, { options: O.sync }), // packed NRPN 100: 0-34
    P(at + 30, 'Fx config', g('Configuration'), section, { options: named(FW.FX_CONFIGS) }), // packed NRPN 113: 36-54
    P(at + 21, 'Pass to effects', g('Configuration'), section, { // packed NRPN 113: 71-75: bit 5 program, bit 6 audio input, bit 2 input (2)
      options: named(FW.PASS_TO_FX),
      get: (d) => passGet(d[at + 21]),
      set: (d, v) => { d[at + 21] = passSet(d[at + 21], v); },
    }),
  ];
}
/** Pass to effects from bits 5 (program), 6 (audio input) and 2 (input 2, only with bit 6). */
function passGet(b) {
  if (!(b & 0x40)) return 0;
  return (b & 0x20 ? 2 : 1) + (b & 0x04 ? 2 : 0);
}
function passSet(b, v) {
  if (v === 0) return (b & ~0x40) | 0x20;
  return (b & ~0x64) | 0x40 | (v === 2 || v === 4 ? 0x20 : 0) | (v >= 3 ? 0x04 : 0);
}

/**
 * OS 2 effect settings: 32 bytes in the program's second block (from 56) and the first 32 of each
 * part's 40 bytes in performance message 20. NRPN 120/122 numbers in the comments.
 */
function effects2(at, chorusAt, section, prefix = '') {
  const g = (x) => `${prefix}${x}`;
  return [
    BIT(at, 0, 'Effects bypass', g('Configuration'), section), // 120/11
    BIT(at, 1, 'Wheel mode', g('Chorus'), section, FW.WHEEL_MODE), // 122/26
    P(at + 1, 'Type', g('Chorus'), section, { // the three OS 1 types live in the first block (byte 21 bits 0-1)
      options: named(FW.CHORUS_TYPES),
      get: (d) => (d[at + 1] ? Math.min(4, 2 + d[at + 1]) : d[chorusAt] & 3),
      set: (d, v) => { if (v >= 3) d[at + 1] = v - 2; else { d[at + 1] = 0; d[chorusAt] = (d[chorusAt] & ~3) | v; } },
    }),
    S(at + 2, 'Output level', g('Distortion'), section), S(at + 3, 'Gain compensate', g('Distortion'), section), S(at + 4, 'Distortion curve', g('Distortion'), section), // 120/112, 122/19, 122/20
    U(at + 8, 'Comb speed', g('Comb filter'), section), S(at + 9, 'Comb depth', g('Comb filter'), section), S(at + 7, 'Comb spread', g('Comb filter'), section), // 122/27-29
    S(at + 6, 'Comb freq wheel', g('Comb filter'), section), S(at + 5, 'Comb boost wheel', g('Comb filter'), section), // 120/124, 122/30
    P(at + 18, 'Sync', g('Comb filter'), section, { options: O.sync }), // 122/63
    U(at + 10, 'Chorus delay', g('Chorus'), section), P(at + 11, 'LFO wave', g('Chorus'), section, { options: named(FW.CHORUS_LFO) }), // 122/21, 22
    U(at + 13, 'Speed 2', g('Chorus'), section), U(at + 14, 'Inertia', g('Chorus'), section), U(at + 12, 'Stereo width', g('Chorus'), section), // 122/23-25
    P(at + 17, 'Sync', g('Chorus'), section, { options: O.sync }), // 122/47
    P(at + 16, 'Sync', g('Panning'), section, { options: O.sync }), // 122/62
  ];
}

// ------------------------------------------------------------------ reading from the unit
/** Send a request and collect the SysEx replies of the given types (count messages, or until quiet). */
async function collect(api, request, types, count, bytes) {
  const c = api.g.client;
  const bps = c.s?.bytesPerSecond ?? 3000;
  const timeout = (c.s?.timeout ?? 2500) + (bytes / bps) * 1000 + 1500;
  const r = await c.request(Uint8Array.from(request), {
    collect: (_m, raw) => types.includes(typeOf(raw)),
    complete: (list) => list.length >= count,
    timeout, quiet: 2500, resolveOnQuiet: true,
  });
  const msgs = (r.messages || []).map((m) => Uint8Array.from(m.raw ?? m));
  if (msgs.length && (msgs[0][5] === 0x22 || msgs[0][5] === 0x24)) unit.model = msgs[0][5];
  return msgs;
}

/** Program data (374 bytes) from a 00/02 message and its 1E/1F partner. */
export function programFrom(main, ext) {
  const d = new Uint8Array(PROG_DATA);
  d.set(dataOf(main).slice(0, PROGRAM_SIZE));
  if (ext) d.set(dataOf(ext).slice(0, PROGRAM_EXT_SIZE), PROGRAM_SIZE);
  return d;
}
export function performanceFrom(main, ext, fx) {
  const d = new Uint8Array(PERF_DATA);
  d.set(dataOf(main).slice(0, PERF_SIZE));
  if (ext) d.set(dataOf(ext).slice(0, PERF_EXT_SIZE), PERF_SIZE);
  if (fx) d.set(dataOf(fx).slice(0, PERF_FX_SIZE), PERF_SIZE + PERF_EXT_SIZE);
  return d;
}

async function fetchProgram(api) {
  const m = await collect(api, msg.currentProgramRequest(api.ctx), [0x00, 0x1e], 2, 400);
  const main = m.find((x) => typeOf(x) === 0x00);
  if (!main) throw new Error('The SuperNova II did not send its current program.');
  return programFrom(main, m.find((x) => typeOf(x) === 0x1e));
}

async function fetchPerformance(api) {
  const m = await collect(api, msg.currentPerformanceRequest(api.ctx), [0x00, 0x1e, 0x05, 0x1b, 0x20], 19, 4100);
  const main = m.find((x) => typeOf(x) === 0x05);
  if (!main) throw new Error('The SuperNova II did not send its current performance.');
  // the parts' programs come first: keep their names for the parts pages
  unit.partNames = Array.from({ length: 8 }, (_, i) => {
    const p = m.find((x) => typeOf(x) === 0x00 && x[8] === i);
    return p ? nameOf(dataOf(p)) : null;
  });
  return performanceFrom(main, m.find((x) => typeOf(x) === 0x1b), m.find((x) => typeOf(x) === 0x20));
}

async function fetchStoredProgram(api, bank, slot) {
  const m = await collect(api, msg.singleRequest(api.ctx, bank, slot), [0x02, 0x1f], 2, 400);
  const main = m.find((x) => typeOf(x) === 0x02);
  if (!main) throw new Error(`No reply for ${bankName(bank)} ${slot}.`);
  return programFrom(main, m.find((x) => typeOf(x) === 0x1f));
}

async function fetchStoredPerformance(api, bank, slot) {
  const m = await collect(api, msg.singleRequest(api.ctx, bank, slot), [0x07, 0x1c, 0x21], 3, 900);
  const main = m.find((x) => typeOf(x) === 0x07);
  if (!main) throw new Error(`No reply for ${bankName(bank)} ${slot}.`);
  return performanceFrom(main, m.find((x) => typeOf(x) === 0x1c), m.find((x) => typeOf(x) === 0x21));
}

/** Names of a whole bank from one bank request (12 bb): 128 programs (50 drums) or performances. */
function scanBank(kind) {
  return async (api, bank, onName) => {
    const n = kind === 'perf' ? 128 : bankSize(bank);
    const per = kind === 'perf' ? 3 : 2;
    const types = kind === 'perf' ? [0x07, 0x1c, 0x21] : [0x02, 0x1f];
    const m = await collect(api, msg.bankRequest(api.ctx, bank), types, n * per, n * (kind === 'perf' ? 880 : 400));
    for (const x of m) if (typeOf(x) === types[0] && x[8] === bank) onName(x[9], nameOf(dataOf(x)));
  };
}

export const nameOf = (d) => readText(d, 0, 16, (b) => (b < 32 || b > 126 ? 32 : b));
const ch = (ctx) => (ctx?.channel ?? 0) & 15;
/** Bank select LSB + program change on the global channel (CC 0 is sent as 0, as the manual recommends). */
const select = (ctx, bank, slot) => [[0xb0 | ch(ctx), 0, 0], [0xb0 | ch(ctx), 32, bank], [0xc0 | ch(ctx), slot]];
const slotNumber = (i) => String(i).padStart(3, '0');

// ------------------------------------------------------------------ Branch Library and files
/** Group a dump into programs, performances, global data and the rest. */
function libraryItems(msgs) {
  const items = [];
  const used = new Set();
  const find = (from, type, test) => {
    for (let k = from; k < msgs.length && k < from + 4; k++) if (!used.has(k) && typeOf(msgs[k]) === type && test(msgs[k])) return k;
    return -1;
  };
  msgs.forEach((m, i) => {
    if (used.has(i)) return;
    const t = typeOf(m);
    const same = (x) => x[8] === m[8] && x[9] === m[9];
    const take = (list) => { list.forEach((k) => used.add(k)); return list.map((k) => msgs[k]); };
    if (t === 0x02) {
      const e = find(i + 1, 0x1f, same);
      items.push({ key: `p${m[8]}:${m[9]}`, label: `${bankName(m[8])} ${slotNumber(m[9])}`, name: nameOf(dataOf(m)), object: 'program', msgs: take([i, ...(e >= 0 ? [e] : [])]) });
    } else if (t === 0x00) {
      const e = find(i + 1, 0x1e, (x) => x[8] === m[8]);
      items.push({ key: `e${i}`, label: `Current program (part ${m[8] === 9 ? 'current' : m[8] + 1})`, name: nameOf(dataOf(m)), object: 'program', msgs: take([i, ...(e >= 0 ? [e] : [])]) });
    } else if (t === 0x07) {
      const a = find(i + 1, 0x1c, same);
      const b = find(i + 1, 0x21, same);
      items.push({ key: `f${m[8]}:${m[9]}`, label: `${bankName(m[8])} ${slotNumber(m[9])}`, name: nameOf(dataOf(m)), object: 'performance', msgs: take([i, ...[a, b].filter((k) => k >= 0)]) });
    } else if (t === 0x05) {
      const a = find(i + 1, 0x1b, () => true);
      const b = find(i + 1, 0x20, () => true);
      items.push({ key: `c${i}`, label: 'Current performance', name: nameOf(dataOf(m)), object: 'performance', msgs: take([i, ...[a, b].filter((k) => k >= 0)]) });
    } else if (t === 0x0a || t === 0x0c || t === 0x22) {
      used.add(i);
      items.push({ key: `a${i}`, label: t === 0x0a ? `Pattern edit buffer (${slotNumber(m[8])})` : patLabel(t === 0x22 ? m[8] : 15, t === 0x22 ? m[9] : m[8]), name: '', object: 'pattern', msgs: [m] });
    } else if (t === 0x0f) {
      const a = find(i + 1, 0x15, () => true);
      items.push({ key: `g${i}`, label: 'Global data', name: '', object: 'global', msgs: take([i, ...(a >= 0 ? [a] : [])]) });
    } else {
      used.add(i);
      items.push({ key: `x${i}`, label: describe(m) || 'Other message', name: '', object: null, msgs: [m] });
    }
  });
  return items;
}

function programFromSyx(msgs) {
  const i = msgs.findIndex((m) => typeOf(m) === 0x00 || typeOf(m) === 0x02);
  if (i < 0) return null;
  const m = msgs[i];
  const ext = msgs.slice(i + 1).find((x) => typeOf(x) === (typeOf(m) === 0x00 ? 0x1e : 0x1f));
  return programFrom(m, ext);
}
function performanceFromSyx(msgs) {
  const i = msgs.findIndex((m) => typeOf(m) === 0x05 || typeOf(m) === 0x07);
  if (i < 0) return null;
  const cur = typeOf(msgs[i]) === 0x05;
  const rest = msgs.slice(i + 1);
  return performanceFrom(msgs[i], rest.find((x) => typeOf(x) === (cur ? 0x1b : 0x1c)), rest.find((x) => typeOf(x) === (cur ? 0x20 : 0x21)));
}
function globalFromSyx(msgs) {
  const m = msgs.find((x) => typeOf(x) === 0x0f);
  if (!m) return null;
  const d = new Uint8Array(GLOBAL_SIZE + GLOBAL_EXT_SIZE);
  d.set(dataOf(m).slice(0, GLOBAL_SIZE));
  const e = msgs.find((x) => typeOf(x) === 0x15);
  if (e) d.set(dataOf(e).slice(0, GLOBAL_EXT_SIZE), GLOBAL_SIZE);
  else d.set(d.slice(16, 16 + 256), GLOBAL_SIZE + 32); // OS 1: only message 0F, its map is the map
  return d;
}

// ------------------------------------------------------------------ simulator (demo mode, tests)
function simulate() {
  const named16 = (d, s) => { for (let i = 0; i < 16; i++) d[i] = s.charCodeAt(i) || 32; return d; };
  const progs = new Map(); // `${bank}:${slot}` -> program data
  const perfs = new Map();
  for (const [b] of [...PROG_BANKS, ...DRUM_BANKS]) for (let i = 0; i < bankSize(b); i++) progs.set(`${b}:${i}`, named16(initProgram(), `${bankName(b).slice(-1)}${slotNumber(i)} Program`));
  for (const [b] of PERF_BANKS) for (let i = 0; i < 128; i++) perfs.set(`${b}:${i}`, named16(initPerformance(), `${bankName(b).slice(-1)}${slotNumber(i)} Performance`));
  const s = { parts: Array.from({ length: 8 }, () => initProgram()), current: 0, perf: initPerformance(), global: new Uint8Array(GLOBAL_SIZE + GLOBAL_EXT_SIZE), protect: false };
  const out = (type, pre, data) => [0xf0, ...MAKER, 0x24, 0x0f, type, ...pre, ...body(data), 0xf7];
  const progMsgs = (t1, t2, pre, d) => [out(t1, pre, d.slice(0, PROGRAM_SIZE)), out(t2, pre, d.slice(PROGRAM_SIZE))];
  const perfMsgs = (cur, pre, d) => [out(cur ? 0x05 : 0x07, pre, d.slice(0, PERF_SIZE)), out(cur ? 0x1b : 0x1c, pre, d.slice(PERF_SIZE, PERF_SIZE + PERF_EXT_SIZE)), out(cur ? 0x20 : 0x21, pre, d.slice(PERF_SIZE + PERF_EXT_SIZE))];
  const part = (p) => (p === 9 ? s.current : p & 7);
  return {
    state: s, progs, perfs,
    handle(raw) {
      const d = Array.from(raw);
      if (d[0] !== 0xf0) return (d[0] & 0xf0) === 0xc0 || (d[0] & 0xf0) === 0xb0 ? [] : null;
      if (d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) return [[0xf0, 0x7e, 0x0f, 0x06, 0x02, 0x00, 0x20, 0x29, 0x01, 0x00, 0x24, 0x00, 0x28, 0x00, 0x00, 0x00, 0xf7]];
      if (!isSN2(d)) return null;
      const t = d[7];
      const data = Uint8Array.from(d.slice(DATA_AT[t] ?? 8, -1));
      const key = `${d[8]}:${d[9]}`;
      switch (t) {
        case 0x03: return progMsgs(0x00, 0x1e, [9], s.parts[s.current]);
        case 0x08: return [...s.parts.flatMap((p, i) => progMsgs(0x00, 0x1e, [i], p)), ...perfMsgs(true, [], s.perf)];
        case 0x10: return [out(0x0f, [], s.global.slice(0, GLOBAL_SIZE)), out(0x15, [], s.global.slice(GLOBAL_SIZE))];
        case 0x13:
          if (progs.has(key)) return progMsgs(0x02, 0x1f, [d[8], d[9]], progs.get(key));
          if (perfs.has(key)) return perfMsgs(false, [d[8], d[9]], perfs.get(key));
          return [];
        case 0x12:
          if (d[8] >= 1 && d[8] <= 4) return Array.from({ length: 128 }, (_, i) => perfMsgs(false, [d[8], i], perfs.get(`${d[8]}:${i}`))).flat();
          return Array.from({ length: bankSize(d[8]) }, (_, i) => progMsgs(0x02, 0x1f, [d[8], i], progs.get(`${d[8]}:${i}`))).flat();
        case 0x00: s.parts[part(d[8])].set(data.slice(0, PROGRAM_SIZE)); return [];
        case 0x1e: s.parts[part(d[8])].set(data.slice(0, PROGRAM_EXT_SIZE), PROGRAM_SIZE); return [];
        case 0x05: s.perf.set(data.slice(0, PERF_SIZE)); return [];
        case 0x1b: s.perf.set(data.slice(0, PERF_EXT_SIZE), PERF_SIZE); return [];
        case 0x20: s.perf.set(data.slice(0, PERF_FX_SIZE), PERF_SIZE + PERF_EXT_SIZE); return [];
        case 0x02: case 0x1f: {
          if (s.protect || !progs.has(key)) return [];
          const p = progs.get(key);
          if (t === 0x02) p.set(data.slice(0, PROGRAM_SIZE)); else p.set(data.slice(0, PROGRAM_EXT_SIZE), PROGRAM_SIZE);
          return [];
        }
        case 0x07: case 0x1c: case 0x21: {
          if (s.protect || !perfs.has(key)) return [];
          const p = perfs.get(key);
          if (t === 0x07) p.set(data.slice(0, PERF_SIZE)); else if (t === 0x1c) p.set(data.slice(0, PERF_EXT_SIZE), PERF_SIZE); else p.set(data.slice(0, PERF_FX_SIZE), PERF_SIZE + PERF_EXT_SIZE);
          return [];
        }
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ program parameter list
const PROGRAM = [
  ...Array.from({ length: 16 }, (_, i) => P(i, `Name ${i + 1}`, 'Name', 'voice', { hidden: true })),
  ...panelState(),
  U(16, 'Vocoder balance', 'Program', 'voice', { help: 'NRPN 102: kept in the program in program mode (in the performance in performance mode)' }),
  ...[0, 1, 2].flatMap(oscillator),
  ...mixer(),
  U(201, 'Noise harden level', 'Noise', 'mix'), ...mods(202, 'Noise harden', 'Noise', 'mix'), // CC 24 and NRPN 60-64
  ...lfo(0), ...lfo(1),
  ...envelope(0), ...envelope(1), ...envelope(2),
  ...filter(),
  ...voice(),
  ...arpeggiator(),
  P(PROGRAM_SIZE + 29, 'Drum played as', 'Drum', 'voice', { options: O.notes, help: 'NRPN 122 MSB 10: the key a drum map sound plays on' }),
  ...effects(254, 'fx'),
  ...effects2(PROGRAM_SIZE + 56, 254 + 21, 'fx2', 'OS 2 '),
  // Arpeggiator settings a program keeps for program mode (in performance mode they come from the
  // performance): CC 9 and NRPN 1 72/73 write them only when the SuperNova is in program mode.
  P(239, 'Arpeggio speed (program mode)', 'Arpeggiator', 'arp', { min: 0, max: 127, format: (v) => `${v + 64} b.p.m.`, help: 'CC 9 in program mode; the performance keeps its own' }),
  P(250, 'Arpeggiator (program mode)', 'Arpeggiator', 'arp', { options: [[72, 'On'], [73, 'Off']], help: 'The arpeggiator switch in program mode; a part has its own' }),
  P(247, 'Arp latch', 'Arpeggiator', 'arp', { options: [[0, 'Off'], [1, 'On']], help: 'CC 65 (64-127 on)' }),
  // Keyboard settings a program keeps for program mode (the performance has its own: message 20
  // bytes 448-452). Found in the Keyboard OS 2.0 and Nova II OS run in an emulator: in program mode
  // NRPN 120 MSB 5 / 4 / 113 / 12 write 1E 10 / 11 / 12 / 3 bit 6 (in performance mode 449 / 450 /
  // 452 / 451); a program stored with 1E 9 = 61 and selected plays its keys three octaves down.
  P(PROGRAM_SIZE + 9, 'Keyboard octave', 'Keyboard (program mode)', 'arp', { options: named(['-3', '-2', '-1', '0', '+1', '+2', '+3'], 61), help: 'Keyboard menu "Keyboard octave" (61-67; the Nova II goes to +4): applied when the program is selected in program mode. The Rack keeps it but has no keys', ...KBD_ONLY }),
  P(PROGRAM_SIZE + 10, 'Kbd t-zone hi', 'Keyboard (program mode)', 'arp', { options: O.notes, help: 'Keyboard menu "Kbd t-zone hi": NRPN 120 MSB 5 in program mode', ...KBD_ONLY }),
  P(PROGRAM_SIZE + 11, 'Kbd t-zone lo', 'Keyboard (program mode)', 'arp', { options: O.notes, help: 'Keyboard menu "Kbd t-zone lo": NRPN 120 MSB 4 in program mode', ...KBD_ONLY }),
  S(PROGRAM_SIZE + 12, 'zone detune', 'Keyboard (program mode)', 'arp', { help: 'Keyboard menu "zone detune" (signed): NRPN 120 MSB 113 in program mode', ...KBD_ONLY }),
  BIT(PROGRAM_SIZE + 3, 6, 'Kbd t-zone', 'Keyboard (program mode)', 'arp', ['Off', 'On'], { help: 'The transpose zone switch: NRPN 120 MSB 12 in program mode (no menu field; the performance keeps its own)', ...KBD_ONLY }),
  BIT(237, 3, 'Constant gate', 'Voice', 'voice'), // packed NRPN 100: 79/80 (handler DB2E)
  BIT(249, 1, 'Vocoder input (program mode)', 'Vocoder', 'voice', ['Input (1)', 'Input (2)']), // packed NRPN 113 18/19 in program mode (E7D0)
  // With the digital I/O option card: the digital inputs as waves, vocoder input and effects input.
  ...[0, 1, 2].map((n) => P(PROGRAM_SIZE + 33 + n, 'Digital input wave', `Osc ${n + 1}`, 'osc', { options: [[0, 'None (the wave above)'], ...Array.from({ length: 8 }, (_, i) => [i + 1, `Dig in (${i + 1})`])], help: 'Used with the digital I/O option card; choosing a wave above clears it' })),
  P(PROGRAM_SIZE + 36, 'Vocoder input, digital', 'Vocoder', 'voice', { options: [[0, 'None (input above)'], ...Array.from({ length: 8 }, (_, i) => [i + 1, `Digital input (${i + 1})`])], help: 'With the digital I/O option card; the vocoder input above clears it' }),
  P(PROGRAM_SIZE + 71, 'Pass to effects, digital', 'OS 2 Configuration', 'fx2', { options: DIGITAL_PASS, help: 'With the digital I/O option card; Pass to effects clears it' }),
  BIT(238, 6, 'Format marker', 'Format', 'voice', ['Clear', 'Set'], { readOnly: true, help: 'Set by the SuperNova before it sends a program (the SuperNova and Nova set it too); shown for information' }),
  BIT(249, 2, 'Format marker (2)', 'Format', 'voice', ['Clear', 'Set'], { readOnly: true, help: 'Set by the SuperNova before it sends a program. It marks programs in the newer value scale: a SuperNova or Nova converts a program without it when it arrives' }),
  ...[...Array.from({ length: 14 }, (_, i) => 42 + i), ...Array.from({ length: 12 }, (_, i) => 76 + i)].map((k) => RES(PROGRAM_SIZE + k, `1E ${k}`, 'fx2', 'Not used: the SuperNova always sends 0 here')),
];

// Bytes and bits not identified yet: no NRPN, CC or menu field of OS 2.0 has been found to reach
// them (docs/devices/novation-supernova2.md); shown as typed values so a backup restores exactly.
const PROGRAM_SPARE = [75].map((x) => PROGRAM_SIZE + x);
/**
 * Bytes no menu field, CC, NRPN or reader of any of the SuperNova II, Nova II and OS 4.1 images was
 * found to use (docs/devices/novation-supernova2.md, "Not identified yet"); shown read-only with what
 * the firmware and the factory sounds show about them, so a backup restores exactly.
 */
const SPARE_HELP = {
  [PROGRAM_SIZE + 75]: '0 in every factory program; the SuperNova only keeps and sends it',
  [PERF_SIZE + 5]: 'Not used: the SuperNova II sends 0 here; 3 or 4 in the Nova\'s factory performances, whose vocoder settings differ',
  [PERF_SIZE + 8]: 'Kept and sent as stored; no menu or controller of the SuperNova II reaches it',
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [PERF_SIZE + 9 + i, 'Not used: the SuperNova always sends 0 here'])),
  // message 20, part block byte 20: the Keyboard OS keeps External part n's first MIDI stream byte here
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [PERF_SIZE + PERF_EXT_SIZE + 40 * i + 20, `SuperNova II Keyboard: the first MIDI stream byte of External part ${i + 1} (NRPN 122 MSB ${96 + i} / ${104 + i}, the second also setting its stream flag); the Rack neither sets nor reads it. 0 in the factory performances`])),
};
const spare = (o, section, base = 0, tag = '') => P(o, `${tag}${(o - base).toString(16).toUpperCase().padStart(2, '0')}h`, 'Reserved', section, {
  input: 'number', readOnly: true, min: 0, max: 127,
  help: SPARE_HELP[o] ?? '0 in every factory sound; no menu or controller of any SuperNova or Nova reaches it',
});

// ------------------------------------------------------------------ performance
// 372 bytes (message 05): name, 4 common bytes, then 8 parts of 44 bytes from 20: 12 part
// settings, then the part's 32-byte effect block. Message 1B: vocoder settings. Message 20: each
// part's 40 OS 2 bytes (32 effect settings, switches), then 144 bytes of the OS 2 performance.
const PART = (i) => 20 + 44 * i;
const PFX = (i) => PERF_SIZE + PERF_EXT_SIZE + 40 * i;
const MIDI_CHANNELS = [...Array.from({ length: 16 }, (_, i) => [i, String(i + 1)]), [16, 'Omni'], [17, 'Global']];
const PROG_BANK_OPTS = [...PROG_BANKS, ...DRUM_BANKS];
const SWITCH_OPTS = ['Off', 'Sustain', 'Arp latch', 'Arp mute', 'Part mute', 'Sustain(I)', 'Arp latch(I)', 'Arp mute(I)', 'Part mute(I)', 'Program + 1', 'Program - 1', 'Pattern + 1', 'Pattern - 1', 'Voc freeze'];
const SUS_OPTS = ['Enable', 'Arp latch', 'Arp mute', 'Part mute', 'Enable(I)', 'Arp latch(I)', 'Arp mute(I)', 'Part mute(I)', 'Program + 1', 'Program - 1', 'Pattern + 1', 'Pattern - 1', 'Voc freeze', 'Off'];
const VEL_CURVES = ['Normal', 'Inverse', 'Cross fade - High', 'Cross fade - Low', 'To value 60', 'From value 61', 'To value 70', 'From value 71', 'To value 80', 'From value 81', 'To value 90', 'From value 91', 'To value 100', 'From value 101', 'To value 110', 'From value 111'];

function programOptions(bank, ctx) {
  const names = ctx?.names?.program;
  return Array.from({ length: bankSize(bank) }, (_, i) => {
    const n = names?.get(`${bank}:${i}`);
    return [i, `${slotNumber(i)}${n ? ` ${n}` : ''}`];
  });
}

function partParams(i) {
  const b = PART(i);
  const s = `part${i}`;
  const g = 'Part';
  const f = PFX(i);
  return [
    P(b + 1, 'Bank', g, s, { options: PROG_BANK_OPTS, relayout: true }),
    P(b, 'Program', g, s, { min: 0, max: 127, dynamic: (d, ctx) => ({ options: programOptions(d[b + 1], ctx) }) }),
    P(b + 2, 'MIDI channel', g, s, { options: MIDI_CHANNELS }), // packed NRPN 109: 48-65
    U(b + 11, 'Part level', g, s, { help: 'Post effects (CC 7 in performance mode)' }),
    P(b + 5, 'Part semitone', g, s, { bias: 64, min: -24, max: 24, format: plus }), // NRPN 111 (descriptor 6A7EC: 40-88)
    S(b + 6, 'Part detune', g, s), // NRPN 112
    P(b + 8, 'Lowest note', 'Key range', s, { options: O.notes }), P(b + 9, 'Highest note', 'Key range', s, { options: O.notes }), // NRPN 115, 114
    P(b + 10, 'Part polyphony', g, s, { bits: 2, options: named(['Off', 'Mono', 'Poly', 'Prog']) }), // packed NRPN 113: 0-3
    BIT(b + 10, 4, 'Arpeggiator', g, s), // packed NRPN 1: 72/73
    BIT(b + 10, 6, 'Effects used', g, s, ['Part', 'Program']), // packed NRPN 84: 75/76
    // Part mutes (packed NRPN 113: 63-70 mute part 1-8, 55-62 un-mute; perf mode only, E8B2/E9C2):
    // perf byte 19 bit n for parts 1-7; part 8's bit travels in byte 16 bit 6 (the transmitter moves
    // it there, 1D644; the receiver back, 1CC1C). Read when a performance loads (10812)
    i < 7 ? BIT(19, i, 'Part mute', g, s, ['Un-muted', 'Muted'], { help: 'Shown as "Part muted" / "Part un-muted"; packed NRPN 113 = ' + (63 + i) + ' / ' + (55 + i) + ' in performance mode. A muted part stays silent when the performance loads' })
      : BIT(16, 6, 'Part mute', g, s, ['Un-muted', 'Muted'], { help: 'Shown as "Part muted" / "Part un-muted"; packed NRPN 113 = 70 / 62 in performance mode. A muted part stays silent when the performance loads' }),
    P(b + 10, 'Expression pedal (Nova)', 'Reserved', s, { shift: 5, bits: 1, options: named(['Off', 'On']), readOnly: true, help: 'Only the Nova (OS 4.1) uses it, for its Expression pedal; the SuperNova II and Nova II do not. Kept so a backup restores exactly.' }),
    L(b + 3, 'Part outputs', g, s, ['1 & 2', '3 & 4', '5 & 6', '7 & 8'], 98), // packed NRPN 1: 98-101
    P(b + 7, 'Part velocity curve', g, s, { options: named(VEL_CURVES, 80) }), // packed NRPN 109: 80-95
    BIT(b + 10, 2, 'Prog change filt', 'MIDI', s), BIT(b + 10, 3, 'Controller filt', 'MIDI', s), // packed NRPN 110: 76/77, 116/117
    P(b + 4, 'Sus/sw2', 'MIDI', s, { options: named(SUS_OPTS, 77) }), // packed NRPN 84: 77-90
    P(f + 36, 'Sw1', 'MIDI', s, { options: named(SWITCH_OPTS) }), P(f + 37, 'Sw3', 'MIDI', s, { options: named(SWITCH_OPTS) }), // 122/31, 122/32
    BIT(f + 33, 3, 'Pedal/breath', 'MIDI', s), // 122/33
    BIT(f + 33, 6, 'Arp bank & pattern used from', g, s, ['Program', 'Part']), // 122/12 (Part sets the bit)
    // used instead of the program's Pattern bank / Pattern no. when the bit above is Part (15EC2)
    P(f + 34, 'Part arp pattern bank', g, s, { options: named(['Mono', 'Poly', 'User(U)', 'User(V)', 'User(W)'], 76) }),
    U(f + 35, 'Part arp pattern no.', g, s),
    ...effects(b + 12, s, 'FX '),
    ...effects2(f, b + 12 + 21, s, 'FX OS 2 '),
    P(f + 15, 'Pass to effects, digital', 'FX OS 2 Configuration', s, { options: DIGITAL_PASS, help: 'With the digital I/O option card; Pass to effects clears it' }),
    RES(f + 38, 'Part 20: 38', s, 'Not used: the SuperNova always sends 0 here'),
    RES(f + 39, 'Part 20: 39', s, 'Not used: the SuperNova always sends 0 here'),
  ];
}

/**
 * The 16 bytes of an External Part, from the SuperNova II Keyboard OS 2.0 run in an emulator
 * (tools/novation/h8): each NRPN 120 MSB 16 + 8 x field + part and NRPN 122 MSB 64-111 was sent and
 * the performance read back (docs/devices/novation-supernova2.md, "External Parts"). Labels and
 * displays are the Keyboard menus' (records 77816-78340 there).
 */
const TX_OPTS = ['Prog change', 'Bank change', 'Mod wheel', 'Pitch bend', 'Aftertouch', 'Volume', 'Sustain']; // menu "PBMWAVSN" 0-6
const YES_NO_INV = ['Yes', 'No']; // a set bit stops the transmission ("Tx ?" No)
function extPart(at, n) {
  const g = `External part ${n + 1}`;
  const o = at + 16 * n;
  const x = (k, label, extra) => P(o + k, `Ext ${n + 1} ${label}`, g, 'keyboard', { ...extra, ...KBD_ONLY });
  return [
    x(0, 'MIDI ch', {
      options: named(['Off', ...Array.from({ length: 16 }, (_, i) => String(i + 1))]),
      get: (d) => (d[o] & 0x40 ? (d[o] & 15) + 1 : 0),
      set: (d, v) => { d[o] = v ? (d[o] & 0x30) | 0x40 | ((v - 1) & 15) : d[o] & ~0x40; },
      help: 'Menu "Ext part MIDI ch" (Off, 1-16): NRPN 120 MSB 40 + part. Bit 6 is set while the part is on, bits 0-3 hold the channel',
    }),
    ...TX_OPTS.map((t, i) => x(1, `Tx ${t}`, { shift: 6 - i, bits: 1, options: named(YES_NO_INV), help: `Menu "PBMWAVSN" ${t} with "Tx ?": NRPN 120 MSB 64 + part = ${i} sets the bit (No), ${i + 7} clears it (Yes)` })),
    x(0, 'Tx Kbd notes', { shift: 5, bits: 1, options: named(YES_NO_INV), help: 'Menu "PBMWAVSN" Kbd notes with "Tx ?": NRPN 120 MSB 64 + part = 14 sets it (No), 15 clears it (Yes). With No the keys no longer play on the part\'s channel' }),
    x(0, 'Tx ext velocity', { shift: 4, bits: 1, options: named(YES_NO_INV), help: 'Menu "Tx ext  velocity" (No / Yes): NRPN 122 MSB 64 + part = 0 sets the bit, 1 clears it. With No the part plays at Default velocity' }),
    x(2, 'bank MSB', { min: 0, max: 127, help: 'Menu "Ext bank MSB": NRPN 120 MSB 88 + part' }),
    x(3, 'bank LSB', { min: 0, max: 127, help: 'Menu "Ext bank LSB": NRPN 120 MSB 80 + part' }),
    x(4, 'program no.', { min: 0, max: 127, help: 'Menu "Ext program no.": NRPN 120 MSB 72 + part' }),
    x(5, 'lowest note', { options: O.notes, help: 'Menu "Ext lowest  note": NRPN 120 MSB 56 + part' }),
    x(6, 'highest note', { options: O.notes, help: 'Menu "Ext highest note": NRPN 120 MSB 48 + part' }),
    x(7, 'velocity min', { min: 1, max: 127, help: 'Menu "Ext velocity min": NRPN 120 MSB 24 + part' }),
    x(8, 'velocity max', { min: 1, max: 127, help: 'Menu "Ext velocity max": NRPN 120 MSB 32 + part (not below the minimum)' }),
    x(9, 'volume level', { min: 0, max: 127, help: 'Menu "Ext volume level": NRPN 120 MSB 96 + part' }),
    x(10, 'transpose', { bias: 64, min: -60, max: 60, format: plus, help: 'Menu "transpose" (4-124 shown signed): NRPN 120 MSB 16 + part' }),
    x(11, 'Mod wheel Tx CC', { min: 0, max: 127, format: (v) => `CC ${v}`, help: 'Menu "Mod wheel Tx   CC": NRPN 120 MSB 104 + part' }),
    x(12, 'Default velocity', { min: 1, max: 127, help: 'Menu "Default velocity" (1-127): NRPN 122 MSB 72 + part' }),
    x(13, 'MIDI Stream byte', { min: 1, max: 12, help: 'Menu "MIDI Stream byte" (1-12): NRPN 122 MSB 80 + part' }),
    x(14, 'stream byte 14', { input: 'number', min: 0, max: 127, help: 'MIDI stream data (menus "Send MIDI stream", "No of bytes", "Message byte"); 0 in the factory performances' }),
    x(15, 'stream flags', { input: 'number', min: 0, max: 127, help: 'MIDI stream: NRPN 122 MSB 104 + part sets bit 0 and NRPN 122 MSB 96 + part clears it, each writing the part\'s first stream byte; what the other bits do is not known' }),
  ];
}
function keyboardParams() {
  const at = PFX(8);
  const g = 'Keyboard performance';
  const x = (k, label, extra) => P(at + k, label, g, 'keyboard', { ...extra, ...KBD_ONLY });
  return [
    ...Array.from({ length: 8 }, (_, n) => extPart(at, n)).flat(),
    x(128, 'Keyboard octave', { options: named(['-3', '-2', '-1', '0', '+1', '+2', '+3'], 61), help: 'Keyboard menu "Keyboard octave" (61-67): applied when the performance loads (61 plays three octaves down)' }),
    x(129, 'Kbd t-zone hi', { options: O.notes, help: 'Keyboard menu "Kbd t-zone hi": NRPN 120 MSB 5 in performance mode' }),
    x(130, 'Kbd t-zone lo', { options: O.notes, help: 'Keyboard menu "Kbd t-zone lo": NRPN 120 MSB 4 in performance mode' }),
    x(131, 'Kbd t-zone', { shift: 6, bits: 1, options: named(['Off', 'On']), help: 'The transpose zone switch: NRPN 120 MSB 12 in performance mode (no menu field)' }),
    x(131, 'Tx song select ?', { shift: 4, bits: 1, options: named(['No', 'Yes']), help: 'Keyboard menu "Tx song select ?": with Yes the Keyboard OS sends Song Select (F3) with Song no. when the performance is selected' }),
    P(at + 131, '20: 451 bits 0-3, 5', 'Reserved', 'keyboard', { input: 'number', readOnly: true, min: 0, max: 47, get: (d) => d[at + 131] & 0x2f, set: (d, v) => { d[at + 131] = (d[at + 131] & 0x50) | (v & 0x2f); }, help: 'Only bits 4 and 6 are used (Tx song select, transpose zone); 0 in the factory performances' }),
    x(132, 'zone detune', { bias: 64, min: -64, max: 63, format: plus, help: 'Keyboard menu "zone detune" (signed): NRPN 120 MSB 113; the Rack keeps it' }),
    x(133, 'Song no.', { min: 0, max: 127, help: 'Keyboard menu "Song no." (with "Tx song select ?"): NRPN 122 MSB 38' }),
    ...Array.from({ length: 10 }, (_, i) => RES(at + 134 + i, `20: ${454 + i}`, 'keyboard', 'Not used: the SuperNova always sends 0 here')),
  ];
}

const X = PERF_SIZE; // message 1B
const PERFORMANCE = [
  ...Array.from({ length: 16 }, (_, i) => P(i, `Name ${i + 1}`, 'Name', 'common', { hidden: true })),
  P(17, 'Arpeggio speed', 'Performance', 'common', { min: 0, max: 127, format: (v) => `${v + 64} b.p.m.` }), // CC 9; descriptor 6AFEC shows value + 64
  P(18, 'Current part', 'Performance', 'common', { options: named(['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6', 'Part 7', 'Part 8']) }),
  U(X + 4, 'Vocoder balance', 'Vocoder', 'common'), // NRPN 102 in performance mode
  P(X, 'Format', 'Performance', 'common', { input: 'number', readOnly: true, help: 'Always 28h: marks a performance of the current system (OS 2)' }),
  P(16, 'Format (05)', 'Performance', 'common', { input: 'number', readOnly: true, min: 0, max: 63, get: (d) => d[16] & 0x3f, set: (d, v) => { d[16] = (d[16] & 0x40) | (v & 0x3f); }, help: 'Always 2Fh: marks the format; a performance without bit 5 (an older format) has its part effects converted when it arrives. Bit 6 is the mute of part 8' }),
  P(X + 1, 'Voc input', 'Vocoder', 'common', { options: named(FW.VOC_INPUT, 18) }), // packed NRPN 113: 18-27
  P(X + 2, 'Voc insert', 'Vocoder', 'common', { options: named(FW.VOC_INSERT, 28) }), // 28-35
  P(X + 3, 'Vocoder width', 'Vocoder', 'common', { bias: 112, min: 0, max: 15 }), // 112-127
  P(X + 6, 'Sibilance level', 'Vocoder', 'common', { bias: 96, min: 0, max: 15 }), // 96-111
  L(X + 7, 'Sibilance type', 'Vocoder', 'common', ['Hpass', 'Noise']), // 16/17
  ...Array.from({ length: 8 }, (_, i) => partParams(i)).flat(),
  ...keyboardParams(),
];
const PART_FX_SPARE = Array.from({ length: 14 }, (_, i) => 19 + i);
const PERF_SPARE = [X + 5, X + 8, ...Array.from({ length: 7 }, (_, i) => X + 9 + i),
  ...Array.from({ length: 8 }, (_, i) => PART_FX_SPARE.map((o) => PFX(i) + o)).flat()];

// ------------------------------------------------------------------ global
// Message 0F: 16 settings (RAM 34656-34665), then the program change map, 128 x (bank, program);
// message 15: 32 more settings (version byte 28h, high bits, RAM 346A2-346B5) and the map again.
const G2 = GLOBAL_SIZE;
const MAP_BANKS = ['Current bank', 'Perf bank A', 'Perf bank B', 'Perf bank C', 'Perf bank D', 'Prog bank A', 'Prog bank B', 'Prog bank C', 'Prog bank D', 'Prog bank E', 'Prog bank F', 'Prog bank G', 'Prog bank H', 'Arp bank Mono', 'Arp bank Poly', 'Arp bank User U', 'Arp bank User V', 'Arp bank User W', 'Drum map a', 'Drum map b', 'Drum map c', 'Drum map d', 'Drum map e', 'Drum map f', 'Drum map g', 'Drum map h'];
/**
 * Stored value -> menu list position for Sysex transmission (the getter at 145C8): NRPN 84 88-127
 * stores the OS 1 choices, NRPN 120 MSB 126 0-21 the OS 2 ones (drum maps, pattern banks).
 */
const SYSEX_TX_AT = (b) => (b < 22 ? b + 38 : b <= 101 ? b - 88 : b <= 103 ? b - 42 : b <= 107 ? b - 90 : b <= 111 ? b - 86 : b <= 113 ? b - 82 : b <= 115 ? b - 80 : b <= 119 ? b - 98 : b <= 123 ? b - 94 : b <= 125 ? b - 92 : b - 90);
/** Sysex reception (getter at 14950): NRPN 109 66-79 (OS 1 order), NRPN 120 MSB 125 0-10 stores 80-90. */
const SYSEX_RX_AT = (b) => (b <= 71 ? b - 66 : b <= 73 ? b - 54 : b <= 77 ? b - 68 : b <= 79 ? b - 58 : b <= 87 ? b - 70 : b - 66);
/** Options [stored value, name] in the order the SuperNova lists them. */
const reorder = (values, at, names) => values.map((b) => [b, names[at(b)]]).sort((x, y) => at(x[0]) - at(y[0]));
const SYSEX_TX_OPTS = reorder([...Array.from({ length: 22 }, (_, i) => i), ...Array.from({ length: 40 }, (_, i) => 88 + i)], SYSEX_TX_AT, FW.SYSEX_TX);
const SYSEX_RX_OPTS = reorder(Array.from({ length: 25 }, (_, i) => 66 + i), SYSEX_RX_AT, FW.SYSEX_RX);
/** Breath sensing, bits 3-6 of RAM 34660 (setter at CF1A): 0 Norm, 1-5 = +1..+5, 6-10 = -5..-1. */
const BREATH_SENS_OPTS = [[6, '-5'], [7, '-4'], [8, '-3'], [9, '-2'], [10, '-1'], [0, 'Norm'], [1, '+1'], [2, '+2'], [3, '+3'], [4, '+4'], [5, '+5']];
/** Bits of a byte that OS 2.0 neither sets nor reads (shown read-only so a backup restores exactly). */
const RESERVED = (o, mask, label, group, section, help) => P(o, label, group, section, {
  input: 'number', readOnly: true, min: 0, max: 127, help,
  get: (d) => d[o] & mask, set: (d, v) => { d[o] = (d[o] & ~mask) | (v & mask); },
});
const ON_OFF_INV = ['On', 'Off']; // a set bit switches the function off
const G = 'global';
const GLOBAL = [
  P(G2, 'Format', 'MIDI', G, { input: 'number', readOnly: true, help: 'Always 28h: marks global settings of the current system (OS 2)' }),
  P(0, 'Global MIDI chan', 'MIDI', G, { options: named(Array.from({ length: 16 }, (_, i) => String(i + 1))) }), // packed NRPN 109: 32-47
  BIT(G2 + 1, 2, 'Local control', 'MIDI', G, ON_OFF_INV, { help: 'CC 122 (0 Off, 127 On)' }),
  P(G2 + 14, 'Incoming program change', 'MIDI', G, { bits: 2, options: named(['Enabled', 'Program map', 'Disabled']) }), // packed NRPN 110: 34-36
  BIT(G2 + 14, 2, 'Incoming control change', 'MIDI', G, ['Enabled', 'Disabled'], { help: 'Packed NRPN 110: 75 Enabled, 115 Disabled (Disabled also stops NRPNs, so this editor\'s live edits)' }),
  BIT(G2 + 16, 1, 'Prog change Tx', 'MIDI', G, ON_OFF_INV), // packed NRPN 100: 96/97
  BIT(G2 + 16, 2, 'Controllers Tx', 'MIDI', G, ON_OFF_INV), // packed NRPN 100: 98/99
  BIT(G2 + 16, 3, 'Aftertouch Tx (Keyboard)', 'MIDI', G, ON_OFF_INV, { ...KBD_ONLY, help: 'SuperNova II Keyboard only (NRPN 122 MSB 44 there); the Rack neither shows nor uses it' }),
  BIT(G2 + 16, 4, 'Key velocity Tx (Keyboard)', 'MIDI', G, ON_OFF_INV, { ...KBD_ONLY, help: 'SuperNova II Keyboard only (NRPN 122 MSB 45 there)' }),
  BIT(G2 + 16, 5, 'Arp kbd notes Tx (Keyboard)', 'MIDI', G, ON_OFF_INV, { ...KBD_ONLY, help: 'SuperNova II Keyboard only (NRPN 122 MSB 46 there)' }),
  P(6, 'MIDI clock', 'MIDI', G, { options: named(['Int', 'Ext', 'Auto'], 105) }), // packed NRPN 1: 105-107
  S(2, 'Master tune', 'Tuning and level', G), // NRPN 116
  U(7, 'Master volume', 'Tuning and level', G), // CC 97
  P(3, 'Pedal/breath', 'Controllers', G, { options: named(FW.PEDAL_BREATH) }), // NRPN 117 (menu field 6CEC8)
  P(G2 + 2, 'Breath mode', 'Controllers', G, { shift: 4, bits: 2, options: named(FW.BREATH_MODE) }), // packed NRPN 113: 89-91
  P(G2 + 1, 'Breath sensing', 'Controllers', G, { shift: 3, bits: 4, options: BREATH_SENS_OPTS }), // packed NRPN 1: 59-69
  P(G2 + 17, 'Input/sw 1', 'Inputs and switches', G, { options: named(FW.INPUT_SW) }), // NRPN 122 MSB 15
  P(G2 + 18, 'Input/sw 2', 'Inputs and switches', G, { options: named(FW.INPUT_SW) }), // NRPN 122 MSB 16
  P(G2 + 12, 'Pedal/sw 3', 'Inputs and switches', G, { options: named(FW.PEDAL_SW3, 12) }), // packed NRPN 113: 12-15
  P(G2 + 26, 'Gain 1', 'Inputs and switches', G, { bias: 64, min: -8, max: 60, format: (v) => `${plus(v)} dB` }), // NRPN 120 MSB 116 (56-124)
  P(G2 + 27, 'Gain 2', 'Inputs and switches', G, { bias: 64, min: -8, max: 60, format: (v) => `${plus(v)} dB` }), // NRPN 120 MSB 117
  BIT(G2 + 14, 3, 'Vel sensing', 'Panel', G, ['Hard', 'Soft']), // packed NRPN 100: 35 Soft (bit set), 36 Hard
  BIT(G2 + 14, 4, 'Knob mode', 'Panel', G, ['Normal', 'Pickup']), // packed NRPN 100: 90/91
  BIT(G2 + 16, 0, 'Finder demos', 'Panel', G, ON_OFF_INV), // packed NRPN 100: 94/95
  BIT(G2 + 16, 6, 'Button clicks', 'Panel', G, ON_OFF_INV), // packed NRPN 100: 112/113
  P(G2 + 19, 'Sysex Tx delay', 'SysEx', G, { min: 0, max: 127, format: (v) => `${String(v).padStart(3, '0')} ms` }), // NRPN 122 MSB 39
  P(G2 + 20, 'Temp disp time', 'Panel', G, { min: 0, max: 127 }), // NRPN 122 MSB 40
  P(4, 'Arp trans chan', 'Arpeggiator', G, { options: [[127, 'Off'], ...Array.from({ length: 16 }, (_, i) => [i, String(i + 1)])] }), // NRPN 118: 0 stores 7Fh, 1-16 store 0-15
  P(5, 'Arp trans ref', 'Arpeggiator', G, { options: O.notes }), // NRPN 119
  P(G2 + 3, 'Arp pattern editing via MIDI', 'Arpeggiator', G, { shift: 4, bits: 3, options: named(FW.VIA_MIDI) }), // packed NRPN 113: 84-88
  P(G2 + 21, 'User pattern bank', 'Arpeggiator', G, { options: named(['U', 'V', 'W']) }), // NRPN 122 MSB 41
  U(8, 'User pattern edit number', 'Arpeggiator', G, { help: 'NRPN 122 MSB 0; 000-063 mono, 064-127 poly patterns' }),
  P(1, 'Sysex transmission', 'SysEx', G, { options: SYSEX_TX_OPTS, help: 'The dump the MIDI button sends from this menu page. Packed NRPN 84 88-127 and NRPN 120 MSB 126 0-21' }),
  P(15, 'Sysex reception', 'SysEx', G, { options: SYSEX_RX_OPTS, help: 'Packed NRPN 109 66-79 and NRPN 120 MSB 125 0-10 (stored 80-90)' }),
  // The sound selected when the global settings were last written (the power-up sound, read at AD10).
  P(10, 'Power-up mode', 'Power-up sound', G, { bits: 2, options: [[1, 'Program'], [2, 'Performance'], [0, 'Program (0)'], [3, 'Program (3)']] }),
  P(11, 'Power-up program bank', 'Power-up sound', G, { // bits 0-3, plus 13 when bit 6 of message 15 byte 14 is set (drum maps)
    options: PROG_BANK_OPTS,
    get: (d) => (d[11] & 15) + (d[G2 + 14] & 0x40 ? 13 : 0),
    set: (d, v) => { d[11] = (d[11] & 0x70) | ((v >= 18 ? v - 13 : v) & 15); d[G2 + 14] = v >= 18 ? d[G2 + 14] | 0x40 : d[G2 + 14] & ~0x40; },
  }),
  U(12, 'Power-up program', 'Power-up sound', G),
  P(13, 'Power-up performance bank', 'Power-up sound', G, { bits: 4, options: PERF_BANKS }),
  U(14, 'Power-up performance', 'Power-up sound', G),
  // Digital I/O option card (handlers at 1217A-12308 act only when the card is fitted, RAM 692BE = 1).
  P(G2 + 22, 'Sample rate', 'Digital I/O option', G, { bits: 2, options: named(FW.SAMPLE_RATE) }), // NRPN 122 MSB 52
  P(G2 + 22, 'Sync', 'Digital I/O option', G, { shift: 2, bits: 3, options: named(FW.DIG_SYNC) }), // NRPN 122 MSB 53
  BIT(G2 + 22, 5, 'Opt in', 'Digital I/O option', G, FW.OPT_IN), // NRPN 122 MSB 54
  P(G2 + 23, 'Opt out', 'Digital I/O option', G, { bits: 3, options: named(FW.OPT_OUT) }), // NRPN 122 MSB 55
  BIT(G2 + 22, 6, 'Elect in', 'Digital I/O option', G, FW.ELECT_IN), // NRPN 122 MSB 56
  P(G2 + 23, 'Elect out', 'Digital I/O option', G, { shift: 3, bits: 2, options: named(FW.ELECT_OUT) }), // NRPN 122 MSB 57
  U(9, 'Map location being edited', 'Program change map', G), // NRPN 120 MSB 0
  ...Array.from({ length: 128 }, (_, i) => [
    P(G2 + 32 + 2 * i, `Map ${slotNumber(i)} bank`, 'Program change map', 'map', { options: named(MAP_BANKS) }), // packed NRPN 1: 107-119, NRPN 110 37-39, NRPN 122 MSB 13/14
    U(G2 + 33 + 2 * i, `Map ${slotNumber(i)} program`, 'Program change map', 'map'), // NRPN 121
  ]).flat(),
  // What OS 2.0 never sets or reads (docs/devices/novation-supernova2.md, "Global"): kept for exact backups.
  RESERVED(10, 0x7c, '0F 10: bits 2-6', 'Reserved', G, 'Always 0; the rest of this setting travels in message 15 byte 1'),
  RESERVED(11, 0x70, '0F 11: bits 4-6', 'Reserved', G, 'Always 0: only bits 0-3 are used'),
  RESERVED(13, 0x70, '0F 13: bits 4-6', 'Reserved', G, 'Always 0: only bits 0-3 are used'),
  RESERVED(G2 + 1, 0x03, '15 1: bits 0-1', 'Reserved', G, 'Always 0 (these bits travel in message 0F byte 10)'),
  RESERVED(G2 + 2, 0x4f, '15 2: bits 0-3, 6', 'Reserved', G, 'Always 0: bits 0-3 travel in message 0F; bit 6 is not used'),
  RESERVED(G2 + 3, 0x0f, '15 3: bits 0-3', 'Reserved', G, 'Always 0 (these bits travel in message 0F)'),
  ...[4, 5, 6, 7, 8, 9, 10, 11].map((k) => RESERVED(G2 + k, 0x7f, `15 ${k}`, 'Reserved', G, 'Not used: always 0, and ignored when received')),
  RESERVED(G2 + 13, 0x7f, '15 13 (5Fh)', 'Reserved', G, 'Not used on the SuperNova II (5Fh by default). On the Nova it is Headphones out (5Fh = Mix)'),
  RESERVED(G2 + 14, 0x20, '15 14: bit 5', 'Reserved', G, 'Not used: cleared when the global settings are written'),
  RESERVED(G2 + 15, 0x7f, '15 15 (Keyboard: favourites slot)', 'Reserved', G, 'The Rack only defaults it to 0; the Keyboard OS 2.0 keeps the favourites slot being assigned here'),
  RESERVED(G2 + 23, 0x60, '15 23: bits 5-6', 'Reserved', G, 'Not used by the digital I/O settings'),
  ...[24, 25].map((k) => RESERVED(G2 + k, 0x7f, `15 ${k} (40h)`, 'Reserved', G, `Not used on the SuperNova II (always 40h). On the Nova it is Trim${k - 23} (54-74 = -10..+10)`)),
  ...[28, 29, 30, 31].map((k) => RESERVED(G2 + k, 0x7f, `15 ${k}`, 'Reserved', G, 'Not used: always 0')),
];
/** Global NRPN numbers the editor uses (sent on the global channel). */
const nrpn = (c, msb, lsb, v) => [[0xb0 | c, 99, msb], [0xb0 | c, 98, lsb], [0xb0 | c, 6, v & 127]];
/**
 * Message 15 byte 2 (breath mode) is ORed into RAM 34660 instead of 34661 by the receiver (1C454),
 * which clears breath mode and disturbs breath sensing: after a global write, set both again by NRPN.
 */
export function globalRepair(ctx, d) {
  const c = ch(ctx);
  const s = (d[G2 + 1] >> 3) & 15;
  return [...nrpn(c, 0, 1, s === 0 ? 64 : s <= 5 ? 64 + s : 53 + s), ...nrpn(c, 0, 113, 89 + Math.min(2, (d[G2 + 2] >> 4) & 3))];
}
/**
 * The program change map is edited in message 15's copy (from byte 32), the one a SuperNova II
 * reads (1C486). Message 0F carries it for older models: banks 13 and up (arpeggio banks, drum
 * maps) go there as (0, slot), as the transmitter at 1D9FA writes them.
 */
const mirrorMap = (d) => {
  const out = Uint8Array.from(d);
  for (let i = 0; i < 128; i++) {
    const b = d[G2 + 32 + 2 * i];
    out[16 + 2 * i] = b >= 13 ? 0 : b;
    out[17 + 2 * i] = b >= 13 ? i : d[G2 + 33 + 2 * i];
  }
  return out;
};

function finish(list, prefix, sendKey) {
  return list.map((p, i) => {
    const q = { key: `${prefix}${i}`, sendKey, ...p };
    if (q.signed && !q.bits) q.bits = 8;
    return q;
  });
}
export const programParams = finish([...PROGRAM, ...PROGRAM_SPARE.map((o) => (o >= PROGRAM_SIZE ? spare(o, 'fx2', PROGRAM_SIZE, '1E: ') : spare(o, 'voice', 0, '00: ')))], 'p', 'program');
export const performanceParams = finish([...PERFORMANCE, ...PERF_SPARE.map((o) => (o >= PFX(0) ? spare(o, o < PFX(8) ? `part${Math.floor((o - PFX(0)) / 40)}` : 'common', PFX(0), '20: ') : o >= PERF_SIZE ? spare(o, 'common', PERF_SIZE, '1B: ') : spare(o, 'common', 0, '05: ')))], 'f', 'performance');
export const globalParams = finish(GLOBAL, 'g', 'global');

/** Defaults: centre for signed values, the first option, the minimum; a name. */
function defaults(size, params, name, extra = (_d) => {}) {
  const d = new Uint8Array(size);
  for (const p of params) {
    if (p.hidden || p.get || p.readOnly) continue;
    const v = p.options ? p.options[0][0] : p.bias ? 0 : (p.min ?? 0);
    writeParam(d, p, v);
  }
  for (let i = 0; i < 16; i++) d[i] = name.charCodeAt(i) || 32;
  extra(d);
  return d;
}
export function initProgram() {
  return defaults(PROG_DATA, programParams, 'Init Program', (d) => {
    d[211] = 127; d[196] = 127; d[124] = 127; d[236] = 100; d[244] = 122; d[246] = 1; d[252] = 7;
  });
}
export function initPerformance() {
  return defaults(PERF_DATA, performanceParams, 'Init Performance', (d) => {
    d[PERF_SIZE] = 0x28;
    for (let i = 0; i < 8; i++) { d[PART(i) + 1] = 5; d[PART(i)] = i; d[PART(i) + 2] = i; d[PART(i) + 9] = 127; d[PART(i) + 11] = 100; d[PART(i) + 10] = 2; }
  });
}

// ------------------------------------------------------------------ arpeggio patterns
// A user pattern is 194 bytes (receivers 1CC98 mono / 1CD0C poly, transmitters 1D840 / 1D8B6):
//   0       mono: the highest note number a sounding step uses (1-12, recomputed by 18FD2); poly: 0
//   1       No of steps (1-64; RAM byte 1 of a mono pattern, byte 0 of a poly one)
//   2 + 3s  step s: the note (mono 1-12: the n-th held note; poly 28-100 = 64 -36..+36 semitones),
//           then the step's gate/velocity byte as two nibbles (high, low): bits 0-6 the velocity,
//           bit 7 a flag. Velocity 0 with the flag is a Tie, without it a Rest; a velocity with the
//           flag is a Glide, without it Norm (gate setters D16C/D1D2, velocity setter F038).
// Patterns 000-063 of a bank are mono, 064-127 poly. Banks: 13 Mono and 14 Poly (ROM presets), 15-17
// User U, V, W. Messages: 0A pp <194> the pattern edit buffer (pp becomes the global User pattern
// edit number), 0D its request; 0B writes the edit buffer into the user bank (global User pattern
// bank); 0C pp <194> pattern pp of bank U (or V/W when Sysex reception redirects); 22 bb pp <194> a
// pattern of bank bb; 16 bb pp stores the edit buffer there; 13 bb pp (bb 15-17) and 14 pp request
// one; 0E requests all. 0B, 0C, 16 and 22 write memory.
export const PATTERN_SIZE = 194;
const PAT_DATA = 1 + PATTERN_SIZE; // the object: pattern number, then the 194 bytes
const PAT_BANKS = [[15, 'User bank U'], [16, 'User bank V'], [17, 'User bank W']];
const patLabel = (bank, n) => `${'UVW'[bank - 15] ?? '?'}${slotNumber(n)} ${n < 64 ? 'mono' : 'poly'}`;
const GATES = ['Norm', 'Tie', 'Rest', 'Glide'];
const stepByte = (d, s) => ((d[4 + 3 * s] & 15) << 4) | (d[5 + 3 * s] & 15);
const setStepByte = (d, s, b) => { d[4 + 3 * s] = (b >> 4) & 15; d[5 + 3 * s] = b & 15; };
const gateOf = (b) => ((b & 0x7f) ? (b & 0x80 ? 3 : 0) : (b & 0x80 ? 1 : 2));
/** Byte 0 of a mono pattern as the SuperNova keeps it: the highest note of the sounding steps. */
export function patternFixup(d) {
  const out = Uint8Array.from(d);
  if (out[0] >= 64) { out[1] = 0; return out; }
  let hi = 1;
  for (let s = 0; s < Math.min(64, out[2]); s++) if (stepByte(out, s) & 0x7f) hi = Math.max(hi, out[3 + 3 * s]);
  out[1] = Math.min(12, hi);
  return out;
}
msg.patternRequest = (ctx) => [...hdr(ctx, 0x0d), 0xf7];
msg.pattern = (ctx, data) => { const d = patternFixup(data); return [...hdr(ctx, 0x0a), d[0] & 127, ...body(d.slice(1, PAT_DATA)), 0xf7]; };
msg.storePattern = (ctx, bank, n, data) => { const d = patternFixup(data); return [...hdr(ctx, 0x22), bank, n, ...body(d.slice(1, PAT_DATA)), 0xf7]; };
msg.patternSlotRequest = (ctx, bank, n) => [...hdr(ctx, 0x13), bank, n, 0xf7];
/** Pattern object data from a 0A, 0C or 22 message (number first). */
export function patternFrom(raw) {
  const t = typeOf(raw);
  const at = t === 0x22 ? 10 : 9;
  const d = new Uint8Array(PAT_DATA);
  d[0] = raw[at - 1];
  d.set(Uint8Array.from(raw.slice(at, -1)).slice(0, PATTERN_SIZE), 1);
  return d;
}
export function initPattern(n = 0) {
  const d = new Uint8Array(PAT_DATA);
  d[0] = n; d[2] = 16;
  for (let s = 0; s < 64; s++) { d[3 + 3 * s] = n < 64 ? (s % 4) + 1 : 64; setStepByte(d, s, 100); }
  return patternFixup(d);
}
function patternParams_() {
  const g = 'Pattern';
  const steps = Array.from({ length: 64 }, (_, s) => [
    P(3 + 3 * s, `Step ${s + 1} note`, 'Steps', 'pattern', { min: 0, max: 127, help: 'Mono: the n-th held note (1-12); poly: semitones from the played note (-36..+36, stored + 64)' }),
    P(4 + 3 * s, `Step ${s + 1} velocity`, 'Steps', 'pattern', {
      min: 0, max: 128, format: (v) => (v === 0 ? 'Rest' : v === 128 ? 'Tie' : String(v)),
      get: (d) => { const b = stepByte(d, s); return b & 0x7f ? b & 0x7f : b & 0x80 ? 128 : 0; },
      set: (d, v) => { const b = stepByte(d, s); setStepByte(d, s, v === 0 ? 0 : v >= 128 ? 0x80 : ((b & 0x7f) ? b & 0x80 : 0) | (v & 0x7f)); },
    }),
    P(4 + 3 * s, `Step ${s + 1} gate`, 'Steps', 'pattern', {
      options: named(GATES), get: (d) => gateOf(stepByte(d, s)),
      set: (d, v) => { const b = stepByte(d, s); const vel = (b & 0x7f) || 100; setStepByte(d, s, [vel, 0x80, 0, 0x80 | vel][v] ?? b); },
    }),
  ]).flat();
  return [
    P(0, 'Pattern number', g, 'pattern', { options: Array.from({ length: 128 }, (_, n) => [n, `${slotNumber(n)} (${n < 64 ? 'mono' : 'poly'})`]), relayout: true, help: '000-063 mono, 064-127 poly. Sending the pattern makes this the User pattern edit number' }),
    P(2, 'No of steps', g, 'pattern', { min: 1, max: 64, relayout: true }), // NRPN 126
    P(1, 'Highest note (mono, derived)', g, 'pattern', { input: 'number', readOnly: true, min: 0, max: 127, help: 'Worked out by the SuperNova from the steps; the editor recomputes it when it sends' }),
    ...steps,
  ];
}
export const patternParams = finish(patternParams_(), 'a', 'pattern');

// ------------------------------------------------------------------ objects
/** Which unit the pages show: the Rack (model 24) or the Keyboard (22). Reading from a unit sets it. */
const MODEL_TARGET = { label: 'Model', title: 'SuperNova II Rack or Keyboard: what the pages show (a read from the unit sets it)', options: () => [[0x24, 'Rack'], [0x22, 'Keyboard']], value: () => unit.model, set: (v) => { unit.model = Number(v); } };
const partSections = Array.from({ length: 8 }, (_, i) => ({ key: `part${i}`, label: `Part ${i + 1}` }));
const PTR = TR.perfTranslator({ PART, PFX });
const isDrumBank = (b) => b >= 18 && b <= 25;

export default {
  coverage: 'Edits the SuperNova II\'s programs, performances, arpeggio patterns and global settings. Programs (3 oscillators, mixer, 2 LFOs, 3 envelopes, filter, voice, arpeggiator with its program-mode settings, effects and the OS 2 settings), performances (8 parts with program, MIDI channel, level, key range, polyphony, MIDI filters, arpeggio pattern and effects, vocoder, and the SuperNova II Keyboard External Parts), every global setting (power-up sound, inputs, MIDI, SysEx, digital I/O card) and the program change map, read from and sent to a SuperNova II Rack or Keyboard; checked on a SuperNova II Rack. Program and performance memories with their names, Store, the Branch Library and Head Library.',
  sysex: { manufacturer: [0x00, 0x20, 0x29], model: 0x24, deviceIdDefault: 0x7f },
  minGap: 40,
  describe,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'program', page: 'Program', icon: '◆', label: 'Program', size: PROG_DATA, autoLoad: true,
      init: initProgram, fetch: fetchProgram, params: programParams, name: nameOf, cols: 3,
      sections: [
        { key: 'osc', label: 'Oscillators' }, { key: 'mix', label: 'Mixer' }, { key: 'lfo', label: 'LFOs' }, { key: 'env', label: 'Envelopes' },
        { key: 'filter', label: 'Filter' }, { key: 'voice', label: 'Voice' }, { key: 'arp', label: 'Arpeggiator' }, { key: 'fx', label: 'Effects' }, { key: 'fx2', label: 'Effects (OS 2)' },
      ],
      groupInfo: {
        'Spare bytes': { note: 'Program values whose purpose is not known: no menu or controller of the SuperNova II reaches them. Kept so a backup restores exactly.', table: true, wide: true },
        Reserved: { note: 'Values the SuperNova always sends as 0 and does not use. Kept so a backup restores exactly.', table: true, wide: true },
      },
      sendParam: (_p, _v, data, ctx) => msg.program(ctx, data),
      note: 'Every change sends the program to the current part\'s edit buffer, so it is heard at once. Store writes it into a memory (Memory protect must be Off, the usual setting). The effects here are used when the part\'s Effects used is Program (always in program mode).',
      sendAll: { label: 'Send to SuperNova', title: 'Send the whole program to the current part', build: (data, ctx) => msg.program(ctx, data) },
      toSyx: (data, ctx) => msg.program(ctx, data),
      fromSyx: programFromSyx,
      toCommon: (d) => TR.programToCommon(d),
      fromCommon: (c, base) => TR.programFromCommon(c, base),
      category: (d) => TR.programCategory(d),
      setCategory: (d, id) => TR.programSetCategory(d, id),
      setName: (d, name) => { for (let i = 0; i < 16; i++) d[i] = Math.max(32, Math.min(126, name.charCodeAt(i) || 32)); },
      slots: {
        label: 'Programs', banks: [...PROG_BANKS, ...DRUM_BANKS], count: (bank) => bankSize(bank),
        slotLabel: (bank, i) => `${bankName(bank).slice(-1)}${slotNumber(i)}`, name: nameOf,
        recall: (bank, i, ctx) => select(ctx, bank, i),
        fetch: (api, bank, i) => fetchStoredProgram(api, bank, i),
        scanBank: scanBank('prog'),
        store: (bank, i, ctx, data) => msg.storeProgram(ctx, bank, i, data),
        writable: () => true,
        note: (bank, ctx) => `Play selects the program on the global channel (${ch(ctx) + 1}), which puts the SuperNova in program mode. Read names reads the whole bank (about ${bank >= 18 ? 7 : 17} s).${isDrumBank(bank) ? ' A drum map holds 50 sounds; in a performance, a part plays a drum map when its bank is a drum map.' : ''}`,
      },
    },
    {
      key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: PERF_DATA, autoLoad: false,
      init: initPerformance, fetch: fetchPerformance, params: performanceParams, name: nameOf, cols: 3,
      sections: [{ key: 'common', label: 'Common' }, ...partSections, { key: 'keyboard', label: 'Keyboard' }],
      emptySection: (section) => (section === 'keyboard' ? 'The SuperNova II Rack has no External Parts or transpose zone: these bytes are kept for a Keyboard (choose Model: Keyboard to see them).' : ''),
      target: MODEL_TARGET,
      groupInfo: {
        'Spare bytes': { note: 'Performance values whose purpose is not known; kept so a backup restores exactly.', table: true, wide: true },
        Reserved: { note: 'Values the SuperNova always sends as 0; kept so a backup restores exactly.', table: true, wide: true },
      },
      sendParam: (_p, _v, data, ctx) => msg.performance(ctx, data),
      note: 'Every change sends the performance to the edit buffer. A part\'s Bank and Program are stored with the performance; the SuperNova loads that program into the part when the performance is selected (store it, then Play it).',
      sendAll: { label: 'Send to SuperNova', build: (data, ctx) => msg.performance(ctx, data) },
      toSyx: (data, ctx) => msg.performance(ctx, data),
      fromSyx: performanceFromSyx,
      toCommon: (d) => PTR.perfToCommon(d),
      fromCommon: (c, base) => PTR.perfFromCommon(c, base),
      setName: (d, name) => { for (let i = 0; i < 16; i++) d[i] = Math.max(32, Math.min(126, name.charCodeAt(i) || 32)); },
      multi: {
        page: 'MIDI channels', label: 'Parts', count: 8, section: (i) => `part${i}`, partLabel: (i) => `Part ${i + 1}`,
        columns: [
          { label: 'Program', params: ['Bank', 'Program'], role: 'patch' },
          { label: 'MIDI channel', params: ['MIDI channel'], role: 'channel' },
          { label: 'Polyphony', params: ['Part polyphony'], role: 'on' },
          { label: 'Level', params: ['Part level'] },
          { label: 'Pan', params: ['Pan position'] },
          { label: 'Key range', params: ['Lowest note', 'Highest note'] },
          { label: 'Semitone', params: ['Part semitone'] },
        ],
        on: (i, d) => (d[PART(i) + 10] & 3) !== 0,
        channels: MIDI_CHANNELS,
        drumPart: (i, d) => isDrumBank(d[PART(i) + 1]),
        note: 'In performance mode each part plays its program on its MIDI channel (Global follows the global channel, Omni takes every channel). Polyphony Off switches a part off. A part plays drums when its Bank is a drum map (a-h): each key then plays one of the map\'s 50 drum sounds, on the key set by that sound\'s Drum played as. Changes go to the performance edit buffer; store the performance to keep them.',
      },
      slots: {
        label: 'Performances', banks: PERF_BANKS, count: 128,
        slotLabel: (bank, i) => `${bankName(bank).slice(-1)}${slotNumber(i)}`, name: nameOf,
        recall: (bank, i, ctx) => select(ctx, bank, i),
        fetch: (api, bank, i) => fetchStoredPerformance(api, bank, i),
        scanBank: scanBank('perf'),
        store: (bank, i, ctx, data) => msg.storePerformance(ctx, bank, i, data),
        writable: () => true,
        note: (_bank, ctx) => `Play selects the performance on the global channel (${ch(ctx) + 1}), which puts the SuperNova in performance mode. Read names reads the whole bank (about 40 s).`,
      },
    },
    {
      key: 'pattern', page: 'Arp patterns', icon: '♫', label: 'Arpeggio pattern', size: PAT_DATA, autoLoad: false,
      init: () => initPattern(0),
      fetch: async (api) => {
        const m = await collect(api, msg.patternRequest(api.ctx), [0x0a], 1, 210);
        if (!m.length) throw new Error('The SuperNova II did not send its pattern edit buffer.');
        return patternFrom(m[0]);
      },
      params: patternParams, cols: 3,
      sections: [{ key: 'pattern', label: 'Pattern' }],
      groupInfo: {
        Steps: {
          wide: true,
          note: 'Each step: a note (mono patterns: the n-th held note, 1-12; poly: semitones from the played note), a velocity and a gate. Rest and Tie have no velocity; Glide slides into the next step. Steps after No of steps are not played.',
          pattern: ({ data }) => {
            const poly = data[0] >= 64;
            const of = (what) => patternParams.filter((p) => p.label.endsWith(` ${what}`) && p.label.startsWith('Step '));
            return {
              length: 64, end: Math.max(1, data[2]), stepLabel: (i) => String(i + 1),
              lanes: [
                { label: poly ? 'Note (semitones)' : 'Note (held note no.)', kind: 'bar', steps: of('note'), min: poly ? 28 : 1, max: poly ? 100 : 12, zero: poly ? 64 : 1, offset: poly ? -64 : 0 },
                { label: 'Velocity', kind: 'note', steps: of('velocity'), min: 1, max: 127, rest: 0, tie: 128, on: 100 },
                { label: 'Gate', kind: 'bar', steps: of('gate'), min: 0, max: 3, zero: 0, names: GATES }, // Norm, Tie, Rest, Glide
              ],
            };
          },
        },
      },
      sendParam: (_p, _v, data, ctx) => msg.pattern(ctx, data),
      note: 'Changes go to the pattern edit buffer, which the arpeggiator plays when a program or part uses this pattern of the global User pattern bank. Sending also makes this pattern the User pattern edit number. Store writes it into a user bank (Memory protect off).',
      sendAll: { label: 'Send to SuperNova', title: 'Send the pattern into the pattern edit buffer', build: (data, ctx) => msg.pattern(ctx, data) },
      toSyx: (data, ctx) => [msg.pattern(ctx, data)],
      fromSyx: (msgs) => { const m = msgs.find((x) => [0x0a, 0x0c, 0x22].includes(typeOf(x))); return m ? patternFrom(m) : null; },
      toCommon: (d) => TR.patternToCommon(d),
      fromCommon: (c, base) => TR.patternFromCommon(c, base),
      slots: {
        label: 'User patterns', banks: PAT_BANKS, count: 128,
        slotLabel: (bank, i) => patLabel(bank, i), name: () => '',
        fetch: async (api, bank, i) => {
          const m = await collect(api, msg.patternSlotRequest(api.ctx, bank, i), [0x0c, 0x22], 1, 210);
          if (!m.length) throw new Error(`No reply for ${patLabel(bank, i)}.`);
          return patternFrom(m[0]);
        },
        store: (bank, i, ctx, data) => { const d = Uint8Array.from(data); d[0] = i; return msg.storePattern(ctx, bank, i, d); },
        writable: () => true,
        note: () => 'Read reads one pattern. Store writes it into the bank (Memory protect off). Patterns 000-063 are mono, 064-127 poly: a pattern stored into the other half is read the other way. The Mono and Poly preset banks are in ROM and cannot be read over MIDI.',
      },
    },
    {
      key: 'global', page: 'Global', icon: '⚙', label: 'Global', size: GLOBAL_SIZE + GLOBAL_EXT_SIZE,
      init: () => { const d = new Uint8Array(GLOBAL_SIZE + GLOBAL_EXT_SIZE); d[G2] = 0x28; d[1] = 88; d[15] = 67; d[7] = 127; d[2] = 64; d[6] = 105; return d; },
      fetch: async (api) => {
        const m = await collect(api, msg.globalRequest(api.ctx), [0x0f, 0x15], 2, 600);
        const d = globalFromSyx(m);
        if (!d) throw new Error('The SuperNova II did not send its global data.');
        return d;
      },
      params: globalParams, cols: 3, target: MODEL_TARGET,
      sections: [{ key: 'global', label: 'Settings' }, { key: 'map', label: 'Program change map' }],
      groupInfo: {
        Reserved: { note: 'Values in the global settings that the SuperNova II does not use. They are kept so a backup restores exactly.', table: true, wide: true },
        'Power-up sound': { note: 'The sound selected when the global settings were last written: the SuperNova starts with it.' },
        'Digital I/O option': { note: 'Settings of the optional digital I/O card. Without the card the SuperNova ignores changes to them but keeps the values.' },
        'Program change map': { note: 'Which bank and program each incoming program change selects when Incoming program change is Program map.', table: true, wide: true },
      },
      note: 'Changes here are not sent as you make them, because sending global settings writes them into the SuperNova\'s memory. Use Write global settings to send them (Memory protect must be Off). Memory protect is not among the global settings; keep it Off (the usual setting; the factory setting is On): the buttons set it.',
      actions: [
        { label: 'Write global settings', title: 'Send the global settings: replaces the SuperNova\'s global settings', run: async (api) => {
          if (!(await api.confirm('Write global settings', 'Send these global settings to the SuperNova II? They replace its global settings (Memory protect must be off).', 'Write', true))) return;
          api.send([...msg.global(api.ctx, mirrorMap(api.data)), ...globalRepair(api.ctx, api.data)]);
        } },
        { label: 'Memory protect off', title: 'Turn memory protect off: allows Store and Write global settings', run: async (api) => api.send(nrpn(ch(api.ctx), 0, 1, 121)) },
        { label: 'Memory protect on', title: 'Turn memory protect on', run: async (api) => api.send(nrpn(ch(api.ctx), 0, 1, 120)) },
      ],
      toSyx: (data, ctx) => msg.global(ctx, mirrorMap(data)),
      fromSyx: globalFromSyx,
    },
  ],
  // Branch Library "Complete dump": the unit's Total data dump and the current edit buffers.
  fullDump: ['Current performance (with its 8 programs)', 'Global data', { request: 'Total data', timeout: 15000 }],
  requests: [
    { label: 'Current program', bytes: (ctx) => msg.currentProgramRequest(ctx) },
    { label: 'Current performance (with its 8 programs)', bytes: (ctx) => msg.currentPerformanceRequest(ctx) },
    { label: 'Global data', bytes: (ctx) => msg.globalRequest(ctx) },
    ...PROG_BANKS.map(([b, l]) => ({ label: `${l} (128 programs)`, bytes: (ctx) => msg.bankRequest(ctx, b) })),
    ...DRUM_BANKS.map(([b, l]) => ({ label: `${l} (50 drum sounds)`, bytes: (ctx) => msg.bankRequest(ctx, b) })),
    ...PERF_BANKS.map(([b, l]) => ({ label: `${l} (128 performances)`, bytes: (ctx) => msg.bankRequest(ctx, b) })),
    { label: 'All programs and drum maps', bytes: (ctx) => msg.allProgramsRequest(ctx) },
    { label: 'All performances', bytes: (ctx) => msg.allPerformancesRequest(ctx) },
    { label: 'All arpeggio patterns', bytes: (ctx) => msg.arpPatternsRequest(ctx) },
    { label: 'Total data', bytes: (ctx) => msg.totalRequest(ctx) },
  ],
};

export const _test = { unit, PROGRAM, PERFORMANCE, GLOBAL, PART, PFX, programFromSyx, performanceFromSyx, globalFromSyx, typeOf, dataOf, libraryItems, readParam };
