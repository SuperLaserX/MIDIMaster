// Roland JV-2080 patch, performance and rhythm set <-> the shared synth model (core/mainlib/common.js).
//
// A patch has up to four tones, each a ROM wave (internal INT-A/INT-B, an SR-JV80 board's or a PCM
// card's) with its own pitch, filter (TVF) and amplifier (TVA) envelopes and two LFOs, plus the
// patch's EFX, chorus and reverb. The shared model reads every tone that is switched on as an
// oscillator (`rom:<wave name>`; the internal names are the owner's manual's), and tone 1's TVF,
// TVA, pitch envelope and LFOs as the voice's. The 4-segment envelopes (T1-T4, L1-L4) read as ADSR:
// T1 attack, T2 + T3 decay, L3 sustain, T4 release.
//
// A performance is 16 parts (receive switch and channel, patch, level, pan, tuning, key range) and
// its EFX, chorus and reverb; a rhythm set is 64 keys (35-98), each a one-wave tone. Another model's
// program numbers do not apply here, so performances from other models set the part layout only.
//
// Everything is kept in `extra` (family "roland-jv"), so another JV-2080 restores it exactly.

import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { readParam, writeParam } from '../../core/model/memmap.js';
import { CATEGORIES } from '../../core/mainlib/categories.js';
import { clamp, tidy, nearestName, effectKind, hashBytes } from './translate-helpers.js';
import { INT_A_WAVES, INT_B_WAVES } from './roland-jv2080-waves.js';
import { SRJV80_BOARDS } from './roland-srjv80.js';

const FAMILY = 'roland-jv';
const MODEL_ID = 'roland-jv2080';
const LFO_WAVES = ['triangle', 'sine', 'saw', 'square', 'triangle', 'sample-hold', 'sample-hold', 'sample-hold']; // TRI SIN SAW SQR TRP S&H RND CHS
const LFO_FROM = { triangle: 0, sine: 1, saw: 2, 'saw-up': 2, square: 3, 'sample-hold': 5, random: 6 };
const FILTERS = [null, 'lpf', 'bpf', 'hpf', 'peak']; // OFF LPF BPF HPF PKG
const FILTER_FROM = { lpf: 1, bpf: 2, hpf: 3, peak: 4 };
// INT-B waves that are plain synth waves (owner's manual names), both ways
const SYNTH_OF = { 'Synth Saw 1': 'saw', 'JP-8 Saw A': 'saw', 'Synth Square': 'square', 'JP-8 SquareA': 'square', 'Synth Pulse1': 'pulse', Triangle: 'triangle', Sine: 'sine', 'White Noise': 'noise' };
const SYNTH_WAVE = { saw: 'JP-8 Saw A', ramp: 'JP-8 Saw A', supersaw: 'JP-8 Saw A', 'double-saw': 'JP-8 Saw A', square: 'JP-8 SquareA', pulse: 'Synth Pulse1', triangle: 'Triangle', 'triangle-mod': 'Triangle', sine: 'Sine', noise: 'White Noise', feedback: 'Synth Saw 2' };
const EXACT_SYNTH = new Set(['saw', 'square', 'pulse', 'triangle', 'sine', 'noise']);
const KF16 = [-100, -70, -50, -30, -10, 0, 10, 20, 30, 40, 50, 70, 100, 120, 150, 200];
const REVERBS = ['ROOM1', 'ROOM2', 'STAGE1', 'STAGE2', 'HALL1', 'HALL2', 'DELAY', 'PAN-DLY'];

/** Name of wave n of group (type, id): INT-A/B from the manual, boards from their ROMs. */
export function jvWaveName(type, id, n) {
  if (type === 0) return (id === 1 ? INT_A_WAVES : id === 2 ? INT_B_WAVES : null)?.[n] ?? null;
  if (type === 2) return SRJV80_BOARDS[id]?.waves?.[n] ?? null;
  return null;
}
/** [type, id, n] of a wave name: internal first, then the boards (which must be installed). */
function jvWaveOf(name) {
  for (const [id, list] of [[1, INT_A_WAVES], [2, INT_B_WAVES]]) { const n = list.indexOf(name); if (n >= 0) return [0, id, n]; }
  for (const [id, b] of Object.entries(SRJV80_BOARDS)) { const n = b.waves?.indexOf(name) ?? -1; if (n >= 0) return [2, Number(id), n]; }
  return null;
}
const ALL_INT = [...INT_A_WAVES, ...INT_B_WAVES];

/** B: {patch, perf, rhythm} parameter lists of roland-jv2080.js (params with section and label). */
export function jvTranslator(B) {
  const finder = (params) => {
    const map = new Map(params.map((p) => [`${p.section}|${p.label}`, p]));
    return (section, label) => {
      const p = map.get(`${section}|${label}`);
      if (!p) throw new Error(`JV-2080: no parameter ${section} ${label}`);
      return p;
    };
  };
  const PP = finder(B.patch);
  const FP = finder(B.perf);
  const RP = finder(B.rhythm);
  const io = (P, d, r) => ({
    g: (s, l) => readParam(d, P(s, l)),
    set: (s, l, v, what) => { if (v === undefined || v === null || Number.isNaN(v)) return; writeParam(d, P(s, l), Math.round(v)); if (what) r.mapped.push(what); },
  });
  const optionsOf = (P, s, l) => P(s, l).options.map(([, n]) => n);

  // ------------------------------------------------------------ shared pieces
  const waveOf = (g, s) => {
    const [type, id, n] = [g(s, 'Wave group type'), g(s, 'Wave group ID'), g(s, 'Wave number')];
    const name = jvWaveName(type, id, n);
    return name ? (type === 0 && SYNTH_OF[name]) || `rom:${name}` : `jv-wave:${type}-${id}-${n}`;
  };
  const env4 = (g, s, k) => ({
    attack: g(s, `${k}-env time 1`) / 127, decay: (g(s, `${k}-env time 2`) + g(s, `${k}-env time 3`)) / 254,
    sustain: g(s, `${k}-env level 3`) / 127, release: g(s, `${k}-env time 4`) / 127,
  });
  const setWave = (set, s, o, k, r) => {
    const w = String(o.wave || 'saw');
    let t = null;
    const own = /^jv-wave:(\d)-(\d+)-(\d+)$/.exec(w);
    if (own) t = own.slice(1).map(Number);
    const rom = /^rom:(.*)$/.exec(w);
    if (!t && rom) {
      t = jvWaveOf(rom[1]);
      if (t && t[0] === 2) r.approximated.push(`Wave ${rom[1]} is on the SR-JV80-${String(t[1]).padStart(2, '0')} board (it must be installed)`);
      if (!t) {
        const i = nearestName(rom[1], ALL_INT);
        if (i >= 0) { t = i < INT_A_WAVES.length ? [0, 1, i] : [0, 2, i - INT_A_WAVES.length]; r.approximated.push(`Wave ${rom[1]} → ${ALL_INT[i]}`); }
      }
    }
    if (!t) {
      const name = SYNTH_WAVE[w] || 'JP-8 Saw A';
      if (!EXACT_SYNTH.has(w)) r.approximated.push(`OSC ${k} ${w} → ${name}`);
      t = jvWaveOf(name);
    }
    set(s, 'Wave group type', t[0]); set(s, 'Wave group ID', t[1]); set(s, 'Wave number', t[2], `Tone ${k} wave`);
  };
  const envInto = (set, s, k, e, lv = (x) => x * 127) => {
    if (!e) return;
    set(s, `${k}-env time 1`, e.attack * 127); set(s, `${k}-env level 1`, lv(1));
    set(s, `${k}-env time 2`, e.decay * 127); set(s, `${k}-env level 2`, lv(e.sustain ?? 1));
    set(s, `${k}-env time 3`, 0); set(s, `${k}-env level 3`, lv(e.sustain ?? 1));
    set(s, `${k}-env time 4`, (e.release ?? 0) * 127);
  };

  /** Effects of a patch or performance common block: EFX, chorus, reverb (sends: the tones'). */
  function effectsOf(g, sends) {
    const out = {};
    const efx = optionsOf(PP, 'common', 'EFX type')[g('common', 'EFX type')];
    if (sends.efx) out.modulation = { type: efx, level: g('common', 'EFX mix out send') / 127 };
    if (sends.chorus) out.chorus = { type: 'Chorus', level: (g('common', 'Chorus level') / 127) * sends.chorus, rate: g('common', 'Chorus rate') / 127, depth: g('common', 'Chorus depth') / 127 };
    if (!out.modulation && out.chorus) out.modulation = { type: 'Chorus', level: out.chorus.level };
    const rv = REVERBS[g('common', 'Reverb type')];
    const level = (g('common', 'Reverb level') / 127) * sends.reverb;
    if (sends.reverb && rv) {
      if (rv === 'DELAY' || rv === 'PAN-DLY') out.delay = { type: rv === 'DELAY' ? 'mono-long' : 'panning-lr', time: g('common', 'Reverb time') / 127, feedback: g('common', 'Delay feedback') / 127, level };
      else out.reverb = { type: rv, level, time: g('common', 'Reverb time') / 127 };
    }
    return out;
  }
  /** EFX parameters 1-12 are kept when the type changes: bring each into the new type's range. */
  function fitEfx(set, get) {
    for (let i = 1; i <= 12; i++) {
      const p = get(`EFX parameter ${i}`);
      const dyn = p.dynamic ? p.dynamic(p.data, {}) : {};
      if (dyn.hidden) continue;
      const v = p.value;
      if (Array.isArray(dyn.options) && !dyn.options.some(([x]) => x === v)) set('common', `EFX parameter ${i}`, dyn.options[Math.min(v, dyn.options.length - 1)][0]);
      else if (dyn.max !== undefined && v > dyn.max) set('common', `EFX parameter ${i}`, dyn.max === 30 ? 15 : dyn.max);
    }
  }
  function effectsInto(set, fx, r, tones, get) {
    const efxNames = optionsOf(PP, 'common', 'EFX type');
    let efx = null;
    let chorus = 0;
    const mod = fx?.modulation;
    if (mod && mod.level > 0) {
      const kind = effectKind(mod.type);
      const exact = efxNames.indexOf(String(mod.type || '').toUpperCase());
      if (exact >= 0) efx = { type: exact, level: mod.level };
      else if (kind === 'chorus' || kind === 'other') { chorus = mod.level; r.mapped.push(`Effect ${mod.type} → chorus`); }
      else {
        const t = { flanger: 'STEREO-FLANGER', phaser: 'PHASER', tremolo: 'TREMOLO-CHORUS', rotary: 'ROTARY', distortion: /DIST/i.test(mod.type) ? 'DISTORTION' : 'OVERDRIVE', eq: /ENHAN|EXCIT/i.test(mod.type) ? 'ENHANCER' : 'STEREO-EQ', delay: 'STEREO-DELAY', reverb: 'REVERB' }[kind];
        efx = { type: efxNames.indexOf(t), level: mod.level };
        r.approximated.push(`Effect ${mod.type} → EFX ${t} (its parameters at their defaults)`);
      }
    }
    if (fx?.chorus && fx.chorus.level > 0) chorus = Math.max(chorus, fx.chorus.level);
    const rv = fx?.reverb;
    const dl = fx?.delay;
    let rvSend = 0;
    if (rv && rv.level > 0) {
      const name = String(rv.type || '').toUpperCase();
      let t = REVERBS.indexOf(name);
      if (t < 0 || t > 5) { t = /ROOM/.test(name) ? 0 : /STAGE|PLATE/.test(name) ? 2 : 4; r.approximated.push(`Reverb ${rv.type || ''} → ${REVERBS[t]}`.replace('  ', ' ')); }
      set('common', 'Reverb type', t, 'Reverb type');
      set('common', 'Reverb level', 127);
      if (rv.time !== undefined) set('common', 'Reverb time', rv.time * 127);
      rvSend = rv.level;
      if (dl && dl.level > 0) {
        if (!efx) { efx = { type: efxNames.indexOf('STEREO-DELAY'), level: dl.level }; r.approximated.push('Delay → EFX STEREO-DELAY (its parameters at their defaults)'); } else r.dropped.push('Delay (the reverb and the EFX are in use)');
      }
    } else if (dl && dl.level > 0) {
      set('common', 'Reverb type', /pan/i.test(dl.type || '') ? 7 : 6, 'Delay (reverb type DELAY)');
      set('common', 'Reverb level', 127);
      if (dl.time !== undefined) set('common', 'Reverb time', dl.time * 127);
      if (dl.feedback !== undefined) set('common', 'Delay feedback', dl.feedback * 127);
      rvSend = dl.level;
    }
    if (efx) {
      set('common', 'EFX type', efx.type, `EFX ${efxNames[efx.type]}`);
      set('common', 'EFX mix out send', efx.level * 127);
      fitEfx(set, get);
    }
    if (chorus) set('common', 'Chorus level', 127, 'Chorus');
    for (const s of tones) {
      if (efx) set(s, 'Output assign', 1);
      set(s, 'Chorus send level', chorus * 127);
      set(s, 'Reverb send level', rvSend * 127);
    }
  }

  // ------------------------------------------------------------ patch
  const TONES = ['t0', 't1', 't2', 't3'];
  function patchToCommon(d) {
    const { g } = io(PP, d);
    const on = TONES.filter((s) => g(s, 'Tone switch'));
    const t = on[0] || 't0';
    const osc = on.map((s) => ({
      wave: waveOf(g, s), coarse: g(s, 'Coarse tune') - 48, fine: g(s, 'Fine tune') - 50,
      level: g(s, 'Tone level') / 127, pan: (g(s, 'Tone pan') - 64) / 63,
    }));
    const ft = FILTERS[g(t, 'Filter type')];
    const s63 = (s, l) => (g(s, l) - 63) / 63;
    const sends = {
      efx: on.some((s) => g(s, 'Output assign') === 1),
      chorus: Math.max(0, ...on.map((s) => g(s, 'Chorus send level') / 127)),
      reverb: Math.max(0, ...on.map((s) => g(s, 'Reverb send level') / 127)),
    };
    const [a1, a2] = [osc[0]?.level ?? 0, osc[1]?.level ?? 0];
    const lfo = (n) => ({ wave: LFO_WAVES[g(t, `LFO${n} waveform`)], rate: g(t, `LFO${n} rate`) / 127, fade: g(t, `LFO${n} delay time`) / 127 });
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: {
        mode: g('common', 'Key assign mode') ? (g('common', 'Solo legato') ? 'legato' : 'mono') : 'poly', legato: !!g('common', 'Solo legato'),
        portamento: { on: !!g('common', 'Portamento switch'), time: g('common', 'Portamento time') / 127 },
        bendUp: g('common', 'Bend range up'), bendDown: g('common', 'Bend range down'), octave: clamp(g('common', 'Octave shift') - 3, -2, 2),
      },
      osc,
      mix: { balance: osc.length > 1 && (a1 || a2) ? (a2 - a1) / Math.max(a1, a2) : -1 },
      pitch: {
        lfo1: s63(t, 'LFO1 pitch depth'), lfo2: s63(t, 'LFO2 pitch depth'), envDepth: (g(t, 'P-env depth') - 12) / 12,
        env: { attack: g(t, 'P-env time 1') / 127, decay: (g(t, 'P-env time 2') + g(t, 'P-env time 3')) / 254 }, target: 'osc1+2',
      },
      filter: {
        type: ft || 'lpf', cutoff: ft ? g(t, 'Cutoff frequency') / 127 : 1, resonance: g(t, 'Resonance') / 127,
        keyTrack: KF16[g(t, 'Cutoff keyfollow')] / 100, envDepth: s63(t, 'F-env depth'),
        lfo1: s63(t, 'LFO1 filter depth'), lfo2: s63(t, 'LFO2 filter depth'), env: env4(g, t, 'F'),
      },
      amp: { level: g('common', 'Patch level') / 127, lfo1: s63(t, 'LFO1 level depth'), lfo2: s63(t, 'LFO2 level depth'), env: env4(g, t, 'A'), pan: 'off' },
      lfo: [lfo(1), lfo(2)],
      effects: effectsOf(g, sends),
      extra: { family: FAMILY, model: MODEL_ID, patch: toBase64(d), match: hashBytes(d.subarray(12)) },
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
    const { g, set } = io(PP, d, r);
    const oscs = (c.osc || []).filter((o) => o && o.on !== false);
    if (!oscs.length) oscs.push({ wave: 'saw' });
    if (oscs.length > 4) r.dropped.push(`${oscs.length - 4} oscillator(s) beyond the 4 tones`);
    const used = TONES.slice(0, Math.min(4, oscs.length));
    const a = c.amp || {};
    const f = c.filter || {};
    const p = c.pitch || {};
    const [l1, l2] = c.lfo || [];
    const bal = oscs.length > 1 ? (c.mix?.balance ?? 0) : -1;
    for (const s of TONES) set(s, 'Tone switch', used.includes(s) ? 1 : 0);
    used.forEach((s, k) => {
      const o = oscs[k];
      setWave(set, s, o, k + 1, r);
      if (typeof o.coarse === 'number') { set(s, 'Coarse tune', 48 + o.coarse, `Tone ${k + 1} coarse tune`); if (Math.abs(o.coarse) > 48) r.approximated.push(`Tone ${k + 1} coarse → ±48`); }
      else if (typeof o.coarse === 'string') { set(s, 'Coarse tune', o.coarse === 'wide+' ? 72 : 24); r.approximated.push(`OSC ${k + 1} range ${o.coarse} → two octaves`); }
      if (o.fine !== undefined) set(s, 'Fine tune', 50 + o.fine, `Tone ${k + 1} fine tune`);
      const bf = k === 0 ? (bal > 0 ? 1 - bal : 1) : k === 1 ? (bal < 0 ? 1 + bal : 1) : 1;
      set(s, 'Tone level', 127 * (o.level ?? 1) * bf, `Tone ${k + 1} level`);
      if (typeof o.pan === 'number') set(s, 'Tone pan', 64 + o.pan * 63);
      if (o.sync) r.dropped.push('Oscillator sync');
      // filter
      if (f.type || f.cutoff !== undefined) {
        const ft = FILTER_FROM[f.type || 'lpf'];
        set(s, 'Filter type', ft ?? 1, 'Filter type');
        if (ft === undefined) r.approximated.push(`Filter ${f.type} → LPF`);
      }
      if (f.cutoff !== undefined) set(s, 'Cutoff frequency', f.cutoff * 127, 'Cutoff');
      if (f.resonance !== undefined) set(s, 'Resonance', f.resonance * 127, 'Resonance');
      if (f.keyTrack !== undefined) {
        const want = f.keyTrack * 100;
        set(s, 'Cutoff keyfollow', KF16.reduce((b, x, i) => (Math.abs(x - want) < Math.abs(KF16[b] - want) ? i : b), 0), 'Cutoff keyfollow');
      }
      if (f.envDepth !== undefined) set(s, 'F-env depth', 63 + f.envDepth * 63, 'Filter envelope depth');
      if (f.env) { envInto(set, s, 'F', f.env); set(s, 'F-env level 4', 0); r.mapped.push('Filter envelope'); }
      if (f.lfo1 !== undefined) set(s, 'LFO1 filter depth', 63 + f.lfo1 * 63);
      if (f.lfo2 !== undefined) set(s, 'LFO2 filter depth', 63 + f.lfo2 * 63);
      // amplifier
      if (a.env) { envInto(set, s, 'A', a.env); r.mapped.push('Amp envelope'); }
      if (a.lfo1 !== undefined) set(s, 'LFO1 level depth', 63 + a.lfo1 * 63);
      if (a.lfo2 !== undefined) set(s, 'LFO2 level depth', 63 + a.lfo2 * 63);
      // pitch
      const tgt = p.target || 'osc1+2';
      const pitchHere = tgt === 'osc1+2' || (tgt === 'osc1' && k === 0) || (tgt === 'osc2' && k === 1);
      if (p.lfo1 !== undefined) set(s, 'LFO1 pitch depth', 63 + (pitchHere ? p.lfo1 : 0) * 63, 'Pitch LFO 1');
      if (p.lfo2 !== undefined) set(s, 'LFO2 pitch depth', 63 + (pitchHere ? p.lfo2 : 0) * 63, 'Pitch LFO 2');
      if (p.envDepth) {
        set(s, 'P-env depth', 12 + (pitchHere ? p.envDepth : 0) * 12, 'Pitch envelope');
        set(s, 'P-env time 1', (p.env?.attack ?? 0) * 127); set(s, 'P-env level 1', 126);
        set(s, 'P-env time 2', (p.env?.decay ?? 0) * 127); set(s, 'P-env level 2', 63);
        set(s, 'P-env time 3', 0); set(s, 'P-env level 3', 63); set(s, 'P-env time 4', 0); set(s, 'P-env level 4', 63);
      }
      // LFOs (each tone has its own two; all get the same)
      for (const [n, l] of [[1, l1], [2, l2]]) {
        if (!l) continue;
        if (l.wave) { const w = LFO_FROM[l.wave]; set(s, `LFO${n} waveform`, w ?? 0, `LFO ${n} waveform`); if (w === undefined) r.approximated.push(`LFO ${n} ${l.wave} → TRI`); }
        if (l.rate !== undefined) set(s, `LFO${n} rate`, l.rate * 127, `LFO ${n} rate`);
        if (l.fade !== undefined) set(s, `LFO${n} delay time`, l.fade * 127);
      }
    });
    if (p.target === 'xmod') r.approximated.push('Pitch modulation of cross modulation → the tones\' pitch');
    if (c.mix?.ring || c.mix?.crossMod) r.dropped.push('Ring and cross modulation (the JV-2080 structures 2-10 ring-modulate tone pairs; not set)');

    const v = c.voice || {};
    if (v.mode) {
      set('common', 'Key assign mode', v.mode === 'mono' || v.mode === 'legato' ? 1 : 0, 'Key assign mode');
      set('common', 'Solo legato', v.mode === 'legato' || v.legato ? 1 : 0);
      if (v.mode === 'unison') r.approximated.push('Unison → POLY');
    }
    if (v.portamento) { set('common', 'Portamento switch', v.portamento.on ? 1 : 0, 'Portamento'); set('common', 'Portamento time', (v.portamento.time ?? 0) * 127); }
    if (v.bendUp !== undefined) set('common', 'Bend range up', clamp(v.bendUp, 0, 12), 'Bend range up');
    if (v.bendDown !== undefined) set('common', 'Bend range down', clamp(v.bendDown, 0, 48), 'Bend range down');
    if (v.octave !== undefined) set('common', 'Octave shift', 3 + v.octave, 'Octave shift');
    if (a.level !== undefined) set('common', 'Patch level', a.level * 127, 'Patch level');
    if (a.pan && a.pan !== 'off') r.dropped.push(`Pan mode ${a.pan}`);
    effectsInto(set, c.effects, r, used, (l) => { const q = PP('common', l); return { dynamic: q.dynamic, data: d, value: readParam(d, q) }; });
    if (c.tone && (c.tone.bass || c.tone.treble)) r.dropped.push('Tone (bass/treble)');
    if (c.velocity?.depths && Object.keys(c.velocity.depths).length) r.dropped.push('Velocity depths');
    if (c.controller?.depths && Object.keys(c.controller.depths).length) r.dropped.push('Controller depths');
    return { data: d, report: tidy(r) };
  }

  /** The patch's Category (the Head Library uses the same 38 Roland categories). */
  function patchSetCategory(d, id) {
    const n = CATEGORIES.findIndex(([k]) => k === id);
    if (n > 0) writeParam(d, PP('common', 'Category'), n);
  }

  // ------------------------------------------------------------ performance
  const PARTS = Array.from({ length: 16 }, (_, i) => `p${i}`);
  function perfToCommon(d) {
    const { g } = io(FP, d);
    const parts = PARTS.map((s) => ({
      on: !!g(s, 'Receive switch'), channel: g(s, 'Receive channel'),
      program: { type: g(s, 'Patch group type'), group: g(s, 'Patch group ID'), number: g(s, 'Patch number') },
      level: g(s, 'Part level') / 127, pan: (g(s, 'Part pan') - 64) / 63,
      transpose: g(s, 'Coarse tune') - 48 + 12 * (g(s, 'Octave shift') - 3), fine: g(s, 'Fine tune') - 50,
      low: g(s, 'Key range lower'), high: g(s, 'Key range upper'), rhythm: s === 'p9',
    }));
    const sends = { efx: true, chorus: 1, reverb: 1 };
    return {
      model: COMMON_MODEL, kind: 'performance', keyMode: 'multi', tempo: g('common', 'Tempo'), parts,
      effects: effectsOf((sec, l) => readParam(d, FP(sec, l)), sends),
      extra: { family: FAMILY, model: MODEL_ID, performance: toBase64(d), match: hashBytes(d.subarray(12)) },
    };
  }
  function perfFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.performance) {
      const src = fromBase64(c.extra.performance);
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} performance bytes (same family: ${c.extra.model})`);
      return { data: d, report: r };
    }
    const { set } = io(FP, d, r);
    const parts = (c.parts || []).filter(Boolean);
    const layered = ['single', 'dual', 'layer', 'split', 'velocity-switch'].includes(c.keyMode);
    // keyboard key modes play every part from one channel; the JV plays them on the parts' channels
    if (layered && new Set(parts.map((p) => p.channel)).size > 1) r.approximated.push(`${c.keyMode} → parts on one channel (part 1's), so they play together`);
    const ch0 = typeof parts[0]?.channel === 'number' ? parts[0].channel : 0;
    let n = 0;
    parts.slice(0, 16).forEach((p, i) => {
      const s = PARTS[n === 9 ? ++n : n];
      n++;
      if (!s) { r.dropped.push(`Part ${i + 1}`); return; }
      const k = Number(s.slice(1)) + 1;
      set(s, 'Receive switch', p.on === false ? 0 : 1, `Part ${k} receive switch`);
      const chan = layered ? ch0 : p.channel;
      if (typeof chan === 'number') set(s, 'Receive channel', chan & 15, `Part ${k} channel`);
      if (p.level !== undefined) set(s, 'Part level', p.level * 127, `Part ${k} level`);
      if (typeof p.pan === 'number') set(s, 'Part pan', 64 + p.pan * 63);
      if (typeof p.transpose === 'number') {
        const oct = clamp(p.transpose / 12, -3, 3);
        const rest = p.transpose - 12 * oct;
        set(s, 'Octave shift', Math.abs(rest) > 48 ? 3 : 3 + oct);
        set(s, 'Coarse tune', 48 + (Math.abs(rest) > 48 ? clamp(p.transpose, -48, 48) : rest), `Part ${k} transpose`);
      }
      if (typeof p.fine === 'number') set(s, 'Fine tune', 50 + p.fine);
      if (typeof p.low === 'number') set(s, 'Key range lower', p.low, `Part ${k} key range`);
      if (typeof p.high === 'number') set(s, 'Key range upper', p.high);
      if (typeof p.velLow === 'number' && (p.velLow > 1 || p.velHigh < 127)) r.dropped.push(`Part ${k} velocity window (no per-part velocity range)`);
    });
    if (c.keyMode === 'split' && typeof c.splitPoint === 'number' && parts.length >= 2) {
      // upper part from the split point up, lower part below (JP parts: upper first)
      set('p0', 'Key range lower', c.splitPoint, 'Split point'); set('p1', 'Key range upper', c.splitPoint - 1);
    }
    if (parts.some((p) => typeof p.low === 'number' && (p.low > 0 || p.high < 127)) || c.keyMode === 'split') set('common', 'Key range switch', 1);
    if (parts.length) r.approximated.push('Part patches left to choose (another model\'s program numbers do not apply to the JV-2080)');
    if (typeof c.tempo === 'number') set('common', 'Tempo', c.tempo, 'Tempo');
    if (c.arpeggio?.on) r.dropped.push('Arpeggio (the JV-2080 has none)');
    effectsInto(set, c.effects, r, [], (l) => { const q = FP('common', l); return { dynamic: q.dynamic, data: d, value: readParam(d, q) }; });
    return { data: d, report: tidy(r) };
  }

  // ------------------------------------------------------------ rhythm set
  const KEYS = Array.from({ length: 64 }, (_, i) => 35 + i);
  function rhythmToCommon(d) {
    const { g } = io(RP, d);
    const notes = KEYS.filter((k) => g(`k${k}`, 'Tone switch')).map((k) => {
      const s = `k${k}`;
      const ft = FILTERS[g(s, 'Filter type')];
      return {
        note: k, wave: waveOf(g, s), coarse: g(s, 'Source key') - k, fine: g(s, 'Fine tune') - 50,
        level: g(s, 'Tone level') / 127, pan: (g(s, 'Tone pan') - 64) / 63, muteGroup: g(s, 'Mute group'),
        sustain: !!g(s, 'Envelope mode'),
        filter: { type: ft || 'lpf', cutoff: ft ? g(s, 'Cutoff frequency') / 127 : 1, resonance: g(s, 'Resonance') / 127 },
        env: env4(g, s, 'A'),
      };
    });
    return {
      model: COMMON_MODEL, kind: 'rhythm', notes,
      extra: { family: FAMILY, model: MODEL_ID, rhythm: toBase64(d), match: hashBytes(d.subarray(12)) },
    };
  }
  function rhythmFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.rhythm) {
      const src = fromBase64(c.extra.rhythm);
      d.set(src.subarray(0, d.length));
      r.mapped.push(`all ${Math.min(src.length, d.length)} rhythm set bytes (same family: ${c.extra.model})`);
      return { data: d, report: r };
    }
    const { set } = io(RP, d, r);
    const notes = (c.notes || []).filter((x) => x && typeof x.note === 'number');
    for (const k of KEYS) set(`k${k}`, 'Tone switch', 0);
    let mapped = 0;
    for (const nt of notes) {
      if (nt.note < 35 || nt.note > 98) { r.dropped.push(`Key ${nt.note} (the rhythm set has keys 35-98)`); continue; }
      const s = `k${nt.note}`;
      set(s, 'Tone switch', 1);
      setWave(set, s, nt, nt.note, r);
      set(s, 'Source key', nt.note + (typeof nt.coarse === 'number' ? nt.coarse : 0));
      if (nt.fine !== undefined) set(s, 'Fine tune', 50 + nt.fine);
      if (nt.level !== undefined) set(s, 'Tone level', nt.level * 127);
      if (typeof nt.pan === 'number') set(s, 'Tone pan', 64 + nt.pan * 63);
      if (nt.muteGroup !== undefined) set(s, 'Mute group', nt.muteGroup);
      if (nt.sustain !== undefined) set(s, 'Envelope mode', nt.sustain ? 1 : 0);
      if (nt.filter) {
        const ft = FILTER_FROM[nt.filter.type || 'lpf'];
        set(s, 'Filter type', ft ?? 1);
        if (nt.filter.cutoff !== undefined) set(s, 'Cutoff frequency', nt.filter.cutoff * 127);
        if (nt.filter.resonance !== undefined) set(s, 'Resonance', nt.filter.resonance * 127);
      }
      if (nt.env) envInto(set, s, 'A', nt.env);
      if (nt.decay !== undefined && !nt.env) set(s, 'A-env time 3', nt.decay * 127);
      mapped++;
    }
    r.mapped.push(`${mapped} drum key(s): wave, tuning, level, pan`);
    return { data: d, report: tidy(r) };
  }

  return { patchToCommon, patchFromCommon, patchSetCategory, perfToCommon, perfFromCommon, rhythmToCommon, rhythmFromCommon };
}

/** Write a 12-character JV name. */
export function setJvName(d, name) {
  for (let i = 0; i < 12; i++) d[i] = Math.max(32, Math.min(127, String(name ?? '').charCodeAt(i) || 32));
}
