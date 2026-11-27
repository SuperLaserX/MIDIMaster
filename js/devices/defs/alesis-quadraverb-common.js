// Alesis Quadraverb family (Quadraverb, Quadraverb Plus = the v2 software, Quadraverb GT): one editor
// built from each model's generated tables (tools/alesis/quadraverb_fw.py). The MIDI implementation is
// described in alesis-quadraverb.js and docs/devices/alesis-quadraverb.md.

import { readText } from '../../core/model/memmap.js';
import { quadraverbTranslator } from './alesis-quadraverb-translate.js';

export const SIZE = 128;
export const PACKED = 147;
export const EDIT = 100;
export const ALL = 101;
export const USER_COUNT = 100;
const NAME_AT = 0x6a;
const NAME_LEN = 14;
const CFG_AT = 0x44;
export const FUNCS = ['Program', 'Reverb', 'Delay', 'Pitch', 'EQ', 'MIDI', 'Store', 'Configuration', 'Mix', 'Modulation', 'Name'];

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad2 = (n) => String(n).padStart(2, '0');
const op = (raw) => raw[5];

/** 128 bytes -> 147 MIDI bytes: one MSB-first bit stream in 7-bit groups (transmitter A838). */
export function pack(d) {
  const out = [];
  let acc = 0; let n = 0;
  for (let i = 0; i < SIZE; i++) {
    acc = (acc << 8) | (d[i] & 0xff); n += 8;
    while (n >= 7) { n -= 7; out.push((acc >> n) & 0x7f); }
    acc &= (1 << n) - 1;
  }
  if (n) out.push((acc << (7 - n)) & 0x7f);
  return out;
}
/** 147 MIDI bytes at raw[at] -> 128 bytes (receiver A59B). */
export function unpack(raw, at) {
  const d = new Uint8Array(SIZE);
  let acc = 0; let n = 0; let k = 0;
  for (let i = 0; i < PACKED && k < SIZE; i++) {
    acc = (acc << 7) | ((raw[at + i] ?? 0) & 0x7f); n += 7;
    if (n >= 8) { n -= 8; d[k++] = (acc >> n) & 0xff; acc &= (1 << n) - 1; }
  }
  return d;
}

/** The three value bytes of opcode 01 (A681: low byte first, as one bit stream). */
export function valueBytes(v) {
  const lo = v & 0xff; const hi = (v >> 8) & 0xff;
  return [lo >> 1, ((lo & 1) << 6) | (hi >> 2), (hi & 3) << 5];
}
export function valueOf(b1, b2, b3) {
  return (((((b2 & 0x3f) << 2) | ((b3 >> 5) & 3)) & 0xff) << 8) | (((b1 << 1) | ((b2 >> 6) & 1)) & 0xff);
}

/** A Quadraverb-family definition from its generated tables (FW) and model specifics. */
export function makeQuadraverb(FW, opt) {
  const { FIRMWARE, SELECTOR, CONFIGS, DESCS, FORMATS, PAGES, TARGETS, PRESETS } = FW;
  const FN = opt.funcs || FUNCS;
  const HDR = [0xf0, 0x00, 0x00, 0x0e, opt.model];

  // ------------------------------------------------------------------ storage (GT: packed work bytes)
  // The GT edits its preamp and a few other values in work bytes 83A8h-83C9h and keeps them in program
  // bits (PACK: work byte -> [program byte, shift, bits]); the bytes that also hold such a field keep their
  // own page value in the low bits.
  const PACK = FW.PACK || {};
  const GLOBAL = FW.GLOBAL || null;
  const LOW = {};
  for (const [, [at, sh]] of Object.entries(PACK)) if (sh) LOW[at] = Math.min(LOW[at] ?? 8, sh);
  /** Where program data keeps the value page byte `off` edits: {offset, size} or a bit field {offset, shift, bits}. */
  function store(off, size = 1) {
    const p = PACK[off];
    if (p) return { offset: p[0], shift: p[1], bits: p[2] };
    if (LOW[off] !== undefined) return { offset: off, shift: 0, bits: LOW[off] };
    return { offset: off, size };
  }
  const getv = (d, st) => (st.bits ? (d[st.offset] >> st.shift) & ((1 << st.bits) - 1) : st.size === 2 ? (d[st.offset] << 8) | d[st.offset + 1] : d[st.offset]);
  function setv(d, st, v) {
    if (st.bits) { const m = ((1 << st.bits) - 1) << st.shift; d[st.offset] = (d[st.offset] & ~m) | ((v << st.shift) & m); }
    else if (st.size === 2) { d[st.offset] = (v >> 8) & 0xff; d[st.offset + 1] = v & 0xff; }
    else d[st.offset] = v & 0xff;
  }
  const covers = (st) => (st.bits ? [st.offset] : st.size === 2 ? [st.offset, st.offset + 1] : [st.offset]);
  const selOf = (d, f) => (SELECTOR[f] === undefined ? 0 : getv(d, store(SELECTOR[f])));
  /** GT: the writes a page's routine makes when it is set (EQ MODE defaults, EQ PRESET tables). */
  function applyEffects(d, off, v) {
    const per = FW.EFFECTS?.[off]?.[cfgOf(d)];
    const ds = DESCS.find((x) => x.off === off);
    const w = per?.[v - (ds?.min || 0)] || [];
    for (const [a, val] of w) setv(d, store(a), val);
    return w.length;
  }
  const isQuadraverb = (raw) => raw?.[0] === 0xf0 && HDR.every((b, i) => raw[i] === b);
  const msg = {
    request: (n) => [...HDR, 0x03, n & 0x7f, 0xf7],
    program: (n, d) => [...HDR, 0x02, n & 0x7f, ...pack(d), 0xf7],
    edit: (d) => msg.program(EDIT, d),
    all: (progs) => [...HDR, 0x02, ALL, ...progs.flatMap((d) => pack(d)), 0xf7],
    param: (func, page, v) => [...HDR, 0x01, func & 0x7f, page & 0x7f, ...valueBytes(v), 0xf7],
  };

  // ------------------------------------------------------------------ pages
  const cfgOf = (d) => Math.min(CONFIGS.length - 1, d[CFG_AT] || 0);
  /** The page list the Quadraverb shows for front-panel function f of program d (null: not used). */
  function pageList(d, f) {
    const lists = PAGES[cfgOf(d)][f];
    return lists[Math.min(lists.length - 1, selOf(d, f))];
  }
  const PROGRAM_FUNCS = opt.programFuncs || [7, 4, 3, 2, 1, 8, 9];
  /** Where the unit edits byte `off` (size 1/2) of program d: {func, page, desc} or null. */
  function locate(d, off, size) {
    for (const f of PROGRAM_FUNCS) {
      const list = pageList(d, f);
      const page = list ? list.findIndex((id) => id >= 0 && DESCS[id].off === off && DESCS[id].size === size) : -1;
      if (page >= 0) return { func: f, page, desc: DESCS[list[page]] };
    }
    return null;
  }
  function formatValue(desc, v) {
    const f = FORMATS[desc.fmt];
    if (f.int) return `${String(v).padStart(f.int.pad, '0')}${f.int.suffix}`;
    return f.texts[v - f.min] ?? String(v);
  }
  const { TARGET_FUNCS, TAP_MAP, MIDI_FUNC } = FW;
  const NAME = opt.name;
  /** MOD TARGET value v of program d: group v>>4 (reverb, delay, pitch, EQ, mix), item v&15 of that
   *  group's list in the current configuration and variant (display 14BC, lists at 1681). */
  function targetName(d, v) {
    const f = TARGET_FUNCS[v >> 4];
    if (f === undefined) return null;
    const per = TARGETS[cfgOf(d)][v >> 4];
    const list = per[Math.min(per.length - 1, selOf(d, f))];
    return list[v & 15] ?? null;
  }

  const GROUP = { 7: 'Configuration', 4: 'EQ', 3: 'Pitch', 2: 'Delay', 1: 'Reverb', 8: 'Mix', 9: 'Modulation', 10: 'Preamp' };
  /** The editor card of a page: its front-panel function, except the graphic EQ bands and the Lezlie
   *  pages (HIGH ROTOR LEVEL is on the EQ button in LEZLIE→DL→REVERB), which get their own. */
  const CARDS = [[/^GRAPH /, 'Graphic EQ'], [/LEZLIE|ROTOR/, 'Lezlie'], [/^SAMPLE|SAMPLING|MIDI TRIGGER/, 'Sampling'],
    [/RESONATOR/, 'Resonator'], [/SPECTRUM|RING MOD|DEL\/REVERB INPUT/, 'Ring modulator'], [/^TAP |MASTER FEEDBACK/, 'Multi-tap delay']];
  const groupOf = (ds, f) => (f === 8 ? GROUP[f] : CARDS.find(([re]) => re.test(ds.label))?.[1] || GROUP[f]);

  /** Program parameters: one per (byte, size, card) the pages edit, in front-panel order. */
  function buildSlots() {
    const slots = new Map();
    for (const f of PROGRAM_FUNCS) {
      for (let c = 0; c < PAGES.length; c++) {
        for (const list of PAGES[c][f]) {
          for (const id of list || []) {
            if (id < 0 || (DESCS[id].off >= SIZE && !PACK[DESCS[id].off])) continue;
            const ds = DESCS[id];
            const group = groupOf(ds, f);
            const k = `${ds.off}:${ds.size}:${group}`;
            if (!slots.has(k)) slots.set(k, { off: ds.off, size: ds.size, func: f, group, descs: [] });
            const s = slots.get(k);
            if (!s.descs.includes(id)) s.descs.push(id);
          }
        }
      }
    }
    return [...slots.values()].sort((a, b) => a.off - b.off);
  }
  const SLOTS = buildSlots();
  /** Program bytes no page edits (in any configuration or type), outside the name and the tap storage. */
  const SPARE = Array.from({ length: SIZE }, (_, i) => i).filter((i) => i < NAME_AT || i >= NAME_AT + NAME_LEN).filter((i) => !(TAP_MAP || []).includes(i))
    .filter((i) => !SLOTS.some((sl) => covers(store(sl.off, sl.size)).includes(i)));
  const LISTISH = (desc) => {
    const f = FORMATS[desc.fmt];
    return !f.int && (f.texts.length <= 12 || f.texts.some((t) => /[A-Z]{2}/.test(t.replace(/dB|Hz|OCTAVES|millisec\w*|%/g, ''))));
  };

  /** Values outside the ranges of the pages the current configuration shows brought into range. */
  function fitProgram(d) {
    let changed = 0;
    for (const s of SLOTS) {
      const at = locate(d, s.off, s.size);
      if (!at) continue;
      const st = store(s.off, s.size);
      const v = getv(d, st);
      const c = Math.max(at.desc.min, Math.min(at.desc.max, v));
      if (c !== v) { setv(d, st, c); changed++; }
    }
    for (let i = 0; i < NAME_LEN; i++) if (d[NAME_AT + i] < 32 || d[NAME_AT + i] > 127) { d[NAME_AT + i] = 32; changed++; }
    return changed;
  }
  // dumps go out as they are: the receiver (A54C) stores them without checks, and factory programs hold
  // values the pages would not reach (Plus program 84: LOW MID EQ FREQ 600, page maximum 500)
  const fitted = (d) => Uint8Array.from(d);

  const nameOf = (d) => readText(d, NAME_AT, NAME_LEN).replace(/\x7f/g, '←').trimEnd();
  function setName(d, name) {
    for (let i = 0; i < NAME_LEN; i++) d[NAME_AT + i] = Math.max(32, Math.min(126, String(name).charCodeAt(i) || 32));
  }
  const presetData = (i) => hex(PRESETS[i]);

  const sendWhole = (_v, _ctx, data) => msg.edit(fitted(data));
  const SELECTORS = new Set(Object.values(SELECTOR));
  function slotParam(s) {
    const first = DESCS[s.descs[0]];
    const min = Math.min(...s.descs.map((id) => DESCS[id].min));
    const max = Math.max(...s.descs.map((id) => DESCS[id].max));
    const key = `b${s.off.toString(16).padStart(2, '0')}${s.size === 2 ? 'w' : ''}${{ 'Graphic EQ': 'g', Lezlie: 'l' }[s.group] || ''}`;
    const here = (d) => { const at = locate(d, s.off, s.size); return at && groupOf(at.desc, at.func) === s.group ? at : null; };
    if (s.off === CFG_AT) {
      return {
        key, group: s.group, label: first.label, offset: s.off, options: CONFIGS.map((n, v) => [v, n]), relayout: true, send: sendWhole,
        help: 'The effect configuration; changing it sends the whole program to the unit (the other pages follow it)',
        after: (d) => (fitProgram(d) ? 'Values outside the new configuration\'s page ranges were brought into range.' : null),
      };
    }
    const st = store(s.off, s.size);
    const effects = !!FW.EFFECTS?.[s.off];
    return {
      key, group: s.group, label: first.label, ...st, min, max,
      relayout: SELECTORS.has(s.off) || effects || undefined,
      send: (v, _ctx, data) => {
        // EQ MODE / EQ PRESET: the unit's own routine changes the EQ; the editor makes the same writes and
        // sends the whole program so both hold the same values (USER restores the EQ the unit copied at recall)
        if (effects) { applyEffects(data, s.off, v); return msg.edit(fitted(data)); }
        const at = here(data);
        return at ? msg.param(at.func, at.page, Math.max(at.desc.min, Math.min(at.desc.max, v))) : msg.edit(fitted(data));
      },
      dynamic: (d) => {
        const at = here(d);
        if (!at) return { hidden: true };
        const ds = at.desc;
        const where = `${FN[at.func]} page ${at.page + 1}`;
        if (FORMATS[ds.fmt].targets) {
          const options = [];
          for (let v = ds.min; v <= ds.max; v++) { const t = targetName(d, v); if (t) options.push([v, t]); }
          return { label: ds.label, options, help: `${ds.label}: the page the modulation drives, from the current configuration's lists (${where})` };
        }
        const help = `${ds.label}: ${formatValue(ds, ds.min)} to ${formatValue(ds, ds.max)} (${where})${GLOBAL && s.off === GLOBAL.alt[2] ? '. While CAB SIMULATOR is GLOBAL (MIDI page tab) the unit uses, and this page edits, the global value instead' : ''}${effects ? '. The unit rewrites the EQ for this choice; the editor makes the same changes and sends the whole program' : ''}`;
        if (LISTISH(ds)) {
          const options = [];
          for (let v = ds.min; v <= ds.max; v++) options.push([v, formatValue(ds, v)]);
          return { label: ds.label, options, help };
        }
        return { label: ds.label, min: ds.min, max: ds.max, format: (v) => formatValue(ds, v), help };
      },
    };
  }

  /** Multi-tap delay taps (v2): pages 80h-84h edit tap TAP NUMBER (69h); tap n is kept in TAP_MAP[5n..5n+4]. */
  function tapParams() {
    if (!TAP_MAP) return [];
    const fields = [[0, 2], [2, 1], [3, 1], [4, 1]]; // DELAY TIME (2 bytes), VOLUME, PANNING, FEEDBACK
    const out = [];
    for (let n = 0; n < 8; n++) {
      for (const [k, size] of fields) {
        const at = (d) => { const list = pageList(d, 2); const page = list ? list.findIndex((id) => id >= 0 && DESCS[id].off === 0x80 + k) : -1; return page >= 0 ? { page, desc: DESCS[list[page]], tapPage: list.findIndex((id) => id >= 0 && DESCS[id].off === 0x69) } : null; };
        const hi = TAP_MAP[5 * n + k]; const lo = TAP_MAP[5 * n + k + 1];
        const any = DESCS.find((ds) => ds.off === 0x80 + k);
        out.push({
          key: `tap${n + 1}_${k}`, group: 'Multi-tap delay', label: any.label.replace(/\bx\b/, String(n + 1)), offset: hi, min: any.min, max: any.max,
          get: size === 2 ? (d) => (d[hi] << 8) | d[lo] : undefined,
          set: size === 2 ? (d, v) => { d[hi] = v >> 8; d[lo] = v & 0xff; } : undefined,
          send: (v, _ctx, data) => { const a = at(data); return a ? [msg.param(2, a.tapPage, n), msg.param(2, a.page, v)] : msg.edit(fitted(data)); },
          after: (d) => { d[0x69] = n; return null; },
          dynamic: (d) => {
            const a = at(d);
            if (!a) return { hidden: true };
            const ds = a.desc;
            const label = ds.label.replace(/\bx\b/, String(n + 1));
            const help = `${label}: ${formatValue(ds, ds.min)} to ${formatValue(ds, ds.max)} (on the unit: set TAP NUMBER to ${n + 1})`;
            if (LISTISH(ds)) { const options = []; for (let v = ds.min; v <= ds.max; v++) options.push([v, formatValue(ds, v)]); return { label, options, help }; }
            return { label, min: ds.min, max: ds.max, format: (v) => formatValue(ds, v), help };
          },
        });
      }
    }
    return out;
  }

  /** GT 5-resonator EQ (5BAND EQ→PCH→DLY, EQ MODE 5 RESONATOR/3 EQ): pages FDh-FFh edit resonator
   *  RESONATOR NUMB (INDEX_BYTE) at the bytes listed in INDEXED. */
  function indexedParams() {
    if (!FW.INDEXED) return [];
    const out = [];
    for (const [k, list] of Object.entries(FW.INDEXED)) {
      const off = Number(k);
      const any = DESCS.find((ds) => ds.off === off);
      list.forEach((byte, n) => {
        const st = store(byte);
        const at = (d) => {
          const l = pageList(d, 4);
          const page = l ? l.findIndex((id) => id >= 0 && DESCS[id].off === off) : -1;
          return page >= 0 ? { page, desc: DESCS[l[page]], numPage: l.findIndex((id) => id >= 0 && DESCS[id].off === FW.INDEX_BYTE) } : null;
        };
        const label = any.label.replace(/\bx\b/, String(n + 1));
        out.push({
          key: `res${n + 1}_${off.toString(16)}`, group: 'Resonator', label, ...st, min: any.min, max: any.max,
          send: (v, _ctx, data) => { const a = at(data); return a ? [msg.param(4, a.numPage, n), msg.param(4, a.page, v)] : msg.edit(fitted(data)); },
          after: (d) => { d[FW.INDEX_BYTE] = n; return null; },
          dynamic: (d) => {
            const a = at(d);
            if (!a) return { hidden: true };
            const ds = a.desc;
            const help = `${label}: ${formatValue(ds, ds.min)} to ${formatValue(ds, ds.max)} (on the unit: set RESONATOR NUMB to ${n + 1})`;
            return { label, min: ds.min, max: ds.max, format: (v) => formatValue(ds, v), help };
          },
        });
      });
    }
    return out;
  }

  const programParams = [
    ...SLOTS.map(slotParam),
    ...indexedParams(),
    ...Array.from({ length: NAME_LEN }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: NAME_AT + i, min: 32, max: 127, kind: 'char', hidden: true })),
    ...SPARE.map((off) => ({
      key: `spare${off.toString(16)}`, group: 'Spare bytes', label: `Byte ${off.toString(16).toUpperCase().padStart(2, '0')}h`, offset: off, min: 0, max: 255,
      input: 'number', send: sendWhole, help: `Not on any page of the ${NAME}; 0 in every factory program (sent with the whole program)`,
    })),
    ...tapParams(),
  ];
  const ORDER = ['Configuration', ...(GLOBAL ? ['Preamp'] : []), 'EQ', 'Graphic EQ', 'Lezlie', 'Ring modulator', 'Resonator', 'Pitch', 'Delay', 'Multi-tap delay', 'Sampling', 'Reverb', 'Mix', 'Modulation', 'Spare bytes'];

  // ------------------------------------------------------------------ MIDI settings (send only)
  // Function 5 pages write 8500-8509 and the program change table (850A + n); no message reads them.
  const midiDesc = (off) => DESCS.find((ds) => ds.func === MIDI_FUNC && ds.off === off);
  // the settings bytes 85xx: MIDI page 00-09, program table 0A-89; GT: CAB SIMULATOR PROGRAM / GLOBAL (90) and
  // the global cabinet (91)
  const MIDI_SIZE = GLOBAL ? GLOBAL.alt[1] + 1 : 10 + 128;
  const TABLE_AT = 10;
  const selDesc = GLOBAL && DESCS.find((ds) => ds.func === GLOBAL.func && ds.off === GLOBAL.select[1]);
  function initMidi() {
    const s = new Uint8Array(MIDI_SIZE);
    for (const ds of DESCS) if (ds.func === MIDI_FUNC && ds.off < 10) s[ds.off] = ds.init;
    for (let n = 0; n < 128; n++) s[TABLE_AT + n] = n % USER_COUNT;
    if (selDesc) s[GLOBAL.select[1]] = selDesc.init;
    return s;
  }
  const midiOptions = (ds) => { const o = []; for (let v = ds.min; v <= ds.max; v++) o.push([v, formatValue(ds, v)]); return o; };
  const midiParam = (off, label, help) => {
    const ds = midiDesc(off);
    const page = PAGES[0][MIDI_FUNC][0].indexOf(DESCS.indexOf(ds));
    return { key: `m${off}`, group: 'MIDI', label, offset: off, options: midiOptions(ds), help, send: (v) => msg.param(5, page, v) };
  };
  const tablePage = (off) => PAGES[0][MIDI_FUNC][0].indexOf(DESCS.indexOf(midiDesc(off)));
  const midiParams = [
    midiParam(0, 'MIDI channel', 'MIDI CHANNEL page: the channel for program changes and modulation sources (OMNI = all)'),
    midiParam(1, 'Program change', 'MIDI PROGRAM CHANGE: OFF, ON (program n recalls program n) or TABLE (looked up below)'),
    midiParam(4, 'MIDI thru', 'MIDI THRU: echo MIDI In to MIDI Out'),
    midiParam(5, 'SysEx enable', `SYSEX ENABLE: the ${NAME} ignores and sends no SysEx while it is OFF; sending OFF cuts this editor off until it is set ON on the panel`),
    midiParam(8, 'Footswitch range low', 'FOOTSWITCH RANGE xx THROUGH yy: the footswitch steps through programs xx..yy'),
    midiParam(9, 'Footswitch range high', 'FOOTSWITCH RANGE xx THROUGH yy (second value)'),
    ...Array.from({ length: 128 }, (_, n) => ({
      key: `t${n}`, group: 'Program change table', label: `MIDI ${String(n).padStart(3, '0')}`, offset: TABLE_AT + n, min: 0, max: USER_COUNT - 1,
      options: Array.from({ length: USER_COUNT }, (_, p) => [p, `Program ${pad2(p)}`]),
      help: `PROGRAM TABLE: the program recalled by program change ${n} when MIDI PROGRAM CHANGE is TABLE`,
      send: (v) => [msg.param(5, tablePage(2), n), msg.param(5, tablePage(3), v)],
    })),
    ...(GLOBAL ? [
      { key: 'cabsrc', group: 'Preamp', label: 'Cab simulator', offset: GLOBAL.select[1], options: midiOptions(selDesc),
        help: `CAB SIMULATOR PROGRAM / GLOBAL (Preamp page ${GLOBAL.select[0] + 1}): PROGRAM uses each program's CAB SIMULATOR, GLOBAL the one below for every program`,
        send: (v, _ctx, data) => (v ? [msg.param(GLOBAL.func, GLOBAL.select[0], 1), msg.param(GLOBAL.func, GLOBAL.alt[0], data[GLOBAL.alt[1]])] : msg.param(GLOBAL.func, GLOBAL.select[0], 0)) },
      { key: 'cabglobal', group: 'Preamp', label: 'Global cab simulator', offset: GLOBAL.alt[1],
        options: FORMATS[GLOBAL.alt[3]].texts.map((t, v) => [v, t.replace(/\s+GLOBAL$/, '')]),
        help: `CAB SIMULATOR while the source is GLOBAL (the Preamp page shows it as "${FORMATS[GLOBAL.alt[3]].texts[1]}"); sent only then, since the same page edits the program's value while the source is PROGRAM`,
        send: (v, _ctx, data) => (data[GLOBAL.select[1]] ? msg.param(GLOBAL.func, GLOBAL.alt[0], v) : null) },
    ] : []),
  ];

  // ------------------------------------------------------------------ simulator (demo mode, tests)
  function simulate() {
    const st = {
      edit: presetData(0),
      user: Array.from({ length: USER_COUNT }, (_, n) => presetData(n < PRESETS.length ? n : 0)),
      midi: initMidi(), sysex: true, program: 0,
    };
    const dump = (n) => {
      if (n < USER_COUNT) return [msg.program(n, st.user[n])];
      if (n === EDIT) return [msg.edit(st.edit)];
      return [msg.all(st.user)];
    };
    return {
      state: st,
      handle(d) {
        if ((d[0] & 0xf0) === 0xc0) {
          const ch = st.midi[0]; // 0-15 = channels 01-16, 16 = OMNI
          if (ch !== 16 && (d[0] & 15) !== ch) return [];
          if (st.midi[1] === 0) return [];
          const n = st.midi[1] === 2 ? st.midi[TABLE_AT + d[1]] : d[1];
          if (n < USER_COUNT) { st.program = n; st.edit = Uint8Array.from(st.user[n]); }
          return [];
        }
        if (!isQuadraverb(d) || !st.sysex) return isQuadraverb(d) ? [] : null;
        switch (op(d)) {
          case 0x01: {
            const [f, page] = [d[6], d[7]];
            const v = valueOf(d[8], d[9], d[10]);
            const list = f === MIDI_FUNC ? PAGES[0][MIDI_FUNC][0] : pageList(st.edit, f);
            if (!list || page >= list.length) return [];
            if (GLOBAL && f === GLOBAL.func && (page === GLOBAL.select[0] || (page === GLOBAL.alt[0] && st.midi[GLOBAL.select[1]]))) {
              const at = page === GLOBAL.select[0] ? GLOBAL.select[1] : GLOBAL.alt[1]; // 677A: 8590 / 8591
              st.midi[at] = v & 0xff;
              return [];
            }
            if (list[page] < 0) return [];
            const ds = DESCS[list[page]];
            const c = Math.max(ds.min, Math.min(ds.max, ds.size === 2 ? v : v & 0xff));
            if (FW.INDEXED?.[ds.off]) setv(st.edit, store(FW.INDEXED[ds.off][st.edit[FW.INDEX_BYTE] % 5]), c);
            else if (PACK[ds.off] || LOW[ds.off] !== undefined) setv(st.edit, store(ds.off), c);
            else if (f === MIDI_FUNC) {
              st.midi[ds.off] = c;
              if (ds.off === 2) st.midi[3] = st.midi[TABLE_AT + c];
              if (ds.off === 3) st.midi[TABLE_AT + st.midi[2]] = c;
              if (ds.off === 5) st.sysex = !!c;
            } else if (ds.off >= SIZE && TAP_MAP) { // tap page: field ds.off - 80h of tap TAP NUMBER (69h)
              const i = 5 * (st.edit[0x69] & 7) + ds.off - 0x80;
              if (ds.size === 2) { st.edit[TAP_MAP[i]] = c >> 8; st.edit[TAP_MAP[i + 1]] = c & 0xff; } else st.edit[TAP_MAP[i]] = c;
            } else if (ds.size === 2) { st.edit[ds.off] = c >> 8; st.edit[ds.off + 1] = c & 0xff; } else st.edit[ds.off] = c;
            return [];
          }
          case 0x02: {
            const n = d[6];
            if (n < USER_COUNT) st.user[n] = unpack(d, 7);
            else if (n === EDIT) st.edit = unpack(d, 7);
            else for (let k = 0; k < USER_COUNT; k++) st.user[k] = unpack(d, 7 + k * PACKED);
            return [];
          }
          case 0x03: return dump(d[6]);
          default: return [];
        }
      },
    };
  }

  // ------------------------------------------------------------------ monitor text
  function describe(raw) {
    if (!isQuadraverb(raw)) return null;
    const c = op(raw);
    const which = (n) => (n < USER_COUNT ? `program ${pad2(n)}` : n === EDIT ? 'edit buffer' : 'all programs');
    if (c === 0x03) return `${NAME} request ${which(raw[6])}`;
    if (c === 0x02) return raw[6] > EDIT ? `${NAME} all 100 programs` : `${NAME} ${which(raw[6])} "${nameOf(unpack(raw, 7))}"`;
    if (c === 0x01) {
      const v = valueOf(raw[8], raw[9], raw[10]);
      return `${NAME} ${FN[raw[6]] || `function ${raw[6]}`} page ${raw[7] + 1} = ${v}`;
    }
    if (c === 0x04) return `${NAME} DSP register write`;
    return `${NAME} opcode ${c}`;
  }

  // ------------------------------------------------------------------ library
  function libraryItems(msgs) {
    const items = [];
    for (const m of msgs) {
      if (!isQuadraverb(m) || op(m) !== 0x02) { items.push({ key: `x${items.length}`, label: isQuadraverb(m) ? describe(m) : 'Other message', name: '', object: null, msgs: [m] }); continue; }
      const n = m[6];
      if (n > EDIT) {
        for (let k = 0; k < USER_COUNT && 7 + (k + 1) * PACKED <= m.length - 1; k++) {
          const d = unpack(m, 7 + k * PACKED);
          items.push({ key: `u${k}`, label: `Program ${pad2(k)}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(msg.program(k, d))] });
        }
      } else {
        const d = unpack(m, 7);
        items.push({ key: n === EDIT ? `e${items.length}` : `u${n}`, label: n === EDIT ? 'Program (edit buffer)' : `Program ${pad2(n)}`, name: nameOf(d), object: 'effect', data: d, msgs: [m] });
      }
    }
    return items;
  }
  const programFromSyx = (msgs) => {
    const m = msgs.find((r) => isQuadraverb(r) && op(r) === 0x02);
    return m ? unpack(m, 7) : null;
  };
  async function readProgram(api, n) {
    return api.request(msg.request(n), (r) => isQuadraverb(r) && op(r) === 0x02 && r[6] === n, (r) => unpack(r, 7));
  }
  async function readAll(api) {
    const raw = await api.request(msg.request(ALL), (r) => isQuadraverb(r) && op(r) === 0x02 && r[6] === ALL, (r) => r);
    return Array.from({ length: USER_COUNT }, (_, k) => unpack(raw, 7 + k * PACKED));
  }

  // ------------------------------------------------------------------ definition
  const TR = quadraverbTranslator({ has: opt.has, family: opt.family, model: opt.id, CONFIGS, presetData, presets: PRESETS.length, fitProgram, setName, nameOf, formatValue, locate, SIZE,
    fromFamily: opt.fromFamily, moreEffects: opt.moreEffects && ((d, fx) => opt.moreEffects(d, fx, (off) => getv(d, store(off)))) });
  const BANKS = [[0, 'User'], [1, 'Preset']];
  const PRESET_NAMES = PRESETS.map((h) => nameOf(hex(h)));
  const dev = (ctx) => (ctx?.channel ?? 0) & 0x0f;

  const def = {
    coverage: `Edits the ${NAME}'s programs (all ${CONFIGS.length} configurations, each page with the label and value texts its display shows), shows the ${PRESETS.length} factory programs, and sets the MIDI page. Reads and writes the current program, single programs and all 100 at once, and sends each change as you make it. The MIDI page can be sent but not read back. Not checked on hardware.`,
    sysex: { manufacturer: [0x00, 0x00, 0x0e], model: opt.model },
    minGap: 20,
    describe,
    recognise: isQuadraverb,
    isOwn: isQuadraverb,
    isRequest: (raw) => isQuadraverb(raw) && op(raw) === 0x03,
    // the Quadraverb and the Plus share the header: a program in a configuration one of them lacks is the other's
    prefer: (msgs) => (msgs.filter((m) => isQuadraverb(m) && op(m) === 0x02 && m[6] <= EDIT).every((m) => unpack(m, 7)[CFG_AT] < CONFIGS.length) ? 1 + (opt.preferWeight || 0) : 0),
    simulate,
    libraryItems,
    objects: [
      {
        key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: SIZE, autoLoad: true,
        init: () => presetData(0),
        request: () => msg.request(EDIT),
        match: (raw) => isQuadraverb(raw) && op(raw) === 0x02 && raw[6] === EDIT,
        decode: (raw) => unpack(raw, 7),
        params: programParams,
        name: nameOf,
        setName,
        category: () => 'none',
        patchKinds: ['effect'],
        toCommon: (d) => TR.toCommon(d),
        fromCommon: (c, base) => TR.fromCommon(c, base),
        cols: 4,
        layout: ORDER.map((group) => ({ group })),
        groupInfo: { 'Spare bytes': { table: true, note: 'Values no page of the unit edits; kept as they are.' } },
        note: `Each change is sent at once, as if made on the ${NAME}'s own page; changing the configuration or the name sends the whole program. SYSEX ENABLE must be ON on the MIDI page.`,
        sendAll: { label: 'Send to edit buffer', title: 'Send the whole program to the unit to play; nothing is stored', build: (data) => msg.edit(fitted(data)) },
        toSyx: (data) => msg.edit(fitted(data)),
        fromSyx: programFromSyx,
        actions: [
          { label: 'Rename', run: async (api) => {
            const r = await api.form('Program name', [{ key: 'name', label: 'Name (14 characters)', value: nameOf(api.data), maxlength: NAME_LEN }]);
            if (!r) return;
            const d = Uint8Array.from(api.data);
            setName(d, r.name);
            api.send(msg.edit(fitted(d)));
            api.setData(d);
          } },
          { label: 'Write to program', title: 'Write the program into a memory location (00-99)', run: async (api) => {
            const r = await api.form('Write into program', [{ key: 'n', label: 'Program (0-99)', value: '0', type: 'number', min: 0, max: 99 }]);
            if (!r) return;
            const n = Math.max(0, Math.min(99, Math.round(Number(r.n) || 0)));
            api.send(msg.program(n, fitted(api.data)));
          } },
        ],
        slots: {
          label: 'Programs', banks: BANKS, count: (bank) => (bank === 1 ? PRESETS.length : USER_COUNT),
          slotLabel: (bank, i) => `${bank ? 'Alesis' : 'Prog'} ${pad2(i)}`,
          note: (bank) => (bank ? `The ${PRESETS.length} Alesis programs are built into the ${NAME}; the editor shows them from its own copy, and Play sends one to the unit to play. On the unit, STORE / RECALL ALESIS PROG copies them into memory. `
            : 'Programs 00-99 are read and written one at a time. ') + 'Play on a memory program sends a program change on the editor\'s channel (MIDI PROGRAM CHANGE must be ON).',
          names: (bank) => (bank === 1 ? PRESET_NAMES : null),
          writable: (bank) => bank === 0,
          name: nameOf,
          recall: (bank, i, ctx) => (bank === 1 ? [msg.edit(presetData(i))] : [[0xc0 | dev(ctx), i]]),
          fetch: async (api, bank, i) => (bank === 1 ? presetData(i) : readProgram(api, i)),
          scanBank: async (api, bank, onName) => {
            const progs = bank === 1 ? PRESETS.map(hex) : await readAll(api);
            progs.forEach((d, i) => onName(i, nameOf(d)));
          },
          store: (bank, i, _ctx, data) => msg.program(i, fitted(data)),
        },
      },
      {
        key: 'global', page: 'MIDI', icon: '⚙', label: 'MIDI page', size: MIDI_SIZE,
        init: initMidi,
        params: midiParams,
        cols: 3,
        layout: [{ group: 'MIDI' }, ...(GLOBAL ? [{ group: 'Preamp' }] : []), { group: 'Program change table' }],
        note: `The MIDI page${GLOBAL ? ', the global cab simulator' : ''} and the program change table can be sent over MIDI but not read back: this page shows the ${NAME}'s defaults until you change a value, then what was sent.`,
        // one .syx of page edits: channel, program change, thru, footswitch range, (GT: cab simulator), then the table
        toSyx: (data) => [...[0, 1, 4, 8, 9].map((off) => midiParams.find((p) => p.offset === off).send(data[off])),
          ...(GLOBAL ? midiParams.find((p) => p.key === 'cabsrc').send(data[GLOBAL.select[1]], null, data) : []),
          ...Array.from({ length: 128 }, (_, n) => midiParams.find((p) => p.key === `t${n}`).send(data[TABLE_AT + n])).flat()].flat(),
      },
    ],
    requests: [
      { label: 'Edit buffer', bytes: () => msg.request(EDIT) },
      { label: 'Program 00', bytes: () => msg.request(0) },
      { label: 'All 100 programs', bytes: () => msg.request(ALL), timeout: 10000 },
    ],
    fullDump: [{ request: 'All 100 programs', timeout: 10000, quiet: 3000 }, { request: 'Edit buffer' }],
    templates: [
      { label: 'Recall program 00 (function 0 page 1)', bytes: () => msg.param(0, 0, 0) },
      { label: 'Reverb decay 50 (configuration 1, reverb page 7)', bytes: () => msg.param(1, 6, 50) },
    ],
    midiNotes: [
      'SysEx is received and sent only while the MIDI page\'s SYSEX ENABLE is ON.',
      'Program change: MIDI PROGRAM CHANGE OFF ignores it, ON recalls the same program (00-99), TABLE looks it up in the program change table.',
      'Modulation: eight MOD slots per program route pitch bend, aftertouch, note number, velocity or a controller to a target with an amplitude.',
      'Opcode 04 writes the DSP registers directly (a factory tool); the editor does not send it.',
    ],
  };


  return { def, msg, isQuadraverb, cfgOf, pageList, locate, formatValue, targetName, fitProgram, nameOf, setName, presetData, initMidi, SLOTS, SPARE,
    _test: { programParams, midiParams, simulate, TABLE_AT, SLOTS } };
}
