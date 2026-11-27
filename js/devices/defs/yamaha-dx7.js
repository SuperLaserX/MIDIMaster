// Yamaha DX7 (mark I): voice editor and Branch Library from the v1.8 firmware (HD6303, 16 KB at C000h,
// DX7-V1-8.OBJ; tables in yamaha-dx7-fw.js, made by tools/yamaha/dx_fw.py) and Yamaha's published
// voice format. Shared code for the DX family: yamaha-dx.js. Checked in an emulator of its v1.8 OS (tools/yamaha/check_editor.mjs), not on a DX7.
//
// What the v1.8 firmware does with MIDI (parser at ED95, transmitter E9BC/EA5C; docs/devices/yamaha-dx7.md):
//   receives  F0 43 0n 00 01 1B <155> cs F7   one voice into the edit buffer
//             F0 43 0n 09 20 00 <4096> cs F7  32 voices into the internal memory
//             F0 43 0n 01 00 5E <94> cs F7    TX7 function data (sets the function values, selects byte 0's voice)
//             (bulk data only with SYS INFO AVAIL and MEMORY PROTECT INTERNAL off; checksum errors show CHECK SUM ERROR!)
//             F0 43 1n 0h pp vv F7            voice parameter pp (+128 h) into the edit buffer (0-155)
//             F0 43 1n 08 pp vv F7            function parameter 64-77; 0-41 press (vv > 0) or release a panel button
//             C0 pp                           voice pp & 3Fh: 0-31 internal, 32-63 cartridge
//   ignores   dump requests (F0 43 2n ...): sub-status 2 is rejected by the parser
//   sends     the edit buffer as one voice when a voice is selected (SYS INFO AVAIL; otherwise a program
//             change), parameter changes while editing, and the 32 voices with FUNCTION > MIDI TRANSMIT.

import { buildDX } from './yamaha-dx.js';
import * as FW from './yamaha-dx7-fw.js';

const clean = (t) => String(t || '').replace(/=\s*$/, '').replace(/\s+/g, ' ').trim();
// Voice field of each VCED offset (per operator below 126)
const OP_FIELDS = ['r', 'r', 'r', 'r', 'l', 'l', 'l', 'l', 'bp', 'ld', 'rd', 'lc', 'rc', 'rs', 'ams', 'kvs', 'tl', 'pm', 'pc', 'pf', 'pd'];
const GLOBAL_FIELDS = { 126: 'pr', 130: 'pl', 134: 'als', 135: 'fbl', 136: 'opi', 137: 'lfs', 138: 'lfd', 139: 'lpmd', 140: 'lamd', 141: 'lfks', 142: 'lfw', 143: 'lpms', 144: 'trnp' };
const fieldOf = (off) => (off < 126 ? OP_FIELDS[off] : GLOBAL_FIELDS[off] || GLOBAL_FIELDS[off < 130 ? 126 : 130]);

// Labels: the edit display texts (table F4F9 with the parameter table F551), the ones the display code
// loads itself (ALGORITHM SELECT, F COARSE, F FINE, OSC DETUNE), MIDDLE C (FB16) and, for what the
// LCD shows without a label, the panel's printing (OSC MODE, OP ON/OFF).
const labels = {};
FW.EDIT.params.forEach((p) => { if (p.text) labels[fieldOf(p.offset)] = clean(p.text); });
for (const [i, c] of Object.entries(FW.CODE_LABELS)) labels[fieldOf(FW.EDIT.params[Number(i)].offset)] = clean(c.text);
labels.trnp = clean(FW.TEXTS.FB16);

const help = {
  r: 'EG rate of this stage: 99 fastest.', l: 'EG level the stage goes to: 99 loudest. Level 4 is where the EG starts and returns after key off.',
  bp: 'Keyboard level scaling break point: A-1 to C8.', lc: 'Curve left of the break point.', rc: 'Curve right of the break point.',
  ld: 'Depth of the scaling left of the break point.', rd: 'Depth of the scaling right of the break point.',
  rs: 'Keyboard rate scaling: higher keys run the EG faster.', ams: 'Amplitude modulation sensitivity (LFO AM DEPTH to this operator).',
  kvs: 'Key velocity sensitivity of the output level.', tl: 'Output level: for a carrier its loudness, for a modulator the depth it modulates with.',
  pm: 'FREQUENCY(RATIO) follows the keyboard; FIXED FREQ.(Hz) plays one pitch.', pc: 'Coarse frequency; the display shows the resulting frequency (ratio, or Hz in fixed mode).',
  pf: 'Fine frequency; the display shows the resulting frequency.', pd: 'Detune -7 to +7.',
  pr: 'Pitch EG rate of this stage.', pl: 'Pitch EG level: 50 = no pitch change.',
  als: 'Algorithm 1-32 (how the six operators connect; see the diagram).', fbl: 'Feedback depth of the algorithm\'s feedback loop.',
  opi: 'Oscillator key sync: ON starts every operator at the same phase on each key.', lfs: 'LFO speed.', lfd: 'LFO delay before it starts.',
  lpmd: 'LFO pitch modulation depth.', lamd: 'LFO amplitude modulation depth.', lfks: 'LFO key sync: ON restarts the LFO on each key.',
  lfw: 'LFO waveform.', lpms: 'Pitch modulation sensitivity (LFO PM DEPTH and the modulation controllers set to PITCH).',
};

const OFFON = FW.OFF_ON.items.map((x) => x.text);
const MODES = FW.MODES.items.map((x) => x.text);
const CTL = FW.CONTROLLERS.items.map((x) => clean(x.text));
const fnLabel = (i) => clean(FW.FUNCTION.items[i]?.text);
// Function parameters (group 2), labels from the function display (F7DB, F813, F843) and the panel.
const functionParams = [
  { num: 64, label: 'POLY/MONO', max: 1, options: [[0, MODES[0]], [1, MODES[1]]], help: 'Function button 2 (POLY/MONO); the display shows POLY MODE or MONO MODE.', relayout: true },
  { num: 65, label: fnLabel(2), max: 12 },
  { num: 66, label: fnLabel(3), max: 12, help: '0: smooth bend; 1-12: the bend moves in steps of this many semitones.' },
  {
    num: 67, label: 'PORTAMENTO MODE', max: 1, help: 'Function button 5: what the portamento does; the choices depend on POLY/MONO.',
    dynamic: (d) => ({ options: d[0] ? [[0, MODES[4]], [1, MODES[5]]] : [[0, MODES[2]], [1, MODES[3]]] }),
  },
  { num: 68, label: fnLabel(5), max: 1, options: OFFON.map((t, i) => [i, t]) },
  { num: 69, label: fnLabel(6), max: 99 },
  ...[0, 1, 2, 3].flatMap((c) => [
    { num: 70 + c * 2, key: `f${70 + c * 2}`, label: `${CTL[c]} ${CTL[4]}`, max: 99, group: CTL[c] },
    ...['PITCH', 'AMP', 'EG B.'].map((t, b) => ({
      num: 71 + c * 2, key: `f${71 + c * 2}_${b}`, label: `${CTL[c]} ${clean(CTL[5 + b])}`, max: 1, shift: b, bits: 1, options: OFFON.map((x, i) => [i, x]), group: CTL[c],
      help: `Whether the ${['modulation wheel', 'foot controller', 'breath controller', 'aftertouch'][c]} controls ${['pitch (LFO PM)', 'amplitude (LFO AM)', 'EG bias'][b]}.`,
    })),
  ]),
];

/** The DX7 v1.8 value texts and init voice, labels and help: also used by the models without a voice edit display. */
export const DX7_FW = {
  CURVES: FW.CURVES.items.map((x) => x.text), WAVES: FW.LFO_WAVES.items.map((x) => x.text), OFFON, OSC_MODES: FW.OSC_MODES.items.map((x) => x.text),
  NOTES: FW.NOTES.items, DETUNE: FW.DETUNE.items, FIXED: FW.FIXED_FREQ.items, INIT: FW.INIT_VOICE.items,
};
export const DX7_LABELS = labels;
export const DX7_HELP = help;

const def = buildDX({
  id: 'yamaha-dx7',
  name: 'DX7',
  fw: DX7_FW,
  labels,
  help,
  requests: false,
  deviceIds: ['yamaha-tx7'], // same voice data: their voices load natively
  functionParams,
  bankNote: 'MEMORY PROTECT INTERNAL must be off and SYS INFO AVAIL on.',
  coverage: 'Edits the DX7\'s voices, its 32-voice bank and its function settings. Every voice parameter (6 operators, pitch EG, algorithm, LFO, transpose, name, operator on/off) with the DX7\'s own names, ranges and value displays; its 32 voices as a bank the editor keeps; the function settings; the algorithm diagram and envelope graphs. The DX7 cannot be asked for its data: it sends a voice when you select one (with SYS INFO AVAIL on) and its 32 voices with MIDI TRANSMIT. Checked against the DX7\'s own software running in an emulator, not yet on a real DX7.',
  notes: {
    voice: 'Each change is sent to the DX7 as you make it: SYS INFO AVAIL must be on (and MEMORY PROTECT INTERNAL off to send whole voices or banks). Selecting a voice on the DX7 sends it here.',
    function: 'The DX7 cannot report its function settings, so these are the editor\'s own values, sent one by one as you change them. Changes made on the DX7\'s panel show up here while SYS INFO AVAIL is on.',
  },
  midiNotes: [
    'Program change 0-31: internal voices 1-32; 32-63: cartridge voices (when a cartridge is inserted).',
    'SysEx: the DX7 receives and sends on its MIDI channel (FUNCTION 8): SysEx channel = MIDI channel. SYS INFO AVAIL must be on.',
    'Parameter changes group 2 numbers 0-41 press panel buttons (value > 0) or release them (value 0).',
  ],
});

export default def;
