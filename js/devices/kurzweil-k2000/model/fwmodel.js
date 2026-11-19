// K2000 parameter model taken from the OS itself (see tools/k2000/extract_params.py).
//
// Every front-panel parameter has: a data location code, a byte offset (counted
// from the segment's tag byte), a storage type with optional bit field, the
// allowed value ranges, and how the K2000 displays each value. This module maps
// the location codes onto stored objects (programs, the Master table) and
// reads, writes and formats values exactly as the K2000 does.

import { PAGES, GROUPS, LISTS, MODES, DSP_FUNCTIONS, DSP_TITLES, ALGORITHMS, ROM_NAMES, FW_VERSION, MASTER_DEFAULT } from './fwparams.js';

export { PAGES, GROUPS, LISTS, MODES, DSP_FUNCTIONS, ALGORITHMS, ROM_NAMES, FW_VERSION };

// Segment tags of the stored program object (one tag byte + fixed-length data).
const T = {
  PROGRAM: 0x08, LAYER: 0x09, FX: 0x0f, ASR1: 0x10, ASR2: 0x11, LFO1: 0x14, LFO2: 0x15,
  FUN1: 0x18, FUN2: 0x19, FUN3: 0x1a, FUN4: 0x1b, ENVCTL: 0x20, AMPENV: 0x21, ENV2: 0x22, ENV3: 0x23,
  CAL: 0x40, F1: 0x50, F2: 0x51, F3: 0x52, AMP: 0x53,
};

/**
 * Location codes used by the parameter table. The K2000 edits programs in a
 * fixed layout (0x30-byte header + 0xE0 bytes per layer); each code selects one
 * segment slot. Stored programs drop unused slots, so slots are found by tag.
 * "Global" LFO2/ASR2/FUN2/FUN4 live in the program header when Globals is on.
 */
export const LOC = {
  0x107: { obj: 'program', scope: 'program', tag: T.PROGRAM },
  0x108: { obj: 'program', scope: 'layer', tag: T.LAYER },
  0x109: { obj: 'program', scope: 'layer', tag: T.LFO1 },
  0x10a: { obj: 'program', scope: 'layer', tag: T.LFO2 },
  0x10b: { obj: 'program', scope: 'program', tag: T.LFO2, global: true },
  0x10c: { obj: 'program', scope: 'layer', tag: T.ASR1 },
  0x10d: { obj: 'program', scope: 'layer', tag: T.ASR2 },
  0x10e: { obj: 'program', scope: 'program', tag: T.ASR2, global: true },
  0x10f: { obj: 'program', scope: 'layer', tag: T.AMPENV },
  0x110: { obj: 'program', scope: 'layer', tag: T.ENV2 },
  0x111: { obj: 'program', scope: 'layer', tag: T.ENV3 },
  0x112: { obj: 'program', scope: 'layer', tag: T.ENVCTL },
  0x113: { obj: 'program', scope: 'program', tag: T.FX },
  0x114: { obj: 'program', scope: 'layer', tag: T.FUN1 },
  0x115: { obj: 'program', scope: 'layer', tag: T.FUN2 },
  0x116: { obj: 'program', scope: 'layer', tag: T.FUN3 },
  0x117: { obj: 'program', scope: 'layer', tag: T.FUN4 },
  0x118: { obj: 'program', scope: 'program', tag: T.FUN2, global: true },
  0x119: { obj: 'program', scope: 'program', tag: T.FUN4, global: true },
  0x11a: { obj: 'program', scope: 'layer', dsp: 0 },   // the DSP block being edited
  0x11b: { obj: 'program', scope: 'layer', tag: T.F1, dsp: 1 },
  0x11c: { obj: 'program', scope: 'layer', tag: T.F2, dsp: 2 },
  0x11d: { obj: 'program', scope: 'layer', tag: T.F3, dsp: 3 },
  0x11e: { obj: 'program', scope: 'layer', tag: T.AMP, dsp: 4 },
  0x11f: { obj: 'program', scope: 'layer', tag: T.CAL },
  // Master table (object Table 100:16): global settings, MIDI and channel setup.
  0x0fe: { obj: 'master', base: 0 },
  0x0ff: { obj: 'master', base: 0x58, stride: 16 },     // per MIDI channel, 16 bytes each
  0x100: { obj: 'master', base: 0x48 },
};

export const MASTER = { type: 100, id: 16 };

const SIZE = { 1: 1, 2: 2, 3: 4, 5: 1, 6: 2, 7: 4 };
const valueCache = new WeakMap();

/** Every allowed raw value of a parameter, in display order (null when there are too many). */
export function paramValues(p) {
  if (valueCache.has(p)) return valueCache.get(p);
  let out = [];
  for (const [lo, span] of p.r) {
    for (let v = lo; v <= lo + span; v++) out.push(v);
    if (out.length > 20000) { out = null; break; }
  }
  valueCache.set(p, out);
  return out;
}

export function paramRange(p) {
  let min = Infinity;
  let max = -Infinity;
  for (const [lo, span] of p.r) { min = Math.min(min, lo); max = Math.max(max, lo + span); }
  return { min, max };
}

/** Text the K2000 shows for raw value v. names(type, id) resolves object names. */
export function formatParam(p, v, names) {
  const s = p.s;
  if (typeof s === 'number') {
    const vals = paramValues(p);
    const i = vals ? vals.indexOf(v) : -1;
    return i >= 0 ? LISTS[s][i] : String(v);
  }
  if (typeof s === 'string') return s.replace('%d', String(v));
  if (s && s.obj) {
    if (!v) return '0 None';
    const n = romName(s.obj, v) ?? names?.(s.obj, v);
    return n ? `${v} ${n}` : String(v);
  }
  return String(v);
}

export function romName(type, id) { return ROM_NAMES[type]?.[id]; }

/** True when the parameter is best edited from a list. */
export function hasChoices(p) { return typeof p.s === 'number'; }

/** Read a raw value at absolute offset `a` of `d`. */
export function readAt(d, a, p) {
  const t = p.t & 7;
  const size = SIZE[t];
  if (!size || a < 0 || a + size > d.length) return 0;
  let v;
  switch (t) {
    case 1: v = (d[a] << 24) >> 24; break;
    case 2: v = ((d[a] << 24) | (d[a + 1] << 16)) >> 16; break;
    case 5: v = d[a]; break;
    case 6: v = (d[a] << 8) | d[a + 1]; break;
    default: v = ((d[a] << 24) | (d[a + 1] << 16) | (d[a + 2] << 8) | d[a + 3]) >>> 0;
  }
  if (p.t & 0x08) v = (v >> p.sh) & ((1 << p.w) - 1);
  return v;
}

/** Write raw value v; returns the LOAD patch {offset, bytes, before} or null when nothing changed. */
export function writeAt(d, a, p, v) {
  const t = p.t & 7;
  const size = SIZE[t];
  if (!size || a < 0 || a + size > d.length) return null;
  const before = d.slice(a, a + size);
  let word = 0;
  for (let i = 0; i < size; i++) word = (word * 256) + d[a + i];
  if (p.t & 0x08) {
    const mask = ((1 << p.w) - 1) << p.sh;
    word = (word & ~mask) | ((v << p.sh) & mask);
  } else word = v;
  word = size === 4 ? word >>> 0 : word & ((1 << (size * 8)) - 1);
  for (let i = size - 1; i >= 0; i--) { d[a + i] = word & 0xff; word = Math.floor(word / 256); }
  const bytes = d.slice(a, a + size);
  if (bytes.every((b, i) => b === before[i])) return null;
  return { offset: a, bytes, before };
}

// ------------------------------------------------------------------ pages

/**
 * Parameters shown on a firmware page, one entry per distinct data location.
 * Pages overlay variants (local vs global rows, alternative output layouts);
 * duplicates keep the entry with the most choices.
 * @returns {{p, name, item}[]}
 */
export function pageEntries(pageId, groupId = null) {
  const page = PAGES[pageId];
  if (!page) return [];
  const out = [];
  const byKey = new Map();
  for (const item of page.items) {
    if (item[0] !== 1) continue;
    const g = groupId ?? item[1];
    if (groupId !== null && item[1] !== groupId) continue;
    const p = GROUPS[g]?.[item[2]];
    if (!p || !LOC[p.loc]) continue;
    const key = `${p.loc}:${p.off}:${p.t & 8 ? `${p.sh}:${p.w}` : ''}`;
    const entry = { p, name: item[9] || item[3] || p.l || `Param ${item[2]}`, item, key };
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, entry); out.push(entry); continue; }
    const n = paramValues(p)?.length ?? 0;
    const pn = paramValues(prev.p)?.length ?? 0;
    if (n > pn) { prev.p = p; }
    if (!prev.item[9] && item[9]) prev.name = item[9];
  }
  return out;
}

/** Page and parameter group for a mode / editor page (title object id). */
export function modePage(titleId) {
  const m = MODES[titleId];
  return m ? { title: m.title, page: m.page, group: m.group } : null;
}

// ------------------------------------------------------------- program access

/**
 * Binds parameter locations to a parsed Program (see program.js).
 * Firmware offsets count the tag byte, so a value lives at segment.offset + off.
 */
export class ProgramMap {
  constructor(prog) { this.prog = prog; }

  /** Absolute offset of the segment holding location `loc`, or null if the program has no such segment. */
  base(loc, layer, block = null) {
    const L = LOC[loc];
    if (!L || L.obj !== 'program') return null;
    const prog = this.prog;
    let tag = L.tag;
    if (L.dsp === 0) {
      if (!block) return null;
      tag = T.F1 + block - 1;
    }
    const seg = L.scope === 'program' ? prog.common.find((s) => s.tag === tag) : prog.segment(layer, tag);
    return seg ? seg.offset : null;
  }

  read(p, layer, block) {
    const b = this.base(p.loc, layer, block);
    return b === null ? null : readAt(this.prog.data, b + p.off, p);
  }

  /** Returns the LOAD patch or null. */
  write(p, layer, block, v) {
    const b = this.base(p.loc, layer, block);
    return b === null ? null : writeAt(this.prog.data, b + p.off, p, v);
  }

  algorithm(layer) {
    const b = this.base(0x11f, layer);
    return b === null ? 0 : this.prog.data[b + 30];
  }

  /** DSP function code of block 1-4 (byte 1 of the block segment). */
  blockCode(layer, block) {
    const b = this.base(0x11b + block - 1, layer);
    return b === null ? null : this.prog.data[b + 1];
  }

  /**
   * Which function covers each block and which parameter page it shows,
   * following the K2000 (functions can span 2 or 3 blocks).
   * @returns {{block, code, start, title, page, group, name, width}[]}
   */
  dspBlocks(layer) {
    const out = [];
    let block = 1;
    while (block <= 4) {
      const code = this.blockCode(layer, block);
      if (code === null) { block++; continue; }
      const width = Math.max(1, DSP_FUNCTIONS[code]?.width || 1);
      for (let b = block; b < block + width && b <= 4; b++) {
        const title = dspTitle(code, block, b);
        const m = MODES[title];
        out.push({ block: b, code, start: block, width, title, page: m?.page, group: m?.group, name: DSP_FUNCTIONS[code]?.name || `Function ${code}`, label: MODES[title]?.title || '' });
      }
      block += width;
    }
    return out;
  }
}

/** Title (page) id for block `block` of a function `code` that starts at block `start` (0x1881CF table). */
export function dspTitle(code, start, block) {
  for (const [c, s, b, title] of DSP_TITLES) {
    if ((c === code || c === 0) && s === start && b === block) return title;
  }
  return 0xb1; // AMP
}

/** Function selectors of the algorithm page: [{block, p}] with the allowed function codes per block. */
export function algorithmSelectors(alg) {
  const group = 0x27 + alg;
  const out = [];
  for (const p of GROUPS[group] || []) {
    const L = LOC[p.loc];
    if (L?.dsp && p.off === 1 && L.tag !== T.CAL) out.push({ block: L.dsp, p });
  }
  return out.sort((a, b) => a.block - b.block);
}

export function algorithmParam(alg = 1) {
  return (GROUPS[0x27 + alg] || GROUPS[0x28]).find((p) => p.loc === 0x11f && p.off === 30) || null;
}

// --------------------------------------------------------------- master table

/** Offset of a Master table parameter for MIDI channel `ch` (1-16, used by per-channel rows). */
export function masterOffset(p, ch = 1) {
  const L = LOC[p.loc];
  if (!L || L.obj !== 'master') return null;
  return L.base + (L.stride ? (ch - 1) * L.stride : 0) + p.off;
}

/** Factory Master table bytes from the OS ROM. */
export const MASTER_DEFAULT_BYTES = Uint8Array.from(MASTER_DEFAULT.match(/../g), (x) => parseInt(x, 16));
