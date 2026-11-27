// Viscount EFX-10 (1995 stereo multi-effect, 27 algorithms): MIDI implementation taken from the v1.02
// EPROM (16/10/1995, 128 KB, 8051). See docs/devices/viscount-efx10.md.
//
// Presets 001-027 are in ROM, one per algorithm (records at 1D6A2); 028-128 are user presets in battery RAM
// (2000h + 40h each). A preset is 64 bytes: 0-3 not shown (the number takes their place), 4-15 the title
// (12 characters 20h-7Fh, NAME EDIT 11DD), 16 the algorithm 0-26, 17-54 the algorithm's parameters, 55-57
// DIRECT / EFFECT / MASTER LEVEL, 58-59 the controllers MIDI CTRL 1 / 2 listen to (80h OFF, 60h PB, 0-31,
// 64-95), 60-61 the parameter each one moves (an index in the algorithm's list), 62 the XOR of bytes 0-61
// (a recall with a wrong one shows "** DATA ERROR **", 0E31), 63 not used.
//
// SysEx F0 31 1n 02 (Viscount, channel n, EFX-10):
//   12 aa bb <128 nibbles, high first> <XOR of the nibbles> F7: a 64-byte block (receiver 1DBB / 07FC), number
//      aa << 4 | bb: F0 / F1 the program map halves (3F00 / 3F40), F2 the settings (3FC0; 32 bytes kept),
//      1B-7F the user presets 028-128 (into the edit buffer instead while the unit is in EDIT)
//   45 F7: end of a dump (the receiving display goes to DATA RECEIVED and the program is recalled again)
//   03 xx pp <section index parameter value> F7: MIDI EDIT EXC., one parameter of the program shown (pp = its
//      number - 1; parser 1FEE, per algorithm table 2039)
// The unit takes them with MIDI EDIT EXC. ON, or while MIDI BULK LOAD shows WAITING (1CB1). Nothing can be
// requested: MIDI BULK DUMP sends FROM..TO (SYSTEM = map and settings, No.028-No.128) and 45 (14B3).
// Identity request F0 7E 0F 06 01 F7 (device 0F only) is answered with IDENTITY (0B7A).

import { FIRMWARE, ALGOS, ROM_PRESETS, USER_PRESETS, SETTINGS, SIGNATURE, IDENTITY, MENUS } from './viscount-efx10-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { readParam, writeParam } from '../../core/model/memmap.js';
import { hashBytes, tidy } from './translate-helpers.js';

export { FIRMWARE, ALGOS, ROM_PRESETS, USER_PRESETS, SETTINGS, SIGNATURE, IDENTITY, MENUS };

export const SIZE = 64;
export const TITLE_AT = 4;
export const TITLE_LEN = 12;
export const ALG_AT = 16;
export const CS_AT = 62;
export const ROM_COUNT = 27;
export const USER_FIRST = 27;            // preset index of 028 (block 1Bh)
export const USER_COUNT = 101;
export const BLOCK = { mapLo: 0xf0, mapHi: 0xf1, settings: 0xf2 };
export const OP = { block: 0x12, end: 0x45, edit: 0x03 };
// the system object: program map (3F00-3F7F) then the settings block (3FC0-3FFF)
export const MAP_AT = 0;
export const SET_AT = 128;
export const SYS_SIZE = SET_AT + 64;
export const S = { program: 0, channel: 1, flags: 2, dumpFrom: 3, dumpTo: 4, shiftFrom: 5, shiftTo: 6, sel1: 7, sel2: 8, sel3: 9, ctrl1Min: 10, ctrl1Max: 11, ctrl2Min: 12, ctrl2Max: 13, contrast: 14 };

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad3 = (n) => String(n).padStart(3, '0');

// ------------------------------------------------------------------ messages
export const isEfx10 = (raw) => raw?.[0] === 0xf0 && raw.length > 5 && raw[1] === 0x31 && (raw[2] & 0xf0) === 0x10 && raw[3] === 0x02;
export const isIdentityReply = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x7e && raw[3] === 0x06 && raw[4] === 0x02 && raw[5] === 0x31;
export const IDENTITY_REQUEST = [0xf0, 0x7e, 0x0f, 0x06, 0x01, 0xf7];
const op = (raw) => raw[4];
const hdr = (ch = 0) => [0xf0, 0x31, 0x10 | (ch & 15), 0x02];

/** A 64-byte block as the unit sends it (1BBF / 1C0D): each byte as two nibbles, the XOR of the nibbles. */
export function blockMessage(block, bytes, ch = 0) {
  const body = [];
  let cs = 0;
  for (let i = 0; i < 64; i++) {
    const b = bytes[i] ?? 0;
    body.push(b >> 4, b & 15);
    cs ^= (b >> 4) ^ (b & 15);
  }
  return [...hdr(ch), OP.block, (block >> 4) & 15, block & 15, ...body, cs, 0xf7];
}
/** {block, data, ok} of a block message, or null. */
export function parseBlock(raw) {
  if (!isEfx10(raw) || op(raw) !== OP.block || raw.length !== 137) return null;
  const data = new Uint8Array(64);
  let cs = 0;
  for (let i = 0; i < 64; i++) {
    const hi = raw[7 + 2 * i];
    const lo = raw[8 + 2 * i];
    data[i] = ((hi << 4) | lo) & 0xff;
    cs ^= hi ^ lo;
  }
  return { block: ((raw[5] & 15) << 4) | (raw[6] & 15), data, ok: cs === raw[135] };
}
export const endMessage = (ch = 0) => [...hdr(ch), OP.end, 0xf7];
/** MIDI EDIT EXC.: one parameter change of the program shown (pp = program number - 1). */
export const editMessage = (program, body, ch = 0) => [...hdr(ch), OP.edit, 0x00, program & 0x7f, ...body, 0xf7];
export const presetBlock = (index) => index; // user preset 028-128 = block 1Bh-7Fh = its index 27-127

// ------------------------------------------------------------------ presets
export const algOf = (d) => (d[ALG_AT] < ALGOS.length ? d[ALG_AT] : 0);
export const titleOf = (d) => String.fromCharCode(...d.subarray(TITLE_AT, TITLE_AT + TITLE_LEN));
export const nameOf = (d) => titleOf(d).trim();
/** Title as NAME EDIT allows it: 12 characters 20h-7Fh. */
export function setName(d, name) {
  const s = String(name).replace(/[^\x20-\x7f]/g, ' ').slice(0, TITLE_LEN).padEnd(TITLE_LEN, ' ');
  for (let i = 0; i < TITLE_LEN; i++) d[TITLE_AT + i] = s.charCodeAt(i);
}
export function checksum(d) {
  let x = 0;
  for (let i = 0; i < CS_AT; i++) x ^= d[i];
  return x;
}
/** The preset with its byte 62 set as STORE (159E) and the recall check (0E31) want it. */
export function withChecksum(d) {
  const x = Uint8Array.from(d.subarray ? d.subarray(0, SIZE) : d.slice(0, SIZE));
  x[CS_AT] = checksum(x);
  return x;
}
/** ROM preset a (001-027) as the edit buffer holds it after a recall (0DDD): LCD line 1, then the 48 data bytes. */
export function romPreset(a) {
  const r = ROM_PRESETS[a];
  const d = new Uint8Array(SIZE);
  for (let i = 0; i < 16; i++) d[i] = r.line1.charCodeAt(i);
  d.set(hex(r.data), 16);
  d[CS_AT] = checksum(d);
  return d;
}
/** User preset 028 + n as the first power-up (032B) fills it from ROM (10000 + 40h n). */
export const factoryUser = (n) => withChecksum(hex(USER_PRESETS[n]));

// ------------------------------------------------------------------ pages and their values
const expandRuns = (v) => v.flatMap(([a, n]) => Array.from({ length: n }, (_, i) => a + i));
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
export const expandTexts = (t) => t.flatMap(([n, tm, fields]) => Array.from({ length: n }, (_, i) => renderTemplate(tm, fields, i)));

const INFO = new Map();
/** raws (in the order the page steps), texts, text of a raw value. */
export function pageInfo(a, pg) {
  const key = `${a}:${pg.n}`;
  let x = INFO.get(key);
  if (!x) {
    const raws = pg.v ? expandRuns(pg.v) : [];
    const texts = expandTexts(pg.t);
    const map = new Map(raws.map((r, i) => [r, texts[i]]));
    x = { raws, texts, map, index: new Map(raws.map((r, i) => [r, i])) };
    INFO.set(key, x);
  }
  return x;
}
export const pagesOf = (a) => ALGOS[a].pages;
export const findPage = (a, block, label) => ALGOS[a].pages.find((p) => (block == null || new RegExp(block).test(p.block)) && new RegExp(label).test(p.label));
/** The text the unit shows for the value of page pg in preset d. */
export function pageText(a, pg, d) {
  const v = readParam(d, pageParamShape(pg));
  return pageInfo(a, pg).map.get(v);
}
const pageParamShape = (pg) => ({ offset: pg.off, size: pg.size, bits: pg.bits, shift: pg.shift });
const LEVEL_BLOCKS = ['DIRECT', 'EFFECT', 'MASTER'];
function groupOf(pg) {
  if (pg.kind === 'cc' || pg.kind === 'ctrl') return 'MIDI CTRL';
  if (LEVEL_BLOCKS.includes(pg.block)) return 'LEVELS';
  return pg.block;
}
function labelOf(pg) {
  if (pg.kind === 'cc') return `${pg.label} ASSIGN`;
  if (pg.kind === 'ctrl') return `${pg.block} PARAMETER`;
  if (LEVEL_BLOCKS.includes(pg.block)) return pg.label.startsWith(pg.block) ? pg.label : `${pg.block} ${pg.label}`;
  return pg.label;
}

// ------------------------------------------------------------------ MIDI EDIT EXC. (03) messages
/** The section / index / parameter bytes and value bytes that set page pg to raw value v (as the parser stores it). */
export function editBody(a, pg, v, d) {
  if (pg.kind === 'ctrl') {
    const cc = ALGOS[a].pages.find((p) => p.kind === 'cc' && p.off === pg.off - 2);
    return cc?.msg ? [cc.msg[0], cc.msg[1], cc.msg[2], d[cc.off] >= 0x7f ? 0x7f : d[cc.off], v & 0x7f] : null;
  }
  const m = pg.msg;
  if (!m) return null;
  const path = m.slice(0, 3);
  switch (m[3]) {
    case 1: return [...path, v & 0x7f];
    case 2: return [...path, (v >> 7) & 0x7f, v & 0x7f];
    case 3: return [...path, v >= 0x7f ? 0x7f : v, d[pg.off + 2] & 0x7f];
    case 4: {
      const table = m[4];
      let i = table.indexOf(v);
      if (i < 0) {
        // the parser cannot reach this value: the nearest one it can, in the page's order
        const info = pageInfo(a, pg);
        const want = info.index.get(v) ?? 0;
        let best = 0;
        let bd = Infinity;
        table.forEach((r, k) => { const x = Math.abs((info.index.get(r) ?? 1e9) - want); if (x < bd) { bd = x; best = k; } });
        i = best;
      }
      return [...path, i];
    }
    case 5: {
      const w = 0x2000 + ((v & 0x80) ? (v & 0x7f) : -v);
      return [...path, (w >> 7) & 0x7f, w & 0x7f];
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ preset parameters
export const unit = { program: 0 }; // the program shown on the unit (MIDI EDIT EXC. names it)
const ALG_NAMES = ALGOS.map((x) => x.name);
function pageParam(a, pg) {
  const info = pageInfo(a, pg);
  const ascending = info.raws.every((r, i) => i === 0 || r === info.raws[i - 1] + 1);
  const base = {
    key: `a${a}p${pg.n}`, group: groupOf(pg), label: labelOf(pg), offset: pg.off,
    ...(pg.size > 1 ? { size: pg.size } : {}), ...(pg.bits ? { bits: pg.bits } : {}), ...(pg.shift ? { shift: pg.shift } : {}),
    efx: { a, n: pg.n },
    help: `${pg.block} / ${pg.label}: edit page ${pg.n}${pg.when ? `; the unit hides this page with some values of the others (it shows it, for one, while ${describeWhen(a, pg.when)})` : ''}${pg.msg?.[3] === 4 ? '; MIDI EDIT EXC. reaches only some of these values (the nearest is sent)' : ''}${!pg.msg && !pg.kind ? '; not sent as you change it (the unit would store it in the wrong place): use Write and recall instead' : ''}`,
    dynamic: (d) => ({ hidden: algOf(d) !== a }),
  };
  if (pg.kind === 'ctrl') {
    return { ...base, options: info.raws.map((r, i) => [r, info.texts[i]]), help: `${base.help}. The parameter ${pg.block} moves (one of the algorithm's pages)` };
  }
  if (!ascending || info.raws.length <= 40) return { ...base, options: info.raws.map((r, i) => [r, info.texts[i]]) };
  return { ...base, min: info.raws[0], max: info.raws.at(-1), format: (v) => info.map.get(v) ?? String(v) };
}
function describeWhen(a, [n, v]) {
  const pg = ALGOS[a].pages.find((p) => p.n === n);
  return pg ? `${pg.block} ${pg.label} is ${pageInfo(a, pg).map.get(v) ?? v}` : `page ${n} is ${v}`;
}
export const presetParams = [
  { key: 'alg', group: 'Preset', label: 'Algorithm', offset: ALG_AT, options: ALG_NAMES.map((t, i) => [i, `${pad3(i + 1)} ${t}`]), relayout: true,
    help: 'On the unit you change algorithm by recalling its ROM preset (001-027, one per algorithm) and storing it; choosing one here sets the other values from that preset the same way.',
    after: (d) => { const a = algOf(d); d.set(hex(ROM_PRESETS[a].data), ALG_AT); d[CS_AT] = checksum(d); return `Parameters set from ROM preset ${pad3(a + 1)} (${ROM_PRESETS[a].line1.slice(4).trim()}), as recalling it on the unit does.`; } },
  ...ALGOS.flatMap((x, a) => x.pages.map((pg) => pageParam(a, pg))),
  ...Array.from({ length: TITLE_LEN }, (_, i) => ({ key: `title${i}`, group: 'Preset', label: `Title ${i + 1}`, offset: TITLE_AT + i, min: 0x20, max: 0x7f, kind: 'char', hidden: true })),
];
const PARAMS_BY_KEY = new Map(presetParams.map((p) => [p.key, p]));
export const paramOf = (a, n) => PARAMS_BY_KEY.get(`a${a}p${n}`);

/** A preset into user preset `index` (27-127), the end message, and the program change that recalls it. */
export const writeAndRecall = (d, index, ch = 0) => [blockMessage(index, withChecksum(d), ch), endMessage(ch), [0xc0 | (ch & 15), index]];

function sendParam(p, v, d, ctx) {
  if (!p.efx) return null;
  const pg = ALGOS[p.efx.a].pages.find((x) => x.n === p.efx.n);
  const body = editBody(p.efx.a, pg, v, d);
  return body ? editMessage(unit.program, body, ctx?.channel ?? 0) : null;
}

// ------------------------------------------------------------------ settings and program map
const progName = (i) => (i < ROM_COUNT ? `${pad3(i + 1)} ${ROM_PRESETS[i].line1.slice(4).trim()}` : pad3(i + 1));
const PROGRAMS = Array.from({ length: 128 }, (_, i) => [i, progName(i)]);
const DUMP_RANGE = [[0, 'SYSTEM'], ...Array.from({ length: USER_COUNT }, (_, i) => [USER_FIRST + i, `No.${pad3(USER_FIRST + i + 1)}`])];
const flag = (key, label, bit, texts, help, group = 'MIDI') => ({ key, group, label, offset: SET_AT + S.flags, bits: 1, shift: bit, options: texts.map((t, i) => [i, t]), help });
export const systemParams = [
  { key: 'channel', group: 'MIDI', label: 'MIDI CHANNEL', offset: SET_AT + S.channel, bits: 4, options: Array.from({ length: 16 }, (_, i) => [i, `CHANNEL: ${String(i + 1).padStart(2, '0')}`]),
    help: 'Program changes, controllers and SysEx on this channel' },
  { key: 'omni', group: 'MIDI', label: 'MIDI OMNI MODE', offset: SET_AT + S.channel, bits: 1, shift: 7, options: [[0, 'OMNI : OFF'], [1, 'OMNI : ON']],
    help: 'ON takes program changes, controllers and SysEx on any channel (the channel page is skipped)' },
  flag('editExc', 'MIDI EDIT EXC.', 1, ['SELECT : OFF', 'SELECT : ON'], 'ON takes SysEx at any time (presets, settings and the MIDI EDIT EXC. parameter changes); OFF only while MIDI BULK LOAD waits'),
  flag('thru', 'MIDI OUT / THRU', 6, ['SELECT : OUT', 'SELECT : THRU'], 'The MIDI OUT socket sends the unit\'s messages or passes MIDI IN through'),
  flag('effOff', 'EFFECT OFF MODE', 0, ['SELECT : DIRECT', 'SELECT : MUTE'], 'What the outputs carry while the effect is switched off', 'PEDALS'),
  { key: 'pedPrg', group: 'PEDALS', label: 'PED.PRG. INC/DEC', offset: SET_AT + S.flags, bits: 2, shift: 2, options: [[0, 'SHIFT XXX TO XXX'], [1, 'PROGRAM MAP'], [2, 'SEL: XXX XXX XXX']], relayout: true,
    help: 'How the program pedals step: through a range of programs, through the program map, or between three programs' },
  { key: 'aux', group: 'PEDALS', label: 'AUX PEDAL SELECT', offset: SET_AT + S.flags, bits: 2, shift: 4, options: [[0, 'BY PASS'], [1, 'PROGRAM DECREASE'], [2, 'SPECIAL FUNCTION']],
    help: 'What the AUX pedal does' },
  { key: 'shiftFrom', group: 'PEDALS', label: 'SHIFT (from)', offset: SET_AT + S.shiftFrom, options: PROGRAMS, help: 'First program of the SHIFT range', dynamic: (s) => ({ hidden: ((s[SET_AT + S.flags] >> 2) & 3) !== 0 }) },
  { key: 'shiftTo', group: 'PEDALS', label: 'TO', offset: SET_AT + S.shiftTo, options: PROGRAMS, help: 'Last program of the SHIFT range', dynamic: (s) => ({ hidden: ((s[SET_AT + S.flags] >> 2) & 3) !== 0 }) },
  ...[S.sel1, S.sel2, S.sel3].map((o, i) => ({ key: `sel${i + 1}`, group: 'PEDALS', label: `SEL ${i + 1}`, offset: SET_AT + o, options: PROGRAMS, help: `Program ${i + 1} of the three the pedals select`, dynamic: (s) => ({ hidden: ((s[SET_AT + S.flags] >> 2) & 3) !== 2 }) })),
  { key: 'ctrl1Min', group: 'MIDI CTRL', label: 'MIDI CTRL 1 RANGE MIN', offset: SET_AT + S.ctrl1Min, min: 0, max: 126, input: 'number', help: 'Controller values below it count as it (the unit keeps MIN below MAX)' },
  { key: 'ctrl1Max', group: 'MIDI CTRL', label: 'MIDI CTRL 1 RANGE MAX', offset: SET_AT + S.ctrl1Max, min: 1, max: 127, input: 'number', help: 'Controller values above it count as it' },
  { key: 'ctrl2Min', group: 'MIDI CTRL', label: 'MIDI CTRL 2 RANGE MIN', offset: SET_AT + S.ctrl2Min, min: 0, max: 126, input: 'number', help: 'Controller values below it count as it (the unit keeps MIN below MAX)' },
  { key: 'ctrl2Max', group: 'MIDI CTRL', label: 'MIDI CTRL 2 RANGE MAX', offset: SET_AT + S.ctrl2Max, min: 1, max: 127, input: 'number', help: 'Controller values above it count as it' },
  { key: 'dumpFrom', group: 'MIDI BULK DUMP', label: 'FROM', offset: SET_AT + S.dumpFrom, options: DUMP_RANGE, help: 'SYSTEM sends the program map and these settings first, then the presets from No.028' },
  { key: 'dumpTo', group: 'MIDI BULK DUMP', label: 'To', offset: SET_AT + S.dumpTo, options: DUMP_RANGE, help: 'Last preset sent (SYSTEM: none)' },
  { key: 'program', group: 'Unit', label: 'Program', offset: SET_AT + S.program, options: PROGRAMS, help: 'The program recalled at power-on; settings sent to the unit set it as the program shown' },
  { key: 'contrast', group: 'Unit', label: 'L.C.D. CONTRAST', offset: SET_AT + S.contrast, min: 0, max: 7, help: 'ADJUST, 0-7 bars' },
  ...Array.from({ length: 128 }, (_, n) => ({
    key: `map${n}`, group: 'MIDI PROGRAM MAP', label: `PRO: ${pad3(n + 1)}`, offset: MAP_AT + n, options: PROGRAMS,
    help: `Program change ${n + 1} (number ${n}) recalls this preset (the NO: field on the unit).`,
  })),
];
/** The settings after the first power-up (032B): map 1:1, the defaults at code 00E0. */
export function initialSystem() {
  const s = new Uint8Array(SYS_SIZE);
  for (let i = 0; i < 128; i++) s[MAP_AT + i] = i;
  s.set(hex(SETTINGS), SET_AT);
  return s;
}
export const systemBlocks = (s, ch = 0) => [
  blockMessage(BLOCK.mapLo, s.subarray(MAP_AT, MAP_AT + 64), ch),
  blockMessage(BLOCK.mapHi, s.subarray(MAP_AT + 64, MAP_AT + 128), ch),
  blockMessage(BLOCK.settings, s.subarray(SET_AT, SET_AT + 64), ch),
];

// ------------------------------------------------------------------ dumps from the panel
/** What MIDI BULK DUMP sends for FROM..TO (14B3): SYSTEM blocks first, the presets, then 45. */
export function dumpMessages({ system, presets }, from = 0, to = 127, ch = 0) {
  const out = [];
  if (from === 0) out.push(...systemBlocks(system, ch));
  if (to) for (let i = from || USER_FIRST; i <= to; i++) out.push(blockMessage(i, presets[i - USER_FIRST], ch));
  out.push(endMessage(ch));
  return out;
}
/** Everything a dump carried: {system (null unless all three system blocks came), presets: Map(index -> data)}. */
export function collect(msgs) {
  const system = initialSystem();
  const seen = new Set();
  const presets = new Map();
  for (const m of msgs) {
    const b = parseBlock(m);
    if (!b?.ok) continue;
    if (b.block === BLOCK.mapLo) { system.set(b.data, MAP_AT); seen.add(b.block); } else if (b.block === BLOCK.mapHi) { system.set(b.data, MAP_AT + 64); seen.add(b.block); } else if (b.block === BLOCK.settings) { system.set(b.data, SET_AT); seen.add(b.block); } else if (b.block >= USER_FIRST && b.block < 128) presets.set(b.block, b.data);
  }
  return { system: seen.size === 3 ? system : null, presets };
}

function listen(api, { done, first = 90000, gap = 5000, hint }) {
  const tr = api.g?.transport;
  if (!tr?.on) return Promise.reject(new Error('No MIDI input is open to receive the dump.'));
  if (hint) api.toast?.(hint, 'info');
  return new Promise((resolve, reject) => {
    const got = [];
    let off = null;
    const fail = () => {
      off?.();
      reject(new Error(got.length ? `The dump stopped after ${got.length} message${got.length === 1 ? '' : 's'}.` : 'Nothing arrived from the EFX-10: start MIDI BULK DUMP on the unit.'));
    };
    let timer = setTimeout(fail, first);
    off = tr.on('sysex', (d) => {
      if (!isEfx10(d)) return;
      got.push(Uint8Array.from(d));
      clearTimeout(timer);
      if (done(got)) { off(); resolve(got); } else timer = setTimeout(fail, gap);
    });
  });
}
const presetHint = (i) => `On the EFX-10: MIDI menu, MIDI BULK DUMP, FROM No.${pad3(i + 1)} To No.${pad3(i + 1)}, then start the dump.`;
const ALL_HINT = 'On the EFX-10: MIDI menu, MIDI BULK DUMP, SYSTEM To No.128 (105 messages, about 45 s), then start the dump.';
const SYSTEM_HINT = 'On the EFX-10: MIDI menu, MIDI BULK DUMP, SYSTEM To SYSTEM (or To No.128), then start the dump.';
async function receivePreset(api, index = null) {
  const got = await listen(api, { done: (g) => g.some((m) => { const b = parseBlock(m); return b?.ok && b.block >= USER_FIRST && b.block < 128 && (index == null || b.block === index); }), hint: index == null ? 'On the EFX-10: MIDI BULK DUMP of the preset (FROM and To the same number).' : presetHint(index) });
  const b = got.map(parseBlock).find((x) => x?.ok && x.block >= USER_FIRST && x.block < 128 && (index == null || x.block === index));
  unit.program = b.block;
  return b.data;
}
async function receiveAll(api) {
  const got = await listen(api, { done: (g) => op(g.at(-1)) === OP.end && g.some((m) => op(m) === OP.block), first: 120000, hint: ALL_HINT });
  return collect(got);
}
async function receiveSystem(api) {
  const got = await listen(api, { done: (g) => !!collect(g).system, hint: SYSTEM_HINT });
  return collect(got).system;
}

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = {
    system: initialSystem(), presets: Array.from({ length: USER_COUNT }, (_, n) => factoryUser(n)), edit: romPreset(0),
    current: 0, mode: 'play', display: '', edits: 0,
  };
  const channel = () => st.system[SET_AT + S.channel] & 15;
  const omni = () => !!(st.system[SET_AT + S.channel] & 0x80);
  const editExc = () => !!(st.system[SET_AT + S.flags] & 2);
  const recall = (i) => { st.current = i; st.edit = i < ROM_COUNT ? romPreset(i) : Uint8Array.from(st.presets[i - USER_FIRST]); };
  return {
    state: st,
    recall,
    /** MIDI BULK DUMP from the panel. */
    panel(action, from = 0, to = 127) {
      if (action === 'BULK DUMP') return dumpMessages({ system: st.system, presets: st.presets }, from, to, channel());
      return [];
    },
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) {
        if (omni() || (d[0] & 15) === channel()) recall(st.system[MAP_AT + d[1]] & 0x7f);
        return [];
      }
      if (d[0] !== 0xf0) return null;
      if (d[1] === 0x7e && d[2] === 0x0f && d[3] === 0x06 && d[4] === 0x01) return [Uint8Array.from(IDENTITY)];
      if (!isEfx10(d)) return [];
      if (!omni() && (d[2] & 15) !== channel()) return [];
      const waiting = st.mode === 'bulkload' || st.mode === 'receiving';
      if (!editExc() && !waiting) return [];
      if (waiting) st.mode = 'receiving';
      if (op(d) === OP.end) {
        if (st.mode === 'receiving') { st.mode = 'play'; st.display = 'DATA RECEIVED'; recall(st.current); }
        return [];
      }
      if (op(d) === OP.block) {
        const b = parseBlock(d);
        if (!b?.ok) { st.display = '** DATA ERROR **'; return []; }
        if (b.block === BLOCK.mapLo) st.system.set(b.data, MAP_AT);
        else if (b.block === BLOCK.mapHi) st.system.set(b.data, MAP_AT + 64);
        else if (b.block === BLOCK.settings) { st.system.set(b.data.subarray(0, 32), SET_AT); st.current = b.data[0] & 0x7f; } else if (st.mode === 'edit') st.edit = b.data;
        else if (b.block >= USER_FIRST && b.block < 128) st.presets[b.block - USER_FIRST] = b.data;
        return [];
      }
      if (op(d) === OP.edit && d[6] === st.current) {
        const body = Array.from(d.slice(7, d.length - 1));
        const a = algOf(st.edit);
        for (const pg of ALGOS[a].pages) {
          const p = paramOf(a, pg.n);
          for (const v of pageInfo(a, pg).raws) {
            const want = editBody(a, pg, v, st.edit);
            if (want && want.length === body.length && want.every((x, i) => x === body[i])) {
              writeParam(st.edit, p, v);
              st.edits++;
              return [];
            }
          }
        }
      }
      return [];
    },
  };
}

// ------------------------------------------------------------------ monitor, library
function describe(raw) {
  if (isIdentityReply(raw)) return 'EFX-10 identity reply ("MODEL ID: EFX-10")';
  if (!isEfx10(raw)) return null;
  if (op(raw) === OP.end) return 'EFX-10 end of dump';
  if (op(raw) === OP.edit) {
    const body = Array.from(raw.slice(7, raw.length - 1)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    return `EFX-10 MIDI EDIT EXC. for program ${pad3(raw[6] + 1)}: ${body}`;
  }
  const b = parseBlock(raw);
  if (!b) return `EFX-10 message ${op(raw).toString(16)}h`;
  const bad = b.ok ? '' : ' (checksum error)';
  if (b.block === BLOCK.mapLo) return `EFX-10 program map 001-064${bad}`;
  if (b.block === BLOCK.mapHi) return `EFX-10 program map 065-128${bad}`;
  if (b.block === BLOCK.settings) return `EFX-10 settings${bad}`;
  if (b.block >= USER_FIRST && b.block < 128) return `EFX-10 preset ${pad3(b.block + 1)} "${nameOf(b.data)}" (${ALGOS[algOf(b.data)].name})${bad}`;
  return `EFX-10 block ${b.block.toString(16)}h${bad}`;
}
function libraryItems(msgs) {
  const items = [];
  const all = collect(msgs);
  for (const m of msgs) {
    const b = parseBlock(m);
    if (b?.ok && b.block >= USER_FIRST && b.block < 128) {
      items.push({ key: `p${b.block}`, label: `Preset ${pad3(b.block + 1)}`, name: nameOf(b.data), object: 'effect', data: b.data, msgs: [Uint8Array.from(m), Uint8Array.from(endMessage(m[2] & 15))] });
    } else if (b?.ok && b.block >= BLOCK.mapLo && b.block <= BLOCK.settings) {
      if (!all.system) items.push({ key: `s${items.length}`, label: describe(m), name: '', object: null, msgs: [m] });
    } else if (!isEfx10(m) || op(m) !== OP.end) items.push({ key: `x${items.length}`, label: describe(m) || 'Other message', name: '', object: null, msgs: [m] });
  }
  if (all.system) {
    const own = msgs.filter((m) => { const b = parseBlock(m); return b?.ok && b.block >= BLOCK.mapLo && b.block <= BLOCK.settings; });
    items.push({ key: 'system', label: 'Settings and program map', name: '', object: 'system', data: all.system, msgs: [...own, Uint8Array.from(endMessage(own[0][2] & 15))] });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: the algorithm's reverb (REV TIME / TIME over 20 s, REV DELAY / PRE DELAY, its LEVEL or EFFECT
// LEVEL), delay (the first delay time over 2980 ms, FEEDBACK / FEED., its LEVEL), chorus / flanger / phaser
// (RATE, DEPTH, LEVEL as modulation; chorus also as effects.chorus) and pitch shifter become effects.*,
// values on 0..1 of their page's range. Exact bytes in extra (family 'viscount-efx10'). fromCommon: the same
// family loads the bytes; anything else picks an algorithm that has the effects, starts from its ROM preset
// and sets what maps; the title of the preset it replaces is kept.
const FAMILY = 'viscount-efx10';
const DELAY_MAX_MS = 2980;
const REVERB_MAX_S = 20;
function sem(a) {
  const P = (block, label) => findPage(a, block, label);
  const s = {};
  const rv = P('^(HALL|REVERB|EARLY|GATE|PLATE|AMBIENCE)', '^(REV TIME|TIME)$') || P('^REVERB', 'REV TIME');
  if (rv) s.reverb = { time: rv, pre: P('^REVERB', '^(REV DELAY|PRE DELAY)$'), level: P('^REVERB', '^(LEVEL|EFF\\. LEVEL)$') };
  const dl = P('^(DELAY|MONO DELAY)', '^(TIME|D\\. TIME|DELAY T\\.C)$') || P('^DELAY', 'TIME');
  if (dl) s.delay = { time: dl, feedback: P(`^${dl.block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, '^(FEEDBACK|FEED\\.)$') || P('^DELAY', '^(FEEDBACK|FEED\\.)$'), level: P('^DELAY', '^(LEVEL|EFF\\. LEVEL|LEVEL C)$') };
  const md = P('^(SPACE CHORUS|CHORUS|MULTI CHORUS|FLANGER|PHASER|MODULATION)', '^RATE');
  if (md) {
    const block = `^${md.block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    s.mod = { rate: md, depth: P(block, '^DEPTH'), level: P(block, '^(LEVEL|EFF\\. LEVEL)'), type: /CHORUS/.test(md.block) ? 'CHORUS' : md.block };
  }
  if (/PITCH/.test(ALGOS[a].name)) s.pitch = { level: P('^P\\. SHIFTER', '^LEVEL') };
  if (/ROTARY/.test(ALGOS[a].name)) s.rotary = true;
  s.effect = P('^EFFECT$', '^LEVEL$');
  return s;
}
const SEM = ALGOS.map((_, a) => sem(a));
const fracOf = (a, pg, d) => {
  const info = pageInfo(a, pg);
  const i = info.index.get(readParam(d, paramOf(a, pg.n))) ?? 0;
  return info.raws.length > 1 ? i / (info.raws.length - 1) : 0;
};
const textNum = (t) => parseFloat(String(t).replace(/[^0-9.+-]/g, ''));
function toCommon(d) {
  const a = algOf(d);
  const s = SEM[a];
  const text = (pg) => pageText(a, pg, d);
  const effects = {};
  const level = (pg) => (pg ? fracOf(a, pg, d) : s.effect ? fracOf(a, s.effect, d) : 1);
  if (s.reverb) {
    effects.reverb = { type: ALGOS[a].name, time: Math.min(1, textNum(text(s.reverb.time)) / REVERB_MAX_S), level: level(s.reverb.level) };
    if (s.reverb.pre) effects.reverb.preDelay = fracOf(a, s.reverb.pre, d);
  }
  if (s.delay) {
    effects.delay = { type: ALGOS[a].name, time: Math.min(1, textNum(text(s.delay.time)) / DELAY_MAX_MS), level: level(s.delay.level) };
    if (s.delay.feedback) effects.delay.feedback = fracOf(a, s.delay.feedback, d);
  }
  if (s.mod) {
    const m = { type: s.mod.type, rate: fracOf(a, s.mod.rate, d), depth: s.mod.depth ? fracOf(a, s.mod.depth, d) : 0.5, level: level(s.mod.level) };
    effects.modulation = m;
    if (s.mod.type === 'CHORUS') effects.chorus = { ...m };
  }
  if (s.pitch) effects.modulation = { type: 'PITCH SHIFT', level: level(s.pitch.level) };
  if (s.rotary) effects.modulation = { type: 'ROTARY', level: 1 };
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'viscount-efx10', algorithm: ALGOS[a].name, data: Array.from(d.slice(0, SIZE)), match: hashBytes(d.slice(0, SIZE)) } };
}
/** The algorithm for a set of effects (-1: none). */
export function pickAlgorithm(fx) {
  const on = (e) => e && (e.level ?? 1) > 0;
  const rv = on(fx.reverb);
  const dl = on(fx.delay);
  const md = [fx.modulation, fx.chorus].find(on);
  const t = String(md?.type || '').toUpperCase();
  if (md && /PITCH|SHIFT|OCTAV|HARMON/.test(t)) return 14;
  if (md && /ROTARY|LESLIE/.test(t)) return 17;
  if (md && /FLANG/.test(t)) return 15;
  if (md && /PHAS/.test(t)) return dl ? 16 : 19;
  if (md && rv) return 22;
  if (md && dl) return 23;
  if (md) return 13;
  if (rv && dl) return 21;
  if (rv) {
    const r = String(fx.reverb.type || '').toUpperCase();
    return /PLATE/.test(r) ? 7 : /AMBIEN/.test(r) ? 8 : /GATE/.test(r) ? 6 : /EARLY|E\.R/.test(r) ? 5 : /SMALL/.test(r) ? 4 : /ROOM|CHAMBER/.test(r) ? 2 : 0;
  }
  if (dl) return 9;
  return -1;
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
    const d = withChecksum(Uint8Array.from(x.data));
    r.mapped.push(`Preset (exact, ${ALGOS[algOf(d)].name})`);
    return { data: d, report: tidy(r) };
  }
  const fx = c?.effects || {};
  const a = pickAlgorithm(fx);
  if (a < 0) {
    r.dropped.push('No effect in the source sound: the preset keeps its algorithm and settings');
    return { data: withChecksum(Uint8Array.from(base || romPreset(0))), report: tidy(r) };
  }
  const d = romPreset(a);
  r.approximated.push(`Algorithm ${ALGOS[a].name}, starting from ROM preset ${pad3(a + 1)}`);
  const s = SEM[a];
  const putFrac = (pg, f, what) => {
    if (!pg || f === undefined || Number.isNaN(f)) return;
    const info = pageInfo(a, pg);
    writeParam(d, paramOf(a, pg.n), info.raws[Math.round(Math.max(0, Math.min(1, f)) * (info.raws.length - 1))]);
    r.approximated.push(what);
  };
  const putText = (pg, wanted, what) => {
    if (!pg || wanted === undefined || Number.isNaN(wanted)) return;
    const info = pageInfo(a, pg);
    let best = 0;
    let bd = Infinity;
    info.texts.forEach((t, i) => { const v = Math.abs(textNum(t) - wanted); if (v < bd) { bd = v; best = i; } });
    writeParam(d, paramOf(a, pg.n), info.raws[best]);
    r.approximated.push(what);
  };
  if (s.reverb && fx.reverb) {
    putText(s.reverb.time, (fx.reverb.time ?? 0.1) * REVERB_MAX_S, 'Reverb time');
    putFrac(s.reverb.pre, fx.reverb.preDelay, 'Pre-delay');
    putFrac(s.reverb.level, fx.reverb.level, 'Reverb level');
  }
  if (s.delay && fx.delay) {
    putText(s.delay.time, (fx.delay.time ?? 0) * DELAY_MAX_MS, 'Delay time');
    putFrac(s.delay.feedback, fx.delay.feedback, 'Delay feedback');
    putFrac(s.delay.level, fx.delay.level, 'Delay level');
  }
  const m = [fx.modulation, fx.chorus].find((e) => e && (e.level ?? 1) > 0);
  if (s.mod && m) {
    putFrac(s.mod.rate, m.rate, `${s.mod.type} rate`);
    putFrac(s.mod.depth, m.depth, `${s.mod.type} depth`);
    putFrac(s.mod.level, m.level, `${s.mod.type} level`);
  }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
  if (base) setName(d, nameOf(base));
  d[CS_AT] = checksum(d);
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ algorithm gallery
const SVG = 'http://www.w3.org/2000/svg';
const OUTPUT_BLOCKS = new Set(['DIRECT', 'EFFECT', 'MASTER', 'ASSIGN', 'MIDI CTRL 1', 'MIDI CTRL 2', 'EFF. ON/OFF']);
/** The blocks algorithm a's edit pages go through, in page order. */
export const blocksOf = (a) => [...new Set(ALGOS[a].pages.filter((p) => !p.kind && !OUTPUT_BLOCKS.has(p.block) && !/^(PRE-DIST|POST-DIST|LINE DRIVER)$/.test(p.block)).map((p) => p.block.replace(/\s+\d+$/, '')))];
function drawBlocks({ value }) {
  const blocks = blocksOf(value);
  const w = 64;
  const gap = 10;
  const W = Math.max(1, blocks.length) * (w + gap) + gap;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} 40`);
  svg.setAttribute('width', String(Math.min(260, W)));
  const el = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  blocks.forEach((b, i) => {
    const x = gap + i * (w + gap);
    el('rect', { x, y: 8, width: w, height: 24, rx: 3, fill: 'none', stroke: 'currentColor' });
    el('text', { x: x + w / 2, y: 24, 'text-anchor': 'middle', 'font-size': b.length > 10 ? 7 : 8, fill: 'currentColor' }, b);
    if (i) el('line', { x1: x - gap, y1: 20, x2: x, y2: 20, stroke: 'currentColor' });
  });
  return svg;
}

// ------------------------------------------------------------------ definition
const ROM_NAMES = ROM_PRESETS.map((r) => r.line1.slice(4).trim());
export default {
  coverage: 'Edits the EFX-10\'s presets (all 27 algorithms: every edit page with its label and value texts, including pages the unit shows only for some values of the others; the MIDI CTRL assignments; the title), shows the 27 ROM presets and the 101 user presets of the first power-up, and edits the settings and the program map. Changes are sent as you make them, for the program the unit shows. The unit cannot be asked for its data: start each dump on the unit (MIDI BULK DUMP) and the editor picks it up; the unit takes what the editor sends with MIDI EDIT EXC. ON or on MIDI BULK LOAD. Not checked on hardware.',
  sysex: { manufacturer: [0x31], model: 0x02 },
  minGap: 100,
  describe,
  recognise: (raw) => isEfx10(raw) || isIdentityReply(raw),
  isOwn: isEfx10,
  isRequest: () => false, // the EFX-10 answers no dump request
  // complete dump: started on the unit; 3 system blocks, 101 presets and the end message, about 0.45 s apart
  panelDump: { text: 'MIDI menu > MIDI BULK DUMP, SYSTEM To No.128 (105 messages, about 45 s)', quiet: 3000, expect: 3 + USER_COUNT + 1 },
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Preset', icon: '◆', label: 'Preset', size: SIZE,
      init: () => romPreset(0),
      // the program on the unit: a ROM preset loads from the firmware, a user preset waits for its MIDI BULK DUMP
      fetch: (api) => (unit.program < USER_FIRST ? Promise.resolve(romPreset(unit.program)) : receivePreset(api, unit.program)),
      receive: (raw) => { const b = parseBlock(raw); return b?.ok && b.block >= USER_FIRST && b.block < 128 ? b.data : null; },
      params: presetParams,
      sendParam,
      name: nameOf,
      setName: (d, n) => { setName(d, n); d[CS_AT] = checksum(d); },
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 4,
      target: {
        label: 'Program on the unit', title: 'The program the EFX-10 shows: MIDI EDIT EXC. messages name it, and the unit takes them only for that program (with MIDI EDIT EXC. ON)',
        options: () => PROGRAMS.map(([v, l]) => [v, l]), value: () => unit.program, set: (v) => { unit.program = Number(v); },
      },
      note: 'Each change is sent at once as a MIDI EDIT EXC. message for the program chosen above: the EFX-10 takes it with MIDI EDIT EXC. ON while it shows that program, and only when that program uses the same algorithm. Write keeps a preset: send it to a user preset (028-128) and recall it. Leave EDIT on the unit first: while it edits, a preset sent lands in its edit buffer instead.',
      toSyx: (data, ctx) => [...blockMessage(Math.max(USER_FIRST, unit.program), withChecksum(data), ctx?.channel ?? 0), ...endMessage(ctx?.channel ?? 0)],
      fromSyx: (msgs) => { const b = msgs.map(parseBlock).find((x) => x?.ok && x.block >= USER_FIRST && x.block < 128); return b ? b.data : null; },
      actions: [
        { label: 'Write and recall', title: 'Send the preset into the user preset chosen as the program on the unit, then recall it with a program change (program map 1:1)', run: (api) => {
          if (unit.program < USER_FIRST) { api.toast('Choose a user preset (028-128) as the program on the unit: 001-027 are in ROM.', 'warn'); return; }
          api.send(writeAndRecall(api.data, unit.program, api.ctx?.channel ?? 0));
        } },
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Preset title', [{ key: 'name', label: 'Title (12 characters)', value: titleOf(api.data), maxlength: TITLE_LEN }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name);
          d[CS_AT] = checksum(d);
          api.setData(d);
        } },
      ],
      galleries: [{
        key: 'algorithms', page: 'Algorithms', icon: '▦', param: 'alg',
        note: 'The blocks each algorithm\'s edit pages go through, in page order. Choosing one loads its ROM preset\'s values, as recalling that preset on the unit does.',
        label: (v) => `${pad3(v + 1)} ${ALGOS[v].name}`,
        draw: drawBlocks,
      }],
      slots: {
        label: 'Presets', banks: [[0, 'User 028-128'], [1, 'ROM 001-027']],
        count: (bank) => (bank ? ROM_COUNT : USER_COUNT),
        slotLabel: (bank, i) => pad3(bank ? 1 + i : USER_FIRST + 1 + i),
        note: (bank) => (bank ? 'ROM presets, one per algorithm: Edit loads one as a recall does. '
          : 'Edit waits for MIDI BULK DUMP of that preset; Read names waits for SYSTEM To No.128. Store sends the preset into that number (MIDI EDIT EXC. ON, or MIDI BULK LOAD waiting). ')
          + 'Play sends a program change (program = preset - 1: the program map as the first power-up sets it).',
        names: (bank) => (bank === 1 ? ROM_NAMES : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => { const p = bank ? i : USER_FIRST + i; unit.program = p; return [[0xc0 | ((ctx?.channel ?? 0) & 15), p]]; },
        fetch: async (api, bank, i) => (bank === 1 ? romPreset(i) : receivePreset(api, USER_FIRST + i)),
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { ROM_NAMES.forEach((s, i) => onName(i, s)); return; }
          const all = await receiveAll(api);
          for (const [idx, d] of all.presets) onName(idx - USER_FIRST, nameOf(d));
        },
        scanNote: (bank) => (bank ? null : ALL_HINT),
        store: (_bank, i, ctx, data) => [blockMessage(USER_FIRST + i, withChecksum(data), ctx?.channel ?? 0), endMessage(ctx?.channel ?? 0)],
      },
    },
    {
      key: 'system', page: 'Settings', icon: '⚙', label: 'Settings', size: SYS_SIZE, notLive: true,
      init: initialSystem,
      fetch: receiveSystem,
      receive: (raw, data) => {
        const b = parseBlock(raw);
        if (!b?.ok || b.block < BLOCK.mapLo || b.block > BLOCK.settings) return null;
        const s = Uint8Array.from(data);
        s.set(b.data, b.block === BLOCK.mapLo ? MAP_AT : b.block === BLOCK.mapHi ? MAP_AT + 64 : SET_AT);
        return s;
      },
      params: systemParams,
      cols: 3,
      layout: [{ group: 'MIDI' }, { group: 'PEDALS' }, { group: 'MIDI CTRL' }, { group: 'MIDI BULK DUMP' }, { group: 'Unit' }, { group: 'MIDI PROGRAM MAP', wide: true }],
      note: 'The MIDI menu settings and the program map, as MIDI BULK DUMP sends them with FROM SYSTEM. The unit takes them with MIDI EDIT EXC. ON or on MIDI BULK LOAD.',
      actions: [
        { label: 'Send to the EFX-10', title: 'Send the program map and settings', run: async (api) => {
          const ok = await api.confirm('Send settings', 'Put the EFX-10 on MIDI BULK LOAD (WAITING) first, or set MIDI EDIT EXC. ON. This replaces its program map and MIDI menu settings.', 'Send');
          if (ok) api.send([...systemBlocks(api.data, api.ctx?.channel ?? 0), endMessage(api.ctx?.channel ?? 0)]);
        } },
        { label: 'First power-up contents', title: 'The program map 1:1 and the settings the unit starts with; not sent until you press Send to the EFX-10', run: (api) => api.setData(initialSystem()) },
      ],
      toSyx: (data, ctx) => [...systemBlocks(data, ctx?.channel ?? 0), endMessage(ctx?.channel ?? 0)].flat(),
      fromSyx: (msgs) => collect(msgs).system,
    },
  ],
  midiNotes: [
    'Dumps are started on the unit: MIDI menu, MIDI BULK DUMP, FROM SYSTEM or a preset To SYSTEM or a preset (SYSTEM = program map and settings). The blocks come about 0.45 s apart and end with F0 31 1n 02 45 F7.',
    'The unit takes SysEx with MIDI EDIT EXC. ON, or while MIDI BULK LOAD shows WAITING. A preset block stores into its number (028-128); while the unit is in EDIT it goes to the edit buffer instead.',
    'MIDI EDIT EXC. messages (03) change one parameter of the program shown: the message names that program, and the parameter numbers belong to its algorithm.',
    'Program change: the program map turns program 1-128 into a preset (1:1 after the first power-up). MIDI CTRL 1 / 2 of each preset choose the controller (or pitch bend) and the parameter it moves; RANGE MIN / MAX in the MIDI menu limit the controller values.',
    'Identity request F0 7E 0F 06 01 F7 (device number 0F only) answers F0 7E 0F 06 02 31 00 1C 12 00 00 00 00 00 F7.',
  ],
};

export const _test = { simulate, toCommon, fromCommon, sem, SEM, sendParam, listen, describe };
