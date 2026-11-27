// DigiTech DSP-128 Plus (multi-effects, 4-character 7-segment display; HD6303, 32 KB EPROM): the editor from its
// v2.00 firmware (see docs/devices/digitech-dsp128plus.md). Every name and value text is what the unit's display shows:
// its page records were run in an emulator for every value (tools/digitech/dsp128p_fw.py writes
// digitech-dsp128plus-fw.js); the bytes and messages are those of its receiver (SCI state machine, main-loop parser) and
// its dump sender.
//
// A program is 12 bytes: byte 0 the configuration ("A  0" - "A 14"), bytes 1-11 the values of that configuration's pages
// in page order. The unit shows no parameter names: each page shows a two-character code and the value ("rd1.4",
// "LP12", "d.250", "CL 7"). 128 user programs (5000h-55FFh, numbered P  1 - P128); the first power-up fills them with the
// 128 factory programs of the ROM.
//
// SysEx F0 00 00 10 <channel - 1> 03 <command> ... F7 (DOD/DigiTech, model 03), taken on the unit's MIDI channel (any
// with "CH o", none with "CH n"). Data bytes travel as pairs: bit 7, then bits 6-0.
//   00                 request: the unit sends 41h
//   41 <pairs>         memory: the 128 programs, then the MIDI channel and the controllers of links 1-50 (1587 bytes).
//                      The receiver stores each byte as it comes, so a message cut after program n writes programs
//                      1..n only; at F7 the unit loads its current program again.
//   40 a b c d         a DSP register write (raw): not used
// Program change n loads program n + 1. A control change moves every parameter of the current program whose link has
// that controller (value x 2 x (range + 1) / 256); channel pressure counts as controller 100 ("CP").

import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';
import { FIRMWARE, CONFIGS, TABLES, MIDI, FACTORY, STARTS, FIRST_POWER_UP } from './digitech-dsp128plus-fw.js';

export { FIRMWARE, CONFIGS, TABLES, MIDI, FACTORY, STARTS };

const NAME = 'DSP-128 Plus';
export const MODEL = 0x03;
export const PROG = 12;
export const COUNT = 128;
export const AT = { programs: 0, settings: PROG * COUNT, channel: PROG * COUNT, links: PROG * COUNT }; // link k at links + k
export const LINKS = 50;
export const DUMP_SIZE = PROG * COUNT + 1 + LINKS; // 5000h-55FFh, 4049h-407Bh
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
export const FIRST = hex(FIRST_POWER_UP);

// ------------------------------------------------------------------ messages
const HDR = [0xf0, 0x00, 0x00, 0x10];
export const isDsp128 = (raw) => raw?.[0] === 0xf0 && raw.length > 7 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0x10 && raw[5] === MODEL;
const hdr = (ch = 0) => [...HDR, ch & 15, MODEL];
export const pairs = (d) => Array.from(d).flatMap((v) => [(v >> 7) & 1, v & 0x7f]);
export const unpairs = (a) => Uint8Array.from({ length: a.length >> 1 }, (_, i) => ((a[2 * i] & 1) << 7) | (a[2 * i + 1] & 0x7f));
export const requestAll = (ch = 0) => [...hdr(ch), 0x00, 0xf7];
/** A 41h message with the first data.length bytes of the memory (the whole dump, or programs 1..n). */
export const memoryMessage = (data, ch = 0) => [...hdr(ch), 0x41, ...pairs(data), 0xf7];
export const allMessage = (dump, ch = 0) => memoryMessage(Array.from({ length: DUMP_SIZE }, (_, i) => dump[i] ?? 0), ch);
export const programChange = (n, ch = 0) => [0xc0 | (ch & 15), n & 0x7f];

export function parse(raw) {
  if (!isDsp128(raw) || raw.at(-1) !== 0xf7) return null;
  const a = Array.from(raw);
  const ch = a[4] & 15;
  const body = a.slice(7, -1);
  switch (a[6]) {
    case 0x00: return { kind: 'request', ch };
    case 0x40: return { kind: 'dsp', ch, bytes: body };
    case 0x41: {
      if (body.length & 1 || body.length > 2 * DUMP_SIZE) return null;
      const data = unpairs(body);
      return { kind: 'all', ch, data, complete: data.length === DUMP_SIZE, programs: Math.floor(Math.min(data.length, AT.settings) / PROG) };
    }
    default: return null;
  }
}
export const isRequest = (raw) => parse(raw)?.kind === 'request';

// ------------------------------------------------------------------ programs
export const configInfo = (d) => CONFIGS[d[0]] || null;
export const configName = (d) => configInfo(d)?.name ?? `configuration ${d[0]}`;
/** The unit's program display: "P  1" - "P128". */
export const programText = (i) => `P${String(i + 1).padStart(3, ' ')}`;
export const factory = (i) => hex(FACTORY[i]);
export const start = (c) => hex(STARTS[c]);
export const programFromDump = (dump, i) => Uint8Array.from(dump.slice(PROG * i, PROG * (i + 1)));
export function programIntoDump(dump, i, d) { dump.set(d.slice(0, PROG), PROG * i); }
export const pageOf = (c, p) => CONFIGS[c]?.params.find((x) => x.p === p) || null;
export const findPage = (c, label) => CONFIGS[c]?.params.find((x) => x.label === label) || null;
/** The text table of a page for the program bytes d (some pages' texts follow another byte: pg.by, one table per value). */
export const tableOf = (pg, d) => (pg.by != null && d ? pg.ts[d[pg.by]] ?? pg.t : pg.t);
export const textOf = (c, p, v, d = null) => { const pg = pageOf(c, p); return pg && v <= pg.max ? TABLES[tableOf(pg, d)][v] : null; };
export const linkName = (k) => MIDI.names[k - 1] ?? null;

// what the editor knows of the unit: the program edits go to, the last memory read
const unit = { target: 0, dump: null };

const opts = (t, max) => TABLES[t].slice(0, max + 1).map((s, v) => [v, s]);
const withValue = (o, v) => (o.some(([x]) => x === v) ? o : [...o, [v, `${v} (outside the page's range: the unit sets it to 0)`]].sort((x, y) => x[0] - y[0]));
/** As the panel does (E8AF): switching the configuration loads its start program (ROM DEF0h), all 12 bytes. */
export function setConfig(d, v) { d.set(start(v), 0); }
const pageParams = CONFIGS.flatMap((c) => c.params.map((pg) => {
  const t = TABLES[pg.t];
  return {
    key: `c${c.v}p${pg.p}`, group: 'Pages', label: pg.label, offset: pg.p, min: 0, max: 255, options: opts(pg.t, pg.max),
    help: `Page ${pg.p + 1} of ${c.name}: "${t[0]}" to "${t[pg.max]}"; MIDI link ${pg.link} (the controller set on MIDI page "${linkName(pg.link)}" moves it)${pg.by != null ? `; its texts follow page ${pageOf(c.v, pg.by)?.label}` : ''}`,
    dynamic: (d) => ({ hidden: d[0] !== c.v, options: withValue(opts(tableOf(pg, d), pg.max), d[pg.p]) }),
  };
}));
export const programParams = [
  { key: 'config', group: 'Configuration', label: 'Configuration', offset: 0, options: CONFIGS.map((c) => [c.v, c.name]), relayout: true,
    get: (d) => d[0], set: setConfig,
    help: 'Page 1. As on the panel, switching loads the configuration\'s built-in start program (all its values).' },
  ...pageParams,
  ...Array.from({ length: PROG - 1 }, (_, i) => ({
    key: `b${i + 1}`, group: 'Bytes (exact)', label: `Byte ${i + 1}`, offset: i + 1, min: 0, max: 255, input: 'number',
    help: `Program byte ${i + 1} as a typed number`,
    dynamic: (d) => { const pg = pageOf(d[0], i + 1); return { label: `Byte ${i + 1} (${pg ? pg.label : 'no page in this configuration'})` }; },
  })),
];
for (const p of programParams) p.sendKey = 'program'; // every change sends the program: the last one wins
const PARAM_BY_KEY = new Map(programParams.map((p) => [p.key, p]));
export const paramOf = (key) => PARAM_BY_KEY.get(key);

/** The 41h message that writes program n (0-127) with the bytes d: programs 1..n, those before n as last read. Null when
 *  n > 0 and the memory was not read (the message would overwrite them). */
export function writeMessage(d, n, ch = 0, dump = unit.dump) {
  if (n > 0 && !dump) return null;
  const data = new Uint8Array(PROG * (n + 1));
  if (n > 0) data.set(dump.slice(0, PROG * n), 0);
  data.set(d.slice(0, PROG), PROG * n);
  return memoryMessage(data, ch);
}
/** What each edit sends: programs 1..n with the edited one last, then a program change that loads it. */
export function writeAndLoad(d, n, ch = 0) {
  const m = writeMessage(d, n, ch);
  if (!m) return [];
  if (unit.dump) programIntoDump(unit.dump, n, d);
  return [m, programChange(n, ch)];
}

// ------------------------------------------------------------------ settings (the end of the 41h dump)
const tx = (a) => a.map((t, v) => [v, t]);
export const settingsParams = [
  { key: 'channel', section: 'midi', group: 'MIDI', label: 'MIDI channel', offset: AT.channel, options: tx(MIDI.channel),
    help: 'MIDI page 0: "CH 1" - "CH16", "CH o" takes every channel, "CH n" none' },
  ...MIDI.links.map((l) => ({
    key: `link${l.k}`, section: 'links', group: 'Controllers', label: l.name.trim() || `Link ${l.k}`, offset: AT.links + l.k, options: opts(l.t, 100),
    help: `MIDI page ${l.k} "${l.name}": the controller that moves the pages with link ${l.k}; "n" none, 1-99 the controller, "CP" channel pressure`
      + (l.k === 22 ? '. Link 22 moves no page: its controller holds the delay (repeat hold)' : '')
      + (l.k === 23 ? '. Link 23 moves no page: its controller switches the bypass' : ''),
  })),
  ...Array.from({ length: LINKS - 44 }, (_, i) => ({
    key: `link${45 + i}`, section: 'links', group: 'Bytes (exact)', label: `Link ${45 + i} (${MIDI.names[44 + i]})`, offset: AT.links + 45 + i, min: 0, max: 255, input: 'number',
    help: `The controller of link ${45 + i}, which no MIDI page shows (the unit\'s name list has "${MIDI.names[44 + i]}" for it)`,
  })),
];

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { dump: Uint8Array.from(FIRST), current: 0, bypass: false, hold: false };
  const accepts = (ch) => { const c = st.dump[AT.channel]; return c === 16 || c === ch; };
  function control(n, v) {
    const s = st.dump;
    if (n === s[AT.links + 22]) st.hold = v > 0x40;
    if (n === s[AT.links + 23]) st.bypass = v > 0x40;
    const d = programFromDump(s, st.current);
    for (const pg of configInfo(d)?.params || []) {
      if (s[AT.links + pg.link] !== n) continue;
      d[pg.p] = ((v * 2) * (pg.max + 1)) >> 8;
    }
    programIntoDump(s, st.current, d);
  }
  return {
    state: st,
    get current() { return st.current; },
    handle(m) {
      const s = m[0] & 0xf0;
      if (s >= 0xb0 && s <= 0xd0 && m[0] < 0xf0) {
        if (!accepts(m[0] & 15)) return [];
        if (s === 0xc0) st.current = m[1] & 0x7f;
        else if (s === 0xb0 && m[1]) control(m[1], m[2] & 0x7f);
        else if (s === 0xd0) control(100, m[1] & 0x7f);
        return [];
      }
      if (m[0] !== 0xf0) return null;
      const x = parse(m);
      if (!x || !accepts(x.ch)) return [];
      switch (x.kind) {
        case 'request': return [Uint8Array.from(allMessage(st.dump, x.ch))];
        case 'all': st.dump.set(x.data, 0); return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor, library
function describe(raw) {
  const m = parse(raw);
  if (!m) return isDsp128(raw) ? NAME + ' message' : null;
  switch (m.kind) {
    case 'request': return NAME + ' request: memory';
    case 'dsp': return NAME + ' DSP register write';
    case 'all': return m.complete ? NAME + ' memory (128 programs, MIDI settings)' : `${NAME} programs 1-${m.programs} (memory message cut there)`;
    default: return NAME + ' message';
  }
}
function libraryItems(msgs) {
  const items = [];
  for (const raw of msgs) {
    const m = parse(raw);
    if (m?.kind === 'all') {
      for (let i = 0; i < m.programs; i++) {
        const d = programFromDump(m.data, i);
        items.push({ key: `p${i}`, label: `Program ${i + 1}`, name: configName(d), object: 'effect', data: d, msgs: [] });
      }
      if (m.complete) items.push({ key: 'all', label: 'Memory (programs and MIDI settings)', name: '', object: 'system', data: m.data, msgs: [Uint8Array.from(raw)] });
    } else if (m?.kind !== 'request') items.push({ key: `x${items.length}`, label: describe(raw) || 'Other message', name: '', object: null, msgs: [raw] });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: the blocks the configuration's pages show become effects.reverb ("rd" decay, "rL" level), effects.delay
// ("d" time, "F" feedback, "dL" level), effects.chorus / effects.modulation ("SP" speed, "DE" depth; flange when the
// pages have "FL"), effects.eq (the EQ configurations), each value as a fraction of its page's range; the exact bytes in
// extra (family 'digitech-dsp128plus'). fromCommon: the same family loads the bytes; anything else picks the
// configuration with the blocks the source uses, starts from its start program (as the panel switch does) and sets what
// maps.
const FAMILY = 'digitech-dsp128plus';
const labelsOf = (c) => (CONFIGS[c]?.params || []).map((x) => x.label);
export function blocks(c) {
  const l = labelsOf(c);
  const has = (...xs) => xs.some((x) => l.includes(x));
  return { reverb: has('rd', 'rL', 'Sd', 'St'), delay: has('d', 'dL'), chorus: has('CL', 'Cd'), flange: has('FL', 'Fd', 'FF'), eq: has('1F', '1L') };
}
function frac(d, label) {
  const pg = findPage(d[0], label);
  return pg ? Math.max(0, Math.min(1, d[pg.p] / Math.max(1, pg.max))) : undefined;
}
function setFrac(d, label, f, r, what) {
  const pg = findPage(d[0], label);
  if (!pg || f === undefined || f === null || Number.isNaN(f)) return;
  d[pg.p] = Math.round(Math.max(0, Math.min(1, f)) * pg.max);
  r.approximated.push(what || label);
}
function toCommon(d) {
  const b = blocks(d[0]);
  const effects = {};
  const first = (...labels) => labels.map((l) => frac(d, l)).find((x) => x !== undefined);
  if (b.reverb) effects.reverb = { type: configName(d), time: first('rd', 'Sd', 'St') ?? 0.5, level: first('rL', 'SL') ?? 1 };
  if (b.delay) effects.delay = { type: configName(d), time: first('d') ?? 0.5, feedback: first('F') ?? 0, level: first('dL') ?? 1 };
  if (b.chorus || b.flange) {
    effects.modulation = { type: b.chorus ? 'CHORUS' : 'FLANGER', rate: frac(d, 'SP') ?? 0.5, depth: frac(d, 'DE') ?? 0.5, level: first('CL', 'FL') ?? 1 };
    if (b.chorus) effects.chorus = { ...effects.modulation };
  }
  if (b.eq) effects.eq = { type: configName(d), level: 1 };
  return { model: 1, kind: 'effect', name: configName(d), effects, extra: { family: FAMILY, configuration: configName(d), labels: labelsOf(d[0]), data: Array.from(d.slice(0, PROG)), match: hashBytes(d.slice(0, PROG)) } };
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === PROG) {
    const d = Uint8Array.from(x.data, (v) => v & 0xff);
    r.mapped.push(`Program (exact, ${configName(d)})`);
    return { data: d, report: tidy(r) };
  }
  const fx = c?.effects || {};
  const on = (e) => e && (e.level ?? 1) > 0;
  const want = {
    reverb: on(fx.reverb), delay: on(fx.delay), chorus: on(fx.chorus) || /CHORUS/i.test(String(fx.modulation?.type || '')),
    flange: /FLANG/i.test(String(fx.modulation?.type || '')),
  };
  if (!want.reverb && !want.delay && !want.chorus && !want.flange) {
    r.dropped.push('No effect in the source sound: the program keeps its configuration and values');
    return { data: Uint8Array.from(base || factory(0)), report: tidy(r) };
  }
  let best = 1;
  let bestScore = -1e9;
  for (const cf of CONFIGS) {
    if (!cf.params.length) continue;
    const b = blocks(cf.v);
    let s = 0;
    for (const k of Object.keys(want)) s += want[k] ? (b[k] ? 10 : -20) : (b[k] ? -1 : 0);
    if (b.eq) s -= 1;
    if (s > bestScore) { bestScore = s; best = cf.v; }
  }
  const d = start(best);
  r.approximated.push(`Configuration ${CONFIGS[best].name} (${labelsOf(best).join(' ')}), from its start program`);
  if (fx.reverb) { setFrac(d, 'rd', fx.reverb.time, r, 'Reverb time'); setFrac(d, 'rL', fx.reverb.level, r, 'Reverb level'); }
  if (fx.delay) { setFrac(d, 'd', fx.delay.time, r, 'Delay time'); setFrac(d, 'F', fx.delay.feedback, r, 'Delay feedback'); }
  const mod = fx.chorus || fx.modulation;
  if (mod) { setFrac(d, 'SP', mod.rate, r, 'Modulation speed'); setFrac(d, 'DE', mod.depth, r, 'Modulation depth'); }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'chorus', 'modulation', 'eq'].includes(k)) r.dropped.push(`Effect ${k}`);
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ gallery: the pages of each configuration
const SVG = 'http://www.w3.org/2000/svg';
function drawPages({ value }) {
  const l = labelsOf(value);
  const w = 30;
  const per = 6; // boxes per row
  const rows = Math.max(1, Math.ceil(l.length / per));
  const W = per * (w + 4) + 4;
  const H = rows * 24 + 6;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', `max-width:${W * 1.3}px`);
  const el = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  if (!l.length) el('text', { x: W / 2, y: 20, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor' }, 'no pages');
  l.forEach((s, i) => {
    const x = 4 + (i % per) * (w + 4);
    const y = 5 + Math.floor(i / per) * 24;
    el('rect', { x, y, width: w, height: 20, rx: 2, fill: 'none', stroke: 'currentColor' });
    el('text', { x: x + w / 2, y: y + 14, 'text-anchor': 'middle', 'font-size': 11, 'font-family': 'monospace', fill: 'currentColor' }, s);
  });
  return svg;
}

// ------------------------------------------------------------------ definition
const chOf = (ctx) => (ctx?.channel ?? 0) & 15;
const isAll = (r) => parse(r)?.kind === 'all';
/** Read the memory (00 request, 41h answer: 3182 bytes, about a second at MIDI speed). */
async function fetchAll(api) {
  const reply = await api.g.client.request(Uint8Array.from(requestAll(chOf(api.ctx))), { match: (_m, r) => isAll(r) && parse(r).complete, timeout: 8000 });
  const d = parse(reply.raw ?? reply).data;
  unit.dump = Uint8Array.from(d);
  return d;
}
const sendParam = (_p, _v, d, ctx) => writeAndLoad(d, unit.target, chOf(ctx));
const def = {
  coverage: 'Edits the DSP-128 Plus\'s programs (all 15 configurations with every page and the value texts its display shows), its 128 user programs and its MIDI pages (channel, the controller of each of the 44 links), and shows the 128 factory programs and each configuration\'s start program. Reads and writes the unit\'s whole memory and loads programs with a program change. Not checked on hardware.',
  sysex: { manufacturer: [0x00, 0x00, 0x10], model: MODEL },
  minGap: 20,
  describe,
  recognise: (raw) => isDsp128(raw),
  isOwn: isDsp128,
  isRequest,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: PROG,
      init: () => factory(0),
      fetch: async (api) => programFromDump(await fetchAll(api), unit.target),
      receive: (raw) => { const m = parse(raw); return m?.kind === 'all' && unit.target < m.programs ? programFromDump(m.data, unit.target) : null; },
      params: programParams,
      groupInfo: { 'Bytes (exact)': { table: true, note: 'The 11 parameter bytes as typed numbers (the pages above show the same bytes with the unit\'s texts).' } },
      sendParam,
      name: configName,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 4,
      target: {
        label: 'Program', title: 'The user program edits are written into, then loaded with a program change',
        options: () => Array.from({ length: COUNT }, (_, i) => [i, `${programText(i)}${unit.dump ? ` (${configName(programFromDump(unit.dump, i))})` : ''}`]),
        value: () => unit.target, set: (v) => { unit.target = Number(v); },
      },
      note: 'The unit cannot take a single program over MIDI: each change rewrites programs 1 to n, ending with the chosen program n, then loads it with a program change. For a program after 1 the ones before it are sent as last read, so press Get (or Read names) first: until then changes to programs 2-128 are not sent.',
      toSyx: (data, ctx) => writeMessage(data, unit.target, chOf(ctx)) || [],
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.kind === 'all' && unit.target < m.programs) return programFromDump(m.data, unit.target); } return null; },
      sendAll: { label: 'Write and load', build: (data, ctx) => writeAndLoad(data, unit.target, chOf(ctx)) },
      galleries: [{
        key: 'configurations', page: 'Configurations', icon: '▦', param: 'config',
        note: 'The pages of each configuration, as the codes its display shows. Choosing one switches the program to it as the panel does: the configuration\'s start program gives every value.',
        label: (v) => `${CONFIGS[v].name}`,
        draw: drawPages,
      }],
      slots: {
        label: 'Programs', banks: [[0, 'User P  1 - P128'], [1, 'Factory (first power-up)']],
        count: () => COUNT,
        slotLabel: (bank, i) => (bank ? `F${i + 1}` : programText(i)),
        note: (bank) => (bank ? 'The factory programs built into the unit, which the first power-up writes into the user programs (its restore key also puts one back into the program shown): Edit loads one from the editor\'s own copy.'
          : 'Edit and Read names read the whole memory; Store rewrites programs 1 to n (the ones before n as read); Play sends a program change.'),
        names: (bank) => (bank === 1 ? FACTORY.map((h) => configName(hex(h))) : null),
        writable: (bank) => bank === 0 && !!unit.dump,
        name: configName,
        recall: (bank, i, ctx) => { if (bank) return []; unit.target = i; return [programChange(i, chOf(ctx))]; },
        fetch: async (api, bank, i) => { if (bank === 1) return factory(i); unit.target = i; return programFromDump(unit.dump || await fetchAll(api), i); },
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { FACTORY.forEach((h, i) => onName(i, configName(hex(h)))); return; }
          const d = await fetchAll(api);
          for (let i = 0; i < COUNT; i++) onName(i, configName(programFromDump(d, i)));
        },
        store: (_bank, i, ctx, data) => { const m = writeMessage(data, i, chOf(ctx)); if (!m) return []; programIntoDump(unit.dump, i, data); return [m]; },
      },
    },
    {
      key: 'system', page: 'Settings', icon: '⚙', label: 'MIDI settings', size: DUMP_SIZE, notLive: true,
      init: () => Uint8Array.from(FIRST),
      fetch: async (api) => fetchAll(api),
      receive: (raw) => { const m = parse(raw); if (m?.kind !== 'all' || !m.complete) return null; unit.dump = Uint8Array.from(m.data); return m.data; },
      params: settingsParams,
      sections: [{ key: 'midi', label: 'MIDI channel' }, { key: 'links', label: 'Controllers' }],
      cols: 4,
      note: 'The unit\'s whole memory: the 128 programs (not shown here), then the MIDI channel and the controller of each link. The unit has no message for the settings alone: Send writes the whole memory back, programs included, as they were read.',
      actions: [
        { label: `Send to the ${NAME}`, title: 'Send the whole memory: the 128 programs as read and these settings', run: async (api) => {
          const ok = await api.confirm('Send all memory', 'This replaces every user program and the MIDI settings with the copy read last (Get first).', 'Send');
          if (ok) api.send([allMessage(api.data, chOf(api.ctx))]);
        } },
        { label: 'First power-up contents', title: 'The memory as the unit sets it after a battery failure (factory programs, channel 1, no controllers)', run: (api) => api.setData(Uint8Array.from(FIRST)) },
      ],
      toSyx: (data, ctx) => allMessage(data, chOf(ctx)),
      fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.kind === 'all' && m.complete) return m.data; } return null; },
    },
  ],
  midiNotes: [
    'SysEx F0 00 00 10 <channel - 1> 03 <command> ... F7, taken on the unit MIDI channel (every channel with "CH o", none with "CH n"). Data bytes travel as pairs: bit 7, then bits 6-0.',
    'Commands: 00 request (the unit answers 41h), 41h memory (1587 bytes: 128 programs of 12 bytes, the MIDI channel, the controllers of links 1-50). The receiver stores each byte as it arrives, so a 41h message cut after program n writes programs 1 to n and leaves the rest; at F7 the unit reloads the program it has loaded.',
    '40h writes a DSP register directly: the editor does not send it.',
    'Program change n loads user program n + 1 (no program map). Control change: each link (MIDI pages 1-44) can have a controller (1-99) or channel pressure ("CP"); the pages of the current program with that link take value x 2 x (range + 1) / 256. The controllers of links 22 and 23 hold the delay and switch the bypass (above 64 on, 64 and below off).',
  ],
};

export const _test = { simulate, toCommon, fromCommon, describe, libraryItems, unit, blocks, drawPages };
export default def;
