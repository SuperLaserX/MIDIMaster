// SYSTEM-8 sounds <-> the shared synth model (js/core/mainlib/common.js). Within the family the whole sound
// (patch, patch2 and patch3 structs, 20195 bytes) travels in extra.data, so SYSTEM-8 -> SYSTEM-8 is exact;
// other instruments get the semantic sections (oscillators, mixer, filter, envelopes, LFO, effects levels,
// voice, tempo). PLUG-OUT patches (raw until their engine editors exist) carry their bytes and the slot's
// model only; performances map to the shared performance shape (key mode, tempo, two parts).

import { readParam, writeParam } from '../../core/model/memmap.js';
import { unit, fromUnit, bipolar, fromBipolar, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';

const FAMILY = 'roland-system8';
const cache = { params: null }; // the definition's parameter list (roland-system8.js sets it at import)
function io(ps) {
  const by = new Map(ps.map((p) => [p.key, p]));
  return {
    get: (d, k) => readParam(d, by.get(k)),
    set: (d, k, v) => { const p = by.get(k); if (p && v !== undefined && !Number.isNaN(v)) writeParam(d, p, Math.round(v)); },
  };
}

const WAVES = ['saw', 'square', 'triangle', 'saw', 'square', 'triangle']; // variation 1: SAW SQR TRI SAW2 SQR2 TRI2
const LFO_WAVES = ['sine', 'triangle', 'saw', 'square', 'sample-hold', 'sample-hold'];
const hex = (d) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));

export function toCommon(d) {
  const ps = cache.params;
  if (!ps) throw new Error('roland-system8-translate: the definition has not set its parameters');
  const { get } = io(ps);
  const env = (pre) => ({ attack: unit(get(d, `${pre}_attack`), 255), decay: unit(get(d, `${pre}_decay`), 255), sustain: unit(get(d, `${pre}_sustain`), 255), release: unit(get(d, `${pre}_release`), 255) });
  const osc = (n) => ({
    wave: get(d, `osc${n}_variation`) === 0 ? WAVES[get(d, `osc${n}_wave`)] : `system8:osc-v${get(d, `osc${n}_variation`)}-${get(d, `osc${n}_wave`)}`,
    coarse: (n === 1 ? get(d, 'osc1_coarse_tune') : get(d, 'osc2_coarse_tune')) - 11 + 12 * (3 - get(d, `osc${n}_range`)),
    fine: Math.round(((get(d, `osc${n}_fine_tune`) - 128) / 128) * 50),
    control1: unit(get(d, `osc${n}_color`), 255),
    level: unit(get(d, `mixer_osc${n}`), 255),
    ...(n === 2 ? { sync: get(d, 'osc2_sync') === 1 } : {}),
  });
  const mono = get(d, 'mono_sw');
  const tempo = get(d, 'patch_tempo');
  return {
    model: 1, kind: 'patch', ...(tempo ? { tempo: tempo / 10 } : {}),
    voice: { mode: mono === 0 ? 'poly' : mono === 1 ? 'mono' : 'unison', portamento: { on: get(d, 'portamento') > 0, time: unit(get(d, 'portamento'), 255) }, bendUp: get(d, 'bend_range') + 1, bendDown: get(d, 'bend_range') + 1 },
    osc: [osc(1), osc(2)],
    mix: { ring: get(d, 'osc2_ring') ? 1 : 0, crossMod: unit(get(d, 'osc1_cross_mod'), 255), noise: unit(get(d, 'mixer_noise'), 255), sub: unit(get(d, 'mixer_osc3_sub_osc'), 255) },
    pitch: { lfo1: bipolar(get(d, 'lfo_pitch_depth'), 128, 127), envDepth: bipolar(get(d, 'pitch_env'), 128, 127), env: { attack: unit(get(d, 'pitch_attack'), 255), decay: unit(get(d, 'pitch_decay'), 255) } },
    filter: {
      type: get(d, 'filter_variation') === 0 && get(d, 'filter_type') >= 3 ? 'hpf' : 'lpf',
      slope: [24, 18, 12, 12, 18, 24][get(d, 'filter_type')] ?? 24,
      cutoff: unit(get(d, 'filter_cutoff'), 255), resonance: unit(get(d, 'filter_resonance'), 255),
      keyTrack: bipolar(get(d, 'filter_key_follow'), 128, 127), envDepth: bipolar(get(d, 'filter_env'), 128, 127),
      lfo1: bipolar(get(d, 'lfo_filter_depth'), 128, 127), env: env('filter'),
    },
    amp: { level: unit(get(d, 'amp_level'), 255), lfo1: bipolar(get(d, 'lfo_amp_depth'), 128, 127), env: env('amp') },
    lfo: [{ wave: LFO_WAVES[get(d, 'lfo_wave')] || 'triangle', rate: unit(get(d, 'lfo_rate'), 255), fade: unit(get(d, 'lfo_fade_time'), 255) }],
    effects: {
      reverb: { level: unit(get(d, 'reverb_level'), 255) },
      delay: { level: unit(get(d, 'delay_level'), 255), time: unit(get(d, 'delay_time'), 255) },
      modulation: { level: unit(get(d, 'effect_depth'), 255) },
    },
    extra: { family: FAMILY, model: 'SYSTEM-8', data: hex(d), match: hex(d.slice(0, 0x80)) + hex(d.slice(0x100, 640)) + hex(d.slice(640)) },
  };
}

/** A PLUG-OUT patch (raw): exact within the family, nothing semantic until its engine editor exists. */
export function rawToCommon(d) {
  return { model: 1, kind: 'patch', extra: { family: `${FAMILY}-plugout`, model: 'PLUG-OUT', data: hex(d), match: hex(d.slice(0, 0x80)) + hex(d.slice(0x100)) } };
}
export function rawFromCommon(c, base) {
  const report = emptyReport();
  if (c?.extra?.family === `${FAMILY}-plugout` && c.extra.data) { report.mapped.push('the whole PLUG-OUT patch'); return { data: unhex(c.extra.data), report }; }
  report.dropped.push('a PLUG-OUT patch takes only PLUG-OUT patch data (its engine editor is not mapped yet)');
  return { data: Uint8Array.from(base), report };
}

const perfIO = (ps) => io(ps);
/** Performance -> shared performance shape (keys of the OS catalog parameters, roland-system8.js PERF_PARAMS). */
export function perfToCommon(d, ps) {
  const { get } = perfIO(ps);
  const part = (pre) => ({
    on: !!get(d, `${pre}_part_sw`), channel: 0,
    program: get(d, `${pre}_part_slot`) * 64 + get(d, `${pre}_part_memory`),
    level: unit(get(d, `${pre}_level`), 127), pan: (get(d, `${pre}_pan`) - 5) / 5,
    transpose: get(d, `${pre}_transpose`) + 12 * get(d, `${pre}_octave`), fine: get(d, `${pre}_fine_tune`),
    low: get(d, `${pre}_range_lower`), high: get(d, `${pre}_range_upper`), velLow: 0, velHigh: 127,
  });
  const up = part('up'); const lw = part('lw');
  const split = up.low > lw.high || lw.low > up.high;
  return {
    model: 1, kind: 'performance',
    keyMode: get(d, 'perf_mode') === 1 ? 'single' : split ? 'split' : 'dual',
    splitPoint: split ? Math.max(up.low, lw.low) : undefined,
    tempo: get(d, 'perf_tempo') / 10,
    parts: [up, lw],
    extra: { family: `${FAMILY}-perf`, model: 'SYSTEM-8', data: hex(d), match: hex(d) },
  };
}
export function perfFromCommon(c, base, ps) {
  const report = emptyReport();
  if (c?.extra?.family === `${FAMILY}-perf` && c.extra.data) { report.mapped.push('the whole SYSTEM-8 performance'); return { data: unhex(c.extra.data), report }; }
  const d = Uint8Array.from(base);
  const { set } = perfIO(ps);
  if (c.keyMode) { set(d, 'perf_mode', c.keyMode === 'single' ? 1 : 0); report.mapped.push('key mode'); }
  if (c.tempo) set(d, 'perf_tempo', Math.round(Math.max(40, Math.min(300, c.tempo)) * 10));
  (c.parts || []).slice(0, 2).forEach((p, i) => {
    const pre = i === 0 ? 'up' : 'lw';
    if (p.on !== undefined) set(d, `${pre}_part_sw`, p.on ? 1 : 0);
    if (typeof p.program === 'number') { set(d, `${pre}_part_slot`, Math.min(3, p.program >> 6)); set(d, `${pre}_part_memory`, p.program & 63); }
    else if (p.program !== undefined) report.dropped.push(`part ${i + 1}: program ${JSON.stringify(p.program)} has no SYSTEM-8 number`);
    if (p.level !== undefined) set(d, `${pre}_level`, fromUnit(p.level, 127));
    if (p.pan !== undefined) set(d, `${pre}_pan`, 5 + Math.round(p.pan * 5));
    if (p.transpose !== undefined) { const oct = Math.max(-3, Math.min(3, Math.trunc(p.transpose / 12))); set(d, `${pre}_octave`, oct); set(d, `${pre}_transpose`, Math.max(-12, Math.min(12, p.transpose - 12 * oct))); }
    if (p.fine !== undefined) set(d, `${pre}_fine_tune`, Math.max(-100, Math.min(100, Math.round(p.fine))));
    if (p.low !== undefined) set(d, `${pre}_range_lower`, p.low);
    if (p.high !== undefined) set(d, `${pre}_range_upper`, p.high);
    report.mapped.push(`part ${i + 1}`);
  });
  if ((c.parts || []).length > 2) report.dropped.push(`${c.parts.length - 2} parts beyond the SYSTEM-8's upper and lower`);
  return { data: d, report: tidy(report) };
}

export function fromCommon(c, base) {
  const ps = cache.params;
  if (!ps) throw new Error('roland-system8-translate: the definition has not set its parameters');
  const { set } = io(ps);
  const report = emptyReport();
  if (c?.extra?.family === FAMILY && c.extra.data) {
    const src = unhex(c.extra.data);
    const d = src.length >= base.length ? src : Uint8Array.from(base); // a 640-byte patch saved before phase 2
    if (d !== src) d.set(src);
    report.mapped.push('the whole SYSTEM-8 patch');
    return { data: d, report };
  }
  const d = Uint8Array.from(base);
  const env = (pre, e) => { if (!e) return; set(d, `${pre}_attack`, fromUnit(e.attack, 255)); set(d, `${pre}_decay`, fromUnit(e.decay, 255)); set(d, `${pre}_sustain`, fromUnit(e.sustain, 255)); set(d, `${pre}_release`, fromUnit(e.release, 255)); report.mapped.push(`${pre} envelope`); };
  (c.osc || []).slice(0, 2).forEach((o, i) => {
    const n = i + 1;
    const w = { saw: 0, supersaw: 0, square: 1, pulse: 1, triangle: 2 }[o.wave];
    if (w === undefined) report.approximated.push(`OSC${n} wave ${o.wave} -> SAW`);
    set(d, `osc${n}_variation`, 0); set(d, `osc${n}_wave`, w ?? 0);
    const semis = Math.round(o.coarse ?? 0);
    const oct = Math.max(-2, Math.min(2, Math.round(semis / 12)));
    set(d, `osc${n}_range`, 3 - oct);
    set(d, n === 1 ? 'osc1_coarse_tune' : 'osc2_coarse_tune', 11 + (semis - 12 * oct));
    set(d, `osc${n}_fine_tune`, 128 + Math.round(((o.fine ?? 0) / 50) * 128));
    if (o.level !== undefined) set(d, `mixer_osc${n}`, fromUnit(o.level, 255));
    if (n === 2 && o.sync !== undefined) set(d, 'osc2_sync', o.sync ? 1 : 0);
    report.mapped.push(`OSC${n}`);
  });
  if (c.mix) { if (c.mix.ring !== undefined) set(d, 'osc2_ring', c.mix.ring > 0 ? 1 : 0); if (c.mix.crossMod !== undefined) set(d, 'osc1_cross_mod', fromUnit(c.mix.crossMod, 255)); if (c.mix.noise !== undefined) set(d, 'mixer_noise', fromUnit(c.mix.noise, 255)); report.mapped.push('mixer'); }
  if (c.filter) {
    const f = c.filter;
    set(d, 'filter_variation', 0);
    const slope = f.slope >= 21 ? 0 : f.slope >= 15 ? 1 : 2;
    set(d, 'filter_type', f.type === 'hpf' ? 5 - slope : slope);
    if (f.type === 'bpf') report.approximated.push('band-pass filter -> LPF');
    if (f.cutoff !== undefined) set(d, 'filter_cutoff', fromUnit(f.cutoff, 255));
    if (f.resonance !== undefined) set(d, 'filter_resonance', fromUnit(f.resonance, 255));
    if (f.keyTrack !== undefined) set(d, 'filter_key_follow', fromBipolar(f.keyTrack, 128, 127, 255));
    if (f.envDepth !== undefined) set(d, 'filter_env', fromBipolar(f.envDepth, 128, 127, 255));
    if (f.lfo1 !== undefined) set(d, 'lfo_filter_depth', fromBipolar(f.lfo1, 128, 127, 255));
    env('filter', f.env);
    report.mapped.push('filter');
  }
  if (c.amp) { env('amp', c.amp.env); if (c.amp.level !== undefined) set(d, 'amp_level', fromUnit(c.amp.level, 255)); if (c.amp.lfo1 !== undefined) set(d, 'lfo_amp_depth', fromBipolar(c.amp.lfo1, 128, 127, 255)); }
  if (c.pitch) { if (c.pitch.envDepth !== undefined) set(d, 'pitch_env', fromBipolar(c.pitch.envDepth, 128, 127, 255)); if (c.pitch.lfo1 !== undefined) set(d, 'lfo_pitch_depth', fromBipolar(c.pitch.lfo1, 128, 127, 255)); if (c.pitch.env) { set(d, 'pitch_attack', fromUnit(c.pitch.env.attack, 255)); set(d, 'pitch_decay', fromUnit(c.pitch.env.decay, 255)); } report.mapped.push('pitch'); }
  const l = c.lfo?.[0];
  if (l) { set(d, 'lfo_variation', 0); set(d, 'lfo_wave', Math.max(0, LFO_WAVES.indexOf(l.wave))); if (l.rate !== undefined) set(d, 'lfo_rate', fromUnit(l.rate, 255)); if (l.fade !== undefined) set(d, 'lfo_fade_time', fromUnit(l.fade, 255)); report.mapped.push('LFO'); }
  if (c.voice) {
    const v = c.voice;
    set(d, 'mono_sw', v.mode === 'mono' || v.mode === 'legato' ? 1 : v.mode === 'unison' ? 2 : 0);
    if (v.mode === 'legato') set(d, 'legato', 1);
    if (v.portamento) set(d, 'portamento', v.portamento.on ? Math.max(1, fromUnit(v.portamento.time, 255)) : 0);
    if (v.bendUp) set(d, 'bend_range', Math.max(1, Math.min(24, v.bendUp)) - 1);
    report.mapped.push('voice');
  }
  const e = c.effects;
  if (e) {
    if (e.reverb?.level !== undefined) set(d, 'reverb_level', fromUnit(e.reverb.level, 255));
    if (e.delay?.level !== undefined) set(d, 'delay_level', fromUnit(e.delay.level, 255));
    if (e.delay?.time !== undefined) set(d, 'delay_time', fromUnit(e.delay.time, 255));
    report.mapped.push('effect levels');
  }
  return { data: d, report: tidy(report) };
}

/** The definition passes its parameter list here when it is imported. */
export const setParams = (ps) => { cache.params = ps; };
