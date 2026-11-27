// Roland JP-8080 (and JP-8000): MIDI implementation from the JP-8080 OS v1.04 firmware
// (Hitachi H8/300H, flash image loaded at 10000h) and checked against a JP-8080 over MIDI.
// See docs/devices/roland-jp8080.md for the firmware addresses.
//
// SysEx: F0 41 dev 00 06 11|12 aa aa aa aa ... cs F7 (RQ1 / DT1, 4-byte addresses, device ID
// 10h by default; the dispatcher at 121B0 ignores other device IDs). Address map (decoder 45556):
//   00 00 00 00  system (19h)   00 00 20 00  motion loop lengths (4)   00 00 30 00  Tx/Rx CCs (2Ah)
//   01 00 00 00  temporary performance: 00 00 common (25h), 08 00 voice modulator (29h),
//                10 00 / 11 00 upper / lower part (8), 40 00 / 42 00 upper / lower patch (F8h)
//   02 nn mm 00  user patch n (0-127) at 02 00 00 00 + n x 100h (7-bit address arithmetic)
//   03 nn 00 00  user performance n (0-63), laid out as 01 00 00 00 (with its two patches)
// RQ1 is answered for addresses below 0B 00 00 00 (08-0A: pattern and motion data, 7-in-8 packed).
// The identity reply (45CDC) is F0 7E dev 06 02 06 01 00 00 00 03 00 00 F7: the firmware leaves
// out Roland's 41h, and the editor accepts it as it is.

import { buildJP } from './roland-jp.js';
import * as FW from './roland-jp8080-fw.js';

export { NOTE, unpack7, pack7, MOTION_TICKS, motionTimeline, buildMotion, motionMessages, motionAddr, readMotion, isJPIdentity as isJP8080Identity } from './roland-jp.js';

const PATCH_BANKS = [
  { label: 'USER', msb: 0x50, lsb: 0, user: true },
  { label: 'PRESET 1', msb: 0x51, lsb: 0 },
  { label: 'PRESET 2', msb: 0x51, lsb: 1 },
  { label: 'PRESET 3', msb: 0x51, lsb: 2 },
];
const PERF_BANKS = [
  { label: 'USER', msb: 0x50, lsb: 0, user: true },
  { label: 'PRESET 1', msb: 0x51, lsb: 0 },
  { label: 'PRESET 2', msb: 0x51, lsb: 1 },
  { label: 'PRESET 3', msb: 0x51, lsb: 2 },
];

const M = {
  id: 'roland-jp8080',
  name: 'JP-8080',
  fw: FW,
  // [address, size, offset in the object]
  sysParts: [['00 00 00 00', 0x19, 0], ['00 00 20 00', 4, 0x19], ['00 00 30 00', 0x2a, 0x1d]],
  perfParts: [['01 00 00 00', 0x25, 0], ['01 00 08 00', 0x29, 0x25], ['01 00 10 00', 8, 0x4e], ['01 00 11 00', 8, 0x56]],
  partSize: 8,
  patchSize: 0xf8,
  depthName: 'Control',
  patchBanks: PATCH_BANKS,
  perfBanks: PERF_BANKS,
  coverage: 'Every system, performance, voice modulator, part and patch byte (including the Control and Velocity depth matrices and the Tx/Rx CC table) with the labels, ranges, value displays and option lists of the v1.04 firmware; bytes without a JP-8080 screen are named from Roland’s address map and the JP-8000 menus. Read and written by address (DT1/RQ1). User patch and performance memories, PRESET 1-3 names from the ROM, bank select, program change, the MODE1/MODE2 CC maps, and motion and RPS pattern data for the Branch Library. Checked on a JP-8080.',
  // Bytes without LCD text (see roland-jp.js): [label, options or null, help, extra].
  switches: ({ PANEL, JP8000, ONOFF, groups }) => ({
  PATCH: {
    0x10: ['LFO1 waveform', ['TRI', 'SAW', 'SQR', 'S/H']],
    0x14: ['LFO2 depth select', ['PITCH', 'FILTER', 'AMP'], 'Which depth the LFO2 DEPTH knob edits.'],
    0x15: ['Ring modulator switch', ONOFF],
    0x18: ['LFO1 & envelope destination', ['OSC1+2', 'OSC2', 'X-MOD DEPTH'], 'Where OSC LFO1 DEPTH and the pitch envelope act.'],
    0x1e: ['OSC1 waveform', ['SUPER SAW', 'TRIANGLE MOD', 'NOISE', 'FEEDBACK OSC', 'SQUARE', 'SAW', 'TRIANGLE'], 'Names from the OSC1 Control labels at 5E0C0, which follow this order.'],
    0x21: ['OSC2 waveform', ['SQUARE', 'TRIANGLE', 'SAW', 'NOISE'], 'No effect while OSC2 External Input Switch is ON.'],
    0x22: ['OSC2 sync switch', ONOFF],
    0x27: ['Filter type', ['HPF', 'BPF', 'LPF']],
    0x28: ['Cutoff slope', ['-12 dB/oct', '-24 dB/oct']],
    0x3a: ['Auto pan / manual pan', ['OFF', 'AUTO PAN', 'MANUAL PAN'], 'With AUTO PAN, AMP LFO1 DEPTH sets the pan LFO depth; with MANUAL PAN it sets the pan position.'],
    0x45: ['Portamento switch', ONOFF],
    0x47: ['Mono switch', ONOFF],
    0x48: ['Legato switch', ONOFF],
    0x49: ['Oscillator shift', ['-2 oct', '-1 oct', '0', '+1 oct', '+2 oct']],
    0x9b: ['Velocity switch', ONOFF],
    0xf0: ['(reserved)', null, 'Reserved in Roland\'s address map; always 0.', { readOnly: true }],
    0xf1: ['OSC2 external input switch', ONOFF, 'ON: OSC2 plays the external input (OSC2 Control shows EXTERNAL INPUT, label table 5E140).'],
    0xf2: ['Voice modulator send switch', ONOFF],
    0xf3: ['Unison switch', ONOFF],
  },
  PERF: {
    0x10: ['Key mode', ['SINGLE', 'DUAL', 'SPLIT']],
    0x12: ['Panel select', ['UPPER', 'LOWER', 'UPPER & LOWER'], 'Which part the panel knobs and part menus edit.'],
    0x17: ['Arpeggio switch', ONOFF],
    0x18: ['Arpeggio mode', ['UP', 'DOWN', 'UP&DOWN', 'RANDOM', 'RPS']],
    0x1a: ['Arpeggio octave range', ['1 octave', '2 octaves', '3 octaves', '4 octaves']],
    0x1b: ['Arpeggio hold', ONOFF],
    0x1c: ['Pedal Assign (JP-8000)', null, `${JP8000} The label is the JP-8000 OS 1.05 menu; the values are option list 4 of both firmwares.`, { listNo: 4 }],
    0x24: ['Vocal/upper input jack', ['REAR', 'FRONT']],
  },
  VMOD: {
    0x00: ['Voice modulator switch', ONOFF],
    0x01: ['Voice modulator panel mode', ONOFF, 'ON: the panel knobs edit the voice modulator (Character, Vocal Mix, ...).'],
  },
  PART: {
    0x00: ['Patch bank', ['IN PERFORMANCE', 'USER', 'PRESET', 'CARD'], 'Selecting a bank, group or number loads that patch into the part. IN PERFORMANCE (the patch stored with the performance) is set only by selecting a performance.'],
    0x07: ['Patch group', groups(64), 'USER: group 1 only; PRESET: 1-3; CARD: 1-32 (S2M-5) or 1-64 (S4M-5).'],
  },
  SYSTEM: {
    0x00: ['Performance bank', [null, 'USER', 'PRESET', 'CARD']],
    0x0d: ['Motion Set', null, 'Which motion set (A or B) Motion Control records and plays. Not on a JP-8080 screen: the label is the JP-8000 OS 1.05 menu, the values option list 18 of both firmwares.', { listNo: 18 }],
    0x09: ['Remote Ctrl CH (JP-8000)', null, `${JP8000} The label is the JP-8000 OS 1.05 menu; the JP-8080 keeps 17 here and uses Remote KBD CH instead.`, { readOnly: true }],
    0x12: ['JP-8000 setting 12h', null, `${JP8000} Always 0 on the JP-8080.`, { readOnly: true }],
    0x13: ['JP-8000 setting 13h', null, `${JP8000} Always 0 on the JP-8080.`, { readOnly: true }],
    0x14: ['JP-8000 setting 14h', null, JP8000, { input: 'number' }],
    0x15: ['JP-8000 setting 15h', null, JP8000, { input: 'number' }],
    0x16: ['JP-8000 setting 16h', null, JP8000, { input: 'number' }],
    0x17: ['Performance group', groups(64), 'USER: group 1 only; PRESET: 1-3; CARD: 1-32 (S2M-5) or 1-64 (S4M-5).'],
  },
}),
};

const { def, test } = buildJP(M);
export const MOTION_SLOTS = def.motionSlots;
export const _test = test;
export default def;
