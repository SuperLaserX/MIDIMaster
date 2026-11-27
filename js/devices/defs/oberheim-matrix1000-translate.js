// Oberheim Matrix-1000 patch <-> the shared synth model (core/mainlib/common.js).
//
// A Matrix patch has two DCOs (pulse and/or a sawtooth-to-triangle "wave", DCO 2 also noise), one
// 24 dB low-pass VCF, two VCAs, three DADSR envelopes, two LFOs, two ramps, a tracking generator
// and a 10-slot modulation matrix. Every patch routes Env 1 to the VCF (VCF freq by Env 1) and Env
// 2 to VCA 2 (VCA 2 by Env 2, the output level), so Env 1 is the filter envelope and Env 2 the amp
// envelope. The fixed modulations (DCO freq by LFO 1, PW by LFO 2) give the pitch LFO and PWM; the
// matrix slots Env -> DCO frequency, LFO -> VCF frequency and LFO -> VCA level give the pitch
// envelope and the filter and amp LFO depths.
//
// The Matrix-6, 6R and 1000 share this 134-byte patch, so `extra` carries it whole (family
// "oberheim-matrix") and another Matrix takes it back exactly.
//
// Assumptions where neither the firmware notes nor the definition give the sense of a value
// (docs/devices/oberheim-matrix1000.md, "Translator"): Mix 0 is DCO 1 alone and 63 DCO 2 alone;
// Waveshape 0 is a sawtooth and 63 a triangle; DCO frequencies are kept as an interval (DCO 2 -
// DCO 1), since the shared model has no absolute pitch; Detune ±31 is read as ±50 cents.

import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { paramIO, tidy } from './translate-helpers.js';

const FAMILY = 'oberheim-matrix';
const MODEL_ID = 'oberheim-matrix1000';
// Triangle, Up saw, Down saw, Square, Random, Noise, Sampled
const LFO_WAVES = ['triangle', 'saw', 'saw', 'square', 'sample-hold', 'sample-hold', 'sample-hold'];
const LFO_FROM = { triangle: 0, sine: 0, saw: 1, 'saw-up': 1, 'saw-down': 2, square: 3, 'sample-hold': 4, random: 4, noise: 5 };
// matrix sources / destinations used here (oberheim-matrix1000.js SOURCES, DESTINATIONS)
const SRC = { env1: 1, env2: 2, env3: 3, lfo1: 4, lfo2: 5 };
const DST = { dco1: 1, dco2: 4, vcf: 9, vca1: 11, vca2: 12 };
// Env n: delay at p, attack p+1, decay p+2, sustain p+3, release p+4, amplitude p+5 (p = 50, 60, 70)
const ENV = (n) => 40 + 10 * n;

/** P: the patch parameters of oberheim-matrix1000.js (keys p<remote number>, m<slot>src/amt/dst). */
export function matrixTranslator(params) {
  function patchToCommon(d) {
    const { get } = paramIO(params);
    const g = (n) => get(d, `p${n}`);
    const u = (v, max = 63) => Math.max(0, Math.min(1, v / max));
    const env = (n) => ({ attack: u(g(ENV(n) + 1)), decay: u(g(ENV(n) + 2)), sustain: u(g(ENV(n) + 3)), release: u(g(ENV(n) + 4)) });
    const slots = Array.from({ length: 10 }, (_, s) => ({ src: get(d, `m${s}src`), amt: get(d, `m${s}amt`), dst: get(d, `m${s}dst`) }))
      .filter((m) => m.src && m.dst && m.dst !== 32 && m.amt);
    const route = (src, dsts) => slots.find((m) => m.src === src && dsts.includes(m.dst));
    const dcoWave = (form, shape) => {
      if (form === 4) return 'noise';
      if (form === 1) return 'square';
      return shape >= 32 ? 'triangle' : 'saw';
    };
    const w1 = g(6);
    const w2 = g(16);
    const osc = [
      { on: w1 !== 0, wave: dcoWave(w1, g(5)), coarse: 0, fine: 0, pulseWidth: u(g(3)), pwmDepth: Math.abs(g(4)) / 63, control1: u(g(5)) },
      { on: w2 !== 0, wave: dcoWave(w2, g(15)), coarse: g(10) - g(0), fine: Math.round((g(12) * 50) / 31), pulseWidth: u(g(13)), pwmDepth: Math.abs(g(14)) / 63, control1: u(g(15)), sync: g(2) !== 0 },
    ];
    // the pitch envelope: an envelope routed to a DCO's frequency through the matrix
    const penv = [SRC.env3, SRC.env1, SRC.env2].map((s) => route(s, [DST.dco1, DST.dco2])).find(Boolean);
    const lfoTo = (src, dsts) => (route(src, dsts)?.amt ?? 0) / 63;
    const pl1 = g(1) || g(11);
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: {
        mode: g(48) === 2 ? 'unison' : 'poly', legato: !!g(47),
        portamento: { on: g(44) > 0, time: u(g(44)) },
      },
      osc,
      mix: { balance: Math.max(-1, Math.min(1, (g(20) - 31.5) / 31.5)) },
      pitch: {
        lfo1: pl1 / 63, lfo2: lfoTo(SRC.lfo2, [DST.dco1, DST.dco2]),
        envDepth: penv ? penv.amt / 63 : 0,
        ...(penv ? { env: { attack: env(penv.src).attack, decay: env(penv.src).decay } } : {}),
        target: g(1) && !g(11) ? 'osc1' : !g(1) && g(11) ? 'osc2' : 'osc1+2',
      },
      filter: {
        type: 'lpf', slope: 24, cutoff: u(g(21), 127), resonance: u(g(24)), keyTrack: g(26) === 2 ? 0 : 1,
        envDepth: g(22) / 63, lfo1: lfoTo(SRC.lfo1, [DST.vcf]), lfo2: lfoTo(SRC.lfo2, [DST.vcf]), env: env(1),
      },
      amp: { level: u(g(27)), lfo1: lfoTo(SRC.lfo1, [DST.vca1, DST.vca2]), lfo2: lfoTo(SRC.lfo2, [DST.vca1, DST.vca2]), env: env(2), pan: 'off' },
      lfo: [{ wave: LFO_WAVES[g(82)] ?? 'triangle', rate: u(g(80)) }, { wave: LFO_WAVES[g(92)] ?? 'triangle', rate: u(g(90)) }],
      extra: { family: FAMILY, model: MODEL_ID, patch: toBase64(d), match: toBase64(Uint8Array.from(d.subarray(8))) },
    };
  }

  function patchFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.patch) {
      const src = fromBase64(c.extra.patch);
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} patch bytes (same family: ${c.extra.model})`);
      return { data: d, report: r };
    }
    const { get, set } = paramIO(params, r);
    const p = (n, v, what) => set(d, `p${n}`, v, what);
    const s63 = (x) => Math.round((x ?? 0) * 63);

    // voice
    const v = c.voice || {};
    if (v.mode) {
      p(48, v.mode === 'unison' ? 2 : 0, 'Keyboard mode');
      if (v.mode === 'mono' || v.mode === 'legato') r.approximated.push('Mono → Reassign (the Matrix-1000 sets mono for the whole unit, in Master)');
    }
    if (v.portamento) p(44, v.portamento.on ? Math.max(1, s63(v.portamento.time)) : 0, 'Portamento rate');
    if (v.legato !== undefined || v.mode === 'legato') p(47, v.legato || v.mode === 'legato' ? 1 : 0, 'Legato portamento');
    if (v.bendUp !== undefined || v.bendDown !== undefined) r.dropped.push('Bend range (a Master setting on the Matrix-1000)');
    if (v.octave) r.dropped.push('Octave shift');

    // DCOs
    const [o1 = { wave: 'saw' }, o2] = c.osc || [];
    const form = (o, n) => {
      const w = String(o?.wave || 'saw');
      if (o?.on === false) return { form: 0 };
      if (w === 'noise') {
        if (n === 2) return { form: 4 };
        r.approximated.push('DCO 1 noise → pulse (only DCO 2 has noise)');
        return { form: 1 };
      }
      if (w === 'square' || w === 'pulse' || /square/.test(w)) return { form: 1 };
      if (w === 'triangle' || w === 'sine' || w === 'triangle-mod') {
        if (w !== 'triangle') r.approximated.push(`DCO ${n} ${w} → triangle (Waveshape 63)`);
        return { form: 2, shape: 63 };
      }
      if (w !== 'saw') r.approximated.push(`DCO ${n} ${w} → sawtooth`);
      return { form: 2, shape: 0 };
    };
    const f1 = form(o1, 1);
    p(6, f1.form, 'DCO 1 waveform');
    if (f1.shape !== undefined) p(5, f1.shape, 'DCO 1 waveshape');
    if (o1.pulseWidth !== undefined) p(3, s63(o1.pulseWidth), 'DCO 1 pulse width');
    if (o1.pwmDepth) p(4, s63(o1.pwmDepth), 'DCO 1 PW by LFO 2');
    if (typeof o1.coarse === 'number' && o1.coarse) r.approximated.push('DCO 1 frequency kept (the shared model has no absolute pitch)');
    if (o2) {
      const f2 = form(o2, 2);
      p(16, f2.form, 'DCO 2 waveform');
      if (f2.shape !== undefined) p(15, f2.shape, 'DCO 2 waveshape');
      if (o2.pulseWidth !== undefined) p(13, s63(o2.pulseWidth), 'DCO 2 pulse width');
      if (o2.pwmDepth) p(14, s63(o2.pwmDepth), 'DCO 2 PW by LFO 2');
      const c1 = typeof o1.coarse === 'number' ? o1.coarse : 0;
      if (typeof o2.coarse === 'number') {
        const want = get(d, 'p0') + Math.round(o2.coarse - c1);
        p(10, want, 'DCO 2 frequency (interval to DCO 1)');
        if (want < 0 || want > 63) r.approximated.push('DCO 2 interval beyond the DCO range: clipped');
      } else if (typeof o2.coarse === 'string') {
        p(10, get(d, 'p0') + (o2.coarse === 'wide+' ? 24 : -24));
        r.approximated.push(`DCO 2 range ${o2.coarse} → two octaves`);
      }
      if (o2.fine !== undefined) { p(12, Math.round((o2.fine * 31) / 50), 'DCO 2 detune'); r.approximated.push('Detune ±50 cents → ±31 steps'); }
      if (o2.sync !== undefined) { p(2, o2.sync ? 3 : 0, 'Sync'); if (o2.sync) r.approximated.push('Sync → Hard'); }
    } else p(16, 0, 'DCO 2 off');
    const m = c.mix || {};
    if (m.balance !== undefined) p(20, Math.round(31.5 + m.balance * 31.5), 'Mix');
    if (m.ring) r.dropped.push('Ring modulator');
    if (m.crossMod) r.dropped.push('Cross modulation');

    // matrix slots: pitch envelope, LFOs to the VCF and VCA
    let slot = 0;
    for (let s = 0; s < 10; s++) { set(d, `m${s}src`, 0); set(d, `m${s}amt`, 0); set(d, `m${s}dst`, 0); }
    const route = (src, amt, dst, what) => {
      if (!amt) return;
      if (slot >= 10) { r.dropped.push(what); return; }
      set(d, `m${slot}src`, src); set(d, `m${slot}amt`, Math.round(amt * 63), what); set(d, `m${slot}dst`, dst);
      slot++;
    };
    const ph = c.pitch || {};
    const envAt = (n, e) => {
      if (!e) return;
      p(ENV(n), 0); p(ENV(n) + 1, s63(e.attack)); p(ENV(n) + 2, s63(e.decay)); p(ENV(n) + 3, s63(e.sustain ?? 0)); p(ENV(n) + 4, s63(e.release ?? e.decay)); p(ENV(n) + 5, 63);
    };
    if (ph.envDepth) {
      envAt(3, { ...ph.env, sustain: 0 });
      const tgt = ph.target || 'osc1+2';
      if (tgt !== 'osc2') route(SRC.env3, ph.envDepth, DST.dco1, 'Pitch envelope (Env 3 → DCO 1 frequency)');
      if (tgt !== 'osc1') route(SRC.env3, ph.envDepth, DST.dco2, 'Pitch envelope (Env 3 → DCO 2 frequency)');
      if (tgt === 'xmod') r.approximated.push('Pitch envelope to cross modulation → DCO frequencies');
    }
    if (ph.lfo1 !== undefined) {
      const t = ph.target || 'osc1+2';
      p(1, t === 'osc2' ? 0 : s63(ph.lfo1), 'DCO 1 freq by LFO 1');
      p(11, t === 'osc1' ? 0 : s63(ph.lfo1), 'DCO 2 freq by LFO 1');
    }
    if (ph.lfo2) { route(SRC.lfo2, ph.lfo2, DST.dco1, 'Pitch LFO 2 (LFO 2 → DCO 1 frequency)'); route(SRC.lfo2, ph.lfo2, DST.dco2, 'Pitch LFO 2 (LFO 2 → DCO 2 frequency)'); }

    // VCF
    const f = c.filter || {};
    if (f.type && f.type !== 'lpf') r.approximated.push(`Filter ${f.type} → low pass (the VCF)`);
    if (f.slope && f.slope !== 24) r.approximated.push(`${f.slope} dB slope → 24 dB`);
    if (f.cutoff !== undefined) p(21, Math.round(f.cutoff * 127), 'VCF frequency');
    if (f.resonance !== undefined) p(24, s63(f.resonance), 'VCF resonance');
    if (f.keyTrack !== undefined) { p(26, f.keyTrack > 0.25 ? 0 : 2, 'VCF key tracking'); if (f.keyTrack > 0.25 && f.keyTrack < 0.9) r.approximated.push('Filter key follow → full keyboard tracking'); }
    if (f.envDepth !== undefined) p(22, s63(f.envDepth), 'VCF freq by Env 1');
    if (f.env) { envAt(1, f.env); r.mapped.push('Filter envelope (Env 1)'); }
    if (f.lfo1) route(SRC.lfo1, f.lfo1, DST.vcf, 'Filter LFO 1 depth (matrix)');
    if (f.lfo2) route(SRC.lfo2, f.lfo2, DST.vcf, 'Filter LFO 2 depth (matrix)');

    // VCA
    const a = c.amp || {};
    if (a.level !== undefined) p(27, s63(a.level), 'VCA 1 level');
    if (a.env) { envAt(2, a.env); p(29, 63); r.mapped.push('Amp envelope (Env 2)'); }
    if (a.lfo1) route(SRC.lfo1, a.lfo1, DST.vca2, 'Amp LFO 1 depth (matrix)');
    if (a.lfo2) route(SRC.lfo2, a.lfo2, DST.vca2, 'Amp LFO 2 depth (matrix)');
    if (a.pan && a.pan !== 'off') r.dropped.push('Pan (the Matrix-1000 is mono)');

    // LFOs
    const [l1, l2] = c.lfo || [];
    const lw = (l, n, key) => {
      if (!l?.wave) return;
      const w = LFO_FROM[l.wave];
      p(key, w ?? 0, `LFO ${n} waveshape`);
      if (w === undefined) r.approximated.push(`LFO ${n} ${l.wave} → triangle`);
      if (l.wave === 'sine') r.approximated.push(`LFO ${n} sine → triangle`);
    };
    if (l1) { lw(l1, 1, 82); if (l1.rate !== undefined) p(80, s63(l1.rate), 'LFO 1 speed'); if (l1.fade) r.dropped.push('LFO 1 fade'); }
    if (l2) { lw(l2, 2, 92); if (l2.rate !== undefined) p(90, s63(l2.rate), 'LFO 2 speed'); }

    if (c.tone && (c.tone.bass || c.tone.treble)) r.dropped.push('Tone (bass/treble)');
    const fx = c.effects || {};
    for (const [k, e] of Object.entries(fx)) if (e && (e.level ?? 0) > 0) r.dropped.push(`Effect ${e.type || k} (no effects on the Matrix-1000)`);
    if (c.velocity?.depths && Object.keys(c.velocity.depths).length) r.dropped.push('Velocity depths');
    if (c.controller?.depths && Object.keys(c.controller.depths).length) r.dropped.push('Controller depths');
    if ((c.osc || []).length > 2) r.dropped.push(`${c.osc.length - 2} oscillator(s) beyond DCO 1 and 2`);
    return { data: d, report: tidy(r) };
  }

  return { patchToCommon, patchFromCommon };
}

/** Write a name: the Matrix-6 shows 6-bit ASCII (upper case, digits, punctuation). */
export function setMatrixName(d, name) {
  const s = String(name ?? '').toUpperCase();
  for (let i = 0; i < 8; i++) {
    const ch = s.charCodeAt(i) || 32;
    d[i] = ch >= 32 && ch < 96 ? ch : 32;
  }
}
