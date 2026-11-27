// V-Synth XT VC-1 (D-50) patch <-> the shared synth model (core/mainlib/common.js).
//
// A D-50 patch has two tones (upper, lower) of two partials each. A partial is a synth partial
// (square or saw wave, pulse width, TVF) or a PCM partial (one of 128 waves, no TVF); the tone's
// structure (1-7) says which, and whether the two are ring modulated. The shared model describes
// one voice, so the upper tone is read and written (in WHOLE key mode only it sounds); a patch
// layering both tones says so with `tones: 2`.
//
// D-50 envelopes have five times and levels (T1-T5, L1-L3, sustain, end): the shared ADSR reads
// T1 as attack, T2-T4 as decay, the sustain level, and T5 as release. Chorus types are numbers on
// the VC-1's screen; their names here (Chorus 1 ... Dimension) are the D-50 manual's.

import { readParam, writeParam } from '../../core/model/memmap.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';

const FAMILY = 'roland-d50';
const MODEL_ID = 'roland-vsynth-xt-vc1';
// structure 1-7: partial 1 and 2 type (S synth, P PCM) and ring modulation
const STRUCTURES = [['S', 'S', false], ['S', 'S', true], ['P', 'S', false], ['P', 'S', true], ['S', 'P', true], ['P', 'P', false], ['P', 'P', true]];
const CHORUS_NAMES = ['Chorus 1', 'Chorus 2', 'Flanger 1', 'Flanger 2', 'Feedback Chorus', 'Tremolo', 'Chorus Tremolo', 'Dimension'];
const LFO_WAVES = ['triangle', 'saw', 'square', 'random'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
const u = (v, max = 100) => Math.max(0, Math.min(1, v / max));
const ratio = (t) => { const m = /^(-?)(\d+)(?:\/(\d+))?$/.exec(t); return m ? (m[1] ? -1 : 1) * Number(m[2]) / Number(m[3] || 1) : null; };

function hashBytes(d) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const x of d) { h1 = Math.imul(h1 ^ x, 16777619) >>> 0; h2 = Math.imul(h2 + x, 2246822507) >>> 0; }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** M: {params, pOf(block, name), defaults(), nameOf, toneName, writeName, LISTS} from roland-vsynthxt-vc1.js */
export function vc1Translator(M) {
  const PCM = M.LISTS.pcm;
  const KF = M.LISTS.keyfollow.map(ratio);

  // ------------------------------------------------------------ VC-1 -> shared model
  function patchToCommon(d) {
    const g = (blk, name) => readParam(d, M.pOf(blk, name));
    const keyMode = g('pt', 'Key Mode');
    const [t1, t2, ring] = STRUCTURES[g('uc', 'Structure')] || STRUCTURES[0];
    const mute = g('uc', 'Partial Mute');
    const env = (blk, kind) => ({
      attack: u(g(blk, `${kind} ENV Time 1`)),
      decay: u(g(blk, `${kind} ENV Time 2`) + g(blk, `${kind} ENV Time 3`) + g(blk, `${kind} ENV Time 4`), 300),
      sustain: u(g(blk, `${kind} ENV Sustain Level`)),
      release: u(g(blk, `${kind} ENV Time 5`)),
    });
    const osc = [['u1', t1], ['u2', t2]].map(([blk, type], k) => ({
      on: !!(mute & (1 << k)),
      wave: type === 'S' ? (g(blk, 'WG Waveform') ? 'saw' : 'square') : `rom:${PCM[g(blk, 'WG PCM Wave No.')]}`,
      coarse: g(blk, 'WG Pitch Coarse') - 36,
      fine: g(blk, 'WG Pitch Fine') - 50,
      level: u(g(blk, 'TVA Level')),
      ...(type === 'S' ? { pulseWidth: u(g(blk, 'WG Pulse Width')), pwmDepth: u(g(blk, 'WG PW LFO Depth')) } : {}),
      keyfollow: KF[g(blk, 'WG Pitch Keyfollow')] ?? 1,
    }));
    const synth = t1 === 'S' ? 'u1' : t2 === 'S' ? 'u2' : null; // the TVF of the first synth partial
    const filter = synth ? {
      type: 'lpf', cutoff: u(g(synth, 'TVF Cutoff Frequency')), resonance: u(g(synth, 'TVF Resonance'), 30),
      keyTrack: KF[g(synth, 'TVF Keyfollow')] ?? 0, envDepth: u(g(synth, 'TVF ENV Depth')),
      lfo1: u(g(synth, 'TVF Mod LFO Depth')), env: env(synth, 'TVF'),
    } : null;
    const lfoOn = g('u1', 'WG Mod LFO Mode') !== 0;
    const penv = g('u1', 'WG Mod P-ENV Mode');
    const chorusBal = g('uc', 'Chorus Balance');
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: {
        mode: keyMode >= 4 ? 'mono' : 'poly',
        portamento: { on: !!g('pt', 'Portamento Switch'), time: u(g('pt', 'Portamento Time')) },
        bendUp: g('pt', 'Bender Range'), bendDown: g('pt', 'Bender Range'),
      },
      osc,
      mix: { balance: (g('uc', 'Partial Balance') - 50) / 50, ring },
      pitch: {
        lfo1: lfoOn ? u(g('uc', 'P-Mod LFO Depth')) : 0,
        envDepth: penv ? (penv === 2 ? -1 : 1) * (g('uc', 'P-ENV Level 0') - 50) / 50 : 0,
        env: { attack: u(g('uc', 'P-ENV Time 1'), 50), decay: u(g('uc', 'P-ENV Time 2') + g('uc', 'P-ENV Time 3'), 100) },
        target: 'osc1+2',
      },
      ...(filter ? { filter } : {}),
      amp: { level: u(g('pt', 'Total Volume')), lfo1: u(g('u1', 'TVA Mod LFO Depth')), env: env('u1', 'TVA'), pan: 'off' },
      lfo: [
        { wave: LFO_WAVES[g('uc', 'LFO-1 Waveform')], rate: u(g('uc', 'LFO-1 Rate')), fade: u(g('uc', 'LFO-1 Delay Time')) },
        { wave: LFO_WAVES[g('uc', 'LFO-2 Waveform')], rate: u(g('uc', 'LFO-2 Rate')) },
      ],
      tone: { bass: (g('uc', 'Low EQ Gain') - 12) / 12, treble: (g('uc', 'High EQ Gain') - 12) / 12 },
      effects: {
        ...(chorusBal ? { modulation: { type: CHORUS_NAMES[g('uc', 'Chorus Type')], level: u(chorusBal) } } : {}),
        ...(g('pt', 'Reverb Balance') ? { reverb: { type: `D-50 reverb ${g('pt', 'Reverb Type') + 1}`, level: u(g('pt', 'Reverb Balance')) } } : {}),
      },
      tones: keyMode === 0 || keyMode === 4 ? 1 : 2,
      extra: { family: FAMILY, model: MODEL_ID, match: hashBytes([...d.subarray(0, 0x80), ...d.subarray(0x8a, 0x140), ...d.subarray(0x14a, 0x180), ...d.subarray(0x192)]) },
    };
  }

  // ------------------------------------------------------------ shared model -> VC-1
  function patchFromCommon(c, base) {
    const d = Uint8Array.from(base || M.defaults());
    const r = emptyReport();
    const set = (blk, name, v, what = name) => {
      if (v === undefined || v === null || Number.isNaN(v)) return;
      const p = M.pOf(blk, name);
      writeParam(d, p, clamp(v, p.min, p.max));
      if (what) r.mapped.push(what);
    };
    const kfIndex = (x, n = KF.length) => {
      let best = 0;
      for (let i = 0; i < n; i++) if (KF[i] !== null && Math.abs(KF[i] - x) < Math.abs(KF[best] - x)) best = i;
      return best;
    };

    // voice and key mode: the upper tone alone (WHOLE), or WHOLE-S for a mono sound
    const v = c.voice || {};
    const mono = v.mode === 'mono' || v.mode === 'legato';
    set('pt', 'Key Mode', mono ? 4 : 0, mono ? 'Key mode WHOLE-S (mono)' : 'Key mode WHOLE');
    if (v.mode === 'unison') r.approximated.push('Unison → WHOLE (poly)');
    if (v.mode === 'legato') r.approximated.push('Legato → WHOLE-S (solo)');
    if (v.portamento) {
      set('pt', 'Portamento Switch', v.portamento.on ? 1 : 0, 'Portamento switch');
      set('pt', 'Portamento Time', (v.portamento.time ?? 0) * 100, 'Portamento time');
      set('pt', 'Portamento Mode', 2, null);
    }
    if (v.bendUp !== undefined || v.bendDown !== undefined) {
      set('pt', 'Bender Range', Math.max(v.bendUp ?? 0, v.bendDown ?? 0), 'Bender range');
      if ((v.bendUp ?? 0) !== (v.bendDown ?? 0)) r.approximated.push('Bend up/down → one bender range');
    }
    set('pt', 'Upper Tone Key Shift', 24 + 12 * (v.octave || 0), v.octave ? 'Octave → upper tone key shift' : null);

    // partials: synth (SQU/SAW) or PCM by wave
    const osc = (c.osc || []).slice(0, 2);
    while (osc.length < 2) osc.push({ on: false, wave: 'saw' });
    const plan = osc.map((o, k) => {
      const w = String(o.wave || 'saw');
      if (w === 'saw' || w === 'supersaw' || w === 'hq-saw' || w === 'la-saw' || w === 'ramp') {
        if (w !== 'saw') r.approximated.push(`OSC ${k + 1} ${w} → SAW`);
        return { type: 'S', wave: 1 };
      }
      if (w === 'square' || w === 'pulse' || w === 'hq-square' || w === 'la-square') return { type: 'S', wave: 0 };
      if (w === 'triangle' || w === 'sine' || w === 'triangle-mod' || w === 'juno') {
        r.approximated.push(`OSC ${k + 1} ${w} → SQU`);
        return { type: 'S', wave: 0 };
      }
      if (w === 'noise') return { type: 'P', pcm: PCM.indexOf('Noise') };
      const rom = /^rom:(.*)$/.exec(w);
      if (rom && PCM.includes(rom[1])) return { type: 'P', pcm: PCM.indexOf(rom[1]) };
      r.approximated.push(`OSC ${k + 1} ${w} → SAW`);
      return { type: 'S', wave: 1 };
    });
    let order = [0, 1];
    const ring = !!c.mix?.ring;
    // S + P exists only with ring modulation (structure 5); otherwise put the PCM partial first
    if (plan[0].type === 'S' && plan[1].type === 'P' && !ring) order = [1, 0];
    const types = order.map((k) => plan[k].type);
    let st = STRUCTURES.findIndex((s) => s[0] === types[0] && s[1] === types[1] && s[2] === ring);
    if (st < 0) {
      st = STRUCTURES.findIndex((s) => s[0] === types[0] && s[1] === types[1]);
      r.approximated.push(ring ? 'Ring modulation needs a synth partial 2 here' : 'Structure without ring modulation not available');
    }
    set('uc', 'Structure', st, `Structure ${st + 1}`);
    if (c.mix?.sync) r.dropped.push('Oscillator sync (no sync on the D-50)');
    if (c.mix?.crossMod) r.dropped.push('Cross modulation (D-50 has ring modulation only)');
    if (order[0] === 1) r.approximated.push('OSC 1 and 2 swapped (PCM partial first)');

    const amp = c.amp || {};
    const envOf = (blk, kind, e, depthName) => {
      if (!e) return;
      set(blk, `${kind} ENV Time 1`, (e.attack ?? 0) * 100, null);
      set(blk, `${kind} ENV Level 1`, 100, null);
      set(blk, `${kind} ENV Time 2`, (e.decay ?? 0) * 100, null);
      set(blk, `${kind} ENV Level 2`, (e.sustain ?? 1) * 100, null);
      set(blk, `${kind} ENV Time 3`, 0, null);
      set(blk, `${kind} ENV Level 3`, (e.sustain ?? 1) * 100, null);
      set(blk, `${kind} ENV Time 4`, 0, null);
      set(blk, `${kind} ENV Sustain Level`, (e.sustain ?? 1) * 100, null);
      set(blk, `${kind} ENV Time 5`, (e.release ?? 0) * 100, null);
      set(blk, `${kind} ENV End Level`, 0, `${depthName} envelope (ADSR → T1-T5)`);
    };
    let mute = 0;
    order.forEach((k, slot) => {
      const o = osc[k];
      const pl = plan[k];
      const blk = slot ? 'u2' : 'u1';
      if (o.on !== false) mute |= 1 << slot;
      const coarse = typeof o.coarse === 'number' ? o.coarse : 0;
      set(blk, 'WG Pitch Coarse', 36 + coarse, `OSC ${k + 1} coarse`);
      if (Math.abs(coarse) > 36) r.approximated.push(`OSC ${k + 1} coarse ${coarse} → limit`);
      set(blk, 'WG Pitch Fine', 50 + (o.fine || 0), `OSC ${k + 1} fine`);
      set(blk, 'WG Pitch Keyfollow', kfIndex(o.keyfollow ?? 1), null);
      if (pl.type === 'S') {
        set(blk, 'WG Waveform', pl.wave, `OSC ${k + 1} wave`);
        set(blk, 'WG Pulse Width', (o.pulseWidth ?? 0) * 100, null);
        set(blk, 'WG PW LFO Depth', (o.pwmDepth ?? 0) * 100, null);
        set(blk, 'WG PW LFO Select', 0, null);
      } else set(blk, 'WG PCM Wave No.', pl.pcm, `OSC ${k + 1} wave ${PCM[pl.pcm]}`);
      set(blk, 'TVA Level', 100 * (amp.level ?? 1) * (o.level ?? 1), null);
      envOf(blk, 'TVA', amp.env, 'Amp');
      set(blk, 'TVA Mod LFO Depth', Math.abs(amp.lfo1 ?? 0) * 100, null);
      // pitch modulation by LFO-1 and the pitch envelope
      const pl1 = c.pitch?.lfo1 ?? 0;
      set(blk, 'WG Mod LFO Mode', pl1 > 0 ? 1 : pl1 < 0 ? 2 : 0, null);
      const pe = c.pitch?.envDepth ?? 0;
      set(blk, 'WG Mod P-ENV Mode', pe > 0 ? 1 : pe < 0 ? 2 : 0, null);
      set(blk, 'WG Mod Bend Mode', 2, null);
      // filter: synth partials only (PCM partials have no TVF)
      const f = c.filter;
      if (pl.type === 'S' && f) {
        set(blk, 'TVF Cutoff Frequency', (f.cutoff ?? 1) * 100, null);
        set(blk, 'TVF Resonance', (f.resonance ?? 0) * 30, null);
        set(blk, 'TVF Keyfollow', kfIndex(f.keyTrack ?? 0, 15), null);
        set(blk, 'TVF ENV Depth', Math.abs(f.envDepth ?? 0) * 100, null);
        set(blk, 'TVF Mod LFO Depth', Math.abs(f.lfo1 ?? 0) * 100, null);
        envOf(blk, 'TVF', f.env, 'Filter');
      }
    });
    set('uc', 'Partial Mute', mute, null);
    const bal = c.mix?.balance ?? 0;
    set('uc', 'Partial Balance', 50 + (order[0] === 1 ? -bal : bal) * 50, 'Oscillator balance');
    if (c.filter) {
      r.mapped.push('Filter (TVF of the synth partials)');
      if (c.filter.type && c.filter.type !== 'lpf') r.approximated.push(`Filter ${c.filter.type} → low pass (the TVF)`);
      if ((c.filter.envDepth ?? 0) < 0) r.approximated.push('Negative filter envelope depth → positive');
      if (!plan.some((p) => p.type === 'S')) r.dropped.push('Filter (PCM partials have no TVF)');
    }
    if (amp.env) r.mapped.push('Amp level');

    // pitch envelope and LFOs
    const p = c.pitch || {};
    if (p.lfo1) set('uc', 'P-Mod LFO Depth', Math.abs(p.lfo1) * 100, 'Pitch LFO depth');
    if (p.envDepth) {
      set('uc', 'P-ENV Level 0', 50 + Math.abs(p.envDepth) * 50, 'Pitch envelope depth');
      set('uc', 'P-ENV Time 1', (p.env?.attack ?? 0) * 50, null);
      set('uc', 'P-ENV Level 1', 50, null);
      set('uc', 'P-ENV Sustain Level', 50, null);
      set('uc', 'P-ENV End Level', 50, null);
    }
    if (p.lfo2) r.dropped.push('Pitch LFO 2 depth');
    const l1 = c.lfo?.[0];
    if (l1) {
      const w = { triangle: 0, sine: 0, saw: 1, square: 2, random: 3, 'sample-hold': 3 }[l1.wave] ?? 0;
      if (l1.wave === 'sine') r.approximated.push('LFO 1 sine → TRI');
      set('uc', 'LFO-1 Waveform', w, null);
      set('uc', 'LFO-1 Rate', (l1.rate ?? 0.5) * 100, 'LFO 1');
      set('uc', 'LFO-1 Delay Time', (l1.fade ?? 0) * 100, null);
    }
    if (c.lfo?.[1]?.rate !== undefined) set('uc', 'LFO-2 Rate', c.lfo[1].rate * 100, 'LFO 2 rate');

    // EQ from tone
    if (c.tone?.bass !== undefined) set('uc', 'Low EQ Gain', 12 + c.tone.bass * 12, 'Bass');
    if (c.tone?.treble !== undefined) set('uc', 'High EQ Gain', 12 + c.tone.treble * 12, 'Treble');

    // effects: chorus (8 types) and reverb (32 types)
    const fx = c.effects || {};
    if (fx.modulation?.type) {
      const n = fx.modulation.type.toUpperCase();
      let t = CHORUS_NAMES.findIndex((x) => x.toUpperCase() === n);
      if (t < 0) {
        t = /TREM/.test(n) ? (/CHORUS/.test(n) ? 6 : 5) : /FLANG/.test(n) ? 2 : /DIMENS/.test(n) ? 7 : /FEEDBACK|FBK/.test(n) ? 4
          : /CHORUS|ENSEMBLE/.test(n) ? (/2|MID|ENSEMBLE/.test(n) ? 1 : 0) : -1;
        if (t >= 0) r.approximated.push(`${fx.modulation.type} → ${CHORUS_NAMES[t]}`);
      }
      if (t >= 0) {
        set('uc', 'Chorus Type', t, `Effect ${fx.modulation.type} → chorus ${t + 1}`);
        set('uc', 'Chorus Balance', (fx.modulation.level ?? 0.5) * 100, null);
      } else {
        r.dropped.push(`Effect ${fx.modulation.type}`);
        set('uc', 'Chorus Balance', 0, null);
      }
    } else set('uc', 'Chorus Balance', 0, null);
    const rv = /^D-50 reverb (\d+)$/.exec(fx.reverb?.type || '');
    if (rv) {
      set('pt', 'Reverb Type', Number(rv[1]) - 1, 'Reverb type');
      set('pt', 'Reverb Balance', (fx.reverb.level ?? 0.3) * 100, null);
    } else if (fx.reverb) {
      set('pt', 'Reverb Balance', (fx.reverb.level ?? 0.3) * 100, 'Reverb level');
      r.approximated.push(`Reverb ${fx.reverb.type || ''} → D-50 reverb ${readParam(d, M.pOf('pt', 'Reverb Type')) + 1}`.trim());
    } else set('pt', 'Reverb Balance', 0, null);
    if (fx.delay && (fx.delay.level ?? 0) > 0) r.dropped.push('Delay (the D-50 reverb types include delays: choose one by ear)');
    if (c.velocity) r.dropped.push('Velocity depths');
    if (c.controller) r.dropped.push('Controller depths');

    // tone names follow the patch name
    if (c.name || M.nameOf(d)) M.writeName(d, 0x80, 10, String(c.name || M.nameOf(d)).slice(0, 10));
    r.mapped = [...new Set(r.mapped)];
    r.approximated = [...new Set(r.approximated)];
    return { data: d, report: r };
  }

  return { patchToCommon, patchFromCommon };
}
