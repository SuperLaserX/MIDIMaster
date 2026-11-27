// Roland SYSTEM-8: the OS 1.32 parameter catalog (OS_GROUPS in roland-system8-fw.js, generated from the OS
// plaintext by tools/system8/os_tables.py + gen_fw_js.py) turned into editor parameters, and the OS's own value
// formatter (FUN_6005032e of OS 1.32) for their screen texts. See docs/devices/roland-system8.md, "OS parameter
// catalog".
//
// A value description is the OS's mini language: \x01 separates list items, \x02 range anchors, \x03[TAG] a
// special formatter, \x04 a first value shown apart from a range, \x05{unit}, \x06(offset) added to the value,
// \x07<n> n decimals (value / 10^n).

import { OS_GROUPS, OS_TABLES } from './roland-system8-fw.js';

const trim = (s) => String(s).trim();
const SPECIAL = /\s*[\x03\x05\x06\x07]/;

export function parseSpec(spec) {
  return {
    tag: /\x03\[([A-Z0-9_]+)\]/.exec(spec)?.[1] || null,
    unit: /\x05\{([^}]*)\}/.exec(spec)?.[1] ?? '',
    off: Number(/\x06\((-?\d+)\)/.exec(spec)?.[1] ?? 0),
    dec: Number(/\x07<(\d+)>/.exec(spec)?.[1] ?? 0),
    body: spec.split(SPECIAL)[0],
  };
}

const NOTE_OCT = '-0123456789';
/** The [TAG] formatters of the OS (FUN_6005032e): value -> screen text. */
export const TAGS = {
  KEY: (v) => `${OS_TABLES.NOTE[v % 12]}${NOTE_OCT[Math.floor(v / 12)] ?? '?'}`,
  DMP: (v) => (v === 0 ? '0.0dB' : v < 81 ? `-${Math.floor((v * 5) / 10)}.${(v * 5) % 10}dB` : '-INF'),
  PRE_DLY: (v) => `${Math.floor((v * 5) / 10)}.${(v * 5) % 10}ms`,
  PART_LEV: (v) => trim(OS_TABLES.PART_LEV[v] ?? v),
  PART_BAL: (v) => (v < 64 ? `LW${64 - v}` : v > 64 ? `UP${v - 64}` : '0'),
  PAN: (v) => (v < 5 ? `L${5 - v}` : v > 5 ? `R${v - 5}` : 'CENTER'),
  VOC_BAL: (v) => (v < 128 ? `D${128 - v}` : v > 128 ? `W${v - 128}` : '0'),
  HI_CUT: (v) => OS_TABLES.HI_CUT[v] ?? String(v),
  LO_CUT: (v) => OS_TABLES.LO_CUT[v] ?? String(v),
  HDMP_F: (v) => OS_TABLES.HDMP_F[v] ?? String(v),
  LDMP_F: (v) => OS_TABLES.LDMP_F[v] ?? String(v),
  OSC3_TUNE: (v) => trim(OS_TABLES.OSC3_TUNE[v] ?? v),
  TUNE: (v) => `${Math.floor((v + 4400) / 10)}.${(v + 4400) % 10}Hz`,
  BANK_NUM: (v) => (v < 0 ? 'MANUAL' : `${String.fromCharCode(65 + (v >> 3))}-${(v & 7) + 1}`),
  FLOAT: (v) => String(v),
  '4CHAR': (v) => { let s = ''; for (let k = 3; k >= 0; k--) { const c = (v >>> (8 * k)) & 0xff; s += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; } return `${s} ${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; },
};

/** The OS's screen text of value `v` (the logical value, stored - bias) under description `spec`; `min` is the
 *  record's minimum. A faithful port of FUN_6005032e. */
export function osText(spec, v, min = 0) {
  const p = parseSpec(spec);
  if (p.tag) return (TAGS[p.tag] || String)(v);
  const sA = v < 0 || (min < 0 && v !== 0);
  if (!sA && spec.charCodeAt(0) < 32) return String(v);
  const x = v + p.off;
  const sg = sA || x < 0 || (p.off < 0 && x !== 0);
  let num;
  if (p.dec) { const d = 10 ** p.dec; const q = Math.trunc(x / d); num = `${sg && x >= 0 ? '+' : ''}${q}.${Math.abs(x - d * q)}`; }
  else num = `${sg && x >= 0 ? '+' : ''}${x}`;
  const list = spec.includes('\x01') || spec.includes('\x04');
  if (!list && spec.includes('\x02')) return num + p.unit;
  let pos = 0;
  for (let n = v - min; n > 0; n--) {
    const k = spec.indexOf('\x01', pos);
    if (k < 0) return String(x) + p.unit;
    pos = k + 1;
  }
  let out = '';
  for (let i = pos; i < spec.length && spec.charCodeAt(i) >= 32; i++) out += spec[i];
  return out;
}

/** The items a value description lists, with the range items expanded the way the OS menus count them (`a\x02b`
 *  anchors: numbers with their prefix/suffix, notes C-1..G9, banks A-1..H-8, bank letters, PLUG-OUT n X-y, or a
 *  list of words): [[value, text]] from `min`, or null when the description is a plain number range. */
export function osOptions(spec, min, max) {
  const p = parseSpec(spec);
  if (p.tag) return max - min <= 255 ? range(min, max).map((v) => [v, TAGS[p.tag](v)]) : null;
  const list = spec.includes('\x01') || spec.includes('\x04');
  const items = p.body.split(/[\x01\x04]/);
  const out = [];
  for (const it of items) {
    if (!it.includes('\x02')) { out.push(it); continue; }
    const texts = expand(it.split('\x02'), max - min + 1 - out.length - (items.length - 1 - items.indexOf(it)), !list);
    if (!texts) return null;
    out.push(...texts);
  }
  return out.slice(0, max - min + 1).map((t, i) => [min + i, t]);
}
const BANK = (i) => `${String.fromCharCode(65 + (i >> 3))}-${(i & 7) + 1}`;
const bankOf = (s) => { const m = /^([A-H])-([1-8])$/.exec(s); return m ? (m[1].charCodeAt(0) - 65) * 8 + Number(m[2]) - 1 : null; };
/** Texts of one range item (its anchors); `labelsOnly`: a plain range, expanded only when its anchors are labels. */
function expand(anchors, room, labelsOnly) {
  const a = anchors[0].trim(); const b = anchors[anchors.length - 1].trim();
  const na = noteOf(a); const nb = noteOf(b);
  if (na !== null && nb !== null) return range(na, nb).map(TAGS.KEY);
  const ba = bankOf(a); const bb = bankOf(b);
  if (ba !== null && bb !== null) return range(ba, bb).map(BANK);
  const pa = /^PLUG-OUT (\d) ([A-H]-[1-8])$/.exec(a); const pb = /^PLUG-OUT (\d) ([A-H]-[1-8])$/.exec(b);
  if (pa && pb) return range(Number(pa[1]) * 64 + bankOf(pa[2]), Number(pb[1]) * 64 + bankOf(pb[2])).map((v) => `PLUG-OUT ${v >> 6} ${BANK(v & 63)}`);
  if (/^[A-H]$/.test(a) && /^[A-H]$/.test(b)) return range(a.charCodeAt(0), b.charCodeAt(0)).map((c) => String.fromCharCode(c));
  const A = anchorOf(a); const B = anchorOf(b);
  if (!A || !B) return anchors.length === room ? anchors.map((x) => x.trim()) : null;
  if (labelsOnly && !A.pre.trim()) return null;
  const step = 10 ** -A.dec;
  const n = Math.round((B.num - A.num) / step) + 1;
  return range(0, n - 1).map((k) => { const x = A.num + k * step; return `${A.pre}${A.plus && x > 0 ? '+' : ''}${x.toFixed(A.dec)}${A.suf}`; });
}
/** A plain number range whose anchors describe a scale (e.g. x0.0 .. x2.0 over 0-255) rather than the number. */
export function scaleOnly(spec, min, max) {
  const p = parseSpec(spec);
  if (p.tag || /[\x01\x04]/.test(spec) || !spec.includes('\x02')) return false;
  const an = p.body.split('\x02').map((x) => anchorOf(x));
  if (an.some((x) => !x)) return false;
  return Math.abs((an.at(-1).num - an[0].num) * 10 ** an[0].dec - (max - min)) > 0.5;
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const NOTES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "C-1" .. "G9" -> MIDI note number, or null. */
function noteOf(s) {
  const m = /^([A-G])([#b]?)(-1|\d)$/.exec(s.trim());
  return m ? NOTES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1) : null;
}
/** "x1.0", "1min", "-40dB", "USB CH1" -> {pre, num, suf, dec, plus}, or null. */
function anchorOf(s) {
  const m = /^(.*?)([-+]?)(\d+)(?:\.(\d+))?(.*)$/.exec(s.trim());
  if (!m) return null;
  return { pre: m[1], num: Number(`${m[2] === '-' ? '-' : ''}${m[3]}.${m[4] || 0}`), dec: (m[4] || '').length, suf: m[5], plus: m[2] === '+' };
}

/** Readable help for a description (its anchors), e.g. "OS: x0.0 … x1.0 … x2.0". */
export const specHelp = (spec) => `OS value text: ${parseSpec(spec).body.replace(/\x01/g, ' / ').replace(/\x02/g, ' … ').replace(/\x04/g, ' / ')}${parseSpec(spec).unit ? ` (${parseSpec(spec).unit})` : ''}`;

export const groupOf = (gkey) => OS_GROUPS[gkey];
const keyOf = (s) => s.replace(/[()#]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** How the editor shows a value of description `text` over min..max: {options} for lists and selections (up to
 *  41 values, or any listed / labelled range), else {format} (the OS formatter) with `help` for scale anchors;
 *  {input: 'number'} for raw words (flags, parameter ids, floats). */
export function osDescribe(text, min, max) {
  const span = max - min;
  if (span < 0 || span > 0xffff) return { input: 'number', help: specHelp(text) };
  const raw = scaleOnly(text, min, max);
  const fmt = raw ? (v) => String(v) : (v) => osText(text, v, min);
  let opts = span <= 255 ? osOptions(text, min, max) : null;
  if (!(opts && opts.length === span + 1) && span <= 40) opts = range(min, max).map((v) => [v, fmt(v)]);
  if (opts && opts.length === span + 1) return { options: opts };
  const out = { format: fmt };
  if (raw || /[\x01\x04]/.test(text)) out.help = specHelp(text);
  if (span > 255 && !parseSpec(text).dec) out.input = 'number';
  return out;
}

/**
 * Editor parameters of OS group `gkey`. `at(packedOffset)` maps the parameter's offset inside the struct
 * (packed address - struct base) to the compact data offset; `over[name]` adds or replaces fields.
 */
export function osParams(gkey, { structBase, at, prefix = '', group, section, over = {} }) {
  const g = OS_GROUPS[gkey];
  if (!g) throw new Error(`SYSTEM-8 OS group ${gkey} missing`);
  const seen = new Map();
  return g.rows.map(([i, name, off, n, min, max, def, bias, flags, text]) => {
    let k = prefix + keyOf(name);
    const c = (seen.get(k) || 0) + 1; seen.set(k, c);
    if (c > 1) k += `_${c}`;
    const wide = max < min; // 32-bit words the OS keeps as 0..FFFFFFFF (flags, parameter ids)
    const p = {
      key: k, label: name.replace(/\s+$/, ''), os: i, offset: at(g.addr - structBase + off),
      ...(n > 1 ? { nibbles: n } : { size: 1 }), min: wide ? 0 : min, max: wide ? 0xffffffff : max, ...osStore(flags, bias, min),
      osDefault: def, ...(flags & 1 ? { readOnly: true } : {}), group, ...(section ? { section } : {}),
      ...osDescribe(text, min, max),
    };
    return { ...p, ...(over[name.trim()] || {}) };
  });
}

/** How a value is stored in the SysEx data: with the record's bias when the type has the 0x200 flag (stored =
 *  value + bias: perf part Octave 0..6, chord notes 0 = NONE ..), else as a two's-complement number of its nibbles
 *  when the range is negative (patch OCTAVE SHIFT FFFFFFFD = -3); checked against the factory data. */
export const osStore = (flags, bias, min) => (flags & 2 ? { bias } : min < 0 ? { signed: true } : {});

/** OS rows by absolute packed address (for the plugin-script rows of the same values). */
export function osRowsByAddr() {
  const m = new Map();
  for (const g of Object.values(OS_GROUPS)) for (const r of g.rows) m.set(g.addr + r[2], r);
  return m;
}

/** Reserved byte runs of a group as [compact offset, bytes]. */
export const osReserved = (gkey, structBase, at) => (OS_GROUPS[gkey]?.reserved || []).map(([o, n]) => [at(OS_GROUPS[gkey].addr - structBase + o), n]);
