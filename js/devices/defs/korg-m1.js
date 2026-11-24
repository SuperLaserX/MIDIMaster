// Korg M1 / M1R / M1EX / M1REX: MIDI implementation from the M1R v1.06 OS (two 27C512s,
// NEC V50, image at E000:0000; DS = F7BF so DS offsets below 8410h are the top of the ROM)
// and checked against an M1R over MIDI. See docs/devices/korg-m1.md.
//
// SysEx F0 42 3g 19 ff ... F7 (g = global channel). Function dispatcher at F000:1C1A
// (code segment EF69), jump tables at DS:8384 (0E-1F) and DS:8360 (40-51):
//   10 program dump request  -> 40 program dump (143 bytes, current program)
//   19 combination request   -> 49 combination dump (124 bytes; combination modes only)
//   0E bb global request     -> 51 global dump (861 bytes)      bb: 0 internal, 1 card
//   1C bb all programs       -> 4C (100 x 143)    1D bb all combinations -> 4D (100 x 124)
//   0F bb all data -> 50     18 bb sequence data -> 48     12 mode request -> 42 mode data
//   11 bb nn program write (program modes)    1A bb nn combination write (combination modes)
//   4E mm bb mode change (0 combi play, 1 combi edit, 2 program play, 3 program edit)
//   41 pl ph vl vh parameter change (edit modes; parameter numbers 0-27, high byte ignored)
// Replies 21 write completed, 22 write error (memory protected), 23 data load completed,
// 24 data load error (wrong mode), 26 message format error.
// Dump data is 7-in-8 packed: each group of 8 starts with the high bits of the next 7 bytes.
//
// Program layout: the edit-page field records (image 18F00-19800: layout word, descriptor
// [max, min, format, label], RAM address in the edit buffer at DS:9969, extra) give each
// byte's label and range. Oscillator 2's pitch EG, VDF and VDA follow oscillator 1's at +40.

import { named, readText } from '../../core/model/memmap.js';

export const MULTISOUNDS = ["Piano", "E.Piano 1", "E.Piano 2", "Clav", "Harpsicord", "Organ  1", "Organ  2", "MagicOrgan", "Guitar  1", "Guitar  2", "E.Guitar", "Sitar  1", "Sitar  2", "A.Bass", "Pick Bass", "E.Bass", "Fretless", "SynthBass1", "SynthBass2", "Vibes", "Bell", "Tubular", "BellRing", "Karimba", "KarimbaNT", "SynMallet", "Flute", "Pan Flute", "Bottles", "Voices", "Choir", "Strings", "Brass  1", "Brass  2", "Tenor Sax", "Mute TP", "Trumpet", "TubaFlugel", "DoubleReed", "Koto Trem", "BambooTrem", "Rhythm", "Lore", "Lore NT", "FlexaTone", "WindBells", "Pole", "Pole NT", "Block", "Block NT", "FingerSnap", "Pop", "Drop", "Drop  NT", "Breath", "Breath NT", "Pluck", "Pluck NT", "Vibe Hit", "VibeHit NT", "Hammer", "Metal Hit", "MetalHitNT", "Pick", "Distortion", "Dist  NT", "Bass Thumb", "BasThumNT1", "BasThumNT2", "Wire", "PanWave", "PingWave", "Fv Wave", "Mv Wave", "Voice Wave", "VoiceWvNT1", "VoiceWvNT2", "DWGS E.P.1", "DWGS E.P.2", "DWGS E.P.3", "DWGS Piano", "DWGS Clav", "DWGS Vibe", "DWGS Bass1", "DWGS Bass2", "DWGS Bell", "DWGS Orgn1", "DWGS Orgn2", "DWGS Voice", "SquareWave", "Digital 1", "Saw Wave", "Digital 2", "25% Pulse", "10% Pulse", "Digital 3", "Digital 4", "Digital 5", "DWGS TRI", "DWGS Sine"];
export const DRUM_SOUNDS = ["Kick 1", "Kick 2", "Kick 3", "Snare 1", "Snare 2", "Snare 3", "Snare 4", "Side Stick", "Tom 1", "Tom 2", "Closed HH1", "Open HH1", "Closed HH2", "Open HH2", "Crash", "Conga 1", "Conga 2", "Timbales 1", "Timbales 2", "Cowbell", "Claps", "Tambourine", "E.Tom", "Ride", "Rap", "Whip", "Shaker", "Pole", "Block", "FingerSnap", "Drop", "Vibe Hit", "Hammer", "Metal Hit", "Pluck", "FlexaTone", "Wind Bell", "Tubular 1", "Tubular 2", "Tubular 3", "Tubular 4", "Bell Ring", "Metronome1", "Metronome2"];
export const EFFECTS = ["Hall", "Ensemble Hall", "Concert Hall", "Room", "Large Room", "Live Stage", "Early Ref 1", "Early Ref 2", "Early Ref 3", "Stereo Delay", "Cross Delay", "Chorus 1", "Chorus 2", "Flanger", "Cross Flanger", "Phaser 1", "Phaser 2", "Tremolo 1", "Tremolo 2", "Equalizer", "Over Drive", "Distortion", "Exciter", "Symphonic Ens", "Rotary SP", "Delay/Hall", "Delay/Room", "Delay/E.Ref", "Delay/Delay", "Delay/Chorus", "Delay/Flanger", "Delay/Phaser", "Delay/Tremolo", "No Effect"];

const MODEL = 0x19;
export const PROGRAM_SIZE = 143;
export const COMBI_SIZE = 124;
export const GLOBAL_SIZE = 861;

// ------------------------------------------------------------------ 7-in-8 packing
export function unpack(b) {
  const out = [];
  for (let k = 0; k < b.length; k += 8) {
    const hi = b[k];
    for (let i = 1; i < 8 && k + i < b.length; i++) out.push(b[k + i] | (((hi >> (i - 1)) & 1) << 7));
  }
  return Uint8Array.from(out);
}
export function pack(b) {
  const out = [];
  for (let k = 0; k < b.length; k += 7) {
    const g = Array.from(b.slice(k, k + 7));
    out.push(g.reduce((a, x, i) => a | (((x >> 7) & 1) << i), 0), ...g.map((x) => x & 0x7f));
  }
  return out;
}

// ------------------------------------------------------------------ messages
const hdr = (ctx, f) => [0xf0, 0x42, 0x30 | ((ctx?.deviceId ?? 0) & 15), MODEL, f];
export const msg = {
  modeRequest: (ctx) => [...hdr(ctx, 0x12), 0xf7],
  mode: (ctx, mode, card = 0) => [...hdr(ctx, 0x4e), mode, card, 0xf7],
  programRequest: (ctx) => [...hdr(ctx, 0x10), 0xf7],
  combiRequest: (ctx) => [...hdr(ctx, 0x19), 0xf7],
  globalRequest: (ctx, card = 0) => [...hdr(ctx, 0x0e), card, 0xf7],
  allProgramsRequest: (ctx, card = 0) => [...hdr(ctx, 0x1c), card, 0xf7],
  allCombisRequest: (ctx, card = 0) => [...hdr(ctx, 0x1d), card, 0xf7],
  allDataRequest: (ctx, card = 0) => [...hdr(ctx, 0x0f), card, 0xf7],
  program: (ctx, data) => [...hdr(ctx, 0x40), ...pack(data), 0xf7],
  combi: (ctx, data) => [...hdr(ctx, 0x49), ...pack(data), 0xf7],
  global: (ctx, data, card = 0) => [...hdr(ctx, 0x51), card, ...pack(data), 0xf7],
  writeProgram: (ctx, card, n) => [...hdr(ctx, 0x11), card, n, 0xf7],
  writeCombi: (ctx, card, n) => [...hdr(ctx, 0x1a), card, n, 0xf7],
};
const isM1 = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x42 && (raw[2] & 0xf0) === 0x30 && raw[3] === MODEL;
const fn = (raw) => (isM1(raw) ? raw[4] : -1);
/** Data of a dump message: after the function byte (and the memory byte of 4C/4D/51). */
const dumpData = (raw) => unpack(raw.slice([0x4c, 0x4d, 0x51].includes(raw[4]) ? 6 : 5, -1));

const NAMES = {
  0x40: 'program dump', 0x41: 'parameter change', 0x42: 'mode data', 0x48: 'sequence data dump', 0x49: 'combination dump',
  0x4c: 'all programs dump', 0x4d: 'all combinations dump', 0x4e: 'mode change', 0x50: 'all data dump', 0x51: 'global dump',
  0x10: 'program dump request', 0x11: 'program write request', 0x12: 'mode request', 0x19: 'combination dump request',
  0x1a: 'combination write request', 0x1c: 'all programs request', 0x1d: 'all combinations request', 0x0e: 'global request',
  0x0f: 'all data request', 0x18: 'sequence data request',
  0x21: 'write completed', 0x22: 'write error (memory protected?)', 0x23: 'data load completed', 0x24: 'data load error (wrong mode)', 0x26: 'message format error',
};
function describe(raw) {
  if (!isM1(raw)) return null;
  return `M1 ${NAMES[raw[4]] || `function ${raw[4].toString(16)}`} (${raw.length} bytes)`;
}

// ------------------------------------------------------------------ parameters
const NOTE = (v) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][v % 12]}${Math.floor(v / 12) - 1}`;
const plus = (v) => `${v > 0 ? '+' : ''}${v}`;
const O = {
  oscMode: named(['SINGLE', 'DOUBLE', 'DRUMS']),
  poly: named(['POLY', 'MONO']),
  onoff: named(['OFF', 'ON']),
  octave: [[-1, "16'"], [0, " 8'"], [1, " 4'"]],
  ms: named(MULTISOUNDS.map((n, i) => `${String(i).padStart(2, '0')} ${n}`)),
  kit: named(['Drum Kit 1', 'Drum Kit 2', 'Drum Kit 3', 'Drum Kit 4']),
  wave: named(['TRIANGLE', 'SAW UP', 'SAW DOWN', 'SQUARE']),
  mgOsc: named(['OFF', 'OSC1', 'OSC2', 'BOTH']),
  mgVdf: named(['OFF', 'VDF1', 'VDF2', 'BOTH']),
  egSw: [[0, '-'], [1, '0'], [2, '+']],
  disEna: named(['DIS', 'ENA']),
  scale: named(['Equal Temp', 'Equal Temp2', 'Pure Major', 'Pure Minor', 'User Programable']),
  pedal: named(['Program Up', 'Program Down', 'Seq Start/Stop', 'Effect 1 ON/OFF', 'Effect 2 ON/OFF', 'Volume', 'VDF Cutoff', 'Effect 1 Cntl', 'Effect 2 Cntl', 'Data Entry']),
  combiType: named(['SINGLE', 'LAYER', 'SPLIT', 'VEL.SW', 'MULTI']),
  channel: named(Array.from({ length: 16 }, (_, i) => `Ch ${i + 1}`)),
  // drum kit sounds: 0 No Assign, 1-44 the ROM sounds, 45 and up the PCM card's (C00...)
  drum: [[0, 'No Assign'], ...DRUM_SOUNDS.map((n, i) => [i + 1, `${String(i).padStart(2, '0')} ${n}`]), ...Array.from({ length: 32 }, (_, i) => [45 + i, `C${String(i).padStart(2, '0')} (card drum sound)`])],
};

const P = (offset, label, extra = {}) => ({ offset, label, ...extra });
const u99 = (o, l) => P(o, l, { min: 0, max: 99 });
const s99 = (o, l) => P(o, l, { signed: true, min: -99, max: 99, format: plus });
const key = (o, l) => P(o, l, { min: 0, max: 127, format: NOTE });

/** One oscillator's pitch EG, VDF and VDA (oscillator 2 at +40). */
function voiceBlock(n) {
  const b = n === 1 ? 0 : 40;
  const g = (s) => `OSC${n} ${s}`;
  // EG time switches (E000:3C63): segment n is on with bit n, negative with bit n + 4.
  const sw = (o, what) => ['AT', 'DT', 'ST', 'RT'].map((s, n) => P(o + b, `${what} ${s}`, {
    options: O.egSw, group: g('EG time switches'),
    help: `${what} EG time: whether it shortens (+), lengthens (-) or leaves (0) the ${['attack', 'decay', 'slope', 'release'][n]} time`,
    get: (d) => ((d[o + b] >> n) & 1 ? ((d[o + b] >> (n + 4)) & 1 ? 0 : 2) : 1),
    set: (d, v) => { const lo = 1 << n; const hi = lo << 4; d[o + b] = v === 1 ? d[o + b] & ~(lo | hi) : v === 0 ? d[o + b] | lo | hi : (d[o + b] | lo) & ~hi; },
  }));
  return [
    ...[[63, 'Start level', s99], [64, 'Attack time', u99], [65, 'Attack level', s99], [66, 'Decay time', u99], [67, 'Release time', u99],
      [68, 'Release level', s99], [69, 'Time velocity sens', s99], [70, 'Level velocity sens', s99]].map(([o, l, f]) => ({ ...f(o + b, l), group: g('pitch EG') })),
    { ...u99(71 + b, 'Cutoff'), group: g('VDF') }, { ...u99(74 + b, 'EG intensity'), group: g('VDF') },
    { ...key(72 + b, 'Kbd track center key'), group: g('VDF') }, { ...s99(73 + b, 'Kbd track cutoff'), group: g('VDF') },
    { ...s99(75 + b, 'Kbd track EG time'), group: g('VDF') }, { ...s99(76 + b, 'Velocity EG time'), group: g('VDF') },
    { ...s99(77 + b, 'Velocity EG intensity'), group: g('VDF') },
    ...[[78, 'Attack time', u99], [79, 'Attack level', s99], [80, 'Decay time', u99], [81, 'Break point', s99], [82, 'Slope time', u99],
      [83, 'Sustain level', s99], [84, 'Release time', u99], [85, 'Release level', s99]].map(([o, l, f]) => ({ ...f(o + b, l), group: g('VDF EG') })),
    { ...u99(86 + b, 'Level'), group: g('VDA') }, { ...key(87 + b, 'Kbd track center key'), group: g('VDA') },
    { ...s99(88 + b, 'Kbd track amplitude'), group: g('VDA') }, { ...s99(89 + b, 'Velocity amplitude'), group: g('VDA') },
    { ...s99(90 + b, 'Kbd track EG time'), group: g('VDA') }, { ...s99(91 + b, 'Velocity EG time'), group: g('VDA') },
    ...[[92, 'Attack time'], [93, 'Attack level'], [94, 'Decay time'], [95, 'Break point'], [96, 'Slope time'], [97, 'Sustain level'], [98, 'Release time']]
      .map(([o, l]) => ({ ...u99(o + b, l), group: g('VDA EG') })),
    ...sw(99, 'VDF kbd track'), ...sw(100, 'VDF velocity'), ...sw(101, 'VDA kbd track'), ...sw(102, 'VDA velocity'),
  ].map((p) => ({ ...p, section: `osc${n}` }));
}

/// Effect block: the same 25 bytes in programs (38-62) and combinations (11-35).
//   0, 1   effect 1 / 2 type          2, 3 effect 1 DRY:EFF balance   4, 5 effect 2 balance
//   6, 7   Out 3 / Out 4 panpot       8    bits 0-1 effect 1 on, 2-3 effect 2 on, 4 placement
//   9-16   effect 1 parameters        17-24 effect 2 parameters
// The firmware picks a page for each type through the table at DS:2A4C (image 1A63C); each
// page lists field records [layout, descriptor, address, handlers]. The handlers address
// [C34D] (the block) + 9 or 17 (effect 1 / 2) + (address - C04D) and read a signed byte,
// an unsigned byte, a little-endian word (delay and reverb times) or bit 0 (Waveform).
// The balances address byte 2 or 4 (single effects write both bytes of the pair, the
// Delay/... doubles keep one per part).
const pct = (v) => `${v}%`;
const ms = (v) => `${v} ms`;
const db = (v) => `${plus(v)} dB`;
const pm = (v) => `${v < 0 ? '-' : '+'}${Math.abs(v)}%`;
/** Mod Speed display (E000:9C92): 0.03-3.00 Hz, 3.1-13.0 Hz, then 14-30 Hz. */
const modHz = (v) => `${v < 100 ? ((v + 1) * 0.03).toFixed(2) : v < 200 ? (3 + (v - 99) / 10).toFixed(1) : `${v - 186}.0`} Hz`;
/** Reverb Time display (E000:9D68): (value + 2) / 10 seconds. */
const revSec = (v) => `${((v + 2) / 10).toFixed(1)} s`;
/** E/R Time display (E000:9DAE): (value + 10) x 10 ms. */
const erMs = (v) => `${(v + 10) * 10} ms`;
const S8 = { signed: true };
const WORD = { word: true };
// Firmware labels (DS:7A58-7C3D) with their descriptor ranges.
const FXF = {
  depth: ['Mod Depth', { min: 0, max: 99, ...S8 }],
  speed: ['Mod Speed', { min: 0, max: 216, format: modHz }],
  wave: ['Waveform', { bit0: true, options: named(['SIN', 'TRI']) }],
  eqL: ['EQ Low', { min: -12, max: 12, format: db, ...S8 }],
  eqH: ['EQ High', { min: -12, max: 12, format: db, ...S8 }],
  dly: ['Delay Time', { min: 0, max: 500, format: ms, ...WORD }],
  timeL: ['Time L', { min: 0, max: 500, format: ms, ...WORD }],
  timeR: ['Time R', { min: 0, max: 500, format: ms, ...WORD }],
  time200: ['Time', { min: 0, max: 200, format: ms }],
  time50: ['Time', { min: 0, max: 50, format: ms }],
  fb: ['Feedback', { min: -99, max: 99, format: pm, ...S8 }],
  fbL: ['Feedback L', { min: -99, max: 99, format: pm, ...S8 }],
  fbR: ['Feedback R', { min: -99, max: 99, format: pm, ...S8 }],
  hd: ['High Damp', { min: 0, max: 99, format: pct, ...S8 }],
  hdL: ['High Damp L', { min: 0, max: 99, format: pct, ...S8 }],
  hdR: ['High Damp R', { min: 0, max: 99, format: pct, ...S8 }],
  rev97: ['Reverb Time', { min: 0, max: 97, format: revSec, ...WORD }],
  rev47: ['Reverb Time', { min: 0, max: 47, format: revSec, ...WORD }],
  pre200: ['Pre Delay', { min: 0, max: 200, format: ms }],
  pre150: ['Pre Delay', { min: 0, max: 150, format: ms }],
  pre100: ['Pre Delay', { min: 0, max: 100, format: ms }],
  erLevel: ['E/R Level', { min: 0, max: 99, ...S8 }],
  er70: ['E/R Time', { min: 0, max: 70, format: erMs }],
  er30: ['E/R Time', { min: 0, max: 30, format: erMs }],
  shape: ['Shape', { min: -99, max: 99, format: plus, ...S8 }],
  manual: ['Manual', { min: 0, max: 99, ...S8 }],
  lowGain: ['Low Gain', { min: -12, max: 12, format: db, ...S8 }],
  highGain: ['High Gain', { min: -12, max: 12, format: db, ...S8 }],
  lowFreq: ['Low Freq', { options: named(['250 Hz', '500 Hz', '1 kHz']) }],
  highFreq: ['High Freq', { options: named(['1 kHz', '2 kHz', '4 kHz']) }],
  dist: ['Distortion', { min: 0, max: 100 }],
  drive: ['Drive', { min: 0, max: 100 }],
  level: ['Level', { min: 0, max: 100 }],
  blend: ['Blend', { min: -99, max: 99, format: plus, ...S8 }],
  ep: ['Emphatic Point', { min: 1, max: 10, ...S8 }],
  ratio: ['Speed Ratio', { min: -10, max: 10, format: plus, ...S8 }],
};
// Pages in on-screen order: [parameter byte, field].
const EQS = [[7, 'eqL'], [6, 'eqH']];
const DLY = [[0, 'dly'], [2, 'fb'], [3, 'hd']];
const PAGES = {
  hall: [[0, 'rev97'], [3, 'pre200'], [4, 'erLevel'], [2, 'hd'], ...EQS],
  room: [[0, 'rev47'], [3, 'pre200'], [4, 'erLevel'], [2, 'hd'], ...EQS],
  er: [[0, 'er70'], [1, 'pre200'], ...EQS],
  delay: [[0, 'timeL'], [4, 'timeR'], [2, 'fb'], [3, 'hd'], ...EQS],
  chorus: [[0, 'depth'], [1, 'speed'], [4, 'time200'], [2, 'wave'], ...EQS],
  flanger: [[0, 'depth'], [1, 'speed'], [4, 'time50'], [3, 'fb'], [2, 'wave'], ...EQS],
  phaser: [[4, 'manual'], [1, 'speed'], [0, 'depth'], [3, 'fb'], [2, 'wave']],
  tremolo: [[0, 'depth'], [1, 'speed'], [2, 'wave'], [3, 'shape'], ...EQS],
  eq: [[7, 'lowGain'], [5, 'lowFreq'], [6, 'highGain'], [4, 'highFreq']],
  overdrive: [[2, 'drive'], [3, 'level'], ...EQS],
  distortion: [[2, 'dist'], [3, 'level'], [7, 'eqL']],
  exciter: [[0, 'blend'], [1, 'ep'], ...EQS],
  symphonic: [[0, 'depth'], ...EQS],
  rotary: [[0, 'depth'], [2, 'ratio']],
  dHall: [...DLY, [4, 'rev97'], [7, 'pre150'], [6, 'hd']],
  dRoom: [...DLY, [4, 'rev47'], [7, 'pre150'], [6, 'hd']],
  dEr: [...DLY, [4, 'er30'], [5, 'pre100']],
  dDelay: [[0, 'timeL'], [2, 'fbL'], [3, 'hdL'], [4, 'timeR'], [6, 'fbR'], [7, 'hdR']],
  dChorus: [...DLY, [4, 'depth'], [5, 'speed'], [6, 'wave']],
  dFlanger: [...DLY, [4, 'depth'], [5, 'speed'], [7, 'fb']],
  dPhaser: [...DLY, [4, 'depth'], [5, 'speed'], [6, 'fb']],
  dTremolo: [...DLY, [4, 'depth'], [5, 'speed'], [7, 'shape']],
};
/** The page each effect type uses (DS:2A4C), indexed by the type byte. */
const TYPE_PAGE = ['hall', 'hall', 'hall', 'room', 'room', 'room', 'er', 'er', 'er', 'delay', 'delay', 'chorus', 'chorus',
  'flanger', 'flanger', 'phaser', 'phaser', 'tremolo', 'tremolo', 'eq', 'overdrive', 'distortion', 'exciter', 'symphonic',
  'rotary', 'dHall', 'dRoom', 'dEr', 'dDelay', 'dChorus', 'dFlanger', 'dPhaser', 'dTremolo', null];
/** Parameter bytes the M1 loads when an effect type is selected (image 1EB80, 8 per type). */
const FX_DEFAULTS = [[33, 0, 40, 55, 46, 0, 0, 251], [26, 0, 40, 30, 46, 0, 0, 253], [36, 0, 40, 120, 46, 0, 254, 0],
  [3, 0, 10, 22, 76, 0, 0, 1], [13, 0, 30, 30, 76, 0, 4, 2], [18, 0, 20, 20, 60, 0, 0, 3], [7, 30, 0, 0, 0, 0, 0, 0],
  [10, 20, 0, 0, 0, 0, 0, 0], [9, 10, 0, 0, 0, 0, 0, 0], [250, 0, 50, 10, 4, 1, 0, 0], [180, 0, 80, 10, 104, 1, 0, 0],
  [60, 9, 3, 0, 10, 0, 0, 0], [20, 79, 0, 0, 5, 0, 0, 0], [70, 5, 6, 181, 0, 0, 0, 0], [37, 6, 4, 80, 25, 0, 0, 0],
  [60, 22, 2, 181, 99, 0, 0, 0], [69, 18, 1, 87, 99, 0, 0, 0], [80, 52, 2, 99, 0, 0, 0, 0], [63, 109, 1, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 0, 0], [0, 0, 80, 15, 0, 0, 0, 0], [0, 0, 80, 20, 0, 0, 0, 0], [99, 5, 0, 0, 0, 0, 0, 0],
  [80, 0, 0, 0, 0, 0, 0, 0], [62, 0, 5, 0, 0, 0, 0, 0], [250, 0, 50, 10, 33, 0, 40, 55], [250, 0, 50, 10, 13, 0, 30, 30],
  [250, 0, 50, 10, 10, 30, 0, 0], [250, 0, 50, 10, 4, 1, 50, 10], [250, 0, 50, 10, 60, 9, 1, 0], [250, 0, 50, 10, 70, 5, 4, 181],
  [250, 0, 50, 10, 60, 22, 181, 0], [250, 0, 50, 10, 80, 52, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];
export const NO_EFFECT = 33;
const fxField = (type, slot) => {
  const f = (PAGES[TYPE_PAGE[type]] || []).find(([s]) => s === slot);
  return f ? FXF[f[1]] : null;
};
const isDouble = (type) => type >= 25 && type <= 32;

/** One of an effect's 8 parameter bytes: label, range and display follow the effect type. */
function fxParam(at, n, slot, section) {
  const o = at + 9 + (n - 1) * 8 + slot;
  const field = (data) => fxField(data[at + n - 1], slot);
  const s8 = (b) => (b > 127 ? b - 256 : b);
  return P(o, `Effect ${n} parameter ${slot + 1}`, {
    size: 2, min: -128, max: 511, group: `Effect ${n}`, section,
    get: (data) => {
      const k = field(data)?.[1] || {};
      if (k.word) return data[o] | (data[o + 1] << 8);
      if (k.bit0) return data[o] & 1;
      return k.signed ? s8(data[o]) : data[o];
    },
    set: (data, v) => {
      const k = field(data)?.[1] || {};
      if (k.word) { data[o] = v & 255; data[o + 1] = (v >> 8) & 255; } else if (k.bit0) data[o] = (data[o] & 0xfe) | (v & 1);
      else data[o] = v & 255;
    },
    dynamic: (data) => {
      const f = field(data);
      if (!f) return { hidden: true };
      const { word, bit0, signed, ...shown } = f[1];
      return { label: f[0], ...shown };
    },
  });
}

/** Selecting a type loads that type's parameter defaults, as the M1 does. */
const fxType = (at, n, section) => P(at + n - 1, `Effect ${n} type`, {
  options: named(EFFECTS), relayout: true, group: `Effect ${n}`, section,
  get: (data) => data[at + n - 1],
  set: (data, v) => {
    if (data[at + n - 1] === v) return;
    data[at + n - 1] = v;
    FX_DEFAULTS[v]?.forEach((b, i) => { data[at + 9 + (n - 1) * 8 + i] = b; });
  },
});

const fxBalance = (v) => (v === 0 ? 'DRY' : v === 100 ? 'EFF' : `${100 - v}:${v}`);
const outPan = (v) => (v === 0 ? 'OFF' : v === 1 ? 'L' : v === 101 ? 'R' : `${101 - v}:${v - 1}`);
function effectBlock(at, section) {
  const bal = (n, part) => {
    const o = at + 2 + (n - 1) * 2 + part;
    return P(o, `Effect ${n} balance`, {
      min: 0, max: 100, format: fxBalance, group: `Effect ${n}`, section,
      // a single effect keeps one balance in both bytes
      set: (data, v) => { data[o] = v; if (!part && !isDouble(data[at + n - 1])) data[o + 1] = v; },
      get: (data) => data[o],
      dynamic: (data) => {
        const type = data[at + n - 1];
        if (type >= NO_EFFECT || (part && !isDouble(type))) return { hidden: true };
        return { label: isDouble(type) ? `DRY:EFF Balance (${part ? EFFECTS[type].split('/')[1] : 'Delay'})` : 'DRY:EFF Balance' };
      },
    });
  };
  return [
    fxType(at, 1, section),
    P(at + 8, 'Effect 1 on', { bits: 2, options: [[0, 'OFF'], [3, 'ON']], group: 'Effect 1', section }),
    bal(1, 0), bal(1, 1),
    ...Array.from({ length: 8 }, (_, s) => fxParam(at, 1, s, section)),
    fxType(at, 2, section),
    P(at + 8, 'Effect 2 on', { shift: 2, bits: 2, options: [[0, 'OFF'], [3, 'ON']], group: 'Effect 2', section }),
    bal(2, 0), bal(2, 1),
    ...Array.from({ length: 8 }, (_, s) => fxParam(at, 2, s, section)),
    P(at + 8, 'Effect placement', { shift: 4, bits: 1, options: named(['PARALLEL', 'SERIAL']), group: 'Effect placement and outputs', section }),
    P(at + 6, 'Out 3 panpot', { min: 0, max: 101, format: outPan, group: 'Effect placement and outputs', section }),
    P(at + 7, 'Out 4 panpot', { min: 0, max: 101, format: outPan, group: 'Effect placement and outputs', section }),
  ];
}

// Multisound 0-99 are internal (%02d), 100 and up the PCM card's (C%d, names from the card).
const MS_OPTIONS = [...MULTISOUNDS.map((n, i) => [i, `${String(i).padStart(2, '0')} ${n}`]),
  ...Array.from({ length: 28 }, (_, i) => [100 + i, `C${i} (card multisound)`])];
const multisound = (o, label) => P(o, label, {
  min: 0, max: 127, group: 'Oscillators', section: 'common',
  dynamic: (data) => (data[10] === 2 ? { label: label.replace('Multisound', 'Drum kit'), options: O.kit } : { options: MS_OPTIONS }),
});

const PROGRAM = [
  ...Array.from({ length: 10 }, (_, i) => P(i, `Name ${i + 1}`, { hidden: true, section: 'common', group: 'Name' })),
  P(10, 'OSC mode', { options: O.oscMode, relayout: true, group: 'Oscillators', section: 'common' }),
  P(11, 'Voice mode', { bits: 1, options: O.poly, group: 'Oscillators', section: 'common' }),
  P(11, 'Hold', { shift: 1, bits: 1, options: O.onoff, group: 'Oscillators', section: 'common' }),
  multisound(12, 'OSC1 Multisound'), P(13, 'OSC1 Octave', { signed: true, options: O.octave, group: 'Oscillators', section: 'common' }),
  multisound(14, 'OSC2 Multisound'), P(15, 'OSC2 Octave', { signed: true, options: O.octave, group: 'Oscillators', section: 'common' }),
  P(16, 'OSC2 Interval', { signed: true, min: -12, max: 12, format: plus, group: 'Oscillators', section: 'common' }),
  P(17, 'OSC2 Detune', { signed: true, min: -50, max: 50, format: plus, group: 'Oscillators', section: 'common' }),
  { ...u99(18, 'OSC2 Delay start'), group: 'Oscillators', section: 'common' },
  ...[[19, 'Pitch MG', O.mgOsc, 'OSC select'], [23, 'VDF MG', O.mgVdf, 'VDF select']].flatMap(([o, g, sel, selLabel]) => [
    P(o, 'Waveform', { bits: 2, options: O.wave, group: g, section: 'common' }),
    P(o, selLabel, { shift: 5, bits: 2, options: sel, group: g, section: 'common' }),
    P(o, 'Key sync', { shift: 7, bits: 1, options: O.onoff, group: g, section: 'common' }),
    { ...u99(o + 1, 'Frequency'), group: g, section: 'common' }, { ...u99(o + 2, 'Delay'), group: g, section: 'common' },
    { ...u99(o + 3, 'Intensity'), group: g, section: 'common' },
  ]),
  ...[[27, 'Pitch', 12], [28, 'Pitch MG intensity', 0], [29, 'VDF cutoff', 99], [30, 'VDF MG intensity', 0], [31, 'VDA amplitude', 99]]
    .map(([o, l, r]) => (r ? P(o, l, { signed: true, min: -r, max: r, format: plus }) : u99(o, l))).map((p) => ({ ...p, group: 'Aftertouch', section: 'common' })),
  ...[[32, 'Pitch bend range', 12], [33, 'VDF sweep intensity', 99], [34, 'Pitch MG intensity (+Y)', 0], [36, 'VDF MG intensity (-Y)', 0]]
    .map(([o, l, r]) => (r ? P(o, l, { signed: true, min: -r, max: r, format: plus }) : u99(o, l))).map((p) => ({ ...p, group: 'Joystick', section: 'common' })),
  P(35, 'Pitch MG frequency (+Y)', { min: 0, max: 3, group: 'Joystick', section: 'common' }),
  P(37, 'VDF MG frequency (-Y)', { min: 0, max: 3, group: 'Joystick', section: 'common' }),
  ...effectBlock(38, 'common'),
  ...voiceBlock(1), ...voiceBlock(2),
];

// Combination timbres: 11 bytes each from byte 36. The timbre pages address them through a
// base of DS:98EB (E000:325A adds 36 + timbre x 11): +9 holds the MIDI filters (bits 0-3,
// masks 1/2/4/8 on the MIDI FILTERING page), +10 the MIDI channel (bits 0-3) and bit 4,
// which the Program field shows as OFF (timbre off). Panpot bit 7 is set by the M1 itself
// (E000:3187) when the timbre plays a DRUMS program; it then shows SND.
const PAN13 = [[0, 'A'], ...Array.from({ length: 9 }, (_, i) => [i + 1, `${9 - i}:${i + 1}`]), [10, 'B'], [11, 'C'], [12, 'C+D'], [13, 'D']];
/** The timbre the M1 builds for each new timbre slot (DS:062C) when the combination type changes. */
const INIT_TIMBRE = [0, 99, 0, 0, 5, 127, 0, 127, 1, 255, 16];
/** Changing the combination type rebuilds the timbres as the M1 does (E000:327D). */
function setCombiType(d, v) {
  if (d[10] === v) return;
  const old = Uint8Array.from(d);
  const ch = unit.channel & 15;
  d[10] = v;
  if (v === 4) { for (let t = 1; t < 8; t++) d[36 + t * 11 + 7] = 127; return; }
  for (let t = 0; t < 8; t++) d.set(INIT_TIMBRE, 36 + t * 11);
  d[36] = old[36]; d[46] = ch; // timbre 1 keeps its program and plays on the global channel
  if (v !== 0) { d[47] = old[47]; d[57] = ch; d[54] = 127; } // timbre 2 too for LAYER, SPLIT and VEL.SW
  if (v === 2) { d[41] = 59; d[53] = 60; } // split at C4
  if (v === 3) { d[43] = 62; d[55] = 63; } // velocity switch at 63
}

const COMBINATION = [
  ...Array.from({ length: 10 }, (_, i) => P(i, `Name ${i + 1}`, { hidden: true, section: 'common', group: 'Name' })),
  P(10, 'Combination type', { options: O.combiType, relayout: true, group: 'Combination', section: 'common', get: (d) => d[10], set: setCombiType,
    help: 'Changing the type rebuilds the timbres the way the M1 does: timbre 1 (and 2 for LAYER, SPLIT and VEL.SW) keep their programs, the rest are switched off.' }),
  P(53, 'Split point', { min: 1, max: 127, format: NOTE, group: 'Combination', section: 'common', get: (d) => d[53], set: (d, v) => { d[53] = v; d[41] = v - 1; },
    dynamic: (d) => (d[10] === 2 ? {} : { hidden: true }), help: 'The lowest key of timbre 2; timbre 1 ends one key below.' }),
  P(55, 'Velocity switch point', { min: 1, max: 127, group: 'Combination', section: 'common', get: (d) => d[55], set: (d, v) => { d[55] = v; d[43] = v - 1; },
    dynamic: (d) => (d[10] === 3 ? {} : { hidden: true }), help: 'The lowest velocity of timbre 2; timbre 1 plays up to one below.' }),
  ...effectBlock(11, 'common'),
  ...Array.from({ length: 8 }, (_, t) => {
    const b = 36 + t * 11;
    const sec = `t${t}`;
    const g = 'Timbre';
    return [
      P(b, 'Program', {
        min: -1, max: 99, group: g, section: sec, relayout: true,
        get: (d) => ((d[b + 10] & 0x10) ? -1 : d[b]),
        set: (d, v) => { if (v < 0) d[b + 10] |= 0x10; else { d[b + 10] &= ~0x10; d[b] = v; } },
        dynamic: (_d, ctx) => ({ options: [[-1, 'OFF'], ...programOptions(ctx)] }),
      }),
      { ...u99(b + 1, 'Level'), group: g, section: sec },
      P(b + 2, 'Transpose', { signed: true, min: -24, max: 24, format: plus, group: g, section: sec }),
      P(b + 3, 'Detune', { signed: true, min: -50, max: 50, format: plus, group: g, section: sec }),
      P(b + 4, 'Panpot', {
        min: 0, max: 14, group: g, section: sec,
        get: (d) => ((d[b + 4] & 0x80) ? 14 : d[b + 4]),
        set: (d, v) => { if (!(d[b + 4] & 0x80) && v <= 13) d[b + 4] = v; },
        dynamic: (d) => ((d[b + 4] & 0x80)
          ? { options: [[14, 'SND']], readOnly: true, help: 'The timbre plays a DRUMS program, so the drum kit pans apply (set by the M1).' }
          : { options: PAN13, help: 'A and B are the stereo outputs (n:m mixes them); C and D are the individual outputs 3 and 4.' }),
      }),
      { ...key(b + 5, 'Key window top'), group: 'Windows', section: sec }, { ...key(b + 6, 'Key window bottom'), group: 'Windows', section: sec },
      P(b + 7, 'Velocity window top', { min: 1, max: 127, group: 'Windows', section: sec }),
      P(b + 8, 'Velocity window bottom', { min: 1, max: 127, group: 'Windows', section: sec }),
      P(b + 10, 'MIDI channel', { bits: 4, options: O.channel, group: 'MIDI', section: sec }),
      ...['Program change', 'Damper', 'Aftertouch', 'Control change'].map((l, i) => P(b + 9, l, { shift: i, bits: 1, options: O.disEna, group: 'MIDI filtering', section: sec })),
    ];
  }).flat(),
];

// Global: the dump sends RAM 984E-9852 and 9858-9867 (E000:A446); the M1 loads the first 19
// bytes back and ignores bytes 19-20 (F000:23B4-23F4). Then 4 drum kits of 30 instruments.
const NOTES12 = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const readOnlyNow = (o, labels) => (d) => ({ options: [[d[o], labels[d[o]] ?? String(d[o])]], readOnly: true });
const GLOBAL = [
  P(0, 'Master tune', { signed: true, min: -50, max: 50, format: plus, group: 'Tuning', section: 'global' }),
  P(1, 'Key transpose', { signed: true, min: -12, max: 12, format: plus, group: 'Tuning', section: 'global' }),
  P(5, 'Scale type', { options: O.scale, relayout: true, group: 'Scale', section: 'global' }),
  P(6, 'Key', { options: named(NOTES12), group: 'Scale', section: 'global', help: 'The key of the Pure Major and Pure Minor scales.' }),
  ...NOTES12.map((n, i) => P(7 + i, n, { signed: true, min: -50, max: 50, format: plus, group: 'User scale', section: 'global', help: `Tuning of every ${n} in cents (User Programable scale)` })),
  P(3, 'Pedal 1 assign', { options: O.pedal, group: 'Pedals', section: 'global' }),
  P(4, 'Pedal 2 assign', { options: O.pedal, group: 'Pedals', section: 'global' }),
  P(2, 'Damper switch polarity', { bits: 1, options: [[0, '+'], [1, '-']], group: 'Pedals', section: 'global',
    help: 'Shown on the M1 keyboard (Damper Switch Polarity); the M1R keeps it without a page.' }),
  P(19, 'Memory allocation', { group: 'Memory (read only)', section: 'global', dynamic: readOnlyNow(19, ['100PROG/100COMBI/4400SEQ', '50PROG/50COMBI/7700SEQ']),
    help: 'Set on the M1 itself; a received global dump does not change it.' }),
  P(20, 'Selected combination', { group: 'Memory (read only)', section: 'global', dynamic: readOnlyNow(20, Array.from({ length: 100 }, (_, i) => `I${String(i).padStart(2, '0')}`)),
    help: 'The combination selected when the dump was made; a received global dump does not change it.' }),
  ...Array.from({ length: 4 }, (_, k) => Array.from({ length: 30 }, (_, i) => {
    const b = 21 + (k * 30 + i) * 7;
    const sec = `kit${k}`;
    const g = `Instrument ${i + 1}`;
    return [
      P(b, `${i + 1} Sound`, { min: 0, max: 127, options: O.drum, group: g, section: sec }),
      P(b + 1, `${i + 1} Key`, { min: 0, max: 127, format: NOTE, group: g, section: sec }),
      P(b + 2, `${i + 1} Pan`, { options: PAN13, group: g, section: sec }),
      P(b + 3, `${i + 1} Tune`, { signed: true, min: -120, max: 120, format: plus, group: g, section: sec }),
      P(b + 4, `${i + 1} Level`, { signed: true, min: -99, max: 99, format: plus, group: g, section: sec }),
      P(b + 5, `${i + 1} Decay`, { signed: true, min: -99, max: 99, format: plus, group: g, section: sec }),
    ];
  }).flat()).flat(),
];

function finish(list, prefix) {
  return list.map((p, i) => {
    const q = { key: `${prefix}${i}`, group: 'Other', ...p };
    if (q.signed && !q.bits) q.bits = 8;
    return q;
  });
}

// ------------------------------------------------------------------ unit state and sending
// The M1 takes program dumps in the program modes and combination dumps in the combination
// modes. The definition remembers the mode it last set or read and switches when needed.
const unit = { mode: null, programBank: 0, combiBank: 0, channel: 0 };
function needMode(ctx, want, card = 0) {
  unit.channel = (ctx?.deviceId ?? 0) & 15;
  const ok = want === 'program' ? unit.mode === 2 || unit.mode === 3 : unit.mode === 0 || unit.mode === 1;
  if (ok) return [];
  unit.mode = want === 'program' ? 2 : 0;
  return [msg.mode(ctx, unit.mode, card)];
}

async function readMode(api) {
  try {
    const m = await api.request(msg.modeRequest(api.ctx), (r) => fn(r) === 0x42, (r) => r[5]);
    unit.mode = m;
    return m;
  } catch { return null; }
}

/** Request a dump; `want` is the reply function code. The timeout allows for the reply's size. */
const REPLY_BYTES = { 0x40: 170, 0x49: 150, 0x51: 1000, 0x4c: 16400, 0x4d: 14200 };
async function ask(api, bytes, want) {
  const c = api.g.client;
  const timeout = (c.s?.timeout ?? 2500) + ((REPLY_BYTES[want] ?? 200) / (c.s?.bytesPerSecond ?? 2900)) * 1000 + 1000;
  const reply = await c.request(Uint8Array.from(bytes), { match: (_m, r) => [want, 0x24, 0x26].includes(fn(r)), timeout });
  const r = reply.raw ?? reply;
  if (fn(r) !== want) throw new Error(fn(r) === 0x24 ? 'The M1 refused the request in its current mode.' : 'The M1 did not understand the request.');
  return dumpData(r);
}

// Reads switch the M1's mode, so one runs at a time (an open page and the connect-time
// loader would otherwise ask for a program while the M1 sits in combination mode).
let busy = Promise.resolve();
const serial = (fn) => (...args) => { const run = busy.then(() => fn(...args)); busy = run.catch(() => {}); return run; };

const fetchProgram = serial(async (api) => {
  await readMode(api);
  for (const m of needMode(api.ctx, 'program')) api.send(m);
  const d = await ask(api, msg.programRequest(api.ctx), 0x40);
  return d.slice(0, PROGRAM_SIZE);
});
const fetchCombi = serial(async (api) => {
  unit.channel = (api.ctx?.deviceId ?? 0) & 15;
  await readMode(api);
  for (const m of needMode(api.ctx, 'combination')) api.send(m);
  const d = await ask(api, msg.combiRequest(api.ctx), 0x49);
  return d.slice(0, COMBI_SIZE);
});
const fetchGlobal = serial(async (api) => (await ask(api, msg.globalRequest(api.ctx), 0x51)).slice(0, GLOBAL_SIZE));

const nameOf = (d) => readText(d, 0, 10, (b) => (b < 32 ? 32 : b));
const pc = (ctx, n) => [0xc0 | ((ctx?.deviceId ?? 0) & 15), n];

// Names of every program / combination come from one bulk dump each (no selecting).
function bulkNames(want, size, request) {
  return async (api, bank, onName) => {
    const d = await ask(api, request(api.ctx, bank), want);
    for (let i = 0; i < 100 && (i + 1) * size <= d.length; i++) onName(i, nameOf(d.slice(i * size, (i + 1) * size)));
  };
}

function programOptions(ctx) {
  const names = ctx?.names?.program;
  return Array.from({ length: 100 }, (_, i) => {
    const n = names?.get(`0:${i}`);
    return [i, `I${String(i).padStart(2, '0')}${n ? ` ${n}` : ''}`];
  });
}

const BANKS = [[0, 'Internal'], [1, 'Card']];
const slotLabel = (bank, i) => `${bank ? 'C' : 'I'}${String(i).padStart(2, '0')}`;

// ------------------------------------------------------------------ librarian
/** Split a dump into programs, combinations and the rest; single items carry write requests. */
function libraryItems(msgs, ctx) {
  const items = [];
  for (const m of msgs) {
    const f = fn(m);
    if (f === 0x4c || f === 0x4d) {
      const prog = f === 0x4c;
      const size = prog ? PROGRAM_SIZE : COMBI_SIZE;
      const card = m[5] & 1;
      const d = dumpData(m);
      for (let i = 0; i < 100 && (i + 1) * size <= d.length; i++) {
        const one = d.slice(i * size, (i + 1) * size);
        items.push({
          key: `${prog ? 'p' : 'c'}${card}:${i}`, label: `${prog ? 'Program' : 'Combination'} ${slotLabel(card, i)}`, name: nameOf(one),
          object: prog ? 'program' : 'combination', single: one,
          msgs: [msg.mode(ctx, prog ? 2 : 0, card), prog ? msg.program(ctx, one) : msg.combi(ctx, one), prog ? msg.writeProgram(ctx, card, i) : msg.writeCombi(ctx, card, i)].map((x) => Uint8Array.from(x)),
        });
      }
    } else if (f === 0x40 || f === 0x49) {
      const d = dumpData(m);
      items.push({ key: `e${items.length}`, label: f === 0x40 ? 'Program (edit buffer)' : 'Combination (edit buffer)', name: nameOf(d), object: f === 0x40 ? 'program' : 'combination', msgs: [m] });
    } else {
      items.push({ key: `x${items.length}`, label: isM1(m) ? `M1 ${NAMES[m[4]] || 'message'}` : 'Other message', name: '', object: f === 0x51 ? 'global' : null, msgs: [m] });
    }
  }
  return items;
}

/** Find an object's data in a .syx: single dump, or the first slot of a bulk dump. */
function fromSyx(single, bulk, size) {
  return (msgs) => {
    const m = msgs.find((r) => fn(r) === single) || msgs.find((r) => fn(r) === bulk);
    if (!m) return null;
    const d = dumpData(m);
    return d.length >= size ? d.slice(0, size) : null;
  };
}

// ------------------------------------------------------------------ simulator (demo mode, tests)
function simulate() {
  const prog = initProgram;
  const combi = initCombi;
  const named10 = (d, s) => { for (let i = 0; i < 10; i++) d[i] = s.charCodeAt(i) || 32; return d; };
  const programs = Array.from({ length: 100 }, (_, i) => named10(prog(), `Program ${String(i).padStart(2, '0')}`));
  const combis = Array.from({ length: 100 }, (_, i) => named10(combi(), `Combi ${String(i).padStart(2, '0')}`));
  const glob = new Uint8Array(GLOBAL_SIZE);
  const s = { mode: 2, prog: Uint8Array.from(programs[0]), combi: Uint8Array.from(combis[0]), protect: false };
  const reply = (f, data, extra = []) => [[0xf0, 0x42, 0x30, MODEL, f, ...extra, ...(data ? pack(data) : []), 0xf7]];
  const cat = (list) => { const out = new Uint8Array(list.length * list[0].length); list.forEach((x, i) => out.set(x, i * x.length)); return out; };
  return {
    state: s, programs, combis,
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) {
        if (d[1] < 100) { if (s.mode >= 2) s.prog = Uint8Array.from(programs[d[1]]); else s.combi = Uint8Array.from(combis[d[1]]); }
        return [];
      }
      if (d[0] !== 0xf0) return null;
      if (d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) return [[0xf0, 0x7e, 0x00, 0x06, 0x02, 0x42, 0x19, 0x00, 0x01, 0x00, 0x0f, 0x00, 0x01, 0x00, 0xf7]];
      if (!isM1(d)) return null;
      const f = d[4];
      const progMode = s.mode === 2 || s.mode === 3;
      switch (f) {
        case 0x12: return reply(0x42, null, [s.mode, 0, 0, 4]);
        case 0x4e: s.mode = d[5]; return reply(0x23);
        case 0x10: return progMode ? reply(0x40, s.prog) : reply(0x24);
        case 0x19: return progMode ? reply(0x24) : reply(0x49, s.combi);
        case 0x0e: return reply(0x51, glob, [0]);
        case 0x1c: return reply(0x4c, cat(programs), [0]);
        case 0x1d: return reply(0x4d, cat(combis), [0]);
        case 0x40: if (!progMode) return reply(0x24); s.prog = dumpData(d).slice(0, PROGRAM_SIZE); return reply(0x23);
        case 0x49: if (progMode) return reply(0x24); s.combi = dumpData(d).slice(0, COMBI_SIZE); return reply(0x23);
        case 0x51: glob.set(dumpData(d).slice(0, GLOBAL_SIZE)); return reply(0x23);
        case 0x11: if (!progMode || s.protect) return reply(0x22); programs[d[6]] = Uint8Array.from(s.prog); return reply(0x21);
        case 0x1a: if (progMode || s.protect) return reply(0x22); combis[d[6]] = Uint8Array.from(s.combi); return reply(0x21);
        default: return reply(0x26);
      }
    },
  };
}

// ------------------------------------------------------------------ objects
const programParams = finish(PROGRAM, 'p').map((p) => ({ ...p, sendKey: 'program' }));
const combiParams = finish(COMBINATION, 'c').map((p) => ({ ...p, sendKey: 'combination' }));
const globalParams = finish(GLOBAL, 'g').map((p) => ({ ...p, sendKey: 'global' }));

const initProgram = () => { const d = new Uint8Array(PROGRAM_SIZE); d.set([...'Init Prog '].map((c) => c.charCodeAt(0))); d[86] = 99; d[126] = 99; d[71] = 99; d[111] = 99; d[38] = NO_EFFECT; d[39] = NO_EFFECT; return d; };
function initCombi() {
  const d = new Uint8Array(COMBI_SIZE);
  d.set([...'Init Combi'].map((c) => c.charCodeAt(0)));
  d[11] = NO_EFFECT; d[12] = NO_EFFECT;
  for (let t = 0; t < 8; t++) d.set(INIT_TIMBRE, 36 + t * 11);
  d[46] = 0; // timbre 1 on, channel 1
  return d;
}

function renameAction(label, build) {
  return {
    label: 'Rename', run: async (api) => {
      const r = await api.form(`${label} name`, [{ key: 'name', label: 'Name (10 characters)', value: nameOf(api.data), maxlength: 10 }]);
      if (!r) return;
      const d = Uint8Array.from(api.data);
      for (let i = 0; i < 10; i++) d[i] = Math.max(32, Math.min(127, r.name.charCodeAt(i) || 32));
      api.send(build(api.ctx, d));
      api.setData(d);
    },
  };
}

export default {
  coverage: 'Every byte of programs, combinations, global settings and drum kits, labelled, ranged and displayed as the M1R v1.06 firmware shows them (including the per-type effect pages and the M1 keyboard damper polarity), read from and sent to the M1 by dump and checked on an M1R. Program and combination memories with names from one bulk dump each, store, card banks, mode handling, and a MIDI channel page for MULTI combinations.',
  sysex: { manufacturer: [0x42], model: MODEL, deviceIdDefault: 0 },
  minGap: 30,
  describe,
  // Main Library import: the M1/M1R messages this definition reads (both models share it).
  recognise: (raw) => isM1(raw),
  deviceIds: ['korg-m1', 'korg-m1r'],
  simulate,
  libraryItems,
  objects: [
    {
      key: 'program', page: 'Program', icon: '◆', label: 'Program', size: PROGRAM_SIZE, autoLoad: true,
      init: initProgram, fetch: fetchProgram, params: programParams, name: nameOf, cols: 3,
      sections: [{ key: 'common', label: 'Common' }, { key: 'osc1', label: 'OSC1 / VDF1 / VDA1' }, { key: 'osc2', label: 'OSC2 / VDF2 / VDA2' }],
      sendParam: (_p, _v, data, ctx) => [...needMode(ctx, 'program'), msg.program(ctx, data)],
      note: 'Every change sends the whole program (143 bytes) to the M1 edit buffer, so it is heard at once. Store writes it into a memory (turn off program memory protect on the M1 first).',
      sendAll: { label: 'Send to M1', title: 'Send the whole program to the edit buffer', build: (data, ctx) => [...needMode(ctx, 'program'), msg.program(ctx, data)] },
      toSyx: (data, ctx) => msg.program(ctx, data),
      fromSyx: fromSyx(0x40, 0x4c, PROGRAM_SIZE),
      actions: [renameAction('Program', (ctx, d) => [...needMode(ctx, 'program'), msg.program(ctx, d)])],
      slots: {
        label: 'Programs', banks: BANKS, count: 100, slotLabel, name: nameOf,
        recall: (bank, i, ctx) => { unit.mode = 2; return [msg.mode(ctx, 2, bank), pc(ctx, i)]; },
        fetch: serial(async (api, bank, i) => { api.send([msg.mode(api.ctx, 2, bank), pc(api.ctx, i)]); unit.mode = 2; await new Promise((r) => setTimeout(r, 150)); return (await ask(api, msg.programRequest(api.ctx), 0x40)).slice(0, PROGRAM_SIZE); }),
        scanBank: serial(bulkNames(0x4c, PROGRAM_SIZE, msg.allProgramsRequest)),
        store: (bank, i, ctx, data) => { unit.mode = 2; return [msg.mode(ctx, 2, bank), msg.program(ctx, data), msg.writeProgram(ctx, bank, i)]; },
        writable: () => true,
        autoNames: [0],
        note: (bank, ctx) => `Play switches to program mode and sends program change ${'0-99'} on the global channel (${(ctx.deviceId & 15) + 1}). Names come from one all-programs dump.${bank ? ' Card banks need a RAM card in the M1.' : ''}`,
      },
    },
    {
      key: 'combination', page: 'Combination', icon: '▦', label: 'Combination', size: COMBI_SIZE, autoLoad: false,
      init: initCombi, fetch: fetchCombi, params: combiParams, name: nameOf, cols: 3,
      sections: [{ key: 'common', label: 'Common' }, ...Array.from({ length: 8 }, (_, t) => ({ key: `t${t}`, label: `Timbre ${t + 1}` }))],
      multi: {
        page: 'MIDI channels', label: 'Timbres', count: 8, section: (i) => `t${i}`, partLabel: (i) => `Timbre ${i + 1}`,
        columns: [
          { label: 'Program', params: ['Program'], role: 'patch' },
          { label: 'MIDI channel', params: ['MIDI channel'], role: 'channel' },
          { label: 'Level', params: ['Level'] },
          { label: 'Panpot', params: ['Panpot'] },
          { label: 'Transpose', params: ['Transpose'] },
          { label: 'Key window', params: ['Key window bottom', 'Key window top'] },
        ],
        on: (i, d) => !(d[36 + i * 11 + 10] & 0x10),
        mode: {
          param: 'Combination type', value: 4, button: 'Make it a MULTI combination',
          note: 'The SINGLE, LAYER, SPLIT and VEL.SW types put their timbres on the global channel; a MULTI combination gives each timbre its own channel and program.',
        },
        note: 'Each timbre plays its program on its MIDI channel (Program OFF switches a timbre off). Changes go to the combination edit buffer; store the combination on the Combination page to keep the setup.',
      },
      sendParam: (_p, _v, data, ctx) => [...needMode(ctx, 'combination'), msg.combi(ctx, data)],
      note: 'Reading or editing switches the M1 to combination mode. Every change sends the whole combination (124 bytes).',
      sendAll: { label: 'Send to M1', build: (data, ctx) => [...needMode(ctx, 'combination'), msg.combi(ctx, data)] },
      toSyx: (data, ctx) => msg.combi(ctx, data),
      fromSyx: fromSyx(0x49, 0x4d, COMBI_SIZE),
      actions: [renameAction('Combination', (ctx, d) => [...needMode(ctx, 'combination'), msg.combi(ctx, d)])],
      slots: {
        label: 'Combinations', banks: BANKS, count: 100, slotLabel, name: nameOf,
        recall: (bank, i, ctx) => { unit.mode = 0; return [msg.mode(ctx, 0, bank), pc(ctx, i)]; },
        fetch: serial(async (api, bank, i) => { api.send([msg.mode(api.ctx, 0, bank), pc(api.ctx, i)]); unit.mode = 0; await new Promise((r) => setTimeout(r, 150)); return (await ask(api, msg.combiRequest(api.ctx), 0x49)).slice(0, COMBI_SIZE); }),
        scanBank: serial(bulkNames(0x4d, COMBI_SIZE, msg.allCombisRequest)),
        store: (bank, i, ctx, data) => { unit.mode = 0; return [msg.mode(ctx, 0, bank), msg.combi(ctx, data), msg.writeCombi(ctx, bank, i)]; },
        writable: () => true,
        autoNames: [0],
        note: (bank, ctx) => `Play switches to combination mode and sends a program change on the global channel (${(ctx.deviceId & 15) + 1}).`,
      },
    },
    {
      key: 'global', page: 'Global & drum kits', icon: '⚙', label: 'Global', size: GLOBAL_SIZE,
      init: () => new Uint8Array(GLOBAL_SIZE),
      fetch: fetchGlobal,
      params: globalParams, cols: 4,
      sections: [{ key: 'global', label: 'Global' }, ...[0, 1, 2, 3].map((k) => ({ key: `kit${k}`, label: `Drum kit ${k + 1}` }))],
      groupInfo: {
        'User scale': { note: 'Used when the scale type is User Programable: each note is tuned in cents.' },
        'Memory (read only)': { note: 'The M1 reports these in its global dump but does not take them back from one.' },
      },
      sendParam: (_p, _v, data, ctx) => msg.global(ctx, data),
      note: 'Global settings (memory protect and the MIDI settings are not part of the global dump), and the 4 drum kits of 30 instruments: drum sound, key, pan, tune, level and decay. Every change sends the whole global block (861 bytes).',
      sendAll: { label: 'Send to M1', build: (data, ctx) => msg.global(ctx, data) },
      toSyx: (data, ctx) => msg.global(ctx, data),
      fromSyx: fromSyx(0x51, 0x51, GLOBAL_SIZE),
    },
  ],
  // Librarian "Complete dump": the M1's own All Data dump (programs, combinations, global with drum
  // kits, sequences) plus the program being edited. All Data is one long message, so the first
  // reply can take half a minute to arrive.
  fullDump: ['Current program', { request: 'All data (programs, combinations, global, sequences)', timeout: 60000 }],
  requests: [
    { label: 'Current program', bytes: (ctx) => msg.programRequest(ctx) },
    { label: 'All programs (internal)', bytes: (ctx) => msg.allProgramsRequest(ctx, 0) },
    { label: 'All combinations (internal)', bytes: (ctx) => msg.allCombisRequest(ctx, 0) },
    { label: 'Global and drum kits', bytes: (ctx) => msg.globalRequest(ctx, 0) },
    { label: 'All data (programs, combinations, global, sequences)', bytes: (ctx) => msg.allDataRequest(ctx, 0) },
    { label: 'All programs (card)', bytes: (ctx) => msg.allProgramsRequest(ctx, 1) },
    { label: 'All combinations (card)', bytes: (ctx) => msg.allCombisRequest(ctx, 1) },
  ],
  templates: [
    { label: 'Mode: program play', bytes: (ctx) => msg.mode(ctx, 2) },
    { label: 'Mode: combination play', bytes: (ctx) => msg.mode(ctx, 0) },
    { label: 'Mode request', bytes: (ctx) => msg.modeRequest(ctx) },
  ],
};

export const _test = { unit, programParams, combiParams, globalParams, PROGRAM, nameOf, needMode };
