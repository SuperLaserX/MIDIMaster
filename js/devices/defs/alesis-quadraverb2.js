// Alesis Quadraverb 2 (1993, eight-block multi-effect with routing): MIDI implementation taken from the
// v2.01e EPROM (128 KB, 8031, two 64 KB banks). See docs/devices/alesis-quadraverb2.md.
//
// A program is 256 bytes (pack routine 7488; ROM presets keep the first 192):
//   00-0D name (14 characters)      0E-15 blocks 1-8: function << 5 | type (0 = OFF)
//   16-35 MOD 1-8: source, TO block (1-8, 9 OUT L, 10 OUT R, 11 MIX), TO parameter, amplitude (signed)
//   36-47 levels: DIRECT, then per block MIX TO L/R and INMIX TO L/R, MASTER EFFECTS (0-100 %)
//   48-5B GEN 1 / 2 (local generators), 10 bytes each
//   5C-   the data of each block in use, in block order (one byte per edit page, two for 16-bit pages),
//         then the routes: pairs [matrix cell low byte, level 0-58 | bit 7 = cell in page 04h], FF FF
//   FF    the block bypass bits (00CF) as STORE found them
// Routes: matrix 0300h + 34 x destination (blocks 1-8, OUT L, OUT R) + source (INPUT L / R, then per
// block INMIX and its outputs MIX / LEFT / RIGHT).
//
// SysEx F0 00 00 0E 0F (Alesis, Quadraverb 2; no channel byte), taken while SYSTEM EXCLUSIVE RECEIVE is ON:
//   01 f b g p v1 v2 v3   one page value (f 0 EDIT, 1 MIX, 2 GLOBAL, 3 CONFIG; block, group and page from 1;
//                         the value as 16 bits low byte first in three 7-bit groups)
//   02 n <293 bytes>      program n (0-99 User 0, 64h edit buffer): 256 bytes as a stream of 7-bit groups
//   0C n <293 bytes>      program n of User 1
//   03 n / 0D n           requests (03 64h edit buffer, 03 65h-7Fh everything: 200 programs, globals, table)
//   07 <16 bytes>         GLOBAL pages (14 bytes); 08 requests them
//   11 <256 bytes>        MIDI program table (128 entries, two bytes each); 12 requests it
//   0F b1 b2              block bypass bits; 10 requests them; 09 a b  bypass / test
//   05 / 06               DSP microcode and register writes (factory use; not offered)

import {
  FIRMWARE, TYPES, MOD_SOURCES, MOD_BLOCKS, MOD_AMOUNT, MIX_TARGETS, GENS, ROUTE_LEVELS, MIX_PAGES, GLOBAL_PAGES,
  MIDI_PAGES, PRESETS, CHECKS,
} from './alesis-quadraverb2-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';

export { FIRMWARE, TYPES, MOD_SOURCES, MOD_BLOCKS, MOD_AMOUNT, MIX_TARGETS, GENS, ROUTE_LEVELS, MIX_PAGES, GLOBAL_PAGES, MIDI_PAGES, PRESETS, CHECKS };

export const SIZE = 256;
export const P = { name: 0, cfg: 14, mods: 22, levels: 54, gens: 72, blocks: 92, bypass: 255 };
export const NAME_LEN = 14;
export const N_BLOCKS = 8;
export const N_PRESETS = 100;
export const OP = { edit: 0x01, program: 0x02, request: 0x03, globals: 0x07, globalsReq: 0x08, bypassSet: 0x09, program1: 0x0c, request1: 0x0d, bypass: 0x0f, bypassReq: 0x10, table: 0x11, tableReq: 0x12 };
export const EDIT_BUFFER = 200; // the editor's number for the edit buffer (64h in the messages)
const WIRE_EDIT = 0x64;
export const HEAD = [0xf0, 0x00, 0x00, 0x0e, 0x0f];
export const FUNCS = ['OFF', 'EQUALIZATION', 'PITCH', 'DELAY', 'REVERBERATION']; // BLOCK x FUNCTION (hi E268)
export const ABBR = ['', 'EQ', 'PCH', 'DLY', 'RVB'];
const MAX_SLOTS = Math.max(...TYPES.map((t) => t.pages.length));
const MAX_ROUTES = 60;

const hex = (s) => Uint8Array.from((s.match(/../g) || []).map((x) => parseInt(x, 16)));
const pad2 = (n) => String(n).padStart(2, '0');
const s16 = (v) => (v & 0x8000 ? v - 0x10000 : v);
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);

// ------------------------------------------------------------------ 7-bit streams (Alesis: bytes high bit first)
export function pack7(bytes) {
  const out = [];
  let acc = 0;
  let n = 0;
  for (const b of bytes) {
    acc = (acc << 8) | (b & 0xff);
    n += 8;
    while (n >= 7) { n -= 7; out.push((acc >> n) & 0x7f); }
    acc &= (1 << n) - 1;
  }
  if (n) out.push((acc << (7 - n)) & 0x7f);
  return out;
}
export function unpack7(b7, count) {
  const out = new Uint8Array(count);
  let acc = 0;
  let n = 0;
  let k = 0;
  for (const b of b7) {
    acc = (acc << 7) | (b & 0x7f);
    n += 7;
    if (n >= 8) { n -= 8; if (k < count) out[k++] = (acc >> n) & 0xff; acc &= (1 << n) - 1; }
  }
  return out;
}

// ------------------------------------------------------------------ messages
export const isQv2 = (raw) => raw?.[0] === 0xf0 && raw.length >= 7 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0x0e && raw[4] === 0x0f;
const op = (raw) => raw[5];
/** A program dump: n 0-99 User 0 (op 02), 100-199 User 1 (op 0C), EDIT_BUFFER (02 64h). */
export function programMessage(n, data) {
  const user1 = n >= 100 && n < 200;
  return [...HEAD, user1 ? OP.program1 : OP.program, n === EDIT_BUFFER ? WIRE_EDIT : user1 ? n - 100 : n, ...pack7(data.slice(0, SIZE)), 0xf7];
}
export const requestMessage = (n) => (n === EDIT_BUFFER ? [...HEAD, OP.request, WIRE_EDIT, 0xf7] : n >= 100 ? [...HEAD, OP.request1, n - 100, 0xf7] : [...HEAD, OP.request, n, 0xf7]);
export const REQUEST_ALL = [...HEAD, OP.request, 0x65, 0xf7];
/** {n, data} of a program dump (n as programMessage takes it), or null. */
export function parseProgram(raw) {
  if (!isQv2(raw) || (op(raw) !== OP.program && op(raw) !== OP.program1) || raw.length < 7 + 293) return null;
  const n = raw[6] === WIRE_EDIT ? EDIT_BUFFER : op(raw) === OP.program1 ? 100 + raw[6] : raw[6];
  return { n, data: unpack7(raw.slice(7, raw.length - 1), SIZE) };
}
/** One page value (SysEx 01): f 0 EDIT, 1 MIX, 2 GLOBAL, 3 CONFIG; block, group, page counted from 1. */
export const editMessage = (f, block, group, page, v) => [...HEAD, OP.edit, f, block, group, page, ...pack7([v & 0xff, (v >> 8) & 0xff]), 0xf7];

// ------------------------------------------------------------------ value texts
function field(v, width, dec, plus, zp) {
  const a = Math.abs(v);
  const ip = Math.floor(a / 10 ** dec);
  let s = zp ? String(ip).padStart(zp, '0') : String(ip);
  if (dec) s += `.${String(a % 10 ** dec).padStart(dec, '0')}`;
  if (v < 0) s = `-${s}`;
  else if ((plus === 1 && v > 0) || (plus === 2 && v >= 0)) s = `+${s}`;
  return s.padStart(width, ' ');
}
function renderTemplate(tm, fields, i) {
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
export const expandTexts = (t) => (t || []).flatMap(([n, tm, fields]) => Array.from({ length: n }, (_, i) => renderTemplate(tm, fields, i)));
const TEXTS = new Map();
/** The raw values a page steps through and the text the LCD shows for each. */
export function pageValues(pg) {
  let r = TEXTS.get(pg);
  if (!r) {
    const texts = expandTexts(pg.t);
    const raws = [];
    for (let v = pg.min; v <= pg.max; v += pg.step || 1) raws.push(v);
    r = { raws, texts, index: new Map(raws.map((v, i) => [v, i])) };
    TEXTS.set(pg, r);
  }
  return r;
}
export const valueText = (pg, v) => { const r = pageValues(pg); const i = r.index.get(v); return i === undefined ? String(v) : (r.texts[i] ?? String(v)); };
const BIG = 1500; // pages with more values than this are typed in (raw units)

// ------------------------------------------------------------------ program layout
const TYPE_OF = new Map(TYPES.map((t) => [t.cfg, t]));
export const typeOf = (cfg) => TYPE_OF.get(cfg) || null;
export const nameOf = (d) => String.fromCharCode(...Array.from(d.slice(P.name, P.name + NAME_LEN), (c) => (c >= 0x20 && c < 0x7f ? c : 0x20))).trim();
export function setName(d, s) {
  const t = String(s || '').padEnd(NAME_LEN, ' ').slice(0, NAME_LEN);
  for (let i = 0; i < NAME_LEN; i++) { const c = t.charCodeAt(i); d[P.name + i] = c >= 0x20 && c < 0x7f ? c : 0x20; }
}
/** The blocks in use: [{k, type, off}] and where the routes start. */
export function layout(d) {
  const blocks = [];
  let o = P.blocks;
  for (let k = 0; k < N_BLOCKS; k++) {
    const type = typeOf(d[P.cfg + k]);
    if (!type) continue;
    blocks.push({ k, type, off: o });
    o += type.size;
  }
  return { blocks, routes: Math.min(o, 255) };
}
export const blockOf = (d, k) => layout(d).blocks.find((b) => b.k === k) || null;
/** The routes as stored: [{cell 0-339, level 0-58}]. */
export function readRoutes(d) {
  const out = [];
  for (let o = layout(d).routes; o + 1 < 255; o += 2) {
    if (d[o] === 0xff && d[o + 1] === 0xff) break;
    const addr = ((d[o + 1] & 0x80) ? 0x400 : 0x300) + d[o];
    const cell = addr - 0x300;
    if (cell < 0 || cell >= 340) break;
    out.push({ cell, level: d[o + 1] & 0x7f });
  }
  return out;
}
/** Write the routes in matrix order (as the pack routine scans 0300-0453), FF FF after them, zeros to 254. */
export function writeRoutes(d, routes) {
  const at = layout(d).routes;
  const list = [...new Map(routes.filter((r) => r.cell >= 0 && r.cell < 340).map((r) => [r.cell, r])).values()].sort((a, b) => a.cell - b.cell);
  let o = at;
  for (const r of list) {
    if (o + 1 >= 255) break;
    const addr = 0x300 + r.cell;
    d[o++] = addr & 0xff;
    d[o++] = (r.level & 0x7f) | (addr & 0x400 ? 0x80 : 0);
  }
  if (o < 0xfd) { d[o++] = 0xff; d[o++] = 0xff; }
  while (o < 255) d[o++] = 0;
}
export const cellOf = (dest, src) => dest * 34 + src;
const srcBlock = (c) => (c < 2 ? -1 : (c - 2) >> 2);
/** The name a route source column has with the program's blocks (ADD ROUTE FROM texts). */
export function sourceName(d, c) {
  if (c === 0) return 'INPUT LEFT';
  if (c === 1) return 'INPUT RIGHT';
  const k = srcBlock(c);
  const type = typeOf(d[P.cfg + k]);
  if (!type) return `BLOCK ${k + 1} (OFF)`;
  return `${ABBR[type.f].padEnd(3)} ${k + 1} ${type.outs[(c - 2) & 3]}`;
}
export function destName(d, r) {
  if (r === 8) return 'OUT L';
  if (r === 9) return 'OUT R';
  const type = typeOf(d[P.cfg + r]);
  return type ? `${ABBR[type.f].padEnd(3)} ${r + 1}` : `BLOCK ${r + 1} (OFF)`;
}
/** Whether a source column exists with the program's blocks (mono outputs have MIX only). */
export function sourceValid(d, c) {
  if (c < 2) return true;
  const type = typeOf(d[P.cfg + srcBlock(c)]);
  if (!type) return false;
  const j = (c - 2) & 3;
  return j <= 1 || type.outs[j] !== 'MIX';
}
const destValid = (d, r) => r >= 8 || !!typeOf(d[P.cfg + r]);

/** The data a type starts with: what the firmware gives it coming from another function (EQ, PITCH, DELAY: as
 * the generator recorded it) or the page records' defaults (REVERB: the recorded data carries Concert Hall's). */
export function typeDefaults(t) {
  if (t.f !== 4) return hex(t.def);
  const b = new Uint8Array(t.size);
  for (const pg of t.pages) writePage(b, 0, pg, pg.def);
  return b;
}
const TIME = new Set(['DECAY', 'REVERSE TIME', 'GATE TIME']);
const NO_CARRY = new Set(['REFLECTION LEVEL', 'REFLECTION SPREAD', 'SWIRL', 'ATTACK']);
const rkey = (pg) => { const k = (pg.mod || pg.label || '').replace(/\s+/g, ' '); return TIME.has(k) ? 'TIME' : k; };
/** A block's data after a type change on the CONFIG page (checked against the firmware, CHECKS.config): another
 * function starts from the defaults; PITCH types keep the values page by page, REVERB types the shared reverb
 * parameters (by name; DECAY / REVERSE TIME / GATE TIME as one, not REFLECTION / SWIRL / ATTACK); DELAY and EQ
 * types start from the defaults. */
export function convertBlock(oldType, oldData, newType) {
  const out = typeDefaults(newType);
  if (!oldType || oldType.f !== newType.f) return out;
  if (newType.f === 2) {
    newType.pages.forEach((pg, i) => { const o = oldType.pages[i]; if (o && o.w === pg.w) writePage(out, 0, pg, readPage(oldData, 0, o)); });
  } else if (newType.f === 4) {
    for (const pg of newType.pages) {
      if (NO_CARRY.has(rkey(pg))) continue;
      const o = oldType.pages.find((x) => rkey(x) === rkey(pg) && x.w === pg.w);
      if (o) writePage(out, 0, pg, readPage(oldData, 0, o));
    }
  }
  return out;
}

/** A program with new block types: the data of unchanged blocks kept, changed ones converted (convertBlock). */
export function setBlockTypes(d, cfgs) {
  const before = layout(d);
  const routes = readRoutes(d);
  const data = new Map(before.blocks.map((b) => [b.k, d.slice(b.off, b.off + b.type.size)]));
  const out = Uint8Array.from(d);
  for (let k = 0; k < N_BLOCKS; k++) {
    const old = d[P.cfg + k];
    const cfg = cfgs[k] ?? old;
    out[P.cfg + k] = typeOf(cfg) ? cfg : 0;
    if (out[P.cfg + k] !== old) {
      data.set(k, typeOf(cfg) ? convertBlock(typeOf(old), data.get(k), typeOf(cfg)) : null);
      if ((old >> 5) !== (out[P.cfg + k] >> 5)) out[P.levels + 1 + 2 * k] = 100; // a new function (or OFF): MIX TO L/R 100 %
    }
  }
  let o = P.blocks;
  for (let k = 0; k < N_BLOCKS; k++) {
    const type = typeOf(out[P.cfg + k]);
    if (!type) continue;
    const b = data.get(k) || typeDefaults(type);
    out.set(b.slice(0, type.size), o);
    o += type.size;
  }
  // routes from outputs a type no longer has go to its MIX output; a block that turns stereo sends its MIX
  // routes to OUT L / OUT R from LEFT / RIGHT; routes of blocks turned off go
  const stereo = (t) => !!t && t.outs[2] !== 'MIX';
  const fixed = [];
  for (const r of routes) {
    const dest = Math.floor(r.cell / 34);
    let src = r.cell % 34;
    const k = srcBlock(src);
    if (k >= 0 && dest >= 8 && (src - 2) % 4 === 1 && out[P.cfg + k] !== d[P.cfg + k] && stereo(typeOf(out[P.cfg + k])) && !stereo(typeOf(d[P.cfg + k]))) src += dest - 7;
    if (!destValid(out, dest)) continue;
    if (src >= 2 && !sourceValid(out, src)) {
      if (!typeOf(out[P.cfg + srcBlock(src)])) continue;
      src = 2 + 4 * srcBlock(src) + 1;
    }
    fixed.push({ cell: cellOf(dest, src), level: r.level });
  }
  writeRoutes(out, fixed);
  return out;
}

// ------------------------------------------------------------------ programs
/** The init program of a user memory (18B5): blank name, levels 100 %, both generators, INPUT -> OUT. */
export function initProgram() {
  const d = new Uint8Array(SIZE);
  d.fill(0x20, 0, NAME_LEN);
  d.fill(100, P.levels, P.levels + 18);
  d.set([0x00, 0x02, 0xee, 0xe8, 0x19, 0x1e, 0x4b], P.gens);
  d.set([0x01, 0x02, 0xee, 0xe8, 0x19, 0x1e, 0x4b], P.gens + 10);
  d.set([0x10, 0xba, 0x33, 0xba, 0xff, 0xff], P.blocks);
  return d;
}
export function presetData(n) {
  const d = new Uint8Array(SIZE);
  d.set(hex(PRESETS[Math.max(0, Math.min(N_PRESETS - 1, n))]));
  return d;
}
const PRESET_DATA = PRESETS.map((_, n) => presetData(n));
export const PRESET_NAMES = PRESET_DATA.map(nameOf);
export const PROGRAM_NAMES = Array.from({ length: 300 }, (_, i) => (i < 100 ? `Preset${pad2(i)}` : `User${i < 200 ? 0 : 1}-${pad2(i % 100)}`));
/** Program n as the user slot list names it: 0-99 User 0, 100-199 User 1. */
const userLabel = (n) => `${n < 100 ? 0 : 1}-${pad2(n % 100)}`;

// ------------------------------------------------------------------ parameters: program
const opt = (texts) => texts.map((s, v) => [v, s]);
const optionsOf = (pg) => { const r = pageValues(pg); return r.raws.map((v, i) => [v, r.texts[i] ?? String(v)]); };
const blockTitle = (d, k) => { const t = typeOf(d[P.cfg + k]); return t ? `${ABBR[t.f]} ${k + 1}: ${t.name}` : `Block ${k + 1}: OFF`; };
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
/** The page's LCD label, with its MOD target name when that says more ("LO (LOW DAMPING)"). */
const pageLabel = (pg) => {
  if (pg.stub) return `${norm(pg.mod)} (no page)`;
  const l = norm(pg.label) || `Page ${pg.g + 1}.${pg.p + 1}`;
  return pg.mod && norm(pg.mod) !== l ? `${l} (${norm(pg.mod)})` : l;
};
function readPage(d, base, pg) {
  if (pg.w) { const v = (d[base + pg.off] << 8) | d[base + pg.off + 1]; return pg.min < 0 ? s16(v) : v; }
  const v = d[base + pg.off];
  return pg.min < 0 ? s8(v) : v;
}
function writePage(d, base, pg, v) {
  v = Math.max(pg.min, Math.min(pg.max, Math.round(v)));
  if (pg.w) { d[base + pg.off] = (v >> 8) & 0xff; d[base + pg.off + 1] = v & 0xff; } else d[base + pg.off] = v & 0xff;
}
const sendProgram = (_v, ctx, data) => programMessage(EDIT_BUFFER, data);

function blockParams(k) {
  const g = `Block ${k + 1}`;
  const cfgOptions = [[0, 'OFF'], ...TYPES.map((t) => [t.cfg, `${FUNCS[t.f]}: ${t.name}`])];
  const params = [{
    key: `b${k}cfg`, group: g, label: `BLOCK ${k + 1} FUNCTION / TYPE`, offset: P.cfg + k, options: cfgOptions, relayout: true, send: sendProgram, sendKey: 'program',
    help: `CONFIG pages BLOCK ${k + 1} FUNCTION and its TYPE. A new type starts from its default values, as on the unit; routes from outputs the new type does not have go to its MIX output`,
    dynamic: (d) => ({ label: blockTitle(d, k) }),
    set: (d, v) => { d.set(setBlockTypes(d, { [k]: v })); },
  }];
  for (let i = 0; i < MAX_SLOTS; i++) {
    params.push({
      key: `b${k}p${i}`, group: g, label: `Page ${i + 1}`, offset: 0, size: SIZE, min: -32768, max: 65535, send: (v, ctx, data) => sendBlockPage(k, i, v, data), sendKey: `b${k}`,
      dynamic: (d) => {
        const b = blockOf(d, k);
        const pg = b?.type.pages[i];
        if (!pg) return { hidden: true };
        const r = pageValues(pg);
        const help = `${pg.screen ? `"${pg.screen.trimEnd()}"` : 'no edit page on the unit'}${pg.mod ? `; MOD target ${pg.mod}` : ''}; ${r.texts[0] ?? pg.min} to ${r.texts.at(-1) ?? pg.max}`;
        return r.raws.length > BIG || !r.texts.length
          ? { label: `${pageLabel(pg)} (raw)`, input: 'number', min: pg.min, max: pg.max, format: (v) => valueText(pg, v), help }
          : { label: pageLabel(pg), options: optionsOf(pg), help };
      },
      get: (d) => { const b = blockOf(d, k); const pg = b?.type.pages[i]; return pg ? readPage(d, b.off, pg) : 0; },
      set: (d, v) => { const b = blockOf(d, k); const pg = b?.type.pages[i]; if (pg) writePage(d, b.off, pg, v); },
    });
  }
  params.push({ key: `b${k}bypass`, group: g, label: 'BYPASS (as stored)', offset: P.bypass, bits: 1, shift: k, options: [[0, 'Off'], [1, 'On']], send: sendProgram, sendKey: 'program',
    help: 'The block\'s bypass state (BYPASS, then the block number on the unit) when the program was stored. The unit also sends and takes bypass changes as they happen' });
  return params;
}
/** EDIT pages go live (SysEx 01 00 block group page value); stubs have no page: the whole program goes. */
function sendBlockPage(k, i, v, data) {
  const b = blockOf(data, k);
  const pg = b?.type.pages[i];
  if (!pg || pg.stub) return programMessage(EDIT_BUFFER, data);
  return editMessage(0, k + 1, pg.g + 1, pg.p + 1, v & 0xffff);
}

const LEVEL_TEXTS = Array.from({ length: 101 }, (_, i) => `${i}%`);
function levelParams() {
  const name = (i) => (i === 0 ? 'DIRECT LEVEL FROM INPUT' : i === 17 ? 'MASTER EFFECTS LEVEL' : `Block ${((i - 1) >> 1) + 1} ${(i - 1) & 1 ? 'INMIX TO L/R' : 'LEVEL TO L/R (MIX)'}`);
  return Array.from({ length: 18 }, (_, i) => ({
    key: `lv${i}`, group: 'MIX', label: name(i), offset: P.levels + i, options: opt(LEVEL_TEXTS), sendKey: 'mix',
    help: `MOD target MIX ${128 + i}: ${MIX_TARGETS[i].replace(/^(DLY|EQ |RVB|PCH)\d /, 'block ')}${i >= 1 && i <= 16 && (i - 1) & 1 ? ' (no MIX page: sent with the program)' : ''}`,
    dynamic: i >= 1 && i <= 16 ? (d) => { const k = (i - 1) >> 1; const t = typeOf(d[P.cfg + k]); return t ? { label: `${ABBR[t.f]} ${k + 1} ${(i - 1) & 1 ? 'INMIX TO L/R' : 'LEVEL TO L/R'}` } : { hidden: true }; } : undefined,
    send: (v, ctx, data) => {
      if (i === 0) return editMessage(1, 1, 2, 1, v);
      if (i === 17) return editMessage(1, 1, 3, 1, v);
      if ((i - 1) & 1) return programMessage(EDIT_BUFFER, data);
      return editMessage(1, ((i - 1) >> 1) + 1, 1, 1, v);
    },
  }));
}

/** MOD TO parameters of target block b (1-8 a block, 9 OUT L, 10 OUT R, 11 MIX) with the program's blocks. */
export function modTargets(d, b) {
  if (b === 11) return MIX_TARGETS.map((s, i) => [128 + i, s.replace(/^(DLY|EQ |RVB|PCH)(\d)/, (m, a, n) => { const t = typeOf(d[P.cfg + Number(n) - 1]); return t ? `${ABBR[t.f].padEnd(3)}${n}` : `${a}${n}`; })]);
  const out = [];
  if (b >= 1 && b <= 8) {
    const t = typeOf(d[P.cfg + b - 1]);
    if (t) t.pages.forEach((pg, i) => out.push([i, pg.mod || pageLabel(pg)]));
  }
  if (b >= 1 && b <= 10) {
    const dest = b <= 8 ? b - 1 : b - 1;
    for (const r of readRoutes(d)) if (Math.floor(r.cell / 34) === dest) out.push([64 + (r.cell % 34), `${sourceName(d, r.cell % 34)} LEVEL`]);
  }
  return out;
}
function modParams(m) {
  const o = P.mods + 4 * m;
  const g = `MOD ${m + 1}`;
  return [
    { key: `m${m}s`, group: g, label: `MOD ${m + 1} SOURCE`, offset: o, options: opt(MOD_SOURCES), send: sendProgram, sendKey: 'program', help: 'What drives the modulation: PITCH BEND, AFTERTOUCH, NOTE NUMBER, NOTE VELOCITY, CONTROLLER 000-125, LOCAL GENERATOR 1 / 2' },
    { key: `m${m}b`, group: g, label: `MOD ${m + 1} TO (block)`, offset: o + 1, min: 0, max: 11, relayout: true, send: sendProgram, sendKey: 'program',
      help: 'Where the modulation goes: a block, OUT L, OUT R or MIX (MOD x TO, the field before the dash)',
      dynamic: (d) => ({ options: [[0, '(none)'], ...MOD_BLOCKS.map((s, i) => [i + 1, i < 8 ? destName(d, i) : s])] }) },
    { key: `m${m}p`, group: g, label: `MOD ${m + 1} TO (parameter)`, offset: o + 2, min: 0, max: 255, send: sendProgram, sendKey: 'program',
      help: 'What the modulation changes: one of the block\'s own parameters, the level of a route into the block or output, or a MIX level',
      dynamic: (d) => { const list = modTargets(d, d[o + 1]); const v = d[o + 2]; return { options: list.some(([x]) => x === v) ? list : [...list, [v, `${v} (not a target here)`]] }; } },
    { key: `m${m}a`, group: g, label: `MOD ${m + 1} AMPLITUDE`, offset: o + 3, signed: true, options: (() => { const t = expandTexts(MOD_AMOUNT.t); return t.map((s, i) => [MOD_AMOUNT.min + i, s]); })(), send: sendProgram, sendKey: 'program', help: 'How far and which way the modulation moves the target: -99 to +99' },
  ];
}
function genParams(k) {
  const o = P.gens + 10 * k;
  const g = `GEN ${k + 1}`;
  const maxPages = Math.max(...GENS.map((x) => x.pages.length));
  const params = [{ key: `g${k}t`, group: g, label: `GEN ${k + 1} TYPE`, offset: o, options: GENS.map((x, i) => [i, x.name]), relayout: true, send: sendProgram, sendKey: 'program',
    help: 'The generator type. The types share the same memory, so a new type starts from what the previous one left there' }];
  for (let i = 1; i < maxPages; i++) {
    params.push({ key: `g${k}p${i}`, group: g, label: `Page ${i}`, offset: 0, size: SIZE, min: -128, max: 255, send: sendProgram, sendKey: 'program',
      dynamic: (d) => { const pg = GENS[d[o]]?.pages[i]; return pg ? { label: `${pg.label}`, options: optionsOf(pg), help: `"${pg.screen.trimEnd()}"` } : { hidden: true }; },
      get: (d) => { const pg = GENS[d[o]]?.pages[i]; return pg ? readPage(d, o, pg) : 0; },
      set: (d, v) => { const pg = GENS[d[o]]?.pages[i]; if (pg) writePage(d, o, pg, v); } });
  }
  return params;
}
const NONE = 0xffff;
function routeParams() {
  const params = [];
  for (let i = 0; i < MAX_ROUTES; i++) {
    params.push({ key: `r${i}c`, group: 'ROUTES', label: `Route ${i + 1}`, offset: 0, size: SIZE, min: 0, max: NONE, relayout: true, send: sendProgram, sendKey: 'program',
      dynamic: (d) => {
        const rs = readRoutes(d);
        if (i > rs.length) return { hidden: true };
        const cells = [];
        for (let r = 0; r < 10; r++) for (let c = 0; c < 34; c++) if (destValid(d, r) && sourceValid(d, c)) cells.push([cellOf(r, c), `${sourceName(d, c)} → ${destName(d, r)}`]);
        return { options: [[NONE, i === rs.length ? '(add a route)' : '(delete)'], ...cells], help: 'ADD ROUTE / DELETE ROUTE: the source and where it goes (a block\'s input or an output); stored in matrix order' };
      },
      get: (d) => readRoutes(d)[i]?.cell ?? NONE,
      set: (d, v) => {
        const rs = readRoutes(d);
        if (v === NONE) rs.splice(i, 1);
        else if (i < rs.length) rs[i] = { cell: v, level: rs[i].level };
        else rs.push({ cell: v, level: 58 });
        writeRoutes(d, rs);
      } });
    params.push({ key: `r${i}l`, group: 'ROUTES', label: `Route ${i + 1} LEVEL`, offset: 0, size: SIZE, min: 0, max: 58, options: opt(ROUTE_LEVELS), send: sendProgram, sendKey: 'program',
      dynamic: (d) => (i < readRoutes(d).length ? { help: `LEVEL FROM: ${sourceName(d, readRoutes(d)[i].cell % 34)} (0 OFF, 1-58 -48.0 dB to +0.0 dB)` } : { hidden: true }),
      get: (d) => readRoutes(d)[i]?.level ?? 0,
      set: (d, v) => { const rs = readRoutes(d); if (rs[i]) { rs[i].level = v; writeRoutes(d, rs); } } });
  }
  return params;
}
export const programParams = [
  ...Array.from({ length: N_BLOCKS }, (_, k) => blockParams(k)).flat(),
  ...levelParams(),
  ...Array.from({ length: 8 }, (_, m) => modParams(m)).flat(),
  ...genParams(0), ...genParams(1),
  ...routeParams(),
  { key: 'preset', group: 'Name', label: 'ROM preset', offset: 0, size: SIZE, options: PRESET_NAMES.map((n, i) => [i, `Preset${pad2(i)} ${n}`]), hidden: true, relayout: true, send: sendProgram, sendKey: 'program',
    help: 'Loads a ROM preset into the editor (the gallery uses it); the value shows the preset the program equals',
    get: (d) => Math.max(0, PRESET_DATA.findIndex((p) => p.every((b, k) => b === d[k]))),
    set: (d, v) => d.set(presetData(v)) },
  ...Array.from({ length: NAME_LEN }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: P.name + i, min: 0x20, max: 0x7f, kind: 'char', hidden: true, send: sendProgram, sendKey: 'program' })),
];

// ------------------------------------------------------------------ globals and the program table
// System object: the 14 bytes of the global dump (07) then the MIDI program table, two bytes per entry
// (program 0-299 high byte first).
export const SYS_SIZE = 14 + 256;
export const TABLE_AT = 14;
const GLOBAL_ORDER = [0xf0, 0xf2, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe]; // byte 13: F3 bit 0 << 1 | F1 bit 0
export const globalsMessage = (s) => [...HEAD, OP.globals, ...pack7(s.slice(0, 14)), 0xf7];
export function tableMessage(s) {
  const body = [];
  for (let i = 0; i < 128; i++) {
    const v = ((s[TABLE_AT + 2 * i] << 8) | s[TABLE_AT + 2 * i + 1]) & 0x1ff;
    body.push(v & 0x7f, ((v >> 7) & 1) | (((v >> 8) & 1) << 1));
  }
  return [...HEAD, OP.table, ...body, 0xf7];
}
export function initialSystem() {
  const s = new Uint8Array(SYS_SIZE);
  s.set([6, 0, 0x2b, 0, 0, 0, 1, 2, 1, 2, 0, 0, 0, 0]); // the first power-up (1958): contrast 6, footswitch Preset00 TO User1-99
  return s;
}
function applySystem(s, raw) {
  if (!isQv2(raw)) return false;
  if (op(raw) === OP.globals) { s.set(unpack7(raw.slice(6, raw.length - 1), 14)); return true; }
  if (op(raw) === OP.table && raw.length >= 6 + 256 + 1) {
    for (let i = 0; i < 128; i++) {
      const a = raw[6 + 2 * i];
      const b = raw[7 + 2 * i];
      const v = (a & 0x7f) | ((b & 1) << 7) | (((b >> 1) & 1) << 8);
      s[TABLE_AT + 2 * i] = v >> 8;
      s[TABLE_AT + 2 * i + 1] = v & 0xff;
    }
    return true;
  }
  return false;
}
const gpage = (g, p = 0) => GLOBAL_PAGES.find((x) => x.g === g && x.p === p);
const globalAt = (addr) => (addr === 0xf1 || addr === 0xf3 ? -1 : GLOBAL_ORDER.indexOf(addr));
function globalParam(pg, key) {
  const gi = globalAt(pg.off);
  const base = { key, section: 'settings', group: 'GLOBAL', label: pg.label || 'GLOBAL', sendKey: 'globals', send: (_v, ctx, s) => globalsMessage(s),
    help: `"${(pg.screen || '').trimEnd()}"` };
  if (pg.w) {
    // FOOTSWITCH range ends: high bit in byte 13 (F1 -> bit 0, F3 -> bit 1), low byte F2 / F4
    const lo = GLOBAL_ORDER.indexOf(pg.off + 1);
    const bit = pg.off === 0xf1 ? 0 : 1;
    return { ...base, offset: 0, size: 14, min: 0, max: 299, options: PROGRAM_NAMES.map((n, i) => [i, n]),
      get: (s) => (((s[13] >> bit) & 1) << 8) | s[lo], set: (s, v) => { s[lo] = v & 0xff; s[13] = (s[13] & ~(1 << bit)) | (((v >> 8) & 1) << bit); } };
  }
  return { ...base, offset: gi, options: optionsOf(pg) };
}
export const systemParams = [
  ...GLOBAL_PAGES.map((pg, i) => globalParam(pg, `gl${i}`)),
  ...Array.from({ length: 128 }, (_, i) => ({
    key: `t${i}`, section: 'settings', group: 'PROGRAM TABLE', label: `${String(i).padStart(3, '0')} =`, offset: TABLE_AT + 2 * i, size: 2, min: 0, max: 299,
    options: PROGRAM_NAMES.map((n, k) => [k, n]), sendKey: 'table', send: (_v, ctx, s) => tableMessage(s),
    help: 'MIDI PROGRAM TABLE (MIDI page; used with MIDI PROGRAM CHANGE: TABLE)',
  })),
];

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = {
    edit: presetData(0), users: Array.from({ length: 200 }, () => initProgram()), system: initialSystem(), bypass: 0,
    sysexOn: true, edits: [], display: '',
  };
  const dump = (n) => programMessage(n, n === EDIT_BUFFER ? st.edit : st.users[n]);
  return {
    state: st,
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) { const n = d[1]; st.edit = n < 100 ? presetData(n) : Uint8Array.from(st.users[n - 100]); return []; }
      if (!isQv2(d) || !st.sysexOn) return d[0] === 0xf0 ? [] : null;
      const o = op(d);
      if (o === OP.request || o === OP.request1) {
        const k = d[6];
        if (k === WIRE_EDIT) return [Uint8Array.from(dump(EDIT_BUFFER))];
        if (o === OP.request && k > WIRE_EDIT) return [...st.users.map((_, i) => Uint8Array.from(dump(i))), Uint8Array.from(globalsMessage(st.system)), Uint8Array.from(tableMessage(st.system))];
        return k < 100 ? [Uint8Array.from(dump(k + (o === OP.request1 ? 100 : 0)))] : [];
      }
      if (o === OP.program || o === OP.program1) {
        const p = parseProgram(d);
        if (!p) return [];
        if (p.n === EDIT_BUFFER) st.edit = p.data;
        else st.users[p.n] = p.data;
        return [];
      }
      if (o === OP.edit) {
        const [f, block, g, p] = Array.from(d.slice(6, 10));
        const raw = unpack7(d.slice(10, 13), 2);
        const v = raw[0] | (raw[1] << 8);
        st.edits.push({ f, block, g, p, v });
        if (f === 0) {
          const b = blockOf(st.edit, block - 1);
          const pg = b?.type.pages.find((x) => x.g === g - 1 && x.p === p - 1 && !x.stub);
          if (pg) writePage(st.edit, b.off, pg, pg.min < 0 ? s16(v) : v);
        } else if (f === 1) {
          const i = g === 1 ? 1 + 2 * (block - 1) : g === 2 ? 0 : 17;
          st.edit[P.levels + i] = Math.max(0, Math.min(100, v));
        }
        return [];
      }
      if (o === OP.globalsReq) return [Uint8Array.from(globalsMessage(st.system))];
      if (o === OP.tableReq) return [Uint8Array.from(tableMessage(st.system))];
      if (o === OP.globals || o === OP.table) { applySystem(st.system, d); return []; }
      if (o === OP.bypassReq) return [Uint8Array.from([...HEAD, OP.bypass, st.bypass >> 1, (st.bypass & 1) << 6, 0xf7])];
      if (o === OP.bypass) { st.bypass = ((d[6] << 1) | (d[7] >> 6)) & 0xff; return []; }
      return [];
    },
  };
}

// ------------------------------------------------------------------ monitor, library
function describe(raw) {
  if (!isQv2(raw)) return null;
  const o = op(raw);
  const p = parseProgram(raw);
  if (p) return `Quadraverb 2 program ${p.n === EDIT_BUFFER ? 'edit buffer' : `User ${userLabel(p.n)}`} "${nameOf(p.data)}"`;
  if (o === OP.request) return raw[6] === WIRE_EDIT ? 'Quadraverb 2 edit buffer request' : raw[6] > WIRE_EDIT ? 'Quadraverb 2 request: everything' : `Quadraverb 2 request: User 0-${pad2(raw[6])}`;
  if (o === OP.request1) return `Quadraverb 2 request: User 1-${pad2(raw[6])}`;
  if (o === OP.edit) return `Quadraverb 2 page value (${['EDIT', 'MIX', 'GLOBAL', 'CONFIG'][raw[6]] ?? raw[6]} block ${raw[7]} page ${raw[8]}.${raw[9]})`;
  if (o === OP.globals) return 'Quadraverb 2 global data';
  if (o === OP.globalsReq) return 'Quadraverb 2 global data request';
  if (o === OP.table) return 'Quadraverb 2 MIDI program table';
  if (o === OP.tableReq) return 'Quadraverb 2 program table request';
  if (o === OP.bypass) return 'Quadraverb 2 block bypass';
  if (o === OP.bypassReq) return 'Quadraverb 2 block bypass request';
  return `Quadraverb 2 message ${o.toString(16)}h`;
}
function libraryItems(msgs) {
  const items = [];
  const sys = initialSystem();
  let sysMsgs = [];
  for (const m of msgs) {
    const p = parseProgram(m);
    if (p) items.push({ key: `p${items.length}`, label: p.n === EDIT_BUFFER ? 'Edit buffer' : `User ${userLabel(p.n)}`, name: nameOf(p.data), object: 'effect', data: p.data, msgs: [m] });
    else if (applySystem(sys, m)) sysMsgs.push(m);
    else items.push({ key: `x${items.length}`, label: describe(m) || 'Other message', name: '', object: null, msgs: [m] });
  }
  if (sysMsgs.length) items.push({ key: 'system', label: 'Globals and program table', name: '', object: 'system', data: sys, msgs: sysMsgs });
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: the first reverb block (DECAY over its range, PREDELAY, its LEVEL TO L/R), the first delay
// (its first delay time over 1500 ms, FEEDBACK), the first chorus / flange / phasor / lezlie (SPEED, DEPTH)
// become effects.*; values on 0..1 of their page's range. The program goes in extra (family
// 'alesis-quadraverb2'), so Quadraverb 2 -> Quadraverb 2 is exact. fromCommon: the same family loads the
// bytes; anything else starts from the ROM preset that has the wanted blocks and sets what maps.
const FAMILY = 'alesis-quadraverb2';
const frac = (pg, v) => { const r = pageValues(pg); const i = r.index.get(v); return r.raws.length > 1 && i !== undefined ? i / (r.raws.length - 1) : Math.max(0, Math.min(1, (v - pg.min) / ((pg.max - pg.min) || 1))); };
const findPg = (type, re) => type.pages.find((pg) => !pg.stub && re.test(`${pg.label || ''} ${pg.mod || ''}`));
function toCommon(d) {
  const effects = {};
  const lay = layout(d);
  const lvl = (k) => d[P.levels + 1 + 2 * k] / 100;
  for (const b of lay.blocks) {
    const t = b.type;
    const get = (pg) => (pg ? readPage(d, b.off, pg) : 0);
    if (t.f === 4 && !effects.reverb) {
      const dec = findPg(t, /^DECAY|REVERSE TIME|GATE TIME/);
      const pre = findPg(t, /PREDELAY/);
      effects.reverb = { type: t.name, time: dec ? frac(dec, get(dec)) : 0.5, level: lvl(b.k) };
      if (pre) effects.reverb.preDelay = frac(pre, get(pre));
    } else if (t.f === 3 && !effects.delay && t.t !== 6) {
      const tm = findPg(t, /DELAY TIME|^DELAY|L DLY|TAP 1 DELAY/);
      const fb = findPg(t, /FEEDBACK/);
      effects.delay = { type: t.name, time: tm ? Math.min(1, get(tm) / (tm.max > 3000 ? 15000 : 1500)) : 0.3, level: lvl(b.k) };
      if (fb) effects.delay.feedback = frac(fb, get(fb));
    } else if (t.f === 2 && !effects.modulation && /CHORUS|FLANG|PHASOR|LEZLIE/.test(t.name)) {
      const sp = findPg(t, /SPEED/);
      const dp = findPg(t, /DEPTH/);
      const m = { type: t.name, rate: sp ? frac(sp, get(sp)) : 0.5, depth: dp ? frac(dp, get(dp)) : 0.5, level: lvl(b.k) };
      effects.modulation = m;
      if (/CHORUS/.test(t.name)) effects.chorus = { ...m };
    }
  }
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'alesis-quadraverb2', blocks: lay.blocks.map((b) => `${ABBR[b.type.f]} ${b.k + 1} ${b.type.name}`), data: Array.from(d), match: hashBytes(d) } };
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
    r.mapped.push('Program (exact)');
    return { data: Uint8Array.from(x.data), report: tidy(r) };
  }
  const fx = c?.effects || {};
  const on = (e) => e && (e.level ?? 1) > 0;
  const want = { 4: on(fx.reverb), 3: on(fx.delay), 2: on(fx.modulation) || on(fx.chorus) };
  const score = (n) => { const fs = layout(presetData(n)).blocks.map((b) => b.type.f); return [4, 3, 2].reduce((s, f) => s + (want[f] === fs.includes(f) ? 1 : 0), 0) - fs.length / 100; };
  let best = 0;
  for (let n = 1; n < N_PRESETS - 1; n++) if (score(n) > score(best)) best = n;
  if (!want[4] && !want[3] && !want[2]) {
    r.dropped.push('No effect in the source sound: the program keeps its blocks and settings');
    return { data: Uint8Array.from(base || presetData(0)), report: tidy(r) };
  }
  const d = presetData(best);
  r.approximated.push(`Starting from Alesis preset ${pad2(best)} "${nameOf(d)}"`);
  for (const b of layout(d).blocks) {
    const t = b.type;
    const set = (pg, v, what) => { if (!pg || v === undefined || v === null || Number.isNaN(v)) return; const rr = pageValues(pg); const i = Math.round(Math.max(0, Math.min(1, v)) * (rr.raws.length - 1)); writePage(d, b.off, pg, rr.raws[i]); r.approximated.push(what); };
    if (t.f === 4 && fx.reverb) { set(findPg(t, /^DECAY/), fx.reverb.time, 'Reverb time → DECAY'); set(findPg(t, /PREDELAY/), fx.reverb.preDelay, 'Reverb pre-delay → PREDELAY'); }
    if (t.f === 3 && fx.delay) { set(findPg(t, /FEEDBACK/), fx.delay.feedback, 'Delay feedback → FEEDBACK'); }
    const m = fx.modulation || fx.chorus;
    if (t.f === 2 && m) { set(findPg(t, /SPEED/), m.rate, 'Modulation rate → SPEED'); set(findPg(t, /DEPTH/), m.depth, 'Modulation depth → DEPTH'); }
  }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
  if (base) setName(d, nameOf(base));
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ block diagram gallery
const SVG = 'http://www.w3.org/2000/svg';
function drawProgram({ value }) {
  const d = presetData(value);
  const lay = layout(d);
  const svg = document.createElementNS(SVG, 'svg');
  const W = Math.max(1, lay.blocks.length) * 46 + 10;
  svg.setAttribute('viewBox', `0 0 ${W} 30`);
  svg.setAttribute('width', String(Math.min(260, W)));
  const el = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  lay.blocks.forEach((b, i) => {
    const x = 5 + i * 46;
    el('rect', { x, y: 4, width: 40, height: 22, rx: 3, fill: 'none', stroke: 'currentColor' });
    el('text', { x: x + 20, y: 14, 'text-anchor': 'middle', 'font-size': 7, fill: 'currentColor' }, `${ABBR[b.type.f]} ${b.k + 1}`);
    el('text', { x: x + 20, y: 22, 'text-anchor': 'middle', 'font-size': 5, fill: 'currentColor' }, b.type.name.slice(0, 12));
  });
  return svg;
}

// ------------------------------------------------------------------ definition
const isOp = (o) => (raw) => isQv2(raw) && op(raw) === o;
const readProgram = (api, n) => api.request(requestMessage(n), (r) => parseProgram(r)?.n === n, (r) => parseProgram(r).data);
async function readSystem(api) {
  const s = initialSystem();
  await api.request([...HEAD, OP.globalsReq, 0xf7], isOp(OP.globals), (r) => applySystem(s, r));
  await api.request([...HEAD, OP.tableReq, 0xf7], isOp(OP.table), (r) => applySystem(s, r));
  return s;
}
const blockLayout = Array.from({ length: N_BLOCKS }, (_, k) => ({ group: `Block ${k + 1}` }));
export default {
  coverage: 'Edits the Quadraverb 2\'s programs: the eight blocks (function, type and every EDIT page of all 53 types, each value shown as the display shows it), the MIX levels, MOD 1-8, GEN 1 / 2, the routes, the name and the bypass states; shows the 100 presets; and edits the GLOBAL pages and the MIDI program table. EDIT and MIX page changes are sent at once; other changes send the whole program. Not checked on hardware.',
  sysex: { manufacturer: [0x00, 0x00, 0x0e], model: 0x0f },
  minGap: 60,
  describe,
  recognise: isQv2,
  isOwn: isQv2,
  isRequest: (raw) => isQv2(raw) && [OP.request, OP.request1, OP.globalsReq, OP.tableReq, OP.bypassReq].includes(op(raw)),
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: SIZE,
      init: () => presetData(0),
      request: () => requestMessage(EDIT_BUFFER),
      match: (raw) => parseProgram(raw)?.n === EDIT_BUFFER,
      decode: (raw) => parseProgram(raw).data,
      params: programParams,
      name: nameOf,
      setName,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 3,
      layout: [...blockLayout, { group: 'MIX' }, ...Array.from({ length: 8 }, (_, m) => ({ group: `MOD ${m + 1}` })), { group: 'GEN 1' }, { group: 'GEN 2' }, { group: 'ROUTES', wide: true }],
      note: 'The program the unit is playing. EDIT and MIX page changes are sent at once, as if made on the unit; other changes (blocks, MODs, generators, routes, name) send the whole program. SYSTEM EXCLUSIVE RECEIVE must be ON (MIDI page). Press STORE on the unit to keep it, or use the slot list.',
      sendAll: { label: 'Send to edit buffer', title: 'Send the whole program to the unit to play; nothing is stored', build: (data) => programMessage(EDIT_BUFFER, data) },
      toSyx: (data) => programMessage(EDIT_BUFFER, data),
      fromSyx: (msgs) => { const p = msgs.map(parseProgram).find(Boolean); return p ? p.data : null; },
      actions: [
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Program name', [{ key: 'name', label: 'Name (14 characters)', value: nameOf(api.data), maxlength: NAME_LEN }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name);
          api.setData(d);
        } },
        { label: 'Init program', title: 'The program a user memory holds after the unit is initialised: no blocks, INPUT -> OUT', run: (api) => api.setData(initProgram()) },
      ],
      galleries: [{
        key: 'presets', page: 'Presets', icon: '▦',
        note: 'The 100 built-in presets and their blocks. Choosing one loads it into the editor, as a program change to Preset 00-99 recalls it on the unit.',
        param: 'preset',
        label: (v) => `Preset${pad2(v)} ${PRESET_NAMES[v]}`,
        draw: drawProgram,
      }],
      slots: {
        label: 'Programs', banks: [[0, 'User 0'], [1, 'User 1'], [2, 'Preset (ROM)']],
        count: () => 100,
        slotLabel: (bank, i) => (bank === 2 ? `Preset${pad2(i)}` : `${bank}-${pad2(i)}`),
        note: (bank) => (bank === 2 ? 'Built-in presets: Edit loads one from the editor\'s own copy; Play sends program change 0-99 (MIDI PROGRAM CHANGE ON recalls Preset 00-99).' : 'Edit reads the program from the unit; Store sends it into this memory. A program change reaches User programs only through the MIDI program table (MIDI PROGRAM CHANGE: TABLE).'),
        names: (bank) => (bank === 2 ? PRESET_NAMES : null),
        writable: (bank) => bank !== 2,
        name: nameOf,
        recall: (bank, i, ctx) => (bank === 2 ? [[0xc0 | ((ctx?.channel ?? 0) & 15), i]] : []),
        fetch: async (api, bank, i) => (bank === 2 ? presetData(i) : readProgram(api, bank * 100 + i)),
        store: (bank, i, ctx, data) => [programMessage(bank * 100 + i, data)],
      },
    },
    {
      key: 'system', page: 'Globals', icon: '⚙', label: 'Globals', size: SYS_SIZE,
      init: initialSystem,
      fetch: readSystem,
      receive: (raw, data) => { const s = Uint8Array.from(data || initialSystem()); return applySystem(s, raw) ? s : null; },
      params: systemParams,
      cols: 3,
      layout: [{ group: 'GLOBAL' }, { group: 'PROGRAM TABLE', wide: true }],
      note: 'The GLOBAL pages and the MIDI program table. MIDI CHANNEL, MIDI PROGRAM CHANGE, MIDI THRU and SYSTEM EXCLUSIVE RECEIVE cannot be set over MIDI: set them on the unit.',
      actions: [
        { label: 'Send to the Quadraverb 2', title: 'Send the GLOBAL pages and the program table', run: (api) => api.send([globalsMessage(api.data), tableMessage(api.data)]) },
        { label: 'First power-up contents', run: (api) => api.setData(initialSystem()) },
      ],
      toSyx: (data) => [...globalsMessage(data), ...tableMessage(data)],
      fromSyx: (msgs) => { const s = initialSystem(); let ok = false; for (const m of msgs) ok = applySystem(s, m) || ok; return ok ? s : null; },
    },
  ],
  requests: [
    { label: 'Edit buffer', bytes: () => requestMessage(EDIT_BUFFER) },
    { label: 'User 0-00', bytes: () => requestMessage(0) },
    { label: 'Everything (200 programs, globals, table)', bytes: () => REQUEST_ALL, timeout: 30000 },
    { label: 'Globals', bytes: () => [...HEAD, OP.globalsReq, 0xf7] },
    { label: 'Program table', bytes: () => [...HEAD, OP.tableReq, 0xf7] },
  ],
  fullDump: [{ request: 'Everything (200 programs, globals, table)', timeout: 30000, quiet: 3000 }, { request: 'Edit buffer' }],
  midiNotes: [
    'SysEx F0 00 00 0E 0F has no channel or device byte: every Quadraverb 2 on the cable takes it, with SYSTEM EXCLUSIVE RECEIVE ON (MIDI page).',
    'Programs: 02 n (User 0) / 0C n (User 1), n 64h = edit buffer; 256 bytes as 293 groups of 7 bits. Requests 03 n / 0D n; 03 65h asks for everything (200 programs, globals, program table).',
    'SysEx 01 sets one page of the edit buffer as the panel does: EDIT (block parameters), MIX, GLOBAL and CONFIG pages, by block, group and page; the value is clamped to the page range.',
    'Program change: with MIDI PROGRAM CHANGE ON program 0-99 recalls Preset 00-99 (TABLE: the program table maps 0-127 to any of the 300 programs).',
    'Messages 05 (DSP microcode) and 06 (a DSP register) are factory functions and not offered.',
  ],
};

export const _test = { simulate, toCommon, fromCommon, describe, libraryItems, sendBlockPage, GLOBAL_ORDER, gpage };
