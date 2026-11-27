// Access Virus TI / TI2 (Desktop, Polar, Keyboard): MIDI implementation from Virus Control's own
// parameter description (Software Suite 5.1.7; tools/virus/vc_xml.py, gen_fw.py) and the TI2 OS
// in the suite's firmware.bin, checked on a Virus TI2 over USB. See docs/devices/access-virus-ti2.md.
//
// USB ports: "Virus TI Synth" is the synth engine (every message below goes there and is answered
// there); "Virus TI MIDI" is the MIDI DIN pass-through (USB <-> MIDI In/Out sockets): the synth
// does not answer on it.
//
// SysEx F0 00 20 33 01 dd cc ... F7: 00 20 33 Access, 01 Virus, dd device ID (0-15, 10 = omni:
// any unit answers; replies carry the unit's own ID), cc the command.
//   10 bb pp <256> s1 <256> s2   single (512 bytes: pages A, B | C, D); s1 = sum of dd..byte 264
//                                 & 7F, s2 = sum of dd..byte 521 & 7F. bb 0 = edit buffer (pp 40 =
//                                 single mode, 0-15 = the part of a multi), 1-4 RAM A-D, 5-30 ROM A-Z
//   11 bb pp <256> s              multi (256 bytes); bb 0 pp 7F = the edit buffer, bb 1 = RAM multis (a
//                                 store takes bank 32h for slots 0-15, bank 1 for 16-127 only)
//   30 bb pp / 31 bb pp           single / multi request (the answer is a 10 / 11 message)
//   32 bb / 33 bb                 single / multi bank request (128 messages)
//   70 71 6E 6F pp ii vv          single parameter, pages A B C D: byte 128 * page + ii of part pp
//                                 (40 = single mode, 0-15 a multi part)
//   72 pp ii vv                   multi parameter (ii 32-47 for part pp, 72-78 its switches)
//   73 00 ii vv                   global parameter (Virus Control's page F)
//   34 00                         arrangement request: the multi edit buffer (11 00 7F) and the 16
//                                 part singles (10 00 00-0F)
//   37 00 pp                      controller dump request: the edit buffer as CC / poly pressure
//   38 tt kk                      remote template tt (0-31), record kk (knob 0-31, 32 = the name): 13 tt kk (see below)
//   39 bb / 3A xx yy / 3B xx yy   Virus Control's memory reads: 14 (a 256-byte page, the same for bb 1-4),
//                                 15 / 17 (32 bytes as low-high nibbles: data memory with the templates /
//                                 the host's code memory, 3B 00 00 = the reset vector LJMP 4EE8)
// The host OS's SysEx receiver (3E8F in the common code) takes 10-13, 16, 30-34, 37-3B and 6E-74:
// there is no global or total request (35, 36), so the global settings cannot be read.
// Data bytes are plain 7-bit values.

import { readParam, writeParam, readText } from '../../core/model/memmap.js';
import { pickFiles } from '../../core/ui/dom.js';
import { sysexMessages } from '../../core/midi/smf.js';
import * as FW from './access-virus-ti2-fw.js';
import * as TR from './access-virus-ti2-translate.js';
import * as OS from './access-virus-ti2-os.js';

export const SINGLE_SIZE = 512;
export const MULTI_SIZE = 256;
export const GLOBAL_SIZE = 128;
export const OMNI = 0x10;
export const SINGLE_PART = 0x40;
export const MULTI_STORE_LOW = 0x32;
const MAKER = [0x00, 0x20, 0x33, 0x01];
const PAGES = [0x70, 0x71, 0x6e, 0x6f];

// ------------------------------------------------------------------ messages
const dev = (ctx) => (ctx?.deviceId ?? OMNI) & 0x7f;
const hdr = (ctx, cmd) => [0xf0, ...MAKER, dev(ctx), cmd];
const body = (d) => Array.from(d, (x) => x & 0x7f);
const sum7 = (m, from = 5) => { let s = 0; for (let i = from; i < m.length; i++) s += m[i]; return s & 0x7f; };

export const msg = {
  singleRequest: (ctx, bank, prog) => [...hdr(ctx, 0x30), bank, prog, 0xf7],
  multiRequest: (ctx, bank, prog) => [...hdr(ctx, 0x31), bank, prog, 0xf7],
  singleBankRequest: (ctx, bank) => [...hdr(ctx, 0x32), bank, 0xf7],
  multiBankRequest: (ctx, bank) => [...hdr(ctx, 0x33), bank, 0xf7],
  /** The multi edit buffer and the 16 part singles. */
  arrangementRequest: (ctx) => [...hdr(ctx, 0x34), 0x00, 0xf7],
  /** Remote template tt (0-31), record kk: knob 0-31 (16 is the name record and gets no answer) or 32 = the template name; answered with 13 tt kk. One at a time: the TI drops requests sent together (about 0.15 s each). */
  remoteTemplateRequest: (ctx, tt, kk) => [...hdr(ctx, 0x38), tt & 0x7f, kk & 0x7f, 0xf7],
  /** Single dump: into an edit buffer (bank 0; prog 40 single mode, 0-15 a part) or a RAM slot (bank 1-4). */
  single(ctx, bank, prog, data) {
    const m = [...hdr(ctx, 0x10), bank, prog, ...body(data.slice(0, 256))];
    m.push(sum7(m));
    m.push(...body(data.slice(256, SINGLE_SIZE)));
    m.push(sum7(m), 0xf7);
    return m;
  },
  /** Store a multi into RAM multi slot `slot` (0-127): the OS takes bank 32h for slots 0-15 and bank 1 for 16-127 only (receiver at 41E0; checked on slot 0). */
  multiStore: (ctx, slot, data) => msg.multi(ctx, slot < 16 ? MULTI_STORE_LOW : 1, slot, data),
  multi(ctx, bank, prog, data) {
    const m = [...hdr(ctx, 0x11), bank, prog, ...body(data.slice(0, MULTI_SIZE))];
    m.push(sum7(m), 0xf7);
    return m;
  },
  param: (ctx, page, part, index, value) => [...hdr(ctx, page), part & 0x7f, index & 0x7f, value & 0x7f, 0xf7],
};

export const isVirus = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x00 && raw[2] === 0x20 && raw[3] === 0x33 && raw[4] === 0x01;
export const cmdOf = (raw) => (isVirus(raw) ? raw[6] : -1);

/** Single data from a 10 message: a TI dump (524 bytes), or a Virus A/B/C one (267: pages A and B only). */
export function singleFrom(raw, base = initSingle()) {
  if (cmdOf(raw) !== 0x10) return null;
  const d = Uint8Array.from(base);
  if (raw.length >= 524) {
    d.set(raw.slice(9, 265), 0);
    d.set(raw.slice(266, 522), 256);
  } else if (raw.length >= 267) d.set(raw.slice(9, 265), 0);
  else return null;
  return d;
}
export function multiFrom(raw) {
  if (cmdOf(raw) !== 0x11 || raw.length < 267) return null;
  return Uint8Array.from(raw.slice(9, 265));
}
/** Checksums of a single (both) or multi message hold. */
export function checksumOk(raw) {
  const s = (to) => { let x = 0; for (let i = 5; i <= to; i++) x += raw[i]; return x & 0x7f; };
  if (cmdOf(raw) === 0x10 && raw.length >= 524) return s(264) === raw[265] && s(521) === raw[522];
  if (raw.length >= 267) return s(264) === raw[265];
  return false;
}

// ------------------------------------------------------------------ banks
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const REMOTE_TEMPLATES = Array.from({ length: 32 }, (_, i) => i);
// numbered 00-31 as the OS names them (00 "Init Template", 01-31 "Template Set 01" ... "31")
const templateLabel = (tt) => `Remote template ${String(tt).padStart(2, '0')}`;
export const RAM_BANKS = [1, 2, 3, 4].map((b) => [b, `RAM ${LETTERS[b - 1]}`]);
export const ROM_BANKS = Array.from({ length: 26 }, (_, i) => [5 + i, `ROM ${LETTERS[i]}`]);
export const bankName = (b) => (b === 0 ? 'Edit buffer' : b <= 4 ? `RAM ${LETTERS[b - 1]}` : b <= 30 ? `ROM ${LETTERS[b - 5]}` : `bank ${b}`);
export const slotNumber = (i) => String(i + 1).padStart(3, '0');
const partLabel = (p) => (p === SINGLE_PART ? 'Single mode' : `Part ${p + 1}`);

const TYPE_NAMES = { 0x10: 'single', 0x11: 'multi', 0x30: 'single request', 0x31: 'multi request', 0x32: 'single bank request', 0x33: 'multi bank request', 0x34: 'arrangement request', 0x37: 'controller dump request', 0x13: 'remote template', 0x14: '256-byte memory page (answer to 39)', 0x15: '32 bytes of data memory (answer to 3A)', 0x17: '32 bytes of host code memory (answer to 3B)', 0x38: 'remote template request', 0x39: 'memory page request', 0x3a: 'data memory request', 0x3b: 'code memory request', 0x70: 'page A parameter', 0x71: 'page B parameter', 0x6e: 'page C parameter', 0x6f: 'page D parameter', 0x72: 'multi parameter', 0x73: 'global parameter', 0x74: 'Virus Control parameter' };
export function describe(raw) {
  if (!isVirus(raw)) return null;
  const c = raw[6];
  const what = TYPE_NAMES[c] || `command ${c.toString(16)}`;
  if (c === 0x10) return `Virus single ${raw[7] === 0 ? `edit buffer (${partLabel(raw[8])})` : `${bankName(raw[7])} ${slotNumber(raw[8])}`} "${nameOf(singleFrom(raw) || new Uint8Array(SINGLE_SIZE))}" (${raw.length} bytes)`;
  if (c === 0x11) return `Virus multi ${raw[7] === 0 ? 'edit buffer' : `bank ${raw[7]} ${slotNumber(raw[8])}`} "${multiNameOf(multiFrom(raw) || new Uint8Array(MULTI_SIZE))}"`;
  if (c === 0x13 && raw.length > 19) return `Virus ${templateLabel(raw[7]).toLowerCase()} ${raw[8] === 0x20 ? 'name' : `knob ${raw[8]}`} "${readText(raw, 9, raw[8] === 0x20 ? 16 : 10, (b) => (b < 32 || b > 126 ? 32 : b)).trimEnd()}"`;
  return `Virus ${what} (${raw.length} bytes)`;
}

// ------------------------------------------------------------------ value lists and conditions
// Value texts are the TI2 screen's own (the OS's display lists), in the order its screen offers them (its
// reordering tables: e.g. the modulation destinations alphabetically) and within the positions its range routines
// allow (tools/virus/os_tables.py -> access-virus-ti2-os.js PARAM). Virus Control's list is used only for a
// parameter the OS table does not name (none today). Lists of amounts are shown as a knob with the screen's text.
const NUMERIC_KNOB = (list) => /^(Tab |Val -|Val 0-127|Val Off -63|Val Tempo|Val Num Delaytime|Val Names HyperSaw|Val Name OscShape|Val Name Arp Swing|Val Num PureTuning|Chorus Amount|Chorus Distance|Filter Bank Poles)/.test(list || '');
/** A model's tables: Virus Control's description (fw) and its host OS's tables (os); the Snow brings its own. */
export const makeTables = (fw, os) => ({ FW: fw, OS: os, listMap: new Map(Object.entries(fw.LISTS).map(([k, v]) => [k, new Map(v)])) });
const TABLES = makeTables(FW, OS);
const { listMap } = TABLES;
/** The screen's entries of a parameter: [[stored value, text], ...] in display order (null: not in the OS table). */
export function screenEntries(key, T = TABLES) {
  const os = T.OS.PARAM[key];
  if (!os) return null;
  const [, list, reorder, first, last] = os;
  const texts = T.OS.LISTS[list] || [];
  // a list of names shorter than the range (Original Bank: 30 banks, range 0-127) ends with its last name
  const end = texts.length && last >= texts.length && Number.isNaN(Number(texts[0])) ? texts.length - 1 : last;
  const out = [];
  for (let pos = first; pos <= end; pos++) out.push([reorder === null ? pos : T.OS.REORDER[reorder][pos], texts[pos] ?? String(pos)]);
  return out;
}
/** Options (a selection) or a display format (a continuous amount) for a parameter, with the range the screen allows. */
function display(key, list, min, max, T = TABLES) {
  const entries = screenEntries(key, T);
  if (!entries) {
    if (!T.FW.LISTS[list]) return {};
    const map = T.listMap.get(list);
    if (NUMERIC_KNOB(list) && max - min > 24) return { format: (v) => map.get(v) ?? String(v) };
    return { options: T.FW.LISTS[list].filter(([r]) => r >= min && r <= max) };
  }
  const raws = entries.map(([r]) => r);
  const range = { min: Math.min(...raws), max: Math.max(...raws) };
  const ordered = T.OS.PARAM[key][2] !== null;
  if (!ordered && entries.length > 25 && (NUMERIC_KNOB(list) || !T.FW.LISTS[list])) { const map = new Map(entries); return { ...range, format: (v) => map.get(v) ?? String(v) }; }
  return { ...range, options: entries };
}
/** Internal parameter -> single offset (for ranges that follow another parameter). */
const OS_OFFSET = new Map();
OS.SINGLE.forEach((e, o) => e.forEach(([id]) => OS_OFFSET.set(id, o)));
/** A range that follows another setting (Reverb Predelay: its last position by Reverb Type, the OS's range routine C493). */
function limitByOther(p, key) {
  const dep = OS.PARAM[key]?.[5];
  if (!dep?.by || !OS_OFFSET.has(dep.by)) return;
  const at = OS_OFFSET.get(dep.by);
  const base = p.dynamic;
  p.dynamic = (data) => {
    const r = base ? base(data) : { options: p.options, format: p.format };
    const last = dep.last[Math.min(data[at], dep.last.length - 1)];
    return { ...r, max: last, ...(r.options ? { options: r.options.filter(([v]) => v <= last) } : {}) };
  };
  const by = FW.SINGLE.find(([x]) => x === at);
  p.help = `${p.help}; the screen offers 0 to ${dep.last.join(' / ')} for ${by ? by[1][0] : `byte ${at}`} ${dep.last.map((_, i) => (i < dep.last.length - 1 ? i : 'higher')).join(' / ')}`;
}

/** Offset of every Virus Control single parameter key (conditions name them). */
const KEY_AT = new Map();
for (const [o, ...vs] of FW.SINGLE) for (const v of vs) if (!KEY_AT.has(v[0])) KEY_AT.set(v[0], o);
export const singleOffset = (key) => KEY_AT.get(key);

/** Whether a Virus Control condition holds for this single (tests on other data count as true). */
export function condition(name, data) {
  const c = FW.CONDS[name];
  if (!c) return true;
  const [op, tests, invert] = c;
  const results = tests.map(([key, min, max]) => {
    const o = KEY_AT.get(key);
    return o === undefined ? true : data[o] >= min && data[o] <= max;
  });
  const r = tests.length ? (op === 'and' ? results.every(Boolean) : results.some(Boolean)) : false;
  return invert ? !r : r;
}

// ------------------------------------------------------------------ single
const SECTION = {
  osc: ['Oscillators', 'Oscillator 1', 'Oscillator 1 HyperSaw', 'Oscillator 1 Wavetable', 'Oscillator 2', 'Oscillator 2 HyperSaw', 'Oscillator 2 Wavetable', 'Oscillator 3', 'Suboscillator', 'Noise Oscillator', 'Ring Modulator'],
  filter: ['Filters', 'Filter 1', 'Filter 2', 'Filter Envelope', 'Voice Saturation'],
  amp: ['Amp Envelope', 'Envelope 3', 'Envelope 4'],
  lfo: ['LFOs', 'LFO 1', 'LFO 2', 'LFO 3'],
  mod: ['Assigns', 'Assign Slot 1', 'Assign Slot 2', 'Assign Slot 3', 'Assign Slot 4', 'Assign Slot 5', 'Assign Slot 6', 'Velocity Response', 'Soft Knobs'],
  fx: ['FX Upper', 'FX Lower', 'Patch Distortion', 'Analog Boost', 'Chorus', 'Phaser', 'Delay', 'Reverb', 'EQ', 'Filter Bank', 'Surround'],
  arp: ['Arpeggiator', 'Arpeggiator User Pattern'],
  input: ['Vocoder', 'Input', 'Input Follower', 'Input Ring Modulator'],
  common: ['Patch Common', 'Unison', 'Categories', 'Single Patchmanagement'],
};
const SECTION_OF = new Map(Object.entries(SECTION).flatMap(([k, sets]) => sets.map((s) => [s, k])));
export const SINGLE_SECTIONS = [
  { key: 'common', label: 'Common' }, { key: 'osc', label: 'Oscillators' }, { key: 'filter', label: 'Filters' }, { key: 'amp', label: 'Envelopes' },
  { key: 'lfo', label: 'LFOs' }, { key: 'mod', label: 'Modulation' }, { key: 'fx', label: 'Effects' }, { key: 'arp', label: 'Arpeggiator' },
  { key: 'input', label: 'Vocoder / input' }, { key: 'reserved', label: 'Reserved bytes' },
];
/** Groups whose bytes are a front-panel selection stored with the sound (Virus Control pages). */
const PANEL = new Set(['Oscillators/Select', 'Filters/Filter Select', 'Assigns/Slot Select', 'LFOs/Select', 'FX Upper/Select', 'FX Lower/Select', 'Input Follower/Select']);

/** Page A index n is MIDI controller n; these are performance controls of Virus Control's "Internal MIDI Standard Parameters", never part of a sound. */
const STANDARD_CC = { 1: 'Modulation wheel', 2: 'Breath', 3: 'Controller 3', 4: 'Foot controller', 6: 'Data entry', 7: 'Channel volume', 8: 'Balance', 9: 'Controller 9', 11: 'Expression', 12: 'Controller 12', 13: 'Controller 13', 14: 'Controller 14', 15: 'Controller 15', 16: 'Controller 16', 32: 'Bank select LSB', 38: 'Data entry LSB', 64: 'Hold pedal', 65: 'Portamento pedal', 66: 'Sostenuto pedal', 98: 'NRPN LSB', 99: 'NRPN MSB', 100: 'RPN LSB', 101: 'RPN MSB', 120: 'All sound off', 121: 'Reset controllers', 122: 'Local control', 123: 'All notes off', 124: 'Omni off', 125: 'Omni on', 126: 'Mono on', 127: 'Poly on' };

const variantOf = (v) => ({ key: v[0], label: v[1], group: v[2], min: v[3], max: v[4], def: v[5], list: v[6], cond: v[7] });

// Bytes of the single the TI2 OS has no sound parameter for (its parameter tables, tools/virus/os_tables.py ->
// access-virus-ti2-os.js; docs/devices/access-virus-ti2.md "Reserved bytes"): no screen shows them and a
// parameter message to them is ignored (checked on the unit). Older sounds (formats 8, 9, 11) carry values in
// several of them; the OS keeps whatever a dump brings.
const pageIndex = (o) => `${'ABCD'[o >> 7]} ${o & 127}`;
/** Where formats 8 and 9 kept a parameter the OS 5 has elsewhere: the OS copies it there when such a sound arrives (checked on the unit). */
const OLD_POSITION = { 38: [50, 'Ring Modulator Volume'], 97: [504, 'Unison Mode'], 98: [505, 'Unison Detune'], 99: [506, 'Unison Pan Spread'], 100: [507, 'Unison LFO Phase'], 101: [508, 'Input Mode'], 102: [509, 'Input Select'], 129: [143, 'Arpeggiator Mode'] };
export const FORMATS = { 8: 'format 8 (older TI sounds)', 9: 'format 9 (TI2 ROM sounds)', 11: 'format 11 (OS 4.5 sounds)', 12: 'format 12 (OS 5)' };
/** Status bits the OS keeps in byte 1 (host OS code, docs "Status bytes the Virus keeps"); no screen shows them. */
export const SINGLE_FLAGS = ['edited', 'compare', 'loaded', 'multi load', 'part of a multi', 'older-sound bit 5', 'bit 6 (unused)'];
export const MULTI_FLAGS = ['edited', '', 'loaded by SysEx'];
const flagText = (names) => (v) => { const on = [0, 1, 2, 3, 4, 5, 6].filter((b) => v & (1 << b)).map((b) => names[b] || `bit ${b}`); return `${v.toString(16).toUpperCase().padStart(2, '0')}h${on.length ? `: ${on.join(', ')}` : ''}`; };

/** A byte with no sound parameter in the OS: read-only, kept so a backup restores exactly. */
function reservedByte(o) {
  const p = { key: `s${o}`, offset: o, group: 'Reserved bytes', section: 'reserved', min: 0, max: 127, input: 'number', readOnly: true };
  if (o === 0) return { ...p, label: 'Format', group: 'Single Patchmanagement', section: 'common', format: (v) => FORMATS[v] || `format ${v}`,
    help: 'Internal parameter 0 of the OS (no screen shows it): 12 in every sound the OS 5 writes; a sound with format 8, 9 or 11 is converted when it arrives (Unison, Ring Modulator Volume and Arpeggiator Mode move, newer parameters get their defaults)' };
  const old = OLD_POSITION[o];
  const cc = o < 128 ? OS.CC_NAMES[o] : '';
  if (old) return { ...p, label: `${old[1]} (formats 8-9)`,
    help: `Page ${pageIndex(o)}: where formats 8 and 9 kept ${old[1]}${cc ? ` (the OS calls controller ${o} "${cc}")` : ''}; the OS copies it to byte ${old[0]} when such a sound arrives and leaves this byte as it was. No parameter in the OS 5.` };
  if (o < 128 && (STANDARD_CC[o] || cc === '')) return { ...p, label: `Controller ${o}${cc ? ` (${cc})` : ''}`,
    help: `Page A ${o} is MIDI controller ${o}${cc ? ` ("${cc}" in the OS's controller list)` : ''}: ${OS.SINGLE[o].length || STANDARD_CC[o] ? 'a performance control' : 'no parameter'}, not part of the sound. Older sounds stored the controller's value here (e.g. 127 for Expression); the OS keeps it as it is.` };
  return { ...p, label: `Reserved (${pageIndex(o)})`,
    help: `Page ${pageIndex(o)}: no parameter in the TI2 OS (no screen, parameter messages ignored).${o === 128 ? ' The OS writes 64 here when it converts a format 8 or 9 sound.' : ''} 0 in OS 5 sounds; older sounds may carry a value, which the OS keeps.` };
}

function singleParams() {
  const out = [];
  for (const [offset, ...vs] of FW.SINGLE) {
    const variants = vs.map(variantOf);
    const v0 = variants[0];
    if (v0.group === 'Single Patch Name') continue;
    if (v0.group === 'Internal MIDI Standard Parameters') { out.push(reservedByte(offset)); continue; }
    const p = {
      key: `s${offset}`, offset, label: v0.label, group: v0.group, section: SECTION_OF.get(v0.group) || 'common',
      min: v0.min, max: v0.max, help: `${v0.key} (page ${'ABCD'[offset >> 7]} ${offset & 127})`, ...display(v0.key, v0.list, v0.min, v0.max),
    };
    if (PANEL.has(v0.key)) { p.group = 'Panel selections'; p.section = 'common'; p.label = `${v0.group} page`; }
    if (v0.key === 'Single Patchmanagement/Flags') Object.assign(p, { label: 'Status', input: 'number', readOnly: true, options: undefined, min: 0, max: 127, format: flagText(SINGLE_FLAGS), help: 'Status bits the OS keeps (internal parameter 1, no screen): bit 0 edited, 1 compare on, 2 sound loaded (by SysEx, from memory or a multi), 3 multi loading, 4 loaded as a part of a multi, 5 only in older sounds (the OS clears it), 6 not used. Storing writes 0; a parameter message cannot set it' });
    if (/^Arpeggiator User Pattern\/Step \d+ Bitfield$/.test(v0.key)) Object.assign(p, { options: [[0, 'Off'], [1, 'On']], help: `${v0.key} (page D ${offset & 127}): "Bitfield" is also the TI's own display name; Virus Control edits it with the step's on/off button (1 in nearly every factory sound)` });
    if (v0.key === 'Single Patchmanagement/Original Bank') Object.assign(p, { readOnly: true, help: 'The bank this sound was loaded from (0 RAM A ... 29 ROM Z), written by the Virus' });
    if (v0.key === 'Single Patchmanagement/Original Patch') Object.assign(p, { input: 'number', readOnly: true, options: undefined, format: (v) => slotNumber(v), help: 'The slot this sound was loaded from, written by the Virus' });
    if (variants.length > 1) {
      p.dynamic = (data) => {
        const v = variants.find((x) => !x.cond || condition(x.cond, data)) || v0;
        const label = v.group === p.group || v.group.startsWith(`${p.group} `) ? v.label : `${v.label} (${v.group})`;
        return { label, min: v.min, max: v.max, help: `${v.key} (page ${'ABCD'[offset >> 7]} ${offset & 127})`, options: undefined, format: undefined, ...display(v.key, v.list, v.min, v.max) };
      };
    }
    limitByOther(p, v0.key);
    out.push(p);
  }
  for (const o of FW.SINGLE_UNMAPPED) out.push(reservedByte(o));
  return out;
}

/**
 * What the OS does to an older sound (format 8, 9 or 11) when it arrives (checked on the unit with formats 8, 9
 * and 11): the unit plays it this way, and RAM/ROM slots send such sounds unconverted. Bytes 1-3 are left alone.
 */
export function upgradeSingle(src) {
  const d = Uint8Array.from(src);
  const f = d[0];
  if (f < 8 || f >= 12) return d;
  const set = (pairs) => { for (const [o, v] of pairs) d[o] = v; };
  if (f <= 9) {
    for (const [from, [to]] of Object.entries(OLD_POSITION)) d[to] = d[from];
    set([[103, 1], [104, 127], [128, 64], [281, 64], [329, 127], [330, 64]]);
    if (d[255] > 2) d[255] = 0; // Oscillators page select: 127 in older sounds becomes 0, 1 stays
  }
  if (f <= 8) set([[267, 64], [268, 3], [269, 4], [270, 2], [276, 127], [277, 64], [278, 64], [279, 127], [280, 127], [298, 64], [318, 64], [328, 127]]);
  set([[336, 20], [337, 70], [339, 64], [340, 70], [341, 20], [342, 70], [344, 64], [345, 70]]);
  d[0] = 12;
  return d;
}
export const singleParams_ = singleParams();
const byOffset = new Map(singleParams_.map((p) => [p.offset, p]));

export const nameOf = (d) => readText(d, 240, 10, (b) => (b < 32 || b > 126 ? 32 : b)).trimEnd();
export const multiNameOf = (d) => readText(d, 4, 10, (b) => (b < 32 || b > 126 ? 32 : b)).trimEnd();
export const setName = (d, at, name) => { for (let i = 0; i < 10; i++) d[at + i] = Math.max(32, Math.min(126, name.charCodeAt(i) || 32)); };

/** A single with Virus Control's default values (its "Init" sound). */
export function initSingle() {
  const d = new Uint8Array(SINGLE_SIZE);
  for (const [o, ...vs] of FW.SINGLE) { const v = vs[0]; if (v[5] !== null && v[5] !== undefined) d[o] = Math.max(v[3] ?? 0, Math.min(v[4] ?? 127, v[5])); }
  d[0] = 12;
  for (const o of [123]) d[o] = 0;
  setName(d, 240, 'Init');
  return d;
}

// Arpeggiator user pattern: 32 steps of 3 bytes from 384 (length, velocity, bitfield), length at 383.
const ARP = 384;
const stepParam = (i, k) => byOffset.get(ARP + 3 * i + k);

// ------------------------------------------------------------------ multi
const partAt = (ci, part) => 32 + 16 * (ci - 32) + part;
const MPART_LABEL = { 'Multi Part Parameter/Bank': 'Bank', 'Multi Part Parameter/Patch': 'Patch', 'Multi Part Parameter/Midi Channel': 'MIDI channel', 'Multi Part Bits/Part Enable': 'Part enable' };
/** The multi's parameters for a model: its number of parts, its tables, and where the part singles' names are kept. */
export function multiParams({ parts = 16, T = TABLES, names = () => unit.partNames } = {}) {
  const out = [];
  for (const r of T.FW.MULTI) {
    const [offset, key, label, group, min, max, , list] = r;
    if (group === 'Multi Patch Name') continue;
    const p = { key: `m${offset}`, offset, label, group: 'Multi', section: 'common', min, max, help: key, ...display(key, list, min, max, T), ...(group === 'Multi Patchmanagement' ? { input: 'number', readOnly: true } : {}) };
    if (offset === 1) Object.assign(p, { label: 'Status', options: undefined, min: 0, max: 127, format: flagText(MULTI_FLAGS), help: 'Status bits the OS keeps (internal parameter 345h, no screen): bit 0 set by a multi parameter edit, bit 2 when a multi arrives by SysEx (01h after an edit, 05h after a dump, checked on the unit); a parameter message cannot set it' });
    if (offset === 3) Object.assign(p, { options: undefined, format: (v) => slotNumber(v), help: 'The slot this multi was loaded from (internal parameter 346h), written by the Virus' });
    out.push(p);
  }
  for (let part = 0; part < parts; part++) {
    const g = `Part ${part + 1}`;
    for (const [ci, key, label, min, max, , list] of T.FW.MPART) {
      const p = { key: `p${part}_${ci}`, offset: partAt(ci, part), label: MPART_LABEL[key] || label, group: g, section: `part${part}`, min, max, help: `${key} (multi page ${ci})`, page: ci, part, ...display(key, list, min, max, T) };
      if (ci === 33) Object.assign(p, { input: 'number', options: undefined, format: (v) => slotNumber(v) });
      out.push(p);
    }
    for (const [bit, key, label, list] of T.FW.MBITS) {
      out.push({ key: `p${part}_b${bit}`, offset: 240 + part, shift: bit, bits: 1, label: MPART_LABEL[key] || label, group: g, section: `part${part}`, min: 0, max: 1, help: `${key} (multi page ${72 + bit})`, page: 72 + bit, part, ...display(key, list, 0, 1, T) });
    }
    // the single the part holds (its edit buffer), named from the arrangement read with the multi
    const at = partAt(33, part);
    out.push({ key: `p${part}_sound`, offset: at, label: 'Sound', group: g, section: `part${part}`, min: 0, max: 127, readOnly: true, part,
      help: 'The single in this part\'s edit buffer (read with the multi by the arrangement request 34 00); in sequencer mode it can differ from Bank and Patch',
      dynamic: (d) => ({ options: [[d[at], names(d)[part] ?? '(not read)']] }) });
  }
  // bytes and bits the OS has no multi parameter for (tools/virus/os_tables.py: page 72 indexes 0, 2, 14, 16-28,
  // 30, 31, 42, 44 and 76 are not in its tables; parameter messages to them are ignored)
  const known = new Set(out.filter((p) => !p.shift && !p.bits).map((p) => p.offset));
  for (let o = 0; o < MULTI_SIZE; o++) {
    if (known.has(o) || (o >= 4 && o <= 13) || (o >= 240 && o - 240 < parts)) continue;
    const page = o >= 32 ? 32 + ((o - 32) >> 4) : o;
    const beyond = o >= 240 ? o - 240 : o >= 32 ? (o - 32) & 15 : -1;
    const what = beyond >= parts ? { label: o >= 240 ? `Part ${beyond + 1} switches` : `Part ${beyond + 1} (page ${page})`, help: `${o >= 240 ? 'Switch bits' : `Multi page ${page}`} of part ${beyond + 1}: this model has ${parts} parts and its OS refuses parameter messages for the others; kept as the dump brings it` }
      : o === 0 ? { label: 'Format', format: (v) => `format ${v}`, help: 'First byte of every multi (2 in all multis read); no parameter in the OS' }
      : o >= 32 ? { label: `Part ${((o - 32) & 15) + 1} reserved (page ${page})`, help: `Multi page ${page} for part ${((o - 32) & 15) + 1}: no parameter in the OS (no screen, parameter messages ignored)${page === 44 ? '; 79 in every multi read' : ''}` }
        : { label: `Reserved (multi ${o})`, help: `Multi byte ${o}: no parameter in the OS (no screen, parameter messages ignored)` };
    out.push({ key: `m${o}`, offset: o, group: 'Reserved bytes', section: 'reserved', min: 0, max: 127, input: 'number', readOnly: true, ...what });
  }
  for (let part = 0; part < parts; part++) {
    out.push({ key: `p${part}_b4`, offset: 240 + part, shift: 4, bits: 1, label: `Part ${part + 1} switch bit 4`, group: 'Reserved bytes', section: 'reserved', min: 0, max: 1, input: 'number', readOnly: true, help: 'Multi page 76 (bit 4 of the part switches): no parameter in the OS, parameter messages ignored' });
  }
  return out;
}
export const multiParams_ = multiParams();
export function initMulti({ parts = 16, T = TABLES, size = MULTI_SIZE } = {}) {
  const d = new Uint8Array(size);
  d[0] = 2;
  setName(d, 4, 'Init Multi');
  for (const r of T.FW.MULTI) if (r[6] !== null && r[6] !== undefined && !(r[1].includes('Patch Name'))) d[r[0]] = r[6];
  for (let part = 0; part < parts; part++) {
    for (const [ci, , , min, max, def] of T.FW.MPART) d[partAt(ci, part)] = Math.max(min, Math.min(max, def ?? 0));
    d[partAt(34, part)] = part; // channels in order, as Virus Control's initialisation
    d[240 + part] = 0x4f; // enabled, MIDI volume, hold pedal, keyboard to MIDI, program change
  }
  return d;
}

// ------------------------------------------------------------------ global (page 73)
const GLOBAL_LABEL = { 123: 'Remote channel', 124: 'Global MIDI channel' };
export function globalParams(T = TABLES) {
  const seen = new Set();
  const out = [];
  for (const [ci, key, label, group, min, max, , list] of T.FW.GLOBAL) {
    if (seen.has(ci)) continue;
    seen.add(ci);
    out.push({ key: `g${ci}`, offset: ci, label: GLOBAL_LABEL[ci] || label, group: group.replace(/^Global /, ''), section: 'global', min, max, help: `${key} (page F ${ci})`, ...display(key, list, min, max, T) });
  }
  return out;
}
export const globalParams_ = globalParams();
export function initGlobal(T = TABLES) {
  const d = new Uint8Array(GLOBAL_SIZE);
  for (const [ci, , , , , , def] of T.FW.GLOBAL) if (def !== null && def !== undefined) d[ci] = def;
  d[118] = 0; // Memory Protect: Disabled (the user's setting)
  return d;
}

// ------------------------------------------------------------------ remote templates (read only)
// Remote mode turns the TI's knobs into a MIDI controller. 32 templates of 32 records (32 bytes each, as in the
// unit's template memory: host OS 6168 at 8000 + 400h x template + 20h x record, memory bank F): record k is knob
// k (0-31): its name (10 characters), byte 10 the value range (KNOB_RANGES: the knob sends the range's values over
// its travel; CE00 at 0D19), byte 11 not read by the OS (Virus Control's: 1 in most of its template files), bytes
// 12-31 the MIDI string (raw MIDI bytes; FF = the knob's value; FE ends it; compiled at 206D, sent by bank 1 DB95).
// Record 16 is no knob: it holds the template name (16 characters) and at byte 16 the channel switch (1: the channel
// of every channel message in the strings becomes the global Remote Channel, F 123 (bit 3E at 6255, used at DB95)).
// Request 38 tt kk (tt template 0-31, kk knob 0-31; 32 = the name record; 16 gets no answer) -> 13 tt kk: the
// record's first 10 bytes as they are, then 22 bytes as nibbles (low first); for kk 32: 17 bytes as they are.
export const TEMPLATE_SIZE = 1024;
export const TEMPLATE_NAME_RECORD = 16;
export const TEMPLATE_KNOBS = Array.from({ length: 32 }, (_, k) => k).filter((k) => k !== TEMPLATE_NAME_RECORD);
const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
/** The template data (1024 bytes) with the records carried by 13 messages for template `tt` (others keep `base`). */
export function templateFrom(msgs, tt, base = initTemplate(tt)) {
  const d = Uint8Array.from(base);
  for (const m of msgs) {
    if (cmdOf(m) !== 0x13 || m[7] !== tt) continue;
    const kk = m[8];
    if (kk === 0x20 && m.length >= 28) d.set(m.slice(9, 26), 32 * TEMPLATE_NAME_RECORD);
    else if (kk < 32 && kk !== TEMPLATE_NAME_RECORD && m.length >= 65) {
      d.set(m.slice(9, 19), 32 * kk);
      for (let i = 0; i < 22; i++) d[32 * kk + 10 + i] = (m[19 + 2 * i] & 15) | ((m[20 + 2 * i] & 15) << 4);
    }
  }
  return d;
}
/** The 13 message the unit sends for record kk (0-31, or 32 for the name) of template tt. */
export function templateMessage(ctx, tt, kk, d) {
  const m = [...hdr(ctx, 0x13), tt & 0x7f, kk & 0x7f];
  if (kk === 0x20) m.push(...body(d.slice(32 * TEMPLATE_NAME_RECORD, 32 * TEMPLATE_NAME_RECORD + 17)));
  else { m.push(...body(d.slice(32 * kk, 32 * kk + 10))); for (let i = 0; i < 22; i++) { const b = d[32 * kk + 10 + i]; m.push(b & 15, b >> 4); } }
  m.push(sum7(m), 0xf7);
  return m;
}
/** A template as the OS initialises it (4B30): knob k "Remote 20" + k, sending CC 20h + k with the knob's value; template 0 "Init Template", the others "Template Set nn". */
export function initTemplate(tt = 0) {
  const d = new Uint8Array(TEMPLATE_SIZE);
  for (const k of TEMPLATE_KNOBS) {
    setName(d, 32 * k, `Remote ${hex2(0x20 + k)}`);
    d[32 * k + 9] = 0;
    d.set([0x00, 0xff, 0xb0, 0x20 + k, 0xff], 32 * k + 10);
    d.fill(0xfe, 32 * k + 15, 32 * k + 32);
  }
  const name = tt ? `Template Set ${String(tt).padStart(2, '0')}` : 'Init Template';
  for (let i = 0; i < 16; i++) d[32 * TEMPLATE_NAME_RECORD + i] = name.charCodeAt(i) || (tt ? 0 : 32);
  return d;
}
const textAt = (d, at, n) => readText(d, at, n, (b) => (b < 32 || b > 126 ? 32 : b)).trimEnd();
export const templateNameOf = (d) => textAt(d, 32 * TEMPLATE_NAME_RECORD, 16);
const STATUS_NAMES = { 0x80: 'Note Off', 0x90: 'Note On', 0xa0: 'Poly Pressure', 0xb0: 'Control Change', 0xc0: 'Program Change', 0xd0: 'Channel Pressure', 0xe0: 'Pitch Bend' };
/** A knob's MIDI string as Virus Control writes it ("B0 46 *": * = the knob's value) and what it sends. */
export function midiStringText(d, at) {
  const bytes = [];
  for (let i = 0; i < 20 && d[at + i] !== 0xfe; i++) bytes.push(d[at + i]);
  if (!bytes.length) return '(nothing)';
  const raw = bytes.map((b) => (b === 0xff ? '*' : hex2(b))).join(' ');
  const s = bytes[0];
  const what = s >= 0x80 && s < 0xf0 ? `${STATUS_NAMES[s & 0xf0]} ch ${(s & 15) + 1}${(s & 0xf0) === 0xb0 && bytes[1] < 0x80 ? ` CC ${bytes[1]}` : ''}` : s === 0xf0 ? 'SysEx' : '';
  return what ? `${raw} (${what})` : raw;
}
/** "B0 46 *" -> the 20 string bytes (FFh = the knob's value, FEh fills the rest); throws on anything else. */
export function parseMidiString(text) {
  const t = String(text || '').trim();
  const toks = t ? t.split(/[\s,]+/) : [];
  if (toks.length > 20) throw new Error('A MIDI string holds at most 20 bytes.');
  const bytes = toks.map((x) => {
    if (x === '*') return 0xff;
    if (!/^[0-9a-f]{1,2}$/i.test(x)) throw new Error(`"${x}" is not a hex byte or *.`);
    const b = parseInt(x, 16);
    if (b >= 0xfe) throw new Error('FE and FF are reserved (FF is written *, FE ends the string).');
    return b;
  });
  return [...bytes, ...Array(20 - bytes.length).fill(0xfe)];
}
/** The MIDI string as typed in the editor ("B0 46 *"). */
export const midiStringInput = (d, at) => { const out = []; for (let i = 0; i < 20 && d[at + i] !== 0xfe; i++) out.push(d[at + i] === 0xff ? '*' : hex2(d[at + i])); return out.join(' '); };
const knobRangeText = (n) => { const r = OS.KNOB_RANGES[n]; if (!r) return `range ${n} (not in the OS table)`; const [a, b, vc, name] = r; return `${a}-${b}${n === 77 ? ' switch' : ''}${name ? ` (Virus Control: ${name})` : ''}`; };
/** Virus Control's knob behaviour number (its list "Val Remote Template Knob Behaviours", 0-61) -> the OS 5 range type with the same values. */
export const vcBehaviourToOs = (i) => { const n = OS.KNOB_RANGES.findIndex((r) => r[2] === i); return n < 0 ? null : n; };

// Records 0-31 are the panel knobs 0-31 of the OS's knob table (OS.PANEL_KNOBS, bank 1 D014: knob 16 is Master Volume,
// never remote, so record 16 holds the name). Each is labelled with the display text (list 45) of the parameter it edits
// with the panel's first selection (Oscillator 1, Filter 1, LFO 1, the first effect), the soft knobs with list 39's
// "Soft Knob n". Areas and order: as Virus Control's Remote page places the records on its panel picture.
const KNOB_LABEL = { 1: 'Amplifier Envelope Release', 2: 'Filter 2 Cutoff', 3: 'Oscillator FM Amount', 4: 'Distortion Intensity', 5: 'Filter Envelope Release', 6: 'Filter 1 Cutoff', 7: 'Oscillator 2 Detune', 8: 'Delay Feedback', 9: 'Filter Balance', 10: 'Filter 1 Resonance', 11: 'Oscillator Balance', 13: 'Amplifier Envelope Sustain', 14: 'Filter Envelope Attack', 15: 'Sub Oscillator Volume', 16: 'Master Volume', 17: 'Filter 1 Envelope Amount', 18: 'Oscillator Volume', 19: 'Lfo 1 Rate', 20: 'Distortion Type', 21: 'Filter Envelope Sustain', 22: 'Amplifier Envelope Attack', 23: 'Oscillator 1 Semitone', 24: 'Delay Time', 25: 'Filter Envelope Decay', 27: 'Oscillator 1 Shape', 28: 'Delay Send', 29: 'Amplifier Envelope Decay', 30: 'Noise Volume', 31: 'Oscillator 1 Wave select' };
export const PANEL_AREAS = [['soft', 'Soft knobs', [0, 12, 26]], ['osc', 'LFO and oscillators', [19, 27, 31, 23, 7, 3]], ['mixer', 'Mixer', [11, 15, 18, 30]], ['filter', 'Filters', [6, 2, 10, 17, 9]], ['env', 'Envelopes', [14, 25, 21, 5, 22, 29, 13, 1]], ['fx', 'Effects', [20, 4, 28, 24, 8]]];
/** The panel knob of record k: its label and what it edits outside Remote mode. */
export function panelKnob(k) {
  const [remote, soft, funcs] = OS.PANEL_KNOBS[k];
  return { remote, soft, funcs, label: soft ? `Soft Knob ${soft}` : KNOB_LABEL[k] };
}
const knobTitle = (k) => `${panelKnob(k).label} (record ${k})`;
function templateParams() {
  const out = [];
  const nameAt = 32 * TEMPLATE_NAME_RECORD;
  out.push({ key: 't_name', offset: nameAt, label: 'Name', group: 'Template', section: 'template', min: 0, max: 127, readOnly: true,
    help: 'Record 16 of the template (16 characters; request 38 tt 20). Change it with "Rename template..."', dynamic: (d) => ({ options: [[d[nameAt], templateNameOf(d) || '(empty)']] }) });
  out.push({ key: 't_channel', offset: nameAt + 16, label: 'MIDI channel', group: 'Template', section: 'template', min: 0, max: 1,
    options: [[0, 'As in the MIDI strings'], [1, 'Remote Channel (global)']],
    help: 'Byte 16 of the name record: 1 replaces the channel of every channel message in the knobs\' strings by the global Remote Channel (host OS 6255 / DB95); Virus Control\'s "MIDI Channel Behaviour"' });
  for (const [section, , knobs] of PANEL_AREAS) for (const k of knobs) {
    const g = knobTitle(k);
    const at = 32 * k;
    const { soft, funcs } = panelKnob(k);
    const what = soft ? `soft knob ${soft} under the display (outside Remote mode it follows the global Soft Knob ${soft} settings)` : `outside Remote mode it edits ${funcs.join(', ')} (the panel selection picks one)`;
    out.push({ key: `k${k}_name`, offset: at, label: 'Name', group: g, section, min: 0, max: 127, readOnly: true,
      help: `Record ${k}, bytes 0-9 (request 38 tt ${hex2(k)}): the name the display shows when the knob is turned in Remote mode. Panel knob ${k}: ${what}. Change it with "Edit knob..."`,
      dynamic: (d) => ({ options: [[d[at], textAt(d, at, 10) || '(empty)']] }) });
    out.push({ key: `k${k}_range`, offset: at + 10, label: 'Value range', group: g, section, min: 0, max: 255,
      options: OS.KNOB_RANGES.map((_, n) => [n, knobRangeText(n)]),
      help: 'Byte 10: the OS\'s knob range type (0-77, its table in bank 1): the values the knob sends over its travel. Virus Control sends its own older numbering unconverted (its 52 "Bipolar -64 - +63" is the OS\'s 64; the OS reads 52 as 0-12)' });
    out.push({ key: `k${k}_vc`, offset: at + 11, label: 'Byte 11', group: g, section, min: 0, max: 255, input: 'number',
      help: 'Not read by the OS; Virus Control writes 1 (sometimes 0 or 13) in its template files, the OS\'s initial templates hold FFh' });
    out.push({ key: `k${k}_midi`, offset: at + 12, label: 'MIDI string', group: g, section, min: 0, max: 255, readOnly: true,
      help: 'Bytes 12-31: the MIDI bytes the knob sends; * (FFh) is the knob\'s value, FEh ends the string. Change it with "Edit knob..."',
      dynamic: (d) => ({ options: [[d[at + 12], midiStringText(d, at + 12)]] }) });
  }
  return out;
}
export const templateParams_ = templateParams();
/** The 32 messages that write template tt (name record first, then knobs 0-31 without 16): 13 tt kk as the unit sends them (receiver states 1E-23 at 4308-4395, stored by 43C0). */
export const templateWrite = (ctx, tt, d) => [templateMessage(ctx, tt, 0x20, d), ...TEMPLATE_KNOBS.map((k) => templateMessage(ctx, tt, k, d))];
/** Messages 13 from a file (.syx or a Virus Control .vrt): the records of the first template in it, for template tt; vcRanges converts Virus Control's knob behaviour numbers to the OS's. */
export function templateFromFile(msgs, tt, vcRanges = false) {
  const recs = msgs.filter((m) => cmdOf(m) === 0x13 && m.length > 19);
  if (!recs.length) return null;
  const src = recs[0][7];
  const d = templateFrom(recs.filter((m) => m[7] === src).map((m) => { const c = Uint8Array.from(m); c[7] = tt; return c; }), tt);
  if (vcRanges) for (const k of TEMPLATE_KNOBS) { const n = vcBehaviourToOs(d[32 * k + 10]); if (n !== null) d[32 * k + 10] = n; }
  return d;
}

// ------------------------------------------------------------------ device I/O
const unit = { part: SINGLE_PART, partNames: [], template: 0 };
/** Send a request and collect the answers (the TI2 answers about one dump a second, also in a bank dump). */
export async function collect(api, request, cmds, count, test = () => true, each = null) {
  const c = api.g.client;
  const timeout = (c.s?.timeout ?? 2500) + count * 1500 + 1500;
  const r = await c.request(Uint8Array.from(request), {
    collect: (_m, raw) => { const ok = cmds.includes(cmdOf(raw)) && test(raw); if (ok) each?.(raw); return ok; },
    complete: (list) => list.length >= count,
    timeout, quiet: 4000, resolveOnQuiet: true,
  });
  return (r.messages || []).map((m) => Uint8Array.from(m.raw ?? m));
}
async function fetchSingle(api, bank, prog) {
  const m = await collect(api, msg.singleRequest(api.ctx, bank, prog), [0x10], 1, (raw) => raw[7] === bank && raw[8] === prog);
  const d = m[0] && singleFrom(m[0]);
  if (!d) throw new Error(`The Virus did not send ${bank ? `${bankName(bank)} ${slotNumber(prog)}` : `the ${partLabel(prog)} edit buffer`}.`);
  return bank ? upgradeSingle(d) : d; // RAM/ROM slots send older sounds unconverted; edit buffers hold them converted
}
/** The multi edit buffer and the names of the 16 part singles, from one arrangement request (34 00: 17 dumps, about 17 s). */
async function fetchArrangement(api) {
  const m = await collect(api, msg.arrangementRequest(api.ctx), [0x10, 0x11], 17, (raw) => raw[7] === 0 && (raw[6] === 0x11 || raw[8] < 16));
  for (const raw of m) if (cmdOf(raw) === 0x10) unit.partNames[raw[8]] = nameOf(singleFrom(raw));
  const d = multiFrom(m.find((raw) => cmdOf(raw) === 0x11) || []);
  if (!d) throw new Error('The Virus did not send its multi edit buffer.');
  return d;
}
async function fetchMulti(api, bank, prog) {
  const m = await collect(api, msg.multiRequest(api.ctx, bank, prog), [0x11], 1, (raw) => raw[7] === bank);
  const d = m[0] && multiFrom(m[0]);
  if (!d) throw new Error(`The Virus did not send ${bank ? `multi ${slotNumber(prog)}` : 'its multi edit buffer'}.`);
  return d;
}
/** One remote template: its name record and its 31 knobs, one request at a time (38 tt kk; the TI answers each in about 0.13 s). */
async function fetchTemplate(api, tt) {
  const got = [];
  for (const kk of [0x20, ...TEMPLATE_KNOBS]) got.push(...await collect(api, msg.remoteTemplateRequest(api.ctx, tt, kk), [0x13], 1, (raw) => raw[7] === tt && raw[8] === kk));
  if (!got.length) throw new Error(`The Virus did not send ${templateLabel(tt).toLowerCase()}.`);
  return templateFrom(got, tt);
}
const putText = (d, at, n, s, pad) => { for (let i = 0; i < n; i++) { const c = s.charCodeAt(i); d[at + i] = i < s.length && c >= 32 && c <= 126 ? c : pad; } };
async function editTemplateKnob(api) {
  const pick = await api.form('Edit knob', [{ key: 'k', label: 'Knob', type: 'select', value: '0', options: PANEL_AREAS.flatMap(([, area, ks]) => ks.map((k) => ({ value: String(k), label: `${area}: ${knobTitle(k)}` }))) }], 'Next');
  if (!pick) return;
  const k = Number(pick.k);
  const d = Uint8Array.from(api.data);
  const at = 32 * k;
  const r = await api.form(knobTitle(k), [
    { key: 'name', label: 'Name (10 characters)', value: textAt(d, at, 10), maxlength: 10 },
    { key: 'midi', label: 'MIDI string (hex bytes, * = the knob\'s value; at most 20 bytes)', value: midiStringInput(d, at + 12) },
  ], 'OK', 'The editor keeps the change; "Write to the Virus" sends the template.');
  if (!r) return;
  d.set(parseMidiString(r.midi), at + 12);
  putText(d, at, 10, r.name, 32);
  api.setData(d);
  api.refresh();
}
async function renameTemplate(api) {
  const d = Uint8Array.from(api.data);
  const r = await api.form('Rename template', [{ key: 'name', label: 'Name (16 characters)', value: templateNameOf(d), maxlength: 16 }]);
  if (!r) return;
  putText(d, 32 * TEMPLATE_NAME_RECORD, 16, r.name, 32);
  api.setData(d);
  api.refresh();
}
async function importVrt(api) {
  const files = await pickFiles('.vrt,.syx', false);
  if (!files?.length) return;
  const d = templateFromFile(sysexMessages(new Uint8Array(await files[0].arrayBuffer())), unit.template, true);
  if (!d) { api.toast('No remote template records (13 tt kk) in that file.', 'warn'); return; }
  api.setData(d);
  api.refresh();
  api.toast('Loaded into the editor, knob behaviours converted to the OS\'s range types. "Write to the Virus" sends it.', 'info');
}
async function writeTemplate(api) {
  const tt = unit.template;
  const ok = await api.confirm(`Write ${templateLabel(tt).toLowerCase()}?`, `This replaces ${templateLabel(tt).toLowerCase()} ("${templateNameOf(api.data)}") in the Virus's template memory with the 32 records shown. Use Export .syx (after Get from device) first to keep the old one.`);
  if (!ok) return;
  api.send(templateWrite(api.ctx, tt, api.data)); // queued in order, the client's gap between SysEx messages (no page timers: a background tab slows them to one a minute)
  api.toast(`${templateLabel(tt)}: 32 records queued (about 5 s).`, 'info');
}
/** Names of a whole bank from one bank request (32 / 33), shown as they arrive (about two minutes). */
function scanBank(cmd) {
  return async (api, bank, onName) => {
    const single = cmd === 0x10;
    const name = (x) => (single ? nameOf(singleFrom(x)) : multiNameOf(multiFrom(x)));
    await collect(api, single ? msg.singleBankRequest(api.ctx, bank) : msg.multiBankRequest(api.ctx, bank), [cmd], 128, (raw) => raw[7] === bank, (x) => onName(x[8], name(x)));
  };
}

/** A part's edit buffer receives a sound: the edit buffer of the selected part (or single mode). */
const sendSingleParam = (ctx, offset, value, part = unit.part) => msg.param(ctx, PAGES[offset >> 7], part, offset & 127, value);

/** The single page's receiver for the edit buffer getPart() names (40 = single mode, or a part). */
export const singleReceiver = (getPart) => (raw, data, ctx) => {
  const part = getPart();
  if (isVirus(raw)) {
    const page = PAGES.indexOf(raw[6]);
    if (page >= 0 && raw[7] === part && raw.length >= 11) { const d = Uint8Array.from(data); d[page * 128 + raw[8]] = raw[9]; return d; }
    if (raw[6] === 0x10 && raw[7] === 0 && raw[8] === part) return singleFrom(raw);
    return null;
  }
  const ch = (ctx?.channel ?? 0) & 15;
  const st = raw[0] & 0xf0;
  if ((raw[0] & 15) !== ch || part !== SINGLE_PART) return null;
  if (st === 0xb0 && byOffset.has(raw[1]) && !STANDARD_CC[raw[1]]) { const d = Uint8Array.from(data); d[raw[1]] = raw[2]; return d; }
  if (st === 0xa0 && byOffset.has(128 + raw[1])) { const d = Uint8Array.from(data); d[128 + raw[1]] = raw[2]; return d; }
  return null;
};

// ------------------------------------------------------------------ Branch Library
// Messages the Head Library reads (dumps 10, 11 and template records 13); requests are 30-3B.
const DATA_CMDS = [0x10, 0x11, 0x13];
const recognise = (m) => DATA_CMDS.includes(cmdOf(m)) && (cmdOf(m) !== 0x10 || !!singleFrom(m)) && (cmdOf(m) !== 0x11 || !!multiFrom(m));
const isRequest = (m) => cmdOf(m) >= 0x30 && cmdOf(m) <= 0x3b;
const isOwn = (m) => isVirus(m);
/** Where the Virus families' messages differ, for a file read without a device hint: TI and Snow singles are 524
 * bytes (pages A-D), the A / B / C's 267; the TI's single banks run to 30 (ROM A-Z; the Snow's to 8), its edit-buffer
 * parts to 15 (the Snow's to 3), its multis to 127 (the Snow's to 63); only the Snow keeps part singles of multis
 * 16-63 (banks 30h-5Fh). */
export const tiSigns = (msgs) => msgs.some((m) => (cmdOf(m) === 0x10 && ((m[7] >= 9 && m[7] < 0x20) || (m[7] === 0 && m[8] >= 4 && m[8] < 16))) || (cmdOf(m) === 0x11 && m[7] === 1 && m[8] >= 64 && m[8] < 128));
export const snowSigns = (msgs) => msgs.some((m) => cmdOf(m) === 0x10 && m[7] >= 0x30 && m[7] < 0x60);
export const longSingles = (msgs) => { const s = msgs.filter((m) => cmdOf(m) === 0x10); return s.length ? s.filter((m) => m.length >= 524).length / s.length : 0; };
const prefer = (msgs) => 1 + longSingles(msgs) + (tiSigns(msgs) ? 0.5 : 0) - (snowSigns(msgs) ? 0.5 : 0);

function libraryItems(msgs) {
  const items = [];
  // remote template records (13 tt kk): one item per template
  const templates = new Map();
  for (const m of msgs) if (cmdOf(m) === 0x13 && m.length > 19) { if (!templates.has(m[7])) templates.set(m[7], []); templates.get(m[7]).push(m); }
  for (const [tt, recs] of templates) {
    const data = templateFrom(recs, tt);
    items.push({ key: `t${tt}`, label: templateLabel(tt), name: templateNameOf(data), object: 'setup', data, msgs: recs });
  }
  msgs.forEach((m, i) => {
    const c = cmdOf(m);
    if (c === 0x10) {
      const d = singleFrom(m);
      if (!d) return;
      items.push({ key: `s${m[7]}:${m[8]}:${i}`, label: m[7] ? `${bankName(m[7])} ${slotNumber(m[8])}` : `Single edit buffer (${partLabel(m[8])})`, name: nameOf(d), object: 'single', msgs: [m] });
    } else if (c === 0x11) {
      const d = multiFrom(m);
      if (!d) return;
      items.push({ key: `m${m[7]}:${m[8]}:${i}`, label: m[7] ? `Multi ${slotNumber(m[8])}` : 'Multi edit buffer', name: multiNameOf(d), object: 'multi', msgs: [m] });
    }
  });
  return items;
}

// ------------------------------------------------------------------ simulator (demo mode and tests)
function simulate() {
  const named = (d, at, s) => { setName(d, at, s); return d; };
  const singles = new Map();
  for (const [b] of [...RAM_BANKS, ...ROM_BANKS]) for (let i = 0; i < 128; i++) singles.set(`${b}:${i}`, named(initSingle(), 240, `${bankName(b).slice(-1)}${slotNumber(i)} Sgl`));
  const multis = new Map();
  for (let i = 0; i < 128; i++) multis.set(`1:${i}`, named(initMulti(), 4, `Multi ${slotNumber(i)}`));
  const s = { single: initSingle(), parts: Array.from({ length: 16 }, () => initSingle()), multi: initMulti(), global: initGlobal(), singles, multis };
  const ctx = { deviceId: 0x00 };
  const buf = (p) => (p === SINGLE_PART ? s.single : s.parts[p & 15]);
  s.templates = REMOTE_TEMPLATES.map((tt) => initTemplate(tt));
  const tpl = (tt) => s.templates[tt];
  return {
    state: s,
    handle(raw) {
      const d = Array.from(raw);
      if (d[0] !== 0xf0) return [];
      if (!isVirus(d)) return null;
      const c = d[6];
      const key = `${d[7]}:${d[8]}`;
      switch (c) {
        case 0x30: return d[7] === 0 ? [msg.single(ctx, 0, d[8], buf(d[8]))] : singles.has(key) ? [msg.single(ctx, d[7], d[8], singles.get(key))] : [];
        case 0x31: return d[7] === 0 ? [msg.multi(ctx, 0, 0x7f, s.multi)] : multis.has(key) ? [msg.multi(ctx, d[7], d[8], multis.get(key))] : [];
        case 0x32: return singles.has(`${d[7]}:0`) ? Array.from({ length: 128 }, (_, i) => msg.single(ctx, d[7], i, singles.get(`${d[7]}:${i}`))) : [];
        case 0x33: return d[7] === 1 ? Array.from({ length: 128 }, (_, i) => msg.multi(ctx, 1, i, multis.get(`1:${i}`))) : [];
        case 0x34: return [msg.multi(ctx, 0, 0x7f, s.multi), ...s.parts.map((p, i) => msg.single(ctx, 0, i, p))];
        case 0x38: return d[7] < 32 && (d[8] === 0x20 || (d[8] < 32 && d[8] !== TEMPLATE_NAME_RECORD)) ? [templateMessage(ctx, d[7], d[8], tpl(d[7]))] : [];
        case 0x13: // a record written as the OS takes it (states 1E-23: template < 32, record 0-31 except 16 or 20h, checksum)
          if (d[7] < 32 && (d[8] === 0x20 || (d[8] < 32 && d[8] !== TEMPLATE_NAME_RECORD)) && d[d.length - 2] === sum7(d.slice(0, -2))) tpl(d[7]).set(templateFrom([Uint8Array.from(d)], d[7], tpl(d[7])));
          return [];
        case 0x10: {
          const data = singleFrom(Uint8Array.from(d));
          if (!data) return [];
          if (d[7] === 0) buf(d[8]).set(data);
          else if (d[7] >= 1 && d[7] <= 4 && s.global[118] === 0) singles.get(key)?.set(data);
          return [];
        }
        case 0x11: {
          const data = multiFrom(Uint8Array.from(d));
          if (data && d[7] === 0) s.multi.set(data);
          else if (data && s.global[118] === 0 && ((d[7] === 1 && d[8] >= 16) || (d[7] === MULTI_STORE_LOW && d[8] < 16))) multis.get(`1:${d[8]}`)?.set(data); // as the OS: bank 1 only for 16-127
          return [];
        }
        case 0x70: case 0x71: case 0x6e: case 0x6f: buf(d[7])[PAGES.indexOf(c) * 128 + d[8]] = d[9]; return [];
        case 0x72:
          if (d[8] >= 72 && d[8] <= 78) { const b = 240 + (d[7] & 15); s.multi[b] = (s.multi[b] & ~(1 << (d[8] - 72))) | ((d[9] & 1) << (d[8] - 72)); } else if (d[8] >= 32) s.multi[partAt(d[8], d[7] & 15)] = d[9]; else s.multi[d[8]] = d[9];
          return [];
        case 0x73: s.global[d[8]] = d[9]; return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ objects
const PART_TARGET = {
  label: 'Edit buffer', title: 'Which edit buffer the page reads and edits: the single of single mode, or a part of the multi',
  options: () => [[SINGLE_PART, 'Single mode'], ...Array.from({ length: 16 }, (_, i) => [i, `Multi part ${i + 1}`])],
  value: () => unit.part, set: (v) => { unit.part = Number(v); },
};
const partSections = Array.from({ length: 16 }, (_, i) => ({ key: `part${i}`, label: `Part ${i + 1}` }));
const findMulti = (part, ci) => multiParams_.find((p) => p.part === part && p.page === ci);

const DEF = {
  coverage: 'Singles (all 388 parameters Virus Control describes: 3 oscillators with the HyperSaw, wavetable and grain/formant models, filters, 4 envelopes, 3 LFOs, 6 assign slots, effects, arpeggiator with its user pattern, vocoder and inputs), the multi (16 parts with bank, patch, channel, key range, volume, pan, output and switches; MIDI channels page) and the global settings (sent only: the OS has no global request), read and sent over the "Virus TI Synth" USB port as Virus Control describes them. RAM and ROM single banks with names from one bank request each (older ROM sounds shown converted as the OS plays them), the RAM multis, store to RAM (checked on RAM A 001), the 32 remote templates (each record named after the panel knob it belongs to; knob names, value ranges, MIDI strings and the channel switch edited, Virus Control .vrt files imported with their knob behaviours converted, written with message 13; every record in the complete dump), Branch Library, translator for the Head Library. Value lists show the TI2 screen texts in its order and range (its display lists, reordering tables and range routines). Bytes the OS has no parameter for are read-only reserved entries with the OS evidence.',
  sysex: { manufacturer: [0x00, 0x20, 0x33], model: 0x01, deviceIdDefault: OMNI },
  minGap: 20,
  describe,
  simulate,
  libraryItems,
  recognise,
  isRequest,
  isOwn,
  prefer,
  objects: [
    {
      key: 'single', page: 'Single', icon: '◆', label: 'Single', size: SINGLE_SIZE, autoLoad: true,
      init: initSingle, params: singleParams_, name: nameOf, cols: 3,
      fetch: (api) => fetchSingle(api, 0, unit.part),
      target: PART_TARGET,
      sections: SINGLE_SECTIONS,
      groupInfo: {
        'Reserved bytes': { note: 'Bytes the TI2 OS has no sound parameter for (its own parameter tables): no screen shows them and parameter messages to them are ignored. Some hold the format 8/9 places of parameters the OS moves when an older sound arrives, or controller values older sounds stored. Kept so a backup restores exactly (docs/devices/access-virus-ti2.md, "Reserved bytes").', table: true, wide: true },
        'Panel selections': { note: 'Which page of a front-panel section is shown; the Virus keeps it with the sound.' },
        'Arpeggiator User Pattern': {
          wide: true,
          note: 'The user pattern (Arpeggiator Pattern "User"): 32 steps of length, velocity and Virus Control\'s "Bitfield" (0/1); steps after User Pattern Length are not played.',
          pattern: ({ data }) => ({
            length: 32, end: Math.min(32, (data[383] ?? 31) + 1), stepLabel: (i) => String(i + 1),
            lanes: [
              { label: 'Bitfield', kind: 'bar', steps: Array.from({ length: 32 }, (_, i) => stepParam(i, 2)), min: 0, max: 1, zero: 0 },
              { label: 'Velocity', kind: 'bar', steps: Array.from({ length: 32 }, (_, i) => stepParam(i, 1)), min: 0, max: 127, zero: 0 },
              { label: 'Length', kind: 'bar', steps: Array.from({ length: 32 }, (_, i) => stepParam(i, 0)), min: 0, max: 127, zero: 0 },
            ],
          }),
        },
      },
      sendParam: (p, _v, data, ctx) => sendSingleParam(ctx, p.offset, data[p.offset]),
      receive: singleReceiver(() => unit.part),
      note: 'Each change is sent as a SysEx parameter (pages A-D) to the edit buffer chosen above, so it is heard at once. Store writes the single into a RAM slot.',
      sendAll: { label: 'Send to Virus', title: 'Send the whole single into the chosen edit buffer (message 10)', build: (data, ctx) => msg.single(ctx, 0, unit.part, data) },
      toSyx: (data, ctx) => [msg.single(ctx, 0, SINGLE_PART, data)],
      fromSyx: (msgs) => { const m = msgs.find((x) => cmdOf(x) === 0x10); return m ? upgradeSingle(singleFrom(m)) : null; },
      toCommon: (d) => TR.singleToCommon(d),
      fromCommon: (c, base) => TR.singleFromCommon(c, base),
      category: (d) => TR.singleCategory(d),
      setCategory: (d, id) => TR.singleSetCategory(d, id),
      setName: (d, name) => setName(d, 240, name),
      slots: {
        label: 'Singles', banks: [...RAM_BANKS, ...ROM_BANKS], count: 128,
        slotLabel: (bank, i) => `${bankName(bank).slice(-1)}${slotNumber(i)}`, name: nameOf,
        fetch: (api, bank, i) => fetchSingle(api, bank, i),
        play: async (api, bank, i) => { const d = await fetchSingle(api, bank, i); api.send(msg.single(api.ctx, 0, unit.part, d)); },
        scanBank: scanBank(0x10),
        namesOnOpen: true, // a bank's names are read the first time it is shown (about 2 minutes, in the background)
        store: (bank, i, ctx, data) => msg.single(ctx, bank, i, data),
        writable: (bank) => bank >= 1 && bank <= 4,
        note: (bank) => `Play reads the single and sends it into the edit buffer chosen above. Read names asks for the whole bank (message 32): the Virus sends about one single a second, so a bank takes some two minutes.${bank > 4 ? ' ROM banks cannot be written.' : ' Store writes into this RAM slot (Memory Protect must be Disabled).'}`,
      },
    },
    {
      key: 'multi', page: 'Multi', icon: '▦', label: 'Multi', size: MULTI_SIZE, autoLoad: false,
      init: () => initMulti(), params: multiParams_, name: multiNameOf, cols: 3,
      fetch: (api) => fetchArrangement(api),
      sections: [{ key: 'common', label: 'Common' }, ...partSections, { key: 'reserved', label: 'Reserved bytes' }],
      groupInfo: { 'Reserved bytes': { note: 'Multi bytes and part switch bits the TI2 OS has no parameter for (no screen; parameter messages ignored). Kept so a backup restores exactly (docs/devices/access-virus-ti2.md).', table: true, wide: true } },
      sendParam: (p, _v, data, ctx) => (p.part === undefined ? msg.param(ctx, 0x72, 0, p.offset, data[p.offset]) : msg.param(ctx, 0x72, p.part, p.page, readParam(data, p))),
      note: 'Each change is sent as a multi parameter (message 72). A part plays the single of its Bank and Patch on its MIDI channel; in multi mode the parts\' sounds are in their part edit buffers (Single page, Edit buffer: Multi part n).',
      sendAll: { label: 'Send to Virus', title: 'Send the multi into the multi edit buffer (message 11 00 7F)', build: (data, ctx) => msg.multi(ctx, 0, 0x7f, data) },
      toSyx: (data, ctx) => [msg.multi(ctx, 0, 0x7f, data)],
      fromSyx: (msgs) => { const m = msgs.find((x) => cmdOf(x) === 0x11); return m ? multiFrom(m) : null; },
      toCommon: (d) => TR.multiToCommon(d),
      fromCommon: (c, base) => TR.multiFromCommon(c, base),
      setName: (d, name) => setName(d, 4, name),
      multi: {
        page: 'MIDI channels', label: 'Parts', count: 16, section: (i) => `part${i}`, partLabel: (i) => `Part ${i + 1}`,
        columns: [
          { label: 'Sound', params: ['Sound'], role: 'patch' },
          { label: 'Bank / patch', params: ['Bank', 'Patch'] },
          { label: 'MIDI channel', params: ['MIDI channel'], role: 'channel' },
          { label: 'On', params: ['Part enable'], role: 'on' },
          { label: 'Volume', params: ['Patch Volume'] },
          { label: 'Pan', params: ['Panorama'] },
          { label: 'Key range', params: ['Low Key', 'High Key'] },
          { label: 'Transpose', params: ['Part Transpose'] },
        ],
        on: (i, d) => readParam(d, findMulti(i, 72)) === 1,
        note: 'Each part plays the single in its edit buffer (Sound) on its MIDI channel; Part enable switches it on. Get from device reads the multi and the 16 part singles (arrangement request, about 17 seconds). Changes go to the multi edit buffer; store the multi to keep them.',
      },
      slots: {
        label: 'Multis', banks: [[1, 'RAM multis']], count: 128,
        slotLabel: (_bank, i) => slotNumber(i), name: multiNameOf,
        fetch: (api, bank, i) => fetchMulti(api, bank, i),
        scanBank: scanBank(0x11),
        namesOnOpen: true,
        store: (_bank, i, ctx, data) => msg.multiStore(ctx, i, data),
        writable: () => true,
        note: () => 'Read names asks for all 128 multis (message 33, about one a second). Store writes the multi into its slot (Memory Protect must be Disabled).',
      },
    },
    {
      key: 'global', page: 'Global', icon: '⚙', label: 'Global', size: GLOBAL_SIZE,
      init: () => initGlobal(), params: globalParams_, cols: 3,
      sections: [{ key: 'global', label: 'Settings' }],
      sendParam: (p, _v, data, ctx) => msg.param(ctx, 0x73, 0, p.offset, data[p.offset]),
      note: 'The Virus TI cannot send its global settings (its OS has no global request), so the values shown are Virus Control\'s defaults until you change them here; each change is sent at once (message 73). Memory Protect is shown Disabled, the usual setting.',
    },
    {
      // key 'setup': the remote templates are device settings, not sounds (no Head Library translator)
      key: 'setup', page: 'Remote templates', icon: '◎', label: 'Remote template', size: TEMPLATE_SIZE, autoLoad: false, notLive: true, // sent with Write to the Virus
      init: () => initTemplate(unit.template), params: templateParams_, name: templateNameOf, cols: 4,
      fetch: (api) => fetchTemplate(api, unit.template),
      target: {
        label: 'Template', title: 'Which of the 32 remote templates to read (the global Remote Patch chooses the one Remote mode uses)',
        options: () => REMOTE_TEMPLATES.map((tt) => [tt, templateLabel(tt)]), value: () => unit.template, set: (v) => { unit.template = Number(v); },
      },
      sections: [{ key: 'template', label: 'Template' }, ...PANEL_AREAS.map(([key, label]) => ({ key, label }))],
      note: 'In Remote mode each panel knob sends its record\'s MIDI string (* = the knob\'s value) over its value range and the display shows its name; Master Volume stays the volume (its record holds the template name). Get from device reads the chosen template (32 requests, one at a time). Changes stay in the editor until "Write to the Virus" sends the 32 records into the chosen template (the unit\'s template memory).',
      toSyx: (d, ctx) => templateWrite(ctx, unit.template, d),
      fromSyx: (msgs) => templateFromFile(msgs, unit.template),
      actions: [
        { label: 'Edit knob...', title: 'Change a knob\'s name and MIDI string (the value range and byte 11 are changed in the cards)', run: (api) => editTemplateKnob(api) },
        { label: 'Rename template...', title: 'Change the template name (16 characters)', run: (api) => renameTemplate(api) },
        { label: 'Import .vrt...', title: 'Load a Virus Control remote template file (*.vrt); its knob behaviours are converted to the OS\'s range types', run: (api) => importVrt(api) },
        { label: 'Write to the Virus', title: 'Send the 32 records (13 tt kk) into the chosen template of the unit', run: (api) => writeTemplate(api) },
      ],
    },
  ],
  // The TI sends one dump a second whatever is asked (a bank, or slots one by one: it keeps only the
  // latest request), so a bank takes 128 s; each step ends as soon as its expected dumps are in.
  // Remote template records: the TI answers each in about 0.11 s (measured: 126 ms a record at the
  // measured 20 ms pace, 150 ms at the DIN default of 150 ms). ROM banks: 26 x 128 s, optional but ticked.
  fullDumpPace: 'The Virus itself sends one dump a second whatever the link (its OS times them; measured over USB), so the banks take the same time on any connection. The request pace only shortens the 1024 template records a little (the Virus takes about 0.11 s for each).',
  // accept: each step records only its own replies (a knob turned meanwhile, or a late dump, is not
  // counted: the steps after it would shift)
  fullDump: [
    { request: 'Single edit buffer', expect: 1, timeout: 3000, seconds: 1, accept: (raw) => cmdOf(raw) === 0x10 && raw[7] === 0 && raw[8] === SINGLE_PART },
    { request: 'Arrangement (multi and its 16 singles)', expect: 17, timeout: 30000, seconds: 17, accept: (raw) => raw[7] === 0 && ((cmdOf(raw) === 0x10 && raw[8] < 16) || cmdOf(raw) === 0x11) },
    ...RAM_BANKS.map(([b, l]) => ({ request: `${l} singles`, expect: 128, timeout: 20000, seconds: 128, accept: (raw) => cmdOf(raw) === 0x10 && raw[7] === b })),
    { request: 'RAM multis', expect: 128, timeout: 20000, seconds: 128, accept: (raw) => cmdOf(raw) === 0x11 && raw[7] === 1 },
    ...REMOTE_TEMPLATES.flatMap((tt) => [0x20, ...TEMPLATE_KNOBS].map((kk) => ({ label: `${templateLabel(tt)} ${kk === 0x20 ? 'name' : `knob ${kk}`}`, bytes: (ctx) => msg.remoteTemplateRequest(ctx, tt, kk), expect: 1, timeout: 1500, quiet: 200, seconds: 0.13, group: 'the 32 remote templates (one request per record)', accept: (raw) => cmdOf(raw) === 0x13 && raw[7] === tt && raw[8] === kk }))),
    ...ROM_BANKS.map(([b, l]) => ({ request: `${l} singles`, expect: 128, timeout: 20000, seconds: 128, group: 'ROM banks A-Z (the factory sounds)', optional: true, accept: (raw) => cmdOf(raw) === 0x10 && raw[7] === b })),
  ],
  requests: [
    { label: 'Single edit buffer', bytes: (ctx) => msg.singleRequest(ctx, 0, SINGLE_PART) },
    ...Array.from({ length: 16 }, (_, i) => ({ label: `Part ${i + 1} single`, bytes: (ctx) => msg.singleRequest(ctx, 0, i) })),
    { label: 'Multi edit buffer', bytes: (ctx) => msg.multiRequest(ctx, 0, 0) },
    { label: 'Arrangement (multi and its 16 singles)', bytes: (ctx) => msg.arrangementRequest(ctx) },
    ...RAM_BANKS.map(([b, l]) => ({ label: `${l} singles`, bytes: (ctx) => msg.singleBankRequest(ctx, b) })),
    ...ROM_BANKS.map(([b, l]) => ({ label: `${l} singles`, bytes: (ctx) => msg.singleBankRequest(ctx, b) })),
    { label: 'RAM multis', bytes: (ctx) => msg.multiBankRequest(ctx, 1) },
    ...REMOTE_TEMPLATES.map((tt) => ({ label: `${templateLabel(tt)} name`, bytes: (ctx) => msg.remoteTemplateRequest(ctx, tt, 0x20) })),
  ],
};

export default DEF;

/**
 * The same editor for another model of the TI family (thin files access-virus-ti-*.js, access-virus-ti2-*.js):
 * the TI and TI2 Desktop, Keyboard and Polar run one host OS (vti.bin and vti_2.bin differ in one byte at 000A, the
 * DSP code is the same), so only the name and the note on what was checked differ.
 */
export function tiModel({ model, note }) {
  return { ...DEF, model, coverage: `${model}: ${note} ${DEF.coverage}` };
}

export const _test = { unit, PAGES, byOffset, partAt, findMulti, writeParam, readParam, libraryItems };
