// JP-8080 / JP-8000 translators to and from the shared synth model (core/mainlib/common.js).
//
// Both models use the same patch layout for 00h-EFh and the same meanings (the JP-8080 renames a
// few: Control vs Ribbon matrix, OSC2 CONTROL1/2 vs PULSE WIDTH/PWM DEPTH, Env Type in Solo vs in
// Mono); the JP-8080 adds F0h-F7h and a 13th Multi-FX type, and its OSC2 has NOISE. So a patch
// carries, besides the semantic fields every device can read, the exact JP bytes ("extra"), and a
// JP of the other model takes those and fixes up only what it cannot hold.

import { COMMON_MODEL, unit, fromUnit, bipolar, fromBipolar, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';

const FAMILY = 'roland-jp';
const LFO1_WAVES = ['triangle', 'saw', 'square', 'sample-hold'];
const OSC1_WAVES = ['supersaw', 'triangle-mod', 'noise', 'feedback', 'square', 'saw', 'triangle'];
const OSC2_WAVES = ['square', 'triangle', 'saw', 'noise'];
const FILTERS = ['hpf', 'bpf', 'lpf'];
const PANS = ['off', 'auto', 'manual'];
const DELAYS = ['panning-lr', 'panning-rl', 'panning-short', 'mono-short', 'mono-long', 'space-echo'];
const TARGETS = ['osc1+2', 'osc2', 'xmod'];
const LFO2_TARGETS = ['pitch', 'filter', 'amp'];
const env4 = (d, o) => ({ attack: unit(d[o]), decay: unit(d[o + 1]), sustain: unit(d[o + 2]), release: unit(d[o + 3]) });
const put4 = (d, o, e) => { if (!e) return; d[o] = fromUnit(e.attack); d[o + 1] = fromUnit(e.decay); d[o + 2] = fromUnit(e.sustain); d[o + 3] = fromUnit(e.release); };
const idx = (list, v, dflt = 0) => { const i = list.indexOf(v); return i < 0 ? dflt : i; };

/**
 * M: { name ('JP-8080'), deviceId, patchSize, patchParams, mfxNames (Multi-FX/Chorus type names),
 *      perfParts: [{address, offset, size}] (object layout), partSize, vmod (offset or undefined) }
 */
/**
 * What the JP-8000 and JP-8080 share of a patch or performance, as one string (Head Library
 * duplicate search across models): patch bytes 10h-EEh (after the name; EFh and the JP-8080's
 * F0h-F7h left out), or performance common 10h-23h and the first 7 bytes of each part.
 */
export function jpMatch(extra) {
  if (extra?.patch) return toBase64(fromBase64(extra.patch).subarray(0x10, 0xef));
  const b = extra?.blocks;
  if (!b?.[0x200000]) return null;
  const parts = [0x200800, 0x200880].map((a) => (b[a] ? Array.from(fromBase64(b[a]).subarray(0, 7)) : []));
  return toBase64(Uint8Array.from([...fromBase64(b[0x200000]).subarray(0x10, 0x24), ...parts.flat()]));
}
const jpExtra = (x) => ({ ...x, match: jpMatch(x) });

export function jpTranslator(M) {
  const depthLabel = new Map(M.patchParams.filter((p) => p.two && p.offset >= 0x4a && p.offset <= 0xeb).map((p) => [p.offset, p.label]));
  const label = (o) => M.patchParams.find((p) => p.offset === o)?.label || `byte ${o.toString(16)}h`;

  // ------------------------------------------------------------ patch
  function patchToCommon(d) {
    const two = (o) => (d[o] & 1) * 128 + (d[o + 1] & 127);
    const depths = (from, to, skip) => {
      const out = {};
      for (let o = from; o <= to; o += 2) {
        if (skip.includes(o)) { o -= 1; continue; }
        if (depthLabel.has(o)) out[depthLabel.get(o)] = Math.max(-1, Math.min(1, (two(o) - 127) / 127));
      }
      return out;
    };
    const range = d[0x23];
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: {
        mode: d[0x47] ? (d[0x48] ? 'legato' : 'mono') : (M.patchSize > 0xf3 && d[0xf3] ? 'unison' : 'poly'), legato: !!d[0x48],
        portamento: { on: !!d[0x45], time: unit(d[0x46]) }, bendUp: d[0x43], bendDown: d[0x44],
        unisonDetune: M.patchSize > 0xf4 ? d[0xf4] : undefined, octave: d[0x49] - 2,
      },
      osc: [
        { wave: OSC1_WAVES[d[0x1e]] || 'saw', control1: unit(d[0x1f]), control2: unit(d[0x20]) },
        {
          wave: OSC2_WAVES[d[0x21]] || 'square', coarse: range === 0 ? 'wide-' : range >= 50 ? 'wide+' : range - 25, fine: d[0x24] - 50,
          control1: unit(d[0x25]), control2: unit(d[0x26]), pulseWidth: unit(d[0x25]), pwmDepth: unit(d[0x26]), sync: !!d[0x22],
        },
      ],
      mix: { balance: bipolar(d[0x17]), crossMod: unit(d[0x16]), ring: !!d[0x15] },
      pitch: { lfo1: bipolar(d[0x19]), lfo2: bipolar(d[0x1a]), envDepth: bipolar(d[0x1b]), env: { attack: unit(d[0x1c]), decay: unit(d[0x1d]) }, target: TARGETS[d[0x18]] || 'osc1+2' },
      filter: {
        type: FILTERS[d[0x27]] || 'lpf', slope: d[0x28] ? 24 : 12, cutoff: unit(d[0x29]), resonance: unit(d[0x2a]), keyTrack: bipolar(d[0x2b]),
        lfo1: bipolar(d[0x2c]), lfo2: bipolar(d[0x2d]), envDepth: bipolar(d[0x2e]), env: env4(d, 0x2f),
      },
      amp: { level: unit(d[0x33]), lfo1: bipolar(d[0x34]), lfo2: bipolar(d[0x35]), env: env4(d, 0x36), pan: PANS[d[0x3a]] || 'off' },
      lfo: [{ wave: LFO1_WAVES[d[0x10]] || 'triangle', rate: unit(d[0x11]), fade: unit(d[0x12]) }, { rate: unit(d[0x13]), target: LFO2_TARGETS[d[0x14]] || 'pitch' }],
      tone: { bass: bipolar(d[0x3b]), treble: bipolar(d[0x3c]) },
      effects: {
        modulation: { type: M.mfxNames[d[0x3d]] || '', level: unit(d[0x3e]) },
        delay: { type: DELAYS[d[0x3f]] || '', time: unit(d[0x40]), feedback: unit(d[0x41]), level: unit(d[0x42]) },
      },
      velocity: { on: !!d[0x9b], depths: depths(0x9c, 0xeb, []) },
      controller: { depths: depths(0x4a, 0x9a, [0x98]) },
      extra: jpExtra({ family: FAMILY, model: M.deviceId, patch: toBase64(d) }),
    };
  }

  /** Semantic fields onto a patch (used when the patch did not come from a JP). */
  function semanticToPatch(c, d, r) {
    const v = c.voice || {};
    const set = (o, val, what) => { if (val === undefined || val === null || Number.isNaN(val)) return; d[o] = val; r.mapped.push(what); };
    if (v.mode) { set(0x47, v.mode === 'mono' || v.mode === 'legato' ? 1 : 0, 'Mono'); set(0x48, v.legato ?? v.mode === 'legato' ? 1 : 0, 'Legato'); if (M.patchSize > 0xf3) set(0xf3, v.mode === 'unison' ? 1 : 0, 'Unison'); else if (v.mode === 'unison') r.dropped.push('Unison (no unison switch)'); }
    if (v.portamento) { set(0x45, v.portamento.on ? 1 : 0, 'Portamento switch'); set(0x46, fromUnit(v.portamento.time), 'Portamento time'); }
    if (v.bendUp !== undefined) set(0x43, Math.min(24, v.bendUp), 'Bend range up');
    if (v.bendDown !== undefined) set(0x44, Math.min(24, v.bendDown), 'Bend range down');
    if (v.octave !== undefined) set(0x49, Math.max(0, Math.min(4, v.octave + 2)), 'Oscillator shift');
    const [o1, o2] = c.osc || [];
    if (o1) {
      const w = OSC1_WAVES.indexOf(o1.wave);
      if (w >= 0) set(0x1e, w, 'OSC1 waveform'); else { d[0x1e] = 5; r.approximated.push(`OSC1 wave ${o1.wave} → SAW`); }
      set(0x1f, fromUnit(o1.control1), 'OSC1 control 1'); set(0x20, fromUnit(o1.control2), 'OSC1 control 2');
    }
    if (o2) {
      const w = OSC2_WAVES.indexOf(o2.wave);
      if (w >= 0) set(0x21, w, 'OSC2 waveform'); else { d[0x21] = 2; r.approximated.push(`OSC2 wave ${o2.wave} → SAW`); }
      if (o2.coarse !== undefined) set(0x23, o2.coarse === 'wide-' ? 0 : o2.coarse === 'wide+' ? 50 : Math.max(1, Math.min(49, Math.round(o2.coarse) + 25)), 'OSC2 range');
      if (o2.fine !== undefined) set(0x24, Math.max(0, Math.min(100, Math.round(o2.fine) + 50)), 'OSC2 fine');
      set(0x25, fromUnit(o2.pulseWidth ?? o2.control1), 'OSC2 control 1 / pulse width');
      set(0x26, fromUnit(o2.pwmDepth ?? o2.control2), 'OSC2 control 2 / PWM depth');
      if (o2.sync !== undefined) set(0x22, o2.sync ? 1 : 0, 'OSC2 sync');
    }
    const m = c.mix || {};
    if (m.balance !== undefined) set(0x17, fromBipolar(m.balance), 'OSC balance');
    if (m.crossMod !== undefined) set(0x16, fromUnit(m.crossMod), 'Cross modulation');
    if (m.ring !== undefined) set(0x15, m.ring ? 1 : 0, 'Ring modulator');
    const p = c.pitch || {};
    if (p.lfo1 !== undefined) set(0x19, fromBipolar(p.lfo1), 'OSC LFO1 depth');
    if (p.lfo2 !== undefined) set(0x1a, fromBipolar(p.lfo2), 'Pitch LFO2 depth');
    if (p.envDepth !== undefined) set(0x1b, fromBipolar(p.envDepth), 'Pitch env depth');
    if (p.env) { set(0x1c, fromUnit(p.env.attack), 'Pitch env attack'); set(0x1d, fromUnit(p.env.decay), 'Pitch env decay'); }
    if (p.target) set(0x18, idx(TARGETS, p.target), 'LFO1 & env destination');
    const f = c.filter || {};
    if (f.type) { const t = FILTERS.indexOf(f.type); if (t >= 0) set(0x27, t, 'Filter type'); else { d[0x27] = 2; r.approximated.push(`Filter ${f.type} → LPF`); } }
    if (f.slope) set(0x28, f.slope >= 18 ? 1 : 0, 'Cutoff slope');
    for (const [k, o, bi] of [['cutoff', 0x29], ['resonance', 0x2a], ['keyTrack', 0x2b, 1], ['lfo1', 0x2c, 1], ['lfo2', 0x2d, 1], ['envDepth', 0x2e, 1]]) if (f[k] !== undefined) set(o, bi ? fromBipolar(f[k]) : fromUnit(f[k]), `Filter ${k}`);
    if (f.env) { put4(d, 0x2f, f.env); r.mapped.push('Filter envelope'); }
    const a = c.amp || {};
    if (a.level !== undefined) set(0x33, fromUnit(a.level), 'Amp level');
    if (a.lfo1 !== undefined) set(0x34, fromBipolar(a.lfo1), 'Amp LFO1 depth');
    if (a.lfo2 !== undefined) set(0x35, fromBipolar(a.lfo2), 'Amp LFO2 depth');
    if (a.env) { put4(d, 0x36, a.env); r.mapped.push('Amp envelope'); }
    if (a.pan) set(0x3a, idx(PANS, a.pan), 'Pan mode');
    const [l1, l2] = c.lfo || [];
    if (l1) { set(0x10, idx(LFO1_WAVES, l1.wave === 'sine' ? 'triangle' : l1.wave), 'LFO1 waveform'); set(0x11, fromUnit(l1.rate), 'LFO1 rate'); set(0x12, fromUnit(l1.fade), 'LFO1 fade'); }
    if (l2) { set(0x13, fromUnit(l2.rate), 'LFO2 rate'); if (l2.target) set(0x14, idx(LFO2_TARGETS, l2.target), 'LFO2 depth select'); }
    if (c.tone) { set(0x3b, fromBipolar(c.tone.bass ?? 0), 'Tone bass'); set(0x3c, fromBipolar(c.tone.treble ?? 0), 'Tone treble'); }
    const fx = c.effects || {};
    if (fx.modulation) {
      const t = M.mfxNames.indexOf(fx.modulation.type);
      if (t >= 0) set(0x3d, t, 'Multi-FX type'); else if (fx.modulation.type) r.approximated.push(`Effect ${fx.modulation.type} → ${M.mfxNames[0]}`);
      set(0x3e, fromUnit(fx.modulation.level), 'Multi-FX level');
    }
    if (fx.delay) {
      const t = DELAYS.indexOf(fx.delay.type);
      if (t >= 0 && t < M.delayTypes) set(0x3f, t, 'Delay type'); else if (fx.delay.type) r.approximated.push(`Delay ${fx.delay.type} → ${DELAYS[0]}`);
      set(0x40, fromUnit(fx.delay.time), 'Delay time'); set(0x41, fromUnit(fx.delay.feedback), 'Delay feedback'); set(0x42, fromUnit(fx.delay.level), 'Delay level');
    }
    const putDepths = (src, from, to) => {
      if (!src) return;
      for (const [o, l] of depthLabel) {
        if (o < from || o > to || src[l] === undefined) continue;
        const v = Math.max(0, Math.min(254, Math.round(127 + src[l] * 127)));
        d[o] = v >> 7; d[o + 1] = v & 127;
        r.mapped.push(`${l} depth`);
      }
    };
    if (c.velocity) { set(0x9b, c.velocity.on ? 1 : 0, 'Velocity switch'); putDepths(c.velocity.depths, 0x9c, 0xeb); }
    if (c.controller) putDepths(c.controller.depths, 0x4a, 0x9a);
  }

  function patchFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.patch) {
      const src = fromBase64(c.extra.patch);
      const n = Math.min(src.length, d.length);
      d.set(src.subarray(0, n), 0);
      r.mapped.push(`all ${n} shared patch bytes (same family: ${c.extra.model})`);
      if (src.length > d.length) {
        // what the source uses that this model does not have (detune and destination only matter when switched on)
        const lost = [0xf1, 0xf2, 0xf3, 0xf5, 0xf6].filter((o) => o < src.length && src[o]);
        if (src[0xf3] && src.length > 0xf4) lost.push(0xf4);
        if (src[0xf6] && src.length > 0xf7) lost.push(0xf7);
        const names = { 0xf1: 'OSC2 external input', 0xf2: 'Voice modulator send', 0xf3: 'Unison', 0xf4: 'Unison detune', 0xf5: 'Patch gain', 0xf6: 'External trigger', 0xf7: 'External trigger destination' };
        if (lost.length) r.dropped.push(...lost.map((o) => `${names[o] || `byte ${o.toString(16)}h`} (${M.name} has no such setting)`));
      } else if (src.length < d.length) r.approximated.push(`${M.name}-only settings (bytes ${src.length.toString(16)}h-${(d.length - 1).toString(16)}h) left at their defaults`);
      // values this model cannot hold
      if (d[0x21] >= 3 && !OSC2_HAS_NOISE(M)) { r.approximated.push('OSC2 NOISE → SQUARE (no noise on this OSC2)'); d[0x21] = 0; }
      if (d[0x3d] >= M.mfxNames.length) { r.dropped.push(`Multi-FX ${c.effects?.modulation?.type || 'type'} (no such type here): effect level set to 0`); d[0x3d] = 0; d[0x3e] = 0; }
      if (c.extra.model !== M.deviceId) r.approximated.push('Controller depths kept on the same knobs (the Control knob on the JP-8080, the ribbon on the JP-8000), as are Morph/Pitch Bend assign and the solo/mono envelope type');
      return { data: d, report: r };
    }
    semanticToPatch(c, d, r);
    return { data: d, report: r };
  }

  // ------------------------------------------------------------ performance
  const part = (n) => M.perfParts.find((p) => p.address === 0x200800 + n * 0x80); // 01 00 10 00 / 11 00
  const commonPart = M.perfParts[0];
  function perfToCommon(d) {
    const blocks = {};
    for (const p of M.perfParts) blocks[p.address] = toBase64(d.subarray(p.offset, p.offset + p.size));
    return {
      model: COMMON_MODEL, kind: 'performance',
      keyMode: ['single', 'dual', 'split'][d[0x10]], splitPoint: d[0x11], tempo: (d[0x22] & 1) * 128 + d[0x23],
      arpeggio: { on: !!d[0x17], mode: ['up', 'down', 'up-down', 'random', 'rps'][d[0x18]], octaves: d[0x1a] + 1, hold: !!d[0x1b] },
      parts: [0, 1].map((n) => { const pp = part(n); return pp ? { channel: d[pp.offset + 2], transpose: d[pp.offset + 3] - 24 } : null; }),
      extra: jpExtra({ family: FAMILY, model: M.deviceId, blocks }),
    };
  }
  function perfFromCommon(c, base) {
    const d = Uint8Array.from(base);
    const r = emptyReport();
    if (c.extra?.family === FAMILY && c.extra.blocks) {
      for (const p of M.perfParts) {
        const src = c.extra.blocks[p.address];
        if (!src) { r.approximated.push(`${p.label || 'block'} left at defaults (the source has none)`); continue; }
        const b = fromBase64(src);
        d.set(b.subarray(0, p.size), p.offset);
        if (b.length > p.size) r.dropped.push(`${b.length - p.size} byte(s) of ${p.label || 'a block'} the ${M.name} does not have`);
        r.mapped.push(p.label || 'block');
      }
      for (const a of Object.keys(c.extra.blocks)) if (!M.perfParts.some((p) => String(p.address) === a)) r.dropped.push(a === String(0x200400) ? `Voice modulator (the ${M.name} has none)` : `block ${a}`);
      return { data: d, report: r };
    }
    if (c.keyMode) { d[0x10] = Math.max(0, ['single', 'dual', 'split'].indexOf(c.keyMode)); r.mapped.push('Key mode'); }
    if (c.splitPoint !== undefined) { d[0x11] = c.splitPoint; r.mapped.push('Split point'); }
    if (c.tempo) { d[0x22] = c.tempo >> 7; d[0x23] = c.tempo & 127; r.mapped.push('Tempo'); }
    if (commonPart) r.approximated.push('Other performance settings left at defaults');
    return { data: d, report: r };
  }

  return { patchToCommon, patchFromCommon, perfToCommon, perfFromCommon };
}

const OSC2_HAS_NOISE = (M) => M.osc2Waves > 3;

/** Which JP model a set of DT1 messages was made for: 'roland-jp8080', 'roland-jp8000' or null. */
export function jpModelOf(parsed) {
  // parsed: [{a (7-bit address int), n (data length)}]
  const A1 = 1 << 21; const A2 = 2 << 21; const A3 = 3 << 21;
  let jp8000 = false;
  for (const { a, n } of parsed) {
    const aa = a >> 21;
    if (aa === 0) { if (a >= 0x800 && a < 0x830) jp8000 = true; continue; } // 00 00 10 00: JP-8000 pattern loop lengths
    if (aa === 2) { const off = (a - A2) % 256; if (off + n > 0xf0) return 'roland-jp8080'; jp8000 = true; continue; }
    if (aa === 1 || aa === 3) {
      const rel = aa === 1 ? a - A1 : (a - A3) % 16384;
      if (rel < 0x80) { if (rel + n > 0x24) return 'roland-jp8080'; jp8000 = true; } else if (rel >= 0x400 && rel < 0x480) return 'roland-jp8080'; // voice modulator
      else if (rel >= 0x800 && rel < 0x900) { if (((rel - 0x800) % 128) + n > 7) return 'roland-jp8080'; jp8000 = true; } else if (rel >= 0x2000) { if (((rel - 0x2000) % 256) + n > 0xf0) return 'roland-jp8080'; jp8000 = true; }
    }
  }
  return jp8000 ? 'roland-jp8000' : null;
}

// ------------------------------------------------------------------ WinJPLib files
// The JP-8000 Branch Library files (.pat, .pfm) found in third-party sound sets: a 128-byte header
// ("JP-8000 USER PATCH      0001" or "JP-8000 USER PERFORMANCE0001") and then fixed records:
//   .pat  239 bytes per patch: patch bytes 00-EE (EFh, the last JP-8000 patch byte, is left out)
//   .pfm  528 bytes per performance: common 24h, upper part 7, lower part 7, then the upper and
//         lower patches (239 bytes each), as at 03 nn 00 00 / 10 00 / 11 00 / 40 00 / 42 00.
// Checked byte for byte against the same sets as SysEx (Alan M .mid, AZS Eternal .j8k).
const WJ_HEAD = 128;
const WJ_PATCH = 239;
const WJ_PERF = 0x24 + 7 + 7 + 2 * WJ_PATCH;

/** {kind: 'patch'|'performance', records: [{patch} | {perf, upper, lower}]} or null. */
export function readWinJpLib(bytes) {
  if (bytes.length < WJ_HEAD) return null;
  const head = String.fromCharCode(...bytes.subarray(0, 28));
  if (head.startsWith('JP-8000 USER PATCH')) {
    const n = Math.floor((bytes.length - WJ_HEAD) / WJ_PATCH);
    return { kind: 'patch', records: Array.from({ length: n }, (_, k) => ({ patch: bytes.subarray(WJ_HEAD + k * WJ_PATCH, WJ_HEAD + (k + 1) * WJ_PATCH) })) };
  }
  if (head.startsWith('JP-8000 USER PERFORMANCE')) {
    const n = Math.floor((bytes.length - WJ_HEAD) / WJ_PERF);
    return {
      kind: 'performance',
      records: Array.from({ length: n }, (_, k) => {
        const r = bytes.subarray(WJ_HEAD + k * WJ_PERF, WJ_HEAD + (k + 1) * WJ_PERF);
        return { perf: r.subarray(0, 0x32), upper: r.subarray(0x32, 0x32 + WJ_PATCH), lower: r.subarray(0x32 + WJ_PATCH) };
      }),
    };
  }
  return null;
}
