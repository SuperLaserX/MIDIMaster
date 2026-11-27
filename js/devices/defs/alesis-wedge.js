// Alesis Wedge (1995 desktop reverb and effects): MIDI implementation taken from the W1 v1.02
// firmware (8051 code, 27C512, 2-31-0077 06-30-97). See docs/devices/alesis-wedge.md.
//
// SysEx F0 00 00 0E 15 <dd> <op> ... F7 (receiver 194D). <dd> is the MIDI channel - 1: it must equal
// 1Dh (the Util MIDI page's channel, 168B) unless Omni is on (flag bit 1, set by CC 125, cleared by
// CC 124). Opcodes (jump table 1A0B):
//   00 global (1DD0)            In L/R and Out L/R levels, Mod#X, AmpX (2 nibbles), Mod#Y, AmpY (2 nibbles), flags
//   01 program change table (1EE3): 128 entries, 2 nibbles each
//   02 edit buffer (1F21)       one program
//   03 user bank (1F62)         128 programs
//   04 <n> user program n (1F7E)
//   05 <n> store the edit buffer into user program n (1FA4, "Program stored from MIDI")
//   06 <cfg> <param> <hi> <lo>  parameter change (1D3C): applied when <cfg> is the edit buffer's
//                               configuration; the Wedge sends the same message when a slider moves (1C8B)
//   40h + op: request (1A20 -> 1B07): 40 global, 41 table, 42 edit buffer, 43 user bank, 7F all four.
//   44h <n> is read but answers nothing in v1.02 (1A36 passes 4, not the number, to the transmitter,
//   whose one-program branch at 1B47 needs bit 7), so a user program is read from the 43h dump.
// A program is 38 bytes: [0] edit position (page * 4 + slider), [1] configuration (0-27), [2-13] name,
// [14-37] the configuration's 24 parameters. Bytes 0-13 are sent as they are, 14-37 as two nibbles each
// (encoder 1C6E). The decoder (1FFE) refuses the whole message unless position < DAh, configuration < 28,
// every name character >= 20h and every parameter <= its configuration's maximum.
// Identity reply (1A55): F0 7E dd 06 02 00 00 0E 00 00 15 00 01 00 02 00 F7 (version 1.02).

import { readText } from '../../core/model/memmap.js';
import { ALGORITHMS, FORMATS, PRESETS, USER_FACTORY, MOD_SOURCES, MOD_AMOUNTS, FIRMWARE } from './alesis-wedge-fw.js';
import { wedgeTranslator } from './alesis-wedge-translate.js';

export { ALGORITHMS, FORMATS, PRESETS, USER_FACTORY, FIRMWARE };
const HDR = [0xf0, 0x00, 0x00, 0x0e, 0x15];
export const SIZE = 38;
const GLOBAL_SIZE = 9;
const TABLE_AT = GLOBAL_SIZE; // the program change table follows the global bytes in the System data
const SYSTEM_SIZE = GLOBAL_SIZE + 128;

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad3 = (n) => String(n).padStart(3, '0');
const dev = (ctx) => (ctx?.channel ?? 0) & 0x0f;
const nib = (v) => [(v >> 4) & 15, v & 15];
export const isWedge = (raw) => raw?.[0] === 0xf0 && HDR.every((b, i) => raw[i] === b);
const op = (raw) => raw[6];

/** A program as sent: bytes 0-13 as they are, then 24 parameters as two nibbles each (62 bytes). */
export const encodeProgram = (d) => [...Array.from(d.slice(0, 14), (b) => b & 0x7f), ...Array.from(d.slice(14, SIZE)).flatMap(nib)];
export function decodeProgram(raw, at) {
  const d = new Uint8Array(SIZE);
  for (let i = 0; i < 14; i++) d[i] = raw[at + i] ?? 0;
  for (let i = 0; i < 24; i++) d[14 + i] = (((raw[at + 14 + 2 * i] ?? 0) & 15) << 4) | ((raw[at + 15 + 2 * i] ?? 0) & 15);
  return d;
}
const PROG_LEN = 62;

export const msg = {
  request: (ctx, code) => [...HDR, dev(ctx), code, 0xf7],
  global: (ctx, s) => [...HDR, dev(ctx), 0x00, s[0], s[1], s[2], s[3], s[4], ...nib(s[5]), s[6], ...nib(s[7]), s[8] & 0x7f, 0xf7],
  table: (ctx, s) => [...HDR, dev(ctx), 0x01, ...Array.from(s.slice(TABLE_AT, TABLE_AT + 128)).flatMap(nib), 0xf7],
  edit: (ctx, d) => [...HDR, dev(ctx), 0x02, ...encodeProgram(d), 0xf7],
  bank: (ctx, progs) => [...HDR, dev(ctx), 0x03, ...progs.flatMap((d) => encodeProgram(d)), 0xf7],
  program: (ctx, n, d) => [...HDR, dev(ctx), 0x04, n & 0x7f, ...encodeProgram(d), 0xf7],
  store: (ctx, n) => [...HDR, dev(ctx), 0x05, n & 0x7f, 0xf7],
  param: (ctx, cfg, i, v) => [...HDR, dev(ctx), 0x06, cfg, i, ...nib(v), 0xf7],
};

// ------------------------------------------------------------------ programs
export const nameOf = (d) => readText(d, 2, 12).trimEnd();
export function setName(d, name) {
  for (let i = 0; i < 12; i++) d[2 + i] = Math.max(32, Math.min(127, String(name).charCodeAt(i) || 32));
}
export const presetData = (i) => hex(PRESETS[i]);
export const userFactoryData = (i) => hex(USER_FACTORY[i]);
const alg = (d) => ALGORITHMS[d[1]] || ALGORITHMS[0];
const pageOf = (a, i) => a.pages.find((p) => p.page === i >> 2);

/** What parameter i (0-23) of configuration `a` is: label, long name, format, maximum (null when unused). */
export function paramInfo(a, i) {
  const f = a.fmt[i];
  const pg = pageOf(a, i);
  if (f < 0 || !pg) return null;
  const s = i & 3;
  return { page: pg.page, title: pg.title, label: pg.cols[s], long: pg.long[s], max: a.max[i], texts: FORMATS[f].texts, routine: FORMATS[f].routine };
}
/** The parameter's name in the editor: the column heading (the long name when the column has none),
 *  after the effect's page title when the configuration has two or three effects (ROOM Decay). */
function paramLabel(a, p) {
  const several = new Set(a.pages.map((pg) => pg.title)).size > 1;
  return `${several && p.title ? `${p.title} ` : ''}${p.label || p.long}`;
}

/** Values above the configuration's maxima (the receiver refuses them) brought into range. */
export function fitProgram(d) {
  const a = alg(d);
  let changed = 0;
  for (let i = 0; i < 24; i++) if (d[14 + i] > a.max[i]) { d[14 + i] = a.max[i]; changed++; }
  if (d[0] >= 24 || !paramInfo(a, d[0])) d[0] = a.pages[0].page * 4;
  return changed;
}
const fitted = (d) => { const x = Uint8Array.from(d); fitProgram(x); return x; };

const sendEdit = (_v, ctx, data) => msg.edit(ctx, fitted(data));
const programParams = [
  {
    key: 'position', group: 'Program', label: 'Edit position', offset: 0, sendKey: 'edit', send: sendEdit,
    help: 'The page and slider the Wedge shows when the program is recalled (page x 4 + slider; a parameter change moves it)',
    dynamic: (d) => {
      const a = alg(d);
      const options = [];
      for (let i = 0; i < 24; i++) { const p = paramInfo(a, i); if (p) options.push([i, `Page ${p.page + 1} ${'ABCD'[i & 3]}: ${paramLabel(a, p)}`]); }
      return { options };
    },
  },
  {
    key: 'config', group: 'Program', label: 'Configuration', offset: 1, options: ALGORITHMS.map((a, n) => [n, a.name]), relayout: true, sendKey: 'edit', send: sendEdit,
    help: 'The effect configuration (algorithm); changing it sends the whole program to the edit buffer',
    after: (d) => (fitProgram(d) ? 'Values above the new configuration\'s ranges were limited to its maxima.' : null),
  },
  ...Array.from({ length: 12 }, (_, i) => ({ key: `name${i}`, group: 'Program', label: `Name ${i + 1}`, offset: 2 + i, min: 32, max: 127, kind: 'char', hidden: true })),
  ...Array.from({ length: 24 }, (_, i) => ({
    key: `p${i}`, group: `Page ${(i >> 2) + 1}`, label: `Parameter ${i + 1}`, offset: 14 + i, min: 0, max: 255,
    send: (v, ctx, data) => msg.param(ctx, data[1], i, v),
    // the Wedge moves its edit position to the parameter that changed (1DB3)
    after: (d) => { d[0] = i; return null; },
    dynamic: (d) => {
      const a = alg(d);
      const p = paramInfo(a, i);
      if (!p) return { hidden: true };
      return {
        label: paramLabel(a, p), help: `${p.long} (slider ${'ABCD'[i & 3]}, ${p.texts[0]} to ${p.texts[p.max]})`,
        max: p.max, options: p.texts.map((t, v) => [v, t]),
      };
    },
  })),
];

// ------------------------------------------------------------------ system: global + program change table
const onOff = [[0, 'OFF'], [1, 'On']];
const MOD_NAMES = { bnd: 'Pitch bend (bnd)', AFt: 'Aftertouch (AFt)', not: 'Note number (not)', UEL: 'Velocity (UEL)' };
// The receiver (1DD0) accepts Mod# 0-122 and Amp 0-197, one less than the Util page reaches (123 = CC 119,
// 198 = +99): a global message holding those is refused, so the lists stop at the receiver's limits.
const modSrc = MOD_SOURCES.slice(0, 123).map((t, v) => [v, MOD_NAMES[t] || `Controller ${t}`]);
const modAmt = MOD_AMOUNTS.slice(0, 198).map((t, v) => [v, t]);
const level = (v) => pad3(v);
const sendGlobal = (_v, ctx, data) => msg.global(ctx, data);
const sendTable = (_v, ctx, data) => msg.table(ctx, data);
const tableOptions = Array.from({ length: 256 }, (_, v) => [v, `${v & 0x80 ? 'User' : 'Pset'} ${pad3(v & 0x7f)}`]);
const systemParams = [
  ...['In L', 'In R', 'Out L', 'Out R'].map((label, i) => ({
    key: `lvl${i}`, section: 'global', group: 'I/O levels', label, offset: i, min: 0, max: 100, format: level, send: sendGlobal, sendKey: 'global',
    help: `${label.startsWith('In') ? 'Input' : 'Output'} level ${label.slice(-1)} (Util I/O page: InL InR OutL OutR, 000-100)`,
  })),
  { key: 'modX', section: 'global', group: 'Modulators', label: 'Mod#X', offset: 4, options: modSrc, send: sendGlobal, sendKey: 'global', help: 'MIDI source of modulator X (Util page 3)' },
  { key: 'ampX', section: 'global', group: 'Modulators', label: 'AmpX', offset: 5, options: modAmt, send: sendGlobal, sendKey: 'global', help: 'Amplitude of modulator X (-99 to +98; 00 = off)' },
  { key: 'modY', section: 'global', group: 'Modulators', label: 'Mod#Y', offset: 6, options: modSrc, send: sendGlobal, sendKey: 'global', help: 'MIDI source of modulator Y' },
  { key: 'ampY', section: 'global', group: 'Modulators', label: 'AmpY', offset: 7, options: modAmt, send: sendGlobal, sendKey: 'global', help: 'Amplitude of modulator Y' },
  { key: 'thru', section: 'global', group: 'MIDI flags', label: 'Thru', offset: 8, bits: 1, shift: 0, options: onOff, send: sendGlobal, sendKey: 'global', help: 'MIDI page "Thru": echo MIDI In to MIDI Out (16CB)' },
  { key: 'omni', section: 'global', group: 'MIDI flags', label: 'Omni', offset: 8, bits: 1, shift: 1, options: onOff, send: sendGlobal, sendKey: 'global', help: 'Receive on every channel (CC 125 Omni On / CC 124 Omni Off set it; not shown on the LCD)' },
  { key: 'dry', section: 'global', group: 'MIDI flags', label: 'Dry defeat switch', offset: 8, bits: 1, shift: 2, options: onOff, send: sendGlobal, sendKey: 'global', help: 'State of the dry-signal switch (0400 drives it when the global message arrives; the Util "Dry Defeat" page sets it)' },
  { key: 'edited', section: 'global', group: 'MIDI flags', label: 'Program edited', offset: 8, bits: 1, shift: 3, options: onOff, readOnly: true, help: 'Set by the Wedge when a parameter changes (2276), cleared when a program is stored or recalled' },
  { key: 'second', section: 'global', group: 'MIDI flags', label: 'Second effect page shown', offset: 8, bits: 1, shift: 6, options: onOff, readOnly: true, help: 'Set by the Wedge while a page of a configuration\'s second effect is shown (2225, descriptor byte 0Eh); lights a panel icon' },
  ...Array.from({ length: 128 }, (_, n) => ({
    key: `t${n}`, section: 'table', group: 'Program change table', label: `MIDI ${pad3(n)}`, offset: TABLE_AT + n, options: tableOptions,
    send: sendTable, sendKey: 'table', help: `Wedge program recalled by program change ${n} when PChg is tbL`,
  })),
];

export function initSystem() {
  const s = new Uint8Array(SYSTEM_SIZE);
  s.set([90, 90, 90, 90, 5, 99, 11, 99, 0]); // levels 90 (reset, 3DF1); Mod#X CC 001 (mod wheel), Mod#Y CC 007 (volume), amplitudes 00
  for (let n = 0; n < 128; n++) s[TABLE_AT + n] = 0x80 | n;
  return s;
}

// ------------------------------------------------------------------ simulator (demo mode, tests)
function simulate() {
  const st = {
    edit: presetData(0), user: USER_FACTORY.map(hex), system: initSystem(), channel: 0, omni: false,
  };
  const reply = {
    0x00: () => [msg.global({ channel: st.channel }, st.system)],
    0x01: () => [msg.table({ channel: st.channel }, st.system)],
    0x02: () => [msg.edit({ channel: st.channel }, st.edit)],
    0x03: () => [msg.bank({ channel: st.channel }, st.user)],
  };
  return {
    state: st,
    handle(d) {
      if (d[0] === 0xf0 && d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) {
        return [[0xf0, 0x7e, st.channel, 0x06, 0x02, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x15, 0x00, 0x01, 0x00, 0x02, 0x00, 0xf7]];
      }
      if ((d[0] & 0xf0) === 0xc0) { const n = d[1]; st.edit = Uint8Array.from(st.user[n] || st.edit); return []; }
      if (!isWedge(d)) return null;
      if (!st.omni && !(st.system[8] & 2) && d[5] !== st.channel) return [];
      const c = op(d);
      if (c & 0x40) {
        const k = c & 0x3f;
        if (k === 0x3f) return [...reply[0](), ...reply[1](), ...reply[3](), ...reply[2]()];
        return reply[k] ? reply[k]() : [];
      }
      const valid = (p) => p[1] < 28 && p[0] < 0xda && p.slice(2, 14).every((b) => b >= 32) && ALGORITHMS[p[1]].max.every((m, i) => p[14 + i] <= m);
      switch (c) {
        case 0x00: {
          const v = [d[7], d[8], d[9], d[10], d[11], (d[12] << 4) | d[13], d[14], (d[15] << 4) | d[16], d[17]];
          if (v.slice(0, 4).some((x) => x > 100) || v[4] > 122 || v[6] > 122 || v[5] > 197 || v[7] > 197) return [];
          st.system.set(v, 0);
          return [];
        }
        case 0x01: for (let n = 0; n < 128; n++) st.system[TABLE_AT + n] = (d[7 + 2 * n] << 4) | d[8 + 2 * n]; return [];
        case 0x02: { const p = decodeProgram(d, 7); if (valid(p)) st.edit = p; return []; }
        case 0x03: { const ps = Array.from({ length: 128 }, (_, n) => decodeProgram(d, 7 + n * PROG_LEN)); if (ps.every(valid)) st.user = ps; return []; }
        case 0x04: { const p = decodeProgram(d, 8); if (valid(p)) st.user[d[7]] = p; return []; }
        case 0x05: st.user[d[7]] = Uint8Array.from(st.edit); return [];
        case 0x06: {
          const [cfg, i, v] = [d[7], d[8], (d[9] << 4) | d[10]];
          if (cfg === st.edit[1] && i < 24 && v <= ALGORITHMS[cfg].max[i]) { st.edit[14 + i] = v; st.edit[0] = i; }
          return [];
        }
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor text
const OPS = { 0: 'global', 1: 'program change table', 2: 'edit buffer', 3: 'user bank (128 programs)', 4: 'user program', 5: 'store edit buffer', 6: 'parameter change' };
function describe(raw) {
  if (!isWedge(raw)) return null;
  const c = op(raw);
  if (c & 0x40) return `Wedge request ${(c & 0x3f) === 0x3f ? 'everything' : OPS[c & 0x3f] || c.toString(16)}${c === 0x44 ? ` ${raw[7]} (answered by nothing in v1.02)` : ''}`;
  if (c === 0x02) return `Wedge edit buffer "${nameOf(decodeProgram(raw, 7))}" (${ALGORITHMS[raw[8]]?.name || raw[8]})`;
  if (c === 0x04) return `Wedge user program ${pad3(raw[7])} "${nameOf(decodeProgram(raw, 8))}"`;
  if (c === 0x05) return `Wedge store edit buffer to user ${pad3(raw[7])}`;
  if (c === 0x06) {
    const a = ALGORITHMS[raw[7]];
    const p = a && paramInfo(a, raw[8]);
    const v = (raw[9] << 4) | raw[10];
    return `Wedge ${a?.name || raw[7]}: ${p ? paramLabel(a, p) : `parameter ${raw[8]}`} = ${p?.texts[v] ?? v}`;
  }
  return `Wedge ${OPS[c] || `opcode ${c}`}`;
}

// ------------------------------------------------------------------ library
function libraryItems(msgs, ctx) {
  const items = [];
  for (const m of msgs) {
    if (!isWedge(m)) { items.push({ key: `x${items.length}`, label: 'Other message', name: '', object: null, msgs: [m] }); continue; }
    const c = op(m);
    if (c === 0x03) {
      for (let n = 0; n < 128 && 7 + (n + 1) * PROG_LEN <= m.length - 1; n++) {
        const d = decodeProgram(m, 7 + n * PROG_LEN);
        items.push({ key: `u${n}`, label: `User ${pad3(n)}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(msg.program(ctx, n, d))] });
      }
    } else if (c === 0x04) {
      const d = decodeProgram(m, 8);
      items.push({ key: `u${m[7]}`, label: `User ${pad3(m[7])}`, name: nameOf(d), object: 'effect', data: d, msgs: [m] });
    } else if (c === 0x02) {
      const d = decodeProgram(m, 7);
      items.push({ key: `e${items.length}`, label: 'Program (edit buffer)', name: nameOf(d), object: 'effect', data: d, msgs: [m] });
    } else {
      items.push({ key: `s${items.length}`, label: `Wedge ${OPS[c] || 'message'}`, name: '', object: c <= 1 ? 'global' : null, msgs: [m] });
    }
  }
  return items;
}

function systemFromSyx(msgs) {
  const g = msgs.find((m) => isWedge(m) && op(m) === 0x00);
  const t = msgs.find((m) => isWedge(m) && op(m) === 0x01);
  if (!g && !t) return null;
  const s = initSystem();
  if (g) s.set([g[7], g[8], g[9], g[10], g[11], (g[12] << 4) | g[13], g[14], (g[15] << 4) | g[16], g[17]], 0);
  if (t) for (let n = 0; n < 128; n++) s[TABLE_AT + n] = (t[7 + 2 * n] << 4) | t[8 + 2 * n];
  return s;
}

const programFromSyx = (msgs) => {
  const m = msgs.find((r) => isWedge(r) && [0x02, 0x03, 0x04].includes(op(r)));
  if (!m) return null;
  return decodeProgram(m, op(m) === 0x04 ? 8 : 7);
};

async function readUserBank(api) {
  const raw = await api.request(msg.request(api.ctx, 0x43), (r) => isWedge(r) && op(r) === 0x03, (r) => r);
  return Array.from({ length: 128 }, (_, n) => decodeProgram(raw, 7 + n * PROG_LEN));
}

// ------------------------------------------------------------------ definition
const TR = wedgeTranslator({ ALGORITHMS, paramInfo, presetData, fitProgram, setName, nameOf, SIZE });
const BANKS = [[0, 'User'], [1, 'Preset']];
const PRESET_NAMES = PRESETS.map((h) => nameOf(hex(h)));

export default {
  coverage: `Every byte of programs (all 28 configurations, each parameter with the LCD text its firmware display routine shows), the global settings and the program change table, from ${FIRMWARE}. Edit buffer, user bank and program dumps, store, live parameter changes. Not checked on hardware.`,
  sysex: { manufacturer: [0x00, 0x00, 0x0e], model: 0x15 },
  minGap: 20,
  describe,
  recognise: isWedge,
  isOwn: isWedge,
  isRequest: (raw) => isWedge(raw) && (op(raw) & 0x40) !== 0,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: SIZE, autoLoad: true,
      init: () => presetData(0),
      request: (ctx) => msg.request(ctx, 0x42),
      match: (raw) => isWedge(raw) && op(raw) === 0x02,
      decode: (raw) => decodeProgram(raw, 7),
      params: programParams,
      name: nameOf,
      setName,
      category: () => 'none',
      patchKinds: ['effect'],
      // Head Library: effect programs move between effects units through the shared model's effects section
      toCommon: (d) => TR.toCommon(d),
      fromCommon: (c, base) => TR.fromCommon(c, base),
      cols: 4,
      layout: [{ group: 'Program' }, ...Array.from({ length: 6 }, (_, p) => ({ group: `Page ${p + 1}` }))],
      note: 'Each slider change is sent as a parameter change (opcode 06), which the Wedge applies to its edit buffer. Changing the configuration or the name sends the whole program. Store writes the program into a user slot.',
      sendAll: { label: 'Send to edit buffer', title: 'Send the whole program to the edit buffer (opcode 02)', build: (data, ctx) => msg.edit(ctx, fitted(data)) },
      toSyx: (data, ctx) => msg.edit(ctx, fitted(data)),
      fromSyx: programFromSyx,
      actions: [
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Program name', [{ key: 'name', label: 'Name (12 characters)', value: nameOf(api.data), maxlength: 12 }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name);
          api.send(msg.edit(api.ctx, fitted(d)));
          api.setData(d);
        } },
        { label: 'Store via Wedge', title: 'Send the program to the edit buffer, then have the Wedge store it (opcode 05) into a user slot', run: async (api) => {
          const r = await api.form('Store into user program', [{ key: 'n', label: 'User program (0-127)', value: '0', type: 'number', min: 0, max: 127 }]);
          if (!r) return;
          const n = Math.max(0, Math.min(127, Math.round(Number(r.n) || 0)));
          api.send([msg.edit(api.ctx, fitted(api.data)), msg.store(api.ctx, n)]);
        } },
      ],
      slots: {
        label: 'Programs', banks: BANKS, count: 128,
        slotLabel: (bank, i) => `${bank ? 'Pset' : 'User'} ${pad3(i)}`,
        note: (bank) => (bank ? 'Preset programs are in the Wedge\'s ROM: their contents come from the firmware. ' : 'Reading a user program reads the whole user bank (the v1.02 Wedge does not answer single-program requests). ')
          + 'Play sends Controller 0 (0 = Preset, 1 = User bank) and a program change: the Wedge follows them when PChg is On.',
        names: (bank) => (bank === 1 ? PRESET_NAMES : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => [[0xb0 | dev(ctx), 0x00, bank === 1 ? 0 : 1], [0xc0 | dev(ctx), i]],
        fetch: async (api, bank, i) => (bank === 1 ? presetData(i) : (await readUserBank(api))[i]),
        scanBank: async (api, bank, onName) => {
          const progs = bank === 1 ? PRESETS.map(hex) : await readUserBank(api);
          progs.forEach((d, i) => onName(i, nameOf(d)));
        },
        store: (bank, i, ctx, data) => msg.program(ctx, i, fitted(data)),
      },
    },
    {
      key: 'global', page: 'System', icon: '⚙', label: 'System', size: SYSTEM_SIZE, autoLoad: true,
      init: initSystem,
      fetch: async (api) => {
        const s = Uint8Array.from(api.data);
        const g = await api.request(msg.request(api.ctx, 0x40), (r) => isWedge(r) && op(r) === 0x00, (r) => r);
        const t = await api.request(msg.request(api.ctx, 0x41), (r) => isWedge(r) && op(r) === 0x01, (r) => r);
        return systemFromSyx([g, t]) || s;
      },
      sections: [{ key: 'global', label: 'Levels, modulators, MIDI' }, { key: 'table', label: 'Program change table' }],
      params: systemParams,
      cols: 3,
      note: 'Global settings go out together (opcode 00), the table as a whole (opcode 01). The MIDI channel, PChg mode and Dry Defeat page are front-panel settings that no message carries.',
      toSyx: (data, ctx) => [msg.global(ctx, data), msg.table(ctx, data)],
      fromSyx: systemFromSyx,
    },
  ],
  requests: [
    { label: 'Edit buffer', bytes: (ctx) => msg.request(ctx, 0x42) },
    { label: 'User bank (128 programs)', bytes: (ctx) => msg.request(ctx, 0x43), timeout: 8000 },
    { label: 'Global settings', bytes: (ctx) => msg.request(ctx, 0x40) },
    { label: 'Program change table', bytes: (ctx) => msg.request(ctx, 0x41) },
    { label: 'Everything (global, table, user bank, edit buffer)', bytes: (ctx) => msg.request(ctx, 0x7f), timeout: 8000 },
  ],
  fullDump: [{ request: 'Everything (global, table, user bank, edit buffer)', timeout: 8000, quiet: 3000 }],
  templates: [
    { label: 'Store the edit buffer into user 000', bytes: (ctx) => msg.store(ctx, 0) },
    { label: 'Parameter change: configuration 20 (LARGE HALL) parameter 0 = 50', bytes: (ctx) => msg.param(ctx, 20, 0, 50) },
  ],
  midiNotes: [
    'Program change: PChg Off ignores it, On recalls the same number in the current bank, tbL looks it up in the program change table (1820).',
    'Controller 0 before a program change selects the bank: 0 = Preset, 1-127 = User (17A8, PChg On).',
    'Mod#X / Mod#Y: pitch bend, aftertouch, note number, velocity or controller 000-119 drive two parameters of each configuration.',
    'CC 124 / 125: Omni off / on. Channel messages and SysEx are read on the Util page channel unless Omni is on.',
  ],
};

export const _test = { programParams, systemParams, TABLE_AT, PROG_LEN, simulate };
