// Yamaha TX802: eight DX7II tone generators (TG1-8, two notes each, 16 in all). Its voices are the
// DX7II's (VCED + ACED, the same formats; yamaha-dx7ii.js); the performance is its own, mapped from
// the TX802 v1.5 firmware (XB224, z:/firmwares/Yamaha_TX802_ROM_v1.5.zip; listing re/dx/tx802.lst)
// and the screen texts of its data ROM (XB536, 32 KB, bank-switched at 6000h; strings in
// re/dx/tx802_xb536_strings.txt). See docs/devices/yamaha-tx802.md. Not yet checked on a TX802.
//
//   F0 43 0n 7E 01 68 "LM  8952PE" <232> cs F7  performance edit buffer: 116 bytes as ASCII hex (two
//                                               characters "0"-"9" "A"-"F" a byte, high first); the
//                                               count is the data only (232), the checksum also covers
//                                               the header (bulk sender A9DD, receiver 9FA4/A2E6)
//   F0 43 0n 7E 01 28 "LM  8952PM" <168> cs F7  one performance memory: the 84-byte packed form as
//                                               ASCII hex; the TX802 sends 64 of them, 1-64 in order
//   F0 43 0n 7E 02 11 "LM  8952S " <263> cs F7  system setup (count with the header, plain bytes)
//   F0 43 1n 1A pp vv F7                        performance parameter pp (= byte number); voice and
//   F0 43 1n 1A pp hi lo F7                     micro tuning (pp 10h-17h, 58h-5Fh) carry two bytes:
//                                               hi = bit 7, lo = bits 6-0 (receiver A6E2, A35C)
//
// The performance edit buffer (RAM 3800h) is twelve parameters for TG1-8 (byte = parameter x 8 + TG)
// and the name; the parameter-change receiver checks the same order. Edit pages: the PERFORMANCE
// EDIT MENU "rcvch vol out lmt shft mtt# dtune name" (texts 59-69 of the data ROM, page code
// E849-EB40). Maxima: table 8F6E. INIT (UTIL5 Initialize perf. edit buffer): data ROM 0E00h.

import { buildDX7II } from './yamaha-dx7ii.js';
import { parseBulk, bulkHeader, dumpRequest, dumpRequestHeader, checksum, YAMAHA } from './yamaha-dx-sysex.js';
import { textAt, VCED_SIZE } from './yamaha-dx-voice.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import * as D2 from './yamaha-dx7ii-data.js';

export const PCED_SIZE = 116;
export const PMEM_SIZE = 84;
const PE = 'LM  8952PE';
const PM = 'LM  8952PM';
const SYS = 'LM  8952S ';

// ------------------------------------------------------------------ messages
const HEX = '0123456789ABCDEF';
/** A TX802 performance message: the bytes as ASCII hex after the header; the count leaves the header out. */
export function tx802Bulk(ch, header, bytes) {
  const data = [...header].map((c) => c.charCodeAt(0));
  for (const b of bytes) data.push(HEX.charCodeAt((b >> 4) & 15), HEX.charCodeAt(b & 15));
  const n = data.length - 10;
  return [0xf0, YAMAHA, ch & 15, 0x7e, (n >> 7) & 0x7f, n & 0x7f, ...data, checksum(data), 0xf7];
}
/** {channel, header, body} of a TX802 performance message ("LM  8952PE" / "PM"), or null. */
export function parseTx802(raw) {
  if (!raw || raw.length < 20 || raw[0] !== 0xf0 || raw[1] !== YAMAHA || (raw[2] & 0xf0) || raw[3] !== 0x7e || raw[raw.length - 1] !== 0xf7) return null;
  const data = Array.from(raw.slice(6, raw.length - 2));
  const header = String.fromCharCode(...data.slice(0, 10));
  if (header !== PE && header !== PM) return null;
  const count = ((raw[4] & 0x7f) << 7) | (raw[5] & 0x7f);
  const hex = data.slice(10);
  if (hex.length !== count || count & 1 || checksum(data) !== raw[raw.length - 2]) return null;
  const body = new Uint8Array(count / 2);
  for (let i = 0; i < body.length; i++) {
    const hi = HEX.indexOf(String.fromCharCode(hex[2 * i]));
    const lo = HEX.indexOf(String.fromCharCode(hex[2 * i + 1]));
    if (hi < 0 || lo < 0) return null;
    body[i] = (hi << 4) | lo;
  }
  if (body.length !== (header === PE ? PCED_SIZE : PMEM_SIZE)) return null;
  return { channel: raw[2] & 15, header, body };
}
const isPe = (raw) => parseTx802(raw)?.header === PE;
const isPm = (raw) => parseTx802(raw)?.header === PM;
const isSys = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === SYS); };
const isTx802 = (raw) => !!parseTx802(raw) || isSys(raw);

/** Parameter change: pp = byte number; voice and micro tuning send two data bytes. */
export function perfParam(ch, pp, v) {
  const two = (pp >= 0x10 && pp < 0x18) || (pp >= 0x58 && pp < 0x60);
  return [0xf0, YAMAHA, 0x10 | (ch & 15), 0x1a, pp & 0x7f, ...(two ? [(v >> 7) & 1, v & 0x7f] : [v & 0x7f]), 0xf7];
}
/** {channel, pp, value} of a performance parameter change (7 or 8 bytes), or null. */
export function parsePerfParam(raw) {
  if (!raw || raw[0] !== 0xf0 || raw[1] !== YAMAHA || (raw[2] & 0xf0) !== 0x10 || raw[3] !== 0x1a || raw[raw.length - 1] !== 0xf7) return null;
  if (raw.length === 7) return { channel: raw[2] & 15, pp: raw[4], value: raw[5] };
  if (raw.length === 8) return { channel: raw[2] & 15, pp: raw[4], value: ((raw[5] & 1) << 7) | raw[6] };
  return null;
}

// ------------------------------------------------------------------ PMEM packing (pack C84F, unpack C921)
//  0-7   TG link << 5 | receive channel      8-15  voice          16-23 micro tuning   24-31 volume
//  32-39 detune << 3 | alternate assign << 2 | output assign     40-47 note limit low 48-55 note limit high
//  56-63 EG forced damp << 6 | note shift    64-83 name
export function packPerf(d) {
  const p = new Uint8Array(PMEM_SIZE);
  for (let t = 0; t < 8; t++) {
    p[t] = ((d[t] & 7) << 5) | (d[8 + t] & 31);
    p[8 + t] = d[16 + t];
    p[16 + t] = d[88 + t];
    p[24 + t] = d[32 + t] & 0x7f;
    p[32 + t] = ((d[24 + t] & 15) << 3) | ((d[80 + t] & 1) << 2) | (d[40 + t] & 3);
    p[40 + t] = d[48 + t];
    p[48 + t] = d[56 + t];
    p[56 + t] = ((d[72 + t] & 1) << 6) | (d[64 + t] & 0x3f);
  }
  p.set(d.subarray(96, 116), 64);
  return p;
}
export function unpackPerf(p) {
  const d = new Uint8Array(PCED_SIZE);
  for (let t = 0; t < 8; t++) {
    d[t] = p[t] >> 5;
    d[8 + t] = p[t] & 31;
    d[16 + t] = p[8 + t];
    d[88 + t] = p[16 + t];
    d[32 + t] = p[24 + t] & 0x7f;
    d[24 + t] = (p[32 + t] >> 3) & 15;
    d[80 + t] = (p[32 + t] >> 2) & 1;
    d[40 + t] = p[32 + t] & 3;
    d[48 + t] = p[40 + t];
    d[56 + t] = p[48 + t];
    d[72 + t] = (p[56 + t] >> 6) & 1;
    d[64 + t] = p[56 + t] & 0x3f;
  }
  d.set(p.subarray(64, 84), 96);
  return d;
}

/** The TX802's own rule for the TG links (8DED): each TG starts a group (its own number) or joins the group before it. */
export function normaliseLinks(d) {
  let head = 0;
  for (let t = 0; t < 8; t++) {
    if (d[t] === head) continue;
    if (d[t] === t) head = t;
    else d[t] = head;
  }
  return d;
}
const headOf = (d, t) => { let h = t; while (h > 0 && d[h] !== h) h--; return h; };

// ------------------------------------------------------------------ parameters
const MAX = [7, 16, 255, 14, 99, 3, 127, 127, 48, 1, 1, 254]; // 8F6E (byte 0-7: a TG number)
const INIT = [0, 0, 0, 7, 90, 3, 0, 127, 24, 0, 0, 0]; // data ROM 0E00, the same for every TG
const opts = (l) => l.map((t, i) => [i, t]);
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']; // data ROM 2400
const noteOpts = Array.from({ length: 128 }, (_, n) => [n, `${NOTES[n % 12]}${Math.floor(n / 12) - 2}`]);
const BANKS = 'ICAB'; // FECF: voice number bits 7-6
const voiceOpts = Array.from({ length: 256 }, (_, n) => [n, `${BANKS[n >> 6]}${String((n & 63) + 1).padStart(2, '0')}`]);
// Micro tuning (EA6E-EB40): high nibble = table (names: data ROM 1F00), low nibble = key for the pure,
// mean tone and Pythagorean tables (major key names 1090, minor 10A8); B0-B1 the two internal tables,
// C0-FE the cartridge's.
const MT = ['Equal tmpr', 'Pure/major', 'Pure/minor', 'Mean tone', 'Pythagorean', 'Werckmeistr', 'Kirnberger', 'Vallotti&Y', '1/4 shift', '1/4 tone', '1/8 tone'];
const KEY_MAJ = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const KEY_MIN = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
export const MICRO_OPTS = [
  ...MT.flatMap((name, t) => ([1, 2, 3, 4].includes(t) ? (t === 2 ? KEY_MIN : KEY_MAJ).map((k, i) => [t * 16 + i, `${name} ${k}`]) : [[t * 16, name]])),
  [0xb0, 'Internal 1'], [0xb1, 'Internal 2'],
  ...Array.from({ length: 63 }, (_, i) => [0xc0 + i, `Cartridge ${i + 1}`]),
];

function pcedParams() {
  const ps = [];
  for (let t = 0; t < 8; t++) {
    const P = (n, label, extra = {}) => ps.push({ key: `t${t}_${n}`, label, offset: n * 8 + t, min: 0, max: MAX[n], group: `TG${t + 1}`, section: `tg${t}`, ...extra });
    P(0, 'Link', {
      relayout: true,
      set: (d, v) => { d[t] = v; normaliseLinks(d); },
      dynamic: (d) => ({ options: t === 0 ? [[0, 'starts a group (TG1)']] : [[t, `starts a group (TG${t + 1})`], [headOf(d, t - 1), `joins TG${headOf(d, t - 1) + 1}`]] }),
      help: 'A TG that starts a group plays its own voice with its own settings; each TG after it that joins its group adds two notes to it (the voice, channel and settings are the first TG\'s). The play screen shows the voice of each group\'s first TG only.',
    });
    P(1, 'Receive channel', { options: Array.from({ length: 17 }, (_, c) => [c, c < 16 ? String(c + 1) : 'omni']), help: 'PERF.EDIT1: the MIDI channel the group plays on (omni: all).' });
    P(2, 'Voice', { options: voiceOpts, help: 'I01-I64 internal, C01-C64 cartridge, A01-A64 and B01-B64 the preset banks in ROM.' });
    P(3, 'Detune', { format: (v) => `${v > 7 ? '+' : ''}${v - 7}`, help: 'PERF.EDIT7 Performance detune: -7 to +7.' });
    P(4, 'Volume', { help: 'The vol page: output volume 0-99.' });
    P(5, 'Output assign', { options: opts(['off', 'I', 'II', 'I+II']), help: 'PERF.EDIT3: outputs I, II or both.' });
    P(6, 'Note limit low', { options: noteOpts, dynamic: (d) => ({ readOnly: !!d[80 + t] }), help: 'PERF.EDIT4 (shows "alt", and takes no change, while the TG plays in alternate assign).' });
    P(7, 'Note limit high', { options: noteOpts, dynamic: (d) => ({ readOnly: !!d[80 + t] }), help: 'PERF.EDIT4 (shows "alt", and takes no change, while the TG plays in alternate assign).' });
    P(8, 'Note shift', { format: (v) => `${v > 24 ? '+' : ''}${v - 24}`, help: 'PERF.EDIT5 Midi note shift: -24 to +24 semitones.' });
    P(9, 'EG forced damp', { options: opts(['off', 'on']), help: 'PERF.EDIT1 EG forced damp.' });
    P(10, 'Alternate assign', { options: opts(['off', 'on']), relayout: true, help: 'PERF.EDIT1 "Altr asgn" (marked on the receive channel and play screens): notes alternate between the groups on the same channel; their note limits do not apply.' });
    P(11, 'Micro tuning', { options: MICRO_OPTS, help: 'PERF.EDIT6: the preset tables (pure, mean tone and Pythagorean with their key), the two internal tables or one of the cartridge\'s.' });
  }
  for (let i = 0; i < 20; i++) ps.push({ key: `name${i}`, label: `Name ${i + 1}`, offset: 96 + i, min: 32, max: 127, hidden: true });
  return ps;
}
export function initPerf() {
  const d = new Uint8Array(PCED_SIZE);
  INIT.forEach((v, n) => d.fill(v, n * 8, n * 8 + 8));
  d.set([...'Init perf           '].map((c) => c.charCodeAt(0)), 96);
  return d;
}
const perfName = (d) => textAt(d, 96, 20);
function setPerfName(d, name) { for (let i = 0; i < 20; i++) d[96 + i] = Math.max(32, Math.min(126, String(name ?? '').charCodeAt(i) || 32)); return d; }

// ------------------------------------------------------------------ Head Library
function perfToCommon(d) {
  const parts = [];
  for (let t = 0; t < 8; t++) {
    if (d[t] !== t) continue;
    parts.push({ on: true, channel: d[8 + t] < 16 ? d[8 + t] : 0, program: d[16 + t], level: d[32 + t] / 99, transpose: d[64 + t] - 24, fine: (d[24 + t] - 7) * 2, low: d[48 + t], high: d[56 + t], output: ['off', 'I', 'II', 'I+II'][d[40 + t]] });
  }
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'multi', parts,
    extra: { family: 'yamaha-dx', model: 'TX802', pced802: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d.subarray(0, 96))) },
  };
}
function perfFromCommon(c) {
  const report = emptyReport();
  const d = initPerf();
  if (c?.extra?.pced802 && fromBase64(c.extra.pced802).length === PCED_SIZE) {
    d.set(fromBase64(c.extra.pced802));
    report.mapped.push('the whole performance (TX802)');
    return { data: d, report };
  }
  const parts = (c?.parts || []).filter((p) => p.on !== false).slice(0, 8);
  if (!parts.length) return { data: d, report };
  // Share the eight TGs out: each part gets a group (the first parts one TG more when they do not divide).
  const each = Math.floor(8 / parts.length);
  let extra = 8 - each * parts.length;
  let t = 0;
  parts.forEach((p) => {
    const n = each + (extra-- > 0 ? 1 : 0);
    const head = t;
    const v = [head, Math.max(0, Math.min(15, p.channel ?? 0)), Number.isInteger(p.program) ? Math.max(0, Math.min(255, p.program)) : 0,
      Math.max(0, Math.min(14, 7 + Math.round((p.fine || 0) / 2))), Math.round(99 * Math.max(0, Math.min(1, p.level ?? 1))), 3,
      Math.max(0, Math.min(127, p.low ?? 0)), Math.max(0, Math.min(127, p.high ?? 127)), Math.max(0, Math.min(48, 24 + Math.round(p.transpose || 0))), 0, 0, 0];
    for (let k = 0; k < n; k++, t++) v.forEach((x, m) => { d[m * 8 + t] = x; });
  });
  report.mapped.push('parts: voice number, channel, key range, volume, note shift');
  report.approximated.push('the eight TGs shared out between the parts (two notes each)', 'detune: 2 cents a step assumed');
  if ((c?.parts || []).filter((p) => p.on !== false).length > 8) report.dropped.push('parts after the eighth');
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ system setup ("LM  8952S ", 263 bytes)
// RAM 565Dh (memory protect, 565Ch, is not in it); receiver 9FD6, sender AA58; SYSTEM pages E1FD (display)
// and BDCA (data entry: byte index tables BE0C, BEA8, BEB8, BF42 into the maxima 8F8B); INIT DBC2, the
// control number table 8E06 (the eight functions on their own numbers, BE98), the program table 8E27.
// Parameter changes: only 19h 4Dh (receive block, A779) and 04h 40h (master tuning, A4FB); any other
// change sends the whole setup (memory protect must be off, A0B6).
export const SYS_SIZE = 263;
const SYS_MAX = [17, 17, 1, 17, 17, 17, 2, 1, 15, 15, 15, 127, 17]; // 8F8B (after memory protect)
const SYS_INIT = [1, 17, 0, 1, 1, 1, 0, 0, 0, 0, 0, 64, 1]; // DBC3
const CTRL_FN = [0, 1, 2, 4, 5, 7, 64, 65]; // BE98
const CTRL_NAMES = ['off', 'Mod. wheel', 'Breath control', 'Foot control', 'Portamento time', 'Volume', 'Sustain switch', 'Portamento sw']; // data ROM 1000h
const RX_OPTS = [[0, 'off'], [1, 'norm'], ...Array.from({ length: 16 }, (_, i) => [i + 2, `G${i + 1}`])]; // E25D-E298
const CH_OPTS = [[0, 'off'], ...Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1)]), [17, 'all']]; // FB1C
export function initSystem() {
  const d = new Uint8Array(SYS_SIZE);
  d.set(SYS_INIT);
  for (let c = 0; c < 122; c++) d[13 + c] = CTRL_FN.includes(c) ? c : 0;
  for (let p = 0; p < 128; p++) d[135 + p] = p;
  return d;
}
function sysParams() {
  const ps = [];
  const P = (o, label, group, extra = {}) => ps.push({ key: `s${o}`, label, offset: o, min: 0, max: SYS_MAX[o] ?? 127, group, ...extra });
  P(3, 'Program change', 'Midi message receive switch', { options: RX_OPTS, help: 'SYSTEM1: off, norm, or G1-G16 as the TX802 shows them.' });
  P(4, 'After touch', 'Midi message receive switch', { options: RX_OPTS });
  P(5, 'Pitch bend', 'Midi message receive switch', { options: RX_OPTS });
  P(12, 'Control change', 'Midi message receive switch', { options: RX_OPTS });
  P(6, 'Note on/off', 'Midi message receive switch', { options: opts(['all', 'odd', 'even']) });
  P(1, 'System exclusive device number', 'System exclusive', { options: CH_OPTS, help: 'SYSTEM4: off, 1-16 or all; the editor needs it on its channel (or all).' });
  P(2, 'Voice data receive block', 'System exclusive', { options: opts(['1-32', '33-64']), help: 'SYSTEM4: where a received 32-voice bulk goes, and which 32 a voice bulk request answers with (565Fh: receiver 9F94, request ABF3); also parameter change 19h 4Dh. The Voices slot list switches it for I33-I64 and back.' });
  P(0, 'Perform select channel', 'Performance select', { options: CH_OPTS, help: 'SYSTEM3: the channel whose program changes select a performance (off, 1-16, all).' });
  P(7, 'Perform select assign table', 'Performance select', { options: opts(['off', 'on']), help: 'SYSTEM3: on = a program change selects the performance the table below assigns to it.' });
  P(8, 'TX802 bank', 'Cartridge bank select', { format: (v) => String(v + 1) });
  P(9, 'Frac.scaling bank', 'Cartridge bank select', { format: (v) => String(v + 1) });
  P(10, 'M.tuning bank', 'Cartridge bank select', { format: (v) => String(v + 1) });
  P(11, 'Master tuning', 'Master tuning', { format: (v) => `${v >= 64 ? '+' : '-'}${Math.abs(v - 64)}`, help: 'SYSTEM7 (E4AE): 64 = centre; sent as F0 43 1n 04 40 vv F7.' });
  for (let c = 0; c < 122; c++) P(13 + c, `Control ${c}`, 'Control number assign', { max: 127, options: CTRL_FN.map((f, i) => [f, CTRL_NAMES[i]]), help: 'SYSTEM2: what this control number does (each function stored as its own usual number).' });
  for (let p = 0; p < 128; p++) P(135 + p, `Program ${p + 1}`, 'Perform select number assign', { max: 127, options: Array.from({ length: 128 }, (_, n) => [n, `${n < 64 ? 'INT' : 'CRT'}${String((n & 63) + 1).padStart(2, '0')}`]), help: 'SYSTEM3: the performance this program change selects (with the assign table on).' });
  return ps;
}
const isSysData = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === SYS && b.body.length === SYS_SIZE); };
function systemObject(ch) {
  return {
    key: 'system', page: 'System', icon: '⚙', label: 'System setup', size: SYS_SIZE,
    init: initSystem, params: sysParams(), cols: 3,
    request: (ctx) => dumpRequestHeader(ch(ctx), SYS),
    match: isSysData,
    decode: (raw) => Uint8Array.from(parseBulk(raw).body),
    note: 'The SYSTEM SETUP MENU pages (midi, ctrl, pfrm, syex, bank, mtun). The TX802 takes parameter changes only for the receive block and the master tuning: any other change sends the whole setup (internal memory protect off).',
    sendParam: (p, _v, d, ctx) => {
      if (p.offset === 2) return [0xf0, YAMAHA, 0x10 | ch(ctx), 0x19, 0x4d, d[2], 0xf7];
      if (p.offset === 11) return [0xf0, YAMAHA, 0x10 | ch(ctx), 0x04, 0x40, d[11], 0xf7];
      return bulkHeader(ch(ctx), SYS, d);
    },
    sendAll: { label: 'Send', title: 'Send the system setup ("LM  8952S ")', build: (d, ctx) => bulkHeader(ch(ctx), SYS, d) },
    toSyx: (d, ctx) => bulkHeader(ch(ctx), SYS, d),
    fromSyx: (msgs) => { const m = msgs.find(isSysData); return m ? Uint8Array.from(parseBulk(m).body) : null; },
    receive: (raw, d) => (isSysData(raw) ? Uint8Array.from(parseBulk(raw).body) : null),
    actions: [
      { label: 'Init', title: 'The TX802\'s initial setup (DBC2, with UTIL6\'s control number and program change tables; not sent until you press Send)', run: (api) => api.setData(initSystem()) },
    ],
  };
}

// ------------------------------------------------------------------ voices in the slot list
// 64 internal voices (VMEM at 6000h and 7000h of the voice RAM page, 32 each). A 32-voice bulk the TX802
// takes goes into the block system byte 2 "Voice data receive block" (565Fh; 19h 4Dh) names (receiver
// 9F94: + 10h to the page), and the bulk and AMEM it sends on request come from the same block (request
// handler ABF3 copies 565Fh into RAM FBh; senders A9AB 6000h / 7000h, AMEM A974 39E6h / 3D26h); UTIL1
// "Transmit 1-32 voice data" / "Transmit 33-64 voice data" set FBh themselves (A81C).
// Program change (J99E6): on the Perform select channel (system byte 0) it selects a performance; otherwise,
// with the Program change receive switch (byte 3) at norm, it reaches every TG that starts a group on that
// channel (map 3888h per channel, built by CCCA; omni TGs on every channel), with "G n" every group on
// channel n (mask 5987h); each such TG keeps the bank of its voice (I, C, A, B: bits 7-6 of the
// performance's voice byte) and takes voice (program & 3Fh) + 1 of it (9A42): 0-63 select 1-64, 64-127
// the same again. Play here therefore sets the voice through the performance (1Ah 10h + TG, exact bank),
// and Edit / Read names select the voice in a TG and read that TG's voice edit buffer (a voice parameter
// change makes its TG the one being edited, A6F4; the voice requests answer that TG, A93C / A915 via D614).
const TX_BANKS = [[0, 'INTERNAL I01-I32'], [1, 'INTERNAL I33-I64'], [2, 'CARTRIDGE C01-C64'], [3, 'PRESET A01-A64'], [4, 'PRESET B01-B64']];
/** The performance voice byte of slot i of bank b (bits 7-6: I, C, A, B). */
export const tx802VoiceByte = (b, i) => (b < 2 ? 32 * b + i : ((b - 1) << 6) | i);
const perfOf = (ctx) => (ctx?.loaded?.has?.('performance') ? ctx.data?.performance : null);
/** The TGs a program change on channel c reaches (heads of groups on c or omni); [] without the performance. */
export function tgsOnChannel(perf, c) {
  if (!perf) return [];
  return Array.from({ length: 8 }, (_, t) => t).filter((t) => perf[t] === t && (perf[8 + t] === c || perf[8 + t] === 16));
}
function tx802Banks(ch) {
  const sysOf = (ctx) => (ctx?.loaded?.has?.('system') ? ctx.data?.system : null);
  const setBlock = (c, v) => [0xf0, YAMAHA, 0x10 | (c & 15), 0x19, 0x4d, v & 1, 0xf7];
  const pad2 = (n) => String(n).padStart(2, '0');
  return {
    banks: TX_BANKS,
    internal: (b) => b < 2,
    count: (b) => (b < 2 ? 32 : 64),
    program: (b, i) => (b < 2 ? 32 * b + i : i),
    slotOf: (n) => [(n & 63) >> 5, n & 31],
    slotLabel: (b, i) => (b < 2 ? `I${pad2(32 * b + i + 1)}` : `${'CAB'[b - 2]}${pad2(i + 1)}`),
    read: async (api, b, go) => {
      const c = ch(api.ctx);
      const sys = Uint8Array.from(parseBulk(await api.request(dumpRequestHeader(c, SYS), isSysData, (r) => r)).body);
      if (api.g?.setObjectData) api.g.setObjectData('system', sys);
      const was = sys[2] ? 1 : 0;
      if (was !== b) api.send(setBlock(c, b));
      try { return await go(); } finally { if (was !== b) api.send(setBlock(c, was)); }
    },
    storeMsgs: (ctx, b, msgs) => {
      const was = sysOf(ctx)?.[2] ? 1 : 0;
      return was === b ? msgs : [setBlock(ch(ctx), b), ...msgs, setBlock(ch(ctx), was)];
    },
    storeNote: '(the Voice data receive block switched to this block for it, then back)',
    outBank: (ctx) => (sysOf(ctx)?.[2] ? 1 : 0),
    simOut: (unit) => (unit.sys802?.[2] ? 1 : 0),
    simIn: (unit) => (unit.sys802?.[2] ? 1 : 0),
    recall: (ctx, b, i) => {
      const tgs = tgsOnChannel(perfOf(ctx), ch(ctx));
      return tgs.length ? tgs.map((t) => perfParam(ch(ctx), 0x10 + t, tx802VoiceByte(b, i))) : [0xc0 | ch(ctx), b < 2 ? 32 * b + i : i];
    },
    playNote: (b, ctx) => {
      const tgs = tgsOnChannel(perfOf(ctx), ch(ctx));
      return tgs.length ? `Play sets the voice of ${tgs.map((t) => `TG${t + 1}`).join(', ')} (the groups on the editor's channel) through the performance.`
        : `Play sends a program change (${b < 2 ? `${32 * b + 1}-${32 * b + 32}` : '1-64'}): each TG on the channel takes that voice number in the bank its voice is in${b < 2 ? '' : ` (Get the performance to set ${TX_BANKS[b][1].split(' ')[0].toLowerCase()} voices exactly)`}.`;
    },
    notes: Object.fromEntries([2, 3, 4].map((b) => [b, `Edit and Read names set the voice of TG1 (with the performance read: the first group on the editor's channel) and read it back, so that TG's voice in the performance edit buffer is replaced.${b === 2 ? ' With no cartridge in, the TX802 keeps the voice it had.' : ' The two preset banks are in the data ROM.'} No bulk carries them: Store is not offered.`])),
  };
}
/** Edit in the slot list: put the voice into a TG (performance voice parameter), then read that TG's voice. */
async function tx802SelectFetch(api, _program, { ch: c, full, isAced, bank, slot }) {
  const tgs = tgsOnChannel(perfOf(api.ctx), c(api.ctx));
  const t = tgs[0] ?? 0;
  api.send(perfParam(c(api.ctx), 0x10 + t, tx802VoiceByte(bank, slot)));
  await new Promise((r) => setTimeout(r, 250));
  const ac = await api.request(dumpRequest(c(api.ctx), 5), isAced, (r) => r);
  const vc = await api.request(dumpRequest(c(api.ctx), 0), (r) => { const b = parseBulk(r); return !!(b?.ok && b.format === 0 && b.data.length === VCED_SIZE); }, (r) => r);
  return full(parseBulk(vc).data, parseBulk(ac).data);
}

// ------------------------------------------------------------------ definition
const def = buildDX7II({
  id: 'yamaha-tx802',
  name: 'TX802',
  noPerformance: true,
  noSystemRequest: true,
  acedLow: true, // keeps ACED bytes 0-38 only, numbered as bytes
  // AMEM: the DX7II's format 6 (32 x 35 bytes): the TX802 sends each voice's 26 bytes of RAM 39E6 / 3D26
  // and nine zeros (A974), keeps bytes 1-26 of each 35 when receiving (9F40, A195), answers its request
  // (AC0B) and sends it before the voices (A961), as the DX7II does.
  recognise: isTx802,
  voiceBanks: tx802Banks,
  selectFetch: tx802SelectFetch,
  deviceIds: ['yamaha-dx7ii', 'yamaha-dx7s'],
  requests: [
    { label: 'Performance edit buffer', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, PE) },
    { label: '64 performances', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, PM), timeout: 8000 },
    { label: 'System setup', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, SYS) },
  ],
  voice: tx802Voice,
  libraryItem: (m, k, msgs) => {
    const t = parseTx802(m);
    if (t?.header === PE) return [{ key: `p${k}`, label: `Performance "${perfName(t.body)}"`, name: perfName(t.body), object: 'performance', data: Uint8Array.from(t.body), msgs: [m] }];
    if (t?.header === PM) {
      const n = (msgs || []).slice(0, k).filter(isPm).length;
      const d = unpackPerf(t.body);
      return [{ key: `pm${k}`, label: `${String(n + 1).padStart(2, '0')} ${perfName(d)}`, name: perfName(d), object: 'performance', data: d, msgs: [Uint8Array.from(tx802Bulk(t.channel, PE, d))] }];
    }
    if (isSysData(m)) return [{ key: `s${k}`, label: 'System setup', name: '', object: 'system', data: Uint8Array.from(parseBulk(m).body), msgs: [m] }];
    if (isSys(m)) return [{ key: `s${k}`, label: 'System setup (kept as it is)', name: '', msgs: [m] }];
    if (isMtOrFks(m)) return D2.dataItems(m, k, msgs);
    return null;
  },
  simulateRequest: (unit, d, hdr) => {
    if (hdr === PE) return [tx802Bulk(d[2] & 15, PE, unit.perf802 ||= initPerf())];
    if (hdr === SYS) return [bulkHeader(d[2] & 15, SYS, unit.sys802 ||= initSystem())];
    if (hdr === PM) return Array.from({ length: 64 }, () => tx802Bulk(d[2] & 15, PM, packPerf(unit.perf802 ||= initPerf())));
    if (/^LM {2}(MCRY|FKSY)/.test(hdr)) return D2.simulateRequest(unit, d, hdr) || [];
    return [];
  },
  simulateBulk: (unit, _b, d) => {
    if (isSysData(d)) unit.sys802 = Uint8Array.from(parseBulk(d).body);
    const t = parseTx802(d);
    if (t?.header === PE) unit.perf802 = Uint8Array.from(t.body);
    const pc = parsePerfParam(d);
    if (pc && pc.pp < PCED_SIZE) applyPerfParam(unit.perf802 ||= initPerf(), pc.pp, pc.value);
    if (isMtOrFks(d) || d[3] === 0x18) D2.simulateBulk(unit, d);
    return [];
  },
  simulateParam: (unit, pc, d) => {
    if (d[3] === 0x19 && d[4] === 0x4d) (unit.sys802 ||= initSystem())[2] = pc.value & 1; // F0 43 1n 19 4D vv F7: receive block (A779)
    const p = parsePerfParam(d);
    if (p && p.pp < PCED_SIZE) applyPerfParam(unit.perf802 ||= initPerf(), p.pp, p.value);
  },
  extend(def2, { ch }) {
    const base = def2.describe;
    def2.describe = (raw) => {
      const t = parseTx802(raw);
      if (t) return `TX802 ${t.header === PE ? 'performance edit buffer' : 'performance memory'} ch ${t.channel + 1} "${perfName(t.header === PE ? t.body : unpackPerf(t.body))}"`;
      const pc = parsePerfParam(raw);
      if (pc) return `TX802 performance parameter ch ${pc.channel + 1}: ${pc.pp < 96 ? `TG${(pc.pp & 7) + 1} parameter ${pc.pp >> 3}` : `name ${pc.pp - 95}`} = ${pc.value}`;
      return base(raw);
    };
    def2.objects.push({
      key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: PCED_SIZE,
      init: initPerf, params: pcedParams(), cols: 3,
      sections: Array.from({ length: 8 }, (_, t) => ({ key: `tg${t}`, label: `TG${t + 1}` })),
      request: (ctx) => dumpRequestHeader(ch(ctx), PE),
      match: isPe,
      decode: (raw) => Uint8Array.from(parseTx802(raw).body),
      name: perfName,
      setName: setPerfName,
      note: 'Eight tone generators of two notes each. A TG that starts a group plays its voice on its receive channel; the TGs that join it add notes. Changes are parameter changes (1Ah, number = byte; a link change starts or ends a group).',
      sendParam: (p, _v, d, c2) => perfParam(ch(c2), p.offset, p.offset < 8 ? 0 : d[p.offset]),
      sendAll: { label: 'Send', title: 'Send the performance edit buffer ("LM  8952PE")', build: (d, c2) => tx802Bulk(ch(c2), PE, d) },
      toSyx: (d, c2) => tx802Bulk(ch(c2), PE, d),
      fromSyx: (msgs) => {
        const m = msgs.find(isPe);
        if (m) return Uint8Array.from(parseTx802(m).body);
        const pm = msgs.find(isPm);
        return pm ? unpackPerf(parseTx802(pm).body) : null;
      },
      receive: (raw, d, ctx) => {
        if (isPe(raw)) return Uint8Array.from(parseTx802(raw).body);
        const pc = parsePerfParam(raw);
        if (pc && pc.channel === ch(ctx) && pc.pp < PCED_SIZE) return applyPerfParam(Uint8Array.from(d), pc.pp, pc.value);
        return null;
      },
      actions: [
        { label: 'Init', title: 'The TX802\'s Initialize perf. edit buffer (not sent until you change something or press Send)', run: (api) => api.setData(initPerf()) },
        {
          label: 'Rename', run: async (api) => {
            const r = await api.form('Performance name', [{ key: 'name', label: 'Name (20 characters)', value: perfName(api.data), maxlength: 20 }]);
            if (!r) return;
            const d = setPerfName(Uint8Array.from(api.data), r.name);
            api.send(Array.from({ length: 20 }, (_, i) => perfParam(ch(api.ctx), 96 + i, d[96 + i])));
            api.setData(d);
          },
        },
      ],
      multi: {
        page: 'MIDI channels', label: 'Tone generators', count: 8, section: (t) => `tg${t}`, partLabel: (t) => `TG${t + 1}`,
        columns: [
          { label: 'Link', params: ['Link'] },
          { label: 'Voice', params: ['Voice'], role: 'patch' },
          { label: 'MIDI channel', params: ['Receive channel'], role: 'channel' },
          { label: 'Volume', params: ['Volume'] },
          { label: 'Note limits', params: ['Note limit low', 'Note limit high'] },
          { label: 'Note shift', params: ['Note shift'] },
          { label: 'Out', params: ['Output assign'] },
        ],
        on: (t, d) => d[t] === t,
        channels: Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]),
        note: 'A TG plays its own voice when it starts a group (Link); the TGs that join a group add two notes each and use the first TG\'s voice and channel.',
      },
      toCommon: perfToCommon,
      fromCommon: (c) => perfFromCommon(c),
    });
    def2.objects.push(systemObject(ch));
    def2.objects.push(tgObject(D2.microTuningObject({ name: 'TX802' }, ch), ch, 'micro tuning (RAM 3000h + TG x 100h: the bulk sender AB04, receiver A039 and the 18h 7Eh key change A7AB all use the TG being edited)'));
    def2.objects.push(tgObject(D2.fractionalObject({ name: 'TX802' }, ch), ch, 'fractional scaling (the voice of the TG being edited: sender A8E2 from its voice buffer 2000h + TG x 200h)'));
  },
  coverage: 'The DX7II voice editor (VCED + ACED, the TX802\'s voice format) with its 64 internal voices in the slot list (two 32-voice blocks through the Voice data receive block) and the cartridge and preset banks (selected in a TG and read back), the Branch Library, and the TX802\'s own eight-TG performance (TG link, receive channel, voice, detune, volume, output, note limits, note shift, EG forced damp, alternate assign, micro tuning, name) with its MIDI channels page, mapped from the v1.5 firmware and its data ROM\'s screens; the 64 performance memories are read by the Branch Library (unpacked). The system setup is kept as data. Not yet checked on a TX802.',
});

/**
 * The TX802's voice pages (data ROM texts 70-96; VOICE EDIT(II) MENU "mode bend rpch prta wheel foot brth
 * aftr") use the DX7II's words, but the TX802 keeps only ACED bytes 0-38: it sends the other ten as 0
 * (A915) and stores only the first 39 it receives (A12E); its maxima (data ROM 0D34) give the pitch bend
 * mode 0, and the key mode page shows poly / mono from bit 0 (F2B3).
 */
function tx802Voice(v) {
  const NOT_USED = 'Not used by the TX802: it sends 0 here and ignores what it receives (kept for DX7II voices).';
  for (const p of v.params) {
    if (p.aced >= 39) Object.assign(p, { readOnly: true, help: NOT_USED });
    if (p.aced === 18) Object.assign(p, { readOnly: true, help: 'The TX802 has no pitch bend mode (its maximum is 0); kept for DX7II voices.' });
    if (p.aced === 15) Object.assign(p, { options: [[0, 'poly'], [1, 'mono'], [2, 'poly (DX7II unison poly)'], [3, 'mono (DX7II unison mono)']], help: 'Key mode: the TX802 plays poly or mono (bit 0); the DX7II\'s unison modes read as their poly / mono.' });
  }
  const ctl = v.layout.find((l) => l.group === 'Controllers');
  if (ctl) ctl.rows = ctl.rows.filter((r) => !/Foot control 2|MIDI IN control/.test(r.label));
}

const isMtOrFks = (raw) => { const b = parseBulk(raw); return !!(b?.ok && /^LM {2}MCRY[EMC]/.test(b.header || '') && b.body.length === D2.MT_SIZE) || !!D2.parseFks(raw); };
const tg = { n: 0 }; // the TG the micro tuning / fractional scaling pages address
/**
 * The TX802 keeps micro tuning and fractional scaling per TG and applies dumps, requests and changes to
 * the TG being edited (RAM 596Bh), which any performance parameter change for a TG selects (A6F4). With
 * the performance read from the TX802, the pages select their TG by re-sending its receive channel (an
 * unchanged value); without it they address whichever TG the TX802 is editing.
 */
function tgObject(o, ch, what) {
  const select = (ctx) => {
    const p = ctx?.data?.performance;
    return p && ctx.loaded?.has?.('performance') ? perfParam(ch(ctx), 8 + tg.n, p[8 + tg.n]) : null;
  };
  const withSelect = (ctx, m) => { const s = select(ctx); if (!s) return m; return [s, ...(Array.isArray(m[0]) ? m : [m])]; };
  return {
    ...o,
    target: { label: 'TG', title: 'The tone generator whose data these pages read and change', options: () => Array.from({ length: 8 }, (_, t) => [t, `TG${t + 1}`]), value: () => tg.n, set: (v) => { tg.n = Number(v) & 7; } },
    note: `${o.note} The TX802 keeps one per TG: this is the ${what}. With the performance read from the TX802, the TG chosen above is selected first (its receive channel is sent again unchanged); otherwise the TX802's own edited TG is used.`,
    fetch: async (api) => {
      const s = select(api.ctx);
      if (s) api.send(s);
      const raw = await api.request(o.request(api.ctx), o.match, (r) => r);
      return o.decode(raw);
    },
    sendParam: (p, v, d, ctx) => withSelect(ctx, o.sendParam(p, v, d, ctx)),
    sendAll: { ...o.sendAll, build: (d, ctx) => withSelect(ctx, o.sendAll.build(d, ctx)) },
  };
}

/** Apply a performance parameter change the way the TX802 does (a link change toggles the group start). */
function applyPerfParam(d, pp, v) {
  if (pp < 8) { d[pp] = d[pp] === pp ? 0 : pp; return normaliseLinks(d); }
  d[pp] = v;
  return d;
}

export const _test = { initSystem, pcedParams, initPerf, parseTx802, tx802Bulk, packPerf, unpackPerf, normaliseLinks, perfParam, parsePerfParam, applyPerfParam, perfToCommon, perfFromCommon, PE, PM };
export default def;
