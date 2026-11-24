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
const SAME = 'Panel switch: the JP-8000 shows it with LEDs only. It is the same byte, with the same values, as on the JP-8080 (Roland\'s JP-8080 address map).';
const NONE = 'A system byte no menu of JP-8000 OS 1.05 shows (the JP-8080 address map lists it as a JP-8000 setting); kept so a backup restores exactly.';

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
  // JP-8000 format codes that differ from the JP-8080 ones (handlers at 6FF30): 11h remote channel
  // (1-16, ALL, OFF), 13h OSC2 range (-WIDE, -24..+24, +WIDE), FFh input quantize.
  formatMap: { 0x11: 0x1a, 0x13: 0x1c, 0xff: 0x18 },
  panelNote: SAME,
  coverage: 'Every system, performance, part and patch byte (including the Ribbon and Velocity depth matrices, the Tx/Rx CC table and the RPS pattern loop lengths) with the labels, ranges, value displays and option lists of the OS 1.05 firmware, read and written by address (DT1/RQ1). User patch and performance memories, the preset names from the ROM, bank select, program change and the motion data (event editor). Built from the firmware and the JP-8080 work; not yet checked on a JP-8000.',
  // System blocks of the JP-8000 only: pattern loop length per key (no PLAY ONCE) and motion loops 1-8.
  sysPlace: (off) => {
    if (off >= 0x800 && off < 0x830) return { label: `Pattern ${NOTE(37 + off - 0x800)} loop length`, group: 'Pattern and motion', format: (v) => `${v} meas.` };
    if (off >= 0x1000 && off < 0x1004) return { label: `Motion ${['A[1]', 'A[2]', 'B[1]', 'B[2]'][off - 0x1000]} loop length`, group: 'Motion control', format: (v) => `${v} meas.` };
    return null;
  },
  switches: ({ ONOFF }) => ({
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
      0x43: ['Bend Range Up', null, 'Pitch bend range up, 0-24 semitones (no JP-8000 menu: the same byte and range as the JP-8080 Bend Range Up).', { format: (v) => `+${v}` }],
      0x44: ['Bend Range Down', null, 'Pitch bend range down, 0-24 semitones (no JP-8000 menu: the same byte and range as the JP-8080 Bend Range Down).', { format: (v) => (v ? `-${v}` : '0') }],
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
      0x12: ['Setting 12h', null, NONE, { input: 'number' }],
      0x13: ['Setting 13h', null, NONE, { input: 'number' }],
      0x14: ['Setting 14h', null, NONE, { input: 'number' }],
      0x15: ['Setting 15h', null, NONE, { input: 'number' }],
      0x16: ['Setting 16h', null, NONE, { input: 'number' }],
    },
  }),
};

const { def, test } = buildJP(M);
export const MOTION_SLOTS = def.motionSlots;
export const _test = test;
export default def;
