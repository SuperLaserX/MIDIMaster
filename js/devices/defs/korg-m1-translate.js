// Korg M1 / M1R program and combination <-> the shared synth model (core/mainlib/common.js).
//
// An M1 program plays one or two oscillators (SINGLE, DOUBLE; DRUMS plays a drum kit), each a ROM
// or card multisound with its own pitch EG, VDF (a low-pass filter without resonance, with an
// 8-stage EG) and VDA (an 8-stage amplitude EG), one pitch MG and one VDF MG, and two effects.
// The shared model reads: multisounds as `rom:<name>` waves (e.g. rom:Piano), OSC1's pitch EG,
// VDF and VDA as the voice's envelopes, the VDA levels as the oscillator levels and balance, the
// pitch MG as LFO 1 and the VDF MG as LFO 2, and the effect types by kind (reverb, delay,
// chorus...). The 8-stage EGs (AT, AL, DT, BP, ST, SL, RT, RL) read as ADSR: AT as attack, DT +
// ST as decay, SL as sustain, RT as release.
//
// A combination is up to 8 timbres (program, level, transpose, detune, panpot, key and velocity
// windows, MIDI channel) and the effects; its type (SINGLE, LAYER, SPLIT, VEL.SW, MULTI) is the
// key mode. Program numbers only mean something on the same model, so another model's parts set
// the layout (channels, transpose, ranges, levels) and leave the programs to choose.
//
// Both keep the whole data in `extra` (family "korg-m1"), so an M1 and an M1R share it exactly.

import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { readParam, writeParam } from '../../core/model/memmap.js';
import { clamp, tidy, nearestName, effectKind, hashBytes } from './translate-helpers.js';

const FAMILY = 'korg-m1';
const MG_WAVES = ['triangle', 'saw', 'saw-down', 'square'];
const MG_FROM = { triangle: 0, sine: 0, saw: 1, 'saw-up': 1, 'saw-down': 2, square: 3 };
const KEY_MODES = ['single', 'layer', 'split', 'velocity-switch', 'multi'];
const KEY_FROM = { single: 0, layer: 1, dual: 1, split: 2, 'velocity-switch': 3, multi: 4 };
// Synth waves of other instruments -> the M1's nearest multisound
const SYNTH_MS = { saw: 'Saw Wave', ramp: 'Saw Wave', supersaw: 'Saw Wave', 'double-saw': 'Saw Wave', square: 'SquareWave', pulse: '25% Pulse', triangle: 'DWGS TRI', sine: 'DWGS Sine', 'triangle-mod': 'DWGS TRI', feedback: 'Saw Wave', noise: 'Breath' };
const EXACT_SYNTH = new Set(['saw', 'square', 'triangle', 'sine', 'pulse']);
// ... and the multisounds that are plain synth waves, named as such for other instruments
const SYNTH_OF = { 'Saw Wave': 'saw', SquareWave: 'square', 'DWGS TRI': 'triangle', 'DWGS Sine': 'sine', '25% Pulse': 'pulse', '10% Pulse': 'pulse' };
const PULSE_WIDTH = { SquareWave: 0.5, '25% Pulse': 0.25, '10% Pulse': 0.1 };

/** Effect type for a shared-model effect (name first, then its kind). */
function effectType(EFFECTS, kind, e) {
  const exact = EFFECTS.findIndex((n) => n.toUpperCase() === String(e.type || '').toUpperCase());
  if (exact >= 0 && exact < 33) return { type: exact, exact: true };
  const n = String(e.type || '').toUpperCase();
  const by = {
    reverb: /ROOM/.test(n) ? 3 : /STAGE/.test(n) ? 5 : /EARLY|E\.?R/.test(n) ? 6 : /PLATE|CONCERT/.test(n) ? 2 : 0,
    delay: /CROSS|PAN/.test(n) ? 10 : 9,
    chorus: /ENSEMBLE|SYMPH/.test(n) ? 23 : 11,
    flanger: 13, phaser: 15, tremolo: 17, rotary: 24,
    distortion: /DIST/.test(n) ? 21 : 20,
    eq: /EXCIT|ENHAN/.test(n) ? 22 : 19,
  }[kind];
  return by === undefined ? null : { type: by, exact: false };
}

/** M: {programParams, combiParams, MULTISOUNDS, EFFECTS, NO_EFFECT} from korg-m1.js */
export function m1Translator(M) {
  const finder = (params) => (o, label) => {
    const p = params.find((x) => x.offset === o && (label === undefined || x.label === label));
    if (!p) throw new Error(`M1: no parameter at ${o} ${label || ''}`);
    return p;
  };
  const PP = finder(M.programParams);
  const CP = finder(M.combiParams);
  const msName = (v) => (v < 100 ? M.MULTISOUNDS[v] : `Card multisound ${v - 100}`);

  // ------------------------------------------------------------ effects (programs 38-62, combinations 11-35)
  function effectsOf(d, P, at) {
    const out = {};
    const on = d[at + 8];
    for (const n of [1, 2]) {
      const type = d[at + n - 1];
      if (type >= M.NO_EFFECT || !((on >> ((n - 1) * 2)) & 3)) continue;
      const name = M.EFFECTS[type];
      const level = readParam(d, P(at + 2 + (n - 1) * 2, `Effect ${n} balance`)) / 100;
      const kind = effectKind(name);
      const slot = kind === 'reverb' ? 'reverb' : kind === 'delay' ? 'delay' : 'modulation';
      if (type >= 25) { // Delay/Hall ... Delay/Tremolo: a delay and a second effect
        out.delay ??= { type: name, level };
        const second = name.split('/')[1];
        const k2 = effectKind(second);
        out[k2 === 'reverb' ? 'reverb' : 'modulation'] ??= { type: second, level };
      } else out[slot] ??= { type: name, level };
    }
    return out;
  }
  function effectsInto(d, P, at, fx, r) {
    const want = [];
    for (const [slot, e] of Object.entries(fx || {})) {
      if (!e || !(e.level > 0) || !e.type) continue;
      const kind = slot === 'reverb' ? 'reverb' : slot === 'delay' ? 'delay' : effectKind(e.type);
      const t = effectType(M.EFFECTS, kind === 'other' && slot === 'modulation' ? 'chorus' : kind, e);
      if (!t) { r.dropped.push(`Effect ${e.type}`); continue; }
      if (!t.exact) r.approximated.push(`Effect ${e.type} → ${M.EFFECTS[t.type]}`);
      want.push({ ...t, level: e.level, kind, name: e.type });
    }
    // two slots: modulation first, then reverb; a delay takes a free slot or joins the reverb (Delay/Hall)
    const mod = want.find((w) => !['reverb', 'delay'].includes(w.kind));
    const rev = want.find((w) => w.kind === 'reverb');
    const dly = want.find((w) => w.kind === 'delay');
    const slots = [mod, rev].filter(Boolean);
    if (dly) {
      if (slots.length < 2) slots.splice(mod ? 1 : 0, 0, dly);
      else if (rev) { slots[1] = { ...rev, type: /ROOM/i.test(rev.name) ? 26 : 25, level: Math.max(rev.level, dly.level) }; r.approximated.push(`Delay and reverb → ${M.EFFECTS[slots[1].type]}`); }
    }
    for (const w of want) if (!slots.includes(w) && !(dly && w === dly) && !(rev && w === rev && slots[1]?.type >= 25)) r.dropped.push(`Effect ${w.name} (two effects on the M1)`);
    let on = d[at + 8] & 0x10;
    for (const n of [1, 2]) {
      const w = slots[n - 1];
      writeParam(d, P(at + n - 1, `Effect ${n} type`), w ? w.type : M.NO_EFFECT);
      if (!w) continue;
      writeParam(d, P(at + 2 + (n - 1) * 2, `Effect ${n} balance`), clamp(w.level * 100, 0, 100));
      on |= 3 << ((n - 1) * 2);
      r.mapped.push(`Effect ${n}: ${M.EFFECTS[w.type]}`);
    }
    d[at + 8] = on;
    if (slots.length) r.approximated.push('Effect parameters at the M1\'s defaults for each type');
  }

  // ------------------------------------------------------------ program
  function programToCommon(d) {
    const g = (o, l) => readParam(d, PP(o, l));
    const mode = d[10];
    const osc = (n) => {
      const b = n === 1 ? 0 : 40;
      const ms = d[n === 1 ? 12 : 14];
      const oct = g(n === 1 ? 13 : 15);
      return {
        wave: mode === 2 ? `drum-kit:${ms + 1}` : ms >= 100 ? `m1-card:${ms - 100}` : SYNTH_OF[M.MULTISOUNDS[ms]] || `rom:${M.MULTISOUNDS[ms]}`,
        ...(PULSE_WIDTH[M.MULTISOUNDS[ms]] ? { pulseWidth: PULSE_WIDTH[M.MULTISOUNDS[ms]] } : {}),
        coarse: 12 * oct + (n === 2 ? g(16) : 0), fine: n === 2 ? g(17) : 0, level: g(86 + b) / 99,
      };
    };
    const oscs = mode === 1 ? [osc(1), osc(2)] : [osc(1)];
    const [l1, l2] = [g(86), g(126)];
    const eg = (at, dt, st, sl, rt) => ({ attack: g(at) / 99, decay: (g(dt) + g(st)) / 198, sustain: Math.max(0, g(sl)) / 99, release: g(rt) / 99 });
    const pSel = d[19] >> 5 & 3;
    const fSel = d[23] >> 5 & 3;
    return {
      model: COMMON_MODEL, kind: 'program',
      voice: { mode: d[11] & 1 ? 'mono' : 'poly', bendUp: Math.abs(g(32)), bendDown: Math.abs(g(32)) },
      osc: oscs,
      mix: { balance: mode === 1 && (l1 || l2) ? (l2 - l1) / Math.max(l1, l2) : -1 },
      pitch: {
        lfo1: pSel ? g(22) / 99 : 0, target: ['osc1+2', 'osc1', 'osc2', 'osc1+2'][pSel],
        envDepth: g(63) / 99, env: { attack: g(64) / 99, decay: g(66) / 99 },
      },
      filter: { type: 'lpf', cutoff: g(71) / 99, resonance: 0, keyTrack: g(73) / 99, envDepth: g(74) / 99, lfo2: fSel ? g(26) / 99 : 0, env: eg(78, 80, 82, 83, 84) },
      amp: { level: Math.max(l1, mode === 1 ? l2 : 0) / 99, env: eg(92, 94, 96, 97, 98), pan: 'off' },
      lfo: [
        { wave: MG_WAVES[d[19] & 3], rate: g(20) / 99, fade: g(21) / 99 },
        { wave: MG_WAVES[d[23] & 3], rate: g(24) / 99, fade: g(25) / 99, target: 'filter' },
      ],
      effects: effectsOf(d, PP, 38),
      ...(mode === 2 ? { drums: true } : {}),
      extra: { family: FAMILY, model: 'korg-m1', program: toBase64(d), match: hashBytes(d.subarray(10)) },
    };
  }

  function programFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.program) {
      const src = fromBase64(c.extra.program);
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} program bytes (same family)`);
      return { data: d, report: r };
    }
    const set = (o, v, label, what) => { if (v === undefined || v === null || Number.isNaN(v)) return; writeParam(d, PP(o, label), Math.round(v)); if (what) r.mapped.push(what); };
    const both = (o, v, label, what) => { set(o, v, label, what); set(o + 40, v, label); };

    // oscillators
    const oscs = (c.osc || []).filter((o) => o && o.on !== false);
    if (!oscs.length) oscs.push({ wave: 'saw' });
    if ((c.osc || []).length > 2) r.dropped.push(`${c.osc.length - 2} oscillator(s) beyond OSC1 and OSC2`);
    const pair = oscs.slice(0, 2);
    const drums = /^drum-kit:(\d)$/.exec(pair[0].wave || '');
    set(10, drums ? 2 : pair.length > 1 ? 1 : 0, 'OSC mode', 'OSC mode');
    const msFor = (o, n) => {
      const w = String(o.wave || 'saw');
      const rom = /^rom:(.*)$/.exec(w);
      if (rom) {
        const i = nearestName(rom[1], M.MULTISOUNDS);
        if (i >= 0) { if (M.MULTISOUNDS[i] !== rom[1]) r.approximated.push(`OSC${n} ${rom[1]} → ${M.MULTISOUNDS[i]}`); return i; }
      }
      const card = /^m1-card:(\d+)$/.exec(w);
      if (card) return 100 + Number(card[1]);
      const name = w === 'pulse' && (o.pulseWidth ?? 0.25) < 0.17 ? '10% Pulse' : SYNTH_MS[w] || 'Saw Wave';
      if (!EXACT_SYNTH.has(w)) r.approximated.push(`OSC${n} ${w} → ${name}`);
      return M.MULTISOUNDS.indexOf(name);
    };
    const octOf = (coarse, n) => {
      if (typeof coarse === 'string') { r.approximated.push(`OSC${n} range ${coarse} → ${coarse === 'wide+' ? "4'" : "16'"}`); return coarse === 'wide+' ? 1 : -1; }
      return clamp((coarse || 0) / 12, -1, 1);
    };
    if (drums) set(12, Number(drums[1]) - 1, 'OSC1 Multisound', 'Drum kit');
    else set(12, msFor(pair[0], 1), 'OSC1 Multisound', 'OSC1 multisound');
    const c1 = typeof pair[0].coarse === 'number' ? pair[0].coarse : 0;
    const o1 = octOf(pair[0].coarse, 1);
    set(13, o1, 'OSC1 Octave', 'OSC1 octave');
    if (Math.abs(c1 - 12 * o1) >= 1 && typeof pair[0].coarse === 'number') r.approximated.push(`OSC1 ${c1} semitones → ${12 * o1} (octaves only)`);
    if (pair[1]) {
      set(14, msFor(pair[1], 2), 'OSC2 Multisound', 'OSC2 multisound');
      const c2 = typeof pair[1].coarse === 'number' ? pair[1].coarse : 0;
      const o2 = octOf(pair[1].coarse, 2);
      set(15, o2, 'OSC2 Octave', 'OSC2 octave');
      const iv = c2 - 12 * o2;
      set(16, clamp(iv, -12, 12), 'OSC2 Interval', 'OSC2 interval');
      if (Math.abs(iv) > 12) r.approximated.push(`OSC2 interval ${iv} → ±12`);
      set(17, clamp((pair[1].fine || 0) - (pair[0].fine || 0), -50, 50), 'OSC2 Detune', 'OSC2 detune');
      if (pair[1].sync) r.dropped.push('Oscillator sync');
    }
    if (pair[0].fine) r.approximated.push('OSC1 fine tune → OSC2 detune (relative)');
    // levels and balance
    const a = c.amp || {};
    const b = pair.length > 1 ? (c.mix?.balance ?? 0) : -1;
    const lv = (o, k) => 99 * (a.level ?? 1) * (o?.level ?? 1) * (k ? (b < 0 ? 1 + b : 1) : (b > 0 ? 1 - b : 1));
    set(86, lv(pair[0], 0), 'Level', 'OSC1 level');
    if (pair[1]) set(126, lv(pair[1], 1), 'Level', 'OSC2 level / balance');
    if (c.mix?.ring) r.dropped.push('Ring modulator');
    if (c.mix?.crossMod) r.dropped.push('Cross modulation');

    // voice
    const v = c.voice || {};
    if (v.mode) {
      writeParam(d, PP(11, 'Voice mode'), v.mode === 'mono' || v.mode === 'legato' ? 1 : 0); r.mapped.push('Voice mode');
      if (v.mode === 'legato') r.approximated.push('Legato → MONO');
      if (v.mode === 'unison') r.approximated.push('Unison → POLY (DOUBLE with detune is the M1\'s nearest)');
    }
    if (v.bendUp !== undefined || v.bendDown !== undefined) {
      set(32, clamp(Math.max(v.bendUp ?? 0, v.bendDown ?? 0), 0, 12), 'Pitch bend range', 'Pitch bend range');
      if ((v.bendUp ?? 0) !== (v.bendDown ?? 0)) r.approximated.push('Bend up/down → one pitch bend range');
    }
    if (v.portamento?.on) r.dropped.push('Portamento (the M1 has none)');
    if (v.octave) r.dropped.push('Octave shift');

    // pitch: MG and EG
    const p = c.pitch || {};
    const [l1, l2] = c.lfo || [];
    const mgWave = (l, n) => {
      const w = MG_FROM[l?.wave];
      if (l?.wave && w === undefined) r.approximated.push(`LFO ${n} ${l.wave} → TRIANGLE`);
      if (l?.wave === 'sine') r.approximated.push(`LFO ${n} sine → TRIANGLE`);
      return w ?? 0;
    };
    if (p.lfo1 || l1) {
      writeParam(d, PP(19, 'Waveform'), mgWave(l1, 1));
      const sel = !p.lfo1 ? 0 : p.target === 'osc2' ? 2 : 3;
      writeParam(d, PP(19, 'OSC select'), sel);
      set(20, (l1?.rate ?? 0.5) * 99, 'Frequency', 'Pitch MG frequency');
      set(21, (l1?.fade ?? 0) * 99, 'Delay');
      set(22, Math.abs(p.lfo1 || 0) * 99, 'Intensity', 'Pitch MG intensity');
    }
    if (p.lfo2) r.dropped.push('Pitch LFO 2 depth (one pitch MG)');
    if (p.envDepth) {
      both(63, p.envDepth * 99, 'Start level', 'Pitch EG');
      both(64, (p.env?.attack ?? 0) * 99, 'Attack time');
      both(65, 0, 'Attack level');
      both(66, (p.env?.decay ?? 0) * 99, 'Decay time');
      both(67, 0, 'Release time'); both(68, 0, 'Release level');
    }

    // VDF
    const f = c.filter || {};
    const eg8 = (o, e, levelOf = (x) => x) => {
      if (!e) return;
      both(o, e.attack * 99, 'Attack time'); both(o + 1, levelOf(99), 'Attack level'); both(o + 2, e.decay * 99, 'Decay time');
      both(o + 3, levelOf((e.sustain ?? 1) * 99), 'Break point'); both(o + 4, 0, 'Slope time'); both(o + 5, levelOf((e.sustain ?? 1) * 99), 'Sustain level');
      both(o + 6, (e.release ?? 0) * 99, 'Release time');
    };
    if (f.cutoff !== undefined) both(71, f.cutoff * 99, 'Cutoff', 'VDF cutoff');
    if (f.keyTrack !== undefined) both(73, clamp(f.keyTrack * 99, -99, 99), 'Kbd track cutoff', 'VDF keyboard tracking');
    if (f.envDepth !== undefined) {
      both(74, Math.abs(f.envDepth) * 99, 'EG intensity', 'VDF EG intensity');
      if (f.envDepth < 0) r.approximated.push('Negative filter envelope depth → negative VDF EG levels');
    }
    if (f.env) { eg8(78, f.env, (x) => ((f.envDepth ?? 0) < 0 ? -x : x)); both(85, 0, 'Release level'); r.mapped.push('VDF EG'); }
    if (f.type && f.type !== 'lpf') r.approximated.push(`Filter ${f.type} → low pass (the VDF)`);
    if ((f.resonance ?? 0) > 0.05) r.dropped.push('Filter resonance (the M1 VDF has none)');
    const fl = f.lfo2 ? l2 : f.lfo1 ? l1 : null;
    if (fl) {
      writeParam(d, PP(23, 'Waveform'), mgWave(fl, f.lfo2 ? 2 : 1));
      writeParam(d, PP(23, 'VDF select'), 3);
      set(24, (fl.rate ?? 0.5) * 99, 'Frequency', 'VDF MG frequency');
      set(25, (fl.fade ?? 0) * 99, 'Delay');
      set(26, Math.abs(f.lfo2 || f.lfo1) * 99, 'Intensity', 'VDF MG intensity');
    }

    // VDA
    if (a.env) {
      const e = a.env;
      both(92, e.attack * 99, 'Attack time'); both(93, 99, 'Attack level'); both(94, e.decay * 99, 'Decay time');
      both(95, (e.sustain ?? 1) * 99, 'Break point'); both(96, 0, 'Slope time'); both(97, (e.sustain ?? 1) * 99, 'Sustain level');
      both(98, (e.release ?? 0) * 99, 'Release time');
      r.mapped.push('VDA EG');
    }
    if (a.lfo1 || a.lfo2) r.dropped.push('Amp LFO (the M1 has no amplitude MG)');
    if (a.pan && a.pan !== 'off') r.dropped.push(`Pan mode ${a.pan}`);

    effectsInto(d, PP, 38, c.effects, r);
    if (c.tone && (c.tone.bass || c.tone.treble)) r.dropped.push('Tone (bass/treble)');
    if (c.velocity?.depths && Object.keys(c.velocity.depths).length) r.dropped.push('Velocity depths');
    if (c.controller?.depths && Object.keys(c.controller.depths).length) r.dropped.push('Controller depths');
    return { data: d, report: tidy(r) };
  }

  // ------------------------------------------------------------ combination
  const PAN_A_B = 10; // panpot 0 = A ... 10 = B; 11 C, 12 C+D, 13 D (outputs 3/4)
  function combiToCommon(d) {
    const parts = Array.from({ length: 8 }, (_, t) => {
      const b = 36 + t * 11;
      const g = (o, l) => readParam(d, CP(b + o, l));
      const pan = d[b + 4] & 0x7f;
      return {
        on: !(d[b + 10] & 0x10), program: d[b], channel: d[b + 10] & 15, level: g(1, 'Level') / 99,
        transpose: g(2, 'Transpose'), fine: g(3, 'Detune'),
        pan: pan <= PAN_A_B ? (pan - 5) / 5 : 0, output: pan > PAN_A_B ? ['C', 'C+D', 'D'][pan - 11] : undefined,
        low: d[b + 6], high: d[b + 5], velLow: d[b + 8], velHigh: d[b + 7],
      };
    });
    return {
      model: COMMON_MODEL, kind: 'combination',
      keyMode: KEY_MODES[d[10]] || 'single',
      ...(d[10] === 2 ? { splitPoint: d[53] } : {}),
      parts,
      effects: effectsOf(d, CP, 11),
      extra: { family: FAMILY, model: 'korg-m1', combination: toBase64(d), match: hashBytes(d.subarray(10)) },
    };
  }

  function combiFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.combination) {
      const src = fromBase64(c.extra.combination);
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} combination bytes (same family)`);
      return { data: d, report: r };
    }
    const parts = (c.parts || []).filter(Boolean);
    const chans = new Set(parts.filter((p) => p.on !== false && typeof p.channel === 'number').map((p) => p.channel));
    let type = KEY_FROM[c.keyMode];
    if (type === undefined) type = chans.size > 1 ? 4 : parts.length > 1 ? 1 : 0;
    if (type !== 4 && chans.size > 1) r.approximated.push(`Part channels → the global channel (${KEY_MODES[type].toUpperCase()} plays its timbres from the keyboard)`);
    writeParam(d, CP(10, 'Combination type'), type);
    r.mapped.push(`Combination type ${KEY_MODES[type].toUpperCase()}`);
    if (type === 2 && typeof c.splitPoint === 'number') writeParam(d, CP(53, 'Split point'), clamp(c.splitPoint, 1, 127));
    parts.slice(0, 8).forEach((p, t) => {
      const b = 36 + t * 11;
      const set = (o, l, v, what) => { if (v === undefined || v === null || Number.isNaN(v)) return; writeParam(d, CP(b + o, l), Math.round(v)); if (what) r.mapped.push(`Timbre ${t + 1} ${what}`); };
      if (p.on === false) d[b + 10] |= 0x10; else d[b + 10] &= ~0x10;
      if (typeof p.channel === 'number' && type === 4) set(10, 'MIDI channel', p.channel & 15, 'MIDI channel');
      if (p.level !== undefined) set(1, 'Level', p.level * 99, 'level');
      if (typeof p.transpose === 'number') { set(2, 'Transpose', clamp(p.transpose, -24, 24), 'transpose'); if (Math.abs(p.transpose) > 24) r.approximated.push(`Timbre ${t + 1} transpose → ±24`); }
      if (typeof p.fine === 'number') set(3, 'Detune', clamp(p.fine, -50, 50), 'detune');
      if (typeof p.pan === 'number' && !(d[b + 4] & 0x80)) set(4, 'Panpot', clamp(5 + p.pan * 5, 0, 10), 'panpot');
      if (typeof p.low === 'number') set(6, 'Key window bottom', p.low, 'key window');
      if (typeof p.high === 'number') set(5, 'Key window top', p.high);
      if (typeof p.velLow === 'number') set(8, 'Velocity window bottom', clamp(p.velLow, 1, 127), 'velocity window');
      if (typeof p.velHigh === 'number') set(7, 'Velocity window top', clamp(p.velHigh, 1, 127));
    });
    if (parts.length > 8) r.dropped.push(`${parts.length - 8} part(s) beyond the M1's 8 timbres`);
    if (parts.length) r.approximated.push('Timbre programs left to choose (another model\'s program numbers do not apply to the M1)');
    if (c.tempo) r.dropped.push('Tempo and arpeggio');
    effectsInto(d, CP, 11, c.effects, r);
    return { data: d, report: tidy(r) };
  }

  return { programToCommon, programFromCommon, combiToCommon, combiFromCommon };
}

/** Write a 10-character M1 name. */
export function setM1Name(d, name) {
  for (let i = 0; i < 10; i++) d[i] = Math.max(32, Math.min(127, String(name ?? '').charCodeAt(i) || 32));
}
