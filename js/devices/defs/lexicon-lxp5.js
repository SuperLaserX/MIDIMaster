// Lexicon LXP-5 (1989 half-rack multi-effects, pitch / delay / reverb): MIDI implementation from the v1.12 EPROM
// ("LXP5 Version 1.12 Copyright 1989 Lexicon, Inc."; 32 KB, Z80). See docs/devices/lexicon-lxp5.md.
//
// The LXP-5 shows only a program number: its parameters are shown on the Lexicon MRC (MIDI Remote Controller).
// The names and every value text here are the MRC's screens (v4.00 EPROMs: its LXP-5 module, display routines run
// for every value, the delay coarse / FINE pairs for every pair of values); the bytes and messages are the
// LXP-5's own (receiver 2A2F, dispatcher 0161, parameter setter 0AEB).
//
// The active setup is 94 bytes (A971h): 0 algorithm (1 DLY/RVB, 2 PTCH/DLY, 3 the BYPASS preset), 1-23 parameters
// 0-22, 24-31 values the unit works out (parameters 17h-1Eh), 32-44 the name (11 characters, 0, one more byte),
// 45-64 four patches of five bytes (Src, Thrsh, Dest, Scale, a byte the unit works out from Scale), 65-93 the
// settings (40h program, 42h algorithm, 46h-5Ch a MIDI source for each of parameters 0-22). A register (and a
// ROM preset) is 57 bytes: algorithm, parameters 0-22, name block, patches. Parameter p is setup byte p + 1.
//
// SysEx F0 06 05 <fn n> ... F7 (Lexicon, LXP-5; n = MIDI channel). Data bytes are 7-bit; cs = their sum AND 7Fh.
//   0n 5E <94> cs        active setup               1n rr 39 <57> cs   register rr (0-127)
//   4n 39 00 <7296> cs   all 128 registers          2n pp vv           parameter pp = vv
//   3n 60 / 61 rr / 62 pp / 64   requests           6n 70 rr / 71 rr   store into / load register rr

import { FIRMWARE, ALGS, TABLES, PAIRS, PATCH, PRESETS } from './lexicon-lxp5-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { readParam, writeParam } from '../../core/model/memmap.js';
import { hashBytes, tidy } from './translate-helpers.js';

export { FIRMWARE, ALGS, TABLES, PAIRS, PATCH, PRESETS };

export const SIZE = 57;            // register, ROM preset, the editor's setup object
export const SETUP_SIZE = 94;      // the active setup (0n dump)
export const ALL_SIZE = 128 * SIZE;
export const SET_AT = 65;          // settings: setup bytes 65-93 (parameters 40h-5Ch)
export const SET_SIZE = SETUP_SIZE - SET_AT;
export const NAME_AT = 24;         // register offsets
export const NAME_LEN = 11;
export const MRC_NAME_LEN = 8;
export const PATCH_AT = 37;
export const PP = { name: 0x1f, patch: 0x2c, program: 0x40, alg: 0x42, source: 0x46 };
export const REQ = { setup: 0x60, register: 0x61, param: 0x62, all: 0x64 };
const NONE = 0x7f;

// ------------------------------------------------------------------ messages
export const isLxp = (raw) => raw?.[0] === 0xf0 && raw.length > 5 && raw[1] === 0x06 && raw[2] === 0x05;
const hdr = (f, ch = 0) => [0xf0, 0x06, 0x05, (f << 4) | (ch & 15)];
export const checksum = (d) => d.reduce((s, b) => s + (b & 0x7f), 0) & 0x7f;
const clean = (d, n) => Array.from({ length: n }, (_, i) => (d[i] ?? 0) & 0x7f);
export const setupMessage = (d, ch = 0) => { const x = clean(d, SETUP_SIZE); return [...hdr(0, ch), 0x5e, ...x, checksum(x), 0xf7]; };
export const registerMessage = (n, d, ch = 0) => { const x = clean(d, SIZE); return [...hdr(1, ch), n & 0x7f, 0x39, ...x, checksum(x), 0xf7]; };
export const allMessage = (d, ch = 0) => { const x = clean(d, ALL_SIZE); return [...hdr(4, ch), 0x39, 0x00, ...x, checksum(x), 0xf7]; };
export const paramMessage = (pp, v, ch = 0) => [...hdr(2, ch), pp & 0x7f, v & 0x7f, 0xf7];
export const requestMessage = (kind, arg = null, ch = 0) => [...hdr(3, ch), kind, ...(arg == null ? [] : [arg & 0x7f]), 0xf7];
export const storeMessage = (n, ch = 0) => [...hdr(6, ch), 0x70, n & 0x7f, 0xf7];
export const loadMessage = (n, ch = 0) => [...hdr(6, ch), 0x71, n & 0x7f, 0xf7];

export function parse(raw) {
  if (!isLxp(raw) || raw.at(-1) !== 0xf7) return null;
  const a = Array.from(raw);
  const ch = a[3] & 15;
  const body = (from, n) => {
    if (a.length !== from + n + 2) return null;
    const data = Uint8Array.from(a.slice(from, from + n));
    return { data, ok: checksum(data) === a[from + n] };
  };
  switch (a[3] >> 4) {
    case 0: { const b = a[4] === 0x5e ? body(5, SETUP_SIZE) : null; return b && { kind: 'setup', ch, ...b }; }
    case 1: { const b = a[5] === 0x39 ? body(6, SIZE) : null; return b && { kind: 'register', ch, n: a[4], ...b }; }
    case 4: { const b = a[4] === 0x39 && a[5] === 0 ? body(6, ALL_SIZE) : null; return b && { kind: 'all', ch, ...b }; }
    case 2: return a.length === 7 ? { kind: 'param', ch, p: a[4], v: a[5] } : null;
    case 3: return (a[4] & 0x78) === 0x60 ? { kind: 'request', ch, req: a[4] & 0x67, arg: a.length > 6 ? a[5] : null } : null;
    case 6: return a[4] === 0x70 || a[4] === 0x71 ? { kind: a[4] === 0x70 ? 'store' : 'load', ch, n: a[5] } : null;
    default: return null;
  }
}
export const isRequest = (raw) => parse(raw)?.kind === 'request';

// ------------------------------------------------------------------ setups, registers, presets
/** Setup (94) -> register form (57). */
export const registerOf = (s) => Uint8Array.from([...s.slice(0, 24), ...s.slice(32, 45), ...s.slice(45, 65)]);
/** Register offset of parameter p (null for the work and settings parameters). */
export function offsetOf(p) {
  if (p < 0x17) return 1 + p;
  if (p >= 0x1f && p < 0x40) return p - 7;
  return null;
}
export const algOf = (d) => d[0];
export const algInfo = (d) => ALGS.find((a) => a.v === d[0]) || null;
export const nameOf = (d) => String.fromCharCode(...Array.from(d.slice(NAME_AT, NAME_AT + NAME_LEN)).filter((c) => c)).replace(/[^\x20-\x7e]/g, ' ').trimEnd();
export function setName(d, name, len = MRC_NAME_LEN) {
  const s = String(name).replace(/[^\x20-\x7e]/g, ' ').slice(0, len).padEnd(len, ' ');
  for (let i = 0; i < len; i++) d[NAME_AT + i] = s.charCodeAt(i);
}
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
export const romPreset = (i) => hex(PRESETS[i][1]);
export const PRESET_NAMES = PRESETS.map((p) => p[0]);

// ------------------------------------------------------------------ MRC texts
const PAIR_CACHE = new Map();
/** Texts of a coarse / FINE pair table: index coarse x 128 + fine. */
export function pairTexts(i) {
  let t = PAIR_CACHE.get(i);
  if (!t) { t = PAIRS[i].rle.flatMap(([s, n]) => Array(n).fill(s)); PAIR_CACHE.set(i, t); }
  return t;
}
/** The MRC text of item it for the bytes of register d (null when a value is outside the MRC's range). */
export function itemText(it, d) {
  if (it.pair != null) {
    const c = d[offsetOf(it.coarseSlot < 8 ? it.coarseSlot : it.coarseSlot + 1)];
    const f = d[offsetOf(it.fineSlot < 8 ? it.fineSlot : it.fineSlot + 1)];
    return c < PAIRS[it.pair].coarse && f < 128 ? pairTexts(it.pair)[c * 128 + f] : null;
  }
  const v = itemValue(it, d);
  return TABLES[it.t][v] ?? null;
}
/** The MRC fader value of an item: the byte, or for PITCH 0 (OFF) / interval + 1. */
export function itemValue(it, d) {
  if (it.send === 'pitch') return d[offsetOf(it.p - 1)] ? d[offsetOf(it.p)] + 1 : 0;
  return d[offsetOf(it.p)];
}

// ------------------------------------------------------------------ setup parameters
const ITEMS = [];
for (const a of ALGS) a.pages.forEach((pg, pi) => pg.items.forEach((it) => ITEMS.push({ a: a.v, page: pi + 1, label: pg.label, it })));
const pageGroup = (page) => `Page ${page}`;
function options(n, text) { return Array.from({ length: n }, (_, v) => [v, text(v) ?? String(v)]); }
function withValue(opts, v, text) { return opts.some(([x]) => x === v) ? opts : [...opts, [v, `${text ?? v} (outside the MRC range)`]].sort((x, y) => x[0] - y[0]); }
function itemParam({ a, page, it }) {
  const alg = ALGS.find((x) => x.v === a);
  const key = `a${a}p${page}s${it.slot}`;
  const base = {
    key, group: pageGroup(page), label: it.name, lxp: { pp: it.p },
    help: `${it.name} (${alg.name}, MRC page ${page}): parameter ${it.p}, ${it.steps} steps`,
  };
  if (it.send === 'pitch') {
    const o8 = offsetOf(it.p - 1);
    const o9 = offsetOf(it.p);
    return {
      ...base, offset: o8, size: 2, min: 0, max: 127,
      get: (d) => (d[o8] ? d[o9] + 1 : 0),
      set: (d, v) => { if (v === 0) d[o8] = 0; else { d[o8] = 1; d[o9] = v - 1; } },
      options: options(it.steps, (v) => TABLES[it.t][v]),
      send: (v, ctx) => (v === 0 ? paramMessage(it.p - 1, 0, chOf(ctx)) : [paramMessage(it.p - 1, 1, chOf(ctx)), paramMessage(it.p, v - 1, chOf(ctx))]),
      help: `${it.name} (${alg.name}, MRC page ${page}): parameter ${it.p - 1} switches it on or OFF, parameter ${it.p} holds the interval (as the MRC sends them)`,
      dynamic: (d) => ({ hidden: algOf(d) !== a }),
    };
  }
  const off = offsetOf(it.p);
  if (it.pair != null) {
    const P = PAIRS[it.pair];
    const isCoarse = it.slot === it.coarseSlot;
    const oc = offsetOf(it.coarseSlot < 8 ? it.coarseSlot : it.coarseSlot + 1);
    const of = offsetOf(it.fineSlot < 8 ? it.fineSlot : it.fineSlot + 1);
    const n = isCoarse ? P.coarse : 128;
    const text = (d, v) => { const c = isCoarse ? v : d[oc]; const f = isCoarse ? d[of] : v; return c < P.coarse && f < 128 ? pairTexts(it.pair)[c * 128 + f] : null; };
    return {
      ...base, offset: off, min: 0, max: 127, options: options(n, (v) => text(new Uint8Array(SIZE), v)),
      help: `${base.help}; read with ${isCoarse ? 'its FINE value' : 'the coarse value'} as one time`,
      dynamic: (d) => ({ hidden: algOf(d) !== a, options: withValue(options(n, (v) => text(d, v)), d[off], text(d, d[off])) }),
    };
  }
  return {
    ...base, offset: off, min: 0, max: 127, options: options(it.steps, (v) => TABLES[it.t][v]),
    dynamic: (d) => ({ hidden: algOf(d) !== a, options: withValue(options(it.steps, (v) => TABLES[it.t][v]), d[off], null) }),
  };
}
const ALG_OPTIONS = [...ALGS].sort((x, y) => x.mrc - y.mrc).map((a) => [a.v, a.name]).concat([[3, 'BYPASS (ROM preset 65, not on the MRC)']]);
const SRC_OPTIONS = PATCH.src.map(([v, t]) => [v, v === 0x47 ? `${t} (top of the MRC fader)` : t]);
const destValue = (i) => PATCH.destRemap[String(i)] ?? i;
function destOptions(a) {
  const names = PATCH.dest[ALGS.find((x) => x.v === a)?.mrc ?? 0];
  return names.map(([i, t]) => [i === NONE ? NONE : destValue(i), t]);
}
const patchParams = [0, 1, 2, 3].flatMap((k) => {
  const at = PATCH_AT + 5 * k;
  const pp = PP.patch + 5 * k;
  const h = (_f, what) => `Patch ${k + 1} ${what}`;
  return [
    { key: `src${k}`, group: `Patch ${k + 1}`, label: `SRC${k + 1}`, offset: at, options: SRC_OPTIONS, lxp: { pp }, help: h(0, 'source, or NONE') },
    { key: `thr${k}`, group: `Patch ${k + 1}`, label: `THRSH${k + 1}`, offset: at + 1, options: PATCH.thresh.map((t, v) => [v, t]), lxp: { pp: pp + 1 }, help: h(1, 'threshold') },
    ...ALGS.map((a) => ({
      key: `a${a.v}dest${k}`, group: `Patch ${k + 1}`, label: `DEST${k + 1}`, offset: at + 2, options: destOptions(a.v), lxp: { pp: pp + 2 },
      help: `${h(2, 'destination')}: the parameter the patch moves (the MRC sends its Dest 23-26 as the Scale of patches 1-4); names from the MRC for ${a.name}`,
      dynamic: (d) => ({ hidden: algOf(d) !== a.v, options: withValue(destOptions(a.v), d[at + 2], null) }),
    })),
    { key: `scale${k}`, group: `Patch ${k + 1}`, label: `SCAL${k + 1}`, offset: at + 3, options: PATCH.scale.map((t, v) => [v, t]), lxp: { pp: pp + 3 }, help: h(3, 'scale') },
    { key: `pw${k}`, group: 'Bytes (exact)', label: `Patch ${k + 1} byte 5`, offset: at + 4, min: 0, max: 127, input: 'number', readOnly: true,
      help: 'Worked out by the unit from the Scale (writing the Scale sets it); not on the MRC' },
  ];
});
const byteParams = [
  ...Array.from({ length: 0x17 }, (_, p) => ({
    key: `b${p}`, group: 'Bytes (exact)', label: `Parameter ${p}`, offset: 1 + p, min: 0, max: 127, input: 'number', lxp: { pp: p },
    help: `Parameter ${p} as a typed number`,
    dynamic: (d) => {
      const it = ALGS.find((x) => x.v === algOf(d))?.pages.flatMap((pg) => pg.items).find((x) => x.p === p || (x.send === 'pitch' && x.p - 1 === p));
      return { label: `Parameter ${p}${it ? ` (${it.send === 'pitch' && it.p - 1 === p ? `${it.name} on` : it.name})` : ' (on no MRC page)'}` };
    },
  })),
  { key: 'b2b', group: 'Bytes (exact)', label: 'Byte after the name', offset: 36, min: 0, max: 127, input: 'number', lxp: { pp: 0x2b },
    help: 'The value after the 11 name characters and their end mark: kept in every register and ROM preset; no screen names it' },
];
export const effectParams = [
  { key: 'alg', group: 'Algorithm', label: 'Algorithm', offset: 0, options: ALG_OPTIONS, relayout: true, lxp: { pp: PP.alg },
    help: 'The MRC algorithm page, sent as the MRC sends it.' },
  ...ITEMS.map(itemParam),
  ...patchParams,
  ...byteParams,
  ...Array.from({ length: NAME_LEN + 1 }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: NAME_AT + i, min: 0, max: 0x7f, kind: 'char', hidden: true, lxp: { pp: PP.name + i } })),
];
const PARAM_BY_KEY = new Map(effectParams.map((p) => [p.key, p]));
export const paramOf = (key) => PARAM_BY_KEY.get(key);
export const findItem = (a, name, page) => ITEMS.find((x) => x.a === a && x.it.name === name && (page == null || x.page === page))?.it || null;

/** Parameter messages that set the active setup to register d (algorithm first, as the MRC sends a setup). */
export function editMessages(d, ch = 0) {
  const out = [paramMessage(PP.alg, d[0], ch)];
  for (let p = 0; p < 0x17; p++) out.push(paramMessage(p, d[1 + p], ch));
  for (let p = PP.name; p < 0x40; p++) if ((p - PP.patch) % 5 !== 4 || p < PP.patch) out.push(paramMessage(p, d[offsetOf(p)], ch));
  return out;
}

// ------------------------------------------------------------------ settings (setup bytes 65-93)
function bothNames(p) {
  const n = [...new Set(ALGS.map((a) => paramNameFor(a.v, p)).filter(Boolean))];
  return n.length ? ` (${n.join(' / ')})` : '';
}
const paramNameFor = (a, p) => ALGS.find((x) => x.v === a)?.pages.flatMap((pg) => pg.items).find((x) => x.p === p || (x.send === 'pitch' && x.p - 1 === p))?.name;
export const settingsParams = [
  { key: 'program', group: 'Program', label: 'Program loaded', offset: 0, min: 0, max: 127, input: 'number', readOnly: true,
    help: 'The program the unit loaded. Writing it would load that register, so the editor only shows it.' },
  { key: 'x41', group: 'Program', label: 'Parameter 41h', offset: 1, min: 0, max: 127, input: 'number', readOnly: true, help: 'No screen names it; shown as stored.' },
  { key: 'algcopy', group: 'Program', label: 'Algorithm (copy)', offset: 2, options: ALG_OPTIONS, readOnly: true, help: 'The algorithm as the unit keeps it here; it copies it to the Algorithm of the setup.' },
  ...[0x43, 0x44, 0x45].map((p) => ({ key: `x${p.toString(16)}`, group: 'Program', label: `Parameter ${p.toString(16)}h`, offset: p - 0x40, min: 0, max: 127, input: 'number', readOnly: true, help: 'No screen names it; shown as stored.' })),
  ...Array.from({ length: 0x17 }, (_, i) => ({
    key: `ms${i}`, group: 'MIDI sources', label: `Parameter ${i}${bothNames(i)}`, offset: 6 + i, options: SRC_OPTIONS, lxp: { pp: PP.source + i },
    help: `The MIDI source that moves parameter ${i} directly, or NONE; source names from the MRC patch Src list`,
  })),
];

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { setup: new Uint8Array(SETUP_SIZE), registers: Array.from({ length: 128 }, () => new Uint8Array(SIZE)), stored: 0 };
  const load = (r) => { st.setup.set(r.slice(0, 24), 0); st.setup.set(r.slice(24, 37), 32); st.setup.set(r.slice(37, 57), 45); st.setup[67] = r[0]; };
  load(romPreset(0));
  st.setup.fill(NONE, 71, 94);
  const setP = (p, v) => {
    if (p === PP.alg) { st.setup[0] = v; st.setup[67] = v; } else if (p === PP.program) { st.setup[65] = v; load(st.registers[v & 0x7f]); } else if (p < 0x5d) st.setup[p + 1] = v;
  };
  return {
    state: st,
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) { st.setup[65] = d[1] & 0x7f; load(st.registers[d[1] & 0x7f]); return []; }
      if (d[0] !== 0xf0) return null;
      const m = parse(d);
      if (!m || m.ch !== 0) return [];
      switch (m.kind) {
        case 'param': setP(m.p, m.v); return [];
        case 'setup': if (m.ok) st.setup.set(m.data); return [];
        case 'register': if (m.ok) st.registers[m.n & 0x7f] = Uint8Array.from(m.data); return [];
        case 'all': if (m.ok) for (let i = 0; i < 128; i++) st.registers[i] = m.data.slice(i * SIZE, (i + 1) * SIZE); return [];
        case 'store': st.registers[m.n & 0x7f] = registerOf(st.setup); st.stored++; return [];
        case 'load': st.setup[65] = m.n & 0x7f; load(st.registers[m.n & 0x7f]); return [];
        case 'request':
          if (m.req === REQ.setup) return [Uint8Array.from(setupMessage(st.setup))];
          if (m.req === REQ.register) return [Uint8Array.from(registerMessage(m.arg, st.registers[m.arg & 0x7f]))];
          if (m.req === REQ.param) return [Uint8Array.from(paramMessage(m.arg, st.setup[m.arg + 1] ?? 0))];
          if (m.req === REQ.all) { const a = new Uint8Array(ALL_SIZE); st.registers.forEach((r, i) => a.set(r, i * SIZE)); return [Uint8Array.from(allMessage(a))]; }
          return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor, library
const algName = (d) => algInfo(d)?.name ?? (d[0] === 3 ? 'BYPASS' : `algorithm ${d[0]}`);
function describe(raw) {
  const m = parse(raw);
  if (!m) return isLxp(raw) ? 'LXP-5 message' : null;
  const bad = m.ok === false ? ' (checksum error)' : '';
  switch (m.kind) {
    case 'setup': return `LXP-5 active setup "${nameOf(registerOf(m.data))}" (${algName(m.data)})${bad}`;
    case 'register': return `LXP-5 register ${m.n + 1} "${nameOf(m.data)}" (${algName(m.data)})${bad}`;
    case 'all': return `LXP-5 all 128 registers${bad}`;
    case 'param': return `LXP-5 parameter ${m.p.toString(16)}h = ${m.v}`;
    case 'request': return `LXP-5 request: ${{ 0x60: 'active setup', 0x61: `register ${(m.arg ?? 0) + 1}`, 0x62: `parameter ${m.arg}`, 0x64: 'all registers' }[m.req] || m.req.toString(16)}`;
    case 'store': return `LXP-5 store the active setup into register ${m.n + 1}`;
    case 'load': return `LXP-5 load register ${m.n + 1}`;
    default: return 'LXP-5 message';
  }
}
function libraryItems(msgs) {
  const items = [];
  for (const raw of msgs) {
    const m = parse(raw);
    if (m?.kind === 'register' && m.ok) items.push({ key: `r${m.n}`, label: `Register ${m.n + 1}`, name: nameOf(m.data), object: 'effect', data: m.data, msgs: [Uint8Array.from(raw)] });
    else if (m?.kind === 'setup' && m.ok) {
      const r = registerOf(m.data);
      items.push({ key: `e${items.length}`, label: 'Active setup', name: nameOf(r), object: 'effect', data: r, msgs: [Uint8Array.from(raw)] });
      items.push({ key: `s${items.length}`, label: 'Settings (from the active setup)', name: '', object: 'system', data: m.data.slice(SET_AT), msgs: [Uint8Array.from(raw)] });
    } else if (m?.kind === 'all' && m.ok) {
      for (let i = 0; i < 128; i++) {
        const d = m.data.slice(i * SIZE, (i + 1) * SIZE);
        items.push({ key: `r${i}`, label: `Register ${i + 1}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(registerMessage(i, d, m.ch))] });
      }
    } else if (m?.kind !== 'request') items.push({ key: `x${items.length}`, label: describe(raw) || 'Other message', name: '', object: null, msgs: [raw] });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: DLY/RVB becomes effects.delay (DELAY, FDBK) and effects.reverb (RTIME, SIZE, PREDLY, RLVL); PTCH/DLY
// effects.pitch (PITCH on: the interval), effects.delay (MDELAY, MFDBK) and effects.reverb; each value as a
// fraction of the MRC's steps. Exact bytes in extra (family 'lexicon-lxp5'). fromCommon: the same family loads
// the bytes; anything else picks the algorithm (pitch -> PTCH/DLY), starts from its first ROM preset, sets what
// maps and keeps the name of the register it replaces.
const FAMILY = 'lexicon-lxp5';
function frac(d, name) {
  const it = findItem(algOf(d), name);
  if (!it) return undefined;
  const v = it.send === 'pitch' ? itemValue(it, d) : d[offsetOf(it.p)];
  const n = it.pair != null && it.slot === it.coarseSlot ? PAIRS[it.pair].coarse : it.steps;
  return Math.max(0, Math.min(1, v / Math.max(1, n - 1)));
}
function setFrac(d, name, f, r, what) {
  const it = findItem(algOf(d), name);
  if (!it || f === undefined || f === null || Number.isNaN(f)) return;
  const n = it.pair != null && it.slot === it.coarseSlot ? PAIRS[it.pair].coarse : it.steps;
  d[offsetOf(it.p)] = Math.round(Math.max(0, Math.min(1, f)) * (n - 1));
  r?.approximated.push(what || name);
}
function toCommon(d) {
  const a = algOf(d);
  const effects = {};
  if (a === 1 || a === 2) {
    effects.reverb = { type: 'Room', time: frac(d, 'RTIME') ?? 0.5, level: frac(d, 'RLVL') ?? 1, size: frac(d, 'SIZE') };
    if (a === 1) effects.reverb.preDelay = frac(d, 'PREDLY');
    effects.delay = { type: algName(d), time: frac(d, a === 1 ? 'DELAY' : 'MDELAY') ?? 0.5, feedback: frac(d, a === 1 ? 'FDBK' : 'MFDBK'), level: 1 };
    if (a === 2) {
      const it = findItem(2, 'PITCH');
      const v = itemValue(it, d);
      if (v) effects.pitch = { type: TABLES[it.t][v], level: 1 };
    }
  }
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'lexicon-lxp5', algorithm: algName(d), data: Array.from(d.slice(0, SIZE)), match: hashBytes(d.slice(0, SIZE)) } };
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
    const d = Uint8Array.from(x.data, (b) => b & 0x7f);
    r.mapped.push(`Register (exact, ${algName(d)})`);
    return { data: d, report: tidy(r) };
  }
  const fx = c?.effects || {};
  const on = (e) => e && (e.level ?? 1) > 0;
  const a = on(fx.pitch) || /PITCH|SHIFT|OCTAV|HARMON/i.test(String(fx.modulation?.type || '')) ? 2 : on(fx.reverb) || on(fx.delay) ? 1 : -1;
  if (a < 0) {
    r.dropped.push('No effect in the source sound: the register keeps its algorithm and settings');
    return { data: Uint8Array.from(base || romPreset(56)), report: tidy(r) };
  }
  const n = PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === a);
  const d = romPreset(n);
  r.approximated.push(`Algorithm ${ALGS.find((g) => g.v === a).name}, starting from ROM preset ${n + 1} (${PRESET_NAMES[n]})`);
  if (fx.reverb) { setFrac(d, 'RTIME', fx.reverb.time, r, 'Reverb time'); setFrac(d, 'SIZE', fx.reverb.size, r, 'Room size'); setFrac(d, 'RLVL', fx.reverb.level, r, 'Reverb level'); if (a === 1) setFrac(d, 'PREDLY', fx.reverb.preDelay, r, 'Pre-delay'); }
  if (fx.delay) { setFrac(d, a === 1 ? 'DELAY' : 'MDELAY', fx.delay.time, r, 'Delay time'); setFrac(d, a === 1 ? 'FDBK' : 'MFDBK', fx.delay.feedback, r, 'Delay feedback'); }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'pitch', 'modulation'].includes(k)) r.dropped.push(`Effect ${k}`);
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
  'Bytes (exact)': { table: true, note: 'Parameters 0-22 as typed numbers (the MRC pages above set them in its steps), the byte after the name and the bytes the unit works out from each patch Scale.' },
};
export default {
  coverage: 'Edits the LXP-5\'s active setup (both algorithms with every page of the Lexicon MRC remote and its value texts, the delay coarse / FINE pairs read as one time, the four patches, the name), its settings (a MIDI source for each parameter) and its 128 registers, and shows the 65 ROM presets. Sends each change as you make it, reads the setup and the registers, stores and loads registers. Not checked on hardware.',
  sysex: { manufacturer: [0x06], model: 0x05 },
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
      init: () => romPreset(56),
      request: (ctx) => requestMessage(REQ.setup, null, chOf(ctx)),
      match: isSetup,
      decode: (raw) => registerOf(parse(raw).data),
      receive: (raw) => { const m = parse(raw); return m?.ok ? (m.kind === 'setup' ? registerOf(m.data) : m.kind === 'register' ? m.data : null) : null; },
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
      note: 'The LXP-5 shows only a program number: the names and value texts are those of the Lexicon MRC remote. Each change is sent at once, as the MRC sends it. Get reads the active setup; Send sets it value by value.',
      toSyx: (data, ctx) => editMessages(data, chOf(ctx)).flat(),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.ok && m.kind === 'setup') return registerOf(m.data); if (m?.ok && m.kind === 'register') return m.data; } return null; },
      sendAll: { label: 'Send to the active setup', build: (data, ctx) => editMessages(data, chOf(ctx)) },
      actions: [
        { label: 'Store into register', title: 'Send this setup value by value, then store the active setup into a register', run: async (api) => {
          const r = await api.form('Store into register', [{ key: 'n', label: 'Register (1-128)', value: 1, type: 'number', min: 1, max: 128 }]);
          if (!r) return;
          const n = Math.max(1, Math.min(128, Number(r.n) || 1)) - 1;
          api.send([...editMessages(api.data, chOf(api.ctx)), storeMessage(n, chOf(api.ctx))]);
        } },
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Name', [{ key: 'name', label: 'Name (the MRC shows 8 characters; the unit keeps 11)', value: nameOf(api.data), maxlength: NAME_LEN }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name, NAME_LEN);
          api.setData(d);
        } },
      ],
      slots: {
        label: 'Registers and presets', banks: [[0, 'Registers 1-128'], [1, 'Presets 1-65 (ROM)']],
        count: (bank) => (bank ? PRESETS.length : 128),
        slotLabel: (bank, i) => `${bank ? 'P' : 'R'}${i + 1}`,
        note: (bank) => (bank ? 'ROM presets (programs 128-192, from the panel): Edit loads one from the editor\'s own copy; Play sends it to the unit value by value.'
          : 'Edit reads the register; Store writes it; Play loads it.'),
        names: (bank) => (bank === 1 ? PRESET_NAMES : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => (bank ? editMessages(romPreset(i), chOf(ctx)) : [loadMessage(i, chOf(ctx))]),
        fetch: async (api, bank, i) => (bank === 1 ? romPreset(i) : fetchRegister(api, i)),
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { PRESET_NAMES.forEach((s, i) => onName(i, s)); return; }
          for (let i = 0; i < 128; i++) onName(i, nameOf(await fetchRegister(api, i)));
        },
        store: (_bank, i, ctx, data) => [registerMessage(i, data, chOf(ctx))],
      },
    },
    {
      key: 'system', page: 'Settings', icon: '⚙', label: 'Settings', size: SET_SIZE,
      init: () => { const d = new Uint8Array(SET_SIZE); d[2] = 2; d.fill(NONE, 6); return d; },
      request: (ctx) => requestMessage(REQ.setup, null, chOf(ctx)),
      match: isSetup,
      decode: (raw) => parse(raw).data.slice(SET_AT),
      receive: (raw) => { const m = parse(raw); return m?.ok && m.kind === 'setup' ? m.data.slice(SET_AT) : null; },
      params: settingsParams,
      sendParam,
      cols: 3,
      note: 'The rest of the active setup: the program, the algorithm, and a MIDI source that moves each of parameters 0-22 directly. Each change is sent at once.',
      toSyx: (data, ctx) => settingsParams.filter((p) => p.lxp).map((p) => paramMessage(p.lxp.pp, readParam(data, p), chOf(ctx))).flat(),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.ok && m.kind === 'setup') return m.data.slice(SET_AT); } return null; },
    },
  ],
  midiNotes: [
    'SysEx F0 06 05 <function, channel> ... F7 on the unit MIDI channel. Data bytes are 7-bit; the checksum is their sum AND 7Fh.',
    'Requests (3n): 60 active setup (0n 5E, 94 bytes), 61 rr register (1n rr 39, 57 bytes), 62 pp parameter (2n pp vv), 64 all registers (4n 39 00).',
    'Parameters (2n pp vv): 0-22 the algorithm parameters, 1Fh-2Bh the name block, 2Ch-3Fh the patches, 40h program (loads it), 42h algorithm, 46h-5Ch a MIDI source per parameter.',
    'The ROM presets (programs 128-192) are reached from the panel; the editor sends them as parameter messages.',
  ],
};

export const _test = { simulate, toCommon, fromCommon, sendParam, describe, libraryItems, registerOf };
