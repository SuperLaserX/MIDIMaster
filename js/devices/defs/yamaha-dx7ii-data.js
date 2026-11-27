// Yamaha DX7II (and DX7s): system setup, micro tuning and fractional scaling as edited objects, and
// the additional data of 32 voices (AMEM) packing. Everything here was read from the DX7II v1.9
// firmware's MIDI and edit code (listings re/dx/dx7ii_lower.lst and re/dx/dx7ii_upper.lst, made by
// tools/yamaha/hd6303_dis.py; "L" = lower bank, "U" = upper bank, both seen at 8000-FFFF). See
// docs/devices/yamaha-dx7ii.md. Not yet checked on a DX7II.
//
//   F0 43 0n 06 08 60 <32 x 35> cs F7          AMEM: 26 + 9 bytes a voice (RAM 4000h / 4680h, receiver L AF38,
//                                              sender L B609; pack U DCC0/DD40, unpack U E01A/E0D6)
//   F0 43 0n 7E 00 5F "LM  8973S " <85> cs F7  system setup (RAM 5000h; receiver L AF06, sender L B6A3)
//   F0 43 0n 7E 02 0A "LM  MCRYE " <256> cs F7 micro tuning edit buffer: 128 keys x 2 bytes (RAM 58D5h);
//                                              "LM  MCRYM" + 00h / 01h the two internal tables (56D5h, 57D5h),
//                                              "LM  MCRYC " the cartridge's (63 messages)
//   F0 43 0n 7E 03 76 "LM  FKSYE " <492> cs F7 fractional scaling of the voice being edited: 246 bytes, each
//                                              sent as two characters 30h + nibble, high first (L ADA9, B86B);
//                                              "LM  FKSYC " the cartridge's (32 messages)
//   F0 43 1n 19 pp vv F7                       pp 40h-52h: system bytes 0-18 (L A9C4); 53h memory protect (bit 0
//                                              INT, bit 1 CRT); 00h-32h the performance (U E6AF)
//   F0 43 1n 04 40 vv F7                       master tuning (system byte 20; L A8ED, sender L B268)
//   F0 43 1n 18 7E kk hh ll F7                 micro tuning edit buffer: key kk = hh x 128 + ll (L AA5A, B067)
//   F0 43 1n 18 7F oo pp hh ll F7              fractional scaling: operator oo (0 = OP6), pp 0 = offset, 1-40 =
//                                              key group; value hh x 128 + ll (L AA77, B092; sender L B308)

import { bulkHeader, parseBulk, paramChange, dumpRequestHeader, YAMAHA } from './yamaha-dx-sysex.js';
import { keyCurveGraph } from './yamaha-dx-draw.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import * as FW from './yamaha-dx7ii-fw.js';

const V = Object.fromEntries([...FW.VALUES.items, ...FW.VALUES2.items].map((x) => [x.addr, x.text.trim()]));
const opts = (l) => l.map((t, i) => [i, t]);
const OFF = V.F9FB;
const OFFON = [V.F9FB, V.F9F7];
const NOTES = FW.NOTES.items.map((t) => t.trim());
export const keyName = (n) => `${NOTES[n % 12]}${Math.floor(n / 12) - 2}`;

// ------------------------------------------------------------------ AMEM (35 bytes a voice)
export const AMEM_SIZE = 35;
/** The 35-byte form of the 49 ACED bytes (U DCC0 + DD40; byte 25 is not used). */
export function packAced(a) {
  const p = new Uint8Array(AMEM_SIZE);
  for (let i = 0; i < 6; i++) p[0] |= (a[i] & 1) << i; // scaling mode OP6..OP1 = bits 0..5
  p[1] = (a[6] & 7) | ((a[7] & 7) << 3); // Ams OP6, OP5
  p[2] = (a[8] & 7) | ((a[9] & 7) << 3); // OP4, OP3
  p[3] = (a[10] & 7) | ((a[11] & 7) << 3); // OP2, OP1
  p[4] = (a[12] & 3) | ((a[13] & 1) << 2) | ((a[14] & 1) << 3) | ((a[19] & 7) << 4); // Peg Rng, LFO mode, Peg Vel, random pitch
  p[5] = (a[15] & 3) | ((a[16] & 15) << 2); // key mode, pitch bend range
  p[6] = (a[17] & 15) | ((a[18] & 3) << 4); // pitch bend step, mode
  p[7] = (a[20] & 1) | ((a[21] & 15) << 1); // portamento mode, step
  for (let i = 0; i < 17; i++) p[8 + i] = a[22 + i] & 0x7f; // portamento time .. Peg Rs
  for (let i = 0; i < 8; i++) p[26 + i] = a[39 + i] & 0x7f; // foot control 2, MIDI IN control
  p[34] = (a[47] & 7) | ((a[48] & 1) << 3); // unison detune, FC1 as CS1
  return p;
}
/** The 49 ACED bytes of a 35-byte AMEM entry, held to the maximum table as the DX7II does (U E01A, E0D6). */
export function unpackAmem(p) {
  const a = new Uint8Array(49);
  for (let i = 0; i < 6; i++) a[i] = (p[0] >> i) & 1;
  [6, 8, 10].forEach((o, k) => { a[o] = p[1 + k] & 7; a[o + 1] = p[1 + k] >> 3; });
  a[12] = p[4] & 3; a[13] = (p[4] >> 2) & 1; a[14] = (p[4] >> 3) & 1; a[19] = p[4] >> 4;
  a[15] = p[5] & 3; a[16] = p[5] >> 2;
  a[17] = p[6] & 15; a[18] = p[6] >> 4;
  a[20] = p[7] & 1; a[21] = p[7] >> 1;
  for (let i = 0; i < 17; i++) a[22 + i] = p[8 + i];
  for (let i = 0; i < 8; i++) a[39 + i] = p[26 + i];
  a[47] = p[34] & 7; a[48] = p[34] >> 3;
  FW.ACED_MAX.items.forEach((m, i) => { if (a[i] > m) a[i] = m; });
  return a;
}
/**
 * The additional data the DX7II makes for a voice that came without it (a 32-voice bulk with no AMEM
 * before it, L ACD0 -> BD88): INIT VOICE's additional data, with each operator's Ams from the voice's own
 * (0-3, VMEM byte 13 of the operator).
 */
export function acedFromVoice(vced) {
  const a = Uint8Array.from(FW.INIT_ACED.items);
  for (let k = 0; k < 6; k++) a[6 + k] = vced[k * 21 + 14] & 3; // OP6 first
  return a;
}

// ------------------------------------------------------------------ system setup (85 bytes)
export const SYS = 'LM  8973S ';
export const SYS_SIZE = 85;
const chOpts = [...Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]), [16, OFF]];
export const sysNum = (o) => 128 + 0x40 + o; // F0 43 1n 19 (40h + byte)
function sysParams() {
  const MAX = FW.SYS_MAX.items;
  const ps = [];
  const P = (o, label, group, extra = {}) => ps.push({ key: `s${o}`, label, offset: o, min: 0, max: MAX[o] ?? 127, group, ...extra });
  // A channel and its on/off byte, shown as the screen does: 1-16 or off (off stores channel 16, D381).
  const pair = (o, label, group, help) => ps.push({
    key: `s${o}`, label, offset: o, size: 2, min: 0, max: 16, group, options: chOpts, help,
    get: (d) => (d[o + 1] ? d[o] & 15 : 16),
    set: (d, v) => { if (v >= 16) { d[o] = 15; d[o + 1] = 0; } else { d[o] = v; d[o + 1] = 1; } },
    pair: true,
  });
  pair(0, 'Transmit channel', 'Channel', 'Channel >Trns ch (bytes 0-1): the channel the keyboard sends on, or off.');
  P(2, 'Receive channel A', 'Channel', { options: chOpts, help: 'Channel Rcv ch >A: voice A (or the single voice) plays on this channel.' });
  P(3, 'Receive channel B', 'Channel', { options: chOpts, help: 'Channel Rcv ch >B: voice B of a dual or split performance.' });
  P(4, 'Omni messages', 'Channel', { options: opts(OFFON), help: 'Channel >Omni messages: obey omni on/off messages.' });
  P(5, 'MIDI IN control A number', 'Control', { min: 11, help: 'Control MIDI IN control >A: the control number (11-31) the voice parameter "MIDI IN control" follows for voice A.' });
  P(6, 'MIDI IN control B number', 'Control', { min: 11, help: '... for voice B.' });
  P(7, 'CS1 number', 'Control', { min: 5, help: 'Control CS >1 number: the control number (5-31) continuous slider 1 sends and receives.' });
  P(8, 'CS2 number', 'Control', { min: 5 });
  P(9, 'Note on/off', 'MIDI', { options: opts([V.FC4F, V.FC54, V.FC59]), help: 'MIDI >Note on/off: send all notes, or the odd or even ones only.' });
  P(10, 'PC trns mode', 'MIDI', { options: opts([V.FC5E, V.FC6B, V.FC78]), help: 'MIDI >PC trns mode: send no program change, the memory number, or the number in the program change table below.' });
  P(11, 'Local', 'MIDI', { options: opts(OFFON) });
  pair(14, 'Device number', 'MIDI', 'MIDI >Device number (bytes 14-15): the SysEx channel; off: no bulk dumps or requests are taken (the editor needs it on, on its channel).');
  P(13, 'Receive block', 'MIDI', { options: opts([V.FC85, V.FC8B]), help: 'MIDI >Receive block: where a received 32-voice bulk goes (internal 1-32 or 33-64).' });
  P(12, 'MIDI out voice bank', 'MIDI', { options: opts([V.FC85, V.FC8B]), help: 'MIDI out Voice >1-32 >33-64: the 32 voices a bulk sends, and a dump request answers.' });
  P(20, 'Master tuning', 'Tuning', { format: (v) => `${v >= 64 ? '+' : '-'}${Math.abs(v - 64)}`, help: '>Master tuning: 64 = centre (sent as F0 43 1n 04 40 vv F7).' });
  ['Voice & Perf.', 'Fractional SC.', 'Micro tuning'].forEach((t, i) => P(16 + i, `Bank ${t}`, 'Cartridge', { format: (v) => String(v + 1), help: `Cartridge >Bank for ${t} (1-16, as the cartridge's size allows).` }));
  P(19, 'Byte 19', 'Cartridge', { input: 'number', help: 'Maximum 3, initial 3 (tables ED39, 0CA4); no screen or code reads it by name. Sent only with the whole setup.' });
  for (let i = 0; i < 64; i++) P(21 + i, `Memory ${i + 1}`, 'Program change table', { input: 'number', format: (v) => String(v + 1), help: 'Program sw:[ ] change trns #: the program number (1-128) sent for this memory when PC trns mode is programmable.' });
  return ps;
}
export const isSys = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === SYS && b.body.length === SYS_SIZE); };

export function systemObject(variant, ch) {
  const params = variant.sysParams ? variant.sysParams({ chOpts, opts, OFFON }) : sysParams(); // the DX7s: its own pages
  const init = () => Uint8Array.from(variant.sysInit || FW.SYS_INIT.items);
  const sendOne = (o, d, c) => {
    if (o <= 18) return paramChange(c, 6, sysNum(o), d[o]);
    if (o === 20) return paramChange(c, 1, 64, d[20]);
    return null;
  };
  return {
    key: 'system', page: 'System', icon: '⚙', label: 'System setup', size: SYS_SIZE,
    init, params, cols: 3,
    request: (ctx) => dumpRequestHeader(ch(ctx), SYS),
    match: isSys,
    decode: (raw) => Uint8Array.from(parseBulk(raw).body),
    note: `The ${variant.name}'s MIDI and cartridge settings (MIDI and Cartridge pages). Bytes 0-18 go as parameter changes (19h, 40h + byte), the master tuning as 04h 40h; the program change table and byte 19 have none, so a change there sends the whole setup.`,
    sendParam: (p, _v, d, ctx) => {
      const c = ch(ctx);
      if (p.pair) return [sendOne(p.offset, d, c), sendOne(p.offset + 1, d, c)];
      return sendOne(p.offset, d, c) || bulkHeader(c, SYS, d);
    },
    sendAll: { label: 'Send', title: 'Send the system setup ("LM  8973S ")', build: (d, ctx) => bulkHeader(ch(ctx), SYS, d) },
    toSyx: (d, ctx) => bulkHeader(ch(ctx), SYS, d),
    fromSyx: (msgs) => { const m = msgs.find(isSys); return m ? Uint8Array.from(parseBulk(m).body) : null; },
    receive: (raw, d, ctx) => {
      if (isSys(raw)) return Uint8Array.from(parseBulk(raw).body);
      const pc = parsePc(raw);
      if (!pc || pc.channel !== ch(ctx)) return null;
      const next = Uint8Array.from(d);
      if (pc.group === 6 && pc.num >= sysNum(0) && pc.num <= sysNum(18)) next[pc.num - sysNum(0)] = pc.value;
      else if (pc.group === 1 && pc.num === 64) next[20] = pc.value;
      else return null;
      return next;
    },
    actions: [
      { label: 'Init', title: `The ${variant.name}'s initial system setup (${variant.sysInit ? 'B186' : 'lower bank 8CA4'}; not sent until you press Send)`, run: (api) => api.setData(init()) },
      { label: 'Memory protect off', title: 'Turn internal and cartridge memory protect off (F0 43 1n 19 53 00 F7): needed before a bulk or Store writes memory', run: (api) => { api.send(paramChange(ch(api.ctx), 6, sysNum(0x13), 0)); api.toast('Memory protect INT and CRT off', 'good', 2000); } },
    ],
  };
}

// ------------------------------------------------------------------ micro tuning (128 keys x 2 bytes)
export const MCRYE = 'LM  MCRYE ';
export const MCRYC = 'LM  MCRYC ';
export const mcrym = (n) => `LM  MCRYM${String.fromCharCode(n)}`;
export const MT_SIZE = 256;
export const MT_MAX = 0x2a2a; // the panel's limit (L 9F23)
// The 12 semitones of an octave in 1/1024 octave (table L 84C0); the display compares a value + 86
// with each step + 86 (L 9E0A) and shows the nearest note with the distance in these units.
const STEPS = FW.EQUAL_STEPS.items.map((e) => (e >= 8192 ? e - 16384 : e)); // C = -86: value 0 is C#-2
const MARKS = STEPS.map((e) => e + 86);
/** A key's tuning as the micro tuning page shows it: nearest note and the distance (1/1024 octave). */
export function mtText(v) {
  const D = (v + 86) & 0x3fff;
  const oct = Math.floor(D / 1024);
  const rem = D % 1024;
  let k = 0;
  while (k < 12 && rem >= MARKS[k]) k++;
  const next = (k < 12 ? MARKS[k] : 1024) - rem;
  const prev = rem - MARKS[k - 1];
  const [note, dev] = prev < next ? [oct * 12 + k - 1, `+${prev}`] : [oct * 12 + k, `-${next}`];
  return `${keyName(note)} ${dev}`;
}
/** Equal temperament (preset 1): the table L 84C0 over the octaves (L 9858), key C-2 as L 9C4E leaves it. */
export function equalTemperament() {
  const d = new Uint8Array(MT_SIZE);
  for (let n = 0; n < 128; n++) {
    const v = (Math.floor(n / 12) * 1024 + STEPS[n % 12]) & 0x3fff;
    d[2 * n] = v >> 7; d[2 * n + 1] = v & 0x7f;
  }
  for (let n = 0; n < 128 && d[2 * n]; n++) { d[2 * n] = d[2 * n + 24]; d[2 * n + 1] = d[2 * n + 25]; }
  return d;
}
const mtParam = (ch, n, d) => [0xf0, YAMAHA, 0x10 | (ch & 15), 0x18, 0x7e, n, d[2 * n] & 0x7f, d[2 * n + 1] & 0x7f, 0xf7];
function mtParams() {
  return Array.from({ length: 128 }, (_, n) => {
    const o = 2 * n;
    return {
      key: `k${n}`, label: keyName(n), offset: o, size: 2, min: 0, max: MT_MAX, input: 'number',
      group: `Keys ${keyName(Math.floor(n / 12) * 12)} - ${keyName(Math.min(127, Math.floor(n / 12) * 12 + 11))}`,
      get: (d) => ((d[o] & 0x7f) << 7) | (d[o + 1] & 0x7f),
      set: (d, v) => { d[o] = (v >> 7) & 0x7f; d[o + 1] = v & 0x7f; },
      format: mtText,
    };
  });
}
const mtHeader = (raw) => { const b = parseBulk(raw); return b?.ok && b.body?.length === MT_SIZE && /^LM {2}MCRY[EMC]/.test(b.header) ? b.header : null; };

export function microTuningObject(variant, ch) {
  const isMt = (raw) => mtHeader(raw) === MCRYE;
  return {
    key: 'microtuning', page: 'Micro tuning', icon: '♯', label: 'Micro tuning', size: MT_SIZE,
    init: equalTemperament, params: mtParams(), cols: 4,
    request: (ctx) => dumpRequestHeader(ch(ctx), MCRYE),
    match: isMt,
    decode: (raw) => Uint8Array.from(parseBulk(raw).body),
    note: `The micro tuning edit buffer: each key's pitch in 1/1024 octave (0 = C#-2; 1024 an octave), shown as the ${variant.name}'s page does, as the nearest note and the distance. A performance plays it when its micro tuning table is the edit buffer's; Send as user table stores it in internal table 1 or 2 (memory protect off).`,
    sendParam: (p, _v, d, ctx) => mtParam(ch(ctx), p.offset / 2, d),
    sendAll: { label: 'Send', title: 'Send the micro tuning edit buffer ("LM  MCRYE ")', build: (d, ctx) => bulkHeader(ch(ctx), MCRYE, d) },
    toSyx: (d, ctx) => bulkHeader(ch(ctx), MCRYE, d),
    fromSyx: (msgs) => { const m = msgs.find((x) => mtHeader(x)); return m ? Uint8Array.from(parseBulk(m).body) : null; },
    receive: (raw, d, ctx) => {
      if (isMt(raw)) return Uint8Array.from(parseBulk(raw).body);
      if (raw.length === 9 && raw[0] === 0xf0 && raw[1] === YAMAHA && raw[2] === (0x10 | ch(ctx)) && raw[3] === 0x18 && raw[4] === 0x7e && raw[5] < 128) {
        const next = Uint8Array.from(d);
        next[2 * raw[5]] = raw[6]; next[2 * raw[5] + 1] = raw[7];
        return next;
      }
      return null;
    },
    actions: [
      { label: 'Equal temperament', title: 'Preset 1, Equal temperament, as the unit lays it out (not sent until you press Send)', run: (api) => api.setData(equalTemperament()) },
      ...[0, 1].map((t) => ({
        label: `Get user table ${t + 1}`, title: `Read internal micro tuning table ${t + 1} ("LM  MCRYM" ${t})`,
        run: async (api) => {
          const raw = await api.request(dumpRequestHeader(ch(api.ctx), mcrym(t)), (r) => mtHeader(r) === mcrym(t), (r) => r);
          api.setData(Uint8Array.from(parseBulk(raw).body));
        },
      })),
      ...[0, 1].map((t) => ({
        label: `Send as user table ${t + 1}`, title: `Store the edited tuning in internal table ${t + 1} ("LM  MCRYM" ${t}; memory protect INT off)`,
        run: async (api) => {
          if (!(await api.confirm('Store micro tuning', `Replace internal micro tuning table ${t + 1} (Programmed tune) of the ${variant.name}?`, 'Send', true))) return;
          api.send(bulkHeader(ch(api.ctx), mcrym(t), api.data));
        },
      })),
    ],
    toCommon: (d) => mtToCommon(d, variant.name),
    fromCommon: (c) => mtFromCommon(c),
  };
}

// ------------------------------------------------------------------ fractional scaling (6 x 41 bytes)
export const FKSYE = 'LM  FKSYE ';
export const FKSYC = 'LM  FKSYC ';
export const FKS_SIZE = 246;
const FKS_OP = 41; // per operator: offset, then 40 key groups (L 930F: 29h bytes, OP6 first)
/** The first key of key group p (L 933E / 9444): C-2 for group 0 (keys 0-12), then 3p + 10. */
export const fksKey = (p) => (p ? 3 * p + 10 : 0);
/** An FKS message: the 246 bytes as two characters each, 30h + the nibble, high first (L B86B). */
export function fksBulk(ch, header, d) {
  const out = [];
  for (const b of d) out.push(0x30 + ((b >> 4) & 15), 0x30 + (b & 15));
  return bulkHeader(ch, header, out);
}
/** {header, body} of an FKS message, or null. */
export function parseFks(raw) {
  const b = parseBulk(raw);
  if (!b?.ok || !/^LM {2}FKSY[EC] $/.test(b.header || '') || b.body.length !== 2 * FKS_SIZE) return null;
  const body = new Uint8Array(FKS_SIZE);
  for (let i = 0; i < FKS_SIZE; i++) {
    const hi = b.body[2 * i] - 0x30;
    const lo = b.body[2 * i + 1] - 0x30;
    if (hi < 0 || hi > 15 || lo < 0 || lo > 15) return null;
    body[i] = (hi << 4) | lo;
  }
  return { channel: b.channel, header: b.header, body };
}
const fksParam = (ch, opIndex, pp, s) => [0xf0, YAMAHA, 0x10 | (ch & 15), 0x18, 0x7f, opIndex, pp, (s >> 7) & 1, s & 0x7f, 0xf7];
function fksParams() {
  const ps = [];
  for (let i = 0; i < 6; i++) {
    const op = 6 - i;
    const base = i * FKS_OP;
    const group = `OP${op} Fractional scaling`;
    // Ofst: shown "+n" for 80h + n (and 0), "-n" for 1-127 (L 9325)
    ps.push({
      key: `op${op}_fofs`, label: 'Ofst', offset: base, min: -127, max: 127, group, section: `op${op}`, fks: [i, 0],
      get: (d) => (d[base] >= 128 ? d[base] - 128 : -d[base]),
      set: (d, v) => { d[base] = v >= 0 ? 128 + v : -v; },
      format: (v) => `${v >= 0 ? '+' : ''}${v}`,
      help: 'Outlvl >Ofst: an offset added to the whole curve (-127 to +127).',
    });
    for (let p = 0; p < 40; p++) {
      const o = base + 1 + p;
      const last = p === 39 ? 127 : fksKey(p + 1) - 1;
      ps.push({
        key: `op${op}_f${p}`, label: `${keyName(fksKey(p))}`, offset: o, min: 0, max: 255, group, section: `op${op}`, fks: [i, p + 1], input: 'number',
        get: (d) => 255 - d[o], set: (d, v) => { d[o] = 255 - v; },
        help: `Output level for keys ${keyName(fksKey(p))} to ${keyName(last)} (0-255; the unit stores 255 minus it).`,
      });
    }
  }
  return ps;
}

export function fractionalObject(variant, ch) {
  const isFks = (raw) => parseFks(raw)?.header === FKSYE;
  const groupInfo = {};
  for (let i = 0; i < 6; i++) {
    const op = 6 - i;
    const base = i * FKS_OP;
    groupInfo[`OP${op} Fractional scaling`] = {
      wide: true,
      draw: ({ data }) => keyCurveGraph({
        points: Array.from({ length: 40 }, (_, p) => ({ key: fksKey(p), value: 255 - data[base + 1 + p] })), max: 255,
        caption: 'Level over the 40 key groups (C-2 to C-1, then three keys each); the offset is not drawn.',
      }),
    };
  }
  return {
    key: 'fractional', page: 'Fractional scaling', icon: '⟋', label: 'Fractional scaling', size: FKS_SIZE,
    init: () => new Uint8Array(FKS_SIZE).fill(0).map((_, k) => (k % FKS_OP === 0 ? 128 : 0)),
    params: fksParams(),
    sections: Array.from({ length: 6 }, (_, k) => ({ key: `op${k + 1}`, label: `OP${k + 1}` })),
    sectionLabel: 'Operator',
    groupInfo,
    cols: 5,
    request: (ctx) => dumpRequestHeader(ch(ctx), FKSYE),
    match: isFks,
    decode: (raw) => parseFks(raw).body,
    note: `The fractional scaling of the voice being edited: per operator an offset and an output level for each of 40 key groups, used instead of the keyboard level scaling when the operator's Scaling mode (additional voice data) is fractional; the ${variant.name} ignores a change for an operator in normal mode.`,
    sendParam: (p, _v, d, ctx) => fksParam(ch(ctx), p.fks[0], p.fks[1], d[p.offset]),
    sendAll: { label: 'Send', title: 'Send the fractional scaling ("LM  FKSYE ")', build: (d, ctx) => fksBulk(ch(ctx), FKSYE, d) },
    toSyx: (d, ctx) => fksBulk(ch(ctx), FKSYE, d),
    fromSyx: (msgs) => { const m = msgs.find((x) => parseFks(x)); return m ? parseFks(m).body : null; },
    receive: (raw, d, ctx) => {
      if (isFks(raw)) return parseFks(raw).body;
      if (raw.length === 10 && raw[0] === 0xf0 && raw[1] === YAMAHA && raw[2] === (0x10 | ch(ctx)) && raw[3] === 0x18 && raw[4] === 0x7f && raw[5] < 6 && raw[6] <= 40) {
        const next = Uint8Array.from(d);
        next[raw[5] * FKS_OP + raw[6]] = ((raw[7] & 1) << 7) | raw[8];
        return next;
      }
      return null;
    },
    toCommon: (d) => fksToCommon(d, variant.name),
    fromCommon: (c, base) => fksFromCommon(c, base),
  };
}

// ------------------------------------------------------------------ Head Library
// A micro tuning is shared as each key's pitch in cents above C-2 (kind 'tuning', `cents`): value v is
// v / 1024 octave above C#-2. Another DX7II-family table also travels exactly (extra.mt).
export function mtToCommon(d, model) {
  const cents = Array.from({ length: 128 }, (_, n) => Math.round(((((d[2 * n] & 0x7f) << 7) | (d[2 * n + 1] & 0x7f)) * 1200) / 1024 + 100));
  return { model: COMMON_MODEL, kind: 'tuning', cents, extra: { family: 'yamaha-dx', model, mt: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d)) } };
}
export function mtFromCommon(c) {
  const report = emptyReport();
  if (c?.extra?.mt && fromBase64(c.extra.mt).length === MT_SIZE) {
    report.mapped.push(`the whole table (${c.extra.model})`);
    return { data: fromBase64(c.extra.mt), report };
  }
  const d = equalTemperament();
  if (Array.isArray(c?.cents) && c.cents.length) {
    c.cents.slice(0, 128).forEach((ct, n) => {
      const v = Math.max(0, Math.min(MT_MAX, Math.round(((ct - 100) * 1024) / 1200)));
      d[2 * n] = v >> 7; d[2 * n + 1] = v & 0x7f;
    });
    report.approximated.push('each key\'s pitch to the nearest 1/1024 octave (about 1.2 cents)');
  } else report.dropped.push('no tuning in the source: equal temperament');
  return { data: d, report };
}
/** Fractional scaling has no shared form: a DX7II-family one travels exactly, others are dropped. */
export function fksToCommon(d, model) {
  return { model: COMMON_MODEL, kind: 'fractional-scaling', extra: { family: 'yamaha-dx', model, fks: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d)) } };
}
export function fksFromCommon(c, base) {
  const report = emptyReport();
  if (c?.extra?.fks && fromBase64(c.extra.fks).length === FKS_SIZE) {
    report.mapped.push(`the whole fractional scaling (${c.extra.model})`);
    return { data: fromBase64(c.extra.fks), report };
  }
  report.dropped.push('fractional scaling of another model (no shared form)');
  return { data: Uint8Array.from(base || new Uint8Array(FKS_SIZE)), report };
}

// ------------------------------------------------------------------ Branch Library, simulator
function parsePc(raw) {
  if (!raw || raw.length !== 7 || raw[0] !== 0xf0 || raw[1] !== YAMAHA || (raw[2] & 0xf0) !== 0x10) return null;
  return { channel: raw[2] & 15, group: (raw[3] >> 2) & 0x1f, num: ((raw[3] & 3) << 7) | raw[4], value: raw[5] };
}

/** Branch Library items for system, micro tuning and fractional scaling dumps (null for other messages). */
export function dataItems(m, k, msgs) {
  if (isSys(m)) return [{ key: `s${k}`, label: 'System setup', name: '', object: 'system', data: Uint8Array.from(parseBulk(m).body), msgs: [m] }];
  const mt = mtHeader(m);
  if (mt) {
    const n = mt === MCRYC ? (msgs || []).slice(0, k).filter((x) => mtHeader(x) === MCRYC).length : 0;
    const what = mt === MCRYE ? 'Micro tuning edit buffer' : mt === MCRYC ? `Cartridge micro tuning ${n + 1}` : `Micro tuning user table ${mt.charCodeAt(9) + 1}`;
    const d = Uint8Array.from(parseBulk(m).body);
    return [{ key: `mt${k}`, label: what, name: '', object: 'microtuning', data: d, msgs: [Uint8Array.from(bulkHeader(parseBulk(m).channel, MCRYE, d))] }];
  }
  const f = parseFks(m);
  if (f) {
    const n = f.header === FKSYC ? (msgs || []).slice(0, k).filter((x) => parseFks(x)?.header === FKSYC).length : 0;
    return [{ key: `fk${k}`, label: f.header === FKSYE ? 'Fractional scaling' : `Cartridge fractional scaling ${n + 1}`, name: '', object: 'fractional', data: f.body, msgs: [Uint8Array.from(fksBulk(f.channel, FKSYE, f.body))] }];
  }
  return null;
}
export const isDataMsg = (raw) => isSys(raw) || !!mtHeader(raw) || !!parseFks(raw);

/** The demo unit's system setup, micro tuning and fractional scaling. */
export function simulateRequest(unit, d, hdr) {
  const c = d[2] & 15;
  if (hdr === SYS) return [bulkHeader(c, SYS, unit.sys ||= Uint8Array.from(FW.SYS_INIT.items))];
  if (hdr === MCRYE) return [bulkHeader(c, MCRYE, unit.mt ||= equalTemperament())];
  if (hdr === mcrym(0) || hdr === mcrym(1)) return [bulkHeader(c, hdr, (unit.mtUser ||= [equalTemperament(), equalTemperament()])[hdr.charCodeAt(9)])];
  if (hdr === FKSYE) return [fksBulk(c, FKSYE, unit.fks ||= new Uint8Array(FKS_SIZE))];
  return null;
}
export function simulateBulk(unit, raw) {
  if (isSys(raw)) { unit.sys = Uint8Array.from(parseBulk(raw).body); return true; }
  const mt = mtHeader(raw);
  if (mt === MCRYE) { unit.mt = Uint8Array.from(parseBulk(raw).body); return true; }
  if (mt && mt.startsWith('LM  MCRYM')) { (unit.mtUser ||= [equalTemperament(), equalTemperament()])[mt.charCodeAt(9) & 1] = Uint8Array.from(parseBulk(raw).body); return true; }
  const f = parseFks(raw);
  if (f?.header === FKSYE) { unit.fks = f.body; return true; }
  if (raw.length === 9 && raw[3] === 0x18 && raw[4] === 0x7e) { const mtd = (unit.mt ||= equalTemperament()); mtd[2 * raw[5]] = raw[6]; mtd[2 * raw[5] + 1] = raw[7]; return true; }
  if (raw.length === 10 && raw[3] === 0x18 && raw[4] === 0x7f) { (unit.fks ||= new Uint8Array(FKS_SIZE))[raw[5] * FKS_OP + raw[6]] = ((raw[7] & 1) << 7) | raw[8]; return true; }
  const pc = parsePc(raw);
  if (pc?.group === 6 && pc.num >= sysNum(0) && pc.num <= sysNum(18)) { (unit.sys ||= Uint8Array.from(FW.SYS_INIT.items))[pc.num - sysNum(0)] = pc.value; return true; }
  if (pc?.group === 1 && pc.num === 64) { (unit.sys ||= Uint8Array.from(FW.SYS_INIT.items))[20] = pc.value; return true; }
  return false;
}
