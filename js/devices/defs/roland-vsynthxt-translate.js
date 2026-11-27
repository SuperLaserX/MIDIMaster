// V-Synth XT patch <-> the shared synth model (core/mainlib/common.js).
//
// A V-Synth patch has up to 16 zones, each with two oscillators (analog, PCM or external input),
// a MOD stage (mix, ring, FM, sync), two COSM blocks (filters, drive, resonators...) and a TVA.
// The shared model describes one voice, so zone 1 is read and written; a patch using more zones
// says so in the report. A sound from another synth becomes: OSC 1/2 analog waves, MOD for ring
// and sync, COSM 1 as a TVF filter (its envelope A = Env 9), the TVA envelope (Env 13), LFOs 1-5
// from the shared LFO, and the chorus, MFX and reverb blocks for the effects.
//
// It checks each wave against the engine's own waveform range, so a table set with fewer analog
// waves reports the missing ones (M.model names the device for `extra`).

import { readParam, writeParam } from '../../core/model/memmap.js';
import { COMMON_MODEL, unit, emptyReport } from '../../core/mainlib/common.js';

const FAMILY = 'roland-vsynth';
const WAVES = ['saw', 'square', 'triangle', 'sine', 'ramp', 'juno', 'hq-saw', 'hq-square', 'noise', 'la-saw', 'la-square', 'supersaw', 'feedback', 'xmod'];
// shared model wave -> analog waveform (index), with the ones that are only close
const FROM_WAVE = { saw: 0, square: 1, triangle: 2, sine: 3, ramp: 4, juno: 5, noise: 8, supersaw: 11, feedback: 12, xmod: 13, 'hq-saw': 6, 'hq-square': 7, 'la-saw': 9, 'la-square': 10 };
const NEAR_WAVE = { 'triangle-mod': 2, pulse: 1 };
const LFO_WAVES = ['sine', 'triangle', 'saw', 'square', 'random', 'trapezoid', 'sample-hold', 'chaos'];
const FILTERS = ['LP24', 'BP24', 'HP24', 'NOTCH24', 'PEAK24', 'LP12', 'BP12', 'HP12', 'NOTCH12', 'PEAK12'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
const u127 = (x) => clamp((x ?? 0) * 127, 0, 127);
const b63 = (x) => clamp(64 + (x ?? 0) * 63, 1, 127); // bipolar -1..1 -> 1..127 (SysEx, centre 64)

/** A short hash of bytes: equal for the same sound (Head Library duplicate search). */
function hashBytes(d) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const x of d) { h1 = Math.imul(h1 ^ x, 16777619) >>> 0; h2 = Math.imul(h2 + x, 2246822507) >>> 0; }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** M: {built, defaults(), fxSlot(kind, n, type), FX, FX_BLOCKS, nameOf, model?} from roland-vsynthxt.js */
export function vsTranslator(M) {
  const byKey = new Map();
  for (const p of M.built.params) byKey.set(`${p.key.split('_')[0]}|${p.name}`, p);
  const P = (block, name) => {
    const p = byKey.get(`${block}|${name}`);
    if (!p) throw new Error(`V-Synth parameter ${block} ${name} not found`);
    return p;
  };
  const fxTypeIndex = (kind, name) => {
    const [a, z] = M.FX_BLOCKS[kind];
    const i = M.FX.slice(a, z).findIndex((f) => f[0] === name);
    return i;
  };
  /** The slot n of effect parameter `label` for type t of block kind. */
  const fxParam = (kind, t, label) => {
    for (let n = 1; n <= 32; n++) {
      const s = M.fxSlot(kind, n, t);
      if (!s.hidden && s.label.replace(/^[^:]*: /, '') === label) return { n, ...s };
    }
    return null;
  };

  // ------------------------------------------------------------ V-Synth -> shared model
  function patchToCommon(d) {
    const g = (block, name) => readParam(d, P(block, name));
    const z = 0; // zone 1
    const t = `t${z}`; const e = `e${z}`; const l = `l${z}`; const ca = `ca${z}`;
    const osc = [1, 2].map((n) => {
      const type = g(t, `OSC ${n} Type`);
      const wave = type === 0 ? WAVES[g(t, `OSC ${n} Analog Wavefrom`)] : type === 1 ? `sample:${g(t, `OSC ${n} Wave Number`)}` : type === 3 ? 'vocoder' : 'external';
      return {
        on: !!g(t, `OSC ${n} Switch`), wave, coarse: g(t, `OSC ${n} Coarse Tune`) - 64, fine: g(t, `OSC ${n} Fine Tune`) - 64,
        level: unit(g(t, `OSC ${n} Level`)), pulseWidth: (g(t, `OSC ${n} Pulse Width`) - 64) / 63, pwmDepth: (g(t, `OSC ${n} Pulse Width LFO Depth`) - 64) / 63,
        detune: (g(t, `OSC ${n} Detune`) - 64) / 63, fat: unit(g(t, `OSC ${n} Fat`)),
      };
    });
    const modType = ['mix', 'ring', 'fm', 'env-ring', 'sync'][g(t, 'MOD Type')];
    const modOn = !!g(t, 'MOD Switch');
    const env = (n) => ({ attack: unit(Math.min(127, g(e, `Env ${n} Attack Time`))), decay: unit(Math.min(127, g(e, `Env ${n} Decay Time`))), sustain: unit(g(e, `Env ${n} Sustain`)), release: unit(Math.min(127, g(e, `Env ${n} Release Time`))) });
    const cosmType = g(ca, 'COSM Type');
    const cosmName = M.FX[M.FX_BLOCKS.cosm[0] + cosmType]?.[0] || '';
    let filter = null;
    if (g(ca, 'COSM Switch') && /^TVF/.test(cosmName)) {
      const fv = (label) => { const s = fxParam('cosm', cosmType, label); return s ? readParam(d, P(ca, `COSM Parameter ${s.n}`)) : undefined; };
      const ft = FILTERS[fv('Filter Type')] || 'LP24';
      filter = {
        type: ft.startsWith('LP') ? 'lpf' : ft.startsWith('HP') ? 'hpf' : ft.startsWith('BP') ? 'bpf' : ft.startsWith('NOTCH') ? 'notch' : 'peak',
        slope: ft.endsWith('24') ? 24 : 12, cutoff: unit(Math.min(127, fv('Cutoff') ?? 127)), resonance: unit(fv('Q') ?? 0),
        keyTrack: (fv('Cutoff Keyfollow') ?? 0) / 20, lfo1: (fv('Cutoff LFO Depth') ?? 0) / 63, envDepth: (fv('Cutoff Env Depth') ?? 0) / 63, env: env(9),
      };
    }
    const lfoWave = LFO_WAVES[g(l, 'LFO 1 Waveform')] || 'triangle';
    const chorusType = M.FX[M.FX_BLOCKS.chorus[0] + g('ch', 'Chorus Type')]?.[0];
    const mfxType = M.FX[M.FX_BLOCKS.mfx[0] + g('m', 'MFX Type')]?.[0];
    const revType = M.FX[M.FX_BLOCKS.reverb[0] + g('rv', 'Reverb Type')]?.[0];
    const zonesUsed = Array.from({ length: 16 }, (_, k) => k).filter((k) => k === 0 || g('c', `Zone ${k + 1} Range Upper`) !== g('c', `Zone ${k} Range Upper`)).length;
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: {
        mode: g('c', 'Mono/Poly') === 0 ? (g('c', 'Legato Switch') ? 'legato' : 'mono') : 'poly', legato: !!g('c', 'Legato Switch'),
        portamento: { on: !!g('c', 'Portamento Switch'), time: unit(g('c', 'Portamento Time')) },
        bendUp: g('c', 'Pitch Bend Range Up'), bendDown: g('c', 'Pitch Bend Range Down'), octave: g('c', 'Octave Shift') - 64,
      },
      osc,
      mix: { balance: (osc[1].level - osc[0].level), ring: modOn && (modType === 'ring' || modType === 'env-ring'), crossMod: modOn && modType === 'fm' ? 0.5 : 0, sync: modOn && modType === 'sync' },
      pitch: { envDepth: (g(t, 'OSC 1 Pitch Envelope Depth') - 64) / 63, lfo1: (g(t, 'OSC 1 Pitch LFO Depth') - 64) / 63, env: { attack: env(1).attack, decay: env(1).decay }, target: 'osc1+2' },
      ...(filter ? { filter } : {}),
      amp: { level: unit(g(t, 'TVA Level')), lfo1: (g(t, 'TVA Level LFO Depth') - 64) / 63, env: env(13), pan: 'manual' },
      lfo: [{ wave: lfoWave, rate: unit(Math.min(127, g(l, 'LFO 1 Rate'))), fade: unit(g(l, 'LFO 1 Fade Time')) }],
      effects: {
        ...(chorusType && chorusType !== 'OFF' && g('c', 'Chorus Switch') ? { modulation: { type: chorusType, level: unit(g('ch', 'Chorus Master Level')) } } : mfxType && mfxType !== 'THRU' && g('c', 'MFX Switch') ? { modulation: { type: mfxType, level: unit(g('m', 'MFX Master Level')) } } : {}),
        ...(revType === 'DELAY' && g('c', 'Reverb Switch') ? { delay: { type: 'delay', level: unit(g('rv', 'Reverb Master Level')) } } : revType && revType !== 'OFF' && g('c', 'Reverb Switch') ? { reverb: { type: revType, level: unit(g('rv', 'Reverb Master Level')) } } : {}),
      },
      zones: zonesUsed,
      extra: { family: FAMILY, model: M.model || 'roland-vsynth-xt', match: hashBytes(d.subarray(12)) },
    };
  }

  // ------------------------------------------------------------ shared model -> V-Synth
  function patchFromCommon(c, base) {
    const d = Uint8Array.from(base || M.defaults());
    const r = emptyReport();
    const set = (block, name, v, what = name) => {
      if (v === undefined || v === null || Number.isNaN(v)) return;
      writeParam(d, P(block, name), v);
      if (what) r.mapped.push(what);
    };
    const t = 't0'; const e = 'e0'; const l = 'l0'; const ca = 'ca0';
    // one zone over the whole keyboard
    set('c', 'Current Zone', 0, null);
    for (let k = 1; k <= 16; k++) set('c', `Zone ${k} Range Upper`, 127, null);

    const v = c.voice || {};
    if (v.mode) {
      set('c', 'Mono/Poly', v.mode === 'poly' || v.mode === 'unison' ? 1 : 0, 'Mono/Poly');
      if (v.mode === 'unison') r.dropped.push('Unison (the V-Synth has no unison mode; played poly)');
    }
    if (v.legato !== undefined || v.mode === 'legato') set('c', 'Legato Switch', v.legato || v.mode === 'legato' ? 1 : 0, 'Legato');
    if (v.portamento) { set('c', 'Portamento Switch', v.portamento.on ? 1 : 0, 'Portamento switch'); set('c', 'Portamento Time', u127(v.portamento.time), 'Portamento time'); }
    if (v.bendUp !== undefined) set('c', 'Pitch Bend Range Up', clamp(v.bendUp, 0, 48), 'Bend range up');
    if (v.bendDown !== undefined) set('c', 'Pitch Bend Range Down', clamp(v.bendDown, 0, 48), 'Bend range down');
    if (v.octave !== undefined) set('c', 'Octave Shift', clamp(64 + v.octave, 61, 67), 'Octave shift');
    if (v.mode === 'unison' && v.unisonDetune) r.dropped.push('Unison detune');

    // oscillators
    const osc = c.osc || [];
    const bal = c.mix?.balance;
    osc.slice(0, 2).forEach((o, i) => {
      if (!o) return;
      const n = i + 1;
      const pre = `OSC ${n}`;
      set(t, `${pre} Switch`, o.on === false ? 0 : 1, null);
      let w = FROM_WAVE[o.wave];
      if (w === undefined && NEAR_WAVE[o.wave] !== undefined) { w = NEAR_WAVE[o.wave]; r.approximated.push(`${pre} wave ${o.wave} → ${WAVES[w].toUpperCase()}`); }
      if (w === undefined) {
        w = 0;
        r.approximated.push(`${pre} wave ${o.wave || '?'} → SAW${/^(rom|sample):/.test(o.wave || '') ? ' (sample waves are not moved yet)' : ''}`);
      } else if (w > P(t, `${pre} Analog Wavefrom`).max) {
        r.approximated.push(`${pre} wave ${WAVES[w].toUpperCase()} → SAW (not on this engine)`);
        w = 0;
      } else r.mapped.push(`${pre} waveform`);
      set(t, `${pre} Type`, 0, null);
      set(t, `${pre} Analog Wavefrom`, w, null);
      if (o.coarse !== undefined) {
        if (o.coarse === 'wide-' || o.coarse === 'wide+') { set(t, `${pre} Coarse Tune`, o.coarse === 'wide-' ? 16 : 112, null); r.approximated.push(`${pre} range ${o.coarse.toUpperCase()} → ${o.coarse === 'wide-' ? '-48' : '+48'} semitones`); }
        else set(t, `${pre} Coarse Tune`, clamp(64 + o.coarse, 16, 112), `${pre} coarse tune`);
      }
      if (o.fine !== undefined) set(t, `${pre} Fine Tune`, clamp(64 + o.fine, 14, 114), `${pre} fine tune`);
      const level = o.level ?? (bal === undefined ? 1 : i === 0 ? Math.min(1, 1 - bal) : Math.min(1, 1 + bal));
      set(t, `${pre} Level`, u127(level), `${pre} level`);
      if (w === 1 && (o.pulseWidth !== undefined)) set(t, `${pre} Pulse Width`, b63(o.pulseWidth), `${pre} pulse width`);
      if (w === 1 && o.pwmDepth) set(t, `${pre} Pulse Width LFO Depth`, b63(o.pwmDepth), `${pre} PWM depth`);
      if (w === 11 || w === 12) {
        // JP control 1/2 of SUPER SAW (detune, mix) and FEEDBACK OSC: the V-Synth's Detune and Fat
        if (o.detune !== undefined || o.control1 !== undefined) set(t, `${pre} Detune`, b63(o.detune ?? (o.control1 * 2 - 1)), null);
        if (o.fat !== undefined || o.control2 !== undefined) set(t, `${pre} Fat`, u127(o.fat ?? o.control2), null);
        if (o.control1 !== undefined) r.approximated.push(`${pre} ${WAVES[w].toUpperCase()} controls → Detune and Fat`);
      }
    });
    if (osc.length > 2) r.dropped.push(`${osc.length - 2} more oscillators`);
    // OSC 2 sync is an oscillator setting in the shared model (osc[1].sync), MOD type OSC SYNC here
    const m = { ...(c.mix || {}), sync: c.mix?.sync || !!osc[1]?.sync };
    if (m.ring || m.sync || m.crossMod) {
      set(t, 'MOD Switch', 1, null);
      set(t, 'MOD Type', m.ring ? 1 : m.sync ? 4 : 2, m.ring ? 'Ring modulation' : m.sync ? 'OSC sync' : null);
      if (!m.ring && !m.sync && m.crossMod) r.approximated.push('Cross modulation → MOD type FM');
      if ([m.ring, m.sync, m.crossMod > 0].filter(Boolean).length > 1) r.dropped.push('Only one of ring, sync and cross modulation (MOD has one type)');
    }

    // pitch: OSC pitch envelopes (Env 1, Env 5), LFO depths
    const p = c.pitch || {};
    const toOsc = p.target === 'osc2' ? [2] : [1, 2];
    for (const n of toOsc) {
      if (p.envDepth !== undefined) set(t, `OSC ${n} Pitch Envelope Depth`, b63(p.envDepth), n === toOsc[0] ? 'Pitch envelope depth' : null);
      if (p.lfo1 !== undefined) set(t, `OSC ${n} Pitch LFO Depth`, b63(p.lfo1), n === toOsc[0] ? 'Pitch LFO depth' : null);
      if (p.env) {
        const en = n === 1 ? 1 : 5;
        set(e, `Env ${en} Attack Time`, u127(p.env.attack), null);
        set(e, `Env ${en} Decay Time`, u127(p.env.decay), null);
        set(e, `Env ${en} Sustain`, 0, null);
        set(e, `Env ${en} Release Time`, 0, null);
      }
    }
    if (p.env) r.mapped.push('Pitch envelope');
    if (p.lfo2) r.dropped.push('Pitch LFO 2 depth (one LFO per oscillator)');
    if (p.target === 'xmod') r.approximated.push('Pitch envelope/LFO1 to X-MOD depth → to both oscillators');

    // filter: COSM 1 as TVF (Mode0), envelope A = Env 9
    const f = c.filter;
    if (f && (f.type || f.cutoff !== undefined)) {
      const tvf = fxTypeIndex('cosm', 'TVF Mode0');
      set(ca, 'COSM Switch', 1, null);
      set(ca, 'COSM Type', tvf, null);
      const sp = (label, val) => { const s = fxParam('cosm', tvf, label); if (s && val !== undefined) writeParam(d, P(ca, `COSM Parameter ${s.n}`), clamp(val, s.min, s.max)); };
      const kind = { lpf: 'LP', hpf: 'HP', bpf: 'BP', notch: 'NOTCH', peak: 'PEAK' }[f.type] || 'LP';
      if (!{ lpf: 1, hpf: 1, bpf: 1, notch: 1, peak: 1 }[f.type]) r.approximated.push(`Filter ${f.type} → LPF`);
      sp('Filter Type', FILTERS.indexOf(`${kind}${(f.slope ?? 24) >= 18 ? 24 : 12}`));
      sp('Cutoff', clamp((f.cutoff ?? 1) * 126, 0, 126));
      sp('Q', u127(f.resonance));
      sp('Cutoff Keyfollow', clamp((f.keyTrack ?? 0) * 20, -20, 20));
      sp('Cutoff LFO Depth', clamp((f.lfo1 ?? 0) * 63, -63, 63));
      sp('Cutoff Env Depth', clamp((f.envDepth ?? 0) * 63, -63, 63));
      r.mapped.push('Filter (COSM 1 TVF): type, cutoff, resonance, key follow, LFO and envelope depth');
      if (f.keyTrack) r.approximated.push('Filter key follow → TVF Cutoff Keyfollow (-200..+200 in steps of 10)');
      if (f.lfo2) r.dropped.push('Filter LFO 2 depth');
      if (f.env) {
        set(e, 'Env 9 Attack Time', u127(f.env.attack), null); set(e, 'Env 9 Decay Time', u127(f.env.decay), null);
        set(e, 'Env 9 Sustain', u127(f.env.sustain), null); set(e, 'Env 9 Release Time', u127(f.env.release), 'Filter envelope (COSM 1 envelope A)');
      }
    }

    // amp: TVA level, envelope (Env 13), LFO
    const a = c.amp || {};
    if (a.level !== undefined) set(t, 'TVA Level', u127(a.level), 'Amp level');
    if (a.env) {
      set(e, 'Env 13 Attack Time', u127(a.env.attack), null); set(e, 'Env 13 Decay Time', u127(a.env.decay), null);
      set(e, 'Env 13 Sustain', u127(a.env.sustain), null); set(e, 'Env 13 Release Time', u127(a.env.release), 'Amp envelope (TVA)');
    }
    if (a.lfo1 !== undefined) set(t, 'TVA Level LFO Depth', b63(a.lfo1), 'Amp LFO depth');
    if (a.lfo2) r.dropped.push('Amp LFO 2 depth');
    if (a.pan === 'auto') { set(t, 'TVA Pan LFO Depth', 96, null); r.approximated.push('Auto pan → TVA pan LFO depth +32'); }

    // LFO: the shared LFO 1 drives every LFO of the zone (OSC 1, OSC 2, COSM 1, COSM 2, TVA)
    const [l1, l2] = c.lfo || [];
    if (l1) {
      const wi = LFO_WAVES.indexOf(l1.wave);
      for (let n = 1; n <= 5; n++) {
        set(l, `LFO ${n} Waveform`, wi < 0 ? 1 : wi, null);
        set(l, `LFO ${n} Rate`, u127(l1.rate), null);
        if (l1.fade !== undefined) set(l, `LFO ${n} Fade Time`, u127(l1.fade), null);
      }
      r.mapped.push('LFO 1 (to the five LFOs of zone 1)');
      if (wi < 0) r.approximated.push(`LFO wave ${l1.wave} → TRI`);
      r.approximated.push('LFO rate on the V-Synth scale (0-127)');
    }
    if (l2 && !(c.pitch?.lfo2 || c.filter?.lfo2 || c.amp?.lfo2)) { /* an unused LFO 2 is no loss */ }

    // effects
    const fx = c.effects || {};
    if (fx.modulation?.type) {
      const n = fx.modulation.type.toUpperCase();
      let chorus = null;
      let mfx = null;
      if (/SUPER CHORUS|^CHORUS/.test(n)) chorus = /FST|FAST/.test(n) ? 'CHORUS 3' : /MID/.test(n) ? 'CHORUS 2' : /CLR|CLEAR/.test(n) ? 'CHORUS 4' : 'CHORUS 1';
      else if (/FLANG/.test(n)) chorus = 'FLANGER';
      else if (/PHAS|TWIST|FREEZE/.test(n)) mfx = /JET|TWIST|FREEZE/.test(n) ? 'DIGITAL PHASER' : 'ANALOG PHASER';
      else if (/DIST|OVERDRIVE/.test(n)) mfx = 'STEREO OVERDRIVE/DISTORTION';
      else if (/ENSEMBLE/.test(n)) chorus = 'CHORUS 2';
      if (chorus) {
        set('c', 'Chorus Switch', 1, null);
        set('ch', 'Chorus Type', fxTypeIndex('chorus', chorus), `Effect ${fx.modulation.type} → chorus ${chorus}`);
        set('ch', 'Chorus Master Level', u127(fx.modulation.level ?? 1), null);
        if (chorus !== n) r.approximated.push(`${fx.modulation.type} → ${chorus}`);
      } else if (mfx) {
        set('c', 'MFX Switch', 1, null);
        set('m', 'MFX Type', fxTypeIndex('mfx', mfx), `Effect ${fx.modulation.type} → MFX ${mfx}`);
        set('m', 'MFX Master Level', u127(fx.modulation.level ?? 1), null);
        r.approximated.push(`${fx.modulation.type} → ${mfx}`);
      } else r.dropped.push(`Effect ${fx.modulation.type}`);
    }
    if (fx.delay && (fx.delay.level ?? 0) > 0) {
      const dly = fxTypeIndex('reverb', 'DELAY');
      set('c', 'Reverb Switch', 1, null);
      set('rv', 'Reverb Type', dly, 'Delay → reverb block DELAY');
      set('rv', 'Reverb Master Level', u127(fx.delay.level), null);
      const sp = (label, val) => { const s = fxParam('reverb', dly, label); if (s) writeParam(d, P('rv', `Reverb Parameter ${s.n}`), clamp(s.min + val * (s.max - s.min), s.min, s.max)); return s; };
      if (fx.delay.time !== undefined && sp('Delay Time', fx.delay.time)) r.approximated.push('Delay time on the V-Synth scale (proportional)');
      if (fx.delay.feedback !== undefined) sp('Feedback', 0.5 + fx.delay.feedback / 2);
      if (/panning|pan/i.test(fx.delay.type || '')) r.approximated.push(`Delay type ${fx.delay.type} → DELAY`);
    }
    if (fx.reverb?.type) r.approximated.push(`Reverb ${fx.reverb.type} kept only as type name`);
    if (c.tone && (c.tone.bass || c.tone.treble)) r.dropped.push('Tone control (bass/treble)');
    if (c.velocity?.depths && Object.values(c.velocity.depths).some((x) => Math.abs(x) > 0.01)) r.dropped.push('Velocity depth matrix');
    if (c.controller?.depths && Object.values(c.controller.depths).some((x) => Math.abs(x) > 0.01)) r.dropped.push('Controller depth matrix (the V-Synth matrix has 8 sources with 2 destinations; set them on the Patch page)');
    return { data: d, report: r };
  }

  return { patchToCommon, patchFromCommon };
}
