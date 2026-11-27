// Alesis Wedge programs <-> the shared synth model (docs/HEAD_LIBRARY.md), effects section only.
//
// toCommon: each effect of the configuration (its pages share a title: ROOM, CHORUS, DLY...) becomes
//   effects.reverb {type, time, level, preDelay}, effects.delay {type, time, feedback, level} or
//   effects.modulation {type, rate, depth, level} (chorus types also as effects.chorus), with amounts
//   0..1 of each parameter's range and delay times as ms / 2500 (the Wedge's longest delay, 2.499 s).
//   The program itself goes in extra (family 'alesis-wedge'), so Wedge -> Wedge is exact.
// fromCommon: the same family loads the exact bytes; anything else picks the configuration that holds
//   the wanted effects, starts from the first preset that uses it, and sets decay, pre-delay, delay
//   time, feedback, rate, depth and the mixes. Everything else keeps the preset's values (reported).

import { emptyReport } from '../../core/mainlib/common.js';
import { effectKind, hashBytes, tidy } from './translate-helpers.js';

const FAMILY = 'alesis-wedge';
const DELAY_MAX_MS = 2500;

/** Kind of effect a page title names (the Wedge's own abbreviations included). */
export function wedgeKind(title) {
  const t = String(title).toUpperCase();
  if (/LEZLIE/.test(t)) return 'rotary';
  if (/PITCH/.test(t)) return 'pitch';
  if (/CHRS\/FLANGE/.test(t)) return 'flanger';
  if (/CHRS|CHORUS/.test(t)) return 'chorus';
  if (/FLNG|FLANGE/.test(t)) return 'flanger';
  if (/DLY|DELAY|MULTI TAP/.test(t)) return 'delay';
  if (/^RM$|ROOM|HALL|PLATE|AMBIEN|CHAMBER|NONLINEAR|REVERB/.test(t)) return 'reverb';
  return effectKind(t);
}

/** Translator for an Alesis Wedge-family program: parameters at byte `at` (24 on the Wedge, 16 on the
 *  MIDIVerb 4 from byte 10), exact copies within one `family`. */
export function wedgeTranslator({ ALGORITHMS, paramInfo, presetData, fitProgram, setName, nameOf, SIZE, at = 14, count = 24, family = FAMILY, model = 'alesis-wedge', presets = 128 }) {
  /** The configuration's effects: [{title, kind, params: [{i, label, max}]}] in page order. */
  function effectsOf(cfg) {
    const a = ALGORITHMS[cfg];
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = paramInfo(a, i);
      if (!p) continue;
      let e = out.find((x) => x.title === p.title);
      if (!e) { e = { title: p.title, kind: wedgeKind(p.title), params: [] }; out.push(e); }
      e.params.push({ i, label: p.label.replace(/^[A-Z0-9]+:/, ''), max: p.max });
    }
    return out;
  }
  const find = (e, labels) => labels.map((l) => e.params.find((p) => p.label === l)).find(Boolean);
  const amount = (d, p) => (p && p.max ? d[at + p.i] / p.max : undefined);
  const delayMs = (d, e) => {
    const [h, t, o] = ['100mS', '10mS', '1mS'].map((l) => find(e, [l]));
    if (!h) { const t1 = find(e, ['Time1']); return t1 ? (d[at + t1.i] / t1.max) * DELAY_MAX_MS : undefined; }
    return d[at + h.i] * 100 + (t ? d[at + t.i] * 10 : 0) + (o ? d[at + o.i] : 0);
  };

  function toCommon(d) {
    const effects = {};
    for (const e of effectsOf(d[1])) {
      const mix = amount(d, find(e, ['Mix', 'RMix', 'DMix', 'CMix', 'FMix', 'LMix'])) ?? amount(d, find(e, ['PMix'])) ?? 1;
      if (e.kind === 'reverb' && !effects.reverb) {
        effects.reverb = { type: e.title, level: mix, time: amount(d, find(e, ['Decay', 'Time'])), preDelay: amount(d, find(e, ['PDly'])) };
      } else if (e.kind === 'delay' && !effects.delay) {
        const ms = delayMs(d, e);
        effects.delay = { type: e.title, level: mix, time: ms === undefined ? undefined : Math.min(1, ms / DELAY_MAX_MS), feedback: amount(d, find(e, ['Fdbk', 'MFdbk', 'Fdbk1'])) };
      } else if (!effects.modulation && e.kind !== 'reverb' && e.kind !== 'delay') {
        const m = { type: e.title, level: mix, rate: amount(d, find(e, ['Rate', 'Speed'])), depth: amount(d, find(e, ['Depth'])) };
        effects.modulation = m;
        if (e.kind === 'chorus') effects.chorus = { ...m };
      }
    }
    return {
      model: 1, kind: 'effect', effects,
      extra: { family, model, configuration: ALGORITHMS[d[1]]?.name, data: Array.from(d), match: hashBytes(d.subarray(1)) },
    };
  }

  /** The configuration for the wanted effects, by name. */
  function pickConfig(fx) {
    const rv = fx.reverb && (fx.reverb.level ?? 1) > 0 ? fx.reverb : null;
    const dl = fx.delay && (fx.delay.level ?? 1) > 0 ? fx.delay : null;
    const md = [fx.modulation, fx.chorus].find((m) => m && (m.level ?? 1) > 0) || null;
    const mk = md ? wedgeKind(md.type || 'chorus') : null;
    const rt = rv ? String(rv.type || '').toUpperCase() : '';
    const has = (n) => ALGORITHMS.some((a) => a.name === n);
    const room = has('ROOM+DELAY') ? 'ROOM' : 'REALROOM'; // the MIDIVerb 4 names its room REALROOM
    let name;
    if (rv && dl) name = `${room}+DELAY`;
    else if (rv && md) name = mk === 'flanger' ? `${room}+FLANGE` : mk === 'rotary' ? 'LEZLIE~ROOM' : `${room}+CHORUS`;
    else if (rv) {
      name = [[/PLATE/, ['PLATE', 'PLATE REVERB']], [/HALL|CATHEDRAL|CHURCH/, ['LARGE HALL', 'CONCERT HALL']], [/AMBIEN/, ['AMBIENCE']],
        [/CHAMBER/, ['CHAMBER', 'REAL ROOM']], [/GATE|NONLIN/, ['NONLINEAR']], [/./, ['ROOM REVERB', 'REAL ROOM']]]
        .find(([re]) => re.test(rt || 'ROOM'))[1].find(has);
    } else if (dl) name = 'MONO DELAY';
    else if (md) name = [mk === 'flanger' ? ['CHRS/FLANGE', 'STEREO FLANGE'] : mk === 'rotary' ? ['LEZLIE~ROOM'] : mk === 'pitch' ? ['QUAD PITCH', 'STEREOPITCHSHFT'] : ['QUAD CHORUS', 'STEREO CHORUS']].flat().find(has);
    return name ? ALGORITHMS.findIndex((a) => a.name.trim() === name) : -1;
  }

  function fromCommon(c, base) {
    const r = emptyReport();
    const x = c?.extra;
    if (x?.family === family && Array.isArray(x.data) && x.data.length === SIZE) {
      const d = Uint8Array.from(x.data);
      if (fitProgram(d)) r.approximated.push('Values above the configuration\'s ranges limited');
      r.mapped.push(`Program (exact, ${ALGORITHMS[d[1]]?.name})`);
      return { data: d, report: tidy(r) };
    }
    const fx = c?.effects || {};
    const cfg = pickConfig(fx);
    let d;
    if (cfg < 0) {
      d = Uint8Array.from(base || presetData(0));
      r.dropped.push('No effect in the source sound: the program keeps its configuration and settings');
      return { data: d, report: tidy(r) };
    }
    let n = 0;
    for (; n < presets; n++) if (presetData(n)[1] === cfg) break;
    if (n >= presets) n = 0;
    d = presetData(n);
    d[1] = cfg;
    fitProgram(d);
    r.approximated.push(`Configuration ${ALGORITHMS[cfg].name}, starting from preset ${String(n).padStart(3, '0')} "${nameOf(presetData(n))}"`);
    const put = (p, u, what) => {
      if (!p || u === undefined || u === null || Number.isNaN(u)) return;
      d[at + p.i] = Math.max(0, Math.min(p.max, Math.round(u * p.max)));
      r.approximated.push(what);
    };
    for (const e of effectsOf(cfg)) {
      const mixP = find(e, ['Mix', 'RMix', 'DMix', 'CMix', 'FMix', 'LMix']) || find(e, ['PMix']);
      if (e.kind === 'reverb' && fx.reverb) {
        put(find(e, ['Decay', 'Time']), fx.reverb.time, `Reverb time → ${e.title} decay`);
        put(find(e, ['PDly']), fx.reverb.preDelay, `Reverb pre-delay → ${e.title} PDly`);
        put(mixP, fx.reverb.level, `Reverb level → ${e.title} mix`);
      } else if (e.kind === 'delay' && fx.delay) {
        const h = find(e, ['100mS']);
        if (h && fx.delay.time !== undefined) {
          const ms = Math.max(0, Math.min(h.max * 100 + 99, Math.round(fx.delay.time * DELAY_MAX_MS)));
          d[at + h.i] = Math.min(h.max, Math.floor(ms / 100));
          const t = find(e, ['10mS']); const o = find(e, ['1mS']);
          if (t) d[at + t.i] = Math.min(t.max, Math.floor(ms / 10) % 10);
          if (o) d[at + o.i] = Math.min(o.max, ms % 10);
          r.approximated.push(`Delay time → ${ms} ms`);
        }
        put(find(e, ['Fdbk']), fx.delay.feedback, 'Delay feedback');
        put(mixP, fx.delay.level, 'Delay level → mix');
      } else if (!['reverb', 'delay'].includes(e.kind)) {
        const m = fx.modulation || fx.chorus;
        if (!m) continue;
        put(find(e, ['Rate', 'Speed']), m.rate, `${m.type || 'Modulation'} rate`);
        put(find(e, ['Depth']), m.depth, `${m.type || 'Modulation'} depth`);
        put(mixP, m.level, `${m.type || 'Modulation'} level → mix`);
      }
    }
    for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
    if (fx.chorus && fx.modulation && fx.chorus.type !== fx.modulation.type) r.dropped.push(`Chorus ${fx.chorus.type} (one modulation effect)`);
    if (base) setName(d, nameOf(base));
    return { data: d, report: tidy(r) };
  }

  return { toCommon, fromCommon, effectsOf, pickConfig };
}
