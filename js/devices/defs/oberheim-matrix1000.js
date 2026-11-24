// Oberheim Matrix-1000: MIDI implementation taken from the v1.13 firmware
// (M1000-CAT27256P-17_v113.BIN, 6809). See docs/devices/oberheim-matrix1000.md.
//
// SysEx header F0 10 06 <cmd>. Dispatcher at 0xC87D, command table at 0xC9E6:
//   01 single patch data (stored into the current bank)   03 master data (03 + 172 bytes)
//   04 request: 0 bank + master, 1 patch, 3 master, 4 edit buffer
//   06 remote parameter edit (parameter numbers via table 0xDE13)
//   08 group mode on / 09 group mode off    0A set bank (and lock)   0B matrix slot edit
//   0C unlock bank    0D patch to edit buffer    0E store edit buffer
// Data is sent as nibbles, low nibble first, followed by a 7-bit checksum of the bytes.
// Patches are 134 bytes: an 8-byte name, then the parameters in the order below. The
// firmware stores them bit-packed (81 bytes); field widths come from its unpacker
// (thread at 0xDF85) and sign extension table (0xE08B).

import { named, readText } from '../../core/model/memmap.js';

const HDR = [0xf0, 0x10, 0x06];
const PATCH_SIZE = 134;
const MASTER_SIZE = 172;

export const SOURCES = ['Unused', 'Env 1', 'Env 2', 'Env 3', 'LFO 1', 'LFO 2', 'Vibrato', 'Ramp 1', 'Ramp 2', 'Keyboard',
  'Portamento', 'Tracking gen', 'Keyboard gate', 'Velocity', 'Release velocity', 'Pressure', 'Pedal 1', 'Pedal 2',
  'Lever 1', 'Lever 2', 'Lever 3'];
export const DESTINATIONS = ['Unused', 'DCO 1 frequency', 'DCO 1 pulse width', 'DCO 1 waveshape', 'DCO 2 frequency',
  'DCO 2 pulse width', 'DCO 2 waveshape', 'Mix', 'VCF FM amount', 'VCF frequency', 'VCF resonance', 'VCA 1 level',
  'VCA 2 level', 'Env 1 delay', 'Env 1 attack', 'Env 1 decay', 'Env 1 release', 'Env 1 amplitude', 'Env 2 delay',
  'Env 2 attack', 'Env 2 decay', 'Env 2 release', 'Env 2 amplitude', 'Env 3 delay', 'Env 3 attack', 'Env 3 decay',
  'Env 3 release', 'Env 3 amplitude', 'LFO 1 speed', 'LFO 1 amplitude', 'LFO 2 speed', 'LFO 2 amplitude', 'Portamento time'];

const OPT = {
  sync: named(['Off', 'Soft', 'Medium', 'Hard']),
  wave1: named(['Off', 'Pulse', 'Wave', 'Pulse + wave']),
  wave2: named(['Off', 'Pulse', 'Wave', 'Pulse + wave', 'Noise']),
  levers: named(['Off', 'Lever 1 (bend)', 'Vibrato', 'Bend + vibrato']),
  track1: named(['Keyboard', 'Portamento']),
  track2: named(['Keyboard', 'Portamento', 'Off']),
  onoff: named(['Off', 'On']),
  kbdMode: named(['Reassign', 'Rotate', 'Unison', 'Reassign + rob']),
  portaMode: named(['Linear', 'Constant time', 'Exponential']),
  lfoTrig: named(['Off', 'Single', 'Multi', 'External']),
  lfoWave: named(['Triangle', 'Up saw', 'Down saw', 'Square', 'Random', 'Noise', 'Sampled']),
  envTrig: named(['Single trigger', 'Single reset', 'Multi trigger', 'Multi reset', 'Ext single', 'Ext single reset', 'Ext multi', 'Ext multi reset']),
  envMode: named(['Normal', 'DADR', 'Free run', 'DADR + free run']),
  envLfo: named(['Normal', 'LFO 1', 'Gated LFO 1']),
  rampTrig: named(['Single', 'Multi', 'External', 'External gated']),
  source: named(SOURCES),
  dest: named(DESTINATIONS),
};

// [remote parameter number, byte offset in the 134-byte patch, group, label, type]
// Byte offset = 8 + table[0xDE13 + parameter]. Types: uN = unsigned N bits, sN = signed N bits,
// or an OPT key. Parameters 39, 49, 89 and 99 are not editable remotely on the 1000.
const PATCH = [
  [48, 8, 'Voice', 'Keyboard mode', 'kbdMode'],
  [0, 9, 'DCO 1', 'Frequency', 'u6'], [5, 10, 'DCO 1', 'Waveshape', 'u6'], [3, 11, 'DCO 1', 'Pulse width', 'u6'],
  [7, 12, 'DCO 1', 'Levers', 'levers'], [6, 13, 'DCO 1', 'Waveform', 'wave1'],
  [10, 14, 'DCO 2', 'Frequency', 'u6'], [15, 15, 'DCO 2', 'Waveshape', 'u6'], [13, 16, 'DCO 2', 'Pulse width', 'u6'],
  [17, 17, 'DCO 2', 'Levers', 'levers'], [16, 18, 'DCO 2', 'Waveform', 'wave2'], [12, 19, 'DCO 2', 'Detune', 's6'],
  [20, 20, 'Mix / VCF / VCA', 'Mix', 'u6'],
  [8, 21, 'DCO 1', 'Key tracking', 'track1'], [9, 22, 'DCO 1', 'Click', 'onoff'],
  [18, 23, 'DCO 2', 'Key tracking', 'track2'], [19, 24, 'DCO 2', 'Click', 'onoff'],
  [2, 25, 'DCO 1', 'Sync', 'sync'],
  [21, 26, 'Mix / VCF / VCA', 'VCF frequency', 'u7'], [24, 27, 'Mix / VCF / VCA', 'VCF resonance', 'u6'],
  [25, 28, 'Mix / VCF / VCA', 'VCF levers', 'levers'], [26, 29, 'Mix / VCF / VCA', 'VCF key tracking', 'track2'],
  [30, 30, 'FM / tracking', 'FM amount', 'u6'], [27, 31, 'Mix / VCF / VCA', 'VCA 1 level', 'u6'],
  [44, 32, 'Portamento / ramps', 'Portamento rate', 'u6'], [46, 33, 'Portamento / ramps', 'Portamento mode', 'portaMode'],
  [47, 34, 'Portamento / ramps', 'Legato portamento', 'onoff'],
  [80, 35, 'LFO 1', 'Speed', 'u6'], [86, 36, 'LFO 1', 'Trigger', 'lfoTrig'], [87, 37, 'LFO 1', 'Lag', 'onoff'],
  [82, 38, 'LFO 1', 'Waveshape', 'lfoWave'], [83, 39, 'LFO 1', 'Retrigger point', 'u6'],
  [88, 40, 'LFO 1', 'Sample source', 'source'], [84, 41, 'LFO 1', 'Amplitude', 'u6'],
  [90, 42, 'LFO 2', 'Speed', 'u6'], [96, 43, 'LFO 2', 'Trigger', 'lfoTrig'], [97, 44, 'LFO 2', 'Lag', 'onoff'],
  [92, 45, 'LFO 2', 'Waveshape', 'lfoWave'], [93, 46, 'LFO 2', 'Retrigger point', 'u6'],
  [98, 47, 'LFO 2', 'Sample source', 'source'], [94, 48, 'LFO 2', 'Amplitude', 'u6'],
  ...[1, 2, 3].flatMap((n) => {
    const b = 49 + (n - 1) * 9;
    const p = 50 + (n - 1) * 10;
    const g = `Env ${n}`;
    // Env 2 delay is packed into 5 bits by the patch store (0xDF85 thread); the others into 6.
    return [[p + 7, b, g, 'Trigger', 'envTrig'], [p, b + 1, g, 'Delay', n === 2 ? 'u5x' : 'u6'], [p + 1, b + 2, g, 'Attack', 'u6'],
      [p + 2, b + 3, g, 'Decay', 'u6'], [p + 3, b + 4, g, 'Sustain', 'u6'], [p + 4, b + 5, g, 'Release', 'u6'],
      [p + 5, b + 6, g, 'Amplitude', 'u6'], [p + 9, b + 7, g, 'LFO 1 trigger', 'envLfo'], [p + 8, b + 8, g, 'Mode', 'envMode']];
  }),
  [33, 76, 'FM / tracking', 'Tracking input', 'source'],
  [34, 77, 'FM / tracking', 'Track point 1', 'u6'], [35, 78, 'FM / tracking', 'Track point 2', 'u6'],
  [36, 79, 'FM / tracking', 'Track point 3', 'u6'], [37, 80, 'FM / tracking', 'Track point 4', 'u6'],
  [38, 81, 'FM / tracking', 'Track point 5', 'u6'],
  [40, 82, 'Portamento / ramps', 'Ramp 1 rate', 'u6'], [41, 83, 'Portamento / ramps', 'Ramp 1 trigger', 'rampTrig'],
  [42, 84, 'Portamento / ramps', 'Ramp 2 rate', 'u6'], [43, 85, 'Portamento / ramps', 'Ramp 2 trigger', 'rampTrig'],
  [1, 86, 'DCO 1', 'Freq by LFO 1', 's7'], [4, 87, 'DCO 1', 'PW by LFO 2', 's7'],
  [11, 88, 'DCO 2', 'Freq by LFO 1', 's7'], [14, 89, 'DCO 2', 'PW by LFO 2', 's7'],
  [22, 90, 'Mix / VCF / VCA', 'VCF freq by Env 1', 's7'], [23, 91, 'Mix / VCF / VCA', 'VCF freq by pressure', 's7'],
  [28, 92, 'Mix / VCF / VCA', 'VCA 1 by velocity', 's7'], [29, 93, 'Mix / VCF / VCA', 'VCA 2 by Env 2', 's7'],
  [56, 94, 'Env 1', 'Amp by velocity', 's7'], [66, 95, 'Env 2', 'Amp by velocity', 's7'], [76, 96, 'Env 3', 'Amp by velocity', 's7'],
  [85, 97, 'LFO 1', 'Amp by Ramp 1', 's7'], [95, 98, 'LFO 2', 'Amp by Ramp 2', 's7'],
  [45, 99, 'Portamento / ramps', 'Rate by velocity', 's7'],
  [31, 100, 'FM / tracking', 'FM by Env 3', 's7'], [32, 101, 'FM / tracking', 'FM by pressure', 's7'],
  [81, 102, 'LFO 1', 'Speed by pressure', 's7'], [91, 103, 'LFO 2', 'Speed by keyboard', 's7'],
];

// ------------------------------------------------------------------ encoding helpers
export function nibbles(data) {
  const out = [];
  let sum = 0;
  for (const b of data) { out.push(b & 15, (b >> 4) & 15); sum += b; }
  return { out, sum: sum & 0x7f };
}

export function unnibble(raw, start, count) {
  const data = new Uint8Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    data[i] = (raw[start + 2 * i] & 15) | ((raw[start + 2 * i + 1] & 15) << 4);
    sum += data[i];
  }
  return { data, ok: (sum & 0x7f) === raw[start + 2 * count] };
}

export const msg = {
  request: (type, num = 0) => [...HDR, 0x04, type, num, 0xf7],
  patch: (num, data) => { const n = nibbles(data); return [...HDR, 0x01, num, ...n.out, n.sum, 0xf7]; },
  toEditBuffer: (data) => { const n = nibbles(data); return [...HDR, 0x0d, 0x00, ...n.out, n.sum, 0xf7]; },
  storeEditBuffer: (num, bank, unit = 0) => [...HDR, 0x0e, num, bank, unit, 0xf7],
  master: (data) => { const n = nibbles(data); return [...HDR, 0x03, 0x03, ...n.out, n.sum, 0xf7]; },
  param: (num, value) => [...HDR, 0x06, num, value & 0x7f, 0xf7],
  matrix: (slot, src, amount, dst) => [...HDR, 0x0b, slot, src, amount & 0x7f, dst, 0xf7],
  setBank: (bank) => [...HDR, 0x0a, bank, 0xf7],
  unlockBank: () => [...HDR, 0x0c, 0xf7],
  groupOn: (units, unit = 0) => [...HDR, 0x08, units, unit, 0xf7],
  groupOff: () => [...HDR, 0x09, 0xf7],
};

const isOb = (raw) => raw[0] === 0xf0 && raw[1] === 0x10 && raw[2] === 0x06;

/** Name stored in a patch. The Matrix-6 uses 6-bit ASCII; the 1000 writes "BNKb: nn". */
export const patchName = (data) => readText(data, 0, 8, (b) => { const c = b & 0x3f; return c < 32 ? c + 64 : c; });

function typeSpec(type) {
  if (OPT[type]) return { options: OPT[type] };
  if (type === 'u5x') return { min: 0, max: 31, help: 'The firmware stores this in 5 bits, so stored patches keep 0-31.' };
  const bits = Number(type.slice(1));
  if (type[0] === 's') return { signed: true, min: -(2 ** (bits - 1) - 1), max: 2 ** (bits - 1) - 1 };
  return { min: 0, max: 2 ** bits - 1 };
}

const patchParams = PATCH.map(([num, offset, group, label, type]) => ({
  key: `p${num}`, num, offset, group, label, ...typeSpec(type),
  send: (v) => msg.param(num, v),
}));

// Modulation matrix: 10 slots of (source, amount, destination) from byte 104.
const matrixRows = [];
for (let s = 0; s < 10; s++) {
  const o = 104 + s * 3;
  const send = (_v, _ctx, data) => msg.matrix(s, data[o], data[o + 1], data[o + 2]);
  patchParams.push(
    { key: `m${s}src`, group: 'Modulation matrix', label: 'Source', offset: o, options: OPT.source, send, sendKey: `m${s}` },
    { key: `m${s}amt`, group: 'Modulation matrix', label: 'Amount', offset: o + 1, signed: true, min: -63, max: 63, send, sendKey: `m${s}` },
    { key: `m${s}dst`, group: 'Modulation matrix', label: 'Destination', offset: o + 2, options: OPT.dest, send, sendKey: `m${s}` });
  matrixRows.push({ label: `${s}`, keys: [`m${s}src`, `m${s}amt`, `m${s}dst`] });
}

// ------------------------------------------------------------------ defaults
export function initPatch(name = 'INIT') {
  const d = new Uint8Array(PATCH_SIZE);
  for (let i = 0; i < 8; i++) d[i] = (name.charCodeAt(i) || 32) & 0x7f;
  const set = (offset, v) => { d[offset] = v & 0xff; };
  set(13, 2); set(18, 2); set(12, 3); set(17, 3); // saw on both DCOs, bend + vibrato
  set(14, 0); set(11, 31); set(16, 31); set(20, 31);
  set(26, 100); set(28, 3); set(31, 63); set(32, 0);
  set(35, 20); set(41, 0); set(42, 30);
  // Env 2 drives VCA 2 (amplitude): attack 0, decay 20, sustain 63, release 20.
  set(58 + 1, 0); set(58 + 2, 0); set(58 + 3, 20); set(58 + 4, 63); set(58 + 5, 20); set(58 + 6, 63);
  set(49 + 3, 20); set(49 + 4, 40); set(49 + 5, 20); set(49 + 6, 63);
  set(93, 63); set(90, 0);
  return d;
}

/** Master defaults as the firmware sets them at cold start (0xB1A8 copy, then 0xDC41). */
export function initMaster() {
  const d = new Uint8Array(MASTER_SIZE);
  [0, 40, 0, 0, 0, 0, 1, 63, 0, 0, 63, 0, 1, 1, 1, 1, 1, 4, 64, 1, 2, 0, 0, 27, 0, 0, 0].forEach((v, i) => { d[i] = v; });
  d[27] = 1; d[28] = 5; d[31] = 1;
  d.fill(0xff, 36, 162);
  d[164] = 2; d[166] = 1;
  return d;
}

const s8 = (min = -63, max = 63) => ({ signed: true, min, max });
const VIB_SRC = named(['Off', 'Lever 2', 'Pedal 1']);
const ccOpt = { min: 0, max: 121, format: (v) => `CC ${v}` };

// Master table offsets, from the code that reads them (CC handler 0xC506, note handler 0xC4BC,
// vibrato 0x900D, front-panel functions 0xC19A-0xC404, defaults 0xB1A8 / 0xDC41).
const masterParams = [
  { key: 'vibSpeed', group: 'Vibrato', label: 'Speed', offset: 1, min: 0, max: 63 },
  { key: 'vibSpeedSrc', group: 'Vibrato', label: 'Speed mod source', offset: 2, options: VIB_SRC },
  { key: 'vibSpeedAmt', group: 'Vibrato', label: 'Speed mod amount', offset: 3, ...s8() },
  { key: 'vibWave', group: 'Vibrato', label: 'Waveshape', offset: 4, options: OPT.lfoWave.slice(0, 6) },
  { key: 'vibAmp', group: 'Vibrato', label: 'Amplitude', offset: 5, min: 0, max: 63 },
  { key: 'vibAmpSrc', group: 'Vibrato', label: 'Amp mod source', offset: 6, options: VIB_SRC },
  { key: 'vibAmpAmt', group: 'Vibrato', label: 'Amp mod amount', offset: 7, ...s8() },
  { key: 'tune', group: 'Tuning', label: 'Master tune', offset: 8, ...s8(-31, 31) },
  { key: 'transpose', group: 'Tuning', label: 'Transpose', offset: 34, ...s8(-24, 24), unit: ' st' },
  { key: 'bendRange', group: 'Tuning', label: 'Bend range', offset: 164, min: 1, max: 24, unit: ' st' },
  { key: 'velCurve', group: 'Tuning', label: 'Velocity curve', offset: 9, min: 0, max: 3 },
  { key: 'velAmount', group: 'Tuning', label: 'Velocity scale', offset: 10, min: 0, max: 63 },
  { key: 'channel', group: 'MIDI', label: 'Basic channel', offset: 11, min: 0, max: 15, format: (v) => `Ch ${v + 1}` },
  { key: 'omni', group: 'MIDI', label: 'Omni', offset: 12, options: OPT.onoff },
  { key: 'controllers', group: 'MIDI', label: 'Controllers', offset: 13, options: OPT.onoff },
  { key: 'patchChanges', group: 'MIDI', label: 'Program changes', offset: 14, options: OPT.onoff },
  { key: 'echo', group: 'MIDI', label: 'MIDI echo', offset: 32, options: OPT.onoff },
  { key: 'mono', group: 'MIDI', label: 'Mono mode', offset: 35, options: OPT.onoff },
  { key: 'sensing', group: 'MIDI', label: 'Active sensing', offset: 31, options: OPT.onoff },
  { key: 'pedal1', group: 'Controller numbers', label: 'Pedal 1', offset: 17, ...ccOpt },
  { key: 'pedal2', group: 'Controller numbers', label: 'Pedal 2 (sustain)', offset: 18, ...ccOpt },
  { key: 'lever2', group: 'Controller numbers', label: 'Lever 2', offset: 19, ...ccOpt },
  { key: 'lever3', group: 'Controller numbers', label: 'Lever 3', offset: 20, ...ccOpt },
  { key: 'bank', group: 'Banks and units', label: 'Bank', offset: 165, bits: 4, min: 0, max: 9 },
  { key: 'bankLock', group: 'Banks and units', label: 'Bank lock', offset: 165, shift: 7, bits: 1, options: OPT.onoff },
  { key: 'units', group: 'Banks and units', label: 'Units in group', offset: 166, min: 1, max: 16 },
  { key: 'unit', group: 'Banks and units', label: 'This unit', offset: 167, min: 0, max: 15 },
  { key: 'group', group: 'Banks and units', label: 'Group mode', offset: 168, shift: 7, bits: 1, options: OPT.onoff },
  { key: 'unison', group: 'Banks and units', label: 'Unison', offset: 169, options: OPT.onoff },
  { key: 'volInvert', group: 'Banks and units', label: 'Volume invert', offset: 170, options: OPT.onoff },
  { key: 'protect', group: 'Banks and units', label: 'Memory protect', offset: 171, options: OPT.onoff },
].map((p) => ({ ...p, send: (_v, _ctx, data) => msg.master(data) }));

// ------------------------------------------------------------------ simulator (demo mode, tests)
function simulate() {
  const st = {
    bank: 0, locked: false, edit: initPatch('BNK0: 00'), master: initMaster(),
    patches: Array.from({ length: 1000 }, (_, i) => initPatch(`BNK${Math.floor(i / 100)}: ${String(i % 100).padStart(2, '0')}`)),
  };
  const named1000 = (i) => { const d = Uint8Array.from(st.patches[i]); const t = `BNK${Math.floor(i / 100)}: ${String(i % 100).padStart(2, '0')}`; for (let k = 0; k < 8; k++) d[k] = t.charCodeAt(k); return d; };
  return {
    state: st,
    handle(d) {
      if (d[0] === 0xf0 && d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) {
        return [[0xf0, 0x7e, st.master[11], 0x06, 0x02, 0x10, 0x06, 0x00, 0x02, 0x00, 0x31, 0x31, 0x33, 0xf7]];
      }
      if ((d[0] & 0xf0) === 0xc0) { st.edit = Uint8Array.from(st.patches[(st.locked ? st.bank * 100 : 0) + d[1]] || st.edit); return []; }
      if (!isOb(d)) return null;
      const cmd = d[3];
      switch (cmd) {
        case 0x04: {
          const [type, num] = [d[4], d[5]];
          if (type === 1) return [msg.patch(num, named1000(st.bank * 100 + num))];
          if (type === 3) return [msg.master(st.master)];
          if (type === 4) return [msg.patch(0, st.edit)];
          if (type === 0) return [...Array.from({ length: 100 }, (_, i) => msg.patch(i, named1000(st.bank * 100 + i))), msg.master(st.master)];
          return [];
        }
        case 0x06: {
          const p = PATCH.find(([n]) => n === d[4]);
          if (p) st.edit[p[1]] = d[4] === 21 ? d[5] : ((d[5] << 25) >> 25) & 0xff;
          return [];
        }
        case 0x0b: { const o = 104 + d[4] * 3; st.edit[o] = d[5]; st.edit[o + 1] = ((d[6] << 25) >> 25) & 0xff; st.edit[o + 2] = d[7]; return []; }
        case 0x0d: { const r = unnibble(d, 5, PATCH_SIZE); if (r.ok) st.edit = r.data; return []; }
        case 0x0e: { if (!st.master[171]) st.patches[d[5] * 100 + d[4]] = Uint8Array.from(st.edit); return []; }
        case 0x01: { const r = unnibble(d, 5, PATCH_SIZE); if (r.ok && !st.master[171]) st.patches[st.bank * 100 + d[4]] = r.data; return []; }
        case 0x03: { const r = unnibble(d, 5, MASTER_SIZE); if (r.ok) st.master = r.data; return []; }
        case 0x0a: st.bank = Math.min(9, d[4]); st.locked = true; st.edit = Uint8Array.from(st.patches[st.bank * 100]); return [];
        case 0x0c: st.locked = false; return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor text
const CMD = { 0x01: 'Single patch data', 0x03: 'Master data', 0x04: 'Request data', 0x06: 'Remote parameter edit', 0x08: 'Group mode on',
  0x09: 'Group mode off', 0x0a: 'Set bank', 0x0b: 'Matrix slot edit', 0x0c: 'Unlock bank', 0x0d: 'Patch to edit buffer', 0x0e: 'Store edit buffer' };
const REQ = ['bank + master', 'patch', 'split', 'master', 'edit buffer'];

function describe(raw) {
  if (!isOb(raw)) return null;
  const c = raw[3];
  const name = CMD[c] || `Command ${c.toString(16)}`;
  if (c === 0x04) return `Matrix-1000 request ${REQ[raw[4]] || raw[4]}${raw[4] === 1 ? ` ${raw[5]}` : ''}`;
  if (c === 0x06) {
    // The firmware sign-extends 7-bit values except for parameter 21 (VCF frequency, 0-127).
    const p = PATCH.find(([n]) => n === raw[4]);
    const v = raw[4] === 21 ? raw[5] : (raw[5] << 25) >> 25;
    return `Matrix-1000 ${name}: ${p ? `${p[2]} ${p[3]}` : `#${raw[4]}`} = ${v}`;
  }
  if (c === 0x0b) return `Matrix-1000 matrix slot ${raw[4]}: ${SOURCES[raw[5]] || raw[5]} ${(raw[6] << 25) >> 25} → ${DESTINATIONS[raw[7]] || raw[7]}`;
  if (c === 0x01) { const r = unnibble(raw, 5, PATCH_SIZE); return `Matrix-1000 patch ${raw[4]} "${patchName(r.data)}"${r.ok ? '' : ' (checksum error)'}`; }
  if (c === 0x0a) return `Matrix-1000 set bank ${raw[4]}`;
  if (c === 0x0e) return `Matrix-1000 store edit buffer to ${raw[5]}${String(raw[4]).padStart(2, '0')}`;
  return `Matrix-1000 ${name}`;
}

// ------------------------------------------------------------------ definition
const BANKS = Array.from({ length: 10 }, (_, b) => [b, `Bank ${b}${b < 2 ? ' (RAM)' : ' (ROM)'}`]);
const decodePatch = (raw) => unnibble(raw, 5, PATCH_SIZE).data;

export default {
  coverage: 'Every patch parameter, the modulation matrix and every master setting, read from and sent to the Matrix-1000 as found in the v1.13 firmware. Patch and master dumps, store, banks and group mode.',
  sysex: { manufacturer: [0x10], model: 0x06 },
  minGap: 20,
  describe,
  // Main Library import: Matrix-6/1000 messages (maker 10h, model 06h).
  recognise: (raw) => raw?.[0] === 0xf0 && raw[1] === HDR[1] && raw[2] === HDR[2],
  simulate,
  objects: [
    {
      key: 'patch', page: 'Patch', icon: '◆', label: 'Edit buffer', size: PATCH_SIZE, autoLoad: true,
      init: () => initPatch(),
      request: () => msg.request(4, 0),
      match: (raw) => isOb(raw) && raw[3] === 0x01,
      decode: decodePatch,
      params: patchParams,
      name: patchName,
      cols: 3,
      layout: [
        { group: 'DCO 1' }, { group: 'DCO 2' }, { group: 'Mix / VCF / VCA' }, { group: 'FM / tracking' },
        { group: 'Env 1' }, { group: 'Env 2' }, { group: 'Env 3' }, { group: 'LFO 1' }, { group: 'LFO 2' },
        { group: 'Portamento / ramps' }, { group: 'Voice' }, { group: 'Modulation matrix', rows: matrixRows, wide: true },
      ],
      note: 'Env 2 drives VCA 2 (the output level) on every Matrix patch. Changes go to the edit buffer only; store them into a RAM slot (banks 0 and 1) to keep them.',
      sendAll: { label: 'Send to edit buffer', title: 'Send the whole patch to the edit buffer (message 0D)', build: (data) => msg.toEditBuffer(data) },
      toSyx: (data) => msg.toEditBuffer(data),
      fromSyx: (msgs) => { const m = msgs.find((r) => isOb(r) && (r[3] === 0x01 || r[3] === 0x0d)); return m ? decodePatch(m) : null; },
      actions: [
        { label: 'Init', title: 'Start from a basic patch (not sent until you change something or press Send)', run: (api) => api.setData(initPatch()) },
      ],
      slots: {
        label: 'Patches', banks: BANKS, count: 100,
        slotLabel: (bank, i) => `${bank}${String(i).padStart(2, '0')}`,
        note: 'Banks 0-1 are RAM, 2-9 are the factory ROM. Play selects the bank (and locks it) and sends a program change on the module channel.',
        writable: (bank) => bank < 2,
        name: patchName,
        recall: (bank, i, ctx) => [msg.setBank(bank), [0xc0 | ctx.channel, i]],
        fetch: async (api, bank, i) => {
          api.send(msg.setBank(bank));
          return api.request(msg.request(1, i), (raw) => isOb(raw) && raw[3] === 0x01 && raw[4] === i, decodePatch);
        },
        store: (bank, i) => msg.storeEditBuffer(i, bank, 0),
        write: (bank, i, data) => [msg.setBank(bank), msg.patch(i, data)],
      },
    },
    {
      key: 'master', page: 'Master', icon: '⚙', label: 'Master settings', size: MASTER_SIZE, autoLoad: true,
      init: () => initMaster(),
      request: () => msg.request(3, 0),
      match: (raw) => isOb(raw) && raw[3] === 0x03,
      decode: (raw) => unnibble(raw, 5, MASTER_SIZE).data,
      params: masterParams,
      cols: 3,
      note: 'The Matrix-1000 applies master data as soon as it arrives, so each change sends the whole table. Bytes the firmware does not use (and the per-patch group bitmap in bytes 36-161) are kept as read.',
      toSyx: (data) => msg.master(data),
      fromSyx: (msgs) => { const m = msgs.find((r) => isOb(r) && r[3] === 0x03); return m ? unnibble(m, 5, MASTER_SIZE).data : null; },
    },
  ],
  // Librarian "Complete dump": the edit buffer and all ten banks (each with the master settings).
  // Selecting a bank locks it, so the dump ends by unlocking (no reply expected).
  fullDump: ['Edit buffer', ...Array.from({ length: 10 }, (_, b) => ({ request: `Bank ${b} (100 patches) + master`, timeout: 8000 })), { label: 'Unlock bank', bytes: () => msg.unlockBank(), timeout: 300, quiet: 300 }],
  requests: [
    { label: 'Edit buffer', bytes: () => msg.request(4, 0) },
    { label: 'Current bank (100 patches) + master', bytes: () => msg.request(0, 0) },
    { label: 'Master settings', bytes: () => msg.request(3, 0) },
    ...Array.from({ length: 10 }, (_, b) => ({ label: `Bank ${b} (100 patches) + master`, bytes: () => [...msg.setBank(b), ...msg.request(0, 0)] })),
  ],
  templates: [
    { label: 'Set bank 0 (locks the bank)', bytes: () => msg.setBank(0) },
    { label: 'Unlock bank', bytes: () => msg.unlockBank() },
    { label: 'Group mode on: 2 units, this is unit 0', bytes: () => msg.groupOn(2, 0) },
    { label: 'Group mode off', bytes: () => msg.groupOff() },
    { label: 'Store edit buffer to 000', bytes: () => msg.storeEditBuffer(0, 0, 0) },
    { label: 'Remote edit: VCF frequency (21) = 64', bytes: () => msg.param(21, 64) },
  ],
  midiNotes: [
    'CC 1/2/4/64 by default (lever 2, lever 3, pedal 1, pedal 2/sustain); assignable in Master.',
    'CC 7 volume, CC 121 reset controllers, CC 123 all notes off, CC 124/125 omni off/on, CC 126/127 mono/poly.',
    'CC 31 at 64 or more makes program changes 0-9 select a bank.',
    'NRPN (CC 99/98) selects a patch parameter by its remote number; CC 6 sets it as value - 64, CC 96/97 step it. RPN 0-2: bend range, fine and coarse tune.',
  ],
};

export const _test = { PATCH, patchParams, masterParams };
