// Yamaha DX voices <-> the shared synth model (core/mainlib/common.js), family "yamaha-dx".
//
// FM has no direct equivalent in the shared model (oscillators, filter, amp), so a DX voice is
// described by what carries over:
//   osc[]        one per carrier, in algorithm order: its pitch (frequency ratio as semitones and
//                cents), and a wave named after what its modulation does: 'sine' (no modulator, or
//                modulators at output level 0), 'saw' (a modulator at the carrier's frequency or a
//                feedback loop), 'square' (a modulator at twice the frequency), 'fm' (anything else)
//   filter       none on a DX: the brightness the modulators give, as cutoff (their output levels)
//                and the modulators' EG as the filter envelope
//   amp          the loudest carrier's output level, EG (as attack/decay/sustain/release) and AM
//   lfo[0]       LFO WAVE / SPEED / DELAY; pitch.lfo1 = PM DEPTH x P MOD SENS., amp.lfo1 = AM DEPTH x A MOD SENS.
//   pitch.env    the pitch EG (levels around 50)
//   velocity     the carriers' KEY VELOCITY
//   extra        the exact voice: {family: 'yamaha-dx', model, ops: 6 | 4, vced (base64), aced?, match}
// A DX voice going to another DX model is copied exactly (6-op to 6-op); the 4-operator models
// convert through their own translator (yamaha-dx4-translate.js) with a report. From another
// family, a voice is built on algorithm 5 (three two-operator stacks): each oscillator becomes a
// carrier with a modulator that gives its wave, the filter cutoff and envelope set the
// modulator's level and EG, the amp envelope the carrier's EG; the report lists what is lost.

import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { tidy } from './translate-helpers.js';
import { ALGORITHMS, VCED_SIZE, VOICE_SIZE, OPON, NAME, opBase, freqValue } from './yamaha-dx-voice.js';
import { opBase4, RATIOS, NAME4 } from './yamaha-dx4.js';

export const FAMILY = 'yamaha-dx';
const LFO_WAVES = ['triangle', 'saw-down', 'saw', 'square', 'sine', 'sample-hold'];
const LFO_FROM = { triangle: 0, 'saw-down': 1, saw: 2, 'saw-up': 2, square: 3, sine: 4, 'sample-hold': 5, random: 5, noise: 5 };
const u99 = (v) => Math.max(0, Math.min(1, v / 99));
const r99 = (x) => Math.max(0, Math.min(99, Math.round(x * 99)));

/** ADSR (0..1, longer = higher) from DX EG rates/levels. */
export function egToAdsr(r, l) {
  return { attack: 1 - u99(r[0]), decay: 1 - u99(Math.min(r[1], r[2])), sustain: u99(l[2]), release: 1 - u99(r[3]) };
}
/** DX EG rates/levels from an ADSR (0..1). */
export function adsrToEg(e = {}) {
  const sus = r99(e.sustain ?? 1);
  const dec = r99(1 - (e.decay ?? 0.5));
  return { r: [r99(1 - (e.attack ?? 0)), dec, dec, r99(1 - (e.release ?? 0.3))], l: [99, sus, sus, 0] };
}

/** Nearest coarse/fine (ratio mode) to a frequency ratio. */
export function nearestRatio(ratio) {
  let best = { coarse: 1, fine: 0, err: Infinity };
  for (let c = 0; c < 32; c++) {
    for (let f = 0; f < 100; f++) {
      const err = Math.abs(Math.log(freqValue(0, c, f) / ratio));
      if (err < best.err) best = { coarse: c, fine: f, err };
    }
  }
  return best;
}

/**
 * The translator for a 6-operator model. P: {model, init() -> voice data}.
 * Voice data: 156 bytes (VCED + operator on/off); `extraOf(d)` / `applyExtra(d, extra)` let a model
 * with more data (DX7II ACED) carry it too.
 */
export function dxTranslator(P) {
  const op = (d, n, i) => d[opBase(n) + i];
  function toCommon(d) {
    const alg = ALGORITHMS[d[134] & 31];
    const on = (n) => !!(d[OPON] & (1 << (6 - n)));
    const mods = (n) => alg.mods.filter(([, t]) => t === n).map(([f]) => f);
    const ratio = (n) => freqValue(op(d, n, 17), op(d, n, 18), op(d, n, 19));
    const carriers = alg.carriers.filter(on);
    const loud = [...carriers].sort((a, b) => op(d, b, 16) - op(d, a, 16))[0] ?? alg.carriers[0];
    const waveOf = (c) => {
      const m = mods(c).filter((x) => on(x) && op(d, x, 16) > 0);
      if (alg.fb[1] === c && d[135] > 0) return 'saw';
      if (!m.length) return 'sine';
      const fixed = op(d, c, 17) || m.some((x) => op(d, x, 17));
      const k = fixed ? 0 : ratio(m[0]) / ratio(c);
      if (Math.abs(k - 1) < 0.02) return 'saw';
      if (Math.abs(k - 2) < 0.04) return 'square';
      return 'fm';
    };
    const trn = d[144] - 24;
    const octave = Math.max(-2, Math.min(2, Math.round(trn / 12)));
    const rest = trn - octave * 12;
    const osc = carriers.map((c) => {
      const fixed = !!op(d, c, 17);
      const semis = fixed ? 0 : 12 * Math.log2(ratio(c));
      const coarse = Math.round(semis);
      return {
        wave: waveOf(c), coarse: coarse + rest, fine: Math.round((semis - coarse) * 100 + (op(d, c, 20) - 7) * 1.5),
        level: u99(op(d, c, 16)), ...(fixed ? { fixedHz: freqValue(1, op(d, c, 18), op(d, c, 19)) } : {}),
      };
    });
    const egOf = (n) => egToAdsr([0, 1, 2, 3].map((i) => op(d, n, i)), [0, 1, 2, 3].map((i) => op(d, n, 4 + i)));
    const modsOfLoud = mods(loud).filter(on);
    const modLevel = modsOfLoud.length ? Math.max(...modsOfLoud.map((m) => op(d, m, 16))) / 99 : 0;
    const peg = [0, 1, 2, 3].map((i) => d[130 + i]);
    const pegDepth = (Math.max(...peg.map((x) => Math.abs(x - 50))) / 49) * Math.sign((peg.find((x) => x !== 50) ?? 50) - 50);
    const ams = Math.max(0, ...carriers.map((c) => op(d, c, 14)));
    const kvs = Math.max(0, ...carriers.map((c) => op(d, c, 15)));
    const common = {
      model: COMMON_MODEL, kind: 'patch',
      voice: { octave },
      osc,
      filter: { type: 'lpf', cutoff: 0.25 + 0.75 * modLevel, resonance: 0, ...(modsOfLoud.length ? { env: egOf(modsOfLoud[0]), envDepth: modLevel } : {}) },
      amp: { level: u99(op(d, loud, 16)), env: egOf(loud), lfo1: u99(d[140]) * (ams / 3) },
      lfo: [{ wave: LFO_WAVES[d[142]] || 'triangle', rate: u99(d[137]), fade: u99(d[138]) }],
      pitch: {
        lfo1: u99(d[139]) * (d[143] / 7), envDepth: Math.max(-1, Math.min(1, pegDepth)),
        env: { attack: 1 - u99(d[126]), decay: 1 - u99(d[127]) },
      },
      velocity: { on: kvs > 0, depths: { amp: kvs / 7 } },
      extra: {
        family: FAMILY, model: P.model, ops: 6, algorithm: (d[134] & 31) + 1,
        vced: toBase64(Uint8Array.from(d.subarray(0, VOICE_SIZE))),
        ...(P.extraOf ? P.extraOf(d) : {}),
        match: toBase64(Uint8Array.from([...d.subarray(0, NAME), ...d.subarray(NAME + 10, VCED_SIZE)])),
      },
    };
    return common;
  }

  function fromCommon(c, base) {
    const report = emptyReport();
    const x = c?.extra;
    if (x?.family === FAMILY && x.ops === 6 && x.vced) {
      const d = P.init();
      const v = fromBase64(x.vced);
      d.set(v.subarray(0, Math.min(VOICE_SIZE, v.length)));
      if (v.length < VOICE_SIZE) d[OPON] = 0x3f;
      report.mapped.push(`every voice parameter (${x.model || 'DX'} voice, same format)`);
      if (P.applyExtra) P.applyExtra(d, x, report);
      else if (x.aced) report.dropped.push(`the ${x.model} additional parameters (ACED) this model does not have`);
      return { data: d, report: tidy(report) };
    }
    if (x?.family === FAMILY && x.ops === 4 && x.vced4) return { data: from4(fromBase64(x.vced4), report), report: tidy(report) };
    return { data: build(c, base, report), report: tidy(report) };
  }

  /**
   * A 4-operator voice (DX21/27/100/11, TX81Z) on six operators: OP1-OP4 become OP3-OP6 of the 6-op
   * algorithm with the same connections (OP4's feedback on OP6; for 4-op algorithm 3 the DX7's
   * algorithm 8, whose feedback is on the operator that modulates the carrier directly); OP1 and OP2
   * are silent. AR/D1R/D1L/D2R/RR become rates and levels, CRS the nearest ratio.
   */
  function from4(v, report) {
    const d = P.init();
    const a4 = v[52] & 7;
    const MAP = [[0, [3, 4, 5, 6]], [13, [3, 4, 5, 6]], [7, [3, 5, 6, 4]], [6, [3, 4, 5, 6]], [4, [3, 4, 5, 6]], [21, [3, 4, 5, 6]], [30, [3, 4, 5, 6]], [31, [3, 4, 5, 6]]];
    const [alg, to] = MAP[a4];
    d[134] = alg;
    d[135] = v[53];
    for (let n = 1; n <= 6; n++) d[opBase(n) + 16] = 0;
    for (let k = 0; k < 4; k++) {
      const s = opBase4(k + 1);
      const t = opBase(to[k]);
      const R = (x, m) => Math.round((x / m) * 99);
      d[t] = R(v[s], 31); d[t + 1] = R(v[s + 1], 31); d[t + 2] = R(v[s + 2], 31); d[t + 3] = R(v[s + 3], 15);
      const sus = R(v[s + 4], 15);
      d[t + 4] = 99; d[t + 5] = sus; d[t + 6] = v[s + 2] ? 0 : sus; d[t + 7] = 0;
      d[t + 9] = v[s + 5]; d[t + 10] = v[s + 5]; d[t + 13] = v[s + 6] * 2; d[t + 14] = v[s + 8] ? 3 : 0; d[t + 15] = v[s + 9]; d[t + 16] = v[s + 10];
      const r = nearestRatio(RATIOS[v[s + 11] & 63] / 100);
      d[t + 17] = 0; d[t + 18] = r.coarse; d[t + 19] = r.fine; d[t + 20] = 7 + (v[s + 12] - 3) * 2;
    }
    for (let i = 0; i < 4; i++) d[137 + i] = v[54 + i];
    d[141] = v[58]; d[142] = [2, 3, 0, 5][v[59] & 3]; d[143] = v[60]; d[144] = v[62];
    for (let i = 0; i < 10; i++) d[NAME + i] = v[NAME4 + i];
    d[OPON] = 0x3f;
    report.approximated.push(`4-operator algorithm ${a4 + 1} as algorithm ${alg + 1} (OP1-OP4 on OP${to.join(', OP')}; OP1 and OP2 silent)`, 'AR/D1R/D1L/D2R/RR as EG rates and levels', 'coarse frequencies as the nearest ratios');
    report.dropped.push('the 4-operator play mode, portamento, pitch bend and controller settings (DX7 function data)');
    return d;
  }

  /** A voice from another family's sound (see the head of this file). */
  function build(c, _base, report) {
    const d = P.init();
    d[134] = 4; // algorithm 5: 2>1, 4>3, 6>5
    d[135] = 0;
    const oscs = (c.osc || []).filter((o) => o && o.on !== false).slice(0, 3);
    if (!oscs.length) oscs.push({ wave: 'saw' });
    if ((c.osc || []).filter((o) => o && o.on !== false).length > 3) report.dropped.push('oscillators after the third');
    const amp = adsrToEg(c.amp?.env);
    const flt = adsrToEg(c.filter?.env || c.amp?.env);
    const cutoff = c.filter?.cutoff ?? 1;
    const envDepth = Math.max(0, c.filter?.envDepth ?? 0);
    let onBits = 0;
    oscs.forEach((o, i) => {
      const car = 1 + i * 2;
      const mod = car + 1;
      onBits |= (1 << (6 - car)) | (1 << (6 - mod));
      const semis = (o.coarse === 'wide-' ? -24 : o.coarse === 'wide+' ? 24 : Number(o.coarse) || 0) + (Number(o.fine) || 0) / 100;
      const r = nearestRatio(2 ** (Math.max(-12, Math.min(60, semis)) / 12));
      const set = (n, k, v) => { d[opBase(n) + k] = v; };
      set(car, 17, 0); set(car, 18, r.coarse); set(car, 19, r.fine);
      set(car, 20, 7);
      amp.r.forEach((v, k) => set(car, k, v));
      amp.l.forEach((v, k) => set(car, 4 + k, v));
      set(car, 16, Math.round(70 + 29 * (o.level ?? c.amp?.level ?? 1)));
      set(car, 15, c.velocity?.on ? 2 : 0);
      const wave = String(o.wave || 'saw');
      const k = wave === 'square' || wave === 'pulse' ? 2 : 1;
      const mr = nearestRatio(2 ** (semis / 12) * k);
      set(mod, 17, 0); set(mod, 18, mr.coarse); set(mod, 19, mr.fine);
      flt.r.forEach((v, j) => set(mod, j, v));
      flt.l.forEach((v, j) => set(mod, 4 + j, Math.round(v * (0.4 + 0.6 * Math.min(1, cutoff + envDepth)))));
      const bright = wave === 'sine' ? 0 : wave === 'triangle' ? 35 : Math.round(45 + 40 * cutoff);
      set(mod, 16, bright);
      if (!['sine', 'triangle', 'saw', 'square', 'pulse'].includes(wave)) report.approximated.push(`oscillator ${i + 1} wave "${wave}" played as an FM saw`);
      if (o.sync) report.dropped.push(`oscillator ${i + 1} sync`);
    });
    for (let n = 1; n <= 6; n++) if (!(onBits & (1 << (6 - n)))) d[opBase(n) + 16] = 0;
    d[OPON] = 0x3f;
    report.approximated.push('oscillator waves as two-operator FM pairs (algorithm 5)', 'filter cutoff and envelope as the modulators\' output level and EG', 'amp envelope as the carriers\' EG rates and levels');
    report.mapped.push('oscillator pitches (frequency ratios)');
    if (c.filter?.resonance) report.dropped.push('filter resonance (no filter on a DX)');
    if (c.filter?.type && c.filter.type !== 'lpf') report.dropped.push(`filter type ${c.filter.type}`);
    const lfo = c.lfo?.[0];
    if (lfo) {
      d[142] = LFO_FROM[lfo.wave] ?? 0;
      d[137] = r99(lfo.rate ?? 0.35);
      d[138] = r99(lfo.fade ?? 0);
      report.mapped.push('LFO wave, speed and delay');
    }
    const pm = Math.max(0, c.pitch?.lfo1 ?? 0);
    d[143] = pm > 0 ? 3 : d[143];
    d[139] = r99(Math.min(1, pm));
    const am = Math.max(0, c.amp?.lfo1 ?? 0);
    d[140] = r99(Math.min(1, am));
    if (am > 0) for (let i = 0; i < oscs.length; i++) d[opBase(1 + i * 2) + 14] = 2;
    if (c.pitch?.envDepth) {
      const lvl = Math.round(50 + 49 * Math.max(-1, Math.min(1, c.pitch.envDepth)));
      d[130] = lvl; d[131] = 50; d[132] = 50; d[133] = 50;
      d[126] = r99(1 - (c.pitch.env?.attack ?? 0)); d[127] = r99(1 - (c.pitch.env?.decay ?? 0.3));
      report.approximated.push('pitch envelope as the pitch EG');
    }
    const oct = Math.max(-2, Math.min(2, Number(c.voice?.octave) || 0));
    d[144] = 24 + oct * 12;
    if (c.voice?.mode && c.voice.mode !== 'poly') report.dropped.push(`voice mode ${c.voice.mode} (POLY/MONO is a function setting, not part of a DX voice)`);
    if (c.voice?.portamento?.on) report.dropped.push('portamento (a function setting)');
    if (c.effects && Object.values(c.effects).some((e) => e && e.level)) report.dropped.push('effects (a DX7 has none)');
    if (c.lfo?.[1]) report.dropped.push('LFO 2 (one LFO)');
    if (c.mix?.ring || c.mix?.crossMod) report.dropped.push('ring and cross modulation');
    return d;
  }

  return { toCommon, fromCommon, build };
}
