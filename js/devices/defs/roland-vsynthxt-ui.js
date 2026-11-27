// V-Synth XT (V-Synth engine): how the editor presents the firmware's parameters. No UI code here:
// these functions only adjust the built parameter lists (labels, option lists, which parameters a
// setting makes irrelevant) and describe the two pattern editors (core/ui/stepgrid.js draws them).
//
// Sources: the V-Synth XT Owner's Manual (oscillator pages p. 86-91, arpeggio Pattern Edit p. 65,
// E1-E8 knob sets p. 34 and 128) and the firmware's own names.

import { readParam } from '../../core/model/memmap.js';
import { PRESET_WAVES } from './roland-vsynthxt-waves.js';

/** The highest wave number a project holds (Internal.prj\Wave, 1-500). */
export const MAX_WAVE = 500;

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NOTES[n % 12]}${Math.floor(n / 12) - 1}`;

// ------------------------------------------------------------------ controller names
// Standard MIDI controller names, added to the firmware's "CC01" ... labels.
export const CC_NAMES = {
  0: 'Bank Select', 1: 'Modulation', 2: 'Breath', 4: 'Foot', 5: 'Portamento Time', 6: 'Data Entry', 7: 'Volume',
  8: 'Balance', 10: 'Pan', 11: 'Expression', 12: 'Effect 1', 13: 'Effect 2', 16: 'General 1', 17: 'General 2',
  18: 'General 3', 19: 'General 4', 32: 'Bank Select LSB', 64: 'Hold', 65: 'Portamento', 66: 'Sostenuto', 67: 'Soft',
  68: 'Legato', 69: 'Hold 2', 70: 'Sound Variation', 71: 'Resonance', 72: 'Release Time', 73: 'Attack Time',
  74: 'Cutoff', 75: 'Decay Time', 76: 'Vibrato Rate', 77: 'Vibrato Depth', 78: 'Vibrato Delay', 80: 'General 5',
  81: 'General 6', 82: 'General 7', 83: 'General 8', 84: 'Portamento Control', 91: 'Reverb', 92: 'Tremolo',
  93: 'Chorus', 94: 'Celeste', 95: 'Phaser', 96: 'Data Increment', 97: 'Data Decrement', 98: 'NRPN LSB', 99: 'NRPN MSB',
  100: 'RPN LSB', 101: 'RPN MSB',
};
export const ccLabel = (n) => `CC${String(n).padStart(2, '0')}${CC_NAMES[n] ? ` ${CC_NAMES[n]}` : ''}`;
/** "CC07" -> "CC07 Volume" in an option list. */
const nameCcOptions = (p) => {
  if (!p.options?.some(([, l]) => /^CC\d\d$/.test(l))) return;
  p.options = p.options.map(([v, l]) => [v, /^CC(\d\d)$/.test(l) ? ccLabel(Number(l.slice(2))) : l]);
};

// ------------------------------------------------------------------ system
// The 24 knob positions of the PATCH PLAY screen, as the XT labels them (read off the unit by the
// user; the firmware draws them, it has no list): User Set knob assignments 0-23.
export const KNOB_POSITIONS = [
  'OSC1-PRM1', 'OSC1-PRM2', 'OSC1-PRM3', 'OSC1-LFO1', 'OSC1-LFO2', 'OSC1-LFO3', 'OSC1-RATE', 'OSC1-LVL',
  'OSC2-PRM1', 'OSC2-PRM2', 'OSC2-PRM3', 'OSC2-LFO1', 'OSC2-LFO2', 'OSC2-LFO3', 'OSC2-RATE', 'OSC2-LVL',
  'CSM1-PRM1', 'CSM1-PRM2', 'CSM2-PRM1', 'CSM2-PRM2', 'TVA-ATK', 'TVA-DCY', 'TVA-SUS', 'TVA-REL',
];
/**
 * System page: Part n Patch (one list for bank select MSB/LSB and program), receive channels and
 * knob positions as lists, controller names.
 * opts: { dt1Of(at, bytes, ctx) -> message, slotNo(n) -> "U001" }
 */
export function presentSystem(built, { dt1Of, slotNo }) {
  const params = built.params;
  for (const p of params) {
    nameCcOptions(p);
    if (/Receive Channel$|^V-LINK Channel$/.test(p.name) && !p.options && p.format) {
      p.options = Array.from({ length: p.max - p.min + 1 }, (_, k) => [p.min + k, p.format(p.min + k).trim()]);
    }
    const us = /^User Set (\d+) Knob (\d+) Parameter Assign$/.exec(p.name);
    if (us) {
      p.label = `User Set ${us[1]} Knob E${us[2]}`;
      p.options = Array.from({ length: p.max - p.min + 1 }, (_, k) => [p.min + k, KNOB_POSITIONS[p.min + k] ?? `Position ${p.min + k}`]);
      p.help = 'Which of the 24 knobs of the PATCH PLAY screen this E knob controls (the names the XT shows there).';
    }
  }
  // Part n: bank select MSB, LSB and program number become one list of the XT's patches
  const added = [];
  for (let n = 1; n <= 16; n++) {
    const msb = params.find((p) => p.name === `Part ${n} Bank Select MSB (CC# 0)`);
    const lsb = params.find((p) => p.name === `Part ${n} Bank Select LSB (CC# 32)`);
    const pc = params.find((p) => p.name === `Part ${n} Program Number (PC)`);
    if (!msb || !lsb || !pc || lsb.offset !== msb.offset + 1 || pc.offset !== msb.offset + 2) continue;
    for (const p of [msb, lsb, pc]) p.hidden = true;
    const part = {
      key: `${msb.key}_patch`, label: `Part ${n} Patch`, name: `Part ${n} Patch`, section: msb.section, group: 'Part patches',
      offset: msb.offset, at: msb.at, size: 3, min: 0, max: 127 * 16384 + 127 * 128 + 127,
      get: (d) => d[msb.offset] * 16384 + d[msb.offset + 1] * 128 + d[msb.offset + 2],
      set: (d, v) => { d[msb.offset] = (v >> 14) & 127; d[msb.offset + 1] = (v >> 7) & 127; d[msb.offset + 2] = v & 127; },
      send: (_v, ctx, d) => dt1Of(msb.at, Array.from(d.slice(msb.offset, msb.offset + 3)), ctx),
      readOnly: true,
      help: `The patch Part ${n} plays. Choose patches in the Patch page's list.`,
      dynamic: (d, ctx) => {
        const names = ctx?.names?.patch;
        const options = [];
        for (let i = 0; i < 512; i++) {
          const name = names?.get(`${i >> 7}:${i & 127}`);
          options.push([87 * 16384 + i, `${slotNo(i)}${name ? ` ${name}` : ''}`]);
        }
        const v = d ? part.get(d) : options[0][0];
        if (!options.some(([x]) => x === v)) options.push([v, `Bank ${v >> 14}/${(v >> 7) & 127}, program ${(v & 127) + 1}`]);
        return { options };
      },
    };
    added.push([params.indexOf(msb), part]);
  }
  for (const [i, p] of added.reverse()) params.splice(i, 0, p);
}

// ------------------------------------------------------------------ patch: oscillators
// Parameter ids (firmware) of OSC 1; OSC 2 is +34h, its Detune and Sub Oscillator +3.
const OSC = {
  type: 0x2a5, waveform: 0x2b1, subOctave: 0x30e,
  analog: [0x2b1, 0x2b2, 0x2b3, 0x2b4, 0x2b5, 0x2b6, 0x2b7, 0x2b8, 0x2b9, 0x2ba],
  pw: [0x2b3, 0x2b4, 0x2b5, 0x2b6], fat: [0x2b7, 0x2b8, 0x2b9, 0x2ba],
  sub: [0x30e, 0x30f], detune: 0x30d,
  pcm: [0x2be, 0x2c6, 0x2c7, 0x2c8, 0x2c9, 0x2ca, 0x2cb, 0x2cc, 0x2cd, 0x2ce, 0x2cf, 0x2d0, 0x2d1, 0x2d2, 0x2d3, 0x2d4, 0x2d5, 0x2d6, 0x2d7],
  wave: 0x2be,
};
const osc2 = (id) => (id >= 0x30d ? id + 3 : id + 0x34);
// Analog waveforms (OM p. 86): what the third and fourth tabs (Pulse Width, Fat) control
const PW_NAME = { 11: 'Detune', 12: 'Harmonics', 13: 'X-MOD' };
const FAT_NAME = { 11: 'Mix', 12: 'FBK Amount' };
// waveforms with the sub-oscillator (then Fat is ignored and Detune applies): SAW, SQUARE,
// TRIANGLE, SINE, RAMP, JUNO, LA-SAW, LA-SQUARE
const SUB_OK = new Set([0, 1, 2, 3, 4, 5, 9, 10]);

/**
 * Oscillator parameters shown for the OSC Type and waveform in use, with the names the XT gives
 * them; the PCM wave as a list of wave names. waveNames: Map number -> name read from the XT.
 */
export function presentOscillators(built, waveNames) {
  const byZone = new Map();
  for (const p of built.params) {
    const z = /^t(\d+)_/.exec(p.key)?.[1];
    if (z === undefined) continue;
    if (!byZone.has(z)) byZone.set(z, new Map());
    byZone.get(z).set(p.fwId, p);
    if (/Wavefrom/.test(p.label)) p.label = p.label.replace('Wavefrom', 'Waveform');
  }
  for (const ps of byZone.values()) {
    for (const k of [0, 1]) {
      const id = (x) => (k ? osc2(x) : x);
      const type = ps.get(id(OSC.type));
      const wf = ps.get(id(OSC.waveform));
      const subOct = ps.get(id(OSC.subOctave));
      if (!type || !wf || !subOct) continue;
      for (const p of [type, wf, subOct]) p.relayout = true;
      const state = (d) => {
        if (!d) return { type: 1, wf: 0, sub: false };
        const w = readParam(d, wf);
        return { type: readParam(d, type), wf: w, sub: SUB_OK.has(w) && readParam(d, subOct) !== 0 };
      };
      const n = k + 1;
      const rename = (p, from, to) => p.label.replace(`OSC ${n} ${from}`, `OSC ${n} ${to}`);
      const hideUnless = (p, show, label) => {
        const prev = p.dynamic;
        p.dynamic = (d, ctx) => {
          const s = state(d);
          return { ...(prev ? prev(d, ctx) : {}), hidden: !show(s), ...(label ? { label: label(s) } : {}) };
        };
      };
      for (const x of OSC.analog) {
        const p = ps.get(id(x));
        if (!p) continue;
        if (OSC.pw.includes(x)) hideUnless(p, (s) => s.type === 0, (s) => rename(p, 'Pulse Width', PW_NAME[s.wf] || 'Pulse Width'));
        else if (OSC.fat.includes(x)) hideUnless(p, (s) => s.type === 0 && !s.sub, (s) => rename(p, 'Fat', FAT_NAME[s.wf] || 'Fat'));
        else hideUnless(p, (s) => s.type === 0);
      }
      for (const x of OSC.sub) { const p = ps.get(id(x)); if (p) hideUnless(p, (s) => s.type === 0 && SUB_OK.has(s.wf)); }
      const det = ps.get(id(OSC.detune));
      if (det) { det.label = `OSC ${n} Sub Oscillator Detune`; hideUnless(det, (s) => s.type === 0 && s.sub); }
      for (const x of OSC.pcm) { const p = ps.get(id(x)); if (p) hideUnless(p, (s) => s.type === 1); }
      const wave = ps.get(id(OSC.wave));
      if (wave) {
        const prev = wave.dynamic;
        wave.label = `OSC ${n} Wave`;
        wave.dynamic = (d, ctx) => {
          const base = prev(d, ctx);
          if (base.hidden) return base;
          // every wave the project can hold (1-500: FUN_89480e30 takes no more): the preset names,
          // names read from the XT, and the rest as user samples (model 00 24 names only waves the XT
          // has loaded, so samples copied onto its drive are selectable by number)
          const names = new Map(PRESET_WAVES.map((x, i) => [i + 1, x]));
          for (const [num, name] of waveNames) names.set(num, name);
          const v = d ? readParam(d, wave) : 1;
          const last = Math.max(MAX_WAVE, v);
          const options = [[0, 'OFF']];
          for (let num = 1; num <= last; num++) options.push([num, `${String(num).padStart(3, '0')} ${names.get(num) ?? '(user sample)'}`]);
          return { ...base, options };
        };
      }
    }
  }
}

// ------------------------------------------------------------------ patch: pattern editors
/**
 * Multi Step Modulator: four tracks of 16 steps (-63..+63). Step values, track switch and
 * destination go into one "Step tracks" card drawn as a step grid / tracker; the other track
 * settings stay in their cards.
 */
export function presentStepModulator(built, groupInfo) {
  const ps = built.params.filter((p) => p.section === 'seq');
  const tracks = [1, 2, 3, 4].map((t) => ({
    t,
    steps: Array.from({ length: 16 }, (_, i) => ps.find((p) => p.name === `Track ${t} Step ${String(i + 1).padStart(2, '0')} Value`)),
    sw: ps.find((p) => p.name === `Track ${t} Switch`),
    dest: ps.find((p) => p.name === `Track ${t} Destination`),
    end: ps.find((p) => p.name === `Track ${t} End Point`),
  }));
  for (const tr of tracks) {
    for (const p of [...tr.steps, tr.sw, tr.dest]) if (p) p.group = 'Step tracks';
    for (const p of [tr.sw, tr.end, tr.dest]) if (p) p.relayout = true;
  }
  groupInfo['Step tracks'] = {
    wide: true,
    note: 'Four tracks of 16 steps, each step a value from -63 to +63 sent to the track\'s destination. Type, grid, end point, direction and zone are in each track\'s card.',
    pattern: ({ data }) => ({
      length: 16,
      lanes: tracks.map((tr) => ({
        label: `Track ${tr.t}`,
        kind: 'bar', steps: tr.steps, min: 1, max: 127, zero: 64, offset: -64,
        header: [tr.sw, tr.dest].filter(Boolean),
        muted: tr.sw ? readParam(data, tr.sw) === 0 : false,
        end: tr.end ? readParam(data, tr.end) + 1 : 16,
      })),
    }),
  };
}

/**
 * Arpeggio pattern (OM p. 65): 32 steps x 16 lines. Each line plays a note (NOTE: the line's note
 * number) or sends a control change (CTRL: the line's controller); a step holds the velocity or CC
 * value, a rest or a tie. The firmware calls a line's state "Control Switch" and its note or
 * controller "Control Number".
 */
export function presentArpeggio(built, groupInfo) {
  const end = built.params.find((p) => p.name === 'Arpeggio End Point');
  const grid = built.params.find((p) => p.name === 'Arpeggio Grid');
  if (end) end.relayout = true;
  const lines = [];
  for (let n = 0; n < 16; n++) {
    const ps = built.params.filter((p) => p.key.startsWith(`st${n}_`));
    const sw = ps.find((p) => p.name === 'Control Switch');
    const num = ps.find((p) => p.name === 'Control Number');
    const steps = Array.from({ length: 32 }, (_, i) => ps.find((p) => p.name === `Step ${i + 1} Velocity`));
    if (!sw || !num || steps.some((p) => !p)) continue;
    for (const p of ps) p.group = 'Arpeggio pattern';
    sw.label = 'State';
    sw.relayout = true;
    num.dynamic = (d) => {
      const ctrl = d ? readParam(d, sw) === 1 : false;
      return {
        label: ctrl ? 'Controller' : 'Note',
        options: Array.from({ length: 128 }, (_, v) => [v, ctrl ? ccLabel(v) : noteName(v)]),
      };
    };
    lines.push({ n, sw, num, steps });
  }
  groupInfo['Arpeggio pattern'] = {
    wide: true,
    note: 'The arpeggio pattern the arpeggiator plays when its Motif uses it: 32 steps by 16 lines. Each line is a note (NOTE) or a controller (CTRL); each step holds a velocity or controller value (1-127), a rest or a tie. Grid and end point are with the arpeggio settings.',
    pattern: ({ data }) => ({
      length: 32,
      end: end ? readParam(data, end) + 1 : 32,
      stepLabel: (i) => String(i + 1),
      lanes: lines.map((l) => {
        const ctrl = readParam(data, l.sw) === 1;
        const v = readParam(data, l.num);
        return {
          label: `Line ${l.n + 1}: ${ctrl ? ccLabel(v) : noteName(v)}`,
          kind: 'note', steps: l.steps, min: 1, max: 127, rest: 0, tie: 128, on: 100,
          header: [l.sw, l.num],
        };
      }),
    }),
  };
  return { grid };
}
