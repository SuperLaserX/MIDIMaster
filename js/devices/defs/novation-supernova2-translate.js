// SuperNova II program and performance <-> the shared synth model (core/mainlib/common.js).
//
// A program has three oscillators (square, saw, double saw or an audio input; pulse width,
// "harden" and sync), a six-source mixer with ring modulators, two LFOs, three envelopes (Env 1
// amplitude, Env 2 and Env 3 free), one filter (12 types, 12/18/24 dB), effects and an
// arpeggiator. The shared model describes OSC 1/2 and one voice, so a SuperNova program becomes:
// osc 1-3, the Osc 1/2 mix as the balance, Env 2 as the filter envelope (its Freq mod. Env 2
// depth), Env 1 as the amplifier, LFO 1/2, chorus and delay. Another SuperNova II gets the whole
// program back through `extra`.

import { COMMON_MODEL, unit, fromUnit, bipolar, fromBipolar, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';

const FAMILY = 'novation-sn2';
const WAVES = ['square', 'saw', 'input:1', 'input:2', 'double-saw'];
const FROM_WAVE = { square: 0, pulse: 0, saw: 1, ramp: 1, 'input:1': 2, 'input:2': 3, 'double-saw': 4, supersaw: 4, 'hq-saw': 1, 'la-saw': 1, juno: 1, 'hq-square': 0, 'la-square': 0 };
const LFO_WAVES = ['square', 'saw', 'triangle', 'sample-hold'];
const CATS = ['synth-bass', 'synth-bass', 'soft-lead', 'hard-lead', 'soft-lead', 'pulsating', 'pulsating', 'bell', 'soft-pad', 'strings', 'keyboards', 'synth-fx', 'drums', 'ac-piano', 'organ', 'synth-brass', 'none', 'none', 'none', 'none'];
const CAT_FROM = { 'synth-bass': 0, bass: 0, 'soft-lead': 2, 'hard-lead': 3, pulsating: 5, 'techno-synth': 6, bell: 7, mallet: 7, 'soft-pad': 8, 'bright-pad': 8, strings: 9, orchestra: 9, keyboards: 10, 'el-piano': 10, 'synth-fx': 11, 'sound-fx': 11, drums: 12, percussion: 12, 'ac-piano': 13, organ: 14, 'synth-brass': 15, 'ac-brass': 15 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
const OSC = (n) => 22 + 34 * n; // oscillator n block
const FX = 254; // program effects

/** A hash of the sound (name left out): equal for the same program (Head Library duplicate search). */
const match = (d) => toBase64(Uint8Array.from(d.subarray(16)));

export const programCategory = (d) => CATS[d[17]] ?? 'none';
export function programSetCategory(d, id) {
  const c = CAT_FROM[id];
  if (c !== undefined) d[17] = c;
}

// ------------------------------------------------------------------ program -> shared model
export function programToCommon(d) {
  const osc = [0, 1, 2].map((n) => {
    const b = OSC(n);
    const wave = WAVES[d[b] - 10 * n] ?? 'saw';
    const octave = d[b + 1] - (32 + 5 * n);
    const semi = d[b + 2] - (57 + 25 * n);
    return {
      wave, coarse: octave * 12 + semi, fine: Math.round(((d[b + 3] - 64) / 64) * 50),
      pulseWidth: unit(d[b + 19]), control1: unit(d[b + 13]), control2: unit(d[b + 25]), sync: d[b + 25] > 0, level: unit(d[124 + 6 * n]),
    };
  });
  const filterType = d[207];
  const type = [3, 6, 10].includes(filterType) || filterType === 13 ? 'lpf' : [4, 7, 11, 14].includes(filterType) ? 'bpf' : [5, 8, 12].includes(filterType) ? 'hpf' : filterType === 9 ? 'notch' : 'lpf';
  const env = (b) => ({ attack: unit(d[b]), decay: unit(d[b + 1]), sustain: unit(d[b + 2]), release: unit(d[b + 3]) });
  const l1 = osc[0].level ?? 0;
  const l2 = osc[1].level ?? 0;
  return {
    model: COMMON_MODEL, kind: 'patch',
    voice: {
      mode: d[238] & 0x20 ? 'unison' : 'poly', portamento: { on: d[231] > 0, time: unit(d[231]) },
      bendUp: Math.abs(d[OSC(0) + 4] - 64), bendDown: Math.abs(d[OSC(0) + 4] - 64), unisonDetune: Math.round((d[288] / 127) * 50), octave: d[OSC(0) + 1] - 32,
    },
    osc,
    mix: { balance: l1 + l2 ? (l2 - l1) / Math.max(l1, l2) : 0, ring: d[124 + 18] > 0 || d[124 + 24] > 0, crossMod: d[289] & 1 ? 0.5 : 0, noise: unit(d[124 + 30]) },
    pitch: { lfo1: bipolar(d[OSC(0) + 9]), lfo2: bipolar(d[OSC(0) + 10]), envDepth: bipolar(d[OSC(0) + 7]), env: { attack: unit(d[188]), decay: unit(d[189]) } },
    filter: {
      type, slope: [12, 18, 24][d[208]] ?? 24, cutoff: unit(d[211]), resonance: unit(d[221]), keyTrack: unit(d[220]),
      envDepth: bipolar(d[214]), lfo1: bipolar(d[216]), lfo2: bipolar(d[217]), env: env(188),
    },
    amp: { level: unit(d[236]), env: env(194), pan: d[FX + 9] > 0 ? 'auto' : 'off' },
    lfo: [{ wave: LFO_WAVES[d[161] - 16] ?? 'triangle', rate: unit(d[163]), fade: unit(d[160]) }, { wave: LFO_WAVES[d[171] - 20] ?? 'triangle', rate: unit(d[173]) }],
    tone: { bass: bipolar(d[FX + 2]), treble: bipolar(d[FX + 3]) },
    effects: {
      modulation: { type: 'chorus', level: unit(d[FX + 16]) },
      delay: { type: 'stereo', time: unit(d[FX + 24]), feedback: unit(d[FX + 25]), level: unit(d[FX + 22]) },
      reverb: { level: unit(d[FX + 11]), time: unit(d[FX + 13]) },
    },
    velocity: { on: d[198] !== 64, depths: { 'Env 1 velocity': bipolar(d[198]), 'Env 2 velocity': bipolar(d[192]) } },
    controller: { depths: { 'Filter freq wheel': bipolar(d[212]), 'Osc 1 pitch wheel': bipolar(d[OSC(0) + 6]) } },
    extra: { family: FAMILY, model: 'novation-supernova2', program: toBase64(d), match: match(d) },
  };
}

// ------------------------------------------------------------------ shared model -> program
function semanticToProgram(c, d, r) {
  const set = (o, v, what) => { if (v === undefined || v === null || Number.isNaN(v)) return; d[o] = clamp(v, 0, 127); r.mapped.push(what); };
  const v = c.voice || {};
  if (v.mode) { d[238] = v.mode === 'unison' ? d[238] | 0x20 : d[238] & ~0x20; r.mapped.push('Unison'); if (v.mode === 'mono' || v.mode === 'legato') r.approximated.push(`${v.mode} → poly (a SuperNova program sets mono per part)`); }
  if (v.portamento) set(231, v.portamento.on ? fromUnit(v.portamento.time ?? 0.3) : 0, 'Portamento');
  if (v.unisonDetune !== undefined) set(288, (v.unisonDetune / 50) * 127, 'Unison detune');
  const bend = Math.max(v.bendUp ?? 0, v.bendDown ?? 0);
  if (v.bendUp !== undefined || v.bendDown !== undefined) {
    for (let n = 0; n < 3; n++) d[OSC(n) + 4] = 64 + clamp(bend, 0, 12);
    r.mapped.push('Pitch bend range');
    if (v.bendUp !== v.bendDown) r.approximated.push('Bend up/down → one range');
  }
  (c.osc || []).slice(0, 3).forEach((o, n) => {
    if (!o) return;
    const b = OSC(n);
    const w = FROM_WAVE[o.wave];
    if (w !== undefined) { d[b] = 10 * n + w; r.mapped.push(`Osc ${n + 1} wave`); } else if (o.wave) { d[b] = 10 * n + 1; r.approximated.push(`Osc ${n + 1} wave ${o.wave} → saw`); }
    if (typeof o.coarse === 'number') {
      const oct = clamp(Math.floor((o.coarse + 6) / 12), -2, 2);
      d[b + 1] = 32 + 5 * n + oct; d[b + 2] = 57 + 25 * n + clamp(o.coarse - 12 * oct, -12, 12);
      r.mapped.push(`Osc ${n + 1} pitch`);
    } else if (typeof o.coarse === 'string') r.approximated.push(`Osc ${n + 1} range ${o.coarse} → 0`);
    if (o.fine !== undefined) set(b + 3, 64 + (o.fine / 50) * 64, `Osc ${n + 1} fine tune`);
    if (o.pulseWidth !== undefined) set(b + 19, fromUnit(o.pulseWidth), `Osc ${n + 1} width`);
    if (o.sync !== undefined) set(b + 25, o.sync ? 64 : 0, `Osc ${n + 1} sync`);
  });
  const m = c.mix || {};
  const levels = [1, 1, 0];
  if (m.balance !== undefined) { levels[0] = Math.min(1, 1 - m.balance); levels[1] = Math.min(1, 1 + m.balance); }
  if ((c.osc || []).length > 2) levels[2] = c.osc[2]?.level ?? 1;
  levels.forEach((l, n) => { d[124 + 6 * n] = fromUnit(l); });
  r.mapped.push('Oscillator mix');
  if (m.ring !== undefined) set(124 + 18, m.ring ? 100 : 0, 'Ring modulator 1*3');
  if (m.noise !== undefined) set(124 + 30, fromUnit(m.noise), 'Noise level');
  if (m.crossMod) r.approximated.push('Cross modulation → 1*3 FM off (set it on the FM buttons)');
  const p = c.pitch || {};
  if (p.lfo1 !== undefined) for (let n = 0; n < 2; n++) set(OSC(n) + 9, fromBipolar(p.lfo1), `Osc ${n + 1} pitch LFO 1`);
  if (p.lfo2 !== undefined) for (let n = 0; n < 2; n++) set(OSC(n) + 10, fromBipolar(p.lfo2), `Osc ${n + 1} pitch LFO 2`);
  if (p.envDepth !== undefined) {
    const target = p.target === 'osc2' ? [1] : [0, 1];
    for (const n of target) set(OSC(n) + 7, fromBipolar(p.envDepth), `Osc ${n + 1} pitch Env 2`);
    r.approximated.push('Pitch envelope → Env 2 (shared with the filter)');
  }
  const f = c.filter || {};
  if (f.type) { const t = { lpf: 3, bpf: 4, hpf: 5, notch: 9 }[f.type]; if (t) set(207, t, 'Filter type'); else r.approximated.push(`Filter ${f.type} → LPF`); }
  if (f.slope) set(208, f.slope >= 24 ? 2 : f.slope >= 18 ? 1 : 0, 'Filter slope');
  if (f.cutoff !== undefined) set(211, fromUnit(f.cutoff), 'Filter cutoff');
  if (f.resonance !== undefined) set(221, fromUnit(f.resonance), 'Filter resonance');
  if (f.keyTrack !== undefined) set(220, fromUnit(Math.abs(f.keyTrack)), 'Filter tracking');
  if (f.envDepth !== undefined) set(214, fromBipolar(f.envDepth), 'Filter freq Env 2');
  if (f.lfo1 !== undefined) set(216, fromBipolar(f.lfo1), 'Filter freq LFO 1');
  if (f.lfo2 !== undefined) set(217, fromBipolar(f.lfo2), 'Filter freq LFO 2');
  const putEnv = (b, e, what) => { if (!e) return; d[b] = fromUnit(e.attack); d[b + 1] = fromUnit(e.decay); d[b + 2] = fromUnit(e.sustain ?? 1); d[b + 3] = fromUnit(e.release); r.mapped.push(what); };
  putEnv(188, f.env, 'Env 2 (filter envelope)');
  const a = c.amp || {};
  if (a.level !== undefined) set(236, fromUnit(a.level), 'Program level');
  putEnv(194, a.env, 'Env 1 (amplifier)');
  if (a.lfo1 || a.lfo2) r.dropped.push('Amplifier LFO depth (no LFO to amplitude in a SuperNova program)');
  const [l1, l2] = c.lfo || [];
  if (l1) { const w = LFO_WAVES.indexOf(l1.wave === 'sine' ? 'triangle' : l1.wave); set(161, 16 + (w < 0 ? 2 : w), 'LFO 1 wave'); set(163, fromUnit(l1.rate), 'LFO 1 speed'); if (l1.fade !== undefined) set(160, fromUnit(l1.fade), 'LFO 1 delay'); }
  if (l2) { const w = LFO_WAVES.indexOf(l2.wave === 'sine' ? 'triangle' : l2.wave); set(171, 20 + (w < 0 ? 2 : w), 'LFO 2 wave'); set(173, fromUnit(l2.rate), 'LFO 2 speed'); }
  if (c.tone) { set(FX + 2, fromBipolar(c.tone.bass ?? 0), 'EQ bass'); set(FX + 3, fromBipolar(c.tone.treble ?? 0), 'EQ treble'); }
  const fx = c.effects || {};
  if (fx.modulation) { set(FX + 16, fromUnit(fx.modulation.level), 'Chorus send'); if (fx.modulation.type && !/chorus|flang|phas/i.test(fx.modulation.type)) r.approximated.push(`Effect ${fx.modulation.type} → chorus`); }
  if (fx.delay) { set(FX + 24, fromUnit(fx.delay.time), 'Delay time'); set(FX + 25, fromUnit(fx.delay.feedback), 'Delay feedback'); set(FX + 22, fromUnit(fx.delay.level), 'Delay send'); }
  if (fx.reverb) { set(FX + 11, fromUnit(fx.reverb.level), 'Reverb send'); if (fx.reverb.time !== undefined) set(FX + 13, fromUnit(fx.reverb.time), 'Reverb decay'); }
  if (c.velocity?.depths) {
    const dep = Object.values(c.velocity.depths);
    if (dep.length) { set(198, fromBipolar(Math.max(...dep.map((x) => Math.abs(x)))), 'Env 1 velocity'); r.approximated.push('Velocity depths → Env 1 velocity'); }
  }
}

export function programFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.program) {
    const src = fromBase64(c.extra.program);
    if (OS4_MODELS.includes(c.extra.model)) {
      d.set(sn1ToSn2Program(src));
      r.mapped.push('the 286 program bytes of the SuperNova / Nova (OS 4.1), converted as a SuperNova II does (1DE84)');
      r.approximated.push('OS 2 settings (message 1E) left as they were');
    } else {
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} program bytes (same model)`);
    }
    return { data: d, report: r };
  }
  semanticToProgram(c, d, r);
  return { data: d, report: r };
}

/**
 * The OS 4.1 family (SuperNova, model 20; Nova, model 21): one 286-byte program format (their
 * CC/NRPN setters write the same bytes), which a SuperNova II converts with 1DE84 for both models.
 */
export const OS4_MODELS = ['novation-supernova', 'novation-nova'];
/** SuperNova / Nova: 286 bytes; the SuperNova II's model with its conversion. */
export function sn1ProgramToCommon(d, model = 'novation-supernova') {
  const pad = new Uint8Array(374);
  pad.set(sn1ToSn2Program(d));
  const c = programToCommon(pad);
  c.extra = { family: FAMILY, model, program: toBase64(d), match: c.extra.match };
  return c;
}
export function sn1ProgramFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.program) {
    const src = fromBase64(c.extra.program);
    if (OS4_MODELS.includes(c.extra.model)) { d.set(src.subarray(0, d.length)); r.mapped.push('all program bytes (same OS 4.1 program format)'); } else {
      d.set(sn2ToSn1Program(src));
      r.mapped.push('the 286 program bytes the SuperNova has, with the SuperNova II values scaled back');
      if (src.length > 286) r.dropped.push('OS 2 settings (message 1E): OS 4.1 has none');
    }
    return { data: d, report: r };
  }
  const pad = new Uint8Array(374);
  pad.set(sn1ToSn2Program(d));
  semanticToProgram(c, pad, r);
  d.set(sn2ToSn1Program(pad));
  return { data: d, report: r };
}

// ------------------------------------------------------------------ performance
/** P: {PART(i), PFX(i), size} from the definition. */
export function perfTranslator(P) {
  function perfToCommon(d) {
    return {
      model: COMMON_MODEL, kind: 'performance',
      tempo: d[17] + 64,
      parts: Array.from({ length: 8 }, (_, i) => {
        const b = P.PART(i);
        return {
          bank: d[b + 1], program: d[b], channel: d[b + 2] < 16 ? d[b + 2] : d[b + 2] === 16 ? 'omni' : 'global',
          transpose: d[b + 5] - 64, level: unit(d[b + 11]), on: (d[b + 10] & 3) !== 0, low: d[b + 8], high: d[b + 9],
        };
      }),
      extra: { family: FAMILY, model: 'novation-supernova2', performance: toBase64(d), match: toBase64(Uint8Array.from(d.subarray(16))) },
    };
  }
  function perfFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.performance) {
      const src = fromBase64(c.extra.performance);
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} performance bytes (same model)`);
      return { data: d, report: r };
    }
    if (c.tempo) { d[17] = clamp(c.tempo - 64, 0, 127); r.mapped.push('Arpeggio speed'); }
    (c.parts || []).slice(0, 8).forEach((p, i) => {
      if (!p) return;
      const b = P.PART(i);
      if (typeof p.channel === 'number') { d[b + 2] = p.channel & 15; r.mapped.push(`Part ${i + 1} MIDI channel`); }
      if (typeof p.transpose === 'number') { d[b + 5] = 64 + clamp(p.transpose, -24, 24); r.mapped.push(`Part ${i + 1} semitone`); }
    });
    if ((c.parts || []).length > 8) r.dropped.push(`${c.parts.length - 8} part(s) beyond the SuperNova's 8`);
    r.approximated.push('Part programs, levels and effects left as they were (the source is another model)');
    return { data: d, report: r };
  }
  return { perfToCommon, perfFromCommon };
}

// ------------------------------------------------------------------ arpeggio patterns
/** A user arpeggio pattern: no shared-model sections; another SuperNova II takes it exactly. */
export function patternToCommon(d) {
  return { model: COMMON_MODEL, kind: 'arp-pattern', extra: { family: FAMILY, model: 'novation-supernova2', pattern: toBase64(d), match: toBase64(Uint8Array.from(d)) } };
}
export function patternFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.pattern) {
    const src = fromBase64(c.extra.pattern);
    d.set(src.subarray(0, d.length));
    r.mapped.push('the whole pattern (same model)');
  } else r.dropped.push('an arpeggio pattern of another model (no shared pattern format yet)');
  return { data: d, report: r };
}

// ------------------------------------------------------------------ SuperNova (1) programs
// A SuperNova II converts a program it receives with model byte 20/21 (the earlier format) at 1DE84:
// a Saw oscillator gets its width and width mods centred (the old Saw had no width), and five values
// change scale: overdrive (v >> 2) + 16, program level v >> 1, filter freq LFO 1/2 mods
// 64 ± floor(sqrt(|v - 64| * 256)) / 2, comb boost 64 + (v - 64) * 230 / 256, and, unless the OS 2
// marker (249 bit 2) is set, distortion drive ((3v - v²/128) mod 256) * 113 / 256.
const sqrt8 = (n) => { let r = 0; for (let b = 0x80; b; b >>= 1) if ((r + b) * (r + b) <= n) r += b; return r; };
const conv = {
  210: (v) => (v >> 2) + 16,
  236: (v) => v >> 1,
  216: (v) => { const x = v - 64; return 64 + Math.sign(x) * (sqrt8(Math.abs(x) * 256) >> 1); },
  259: (v) => 64 + Math.floor(((v - 64) * 230) / 256),
  254: (v) => ((((3 * v - Math.floor((v * v) / 128)) & 255) * 113) >> 8),
};
conv[217] = conv[216];
export function sn1ToSn2Program(src) {
  const d = Uint8Array.from(src.subarray(0, 286));
  for (let n = 0; n < 3; n++) if (d[22 + 34 * n] === 10 * n + 1) for (let k = 19; k <= 24; k++) d[22 + 34 * n + k] = 0x40;
  for (const o of [210, 236, 216, 217, 259]) d[o] = Math.max(0, Math.min(127, conv[o](d[o])));
  if (!(d[249] & 4)) d[254] = Math.max(0, Math.min(127, conv[254](d[254])));
  return d;
}
/** The other way: for each converted value, the old value whose conversion is nearest. */
export function sn2ToSn1Program(src) {
  const d = Uint8Array.from(src.subarray(0, 286));
  for (const o of [210, 236, 216, 217, 259, 254]) {
    let best = 0;
    for (let v = 0; v < 128; v++) if (Math.abs(conv[o](v) - src[o]) < Math.abs(conv[o](best) - src[o])) best = v;
    d[o] = best;
  }
  d[249] &= ~4;
  return d;
}
