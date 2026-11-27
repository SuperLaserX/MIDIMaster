// Roland V-Synth XT, VC-2 engine (Vocal Designer): the XT's VC-2 application (OS 2.02, "VAPP2").
// Roland SysEx, model 00 00 0D (the VC-2's own; it does not answer 00 53), 4-byte addresses,
// device ID 10h; identity family 0D 02. The map is built at run time from descriptors
// (8931C1B0 decodes addresses into 40-byte entries), so the rows follow the VC-2 MIDI
// Implementation (2005); every size and range checked on the unit:
//
//   01 00 00 00  setup (0Ch)     02 00 00 00  system (91h)     03 00 0n 00  sampling template n+1 (1Dh, n = 0-7)
//   10 00 00 00  temporary patch      20 00 00 00 + n x 00 01 00 00   user patch n (U001-U448)
//   patch: +00 00 00 common (14Bh: algorithm, name, tempo, beam/pad, tune, scale tune, MFX, chorus, reverb)
//          +00 03 00 carrier (43h)  +00 04 00 modulator (0Fh)  +00 05 00 vocoder (0Eh)
//
// Value names are the VC-2's screen strings (tools/roland/vc2_fw.py); effect parameters follow the
// effect type through the framework tables (roland-vsynthxt-vc2-fw.js).

import { readParam, readText } from '../../core/model/memmap.js';
import { dt1, parseDt1, readBlock, intToAddr, addrToInt, checksum } from '../../core/midi/roland.js';
import { E, FX, FX_BLOCKS, P } from './roland-vsynthxt-vc2-fw.js';
import { LISTS } from './roland-vsynthxt-vc2-lists.js';
import { fxSlot as vsFxSlot, readAndRememberWaves, rememberedWaves, select } from './roland-vsynthxt.js';
import { vc2Translator } from './roland-vsynthxt-vc2-translate.js';
import { INIT } from './roland-vsynthxt-vc2-init.js';
import { VC2_MAP, ALG_GROUPS, ALG_WAVES, ALG_INIT, ALG_INIT_DIFF, FACTORY_WAVES } from './roland-vsynthxt-vc2-map.js';
import { isP02, readP02, writeP02, p02FileName } from './roland-vsynthxt-vc2-p02.js';

export const MODEL = [0x00, 0x00, 0x0d];
export const A = (s) => addrToInt(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const hex4 = (a) => intToAddr(a).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const T = { P, E, FX, FX_BLOCKS };
export const fxSlot = (kind, n, t) => vsFxSlot(kind, n, t, T);
export const PATCH = A('10 00 00 00');
export const USER_PATCHES = 448;
export const userPatch = (n) => A('20 00 00 00') + n * A('00 01 00 00');
export const slotNo = (n) => `U${String(n + 1).padStart(3, '0')}`;

// ------------------------------------------------------------------ value displays
const opts = (list, first = 0) => ({ options: list.map((t, i) => [first + i, t]) });
const OFF_ON = opts(['OFF', 'ON']);
const signed = (c, step = 1, dec = 0) => ({ format: (v) => { const x = (v - c) * step; const t = x.toFixed(dec); return x > 0 ? `+${t}` : t; } });
const PAN = { format: (v) => (v < 64 ? `L${64 - v}` : v === 64 ? '0' : `${v - 64}R`) };
const KF = signed(64, 10);
const DEPTH = signed(64);
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const hzList = (list) => ({ options: list.map((f, i) => [i, `${f} Hz`]) });
const EQ_LOW = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000];
const EQ_HIGH = [2000, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const EQ_27 = [...EQ_LOW, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const CTRL = opts(LISTS.control); // 0-109, indexed by CC number (32 shows OFF)
const CTRL_NO_VK = { options: LISTS.control.map((t, i) => [i, t]).filter(([i]) => i <= 106 || i === 109) }; // without VELO, KEYF
const ASSIGN = opts(LISTS.assign); // 0-98
const VOICE_ASSIGN = opts(LISTS.control.slice(0, 96)); // OFF, CC01-CC95
const DB15 = { ...signed(15), unit: ' dB' };
const TIMES10 = { format: (v) => String(v * 10) };

// ------------------------------------------------------------------ rows: [offset, name, min, max, display, group, extra]
const name12 = Array.from({ length: 12 }, (_, i) => [1 + i, `Patch Name ${i + 1}`, 32, 127, { kind: 'char', hidden: true }, 'Name']);
const scale = NOTE.map((n, i) => [0x17 + 2 * i, `Scale Tune for ${n}`, 28, 228, { ...signed(128), unit: ' cent', nibbles: 2 }, 'Scale tune']);
const fxRows = (kind, at, typeName, typeList, levels, n) => [
  [at, typeName, 0, typeList.length - 1, opts(typeList), typeName.replace(/ Type$/, ''), { fxType: kind }],
  ...levels.map((l, i) => [at + 1 + i, l, 0, 127, {}, typeName.replace(/ Type$/, '')]),
  ...Array.from({ length: n }, (_, k) => [at + 1 + levels.length + 4 * k, `${typeName.replace(/ Type$/, '')} Parameter ${k + 1}`, 0, 0, {}, typeName.replace(/ Type$/, ''), { fx: kind, slot: k + 1, list: typeList }]),
];
const COMMON = [
  [0x00, 'Algorithm', 0, 11, opts(LISTS.algorithm), 'Common'],
  ...name12,
  [0x0d, 'Patch Tempo', 200, 2500, { format: (v) => (v / 10).toFixed(1), nibbles: 4 }, 'Common'],
  [0x11, 'Beam Type', 0, 4, opts(['OFF', 'TIME TRIP', 'TIME', 'PITCH', 'ASSIGNABLE']), 'Beam and pad'],
  [0x12, 'Pad Mode', 0, 1, opts(['X-Y', 'TIME-TRIP']), 'Beam and pad'],
  [0x13, 'Pad Hold', 0, 1, OFF_ON, 'Beam and pad'],
  [0x14, 'Patch Coarse Tune', 16, 112, signed(64), 'Tune'],
  [0x15, 'Patch Fine Tune', 14, 114, signed(64), 'Tune'],
  [0x16, 'Scale Tune Switch', 0, 1, OFF_ON, 'Scale tune'],
  ...scale,
  [0x2f, 'MFX Switch', 0, 1, OFF_ON, 'Effect switches'],
  [0x30, 'Chorus Switch', 0, 1, OFF_ON, 'Effect switches'],
  [0x31, 'Reverb Switch', 0, 1, OFF_ON, 'Effect switches'],
  ...fxRows('mfx', 0x32, 'MFX Type', LISTS.mfx, ['MFX Master Level', 'MFX Chorus Send Level', 'MFX Reverb Send Level'], 32),
  ...fxRows('chorus', 0xb6, 'Chorus Type', LISTS.chorus, ['Chorus Master Level', 'Chorus Reverb Send Level'], 12),
  ...fxRows('reverb', 0xe9, 'Reverb Type', LISTS.reverb.slice(0, 15), ['Reverb Master Level'], 24), // 0-14 (checked on the unit)
];
const oscHead = (n, at, two) => [
  ...(two ? [[at - 1, `OSC${n} Switch`, 0, 1, OFF_ON, `OSC ${n}`]] : []),
  [at, `OSC${n} Wave`, two ? 0 : 1, 127, { waves: true }, `OSC ${n}`],
  [at + 1, `OSC${n} Wave Offset`, 0, 15, {}, `OSC ${n}`],
  [at + 2, `OSC${n} Level`, 0, 127, {}, `OSC ${n}`],
  [at + 3, `OSC${n} Pan`, 0, 127, PAN, `OSC ${n}`],
  ...(two
    ? [[at + 4, `OSC${n} Pitch Coarse`, 16, 112, signed(64), `OSC ${n}`], [at + 5, `OSC${n} Pitch Fine`, 14, 114, signed(64), `OSC ${n}`], [at + 6, `OSC${n} Pitch KF`, 44, 84, KF, `OSC ${n}`]]
    : [[at + 4, `OSC${n} Pitch Octave Shift`, 60, 68, signed(64), `OSC ${n}`]]),
];
const oscTail = (n, at) => [
  [at, `OSC${n} Glide Depth`, 1, 127, DEPTH, `OSC ${n}`],
  [at + 1, `OSC${n} PW`, 1, 127, DEPTH, `OSC ${n}`],
  [at + 2, `OSC${n} SubOSC Switch`, 0, 3, opts(['OFF', '-2Oct', '-1Oct', '0Oct']), `OSC ${n}`],
  [at + 3, `OSC${n} Sub Level`, 0, 127, {}, `OSC ${n}`],
  [at + 4, `OSC${n} Detune`, 1, 127, DEPTH, `OSC ${n}`],
  [at + 5, `OSC${n} Formant Style`, 0, 10, opts(LISTS.formantStyle), `OSC ${n}`],
  [at + 6, `OSC${n} Formant`, 1, 127, DEPTH, `OSC ${n}`],
  [at + 7, `OSC${n} Formant KF`, 44, 84, KF, `OSC ${n}`],
  [at + 8, `OSC${n} Vibrato Depth`, 1, 127, DEPTH, `OSC ${n}`],
  [at + 9, `OSC${n} Vibrato Mod Depth`, 1, 127, DEPTH, `OSC ${n}`],
];
const CARRIER = [
  [0x00, 'Portamento Switch', 0, 1, OFF_ON, 'Voice'],
  [0x01, 'Portamento Mode', 0, 1, opts(['NORMAL', 'LEGATO']), 'Voice'],
  [0x02, 'Portamento Type', 0, 1, opts(['RATE', 'TIME']), 'Voice'],
  [0x03, 'Portamento Time', 0, 127, {}, 'Voice'],
  [0x04, 'MONO/POLY', 0, 1, opts(['MONO', 'POLY']), 'Voice'],
  [0x05, 'Legato Switch', 0, 1, OFF_ON, 'Voice'],
  [0x06, 'Bender Range', 0, 48, {}, 'Voice'],
  [0x07, 'Glide Time', 0, 127, {}, 'Voice'],
  [0x08, 'Vibrato Type', 0, 3, opts(LISTS.vibratoType), 'Vibrato'],
  [0x09, 'Vibrato Rate', 0, 127, {}, 'Vibrato'],
  [0x0a, 'Vibrato Control', 0, 109, CTRL, 'Vibrato'],
  ...oscHead(1, 0x0b, false), ...oscTail(1, 0x10),
  ...oscHead(2, 0x1b, true), ...oscTail(2, 0x22),
  [0x2c, 'Growl Switch', 0, 1, OFF_ON, 'Growl'],
  [0x2d, 'Growl Intensity', 0, 127, {}, 'Growl'],
  [0x2e, 'Growl Speed', 0, 127, {}, 'Growl'],
  [0x2f, 'Growl Control', 0, 109, CTRL, 'Growl'],
  [0x30, 'Growl Intensity Mod Depth', 1, 127, DEPTH, 'Growl'],
  [0x31, 'Growl Speed Mod Depth', 1, 127, DEPTH, 'Growl'],
  ...[1, 2].flatMap((k) => [
    [0x32 + 3 * (k - 1), `EQ${k} Freq`, 0, 26, hzList(EQ_27), 'EQ'],
    [0x33 + 3 * (k - 1), `EQ${k} Q`, 0, 5, opts(['0.5', '0.7', '1.0', '2.0', '4.0', '8.0']), 'EQ'],
    [0x34 + 3 * (k - 1), `EQ${k} Gain`, 0, 30, DB15, 'EQ'],
  ]),
  [0x38, 'TVA Level', 0, 127, {}, 'TVA'],
  [0x39, 'TVA Level KF', 44, 84, KF, 'TVA'],
  [0x3a, 'TVA Level Velo Sens', 1, 127, DEPTH, 'TVA'],
  [0x3b, 'TVA Attack Time', 0, 127, {}, 'TVA'],
  [0x3c, 'TVA Attack Time Velo Sens', 1, 127, DEPTH, 'TVA'],
  [0x3d, 'TVA Release Time', 0, 127, {}, 'TVA'],
  [0x3e, 'TVA Pan', 0, 127, PAN, 'TVA'],
  [0x3f, 'TVA Pan KF', 44, 84, KF, 'TVA'],
  [0x40, 'TVA Level/Pan Control', 0, 109, CTRL, 'TVA'],
  [0x41, 'TVA Level Mod Depth', 1, 127, DEPTH, 'TVA'],
  [0x42, 'TVA Pan Mod Depth', 1, 127, DEPTH, 'TVA'],
];
const MODULATOR = [
  [0x00, 'KeyMode', 0, 1, opts(['NORMAL', 'ALWAYS-ON']), 'Modulator'],
  [0x01, 'OSC Wave', 0, 127, { waves: true }, 'Modulator'],
  [0x02, 'OSC Pitch', 1, 127, DEPTH, 'Modulator'],
  [0x03, 'OSC Time', 1, 127, DEPTH, 'Modulator'],
  [0x04, 'OSC Formant', 1, 127, DEPTH, 'Modulator'],
  [0x05, 'OSC Tempo Sync Sw', 0, 1, OFF_ON, 'Modulator'],
  [0x06, 'TVA Level', 0, 127, {}, 'Modulator'],
  ...[['OSC Pitch', 0x07], ['OSC Time', 0x09], ['OSC Formant', 0x0b], ['TVA Level', 0x0d]].flatMap(([n, at]) => [
    [at, `${n} Control`, 0, 109, CTRL_NO_VK, 'Modulator control'],
    [at + 1, `${n} Mod Depth`, 1, 127, DEPTH, 'Modulator control'],
  ]),
];
const VOCODER = [
  [0x00, 'Natural Level', 0, 127, {}, 'Vocoder'],
  [0x01, 'Natural Reverb Send Level', 0, 127, {}, 'Vocoder'],
  [0x02, 'Vocoder Level', 0, 127, {}, 'Vocoder'],
  [0x03, 'Level Control', 0, 109, CTRL, 'Vocoder'],
  [0x04, 'Natural Level Mod Depth', 1, 127, DEPTH, 'Vocoder'],
  [0x05, 'Vocoder Level Mod Depth', 1, 127, DEPTH, 'Vocoder'],
  [0x06, 'Attack', 0, 100, {}, 'Vocoder'],
  [0x07, 'Release', 0, 100, {}, 'Vocoder'],
  [0x08, 'AutoNoteOn', 0, 1, OFF_ON, 'Vocoder'],
  [0x09, 'Hold Dump Time', 0, 127, {}, 'Vocoder'],
  [0x0a, 'Unvoice Detect', 1, 50, {}, 'Vocoder'],
  [0x0b, 'Unvoice Level', 0, 127, {}, 'Vocoder'],
  [0x0c, 'Formant Type', 0, 15, opts(LISTS.formantType), 'Vocoder'],
  [0x0d, 'Tone Control', 0, 127, {}, 'Vocoder'],
];
const SETUP = [
  [0x00, 'Part 1 Bank Select MSB (CC#0)', 0, 127, {}, 'Setup'],
  [0x01, 'Part 1 Bank Select LSB (CC#32)', 0, 127, {}, 'Setup'],
  [0x02, 'Part 1 Program Number (PC)', 0, 127, {}, 'Setup'],
  [0x03, 'Transpose Switch', 0, 1, OFF_ON, 'Setup'],
  [0x04, 'Transpose Value', 59, 70, signed(64), 'Setup'],
  [0x05, 'Octave Shift', 61, 67, signed(64), 'Setup'],
  [0x06, 'Beep Switch', 0, 1, OFF_ON, 'Setup'],
  [0x07, 'Sampling Template', 1, 8, {}, 'Setup'],
  [0x08, 'Patch Palette Bank', 0, 7, {}, 'Setup'],
  [0x09, 'Patch Palette Number', 0, 7, {}, 'Setup'],
  [0x0a, 'Chord Memory Switch', 0, 1, OFF_ON, 'Setup'],
  [0x0b, 'Chord Memory Hold', 0, 1, OFF_ON, 'Setup'],
];
const ASSIGNS = ['Beam TIME TRIP Assign L', 'Beam TIME TRIP Assign R', 'Beam TIME Assign L', 'Beam TIME Assign R', 'Beam PITCH Assign L', 'Beam PITCH Assign R',
  'Beam ASSIGNABLE Assign L', 'Beam ASSIGNABLE Assign R', 'Pad Assign X', 'Pad Assign Y', 'Trip Assign X', 'Trip Assign Y', 'Knob1 Assign', 'Knob2 Assign'];
const channels = (extra) => ({ options: [...Array.from({ length: 16 }, (_, i) => [i, String(i + 1)]), ...extra.map((t, i) => [16 + i, t])] });
const SYSTEM = [
  [0x00, 'Master Tune', 24, 2024, { format: (v) => `${(440 * 2 ** ((v - 1024) / 1200)).toFixed(1)} Hz`, nibbles: 4 }, 'System'],
  [0x04, 'Master Key Shift', 40, 88, signed(64), 'System'],
  [0x05, 'Master Level', 0, 127, {}, 'System'],
  [0x06, 'Clock Source', 0, 1, opts(['INT', 'MIDI']), 'System'],
  [0x07, 'Clock Out', 0, 1, OFF_ON, 'System'],
  [0x08, 'Receive Program Change', 0, 1, OFF_ON, 'MIDI'],
  [0x09, 'Receive Bank Select', 0, 1, OFF_ON, 'MIDI'],
  [0x0a, 'Receive Channel', 0, 16, channels(['OFF']), 'MIDI'],
  [0x0b, 'Volume Expression Level Control', 0, 1, OFF_ON, 'MIDI'],
  [0x0c, 'Transmit Program Change', 0, 1, OFF_ON, 'MIDI'],
  [0x0d, 'Transmit Bank Select', 0, 1, OFF_ON, 'MIDI'],
  [0x0e, 'Keyboard Velocity', 0, 127, { format: (v) => (v ? String(v) : 'REAL') }, 'Controllers'],
  [0x0f, 'Keyboard Sens', 0, 2, opts(['LIGHT', 'MEDIUM', 'HEAVY']), 'Controllers'],
  [0x10, 'Aftertouch Sens', 0, 20, TIMES10, 'Controllers'],
  [0x11, 'Patch Transmit Channel', 0, 17, channels(['RXCH', 'OFF']), 'MIDI'],
  [0x12, 'Beam Sens L', 0, 20, TIMES10, 'Controllers'],
  [0x13, 'Beam Sens R', 0, 20, TIMES10, 'Controllers'],
  ...ASSIGNS.map((n, i) => [0x14 + i, n, 0, 98, ASSIGN, 'Controllers']),
  [0x22, 'Hold Pedal Polarity', 0, 1, opts(['STANDARD', 'REVERSE']), 'Controllers'],
  [0x23, 'Pedal 1 Assign', 0, 98, ASSIGN, 'Controllers'],
  [0x24, 'Pedal 1 Polarity', 0, 1, opts(['STANDARD', 'REVERSE']), 'Controllers'],
  [0x25, 'Pedal 2 Assign', 0, 98, ASSIGN, 'Controllers'],
  [0x26, 'Pedal 2 Polarity', 0, 1, opts(['STANDARD', 'REVERSE']), 'Controllers'],
  [0x27, 'Voice Assign', 0, 95, VOICE_ASSIGN, 'Controllers'],
  [0x28, 'Local Switch', 0, 1, OFF_ON, 'MIDI'],
  [0x29, 'Transmit Active Sensing', 0, 1, OFF_ON, 'MIDI'],
  [0x2a, 'EQ Low Freq', 0, 19, hzList(EQ_LOW), 'EQ'],
  [0x2b, 'EQ Low Gain', 0, 30, DB15, 'EQ'],
  [0x2c, 'EQ High Freq', 0, 8, hzList(EQ_HIGH), 'EQ'],
  [0x2d, 'EQ High Gain', 0, 30, DB15, 'EQ'],
  [0x2e, 'EQ Total Gain', 0, 30, DB15, 'EQ'],
  [0x2f, 'EQ Switch', 0, 1, OFF_ON, 'EQ'],
  [0x30, 'Chord Memory Grid', 0, 5, opts(['Dotted 8th', '8th', 'Dotted 16th', '16th', '32th', '64th']), 'Chord memory'],
  ...NOTE.flatMap((n, i) => [1, 2, 3, 4].map((k) => [0x31 + 8 * i + 2 * (k - 1), `Chord Memory ${n} Key ${k}`, 0, 128,
    { format: (v) => (v === 128 ? 'OFF' : `${NOTE[v % 12]}${Math.floor(v / 12) - 1}`), nibbles: 2 }, 'Chord memory'])),
];
const TEMPLATE = [
  ...Array.from({ length: 8 }, (_, i) => [i, `Name ${i + 1}`, 32, 127, { kind: 'char', hidden: true }, 'Name']),
  [0x08, 'EQ Low Freq', 0, 19, hzList(EQ_LOW), 'EQ'],
  [0x09, 'EQ Low Gain', 0, 30, DB15, 'EQ'],
  [0x0a, 'EQ Mid Freq', 0, 26, hzList(EQ_27), 'EQ'],
  [0x0b, 'EQ Mid Q', 0, 20, opts(['0.3', '0.4', '0.6', '0.8', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '5.0', '6.0', '7.0', '8.0', '10.0', '12.0', '14.0', '16.0', '18.0', '20.0']), 'EQ'],
  [0x0c, 'EQ Mid Gain', 0, 30, DB15, 'EQ'],
  [0x0d, 'EQ High Freq', 0, 8, hzList(EQ_HIGH), 'EQ'],
  [0x0e, 'EQ High Gain', 0, 30, DB15, 'EQ'],
  [0x0f, 'PreEFX Type', 0, 3, opts(['OFF', 'NoiseSup+Comp', 'NoiseSup+Limitter', 'NoiseSup']), 'Pre-effect'],
  [0x10, 'Output Level', 0, 127, {}, 'Pre-effect'],
  [0x11, 'NoiseSup Thres', 4, 64, { ...signed(64), unit: ' dB' }, 'Pre-effect'],
  [0x12, 'NoiseSup Release', 0, 127, {}, 'Pre-effect'],
  [0x13, 'NoiseSup Level', 0, 127, {}, 'Pre-effect'],
  [0x14, 'Comp Gain', 0, 127, {}, 'Pre-effect'],
  [0x15, 'Comp Attack', 0, 127, {}, 'Pre-effect'],
  [0x16, 'Comp Release', 0, 127, {}, 'Pre-effect'],
  [0x17, 'Comp Level', 0, 127, {}, 'Pre-effect'],
  [0x18, 'Limit Thres', 24, 64, { ...signed(64), unit: ' dB' }, 'Pre-effect'],
  [0x19, 'Limit Attack', 0, 127, {}, 'Pre-effect'],
  [0x1a, 'Limit Release', 0, 127, {}, 'Pre-effect'],
  [0x1b, 'Limit Ratio', 0, 3, opts(['2:1', '4:1', '16:1', 'inf:1']), 'Pre-effect'],
  [0x1c, 'Limit Level', 0, 127, {}, 'Pre-effect'],
];

// ------------------------------------------------------------------ building objects
/** Wave number -> name read from the VC-2 (model 00 24); shown next to the OSC wave numbers. */
export const VC2_WAVES = new Map(FACTORY_WAVES); // the factory names until Read wave names reads the unit's

/** blocks: [{key, at, size, rows, section}] -> {size, params, parts} */
function build(blocks) {
  const params = [];
  const parts = [];
  let offset = 0;
  for (const b of blocks) {
    parts.push({ key: b.key, at: b.at, offset, size: b.size });
    let typeParam = null;
    for (const [off, name, min, max, disp, group, extra = {}] of b.rows) {
      const { nibbles, unit, waves, ...shown } = disp;
      const p = { key: `${b.key}_${off.toString(16)}`, block: b.key, label: name, name, section: b.section, group, offset: offset + off, at: b.at + off, min, max, ...shown };
      if (nibbles) p.nibbles = nibbles;
      if (unit && p.format) { const f = p.format; p.format = (v) => `${f(v)}${unit}`; }
      if (waves) p.format = (v) => (VC2_WAVES.has(v) ? `${v} ${VC2_WAVES.get(v)}` : String(v));
      if (extra.fxType) typeParam = p;
      if (extra.fx) {
        const tp = typeParam;
        const kind = extra.fx;
        const n = extra.slot;
        Object.assign(p, { nibbles: 4, bias: 32768, min: -20000, max: 20000, fxSlot: n, fxKind: kind });
        const list = extra.list;
        p.dynamic = (data) => {
          const t = data ? readParam(data, tp) : 0;
          const s = fxSlot(kind, n, t);
          // the effect's name as the VC-2 shows it (the framework tables name it in capitals)
          if (!s.hidden && list[t]) s.label = s.label.replace(/^[^:]*:/, `${list[t]}:`);
          return s;
        };
      }
      params.push(p);
    }
    offset += b.size;
  }
  return { size: offset, params, parts };
}

export const patchBuilt = build([
  { key: 'c', at: 0, size: 0x14b, rows: COMMON, section: 'common' },
  { key: 'ca', at: A('00 03 00'), size: 0x43, rows: CARRIER, section: 'carrier' },
  { key: 'mo', at: A('00 04 00'), size: 0x0f, rows: MODULATOR, section: 'modulator' },
  { key: 'vo', at: A('00 05 00'), size: 0x0e, rows: VOCODER, section: 'vocoder' },
]);
for (const p of patchBuilt.params) if (p.block === 'c' && /^(MFX|Chorus|Reverb)/.test(p.name) && !/Switch$/.test(p.name)) p.section = 'fx';

// ------------------------------------------------------------------ algorithms
// Each parameter belongs to an algorithm group (VC2_MAP, from the VC-2's address descriptors); an
// algorithm takes group 0 and its ALG_GROUPS, and the VC-2 silently refuses the rest, so the editor
// hides them. Oscillator waves take the numbers in ALG_WAVES. Choosing an algorithm makes the VC-2
// load that algorithm's INIT PATCH (every value; read on the unit), and the editor does the same.
/** The patch the VC-2 holds after `alg` is chosen. */
export function algorithmInit(alg) {
  const d = Uint8Array.from(ALG_INIT);
  for (const [i, v] of ALG_INIT_DIFF[alg] || []) d[i] = v;
  return d;
}
{
  const ps = patchBuilt.params;
  const algP = ps.find((p) => p.key === 'c_0');
  const algOf = (d) => (d ? Math.min(11, d[algP.offset]) : 0);
  algP.after = (d, v) => {
    d.set(algorithmInit(v));
    return `The VC-2 loads the INIT PATCH of ${LISTS.algorithm[v]} when the algorithm changes; the editor shows it.`;
  };
  algP.help = 'Choosing an algorithm makes the VC-2 load its INIT PATCH (every value). Parameters the algorithm does not use are hidden.';
  const WAVE_KEY = { ca_b: 'osc1', ca_1b: 'osc2', mo_1: 'mod' };
  for (const p of ps) {
    const m = VC2_MAP[p.key];
    if (!m) continue;
    p.algGroup = m.group;
    if (m.group === 0 && !WAVE_KEY[p.key]) continue;
    const own = p.dynamic;
    p.dynamic = (d, ctx) => {
      const alg = algOf(d);
      if (m.group && !ALG_GROUPS[alg].includes(m.group)) return { hidden: true };
      const r = own ? own(d, ctx) : {};
      const w = WAVE_KEY[p.key] && ALG_WAVES[alg][WAVE_KEY[p.key]];
      if (WAVE_KEY[p.key] && !w) return { hidden: true };
      if (w && w[0] === w[1]) return { ...r, readOnly: true, help: `${LISTS.algorithm[alg]} has no ${p.label.replace(/ Wave$/, '')} wave` };
      if (!w) return r;
      const help = `${LISTS.algorithm[alg]} takes waves ${w[0]}-${w[1]}`;
      // a list of the wave names when they are known for the whole range, else a number
      const named = Array.from({ length: w[1] - w[0] + 1 }, (_, i) => w[0] + i).filter((n) => n === 0 || VC2_WAVES.has(n));
      if (named.length === w[1] - w[0] + 1) return { ...r, help, options: named.map((n) => [n, n === 0 ? 'OFF' : `${n} ${VC2_WAVES.get(n)}`]) };
      return { ...r, min: w[0], max: w[1], help };
      return r;
    };
  }
}
export const sysBuilt = build([
  { key: 'su', at: A('01 00 00 00'), size: 0x0c, rows: SETUP, section: 'setup' },
  { key: 'sy', at: A('02 00 00 00'), size: 0x91, rows: SYSTEM, section: 'system' },
  ...Array.from({ length: 8 }, (_, n) => ({ key: `t${n}`, at: A('03 00 00 00') + n * A('00 00 01 00'), size: 0x1d, rows: TEMPLATE, section: `t${n}` })),
]);
for (const p of sysBuilt.params) if (p.group === 'Chord memory') p.section = 'chord';
// Setup's bank select MSB/LSB and program number are the patch being played: shown as its name
// (read only); patches are chosen in the Patch page's list.
{
  const ps = sysBuilt.params;
  const msb = ps.find((p) => p.name === 'Part 1 Bank Select MSB (CC#0)');
  if (msb) {
    for (const p of ps.filter((x) => x.block === 'su' && /^Part 1 (Bank Select|Program Number)/.test(x.name))) p.hidden = true;
    const o = msb.offset;
    const cur = {
      key: 'su_patch', block: 'su', label: 'Current patch', name: 'Current patch', section: 'setup', group: msb.group,
      offset: o, at: msb.at, size: 3, min: 0, max: 127 * 16384 + 127 * 128 + 127, readOnly: true,
      help: 'The patch the VC-2 plays (bank select and program number in its setup). Choose patches in the list on the Patch page.',
      get: (d) => d[o] * 16384 + d[o + 1] * 128 + d[o + 2],
      set: (d, v) => { d[o] = (v >> 14) & 127; d[o + 1] = (v >> 7) & 127; d[o + 2] = v & 127; },
      dynamic: (d, ctx) => {
        const v = d ? cur.get(d) : 87 * 16384;
        const msbV = v >> 14, lsb = (v >> 7) & 127, pc = v & 127;
        const name = lsb >= 1 && lsb <= 4 ? ctx?.names?.patch?.get(`${lsb - 1}:${pc}`) : null;
        const label = msbV !== 87 ? `Bank ${msbV}/${lsb}, program ${pc + 1}`
          : lsb === 0 ? `P${String(pc + 1).padStart(3, '0')} (preset)` : `${slotNo((lsb - 1) * 128 + pc)}${name ? ` ${name}` : ''}`;
        return { options: [[v, label]] };
      },
    };
    ps.splice(ps.indexOf(msb), 0, cur);
  }
}

export const pOf = (block, name) => {
  const p = [...patchBuilt.params, ...sysBuilt.params].find((x) => x.block === block && x.name === name);
  if (!p) throw new Error(`VC-2 parameter ${block} ${name} not found`);
  return p;
};

/** A neutral value per parameter: centre of bipolar ranges, the lowest choice, levels 100. */
function defaults(built) {
  const d = new Uint8Array(built.size);
  for (const p of built.params) {
    let v = p.min;
    if (p.fxSlot) v = 0;
    else if (p.format && !p.options && p.min <= 64 && p.max >= 64 && p.max < 200) v = 64;
    else if (p.max === 127 && !p.options && !p.format) v = 100;
    if (p.name === 'Patch Tempo') v = 1200;
    if (p.name === 'Master Tune') v = 1024;
    if (/^Scale Tune for/.test(p.name)) v = 128;
    if (/^Chord Memory .+ Key \d$/.test(p.name)) v = 128;
    if (p.kind === 'char') v = 32;
    v += p.bias || 0;
    if (p.nibbles) { for (let i = p.nibbles - 1; i >= 0; i--) { d[p.offset + i] = v & 15; v >>>= 4; } } else d[p.offset] = v & 127;
  }
  return d;
}
export const nameOf = (d) => readText(d, 1, 12);
export const setName = (d, name) => { for (let i = 0; i < 12; i++) d[1 + i] = Math.max(32, Math.min(127, String(name ?? '').charCodeAt(i) || 32)); };
/** The factory patch the VC-2 accepts in full (roland-vsynthxt-vc2-init.js), named INIT PATCH. */
export const patchDefaults = () => Uint8Array.from(INIT);
/** Set the parameters of effect block `kind` to the defaults of its current type. */
export function fxDefaults(d, kind) {
  for (const p of patchBuilt.params) {
    if (p.fxKind !== kind) continue;
    const s = p.dynamic(d);
    let v = (s.hidden ? 0 : s.default ?? 0) + p.bias;
    for (let i = p.nibbles - 1; i >= 0; i--) { d[p.offset + i] = v & 15; v >>>= 4; }
  }
}

// ------------------------------------------------------------------ SysEx
const parse = (raw) => parseDt1(raw, MODEL);
export function rq1Msg(dev, addr, size) {
  const body = [...intToAddr(addr), ...intToAddr(size)];
  return [0xf0, 0x41, dev & 0x7f, ...MODEL, 0x11, ...body, checksum(body), 0xf7];
}
/**
 * DT1 messages of up to 128 bytes for each block, cut only between parameters: the VC-2 ignores a
 * value of several nibbles that arrives split over two messages (checked: Reverb Parameter 6,
 * bytes FFh-102h of the common block, was dropped when cut at 100h).
 */
export function writeParts(built, data, dev, base, max = 128) {
  const out = [];
  for (const part of built.parts) {
    const spans = built.params.filter((p) => p.nibbles > 1 && p.offset >= part.offset && p.offset < part.offset + part.size);
    let start = 0;
    while (start < part.size) {
      let end = Math.min(part.size, start + max);
      while (end < part.size && spans.some((p) => p.offset - part.offset < end && p.offset - part.offset + p.nibbles > end)) end--;
      out.push(dt1(MODEL, dev, intToAddr(base + part.at + start), Array.from(data.slice(part.offset + start, part.offset + end))));
      start = end;
    }
  }
  return out;
}

/** Bytes of `built` at `base` from DT1 messages (a reply packet may run across blocks: the VC-2 sends up to 255 bytes). */
function assemble(built, base, msgs) {
  const d = defaults(built);
  let have = 0;
  for (const m of msgs) {
    const p = parse(m);
    if (!p?.ok) continue;
    const a = addrToInt(p.addr);
    for (const part of built.parts) {
      for (let i = 0; i < p.data.length; i++) {
        const k = a + i - (base + part.at);
        if (k >= 0 && k < part.size) { d[part.offset + k] = p.data[i]; have++; }
      }
    }
  }
  return { data: d, have };
}

async function readAll(api, built, base, size, onProgress) {
  const msgs = [];
  let have = 0;
  try {
    await api.g.client.request(Uint8Array.from(rq1Msg(api.ctx.deviceId, base, size)), {
      collect: (m, r) => {
        const raw = r ?? m.raw;
        if (!parse(raw)?.ok) return false;
        msgs.push(raw);
        have = assemble(built, base, msgs).have;
        onProgress?.(have, built.size);
        return true;
      },
      complete: () => have >= built.size, quiet: 1500, resolveOnQuiet: true, timeout: 4000,
    });
  } catch { /* block by block below */ }
  const r = assemble(built, base, msgs);
  if (r.have >= built.size) return r.data;
  for (const part of built.parts) r.data.set(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(base + part.at), part.size), part.offset);
  return r.data;
}

/** The patch an address belongs to: a temporary area or user patch n. */
function patchBase(a) {
  if ((a >= PATCH && a < A('11 00 00 00')) || (a >= userPatch(0) && a < userPatch(USER_PATCHES))) return a - (a % A('00 01 00 00'));
  return null;
}

function fromSyx(built, baseOf) {
  return (msgs) => {
    const counts = new Map();
    for (const m of msgs) {
      const p = parse(m);
      if (!p?.ok) continue;
      const b = baseOf(addrToInt(p.addr));
      if (b !== null) counts.set(b, (counts.get(b) || 0) + p.data.length);
    }
    if (!counts.size) return null;
    const base = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    return assemble(built, base, msgs).data;
  };
}

function receiver(built, base) {
  return (raw, data) => {
    const p = parse(raw);
    if (!p?.ok) return null;
    const a = addrToInt(p.addr);
    let d = null;
    for (const part of built.parts) {
      for (let i = 0; i < p.data.length; i++) {
        const k = a + i - (base + part.at);
        if (k >= 0 && k < part.size) { d ??= Uint8Array.from(data); d[part.offset + k] = p.data[i]; }
      }
    }
    return d;
  };
}

for (const p of patchBuilt.params) p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(PATCH + p.at), Array.from(data.slice(p.offset, p.offset + (p.nibbles || 1))));
for (const p of sysBuilt.params) p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(p.at), Array.from(data.slice(p.offset, p.offset + (p.nibbles || 1))));

function libraryItems(msgs) {
  const items = [];
  const byKey = new Map();
  const add = (key, label, object, m) => {
    let it = byKey.get(key);
    if (!it) { it = { key, label, object, name: '', msgs: [] }; byKey.set(key, it); items.push(it); }
    it.msgs.push(m);
    return it;
  };
  for (const m of msgs) {
    const p = parse(m);
    if (!p?.ok) { add('other', 'Other VC-2 messages', null, m); continue; }
    const a = addrToInt(p.addr);
    if (a < PATCH) { add('sys', 'System', 'system', m); continue; }
    const base = patchBase(a);
    if (base === null) { add(`x${a >> 21}`, `Data at ${hex4(a & ~0x1fffff)}`, null, m); continue; }
    const it = base < userPatch(0)
      ? add(`tp${(base - PATCH) >> 14}`, base === PATCH ? 'Temporary patch' : `Temporary area ${((base - PATCH) >> 14) + 1}`, 'patch', m)
      : add(`up${(base - userPatch(0)) >> 14}`, `User patch ${slotNo((base - userPatch(0)) >> 14)}`, 'patch', m);
    if (a === base && p.data.length >= 13) it.name = readText(p.data, 1, 12);
  }
  return items;
}

function describe(raw) {
  if (raw[1] !== 0x41 || raw[3] !== 0 || raw[4] !== 0 || raw[5] !== 0x0d) return null;
  const cmd = raw[6];
  const a = addrToInt(Array.from(raw.slice(7, 11)));
  const where = a < A('02 00 00 00') ? 'setup' : a < A('03 00 00 00') ? 'system' : a < PATCH ? 'sampling template'
    : a < A('11 00 00 00') ? 'temporary patch' : a < userPatch(USER_PATCHES) ? `user patch ${slotNo((a - userPatch(0)) >> 14)}` : '';
  if (cmd === 0x12) return `VC-2 DT1 ${hex4(a)} ${where} (${raw.length - 13} bytes)`;
  if (cmd === 0x11) return `VC-2 RQ1 ${hex4(a)} ${where} size ${addrToInt(Array.from(raw.slice(11, 15)))}`;
  return null;
}

const TR = vc2Translator({ pOf, defaults: patchDefaults, nameOf, LISTS, waves: VC2_WAVES, fxDefaults });
const BANKS = [0, 1, 2, 3].map((b) => [b, `User ${slotNo(b * 128)}-${slotNo(Math.min(USER_PATCHES, b * 128 + 128) - 1)}`]);
const bankCount = (bank) => Math.min(128, USER_PATCHES - bank * 128);
const rxChannel = (ctx) => {
  const s = ctx.data?.system;
  const v = s ? readParam(s, pOf('sy', 'Receive Channel')) : null;
  return v !== null && v < 16 ? v : ctx.channel ?? 0;
};
const waveNamesAction = {
  label: 'Read wave names',
  title: 'Read the names of the VC-2 waves loaded on the XT (read only, model 00 24; a few seconds); they are remembered for next time',
  run: (api) => readAndRememberWaves(api, VC2_WAVES, 'vc2-waves'),
};

// ------------------------------------------------------------------ patch files (.p02, USB storage)
// The XT keeps the VC-2 user patches as V:\Internal.vc2\Patch\nnn <name>.p02 (roland-vsynthxt-vc2-p02.js).
const p02Actions = [
  {
    label: 'Open .p02',
    title: 'Load a VC-2 patch file (from the XT\'s drive in USB storage mode) into the editor',
    run: async (api) => {
      const { pickFiles } = await import('../../core/ui/dom.js');
      const [file] = await pickFiles('.p02', false);
      if (!file) return;
      const d = readP02(new Uint8Array(await file.arrayBuffer()), patchBuilt.params, patchDefaults());
      if (!d) { api.toast('Not a VC-2 patch file (.p02).', 'warn'); return; }
      api.setData(d);
      api.toast('Loaded into the editor. Use Send to VC-2 to hear it.', 'info');
    },
  },
  {
    label: 'Save .p02',
    title: 'Save the patch as a VC-2 patch file, named for a user patch, to copy onto the XT\'s drive',
    run: async (api) => {
      const r = await api.form('Save as a .p02 file', [{ key: 'n', label: `User patch number (1-${USER_PATCHES})`, type: 'number', value: 1, min: 1, max: USER_PATCHES }], 'Save',
        'The XT reads the VC-2 user patches from V:\\Internal.vc2\\Patch\\ in USB storage mode, as "nnn Name.p02". Replace the file of the same number there.');
      if (!r) return;
      const n = Math.max(1, Math.min(USER_PATCHES, Math.round(r.n) || 1));
      const { downloadBlob } = await import('../../core/ui/dom.js');
      downloadBlob(writeP02(api.data, patchBuilt.params), p02FileName(n, nameOf(api.data)));
    },
  },
];

export default {
  coverage: 'The VC-2 (Vocal Designer) engine of the V-Synth XT OS 2.02, by its own model 00 00 0D: setup, system (controllers, EQ, chord memory) and the 8 sampling templates (mic EQ and pre-effect); the patch (algorithm, tempo, beam/pad, tune, scale tune, MFX/chorus/reverb with effect parameters named per type, carrier oscillators with formant, growl, EQ and TVA, modulator, vocoder) with the VC-2\'s screen names and value lists, shown per algorithm (the groups and wave numbers each algorithm takes; choosing one loads its INIT PATCH, as on the unit); 448 user patches; .p02 patch files from the XT drive (USB storage) open, save and import; wave names read from the unit.',
  sysex: { manufacturer: [0x41], model: MODEL, deviceIdDefault: 0x10 },
  minGap: 20,
  // wave names remembered from the last Read wave names (reading them again takes a few seconds)
  connectTasks: [{ label: 'Remembered wave names', run: (api) => rememberedWaves(api, VC2_WAVES, 'vc2-waves') }],
  describe,
  recognise: (raw) => !!parse(raw)?.ok,
  isOwn: (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === 0 && raw[4] === 0 && raw[5] === 0x0d,
  isRequest: (raw) => raw?.[1] === 0x41 && raw[3] === 0 && raw[4] === 0 && raw[5] === 0x0d && raw[6] === 0x11,
  libraryItems,
  // VC-2 patch files (.p02) from the XT's drive: one patch each (also inside a drive image)
  readFile: (name, bytes) => {
    if (!isP02(bytes)) return null;
    return [{ object: 'patch', data: readP02(bytes, patchBuilt.params, patchDefaults()), label: String(name).split(/[\\/]/).pop().replace(/\.p02$/i, '') }];
  },
  fullDump:['System', 'Temporary patch', ...BANKS.map(([, l]) => `User patches ${l.slice(5)}`)],
  requests: [
    { label: 'System', bytes: (ctx) => sysBuilt.parts.map((p) => rq1Msg(ctx.deviceId, p.at, p.size)) },
    { label: 'Temporary patch', bytes: (ctx) => rq1Msg(ctx.deviceId, PATCH, A('00 01 00 00')), quiet: 2500 },
    // one request per patch: an RQ1 over several patches does not answer them
    ...BANKS.map(([b, l]) => ({ label: `User patches ${l.slice(5)}`, bytes: (ctx) => Array.from({ length: bankCount(b) }, (_, i) => rq1Msg(ctx.deviceId, userPatch(b * 128 + i), A('00 01 00 00'))), quiet: 2500 })),
  ],
  objects: [
    {
      key: 'system', page: 'System', icon: '⚙', label: 'System', size: sysBuilt.size, autoLoad: true,
      init: () => defaults(sysBuilt),
      fetch: async (api) => {
        const d = defaults(sysBuilt);
        for (const part of sysBuilt.parts) d.set(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(part.at), part.size), part.offset);
        return d;
      },
      params: sysBuilt.params,
      receive: receiver(sysBuilt, 0),
      sections: [{ key: 'setup', label: 'Setup' }, { key: 'system', label: 'System' }, { key: 'chord', label: 'Chord memory' },
        ...Array.from({ length: 8 }, (_, n) => ({ key: `t${n}`, label: `Template ${n + 1}` }))],
      cols: 3,
      note: 'Device ID, Tx Edit, Receive SysEx, output gain, digital output, USB mode and USB MIDI thru have no SysEx address; set them on the XT. Sampling templates hold the mic input EQ and pre-effect.',
      sendAll: { label: 'Send to VC-2', build: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId, 0) },
      toSyx: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId, 0).flat(),
      fromSyx: fromSyx(sysBuilt, (a) => (a < PATCH ? 0 : null)),
    },
    {
      key: 'patch', page: 'Patch', icon: '◆', label: 'Patch', size: patchBuilt.size, autoLoad: true,
      init: patchDefaults,
      fetch: (api) => readAll(api, patchBuilt, PATCH, A('00 01 00 00'), (n, t) => api.g?.setBusy?.(1, `Reading the patch ${n}/${t}`)),
      params: patchBuilt.params,
      receive: receiver(patchBuilt, PATCH),
      sections: [{ key: 'common', label: 'Common' }, { key: 'fx', label: 'Effects' }, { key: 'carrier', label: 'Carrier' }, { key: 'modulator', label: 'Modulator' }, { key: 'vocoder', label: 'Vocoder' }],
      emptySection: (section, d) => `${LISTS.algorithm[Math.min(11, d?.[0] ?? 0)]} does not use the ${section}: choose another algorithm on the Common page.`,
      cols: 3,
      name: nameOf,
      setName,
      toCommon: (d) => TR.patchToCommon(d),
      fromCommon: (c, base) => TR.patchFromCommon(c, base),
      actions: [waveNamesAction, ...p02Actions],
      note: `Edits the VC-2 temporary patch (${hex4(PATCH)}); changes are heard at once. The XT must be in VC-2 mode. The algorithm decides which parameters and wave numbers the VC-2 takes: the others are hidden. Store writes into a user patch.`,
      sendAll: { label: 'Send to VC-2', title: 'Write the whole patch to the temporary patch', build: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId, PATCH) },
      toSyx: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId, PATCH).flat(),
      fromSyx: fromSyx(patchBuilt, patchBase),
      slots: {
        label: 'Patches',
        banks: BANKS,
        count: (bank) => bankCount(bank), // U001-U448: the last bank holds 64
        slotLabel: (bank, i) => slotNo(bank * 128 + i),
        name: nameOf,
        // bank select 87/0 is the preset bank P001-P128; the user patches are 87/1-4 (checked: 87/4 + PC 63 = U448)
        recall: (bank, i, ctx) => select(rxChannel(ctx), 87, bank + 1, i),
        fetch: (api, bank, i) => readAll(api, patchBuilt, userPatch(bank * 128 + i), A('00 01 00 00')),
        fetchName: async (api, bank, i) => readText(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPatch(bank * 128 + i) + 1), 12), 0, 12),
        store: (bank, i, ctx, data) => writeParts(patchBuilt, data, ctx.deviceId, userPatch(bank * 128 + i)),
        writable: (bank) => bank * 128 < USER_PATCHES, // called as (bank, ctx)
        autoNames: [0, 1, 2, 3], // every user patch name when the XT connects
        note: (bank, ctx) => `Play sends bank select 87/${bank + 1} and a program change on channel ${rxChannel(ctx) + 1} (87/0 selects the preset patches P001-P128, which have no SysEx address). Edit reads the user patch by address; Store writes the editor into it.`,
      },
    },
  ],
};

export const _test = { patchBuilt, sysBuilt, libraryItems, describe, assemble, defaults, TR };
