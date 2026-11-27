// Alesis MIDIVerb 4 (1996 rack reverb and effects): MIDI implementation taken from the v1.04 firmware
// (8051 code, 64 KB; the Wedge's software family and LCD). See docs/devices/alesis-midiverb4.md.
//
// SysEx F0 00 00 0E 11 <dd> <op> ... F7 (header check B9E6). <dd> is the MIDI channel - 1 (1Dh) unless
// Omni is on (flag bit 1; a reset turns it on, D2DC). Opcodes (jump table BA60, receiver BA72):
//   00 global (BD87): 6 levels, Mod#X, AmpX (2 nibbles), Mod#Y, AmpY (2 nibbles), footswitch, flags
//   01 program change table (BEDA): 128 entries, 2 nibbles each
//   02 edit buffer (BF18)      03 user bank, 128 programs (BF55)
//   04 <n> user program n (BF71)   05 <n> store the edit buffer into user n (BF97)
//   40h + op: request (BAAF -> BBB0): 40 global, 41 table, 42 edit buffer, 43 user bank; 7F all four
//   (global, table, edit buffer, user bank). 44h <n> answers nothing (BAC5 passes 4, not the number, to
//   the transmitter, as on the Wedge), so a user program is read from the 43h dump.
// There is no parameter-change message: every edit sends the whole program to the edit buffer.
// A program is 26 bytes: [0] edit position (page * 4 + slider), [1] configuration (0-31), [2-9] name,
// [10-25] the configuration's 16 parameters. Bytes 0-9 go out as they are, 10-25 as two nibbles each
// (encoder BCEB). The decoder (BFF1) refuses the whole message unless position < E6h, configuration < 32,
// every name character >= 20h and every parameter <= its configuration's maximum.
// Identity reply (BB14): F0 7E dd 06 02 00 00 0E 00 00 11 00 01 00 04 00 F7 (version 1.04).

import { readText } from '../../core/model/memmap.js';
import { ALGORITHMS, FORMATS, PRESETS, USER_FACTORY, MOD_SOURCES, MOD_AMOUNTS, FOOTSWITCH, LEVELS, FIRMWARE } from './alesis-midiverb4-fw.js';
import { wedgeTranslator } from './alesis-wedge-translate.js';

export { ALGORITHMS, FORMATS, PRESETS, USER_FACTORY, FIRMWARE };
const HDR = [0xf0, 0x00, 0x00, 0x0e, 0x11];
export const SIZE = 26;
const RAW = 10;
const NP = 16;
const PROG_LEN = RAW + 2 * NP; // 42
const GLOBAL_SIZE = 12;
const TABLE_AT = GLOBAL_SIZE;
const SYSTEM_SIZE = GLOBAL_SIZE + 128;

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad3 = (n) => String(n).padStart(3, '0');
const dev = (ctx) => (ctx?.channel ?? 0) & 0x0f;
const nib = (v) => [(v >> 4) & 15, v & 15];
export const isMidiverb4 = (raw) => raw?.[0] === 0xf0 && HDR.every((b, i) => raw[i] === b);
const op = (raw) => raw[6];

export const encodeProgram = (d) => [...Array.from(d.slice(0, RAW), (b) => b & 0x7f), ...Array.from(d.slice(RAW, SIZE)).flatMap(nib)];
export function decodeProgram(raw, at) {
  const d = new Uint8Array(SIZE);
  for (let i = 0; i < RAW; i++) d[i] = raw[at + i] ?? 0;
  for (let i = 0; i < NP; i++) d[RAW + i] = (((raw[at + RAW + 2 * i] ?? 0) & 15) << 4) | ((raw[at + RAW + 1 + 2 * i] ?? 0) & 15);
  return d;
}

export const msg = {
  request: (ctx, code) => [...HDR, dev(ctx), code, 0xf7],
  global: (ctx, s) => [...HDR, dev(ctx), 0x00, ...Array.from(s.slice(0, 7)), ...nib(s[7]), s[8], ...nib(s[9]), s[10], s[11] & 0x7f, 0xf7],
  table: (ctx, s) => [...HDR, dev(ctx), 0x01, ...Array.from(s.slice(TABLE_AT, TABLE_AT + 128)).flatMap(nib), 0xf7],
  edit: (ctx, d) => [...HDR, dev(ctx), 0x02, ...encodeProgram(d), 0xf7],
  bank: (ctx, progs) => [...HDR, dev(ctx), 0x03, ...progs.flatMap((d) => encodeProgram(d)), 0xf7],
  program: (ctx, n, d) => [...HDR, dev(ctx), 0x04, n & 0x7f, ...encodeProgram(d), 0xf7],
  store: (ctx, n) => [...HDR, dev(ctx), 0x05, n & 0x7f, 0xf7],
};
const globalFrom = (g) => [g[7], g[8], g[9], g[10], g[11], g[12], g[13], (g[14] << 4) | g[15], g[16], (g[17] << 4) | g[18], g[19], g[20]];

// ------------------------------------------------------------------ programs
export const nameOf = (d) => readText(d, 2, 8).trimEnd();
export function setName(d, name) {
  for (let i = 0; i < 8; i++) d[2 + i] = Math.max(32, Math.min(127, String(name).charCodeAt(i) || 32));
}
export const presetData = (i) => hex(PRESETS[i]);
export const userFactoryData = (i) => hex(USER_FACTORY[i]);
const alg = (d) => ALGORITHMS[d[1]] || ALGORITHMS[0];

/** Parameter i (0-15) of configuration `a`: label, long name, page title, format, maximum (null when unused). */
export function paramInfo(a, i) {
  const f = a.fmt[i];
  const pg = a.pages.find((p) => p.page === i >> 2);
  if (f < 0 || !pg) return null;
  const s = i & 3;
  return { page: pg.page, title: pg.title, heading: pg.heading, label: pg.cols[s], long: pg.long[s], max: a.max[i], texts: FORMATS[f].texts, routine: FORMATS[f].routine };
}
function paramLabel(a, p) {
  const several = new Set(a.pages.map((pg) => pg.title)).size > 1;
  return `${several && p.title ? `${p.title} ` : ''}${p.label || p.long}`;
}

export function fitProgram(d) {
  const a = alg(d);
  let changed = 0;
  for (let i = 0; i < NP; i++) if (d[RAW + i] > a.max[i]) { d[RAW + i] = a.max[i]; changed++; }
  if (d[0] >= NP || !paramInfo(a, d[0])) d[0] = a.pages[0].page * 4;
  return changed;
}
const fitted = (d) => { const x = Uint8Array.from(d); fitProgram(x); return x; };
const sendEdit = (_v, ctx, data) => msg.edit(ctx, fitted(data));

const programParams = [
  {
    key: 'position', group: 'Program', label: 'Edit position', offset: 0, sendKey: 'edit', send: sendEdit,
    help: 'The page and slider shown when the program is recalled (page x 4 + slider)',
    dynamic: (d) => {
      const a = alg(d);
      const options = [];
      for (let i = 0; i < NP; i++) { const p = paramInfo(a, i); if (p) options.push([i, `Page ${p.page + 1} ${'ABCD'[i & 3]}: ${paramLabel(a, p)}`]); }
      return { options };
    },
  },
  {
    key: 'config', group: 'Program', label: 'Configuration', offset: 1, options: ALGORITHMS.map((a, n) => [n, a.name]), relayout: true, sendKey: 'edit', send: sendEdit,
    help: 'The effect configuration (algorithm)',
    after: (d) => (fitProgram(d) ? 'Values above the new configuration\'s ranges were limited to its maxima.' : null),
  },
  ...Array.from({ length: 8 }, (_, i) => ({ key: `name${i}`, group: 'Program', label: `Name ${i + 1}`, offset: 2 + i, min: 32, max: 127, kind: 'char', hidden: true })),
  ...Array.from({ length: NP }, (_, i) => ({
    key: `p${i}`, group: `Page ${(i >> 2) + 1}`, label: `Parameter ${i + 1}`, offset: RAW + i, min: 0, max: 255, sendKey: 'edit', send: sendEdit,
    dynamic: (d) => {
      const a = alg(d);
      const p = paramInfo(a, i);
      if (!p) return { hidden: true };
      return { label: paramLabel(a, p), help: `${p.long} (${p.heading}, slider ${'ABCD'[i & 3]}, ${p.texts[0]} to ${p.texts[p.max]})`, max: p.max, options: p.texts.map((t, v) => [v, t]) };
    },
  })),
];

// ------------------------------------------------------------------ system
const onOff = [[0, 'OFF'], [1, 'On']];
const MOD_NAMES = { bnd: 'Pitch bend (bnd)', AFt: 'Aftertouch (AFt)', not: 'Note number (not)', UEL: 'Velocity (UEL)' };
// The receiver (BD87) accepts Mod# 0-122, Amp 0-197 and footswitch 0-1: one less than the Util pages reach
// (Mod# 123 = CC 119, Amp 198 = +99, footswitch CtL), so the lists stop at the receiver's limits.
const modSrc = MOD_SOURCES.slice(0, 123).map((t, v) => [v, MOD_NAMES[t] || `Controller ${t}`]);
const modAmt = MOD_AMOUNTS.slice(0, 198).map((t, v) => [v, t]);
const sendGlobal = (_v, ctx, data) => msg.global(ctx, data);
const sendTable = (_v, ctx, data) => msg.table(ctx, data);
const tableOptions = Array.from({ length: 256 }, (_, v) => [v, `${v & 0x80 ? 'User' : 'Pset'} ${pad3(v & 0x7f)}`]);
const LEVEL_NAMES = ['Input level (Stereo)', 'Input level Ch 1', 'Input level Ch 2', 'Output level (Stereo)', 'Output level Ch 1', 'Output level Ch 2'];
const flag = (key, label, shift, help, readOnly = false) => ({ key, section: 'global', group: 'MIDI and modes', label, offset: 11, bits: 1, shift, options: onOff, help, ...(readOnly ? { readOnly } : { send: sendGlobal, sendKey: 'global' }) });
const systemParams = [
  ...LEVEL_NAMES.map((label, i) => ({
    key: `lvl${i}`, section: 'global', group: 'Levels', label, offset: i, min: 0, max: 100, format: (v) => LEVELS[v] ?? String(v), send: sendGlobal, sendKey: 'global',
    help: 'Util Input Level / Output Level pages: "Stereo" in stereo mode, "Ch 1" and "Ch 2" in dual mode (000-100)',
  })),
  { key: 'modX', section: 'global', group: 'Modulators', label: 'Mod#X', offset: 6, options: modSrc, send: sendGlobal, sendKey: 'global', help: 'MIDI source of modulator X' },
  { key: 'ampX', section: 'global', group: 'Modulators', label: 'AmpX', offset: 7, options: modAmt, send: sendGlobal, sendKey: 'global', help: 'Amplitude of modulator X (-99 to +98; 00 = off)' },
  { key: 'modY', section: 'global', group: 'Modulators', label: 'Mod#Y', offset: 8, options: modSrc, send: sendGlobal, sendKey: 'global', help: 'MIDI source of modulator Y' },
  { key: 'ampY', section: 'global', group: 'Modulators', label: 'AmpY', offset: 9, options: modAmt, send: sendGlobal, sendKey: 'global', help: 'Amplitude of modulator Y' },
  { key: 'foot', section: 'global', group: 'MIDI and modes', label: 'Footswitch', offset: 10, options: FOOTSWITCH.slice(0, 2).map((t, v) => [v, t]), send: sendGlobal, sendKey: 'global', help: 'Util Footswitch page (column B): Adu or byP. The page also offers CtL, but the MIDIVerb 4 refuses it over MIDI' },
  flag('thru', 'Thru', 0, 'MIDI page "Thru": pass everything from MIDI In on to MIDI Out'),
  flag('omni', 'Omni', 1, 'Receive on every channel (CC 125 turns it on, CC 124 off; a reset turns it on)'),
  flag('dry', 'Dry defeat switch', 2, 'State of the dry-signal switch; it follows the Dry Defeat setting of the Footswitch / Dry Defeat page'),
  flag('cascade', 'Cascade', 3, 'Util "Dual Programs: Cascade" page'),
  flag('display', 'Program display flag', 5, 'Set by the MIDIVerb 4 at power-on; it decides when the program display is redrawn. Shown for information', true),
  flag('edited', 'Program edited', 6, 'Set when a parameter changes, cleared by store and recall', true),
  ...Array.from({ length: 128 }, (_, n) => ({
    key: `t${n}`, section: 'table', group: 'Program change table', label: `MIDI ${pad3(n)}`, offset: TABLE_AT + n, options: tableOptions,
    send: sendTable, sendKey: 'table', help: `Program recalled by program change ${n} when PChg is tbL`,
  })),
];

export function initSystem() {
  const s = new Uint8Array(SYSTEM_SIZE);
  s.set([90, 90, 90, 90, 90, 90, 5, 99, 11, 99, 0, 0x22]); // editor defaults; flags: Omni on and bit 5 as a reset leaves them (D2DA)
  for (let n = 0; n < 128; n++) s[TABLE_AT + n] = 0x80 | n;
  return s;
}

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { edit: presetData(1), user: USER_FACTORY.map(hex), system: initSystem(), channel: 0 };
  const c = () => ({ channel: st.channel });
  const reply = { 0: () => [msg.global(c(), st.system)], 1: () => [msg.table(c(), st.system)], 2: () => [msg.edit(c(), st.edit)], 3: () => [msg.bank(c(), st.user)] };
  const valid = (p) => p[1] < 32 && p[0] < 0xe6 && p.slice(2, RAW).every((b) => b >= 32) && ALGORITHMS[p[1]].max.every((m, i) => p[RAW + i] <= m);
  return {
    state: st,
    handle(d) {
      if (d[0] === 0xf0 && d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) return [[0xf0, 0x7e, st.channel, 0x06, 0x02, 0, 0, 0x0e, 0, 0, 0x11, 0, 0x01, 0, 0x04, 0, 0xf7]];
      if (!isMidiverb4(d)) return null;
      if (!(st.system[11] & 2) && d[5] !== st.channel) return [];
      const k = op(d);
      if (k & 0x40) {
        const r = k & 0x3f;
        if (r === 0x3f) return [...reply[0](), ...reply[1](), ...reply[2](), ...reply[3]()];
        return reply[r] ? reply[r]() : [];
      }
      switch (k) {
        case 0: { const g = globalFrom(d); if (g.slice(0, 6).every((x) => x <= 100) && g[6] <= 122 && g[8] <= 122 && g[7] <= 197 && g[9] <= 197 && g[10] < 2) st.system.set(g, 0); return []; }
        case 1: for (let n = 0; n < 128; n++) st.system[TABLE_AT + n] = (d[7 + 2 * n] << 4) | d[8 + 2 * n]; return [];
        case 2: { const p = decodeProgram(d, 7); if (valid(p)) st.edit = p; return []; }
        case 3: { const ps = Array.from({ length: 128 }, (_, n) => decodeProgram(d, 7 + n * PROG_LEN)); if (ps.every(valid)) st.user = ps; return []; }
        case 4: { const p = decodeProgram(d, 8); if (valid(p)) st.user[d[7]] = p; return []; }
        case 5: st.user[d[7]] = Uint8Array.from(st.edit); return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ monitor text, library
const OPS = { 0: 'global', 1: 'program change table', 2: 'edit buffer', 3: 'user bank (128 programs)', 4: 'user program', 5: 'store edit buffer' };
function describe(raw) {
  if (!isMidiverb4(raw)) return null;
  const k = op(raw);
  if (k & 0x40) return `MIDIVerb 4 request ${(k & 0x3f) === 0x3f ? 'everything' : OPS[k & 0x3f] || k.toString(16)}`;
  if (k === 2) return `MIDIVerb 4 edit buffer "${nameOf(decodeProgram(raw, 7))}" (${ALGORITHMS[raw[8]]?.name || raw[8]})`;
  if (k === 4) return `MIDIVerb 4 user program ${pad3(raw[7])} "${nameOf(decodeProgram(raw, 8))}"`;
  if (k === 5) return `MIDIVerb 4 store edit buffer to user ${pad3(raw[7])}`;
  return `MIDIVerb 4 ${OPS[k] || `opcode ${k}`}`;
}

function libraryItems(msgs, ctx) {
  const items = [];
  for (const m of msgs) {
    if (!isMidiverb4(m)) { items.push({ key: `x${items.length}`, label: 'Other message', name: '', object: null, msgs: [m] }); continue; }
    const k = op(m);
    if (k === 3) {
      for (let n = 0; n < 128 && 7 + (n + 1) * PROG_LEN <= m.length - 1; n++) {
        const d = decodeProgram(m, 7 + n * PROG_LEN);
        items.push({ key: `u${n}`, label: `User ${pad3(n)}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(msg.program(ctx, n, d))] });
      }
    } else if (k === 4) {
      const d = decodeProgram(m, 8);
      items.push({ key: `u${m[7]}`, label: `User ${pad3(m[7])}`, name: nameOf(d), object: 'effect', data: d, msgs: [m] });
    } else if (k === 2) {
      const d = decodeProgram(m, 7);
      items.push({ key: `e${items.length}`, label: 'Program (edit buffer)', name: nameOf(d), object: 'effect', data: d, msgs: [m] });
    } else items.push({ key: `s${items.length}`, label: `MIDIVerb 4 ${OPS[k] || 'message'}`, name: '', object: k <= 1 ? 'global' : null, msgs: [m] });
  }
  return items;
}

function systemFromSyx(msgs) {
  const g = msgs.find((m) => isMidiverb4(m) && op(m) === 0);
  const t = msgs.find((m) => isMidiverb4(m) && op(m) === 1);
  if (!g && !t) return null;
  const s = initSystem();
  if (g) s.set(globalFrom(g), 0);
  if (t) for (let n = 0; n < 128; n++) s[TABLE_AT + n] = (t[7 + 2 * n] << 4) | t[8 + 2 * n];
  return s;
}
const programFromSyx = (msgs) => {
  const m = msgs.find((r) => isMidiverb4(r) && [2, 3, 4].includes(op(r)));
  return m ? decodeProgram(m, op(m) === 4 ? 8 : 7) : null;
};
async function readUserBank(api) {
  const raw = await api.request(msg.request(api.ctx, 0x43), (r) => isMidiverb4(r) && op(r) === 3, (r) => r);
  return Array.from({ length: 128 }, (_, n) => decodeProgram(raw, 7 + n * PROG_LEN));
}

// ------------------------------------------------------------------ definition
const TR = wedgeTranslator({ ALGORITHMS, paramInfo, presetData, fitProgram, setName, nameOf, SIZE, at: RAW, count: NP, family: 'alesis-midiverb4', model: 'alesis-midiverb4' });
const PRESET_NAMES = PRESETS.map((h) => nameOf(hex(h)));

export default {
  coverage: 'Edits the MIDIVerb 4\'s programs (32 configurations, each value shown as its display shows it), its global settings and its program change table. Reads the current program and the user bank, sends programs and stores them into user slots. Not checked on hardware.',
  sysex: { manufacturer: [0x00, 0x00, 0x0e], model: 0x11 },
  minGap: 20,
  describe,
  recognise: isMidiverb4,
  isOwn: isMidiverb4,
  isRequest: (raw) => isMidiverb4(raw) && (op(raw) & 0x40) !== 0,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: SIZE, autoLoad: true,
      init: () => presetData(1),
      request: (ctx) => msg.request(ctx, 0x42),
      match: (raw) => isMidiverb4(raw) && op(raw) === 2,
      decode: (raw) => decodeProgram(raw, 7),
      params: programParams,
      name: nameOf,
      setName,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon: (d) => TR.toCommon(d),
      fromCommon: (c, base) => TR.fromCommon(c, base),
      cols: 4,
      layout: [{ group: 'Program' }, ...Array.from({ length: 4 }, (_, p) => ({ group: `Page ${p + 1}` }))],
      note: 'The MIDIVerb 4 cannot take single values over MIDI, so each change sends the whole program to the program it is playing. Store writes the program into a user slot.',
      sendAll: { label: 'Send to edit buffer', title: 'Send the whole program to the MIDIVerb 4 (it plays it but does not store it)', build: (data, ctx) => msg.edit(ctx, fitted(data)) },
      toSyx: (data, ctx) => msg.edit(ctx, fitted(data)),
      fromSyx: programFromSyx,
      actions: [
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Program name', [{ key: 'name', label: 'Name (8 characters)', value: nameOf(api.data), maxlength: 8 }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name);
          api.send(msg.edit(api.ctx, fitted(d)));
          api.setData(d);
        } },
        { label: 'Store via MIDIVerb', title: 'Send the program to the MIDIVerb 4, then have it store the program into a user slot', run: async (api) => {
          const r = await api.form('Store into user program', [{ key: 'n', label: 'User program (0-127)', value: '0', type: 'number', min: 0, max: 127 }]);
          if (!r) return;
          const n = Math.max(0, Math.min(127, Math.round(Number(r.n) || 0)));
          api.send([msg.edit(api.ctx, fitted(api.data)), msg.store(api.ctx, n)]);
        } },
      ],
      slots: {
        label: 'Programs', banks: [[0, 'User'], [1, 'Preset']], count: 128,
        slotLabel: (bank, i) => `${bank ? 'Pset' : 'User'} ${pad3(i)}`,
        note: (bank) => (bank ? 'Preset programs are built into the MIDIVerb 4: the editor shows them from its own copy. ' : 'Reading one user program reads the whole user bank (the MIDIVerb 4 cannot send single programs). ')
          + 'Play sends Controller 0 (0 = Preset, 1 = User bank) and a program change.',
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
        const g = await api.request(msg.request(api.ctx, 0x40), (r) => isMidiverb4(r) && op(r) === 0, (r) => r);
        const t = await api.request(msg.request(api.ctx, 0x41), (r) => isMidiverb4(r) && op(r) === 1, (r) => r);
        return systemFromSyx([g, t]);
      },
      sections: [{ key: 'global', label: 'Levels, modulators, MIDI' }, { key: 'table', label: 'Program change table' }],
      params: systemParams,
      cols: 3,
      note: 'The global settings are sent together, the program change table as a whole. The MIDI channel, PChg mode and Dry Defeat can only be set on the MIDIVerb 4\'s front panel.',
      toSyx: (data, ctx) => [msg.global(ctx, data), msg.table(ctx, data)],
      fromSyx: systemFromSyx,
    },
  ],
  requests: [
    { label: 'Edit buffer', bytes: (ctx) => msg.request(ctx, 0x42) },
    { label: 'User bank (128 programs)', bytes: (ctx) => msg.request(ctx, 0x43), timeout: 8000 },
    { label: 'Global settings', bytes: (ctx) => msg.request(ctx, 0x40) },
    { label: 'Program change table', bytes: (ctx) => msg.request(ctx, 0x41) },
    { label: 'Everything (global, table, edit buffer, user bank)', bytes: (ctx) => msg.request(ctx, 0x7f), timeout: 8000 },
  ],
  fullDump: [{ request: 'Everything (global, table, edit buffer, user bank)', timeout: 8000, quiet: 3000 }],
  templates: [{ label: 'Store the edit buffer into user 000', bytes: (ctx) => msg.store(ctx, 0) }],
  midiNotes: [
    'Program change: PChg OFF, On (current bank) or tbL (program change table). Controller 0 before it selects the bank: 0 = Preset, 1-127 = User.',
    'Mod#X / Mod#Y: pitch bend, aftertouch, note number, velocity or controller 000-119 drive two parameters of each configuration.',
    'CC 124 / 125: Omni off / on.',
  ],
};

export const _test = { programParams, systemParams, TABLE_AT, PROG_LEN, simulate };
