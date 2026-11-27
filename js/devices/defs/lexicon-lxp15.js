// Lexicon LXP-15 (1991 multi-effects, five algorithms): MIDI implementation taken from the v2.00 EPROM
// ("Lexicon LXP-15  Version 2.00", 1994; 64 KB, Z80, two 32 KB banks). See docs/devices/lexicon-lxp15.md.
//
// The active setup is 129 parameters (RAM A180h): 0-66 are a register, 67-128 the unit's own settings.
//   0 algorithm (1 Dly/Rvb, 2 Pch/Dly, 3 Gate, 4 Plate, 5 ChorDly), 1-26 the algorithm's parameters (each
//   algorithm reads the same bytes its own way; 14-bit values as two bytes, low 7 bits first), 27-54 four
//   patches of 7 bytes (Src, Thresh, Dest, Scale lo / hi, Offset lo / hi), 55-66 the name (12 characters).
// Every value is 7 bits. Every change on the panel is sent at once as a parameter message.
//
// SysEx F0 06 06 <fn n> ... F7 (Lexicon, LXP-15; n = MIDI channel, any with Omni):
//   0n 7D <125> cs   active setup as the unit sends it (parameters 0-124). The v2.00 receiver takes it only with a
//                    count of 81h (129 parameters, 376A), which is a status byte, so no setup dump reaches it
//                    (v1.31 sent and took 0n 7D): the editor sets the active setup with parameter messages
//   1n rr 43 <67> cs register rr (0-127); 4n 43 00 <8576> cs all 128 registers; 7n 00 02 <256> cs program map
//   2n pp vv         parameter pp = vv; 5n pp lo hi: a 14-bit parameter (low 7 bits first)
//   3n 60 / 61 rr / 62 pp / 65 pp / 64 / 66   requests: active setup, register, parameter (2n or 5n form),
//                    all registers, program map
//   6n 70 rr         store the active setup into register rr; 6n 71 rr: load register rr
// cs = the sum of the data bytes AND 7Fh. Receiver 3687 (bank A), dispatcher 04A5, sender 2BC5.

import { FIRMWARE, ALGS, SYS, TABLES, PRESETS, MAPVALS, SETUP0, PARAM_NAMES } from './lexicon-lxp15-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { readParam, writeParam } from '../../core/model/memmap.js';
import { hashBytes, tidy } from './translate-helpers.js';

export { FIRMWARE, ALGS, SYS, PRESETS, MAPVALS, SETUP0, PARAM_NAMES };
const SETUP_NAMES = PARAM_NAMES;

export const SIZE = 67;            // a register, and the register part of the active setup
export const SETUP_SIZE = 125;     // the active setup as the unit sends it (0n 7D)
export const SETUP_RX = 129;       // the active setup in RAM (A180h-A200h); the v2.00 receiver's 0n count
export const MAP_SIZE = 256;
export const ALL_SIZE = 128 * SIZE;
export const NAME_AT = 55;
export const NAME_LEN = 12;
export const P = { alg: 0, setupNum: 77, preNum: 76, regNum: 75, midiChannel: 79, memProt: 82 };
export const REQ = { setup: 0x60, register: 0x61, param: 0x62, param14: 0x65, all: 0x64, map: 0x66 };

const pad3 = (n) => String(n).padStart(3, ' ');
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));

// ------------------------------------------------------------------ text tables
const RUN_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function field(v, width, dec, plus, zp) {
  const a = Math.abs(v);
  const ip = Math.floor(a / 10 ** dec);
  let s = zp ? String(ip).padStart(zp, '0') : String(ip);
  if (dec) s += `.${String(a % 10 ** dec).padStart(dec, '0')}`;
  if (v < 0) s = `-${s}`;
  else if ((plus === 1 && v > 0) || (plus === 2 && v >= 0)) s = `+${s}`;
  return s.padStart(width, ' ');
}
function render(tm, fields, i) {
  const vals = fields.map(([start, step, width, dec, plus, zp]) => field(start + step * i, width, dec, plus, zp));
  let out = '';
  for (let k = 0; k < tm.length; k++) {
    const c = tm[k];
    if ((c === '{' || c === '}') && tm[k + 1] === c) { out += c; k++; } else if (c === '{') {
      const e = tm.indexOf('}', k);
      out += vals[Number(tm.slice(k + 1, e))];
      k = e;
    } else out += c;
  }
  return out;
}
const expandSegs = (segs) => segs.flatMap(([n, tm, fl]) => Array.from({ length: n }, (_, i) => render(tm, fl, i)));
/** Texts of an encoded table: every text, or the distinct texts with one run-length character each. */
export function decodeTable(enc) {
  if (enc.t) return expandSegs(enc.t);
  const d = expandSegs(enc.d);
  const out = [];
  for (let i = 0; i < d.length; i++) for (let k = RUN_CHARS.indexOf(enc.r[i]); k > 0; k--) out.push(d[i]);
  return out;
}
const TABLE_CACHE = new Map();
export function table(i) {
  let t = TABLE_CACHE.get(i);
  if (!t) { t = decodeTable(TABLES[i]); TABLE_CACHE.set(i, t); }
  return t;
}
/** The text the unit shows for value v of item it (null when v is out of its range). */
export function itemText(it, v) {
  if (it.t == null) return null;
  const from = it.tmin ?? it.min;
  return table(it.t)[v - from] ?? null;
}

// ------------------------------------------------------------------ messages
export const isLxp = (raw) => raw?.[0] === 0xf0 && raw.length > 5 && raw[1] === 0x06 && raw[2] === 0x06;
const fn = (raw) => raw[3] >> 4;
const hdr = (f, ch = 0) => [0xf0, 0x06, 0x06, (f << 4) | (ch & 15)];
export const checksum = (data) => data.reduce((s, b) => s + (b & 0x7f), 0) & 0x7f;
const clean = (data, n) => Array.from({ length: n }, (_, i) => (data[i] ?? 0) & 0x7f);

/** Parameter message: 2n pp vv (7 bits) or 5n pp lo hi (14 bits). */
export function paramMessage(p, v, form = 1, ch = 0) {
  const u = v & 0x3fff;
  return form === 2 ? [...hdr(5, ch), p & 0x7f, u & 0x7f, (u >> 7) & 0x7f, 0xf7] : [...hdr(2, ch), p & 0x7f, u & 0x7f, 0xf7];
}
export const requestMessage = (kind, arg = null, ch = 0) => [...hdr(3, ch), kind, ...(arg == null ? [] : [arg & 0x7f]), 0xf7];
export const registerMessage = (n, data, ch = 0) => { const d = clean(data, SIZE); return [...hdr(1, ch), n & 0x7f, 0x43, ...d, checksum(d), 0xf7]; };
export const allRegistersMessage = (data, ch = 0) => { const d = clean(data, ALL_SIZE); return [...hdr(4, ch), 0x43, 0x00, ...d, checksum(d), 0xf7]; };
export const mapMessage = (data, ch = 0) => { const d = clean(data, MAP_SIZE); return [...hdr(7, ch), 0x00, 0x02, ...d, checksum(d), 0xf7]; };
/** The active setup as the unit sends it (0n 7D + parameters 0-124). */
export const setupDumpMessage = (data, ch = 0) => { const d = clean(data, SETUP_SIZE); return [...hdr(0, ch), 0x7d, ...d, checksum(d), 0xf7]; };
export const storeMessage = (n, ch = 0) => [...hdr(6, ch), 0x70, n & 0x7f, 0xf7];
export const loadMessage = (n, ch = 0) => [...hdr(6, ch), 0x71, n & 0x7f, 0xf7];

/** {kind, ...} of a message from or for the unit, or null. kind: setup, register, all, map, param, request, store, load. */
export function parse(raw) {
  if (!isLxp(raw) || raw.at(-1) !== 0xf7) return null;
  const ch = raw[3] & 15;
  const body = (from, n) => {
    if (raw.length !== from + n + 2) return null;
    const data = Uint8Array.from(raw.subarray ? raw.subarray(from, from + n) : raw.slice(from, from + n));
    return { data, ok: checksum(data) === raw[from + n] };
  };
  switch (fn(raw)) {
    case 0: { const n = raw[4]; const b = body(5, n); return b && { kind: 'setup', ch, count: n, ...b }; }
    case 1: { const b = raw[5] === 0x43 ? body(6, SIZE) : null; return b && { kind: 'register', ch, n: raw[4], ...b }; }
    case 4: { const b = raw[4] === 0x43 && raw[5] === 0x00 ? body(6, ALL_SIZE) : null; return b && { kind: 'all', ch, ...b }; }
    case 7: { const b = raw[4] === 0x00 && raw[5] === 0x02 ? body(6, MAP_SIZE) : null; return b && { kind: 'map', ch, ...b }; }
    case 2: return raw.length === 7 ? { kind: 'param', ch, p: raw[4], v: raw[5], form: 1 } : null;
    case 5: return raw.length === 8 ? { kind: 'param', ch, p: raw[4], v: raw[5] | (raw[6] << 7), form: 2 } : null;
    case 3: return (raw[4] & 0x78) === 0x60 ? { kind: 'request', ch, req: raw[4] & 0x67, arg: raw.length > 6 ? raw[5] : null } : null;
    case 6: return raw[4] === 0x70 || raw[4] === 0x71 ? { kind: raw[4] === 0x70 ? 'store' : 'load', ch, n: raw[5] } : null;
    default: return null;
  }
}
export const isRequest = (raw) => parse(raw)?.kind === 'request';

// ------------------------------------------------------------------ registers and presets
export const algOf = (d) => d[P.alg];
export const algInfo = (d) => ALGS.find((a) => a.v === d[P.alg]) || null;
export const nameOf = (d) => String.fromCharCode(...Array.from(d.slice(NAME_AT, NAME_AT + NAME_LEN))).replace(/[^\x20-\x7e]/g, ' ').trimEnd();
/** Name as Name Edit allows it: 12 characters 20h-7Eh. */
export function setName(d, name) {
  const s = String(name).replace(/[^\x20-\x7e]/g, ' ').slice(0, NAME_LEN).padEnd(NAME_LEN, ' ');
  for (let i = 0; i < NAME_LEN; i++) d[NAME_AT + i] = s.charCodeAt(i);
}
/** ROM preset i (0-127) as the unit copies it into register i on first power-up (42DCh + 67 i). */
export const romPreset = (i) => hex(PRESETS[i][1]);
export const PRESET_NAMES = PRESETS.map((p) => p[0].trimEnd());

// ------------------------------------------------------------------ setup parameters
const ITEMS = new Map(); // key -> {alg, page, item}
function itemKey(a, it) { return `a${a}p${it.p}`; }
const get14 = (o, signed) => (d) => { const v = (d[o] & 0x7f) | ((d[o + 1] & 0x7f) << 7); return signed && v >= 8192 ? v - 16384 : v; };
const set14 = (o) => (d, v) => { const u = v & 0x3fff; d[o] = u & 0x7f; d[o + 1] = (u >> 7) & 0x7f; };
/** The values ADJUST reaches for item it, in order. */
export const valuesOf = (it) => it.vals || Array.from({ length: it.max - it.min + 1 }, (_, i) => it.min + i);
function presetValuesOutside(a, it) {
  if (it.form === 2 || it.t == null) return [];
  const reach = new Set(valuesOf(it));
  const out = new Set();
  for (const [, h] of PRESETS) {
    if (parseInt(h.slice(0, 2), 16) !== a) continue;
    const v = parseInt(h.slice(2 * it.p, 2 * it.p + 2), 16);
    if (!reach.has(v) && itemText(it, v) != null) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}
function pageGroup(page) { return page >= 7 ? `Patch ${page - 6}` : `Page ${page}`; }
function itemParam(a, page, it) {
  const key = itemKey(a, it);
  ITEMS.set(key, { a, page, it });
  const label = it.long || it.name;
  const base = {
    key, group: pageGroup(page), label, offset: it.p,
    lxp: { a, p: it.p, form: it.form },
    help: `${it.name} (PAGE ${page}, soft button ${it.soft + 1})`,
    dynamic: (d) => ({ hidden: algOf(d) !== a }),
  };
  if (it.form === 2) Object.assign(base, { size: 2, get: get14(it.p, it.signed), set: set14(it.p) });
  if (it.t == null) return { ...base, min: it.min, max: it.max, input: 'number' };
  const reach = valuesOf(it);
  if (reach.length <= 130) {
    const opts = reach.map((v) => [v, itemText(it, v)]);
    // values the ROM presets keep outside the panel's range (an unused patch: Src / Dest 127), with the unit's text
    for (const v of presetValuesOutside(a, it)) opts.push([v, `${itemText(it, v)} (ROM preset value, not on the panel)`]);
    return { ...base, options: opts };
  }
  return { ...base, min: it.min, max: it.max, input: 'number', format: (v) => itemText(it, v) ?? String(v) };
}
const ALG_OPTIONS = ALGS.map((a) => [a.v, `${a.v} ${a.name}`]);
export const effectParams = [
  { key: 'alg', group: 'Algorithm', label: 'Algorithm', offset: P.alg, options: ALG_OPTIONS, relayout: true,
    help: 'PAGE 6, Algthm. Changing it keeps every other value: each algorithm reads them its own way.' },
  ...ALGS.flatMap((x) => {
    const seen = new Set(); // a parameter on two pages gets one control
    return x.pages.flatMap((pg) => pg.items.filter((it) => !it.none && !seen.has(it.p) && seen.add(it.p)).map((it) => itemParam(x.v, pg.page, it)));
  }),
  ...Array.from({ length: NAME_LEN }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: NAME_AT + i, min: 0x20, max: 0x7e, kind: 'char', hidden: true })),
];
const PARAM_BY_KEY = new Map(effectParams.map((p) => [p.key, p]));
export const paramOf = (a, p) => PARAM_BY_KEY.get(`a${a}p${p}`);
export const findItem = (a, name) => ALGS.find((x) => x.v === a)?.pages.flatMap((pg) => pg.items).find((it) => !it.none && (it.long === name || it.name === name));
/** The value of parameter p in setup d as the unit shows it. */
export function textOfParam(a, p, d) {
  const x = ITEMS.get(`a${a}p${p}`);
  if (!x) return null;
  return itemText(x.it, readParam(d, PARAM_BY_KEY.get(`a${a}p${p}`)));
}

/** The parameter messages that set the register part of the active setup to d (algorithm first). */
export function editMessages(d, ch = 0) {
  const a = algOf(d);
  const out = [paramMessage(P.alg, d[P.alg], 1, ch)];
  const pairs = new Set();
  for (const pg of ALGS.find((x) => x.v === a)?.pages || []) for (const it of pg.items) if (!it.none && it.form === 2) pairs.add(it.p);
  for (let p = 1; p < SIZE; p++) {
    if (pairs.has(p)) { out.push(paramMessage(p, (d[p] & 0x7f) | ((d[p + 1] & 0x7f) << 7), 2, ch)); p++; } else out.push(paramMessage(p, d[p], 1, ch));
  }
  return out;
}

// ------------------------------------------------------------------ the unit's settings (setup 67-124)
const MAPVAL = 94;
const sysItems = SYS.flatMap((pg) => pg.items.filter((it) => !it.none && it.p >= SIZE && it.p < SETUP_SIZE).map((it) => ({ ...it, page: pg.page })));
/** Text of a settings item for value v (from its table or the screens the panel stepped through). */
export function sysText(it, v) {
  if (it.p === MAPVAL) return MAPVALS[v] ?? null; // with PgmChg on a map entry; with OFF / PRE / REG the page shows ---
  if (it.t != null) return itemText(it, v);
  const x = it.texts?.find((t) => t[0] === v);
  return x ? x[1] : null;
}
function sysParam(it) {
  const base = {
    key: `s${it.p}`, group: SYS_GROUPS[it.page] || `PAGE ${it.page}`, label: it.long || it.name, offset: it.p,
    lxp: { p: it.p, form: it.form },
    help: `${it.name} (PAGE ${it.page}, soft button ${it.soft + 1})`,
  };
  if (it.form === 2) Object.assign(base, { size: 2, get: get14(it.p, false), set: set14(it.p) });
  const vals = it.p === MAPVAL ? MAPVALS.map((_, v) => v) : it.texts ? it.texts.map((t) => t[0]) : Array.from({ length: it.max - it.min + 1 }, (_, i) => it.min + i);
  if (vals.every((v) => sysText(it, v) != null) && vals.length <= 260) return { ...base, options: vals.map((v) => [v, sysText(it, v)]) };
  return { ...base, min: it.min, max: it.max, input: 'number' };
}
const SYS_GROUPS = { 0: 'Setup (PAGE 0)', 11: 'MIDI and display (PAGE 11)', 12: 'SysEx Transmit (PAGE 12)', 13: 'Program change and global patch (PAGE 13)', 15: 'Store (PAGE 15)' };
const SYS_NAMED = new Set(sysItems.map((it) => it.p).flatMap((p) => { const it = sysItems.find((x) => x.p === p); return it.form === 2 ? [p, p + 1] : [p]; }));
export const systemParams = [
  ...sysItems.map(sysParam),
  ...Array.from({ length: SETUP_SIZE - SIZE }, (_, i) => SIZE + i).filter((p) => !SYS_NAMED.has(p)).map((p) => ({
    key: `x${p}`, group: 'Other setup bytes', label: `Setup ${p}${SETUP_NAMES[p] ? ` (${SETUP_NAMES[p]})` : ''}`, offset: p, min: 0, max: 127, input: 'number', readOnly: true,
    help: `Sent by the unit with the active setup but on no page of its panel${SETUP_NAMES[p] ? `; the SysEx Transmit page calls it ${SETUP_NAMES[p]}` : ''}. Shown as stored.`,
  })),
];

// ------------------------------------------------------------------ program map (7n: 128 entries of two bytes)
// Entry n (bytes 2n, 2n+1): the number 0-127, then 20h for a register, 10h for a preset, 0 for OFF (MapVal on
// PAGE 13 steps through Reg 1-128, Pre 1-128, OFF: values 0-256 here).
export const MAP_KIND = { register: 0x20, preset: 0x10, off: 0 };
export function mapEntry(m, n) {
  const k = m[2 * n + 1];
  if (k === MAP_KIND.register) return m[2 * n] & 0x7f;
  if (k === MAP_KIND.preset) return 128 + (m[2 * n] & 0x7f);
  return k === MAP_KIND.off && !m[2 * n] ? 256 : -1;
}
export function setMapEntry(m, n, v) {
  if (v >= 0 && v < 128) { m[2 * n] = v; m[2 * n + 1] = MAP_KIND.register; } else if (v >= 128 && v < 256) { m[2 * n] = v - 128; m[2 * n + 1] = MAP_KIND.preset; } else { m[2 * n] = 0; m[2 * n + 1] = 0; }
}
export const mapText = (v) => MAPVALS[v] ?? null;
export const mapParams = Array.from({ length: 128 }, (_, n) => ({
  key: `map${n}`, group: 'Program map', label: `Map ${n + 1}`, offset: 2 * n, size: 2,
  get: (m) => mapEntry(m, n), set: (m, v) => setMapEntry(m, n, v),
  options: MAPVALS.map((t, v) => [v, t]),
  help: `Program map entry ${n + 1}: PAGE 13, PgmChg on Map ${n + 1}, MapVal`,
}));

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = {
    setup: Uint8Array.from(SETUP0), registers: PRESETS.map((_, i) => romPreset(i)), map: new Uint8Array(MAP_SIZE),
    display: '', stored: 0,
  };
  const channel = () => st.setup[P.midiChannel];
  const takes = (ch) => channel() >= 16 || ch === channel();
  const protectedMem = () => !!st.setup[P.memProt];
  const loadRegister = (n) => { st.setup.set(st.registers[n], 0); st.setup[P.regNum] = n; };
  const loadPreset = (n) => { st.setup.set(romPreset(n), 0); st.setup[P.setupNum] = n; st.setup[P.preNum] = n; };
  return {
    state: st,
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) return [];
      if (d[0] !== 0xf0) return null;
      const m = parse(d);
      if (!m || !takes(m.ch)) return [];
      const ch = channel() & 15;
      switch (m.kind) {
        case 'param':
          if (m.p === P.setupNum && m.form === 1) { loadPreset(m.v & 0x7f); return []; }
          if (m.form === 2) { st.setup[m.p] = m.v & 0x7f; st.setup[m.p + 1] = (m.v >> 7) & 0x7f; } else st.setup[m.p] = m.v & 0x7f;
          return [];
        case 'request':
          if (m.req === REQ.setup) return [Uint8Array.from(setupDumpMessage(st.setup, ch))];
          if (m.req === REQ.register) return [Uint8Array.from(registerMessage(m.arg, st.registers[m.arg & 0x7f], ch))];
          if (m.req === REQ.param) return [Uint8Array.from(paramMessage(m.arg, st.setup[m.arg], 1, ch))];
          if (m.req === REQ.param14) return [Uint8Array.from(paramMessage(m.arg, st.setup[m.arg] | (st.setup[m.arg + 1] << 7), 2, ch))];
          if (m.req === REQ.all) return [Uint8Array.from(allRegistersMessage(st.registers.flatMap((r) => Array.from(r)), ch))];
          if (m.req === REQ.map) return [Uint8Array.from(mapMessage(st.map, ch))];
          return [];
        case 'setup':
          // 376A wants a count of 81h, a status byte that ends the message: no setup dump is taken
          return [];
        case 'register':
          if (!m.ok) { st.display = 'MIDI Error'; return []; }
          if (protectedMem()) { st.display = 'Dump Failed: Memory Protected'; return []; }
          st.registers[m.n & 0x7f] = Uint8Array.from(m.data);
          st.display = 'Register Dump Received';
          return [];
        case 'all':
          if (!m.ok) return [];
          for (let i = 0; i < 128; i++) st.registers[i] = m.data.slice(i * SIZE, (i + 1) * SIZE);
          st.display = 'All Registers Dump Received';
          return [];
        case 'map':
          if (m.ok) st.map = Uint8Array.from(m.data);
          return [];
        case 'store':
          if (protectedMem()) { st.display = 'MIDI Store Failed: Memory Protected'; return []; }
          st.registers[m.n & 0x7f] = st.setup.slice(0, SIZE);
          st.stored++;
          st.display = 'Register Store Received';
          return [];
        case 'load':
          loadRegister(m.n & 0x7f);
          return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor, library
const algName = (d) => algInfo(d)?.name ?? `algorithm ${d[0]}`;
function describe(raw) {
  const m = parse(raw);
  if (!m) return isLxp(raw) ? 'LXP-15 message' : null;
  const bad = m.ok === false ? ' (checksum error)' : '';
  switch (m.kind) {
    case 'setup': return `LXP-15 active setup "${nameOf(m.data)}" (${algName(m.data)}, ${m.count} parameters)${bad}`;
    case 'register': return `LXP-15 register ${m.n + 1} "${nameOf(m.data)}" (${algName(m.data)})${bad}`;
    case 'all': return `LXP-15 all 128 registers${bad}`;
    case 'map': return `LXP-15 program map${bad}`;
    case 'param': return `LXP-15 parameter ${m.p}${PARAM_NAMES[m.p] ? ` (${PARAM_NAMES[m.p]})` : ''} = ${m.v}`;
    case 'request': return `LXP-15 request: ${{ 0x60: 'active setup', 0x61: `register ${(m.arg ?? 0) + 1}`, 0x62: `parameter ${m.arg}`, 0x65: `parameter ${m.arg} (14 bits)`, 0x64: 'all registers', 0x66: 'program map' }[m.req] || m.req.toString(16)}`;
    case 'store': return `LXP-15 store the active setup into register ${m.n + 1}`;
    case 'load': return `LXP-15 load register ${m.n + 1}`;
    default: return 'LXP-15 message';
  }
}
function libraryItems(msgs) {
  const items = [];
  for (const raw of msgs) {
    const m = parse(raw);
    if (m?.kind === 'register' && m.ok) items.push({ key: `r${m.n}`, label: `Register ${m.n + 1}`, name: nameOf(m.data), object: 'effect', data: m.data, msgs: [Uint8Array.from(raw)] });
    else if (m?.kind === 'setup' && m.ok) {
      items.push({ key: `e${items.length}`, label: 'Active setup', name: nameOf(m.data), object: 'effect', data: m.data.slice(0, SIZE), msgs: [Uint8Array.from(raw)] });
      if (m.count >= SETUP_SIZE) items.push({ key: `s${items.length}`, label: 'Settings (from the active setup)', name: '', object: 'system', data: m.data.slice(0, SETUP_SIZE), msgs: [Uint8Array.from(raw)] });
    } else if (m?.kind === 'all' && m.ok) {
      for (let i = 0; i < 128; i++) {
        const d = m.data.slice(i * SIZE, (i + 1) * SIZE);
        items.push({ key: `r${i}`, label: `Register ${i + 1}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(registerMessage(i, d, m.ch))] });
      }
    } else if (m?.kind === 'map' && m.ok) items.push({ key: 'map', label: 'Program map', name: '', object: 'global', data: m.data, msgs: [Uint8Array.from(raw)] });
    else if (m?.kind !== 'request') items.push({ key: `x${items.length}`, label: describe(raw) || 'Other message', name: '', object: null, msgs: [raw] });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: the algorithm's reverb (Decay Time or Slope, Pre Delay, Room Size, Reverb Mix), delay (Delay 2,
// Left Delay; Glide / PreDly / Feedback) and modulation (Pch/Dly: pitch shift while Pitch Enable is On;
// ChorDly: chorus at Chorus Rate) become effects.*, each value as a fraction of its panel range. Exact bytes in
// extra (family 'lexicon-lxp15'). fromCommon: the same family loads the bytes; anything else picks the
// algorithm that has the effects, starts from the first ROM preset with it and sets what maps; the name of the
// register it replaces is kept.
const FAMILY = 'lexicon-lxp15';
const firstPresetOf = (a) => Math.max(0, PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === a));
function frac(a, name, d) {
  const it = findItem(a, name);
  if (!it) return undefined;
  const v = readParam(d, paramOf(a, it.p));
  return it.max > it.min ? Math.max(0, Math.min(1, (v - it.min) / (it.max - it.min))) : 0;
}
function setFrac(a, name, d, f, r, what) {
  const it = findItem(a, name);
  if (!it || f === undefined || Number.isNaN(f)) return;
  writeParam(d, paramOf(a, it.p), Math.round(it.min + Math.max(0, Math.min(1, f)) * (it.max - it.min)));
  r?.approximated.push(what || name);
}
const REVERB = { 1: 'Hall', 2: 'Hall', 3: 'Gate', 4: 'Plate' };
function toCommon(d) {
  const a = algOf(d);
  const effects = {};
  const mix = frac(a, 'Reverb Mix', d) ?? frac(a, 'Output Mix', d) ?? 1;
  if (REVERB[a]) {
    effects.reverb = { type: REVERB[a], time: frac(a, a === 3 ? 'Slope' : 'Decay Time', d) ?? 0.5, level: mix };
    const pre = frac(a, 'Pre Delay', d);
    if (pre !== undefined) effects.reverb.preDelay = pre;
    const size = frac(a, 'Room Size', d);
    if (size !== undefined) effects.reverb.size = size;
  }
  const dl = findItem(a, 'Delay 2') || findItem(a, 'Left Delay');
  if (dl) {
    effects.delay = { type: algName(d), time: frac(a, dl.long, d), level: 1 };
    const fb = frac(a, 'Feedback', d) ?? frac(a, 'Feedback 3', d) ?? frac(a, 'Glide Fdbk', d);
    if (fb !== undefined) effects.delay.feedback = fb;
  }
  if (a === 2 && textOfParam(2, findItem(2, 'Pitch Enable').p, d) === 'On') effects.modulation = { type: 'PITCH SHIFT', level: 1 };
  if (a === 5) {
    effects.modulation = { type: 'CHORUS', rate: frac(5, 'Chorus Rate', d) ?? 0.5, level: 1 };
    effects.chorus = { ...effects.modulation };
  }
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'lexicon-lxp15', algorithm: algName(d), data: Array.from(d.slice(0, SIZE)), match: hashBytes(d.slice(0, SIZE)) } };
}
/** The algorithm for a set of effects (-1: none). */
export function pickAlgorithm(fx) {
  const on = (e) => e && (e.level ?? 1) > 0;
  const md = [fx.modulation, fx.chorus].find(on);
  const t = String(md?.type || '').toUpperCase();
  if (md && /PITCH|SHIFT|OCTAV|HARMON|DETUNE/.test(t)) return 2;
  if (md) return 5;
  if (on(fx.reverb)) {
    const r = String(fx.reverb.type || '').toUpperCase();
    return /PLATE/.test(r) ? 4 : /GATE/.test(r) ? 3 : 1;
  }
  if (on(fx.delay)) return 1;
  return -1;
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
  const a = pickAlgorithm(fx);
  if (a < 0) {
    r.dropped.push('No effect in the source sound: the register keeps its algorithm and settings');
    return { data: Uint8Array.from(base || romPreset(0)), report: tidy(r) };
  }
  const n = firstPresetOf(a);
  const d = romPreset(n);
  r.approximated.push(`Algorithm ${ALGS.find((g) => g.v === a).name}, starting from preset ${n + 1} (${PRESET_NAMES[n]})`);
  if (fx.reverb && REVERB[a]) {
    setFrac(a, a === 3 ? 'Slope' : 'Decay Time', d, fx.reverb.time, r, 'Reverb time');
    setFrac(a, 'Pre Delay', d, fx.reverb.preDelay, r, 'Pre-delay');
    setFrac(a, 'Room Size', d, fx.reverb.size, r, 'Room size');
    setFrac(a, 'Reverb Mix', d, fx.reverb.level, r, 'Reverb level');
  }
  if (fx.delay) {
    const dl = findItem(a, 'Delay 2') || findItem(a, 'Left Delay');
    if (dl) setFrac(a, dl.long, d, fx.delay.time, r, 'Delay time');
    setFrac(a, findItem(a, 'Feedback') ? 'Feedback' : 'Feedback 3', d, fx.delay.feedback, r, 'Delay feedback');
  }
  const m = [fx.modulation, fx.chorus].find((e) => e && (e.level ?? 1) > 0);
  if (m && a === 5) setFrac(5, 'Chorus Rate', d, m.rate, r, 'Chorus rate');
  if (m && a === 2) { setFrac(2, 'Pitch Enable', d, 1, r, 'Pitch shift on'); }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
  if (base) setName(d, nameOf(base));
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
  return paramMessage(p.lxp.p, v, p.lxp.form || 1, chOf(ctx));
}
export default {
  coverage: 'Edits the LXP-15\'s active setup (all five algorithms: every PAGE 1-10 soft button with its name, long name and value texts; four patches; the name), its 128 registers, its settings (MIDI channel, display, memory protect, program change and global patch, setup numbers) and its program map, and shows the 128 ROM presets. Sends each change as you make it, reads the setup, the registers and the map, stores and loads registers. Not checked on hardware.',
  sysex: { manufacturer: [0x06], model: 0x06 },
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
      decode: (raw) => parse(raw).data.slice(0, SIZE),
      receive: (raw) => { const m = parse(raw); return m?.ok && (m.kind === 'setup' || m.kind === 'register') ? m.data.slice(0, SIZE) : null; },
      params: effectParams,
      sendParam,
      name: nameOf,
      setName,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 5,
      note: 'The part of the active setup a register keeps. Each change is sent at once, as the panel sends it. Get reads the active setup. To keep it, store it into a register from the slot list, or use Store into register for what the unit plays. Memory Protect must be Off for both.',
      toSyx: (data, ctx) => editMessages(data, chOf(ctx)).flat(),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.ok && (m.kind === 'setup' || m.kind === 'register')) return m.data.slice(0, SIZE); } return null; },
      actions: [
        { label: 'Send to the active setup', title: 'Send every value of the setup, the algorithm first', run: (api) => api.send(editMessages(api.data, chOf(api.ctx))) },
        { label: 'Store into register', title: 'Send this setup, then store the active setup of the unit into a register', run: async (api) => {
          const r = await api.form('Store into register', [{ key: 'n', label: 'Register (1-128)', value: 1, type: 'number', min: 1, max: 128 }]);
          if (!r) return;
          const n = Math.max(1, Math.min(128, Number(r.n) || 1)) - 1;
          api.send([...editMessages(api.data, chOf(api.ctx)), storeMessage(n, chOf(api.ctx))]);
        } },
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Name', [{ key: 'name', label: 'Name (12 characters)', value: nameOf(api.data), maxlength: NAME_LEN }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name);
          api.setData(d);
        } },
      ],
      slots: {
        label: 'Registers and presets', banks: [[0, 'Registers 1-128'], [1, 'Presets 1-128 (ROM)']],
        count: () => 128,
        slotLabel: (bank, i) => `${bank ? 'P' : 'R'}${i + 1}`,
        note: (bank) => (bank ? 'ROM presets: Edit loads one from the editor\'s own copy; Play loads it on the unit (as Setup # = preset - 1).'
          : 'Edit reads the register; Store writes it (Memory Protect Off); Play loads it.'),
        names: (bank) => (bank === 1 ? PRESET_NAMES : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => [bank ? paramMessage(P.setupNum, i, 1, chOf(ctx)) : loadMessage(i, chOf(ctx))],
        fetch: async (api, bank, i) => (bank === 1 ? romPreset(i) : fetchRegister(api, i)),
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { PRESET_NAMES.forEach((s, i) => onName(i, s)); return; }
          for (let i = 0; i < 128; i++) onName(i, nameOf(await fetchRegister(api, i)));
        },
        store: (_bank, i, ctx, data) => [registerMessage(i, data, chOf(ctx))],
      },
    },
    {
      key: 'system', page: 'Settings', icon: '⚙', label: 'Settings', size: SETUP_SIZE,
      init: () => Uint8Array.from(SETUP0.slice(0, SETUP_SIZE)),
      request: (ctx) => requestMessage(REQ.setup, null, chOf(ctx)),
      match: isSetup,
      decode: (raw) => { const d = new Uint8Array(SETUP_SIZE); d.set(parse(raw).data.slice(0, SETUP_SIZE)); return d; },
      receive: (raw) => { const m = parse(raw); return m?.ok && m.kind === 'setup' ? m.data.slice(0, SETUP_SIZE) : null; },
      params: systemParams,
      sendParam,
      cols: 3,
      note: "The unit's own settings, sent with the active setup. Each change is sent at once. The MIDI channel changes the channel the unit listens on: set the editor's channel to match.",
      toSyx: (data, ctx) => systemParams.filter((p) => p.lxp).map((p) => paramMessage(p.lxp.p, readParam(data, p), p.lxp.form, chOf(ctx))).flat(),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.ok && m.kind === 'setup') return m.data.slice(0, SETUP_SIZE); } return null; },
    },
    {
      // key 'global': the unit's program map is a setting, not a sound (no translator)
      key: 'global', page: 'Program map', icon: '▤', label: 'Program map', size: MAP_SIZE, notLive: true,
      init: () => new Uint8Array(MAP_SIZE),
      request: (ctx) => requestMessage(REQ.map, null, chOf(ctx)),
      match: (r) => parse(r)?.kind === 'map',
      decode: (raw) => parse(raw).data,
      receive: (raw) => { const m = parse(raw); return m?.ok && m.kind === 'map' ? m.data : null; },
      params: mapParams,
      cols: 4,
      note: 'The program map: what a program change does while PgmChg on PAGE 13 is on the map. Changes are sent when you press Send to the LXP-15.',
      actions: [{ label: 'Send to the LXP-15', title: 'Send the whole map', run: (api) => api.send([mapMessage(api.data, chOf(api.ctx))]) }],
      toSyx: (data, ctx) => mapMessage(data, chOf(ctx)),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.ok && m.kind === 'map') return m.data; } return null; },
    },
  ],
  midiNotes: [
    'SysEx F0 06 06 <function, channel> ... F7: the unit answers on its MIDI channel and takes messages on that channel (any with Omni).',
    'Requests (3n): 60 active setup, 61 rr register, 62 pp / 65 pp one parameter (7 or 14 bits), 64 all registers, 66 program map.',
    'Every change on the panel is sent at once as a parameter message (2n pp vv, or 5n pp lo hi for 14-bit values); the unit takes the same messages, without checking ranges.',
    'The active setup dump the unit sends (0n 7D, 125 parameters) cannot be sent back: the v2.00 receiver wants a count of 81h, a status byte. The editor sets the active setup with parameter messages.',
    'Register dumps (1n) and Store (6n 70) are refused while Memory Protect is On; the all-registers dump (4n) is stored even then.',
  ],
};

export const _test = { simulate, toCommon, fromCommon, sendParam, describe, libraryItems };
