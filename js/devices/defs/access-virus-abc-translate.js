// Access Virus A / B / C (and Classic, kb, Indigo, Rack, KC, Indigo 2, Rack XL) single and multi <-> the shared
// synth model (core/mainlib/common.js).
//
// A single is 256 bytes: page A (bytes 0-127, the MIDI controller numbers) and page B (128-255), the parameters the
// host OS menus and panel knobs edit (access-virus-abc.js). The shared model gets Osc 1-3, the sub oscillator, noise
// and ring modulator, Filter 1 with the filter envelope, the amplifier, LFO 1-3, chorus and the delay / reverb;
// another A / B / C model gets the whole single back through `extra`. A Virus TI single carries the same pages A / B
// with a few parameters moved (the TI's OS keeps their old places): those are taken from the TI's places.
// A multi is the 256-byte multi the TI kept: 16 parts, page C index ci of part p at 32 + 16 * (ci - 32) + p.

import { COMMON_MODEL, unit, fromUnit, bipolar, fromBipolar, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';

const FAMILY = 'access-virus-abc';
const TI_FAMILY = 'access-virus-ti';
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));

// Single offsets (page A index, 128 + page B index), from the B / C host OS menus and knobs
const O = {
  portamento: 5, osc1Shape: 17, osc1Pw: 18, osc1Wave: 19, osc1Semi: 20, osc2Shape: 22, osc2Pw: 23, osc2Wave: 24, osc2Semi: 25, osc2Detune: 26,
  fm: 27, sync: 28, oscBalance: 33, subVolume: 34, subShape: 35, noise: 37, ring: 38, cutoff1: 40, cutoff2: 41, res1: 42, env1: 44, key1: 46,
  mode1: 51, fenv: 54, aenv: 59, lfo1Rate: 67, lfo1Shape: 68, lfo1Osc: 74, lfo1Cutoff: 78, lfo2Rate: 79, lfo2Shape: 80, volume: 91,
  keyMode: 94, unison: 97, unisonDetune: 98, chorusOn: 104, chorusMix: 105, chorusRate: 106, chorusDepth: 107, fxMode: 112, fxSend: 113,
  fxTime: 114, fxFeedback: 115, fxRate: 116, lfo3Rate: 135, lfo3Shape: 136, bendUp: 154, bendDown: 155, osc3Mode: 169, osc3Volume: 170,
  osc3Semi: 171, name: 240, category1: 251,
};
/** Where a Virus TI single keeps the parameters it moved (TI byte -> A/B/C byte), as the TI's OS converts older sounds. */
const TI_MOVED = { 50: 38, 504: 97, 505: 98, 506: 99, 507: 100, 508: 101, 509: 102, 143: 129 };
const LFO_WAVES = ['sine', 'triangle', 'saw', 'square', 'sample-hold', 'sample-glide'];
const FROM_LFO = { sine: 0, triangle: 1, saw: 2, ramp: 2, square: 3, pulse: 3, 'sample-hold': 4, random: 4, 'sample-glide': 5 };
// Category 1 (B 123: Off, Lead, Bass, Pad, Decay, Pluck, Acid, Classic, Arpeggiator, Effects, Drums, Percussion,
// Input, Vocoder, Favourites 1-3; the C OS 6.6 adds Organ, Piano, String, FM, Digital) -> Head Library categories
const CATS = ['none', 'soft-lead', 'synth-bass', 'soft-pad', 'synth-fx', 'plucked', 'techno-synth', 'other-synth', 'pulsating', 'sound-fx', 'drums', 'percussion', 'other-synth', 'vox', 'none', 'none', 'none',
  'organ', 'ac-piano', 'strings', 'other-synth', 'other-synth'];
const CAT_FROM = { 'soft-lead': 1, 'hard-lead': 1, 'synth-bass': 2, bass: 2, 'soft-pad': 3, 'bright-pad': 3, plucked: 5, fretted: 5, 'techno-synth': 6, 'other-synth': 7, pulsating: 8, 'sound-fx': 9, 'synth-fx': 9, 'hit-stab': 9, drums: 10, 'beat-groove': 10, percussion: 11, mallet: 11, bell: 11, vox: 13,
  organ: 17, 'ac-piano': 18, 'el-piano': 18, keyboards: 18, strings: 19, orchestra: 19 };

const match = (d) => {
  const x = Uint8Array.from(d.subarray(0, 256));
  for (let o = 240; o < 250; o++) x[o] = 0;
  x[251] = 0; x[252] = 0;
  return toBase64(x);
};

export const singleCategory = (d) => CATS[d[O.category1]] ?? 'none';
/** maxCat: the last category the model's OS offers (16 on the B / Classic, 21 on the C). */
export function singleSetCategory(d, id, maxCat = 16) {
  const c = CAT_FROM[id];
  if (c !== undefined && c <= maxCat) d[O.category1] = c;
}

function oscWave(d, shape, wave) {
  const s = d[shape];
  if (s < 32) return d[wave] === 0 ? 'sine' : d[wave] === 1 ? 'triangle' : `rom:virus-wave-${d[wave] + 1}`;
  return s < 96 ? 'saw' : 'square';
}
const OSC3 = ['off', 'slave', 'saw', 'square', 'sine', 'triangle'];
/** Delay / reverb mode (A 112): 0 Off, 1 Delay, 2-? delay patterns, reverb types from the screen's list. */
const isReverb = (mode, modeTexts) => /Rev|Room|Hall|Ambience|Chamber|Plate/i.test(modeTexts?.[mode] ?? '');

// ------------------------------------------------------------------ single -> shared model
export function singleToCommon(d, model = 'access-virus-b', fxModes = null) {
  const env = (o) => ({ attack: unit(d[o]), decay: unit(d[o + 1]), sustain: unit(d[o + 2]), release: unit(d[o + 4]) });
  const mode1 = d[O.mode1];
  const osc3 = d[O.osc3Mode];
  const fx = d[O.fxMode];
  const rev = fx > 1 && isReverb(fx, fxModes);
  return {
    model: COMMON_MODEL, kind: 'patch',
    voice: {
      mode: d[O.unison] > 0 ? 'unison' : d[O.keyMode] === 0 ? 'poly' : 'mono',
      portamento: { on: d[O.portamento] > 0, time: unit(d[O.portamento]) },
      bendUp: Math.abs(d[O.bendUp] - 64), bendDown: Math.abs(64 - d[O.bendDown]), unisonDetune: Math.round((d[O.unisonDetune] / 127) * 50),
    },
    osc: [
      { wave: oscWave(d, O.osc1Shape, O.osc1Wave), coarse: d[O.osc1Semi] - 64, fine: 0, pulseWidth: unit(d[O.osc1Pw]) },
      { wave: oscWave(d, O.osc2Shape, O.osc2Wave), coarse: d[O.osc2Semi] - 64, fine: Math.round((d[O.osc2Detune] / 127) * 50), pulseWidth: unit(d[O.osc2Pw]), sync: d[O.sync] > 0 },
      ...(osc3 > 0 ? [{ wave: OSC3[osc3] ?? `rom:virus-wave-${osc3 - 5}`, coarse: d[O.osc3Semi] - 64, fine: 0, level: unit(d[O.osc3Volume]) }] : []),
    ],
    mix: { balance: bipolar(d[O.oscBalance]), ring: d[O.ring] > 0, noise: unit(d[O.noise]), sub: unit(d[O.subVolume]) },
    pitch: { lfo1: bipolar(d[O.lfo1Osc]) },
    filter: {
      type: mode1 === 0 ? 'lpf' : mode1 === 1 ? 'hpf' : mode1 === 2 ? 'bpf' : 'notch', slope: 12,
      cutoff: unit(d[O.cutoff1]), resonance: unit(d[O.res1]), keyTrack: bipolar(d[O.key1]), envDepth: unit(d[O.env1]), lfo1: bipolar(d[O.lfo1Cutoff]), env: env(O.fenv),
    },
    amp: { level: unit(d[O.volume]), env: env(O.aenv) },
    lfo: [
      { wave: LFO_WAVES[d[O.lfo1Shape]] ?? 'triangle', rate: unit(d[O.lfo1Rate]) },
      { wave: LFO_WAVES[d[O.lfo2Shape]] ?? 'triangle', rate: unit(d[O.lfo2Rate]) },
      { wave: LFO_WAVES[d[O.lfo3Shape]] ?? 'triangle', rate: unit(d[O.lfo3Rate]) },
    ],
    effects: {
      chorus: { level: d[O.chorusOn] ? unit(d[O.chorusMix]) : 0, rate: unit(d[O.chorusRate]), depth: unit(d[O.chorusDepth]) },
      ...(fx && !rev ? { delay: { type: 'stereo', time: unit(d[O.fxTime]), feedback: unit(d[O.fxFeedback]), level: unit(d[O.fxSend]) } } : {}),
      ...(rev ? { reverb: { level: unit(d[O.fxSend]), time: unit(d[O.fxRate]) } } : {}),
    },
    extra: { family: FAMILY, model, single: toBase64(d.subarray(0, 256)), match: match(d) },
  };
}

// ------------------------------------------------------------------ shared model -> single
const FROM_WAVE = { saw: [64], ramp: [64], 'hq-saw': [64], 'la-saw': [64], juno: [64], supersaw: [64], 'double-saw': [64], square: [127], pulse: [127], 'hq-square': [127], 'la-square': [127], sine: [0, 0], triangle: [0, 1] };
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
  const oscs = [[O.osc1Shape, O.osc1Wave, O.osc1Semi, O.osc1Pw], [O.osc2Shape, O.osc2Wave, O.osc2Semi, O.osc2Pw]];
  (c.osc || []).slice(0, 2).forEach((o, n) => {
    if (!o) return;
    const [shape, wave, semi, pw] = oscs[n];
    const w = FROM_WAVE[o.wave];
    if (w) { d[shape] = w[0]; if (w[1] !== undefined) d[wave] = w[1]; r.mapped.push(`Osc ${n + 1} wave`); } else if (o.wave) { d[shape] = 64; r.approximated.push(`Osc ${n + 1} wave ${o.wave} → saw`); }
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
    const t = { lpf: 0, hpf: 1, bpf: 2, notch: 3 }[f.type];
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
  if (ch && ch.level !== undefined) { d[O.chorusOn] = ch.level > 0 ? 1 : 0; set(O.chorusMix, fromUnit(ch.level), 'Chorus'); }
  if (fx.delay && (fx.delay.level ?? 0) > 0) {
    d[O.fxMode] = 1;
    set(O.fxSend, fromUnit(fx.delay.level ?? 0), 'Delay send'); set(O.fxTime, fromUnit(fx.delay.time ?? 0.3), 'Delay time'); set(O.fxFeedback, fromUnit(fx.delay.feedback ?? 0.3), 'Delay feedback');
  } else if (fx.reverb && (fx.reverb.level ?? 0) > 0) r.approximated.push('Reverb: the delay / reverb section keeps its mode (choose a reverb type on the Virus)');
}

/** A single from the shared model; a Virus TI single gives its pages A / B with the moved parameters taken back. */
export function singleFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.single) {
    d.set(fromBase64(c.extra.single).subarray(0, 256));
    r.mapped.push('all 256 single bytes (same family)');
    return { data: d, report: r };
  }
  if (c.extra?.family === TI_FAMILY && c.extra.single) {
    const ti = fromBase64(c.extra.single);
    const fmt = d[0];
    d.set(ti.subarray(0, 256));
    d[0] = fmt;
    for (const [from, to] of Object.entries(TI_MOVED)) if (ti.length > from) d[to] = ti[from];
    r.mapped.push('pages A and B of the Virus TI single (its moved Unison, Input, Ring Modulator and Arpeggiator Mode taken back)');
    r.dropped.push('pages C and D of the TI single (TI-only parameters)');
    return { data: d, report: r };
  }
  semanticToSingle(c, d, r);
  return { data: d, report: r };
}

// ------------------------------------------------------------------ multi
const PART = (ci, part) => 32 + 16 * (ci - 32) + part;
export function multiToCommon(d, model = 'access-virus-b') {
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'multi', tempo: d[15] + 63,
    parts: Array.from({ length: 16 }, (_, i) => ({
      on: (d[240 + i] & 1) === 1, channel: d[PART(34, i)] & 15, bank: d[PART(32, i)], program: d[PART(33, i)],
      level: unit(d[PART(39, i)]), pan: bipolar(d[PART(43, i)]), transpose: d[PART(37, i)] - 64, low: d[PART(35, i)], high: d[PART(36, i)],
    })),
    extra: { family: FAMILY, model, multi: toBase64(d), match: toBase64(Uint8Array.from(d.subarray(14))) },
  };
}
export function multiFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if ((c.extra?.family === FAMILY || c.extra?.family === TI_FAMILY) && c.extra.multi) {
    const src = fromBase64(c.extra.multi);
    d.set(src.subarray(0, Math.min(src.length, 256)));
    r.mapped.push(`all 256 multi bytes (${c.extra.family === FAMILY ? 'same family' : 'the Virus TI keeps the same multi layout'})`);
    return { data: d, report: r };
  }
  if (c.tempo) { d[15] = clamp(c.tempo - 63, 0, 127); r.mapped.push('Clock tempo'); }
  (c.parts || []).slice(0, 16).forEach((p, i) => {
    if (!p) return;
    if (p.on !== undefined) d[240 + i] = p.on ? d[240 + i] | 1 : d[240 + i] & ~1;
    if (typeof p.channel === 'number') d[PART(34, i)] = p.channel & 15;
    if (typeof p.bank === 'number') d[PART(32, i)] = clamp(p.bank, 0, 7);
    if (typeof p.program === 'number') d[PART(33, i)] = clamp(p.program, 0, 127);
    if (p.level !== undefined) d[PART(39, i)] = fromUnit(p.level);
    if (p.pan !== undefined) d[PART(43, i)] = fromBipolar(p.pan);
    if (p.transpose !== undefined) d[PART(37, i)] = clamp(64 + p.transpose, 16, 112);
    if (p.low !== undefined) d[PART(35, i)] = clamp(p.low, 0, 127);
    if (p.high !== undefined) d[PART(36, i)] = clamp(p.high, 0, 127);
    r.mapped.push(`Part ${i + 1}`);
  });
  return { data: d, report: r };
}
