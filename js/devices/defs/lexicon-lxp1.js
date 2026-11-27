// Lexicon LXP-1 (1988 half-rack reverb / effects, eight algorithms): MIDI implementation from the v1.06 EPROM
// ("LXP Version 1.06 Copyright 1988 Lexicon, Inc."; 32 KB, Z80). See docs/devices/lexicon-lxp1.md.
//
// The LXP-1 has no display: its parameters are shown on the Lexicon MRC (MIDI Remote Controller). The names and
// every value text here are the MRC's screens (v4.00 EPROMs: its LXP-1 module, display routines run for every
// value); the bytes, messages and conversions are the LXP-1's own (receiver 2254, dispatcher 024E, sender 2EED).
//
// A setup (register, dump) is 49 bytes: 0 algorithm (1 REVERB, 2 PLATE, 3 CHORUS 1, 4 DELAY 2, 5 CHORUS 2,
// 6 INVERSE, 7 GATE, 8 DELAY 1), 1-20 ten 16-bit words (low byte first; each algorithm reads them its own way),
// 21-36 the name (16 bytes; the MRC writes 8), 37-40 patch Src 1-4, 41-44 Dest 1-4, 45-48 Scale 1-4.
// The MRC turns a fader step v (0 to steps - 1) into a word: 8000h + v * (4000h / steps), or 4000h + v *
// (8000h / steps) for the bipolar ones; with 255 steps 40h / 80h a step and one step left out above 79h.
//
// SysEx F0 06 02 <fn n> ... F7 (Lexicon, LXP-1; n = MIDI channel). Dumps are 7-bit groups: a byte holding
// bit 7 of the next seven (bit 0 first), then the seven; cs = the sum of the sent bytes AND 7Fh.
//   0n 38 <56> cs        active setup (49 bytes)          1n rr 38 <56> cs   register rr (0-127)
//   4n 38 00 <7168> cs   all 128 registers (6272 bytes)    5n pp a b c d      parameter pp = abcd (nibbles)
//   2n pp hb lo hi       parameter pp (16 bits as one group) 3n 60 / 61 rr / 62 pp / 65 pp / 64   requests
//   6n 70 rr / 71 rr     store the active setup into register rr / load register rr
// Parameters: 0-9 the words, 20h-2Fh the name, 30h-3Bh the patches, 41h the algorithm (40h loads register
// 64 whatever the value: 034C passes the parameter number, so the editor never sends it).

import { FIRMWARE, ALGS, TABLES, SRC, SCALE, PRESETS } from './lexicon-lxp1-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { readParam, writeParam } from '../../core/model/memmap.js';
import { hashBytes, tidy } from './translate-helpers.js';

export { FIRMWARE, ALGS, TABLES, SRC, SCALE, PRESETS };

export const SIZE = 49;
export const ALL_SIZE = 128 * SIZE;
export const WORDS = 10;
export const NAME_AT = 21;
export const NAME_LEN = 16;
export const MRC_NAME_LEN = 8;
export const SRC_AT = 37;
export const DEST_AT = 41;
export const SCALE_AT = 45;
export const PP = { name: 0x20, patch: 0x30, alg: 0x41 };
export const REQ = { setup: 0x60, register: 0x61, param: 0x62, param16: 0x65, all: 0x64 };
const NONE = 0x7f;
const hexw = (w) => `${w.toString(16).toUpperCase().padStart(4, '0')}h`;

// ------------------------------------------------------------------ 7-bit groups
/** Bytes -> groups of a high-bit byte and seven 7-bit bytes. */
export function pack(d) {
  const out = [];
  for (let i = 0; i < d.length; i += 7) {
    const g = Array.from(d.slice(i, i + 7));
    out.push(g.reduce((hb, x, k) => hb | ((x & 0x80) ? 1 << k : 0), 0), ...g.map((x) => x & 0x7f));
  }
  return out;
}
export function unpack(m) {
  const out = [];
  let hb = 0;
  for (let i = 0; i < m.length; i++) {
    if (i % 8 === 0) hb = m[i];
    else out.push((m[i] & 0x7f) | (((hb >> (i % 8 - 1)) & 1) << 7));
  }
  return Uint8Array.from(out);
}
export const checksum = (m) => m.reduce((s, b) => s + (b & 0x7f), 0) & 0x7f;

// ------------------------------------------------------------------ messages
export const isLxp = (raw) => raw?.[0] === 0xf0 && raw.length > 5 && raw[1] === 0x06 && raw[2] === 0x02;
const hdr = (f, ch = 0) => [0xf0, 0x06, 0x02, (f << 4) | (ch & 15)];
const dump = (head, d) => { const p = pack(d); return [...head, ...p, checksum(p), 0xf7]; };
const fit = (d, n) => Uint8Array.from({ length: n }, (_, i) => d[i] ?? 0);
export const setupMessage = (d, ch = 0) => dump([...hdr(0, ch), 0x38], fit(d, SIZE));
export const registerMessage = (n, d, ch = 0) => dump([...hdr(1, ch), n & 0x7f, 0x38], fit(d, SIZE));
export const allMessage = (d, ch = 0) => dump([...hdr(4, ch), 0x38, 0x00], fit(d, ALL_SIZE));
/** 5n pp + four nibbles (what the MRC sends). */
export const paramMessage = (pp, v, ch = 0) => [...hdr(5, ch), pp & 0x7f, (v >> 12) & 15, (v >> 8) & 15, (v >> 4) & 15, v & 15, 0xf7];
/** 2n pp hb lo hi (what the unit answers to 3n 62). */
export const param2Message = (pp, v, ch = 0) => [...hdr(2, ch), pp & 0x7f, ...pack([v & 0xff, (v >> 8) & 0xff]), 0xf7];
export const requestMessage = (kind, arg = null, ch = 0) => [...hdr(3, ch), kind, ...(arg == null ? [] : [arg & 0x7f]), 0xf7];
export const storeMessage = (n, ch = 0) => [...hdr(6, ch), 0x70, n & 0x7f, 0xf7];
export const loadMessage = (n, ch = 0) => [...hdr(6, ch), 0x71, n & 0x7f, 0xf7];
export const algMessage = (code, ch = 0) => paramMessage(PP.alg, code, ch);

/** {kind, ...} of a message from or for the unit, or null. */
export function parse(raw) {
  if (!isLxp(raw) || raw.at(-1) !== 0xf7) return null;
  const a = Array.from(raw);
  const ch = a[3] & 15;
  const body = (from, count, n) => {
    if (a.length !== from + count + 2) return null;
    const m = a.slice(from, from + count);
    return { data: unpack(m).slice(0, n), ok: checksum(m) === a[from + count] };
  };
  switch (a[3] >> 4) {
    case 0: { const b = a[4] === 0x38 ? body(5, 0x38, SIZE) : null; return b && { kind: 'setup', ch, ...b }; }
    case 1: { const b = a[5] === 0x38 ? body(6, 0x38, SIZE) : null; return b && { kind: 'register', ch, n: a[4], ...b }; }
    case 4: { const b = a[4] === 0x38 && a[5] === 0 ? body(6, 0x1c00, ALL_SIZE) : null; return b && { kind: 'all', ch, ...b }; }
    case 5: return a.length === 10 ? { kind: 'param', ch, p: a[4], v: (a[5] << 12) | (a[6] << 8) | (a[7] << 4) | a[8], form: 5 } : null;
    case 2: { if (a.length !== 9) return null; const d = unpack(a.slice(5, 8)); return { kind: 'param', ch, p: a[4], v: d[0] | (d[1] << 8), form: 2 }; }
    case 3: return (a[4] & 0x78) === 0x60 ? { kind: 'request', ch, req: a[4] & 0x67, arg: a.length > 6 ? a[5] : null } : null;
    case 6: return a[4] === 0x70 || a[4] === 0x71 ? { kind: a[4] === 0x70 ? 'store' : 'load', ch, n: a[5] } : null;
    default: return null;
  }
}
export const isRequest = (raw) => parse(raw)?.kind === 'request';

// ------------------------------------------------------------------ setups and presets
export const algOf = (d) => d[0];
export const algInfo = (d) => ALGS.find((a) => a.v === d[0]) || null;
export const wordOf = (d, n) => d[1 + 2 * n] | (d[2 + 2 * n] << 8);
export const setWord = (d, n, v) => { d[1 + 2 * n] = v & 0xff; d[2 + 2 * n] = (v >> 8) & 0xff; };
export const nameOf = (d) => String.fromCharCode(...Array.from(d.slice(NAME_AT, NAME_AT + NAME_LEN)).filter((c) => c)).replace(/[^\x20-\x7e]/g, ' ').trimEnd();
/** The name as the MRC writes it: up to 8 characters (the rest of the 16 bytes are left as they are). */
export function setName(d, name, len = MRC_NAME_LEN) {
  const s = String(name).replace(/[^\x20-\x7e]/g, ' ').slice(0, len).padEnd(len, ' ');
  for (let i = 0; i < len; i++) d[NAME_AT + i] = s.charCodeAt(i);
}
export const romPreset = (i) => Uint8Array.from(PRESETS[i][1].match(/../g).map((x) => parseInt(x, 16)));
export const PRESET_NAMES = PRESETS.map((p, i) => p[0] || `Preset ${i + 1} (${ALGS.find((a) => a.v === parseInt(p[1].slice(0, 2), 16))?.name ?? '?'})`);

/** The word the MRC sends for fader step v of an item. */
export function stepWord(it, v) {
  if (it.steps === 255) {
    const s = v > 0x79 ? v + 1 : v;
    return it.send === 'a' ? 0x8000 + s * 0x40 : 0x4000 + s * 0x80;
  }
  return it.send === 'a' ? 0x8000 + v * Math.floor(0x4000 / it.steps) : 0x4000 + v * Math.floor(0x8000 / it.steps);
}
const nSteps = (it) => it.steps;
/** The step whose word is w, or -1. */
export function stepOf(it, w) {
  for (let v = 0; v < nSteps(it); v++) if (stepWord(it, v) === w) return v;
  return -1;
}
/** The MRC text for word w of an item; a word between steps reads as the step below it, with the word. */
export function wordText(it, w) {
  const v = stepOf(it, w);
  if (v >= 0) return TABLES[it.t][v];
  let below = -1;
  for (let s = 0; s < nSteps(it); s++) if (stepWord(it, s) <= w) below = s;
  return below < 0 ? `${hexw(w)} (below the MRC range)` : `${TABLES[it.t][below]} (${hexw(w)}, between MRC steps)`;
}

// ------------------------------------------------------------------ parameters
const ITEMS = []; // {alg, page, it}
for (const a of ALGS) a.pages.forEach((pg, pi) => pg.items.forEach((it) => ITEMS.push({ a: a.v, page: pi + 1, it })));
/** Words the ROM presets keep between MRC steps for an item of this kind (shown with the step below). */
function offGrid(a, it) {
  const out = new Set();
  for (const p of PRESETS) {
    const d = Uint8Array.from(p[1].match(/../g).map((x) => parseInt(x, 16)));
    const own = ALGS.find((x) => x.v === d[0])?.pages.flatMap((pg) => pg.items).find((x) => x.name === it.name);
    if (!own || own.w === undefined) continue;
    const w = wordOf(d, own.w);
    if (stepOf(it, w) < 0) out.add(w);
  }
  return [...out].sort((x, y) => x - y);
}
function itemParam({ a, page, it }) {
  const opts = Array.from({ length: nSteps(it) }, (_, v) => [stepWord(it, v), TABLES[it.t][v]]);
  for (const w of offGrid(a, it)) opts.push([w, wordText(it, w)]);
  opts.sort((x, y) => x[0] - y[0]);
  // a word between steps (from a dump or the Words table) is listed with the step below it
  const withValue = (d) => {
    const w = wordOf(d, it.w);
    return opts.some(([x]) => x === w) ? opts : [...opts, [w, wordText(it, w)]].sort((x, y) => x[0] - y[0]);
  };
  const alg = ALGS.find((x) => x.v === a);
  return {
    key: `a${a}w${it.w}`, group: `Page ${page}`, label: it.name, offset: 1 + 2 * it.w, size: 2, littleEndian: true,
    options: opts, lxp: { pp: it.w },
    help: `${it.name} (${alg.name}, MRC page ${page}, fader ${it.slot % 4 + 1}): ${it.steps} steps; it sets word ${it.w} of the Words table`,
    dynamic: (d) => ({ hidden: algOf(d) !== a, options: withValue(d) }),
  };
}
const ALG_OPTIONS = [...ALGS].sort((x, y) => x.mrc - y.mrc).map((a) => [a.v, a.name]);
/** The name the MRC gives word n in algorithm a (a page item, else the patch Dest list), or null. */
export function wordName(a, n) {
  const alg = ALGS.find((x) => x.v === a);
  if (!alg) return null;
  const it = alg.pages.flatMap((p) => p.items).find((x) => x.w === n);
  if (it) return it.name;
  const dn = alg.dest[n];
  return dn && !/^-+$/.test(dn) && dn !== 'NONE' ? dn : null;
}
function itemFor(a, n) { return ALGS.find((x) => x.v === a)?.pages.flatMap((p) => p.items).find((x) => x.w === n) || null; }
const wordParams = Array.from({ length: WORDS }, (_, n) => ({
  key: `w${n}`, group: 'Words (exact)', label: `Word ${n}`, offset: 1 + 2 * n, size: 2, littleEndian: true, min: 0, max: 0xffff, input: 'number',
  lxp: { pp: n },
  help: `The value the algorithm reads as its parameter ${n} (0-65535)`,
  dynamic: (d) => {
    const nm = wordName(algOf(d), n);
    const it = itemFor(algOf(d), n);
    return { label: `Word ${n}${nm ? ` (${nm})` : ' (no name on the MRC)'}`, format: (w) => (it ? wordText(it, w) : hexw(w)) };
  },
}));
const SRC_OPTIONS = SRC.map(([v, t]) => [v, v === 0x45 ? `${t} (top of the MRC fader)` : t]);
const SCALE_OPTIONS = SCALE.map((t, v) => [v, t]);
const patchParams = [0, 1, 2, 3].flatMap((k) => [
  { key: `src${k}`, group: `Patch ${k + 1}`, label: `SRC${k + 1}`, offset: SRC_AT + k, options: SRC_OPTIONS, lxp: { pp: PP.patch + k },
    help: `Patch ${k + 1} source: controllers 0-31 and 64-95, NOTE, VEL, AFTCH, PBEND, TEMPO, or NONE` },
  ...ALGS.map((a) => ({
    key: `a${a.v}dest${k}`, group: `Patch ${k + 1}`, label: `DEST${k + 1}`, offset: DEST_AT + k, lxp: { pp: PP.patch + 4 + k },
    options: [...a.dest.map((t, v) => [v, t]), [NONE, 'NONE']],
    help: `Patch ${k + 1} destination: the parameter the patch moves, or NONE; the names are the MRC's for ${a.name}`,
    dynamic: (d) => ({ hidden: algOf(d) !== a.v }),
  })),
  { key: `scale${k}`, group: `Patch ${k + 1}`, label: `SCALE${k + 1}`, offset: SCALE_AT + k, options: SCALE_OPTIONS, lxp: { pp: PP.patch + 8 + k },
    help: `Patch ${k + 1} scale: how far the source moves the destination, -200% to +200%` },
]);
export const effectParams = [
  { key: 'alg', group: 'Algorithm', label: 'Algorithm', offset: 0, options: ALG_OPTIONS, relayout: true, lxp: { pp: PP.alg },
    help: 'The MRC algorithm page. The unit changes the algorithm and keeps every other value.' },
  ...ITEMS.map(itemParam),
  ...patchParams,
  ...wordParams,
  ...Array.from({ length: NAME_LEN }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: NAME_AT + i, min: 0, max: 0x7f, kind: 'char', hidden: true, lxp: { pp: PP.name + i } })),
];
const PARAM_BY_KEY = new Map(effectParams.map((p) => [p.key, p]));
export const paramOf = (key) => PARAM_BY_KEY.get(key);
/** The MRC text of word n of setup d (null when the algorithm has no page item for it). */
export function textOfWord(d, n) {
  const it = itemFor(algOf(d), n);
  return it ? wordText(it, wordOf(d, n)) : null;
}
export const findItem = (a, name) => ALGS.find((x) => x.v === a)?.pages.flatMap((p) => p.items).find((it) => it.name === name) || null;

/** Parameter messages that set the active setup to d (algorithm, words, name, patches). */
export function editMessages(d, ch = 0) {
  const out = [algMessage(d[0], ch)];
  for (let n = 0; n < WORDS; n++) out.push(paramMessage(n, wordOf(d, n), ch));
  for (let i = 0; i < NAME_LEN; i++) out.push(paramMessage(PP.name + i, d[NAME_AT + i], ch));
  for (let k = 0; k < 12; k++) out.push(paramMessage(PP.patch + k, d[SRC_AT + k], ch));
  return out;
}

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { setup: romPreset(0), registers: Array.from({ length: 128 }, () => new Uint8Array(SIZE)), program: 0, channel: 0, stored: 0 };
  const setP = (p, v) => {
    if (p < WORDS) setWord(st.setup, p, v);
    else if (p >= 0x20 && p < 0x30) st.setup[NAME_AT + p - 0x20] = v & 0xff;
    else if (p >= 0x30 && p < 0x3c) st.setup[SRC_AT + p - 0x30] = v & 0xff;
    else if (p === PP.alg) st.setup[0] = v & 0xff;
    else if (p === 0x40) { st.program = 0x40; st.setup.set(st.registers[0x40]); }
  };
  const getP = (p) => (p < WORDS ? wordOf(st.setup, p) : p >= 0x20 && p < 0x30 ? st.setup[NAME_AT + p - 0x20]
    : p >= 0x30 && p < 0x3c ? st.setup[SRC_AT + p - 0x30] : p === 0x40 ? st.program : 0);
  return {
    state: st,
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) { if ((d[0] & 15) === st.channel) { st.program = d[1] & 0x7f; st.setup.set(st.registers[st.program]); } return []; }
      if (d[0] !== 0xf0) return null;
      const m = parse(d);
      if (!m || m.ch !== st.channel) return [];
      const ch = st.channel;
      switch (m.kind) {
        case 'param': setP(m.p, m.v); return [];
        case 'setup': if (m.ok) st.setup.set(m.data); return [];
        case 'register': if (m.ok) st.registers[m.n & 0x7f] = Uint8Array.from(m.data); return [];
        case 'all': if (m.ok) for (let i = 0; i < 128; i++) st.registers[i] = m.data.slice(i * SIZE, (i + 1) * SIZE); return [];
        case 'store': st.registers[m.n & 0x7f] = st.setup.slice(); st.stored++; return [];
        case 'load': st.program = m.n & 0x7f; st.setup.set(st.registers[st.program]); return [];
        case 'request':
          if (m.req === REQ.setup) return [Uint8Array.from(setupMessage(st.setup, ch))];
          if (m.req === REQ.register) return [Uint8Array.from(registerMessage(m.arg, st.registers[m.arg & 0x7f], ch))];
          if (m.req === REQ.param) return [Uint8Array.from(param2Message(m.arg, getP(m.arg), ch))];
          if (m.req === REQ.param16) return [Uint8Array.from(paramMessage(m.arg, getP(m.arg), ch))];
          if (m.req === REQ.all) { const a = new Uint8Array(ALL_SIZE); st.registers.forEach((r, i) => a.set(r, i * SIZE)); return [Uint8Array.from(allMessage(a, ch))]; }
          return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor, library
const algName = (d) => algInfo(d)?.name ?? `algorithm ${d[0]}`;
function paramName(p) {
  if (p < WORDS) return `word ${p}`;
  if (p >= 0x20 && p < 0x30) return `name ${p - 0x1f}`;
  if (p >= 0x30 && p < 0x3c) return `patch ${(p - 0x30) % 4 + 1} ${['source', 'destination', 'scale'][Math.floor((p - 0x30) / 4)]}`;
  return { 0x40: 'register (loads 64)', 0x41: 'algorithm' }[p] || `parameter ${p.toString(16)}h`;
}
function describe(raw) {
  const m = parse(raw);
  if (!m) return isLxp(raw) ? 'LXP-1 message' : null;
  const bad = m.ok === false ? ' (checksum error)' : '';
  switch (m.kind) {
    case 'setup': return `LXP-1 active setup "${nameOf(m.data)}" (${algName(m.data)})${bad}`;
    case 'register': return `LXP-1 register ${m.n + 1} "${nameOf(m.data)}" (${algName(m.data)})${bad}`;
    case 'all': return `LXP-1 all 128 registers${bad}`;
    case 'param': return `LXP-1 ${paramName(m.p)} = ${m.p < WORDS ? hexw(m.v) : m.v}`;
    case 'request': return `LXP-1 request: ${{ 0x60: 'active setup', 0x61: `register ${(m.arg ?? 0) + 1}`, 0x62: `parameter ${m.arg} (2n)`, 0x65: `parameter ${m.arg} (5n)`, 0x64: 'all registers' }[m.req] || m.req.toString(16)}`;
    case 'store': return `LXP-1 store the active setup into register ${m.n + 1}`;
    case 'load': return `LXP-1 load register ${m.n + 1}`;
    default: return 'LXP-1 message';
  }
}
function libraryItems(msgs) {
  const items = [];
  for (const raw of msgs) {
    const m = parse(raw);
    if (m?.kind === 'register' && m.ok) items.push({ key: `r${m.n}`, label: `Register ${m.n + 1}`, name: nameOf(m.data), object: 'effect', data: m.data, msgs: [Uint8Array.from(raw)] });
    else if (m?.kind === 'setup' && m.ok) items.push({ key: `e${items.length}`, label: 'Active setup', name: nameOf(m.data), object: 'effect', data: m.data, msgs: [Uint8Array.from(raw)] });
    else if (m?.kind === 'all' && m.ok) {
      for (let i = 0; i < 128; i++) {
        const d = m.data.slice(i * SIZE, (i + 1) * SIZE);
        items.push({ key: `r${i}`, label: `Register ${i + 1}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(registerMessage(i, d, m.ch))] });
      }
    } else if (m?.kind !== 'request') items.push({ key: `x${items.length}`, label: describe(raw) || 'Other message', name: '', object: null, msgs: [raw] });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: REVERB / PLATE / INVERSE / GATE become effects.reverb (time = RTIME / TIME / SLOPE step, pre-delay,
// size, level = FXLVL), DELAY 1 / 2 effects.delay (time, feedback), CHORUS 1 / 2 effects.chorus (rate, depth),
// each as a fraction of the MRC's steps. Exact bytes in extra (family 'lexicon-lxp1'). fromCommon: the same
// family loads the bytes; anything else picks the algorithm, starts from its first ROM preset, sets the steps
// that map and keeps the name of the setup it replaces.
const FAMILY = 'lexicon-lxp1';
function frac(d, name) {
  const it = findItem(algOf(d), name);
  if (!it) return undefined;
  const v = stepOf(it, wordOf(d, it.w));
  if (v < 0) { let b = 0; for (let s = 0; s < it.steps; s++) if (stepWord(it, s) <= wordOf(d, it.w)) b = s; return b / Math.max(1, it.steps - 1); }
  return v / Math.max(1, it.steps - 1);
}
function setFrac(d, name, f, r, what) {
  const it = findItem(algOf(d), name);
  if (!it || f === undefined || f === null || Number.isNaN(f)) return;
  setWord(d, it.w, stepWord(it, Math.round(Math.max(0, Math.min(1, f)) * (it.steps - 1))));
  r?.approximated.push(what || name);
}
const REVERB = { 1: 'Hall', 2: 'Plate', 6: 'Reverse', 7: 'Gate' };
function toCommon(d) {
  const a = algOf(d);
  const effects = {};
  const level = frac(d, 'FXLVL') ?? 1;
  if (REVERB[a]) {
    effects.reverb = { type: REVERB[a], time: frac(d, a === 7 ? 'TIME' : a === 6 ? 'SIZE' : 'RTIME') ?? 0.5, level };
    const pre = frac(d, 'PDLY');
    if (pre !== undefined) effects.reverb.preDelay = pre;
    const size = frac(d, 'SIZE');
    if (size !== undefined && a !== 6) effects.reverb.size = size;
  }
  if (a === 8 || a === 4) {
    effects.delay = { type: algName(d), time: frac(d, a === 8 ? 'DELAY' : 'GPDLY') ?? 0.5, level };
    const fb = frac(d, a === 8 ? 'FDBK3' : 'FDBK');
    if (fb !== undefined) effects.delay.feedback = fb;
  }
  if (a === 3 || a === 5) {
    effects.chorus = { type: algName(d), rate: frac(d, a === 3 ? 'RATE' : 'TUNE') ?? 0.5, level };
    if (a === 3) effects.chorus.depth = frac(d, 'DEPTH');
    effects.modulation = { ...effects.chorus };
  }
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'lexicon-lxp1', algorithm: algName(d), data: Array.from(d.slice(0, SIZE)), match: hashBytes(d.slice(0, SIZE)) } };
}
/** The algorithm for a set of effects (-1: none). */
export function pickAlgorithm(fx) {
  const on = (e) => e && (e.level ?? 1) > 0;
  const md = [fx.chorus, fx.modulation].find(on);
  if (md) return /DETUN|PITCH|SHIFT|FLANG/i.test(String(md.type || '')) ? 5 : 3;
  if (on(fx.reverb)) {
    const t = String(fx.reverb.type || '');
    return /PLATE/i.test(t) ? 2 : /GATE/i.test(t) ? 7 : /REV|INVERS/i.test(t) && !/REVERB/i.test(t) ? 6 : 1;
  }
  if (on(fx.delay)) return 8;
  return -1;
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
    const d = Uint8Array.from(x.data, (b) => b & 0xff);
    r.mapped.push(`Setup (exact, ${algName(d)})`);
    return { data: d, report: tidy(r) };
  }
  const fx = c?.effects || {};
  const a = pickAlgorithm(fx);
  if (a < 0) {
    r.dropped.push('No effect in the source sound: the setup keeps its algorithm and settings');
    return { data: Uint8Array.from(base || romPreset(0)), report: tidy(r) };
  }
  const n = Math.max(0, PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === a));
  const d = romPreset(n);
  r.approximated.push(`Algorithm ${ALGS.find((g) => g.v === a).name}, starting from ROM preset ${n + 1}`);
  if (fx.reverb && REVERB[a]) {
    setFrac(d, a === 7 ? 'TIME' : a === 6 ? 'SIZE' : 'RTIME', fx.reverb.time, r, 'Reverb time');
    setFrac(d, 'PDLY', fx.reverb.preDelay, r, 'Pre-delay');
    if (a !== 6) setFrac(d, 'SIZE', fx.reverb.size, r, 'Room size');
    setFrac(d, 'FXLVL', fx.reverb.level, r, 'Effect level');
  }
  if (fx.delay && (a === 8 || a === 4)) {
    setFrac(d, a === 8 ? 'DELAY' : 'GPDLY', fx.delay.time, r, 'Delay time');
    setFrac(d, a === 8 ? 'FDBK3' : 'FDBK', fx.delay.feedback, r, 'Delay feedback');
  }
  const m = [fx.chorus, fx.modulation].find((e) => e && (e.level ?? 1) > 0);
  if (m && a === 3) { setFrac(d, 'RATE', m.rate, r, 'Chorus rate'); setFrac(d, 'DEPTH', m.depth, r, 'Chorus depth'); }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
  if (base) for (let i = 0; i < NAME_LEN; i++) d[NAME_AT + i] = base[NAME_AT + i];
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ definition
const chOf = (ctx) => (ctx?.channel ?? 0) & 15;
const isSetup = (r) => parse(r)?.kind === 'setup';
async function fetchRegister(api, n) {
  return api.request(requestMessage(REQ.register, n, chOf(api.ctx)), (r) => { const m = parse(r); return m?.kind === 'register' && m.n === n; }, (r) => parse(r).data);
}
function sendParam(p, v, d, ctx) {
  if (!p.lxp) return null;
  return paramMessage(p.lxp.pp, v, chOf(ctx));
}
const groupInfo = {
  'Words (exact)': { table: true, note: 'The ten 16-bit words of the setup as typed numbers (0-65535). Each algorithm reads them its own way; the MRC pages above set them in steps. A word with no MRC name is on no page and in no patch Dest list of the algorithm.' },
  'Page 1': { note: 'MRC page 1 (four faders).' },
  'Page 2': { note: 'MRC page 2.' },
};
export default {
  coverage: 'Edits the LXP-1\'s active setup (the eight algorithms with the page names and fader value texts of the Lexicon MRC remote; the ten parameter words also as exact numbers; four patches; the name) and its 128 registers, and shows the 16 ROM presets. Sends each change as you make it, reads the setup and the registers, stores and loads registers. Not checked on hardware.',
  sysex: { manufacturer: [0x06], model: 0x02 },
  minGap: 20,
  describe,
  recognise: (raw) => isLxp(raw),
  isOwn: isLxp,
  isRequest,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Setup', icon: '◆', label: 'Active setup', size: SIZE,
      init: () => romPreset(0),
      request: (ctx) => requestMessage(REQ.setup, null, chOf(ctx)),
      match: isSetup,
      decode: (raw) => parse(raw).data,
      receive: (raw) => { const m = parse(raw); return m?.ok && (m.kind === 'setup' || m.kind === 'register') ? m.data : null; },
      params: effectParams,
      groupInfo,
      sendParam,
      name: nameOf,
      setName,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 4,
      note: 'The LXP-1 has no display: the names and value texts are those of the Lexicon MRC remote. Each change is sent at once, as the MRC sends it. Get reads the active setup; Send writes it to the unit.',
      toSyx: (data, ctx) => setupMessage(data, chOf(ctx)),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.ok && (m.kind === 'setup' || m.kind === 'register')) return m.data; } return null; },
      sendAll: { label: 'Send to the active setup', build: (data, ctx) => [setupMessage(data, chOf(ctx))] },
      actions: [
        { label: 'Store into register', title: 'Send this setup, then store the active setup into a register', run: async (api) => {
          const r = await api.form('Store into register', [{ key: 'n', label: 'Register (1-128)', value: 1, type: 'number', min: 1, max: 128 }]);
          if (!r) return;
          const n = Math.max(1, Math.min(128, Number(r.n) || 1)) - 1;
          api.send([setupMessage(api.data, chOf(api.ctx)), storeMessage(n, chOf(api.ctx))]);
        } },
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Name', [{ key: 'name', label: 'Name (the MRC shows 8 characters; the unit keeps 16)', value: nameOf(api.data), maxlength: NAME_LEN }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name, NAME_LEN);
          api.setData(d);
        } },
      ],
      slots: {
        label: 'Registers and presets', banks: [[0, 'Registers 1-128'], [1, 'Presets 1-16 (ROM)']],
        count: (bank) => (bank ? PRESETS.length : 128),
        slotLabel: (bank, i) => `${bank ? 'P' : 'R'}${i + 1}`,
        note: (bank) => (bank ? 'ROM presets (programs 128-143 of the unit, reached only from its panel): Edit loads one from the editor\'s own copy; Play sends it to the unit as the active setup.'
          : 'Edit reads the register; Store writes it; Play loads it (a program change does the same).'),
        names: (bank) => (bank === 1 ? PRESET_NAMES : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => [bank ? setupMessage(romPreset(i), chOf(ctx)) : loadMessage(i, chOf(ctx))],
        fetch: async (api, bank, i) => (bank === 1 ? romPreset(i) : fetchRegister(api, i)),
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { PRESET_NAMES.forEach((s, i) => onName(i, s)); return; }
          for (let i = 0; i < 128; i++) onName(i, nameOf(await fetchRegister(api, i)));
        },
        store: (_bank, i, ctx, data) => [registerMessage(i, data, chOf(ctx))],
      },
    },
  ],
  midiNotes: [
    'SysEx F0 06 02 <function, channel> ... F7 on the unit\'s MIDI channel (set on its panel).',
    'Requests (3n): 60 active setup, 61 rr register, 62 pp parameter (answered as 2n pp hb lo hi), 65 pp parameter (answered as 5n pp + four nibbles), 64 all registers.',
    'Dumps are sent in groups of eight bytes: one holding bit 7 of the next seven, then the seven. The count byte 38h is the number of bytes sent (56 = 49 data bytes).',
    'Parameter 40h loads register 64 whatever value it carries (the firmware passes the parameter number): the editor loads registers with 6n 71 rr.',
    'The ROM presets (programs 128-143) are reached only from the panel; the editor sends them as setup dumps.',
  ],
};

export const _test = { simulate, toCommon, fromCommon, sendParam, describe, libraryItems };
