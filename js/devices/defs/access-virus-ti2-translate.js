// Access Virus TI / TI2 single and multi <-> the shared synth model (core/mainlib/common.js).
//
// A single has three oscillators (Osc 1/2 with the Classic, HyperSaw, Wavetable, Wave PWM, Grain
// and Formant models; Osc 3 a simple one), a sub oscillator and noise, two filters (Filter 1 with
// LP/HP/BP/BS and the analog 1-4 pole modes), four envelopes (filter, amplifier, Env 3/4), three
// LFOs and the effects. The shared model gets Osc 1-3, Filter 1 with the filter envelope, the
// amplifier, LFO 1-3, chorus, delay and reverb; another Virus TI gets the whole single back
// through `extra`. Offsets are those of Virus Control's description (access-virus-ti2-fw.js).

import { COMMON_MODEL, unit, fromUnit, bipolar, fromBipolar, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';

const FAMILY = 'access-virus-ti';
const MODEL = 'access-virus-ti2';
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));

// Single offsets (page * 128 + index)
const O = {
  portamento: 5, osc1Shape: 17, osc1Pw: 18, osc1Wave: 19, osc1Semi: 20, osc2Shape: 22, osc2Pw: 23, osc2Wave: 24, osc2Semi: 25, osc2Detune: 26,
  sync: 28, oscBalance: 33, subVolume: 34, noise: 37, cutoff1: 40, cutoff2: 41, res1: 42, env1: 44, key1: 46, ring: 50, mode1: 51,
  fenv: 54, aenv: 59, lfo1Rate: 67, lfo1Shape: 68, lfo2Rate: 79, lfo2Shape: 80, volume: 91, keyMode: 94, chorusType: 103, chorusMix: 105,
  chorusRate: 106, chorusDepth: 107, delaySend: 113, delayTime: 114, delayFeedback: 115, lfo3Rate: 135, lfo3Shape: 136, bendUp: 154, bendDown: 155,
  osc3Mode: 169, osc3Volume: 170, osc3Semi: 171, category1: 251, reverbSend: 258, reverbTime: 260, osc1Model: 286, osc2Model: 291, unison: 504, unisonDetune: 505,
  lfo1Osc: 74, lfo1Cutoff: 78,
};
const LFO_WAVES = ['sine', 'triangle', 'saw', 'square', 'sample-hold', 'sample-glide'];
const FROM_LFO = { sine: 0, triangle: 1, saw: 2, ramp: 2, square: 3, pulse: 3, 'sample-hold': 4, random: 4, 'sample-glide': 5 };
// Virus categories (Val Name Categories) -> Head Library categories
const CATS = ['none', 'soft-lead', 'synth-bass', 'soft-pad', 'synth-fx', 'plucked', 'techno-synth', 'other-synth', 'pulsating', 'sound-fx', 'drums', 'percussion', 'other-synth', 'vox', 'none', 'none', 'none', 'organ', 'ac-piano', 'strings', 'keyboards', 'other-synth', 'techno-synth'];
const CAT_FROM = { 'soft-lead': 1, 'hard-lead': 1, 'synth-bass': 2, bass: 2, 'soft-pad': 3, 'bright-pad': 3, plucked: 5, fretted: 5, 'techno-synth': 6, 'other-synth': 7, pulsating: 8, 'sound-fx': 9, 'synth-fx': 9, 'hit-stab': 9, drums: 10, 'beat-groove': 10, percussion: 11, mallet: 11, bell: 11, vox: 13, organ: 17, 'ac-piano': 18, 'el-piano': 18, keyboards: 20, strings: 19, orchestra: 19, 'synth-brass': 7, 'ac-brass': 7 };

/** A hash of the sound (name, category and patch management left out): equal for the same single. */
const match = (d) => {
  const x = Uint8Array.from(d);
  for (const o of [1, 2, 3, 251, 252]) x[o] = 0;
  for (let o = 240; o < 250; o++) x[o] = 0;
  return toBase64(x);
};

export const singleCategory = (d) => CATS[d[O.category1]] ?? 'none';
export function singleSetCategory(d, id) {
  const c = CAT_FROM[id];
  if (c !== undefined) d[O.category1] = c;
}

/** Osc 1/2 wave as a shared-model name: the model, then the Classic shape (0 spectral wave, 64 saw, 127 pulse). */
function oscWave(d, model, shape, wave) {
  const m = d[model];
  if (m === 1) return 'supersaw';
  if (m >= 2) return `rom:virus-wavetable-${d[wave]}`;
  const s = d[shape];
  if (s < 32) return d[wave] === 0 ? 'sine' : d[wave] === 1 ? 'triangle' : `rom:virus-wave-${d[wave] + 1}`;
  return s < 96 ? 'saw' : 'square';
}
const OSC3 = ['off', 'slave', 'saw', 'square', 'sine', 'triangle'];

// ------------------------------------------------------------------ single -> shared model
export function singleToCommon(d) {
  const env = (o) => ({ attack: unit(d[o]), decay: unit(d[o + 1]), sustain: unit(d[o + 2]), release: unit(d[o + 4]) });
  const mode1 = d[O.mode1];
  const osc3 = d[O.osc3Mode];
  return {
    model: COMMON_MODEL, kind: 'patch',
    voice: {
      mode: d[O.unison] > 0 ? 'unison' : d[O.keyMode] === 0 ? 'poly' : 'mono',
      portamento: { on: d[O.portamento] > 0, time: unit(d[O.portamento]) },
      bendUp: Math.abs(d[O.bendUp] - 64), bendDown: Math.abs(64 - d[O.bendDown]), unisonDetune: Math.round((d[O.unisonDetune] / 127) * 50),
    },
    osc: [
      { wave: oscWave(d, O.osc1Model, O.osc1Shape, O.osc1Wave), coarse: d[O.osc1Semi] - 64, fine: 0, pulseWidth: unit(d[O.osc1Pw]) },
      { wave: oscWave(d, O.osc2Model, O.osc2Shape, O.osc2Wave), coarse: d[O.osc2Semi] - 64, fine: Math.round((d[O.osc2Detune] / 127) * 50), pulseWidth: unit(d[O.osc2Pw]), sync: d[O.sync] > 0 },
      ...(osc3 > 0 ? [{ wave: OSC3[osc3] ?? `rom:virus-wave-${osc3 - 5}`, coarse: d[O.osc3Semi] - 64, fine: 0, level: unit(d[O.osc3Volume]) }] : []),
    ],
    mix: { balance: bipolar(d[O.oscBalance]), ring: d[O.ring] > 0, noise: unit(d[O.noise]), sub: unit(d[O.subVolume]) },
    pitch: { lfo1: bipolar(d[O.lfo1Osc]) },
    filter: {
      type: [0, 4, 5, 6, 7].includes(mode1) ? 'lpf' : mode1 === 1 ? 'hpf' : mode1 === 2 ? 'bpf' : 'notch',
      slope: mode1 >= 4 ? 6 * (mode1 - 3) : 12, cutoff: unit(d[O.cutoff1]), resonance: unit(d[O.res1]), keyTrack: bipolar(d[O.key1]),
      envDepth: unit(d[O.env1]), lfo1: bipolar(d[O.lfo1Cutoff]), env: env(O.fenv),
    },
    amp: { level: unit(d[O.volume]), env: env(O.aenv) },
    lfo: [
      { wave: LFO_WAVES[d[O.lfo1Shape]] ?? 'triangle', rate: unit(d[O.lfo1Rate]) },
      { wave: LFO_WAVES[d[O.lfo2Shape]] ?? 'triangle', rate: unit(d[O.lfo2Rate]) },
      { wave: LFO_WAVES[d[O.lfo3Shape]] ?? 'triangle', rate: unit(d[O.lfo3Rate]) },
    ],
    effects: {
      chorus: { level: d[O.chorusType] ? unit(d[O.chorusMix]) : 0, rate: unit(d[O.chorusRate]), depth: unit(d[O.chorusDepth]) },
      delay: { type: 'stereo', time: unit(d[O.delayTime]), feedback: unit(d[O.delayFeedback]), level: unit(d[O.delaySend]) },
      reverb: { level: unit(d[O.reverbSend]), time: unit(d[O.reverbTime]) },
    },
    extra: { family: FAMILY, model: MODEL, single: toBase64(d), match: match(d) },
  };
}

// ------------------------------------------------------------------ shared model -> single
const FROM_WAVE = { saw: [0, 64], ramp: [0, 64], 'hq-saw': [0, 64], 'la-saw': [0, 64], juno: [0, 64], square: [0, 127], pulse: [0, 127], 'hq-square': [0, 127], 'la-square': [0, 127], sine: [0, 0, 0], triangle: [0, 0, 1], supersaw: [1, 64], 'double-saw': [1, 64] };
function semanticToSingle(c, d, r) {
  const set = (o, v, what) => { if (v === undefined || v === null || Number.isNaN(v)) return; d[o] = clamp(v, 0, 127); r.mapped.push(what); };
  const v = c.voice || {};
  if (v.mode) {
    d[O.unison] = v.mode === 'unison' ? Math.max(1, d[O.unison]) : 0;
    d[O.keyMode] = v.mode === 'mono' || v.mode === 'legato' ? 1 : 0;
    r.mapped.push('Voice mode');
  }
  if (v.portamento) set(O.portamento, v.portamento.on ? fromUnit(v.portamento.time ?? 0.3) : 0, 'Portamento');
  if (v.bendUp !== undefined) set(O.bendUp, 64 + v.bendUp, 'Bender up');
  if (v.bendDown !== undefined) set(O.bendDown, 64 - v.bendDown, 'Bender down');
  if (v.unisonDetune !== undefined) set(O.unisonDetune, (v.unisonDetune / 50) * 127, 'Unison detune');
  const oscs = [[O.osc1Model, O.osc1Shape, O.osc1Wave, O.osc1Semi, O.osc1Pw], [O.osc2Model, O.osc2Shape, O.osc2Wave, O.osc2Semi, O.osc2Pw]];
  (c.osc || []).slice(0, 2).forEach((o, n) => {
    if (!o) return;
    const [model, shape, wave, semi, pw] = oscs[n];
    const w = FROM_WAVE[o.wave];
    if (w) { d[model] = w[0]; d[shape] = w[1]; if (w[2] !== undefined) d[wave] = w[2]; r.mapped.push(`Osc ${n + 1} wave`); } else if (o.wave) { d[model] = 0; d[shape] = 64; r.approximated.push(`Osc ${n + 1} wave ${o.wave} → saw`); }
    if (typeof o.coarse === 'number') set(semi, 64 + clamp(o.coarse, -48, 48), `Osc ${n + 1} semitone`);
    if (o.pulseWidth !== undefined) set(pw, fromUnit(o.pulseWidth), `Osc ${n + 1} pulse width`);
    if (n === 1 && o.fine !== undefined) set(O.osc2Detune, (Math.abs(o.fine) / 50) * 127, 'Osc 2 detune');
    if (n === 1 && o.sync !== undefined) { d[O.sync] = o.sync ? 1 : 0; r.mapped.push('Osc sync'); }
  });
  const o3 = (c.osc || [])[2];
  if (o3) {
    const m = OSC3.indexOf(o3.wave);
    d[O.osc3Mode] = m > 0 ? m : 2;
    if (m <= 0) r.approximated.push(`Osc 3 wave ${o3.wave} → saw`);
    if (typeof o3.coarse === 'number') d[O.osc3Semi] = 64 + clamp(o3.coarse, -48, 48);
    if (o3.level !== undefined) d[O.osc3Volume] = fromUnit(o3.level);
    r.mapped.push('Osc 3');
  }
  const m = c.mix || {};
  if (m.balance !== undefined) set(O.oscBalance, fromBipolar(m.balance), 'Osc balance');
  if (m.noise !== undefined) set(O.noise, fromUnit(m.noise), 'Noise');
  if (m.ring !== undefined) set(O.ring, m.ring ? 64 : 0, 'Ring modulator');
  if (m.sub !== undefined) set(O.subVolume, fromUnit(m.sub), 'Sub oscillator');
  const f = c.filter || {};
  if (f.type) {
    const t = { lpf: f.slope && f.slope !== 12 && f.slope !== 24 ? clamp(3 + f.slope / 6, 4, 7) : 0, hpf: 1, bpf: 2, notch: 3 }[f.type];
    if (t !== undefined) { d[O.mode1] = t; r.mapped.push('Filter type'); } else r.approximated.push(`Filter type ${f.type} → low pass`);
  }
  if (f.cutoff !== undefined) set(O.cutoff1, fromUnit(f.cutoff), 'Cutoff');
  if (f.resonance !== undefined) set(O.res1, fromUnit(f.resonance), 'Resonance');
  if (f.keyTrack !== undefined) set(O.key1, fromBipolar(f.keyTrack), 'Filter keyfollow');
  if (f.envDepth !== undefined) set(O.env1, fromUnit(Math.abs(f.envDepth)), 'Filter envelope amount');
  if (f.lfo1 !== undefined) set(O.lfo1Cutoff, fromBipolar(f.lfo1), 'LFO 1 to filter gain');
  const envTo = (o, e, what) => {
    if (!e) return;
    set(o, fromUnit(e.attack), `${what} attack`); set(o + 1, fromUnit(e.decay), `${what} decay`);
    set(o + 2, fromUnit(e.sustain), `${what} sustain`); set(o + 4, fromUnit(e.release), `${what} release`);
  };
  envTo(O.fenv, f.env, 'Filter envelope');
  const a = c.amp || {};
  envTo(O.aenv, a.env, 'Amp envelope');
  if (a.level !== undefined) set(O.volume, fromUnit(a.level), 'Patch volume');
  (c.lfo || []).slice(0, 3).forEach((l, n) => {
    if (!l) return;
    const [rate, shape] = [[O.lfo1Rate, O.lfo1Shape], [O.lfo2Rate, O.lfo2Shape], [O.lfo3Rate, O.lfo3Shape]][n];
    if (l.rate !== undefined) set(rate, fromUnit(l.rate), `LFO ${n + 1} rate`);
    const w = FROM_LFO[l.wave];
    if (w !== undefined) { d[shape] = w; r.mapped.push(`LFO ${n + 1} shape`); } else if (l.wave) r.approximated.push(`LFO ${n + 1} wave ${l.wave} left as it was`);
  });
  const fx = c.effects || {};
  const ch = fx.chorus || fx.modulation;
  if (ch && ch.level !== undefined) { d[O.chorusType] = ch.level > 0 ? Math.max(1, d[O.chorusType]) : 0; set(O.chorusMix, fromUnit(ch.level), 'Chorus'); }
  if (fx.delay) { set(O.delaySend, fromUnit(fx.delay.level ?? 0), 'Delay send'); set(O.delayTime, fromUnit(fx.delay.time ?? 0.3), 'Delay time'); set(O.delayFeedback, fromUnit(fx.delay.feedback ?? 0.3), 'Delay feedback'); }
  if (fx.reverb) { set(O.reverbSend, fromUnit(fx.reverb.level ?? 0), 'Reverb send'); if (fx.reverb.time !== undefined) set(O.reverbTime, fromUnit(fx.reverb.time), 'Reverb time'); }
}

export function singleFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.single) {
    const src = fromBase64(c.extra.single);
    d.set(src.subarray(0, d.length));
    r.mapped.push(`all ${Math.min(src.length, d.length)} single bytes (same family)`);
    return { data: d, report: r };
  }
  semanticToSingle(c, d, r);
  return { data: d, report: r };
}

// ------------------------------------------------------------------ multi
const PART = (ci, part) => 32 + 16 * (ci - 32) + part;
export function multiToCommon(d) {
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'multi', tempo: d[15] + 63,
    parts: Array.from({ length: 16 }, (_, i) => ({
      on: (d[240 + i] & 1) === 1, channel: d[PART(34, i)] & 15, bank: d[PART(32, i)], program: d[PART(33, i)],
      level: unit(d[PART(39, i)]), pan: bipolar(d[PART(43, i)]), transpose: d[PART(37, i)] - 64, low: d[PART(35, i)], high: d[PART(36, i)],
    })),
    extra: { family: FAMILY, model: MODEL, multi: toBase64(d), match: toBase64(Uint8Array.from(d.subarray(14))) },
  };
}
export function multiFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.multi) {
    const src = fromBase64(c.extra.multi);
    d.set(src.subarray(0, d.length));
    r.mapped.push(`all ${Math.min(src.length, d.length)} multi bytes (same family)`);
    return { data: d, report: r };
  }
  if (c.tempo) { d[15] = clamp(c.tempo - 63, 0, 127); r.mapped.push('Clock tempo'); }
  (c.parts || []).slice(0, 16).forEach((p, i) => {
    if (!p) return;
    if (p.on !== undefined) d[240 + i] = p.on ? d[240 + i] | 1 : d[240 + i] & ~1;
    if (typeof p.channel === 'number') d[PART(34, i)] = p.channel & 15;
    if (typeof p.program === 'number') d[PART(33, i)] = clamp(p.program, 0, 127);
    if (typeof p.bank === 'number' && p.bank <= 29) d[PART(32, i)] = p.bank;
    if (p.level !== undefined) d[PART(39, i)] = fromUnit(p.level);
    if (p.pan !== undefined) d[PART(43, i)] = fromBipolar(p.pan);
    if (p.transpose !== undefined) d[PART(37, i)] = clamp(64 + p.transpose, 16, 112);
    if (p.low !== undefined) d[PART(35, i)] = clamp(p.low, 0, 127);
    if (p.high !== undefined) d[PART(36, i)] = clamp(p.high, 0, 127);
    r.mapped.push(`Part ${i + 1}`);
  });
  if ((c.parts || []).length > 16) r.dropped.push(`parts ${17}-${c.parts.length}`);
  return { data: d, report: r };
}
