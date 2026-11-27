// Alesis Microverb 4 (1995 half-rack reverb and effects): MIDI implementation taken from the C4C v1.02
// firmware (8051 code, 2-31-0066; the Wedge / MIDIVerb 4 software family, with a 3-digit LED instead of
// their LCD). See docs/devices/alesis-microverb4.md.
//
// 100 preset programs (table C2A2) and 100 user programs. A program is one of 32 configurations with 16
// parameters, but only two can be edited: Edit A and Edit B, each driving one parameter (or, on MULTI TAP
// DELAY, scaling the tap times). A user program keeps just Edit A, Edit B and the program it builds on:
// the preset of the same number or the user bank's own factory program of that number (table CFA2;
// selected by bit 7 of its first byte, BA75). Two bytes per program in a serial EEPROM.
//
// SysEx F0 00 00 0E 12 <dd> <op> ... F7 (header check B6C5). <dd> is the MIDI channel - 1 (1Dh) unless
// Omni is on. Opcodes (jump table B74D):
//   00 n A B base   current program (B972): user program n with these Edit A / B and base
//   01 (A B base) x 100   every user program (B9C0)       02 n A B base   user program n (B9DF)
//   03              store the current program into its user number (B9F7)
//   40h current, 41h all user programs, 7Fh both (B865); 42h n is read but not answered (as on the Wedge).
// Each program is checked against the Edit A / B maxima of its configuration (BA1A): a value above them
// refuses the message. Identity reply (B7A5): F0 7E dd 06 02 00 00 0E 00 00 12 00 01 00 02 00 F7.

import { ALGORITHMS, FORMATS, PRESETS, USER_BASE, PRESET_AB, USER_FACTORY, FIRMWARE } from './alesis-microverb4-fw.js';
import { wedgeTranslator } from './alesis-wedge-translate.js';

export { ALGORITHMS, FORMATS, PRESETS, USER_BASE, PRESET_AB, USER_FACTORY, FIRMWARE };
const HDR = [0xf0, 0x00, 0x00, 0x0e, 0x12];
export const SIZE = 4; // [program number, base (0 = preset, 1 = user factory), Edit A, Edit B]
const REC = 26;
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad2 = (n) => String(n).padStart(2, '0');
const dev = (ctx) => (ctx?.channel ?? 0) & 0x0f;
export const isMicroverb4 = (raw) => raw?.[0] === 0xf0 && HDR.every((b, i) => raw[i] === b);
const op = (raw) => raw[6];

/** The 26-byte program a user program builds on: preset n (base 0) or the user bank's factory program n. */
export const baseRecord = (n, base) => hex((base ? USER_BASE : PRESETS)[Math.min(99, n)]);
const recName = (r) => String.fromCharCode(...r.slice(2, 10)).trimEnd();
const algOf = (d) => ALGORITHMS[baseRecord(d[0], d[1])[1]];
export const nameOf = (d) => recName(baseRecord(d[0], d[1]));

/** Label of Edit A (k = 0) or B (1) in configuration `a`: the long name of the parameter it drives. */
export function knobInfo(a, k) {
  const kn = a.knobs[k];
  const names = kn.param.map((i) => {
    const pg = a.pages.find((p) => p.page === i >> 2);
    const long = pg ? pg.long[i & 3] : '';
    return (long || pg?.cols[i & 3] || `Parameter ${i + 1}`).replace(/^TAP TO SET /, '').replace(/ (HUNDREDS|TENS DIGIT|ONES DIGIT)$/, '');
  });
  const label = kn.param.length > 1 ? `${[...new Set(names)].join(', ')} (together)` : names[0];
  return { label, max: kn.max, texts: FORMATS[kn.fmt].texts, params: kn.param };
}

export function fitProgram(d) {
  let changed = 0;
  const a = algOf(d);
  for (const k of [0, 1]) if (d[2 + k] > a.knobs[k].max) { d[2 + k] = a.knobs[k].max; changed++; }
  return changed;
}
const fitted = (d) => { const x = Uint8Array.from(d); fitProgram(x); return x; };

export const msg = {
  request: (ctx, code) => [...HDR, dev(ctx), code, 0xf7],
  current: (ctx, d) => [...HDR, dev(ctx), 0x00, d[0] & 0x7f, d[2] & 0x7f, d[3] & 0x7f, d[1] & 1, 0xf7],
  all: (ctx, progs) => [...HDR, dev(ctx), 0x01, ...progs.flatMap((d) => [d[2] & 0x7f, d[3] & 0x7f, d[1] & 1]), 0xf7],
  program: (ctx, n, d) => [...HDR, dev(ctx), 0x02, n & 0x7f, d[2] & 0x7f, d[3] & 0x7f, d[1] & 1, 0xf7],
  store: (ctx) => [...HDR, dev(ctx), 0x03, 0xf7],
};
const fromCurrent = (m) => Uint8Array.from([m[7], m[10] & 1, m[8], m[9]]);
const fromAll = (m) => Array.from({ length: 100 }, (_, n) => Uint8Array.from([n, m[9 + 3 * n] & 1, m[7 + 3 * n], m[8 + 3 * n]]));

/** Preset n as a program (its Edit A / B from table C0A2, base 0). */
export const presetProgram = (n) => Uint8Array.from([n, 0, PRESET_AB[n][0], PRESET_AB[n][1]]);
/** User program n as a reset leaves it (table C1A2: bit 7 of A = builds on the user factory program). */
export const userFactoryProgram = (n) => Uint8Array.from([n, USER_FACTORY[n][0] >> 7, USER_FACTORY[n][0] & 0x7f, USER_FACTORY[n][1]]);

const sendCurrent = (_v, ctx, data) => msg.current(ctx, fitted(data));
const params = [
  { key: 'number', group: 'Program', label: 'Program number', offset: 0, sendKey: 'cur', send: sendCurrent, relayout: true,
    help: 'User program number 00-99; the program builds on the preset or factory program of this number',
    dynamic: (d) => ({ options: Array.from({ length: 100 }, (_, n) => [n, `${pad2(n)} ${recName(baseRecord(n, d[1]))}`]) }) },
  { key: 'base', group: 'Program', label: 'Builds on', offset: 1, sendKey: 'cur', send: sendCurrent, relayout: true,
    help: 'Bit 7 of the stored Edit A byte: which ROM program the user program uses (BA75: table C2A2 or CFA2)',
    dynamic: (d) => ({ options: [[0, `Preset ${pad2(d[0])} ${recName(baseRecord(d[0], 0))}`], [1, `User factory ${pad2(d[0])} ${recName(baseRecord(d[0], 1))}`]] }),
    after: (d) => (fitProgram(d) ? 'Edit A / B limited to the new configuration\'s maxima.' : null) },
  { key: 'config', group: 'Program', label: 'Configuration', offset: 0, readOnly: true, get: (d) => baseRecord(d[0], d[1])[1], set: () => {},
    options: ALGORITHMS.map((a, n) => [n, a.name]), help: 'The configuration of the program it builds on (byte 1 of the ROM program)' },
  ...[0, 1].map((k) => ({
    key: k ? 'editB' : 'editA', group: 'Edit knobs', label: k ? 'Edit B' : 'Edit A', offset: 2 + k, min: 0, max: 127, sendKey: 'cur', send: sendCurrent,
    dynamic: (d) => {
      const kn = knobInfo(algOf(d), k);
      return { label: `Edit ${'AB'[k]}: ${kn.label}`, max: kn.max, options: kn.texts.map((t, v) => [v, t]), help: `Edit ${'AB'[k]} knob, ${kn.texts[0]} to ${kn.texts[kn.max]} as the LED shows it` };
    },
  })),
];

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { current: userFactoryProgram(0), user: Array.from({ length: 100 }, (_, n) => userFactoryProgram(n)), channel: 0 };
  const ok = (p) => { const a = algOf(p); return p[2] <= a.knobs[0].max && p[3] <= a.knobs[1].max; };
  return {
    state: st,
    handle(d) {
      if (d[0] === 0xf0 && d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) return [[0xf0, 0x7e, st.channel, 0x06, 0x02, 0, 0, 0x0e, 0, 0, 0x12, 0, 0x01, 0, 0x02, 0, 0xf7]];
      if (!isMicroverb4(d) || d[5] !== st.channel) return isMicroverb4(d) ? [] : null;
      const k = op(d);
      const c = { channel: st.channel };
      if (k === 0x40) return [msg.current(c, st.current)];
      if (k === 0x41) return [msg.all(c, st.user)];
      if (k === 0x7f) return [msg.current(c, st.current), msg.all(c, st.user)];
      if (k === 0) { const p = fromCurrent(d); st.current = p; return []; }
      if (k === 1) { const ps = fromAll(d); if (ps.every(ok)) st.user = ps; return []; }
      if (k === 2) { const p = Uint8Array.from([d[7], d[10] & 1, d[8], d[9]]); if (ok(p)) st.user[d[7]] = p; return []; }
      if (k === 3) { st.user[st.current[0]] = Uint8Array.from(st.current); return []; }
      return [];
    },
  };
}

// ------------------------------------------------------------------ monitor, library
const OPS = { 0: 'current program', 1: 'user programs', 2: 'user program', 3: 'store current program' };
function describe(raw) {
  if (!isMicroverb4(raw)) return null;
  const k = op(raw);
  if (k & 0x40) return `Microverb 4 request ${k === 0x7f ? 'everything' : OPS[k & 0x3f] || k.toString(16)}`;
  if (k === 0 || k === 2) { const p = Uint8Array.from([raw[7], raw[10] & 1, raw[8], raw[9]]); return `Microverb 4 ${OPS[k]} ${pad2(p[0])} "${nameOf(p)}" A ${p[2]} B ${p[3]}`; }
  return `Microverb 4 ${OPS[k] || `opcode ${k}`}`;
}
function libraryItems(msgs, ctx) {
  const items = [];
  for (const m of msgs) {
    if (!isMicroverb4(m)) { items.push({ key: `x${items.length}`, label: 'Other message', name: '', object: null, msgs: [m] }); continue; }
    const k = op(m);
    if (k === 1) fromAll(m).forEach((d, n) => items.push({ key: `u${n}`, label: `User ${pad2(n)}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(msg.program(ctx, n, d))] }));
    else if (k === 0 || k === 2) { const d = fromCurrent(m); items.push({ key: `${k ? 'u' : 'c'}${d[0]}`, label: k ? `User ${pad2(d[0])}` : 'Current program', name: nameOf(d), object: 'effect', data: d, msgs: [m] }); }
    else items.push({ key: `s${items.length}`, label: `Microverb 4 ${OPS[k] || 'message'}`, name: '', object: null, msgs: [m] });
  }
  return items;
}
async function readUser(api) {
  const raw = await api.request(msg.request(api.ctx, 0x41), (r) => isMicroverb4(r) && op(r) === 1, (r) => r);
  return fromAll(raw);
}

// ------------------------------------------------------------------ Head Library
// The program as 26 bytes (the ROM program it builds on, with Edit A / B written into the parameter they
// drive when the knob's range is that parameter's), for the translator shared with the Wedge / MIDIVerb 4.
const algInfo = (a, i) => {
  const pg = a.pages.find((p) => p.page === i >> 2);
  if (!pg || !a.max[i] || !((pg.sliders >> (i & 3)) & 1)) return null;
  return { page: pg.page, title: pg.title, label: pg.cols[i & 3], long: pg.long[i & 3], max: a.max[i] };
};
function recordOf(d) {
  const r = baseRecord(d[0], d[1]);
  const a = ALGORITHMS[r[1]];
  [0, 1].forEach((k) => { const kn = a.knobs[k]; if (kn.param.length === 1 && a.max[kn.param[0]] === kn.max) r[10 + kn.param[0]] = d[2 + k]; });
  return r;
}
const TR = wedgeTranslator({
  ALGORITHMS, paramInfo: algInfo, presetData: (i) => (i < 100 ? baseRecord(i, 0) : Uint8Array.from([0, 255])), fitProgram: () => 0,
  setName: () => {}, nameOf: recName, SIZE: REC, at: 10, count: 16, family: 'alesis-microverb4-record', model: 'alesis-microverb4', presets: 100,
});
function toCommon(d) {
  const c = TR.toCommon(recordOf(d));
  c.extra = { ...c.extra, family: 'alesis-microverb4', program: Array.from(d) };
  return c;
}
function fromCommon(c, base) {
  const x = c?.extra;
  if (x?.family === 'alesis-microverb4' && Array.isArray(x.program) && x.program.length === SIZE) {
    const d = Uint8Array.from(x.program);
    return { data: d, report: { mapped: ['Program (exact)'], approximated: fitProgram(d) ? ['Edit A / B limited'] : [], dropped: [] } };
  }
  const { data: r, report } = TR.fromCommon(c, null);
  const cfg = r[1];
  let n = PRESETS.findIndex((h) => hex(h)[1] === cfg);
  let b = 0;
  if (n < 0) { n = USER_BASE.findIndex((h) => hex(h)[1] === cfg); b = 1; }
  if (n < 0) { report.dropped.push('No program uses that configuration: kept the current program'); return { data: Uint8Array.from(base || presetProgram(0)), report }; }
  const d = b ? Uint8Array.from([n, 1, 0, 0]) : presetProgram(n);
  const a = ALGORITHMS[cfg];
  [0, 1].forEach((k) => {
    const kn = a.knobs[k];
    const p = kn.param[0];
    if (kn.param.length === 1 && a.max[p]) d[2 + k] = Math.round((r[10 + p] / a.max[p]) * kn.max);
  });
  fitProgram(d);
  report.approximated = report.approximated.filter((l) => !l.startsWith('Configuration '));
  report.approximated.unshift(`Program ${pad2(n)} (${b ? 'user factory' : 'preset'} "${nameOf(d)}", ${a.name}); only Edit A and Edit B can change`);
  return { data: d, report };
}

// ------------------------------------------------------------------ definition
export default {
  coverage: `User programs (Edit A, Edit B and the program they build on, with the LED text of each knob value and the parameter it drives) and the current program, from ${FIRMWARE}. Preset and factory program names and configurations from the ROM tables. Not checked on hardware.`,
  sysex: { manufacturer: [0x00, 0x00, 0x0e], model: 0x12 },
  minGap: 20,
  describe,
  recognise: isMicroverb4,
  isOwn: isMicroverb4,
  isRequest: (raw) => isMicroverb4(raw) && (op(raw) & 0x40) !== 0,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Current program', size: SIZE, autoLoad: true,
      init: () => userFactoryProgram(0),
      request: (ctx) => msg.request(ctx, 0x40),
      match: (raw) => isMicroverb4(raw) && op(raw) === 0,
      decode: fromCurrent,
      params,
      name: nameOf,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 3,
      note: 'The Microverb 4 edits two values per program, Edit A and Edit B; the rest of the program is the preset or factory program it builds on. Each change sends the current program (opcode 00). Store keeps it in its user number.',
      sendAll: { label: 'Send current program', title: 'Send program number, base, Edit A and Edit B (opcode 00)', build: (data, ctx) => msg.current(ctx, fitted(data)) },
      toSyx: (data, ctx) => msg.current(ctx, fitted(data)),
      fromSyx: (msgs) => { const m = msgs.find((r) => isMicroverb4(r) && (op(r) === 0 || op(r) === 2)); return m ? fromCurrent(m) : null; },
      actions: [{ label: 'Store', title: 'Store the current program into its user number (opcode 03)', run: (api) => api.send(msg.store(api.ctx)) }],
      slots: {
        label: 'Programs', banks: [[0, 'User'], [1, 'Preset']], count: 100,
        slotLabel: (bank, i) => `${bank ? 'Pset' : 'User'} ${pad2(i)}`,
        note: (bank) => (bank ? 'Presets are in ROM; Edit loads one as the start of user program of the same number. ' : 'A user program n always builds on preset n or factory program n. ')
          + 'Play sends Controller 0 (0 = Preset, 1 = User bank) and a program change.',
        names: (bank) => (bank === 1 ? PRESETS.map((h) => recName(hex(h))) : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => [[0xb0 | dev(ctx), 0x00, bank === 1 ? 0 : 1], [0xc0 | dev(ctx), i]],
        fetch: async (api, bank, i) => (bank === 1 ? presetProgram(i) : (await readUser(api))[i]),
        scanBank: async (api, bank, onName) => {
          const progs = bank === 1 ? Array.from({ length: 100 }, (_, n) => presetProgram(n)) : await readUser(api);
          progs.forEach((d, i) => onName(i, nameOf(d)));
        },
        // user program i builds on program i: the editor's base choice and knob values go there
        store: (bank, i, ctx, data) => { const d = Uint8Array.from(data); d[0] = i; fitProgram(d); return msg.program(ctx, i, d); },
      },
    },
  ],
  requests: [
    { label: 'Current program', bytes: (ctx) => msg.request(ctx, 0x40) },
    { label: 'User programs (100)', bytes: (ctx) => msg.request(ctx, 0x41) },
    { label: 'Everything (current and user programs)', bytes: (ctx) => msg.request(ctx, 0x7f) },
  ],
  fullDump: ['Everything (current and user programs)'],
  midiNotes: [
    'Program change selects programs 0-99 of the current bank; Controller 0 before it picks the bank (0 = Preset, 1-127 = User).',
    'CC 124 / 125: Omni off / on.',
  ],
};

export const _test = { simulate, recordOf };
