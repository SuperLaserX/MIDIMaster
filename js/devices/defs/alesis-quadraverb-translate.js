// Alesis Quadraverb programs <-> the shared synth model (intdocs/HEAD_LIBRARY.md), effects section only.
//
// toCommon: the configuration's effects become effects.reverb {type, time, preDelay, level},
//   effects.delay {type, time, feedback, level} and effects.modulation {type, rate, depth, level}
//   (chorus modes also as effects.chorus; the Lezlie as type 'LEZLIE'). Amounts are 0..1 of the page
//   ranges, delay times ms / 1500 (the longest Quadraverb delay), pre-delay ms / 140. The program
//   itself goes in extra (family 'alesis-quadraverb'), so Quadraverb -> Quadraverb is exact.
// fromCommon: the same family loads the exact bytes; anything else picks the configuration holding
//   the wanted effects, starts from the first factory program that uses it and sets the reverb type,
//   decay, pre-delay, delay time and feedback, chorus speed and depth and the output levels.

import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';

const FAMILY = 'alesis-quadraverb';
const DELAY_MAX_MS = 1500;
// program bytes (alesis-quadraverb.js header; pages in alesis-quadraverb-fw.js)
const B = {
  cfg: 0x44, pitchMode: 0x1a, lfoSpeed: 0x1d, lfoDepth: 0x1e, lezSpeed: 0x24, delayType: 0x27, delayTime: 0x2a,
  feedback: 0x2c, revType: 0x32, preDelay: 0x37, decay: 0x39, pitchOut: 0x48, delayOut: 0x49, revOut: 0x4a, revChorus: 0x1a,
};
const REV_TYPES = ['PLATE', 'ROOM', 'CHAMBER', 'HALL', 'REVERSE'];
const PITCH_MODES = ['MONO CHORUS', 'STEREO CHORUS', 'MONO FLANGE', 'STEREO FLANGE', 'PITCH DETUNE', 'PHASE SHIFTER'];
// configurations holding each effect (Quadraverb; the Plus adds RING / RESONATOR→DL→REVERB and SAMPLING)
const QV_HAS = { reverb: [0, 1, 4], delay: [0, 1, 2, 3], pitch: [0, 3], lezlie: [1] };

export function quadraverbTranslator({ has, family, model, CONFIGS, presetData, presets, fitProgram, setName, nameOf, locate, SIZE, fromFamily, moreEffects }) {
  const HAS = has || QV_HAS;
  const FAMILY_ID = family || FAMILY;
  const u = (v, max) => Math.max(0, Math.min(1, v / max));
  const w16 = (d, o) => (d[o] << 8) | d[o + 1];

  function toCommon(d) {
    const cfg = d[B.cfg];
    const effects = {};
    if (HAS.reverb.includes(cfg)) {
      effects.reverb = { type: REV_TYPES[d[B.revType]] || 'PLATE', time: u(d[B.decay], 99), preDelay: u(d[B.preDelay], 140), level: u(d[B.revOut], 99) };
    }
    if (HAS.delay.includes(cfg)) {
      effects.delay = { type: ['MONO DELAY', 'STEREO DELAY', 'PING PONG DELAY'][d[B.delayType]] || 'MONO DELAY', time: u(w16(d, B.delayTime), DELAY_MAX_MS), feedback: u(d[B.feedback], 99), level: u(d[B.delayOut], 99) };
    }
    if (HAS.pitch.includes(cfg)) {
      const type = PITCH_MODES[d[B.pitchMode]] || 'MONO CHORUS';
      const m = { type, rate: u(d[B.lfoSpeed], 98), depth: u(d[B.lfoDepth], 98), level: u(d[B.pitchOut], 99) };
      effects.modulation = m;
      if (/CHORUS/.test(type)) effects.chorus = { ...m };
    } else if (HAS.lezlie.includes(cfg)) {
      effects.modulation = { type: 'LEZLIE', rate: d[B.lezSpeed] ? 1 : 0, level: u(d[B.pitchOut], 99) };
    } else if (cfg === 4 && d[B.revChorus]) {
      effects.chorus = { type: 'REVERB CHORUS', rate: u(d[B.lfoSpeed], 98), depth: u(d[B.lfoDepth], 98), level: 1 };
    }
    moreEffects?.(d, effects);
    return {
      model: 1, kind: 'effect', effects,
      extra: { family: FAMILY_ID, model: model || 'alesis-quadraverb', configuration: CONFIGS[cfg], data: Array.from(d), match: hashBytes(d) },
    };
  }

  function pickConfig(fx) {
    const on = (e) => e && (e.level ?? 1) > 0;
    const md = [fx.modulation, fx.chorus].find(on);
    if (md && /LEZ|LESLIE|ROTARY/i.test(md.type || '')) return 1;
    if (on(fx.reverb)) return on(fx.delay) || md ? 0 : 4;
    if (on(fx.delay) || md) return 3;
    return -1;
  }

  function fromCommon(c, base) {
    const r = emptyReport();
    const x = c?.extra;
    if (x?.family === FAMILY_ID && Array.isArray(x.data) && x.data.length === SIZE && x.data[B.cfg] < CONFIGS.length) {
      const d = Uint8Array.from(x.data); // as it is: the unit stores dumps unchecked
      r.mapped.push(`Program (exact, ${CONFIGS[d[B.cfg]]})`);
      return { data: d, report: tidy(r) };
    }
    // another family whose programs the unit loads itself (the GT takes Quadraverb programs, converting them)
    if (fromFamily && x?.family === fromFamily.family && Array.isArray(x.data) && x.data.length === SIZE && x.data[B.cfg] < CONFIGS.length) {
      const d = fromFamily.convert(Uint8Array.from(x.data));
      r.mapped.push(`Program (${CONFIGS[d[B.cfg]]})`);
      r.approximated.push(fromFamily.note);
      return { data: d, report: tidy(r) };
    }
    const fx = c?.effects || {};
    const cfg = pickConfig(fx);
    if (cfg < 0) {
      r.dropped.push('No effect in the source sound: the program keeps its configuration and settings');
      return { data: Uint8Array.from(base || presetData(0)), report: tidy(r) };
    }
    let n = 0;
    while (n < presets && presetData(n)[B.cfg] !== cfg) n++;
    const d = presetData(n < presets ? n : 0);
    d[B.cfg] = cfg;
    r.approximated.push(`Configuration ${CONFIGS[cfg]}, starting from Alesis program ${String(n).padStart(2, '0')} "${nameOf(d)}"`);
    const put = (o, v, max, what, min = 0) => {
      if (v === undefined || v === null || Number.isNaN(v)) return;
      d[o] = Math.max(min, Math.min(max, Math.round(v * max)));
      r.approximated.push(what);
    };
    if (fx.reverb && HAS.reverb.includes(cfg)) {
      const t = String(fx.reverb.type || '').toUpperCase();
      const k = REV_TYPES.findIndex((n2) => t.includes(n2));
      d[B.revType] = k >= 0 ? k : /GATE|NONLIN/.test(t) ? 0 : /AMBIEN|STUDIO|SMALL/.test(t) ? 1 : d[B.revType];
      r.approximated.push(`Reverb type → ${REV_TYPES[d[B.revType]]}`);
      put(B.decay, fx.reverb.time, 99, 'Reverb time → decay');
      put(B.preDelay, fx.reverb.preDelay, 140, 'Reverb pre-delay', 1);
      put(B.revOut, fx.reverb.level, 99, 'Reverb level → reverb output level');
    }
    if (fx.delay && HAS.delay.includes(cfg)) {
      if (fx.delay.time !== undefined) {
        const lim = locate(d, B.delayTime, 2)?.desc.max ?? 400; // the DELAY TIME page of this configuration and type
        const ms = Math.max(1, Math.min(lim, Math.round(fx.delay.time * DELAY_MAX_MS)));
        d[B.delayTime] = ms >> 8; d[B.delayTime + 1] = ms & 0xff;
        r.approximated.push(`Delay time → ${ms} ms`);
      }
      put(B.feedback, fx.delay.feedback, 99, 'Delay feedback');
      put(B.delayOut, fx.delay.level, 99, 'Delay level → delay output level');
    }
    const m = fx.modulation || fx.chorus;
    if (m && HAS.pitch.includes(cfg)) {
      const t = String(m.type || '').toUpperCase();
      d[B.pitchMode] = /FLANG/.test(t) ? 3 : /PHAS/.test(t) ? 5 : /DETUNE|PITCH/.test(t) ? 4 : 1;
      r.approximated.push(`${m.type || 'Modulation'} → ${PITCH_MODES[d[B.pitchMode]]}`);
      put(B.lfoSpeed, m.rate, 98, 'Modulation rate → LFO speed');
      put(B.lfoDepth, m.depth, 98, 'Modulation depth → LFO depth');
      put(B.pitchOut, m.level, 99, 'Modulation level → pitch output level');
    } else if (m && cfg === 1) {
      d[B.lezSpeed] = (m.rate ?? 0) >= 0.5 ? 1 : 0;
      r.approximated.push(`Rotary speed → ${d[B.lezSpeed] ? 'FAST' : 'SLOW'}`);
    }
    for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
    fitProgram(d);
    if (base) setName(d, nameOf(base));
    return { data: d, report: tidy(r) };
  }

  return { toCommon, fromCommon, pickConfig };
}
