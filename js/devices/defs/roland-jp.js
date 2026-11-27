// Roland JP-8080 / JP-8000 editors: the code both models share. buildJP(M) makes a definition
// from a model config (roland-jp8080.js, roland-jp8000.js); the model-independent parts (value
// formats, motion data, identity) are exported here. Built from the JP-8080 OS v1.04 firmware
// (Hitachi H8/300H, flash image loaded at 10000h) and checked against a JP-8080 over MIDI; the
// JP-8000 OS v1.05 firmware uses the same layouts (docs/devices/roland-jp8000.md).
// See docs/devices/roland-jp8080.md for the firmware addresses.
//
// SysEx: F0 41 dev 00 06 11|12 aa aa aa aa ... cs F7 (RQ1 / DT1, 4-byte addresses, device ID
// 10h by default; the dispatcher at 121B0 ignores other device IDs). Address map (decoder 45556):
//   00 00 00 00  system (19h)   00 00 20 00  motion loop lengths (4)   00 00 30 00  Tx/Rx CCs (2Ah)
//   01 00 00 00  temporary performance: 00 00 common (25h), 08 00 voice modulator (29h),
//                10 00 / 11 00 upper / lower part (8), 40 00 / 42 00 upper / lower patch (F8h)
//   02 nn mm 00  user patch n (0-127) at 02 00 00 00 + n x 100h (7-bit address arithmetic)
//   03 nn 00 00  user performance n (0-63), laid out as 01 00 00 00 (with its two patches)
// RQ1 is answered for addresses below 0B 00 00 00 (08-0A: pattern and motion data, 7-in-8 packed).
// The identity reply (45CDC) is F0 7E dev 06 02 06 01 00 00 00 03 00 00 F7: the firmware leaves
// out Roland's 41h, and the editor accepts it as it is.

import { readText } from '../../core/model/memmap.js';
import { addrToInt, intToAddr, rq1, dt1, dt1Chunks, parseDt1, readBlock } from '../../core/midi/roland.js';
import { jpTranslator, jpModelOf, readWinJpLib } from './roland-jp-common.js';

export const MODEL = [0x00, 0x06];
export const A = (s) => addrToInt(s.split(' ').map((x) => parseInt(x, 16)));
const hex4 = (n) => intToAddr(n).map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ------------------------------------------------------------------ value displays (firmware formats, handler table D61C2)
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']; // table D6143 (Eb/Bb use the flat glyph)
export const NOTE = (v) => `${NOTES[v % 12]}${Math.floor(v / 12) - 1}`;
const sign = (n) => `${n > 0 ? '+' : ''}${n}`;
const MOTIONS = [['A[1]', '09 00 00 00'], ['A[2]', '09 40 00 00'], ['B[1]', '0A 00 00 00'], ['B[2]', '0A 40 00 00']];
/** Unpack 7-in-8 data (pattern and motion events, 6 bytes each). */
export function unpack7(data) {
  const out = [];
  for (let i = 0; i + 7 <= data.length; i += 7) {
    const f = data[i];
    const ev = [];
    for (let k = 0; k < 6; k++) ev.push(data[i + 1 + k] | (f & (1 << k) ? 0x80 : 0));
    out.push(ev);
  }
  return out;
}
/** Pack 6-byte events into 7-in-8 groups (flag byte: bit k = bit 7 of byte k). */
export function pack7(events) {
  const out = [];
  for (const e of events) {
    let f = 0;
    e.forEach((b, k) => { if (b & 0x80) f |= 1 << k; });
    out.push(f, ...e.map((b) => b & 0x7f));
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ motion control data
// A motion is one event list (player 351E8, apply 398D0, erase 35DB6), 6 bytes per event:
//   0  ticks to wait after the event        2  81h knob event, 80h empty (time only)
//   1  not used by the player (kept)         3  knob slot 0-27h (the Tx/Rx slots, patch order)
//   4  value 0-127                           5  0
// The first event is a header (type 80h, bytes 3-5 = 02 0E 2A). Empty 80h events carry time:
// the unit pads a motion to its full length with C0 FF 80 00 00 00. Erasing a knob turns its
// events into 80h and leaves their slot and value bytes behind.
//
// Length (2026-11-25). Ticks are MIDI clocks: 24 a beat, 96 a measure. The player loops at the
// loop point, Loop Length x 96 (3A11C -> 3A484; system 00 00 20 00 + m: 0 PLAY ONCE = 9504, no
// loop; 1-8 measures). The unit's empty motion is the header and 50 empty events of 192 ticks
// (356DC -> 5A714). A recording goes in front of it: knob events inside the loop, the last one
// waiting until 192 ticks past the loop end. Every motion on the test unit and every factory motion
// (8E6E0-8FFE1), at loop length 4 (the factory setting), has its knob events before tick 384 and
// is 384 + 192 ticks of recording, then that tail (the header event, then 50 C0 events, 9792
// ticks): 10368. Only the loop plays; the rest is never reached.
export const MOTION_TICKS_PER_MEASURE = 96;
export const MOTION_TAIL = 192 + 9792;
export const MOTION_TICKS = 4 * MOTION_TICKS_PER_MEASURE + MOTION_TAIL; // 10368, at the factory loop length
/** Ticks that play in a loop of `loop` measures (1-8); null for PLAY ONCE (0) or unknown. */
export const motionLoopTicks = (loop) => (Number.isInteger(loop) && loop >= 1 && loop <= 8 ? loop * MOTION_TICKS_PER_MEASURE : null);
/** The length the unit gives a motion recorded at loop length `loop` (PLAY ONCE / unknown: 10368). */
export const motionLength = (loop) => (motionLoopTicks(loop) ?? 4 * MOTION_TICKS_PER_MEASURE) + MOTION_TAIL;
/** Knob events of a motion as absolute times: {total, points: [{tick, slot, value}], header}. */
export function motionTimeline(raw) {
  const ev = unpack7(raw);
  const points = [];
  let tick = 0;
  ev.forEach((e, i) => {
    if (i > 0 && e[2] === 0x81) points.push({ tick, slot: e[3], value: e[4] });
    tick += e[0];
  });
  return { total: tick, points, header: ev[0] || null };
}
/** Events for a motion: header, knob events in time order, empty events for long gaps and the tail. */
export function buildMotion(points, total = MOTION_TICKS) {
  const pts = points.filter((p) => p.tick >= 0 && p.tick < total).slice().sort((a, b) => a.tick - b.tick);
  const events = [];
  const pad = (gap) => { while (gap > 0) { const w = Math.min(gap, 0xc0); events.push([w, 0xff, 0x80, 0, 0, 0]); gap -= w; } };
  const first = pts.length ? pts[0].tick : total;
  events.push([Math.min(first, 0xc0), 0xff, 0x80, 0x02, 0x0e, 0x2a]);
  pad(first - Math.min(first, 0xc0));
  pts.forEach((p, i) => {
    const gap = (i + 1 < pts.length ? pts[i + 1].tick : total) - p.tick;
    events.push([Math.min(gap, 0xc0), 0x02, 0x81, p.slot & 0x7f, p.value & 0x7f, 0]);
    pad(gap - Math.min(gap, 0xc0));
  });
  return events;
}
export const motionAddr = (m) => A(MOTIONS[m][1]);
/** DT1 messages that write a motion (E7h data bytes each, as the unit sends them). */
export function motionMessages(dev, m, raw) {
  return dt1Chunks(MODEL, dev, intToAddr(motionAddr(m)), raw, 0xe7);
}
/** Read motion m (0-3) from the unit; an empty motion gives an empty array. */
export async function readMotion(client, dev, m, opts) {
  return readEvents(client, dev, motionAddr(m), A('00 40 00 00'), opts);
}
/** The packed event data at `start` (a motion, or an RPS pattern on the JP-8000); empty when there is none. */
async function readEvents(client, dev, start, size, { quiet = 800, timeout = 3000 } = {}) {
  const parts = new Map();
  try {
    await client.request(Uint8Array.from(rq1(MODEL, dev, intToAddr(start), size)), {
      collect: (msg, r) => {
        const p = parseDt1(r ?? msg.raw, MODEL);
        if (!p?.ok) return false;
        const off = addrToInt(p.addr) - start;
        if (off < 0 || off >= size) return false;
        parts.set(off, p.data);
        return true;
      },
      quiet, resolveOnQuiet: true, timeout,
    });
  } catch { /* no reply: no events */ }
  const out = [];
  for (const off of [...parts.keys()].sort((a, b) => a - b)) out.push(...parts.get(off));
  return Uint8Array.from(out);
}

// RPS patterns (JP-8000). OS 1.05 answers RQ1 and takes DT1 at 08 nn 00 00 (pattern n = key C#2 + n,
// 0-47), 7-in-8 packed like the motions, in DT1 messages of E7h bytes (checked by running the OS in an
// emulator: tools/roland/jp8000). The JP-8080 OS has no SysEx for them. Each event is 6 bytes:
//   0  ticks to wait after the event (MIDI clocks: 24 a beat, 96 a measure)
//   1  0          2  note number (80h: the end of the pattern)   3  velocity 1-127 (end: 16h)
//   4-5  gate time in ticks (high, low)
// Every factory pattern is 4 measures (384 ticks) long, the end event filling up to the last tick.
export const PATTERN_KEYS = Array.from({ length: 48 }, (_, i) => NOTE(37 + i)); // C#2 .. C6
export const patternAddr = (n) => A('08 00 00 00') + n * A('00 01 00 00');
/** Read RPS pattern n (0-47) from a JP-8000; an empty pattern gives an empty array. */
export function readPattern(client, dev, n, opts) { return readEvents(client, dev, patternAddr(n), A('00 01 00 00'), opts); }
/** DT1 messages that write RPS pattern n (E7h data bytes each, as the unit sends them). */
export function patternMessages(dev, n, raw) { return dt1Chunks(MODEL, dev, intToAddr(patternAddr(n)), raw, 0xe7); }
/** Pattern events as notes: [{tick, note, velocity, gate}], with the total length in ticks and the end event. */
export function patternTimeline(raw) {
  const notes = [];
  let tick = 0, end = null;
  for (const e of unpack7(raw)) {
    if (e[2] === 0x80) end = e; else notes.push({ tick, note: e[2], velocity: e[3], gate: (e[4] << 8) | e[5] });
    tick += e[0];
  }
  return { total: tick, notes, end };
}
/** Identity reply as the firmware sends it (no 41h manufacturer byte; JP-8000 and JP-8080 alike). */
export const isJPIdentity = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x7e && raw[3] === 6 && raw[4] === 2 && raw[5] === 6 && raw[6] === 1;

/** Build a JP-8080 or JP-8000 definition from its model config M (see roland-jp8080.js / roland-jp8000.js). */
export function buildJP(M) {
  const FW = M.fw;
  const L = (n) => FW.LISTS[n];
  // Tempo sync (format 6): note glyphs D80E8 (16th, 8th, quarter, half, whole, double whole) with a
  // triplet or dot mark (D615E), then the strings 3-8 MEASURES and LFO1 (table 5DE14).
  const NOTE_VALUES = ['1/16', '1/8 triplet', '1/16 dotted', '1/8', '1/4 triplet', '1/8 dotted', '1/4', '1/2 triplet', '1/4 dotted', '1/2', '1 bar triplet', '1/2 dotted', '1 bar', '2 bars triplet', '1 bar dotted', '2 bars'];
  const SYNC = ['OFF', ...NOTE_VALUES, '3 MEASURES', '4 MEASURES', '5 MEASURES', '6 MEASURES', '7 MEASURES', '8 MEASURES', 'LFO1'];
  const QUANTIZE = ['OFF', '1/16 triplet', '1/16', '1/8 triplet', '1/8', '1/4 triplet', '1/4']; // format 18, table D61B4
  const CHANNEL = (v) => (v < 16 ? `Ch ${v + 1}` : 'OFF'); // format A
  const opts = (list, max, min = 0) => Array.from({ length: max - min + 1 }, (_, i) => [i + min, list[i + min] ?? String(i + min)]);
  const range = (max, f) => Array.from({ length: max + 1 }, (_, i) => [i, f(i)]);
  const patchNumber = (n) => `${'AB'[n >> 6] ?? '?'}${((n >> 3) & 7) + 1}${(n & 7) + 1}`; // A11-B88
  const perfNumber = (n) => `${((n >> 3) & 7) + 1}${(n & 7) + 1}`; // 11-88

  /** Display for a firmware format code (fmt) with its argument (arg). */
  function display(fmt0, arg, max, min) {
    const fmt = M.formatMap?.[fmt0] ?? fmt0;
    switch (fmt) {
      case 1: return { options: range(max, perfNumber) };
      case 2: return { options: range(max, patchNumber) };
      case 3: return { format: (v) => sign(v - arg) };
      case 4: return { options: opts(L(arg), max, min) };
      case 5: return { format: NOTE };
      case 6: return { options: opts(SYNC, max) };
      case 7: return {};
      case 8: return { options: range(max, (v) => (v < 128 ? NOTE(v) : 'ALL')) };
      case 9: return { format: (v) => String(v + 1) };
      case 0xa: return { options: range(max, CHANNEL) };
      case 0xd: return { options: range(max, (v) => (v ? String(v) : 'PLAY ONCE')) };
      case 0x10: return { format: (v) => (v ? `-${v}` : '0') };
      case 0x15: return { format: (v) => sign(v) };
      case 0x18: return { options: opts(QUANTIZE, max) };
      case 0x1a: return { options: range(max, (v) => (v < 16 ? `Ch ${v + 1}` : v === 16 ? 'ALL' : 'OFF')) };
      case 0x1c: return { format: (v) => (v === 0 ? L(arg)[0] : v === max ? L(arg)[1] : sign(v - 25)) }; // handler 4AE3C: centre 19h
      default: return {};
    }
  }

  // Bytes without LCD text. Panel switches show their state with LEDs only; their names and value
  // orders are those of Roland`s parameter address map (${M.name} owner`s manual, MIDI implementation),
  // which agree with what the firmware does show (OSC1/OSC2 control labels, bank select table D30B4).
  // Entries: [label, options or null, help, extra].
  const PANEL = M.panelNote || `Panel switch: the ${M.name} shows it with its LEDs only.`;
  const JP8000 = `A JP-8000 setting, kept so JP-8000 files load; the ${M.name} ignores it.`;
  const ONOFF = ['OFF', 'ON'];
  const groups = (n) => Array.from({ length: n }, (_, i) => `Group ${i + 1}`);
  const SWITCHES = M.switches({ PANEL, JP8000, ONOFF, groups, L });
  const PATCH_LABEL_FIX = { 'Conterol 2': 'Control 2' };

  // ------------------------------------------------------------------ parameters from the firmware rows
  /** rows: [offset, min, max, sub, label, fmt, arg, src]; sub 1/2 marks the bytes of a two-byte value. */
  function paramsFrom(rows, kind, at, place) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const [off, min, max, sub, label0, fmt, arg, src] = rows[i];
      const o = at(off);
      const sw = SWITCHES[kind]?.[off];
      const pl = place(off, label0) || {};
      if (sub === 1) { // two-byte value: high byte (0-1), low byte (0-127)
        const lo = rows[i + 1];
        i++;
        // the combined range and initial value from the firmware's per-id table (FW.RANGES2):
        // TEMPO 20-250, Trig Source Note 0-128 (ALL), depths 0-254; the unit refuses values outside
        const r2 = FW.RANGES2?.[kind]?.[off];
        const vmin = r2 ? r2[0] : 0;
        const vmax = r2 ? r2[1] : max * 128 + lo[2];
        out.push({
          key: `${kind}_${off.toString(16)}`, label: cleanLabel(label0, pl), offset: o, size: 2, min: vmin, max: vmax, address: off,
          get: (d) => (d[o] & 1) * 128 + (d[o + 1] & 127), set: (d, v) => { d[o] = (v >> 7) & 1; d[o + 1] = v & 127; },
          ...display(fmt, arg, vmax, vmin), ...pl, two: true, ...(r2 ? { init: r2[2] } : {}),
        });
        continue;
      }
      const p = { key: `${kind}_${off.toString(16)}`, offset: o, min, max, address: off, ...pl };
      if (label0 !== undefined) Object.assign(p, { label: cleanLabel(label0, pl) }, display(fmt, arg, max, min), pl);
      else if (sw) {
        const list = sw[1] || (sw[3]?.listNo !== undefined ? L(sw[3].listNo) : null);
        const { listNo, ...extra } = sw[3] || {};
        Object.assign(p, { label: sw[0], help: sw[2] || PANEL, ...(list ? { options: opts(list, max, min) } : {}), ...extra });
      }
      else if (pl.label) Object.assign(p, pl);
      else Object.assign(p, { label: `Byte ${off.toString(16).toUpperCase()}h`, input: 'number' });
      if (src === 'menu' || sw) p.src = src || 'switch';
      out.push(p);
    }
    return out;
  }
  function cleanLabel(l, pl) {
    if (pl?.label) return pl.label;
    const s = l.replace(/(Control|Velocity|Ribbon)\s*:.*$/, '').replace(/\s{2,}.*$/, '').trim();
    return PATCH_LABEL_FIX[s] || s;
  }

  // ------------------------------------------------------------------ objects
  // System: 00 00 00 00 (19h), 00 00 20 00 (4), 00 00 30 00 (2Ah) laid out one after the other.
  const SYS_PARTS = M.sysParts.map(([a, size, offset]) => ({ address: A(a), offset, size }));
  const SYS_SIZE = SYS_PARTS.reduce((n, p) => Math.max(n, p.offset + p.size), 0);
  const sysAt = (off) => { const pt = SYS_PARTS.find((x) => off >= (x.address & 0x3fff) && off < (x.address & 0x3fff) + x.size); return pt.offset + off - (pt.address & 0x3fff); };
  const TXRX = sysAt(0x1800);
  // Tx/Rx setting slots (00 30 00-27): patch byte each slot's knob edits, from the UI table (E9h + knob).
  const TXRX_PATCH = [0x11, 0x12, 0x13, 0x16, 0x17, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1f, 0x20, 0x23, 0x24, 0x25, 0x26, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3b, 0x3c, 0x3e, 0x40, 0x41, 0x42, 0x46];
  const PATCH_ROWS = new Map(FW.PATCH.map((r) => [r[0], r]));
  const knobName = (off) => cleanLabel(PATCH_ROWS.get(off)?.[4] ?? '', null);
  // The CC option list (OFF, CC1-31, AFTERTOUCH, CC33-95, EXCLUSIVE): list 11 of the JP-8080 OS,
  // list 10 of the JP-8000 OS (M.ccList).
  const CC_LIST = opts(L(M.ccList ?? 11), 96);
  const sysParams = paramsFrom(FW.SYSTEM, 'SYSTEM', sysAt, (off) => {
    if (off >= 0x1800 && off < 0x1828) return { label: knobName(TXRX_PATCH[off - 0x1800]), group: 'Tx/Rx setting (MODE2): CC per knob', options: CC_LIST };
    if (off === 0x1828 || off === 0x1829) return { label: (M.upDownLabels ?? ['Control Up', 'Control Down'])[off - 0x1828], group: 'Tx/Rx setting (MODE2): CC per knob', options: opts(L(M.ccList ?? 11), 95) };
    const own = M.sysPlace?.(off, display);
    if (own) return own;
    if (off >= 0x1000) return { label: `Motion ${['A[1]', 'A[2]', 'B[1]', 'B[2]'][off - 0x1000]} loop length`, group: 'Motion control', ...display(0xd, 0, 8, 0) };
    if (off === 1) return { label: 'Performance number', group: 'Current selection' };
    // two menus show "Metronome": the Pattern REC menu (record 157, byte 10h, with Input Quantize and
    // Gate Time Ratio) and the Motion REC menu (record 150, byte 11h, with Loop Length)
    if (off === 0x10) return { label: 'Metronome (pattern recording)', group: 'Pattern and motion' };
    if (off === 0x11) return { label: 'Metronome (motion recording)', group: 'Motion control' };
    if (off === 0 || off === 0x17) return { group: 'Current selection' };
    if (off === 0x09 || (off >= 0x12 && off <= 0x16)) return { group: 'JP-8000 settings' };
    if ([0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11].includes(off)) return { group: 'Pattern and motion' };
    return { group: 'MIDI and system' };
  }).map((p) => (p.label?.startsWith('Byte') ? { ...p, group: 'Stored state', help: `A system byte the ${M.name} keeps with its settings; no screen edits it (see docs/devices/roland-jp8080.md).` } : p));

  // Performance: common (25h), voice modulator (29h), upper and lower part (8 each).
  const PERF_PARTS = M.perfParts.map(([a, size, offset]) => ({ address: A(a), offset, size }));
  const PERF_SIZE = PERF_PARTS.reduce((n, p) => Math.max(n, p.offset + p.size), 0);
  const PART0 = PERF_PARTS.find((p) => p.address === A('01 00 10 00')).offset;
  const PART_SIZE = M.partSize;
  const VMOD = PERF_PARTS.find((p) => p.address === A('01 00 08 00'))?.offset;
  const PART_NAMES = ['Upper', 'Lower'];
  const perfGroup = (off) => (off < 0x10 ? 'Name' : off <= 0x16 ? 'Keyboard and parts' : off <= 0x1c ? 'Arpeggiator' : off <= 0x21 ? 'Individual trigger' : off <= 0x23 ? 'Tempo' : 'Keyboard and parts');
  /** Part Patch number: A11-B88, with the preset names when the part's bank is PRESET. */
  function partPatchNames(base) {
    return (data) => {
      const names = data[base] === 2 ? FW.PRESET_PATCHES[PART_SIZE > 7 ? data[base + 7] : 0] : null;
      return names ? { options: range(127, (v) => `${patchNumber(v)} ${names[v]}`) } : {};
    };
  }
  const perfParams = [
    ...paramsFrom(FW.PERF, 'PERF', (o) => o, (off) => ({ section: 'common', group: perfGroup(off), ...(off < 0x10 ? { hidden: true } : {}) })),
    ...(VMOD === undefined ? [] : paramsFrom(FW.VMOD, 'VMOD', (o) => VMOD + o, (off) => ({ section: 'vmod', group: off <= 0x0b ? 'Voice modulator' : off <= 0x17 ? 'Character' : 'Voice modulator levels' }))),
    ...[0, 1].flatMap((n) => paramsFrom(FW.PART, 'PART', (o) => PART0 + n * PART_SIZE + o, (off) => ({ section: `part${n}`, group: `${PART_NAMES[n]} part`, ...(off === 1 ? { label: 'Patch number', dynamic: partPatchNames(PART0 + n * PART_SIZE) } : {}) }))
      .map((p) => ({ ...p, key: `${p.key}_${n}`, part: n }))),
  ];

  // Patch: F8h bytes at 01 00 40 00 (upper) or 01 00 42 00 (lower).
  const PATCH_SIZE = M.patchSize;
  const patchTarget = { key: 'upper', base: A('01 00 40 00') };
  const patchGroup = (off) => {
    if (off < 0x10) return 'Name';
    if (off <= 0x14) return 'LFO';
    if (off <= 0x1d) return 'OSC common';
    if (off <= 0x20) return 'OSC1';
    if (off <= 0x26) return 'OSC2';
    if (off <= 0x32) return 'Filter';
    if (off <= 0x3a) return 'Amp';
    if (off <= 0x42) return 'Tone and effects';
    if (off <= 0x49) return 'Controllers';
    if (off <= 0x9a) return off === 0x98 ? 'Controllers' : `${M.depthName} depth (per knob)`;
    if (off === 0x9b) return 'Controllers';
    if (off <= 0xeb) return 'Velocity depth (per knob)';
    if (off <= 0xef) return 'Controllers';
    return 'Unison, gain and external input';
  };
  const patchParams = paramsFrom(FW.PATCH, 'PATCH', (o) => o, (off) => ({
    section: off >= 0x4a && off <= 0xeb && off !== 0x98 && off !== 0x9b ? (off <= 0x9a ? 'control' : 'velocity') : 'main',
    group: patchGroup(off),
    ...(off < 0x10 ? { hidden: true } : {}),
    // OSC2 Range / Fine depths are limited to -50..+50 / -100..+100 (Roland address map)
    ...(off === 0x62 || off === 0xb4 ? { min: 0x4d, max: 0xb1 } : off === 0x64 || off === 0xb6 ? { min: 0x1b, max: 0xe3 } : {}),
    ...(off >= 0xec && off <= 0xee ? {
      label: `${['Bend Range Asgn', 'Velocity Assign', `${M.depthName} Assign`][off - 0xec]} indicator`, options: [[0, '(Not Assigned)'], [1, 'ACTIVE']], readOnly: true,
      help: `ACTIVE while any assignment of this kind exists (the menu then offers All Clear[WRITE]). Shown for information: the ${M.name} reports it but does not take it.`,
    } : {}),
  })).map((p) => (p.label?.startsWith('Byte') ? { ...p, group: 'Stored state', help: `A patch byte the ${M.name} stores and sends but no screen or panel control edits (see docs/devices/roland-jp8080.md).` } : p));

  // The MIDI channels page and helpers read part channels from these.
  const PART_CH = (n) => PART0 + n * PART_SIZE + 2;

  // ------------------------------------------------------------------ message helpers
  const sysData = (ctx) => (ctx?.loaded?.has('system') ? ctx.data.system : null);
  const perfData = (ctx) => (ctx?.loaded?.has('performance') ? ctx.data.performance : null);
  const perfChannel = (ctx) => { const c = sysData(ctx)?.[2]; return c !== undefined && c < 16 ? c : ctx.channel; };
  const partChannel = (ctx, n) => { const c = perfData(ctx)?.[PART_CH(n)]; return c !== undefined && c < 16 ? c : ctx.channel; };
  const select = (ch, msb, lsb, pc) => [[0xb0 | ch, 0, msb], [0xb0 | ch, 32, lsb], [0xc0 | ch, pc]];

  function build(parts, rebase = (a) => a) { return { parts, rebase }; }
  const sysBuilt = build(SYS_PARTS);
  const perfBuilt = build(PERF_PARTS);
  const patchBuilt = { parts: [{ address: A('01 00 40 00'), offset: 0, size: PATCH_SIZE }], rebase: (a) => a - A('01 00 40 00') + patchTarget.base };

  async function fetchParts(api, built, base) {
    const size = built.parts.reduce((n, p) => Math.max(n, p.offset + p.size), 0);
    const out = new Uint8Array(size);
    const first = built.parts[0].address;
    for (const part of built.parts) {
      const addr = base === undefined ? built.rebase(part.address) : base + (part.address - first);
      out.set(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(addr), part.size), part.offset);
    }
    return out;
  }
  function writeParts(built, data, dev, base) {
    const msgs = [];
    const first = built.parts[0].address;
    for (const part of built.parts) {
      const addr = base === undefined ? built.rebase(part.address) : base + (part.address - first);
      msgs.push(...dt1Chunks(MODEL, dev, intToAddr(addr), data.slice(part.offset, part.offset + part.size)));
    }
    return msgs;
  }
  /** Where object byte `offset` lives on the device. */
  function addressOf(built, offset) {
    const part = built.parts.find((p) => offset >= p.offset && offset < p.offset + p.size);
    return built.rebase(part.address) + (offset - part.offset);
  }
  function withSend(params, built) {
    for (const p of params) p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(addressOf(built, p.offset)), Array.from(data.slice(p.offset, p.offset + (p.size || 1))));
    return params;
  }
  withSend(sysParams, sysBuilt);
  withSend(perfParams, perfBuilt);
  withSend(patchParams, patchBuilt);

  /** Apply a DT1 the ${M.name} sent (panel edits with Tx/Rx Edit SW on, or a bulk dump) to an object. */
  function receiver(built) {
    return (raw, data) => {
      const p = parseDt1(raw, MODEL);
      if (!p?.ok) return null;
      const a = addrToInt(p.addr);
      let d = null;
      for (const part of built.parts) {
        const pa = built.rebase(part.address);
        for (let i = 0; i < p.data.length; i++) {
          const k = a + i - pa;
          if (k >= 0 && k < part.size) { d ??= Uint8Array.from(data); d[part.offset + k] = p.data[i]; }
        }
      }
      return d;
    };
  }
  /** Every DT1 in a .syx onto an object; bases(a) gives the copies an address belongs to. */
  function fromSyxInto(built, size, init, bases) {
    return (msgs) => {
      const d = init();
      let hit = false;
      const first = built.parts[0].address;
      for (const m of msgs) {
        const p = parseDt1(m, MODEL);
        if (!p?.ok) continue;
        const a = addrToInt(p.addr);
        for (const base of bases(a)) {
          for (const part of built.parts) {
            const pa = base + (part.address - first);
            for (let i = 0; i < p.data.length; i++) {
              const k = a + i - pa;
              if (k >= 0 && k < part.size) { d[part.offset + k] = p.data[i]; hit = true; }
            }
          }
        }
      }
      return hit ? d : null;
    };
  }

  // Defaults: init values from the firmware's patch table (8D30C, byte 2 of each entry), depths at
  // their centre (127 = 0) and the INIT PATCH / INIT PERFORMANCE names.
  function patchDefaults() {
    const d = new Uint8Array(PATCH_SIZE);
    for (const p of patchParams) if (!p.two) d[p.offset] = Math.max(p.min, Math.min(p.max, 0));
    FW.PATCH_CC.forEach(([init], i) => { d[i] = init; });
    for (const p of patchParams) if (p.two) p.set(d, 127);
    for (let i = 0; i < 16; i++) d[i] = 'INIT PATCH      '.charCodeAt(i);
    return d;
  }
  function perfDefaults() {
    const d = new Uint8Array(PERF_SIZE);
    for (let i = 0; i < 16; i++) d[i] = 'INIT PERFORMANCE'.charCodeAt(i);
    for (const p of perfParams) if (p.min > 0 && !p.two) d[p.offset] = p.min;
    for (const p of perfParams) if (p.two && p.init !== undefined) p.set(d, p.init); // TEMPO 120, Trig Source Note ALL
    d[PART_CH(0)] = 0; d[PART_CH(1)] = 1;
    return d;
  }
  function sysDefaults() {
    const d = new Uint8Array(SYS_SIZE);
    for (const p of sysParams) if (p.min > 0) d[p.offset] = p.min;
    d[2] = 0x0f; // perform control channel 16
    TXRX_PATCH.forEach((o, i) => { d[TXRX + i] = FW.PATCH_CC[o][2]; });
    return d;
  }

  const nameOf = (data, offset = 0) => readText(data, offset, 16);

  // ------------------------------------------------------------------ memories
  const userPatch = (n) => A('02 00 00 00') + n * 256;
  const userPerf = (n) => A('03 00 00 00') + n * A('00 01 00 00');
  // Bank select (handler 43368): patches MSB 50h (user, LSB 0) / 51h (preset, LSB 0-2) / 52h (card,
  // LSB = card bank); performances are selected the same way on the Perform Ctrl channel.
  const PATCH_BANKS = M.patchBanks;
  const PERF_BANKS = M.perfBanks;
  // Preset names from the ROM records (generated); PRESET n is ROM bank n (checked on a ${M.name}).
  const presetPatchNames = (bank) => (PATCH_BANKS[bank].user ? null : FW.PRESET_PATCHES[PATCH_BANKS[bank].lsb]);
  const presetPerfNames = (bank) => (PERF_BANKS[bank].user ? null : FW.PRESET_PERFORMANCES[PERF_BANKS[bank].lsb]);

  // Motion sets (09 00 / 09 40 / 0A 00 / 0A 40 = A[1] A[2] B[1] B[2]) are event lists of varying
  // length, sent as 7-in-8 packed DT1 data (RQ1 45444, DT1 3E45C): each group of 7 bytes is a flag
  // byte holding bit 7 of the 6 bytes after it. An empty motion sends nothing. RPS patterns (the 48
  // keys C#2-C6) use the same event lists inside the unit. The JP-8080's OS 1.04 has no SysEx for
  // them: RQ1 returns nothing below 09 00 00 00 and DT1 handles only 09-0A (checked: a pattern
  // written to 08 00 00 00 does not read back). The JP-8000's OS 1.05 reads and writes them at
  // 08 nn 00 00 (M.patterns: requests and the complete dump; see readPattern above).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function readPerfName(api) { return nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(A('01 00 00 00')), 16)); }

  // ------------------------------------------------------------------ Branch Library and console
  function libraryItems(msgs) {
    const items = [];
    const byKey = new Map();
    for (const m of msgs) {
      const p = parseDt1(m, MODEL);
      let key = 'other';
      let label = 'Other messages';
      let object = null;
      let base = null;
      if (p?.ok) {
        const a = addrToInt(p.addr);
        const [aa, bb, cc] = [a >> 21, (a >> 14) & 127, (a >> 7) & 127];
        if (aa === 0) { key = 'sys'; label = 'System'; object = 'system'; }
        else if (aa === 1 && cc >= 0x40) { key = `tp${cc >= 0x42 ? 1 : 0}`; label = `Temporary patch (${cc >= 0x42 ? 'lower' : 'upper'})`; object = 'patch'; base = A(cc >= 0x42 ? '01 00 42 00' : '01 00 40 00'); }
        else if (aa === 1) { key = 'tf'; label = 'Temporary performance'; object = 'performance'; base = A('01 00 00 00'); }
        else if (aa === 2) { const n = (a - A('02 00 00 00')) >> 8; key = `up${n}`; label = `User patch ${patchNumber(n)}`; object = 'patch'; base = userPatch(n); }
        else if (aa === 3) { key = `uf${bb}`; label = `User performance ${perfNumber(bb)}`; object = 'performance'; base = userPerf(bb); }
        else if (aa === 8) { key = `ptn${bb}`; label = `RPS pattern ${PATTERN_KEYS[bb] ?? bb}`; }
        else if (aa === 9 || aa === 10) { const m = (aa - 9) * 2 + (bb >= 0x40 ? 1 : 0); key = `mot${m}`; label = `Motion ${MOTIONS[m][0]}`; }
        else { key = `x${aa}`; label = `Data at ${aa.toString(16).padStart(2, '0')}`; }
      } else if (m[1] === 0x41 && m[3] === 0 && m[4] === 6) { key = 'req'; label = `Requests and other ${M.name} messages`; }
      let item = byKey.get(key);
      if (!item) { item = { key, label, object, name: '', msgs: [] }; byKey.set(key, item); items.push(item); }
      item.msgs.push(m);
      if (p?.ok && base !== null && addrToInt(p.addr) === base && p.data.length >= 16) item.name = readText(p.data, 0, 16);
    }
    return items;
  }

  /** The identity reply leaves out Roland's 41h: F0 7E dev 06 02 | 06 01 family | 00 00 model | 00 03 00 00 version. */
  function describeIdentity(raw) {
    if (!isJPIdentity(raw)) return null;
    const hx = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(' ');
    return `Identity reply: Roland ${M.name} (device ID ${raw[2].toString(16).padStart(2, '0')}h), family ${hx(raw.slice(5, 7))}, model ${hx(raw.slice(7, 9))}, version ${hx(raw.slice(9, 13))}. The firmware leaves out Roland's manufacturer ID 41h, so other software may name another maker.`;
  }
  function describe(raw) {
    const p = parseDt1(raw, MODEL);
    if (p) return `${M.name} DT1 ${p.addr.map((b) => b.toString(16).padStart(2, '0')).join(' ')} (${p.data.length} bytes)${p.ok ? '' : ' checksum error'}`;
    if (raw[1] === 0x41 && raw[3] === 0 && raw[4] === 6 && raw[5] === 0x11) return `${M.name} RQ1 ${Array.from(raw.slice(6, 10), (b) => b.toString(16).padStart(2, '0')).join(' ')} size ${addrToInt(Array.from(raw.slice(10, 14)))}`;
    if (isJPIdentity(raw)) return describeIdentity(raw);
    return null;
  }

  /** Identity reply as the firmware sends it (no 41h manufacturer byte). */

  // ------------------------------------------------------------------ simulator (demo mode, tests)
  function simulate() {
    const mem = new Map();
    const put = (built, base, d) => { const first = built.parts[0].address; for (const p of built.parts) for (let i = 0; i < p.size; i++) mem.set(base + (p.address - first) + i, d[p.offset + i]); };
    const nm = (base, s) => { for (let i = 0; i < 16; i++) mem.set(base + i, s.charCodeAt(i) || 32); };
    put(sysBuilt, 0, sysDefaults());
    put(perfBuilt, A('01 00 00 00'), perfDefaults());
    for (const b of ['01 00 40 00', '01 00 42 00']) { const d = patchDefaults(); for (let i = 0; i < PATCH_SIZE; i++) mem.set(A(b) + i, d[i]); }
    for (let n = 0; n < 128; n++) { const d = patchDefaults(); for (let i = 0; i < PATCH_SIZE; i++) mem.set(userPatch(n) + i, d[i]); nm(userPatch(n), `User ${patchNumber(n)}`.padEnd(16)); }
    for (let n = 0; n < 64; n++) { put(perfBuilt, userPerf(n), perfDefaults()); nm(userPerf(n), `Perform U:${perfNumber(n)}`.padEnd(16)); }
    nm(A('01 00 00 00'), 'Demo Perform    '); nm(A('01 00 40 00'), 'Demo Upper      '); nm(A('01 00 42 00'), 'Demo Lower      ');
    const bank = Array.from({ length: 16 }, () => [0x50, 0]);
    const copy = (from, to, size) => { for (let i = 0; i < size; i++) mem.set(to + i, mem.get(from + i) ?? 0); };
    function programChange(ch, pc) {
      const [msb, lsb] = bank[ch];
      if (ch === mem.get(2)) {
        if (msb !== 0x50 || pc > 63) return;
        copy(userPerf(pc), A('01 00 00 00'), 0x25); copy(userPerf(pc) + A('00 00 08 00'), A('01 00 08 00'), 0x29);
        mem.set(1, pc);
        return;
      }
      for (const n of [0, 1]) {
        if (ch !== mem.get(A('01 00 10 02') + n * 128)) continue;
        const base = A(n ? '01 00 42 00' : '01 00 40 00');
        if (msb === 0x50) copy(userPatch(pc), base, PATCH_SIZE);
        else { const d = patchDefaults(); for (let i = 0; i < PATCH_SIZE; i++) mem.set(base + i, d[i]); nm(base, `Preset ${lsb + 1}-${patchNumber(pc)}`.padEnd(16)); }
        mem.set(A('01 00 10 00') + n * 128, msb === 0x50 ? 1 : 2); mem.set(A('01 00 10 01') + n * 128, pc);
      }
    }
    return {
      mem,
      handle(d) {
        const st = d[0] & 0xf0;
        if (st === 0xb0 && (d[1] === 0 || d[1] === 32)) { bank[d[0] & 15][d[1] ? 1 : 0] = d[2]; return []; }
        if (st === 0xc0) { programChange(d[0] & 15, d[1]); return []; }
        if (d[0] !== 0xf0) return null;
        if (d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) return [[0xf0, 0x7e, 0x10, 0x06, 0x02, 0x06, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0xf7]];
        if (d[1] !== 0x41 || d[3] !== 0 || d[4] !== 6) return null;
        if (d[5] === 0x12) { const p = parseDt1(d, MODEL); if (p?.ok) { const a = addrToInt(p.addr); p.data.forEach((b, i) => mem.set(a + i, b)); } return []; }
        if (d[5] === 0x11) {
          const a = addrToInt(Array.from(d.slice(6, 10)));
          const size = addrToInt(Array.from(d.slice(10, 14)));
          const data = Array.from({ length: size }, (_, i) => mem.get(a + i) ?? 0);
          return dt1Chunks(MODEL, d[2], intToAddr(a), data, 0xfe);
        }
        return [];
      },
    };
  }

  // ------------------------------------------------------------------ the definition
  const PATCH_TARGETS = [['upper', 'Upper part patch (01 00 40 00)'], ['lower', 'Lower part patch (01 00 42 00)']];
  const CHANNELS = Array.from({ length: 17 }, (_, v) => [v, CHANNEL(v)]);

  // Head Library: translation to and from the shared synth model (roland-jp-common.js).
  const BLOCK_NAMES = { [A('01 00 00 00')]: 'Performance common', [A('01 00 08 00')]: 'Voice modulator', [A('01 00 10 00')]: 'Upper part', [A('01 00 11 00')]: 'Lower part' };
  const TR = jpTranslator({
    name: M.name, deviceId: M.id, patchSize: PATCH_SIZE, patchParams,
    mfxNames: patchParams.find((p) => p.offset === 0x3d).options.map(([, l]) => l),
    osc2Waves: patchParams.find((p) => p.offset === 0x21).options.length,
    delayTypes: patchParams.find((p) => p.offset === 0x3f).options.length,
    perfParts: PERF_PARTS.map((p) => ({ ...p, label: BLOCK_NAMES[p.address] })),
  });
  const parsedDt1 = (msgs) => msgs.map((m) => parseDt1(m, MODEL)).filter((p) => p?.ok).map((p) => ({ a: addrToInt(p.addr), n: p.data.length }));

  const def = {
    coverage: M.coverage,
    sysex: { manufacturer: [0x41], model: MODEL, deviceIdDefault: 0x10 },
    minGap: 30,
    describe,
    simulate,
    libraryItems,
    isIdentity: isJPIdentity,
    describeIdentity,
    // Head Library import: messages this definition reads, and how sure it is that a set of them was
    // made for this model (JP-8000 and JP-8080 share model ID 00 06; the layout tells them apart).
    recognise: (raw) => !!parseDt1(raw, MODEL)?.ok,
    // Roland model 00 06 messages, readable or not (a damaged DT1 is still this device's data)
    isOwn: (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === MODEL[0] && raw[4] === MODEL[1],
    isRequest: (raw) => raw?.[1] === 0x41 && raw[3] === MODEL[0] && raw[4] === MODEL[1] && raw[5] === 0x11,
    prefer: (msgs) => { const m = jpModelOf(parsedDt1(msgs)); return m === M.id ? 2 : m === null ? 1 : 0.5; },
    // A user performance carries its two patches (03 nn 40 00 / 42 00): kept as patches of their own.
    libraryParts: (item) => (/^uf/.test(item.key) ? [['Upper', 0x40], ['Lower', 0x42]].map(([role, cc]) => ({
      role, object: 'patch', msgs: item.msgs.filter((m) => { const p = parseDt1(m, MODEL); return p?.ok && (((addrToInt(p.addr) >> 7) & 127) & ~1) === cc; }),
    })).filter((x) => x.msgs.length) : []),
    // WinJPLib .pat / .pfm files (JP-8000 format; see roland-jp-common.js).
    readFile: M.id === 'roland-jp8000' ? (name, bytes) => {
      const f = readWinJpLib(bytes);
      if (!f) return null;
      const patchOf = (rec) => { const d = patchDefaults(); d.set(rec.subarray(0, PATCH_SIZE)); return d; };
      if (f.kind === 'patch') return f.records.map((r, k) => ({ object: 'patch', data: patchOf(r.patch), label: `User patch ${patchNumber(k)}` }));
      return f.records.map((r, k) => {
        const d = perfDefaults();
        d.set(r.perf.subarray(0, PERF_SIZE));
        return { object: 'performance', data: d, label: `User performance ${perfNumber(k)}`, parts: [{ role: 'Upper', object: 'patch', data: patchOf(r.upper) }, { role: 'Lower', object: 'patch', data: patchOf(r.lower) }] };
      });
    } : undefined,
    // The Motion page (event editor); loaded when opened so the definition needs no UI code.
    pages: [{
      key: 'motion', label: 'Motion', icon: '∿',
      view: (root, g, params) => {
        let v = null;
        import('./roland-jp8080-motion.js').then((m) => { v = m.motionView(root, g, params); }).catch((err) => g.error(err, 'Motion page'));
        return { destroy: () => v?.destroy?.() };
      },
    }],
    objects: [
      {
        key: 'system', page: 'System', icon: '⚙', label: 'System', size: SYS_SIZE, autoLoad: true,
        init: sysDefaults,
        fetch: (api) => fetchParts(api, sysBuilt),
        params: sysParams,
        receive: receiver(sysBuilt),
        cols: 3,
        groupInfo: {
          'Tx/Rx setting (MODE2): CC per knob': { note: `The control change each knob sends and receives when Tx/Rx Edit Mode is MODE2 (${M.upDownNote ?? 'Control Up/Down: the CCs that step the Control knob'}). In MODE1 the knobs use Roland\'s fixed control changes (listed in the owner\'s manual).${M.txrxWarning ? ` ${M.txrxWarning}` : ''}` },
          'Stored state': { note: 'Values the system settings hold that no menu edits; kept so a backup restores exactly.', table: true },
        },
        note: `Read when the ${M.name} connects. Perform Ctrl CH is the channel that selects performances and takes fine tuning; each part has its own channel on the Performance page.`,
        sendAll: { label: `Send to ${M.name}`, build: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId) },
        toSyx: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId).flat(),
        fromSyx: fromSyxInto(sysBuilt, SYS_SIZE, sysDefaults, (a) => (a >> 21 === 0 ? [0] : [])),
      },
      {
        key: 'patch', page: 'Patch', icon: '◆', label: 'Patch', size: PATCH_SIZE, autoLoad: true,
        toCommon: (d) => TR.patchToCommon(d), fromCommon: (c, base) => TR.patchFromCommon(c, base),
        init: patchDefaults,
        fetch: (api) => fetchParts(api, patchBuilt),
        params: patchParams,
        receive: receiver(patchBuilt),
        sections: [{ key: 'main', label: 'Patch' }, { key: 'control', label: 'Control depths' }, { key: 'velocity', label: 'Velocity depths' }], cols: 3,
        name: (d) => nameOf(d),
        target: {
          label: 'Edit', title: 'Which part\'s temporary patch the editor shows',
          options: () => PATCH_TARGETS,
          value: () => patchTarget.key,
          set: (v) => { patchTarget.key = v; patchTarget.base = A(v === 'lower' ? '01 00 42 00' : '01 00 40 00'); },
        },
        groupInfo: {
          'Control depth (per knob)': { note: 'How far the Control knob (or its assigned controller) moves each knob\'s value, -127 to +127 (Control Assign).' },
          'Velocity depth (per knob)': { note: 'How far key velocity moves each knob\'s value, -127 to +127 (Velocity Assign).' },
          'Stored state': { note: `Values the ${M.name} stores with a patch that no screen or panel control edits; kept so a backup restores exactly.`, table: true },
        },
        note: () => `Edits the patch the ${patchTarget.key} part is playing (its temporary patch); changes are heard at once. Store keeps it in user memory.`,
        actions: [
          { label: 'Rename', run: async (api) => {
            const r = await api.form('Patch name', [{ key: 'name', label: 'Name (16 characters)', value: nameOf(api.data), maxlength: 16 }]);
            if (!r) return;
            const d = Uint8Array.from(api.data);
            for (let i = 0; i < 16; i++) d[i] = Math.max(32, Math.min(125, r.name.charCodeAt(i) || 32));
            api.send(dt1(MODEL, api.ctx.deviceId, intToAddr(patchTarget.base), Array.from(d.slice(0, 16))));
            api.setData(d);
          } },
        ],
        sendAll: { label: `Send to ${M.name}`, title: 'Send the whole patch to the unit\'s temporary patch, to hear it', build: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId) },
        toSyx: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId, A('01 00 40 00')).flat(),
        fromSyx: fromSyxInto({ parts: [{ address: 0, offset: 0, size: PATCH_SIZE }] }, PATCH_SIZE, patchDefaults, (a) => {
          if (a >> 21 === 1 && ((a >> 7) & 127) >= 0x40) return [a >= A('01 00 42 00') ? A('01 00 42 00') : A('01 00 40 00')];
          if (a >> 21 === 2) return [userPatch((a - A('02 00 00 00')) >> 8)];
          if (a >> 21 === 3 && ((a >> 7) & 127) >= 0x40) return [(a & ~A('00 00 7f 7f')) + A(((a >> 7) & 127) >= 0x42 ? '00 00 42 00' : '00 00 40 00')];
          return [];
        }),
        slots: {
          label: 'Patches',
          banks: PATCH_BANKS.map((b, i) => [i, b.label]),
          count: 128,
          slotLabel: (bank, i) => `${PATCH_BANKS[bank].user ? 'U' : `P${bank}`}:${patchNumber(i)}`,
          name: (d) => nameOf(d),
          recall: (bank, i, ctx) => select(partChannel(ctx, patchTarget.key === 'lower' ? 1 : 0), PATCH_BANKS[bank].msb, PATCH_BANKS[bank].lsb, i),
          fetch: async (api, bank, i) => {
            if (PATCH_BANKS[bank].user) return readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPatch(i)), PATCH_SIZE);
            api.send(select(partChannel(api.ctx, patchTarget.key === 'lower' ? 1 : 0), PATCH_BANKS[bank].msb, PATCH_BANKS[bank].lsb, i));
            await sleep(api.g?.demo ? 50 : 400);
            return fetchParts(api, patchBuilt);
          },
          fetchName: async (api, bank, i) => nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPatch(i)), 16)),
          names: presetPatchNames,
          scannable: (bank) => !!PATCH_BANKS[bank].user,
          store: (bank, i, ctx, data) => dt1Chunks(MODEL, ctx.deviceId, intToAddr(userPatch(i)), data, 0x80),
          writable: (bank) => !!PATCH_BANKS[bank].user,
          autoNames: [0],
          note: (bank, ctx) => `Play selects the patch on the ${patchTarget.key} part's channel (${partChannel(ctx, patchTarget.key === 'lower' ? 1 : 0) + 1}); System Tx/Rx ProgChg SW must be BANK SEL + PC.${PATCH_BANKS[bank].user ? ' Store writes the editor\'s patch into user memory.' : ''}`,
        },
      },
      {
        key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: PERF_SIZE, autoLoad: true,
        toCommon: (d) => TR.perfToCommon(d), fromCommon: (c, base) => TR.perfFromCommon(c, base),
        init: perfDefaults,
        fetch: (api) => fetchParts(api, perfBuilt),
        params: perfParams,
        receive: receiver(perfBuilt),
        sections: [{ key: 'common', label: 'Common' }, ...(VMOD === undefined ? [] : [{ key: 'vmod', label: 'Voice modulator' }]), { key: 'part0', label: 'Upper part' }, { key: 'part1', label: 'Lower part' }], cols: 3,
        name: (d) => nameOf(d),
        multi: {
          page: 'MIDI channels', label: 'Parts', count: 2, section: (i) => `part${i}`,
          partLabel: (i) => `${PART_NAMES[i]} part`,
          columns: [
            { label: 'Channel', params: ['Part MIDI CH'], role: 'channel' },
            { label: 'Patch', params: ['Patch bank', ...(PART_SIZE > 7 ? ['Patch group'] : []), 'Patch number'], role: 'patch' },
            { label: 'Transpose', params: ['Part Transpose'] },
          ],
          channels: CHANNELS,
          note: 'Each part plays its patch on its MIDI channel (OFF: the part receives nothing). Key mode (Common) decides whether one or both parts sound. Changes go to the temporary performance; store it to keep them.',
        },
        note: 'Edits the performance being played (the temporary performance): common settings, the voice modulator and both parts. Each part\'s patch is on the Patch page.',
        actions: [{ label: 'Rename', run: async (api) => {
          const r = await api.form('Performance name', [{ key: 'name', label: 'Name (16 characters)', value: nameOf(api.data), maxlength: 16 }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          for (let i = 0; i < 16; i++) d[i] = Math.max(32, Math.min(125, r.name.charCodeAt(i) || 32));
          api.send(dt1(MODEL, api.ctx.deviceId, intToAddr(A('01 00 00 00')), Array.from(d.slice(0, 16))));
          api.setData(d);
        } }],
        sendAll: { label: `Send to ${M.name}`, build: (data, ctx) => writeParts(perfBuilt, data, ctx.deviceId) },
        toSyx: (data, ctx) => writeParts(perfBuilt, data, ctx.deviceId).flat(),
        fromSyx: fromSyxInto(perfBuilt, PERF_SIZE, perfDefaults, (a) => (a >> 21 === 1 ? [A('01 00 00 00')] : a >> 21 === 3 ? [a & ~A('00 00 7f 7f')] : [])),
        slots: {
          label: 'Performances',
          banks: PERF_BANKS.map((b, i) => [i, b.label]),
          count: 64,
          slotLabel: (bank, i) => `${PERF_BANKS[bank].user ? 'U' : `P${bank}`}:${perfNumber(i)}`,
          name: (d) => nameOf(d),
          recall: (bank, i, ctx) => select(perfChannel(ctx), PERF_BANKS[bank].msb, PERF_BANKS[bank].lsb, i),
          fetch: async (api, bank, i) => {
            if (PERF_BANKS[bank].user) return fetchParts(api, perfBuilt, userPerf(i));
            api.send(select(perfChannel(api.ctx), PERF_BANKS[bank].msb, PERF_BANKS[bank].lsb, i));
            await sleep(api.g?.demo ? 50 : 500);
            return fetchParts(api, perfBuilt);
          },
          fetchName: async (api, bank, i) => nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPerf(i)), 16)),
          names: presetPerfNames,
          scannable: (bank) => !!PERF_BANKS[bank].user,
          store: (bank, i, ctx, data) => writeParts(perfBuilt, data, ctx.deviceId, userPerf(i)),
          writable: (bank) => !!PERF_BANKS[bank].user,
          autoNames: [0],
          note: (bank, ctx) => `Play selects the performance on the Perform Ctrl channel (${perfChannel(ctx) + 1}). A stored performance keeps the common settings, voice modulator and parts, and its two patches are stored with it.`,
        },
      },
    ],
    // Branch Library "Complete dump": everything the unit holds (checked on a JP-8080: user patches take
    // about 40 s, user performances about 80 s; an empty motion sends nothing).
    fullDump: [
      'System', `Temporary performance (common, ${VMOD === undefined ? '' : 'voice modulator, '}parts)`, 'Temporary patch, upper', 'Temporary patch, lower',
      'All user patches', 'All user performances', ...MOTIONS.map(([m]) => ({ request: `Motion ${m}`, timeout: 3000 })),
      ...(M.patterns ? [{ request: 'All RPS patterns (C#2-C6)', timeout: 3000 }] : []),
    ],
    requests: [
      { label: 'System', bytes: (ctx) => SYS_PARTS.map((p) => rq1(MODEL, ctx.deviceId, intToAddr(p.address), p.size)) },
      { label: `Temporary performance (common, ${VMOD === undefined ? '' : 'voice modulator, '}parts)`, bytes: (ctx) => PERF_PARTS.map((p) => rq1(MODEL, ctx.deviceId, intToAddr(p.address), p.size)) },
      { label: 'Temporary patch, upper', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('01 00 40 00')), PATCH_SIZE) },
      { label: 'Temporary patch, lower', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('01 00 42 00')), PATCH_SIZE) },
      { label: 'All user patches', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('02 00 00 00')), A('00 02 00 00')) }, // 128 x 00 00 02 00
      { label: 'All user performances', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('03 00 00 00')), A('00 40 00 00')) },
      { label: 'Motion sets A and B (4 motions)', bytes: (ctx) => MOTIONS.map(([, a]) => rq1(MODEL, ctx.deviceId, intToAddr(A(a)), A('00 40 00 00'))) },
      ...MOTIONS.map(([m, a]) => ({ label: `Motion ${m}`, bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A(a)), A('00 40 00 00')) })),
      // RPS patterns (JP-8000 only): one request answers every non-empty pattern, 08 00 00 00 to 08 2F
      ...(M.patterns ? [{ label: 'All RPS patterns (C#2-C6)', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('08 00 00 00')), A('00 30 00 00')) }] : []),
    ],
  };

  const MOTION_SLOTS = TXRX_PATCH.map((o, i) => [i, knobName(o)]);
  def.motionSlots = MOTION_SLOTS;
  const test = { MOTION_SLOTS, unpack7, patternAddr, ...(M.patterns ? { readPattern, patternMessages, patternTimeline } : {}), MOTIONS, PATTERN_KEYS, MODEL, A, sysParams, perfParams, patchParams, sysBuilt, perfBuilt, patchBuilt, patchTarget, userPatch, userPerf, patchDefaults, perfDefaults, sysDefaults, addressOf, display, SYNC, TXRX_PATCH, libraryItems, isJP8080Identity: isJPIdentity, PATCH_BANKS, PERF_BANKS };
  return { def, test };
}
