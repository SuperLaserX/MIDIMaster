// DigiTech MEQ 28 / MEQ 14 / MEQ 7 (MIDI graphic equalizers: 28 bands, two channels of 14, four channels of 7; one
// HD6303 firmware for the three, chosen by two jumpers): the editor from the v1.06 EPROM (see
// docs/devices/digitech-meq.md). The display has two 7-segment digits: the program number, the output levels and the
// MIDI pages show there, and every such text below is what the firmware's own routines put on them (run in an emulator:
// tools/digitech/meq_fw.py writes digitech-meq-fw.js). A band shows as a column of 13 LEDs (two lit between steps); its
// value 0-24 is -12 to +12 dB and the band names (frequencies) are those of DigiTech's MIDI implementation manual, as the
// firmware has no text for them.
//
// A program is 35 bytes: 31 band columns (0-24; which columns are bands depends on the model) and four output levels
// (0-15, shown "-14" to "16"). 99 programs ("1" - "99").
// SysEx F0 00 00 10 <channel - 1> <model: 07 MEQ 28, 08 MEQ 14, 09 MEQ 7> <command> ... F7 (DOD / DigiTech), taken when a
// section of the unit receives on that channel; data bytes travel as pairs (bit 7, then bits 6-0).
//   00              request: the unit sends 41h on its first section's channel (nothing when that one is off or omni)
//   41 <pairs>      memory (3511 bytes): settings then the 99 programs; at its last byte the unit loads the program of
//                   byte 0 and restarts
//   42 n <pairs>    one program (n 0-98, 35 bytes), stored; nothing else changes
//   01 n            "request one program": the v1.06 handler jumps to 0042h, where nothing answers (the unit restarts
//                   through its illegal-opcode trap). Never sent.
// Program change n loads program n + 1 into the sections that receive on its channel; control changes move the bands,
// levels and bypass linked to them.

import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';
import { FIRMWARE, MODELS, TEXTS } from './digitech-meq-fw.js';

export { FIRMWARE, MODELS, TEXTS };

export const PROG = 35;
export const COUNT = 99;
export const BANDS = 31;
export const LEVELS = 31;               // program bytes 31-34: the output level of sections 1-4
/** Dump offsets (the 41h memory, RAM 813Dh-8EF3h). */
export const AT = { program: 0, channels: 1, masks: 5, bandLinks: 9, levelLinks: 40, bypassLink: 44, lock: 45, programs: 46 };
export const DUMP_SIZE = AT.programs + PROG * COUNT; // 3511
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));

// The band frequencies of each model's program bytes (DigiTech MIDI Implementation Manual, MEQ tables).
const F28 = ['31.5 Hz', '40 Hz', '50 Hz', '63 Hz', '80 Hz', '100 Hz', '125 Hz', '160 Hz', '200 Hz', '250 Hz', '315 Hz', '400 Hz', '500 Hz', '630 Hz', '800 Hz', '1 kHz', '1.25 kHz', '1.6 kHz', '2 kHz', '2.5 kHz', '3.15 kHz', '4 kHz', '5 kHz', '6.3 kHz', '8 kHz', '10 kHz', '12.5 kHz', '16 kHz'];
const F14 = ['40 Hz', '63 Hz', '100 Hz', '160 Hz', '250 Hz', '400 Hz', '630 Hz', '1 kHz', '1.6 kHz', '2.5 kHz', '4 kHz', '6.3 kHz', '10 kHz', '16 kHz'];
const F7 = ['63 Hz', '160 Hz', '400 Hz', '1 kHz', '2.5 kHz', '6.3 kHz', '16 kHz'];
const LAYOUT = [
  [{ first: 2, names: F28 }],
  [{ first: 1, names: F14 }, { first: 16, names: F14 }],
  [{ first: 0, names: F7 }, { first: 8, names: F7 }, { first: 16, names: F7 }, { first: 24, names: F7 }],
];
const hz = (s) => parseFloat(s) * (/kHz/.test(s) ? 1000 : 1);
/** The bands of model m: [{col, section, name, hz}] (column = program byte). */
export const bandsOf = (m) => LAYOUT[m].flatMap((s, si) => s.names.map((name, i) => ({ col: s.first + i, section: si, name, hz: hz(name) })));
export const sectionName = (m, s) => (m === 0 ? '' : `Ch${s + 1}`);
export const bandLabel = (m, b) => (m === 0 ? b.name : `${sectionName(m, b.section)} ${b.name}`);

// ------------------------------------------------------------------ what the editor knows of the unit
const unit = { model: 1, target: 0, dump: null };
export const modelOf = (byte) => MODELS.findIndex((x) => x.byte === byte);
export const first = (m = unit.model) => hex(MODELS[m].first);
export const factory = (i, m = unit.model) => hex(MODELS[m].factory[i]);
export const programFromDump = (dump, i) => Uint8Array.from(dump.slice(AT.programs + PROG * i, AT.programs + PROG * (i + 1)));
export function programIntoDump(dump, i, d) { dump.set(d.slice(0, PROG), AT.programs + PROG * i); }

// ------------------------------------------------------------------ messages
const HDR = [0xf0, 0x00, 0x00, 0x10];
export const isMeq = (raw) => raw?.[0] === 0xf0 && raw.length > 7 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0x10 && modelOf(raw[5]) >= 0;
const hdr = (ch, m) => [...HDR, ch & 15, MODELS[m].byte];
export const pairs = (d) => Array.from(d).flatMap((v) => [(v >> 7) & 1, v & 0x7f]);
export const unpairs = (a) => Uint8Array.from({ length: a.length >> 1 }, (_, i) => ((a[2 * i] & 1) << 7) | (a[2 * i + 1] & 0x7f));
export const requestAll = (ch = 0, m = unit.model) => [...hdr(ch, m), 0x00, 0xf7];
export const allMessage = (dump, ch = 0, m = unit.model) => [...hdr(ch, m), 0x41, ...pairs(Array.from({ length: DUMP_SIZE }, (_, i) => dump[i] ?? 0)), 0xf7];
export const programMessage = (n, d, ch = 0, m = unit.model) => [...hdr(ch, m), 0x42, ...pairs([n, ...Array.from({ length: PROG }, (_, i) => d[i] ?? 0)]), 0xf7];
export const programChange = (n, ch = 0) => [0xc0 | (ch & 15), n & 0x7f];

export function parse(raw) {
  if (!isMeq(raw) || raw.at(-1) !== 0xf7) return null;
  const a = Array.from(raw);
  const ch = a[4] & 15;
  const model = modelOf(a[5]);
  const body = a.slice(7, -1);
  switch (a[6]) {
    case 0x00: return { kind: 'request', ch, model };
    case 0x01: return { kind: 'request1', ch, model };
    case 0x41: {
      if (body.length !== 2 * DUMP_SIZE) return null;
      return { kind: 'all', ch, model, data: unpairs(body) };
    }
    case 0x42: {
      if (body.length !== 2 * (PROG + 1)) return null;
      const d = unpairs(body);
      return { kind: 'program', ch, model, n: d[0], data: d.slice(1) };
    }
    default: return null;
  }
}
export const isRequest = (raw) => /^request/.test(parse(raw)?.kind || '');
const learn = (m) => { if (m && m.model >= 0) unit.model = m.model; };

// ------------------------------------------------------------------ values
const db = (v) => (v === 12 ? '0 dB' : `${v > 12 ? '+' : ''}${v - 12} dB`);
const leds = (v) => { const l = TEXTS.led[v]; return l.length === 1 ? `LED ${l[0]}` : `LEDs ${l[1]}+${l[0]}`; };
export const bandText = (v) => (v <= 24 ? `${db(v)} (${leds(v)})` : null);
const BAND_OPTS = Array.from({ length: 25 }, (_, v) => [v, bandText(v)]);
const LEVEL_OPTS = TEXTS.level.map((t, v) => [v, t]);
const withValue = (o, v, why) => (o.some(([x]) => x === v) ? o : [...o, [v, `${v} (${why})`]].sort((x, y) => x[0] - y[0]));
export const levelText = (v) => TEXTS.level[v] ?? null;
export const programText = (i) => TEXTS.program[i];
export const name = (d, m = unit.model) => {
  const lv = Array.from({ length: MODELS[m].sections }, (_, s) => levelText(d[LEVELS + s]) ?? '?');
  const flat = bandsOf(m).every((b) => d[b.col] === 12);
  return `${flat ? 'flat' : 'EQ'} · level ${lv.join(' / ')}`;
};

const usedCols = (m) => new Set(bandsOf(m).map((b) => b.col));
const bandParams = MODELS.flatMap((x, m) => bandsOf(m).map((b) => ({
  key: `m${m}b${b.col}`, group: m === 0 ? 'Bands' : `Channel ${b.section + 1}`, label: b.name, offset: b.col, min: 0, max: 255, options: BAND_OPTS,
  help: `${x.name} ${bandLabel(m, b)}: 0-24 = -12 to +12 dB (DigiTech's MIDI implementation manual; the unit shows it as a column of 13 LEDs, two lit between steps). A controller can move it: choose one under the band controllers on the Settings page.`,
  dynamic: (d) => ({ hidden: unit.model !== m, options: withValue(BAND_OPTS, d[b.col], 'above 24: the unit shows and sets 24') }),
})));
const levelParams = MODELS.flatMap((x, m) => Array.from({ length: x.sections }, (_, s) => ({
  key: `m${m}l${s}`, group: m === 0 ? 'Bands' : `Channel ${s + 1}`, label: m === 0 ? 'Level' : `Ch${s + 1} Level`, offset: LEVELS + s, min: 0, max: 255, options: LEVEL_OPTS,
  help: `${x.name} output level${m ? ` of channel ${s + 1}` : ''}: 0-15 as the level page shows it ("-14" to "16", 2 per step)`,
  dynamic: (d) => ({ hidden: unit.model !== m, options: withValue(LEVEL_OPTS, d[LEVELS + s], 'above 15: no text in the level table') }),
})));
const byteParams = Array.from({ length: PROG }, (_, i) => ({
  key: `byte${i}`, group: 'Bytes (exact)', label: `Byte ${i}`, offset: i, min: 0, max: 255, input: 'number',
  help: `Program byte ${i} as a typed number`,
  dynamic: () => {
    const m = unit.model;
    const b = bandsOf(m).find((x) => x.col === i);
    if (b) return { label: `Byte ${i} (${bandLabel(m, b)})` };
    if (i >= LEVELS && i < LEVELS + MODELS[m].sections) return { label: `Byte ${i} (${m ? `Ch${i - LEVELS + 1} ` : ''}Level)` };
    return { label: `Byte ${i} (unused on the ${MODELS[m].name})` };
  },
}));
export const programParams = [...bandParams, ...levelParams, ...byteParams];
for (const p of programParams) p.sendKey = 'program'; // every change sends the program: the last one wins
const PARAM_BY_KEY = new Map(programParams.map((p) => [p.key, p]));
export const paramOf = (key) => PARAM_BY_KEY.get(key);

/** The channels (0-15) whose program change loads the program into every section that receives: the sections' own
 *  channels as last read (omni sections take any), else the editor's channel. */
export function loadChannels(ch, dump = unit.dump, m = unit.model) {
  if (!dump) return [ch];
  const set = [];
  for (let s = 0; s < MODELS[m].sections; s++) {
    const c = dump[AT.channels + s];
    const x = c >= 1 && c <= 16 ? c - 1 : c === 17 ? ch : null;
    if (x !== null && !set.includes(x)) set.push(x);
  }
  return set.length ? set : [ch];
}
/** What each edit sends: the program (42h) into program n, then a program change that loads it. */
export function writeAndLoad(d, n, ch = 0) {
  if (unit.dump) programIntoDump(unit.dump, n, d);
  return [programMessage(n, d, ch), ...loadChannels(ch).map((c) => programChange(n, c))];
}

// ------------------------------------------------------------------ settings (the head of the 41h memory)
const tx = (a) => a.map((t, v) => [v, t]);
const CHANNEL_OPTS = TEXTS.channel.map((t, v) => [v, v === 0 ? `${t} (off)` : v === 17 ? `${t} (every channel)` : t]);
const LINK_OPTS = TEXTS.link.map((t, v) => [v, v === 0 ? `${t} (none)` : t]);
const BYPASS_OPTS = TEXTS.bypassLink.map((t, v) => [v, v === 0 ? `${t} (none)` : t]);
const LOCK_OPTS = [[0, 'Off'], [0xa3, 'A3h semi lockout (the panel cannot edit)'], [0xa5, 'A5h full lockout (the unit stops after power-up)']];
export const settingsParams = [
  { key: 'program', section: 'midi', group: 'Program', label: 'Current program', offset: AT.program, options: tx(TEXTS.program),
    help: 'The program the unit has loaded, "1" - "99". Sending the memory loads this program when it arrives' },
  ...[0, 1, 2, 3].map((s) => ({
    key: `channel${s}`, section: 'midi', group: 'MIDI channels', label: `Channel ${s + 1}`, offset: AT.channels + s, options: CHANNEL_OPTS,
    help: `The MIDI channel ${s ? `of the unit's channel ${s + 1}` : 'of the unit (its first channel)'} as its MIDI page shows it: "--" off, 1-16, "oi" (17) every channel. Requests are answered on the first one, and not at all when it is off or every channel`,
    dynamic: (d) => ({ hidden: s >= MODELS[unit.model].sections, options: withValue(CHANNEL_OPTS, d[AT.channels + s], 'no text') }),
  })),
  ...[0, 1, 2, 3].map((s) => ({
    key: `mask${s}`, section: 'midi', group: 'Bytes (exact)', label: `Channel ${s + 1} mask`, offset: AT.masks + s, min: 0, max: 255, input: 'number', readOnly: true,
    help: 'Which sections a message on this channel reaches; the unit sets it at its first power-up ("internal use" in DigiTech\'s manual). Shown, not changed',
  })),
  ...MODELS.flatMap((x, m) => bandsOf(m).map((b) => ({
    key: `m${m}link${b.col}`, section: 'links', group: m === 0 ? 'Band controllers' : `Channel ${b.section + 1} controllers`, label: b.name, offset: AT.bandLinks + b.col, options: LINK_OPTS,
    help: `The controller that moves ${bandLabel(m, b)} ("--" none, 1-99)`,
    dynamic: () => ({ hidden: unit.model !== m }),
  }))),
  ...[0, 1, 2, 3].map((s) => ({
    key: `levellink${s}`, section: 'links', group: 'Level and bypass controllers', label: `Channel ${s + 1} level`, offset: AT.levelLinks + s, options: LINK_OPTS,
    help: `The controller that moves the output level of channel ${s + 1} ("--" none, 1-99; the unit takes it on any channel it receives)`,
    dynamic: () => ({ hidden: s >= MODELS[unit.model].sections, label: unit.model === 0 ? 'Level' : `Channel ${s + 1} level` }),
  })),
  { key: 'bypasslink', section: 'links', group: 'Level and bypass controllers', label: 'Bypass', offset: AT.bypassLink, options: BYPASS_OPTS,
    help: 'The controller that switches the bypass, shown with the left digit\'s point: values 0-64 bypass, 65-127 the EQ' },
  { key: 'lock', section: 'midi', group: 'Power-up lock', label: 'Power-up lock', offset: AT.lock, options: LOCK_OPTS,
    help: 'A3h semi lockout (every edit key does nothing; programs can still be recalled), A5h full lockout (after power-up, or the restart that sending the memory causes, the unit waits for ever: no keys, no MIDI). Names from DigiTech\'s manual. A power-up with the bypass key held switches A3h, with the recall key A5h. Keep it Off',
    dynamic: (d) => ({ options: withValue(LOCK_OPTS, d[AT.lock], 'off: only A3h and A5h lock') }) },
  ...MODELS.flatMap((x, m) => Array.from({ length: BANDS }, (_, c) => c).filter((c) => !usedCols(m).has(c)).map((c) => ({
    key: `m${m}xlink${c}`, section: 'links', group: 'Bytes (exact)', label: `Column ${c} controller`, offset: AT.bandLinks + c, min: 0, max: 255, input: 'number',
    help: `A controller setting for column ${c}, which is no band on the ${x.name}; shown as stored`,
    dynamic: () => ({ hidden: unit.model !== m }),
  }))),
];

// ------------------------------------------------------------------ simulator
const sectionsOf = (dump, ch, m) => {
  const out = [];
  for (let s = 0; s < MODELS[m].sections; s++) { const c = dump[AT.channels + s]; if (c === 17 || c === ch + 1) out.push(s); }
  return out;
};
const loadsOf = (m, secs) => MODELS[m].loads[String(secs.reduce((a, s) => a | (1 << s), 0))] || [];
function simulate() {
  const m0 = unit.model;
  const st = { model: m0, dump: first(m0), edit: null, current: 0, bypass: false };
  // its channels on MIDI channel 1: with the first power-up's "every channel" the unit answers no request
  for (let i = 0; i < MODELS[m0].sections; i++) st.dump[AT.channels + i] = 1;
  st.edit = programFromDump(st.dump, 0);
  const load = (n, secs) => { const p = programFromDump(st.dump, n); for (const i of loadsOf(st.model, secs)) st.edit[i] = p[i]; };
  return {
    state: st,
    get current() { return st.current; },
    handle(msg) {
      const m = Array.from(msg);
      const s = m[0] & 0xf0;
      if (s === 0xb0 || s === 0xc0) {
        const secs = sectionsOf(st.dump, m[0] & 15, st.model);
        if (!secs.length) return [];
        if (s === 0xc0) { if (m[1] < COUNT) { st.current = m[1]; st.dump[AT.program] = m[1]; load(m[1], secs); } return []; }
        const n = m[1];
        const v = m[2] & 0x7f;
        if (!n || n >= 100) return [];
        for (let k = 0; k < 36; k++) {
          if (st.dump[AT.bandLinks + k] !== n) continue;
          if (k < BANDS) { if (loadsOf(st.model, secs).includes(k)) st.edit[k] = (v * 2 * 25) >> 8; } else if (k < 35) st.edit[k] = (v * 2 * 16) >> 8;
          else st.bypass = v <= 64;
        }
        return [];
      }
      if (m[0] !== 0xf0) return null;
      const x = parse(m);
      if (!x || x.model !== st.model || !sectionsOf(st.dump, x.ch, st.model).length) return [];
      switch (x.kind) {
        case 'request': { const c = st.dump[AT.channels]; return c >= 1 && c <= 16 ? [Uint8Array.from(allMessage(st.dump, c - 1, st.model))] : []; }
        case 'program': if (x.n < COUNT) programIntoDump(st.dump, x.n, x.data); return [];
        case 'all': st.dump.set(x.data, 0); st.current = st.dump[AT.program]; st.edit = programFromDump(st.dump, st.current); return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor, library
function describe(raw) {
  const m = parse(raw);
  if (!m) return isMeq(raw) ? 'MEQ message' : null;
  const nm = MODELS[m.model].name;
  switch (m.kind) {
    case 'request': return `${nm} request: memory`;
    case 'request1': return `${nm} request one program (01h: restarts a v1.06 unit)`;
    case 'all': return `${nm} memory (settings, 99 programs)`;
    case 'program': return `${nm} program ${m.n + 1}`;
    default: return `${nm} message`;
  }
}
function libraryItems(msgs) {
  const items = [];
  for (const raw of msgs) {
    const m = parse(raw);
    if (m?.kind === 'all') {
      for (let i = 0; i < COUNT; i++) {
        const d = programFromDump(m.data, i);
        items.push({ key: `p${i}`, label: `Program ${i + 1}`, name: name(d, m.model), object: 'effect', data: d, msgs: [] });
      }
      items.push({ key: 'all', label: `${MODELS[m.model].name} memory (settings and programs)`, name: '', object: 'system', data: m.data, msgs: [Uint8Array.from(raw)] });
    } else if (m?.kind === 'program') {
      items.push({ key: `p${m.n}`, label: `Program ${m.n + 1}`, name: name(m.data, m.model), object: 'effect', data: m.data, msgs: [Uint8Array.from(raw)] });
    } else if (!m?.kind?.startsWith('request')) items.push({ key: `x${items.length}`, label: describe(raw) || 'Other message', name: '', object: null, msgs: [raw] });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: effects.eq = a graphic EQ: bands [{hz, gain (dB), name}] of channel 1, sections[] every channel's bands,
// levels[] the output level texts; the exact bytes and the model in extra (family 'digitech-meq'). fromCommon: the same
// model loads the bytes; another MEQ model or another device's graphic EQ: each band takes the gain of the source band
// nearest in frequency (per channel when the source has channels), levels by their text.
const FAMILY = 'digitech-meq';
function toCommon(d) {
  const m = unit.model;
  const bs = bandsOf(m);
  const sections = Array.from({ length: MODELS[m].sections }, (_, s) => bs.filter((b) => b.section === s).map((b) => ({ hz: b.hz, name: b.name, gain: Math.min(24, d[b.col]) - 12 })));
  const levels = Array.from({ length: MODELS[m].sections }, (_, s) => levelText(d[LEVELS + s]));
  const effects = { eq: { type: `${MODELS[m].name} graphic EQ`, bands: sections[0], sections, levels, level: 1 } };
  return { model: 1, kind: 'effect', name: name(d, m), effects, extra: { family: FAMILY, model: MODELS[m].name, data: Array.from(d.slice(0, PROG)), match: hashBytes(d.slice(0, PROG)) } };
}
function fromCommon(c, base) {
  const r = emptyReport();
  const m = unit.model;
  const x = c?.extra;
  if (x?.family === FAMILY && x.model === MODELS[m].name && Array.isArray(x.data) && x.data.length === PROG) {
    r.mapped.push(`Program (exact, ${x.model})`);
    return { data: Uint8Array.from(x.data, (v) => v & 0xff), report: tidy(r) };
  }
  const d = Uint8Array.from(base?.length === PROG ? base : factory(0, m));
  const eq = c?.effects?.eq;
  const src = Array.isArray(eq?.sections) && eq.sections.length ? eq.sections : Array.isArray(eq?.bands) ? [eq.bands] : null;
  if (!src) {
    r.dropped.push('No graphic EQ in the source: the program keeps its bands');
    return { data: d, report: tidy(r) };
  }
  for (const b of bandsOf(m)) {
    const list = (src[b.section] || src[0]).filter((y) => Number.isFinite(y?.hz) && Number.isFinite(y?.gain));
    if (!list.length) continue;
    const near = list.reduce((a, y) => (Math.abs(Math.log(y.hz / b.hz)) < Math.abs(Math.log(a.hz / b.hz)) ? y : a));
    d[b.col] = Math.max(0, Math.min(24, Math.round(near.gain) + 12));
  }
  r.approximated.push(`Bands by frequency${x?.model ? ` (from the ${x.model})` : ''}, each from the nearest source band`);
  if (Array.isArray(eq.levels)) eq.levels.forEach((t, s) => { const v = TEXTS.level.indexOf(t); if (s < MODELS[m].sections && v >= 0) d[LEVELS + s] = v; });
  for (const k of Object.keys(c?.effects || {})) if (k !== 'eq') r.dropped.push(`Effect ${k}`);
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ the LED columns as the front panel shows them
const SVG = 'http://www.w3.org/2000/svg';
const drawColumns = (group) => ({ data, params }) => {
  const re = new RegExp(`^m${unit.model}b[0-9]+$`);
  const bands = params.filter((p) => p.group === group && re.test(p.key)).map((p) => p.offset);
  const w = 16;
  const W = Math.max(14, bands.length) * w + 8;
  const H = 13 * 10 + 20;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width:${W * 1.6}px`);
  const el = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  bands.forEach((col, i) => {
    const lit = TEXTS.led[Math.min(24, data[col])];
    for (let led = 1; led <= 13; led++) {
      el('circle', { cx: 4 + i * w + w / 2, cy: 7 + (13 - led) * 10, r: 3.6, fill: lit.includes(led) ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 0.6, opacity: led === 7 || lit.includes(led) ? 1 : 0.45 });
    }
  });
  el('text', { x: 4, y: H - 3, 'font-size': 9, fill: 'currentColor' }, 'centre LED = 0 dB');
  return svg;
};

// ------------------------------------------------------------------ definition
const chOf = (ctx) => (ctx?.channel ?? 0) & 15;
const isAll = (r) => parse(r)?.kind === 'all';
/** Read the memory (00 request, the 41h answer: 7030 bytes, about 2.3 s at MIDI speed). */
async function fetchAll(api) {
  const reply = await api.g.client.request(Uint8Array.from(requestAll(chOf(api.ctx))), { match: (_m, r) => isAll(r), timeout: 10000 });
  const m = parse(reply.raw ?? reply);
  learn(m);
  unit.dump = Uint8Array.from(m.data);
  return m.data;
}
const modelTarget = {
  label: 'Model', title: 'Which MEQ you have: it decides which bands the pages show and how messages are addressed (a message from the unit sets it)',
  options: () => MODELS.map((x, m) => [m, `${x.name} (model byte ${x.byte.toString(16).padStart(2, '0').toUpperCase()}h)`]),
  value: () => unit.model, set: (v) => { unit.model = Number(v); },
};
const def = {
  coverage: 'Edits the MEQ\'s programs (the bands of the MEQ 28, MEQ 14 or MEQ 7 and the output levels, with the level page\'s texts), its 99 user programs and its settings (MIDI channels, controller links with the MIDI pages\' texts, power-up lock), and shows the 10 factory programs of each model. Band names from DigiTech\'s MIDI implementation manual. Reads and writes the unit\'s whole memory, writes single programs and loads them with a program change. Not checked on hardware.',
  sysex: { manufacturer: [0x00, 0x00, 0x10], model: 0x08 },
  minGap: 20,
  describe,
  recognise: (raw) => isMeq(raw),
  isOwn: isMeq,
  isRequest,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: PROG,
      init: () => factory(0),
      fetch: async (api) => programFromDump(await fetchAll(api), unit.target),
      receive: (raw) => {
        const m = parse(raw);
        learn(m);
        if (m?.kind === 'all') { unit.dump = Uint8Array.from(m.data); return programFromDump(m.data, unit.target); }
        return m?.kind === 'program' && m.n === unit.target ? m.data : null;
      },
      params: programParams,
      groupInfo: {
        Bands: { draw: drawColumns('Bands'), wide: true, note: 'Each band 0-24: -12 to +12 dB in 1 dB steps; the unit shows it as a column of 13 LEDs (2 dB apart, two lit between).' },
        'Channel 1': { draw: drawColumns('Channel 1'), wide: true }, 'Channel 2': { draw: drawColumns('Channel 2'), wide: true },
        'Channel 3': { draw: drawColumns('Channel 3'), wide: true }, 'Channel 4': { draw: drawColumns('Channel 4'), wide: true },
        'Bytes (exact)': { table: true, note: 'The 35 program bytes as typed numbers (the cards above show the same bytes).' },
      },
      sendParam: (_p, _v, d, ctx) => writeAndLoad(d, unit.target, chOf(ctx)),
      name: (d) => name(d),
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 4,
      target: {
        label: 'Program', title: 'The user program edits are written into, then loaded with a program change',
        options: () => Array.from({ length: COUNT }, (_, i) => [i, programText(i)]),
        value: () => unit.target, set: (v) => { unit.target = Number(v); },
      },
      note: () => `Model: ${MODELS[unit.model].name} (chosen on the Settings page; a message from the unit sets it). Each change writes the program into the unit and loads it with a program change on the channels its sections receive on (as last read; otherwise the editor's channel). A program change reaches the filters only while the unit shows its program or band pages: in its level and MIDI pages the bands change when it leaves them.`,
      toSyx: (data, ctx) => programMessage(unit.target, data, chOf(ctx)),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); learn(m); if (m?.kind === 'program') return m.data; if (m?.kind === 'all') return programFromDump(m.data, unit.target); } return null; },
      sendAll: { label: 'Write and load', build: (data, ctx) => writeAndLoad(data, unit.target, chOf(ctx)) },
      slots: {
        label: 'Programs', banks: [[0, 'User 1 - 99'], [1, 'Factory (first power-up)']],
        count: (bank) => (bank ? 10 : COUNT),
        slotLabel: (bank, i) => (bank ? `F${i + 1}` : programText(i)),
        note: (bank) => (bank ? 'The 10 programs the first power-up writes into programs 1-10 (the MEQ 28 and MEQ 14 share them; the MEQ 7 has its own): Edit loads one from the editor\'s own copy.'
          : 'Edit and Read names read the whole memory (the unit answers on its first channel, and only when that one is 1-16); Store writes one program; Play sends a program change.'),
        names: (bank) => (bank === 1 ? MODELS[unit.model].factory.map((h) => name(hex(h))) : null),
        writable: (bank) => bank === 0,
        name: (d) => name(d),
        recall: (bank, i, ctx) => { if (bank) return []; unit.target = i; return loadChannels(chOf(ctx)).map((c) => programChange(i, c)); },
        fetch: async (api, bank, i) => { if (bank === 1) return factory(i); unit.target = i; return programFromDump(unit.dump || await fetchAll(api), i); },
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { MODELS[unit.model].factory.forEach((h, i) => onName(i, name(hex(h)))); return; }
          const d = await fetchAll(api);
          for (let i = 0; i < COUNT; i++) onName(i, name(programFromDump(d, i)));
        },
        store: (_bank, i, ctx, data) => { if (unit.dump) programIntoDump(unit.dump, i, data); return [programMessage(i, data, chOf(ctx))]; },
      },
    },
    {
      key: 'system', page: 'Settings', icon: '⚙', label: 'Settings', size: DUMP_SIZE, notLive: true,
      init: () => first(),
      fetch: async (api) => fetchAll(api),
      receive: (raw) => { const m = parse(raw); if (m?.kind !== 'all') return null; learn(m); unit.dump = Uint8Array.from(m.data); return m.data; },
      params: settingsParams,
      sections: [{ key: 'midi', label: 'MIDI channels and lock' }, { key: 'links', label: 'Controllers' }],
      cols: 4,
      target: modelTarget,
      note: 'The unit\'s whole memory: these settings, then the 99 programs (not shown here). The unit has no message for the settings alone: Send writes the whole memory back, programs included as they were read; at its end the unit loads the current program and restarts.',
      warning: (ctx) => { const l = ctx?.data?.system?.[AT.lock]; return l === 0xa5 ? 'The power-up lock is A5h (full lockout): after this memory arrives the unit restarts and stops. Set it Off before sending.' : null; },
      actions: [
        { label: 'Send to the MEQ', title: 'Send the whole memory: these settings and the 99 programs as read; the unit restarts', run: async (api) => {
          const ok = await api.confirm('Send all memory', 'This replaces every program and setting with the copy read last (Get first); the unit restarts when it arrives.', 'Send');
          if (ok) api.send([allMessage(api.data, chOf(api.ctx))]);
        } },
        { label: 'First power-up contents', title: 'The memory as the unit sets it at its first power-up (the 10 factory programs, flat programs 11-99, every channel, no controllers)', run: (api) => api.setData(first()) },
      ],
      toSyx: (data, ctx) => allMessage(data, chOf(ctx)),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.kind === 'all') { learn(m); return m.data; } } return null; },
    },
  ],
  midiNotes: [
    'SysEx F0 00 00 10 <channel - 1> <model> <command> ... F7: model 07 MEQ 28, 08 MEQ 14, 09 MEQ 7; taken when one of the unit\'s channels receives on that MIDI channel (or every channel). Data bytes travel as pairs: bit 7, then bits 6-0.',
    'Commands: 00 request (the unit answers 41h on its first channel\'s MIDI channel; nothing when that one is off or every channel), 41h memory (3511 bytes: current program, MIDI channels, section masks, 36 controller links, power-up lock, 99 programs of 35 bytes; at its last byte the unit loads the current program and restarts), 42h one program (number 0-98, then 35 bytes: stored only).',
    'The 01h "request one program" of DigiTech\'s manual jumps to address 0042h in v1.06, where nothing answers: the unit restarts. The editor never sends it.',
    'Program change n (0-98) loads program n + 1 into the channels of the unit that receive on it. Control change: a band, an output level or the bypass linked to a controller (1-99) takes value x 2 x (range + 1) / 256; the bypass is on for 0-64.',
  ],
};

export const _test = { simulate, toCommon, fromCommon, describe, libraryItems, unit, drawColumns };
export default def;
