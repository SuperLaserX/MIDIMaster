// Roland JP-8000: MIDI implementation from the JP-8000 OS v1.05 firmware (Hitachi H8/300H, image
// loaded at 0), built on the same code as the JP-8080 editor (roland-jp.js). The JP-8080 is the rack
// successor: same SysEx (F0 41 dev 00 06, RQ1 11h / DT1 12h, dispatcher 05880, identity 7E 06 01)
// and the same address map, minus the voice modulator and the JP-8080 additions. Tables found in
// the image (see docs/devices/roland-jp8000.md): SysEx table 6D830, UI table 72F88, knob
// descriptors 70B04, menu records 6E4F0 (2Ch bytes), option lists 73E10 / 753FE, per-byte CC
// table 53E8C, format handlers 6FF30, address decoder 2C6EE.
//
//   00 00 00 00  system (17h)        00 00 10 00  RPS pattern loop length per key (30h)
//   00 00 20 00  motion loop lengths (4)          00 00 30 00  Tx/Rx CC per knob (2Ah)
//   01 00 00 00  temporary performance: 00 00 common (24h), 10 00 / 11 00 upper / lower part (7),
//                40 00 / 42 00 upper / lower patch (F0h)
//   02 nn mm 00  user patch n (0-127)      03 nn 00 00  user performance n (0-63)
//   09 00 / 09 40 / 0A 00 / 0A 40  motions A[1] A[2] B[1] B[2]
// Checked only against the JP-8080 hardware and the firmware: no JP-8000 was available.

import { buildJP, NOTE } from './roland-jp.js';
import * as FW from './roland-jp8000-fw.js';

export { NOTE };

const PATCH_BANKS = [
  { label: 'USER', msb: 0x50, lsb: 0, user: true },
  { label: 'PRESET', msb: 0x51, lsb: 0 },
];
const PERF_BANKS = [
  { label: 'USER', msb: 0x50, lsb: 0, user: true },
  { label: 'PRESET', msb: 0x51, lsb: 0 },
];
const SAME = 'Panel switch: the JP-8000 shows it with its LEDs only.';
const PANEL_LED = 'The JP-8000 shows it with its LEDs only.';
// System 12h / 13h: Roland's JP-8000 address map names them; the values are the lists of the two
// utility pages (option lists 16 and 17). OS 1.05 keeps, sends and receives them (range checked),
// but its pages hold their own selection in work RAM and never read these bytes (emulator, see the doc).
const MENU_BYTE = (page, keys) => `The selection of the ${page} page (${keys}). The JP-8000 stores and sends it, but the page itself starts at its first entry after power-up and does not use this value.`;

const M = {
  id: 'roland-jp8000',
  name: 'JP-8000',
  fw: FW,
  sysParts: [['00 00 00 00', 0x17, 0], ['00 00 10 00', 0x30, 0x17], ['00 00 20 00', 4, 0x47], ['00 00 30 00', 0x2a, 0x4b]],
  perfParts: [['01 00 00 00', 0x24, 0], ['01 00 10 00', 7, 0x24], ['01 00 11 00', 7, 0x2b]],
  partSize: 7,
  patchSize: 0xf0,
  depthName: 'Ribbon',
  patchBanks: PATCH_BANKS,
  perfBanks: PERF_BANKS,
  // JP-8000 format codes that differ from the JP-8080 ones (handlers at 6FF30): 0Fh input quantize
  // (OFF, then the note glyphs of table 6FF22), 11h remote channel (1-16, ALL, OFF), 13h OSC2 range
  // (-WIDE, -24..+24, +WIDE).
  formatMap: { 0x0f: 0x18, 0x11: 0x1a, 0x13: 0x1c },
  // Tx/Rx CC list: option list 10 (list 11 on the JP-8080); 00 00 30 28/29 are the ribbon's halves.
  ccList: 10,
  // RPS patterns have SysEx on the JP-8000 (08 nn 00 00; not on the JP-8080).
  patterns: true,
  upDownLabels: ['Ribbon Up', 'Ribbon Down'],
  upDownNote: 'Ribbon Up/Down: the messages of the right-hand and left-hand halves of the ribbon controller; EXCLUSIVE cannot be assigned to them',
  // OS 1.05 (12A60, MODE2 branch 12D4E) indexes its 96-entry CC table (21B450h) with the slot's value
  // without excluding 96, so EXCLUSIVE writes over the memory signature copy at 21B5D0h (emulator).
  txrxWarning: 'Caution: with Tx/Rx Edit Mode MODE2 and Tx/Rx Edit SW ON, do not set a knob to EXCLUSIVE: a fault in the JP-8000\'s system software (OS 1.05) then makes it show "Memory Damaged!" at the next power-on (your data stays). Setting it on the panel does the same.',
  panelNote: SAME,
  coverage: 'Edits the JP-8000\'s patches, performances and system settings, read from and written to the unit. Every setting is named and shown as on the JP-8000\'s screens (OS 1.05), including the Ribbon and Velocity depth of each knob, the knob CC table and the RPS pattern loop lengths. User patch and performance memories, the preset names, and the motion data (event editor). Built from the JP-8000\'s system software and the JP-8080 work; not yet checked on a JP-8000.',
  // System blocks of the JP-8000 only: pattern loop length per key (no PLAY ONCE) and motion loops 1-8.
  sysPlace: (off) => {
    if (off >= 0x800 && off < 0x830) return { label: `Pattern ${NOTE(37 + off - 0x800)} loop length`, group: 'Pattern and motion', format: (v) => `${v} meas.` };
    if (off >= 0x1000 && off < 0x1004) return { label: `Motion ${['A[1]', 'A[2]', 'B[1]', 'B[2]'][off - 0x1000]} loop length`, group: 'Motion control', format: (v) => `${v} meas.` };
    if (off === 0x09) return { group: 'MIDI and system' };
    if (off === 0x12 || off === 0x13) return { group: 'Utility pages (stored selection)' };
    if (off >= 0x14 && off <= 0x16) return { group: 'Keyboard shift and ribbon' };
    return null;
  },
  switches: ({ ONOFF, L }) => ({
    PATCH: {
      0x10: ['LFO1 waveform', ['TRI', 'SAW', 'SQR', 'S/H']],
      0x14: ['LFO2 depth select', ['PITCH', 'FILTER', 'AMP'], `${SAME} Which depth the LFO2 DEPTH knob edits.`],
      0x15: ['Ring modulator switch', ONOFF],
      0x18: ['LFO1 & envelope destination', ['OSC1+2', 'OSC2', 'X-MOD DEPTH']],
      0x1e: ['OSC1 waveform', ['SUPER SAW', 'TRIANGLE MOD', 'NOISE', 'FEEDBACK OSC', 'SQUARE', 'SAW', 'TRIANGLE']],
      0x21: ['OSC2 waveform', ['SQUARE', 'TRIANGLE', 'SAW']],
      0x22: ['OSC2 sync switch', ONOFF],
      0x27: ['Filter type', ['HPF', 'BPF', 'LPF']],
      0x28: ['Cutoff slope', ['-12 dB/oct', '-24 dB/oct']],
      0x3a: ['Auto pan / manual pan', ['OFF', 'AUTO PAN', 'MANUAL PAN']],
      0x43: ['Bend Range Up', null, 'Pitch bend range up, 0-24 semitones (no JP-8000 menu shows it; the same setting as the JP-8080\'s Bend Range Up).', { format: (v) => `+${v}` }],
      0x44: ['Bend Range Down', null, 'Pitch bend range down, 0-24 semitones (no JP-8000 menu shows it; the same setting as the JP-8080\'s Bend Range Down).', { format: (v) => (v ? `-${v}` : '0') }],
      0x45: ['Portamento switch', ONOFF],
      0x47: ['Mono switch', ONOFF],
      0x48: ['Legato switch', ONOFF],
      0x49: ['Oscillator shift', ['-2 oct', '-1 oct', '0', '+1 oct', '+2 oct']],
      0x9b: ['Velocity switch', ONOFF],
    },
    PERF: {
      0x10: ['Key mode', ['SINGLE', 'DUAL', 'SPLIT']],
      0x12: ['Panel select', ['UPPER', 'LOWER', 'UPPER & LOWER'], 'Which part the panel knobs and part menus edit.'],
      0x17: ['Arpeggio switch', ONOFF],
      0x18: ['Arpeggio mode', ['UP', 'DOWN', 'UP&DOWN', 'RANDOM', 'RPS']],
      0x1a: ['Arpeggio octave range', ['1 octave', '2 octaves', '3 octaves', '4 octaves']],
      0x1b: ['Arpeggio hold', ONOFF],
    },
    VMOD: {},
    PART: {
      0x00: ['Patch bank', ['IN PERFORMANCE', 'USER', 'PRESET'], 'Selecting a bank or number loads that patch into the part. IN PERFORMANCE (the patch stored with the performance) is set only by selecting a performance.'],
    },
    SYSTEM: {
      0x00: ['Performance bank', [null, 'USER', 'PRESET']],
      // the page lists as the LCD shows them, with the padding between the two words taken out
      0x12: ['Factory Preset Menu', L(16).map((t) => t.replace(/\s+/g, ' ')), MENU_BYTE('Initialize ("Initialze[WRITE]")', 'SHIFT + INIT/UTIL')],
      0x13: ['Bulk Dump Menu', L(17).map((t) => t.replace(/\s+/g, ' ')), MENU_BYTE('Bulk Dump ("Bulk Dump[WRITE]")', 'SHIFT + INIT/UTIL, then INIT/UTIL again')],
      0x14: ['Keyboard Shift', ['-2 oct', '-1 oct', '0', '+1 oct', '+2 oct'], `Panel switch: SHIFT + -OCT/+OCT turns the OSC SHIFT buttons into Keyboard Shift buttons, which then shift the keyboard in octaves (both parts, and the notes it sends). ${PANEL_LED}`],
      0x15: ['Ribbon Relative', ONOFF, `Panel switch RIBBON CONTROLLER [RELATIVE]: ON, the sound starts unchanged wherever the ribbon is touched and changes as the finger moves. ${PANEL_LED}`],
      0x16: ['Ribbon Hold', ONOFF, `Panel switch RIBBON CONTROLLER [HOLD]: ON, the change the ribbon made stays when the finger is taken off. ${PANEL_LED}`],
    },
  }),
};

const { def, test } = buildJP(M);
export const MOTION_SLOTS = def.motionSlots;
export const _test = test;
export default def;
