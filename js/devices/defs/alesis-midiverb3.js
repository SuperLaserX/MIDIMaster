// Alesis MIDIVerb III (1989 rack multi-effect: reverb, delay, chorus / flange and EQ at once, 3-digit LED):
// MIDI implementation taken from the v1.01 EPROM (27C256, 8031 code). See docs/devices/alesis-midiverb3.md.
//
// Memory (EEPROM 0000-06D5, the 1750 bytes of a dump): 0000 + 16n user program 100 + n (n = 0-99), 0640 the
// edit buffer (the current program as edited), 0650 current program 0-199, 0651 edited flag, 0652 the map
// entry the MIDI PROG page shows, 0653 MIDI echo, 0654 MIDI channel - 1, 0655 program change on, 0656-06D5 the
// MIDI program map (program change 0-127 -> program 0-199). Programs 000-099 are the factory programs in ROM
// (4000). A program is 16 bytes (Alesis service manual, section 9: 0 input EQ, 1 effect EQ, 2 chorus
// algorithm, 3 chorus speed, 4 / 5 delay time MSB / LSB, 6 delay regeneration, 7 reverb algorithm,
// 8 reverb decay, 9 reverb mix, 10 delay mix, 11 configuration, 12 modulation routing, 13 modulation
// amplitude, 14-15 spare).
//
// SysEx F0 00 00 0E 03 <op> ... F7, no channel byte (header check 2FF0; op < 8, jump table 3031):
//   00 <1750 bytes as bits 0-6, bit 7>   all data (3261): written to EEPROM 0000 on, then the unit restarts
//   01 n <16 bytes as bits 0-6, bit 7>   one program into the edit buffer (3049); n < 100 also stores it as
//                                        user program 100 + n and makes that the current program
//   02                                   request: the unit answers with 00 (3320)
//   03 p <bits 0-6> <bit 7 | bits 8-9 << 1>   parameter p 0-14 of the edit buffer (310F; limits 31C1)
// Nothing else is sent but MIDI echo. Programs and settings use no names; v1.00 has the same MIDI code.

import { DESCRIPTORS, FORMATS, PAGES, DELAY_MAX, SYSEX_PARAMS, RECALL_LIMIT, FACTORY, FIRMWARE } from './alesis-midiverb3-fw.js';
import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, nearestName, tidy } from './translate-helpers.js';

export { DESCRIPTORS, FORMATS, PAGES, DELAY_MAX, SYSEX_PARAMS, RECALL_LIMIT, FACTORY, FIRMWARE };

const HDR = [0xf0, 0x00, 0x00, 0x0e, 0x03];
export const SIZE = 16;
export const MEM = { size: 0x6d6, edit: 0x640, current: 0x650, edited: 0x651, mapSel: 0x652, echo: 0x653, channel: 0x654, progChange: 0x655, map: 0x656 };
export const EDIT_ONLY = 0x7f; // opcode 01 with a number of 100 or more loads the edit buffer only
const FAMILY = 'alesis-midiverb3';
const DELAY_MAX_MS = 1500; // the delay scale the Alesis translators share (Quadraverb)

const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
export const isMidiverb3 = (raw) => raw?.[0] === 0xf0 && raw.length > 6 && HDR.every((b, i) => raw[i] === b);
const isEchoHeader = (raw) => raw?.length === 6 && HDR.every((b, i) => raw[i] === b) && raw[5] === 0xf7;
const op = (raw) => raw[5];

// ------------------------------------------------------------------ messages
const pairs = (bytes) => Array.from(bytes).flatMap((b) => [b & 0x7f, (b >> 7) & 1]);
function unpair(raw, at, n) {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = ((raw[at + 2 * i] ?? 0) & 0x7f) | (((raw[at + 2 * i + 1] ?? 0) & 1) << 7);
  return d;
}
/** The program byte a SysEx parameter number (opcode 03) writes: 0-3 the same, 4 = delay time (4 / 5), 5-14 -> 6-15. */
export const paramOffset = (p) => (p < 4 ? p : p === 4 ? 4 : p + 1);

export const msg = {
  request: () => [...HDR, 0x02, 0xf7],
  dump: (mem) => [...HDR, 0x00, ...pairs(mem.slice(0, MEM.size)), 0xf7],
  program: (n, d) => [...HDR, 0x01, n & 0x7f, ...pairs(d.slice(0, SIZE)), 0xf7],
  param: (p, v) => (p === 4
    ? [...HDR, 0x03, 4, v & 0x7f, ((v >> 7) & 1) | (((v >> 8) & 3) << 1), 0xf7]
    : [...HDR, 0x03, p & 0x7f, v & 0x7f, (v >> 7) & 1, 0xf7]),
};
/** The 1750 memory bytes of an opcode 00 dump (as many as it holds; the unit takes a short one as it is). */
export function memFrom(raw) {
  const m = initMemory();
  const n = Math.min(MEM.size, Math.floor((raw.length - 7) / 2));
  m.set(unpair(raw, 6, n), 0);
  return m;
}
const programFrom = (raw) => unpair(raw, 7, SIZE);

// ------------------------------------------------------------------ programs
export const factoryProgram = (n) => hex(FACTORY[Math.max(0, Math.min(99, n))]);
export const userProgram = (mem, n) => Uint8Array.from(mem.slice(16 * n, 16 * n + 16));
const texts = (desc) => FORMATS[DESCRIPTORS[desc].fmt].texts;
const cfgOf = (d) => Math.min(14, d[11]);
// the button position of each program byte (4400: 0-4 REVERB, DELAY, CHORUS, EQ, MIX with the lower EDIT LED,
// 5-9 with the upper one, 10 CONFIG, 11 / 12 MOD); PAGES[cfg][position] is the descriptor shown there
const POS_OF = { 8: 0, 6: 1, 3: 2, 1: 3, 10: 4, 7: 5, 4: 6, 2: 7, 0: 8, 9: 9, 11: 10, 12: 11, 13: 12 };
const NONE = DESCRIPTORS.findIndex((x) => x.routine === '03F3'); // shows "---"
/** Whether configuration `cfg` shows program byte `off` (configurations 14 and 15 show "---" for the reverb). */
export const shown = (cfg, off) => PAGES[cfg][POS_OF[off]] !== NONE;
export const delayOf = (d) => (d[4] << 8) | d[5];
export const hasReverb = (cfg) => shown(cfg, 7);
export const preDelayed = (cfg) => [0, 6, 12].includes(cfg); // the delay feeds the reverb (configurations 1, 7, 13)

/** Limit a program the way recalling it does (29EB: table 31D0) and its delay time to the configuration (11AF). */
export function fitProgram(d) {
  let changed = 0;
  for (let i = 0; i < SIZE; i++) if (i !== 4 && i !== 5 && d[i] > RECALL_LIMIT[i]) { d[i] = RECALL_LIMIT[i]; changed++; }
  const t = delayOf(d);
  const lim = DELAY_MAX[cfgOf(d)];
  const ms = Math.max(1, Math.min(lim, t));
  if (ms !== t) { d[4] = ms >> 8; d[5] = ms & 0xff; changed++; }
  return changed;
}
const fitted = (d) => { const x = Uint8Array.from(d.slice(0, SIZE)); fitProgram(x); return x; };

// screen names: the Alesis reference manual (front panel and section 4) and service manual (program bytes);
// the firmware itself holds only the LED texts
const CONFIG_PATHS = ['EQ > CHRS > DELAY > REVERB', 'EQ > CHRS > REVERB, EQ > CHRS > DELAY', 'EQ > CHRS > REVERB, DELAY',
  'EQ > CHRS > REVERB, EQ > DELAY', 'EQ > REVERB, CHRS > DELAY', 'EQ > DELAY, CHRS > REVERB'];
export const CONFIGS = Array.from({ length: 15 }, (_, c) => {
  const path = c < 12 ? CONFIG_PATHS[c % 6] : c === 12 ? 'EQ > DELAY > REVERB, CHRS' : 'EQ > CHRS > DELAY (up to 490 ms, no reverb)';
  const out = c < 6 || c === 12 || c === 13;
  return `${texts(10)[c]}: ${path}${out ? '; chorus also to the output' : '; chorus on the effects only'}${preDelayed(c) ? '; delay = reverb pre-delay' : ''}`;
});
export const REVERB_NAMES = ['Room 1', 'Room 2', 'Room 3', 'Room 4', 'Hall 1', 'Hall 2', 'Hall 3', 'Hall 4', 'Chamber 1', 'Chamber 2', 'Chamber 3', 'Chamber 4',
  'Plate 1', 'Plate 2', 'Plate 3', 'Plate 4', 'Gate 1', 'Gate 2', 'Reverse 1', 'Reverse 2'];
export const REVERB_KINDS = ['SMALL ROOM', 'SMALL ROOM', 'MEDIUM ROOM', 'LARGE ROOM', 'SMALL HALL', 'SMALL HALL', 'MEDIUM HALL', 'LARGE HALL',
  'MEDIUM CHAMBER', 'MEDIUM CHAMBER', 'LARGE CHAMBER', 'PERCUSSION CHAMBER', 'PERCUSSION PLATE', 'TIGHT PLATE', 'SOFT PLATE', 'VOCAL PLATE',
  'BRIGHT GATE', 'POWER GATE', 'MEDIUM REVERSE', 'SLOW REVERSE'];
const DEPTHS = ['smallest', 'small', 'medium', 'medium', 'big', 'biggest'];
const chorusName = (v) => (v ? `${v > 12 ? (v > 18 ? 'Stereo flange' : 'Mono flange') : v > 6 ? 'Stereo chorus' : 'Mono chorus'} ${((v - 1) % 6) + 1} (${DEPTHS[(v - 1) % 6]} depth)` : 'Off');
const SOURCES = { P: 'Pitch bend', 1: 'Controller 1 (mod wheel)', n: 'Note number', U: 'Note velocity', A: 'Aftertouch', S: 'Sustain pedal (controller 64)', b: 'Breath controller (controller 2)', 7: 'Volume pedal (controller 7)' };
const TARGETS = { rd: 'Reverb decay', dt: 'Delay time', dr: 'Delay regeneration', cs: 'Chorus speed', rL: 'Reverb level', dL: 'Delay level' };
const modName = (t) => (t === 'OFF' ? null : `${SOURCES[t[0]]} → ${TARGETS[t.slice(1)]}`);

/** A name for a program (the MIDIVerb III has none): configuration, reverb, chorus and delay as the LED shows them. */
export function nameOf(d) {
  const cfg = cfgOf(d);
  const parts = [`Config ${texts(10)[cfg]}`];
  if (hasReverb(cfg)) parts.push(texts(5)[d[7]] ?? '?');
  if (d[2]) parts.push(texts(7)[d[2]] ?? '?');
  parts.push(`${delayOf(d)}ms`);
  return parts.join(' ');
}

const sendParam = (p) => (_v, _ctx, data) => { const d = fitted(data); return msg.param(p, p === 4 ? delayOf(d) : d[paramOffset(p)]); };
const levelParam = (key, group, label, off, p, help) => ({
  key, group, label, offset: off, min: 0, max: 99, sendKey: key, send: sendParam(p), format: (v) => texts(0)[v] ?? String(v), help,
  dynamic: (d) => (shown(cfgOf(d), off) ? {} : { hidden: true }),
});
const ledOptions = (desc, name) => texts(desc).map((t, v) => { const n = name?.(v, t); return [v, n ? `${t}: ${n}` : t]; });

const programParams = [
  { key: 'config', group: 'Configuration', label: 'CONFIG', offset: 11, options: CONFIGS.map((t, c) => [c, t]), relayout: true, sendKey: 'config', send: sendParam(10),
    help: 'CONFIG button: how the EQ, chorus, delay and reverb are connected (manual figure 10). LED 01-15',
    after: (d) => (fitProgram(d) ? 'DELAY TIME limited to the configuration\'s longest delay (the unit does the same, 11AF).' : null) },
  { key: 'inEq', group: 'EQ', label: 'INPUT EQ', offset: 0, sendKey: 'inEq', send: sendParam(0), options: ledOptions(8, (_v, t) => (t === 'OFF' ? 'no high cut' : `${t} kHz high cut`)),
    help: 'EQ button, upper EDIT LED: a 6 dB/octave high-cut on the input; the LED shows the -3 dB point in kHz' },
  { key: 'fxEq', group: 'EQ', label: 'EFFECT EQ', offset: 1, sendKey: 'fxEq', send: sendParam(1), options: ledOptions(3, (_v, t) => (t === 'OFF' ? 'no high cut' : `${t} kHz high cut`)),
    help: 'EQ button, lower EDIT LED: a high-cut inside the effect (the reverb\'s high-frequency decay; in configurations 14 and 15 the delay regeneration\'s)' },
  { key: 'chAlg', group: 'Chorus', label: 'CHORUS ALGORITHM', offset: 2, sendKey: 'chAlg', send: sendParam(2), options: ledOptions(7, (v) => (v ? chorusName(v) : null)),
    help: 'CHORUS button, upper EDIT LED: C1-C6 mono / SC1-SC6 stereo chorus, F1-F6 mono / SF1-SF6 stereo flange (manual figure 6); OFF' },
  { key: 'chSpeed', group: 'Chorus', label: 'CHORUS SPEED', offset: 3, min: 0, max: 98, sendKey: 'chSpeed', send: sendParam(3), format: (v) => texts(2)[v] ?? String(v),
    help: 'CHORUS button, lower EDIT LED: the sweep (flanging) or detune amount (chorus); LED 01-99' },
  { key: 'dlTime', group: 'Delay', label: 'DELAY TIME', offset: 4, size: 2, min: 1, max: 490, input: 'number', unit: 'ms', sendKey: 'dlTime', send: sendParam(4),
    dynamic: (d) => ({ max: DELAY_MAX[cfgOf(d)], label: preDelayed(cfgOf(d)) ? 'DELAY TIME (reverb pre-delay)' : 'DELAY TIME', help: `DELAY button, upper EDIT LED: 1-${DELAY_MAX[cfgOf(d)]} ms in this configuration (LED 001-${DELAY_MAX[cfgOf(d)]}); bytes 4 / 5 hold it high byte first` }) },
  levelParam('dlRegen', 'Delay', 'DELAY REGENERATION', 6, 5, 'DELAY button, lower EDIT LED: the part of the delay fed back (number of repeats); LED 00-99'),
  levelParam('dlMix', 'Delay', 'DELAY MIX', 10, 9, 'MIX button, lower EDIT LED: the delay output level; LED 00-99'),
  { key: 'rvAlg', group: 'Reverb', label: 'REVERB ALGORITHM', offset: 7, sendKey: 'rvAlg', send: sendParam(6), options: ledOptions(5, (v) => `${REVERB_NAMES[v]} (${REVERB_KINDS[v].toLowerCase()})`),
    help: 'REVERB button, upper EDIT LED: 20 reverbs (manual figure 5)',
    dynamic: (d) => (shown(cfgOf(d), 7) ? {} : { hidden: true }) },
  levelParam('rvDecay', 'Reverb', 'REVERB DECAY', 8, 7, 'REVERB button, lower EDIT LED: the reverb length (not used by Reverse 1 and 2); LED 00-99'),
  levelParam('rvMix', 'Reverb', 'REVERB MIX', 9, 8, 'MIX button, upper EDIT LED: the reverb output level; LED 00-99'),
  { key: 'modRoute', group: 'Modulation', label: 'MOD ROUTING', offset: 12, sendKey: 'modRoute', send: sendParam(11), options: ledOptions(11, (_v, t) => modName(t)),
    help: 'MOD button (first press): which MIDI controller on the MIDI channel changes which parameter; LED: source letter, then the parameter (manual figure 10)' },
  { key: 'modAmp', group: 'Modulation', label: 'MOD AMPLITUDE', offset: 13, sendKey: 'modAmp', send: sendParam(12), options: ledOptions(16),
    help: 'MOD button (second press): how far the controller moves the parameter, -99 to 99 (stored 0-198; the LED shows no plus sign)' },
  ...[14, 15].map((off) => ({
    key: `spare${off}`, group: 'Spare', label: `Spare byte ${off}`, offset: off, min: 0, max: 255, input: 'number', readOnly: true,
    help: 'Spare in the service manual; no page, display or DSP routine of v1.01 reads it. Kept as stored (factory programs 80 and 96 hold FF / D2 F0 here); opcode 03 parameter 13 / 14 writes it',
  })),
];

// ------------------------------------------------------------------ memory (MIDI settings, program map)
export function initMemory() {
  // what INT. PROG + STORE at power-on leaves (010B-0169): the factory programs in 100-199, program 000 current
  // and unedited, MIDI channel 1, program change and echo on, the map 000-127 to programs 000-127
  const m = new Uint8Array(MEM.size);
  for (let n = 0; n < 100; n++) m.set(factoryProgram(n), 16 * n);
  m.set(factoryProgram(0), MEM.edit);
  m[MEM.current] = 0; m[MEM.edited] = 0; m[MEM.mapSel] = 0; m[MEM.channel] = 0; m[MEM.progChange] = 1; m[MEM.echo] = 1;
  for (let i = 0; i < 128; i++) m[MEM.map + i] = i;
  return m;
}
const progLabel = (v) => `${pad3(v)} (${v < 100 ? 'factory' : 'user'})`;
const progOptions = Array.from({ length: 200 }, (_, v) => [v, progLabel(v)]);
const systemParams = [
  { key: 'channel', section: 'midi', group: 'MIDI', label: 'MIDI CHANNEL', offset: MEM.channel, options: ledOptions(14, (v) => `channel ${v + 1}`), help: 'MIDI button, first page (c01-c16): the receive channel' },
  { key: 'progChange', section: 'midi', group: 'MIDI', label: 'MIDI PROGRAM CHANGE', offset: MEM.progChange, options: ledOptions(15, (v) => (v ? 'on' : 'off')), help: 'MIDI button, second page: PoF ignores program changes, Pon recalls the mapped program' },
  { key: 'echo', section: 'midi', group: 'MIDI', label: 'MIDI ECHO', offset: MEM.echo, options: ledOptions(19, (v) => (v ? 'on' : 'off')), help: 'MIDI button, third page: send everything received back out of MIDI OUT/THRU (not SysEx for the MIDIVerb III)' },
  { key: 'mapSel', section: 'midi', group: 'MIDI', label: 'MIDI PROG page', offset: MEM.mapSel, options: Array.from({ length: 128 }, (_, v) => [v, pad3(v)]), help: 'The program change number the MIDI PROG page shows, whose program the INT. PROG page sets' },
  { key: 'current', section: 'midi', group: 'Current program', label: 'Program', offset: MEM.current, options: progOptions, help: 'The program selected when the unit starts (PROGRAM mode display)' },
  { key: 'edited', section: 'midi', group: 'Current program', label: 'Edit buffer', offset: MEM.edited, options: [[0, 'As stored'], [1, 'Edited (dot after the program number)']], help: 'Set when a parameter changes, cleared when a program is recalled or stored' },
  ...Array.from({ length: 128 }, (_, n) => ({
    key: `map${n}`, section: 'map', group: 'MIDI program map', label: `MIDI ${pad3(n)}`, offset: MEM.map + n, options: progOptions,
    help: `MIDI PROG ${pad3(n)} -> INT. PROG: the program a program change ${n} recalls (with Pon)`,
  })),
];

// ------------------------------------------------------------------ simulator
function simulate() {
  const st = { mem: initMemory(), restarts: 0 };
  return {
    state: st,
    handle(d) {
      if (!isMidiverb3(d)) return null;
      const k = op(d);
      const m = st.mem;
      if (k === 0x02) return [msg.dump(m)];
      if (k === 0x00) { m.set(memFrom(d).slice(0, Math.min(MEM.size, Math.floor((d.length - 7) / 2))), 0); st.restarts++; return []; }
      if (k === 0x01) {
        const n = d[6];
        const p = programFrom(d);
        m.set(p, MEM.edit);
        if (n < 100) { m.set(p, 16 * n); m[MEM.current] = n + 100; m[MEM.edited] = 0; } else m[MEM.edited] = 1;
        const e = m.slice(MEM.edit, MEM.edit + SIZE);
        if (delayOf(e) > DELAY_MAX[cfgOf(e)]) { m[MEM.edit + 4] = DELAY_MAX[cfgOf(e)] >> 8; m[MEM.edit + 5] = DELAY_MAX[cfgOf(e)] & 0xff; }
        return [];
      }
      if (k === 0x03 && d[6] < 15) {
        const p = d[6];
        const v = Math.min(SYSEX_PARAMS[p].limit, (d[7] & 0x7f) | ((d[8] & 1) << 7));
        if (p === 4) { m[MEM.edit + 4] = (d[8] >> 1) & 3; m[MEM.edit + 5] = v; } else m[MEM.edit + paramOffset(p)] = v;
        m[MEM.edited] = 1;
        if (SYSEX_PARAMS[p].dsp === '11AF') { // configuration / reverb algorithm: 11AF limits the delay time
          const e = m.slice(MEM.edit, MEM.edit + SIZE);
          const lim = DELAY_MAX[cfgOf(e)];
          if (delayOf(e) > lim) { m[MEM.edit + 4] = lim >> 8; m[MEM.edit + 5] = lim & 0xff; }
        }
      }
      return [];
    },
  };
}

// ------------------------------------------------------------------ monitor text, library
function describe(raw) {
  if (isEchoHeader(raw)) return 'MIDIVerb III SysEx header echoed (MIDI ECHO on)';
  if (!isMidiverb3(raw)) return null;
  const k = op(raw);
  if (k === 0) return `MIDIVerb III all data (${Math.floor((raw.length - 7) / 2)} bytes: user programs 100-199, edit buffer, MIDI settings, program map)`;
  if (k === 1) return raw[6] < 100 ? `MIDIVerb III program to user ${100 + raw[6]} "${nameOf(programFrom(raw))}"` : `MIDIVerb III program to the edit buffer "${nameOf(programFrom(raw))}"`;
  if (k === 2) return 'MIDIVerb III request all data';
  if (k === 3) {
    const p = raw[6];
    const v = (raw[7] & 0x7f) | ((raw[8] & 1) << 7) | (p === 4 ? ((raw[8] >> 1) & 3) << 8 : 0);
    const prm = programParams.find((x) => x.send && x.offset === paramOffset(p));
    return `MIDIVerb III parameter ${p}${prm ? ` ${prm.label}` : ''} = ${v}`;
  }
  return `MIDIVerb III opcode ${k}`;
}

function libraryItems(msgs) {
  const items = [];
  for (const m of msgs) {
    if (!isMidiverb3(m)) { items.push({ key: `x${items.length}`, label: isEchoHeader(m) ? 'MIDI echo of a SysEx header' : 'Other message', name: '', object: null, msgs: [m] }); continue; }
    const k = op(m);
    if (k === 0) {
      const mem = memFrom(m);
      for (let n = 0; n < 100; n++) {
        const d = userProgram(mem, n);
        items.push({ key: `u${n}`, label: `User ${100 + n}`, name: nameOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(msg.program(n, d))] });
      }
      const e = mem.slice(MEM.edit, MEM.edit + SIZE);
      items.push({ key: `e${items.length}`, label: 'Edit buffer', name: nameOf(e), object: 'effect', data: e, msgs: [Uint8Array.from(msg.program(EDIT_ONLY, e))] });
      items.push({ key: `s${items.length}`, label: 'Memory (MIDI settings, program map, all user programs)', name: '', object: 'system', data: mem, msgs: [m] });
    } else if (k === 1) {
      const d = programFrom(m);
      items.push({ key: m[6] < 100 ? `u${m[6]}` : `e${items.length}`, label: m[6] < 100 ? `User ${100 + m[6]}` : 'Edit buffer', name: nameOf(d), object: 'effect', data: d, msgs: [m] });
    } else items.push({ key: `o${items.length}`, label: k === 2 ? 'MIDIVerb III request' : 'MIDIVerb III parameter edit', name: '', object: null, msgs: [m] });
  }
  return items;
}

async function readMemory(api) {
  return api.request(msg.request(), (r) => isMidiverb3(r) && op(r) === 0, (r) => memFrom(r));
}
const programFromSyx = (msgs) => {
  const m = msgs.find((r) => isMidiverb3(r) && (op(r) === 0 || op(r) === 1));
  if (!m) return null;
  return op(m) === 0 ? memFrom(m).slice(MEM.edit, MEM.edit + SIZE) : programFrom(m);
};

// ------------------------------------------------------------------ Head Library
const u = (v, max) => Math.max(0, Math.min(1, v / max));
const CHORUS_TYPES = ['MONO CHORUS', 'STEREO CHORUS', 'MONO FLANGE', 'STEREO FLANGE'];
function toCommon(d) {
  const cfg = cfgOf(d);
  const effects = {};
  const ms = delayOf(d);
  if (hasReverb(cfg)) {
    effects.reverb = { type: REVERB_KINDS[d[7]] || 'SMALL ROOM', time: u(d[8], 99), level: u(d[9], 99) };
    if (preDelayed(cfg)) effects.reverb.preDelay = u(ms, 140);
  }
  effects.delay = { type: 'MONO DELAY', time: u(ms, DELAY_MAX_MS), feedback: u(d[6], 99), level: u(d[10], 99) };
  if (d[2]) {
    const g = Math.floor((d[2] - 1) / 6);
    const m = { type: CHORUS_TYPES[g], rate: u(d[3], 98), depth: ((d[2] - 1) % 6) / 5, level: 1 };
    effects.modulation = m;
    if (g < 2) effects.chorus = { ...m };
  }
  return { model: 1, kind: 'effect', effects, extra: { family: FAMILY, model: 'alesis-midiverb3', configuration: CONFIGS[cfg], data: Array.from(d.slice(0, SIZE)), match: hashBytes(d.slice(0, SIZE)) } };
}
function fromCommon(c, base) {
  const r = emptyReport();
  const x = c?.extra;
  if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
    const d = Uint8Array.from(x.data);
    if (fitProgram(d)) r.approximated.push('Values outside their ranges limited');
    r.mapped.push(`Program (exact, configuration ${texts(10)[cfgOf(d)]})`);
    return { data: d, report: tidy(r) };
  }
  const fx = c?.effects || {};
  const on = (e) => e && (e.level ?? 1) > 0;
  const rv = on(fx.reverb);
  const dl = on(fx.delay);
  const md = [fx.modulation, fx.chorus].find(on);
  if (!rv && !dl && !md) {
    r.dropped.push('No effect in the source sound: the program keeps its settings');
    return { data: Uint8Array.from(base || factoryProgram(0)), report: tidy(r) };
  }
  // reverb with pre-delay: configuration 1; reverb: 2 (chorus to reverb and delay); no reverb: 14 (490 ms delay)
  const cfg = rv ? ((fx.reverb.preDelay ?? 0) > 0 ? 0 : 1) : 13;
  let n = FACTORY.findIndex((h) => hex(h)[11] === cfg);
  if (n < 0) n = 0;
  const d = factoryProgram(n);
  d[11] = cfg;
  r.approximated.push(`Configuration ${CONFIGS[cfg]}, starting from factory program ${pad3(n)}`);
  const put = (o, v, max, what, min = 0) => {
    if (v === undefined || v === null || Number.isNaN(v)) return;
    d[o] = Math.max(min, Math.min(max, Math.round(v * max)));
    r.approximated.push(what);
  };
  const setMs = (ms, what) => { const t = Math.max(1, Math.min(DELAY_MAX[cfg], Math.round(ms))); d[4] = t >> 8; d[5] = t & 0xff; r.approximated.push(`${what} → ${t} ms`); };
  if (rv) {
    const k = nearestName(fx.reverb.type || 'HALL', REVERB_KINDS);
    d[7] = k >= 0 ? k : 4;
    r.approximated.push(`Reverb type → ${texts(5)[d[7]]} ${REVERB_NAMES[d[7]]}`);
    put(8, fx.reverb.time, 99, 'Reverb time → REVERB DECAY');
    put(9, fx.reverb.level, 99, 'Reverb level → REVERB MIX');
    if (cfg === 0) setMs((fx.reverb.preDelay ?? 0) * 140, 'Pre-delay → DELAY TIME');
  }
  if (dl) {
    if (fx.delay.time !== undefined && cfg !== 0) setMs(fx.delay.time * DELAY_MAX_MS, 'Delay time');
    else if (fx.delay.time !== undefined) r.dropped.push('Delay time (the delay is the reverb pre-delay here)');
    put(6, fx.delay.feedback, 99, 'Delay feedback → DELAY REGENERATION');
    put(10, fx.delay.level, 99, 'Delay level → DELAY MIX');
  } else { d[10] = 0; r.approximated.push('No delay: DELAY MIX 00'); }
  if (md) {
    const t = String(md.type || '').toUpperCase();
    const g = (/FLANG/.test(t) ? 2 : 0) + (/STEREO|ENSEMBLE|WIDE/.test(t) ? 1 : 0);
    d[2] = 1 + 6 * g + Math.max(0, Math.min(5, Math.round((md.depth ?? 0.4) * 5)));
    r.approximated.push(`${md.type || 'Modulation'} → CHORUS ALGORITHM ${texts(7)[d[2]]}`);
    put(3, md.rate, 98, 'Modulation rate → CHORUS SPEED');
    if (md.level !== undefined && md.level < 1) r.dropped.push('Modulation level (the chorus level is fixed)');
  } else { d[2] = 0; r.approximated.push('No chorus: CHORUS ALGORITHM OFF'); }
  for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'modulation', 'chorus'].includes(k)) r.dropped.push(`Effect ${k}`);
  fitProgram(d);
  return { data: d, report: tidy(r) };
}

// ------------------------------------------------------------------ definition
const FACTORY_NAMES = FACTORY.map((h) => nameOf(hex(h)));

export default {
  coverage: `Every byte of a program (each parameter with the text its LED display routine shows, from ${FIRMWARE}; names from the Alesis manuals: the firmware holds none), the MIDI settings and the MIDI program map, the 100 factory programs. Live parameter edits, edit buffer and user program writes, the all-data dump. Not checked on hardware.`,
  sysex: { manufacturer: [0x00, 0x00, 0x0e], model: 0x03 },
  // a program message writes 34 EEPROM bytes (each polled at 06D6) while MIDI waits in a 256-byte ring
  minGap: 400,
  describe,
  recognise: (raw) => isMidiverb3(raw) || isEchoHeader(raw),
  isOwn: isMidiverb3,
  isRequest: (raw) => isMidiverb3(raw) && op(raw) === 2,
  simulate,
  libraryItems,
  objects: [
    {
      key: 'effect', page: 'Program', icon: '◆', label: 'Edit buffer', size: SIZE, autoLoad: true,
      init: () => factoryProgram(0),
      request: () => msg.request(),
      match: (raw) => isMidiverb3(raw) && op(raw) === 0,
      decode: (raw) => memFrom(raw).slice(MEM.edit, MEM.edit + SIZE),
      receive: (raw) => (isMidiverb3(raw) && op(raw) === 0 ? memFrom(raw).slice(MEM.edit, MEM.edit + SIZE) : null),
      params: programParams,
      name: nameOf,
      category: () => 'none',
      patchKinds: ['effect'],
      toCommon,
      fromCommon,
      cols: 4,
      layout: [{ group: 'Configuration', wide: true }, { group: 'Reverb' }, { group: 'Delay' }, { group: 'Chorus' }, { group: 'EQ' }, { group: 'Modulation' }, { group: 'Spare' }],
      note: 'Each change goes to the edit buffer at once (SysEx opcode 03). Reading asks for all data (opcode 02, about 3.5 KB). Programs have no names: the name shown is made from the configuration, reverb, chorus and delay time.',
      sendAll: { label: 'Send to edit buffer', title: 'Send the whole program to the edit buffer (opcode 01 with number 127: nothing is stored)', build: (data) => msg.program(EDIT_ONLY, fitted(data)) },
      toSyx: (data) => msg.program(EDIT_ONLY, fitted(data)),
      fromSyx: programFromSyx,
      actions: [
        { label: 'Store as user program', title: 'Send the program as user program 100-199 (opcode 01); the unit stores it and selects it', run: async (api) => {
          const f = await api.form('Store into user program', [{ key: 'n', label: 'User program (100-199)', value: '100', type: 'number', min: 100, max: 199 }]);
          if (!f) return;
          const n = Math.max(100, Math.min(199, Math.round(Number(f.n) || 100)));
          api.send(msg.program(n - 100, fitted(api.data)));
        } },
      ],
      slots: {
        label: 'Programs', banks: [[0, 'User 100-199'], [1, 'Factory 000-099']], count: 100,
        slotLabel: (bank, i) => pad3(bank ? i : 100 + i),
        note: (bank) => (bank ? 'Factory programs are in ROM (table 4000); a reset copies them into 100-199. '
          : 'Reading a user program reads all data (the unit sends nothing smaller). Writing one (opcode 01) also selects it. ')
          + 'Play sends a program change, which recalls what the MIDI program map holds for it (000-127 to themselves after a reset; 128-199 only through the map).',
        names: (bank) => (bank === 1 ? FACTORY_NAMES : null),
        writable: (bank) => bank === 0,
        name: nameOf,
        recall: (bank, i, ctx) => { const p = bank ? i : 100 + i; return p < 128 ? [[0xc0 | ((ctx?.channel ?? 0) & 15), p]] : []; },
        fetch: async (api, bank, i) => (bank === 1 ? factoryProgram(i) : userProgram(await readMemory(api), i)),
        scanBank: async (api, bank, onName) => {
          if (bank === 1) { FACTORY_NAMES.forEach((s, i) => onName(i, s)); return; }
          const mem = await readMemory(api);
          for (let i = 0; i < 100; i++) onName(i, nameOf(userProgram(mem, i)));
        },
        store: (_bank, i, _ctx, data) => msg.program(i, fitted(data)),
      },
    },
    {
      key: 'system', page: 'Memory', icon: '⚙', label: 'Memory', size: MEM.size, notLive: true, autoLoad: true,
      init: initMemory,
      fetch: readMemory,
      receive: (raw) => (isMidiverb3(raw) && op(raw) === 0 ? memFrom(raw) : null),
      sections: [{ key: 'midi', label: 'MIDI and current program' }, { key: 'map', label: 'MIDI program map' }],
      params: systemParams,
      cols: 3,
      note: 'Everything the unit keeps: the MIDI settings, the program map, the current program and its edit buffer, and user programs 100-199 (edit those on the Program page). MIDI settings and the map travel only in the all-data dump: Send replaces all of it, after which the unit restarts.',
      actions: [
        { label: 'Send all data', title: 'Send the whole memory (opcode 00, 3.5 KB): user programs 100-199, edit buffer, MIDI settings and map; the unit takes about 10 s and restarts', run: async (api) => {
          const ok = await api.confirm('Send all data', 'This replaces all user programs 100-199, the MIDI settings and the program map of the MIDIVerb III with what this page holds. The unit stores it (about 10 seconds) and restarts.', 'Send');
          if (ok) api.send(msg.dump(api.data));
        } },
        { label: 'Factory contents', title: 'What a reset (INT. PROG + STORE at power-on) leaves: factory programs in 100-199, channel 1, Pon, Eon, the map 000-127 to themselves', run: (api) => api.setData(initMemory()) },
      ],
      toSyx: (data) => msg.dump(data),
      fromSyx: (msgs) => { const m = msgs.find((r) => isMidiverb3(r) && op(r) === 0); return m ? memFrom(m) : null; },
    },
  ],
  requests: [{ label: 'All data', bytes: () => msg.request(), timeout: 4000 }],
  fullDump: [{ request: 'All data', timeout: 4000, expect: 1, seconds: 2 }],
  midiNotes: [
    'Program change (with Pon) recalls the program the MIDI program map holds for that number; a reset maps 000-127 to themselves, so programs 128-199 need the map.',
    'MOD ROUTING: pitch bend, controller 1, note number, note velocity, aftertouch, controller 64, controller 2 or controller 7 on the MIDI channel moves one of six parameters by MOD AMPLITUDE.',
    'MIDI ECHO (Eon) sends everything received back out, except SysEx for the MIDIVerb III (of which only the header and F7 go out).',
    'The unit sends SysEx only when asked (opcode 02) or from the MIDI SEND page (Snd, then STORE).',
  ],
};

export const _test = { programParams, systemParams, simulate, toCommon, fromCommon, unpair, pairs };
