// ART Multiverb Alpha 2 family (Alpha 2 v2.02, Alpha 2 SE v1.03 / v1.04): one editor built from each
// model's generated tables (tools/art/alpha2_fw.py). See docs/devices/art-multiverb-alpha2.md and
// docs/devices/art-multiverb-alpha2-se.md.
//
// A preset is a chain: a configuration (0-53: LOW-PASS first, then up to four digital effects in a fixed
// order) of which some effects are in use, plus MIX, the 7-band EQUALIZER and the A.E.S. when in use, a
// 16-character title and up to eight PERFORMANCE MIDI assignments. The edit buffer holds it expanded in
// 98 bytes, the same in both models:
//   0      X-15 FX ON/OFF status: bit 0-5 = switch #4 EQUALIZER, #6 REVERB, #7 DELAY, #8 PITCH EFX,
//          #9 FLNG/CHOR, #10 SPECL FX
//   1      bit 0 EQUALIZER, bit 1 A.E.S. in the preset          2   configuration 0-53
//   3      bit k: the k-th effect of the configuration in use    4-6 MIX DRY, EFX, DRYEQ
//   7-13   EQUALIZER 40Hz ... 10KHz                              14  A.E.S.
//   15-32  the configuration's effects in chain order, each with its parameters
//   33-48  title                                                  49  PERFORMANCE MIDI assignments in use (bit k = #k+1)
//   50+6k  #k+1: controller (0-120 MC n, 121-127 note / pressure / bend sources, 128 OFF), LOW VALUE,
//          HIGH VALUE, the parameter it controls (1-29 = bytes 4-32; 0 none), and two runtime bytes:
//          the parameter's value as recalled (STORE writes it back) and the last controller value
//          not yet applied (FFh none)
// Stored presets are packed: the Alpha 2 keeps whole bytes (22-80 bytes), the SE bit fields as narrow as
// each value's range. SysEx F0 1A <ch> 11 <id> ... F7 with <ch> = MIDI CHANNEL - 1.

import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';

export const SIZE = 98;
export const E = { status: 0, blocks: 1, config: 2, present: 3, mix: 4, eq: 7, aes: 14, fx: 15, title: 33, pmUsed: 49, pm: 50 };
export const FX_SIZE = 18;
export const TITLE_LEN = 16;
export const N_PRESETS = 200;
export const T = { lpf: 0, mix: 25, eq: 26, aes: 27 };
export const SWITCH_OF_BIT = [4, 6, 7, 8, 9, 10]; // X-15 switch of status bits 0-5
const PM_TEMPLATE = [4, 0, 0x7f, 0, 0, 0xff]; // an unused assignment
const FAMILY = 'art-multiverb';

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad3 = (n) => String(n).padStart(3, ' ');
export const isAlpha = (raw) => raw?.[0] === 0xf0 && raw.length >= 6 && raw[1] === 0x1a && raw[3] === 0x11 && raw[2] < 16;
const id = (raw) => raw[4];
const chanCtx = (raw) => ({ channel: raw[2] & 15 });
const pair = (n) => [n & 0x7f, (n >> 7) & 1];
const pairs = (bytes) => Array.from(bytes).flatMap((b) => [b & 0x7f, (b >> 7) & 1]);
export function unpair(raw, at, n) {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = ((raw[at + 2 * i] ?? 0) & 0x7f) | (((raw[at + 2 * i + 1] ?? 0) & 1) << 7);
  return d;
}
const num = (raw, at) => ((raw[at] ?? 0) & 0x7f) | (((raw[at + 1] ?? 0) & 1) << 7);
const bitLength = (n) => (n > 0 ? 32 - Math.clz32(n) : 0);

/**
 * @param FW  the model's generated tables (art-multiverb-alpha2-fw.js / art-multiverb-alpha2-se-fw.js)
 * @param M   {id, name, se, AT}: AT = firmware addresses the help texts name (strings)
 */
export function makeAlpha(FW, M) {
  const { TYPES, CONFIGS, TEXTS, UTIL, PM_TITLES, FX_STATUS, CTRL, X15, DEFAULTS, FIRMWARE } = FW;
  const SE = !!M.se;
  const AT = M.AT;
  const WHO = M.name;
  const BROKEN = FW.BROKEN || [];
  const N_FACTORY = SE ? FW.N_FACTORY : FW.FACTORY.length;
  const N_MAP = SE ? 200 : 128; // MIDI program table entries
  const head = (ctx) => [0xf0, 0x1a, (ctx?.channel ?? 0) & 0x0f, 0x11];

  // ---------------------------------------------------------------- effect types, layout
  const sizeOf = (t) => TYPES[t].params.length;
  const cfgOf = (d) => Math.min(CONFIGS.length - 1, d[E.config]);
  /** The LCD texts of parameter i of type t (min..max); with an edit buffer, the variant it selects
   *  (TUNER REFRNC lists the notes of the strings TYPE picks). */
  function textsOf(t, i, d = null) {
    const vs = TEXTS[t][i];
    if (d && vs.length > 1) {
      const cfg = cfgOf(d);
      const hit = vs.find((v) => (v.when ? d[fxOffset(cfg, t, v.when[0])] === v.when[1] : v.configs?.includes(cfg)));
      if (hit) return hit.values;
    }
    return vs[0].values;
  }
  const labelOf = (t, i) => TEXTS[t][i][0].label;
  const valueText = (t, i, v, d = null) => textsOf(t, i, d)[v - TYPES[t].params[i].min] ?? String(v);
  const varies = (t, i) => TEXTS[t][i].length > 1;
  const switchOf = (t) => TYPES[t].params[0].x15; // the X-15 switch that turns the effect on/off
  /** Byte offset of parameter i of effect type t in configuration cfg, or -1 when cfg has no such effect. */
  function fxOffset(cfg, t, i = 0) {
    let o = E.fx;
    for (const x of CONFIGS[cfg]) {
      if (x === t) return o + i;
      o += sizeOf(x);
    }
    return -1;
  }
  /** Whether effect type t is in use in the edit buffer (MIX always). */
  function inUse(d, t) {
    if (t === T.mix) return true;
    if (t === T.eq) return !!(d[E.blocks] & 1);
    if (t === T.aes) return !!(d[E.blocks] & 2);
    const k = CONFIGS[cfgOf(d)].indexOf(t);
    return k >= 0 && !!((d[E.present] >> k) & 1);
  }
  /** Parameters 1-29 of a configuration, as PERFORMANCE MIDI numbers them: {n, t, i, offset}. */
  function paramList(cfg) {
    const out = [];
    const add = (t) => TYPES[t].params.forEach((_, i) => out.push({ n: out.length + 1, t, i, offset: E.mix + out.length }));
    [T.mix, T.eq, T.aes, ...CONFIGS[cfg]].forEach(add);
    return out.slice(0, 29);
  }
  const paramName = (t, i) => `${TYPES[t].abbr.trim()}:${labelOf(t, i)}`;
  const chainName = (cfg) => CONFIGS[cfg].map((t) => TYPES[t].name).join(' > ');
  const CONFIG_NAMES = CONFIGS.map((_, c) => chainName(c));
  const CONFIG_OK = CONFIGS.map((_, c) => !BROKEN.includes(c));

  /** What is in use, as the LCD sums it up ("3 EQL+AES+REV"). */
  function summary(d) {
    const ab = [];
    if (inUse(d, T.eq)) ab.push('EQL');
    if (inUse(d, T.aes)) ab.push('AES');
    for (const t of CONFIGS[cfgOf(d)]) if (inUse(d, t)) ab.push(TYPES[t].abbr.trim());
    return ab.length ? `${ab.length} ${ab.join('+')}` : '<no effects>';
  }

  // ---------------------------------------------------------------- edit buffer
  /** An edit buffer of configuration cfg with every value at its default, nothing in use. */
  function initEdit(cfg = 0) {
    const d = new Uint8Array(SIZE);
    d[E.config] = cfg;
    for (const { t, i, offset } of paramList(cfg)) if (offset < E.title) d[offset] = TYPES[t].params[i].def;
    d.fill(0x20, E.title, E.title + TITLE_LEN);
    for (let k = 0; k < 8; k++) d.set(PM_TEMPLATE, E.pm + 6 * k);
    return d;
  }
  const titleOf = (d) => String.fromCharCode(...Array.from(d.slice(E.title, E.title + TITLE_LEN), (c) => (c >= 0x20 && c < 0x7f ? c : 0x20)));
  function nameOf(d) {
    const s = titleOf(d).trim();
    return s || (summary(d) === '<no effects>' ? '' : '<blank title>');
  }
  function setName(d, name) {
    const s = String(name ?? '').replace(/[^\x20-\x7e]/g, ' ').slice(0, TITLE_LEN).padEnd(TITLE_LEN, ' ');
    for (let i = 0; i < TITLE_LEN; i++) d[E.title + i] = s.charCodeAt(i);
  }
  /** An empty preset (as STORE keeps it: blank title, nothing in use, MIX as the empty preset). */
  const emptyMix = SE ? [0, 0x17, 0x17] : [0x17, 0x17, 0];
  const isEmptyPreset = (d) => !d[1] && !d[2] && !d[3] && !d[E.pmUsed] && !titleOf(d).trim() && d[4] === emptyMix[0] && d[5] === emptyMix[1] && d[6] === emptyMix[2];

  /** Keep values in their ranges (the unit does not check what it receives). Returns how many changed. */
  function fitEdit(d) {
    let n = 0;
    const lim = (o, lo, hi) => { const v = Math.max(lo, Math.min(hi, d[o])); if (v !== d[o]) { d[o] = v; n++; } };
    lim(E.config, 0, CONFIGS.length - 1);
    if (BROKEN.includes(d[E.config])) { d[E.config] = 0; n++; }
    if (d[E.status] & 0xc0) { d[E.status] &= 0x3f; n++; }
    for (const { t, i, offset } of paramList(cfgOf(d))) lim(offset, TYPES[t].params[i].min, TYPES[t].params[i].max);
    for (let k = 0; k < TITLE_LEN; k++) if (d[E.title + k] < 0x20 || d[E.title + k] > 0x7e) { d[E.title + k] = 0x20; n++; }
    const list = paramList(cfgOf(d));
    for (let k = 0; k < 8; k++) {
      const o = E.pm + 6 * k;
      lim(o, 0, 128);
      lim(o + 3, 0, list.length);
      const p = list[d[o + 3] - 1];
      if (p) { lim(o + 1, TYPES[p.t].params[p.i].min, TYPES[p.t].params[p.i].max); lim(o + 2, TYPES[p.t].params[p.i].min, TYPES[p.t].params[p.i].max); }
    }
    return n;
  }
  /** The edit buffer as sent: values limited, each assignment's runtime bytes set as recalling leaves them
   *  (byte 4 = the controlled parameter's value, which STORE writes back; byte 5 = FFh). */
  function prepare(data) {
    const d = Uint8Array.from(data.slice(0, SIZE));
    fitEdit(d);
    for (let k = 0; k < 8; k++) {
      const o = E.pm + 6 * k;
      if (!((d[E.pmUsed] >> k) & 1)) continue;
      if (d[o + 3] >= 1 && d[o + 3] <= 29) d[o + 4] = d[E.mix + d[o + 3] - 1];
      d[o + 5] = 0xff;
    }
    return d;
  }

  // ---------------------------------------------------------------- packed presets
  // Alpha 2 (6CDB / 69C2): byte 0, bytes 1-6, the EQ and A.E.S. bytes when in use, the bytes of the
  // effects in use, the title in 7 bits a character (14 bytes), byte 49 and 4 bytes per assignment in use.
  function packTitle(d) {
    const out = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < TITLE_LEN; i++) {
      acc = (acc << 7) | (d[E.title + i] & 0x7f);
      bits += 7;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
      acc &= (1 << bits) - 1;
    }
    return out;
  }
  function unpackTitle(bytes) {
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const b of bytes) {
      acc = (acc << 8) | b;
      bits += 8;
      while (bits >= 7) { bits -= 7; out.push((acc >> bits) & 0x7f); }
      acc &= (1 << bits) - 1;
    }
    return out.slice(0, TITLE_LEN);
  }
  function packA2(d) {
    const cfg = cfgOf(d);
    const out = [d[0] & 0x3f, d[1], d[2], d[3], d[4], d[5], d[6]];
    if (d[1] & 1) out.push(...d.slice(E.eq, E.eq + 7));
    if (d[1] & 2) out.push(d[E.aes]);
    let o = E.fx;
    CONFIGS[cfg].forEach((t, k) => {
      if ((d[3] >> k) & 1) out.push(...d.slice(o, o + sizeOf(t)));
      o += sizeOf(t);
    });
    out.push(...packTitle(d), d[E.pmUsed]);
    for (let k = 0; k < 8; k++) if ((d[E.pmUsed] >> k) & 1) out.push(...d.slice(E.pm + 6 * k, E.pm + 6 * k + 4));
    return Uint8Array.from(out);
  }
  function unpackA2(p) {
    const cfg = Math.min(CONFIGS.length - 1, p[2]);
    const d = initEdit(cfg);
    d.set(p.slice(0, 7), 0);
    let at = 7;
    if (p[1] & 1) { d.set(p.slice(at, at + 7), E.eq); at += 7; }
    if (p[1] & 2) d[E.aes] = p[at++];
    let o = E.fx;
    CONFIGS[cfg].forEach((t, k) => {
      const n = sizeOf(t);
      if ((p[3] >> k) & 1) { d.set(p.slice(at, at + n), o); at += n; }
      o += n;
    });
    d.set(unpackTitle(p.slice(at, at + 14)), E.title);
    at += 14;
    const used = p[at++] ?? 0;
    d[E.pmUsed] = used;
    for (let k = 0; k < 8; k++) {
      if (!((used >> k) & 1)) continue;
      const s = E.pm + 6 * k;
      d.set(p.slice(at, at + 4), s);
      at += 4;
      d[s + 4] = d[E.mix + d[s + 3] - 1] ?? 0;
      d[s + 5] = 0xff;
    }
    return d;
  }
  const packedLengthA2 = (p) => {
    let n = 7 + (p[1] & 1 ? 7 : 0) + (p[1] & 2 ? 1 : 0);
    CONFIGS[Math.min(CONFIGS.length - 1, p[2])].forEach((t, k) => { if ((p[3] >> k) & 1) n += sizeOf(t); });
    n += 14;
    const used = p[n] ?? 0;
    return n + 1 + 4 * [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => (used >> k) & 1).length;
  };

  // SE (AT.pack / AT.unpack): one MSB-first bit stream: switches 6 bits, blocks 2, configuration 6,
  // effects 5; parameters 1-29 of the effects in use, each (value - min) in as many bits as max - min
  // needs (none when min = max; the widths AT.widths works out from the header); the title, 7 bits a
  // character; byte 49 in 8 bits; per assignment in use its controller (8), parameter (5) and, with a
  // parameter, LOW and HIGH in that parameter's width. The last byte is filled with zero bits.
  function widths(d) {
    return paramList(cfgOf(d)).map(({ t, i }) => {
      const P = TYPES[t].params[i];
      const bits = inUse(d, t) ? bitLength(P.max - P.min) : 0;
      return bits ? { min: P.min, bits } : { min: 0, bits: 0 };
    });
  }
  function packSE(d) {
    const out = [];
    let acc = 0;
    let n = 0;
    const put = (v, bits) => {
      for (let k = bits - 1; k >= 0; k--) {
        acc = (acc << 1) | ((v >> k) & 1);
        if (++n === 8) { out.push(acc); acc = 0; n = 0; }
      }
    };
    put(d[0], 6); put(d[1], 2); put(d[2], 6); put(d[3], 5);
    const W = widths(d);
    W.forEach((w, k) => { if (w.bits) put((d[E.mix + k] - w.min) & 0xff, w.bits); });
    for (let i = 0; i < TITLE_LEN; i++) put(d[E.title + i], 7);
    put(d[E.pmUsed], 8);
    for (let k = 0; k < 8; k++) {
      if (!((d[E.pmUsed] >> k) & 1)) continue;
      const o = E.pm + 6 * k;
      put(d[o], 8);
      put(d[o + 3], 5);
      if (d[o + 3]) {
        const w = W[d[o + 3] - 1] || { min: 0, bits: 0 };
        put((d[o + 1] - w.min) & 0xff, w.bits);
        put((d[o + 2] - w.min) & 0xff, w.bits);
      }
    }
    if (n) out.push(acc << (8 - n));
    return Uint8Array.from(out);
  }
  function unpackSE(p) {
    let at = 0;
    let bit = 0;
    const get = (bits) => {
      let v = 0;
      for (let k = 0; k < bits; k++) {
        v = (v << 1) | (((p[at] ?? 0) >> (7 - bit)) & 1);
        if (++bit === 8) { bit = 0; at++; }
      }
      return v;
    };
    const h = [get(6), get(2), get(6), get(5)];
    const d = initEdit(Math.min(CONFIGS.length - 1, h[2]));
    d.set(h, 0);
    const W = widths(d);
    W.forEach((w, k) => { if (w.bits) d[E.mix + k] = (get(w.bits) + w.min) & 0xff; });
    for (let i = 0; i < TITLE_LEN; i++) d[E.title + i] = get(7);
    d[E.pmUsed] = get(8);
    for (let k = 0; k < 8; k++) {
      const o = E.pm + 6 * k;
      if (!((d[E.pmUsed] >> k) & 1)) { d.set(PM_TEMPLATE, o); continue; }
      d[o] = get(8);
      d[o + 3] = get(5);
      if (d[o + 3]) {
        const w = W[d[o + 3] - 1] || { min: 0, bits: 0 };
        d[o + 1] = (get(w.bits) + w.min) & 0xff;
        d[o + 2] = (get(w.bits) + w.min) & 0xff;
        d[o + 4] = d[E.mix + d[o + 3] - 1] ?? 0;
      } else {
        d[o + 1] = 0; d[o + 2] = 0x7f; d[o + 4] = 0;
      }
      d[o + 5] = 0xff;
    }
    return settleSE(d);
  }
  /** What the SE's recall does next (AT.settle): every parameter of an effect not in use takes its record's
   *  "unused" value, the others are limited to their ranges, bytes after the chain become 0. */
  function settleSE(d) {
    const list = paramList(cfgOf(d));
    for (const { t, i, offset } of list) {
      const P = TYPES[t].params[i];
      d[offset] = inUse(d, t) ? Math.max(P.min, Math.min(P.max, d[offset])) : P.unused;
    }
    for (let o = E.mix + list.length; o < E.title; o++) d[o] = 0;
    return d;
  }
  /** The packed form a stored preset keeps. */
  const pack = SE ? packSE : packA2;
  /** A packed preset expanded as recalling it does, over the defaults of its configuration. */
  const unpack = SE ? unpackSE : unpackA2;
  const packedLength = SE ? (p) => packSE(unpackSE(p)).length : packedLengthA2;

  // ---------------------------------------------------------------- ROM presets
  // Alpha 2: presets 1-115 are the factory presets in ROM until overwritten, 116-200 start empty.
  // SE: four ROM banks; a preset slot holds a packed preset in user RAM or a ROM reference {h, l}:
  // preset l of bank h - 1, or with h = 0 (OPEN) of the selected BANK; a preset past a bank's end is empty.
  const BANKS = SE ? FW.BANKS : [{ name: 'FACTORY', presets: FW.FACTORY, titles: FW.FACTORY_TITLES }];
  const DEF = hex(DEFAULTS);
  const DEFAULT_BANK = SE ? (DEF[0xc0da - 0xc0b1] ?? 0) : 0;
  const bankEdit = (b, n) => {
    const list = BANKS[b]?.presets || [];
    return n >= 0 && n < list.length ? unpack(hex(list[n])) : unpack(hex(FW.EMPTY));
  };
  const factoryEdit = (n) => bankEdit(DEFAULT_BANK, Math.max(0, Math.min(N_FACTORY - 1, n)));
  const emptyEdit = () => unpack(hex(FW.EMPTY));
  /** What a preset slot holds when it is in ROM: Alpha 2 factory preset n (empty from 116 on); SE a
   *  reference {h, l} resolved with the selected bank. */
  const romPreset = (n, ref = null, bank = DEFAULT_BANK) => {
    if (!SE) return n < N_FACTORY ? factoryEdit(n) : emptyEdit();
    const r = ref || { h: 0, l: n };
    return bankEdit(r.h ? r.h - 1 : bank, r.l);
  };
  /** The SLOT page text of a ROM reference (or user RAM). */
  const slotText = (ref) => {
    if (!ref) return FW.SLOT_PAGE?.ram?.[0] ?? 'USER RAM';
    if (!ref.h) return FW.SLOT_PAGE.open[0];
    const letter = ref.h <= 3 ? 'ABC'[ref.h - 1] : pad3(ref.h);
    return `BANK ${letter}, #${pad3(ref.l + 1)}`;
  };

  // ---------------------------------------------------------------- messages
  const msg = {
    hello: (ctx) => [...head(ctx), 0x41, 0xf7],
    getSetting: (s, ctx) => [...head(ctx), 0x43, s & 0x7f, 0xf7],
    setting: (s, v, ctx) => (s === 0x40 ? [...head(ctx), 0x03, 0x40, ...pair(v), 0xf7] : [...head(ctx), 0x03, s & 0x7f, v & 0x7f, 0xf7]),
    getEdit: (ctx) => [...head(ctx), 0x45, 0xf7],
    edit: (d, ctx) => [...head(ctx), 0x05, ...pairs(d.slice(0, SIZE)), 0xf7],
    recall: (n, ctx) => [...head(ctx), 0x09, ...pair(n), 0xf7],
    recallFactory: (n, ctx) => [...head(ctx), 0x09, n & 0x7f, 0x40 | ((n >> 7) & 1), 0xf7],
    store: (n, ctx) => [...head(ctx), 0x0a, ...pair(n), 0xf7],
    getStatus: (ctx) => [...head(ctx), 0x4d, 0xf7],
    getAllExpanded: (ctx) => [...head(ctx), 0x4f, 0xf7],
    /** All presets in the Alpha 2 form (0B: packed, 02 n n = in ROM); the SE converts them as it takes them. */
    allA2: (list, ctx) => [...head(ctx), 0x0b, ...list.flatMap((p, n) => (p ? [p.length, ...pairs(p)] : [0x02, ...pair(n)])), 0xf7],
    map128: (m, ctx) => [...head(ctx), 0x0c, ...pairs(Array.from(m).slice(0, 128)), 0xf7],
  };
  if (SE) {
    Object.assign(msg, {
      getMapEntry: (c, ctx) => [...head(ctx), 0x51, c & 0x7f, 0xf7],
      mapEntry: (c, n, ctx) => [...head(ctx), 0x11, ...pair(c), ...pair(n), 0xf7],
      getAll: (ctx) => [...head(ctx), 0x52, 0xf7],
      /** 12: per slot {packed} (length, pairs) or {rom: {h, l}} (02, l, h as pairs). */
      all: (list, ctx) => [...head(ctx), 0x12, ...list.flatMap((e) => (e.packed ? [e.packed.length, ...pairs(e.packed)] : [0x02, ...pair(e.rom.l), ...pair(e.rom.h)])), 0xf7],
      getMap: (ctx) => [...head(ctx), 0x53, 0xf7],
      map: (m, ctx) => [...head(ctx), 0x13, ...pairs(Array.from(m).slice(0, N_MAP)), 0xf7],
    });
  } else {
    Object.assign(msg, {
      getPreset: (n, ctx) => [...head(ctx), 0x46, ...pair(n), 0xf7],
      preset: (n, packed, ctx) => [...head(ctx), 0x06, ...pair(n), packed.length, ...pairs(packed), 0xf7],
      presetRom: (n, ctx) => [...head(ctx), 0x06, ...pair(n), 0x02, ...pair(n), 0xf7],
      getMapEntry: (c, ctx) => [...head(ctx), 0x48, c & 0x7f, 0xf7],
      mapEntry: (c, n, ctx) => [...head(ctx), 0x08, c & 0x7f, ...pair(n), 0xf7],
      getAll: (ctx) => [...head(ctx), 0x4b, 0xf7],
      all: (list, ctx) => msg.allA2(list, ctx),
      getMap: (ctx) => [...head(ctx), 0x4c, 0xf7],
      map: (m, ctx) => msg.map128(m, ctx),
    });
  }
  const ALL_ID = SE ? 0x12 : 0x0b;
  const MAP_ID = SE ? 0x13 : 0x0c;
  /** The 200 entries of an all-presets message: {packed} | {data} | {rom: true} (0B, 0F) | {rom: {h, l}} (12).
   *  0B received by the SE: an entry 02 n n becomes OPEN with the slot's own number. */
  function presetsFrom(raw) {
    const out = [];
    let at = 5;
    const k = id(raw);
    while (out.length < N_PRESETS && at < raw.length - 1) {
      const n = raw[at++];
      if (n === 2) {
        if (k === 0x12) { out.push({ rom: { l: num(raw, at), h: num(raw, at + 2) } }); at += 4; } else { out.push({ rom: SE ? { h: 0, l: out.length } : true }); at += 2; }
        continue;
      }
      if (n < 2) break;
      const b = unpair(raw, at, n);
      at += 2 * n;
      if (k === 0x0f) out.push({ data: b });
      else if (k === 0x0b && SE) out.push({ data: unpackA2(b) }); // the SE converts (6CEE)
      else out.push({ packed: b });
    }
    return out;
  }
  /** A single preset message (Alpha 2 06): {n, packed} or {n, rom: true}. */
  function presetFrom(raw) {
    const n = num(raw, 5);
    if (raw[7] === 2) return { n, rom: true };
    return { n, packed: unpair(raw, 8, raw[7]) };
  }
  const entryEdit = (n, e, bank = DEFAULT_BANK) => (e.rom ? romPreset(n, e.rom === true ? null : e.rom, bank) : e.data ? Uint8Array.from(e.data) : unpack(e.packed));
  /** The messages that write an edit buffer as preset n. Alpha 2: the packed preset (06), or "in ROM" for
   *  an empty one from 116 on. SE (no single-preset message): the edit buffer (05), then STORE (0A). */
  function storeMessage(n, data, ctx) {
    const d = prepare(data);
    if (SE) return [msg.edit(d, ctx), msg.store(n, ctx)];
    return n >= N_FACTORY && isEmptyPreset(d) ? msg.presetRom(n, ctx) : msg.preset(n, pack(d), ctx);
  }

  // ---------------------------------------------------------------- settings (03 s v) and program table
  // One byte per setting number s (00-3F) as 43 s reads it, then the preset shown (03 40), the software
  // version (03 41), the store status (0D) and the program table entries.
  const S = { bypass: 0x00, remote1: 0x01, lcdAngle: 0x02, lock: 0x03, same: 0x04, remote2: 0x05, bypassLevel: 0x06, autoPm: 0x07, channel: 0x20, omni: 0x21, mptPage: 0x22, pm: 0x24, prog: 0x25, fxEnable: 0x26, ctrl: 0x30 };
  if (SE) S.bank = 0x09;
  const SYS = { current: 0x40, version: 0x41, status: 0x43, map: 0x50, size: 0x50 + N_MAP };
  const SAME_AT = Number.parseInt(AT.sameRam, 16);
  const ADDR = { 0x00: 0xc0ba, 0x01: 0xc0b7, 0x02: 0xc0bc, 0x03: 0xc0b3, 0x04: SAME_AT, 0x05: 0xc0b8, 0x06: 0xc0b9, 0x07: 0xc0c2, 0x20: 0xc0b4, 0x21: 0xc0b5, 0x22: 0xc0b6, 0x24: 0xc0be, 0x25: 0xc0bd, 0x26: 0xc0c3 };
  if (SE) ADDR[0x09] = 0xc0da;
  for (let k = 0; k < 11; k++) ADDR[S.ctrl + k] = 0xc0c4 + k;
  const SETTINGS = Object.keys(ADDR).map(Number).sort((a, b) => a - b);
  function initSystem() {
    const s = new Uint8Array(SYS.size);
    for (const k of SETTINGS) s[k] = ADDR[k] === SAME_AT ? 1 : (DEF[ADDR[k] - 0xc0b1] ?? 0);
    s[SYS.current] = 0;
    const v = FW.FIRMWARE.match(/v(\d+)\.(\d+)/);
    s[SYS.version] = SE ? Number(v[2]) : 2; s[SYS.version + 1] = 2; // the version word at 001F
    s[SYS.status] = DEF[0xc0c0 - 0xc0b1];
    for (let c = 0; c < N_MAP; c++) s[SYS.map + c] = c; // program c recalls preset c + 1
    return s;
  }
  /** Apply a 03 / 0C / 0D (/ 11 / 13 on the SE, 08 on the Alpha 2) message to settings s; true when it was one. */
  function applySystem(s, raw) {
    if (!isAlpha(raw)) return false;
    const k = id(raw);
    if (k === 0x03) {
      const sub = raw[5];
      if (sub === 0x40) s[SYS.current] = num(raw, 6);
      else if (sub === 0x41) { s[SYS.version] = raw[6]; s[SYS.version + 1] = raw[7]; } else if (sub < 0x40) s[sub] = raw[6];
      return true;
    }
    if (k === 0x0c) { s.set(unpair(raw, 5, 128), SYS.map); return true; }
    if (k === 0x13 && SE) { s.set(unpair(raw, 5, N_MAP), SYS.map); return true; }
    if (k === 0x11 && SE) { const c = num(raw, 5); if (c < N_MAP) s[SYS.map + c] = num(raw, 7); return true; }
    if (k === 0x08 && !SE) { s[SYS.map + (raw[5] & 0x7f)] = num(raw, 6); return true; }
    if (k === 0x0d) { s[SYS.status] = num(raw, 5); return true; }
    return false;
  }
  function systemMessages(s, ctx) {
    const out = SETTINGS.filter((k) => k !== S.same).map((k) => msg.setting(k, s[k], ctx));
    out.push(msg.map(s.slice(SYS.map, SYS.map + N_MAP), ctx));
    return out;
  }

  // ---------------------------------------------------------------- parameters: preset
  const sendEdit = (_v, ctx, data) => msg.edit(prepare(data), ctx);
  const optionsOf = (t, i, d = null) => textsOf(t, i, d).map((s, k) => [TYPES[t].params[i].min + k, s]);
  const opt = (texts) => texts.map((s, v) => [v, s]);
  const bit = (d, o, k) => (d[o] >> k) & 1;
  const setBit = (d, o, k, v) => { d[o] = v ? d[o] | (1 << k) : d[o] & ~(1 << k); };
  const switchBit = (t) => SWITCH_OF_BIT.indexOf(switchOf(t));

  /** ADD EFFECT: the effect's parameters at their defaults and its X-15 switch on. */
  function addEffect(d, t) {
    const cfg = cfgOf(d);
    TYPES[t].params.forEach((p, i) => {
      const o = t === T.eq ? E.eq + i : t === T.aes ? E.aes : fxOffset(cfg, t, i);
      if (o >= 0) d[o] = p.def;
    });
    const b = switchBit(t);
    if (b >= 0) setBit(d, E.status, b, 1);
  }
  /** DELETE EFFECT: assignments controlling one of its parameters go too. */
  function dropAssignments(d, t) {
    const list = paramList(cfgOf(d));
    for (let k = 0; k < 8; k++) {
      const o = E.pm + 6 * k;
      const p = list[d[o + 3] - 1];
      if (bit(d, E.pmUsed, k) && p && p.t === t) { setBit(d, E.pmUsed, k, 0); d.set(PM_TEMPLATE, o); }
    }
  }
  function setInUse(d, t, on) {
    if (inUse(d, t) === !!on) return;
    if (t === T.eq) setBit(d, E.blocks, 0, on);
    else if (t === T.aes) setBit(d, E.blocks, 1, on);
    else setBit(d, E.present, CONFIGS[cfgOf(d)].indexOf(t), on);
    if (on) addEffect(d, t); else dropAssignments(d, t);
  }
  /** Change the configuration: each effect keeps its values and use; effects new to the chain are added
   *  (defaults, X-15 switch on); assignments follow their parameter or go with it. */
  function setConfig(d, cfg) {
    const old = cfgOf(d);
    if (cfg === old) return;
    const before = Uint8Array.from(d);
    const oldList = paramList(old);
    d[E.config] = cfg;
    let present = 0;
    CONFIGS[cfg].forEach((t, k) => {
      const was = CONFIGS[old].indexOf(t);
      if (was >= 0) {
        for (let i = 0; i < sizeOf(t); i++) d[fxOffset(cfg, t, i)] = before[fxOffset(old, t, i)];
        if ((before[E.present] >> was) & 1) present |= 1 << k;
      } else {
        present |= 1 << k;
        d[E.present] = present;
        addEffect(d, t);
      }
    });
    d[E.present] = present;
    const list = paramList(cfg);
    for (let k = 0; k < 8; k++) {
      const o = E.pm + 6 * k;
      if (!bit(d, E.pmUsed, k)) continue;
      const p = oldList[before[o + 3] - 1];
      const q = p && list.find((x) => x.t === p.t && x.i === p.i);
      if (q) d[o + 3] = q.n;
      else { setBit(d, E.pmUsed, k, 0); d.set(PM_TEMPLATE, o); }
    }
  }

  const hiddenUnless = (f) => (d) => (f(d) ? {} : { hidden: true });
  const effectGroup = (t) => (t === T.aes ? 'A.E.S.' : t === T.eq ? 'EQUALIZER' : TYPES[t].name);
  function effectParams(t) {
    return TYPES[t].params.map((P, i) => {
      const lab = labelOf(t, i);
      const help = `${TYPES[t].abbr.trim()}:${lab}${lab !== P.name ? ` (also called ${P.name})` : ''}; ${valueText(t, i, P.min)} to ${valueText(t, i, P.max)}, default ${valueText(t, i, P.def)}`
        + (P.off !== 0x80 ? `; ${valueText(t, i, P.off) || P.off} while X-15 switch ${X15[P.x15]} is off` : '')
        + (P.name === 'STATE' ? '. The stored value is always 0: the display shows the sampler\'s running state (REC-RDY, RECRDNG, IDLE, PLAY)' : '')
        + (varies(t, i) && TEXTS[t][i][0].when ? `. The notes follow ${labelOf(t, TEXTS[t][i][0].when[0])} (${textsOf(t, TEXTS[t][i][0].when[0]).join(', ')}); AUTO shows the note it picks` : '');
      const dynamic = varies(t, i)
        ? (d) => (inUse(d, t) ? { options: optionsOf(t, i, d) } : { hidden: true })
        : hiddenUnless((d) => inUse(d, t));
      const base = { key: `t${t}p${i}`, group: effectGroup(t), label: lab, options: optionsOf(t, i), send: sendEdit, sendKey: 'edit', help, dynamic };
      if (t === T.mix) return { ...base, offset: E.mix + i, dynamic: undefined };
      if (t === T.eq) return { ...base, offset: E.eq + i };
      if (t === T.aes) return { ...base, offset: E.aes };
      if (t === T.lpf) return { ...base, offset: E.fx };
      return {
        ...base, offset: E.fx, size: FX_SIZE, min: P.min, max: P.max,
        get: (d) => { const o = fxOffset(cfgOf(d), t, i); return o < 0 ? P.def : d[o]; },
        set: (d, v) => { const o = fxOffset(cfgOf(d), t, i); if (o >= 0) d[o] = Math.max(P.min, Math.min(P.max, v)); },
      };
    });
  }

  const PM_PARAM_NONE = 'MIDI DataMONITOR (no parameter)';
  function pmParams(k) {
    const o = E.pm + 6 * k;
    const g = `PERFORMANCE MIDI #${k + 1}`;
    const used = (d) => bit(d, E.pmUsed, k);
    const target = (d) => paramList(cfgOf(d))[d[o + 3] - 1];
    const rangeOpts = (d) => { const p = target(d); return p ? { options: optionsOf(p.t, p.i, d) } : { options: [[0, '0']] }; };
    return [
      { key: `pm${k}`, group: g, label: 'In use', offset: E.pmUsed, bits: 1, shift: k, options: [[0, 'No'], [1, 'Yes']], send: sendEdit, sendKey: 'edit', relayout: true,
        help: 'ADD EFFECT in the PM pages adds an assignment (MC 4, the first parameter in use, its full range); DELETE removes it',
        set: (d, v) => {
          if (!!v === !!used(d)) return;
          setBit(d, E.pmUsed, k, v);
          if (!v) { d.set(PM_TEMPLATE, o); return; }
          const p = paramList(cfgOf(d)).find((x) => inUse(d, x.t));
          const P = TYPES[p.t].params[p.i];
          d.set([4, P.min, P.max, p.n, d[p.offset], 0xff], o);
        } },
      { key: `pm${k}p`, group: g, label: PM_TITLES.param.replace(/^#\d /, ''), offset: o + 3, min: 0, max: 29, relayout: true, send: sendEdit, sendKey: 'edit',
        help: 'Screen 1: the parameter the controller moves (only parameters in use can be chosen); choosing one sets LOW / HIGH to its range',
        dynamic: (d) => (used(d) ? { options: [[0, PM_PARAM_NONE], ...paramList(cfgOf(d)).filter((p) => inUse(d, p.t) || p.n === d[o + 3]).map((p) => [p.n, `${p.n}: ${paramName(p.t, p.i)}`])] } : { hidden: true }),
        set: (d, v) => {
          d[o + 3] = v;
          const p = paramList(cfgOf(d))[v - 1];
          if (p) { const P = TYPES[p.t].params[p.i]; d[o + 1] = P.min; d[o + 2] = P.max; d[o + 4] = d[p.offset]; }
          d[o + 5] = 0xff;
        } },
      { key: `pm${k}c`, group: g, label: PM_TITLES.controller.replace(/^#\d /, ''), offset: o, options: opt(CTRL), send: sendEdit, sendKey: 'edit',
        help: 'Screen 2: MC 0-120 = MIDI controller numbers on the MIDI channel; 121-127 note, pressure and pitch bend sources; 128 OFF', dynamic: hiddenUnless(used) },
      { key: `pm${k}l`, group: g, label: PM_TITLES.low.replace(/^#\d /, '').replace(/:$/, ''), offset: o + 1, min: 0, max: 127, send: sendEdit, sendKey: 'edit',
        help: 'Screen 3: the parameter value at controller value 0 (LOW above HIGH turns the direction round)', dynamic: (d) => (used(d) ? rangeOpts(d) : { hidden: true }) },
      { key: `pm${k}h`, group: g, label: PM_TITLES.high.replace(/^#\d /, '').replace(/:$/, ''), offset: o + 2, min: 0, max: 127, send: sendEdit, sendKey: 'edit',
        help: 'Screen 4: the parameter value at controller value 127', dynamic: (d) => (used(d) ? rangeOpts(d) : { hidden: true }) },
    ];
  }
  const runtimeParams = Array.from({ length: 8 }, (_, k) => [
    { key: `pm${k}v`, group: 'PERFORMANCE MIDI runtime', label: `#${k + 1} recalled value`, offset: E.pm + 6 * k + 4, min: 0, max: 255, input: 'number', readOnly: true,
      help: 'The controlled parameter\'s value when the preset was recalled; STORE writes it back. The editor sets it to the parameter\'s value whenever it sends' },
    { key: `pm${k}x`, group: 'PERFORMANCE MIDI runtime', label: `#${k + 1} pending controller value`, offset: E.pm + 6 * k + 5, min: 0, max: 255, input: 'number', readOnly: true,
      help: 'A controller value received and not yet applied; 255 (FFh) = none' },
  ]).flat();

  const presetParams = [
    { key: 'config', group: 'Chain', label: 'Configuration', offset: E.config, options: CONFIG_NAMES.map((s, c) => [c, `${c}: ${s}`]).filter(([c]) => CONFIG_OK[c]), relayout: true, send: sendEdit, sendKey: 'edit',
      help: 'The chain the effects can be in (0-53). The unit chooses it when ADD EFFECT asks for a combination; effects keep their values when it changes here, and new ones are added',
      set: (d, v) => setConfig(d, v) },
    { key: 'useEq', group: 'Chain', label: 'EQUALIZER in the preset', offset: E.blocks, bits: 1, shift: 0, options: [[0, 'No'], [1, 'Yes']], relayout: true, send: sendEdit, sendKey: 'edit',
      help: 'ADD / DELETE EFFECT EQUALIZER: the 7-band EQ before the digital effects', set: (d, v) => setInUse(d, T.eq, v) },
    { key: 'useAes', group: 'Chain', label: 'ACU ENV SIM in the preset', offset: E.blocks, bits: 1, shift: 1, options: [[0, 'No'], [1, 'Yes']], relayout: true, send: sendEdit, sendKey: 'edit',
      help: 'The Acoustic Environment Simulator (A.E.S.)', set: (d, v) => setInUse(d, T.aes, v) },
    ...[0, 1, 2, 3, 4].map((k) => ({
      key: `use${k}`, group: 'Chain', label: `Effect ${k + 1} in the preset`, offset: E.present, bits: 1, shift: k, options: [[0, 'No'], [1, 'Yes']], relayout: true, send: sendEdit, sendKey: 'edit',
      help: `Whether the configuration's effect ${k + 1} is in use (DELETE EFFECT clears it and removes the assignments on its parameters)`,
      dynamic: (d) => { const t = CONFIGS[cfgOf(d)][k]; return t === undefined ? { hidden: true } : { label: `${TYPES[t].name} in the preset` }; },
      set: (d, v) => { const t = CONFIGS[cfgOf(d)][k]; if (t !== undefined) setInUse(d, t, v); },
    })),
    ...SWITCH_OF_BIT.map((sw, k) => ({
      key: `x15_${sw}`, group: 'X-15 FX ON/OFF', label: X15[sw], offset: E.status, bits: 1, shift: k, options: [[0, FX_STATUS[0]], [1, FX_STATUS[1]]], send: sendEdit, sendKey: 'edit',
      help: `Switch ${X15[sw]} as the preset recalls it ('ENTER' to EDIT ON/OFF CONTROLRS, then STORE); while off, the effects on it take their "off" values. The FX ON/OFF controller set for it on the Settings page changes it live (64 and up: on, below: off)`,
    })),
    ...[T.mix, T.eq, T.aes, ...TYPES.map((_, t) => t).filter((t) => t < T.mix)].flatMap(effectParams),
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(pmParams),
    ...runtimeParams,
    ...Array.from({ length: TITLE_LEN }, (_, i) => ({ key: `title${i}`, group: 'Chain', label: `Title ${i + 1}`, offset: E.title + i, min: 0x20, max: 0x7e, kind: 'char', hidden: true })),
  ];
  // card order: the chain as the configurations run (LOW-PASS, delays, reverbs, pitch, modulation, pan)
  const ORDER = [0, 13, 14, 15, 16, 17, 18, 7, 8, 9, 10, 11, 12, 3, 24, 1, 2, 23, 4, 5, 6, 19, 20, 21, 22];

  // ---------------------------------------------------------------- parameters: settings
  const ctrlOptions = opt(CTRL).slice(0, 121);
  const systemParams = [
    { key: 'bypass', section: 'settings', group: 'BYPASS', label: 'BYPASS', offset: S.bypass, options: [[0, 'ACTIVE'], [1, 'BYPASS']], help: 'The BYPASS button (Set Bypass OFF / ON in the manual); the LED flashes while bypassed' },
    ...(SE ? [{ key: 'bank', section: 'settings', group: 'UTILITY', label: FW.BANK_UTIL.title, offset: S.bank, options: opt(FW.BANK_UTIL.values),
      help: `The built-in bank whose presets the OPEN preset slots and HIT RECALL FOR A.R.T. PRESET use (factory value ${FW.BANK_UTIL.values[DEFAULT_BANK]}; a reset on software 1.04 sets B "STUDIO")` }] : []),
    { key: 'bypassLevel', section: 'settings', group: 'UTILITY', label: UTIL.bypassLevel.title, offset: S.bypassLevel, options: opt(UTIL.bypassLevel.values), help: 'The dry level while bypassed; MIX DRY LEVEL uses the preset\'s DRY' },
    { key: 'remote1', section: 'settings', group: 'UTILITY', label: UTIL.remote1.title, offset: S.remote1, options: opt(UTIL.remote1.values), help: 'The REMOTE 1 jack; INCR PROGS n steps through n presets (REMOTE 2 = DECR PROGS steps back)' },
    { key: 'remote2', section: 'settings', group: 'UTILITY', label: UTIL.remote2.title, offset: S.remote2, options: opt(UTIL.remote2.values), help: 'The REMOTE 2 jack (DECR PROGS needs REMOTE 1 on INCR PROGS)' },
    { key: 'autoPm', section: 'settings', group: 'UTILITY', label: UTIL.autoPm.title, offset: S.autoPm, options: opt(UTIL.autoPm.values), help: 'When the display shows Performance MIDI and FX ON/OFF changes' },
    { key: 'lcdAngle', section: 'settings', group: 'UTILITY', label: UTIL.lcdAngle.title, offset: S.lcdAngle, options: opt(UTIL.lcdAngle.values), help: 'The display contrast' },
    { key: 'lock', section: 'settings', group: 'UTILITY', label: UTIL.lock.title, offset: S.lock, options: opt(UTIL.lock.values), help: `Whether STORE on the panel may write presets 1-${N_FACTORY} (storing over MIDI writes them anyway)` },
    { key: 'channel', section: 'settings', group: 'MIDI', label: UTIL.channel.title, offset: S.channel, options: opt(UTIL.channel.values), help: 'Send and receive channel; SysEx is received only on it (set the editor\'s channel to match after changing it); OFF ignores all MIDI but MIDI THRU' },
    { key: 'omni', section: 'settings', group: 'MIDI', label: UTIL.omni.title, offset: S.omni, options: opt(UTIL.omni.values), help: 'Program changes on any channel (CC 124 / 125 on the channel set it too); not for SysEx' },
    { key: 'pm', section: 'settings', group: 'MIDI', label: 'MIDI ENABLE PM', offset: S.pm, options: opt(UTIL.pm.values), help: 'Performance MIDI: the presets\' controller assignments' },
    { key: 'prog', section: 'settings', group: 'MIDI', label: 'MIDI ENABLE PROG', offset: S.prog, options: opt(UTIL.prog.values), help: `Program changes recall the preset the MIDI program table gives${SE ? '; after an odd CC 32 (bank select LSB) value they reach table entries 128-199' : ''}` },
    { key: 'fxEnable', section: 'settings', group: 'MIDI', label: 'FX ON/OFF ENABLE (USING X-15)', offset: S.fxEnable, options: opt(UTIL.fxEnable.values), help: 'The FX ON/OFF controllers below turn the X-15 switches on (64-127) and off (0-63)' },
    { key: 'mptPage', section: 'settings', group: 'MIDI', label: 'MIDI PROG (program table page)', offset: S.mptPage, min: 0, max: N_MAP - 1, input: 'number', help: 'The program number the MIDI PROG= / PRESET= page shows' },
    ...X15.map((name, k) => ({ key: `ctrl${k}`, section: 'settings', group: 'FX ON/OFF CONTROLLERS', label: name, offset: S.ctrl + k, options: ctrlOptions,
      help: `The controller that turns switch ${name} on / off (MIDI page 'ENTER' to EDIT ON/OFF CONTROLRS; 0-120)` })),
    { key: 'same', section: 'settings', group: 'Status', label: 'Edit buffer as stored', offset: S.same, options: [[0, 'No (edited)'], [1, 'Yes']], readOnly: true, help: 'Yes while the edit buffer matches the current preset as stored; the display shows a "not equal" sign when it does not' },
    { key: 'current', section: 'settings', group: 'Status', label: 'Preset shown', offset: SYS.current, min: 0, max: 199, readOnly: true, format: (v) => String(v + 1), help: 'The preset number the unit shows' },
    { key: 'stored', section: 'settings', group: 'Status', label: 'Last store fitted', offset: SYS.status, bits: 1, options: [[0, 'No (memory full)'], [1, 'Yes']], readOnly: true, help: 'Cleared when a preset did not fit in the preset memory' },
    { key: 'version', section: 'settings', group: 'Status', label: 'Software version', offset: SYS.version, size: 2, readOnly: true, get: (d) => (d[SYS.version + 1] << 8) | d[SYS.version], format: (v) => `v${v >> 8}.${String(v & 0xff).padStart(2, '0')}`,
      help: `The software version the unit reports (its UTILITY page shows "${UTIL.version.trim()}")${SE ? '; the SE 1.03 / 1.04 report 2.03 / 2.04' : ''}` },
    ...Array.from({ length: N_MAP }, (_, c) => ({
      key: `map${c}`, section: 'map', group: 'MIDI PROGRAM TABLE', label: `MIDI PROG=${pad3(c)}`, offset: SYS.map + c, min: 0, max: 199, options: Array.from({ length: 200 }, (_, n) => [n, `PRESET=${pad3(n + 1)}`]),
      help: SE ? `The preset program change ${c & 0x7f}${c >= 128 ? ' recalls after an odd CC 32 value' : ' recalls'}` : `The preset program change ${c} recalls`,
      send: (v, ctx) => msg.mapEntry(c, v, ctx), sendKey: `map${c}`,
    })),
  ].map((p) => (p.send || p.readOnly || p.section === 'map' ? p : { ...p, send: (v, ctx) => msg.setting(p.offset, v, ctx), sendKey: `set${p.offset}` }));

  async function readSystem(api) {
    const s = initSystem();
    for (const k of [...SETTINGS, 0x40, 0x41]) {
      const r = await api.request(msg.getSetting(k, api.ctx), (x) => isAlpha(x) && id(x) === 0x03 && x[5] === k, (x) => x);
      applySystem(s, r);
    }
    applySystem(s, await api.request(msg.getStatus(api.ctx), (x) => isAlpha(x) && id(x) === 0x0d, (x) => x));
    applySystem(s, await api.request(msg.getMap(api.ctx), (x) => isAlpha(x) && id(x) === MAP_ID, (x) => x));
    return s;
  }

  // ---------------------------------------------------------------- simulator
  /** SE STORE (70A6): an empty edit buffer leaves the slot empty (OPEN, preset FFh); one equal to a ROM
   *  preset becomes a reference to it (banks in order, each from its last preset, 713C); else user RAM. */
  function storeEntrySE(d) {
    if (isEmptyPreset(d)) return { rom: { h: 0, l: 0xff } };
    const pk = pack(prepare(d));
    const h = Array.from(pk, (b) => b.toString(16).padStart(2, '0')).join('');
    for (let b = 0; b < BANKS.length; b++) {
      const k = BANKS[b].presets.lastIndexOf(h);
      if (k >= 0) return { rom: { h: b + 1, l: k } };
    }
    return { packed: pk };
  }
  function simulate() {
    const st = { channel: 0, edit: factoryEdit(0), presets: Array(N_PRESETS).fill(null), sys: initSystem(), recalled: [] };
    st.sys[S.channel] = 1;
    if (SE) for (let n = 0; n < N_PRESETS; n++) st.presets[n] = { rom: { h: 0, l: n } };
    const ctx = () => ({ channel: st.channel });
    const bank = () => st.sys[S.bank] ?? 0;
    const presetOf = (n) => (SE ? entryEdit(n, st.presets[n], bank()) : st.presets[n] ? unpack(st.presets[n]) : romPreset(n));
    return {
      state: st,
      handle(d) {
        if (!isAlpha(d)) return null;
        if (st.sys[S.channel] === 0 || d[2] !== st.sys[S.channel] - 1) return [];
        const k = id(d);
        st.channel = d[2];
        switch (k) {
          case 0x41: return [[...head(ctx()), 0x01, 0xf7]];
          case 0x43: {
            const s = d[5];
            if (s === 0x40) return [msg.setting(0x40, st.sys[SYS.current], ctx())];
            if (s === 0x41) return [[...head(ctx()), 0x03, 0x41, st.sys[SYS.version], st.sys[SYS.version + 1], 0xf7]];
            return SETTINGS.includes(s) ? [[...head(ctx()), 0x03, s, st.sys[s] & 0x7f, 0xf7]] : [];
          }
          case 0x45: return [msg.edit(st.edit, ctx())];
          case 0x46: if (SE) return []; { const n = num(d, 5); return n < N_PRESETS ? [st.presets[n] ? msg.preset(n, st.presets[n], ctx()) : msg.presetRom(n, ctx())] : []; }
          case 0x48: return SE ? [] : [msg.mapEntry(d[5], st.sys[SYS.map + d[5]], ctx())];
          case 0x51: return SE && d[5] < N_MAP ? [msg.mapEntry(d[5], st.sys[SYS.map + d[5]], ctx())] : [];
          case 0x4b: return SE ? [] : [msg.all(st.presets, ctx())];
          case 0x52: return SE ? [msg.all(st.presets, ctx())] : [];
          case 0x4c: return SE ? [] : [msg.map(st.sys.slice(SYS.map, SYS.map + N_MAP), ctx())];
          case 0x53: return SE ? [msg.map(st.sys.slice(SYS.map, SYS.map + N_MAP), ctx())] : [];
          case 0x4d: return [[...head(ctx()), 0x0d, ...pair(st.sys[SYS.status]), 0xf7]];
          case 0x4f: return [[...head(ctx()), 0x0f, ...st.presets.flatMap((p, n) => (SE ? (p.packed ? [0x62, ...pairs(unpack(p.packed))] : [0x02, ...pair(n)]) : (p ? [0x62, ...pairs(unpack(p))] : [0x02, ...pair(n)]))), 0xf7]];
          case 0x03: applySystem(st.sys, d); return [];
          case 0x05: st.edit = unpair(d, 5, SIZE); return [];
          case 0x06: {
            if (SE) return [];
            const e = presetFrom(d);
            if (e.n >= N_PRESETS) return [];
            st.presets[e.n] = e.rom ? null : e.packed;
            return [];
          }
          case 0x08: if (!SE && num(d, 6) < N_PRESETS) st.sys[SYS.map + d[5]] = num(d, 6); return [];
          case 0x11: if (SE && num(d, 7) < N_PRESETS && num(d, 5) < N_MAP) st.sys[SYS.map + num(d, 5)] = num(d, 7); return [];
          case 0x09: {
            const n = num(d, 5);
            if (d[6] & 0x40) { if (n < N_FACTORY) st.edit = SE ? bankEdit(bank(), n) : factoryEdit(n); } else if (n < N_PRESETS) { st.sys[SYS.current] = n; st.edit = presetOf(n); st.recalled.push(n); }
            return [];
          }
          case 0x0a: {
            const n = num(d, 5);
            if (n >= N_PRESETS) return [];
            st.sys[SYS.current] = n;
            if (SE) st.presets[n] = storeEntrySE(st.edit);
            else st.presets[n] = isEmptyPreset(st.edit) ? null : pack(prepare(st.edit));
            return [];
          }
          case 0x0b: presetsFrom(d).forEach((e, n) => { st.presets[n] = SE ? (e.rom ? e : { packed: pack(e.data) }) : e.rom ? null : e.packed; }); return [];
          case 0x12: if (SE) presetsFrom(d).forEach((e, n) => { st.presets[n] = e; }); return [];
          case 0x0c: case 0x13: applySystem(st.sys, d); return [];
          default: return [];
        }
      },
    };
  }

  // ---------------------------------------------------------------- monitor text, library
  const NAMES = { 0x01: 'acknowledge', 0x03: 'setting', 0x05: 'edit buffer', 0x09: 'recall preset', 0x0a: 'store edit buffer', 0x0b: 'all presets', 0x0c: 'MIDI program table', 0x0d: 'store status', 0x0f: 'all presets (expanded)' };
  if (SE) Object.assign(NAMES, { 0x0b: 'all presets (Alpha 2 form)', 0x0c: 'MIDI program table 0-127', 0x10: 'preset', 0x11: 'program table entry', 0x12: 'all presets', 0x13: 'MIDI program table' });
  else Object.assign(NAMES, { 0x06: 'preset', 0x08: 'program table entry' });
  const SETTING_NAMES = { 0x00: 'BYPASS', 0x01: 'REMOTE SWITCH 1', 0x02: 'LCD VIEW ANGLE', 0x03: `PRESET 1..${N_FACTORY} lock`, 0x04: 'edit buffer as stored', 0x05: 'REMOTE SWITCH 2', 0x06: 'BYPASS LEVEL', 0x07: 'AUTO PM DISPLAY', 0x20: 'MIDI CHANNEL', 0x21: 'OMNI MODE', 0x22: 'MIDI PROG page', 0x24: 'MIDI ENABLE PM', 0x25: 'MIDI ENABLE PROG', 0x26: 'FX ON/OFF ENABLE', 0x40: 'preset shown', 0x41: 'software version' };
  if (SE) SETTING_NAMES[0x09] = 'BANK';
  X15.forEach((n, k) => { SETTING_NAMES[S.ctrl + k] = `FX ON/OFF controller ${n}`; });
  function describe(raw) {
    if (!isAlpha(raw)) return null;
    const k = id(raw);
    const who = `${WHO} (ch ${raw[2] + 1})`;
    if (k >= 0x40) {
      const what = NAMES[k & 0x3f] || `message ${(k & 0x3f).toString(16)}`;
      if (k === 0x43) return `${who} request ${SETTING_NAMES[raw[5]] || `setting ${raw[5].toString(16)}`}`;
      if (k === 0x46 && !SE) return `${who} request preset ${num(raw, 5) + 1}`;
      if ((k === 0x48 && !SE) || (k === 0x51 && SE)) return `${who} request program table entry ${raw[5]}`;
      if (k === 0x41) return `${who} hello (answer 01)`;
      return `${who} request ${what}`;
    }
    if (k === 0x03) return `${who} ${SETTING_NAMES[raw[5]] || `setting ${raw[5].toString(16)}`} = ${raw[5] >= 0x40 ? `${raw[6]} ${raw[7]}` : raw[6]}`;
    if (k === 0x05) return `${who} edit buffer "${nameOf(unpair(raw, 5, SIZE))}"`;
    if (k === 0x06 && !SE) { const e = presetFrom(raw); return `${who} preset ${e.n + 1}${e.rom ? (e.n < N_FACTORY ? ' = factory preset' : ' = empty') : ` "${nameOf(unpack(e.packed))}"`}`; }
    if (k === 0x08 && !SE) return `${who} MIDI program ${raw[5]} -> preset ${num(raw, 6) + 1}`;
    if (k === 0x11 && SE) return `${who} MIDI program ${num(raw, 5)} -> preset ${num(raw, 7) + 1}`;
    if (k === 0x09) return raw[6] & 0x40 ? `${who} recall factory preset ${num(raw, 5) + 1} into the edit buffer` : `${who} recall preset ${num(raw, 5) + 1}`;
    if (k === 0x0a) return `${who} store the edit buffer as preset ${num(raw, 5) + 1}`;
    return `${who} ${NAMES[k] || `message ${k.toString(16)}`}`;
  }

  /** The message(s) that put a preset back into slot n. */
  const slotMessages = (n, e, d, ctx) => {
    if (SE) return [msg.edit(prepare(d), ctx), msg.store(n, ctx)];
    return [e.rom ? msg.presetRom(n, ctx) : msg.preset(n, e.packed || pack(prepare(d)), ctx)];
  };
  function libraryItems(msgs) {
    const items = [];
    let sys = null;
    const sysMsgs = [];
    // the SE's OPEN slots follow its BANK setting: take it from the same dump when there
    let bank = DEFAULT_BANK;
    if (SE) for (const m of msgs) if (isAlpha(m) && id(m) === 0x03 && m[5] === S.bank) bank = Math.min(3, m[6]);
    const addPreset = (n, d, ms) => items.push({ key: `p${n}`, label: `Preset ${n + 1}`, name: nameOf(d), object: 'effect', data: d, msgs: ms });
    for (const m of msgs) {
      if (!isAlpha(m)) { items.push({ key: `x${items.length}`, label: 'Other message', name: '', object: null, msgs: [m] }); continue; }
      const k = id(m);
      const ctx = chanCtx(m);
      if (k === 0x0b || k === 0x0f || (k === 0x12 && SE)) {
        presetsFrom(m).forEach((e, n) => {
          const d = entryEdit(n, e, bank);
          addPreset(n, d, slotMessages(n, e, d, ctx));
        });
      } else if (k === 0x06 && !SE) {
        const e = presetFrom(m);
        addPreset(e.n, entryEdit(e.n, e), [m]);
      } else if (k === 0x05) {
        const d = unpair(m, 5, SIZE);
        items.push({ key: `e${items.length}`, label: 'Edit buffer', name: nameOf(d), object: 'effect', data: d, msgs: [m] });
      } else if ([0x03, 0x0c, 0x0d].includes(k) || (SE && [0x11, 0x13].includes(k)) || (!SE && k === 0x08)) {
        sys = sys || initSystem();
        applySystem(sys, m);
        if (k === MAP_ID || k === 0x0c || k === 0x11 || k === 0x08 || (k === 0x03 && m[5] < 0x40 && m[5] !== S.same)) sysMsgs.push(m);
      } else items.push({ key: `o${items.length}`, label: k >= 0x40 ? `${WHO} request` : `${WHO} ${NAMES[k] || 'message'}`, name: '', object: null, msgs: [m] });
    }
    if (sys) items.push({ key: 'system', label: 'Settings and MIDI program table', name: '', object: 'system', data: sys, msgs: sysMsgs });
    return items;
  }

  async function readAll(api) {
    return api.request(msg.getAll(api.ctx), (r) => isAlpha(r) && id(r) === ALL_ID, (r) => presetsFrom(r));
  }
  async function readBank(api) {
    if (!SE) return DEFAULT_BANK;
    const r = await api.request(msg.getSetting(S.bank, api.ctx), (x) => isAlpha(x) && id(x) === 0x03 && x[5] === S.bank, (x) => x);
    return Math.min(3, r[6]);
  }
  async function readPreset(api, n) {
    if (SE) {
      const bank = await readBank(api);
      return entryEdit(n, (await readAll(api))[n] || { rom: { h: 0, l: 0xff } }, bank);
    }
    const e = await api.request(msg.getPreset(n, api.ctx), (r) => isAlpha(r) && id(r) === 0x06 && num(r, 5) === n, (r) => presetFrom(r));
    return entryEdit(n, e);
  }
  const editFromSyx = (msgs) => {
    const m = msgs.find((r) => isAlpha(r) && [0x05, 0x06, 0x0b, 0x0f, 0x12].includes(id(r)));
    if (!m) return null;
    if (id(m) === 0x05) return unpair(m, 5, SIZE);
    if (id(m) === 0x06 && !SE) { const e = presetFrom(m); return entryEdit(e.n, e); }
    const e = presetsFrom(m)[0];
    return e ? entryEdit(0, e) : null;
  };

  // ---------------------------------------------------------------- Head Library
  const DELAY_MAX_MS = 1500; // the delay scale the effect translators share
  const u = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const msOf = (s) => { const m = /([\d.]+)\s*(ms|s)/.exec(s || ''); return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : 0; };
  const secOf = (s) => { const m = /([\d.]+)s/.exec(s || ''); return m ? Number(m[1]) : 0; };
  const KINDS = { reverb: [7, 8, 9], gate: [10, 11, 12], delay: [13, 14, 15, 16, 17, 18], chorus: [2], flanger: [1], phaser: [23], tremolo: [5], panner: [4], pitch: [3, 24] };
  const kindOf = (t) => Object.keys(KINDS).find((k) => KINDS[k].includes(t));
  const pIdx = (t, name) => TYPES[t].params.findIndex((p) => p.name === name);
  const get = (d, t, name) => { const i = pIdx(t, name); return i < 0 ? null : d[fxOffset(cfgOf(d), t, i)]; };
  function toCommon(d) {
    const cfg = cfgOf(d);
    const effects = {};
    for (const t of CONFIGS[cfg]) {
      if (!inUse(d, t)) continue;
      const kind = kindOf(t);
      const lvl = get(d, t, 'LEVEL') ?? get(d, t, 'DEPTH');
      const level = lvl === null ? 1 : u(lvl, 0, 63);
      if ((kind === 'reverb' || kind === 'gate') && !effects.reverb) {
        const type = textsOf(t, 0)[get(d, t, 'TYPE') - TYPES[t].params[0].min] || '';
        const gate = t >= 10;
        const dec = get(d, t, 'DECAY');
        effects.reverb = { type: gate ? `GATE ${type}` : type.replace(/-\d/, ''), time: gate ? u(dec, 0, 7) : u(secOf(valueText(t, pIdx(t, 'DECAY'), dec)), 0, 25), level };
      } else if (kind === 'delay' && !effects.delay) {
        const ti = pIdx(t, 'DELAY') >= 0 ? pIdx(t, 'DELAY') : pIdx(t, 'DLY-L');
        effects.delay = { type: t >= 17 ? 'STEREO DELAY' : t >= 15 ? 'MONO DELAY' : 'MULTI TAP', time: u(msOf(valueText(t, ti, d[fxOffset(cfg, t, ti)])), 0, DELAY_MAX_MS), feedback: u(get(d, t, 'REGEN'), 0, 63), level };
      } else if (['chorus', 'flanger', 'phaser', 'tremolo', 'panner', 'pitch'].includes(kind) && !effects.modulation) {
        const rate = get(d, t, 'SPEED');
        const depth = get(d, t, 'WIDTH') ?? get(d, t, 'MOD %');
        const m = { type: { chorus: 'STEREO CHORUS', flanger: 'FLANGER', phaser: 'PHASER', tremolo: 'TREMOLO', panner: 'AUTO PAN', pitch: 'PITCH SHIFT' }[kind], level };
        if (rate !== null) m.rate = u(rate, 0, 84);
        if (depth !== null) m.depth = u(depth, 0, 31);
        effects.modulation = m;
        if (kind === 'chorus') effects.chorus = { ...m };
      }
    }
    return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: M.id, configuration: CONFIG_NAMES[cfg], inUse: summary(d), data: Array.from(prepare(d)), match: hashBytes(prepare(d)) } };
  }
  /** The first configuration holding effects of the kinds wanted (most first), with LOW-PASS. */
  function pickConfig(want) {
    let best = 0;
    let score = -1;
    CONFIGS.forEach((c, k) => {
      if (!CONFIG_OK[k]) return;
      const kinds = new Set(c.map(kindOf));
      const s = want.filter((w) => kinds.has(w)).length * 10 - c.length;
      if (s > score) { score = s; best = k; }
    });
    return best;
  }
  function nearest(t, i, target, valueOf) {
    const P = TYPES[t].params[i];
    let best = P.def;
    let err = Infinity;
    textsOf(t, i).forEach((s, k) => { const e = Math.abs(valueOf(s) - target); if (e < err) { err = e; best = P.min + k; } });
    return best;
  }
  function fromCommon(c, base) {
    const r = emptyReport();
    const x = c?.extra;
    if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
      const d = Uint8Array.from(x.data);
      if (fitEdit(d)) r.approximated.push('Values outside their ranges limited');
      r.mapped.push(`Preset (exact: ${CONFIG_NAMES[cfgOf(d)]}, ${summary(d)})`);
      return { data: d, report: tidy(r) };
    }
    const fx = c?.effects || {};
    const on = (e) => e && (e.level ?? 1) > 0;
    const m = [fx.modulation, fx.chorus].find(on);
    const mt = String(m?.type || '').toUpperCase();
    const modKind = !m ? null : /PITCH|SHIFT|OCTAV|HARMON/.test(mt) ? 'pitch' : /FLANG/.test(mt) ? 'flanger' : /PHAS/.test(mt) ? 'phaser' : /TREM/.test(mt) ? 'tremolo' : /PAN/.test(mt) ? 'panner' : 'chorus';
    const rvKind = on(fx.reverb) && (/GATE/i.test(fx.reverb.type || '') ? 'gate' : 'reverb');
    const want = [rvKind, on(fx.delay) && 'delay', modKind].filter(Boolean);
    if (!want.length) {
      r.dropped.push('No effect in the source sound: the preset keeps its settings');
      return { data: Uint8Array.from(base || factoryEdit(0)), report: tidy(r) };
    }
    const cfg = pickConfig(want);
    const d = initEdit(cfg);
    d[E.mix] = 31; d[E.mix + 1] = 31; d[E.mix + 2] = 31;
    r.approximated.push(`Configuration ${cfg}: ${CONFIG_NAMES[cfg]}`);
    const put = (t, name, v, what) => {
      const i = pIdx(t, name);
      if (i < 0 || v === undefined || v === null || Number.isNaN(v)) return;
      const P = TYPES[t].params[i];
      d[fxOffset(cfg, t, i)] = Math.max(P.min, Math.min(P.max, Math.round(v)));
      r.approximated.push(what);
    };
    CONFIGS[cfg].forEach((t, k) => {
      const kind = kindOf(t);
      let src = null;
      if (kind === rvKind) src = fx.reverb;
      else if (kind === 'delay' && want.includes('delay')) src = fx.delay;
      else if (kind === modKind) src = m;
      if (!src) return;
      d[E.present] |= 1 << k;
      addEffect(d, t);
      if (src.level !== undefined) put(t, pIdx(t, 'LEVEL') >= 0 ? 'LEVEL' : 'DEPTH', src.level * 63, `${kind} level → ${TYPES[t].name} LEVEL`);
      if (kind === 'reverb' || kind === 'gate') {
        const want2 = String(src.type || 'HALL').toUpperCase();
        const ti = 0;
        const k2 = textsOf(t, ti).findIndex((s) => s !== 'OFF' && want2.includes(s.replace(/-.*/, '')));
        if (k2 >= 0) put(t, 'TYPE', TYPES[t].params[ti].min + k2, `Reverb type → ${textsOf(t, ti)[k2]}`);
        const di = pIdx(t, 'DECAY');
        if (src.time !== undefined) put(t, 'DECAY', t >= 10 ? src.time * TYPES[t].params[di].max : nearest(t, di, src.time * 25, secOf), 'Reverb time → DECAY');
      } else if (kind === 'delay') {
        const ti = pIdx(t, 'DELAY') >= 0 ? pIdx(t, 'DELAY') : pIdx(t, 'DLY-L');
        if (src.time !== undefined) put(t, TYPES[t].params[ti].name, nearest(t, ti, src.time * DELAY_MAX_MS, msOf), 'Delay time');
        if (src.feedback !== undefined) put(t, 'REGEN', src.feedback * 63, 'Delay feedback → REGEN');
      } else {
        if (src.rate !== undefined) put(t, 'SPEED', src.rate * 84, 'Modulation rate → SPEED');
        if (src.depth !== undefined) put(t, pIdx(t, 'WIDTH') >= 0 ? 'WIDTH' : 'MOD %', src.depth * 31, 'Modulation depth → WIDTH');
        if (kind === 'pitch') r.dropped.push('Pitch intervals (PITCH 0, FINE 0.00)');
      }
    });
    for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
    setName(d, base ? nameOf(base) : '');
    fitEdit(d);
    return { data: d, report: tidy(r) };
  }

  // ---------------------------------------------------------------- definition
  const romName = (b, i) => (BANKS[b].titles[i] || '').trim();
  const bankLabel = (b) => (SE ? `ROM ${FW.BANK_UTIL.values[b]}` : 'Factory');
  const slotBanks = SE ? [[0, 'Presets 1-200'], ...BANKS.map((_, b) => [b + 1, `${bankLabel(b)} (${BANKS[b].presets.length})`])] : [[0, 'Presets 1-200']];
  const slots = {
    label: 'Presets', banks: slotBanks,
    count: SE ? (bank) => (bank ? BANKS[bank - 1].presets.length : N_PRESETS) : N_PRESETS,
    slotLabel: (_bank, i) => pad3(i + 1),
    note: SE
      ? (bank) => (bank
        ? `The ${bankLabel(bank - 1)} presets built into the unit: Edit shows one here, Play sends it to the unit to play. Store it into a preset slot from the Presets 1-200 list.`
        : 'Each slot holds a preset of your own or points to a built-in one (SLOT page: OPEN = the selected BANK\'s preset of the same number, or BANK A-D #n). Edit and Read names read all 200 at once. Store sends the preset to the unit and has it STORE it, since the unit cannot take a single preset over MIDI; a preset equal to a built-in one is stored as a reference to it, an empty one leaves the slot empty. Play recalls the preset.')
      : () => `Edit reads one preset; Read names reads all 200 at once. Store writes the preset without changing what the unit is playing; an empty preset from ${N_FACTORY + 1} on is stored as empty. Presets 1-${N_FACTORY} are the factory presets until overwritten (storing over MIDI ignores the 1..${N_FACTORY} lock). Play recalls the preset.`,
    writable: (bank) => !bank,
    name: nameOf,
    names: SE ? (bank) => (bank ? BANKS[bank - 1].titles.map((_, i) => romName(bank - 1, i)) : null) : undefined,
    recall: (bank, i, ctx) => (bank ? [msg.edit(prepare(bankEdit(bank - 1, i)), ctx)] : [msg.recall(i, ctx)]),
    fetch: (api, bank, i) => (bank ? Promise.resolve(bankEdit(bank - 1, i)) : readPreset(api, i)),
    scanBank: async (api, bank, onName) => {
      if (bank) return;
      const b = SE ? await readBank(api) : DEFAULT_BANK;
      const list = await readAll(api);
      list.forEach((e, n) => onName(n, nameOf(entryEdit(n, e, b))));
    },
    store: (_bank, i, ctx, data) => storeMessage(i, data, ctx),
  };
  if (!SE) delete slots.names;

  const def = {
    coverage: `Edits the ${WHO}'s presets (all ${CONFIGS.length - BROKEN.length} configurations, each value shown as the edit display shows it; MIX, EQUALIZER, A.E.S., the X-15 FX ON/OFF states, the title and the eight PERFORMANCE MIDI assignments), ${SE ? `shows the four built-in preset banks (${BANKS.map((b) => `${b.name} ${b.presets.length}`).join(', ')}) and the slots that point to them` : `shows the ${N_FACTORY} factory presets`}, and edits the UTILITY and MIDI settings, the FX ON/OFF controllers and the MIDI program table. Every change is sent as you make it; ${SE ? 'all presets can be read and written at once, stored and recalled' : 'presets can be read, written, recalled and stored one by one or all at once'}. Not checked on hardware.`,
    sysex: { manufacturer: [0x1a], model: 0x11 },
    minGap: 120, // the edit buffer is 202 bytes; the unit applies it from its main loop
    describe,
    recognise: isAlpha,
    isOwn: isAlpha,
    isRequest: (raw) => isAlpha(raw) && id(raw) >= 0x40,
    // the two models share the header: SE-only messages (11, 12, 13, BANK 03 09, version 2.03 / 2.04) or
    // Alpha 2-only ones (06, 08, 0B, 0C, which the SE does not send) decide; an edit buffer alone fits both
    prefer: (msgs) => {
      const own = msgs.filter(isAlpha);
      const se = own.some((m) => [0x11, 0x12, 0x13].includes(id(m)) || (id(m) === 0x03 && (m[5] === 0x09 || (m[5] === 0x41 && m[6] !== 2))));
      const a2 = own.some((m) => [0x06, 0x08, 0x0b, 0x0c].includes(id(m)));
      return se === a2 ? 1 : se === SE ? 2 : 0.5;
    },
    simulate,
    libraryItems,
    objects: [
      {
        key: 'effect', page: 'Preset', icon: '◆', label: 'Edit buffer', size: SIZE, autoLoad: true,
        init: () => factoryEdit(0),
        request: (ctx) => msg.getEdit(ctx),
        match: (raw) => isAlpha(raw) && id(raw) === 0x05,
        decode: (raw) => unpair(raw, 5, SIZE),
        receive: (raw) => (isAlpha(raw) && id(raw) === 0x05 ? unpair(raw, 5, SIZE) : null),
        params: presetParams,
        name: nameOf,
        setName,
        category: () => 'none',
        patchKinds: ['effect'],
        toCommon,
        fromCommon,
        cols: 4,
        layout: [{ group: 'Chain' }, { group: 'MIX' }, { group: 'EQUALIZER' }, { group: 'A.E.S.' }, ...ORDER.map((t) => ({ group: TYPES[t].name })), { group: 'X-15 FX ON/OFF' },
          ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ group: `PERFORMANCE MIDI #${k + 1}` })), { group: 'PERFORMANCE MIDI runtime', wide: true }],
        groupInfo: { 'PERFORMANCE MIDI runtime': { note: 'What the unit fills in for each assignment when a preset is recalled. Shown, not edited: the editor sets them as the unit expects whenever it sends.' } },
        note: (ctx) => `Every change sends the whole preset to the ${WHO}, which cannot take single values over MIDI. The editor sends on MIDI channel ${(ctx?.channel ?? 0) + 1}, which must be the unit's MIDI CHANNEL. Parameters of effects not in the preset are hidden (the unit does not keep them).`,
        sendAll: { label: 'Send to edit buffer', title: 'Send the whole preset to the unit to play; nothing is stored', build: (data, ctx) => msg.edit(prepare(data), ctx) },
        toSyx: (data, ctx) => msg.edit(prepare(data), ctx),
        fromSyx: editFromSyx,
        actions: [
          { label: 'Store as preset', title: `Send the preset and STORE it as preset 1-200 (storing over MIDI ignores the 1..${N_FACTORY} lock)`, run: async (api) => {
            const f = await api.form('Store into preset', [{ key: 'n', label: `Preset (1-200; 1-${N_FACTORY} are the factory presets)`, value: String(N_FACTORY + 1), type: 'number', min: 1, max: 200 }]);
            if (!f) return;
            const n = Math.max(1, Math.min(200, Math.round(Number(f.n) || N_FACTORY + 1))) - 1;
            api.send([msg.edit(prepare(api.data), api.ctx), msg.store(n, api.ctx)]);
          } },
          { label: 'Rename', run: async (api) => {
            const r = await api.form('Preset title', [{ key: 'name', label: 'Title (16 characters)', value: titleOf(api.data).trimEnd(), maxlength: TITLE_LEN }]);
            if (!r) return;
            const d = Uint8Array.from(api.data);
            setName(d, r.name);
            api.setData(d);
            api.send(msg.edit(prepare(d), api.ctx));
          } },
          { label: 'Recall factory preset', title: `HIT RECALL FOR A.R.T. PRESET: the unit loads a factory preset${SE ? ' of the selected BANK' : ''} to play, without changing any stored preset`, run: async (api) => {
            const f = await api.form('Recall factory preset', [{ key: 'n', label: `Factory preset (1-${N_FACTORY})`, value: '1', type: 'number', min: 1, max: N_FACTORY }]);
            if (!f) return;
            const n = Math.max(1, Math.min(N_FACTORY, Math.round(Number(f.n) || 1))) - 1;
            let bank = DEFAULT_BANK;
            if (SE) try { bank = await readBank(api); } catch { /* no answer: the factory BANK */ }
            api.send(msg.recallFactory(n, api.ctx));
            api.setData(SE ? bankEdit(bank, n) : factoryEdit(n));
          } },
        ],
        slots,
      },
      {
        key: 'system', page: 'Settings', icon: '⚙', label: 'Settings', size: SYS.size, autoLoad: true,
        init: initSystem,
        fetch: readSystem,
        receive: (raw, data) => { if (!isAlpha(raw) || ![0x03, 0x0c, 0x0d, ...(SE ? [0x11, 0x13] : [0x08])].includes(id(raw))) return null; const s = Uint8Array.from(data); applySystem(s, raw); return s; },
        sections: [{ key: 'settings', label: 'UTILITY and MIDI' }, { key: 'map', label: 'MIDI program table' }],
        params: systemParams,
        cols: 3,
        layout: [{ group: 'BYPASS' }, { group: 'UTILITY' }, { group: 'MIDI' }, { group: 'FX ON/OFF CONTROLLERS' }, { group: 'Status' }, { group: 'MIDI PROGRAM TABLE', wide: true }],
        note: 'Each setting is sent to the unit as you change it; the unit keeps it without STORE (its memory is battery-backed). Reading asks for each setting, the store status and the program table.',
        actions: [
          { label: 'Send all settings', title: 'Send every setting and the whole program table', run: (api) => api.send(systemMessages(api.data, api.ctx)) },
          { label: 'Factory values', title: 'What a factory reset leaves (program change c recalls preset c + 1); not sent until you press Send all settings', run: (api) => api.setData(initSystem()) },
        ],
        toSyx: (data, ctx) => systemMessages(data, ctx).flat(),
        fromSyx: (msgs) => { const s = initSystem(); let any = false; for (const m of msgs) any = applySystem(s, m) || any; return any ? s : null; },
      },
    ],
    requests: [
      { label: 'Edit buffer', bytes: (ctx) => msg.getEdit(ctx), timeout: 3000 },
      { label: 'All presets', bytes: (ctx) => msg.getAll(ctx), timeout: 4000 },
      { label: 'MIDI program table', bytes: (ctx) => msg.getMap(ctx), timeout: 3000 },
      { label: 'Settings', bytes: (ctx) => [...SETTINGS, 0x40, 0x41].map((k) => msg.getSetting(k, ctx)), timeout: 3000 },
    ],
    fullDump: [
      { request: 'All presets', timeout: 4000, expect: 1, seconds: 5 },
      { request: 'MIDI program table', expect: 1, seconds: 1 },
      { request: 'Settings', expect: SETTINGS.length + 2, seconds: 2 },
      { request: 'Edit buffer', expect: 1, seconds: 1 },
    ],
    midiNotes: [
      `SysEx (header F0 1A, MIDI channel - 1, 11h) is received only on the unit's MIDI CHANNEL (not with OMNI, not with the channel OFF).`,
      `Program change (MIDI ENABLE PROG ON, on the channel or with OMNI) recalls the preset the MIDI program table gives${SE ? ' (200 entries: CC 32 = 1 before the program change reaches entries 128-199)' : ''}; CC 124 / 125 set OMNI off / on.`,
      'PERFORMANCE MIDI: each preset has up to eight assignments (controller 0-120, note number / velocity, aftertouch, channel pressure or pitch bend, moving one parameter between LOW and HIGH).',
      'FX ON/OFF controllers (MIDI page, default MC 84 and 70-79): with FX ON/OFF ENABLE on, values 64-127 turn an X-15 switch on, 0-63 off; the ART X-15 sends them.',
      SE ? 'MIDI page PRESS ENTER TO: SEND A PRESET sends the edit buffer (05), SEND ENTIRE MPT the program table (13), SEND ALL PRESETS all presets (12).'
        : 'MIDI page PRESS ENTER TO: SEND A PRESET sends the edit buffer (05), SEND ENTIRE MPT the program table (0C), SEND ALL PRESETS all presets (0B).',
    ],
  };

  return {
    def,
    TYPES, CONFIGS, TEXTS, UTIL, PM_TITLES, FX_STATUS, CTRL, X15, DEFAULTS, FIRMWARE, BANKS, BROKEN, N_FACTORY, N_MAP, DEFAULT_BANK,
    sizeOf, cfgOf, textsOf, labelOf, valueText, switchOf, fxOffset, inUse, paramList, paramName, CONFIG_NAMES, summary,
    initEdit, titleOf, nameOf, setName, isEmptyPreset, fitEdit, prepare, pack, unpack, packedLength, unpackA2, packA2,
    bankEdit, factoryEdit, emptyEdit, romPreset, slotText, msg, presetsFrom, presetFrom, storeMessage,
    S, SYS, ADDR, SETTINGS, initSystem, systemMessages, setConfig,
    _test: { presetParams, systemParams, simulate, toCommon, fromCommon, unpair, pairs, packTitle, unpackTitle, applySystem, pickConfig, storeEntrySE },
  };
}
