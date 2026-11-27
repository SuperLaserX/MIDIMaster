// V-Synth XT VC-2 (Vocal Designer) patch <-> the shared synth model (core/mainlib/common.js).
//
// A VC-2 patch is a vocal instrument: an algorithm (Modeling, Vocoder, Keyboard, Process...), a
// carrier with two oscillators (vocal waves with formant, vibrato, growl), a modulator (the mic
// or a wave) and the vocoder, plus MFX, chorus and reverb. The shared model describes a
// synthesizer voice, so what moves between instruments is the playing side: voice mode,
// portamento, bend range, the carrier oscillators' levels, pans and tuning, the TVA envelope
// (attack and release), and the effects by name. Waves stay the VC-2's own (`rom:<wave name>`
// when the names were read from the unit, else `vc2-wave:<n>`).

import { readParam, writeParam } from '../../core/model/memmap.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';

const FAMILY = 'roland-vc2';
const MODEL_ID = 'roland-vsynth-xt-vc2';
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
const u = (v, max = 127) => Math.max(0, Math.min(1, v / max));

function hashBytes(d) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const x of d) { h1 = Math.imul(h1 ^ x, 16777619) >>> 0; h2 = Math.imul(h2 + x, 2246822507) >>> 0; }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** M: {pOf(block, name), defaults(), nameOf, LISTS, waves (Map), fxDefaults(data, kind)} from roland-vsynthxt-vc2.js */
export function vc2Translator(M) {
  const L = M.LISTS;
  const waveId = (n) => (M.waves.has(n) ? `rom:${M.waves.get(n)}` : `vc2-wave:${n}`);

  function patchToCommon(d) {
    const g = (blk, name) => readParam(d, M.pOf(blk, name));
    const osc = [1, 2].map((n) => ({
      on: n === 1 ? true : !!g('ca', 'OSC2 Switch'),
      wave: waveId(g('ca', `OSC${n} Wave`)),
      coarse: n === 1 ? 12 * (g('ca', 'OSC1 Pitch Octave Shift') - 64) : g('ca', 'OSC2 Pitch Coarse') - 64,
      fine: n === 1 ? 0 : g('ca', 'OSC2 Pitch Fine') - 64,
      level: u(g('ca', `OSC${n} Level`)),
      pan: (g('ca', `OSC${n} Pan`) - 64) / 63,
      detune: (g('ca', `OSC${n} Detune`) - 64) / 63,
      pulseWidth: (g('ca', `OSC${n} PW`) - 64) / 63,
    }));
    const mfx = g('c', 'MFX Type');
    const ch = g('c', 'Chorus Type');
    const rv = g('c', 'Reverb Type');
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: {
        mode: g('ca', 'MONO/POLY') ? 'poly' : g('ca', 'Legato Switch') ? 'legato' : 'mono', legato: !!g('ca', 'Legato Switch'),
        portamento: { on: !!g('ca', 'Portamento Switch'), time: u(g('ca', 'Portamento Time')) },
        bendUp: g('ca', 'Bender Range'), bendDown: g('ca', 'Bender Range'),
      },
      osc,
      mix: { balance: osc[1].on ? osc[1].level - osc[0].level : -1 },
      amp: {
        level: u(g('ca', 'TVA Level')), pan: 'manual',
        env: { attack: u(g('ca', 'TVA Attack Time')), decay: 0, sustain: 1, release: u(g('ca', 'TVA Release Time')) },
      },
      tempo: g('c', 'Patch Tempo') / 10,
      effects: {
        ...(g('c', 'Chorus Switch') && ch ? { modulation: { type: L.chorus[ch], level: u(g('c', 'Chorus Master Level')) } }
          : g('c', 'MFX Switch') && mfx ? { modulation: { type: L.mfx[mfx], level: u(g('c', 'MFX Master Level')) } } : {}),
        ...(g('c', 'Reverb Switch') && rv ? { reverb: { type: L.reverb[rv], level: u(g('c', 'Reverb Master Level')) } } : {}),
      },
      vocal: { algorithm: L.algorithm[g('c', 'Algorithm')] },
      extra: { family: FAMILY, model: MODEL_ID, match: hashBytes(d.subarray(13)) },
    };
  }

  function patchFromCommon(c, base) {
    const d = Uint8Array.from(base || M.defaults());
    const r = emptyReport();
    const set = (blk, name, v, what = name) => {
      if (v === undefined || v === null || Number.isNaN(v)) return;
      const p = M.pOf(blk, name);
      writeParam(d, p, clamp(v, p.min, p.max));
      if (what) r.mapped.push(what);
    };
    const v = c.voice || {};
    if (v.mode) set('ca', 'MONO/POLY', v.mode === 'poly' || v.mode === 'unison' ? 1 : 0, 'Mono/poly');
    if (v.mode === 'unison') r.dropped.push('Unison (played poly)');
    if (v.legato !== undefined || v.mode === 'legato') set('ca', 'Legato Switch', v.legato || v.mode === 'legato' ? 1 : 0, 'Legato');
    if (v.portamento) {
      set('ca', 'Portamento Switch', v.portamento.on ? 1 : 0, 'Portamento switch');
      set('ca', 'Portamento Time', (v.portamento.time ?? 0) * 127, 'Portamento time');
    }
    if (v.bendUp !== undefined || v.bendDown !== undefined) {
      set('ca', 'Bender Range', Math.max(v.bendUp ?? 0, v.bendDown ?? 0), 'Bend range');
      if ((v.bendUp ?? 0) !== (v.bendDown ?? 0)) r.approximated.push('Bend up/down → one bender range');
    }
    // carrier oscillators: level, pan, tuning; their waves stay the VC-2's vocal waves
    const osc = c.osc || [];
    osc.slice(0, 2).forEach((o, i) => {
      if (!o) return;
      const n = i + 1;
      if (n === 2) set('ca', 'OSC2 Switch', o.on === false ? 0 : 1, null);
      set('ca', `OSC${n} Level`, (o.level ?? 1) * 127, `OSC ${n} level`);
      if (o.pan !== undefined) set('ca', `OSC${n} Pan`, 64 + o.pan * 63, null);
      if (typeof o.coarse === 'number') {
        if (n === 1) {
          set('ca', 'OSC1 Pitch Octave Shift', 64 + Math.round(o.coarse / 12), 'OSC 1 octave');
          if (o.coarse % 12) r.approximated.push(`OSC 1 coarse ${o.coarse} → nearest octave`);
        } else set('ca', 'OSC2 Pitch Coarse', 64 + o.coarse, 'OSC 2 coarse tune');
      }
      if (n === 2 && typeof o.fine === 'number') set('ca', 'OSC2 Pitch Fine', 64 + o.fine, null);
      if (o.detune !== undefined) set('ca', `OSC${n} Detune`, 64 + o.detune * 63, null);
      const w = String(o.wave || '');
      const rom = /^rom:(.*)$/.exec(w);
      const known = rom ? [...M.waves.entries()].find(([, name]) => name === rom[1]) : null;
      const own = /^vc2-wave:(\d+)$/.exec(w);
      if (known) set('ca', `OSC${n} Wave`, known[0], `OSC ${n} wave ${rom[1]}`);
      else if (own) set('ca', `OSC${n} Wave`, Number(own[1]), `OSC ${n} wave`);
      else if (w) r.approximated.push(`OSC ${n} ${w} → the VC-2 vocal wave of the base patch`);
    });
    if (osc.length > 2) r.dropped.push(`${osc.length - 2} more oscillators`);
    if (c.mix?.ring || c.mix?.sync || c.mix?.crossMod) r.dropped.push('Ring, sync and cross modulation');
    if (c.filter) r.dropped.push('Filter (the VC-2 carrier has formant and EQ, no filter)');
    if (c.pitch?.envDepth || c.pitch?.lfo1) r.dropped.push('Pitch envelope and LFO (the VC-2 has vibrato)');
    if (c.lfo?.length) r.dropped.push('LFOs');
    const a = c.amp || {};
    if (a.level !== undefined) set('ca', 'TVA Level', a.level * 127, 'Amp level');
    if (a.env) {
      set('ca', 'TVA Attack Time', (a.env.attack ?? 0) * 127, 'Amp attack');
      set('ca', 'TVA Release Time', (a.env.release ?? 0) * 127, 'Amp release');
      if ((a.env.sustain ?? 1) < 0.99 || a.env.decay) r.approximated.push('Amp envelope → attack and release (no decay or sustain)');
    }
    if (c.tempo) set('c', 'Patch Tempo', c.tempo * 10, 'Tempo');
    // effects by name
    const fx = c.effects || {};
    const pick = (list, name) => {
      const n = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!n) return -1;
      let i = list.findIndex((x) => x.toUpperCase().replace(/[^A-Z0-9]/g, '') === n);
      if (i < 0) i = list.findIndex((x, k) => k && (n.includes(x.toUpperCase().replace(/[^A-Z0-9]/g, '')) || x.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(n)));
      return i;
    };
    if (fx.modulation?.type) {
      const t = fx.modulation.type;
      let ch = pick(L.chorus, t);
      if (ch < 0 && /CHORUS|ENSEMBLE/i.test(t)) ch = 1;
      if (ch < 0 && /FLANG/i.test(t)) ch = L.chorus.indexOf('Flanger');
      if (ch > 0) {
        set('c', 'Chorus Switch', 1, null);
        set('c', 'Chorus Type', ch, `Effect ${t} → chorus ${L.chorus[ch]}`);
        M.fxDefaults(d, 'chorus');
        set('c', 'Chorus Master Level', (fx.modulation.level ?? 1) * 127, null);
        if (L.chorus[ch].toUpperCase() !== t.toUpperCase()) r.approximated.push(`${t} → ${L.chorus[ch]}`);
      } else {
        const m = pick(L.mfx, t);
        if (m > 0) {
          set('c', 'MFX Switch', 1, null);
          set('c', 'MFX Type', m, `Effect ${t} → MFX ${L.mfx[m]}`);
          M.fxDefaults(d, 'mfx');
          set('c', 'MFX Master Level', (fx.modulation.level ?? 1) * 127, null);
        } else r.dropped.push(`Effect ${t}`);
      }
    }
    if (fx.reverb?.type) {
      const t = fx.reverb.type;
      let rv = pick(L.reverb.slice(0, 15), t);
      if (rv <= 0) rv = /HALL/i.test(t) ? L.reverb.indexOf('Hall 1') : /ROOM/i.test(t) ? L.reverb.indexOf('Room 1') : /PLATE/i.test(t) ? 1 : L.reverb.indexOf('Hall 1');
      set('c', 'Reverb Switch', 1, null);
      set('c', 'Reverb Type', rv, `Reverb ${t} → ${L.reverb[rv]}`);
      M.fxDefaults(d, 'reverb');
      set('c', 'Reverb Master Level', (fx.reverb.level ?? 0.5) * 127, null);
      if (L.reverb[rv].toUpperCase() !== String(t).toUpperCase()) r.approximated.push(`Reverb ${t} → ${L.reverb[rv]}`);
    }
    if (fx.delay && (fx.delay.level ?? 0) > 0) {
      const m = L.mfx.indexOf('Stereo Delay');
      if (!fx.modulation && m > 0) {
        set('c', 'MFX Switch', 1, null);
        set('c', 'MFX Type', m, 'Delay → MFX Stereo Delay');
        M.fxDefaults(d, 'mfx');
        set('c', 'MFX Master Level', fx.delay.level * 127, null);
      } else r.dropped.push('Delay (the MFX holds the modulation effect)');
    }
    if (c.velocity) r.dropped.push('Velocity depths');
    if (c.controller) r.dropped.push('Controller depths');
    r.approximated.push(`The algorithm (${L.algorithm[readParam(d, M.pOf('c', 'Algorithm'))]}) decides which oscillator, formant and modulator settings the VC-2 takes; it keeps its own for the rest (read the patch back to see)`);
    r.mapped = [...new Set(r.mapped)];
    return { data: d, report: r };
  }

  return { patchToCommon, patchFromCommon };
}
