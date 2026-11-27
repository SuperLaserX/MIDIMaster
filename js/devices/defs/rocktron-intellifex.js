// Rocktron Intellifex LTD (1995 rack multi-effect with Hush noise reduction): MIDI implementation taken
// from the v1.0 EPROM (Jan 1995, 27C256, 8031 at 12 MHz). See docs/devices/rocktron-intellifex.md.
//
// Presets 1-80 are user presets in an 8 KB EEPROM (XRAM 0000-1FFF), 81-160 factory presets in ROM. A
// preset travels as 100 bytes: 55 parameter bytes (XRAM 0A81 + 55n: byte 0 = the configuration 0-5,
// bytes 1.. the values of the configuration's pages in the order of table 320F), the 13-character title
// (1BEF + 13n) and 8 controller assignments of 4 bytes (0081 + 32n: NUMB = MIDI controller 0-120 or 121
// OFF, PARA = one of the configuration's parameters, ULIM / LLIM = the range the controller sweeps).
//
// SysEx F0 00 00 29 02 <op> <each data byte as bits 0-6, then bit 7> <checksum> F7 (sender 058B / 05C2,
// receiver 1A3A; checksum = XOR of the data bytes, 7 bits). Nothing can be requested: the MIDI DUMP/LOAD
// menu sends, and receives only while its PRESET LOAD or LOAD USER DATA page is shown (1B6A).
//   28h   one preset: PRESET DUMP sends the preset chosen on the page; PRESET LOAD stores into the one
//         chosen there (the message has no preset number)
//   2Ah   first message of the user data (DUMP USER DATA / LOAD USER DATA): preset 1; then 81 x 2Bh:
//         presets 2-80, the program map (128 bytes, XRAM 0001) and the globals (6 bytes, 1BE9-1BEE)
// The unit leaves about 1.8 s between those messages (0633) while the receiver writes its EEPROM (0C9B).

import { CONFIGS, PAGES, TWO_TAP_TIMES, UTIL, ROM_NAMES, ROM_PRESETS, CTRL_DEFAULT, RESTORE, FIRMWARE } from './rocktron-intellifex-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';

export { CONFIGS, PAGES, TWO_TAP_TIMES, UTIL, ROM_NAMES, ROM_PRESETS, CTRL_DEFAULT, RESTORE, FIRMWARE };

const HDR = [0xf0, 0x00, 0x00, 0x29, 0x02];
export const OP = { preset: 0x28, userFirst: 0x2a, userNext: 0x2b };
export const P_SIZE = 100;
export const TITLE_AT = 55;
export const TITLE_LEN = 13;
export const CTRL_AT = 68;
export const USER_COUNT = 80;
// the user data as one object: globals (1BE9-1BEE), program map (0001-0080), the 80 presets
export const G = { marker: 0, mapping: 1, bypass: 2, incDec: 3, powerOn: 4, channel: 5 };
export const MAP_AT = 6;
export const PRESETS_AT = MAP_AT + 128;
export const SYS_SIZE = PRESETS_AT + USER_COUNT * P_SIZE;
const DTYPE = 0x23;
const TIME_PAGES = [0x1d, 0x21];

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
export const isIntellifex = (raw) => raw?.[0] === 0xf0 && raw.length > 6 && HDR.every((b, i) => raw[i] === b);
const op = (raw) => raw[5];

// ------------------------------------------------------------------ messages
/** One SysEx message: every byte as bits 0-6 then bit 7, the XOR of those, F7. */
export function message(code, bytes) {
  const body = [];
  let cs = 0;
  for (const b of bytes) {
    const lo = b & 0x7f;
    const hi = (b >> 7) & 1;
    body.push(lo, hi);
    cs ^= lo ^ hi;
  }
  return [...HDR, code, ...body, cs & 0x7f, 0xf7];
}

/** {op, data, ok}: the bytes a message carries and whether its checksum holds (0849). */
export function unpack(raw) {
  const body = raw.slice(6, raw.length - 1);
  const n = (body.length - 1) >> 1;
  const data = new Uint8Array(n);
  let cs = 0;
  for (const b of body) cs ^= b;
  for (let i = 0; i < n; i++) data[i] = (body[2 * i] & 0x7f) | ((body[2 * i + 1] & 1) << 7);
  return { op: op(raw), data, ok: (cs & 0x7f) === 0 && (body.length & 1) === 1 };
}

// ------------------------------------------------------------------ presets
export const configOf = (d) => (d[0] < CONFIGS.length ? d[0] : 0); // 0DED: 6 and up load as 0
/** Byte of the preset holding page `page` in configuration `cfg` (1..54), or -1. */
export const byteOf = (cfg, page) => { const i = CONFIGS[cfg].params.indexOf(page); return i < 0 ? -1 : 1 + i; };
export const valueOf = (d, page) => { const b = byteOf(configOf(d), page); return b < 0 ? undefined : d[b]; };
/** What the display shows for value v of page `page` in preset d (DLY TIME1/2 follow D TYPE). */
export function textsOf(page, d) {
  if (TIME_PAGES.includes(page) && d && valueOf(d, DTYPE) === 2) return TWO_TAP_TIMES;
  return PAGES[page].texts;
}
export const formatValue = (page, v, d) => textsOf(page, d)?.[v] ?? String(v);
export const titleOf = (d) => String.fromCharCode(...d.subarray(TITLE_AT, TITLE_AT + TITLE_LEN));
export const nameOf = (d) => titleOf(d).trim();
/** Title as the unit keeps it: 13 characters from space to '[' (TITLE EDIT, 1698), a space first like the factory titles. */
export function setName(d, name) {
  let s = String(name).toUpperCase().replace(/[^\x20-\x5b]/g, ' ');
  if (s.length < TITLE_LEN && !s.startsWith(' ')) s = ` ${s}`;
  s = s.slice(0, TITLE_LEN).padEnd(TITLE_LEN, ' ');
  for (let i = 0; i < TITLE_LEN; i++) d[TITLE_AT + i] = s.charCodeAt(i);
}
const ctrlAt = (n, k) => CTRL_AT + 4 * n + k;
export const paraMax = (cfg) => CONFIGS[cfg].params.length - 1;
/** Page a controller assignment's PARA points at (0B7C). */
export const paraPage = (d, n) => CONFIGS[configOf(d)].params[Math.min(d[ctrlAt(n, 1)] & 0x3f, paraMax(configOf(d)))];

/** Values the unit would not load (0E2C sets them to 0), PARA beyond the list, limits beyond their page. */
export function fitPreset(d) {
  let changed = 0;
  if (d[0] >= CONFIGS.length) { d[0] = 0; changed++; }
  const cfg = configOf(d);
  CONFIGS[cfg].params.forEach((p, i) => { if (d[1 + i] >= PAGES[p].count) { d[1 + i] = 0; changed++; } });
  for (let i = 0; i < TITLE_LEN; i++) if (d[TITLE_AT + i] < 0x20 || d[TITLE_AT + i] > 0x5b) { d[TITLE_AT + i] = 0x20; changed++; }
  for (let n = 0; n < 8; n++) {
    if (d[ctrlAt(n, 0)] > 121) { d[ctrlAt(n, 0)] = 121; changed++; }
    if (d[ctrlAt(n, 1)] > paraMax(cfg)) { d[ctrlAt(n, 1)] = paraMax(cfg); changed++; }
    const top = PAGES[paraPage(d, n)].count - 1;
    for (const k of [2, 3]) if (d[ctrlAt(n, k)] > top) { d[ctrlAt(n, k)] = top; changed++; }
  }
  return changed;
}
const fitted = (d) => { const x = Uint8Array.from(d); fitPreset(x); return x; };

/** Factory preset n (81 + n on the unit) as the 55 ROM bytes. */
export const romRecord = (n) => hex(ROM_PRESETS[n]);
/** Factory preset n as a user preset: what FACTORY RESTORE writes (10ED: configuration bits 0-2, 6+ as 0;
 *  ROM title; the default controller assignments 2064). */
export function factoryPreset(n) {
  const d = new Uint8Array(P_SIZE);
  d.set(romRecord(n), 0);
  const c = d[0] & 7;
  d[0] = c < 6 ? c : 0;
  for (let i = 0; i < TITLE_LEN; i++) d[TITLE_AT + i] = ROM_NAMES[n].charCodeAt(i);
  d.set(hex(CTRL_DEFAULT), CTRL_AT);
  return d;
}
export const presetMessage = (d, code = OP.preset) => message(code, fitted(d));

// ------------------------------------------------------------------ user data (globals, map, presets)
/** The user data after FACTORY RESTORE with ENTER CODE 249 (108A) or 10 (10AF). */
export function restoredUserData(code = 249) {
  const r = RESTORE[String(code)];
  const s = new Uint8Array(SYS_SIZE);
  s[G.marker] = r.marker;
  s.set(r.globals, 1);
  s.set(r.map, MAP_AT);
  for (let n = 0; n < USER_COUNT; n++) s.set(factoryPreset(n), PRESETS_AT + n * P_SIZE);
  return s;
}
export const userPreset = (s, n) => s.slice(PRESETS_AT + n * P_SIZE, PRESETS_AT + (n + 1) * P_SIZE);
/** The 82 messages of DUMP USER DATA (054F): 2Ah + preset 1, 2Bh + presets 2-80, the map, the globals. */
export function userDataMessages(s) {
  const out = [];
  for (let n = 0; n < USER_COUNT; n++) out.push(message(n ? OP.userNext : OP.userFirst, fitted(userPreset(s, n))));
  out.push(message(OP.userNext, s.subarray(MAP_AT, MAP_AT + 128)));
  out.push(message(OP.userNext, s.subarray(0, 6)));
  return out;
}
/** User data from the messages of a dump (null unless all 82 are there, in order, with good checksums). */
export function userDataFrom(msgs) {
  const own = msgs.filter((m) => isIntellifex(m) && (op(m) === OP.userFirst || op(m) === OP.userNext));
  const start = own.findIndex((m) => op(m) === OP.userFirst);
  if (start < 0 || own.length - start < USER_COUNT + 2) return null;
  const parts = own.slice(start, start + USER_COUNT + 2).map(unpack);
  if (!parts.every((p, i) => p.ok && (i === 0 || p.op === OP.userNext))) return null;
  if (parts.slice(0, USER_COUNT).some((p) => p.data.length !== P_SIZE) || parts[USER_COUNT].data.length !== 128 || parts[USER_COUNT + 1].data.length !== 6) return null;
  const s = new Uint8Array(SYS_SIZE);
  parts.slice(0, USER_COUNT).forEach((p, n) => s.set(p.data, PRESETS_AT + n * P_SIZE));
  s.set(parts[USER_COUNT].data, MAP_AT);
  s.set(parts[USER_COUNT + 1].data, 0);
  return s;
}

// ------------------------------------------------------------------ listening for front-panel dumps
/** Wait for messages the unit sends from its MIDI DUMP/LOAD menu (nothing can request them). */
function listen(api, { done, first = 90000, gap = 10000, hint }) {
  const tr = api.g?.transport;
  if (!tr?.on) return Promise.reject(new Error('No MIDI input is open to receive the dump.'));
  if (hint) api.toast?.(hint, 'info');
  return new Promise((resolve, reject) => {
    const got = [];
    let off = null;
    const fail = () => {
      off?.();
      reject(new Error(got.length ? `The dump stopped after ${got.length} message${got.length === 1 ? '' : 's'}.` : 'Nothing arrived from the Intellifex: start the dump on its MIDI DUMP/LOAD menu.'));
    };
    let timer = setTimeout(fail, first);
    off = tr.on('sysex', (d) => {
      if (!isIntellifex(d)) return;
      got.push(Uint8Array.from(d));
      clearTimeout(timer);
      if (done(got)) { off(); resolve(got); } else timer = setTimeout(fail, gap);
    });
  });
}
const PRESET_HINT = 'On the Intellifex: MIDI DUMP/LOAD, PRESET DUMP, choose the preset and start the dump.';
const USER_HINT = 'On the Intellifex: MIDI DUMP/LOAD, DUMP USER DATA (82 messages, about 2 1/2 minutes).';
async function receivePreset(api) {
  const got = await listen(api, { done: (g) => op(g.at(-1)) === OP.preset, hint: PRESET_HINT });
  const u = unpack(got.at(-1));
  if (!u.ok || u.data.length !== P_SIZE) throw new Error('The preset dump arrived damaged (checksum or length).');
  return u.data;
}
async function receiveUserData(api) {
  const got = await listen(api, { done: (g) => !!userDataFrom(g), first: 120000, gap: 15000, hint: USER_HINT });
  return userDataFrom(got);
}

// ------------------------------------------------------------------ preset parameters
const blockOfPage = (cfg, page) => CONFIGS[cfg].blocks.find((b) => b.pages.includes(page))?.title;
const pageOptions = (page, d) => { const t = textsOf(page, d); return t ? t.map((x, v) => [v, x]) : null; };
function pageParam(cfg, block, page) {
  const P = PAGES[page];
  const at = byteOf(cfg, page);
  const twice = CONFIGS[cfg].blocks.filter((b) => b.pages.includes(page)).length > 1;
  const base = {
    key: `c${cfg}-${block.block.toString(16)}-${page.toString(16)}`, group: block.title, label: P.label, offset: at, min: 0, max: P.count - 1,
    help: `${P.screen.trim()}: page ${page.toString(16).toUpperCase()}h, preset byte ${at}`, relayout: twice || page === DTYPE,
  };
  const hidden = (d) => configOf(d) !== cfg;
  if (TIME_PAGES.includes(page)) return { ...base, dynamic: (d) => ({ hidden: hidden(d), format: (v) => formatValue(page, v, d) }) };
  if (P.texts && P.count <= 64) return { ...base, options: P.texts.map((t, v) => [v, t]), dynamic: (d) => ({ hidden: hidden(d) }) };
  if (P.texts) return { ...base, format: (v) => P.texts[v] ?? String(v), dynamic: (d) => ({ hidden: hidden(d) }) };
  return { ...base, dynamic: (d) => ({ hidden: hidden(d) }) };
}
const CTRL_GROUP = UTIL.blocks.controller;
const ctrlLabel = (k, n) => [UTIL.labels.numb.replace('1', n + 1), UTIL.labels.para.replace('1', n + 1), UTIL.labels.ulim.replace('1', n + 1), UTIL.labels.llim.replace('1', n + 1)][k];
const paraName = (cfg, i) => { const p = CONFIGS[cfg].params[i]; return `${PAGES[p].screen.slice(0, 10).trim()} (${blockOfPage(cfg, p)})`; };
function ctrlParams(n) {
  const limit = (k) => ({
    key: `ctrl${n}${k === 2 ? 'u' : 'l'}`, group: CTRL_GROUP, label: ctrlLabel(k, n), offset: ctrlAt(n, k), min: 0, max: 255,
    help: `${k === 2 ? 'Upper' : 'Lower'} end of the range controller ${n + 1} sweeps, in the values of its PARA (0C06)`,
    dynamic: (d) => { const p = paraPage(d, n); return { options: (pageOptions(p, d) || Array.from({ length: PAGES[p].count }, (_, v) => [v, String(v)])) }; },
  });
  return [
    { key: `ctrl${n}n`, group: CTRL_GROUP, label: ctrlLabel(0, n), offset: ctrlAt(n, 0), options: UTIL.numb.map((t, v) => [v, t]),
      help: `MIDI controller number that drives assignment ${n + 1} (0-120; 121 = OFF, 1B27 takes controllers below 121)` },
    { key: `ctrl${n}p`, group: CTRL_GROUP, label: ctrlLabel(1, n), offset: ctrlAt(n, 1), min: 0, max: 63, relayout: true,
      help: 'The parameter it changes: one of the configuration\'s parameters (preset byte = PARA + 1)',
      dynamic: (d) => ({ options: CONFIGS[configOf(d)].params.map((_, i) => [i, paraName(configOf(d), i)]) }),
      // 0438: choosing PARA sets ULIM to the parameter's top value and LLIM to its lowest
      after: (d) => { d[ctrlAt(n, 2)] = PAGES[paraPage(d, n)].count - 1; d[ctrlAt(n, 3)] = 0; return `${ctrlLabel(2, n)} and ${ctrlLabel(3, n)} set to the parameter's full range, as the unit does.`; } },
    limit(2), limit(3),
  ];
}
export const presetParams = [
  { key: 'config', group: 'Preset', label: 'Configuration', offset: 0, options: CONFIGS.map((c, i) => [i, c.name]), relayout: true,
    help: 'Preset byte 0: the effect chain (names from 45A0, in the display\'s arrow letters). The bytes after it change meaning with it.',
    after: (d) => (fitPreset(d) ? 'Values outside the new configuration\'s ranges set to their lowest (as the unit loads them).' : null) },
  ...CONFIGS.flatMap((c, cfg) => c.blocks.flatMap((b) => b.pages.map((p) => pageParam(cfg, b, p)))),
  ...Array.from({ length: 8 }, (_, n) => ctrlParams(n)).flat(),
  ...Array.from({ length: TITLE_LEN }, (_, i) => ({ key: `title${i}`, group: 'Preset', label: `Title ${i + 1}`, offset: TITLE_AT + i, min: 0x20, max: 0x5b, kind: 'char', hidden: true })),
];

// ------------------------------------------------------------------ user data parameters
const PRESET_LABELS = Array.from({ length: 160 }, (_, i) => `${i + 1}${i >= 80 ? ` ${ROM_NAMES[i - 80].trim()}` : ''}`);
const presetChoice = (s) => PRESET_LABELS.map((l, i) => [i, i < 80 && s ? `${i + 1} ${nameOf(userPreset(s, i))}` : l]);
export const systemParams = [
  { key: 'marker', group: 'Memory', label: 'Memory check byte', offset: G.marker, options: [[0x17, '17h: FACTORY RESTORE code 249'], [0x0a, '0Ah: FACTORY RESTORE code 10']],
    help: 'XRAM 1BE9: the power-on test (009C) wants 17h or 0Ah, else it shows EXT MEMORY ERRORS. Code 2 on the FACTORY RESTORE page repeats the restore this byte names (04E7).' },
  { key: 'powerOn', group: 'Memory', label: 'PWR ON PR', offset: G.powerOn, min: 0, max: 159,
    help: 'XRAM 1BED: the preset recalled at power-on (009C; values from 160 up start at 160). Stored from the unit\'s preset select page ("PWR ON PR STORED", 03C3).',
    dynamic: (s) => ({ options: presetChoice(s) }) },
  { key: 'channel', group: UTIL.blocks.channel, label: UTIL.labels.midiChannel, offset: G.channel, options: UTIL.midiChannel.map((t, v) => [v, t]),
    help: 'XRAM 1BEE: channel for program changes and controllers (1ACF); OMNI takes every channel, OFF none. SysEx ignores it.' },
  { key: 'bypass', group: UTIL.blocks.footswitch, label: UTIL.labels.bypass, offset: G.bypass, options: UTIL.footswitch.map((t, v) => [v, t]),
    help: 'XRAM 1BEB: how the bypass footswitch is read (1599). The LTD v1.0 menu tables (3944) never reach the FOOTSWITCH TYPES block, so only MIDI or a restore sets it.' },
  { key: 'incDec', group: UTIL.blocks.footswitch, label: UTIL.labels.incDec, offset: G.incDec, options: UTIL.footswitch.map((t, v) => [v, t]),
    help: 'XRAM 1BEC: how the INC/DEC footswitches are read (15A2); not on the LTD\'s menus either.' },
  { key: 'mapping', group: UTIL.blocks.mapping, label: UTIL.labels.progMapping, offset: G.mapping, options: UTIL.offOn.map((t, v) => [v, t]),
    help: 'XRAM 1BEA: ON looks program changes up in the map below (1B06), OFF recalls preset = program + 1.' },
  ...Array.from({ length: 128 }, (_, n) => ({
    key: `map${n}`, group: UTIL.blocks.mapping, label: `${n + 1} ${UTIL.labels.mapTo}`, offset: MAP_AT + n, min: 0, max: 160,
    help: `Program change ${n + 1} (number ${n}) recalls this preset while PROG MAPPING is ON; OFF ignores it (XRAM ${(n + 1).toString(16).toUpperCase().padStart(4, '0')})`,
    options: [...PRESET_LABELS.map((l, i) => [i, l]), [160, UTIL.mapTo[160]]],
  })),
];

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { user: restoredUserData(249), loadPage: 'any', presetTarget: 0, rx: -1, current: 0 };
  const accepts = (what) => st.loadPage === 'any' || st.loadPage === what;
  return {
    state: st,
    /** What the unit sends from its MIDI DUMP/LOAD menu. */
    panel(action, n = 0) {
      if (action === 'PRESET DUMP') return [message(OP.preset, userPreset(st.user, n))];
      if (action === 'DUMP USER DATA') return userDataMessages(st.user);
      return [];
    },
    handle(d) {
      if ((d[0] & 0xf0) === 0xc0) {
        const ch = st.user[G.channel];
        if (ch === 17 || (ch !== 16 && ch !== (d[0] & 15))) return [];
        const p = st.user[G.mapping] ? st.user[MAP_AT + d[1]] : d[1];
        if (p < 160) st.current = p;
        return [];
      }
      if (d[0] !== 0xf0) return null;
      if (!isIntellifex(d)) return [];
      const u = unpack(d);
      if (!u.ok) return [];
      if (u.op === OP.preset && accepts('PRESET LOAD') && u.data.length === P_SIZE) st.user.set(u.data, PRESETS_AT + st.presetTarget * P_SIZE);
      else if (u.op === OP.userFirst && accepts('LOAD USER DATA') && u.data.length === P_SIZE) { st.user.set(u.data, PRESETS_AT); st.rx = 1; }
      else if (u.op === OP.userNext && st.rx > 0) {
        if (st.rx < USER_COUNT && u.data.length === P_SIZE) st.user.set(u.data, PRESETS_AT + st.rx * P_SIZE);
        else if (st.rx === USER_COUNT && u.data.length === 128) st.user.set(u.data, MAP_AT);
        else if (st.rx === USER_COUNT + 1 && u.data.length === 6) st.user.set(u.data, 0);
        st.rx = st.rx > USER_COUNT ? -1 : st.rx + 1;
      }
      return [];
    },
  };
}

// ------------------------------------------------------------------ monitor, library
function describe(raw) {
  if (!isIntellifex(raw)) return null;
  const u = unpack(raw);
  const bad = u.ok ? '' : ' (checksum error)';
  const what = u.data.length === P_SIZE ? `preset "${nameOf(u.data)}" (${CONFIGS[configOf(u.data)].name})` : u.data.length === 128 ? 'program map' : u.data.length === 6 ? 'globals' : `${u.data.length} bytes`;
  if (u.op === OP.preset) return `Intellifex PRESET DUMP: ${what}${bad}`;
  if (u.op === OP.userFirst) return `Intellifex USER DATA 1/82: ${what}${bad}`;
  if (u.op === OP.userNext) return `Intellifex USER DATA: ${what}${bad}`;
  return `Intellifex message ${u.op.toString(16)}h${bad}`;
}
function libraryItems(msgs) {
  const items = [];
  const s = userDataFrom(msgs);
  let n = 0;
  for (const m of msgs) {
    if (!isIntellifex(m)) { items.push({ key: `x${items.length}`, label: 'Other message', name: '', object: null, msgs: [m] }); continue; }
    const u = unpack(m);
    if (u.ok && u.data.length === P_SIZE && u.op === OP.preset) {
      items.push({ key: `p${items.length}`, label: 'Preset (PRESET DUMP)', name: nameOf(u.data), object: 'effect', data: u.data, msgs: [m] });
    } else if (u.ok && u.data.length === P_SIZE && (u.op === OP.userFirst || u.op === OP.userNext)) {
      if (u.op === OP.userFirst) n = 0;
      // sent back alone, a preset goes through PRESET LOAD: the unit takes 2Bh only after a 2Ah
      items.push({ key: `u${n}`, label: `User preset ${n + 1}`, name: nameOf(u.data), object: 'effect', data: u.data, msgs: [Uint8Array.from(message(OP.preset, u.data))] });
      n++;
    } else if (!s) items.push({ key: `s${items.length}`, label: describe(m), name: '', object: null, msgs: [m] });
  }
  if (s) {
    const own = msgs.filter((m) => isIntellifex(m) && (op(m) === OP.userFirst || op(m) === OP.userNext));
    items.push({ key: 'system', label: 'User data (globals, program map and the 80 presets)', name: '', object: 'system', data: s, msgs: own.slice(own.findIndex((m) => op(m) === OP.userFirst)).slice(0, USER_COUNT + 2) });
  }
  return items;
}

// ------------------------------------------------------------------ Head Library translator
// toCommon: reverb (REVERB block or the HUSH>REVERB configuration), delay (DELAY block, DELAY 3 or the
// voice delays with REGEN L), chorus (voice 1's RATE / DEPTH) and pitch shift become effects.reverb,
// effects.delay, effects.modulation / effects.chorus. Levels in dB are turned into gain (0..1, -oo = 0),
// delay times ms / 1500 (the longest: 2-TAP), pre-delay ms / 209, decay and damping of their 0-99 range.
// Exact bytes in extra (family 'rocktron-intellifex'). fromCommon: the same family loads the bytes;
// anything else picks the configuration, starts from the first factory preset that uses it and sets
// what maps. Hush, the ducker, pans and the controller assignments stay as the factory preset has them.
const FAMILY = 'rocktron-intellifex';
const DELAY_MAX_MS = 1500;
const SEM = [
  { reverb: { level: 0x08, decay: 0x2a }, chorus: { level: 0x06, rate: 0x12, depth: 0x11 }, delay: { level: 0x07, time: 0x40, feedback: 0x61 } },
  { reverb: { level: 0x08, decay: 0x2a }, pitch: { level: 0x2d }, delay: { level: 0x07, time: 0x45, feedback: 0x61 } },
  { reverb: { level: 0x32, decay: 0x2a, type: 0x37, preDelay: 0x39, preDelayR: 0x3a } },
  { delay: { level: 0x33, time: 0x1d, feedback: 0x1e, type: 0x23 } },
  { chorus: { level: 0x34, rate: 0x12, depth: 0x11 }, delay: { level: 0x34, time: 0x40, feedback: 0x61 } },
  { pitch: { level: 0x35 }, delay: { level: 0x35, time: 0x40, feedback: 0x61 } },
];
const dbOf = (t) => (/oo/.test(t) ? -Infinity : parseFloat(String(t).replace(/\s+/g, '')));
const gain = (db) => (db === -Infinity ? 0 : Math.min(1, 10 ** (db / 20)));
const msOf = (t) => parseInt(t, 10);
function nearestIndex(texts, wanted, score) {
  let best = 0;
  let bd = Infinity;
  texts.forEach((t, i) => { const x = Math.abs(score(t) - wanted); if (x < bd) { bd = x; best = i; } });
  return best;
}
function toCommon(d) {
  const cfg = configOf(d);
  const s = SEM[cfg];
  const text = (page) => formatValue(page, valueOf(d, page), d);
  const lvl = (page) => gain(dbOf(text(page)));
  const effects = {};
  if (s.reverb) {
    effects.reverb = { type: s.reverb.type ? text(s.reverb.type) : 'REVERB', level: lvl(s.reverb.level), time: valueOf(d, s.reverb.decay) / 99 };
    if (s.reverb.preDelay) effects.reverb.preDelay = msOf(text(s.reverb.preDelay)) / 209;
  }
  if (s.delay) {
    effects.delay = { type: s.delay.type ? text(s.delay.type) : 'DELAY', level: lvl(s.delay.level), time: Math.min(1, msOf(text(s.delay.time)) / DELAY_MAX_MS), feedback: lvl(s.delay.feedback) };
  }
  if (s.chorus) {
    const m = { type: cfg === 4 ? '8V-CHORUS' : 'CHORUS', level: lvl(s.chorus.level), rate: valueOf(d, s.chorus.rate) / 254, depth: valueOf(d, s.chorus.depth) / 100 };
    effects.modulation = m;
    effects.chorus = { ...m };
  }
  if (s.pitch) effects.modulation = { type: 'PITCH SHIFT', level: lvl(s.pitch.level) };
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'rocktron-intellifex', configuration: CONFIGS[cfg].name, data: Array.from(d), match: hashBytes(d) } };
}
function pickConfig(fx) {
  const on = (e) => e && (e.level ?? 1) > 0;
  const rv = on(fx.reverb);
  const dl = on(fx.delay);
  const md = [fx.modulation, fx.chorus].find(on);
  const pitch = md && /PITCH|SHIFT|OCTAV|HARMON/i.test(md.type || '');
  if (pitch) return rv ? 1 : 5;
  if (md) return rv ? 0 : 4;
  if (rv && dl) return 0;
  if (rv) return 2;
  if (dl) return 3;
  return -1;
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === P_SIZE) {
    const d = Uint8Array.from(x.data);
    if (fitPreset(d)) r.approximated.push('Values outside their ranges limited');
    r.mapped.push(`Preset (exact, ${CONFIGS[configOf(d)].name})`);
    return { data: d, report: tidy(r) };
  }
  const fx = c?.effects || {};
  const cfg = pickConfig(fx);
  if (cfg < 0) {
    r.dropped.push('No effect in the source sound: the preset keeps its configuration and settings');
    return { data: Uint8Array.from(base || factoryPreset(0)), report: tidy(r) };
  }
  let n = ROM_PRESETS.findIndex((h) => (parseInt(h.slice(0, 2), 16) & 7) === cfg);
  if (n < 0) n = 0;
  const d = factoryPreset(n);
  r.approximated.push(`Configuration ${CONFIGS[cfg].name}, starting from factory preset ${81 + n} "${ROM_NAMES[n].trim()}"`);
  const s = SEM[cfg];
  const put = (page, i, what) => { const b = byteOf(cfg, page); if (b > 0 && i !== undefined && !Number.isNaN(i)) { d[b] = Math.max(0, Math.min(PAGES[page].count - 1, Math.round(i))); r.approximated.push(what); } };
  const level = (page, g, what) => { if (g === undefined) return; const db = g <= 0 ? -Infinity : 20 * Math.log10(g); put(page, nearestIndex(textsOf(page, d), db === -Infinity ? -1e9 : db, (t) => { const v = dbOf(t); return v === -Infinity ? -1e9 : v; }), what); };
  const ms = (page, u, what) => { if (u === undefined) return; put(page, nearestIndex(textsOf(page, d), u * DELAY_MAX_MS, msOf), what); };
  if (s.reverb && fx.reverb) {
    level(s.reverb.level, fx.reverb.level, 'Reverb level');
    if (fx.reverb.time !== undefined) put(s.reverb.decay, fx.reverb.time * 99, 'Reverb time → REVERB DECAY');
    if (s.reverb.type) {
      const t = String(fx.reverb.type || '').toUpperCase();
      const i = /PLATE/.test(t) ? 0 : /ROOM|CHAMBER|AMBIEN/.test(t) ? 2 : /STADIUM|ARENA/.test(t) ? 6 : 4;
      put(s.reverb.type, i, `Reverb type → ${PAGES[s.reverb.type].texts[i]}`);
    }
    if (s.reverb.preDelay && fx.reverb.preDelay !== undefined) {
      put(s.reverb.preDelay, fx.reverb.preDelay * 209, 'Pre-delay → PREDELAY L');
      put(s.reverb.preDelayR, fx.reverb.preDelay * 209, 'Pre-delay → PREDELAY R');
    }
  } else if (s.reverb) level(s.reverb.level, 0, 'No reverb: REVERB LVL -oo');
  if (s.delay && fx.delay && s.delay.level !== s.chorus?.level && s.delay.level !== s.pitch?.level) level(s.delay.level, fx.delay.level, 'Delay level');
  if (s.delay && fx.delay) {
    ms(s.delay.time, fx.delay.time, 'Delay time');
    level(s.delay.feedback, fx.delay.feedback, 'Delay feedback → regeneration');
  }
  const m = [fx.modulation, fx.chorus].find((e) => e && (e.level ?? 1) > 0);
  if (s.chorus) {
    if (m) {
      level(s.chorus.level, m.level, 'Chorus level');
      if (m.rate !== undefined) put(s.chorus.rate, m.rate * 254, 'Chorus rate → RATE 1');
      if (m.depth !== undefined) put(s.chorus.depth, m.depth * 100, 'Chorus depth → DEPTH 1');
    } else level(s.chorus.level, 0, 'No chorus: CHORUS LVL -oo');
  }
  if (s.pitch && m) { level(s.pitch.level, m.level, 'Pitch shift level'); r.dropped.push('Pitch intervals (the factory preset\'s are kept)'); }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
  if (base) setName(d, nameOf(base));
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ definition
const pad3 = (n) => String(n).padStart(3, ' ');
let rxIndex = -1;
export default {
  coverage: `Presets (all six configurations: every page with its display label and the text the display routine shows for each value; title; the eight controller assignments), the 80 factory presets, the globals and the program map, from ${FIRMWARE}. Dumps are started on the unit (MIDI DUMP/LOAD): the editor listens for PRESET DUMP and DUMP USER DATA and sends what PRESET LOAD and LOAD USER DATA take. Not checked on hardware.`,
  sysex: { manufacturer: [0x00, 0x00, 0x29], model: 0x02 },
  minGap: 2000, // the unit's own pace between dump messages (0633) while it writes the EEPROM
  describe,
  recognise: isIntellifex,
  isOwn: isIntellifex,
  isRequest: () => false, // the Intellifex answers no request
  // complete dump: started on the unit; 82 messages about 1.8 s apart (0633)
  panelDump: { text: 'MIDI DUMP/LOAD > DUMP USER DATA (82 messages, about 2 1/2 min)', quiet: 4000, expect: USER_COUNT + 2 },
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Preset', icon: '◆', label: 'Preset', size: P_SIZE, notLive: true,
      init: () => factoryPreset(0),
      fetch: receivePreset,
      receive: (raw) => { if (!isIntellifex(raw) || op(raw) !== OP.preset) return null; const u = unpack(raw); return u.ok && u.data.length === P_SIZE ? u.data : null; },
      params: presetParams,
      name: nameOf,
      setName,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 4,
      note: 'The Intellifex takes no edits over MIDI: change the preset here, then put the unit on MIDI DUMP/LOAD > PRESET LOAD with the preset number to write and press Send. A preset the unit sends with PRESET DUMP shows up here by itself.',
      sendAll: { label: 'Send to PRESET LOAD', title: 'Send the preset (28h); the unit stores it into the preset chosen on its PRESET LOAD page', build: (data) => presetMessage(data) },
      toSyx: (data) => presetMessage(data),
      fromSyx: (msgs) => { const m = msgs.find((r) => isIntellifex(r) && unpack(r).data.length === P_SIZE); return m ? unpack(m).data : null; },
      actions: [
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Preset title', [{ key: 'name', label: 'Title (13 characters: A-Z, 0-9, space and punctuation up to [)', value: titleOf(api.data), maxlength: TITLE_LEN }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          setName(d, r.name);
          api.setData(d);
        } },
      ],
      slots: {
        label: 'Presets', banks: [[0, 'User 1-80'], [1, 'Factory 81-160']], count: USER_COUNT,
        slotLabel: (bank, i) => pad3(bank ? 81 + i : 1 + i),
        note: (bank) => (bank ? 'Factory presets are in ROM; Edit loads one as FACTORY RESTORE copies it into a user preset. '
          : 'Read waits for PRESET DUMP of that preset; Read names waits for DUMP USER DATA. Write sends the preset to PRESET LOAD: choose its number on the unit first. ')
          + 'Play sends a program change (program = preset - 1, as with PROG MAPPING OFF; 129-160 need the map).',
        names: (bank) => (bank === 1 ? ROM_NAMES.map((s) => s.trim()) : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => { const p = bank ? 80 + i : i; return p < 128 ? [[0xc0 | ((ctx?.channel ?? 0) & 15), p]] : []; },
        fetch: async (api, bank, i) => (bank === 1 ? factoryPreset(i) : receivePreset(api)),
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { ROM_NAMES.forEach((s, i) => onName(i, s.trim())); return; }
          const s = await receiveUserData(api);
          for (let i = 0; i < USER_COUNT; i++) onName(i, nameOf(userPreset(s, i)));
        },
        scanNote: (bank) => (bank ? null : USER_HINT),
        store: (_bank, _i, _ctx, data) => presetMessage(data),
      },
    },
    {
      key: 'system', page: 'User data', icon: '⚙', label: 'User data', size: SYS_SIZE, notLive: true,
      init: () => restoredUserData(249),
      fetch: receiveUserData,
      receive: (raw, data) => {
        if (!isIntellifex(raw) || (op(raw) !== OP.userFirst && op(raw) !== OP.userNext)) return null;
        const u = unpack(raw);
        if (!u.ok) return null;
        if (u.op === OP.userFirst) rxIndex = 0;
        if (rxIndex < 0) return null;
        const s = Uint8Array.from(data);
        if (rxIndex < USER_COUNT && u.data.length === P_SIZE) s.set(u.data, PRESETS_AT + rxIndex * P_SIZE);
        else if (rxIndex === USER_COUNT && u.data.length === 128) s.set(u.data, MAP_AT);
        else if (rxIndex === USER_COUNT + 1 && u.data.length === 6) s.set(u.data, 0);
        else { rxIndex = -1; return null; }
        rxIndex = rxIndex > USER_COUNT ? -1 : rxIndex + 1;
        return s;
      },
      params: systemParams,
      cols: 3,
      layout: [{ group: UTIL.blocks.channel }, { group: 'Memory' }, { group: UTIL.blocks.footswitch }, { group: UTIL.blocks.mapping, wide: true }],
      note: 'Everything DUMP USER DATA sends: the globals, the program map and the 80 user presets (edit those on the Preset page). The unit only takes all of it at once, on LOAD USER DATA: send what was read from it, changed, or the factory contents.',
      actions: [
        { label: 'Send to LOAD USER DATA', title: 'Send all 82 messages (2Ah, 81 x 2Bh), about 2 1/2 minutes; this replaces all 80 user presets', run: async (api) => {
          const ok = await api.confirm('Send user data', 'Put the Intellifex on MIDI DUMP/LOAD > LOAD USER DATA first. This replaces its globals, program map and all 80 user presets with what this page holds.', 'Send');
          if (ok) api.send(userDataMessages(api.data));
        } },
        { label: 'Factory contents (code 249)', title: 'What FACTORY RESTORE with ENTER CODE 249 leaves: program map 1:1 and OFF, OMNI, the factory presets in 1-80', run: (api) => api.setData(restoredUserData(249)) },
        { label: 'Factory contents (code 10)', title: 'What ENTER CODE 10 leaves: its program map ON, channel 1, the factory presets in 1-80', run: (api) => api.setData(restoredUserData(10)) },
      ],
      toSyx: (data) => userDataMessages(data).flat(),
      fromSyx: (msgs) => userDataFrom(msgs),
    },
  ],
  midiNotes: [
    'Dumps are started on the unit: MIDI DUMP/LOAD > PRESET DUMP (one preset) or DUMP USER DATA (everything, 82 messages about 1.8 s apart). The Branch Library\'s "Record a dump" and complete dump record them.',
    'The unit takes SysEx only while MIDI DUMP/LOAD shows PRESET LOAD (one preset, stored into the number chosen there) or LOAD USER DATA (the whole 82-message sequence, which must start with the 2Ah message).',
    'Program change: preset = program + 1 with PROG MAPPING OFF; ON looks it up in the program map (presets 1-160 or OFF). MIDI CHANNL OMNI takes every channel, OFF none.',
    'Controllers: each preset has eight assignments (NUMB = controller 0-120, PARA = parameter, ULIM / LLIM = range); controller changes are taken while the current preset is a user preset (1AF1: below 81).',
  ],
};

export const _test = { simulate, toCommon, fromCommon, pickConfig, listen };
