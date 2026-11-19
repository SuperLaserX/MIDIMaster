// Value tables and display formatters for K2000 parameters.

import { lfoRateCentiHz, filterCoarseHz, envFilFreqCents, lfoPitchCents, envTimeMs } from './romtables.js';

export { lfoRateCentiHz, filterCoarseHz, envFilFreqCents, lfoPitchCents, envTimeMs };

import { noteName, parseNoteName } from '../../../core/music.js';
import { DSP_FUNCTIONS as FW_DSP_FUNCTIONS } from './fwparams.js';

/** K2000 key naming: C4 = MIDI 60. */
export { noteName, parseNoteName };

// Control sources, numbered as in the Kurzweil reference (K2500 guide chapter 6;
// values confirmed on the K2000: Data=6, AttVel=100, LFO1=114, LFO2=116, ENV2=121, ON=127).
const CS = {
  0: 'OFF', 1: 'MWheel', 2: 'Breath', 3: 'MIDI03', 4: 'Foot', 5: 'PortTim', 6: 'Data', 7: 'Volume',
  8: 'Balance', 9: 'MIDI09', 10: 'Pan', 11: 'Express',
  32: 'Chan St', 33: 'MPress', 34: 'BMPress', 35: 'PWheel', 36: 'Bi-MWhl', 37: 'AbsPWhl',
  38: 'GASR2', 39: 'GFUN2', 40: 'GLFO2', 41: 'GLFO2ph', 42: 'GFUN4',
  47: 'A Clk4', 48: '~A Clk4', 49: 'B Clk4', 50: '~B Clk4', 51: 'A Clk2', 52: '~A Clk2', 53: 'B Clk2', 54: '~B Clk2',
  55: 'Sync St', 56: 'A Clock', 57: '~A Clk', 58: 'B Clock', 59: '~B Clk',
  60: 'GPhase1', 61: 'GPhase2', 62: 'GRand1', 63: 'GRand2',
  64: 'Sustain', 65: 'PortSw', 66: 'SostPd', 67: 'SoftPd', 69: 'FrezPd',
  96: 'Note St', 97: 'Key St', 98: 'KeyNum', 99: 'BKeyNum', 100: 'AttVel', 101: 'InvAVel', 102: 'PPress',
  103: 'BPPress', 104: 'RelVel', 105: 'Bi-AVel', 106: 'VTRIG1', 107: 'VTRIG2', 108: 'RandV1', 109: 'RandV2',
  110: 'ASR1', 111: 'ASR2', 112: 'FUN1', 113: 'FUN2', 114: 'LFO1', 115: 'LFO1ph', 116: 'LFO2', 117: 'LFO2ph',
  118: 'FUN3', 119: 'FUN4', 120: 'AMPENV', 121: 'ENV2', 122: 'ENV3', 123: 'Loop St', 124: 'PB Rate',
  125: 'Atk St', 126: 'Rel St', 127: 'ON',
};

export function controlSourceName(v) {
  const s = v > 127 ? v - 256 : v;
  if (s < 0) return `-${controlSourceName(-s)}`;
  return CS[s] ?? `MIDI${String(s).padStart(2, '0')}`;
}

/** Options list for selects: all 128 sources (inverted forms are rarely used and omitted). */
export const CONTROL_SOURCES = Array.from({ length: 128 }, (_, v) => ({ value: v, label: `${v} ${controlSourceName(v)}` }));

// DSP function names come from the K2000 OS (see fwmodel.js / tools/k2000/extract_params.py).
export function dspFunctionName(code) {
  return FW_DSP_FUNCTIONS[code]?.name || `Function ${code}`;
}

// ------------------------------------------------------------ formatters
export const fmt = {
  raw: (v) => String(v),
  signed: (v) => (v > 0 ? `+${v}` : String(v)),
  note: (v) => `${noteName(v)} (${v})`,
  semitones: (v) => `${v > 0 ? '+' : ''}${v} ST`,
  cents: (v) => `${v > 0 ? '+' : ''}${v} ct`,
  percent: (v) => `${v}%`,
  db: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  halfDb: (v) => `${v > 0 ? '+' : ''}${(v / 2).toFixed(1)} dB`,
  control: (v) => controlSourceName(v),
  envTime: (v) => {
    const ms = envTimeMs[v & 0xff];
    return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : `${ms} ms`;
  },
  envLevel: (v) => `${v}%`,
  lfoRate: (v) => `${(lfoRateCentiHz[v & 0xff] / 100).toFixed(2)} Hz`,
  coarseHz: (v) => {
    const hz = filterCoarseHz[Math.max(0, Math.min(127, v + 48))];
    return `${noteName(v + 60)} ${hz >= 1000 ? (hz / 1000).toFixed(2) + ' kHz' : hz + ' Hz'}`;
  },
  freqDepth: (v) => `${envFilFreqCents[(v + 128) & 0xff]} ct`,
  pitchDepth: (v) => `${lfoPitchCents[(v + 128) & 0xff]} ct`,
  keyTrack: (v) => {
    const a = Math.abs(v);
    const ct = a <= 8 ? 5 * a : a <= 33 ? 40 + 2 * (a - 8) : 90 + (a - 33);
    return `${v < 0 ? '-' : ''}${ct} ct/key`;
  },
  dsp: (v) => dspFunctionName(v),
  velMark: (v) => ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'][v & 7],
  onOff: (v) => (v ? 'On' : 'Off'),
  hex: (v) => '0x' + v.toString(16).padStart(2, '0'),
};
