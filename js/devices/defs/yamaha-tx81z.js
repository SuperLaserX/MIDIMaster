// Yamaha TX81Z: 4-operator voice (VCED + ACED with the eight waves), 32 internal voices, the performance
// (PCED: eight instruments with their own voice, receive channel, key limits...) and its 24 memories
// (PMEM), the system setup, the program change table, the effects and both micro tuning tables.
// From the TX81Z v1.6 firmware (64 KB, two banks; maximum tables at 05F1, INIT VOICE 0088, texts
// 2849-2F77, bulk headers "LM  8976AE/PE/PM/S0-S2", "LM  MCRTE0/1") and Yamaha's TX81Z data format.
// Shared 4-op code: yamaha-dx4.js. See docs/devices/yamaha-tx81z.md. Not yet checked on a TX81Z.
//
// Addresses below are CPU addresses (8000-FFFF) of the lower bank (file 0000-7FFF: screens, packing)
// or the upper bank (file 8000-FFFF: MIDI). RAM: PCED 6DD7, PMEM 6E45 (24 x 76), system 7565-756F and
// 7740-774F, program change table 7571, effects 75F1, micro tuning 7628 (octave) and 7640 (full).
//
//   PMEM record (76 bytes; packing 8509, unpacking 846B of the lower bank), per instrument 8 bytes:
//     0 OUT ASSIGN<<5 | voice bit 7<<4 | MAX NOTES, 1 voice & 7Fh, 2 LFO SELECT<<5 | RECEIVE CH,
//     3 LIMIT/L, 4 LIMIT/H, 5 INST DETUNE, 6 MICROTUNE<<6 | NOTE SHIFT, 7 volume;
//     64 MICTUN, 65 key<<3 | effect<<1 | assign, 66-75 name. The bulk "LM  8976PM" (sender E246) holds
//     32 records: memories 1-24, then eight copies of the SINGLE template (AF13).
//   Parameter changes besides PCED (receiver D8DD, group 10h numbers 7Bh-7Fh, longer messages):
//     F0 43 1n 10 7B pp vv F7     system byte pp (0-26)
//     F0 43 1n 10 7C pp vv F7     effects byte pp (0-54)
//     F0 43 1n 10 7D kk nn ff F7  octave micro tuning key kk (0-11): note, fine
//     F0 43 1n 10 7E kk nn ff F7  full micro tuning key kk (0-127)
//     F0 43 1n 10 7F pp hh ll F7  program change table: PGM pp+1 = hh<<7 | ll

import { buildDX4 } from './yamaha-dx4.js';
import { YAMAHA, bulkHeader, parseBulk, paramChange, dumpRequestHeader } from './yamaha-dx-sysex.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import { textAt } from './yamaha-dx-voice.js';

// TX81Z texts (2849.., 2C09.., 2EB5..)
export const TX81Z_TEXTS = {
  OFFON: ['off', 'on'],
  WAVES: ['saw up', 'square', 'triangl', 'S/Hold'],
  POLYMONO: ['Poly', 'Mono'],
  PORTA: ['Full Time', 'Fingered'],
  FIXMODE: ['RATIO', 'FIX'],
  OSW: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'],
  SHFT: ['off', '48', '24', '12'],
  NOTES: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
  L: {
    ar: 'AR', d1r: 'D1R', d1l: 'D1L', d2r: 'D2R', rr: 'RR', shft: 'SHFT', out: 'OUT', rs: 'RS', ls: 'LS', crs: 'CRS', fin: 'FIN', osw: 'OSW', det: 'DET',
    ame: 'AME', ebs: 'EBS', kvs: 'KVS', fix: 'Frequency', fixrg: 'Fix Range', alg: 'ALG', fbl: 'Feedback(OP4)', lfw: 'Wave', lfs: 'Speed', lfd: 'Delay',
    pmd: 'P Mod Depth', amd: 'A Mod Depth', sy: 'Sync', pms: 'P Mod Sens.', ams: 'AMS', trps: 'Middle C', mo: 'Poly/Mono', pbr: 'P Bend Range',
    pm: 'Portamento mode', port: 'Portamento Time', su: 'Sus', po: 'Por', ch: 'Chorus', fcvol: 'FC Volume', mwp: 'MW Pitch', mwa: 'MW Amplitude',
    bcp: 'BC Pitch', bca: 'BC Amplitude', bcpb: 'BC P. Bias', bceb: 'BC EG Bias', pr: 'P EG Rate', pl: 'P EG Level', rev: 'Reverb Rate', fcp: 'FC Pitch', fca: 'FC Amplitude',
  },
};
// INIT VOICE (packed, 0088)
export const TX81Z_INIT = [
  0x1f, 0x1f, 0x00, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x04, 0x03, 0x1f, 0x1f, 0x00, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x04, 0x03,
  0x1f, 0x1f, 0x00, 0x0f, 0x0f, 0x00, 0x00, 0x00, 0x04, 0x03, 0x1f, 0x1f, 0x00, 0x0f, 0x0f, 0x00, 0x00, 0x5a, 0x04, 0x03,
  0x00, 0x23, 0x00, 0x00, 0x00, 0x62, 0x18, 0x04, 0x04, 0x00, 0x28, 0x32, 0x00, 0x00, 0x00, 0x32, 0x00,
  ...[...'INIT VOICE'].map((c) => c.charCodeAt(0)), ...new Array(61).fill(0),
];
const opts = (l) => l.map((t, i) => [i, t]);
const NOTE = (n) => `${TX81Z_TEXTS.NOTES[n % 12]}${Math.floor(n / 12) - 2}`;
const voiceName = (n) => (n < 32 ? `I${String(n + 1).padStart(2, '0')}` : `${'ABCD'[(n - 32) >> 5]}${String(((n - 32) & 31) + 1).padStart(2, '0')}`);
const signed = (v) => `${v > 0 ? '+' : ''}${v}`;
const isHdr = (raw, hdr, size) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7e && b.header === hdr && b.body.length === size); };
/** Group 10h messages 7Bh-7Fh (system, effects, micro tuning, program change table). */
const longChange = (ch, num, ...bytes) => [0xf0, YAMAHA, 0x10 | (ch & 15), 0x10, num, ...bytes.map((b) => b & 0x7f), 0xf7];
const parseLong = (raw) => (raw?.length >= 8 && raw[0] === 0xf0 && raw[1] === YAMAHA && (raw[2] & 0xf0) === 0x10 && raw[3] === 0x10 && raw[4] >= 0x7b && raw[raw.length - 1] === 0xf7
  ? { channel: raw[2] & 15, num: raw[4], args: Array.from(raw.slice(5, -1)) } : null);

// ------------------------------------------------------------------ performance (PCED, 110 bytes)
export const PCED_SIZE = 110;
const PE = 'LM  8976PE';
const MAXN = [8, 0, 159, 16, 127, 127, 14, 48, 99, 3, 3, 1]; // maximum table after the ACED one (0664)
function pcedParams() {
  const ps = [];
  for (let i = 0; i < 8; i++) {
    const b = i * 12;
    const s = `i${i}`;
    const P = (o, label, extra = {}) => ps.push({ key: `i${i}_${o}`, label, offset: b + o, min: 0, max: MAXN[o], group: `Instrument ${i + 1}`, section: s, ...extra });
    P(0, 'MAX NOTES', { help: 'Notes (voices) the instrument may use; 0 = instrument off. The eight together have 8.' });
    ps.push({
      key: `i${i}_voice`, label: 'Voice', offset: b + 1, size: 2, min: 0, max: 159, group: `Instrument ${i + 1}`, section: s,
      get: (d) => (d[b + 1] << 7) | d[b + 2], set: (d, v) => { d[b + 1] = (v >> 7) & 1; d[b + 2] = v & 0x7f; },
      options: Array.from({ length: 160 }, (_, n) => [n, voiceName(n)]), help: 'I01-I32 internal, A-D the presets (two bytes: 128s, then the rest).',
    });
    P(3, 'RECEIVE CH', { options: Array.from({ length: 17 }, (_, c) => [c, c < 16 ? String(c + 1) : 'omni']) });
    P(4, 'LIMIT/L', { options: Array.from({ length: 128 }, (_, n) => [n, NOTE(n)]) });
    P(5, 'LIMIT/H', { options: Array.from({ length: 128 }, (_, n) => [n, NOTE(n)]) });
    P(6, 'INST DETUNE', { format: (v) => `${v > 7 ? '+' : ''}${v - 7}` });
    P(7, 'NOTE SHIFT', { format: (v) => `${v > 24 ? '+' : ''}${v - 24}` });
    P(8, 'Volume');
    P(9, 'OUT ASSIGN', { options: [[0, 'off'], [1, 'I'], [2, 'II'], [3, 'I+II']] });
    P(10, 'LFO SELECT', { options: [[0, 'off'], [1, 'inst1'], [2, 'inst2'], [3, 'vib']] });
    P(11, 'MICROTUNE', { options: [[0, 'off'], [1, 'on']] });
  }
  const C = (o, label, max, extra = {}) => ps.push({ key: `c${o}`, label, offset: o, min: 0, max, group: 'Performance', section: 'common', ...extra });
  C(96, 'MICTUN', 12, { options: opts(['Equal', 'Pure(major)', 'Pure(minor)', 'Mean tone', 'Pythagorean', 'Werckmeister', 'Kirnberger', 'Vallotti&young', '1/4 Shift eql', '1/4 Tone', '1/8 Tone', 'MICRO OCT.', 'MICRO FULL']), help: 'Micro tuning table (the order of the names in the firmware, 2EB5-2F57, then the octave and full user tables).' });
  C(97, 'Assign', 1, { options: [[0, 'norm'], [1, 'altr']], help: 'Note assign: normal or alternate.' });
  C(98, 'Effect', 3, { options: [[0, 'off'], [1, 'delay'], [2, 'pan'], [3, 'chord']] });
  C(99, 'Micro tune key', 11, { options: opts(TX81Z_TEXTS.NOTES) });
  for (let i = 0; i < 10; i++) C(100 + i, `Name ${i + 1}`, 127, { hidden: true });
  return ps;
}

// ------------------------------------------------------------------ performance memory (PMEM)
export const PMEM_REC = 76;
const PM = 'LM  8976PM';
const PM_SIZE = 32 * PMEM_REC;
export const PBANK_KEY = 'perf-bank';
/** PCED (bulk form: voice in bytes 1-2) -> one PMEM record (routine 8509). */
export function packPerf(d) {
  const m = new Uint8Array(PMEM_REC);
  for (let i = 0; i < 8; i++) {
    const b = i * 12;
    const o = i * 8;
    m[o] = ((d[b + 9] & 3) << 5) | ((d[b + 1] & 1) << 4) | (d[b] & 15);
    m[o + 1] = d[b + 2] & 0x7f;
    m[o + 2] = ((d[b + 10] & 3) << 5) | (d[b + 3] & 31);
    m[o + 3] = d[b + 4] & 0x7f; m[o + 4] = d[b + 5] & 0x7f; m[o + 5] = d[b + 6] & 0x7f;
    m[o + 6] = ((d[b + 11] & 1) << 6) | (d[b + 7] & 63);
    m[o + 7] = d[b + 8] & 0x7f;
  }
  m[64] = d[96] & 0x7f;
  m[65] = ((d[99] & 15) << 3) | ((d[98] & 3) << 1) | (d[97] & 1);
  for (let i = 0; i < 10; i++) m[66 + i] = d[100 + i] & 0x7f;
  return m;
}
/** One PMEM record -> PCED (routine 846B). */
export function unpackPerf(m) {
  const d = new Uint8Array(PCED_SIZE);
  for (let i = 0; i < 8; i++) {
    const b = i * 12;
    const o = i * 8;
    d[b] = m[o] & 15; d[b + 1] = (m[o] >> 4) & 1; d[b + 2] = m[o + 1] & 0x7f; d[b + 9] = (m[o] >> 5) & 3;
    d[b + 3] = m[o + 2] & 31; d[b + 10] = (m[o + 2] >> 5) & 3;
    d[b + 4] = m[o + 3] & 0x7f; d[b + 5] = m[o + 4] & 0x7f; d[b + 6] = m[o + 5] & 0x7f;
    d[b + 7] = m[o + 6] & 63; d[b + 11] = (m[o + 6] >> 6) & 1; d[b + 8] = m[o + 7] & 0x7f;
  }
  d[96] = m[64] & 0x7f; d[97] = m[65] & 1; d[98] = (m[65] >> 1) & 3; d[99] = (m[65] >> 3) & 15;
  for (let i = 0; i < 10; i++) d[100 + i] = m[66 + i] & 0x7f;
  return d;
}
// The performance templates of the Init function (packed records at 87A6, 87F2, 883E, 888A, 88D6 of the
// lower bank; screen texts "singl", "dual", "split", "mono8", "poly4" at 2F60): eight instruments, then MICTUN
// and the common byte (both 0) and the name.
const T8 = (rows) => rows.flatMap((r) => r.split(' ').map((x) => parseInt(x, 16)));
const REST = ['60 00 62 00 7f 07 18 63', '60 00 63 00 7f 07 18 63', '60 00 64 00 7f 07 18 63', '60 00 65 00 7f 07 18 63', '60 00 66 00 7f 07 18 63', '60 00 67 00 7f 07 18 63'];
export const PERF_TEMPLATES = [
  ['singl', 'SINGLE    ', T8(['68 00 20 00 7f 07 18 63', '60 00 41 00 7f 07 18 63', ...REST])],
  ['dual', 'DUAL      ', T8(['64 00 20 00 7f 07 18 63', '64 00 40 00 7f 09 18 63', ...REST])],
  ['split', 'SPLIT     ', T8(['64 00 20 3c 7f 07 18 63', '64 00 40 00 3b 07 18 63', ...REST])],
  ['mono8', 'MONO8     ', T8(Array.from({ length: 8 }, (_, i) => `61 0${i} ${(0x20 * Math.min(3, i + 1) + i).toString(16)} 00 7f 07 18 63`))],
  ['poly4', 'POLY4     ', T8(Array.from({ length: 8 }, (_, i) => `6${i < 4 ? 2 : 0} 0${i} ${(0x20 * Math.min(3, i + 1) + i).toString(16)} 00 7f 07 18 63`))],
].map(([key, name, inst]) => ({ key, name: name.trim(), record: Uint8Array.from([...inst, 0, 0, ...[...name].map((c) => c.charCodeAt(0))]) }));
const initPerf = (key = 'singl') => unpackPerf(PERF_TEMPLATES.find((t) => t.key === key).record);
const isPced = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === PE && b.body.length === PCED_SIZE); };
const isPmem = (raw) => isHdr(raw, PM, PM_SIZE);
const pmemName = (bank, i) => textAt(bank, i * PMEM_REC + 66);

function perfToCommon(d) {
  const parts = Array.from({ length: 8 }, (_, i) => {
    const b = i * 12;
    return { on: d[b] > 0, channel: d[b + 3] < 16 ? d[b + 3] : 0, program: (d[b + 1] << 7) | d[b + 2], level: d[b + 8] / 99, transpose: d[b + 7] - 24, fine: (d[b + 6] - 7) * 2, low: d[b + 4], high: d[b + 5] };
  });
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'multi', parts,
    extra: { family: 'yamaha-dx', model: 'TX81Z', pced81z: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d.subarray(0, 100))) },
  };
}
function perfFromCommon(c) {
  const report = emptyReport();
  const d = initPerf();
  if (c?.extra?.pced81z) { d.set(fromBase64(c.extra.pced81z).subarray(0, PCED_SIZE)); report.mapped.push('the whole performance (TX81Z)'); return { data: d, report }; }
  const parts = (c?.parts || []).filter((p) => p.on !== false).slice(0, 8);
  const notes = parts.length ? Math.max(1, Math.floor(8 / parts.length)) : 0;
  parts.forEach((p, i) => {
    const b = i * 12;
    const prog = Number.isInteger(p.program) ? Math.max(0, Math.min(159, p.program)) : 0;
    d.set([i === 0 ? 8 - notes * (parts.length - 1) : notes, prog >> 7, prog & 0x7f, Math.max(0, Math.min(15, p.channel ?? i)), p.low ?? 0, p.high ?? 127,
      Math.max(0, Math.min(14, 7 + Math.round((p.fine || 0) / 2))), Math.max(0, Math.min(48, 24 + Math.round(p.transpose || 0))), Math.round(99 * (p.level ?? 1)), 3, 0, 0], b);
  });
  report.mapped.push('parts: voice number, channel, key range, level, transpose');
  report.approximated.push('the eight notes shared out between the parts');
  if ((c?.parts || []).length > 8) report.dropped.push('parts after the eighth');
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ system setup ("LM  8976S0", 27 bytes)
// RAM 7565-756F then the 16-character message at 7740 (sender E4C3). Labels: the UTILITY pages (records
// 20-23 and the MIDI control pages 75-82 of the table at A76C), whose order matches the page table B5E5;
// value texts from the display routines (A37E, A485, A424, A6AE, A6E4, A390, B432).
const S0 = 'LM  8976S0';
const SYS_SIZE = 27;
const CHG = ['off', 'norm', ...Array.from({ length: 16 }, (_, i) => `G${i + 1}`)];
function sysParams() {
  const ps = [];
  const P = (o, label, max, group, extra = {}) => ps.push({ key: `s${o}`, label, offset: o, min: 0, max, group, ...extra });
  P(0, 'Master Tune', 127, 'UTILITY', { format: (v) => signed(v - 64), help: 'Shown as -64..+63 (A37E).' });
  P(8, 'Mem Protect', 1, 'UTILITY', { options: opts(TX81Z_TEXTS.OFFON), help: 'Memory protect (the firmware\'s cold start sets it on; kept off here).' });
  P(9, 'Combine', 1, 'UTILITY', { options: opts(TX81Z_TEXTS.OFFON) });
  P(1, 'Basic Rcv.Ch', 16, 'MIDI control', { options: Array.from({ length: 17 }, (_, c) => [c, c < 16 ? String(c + 1) : 'omn']) });
  P(2, 'Transmit Ch', 15, 'MIDI control', { options: Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]), help: 'Also the channel of the TX81Z\'s own bulk dumps.' });
  P(3, 'P.Change', 2, 'MIDI control', { options: opts(['off', 'com', 'ind']), help: 'Program change reception: off, common, individual (per instrument).' });
  P(4, 'Cont.Change', 17, 'MIDI control', { options: opts(CHG) });
  P(10, 'A.Touch → BC', 1, 'MIDI control', { options: opts(TX81Z_TEXTS.OFFON), help: 'Aftertouch received as breath control.' });
  P(5, 'Pitch Bend', 17, 'MIDI control', { options: opts(CHG) });
  P(6, 'Note on/off', 2, 'MIDI control', { options: opts(['all', 'odd', 'even']) });
  P(7, 'Exclusive', 1, 'MIDI control', { options: opts(TX81Z_TEXTS.OFFON) });
  for (let i = 0; i < 16; i++) P(11 + i, `Message ${i + 1}`, 127, 'Message', { hidden: true });
  return ps;
}
function initSystem() {
  const d = Uint8Array.from([64, 16, 0, 1, 1, 1, 0, 1, 0, 1, 0, ...[...'<Good morning!!>'].map((c) => c.charCodeAt(0))]);
  return d;
}

// ------------------------------------------------------------------ program change table ("LM  8976S1")
// 128 entries, each sent as its bit 7 then the low seven bits (sender E543): 0-159 voices, A0h-B7h the
// performances PF01-PF24 (display A13A: "PGM nnn = I01" / "PF01"); cold start: PGM n = voice n (99AB).
const S1 = 'LM  8976S1';
const PC_SIZE = 256;
const pcName = (v) => (v < 160 ? voiceName(v) : `PF${String(v - 159).padStart(2, '0')}`);
function pcParams() {
  return Array.from({ length: 128 }, (_, n) => ({
    key: `pgm${n}`, label: `PGM ${n + 1}`, offset: 2 * n, size: 2, min: 0, max: 183, group: `PGM ${(n & ~31) + 1}-${(n & ~31) + 32}`,
    section: `p${n >> 5}`, get: (d) => ((d[2 * n] & 1) << 7) | (d[2 * n + 1] & 0x7f), set: (d, v) => { d[2 * n] = (v >> 7) & 1; d[2 * n + 1] = v & 0x7f; },
    options: Array.from({ length: 184 }, (_, v) => [v, pcName(v)]),
  }));
}
const initPc = () => { const d = new Uint8Array(PC_SIZE); for (let n = 0; n < 128; n++) { d[2 * n] = 0; d[2 * n + 1] = n; } return d; };

// ------------------------------------------------------------------ effects ("LM  8976S2", 55 bytes)
// 75F1-75F7 delay and pan (maxima C7BB: 127, 48, 7, 99, 2, 1, 99), 75F8 the chords: 12 keys x 4 notes
// (0-48 = the key's note -24..+24, 49 = none, shown " * "; display A098); cold start values at 99C9.
const S2 = 'LM  8976S2';
const FX_SIZE = 55;
const FX_INIT = [8, 24, 0, 73, 0, 0, 25, 16, 19, 24, 49, 16, 19, 21, 24, 17, 21, 24, 49, 16, 19, 24, 49, 15, 20, 24, 49, 16, 19, 21, 24, 16, 19, 21, 24, 16, 19, 24, 49, 16, 19, 21, 24, 15, 20, 24, 49, 16, 19, 21, 24, 15, 18, 20, 24];
const KEYNAME = (k) => `${TX81Z_TEXTS.NOTES[k]}3`;
function fxParams() {
  const ps = [];
  const P = (o, label, max, group, extra = {}) => ps.push({ key: `e${o}`, label, offset: o, min: 0, max, group, section: 'fx', ...extra });
  P(0, 'Delay Time', 127, 'Effect 1 (delay)', { format: (v) => `${((v + 1) / 100).toFixed(2)}s`, help: 'Shown as (value + 1) / 100 seconds (A6D4).' });
  P(1, 'Pitch Shift', 48, 'Effect 1 (delay)', { format: (v) => signed(v - 24) });
  P(2, 'Feedback', 7, 'Effect 1 (delay)');
  P(3, 'Effect Level', 99, 'Effect 1 (delay)');
  P(4, 'Select', 2, 'Effect 2 (pan)', { options: opts(['LFO', 'velocity', 'note']), help: 'What moves the pan.' });
  P(5, 'Direction', 1, 'Effect 2 (pan)', { options: [[0, 'I→II'], [1, 'II→I']], help: 'Between the outputs I and II (the screen draws "I→" and the second output with a custom character).' });
  P(6, 'Pan Range', 99, 'Effect 2 (pan)');
  for (let k = 0; k < 12; k++) {
    for (let j = 0; j < 4; j++) {
      P(7 + 4 * k + j, `${KEYNAME(k)} note ${j + 1}`, 49, 'Effect 3 (chord)', {
        section: 'chord', options: Array.from({ length: 50 }, (_, v) => [v, v < 49 ? NOTE(v + k + 36) : '*']),
        help: j ? undefined : `The chord played by key ${TX81Z_TEXTS.NOTES[k]} ("Key on note?"): up to four notes from two octaves below to two above; * = none.`,
      });
    }
  }
  return ps;
}

// ------------------------------------------------------------------ micro tuning ("LM  MCRTE0" / "LM  MCRTE1")
// Per key: note 13-108 (C#-1..C7; the receive check C7A1 keeps that range) and fine 0-63 (64ths of a
// semitone). The screen (A051) shows the key, the nearest note and the fine as +0..+32 or, from 33 on,
// as the next note -31..-1. Octave table: keys C3..B3 (equal: note 60 + key), full: keys 0-127.
const MT0 = 'LM  MCRTE0';
const MT1 = 'LM  MCRTE1';
function mtParams(keys) {
  const ps = [];
  for (let k = 0; k < keys; k++) {
    const key = keys === 12 ? 60 + k : k;
    const grp = keys === 12 ? 'Octave' : `Octave ${Math.floor(k / 12) - 2}`;
    const sec = keys === 12 ? 'oct' : `o${Math.floor(k / 12)}`;
    ps.push({ key: `n${k}`, label: `${NOTE(key)} note`, offset: 2 * k, min: 13, max: 108, group: grp, section: sec, options: Array.from({ length: 96 }, (_, i) => [i + 13, NOTE(i + 13)]) });
    ps.push({ key: `f${k}`, label: `${NOTE(key)} fine`, offset: 2 * k + 1, min: 0, max: 63, group: grp, section: sec, format: (v) => (v <= 32 ? `+${v}` : `${v - 64} (next note)`), help: k ? undefined : 'Fine tuning in 64ths of a semitone (about 1.6 cents); from 33 on the screen shows it below the next note.' });
  }
  return ps;
}
const initMt = (keys) => { const d = new Uint8Array(2 * keys); for (let k = 0; k < keys; k++) d[2 * k] = keys === 12 ? 60 + k : Math.max(13, Math.min(108, k)); return d; };
function mtToCommon(d, keys) {
  const cents = Array.from({ length: 128 }, (_, n) => {
    const k = keys === 12 ? n % 12 : n;
    const note = d[2 * k] + (keys === 12 ? 12 * (Math.floor(n / 12) - 5) : 0);
    return Math.round(note * 100 + (d[2 * k + 1] * 100) / 64);
  });
  return { model: COMMON_MODEL, kind: 'tuning', cents, extra: { family: 'yamaha-dx', model: 'TX81Z', [keys === 12 ? 'mt81oct' : 'mt81full']: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d)) } };
}
function mtFromCommon(c, keys) {
  const report = emptyReport();
  const own = c?.extra?.[keys === 12 ? 'mt81oct' : 'mt81full'];
  if (own && fromBase64(own).length === 2 * keys) { report.mapped.push('the whole table (TX81Z)'); return { data: fromBase64(own), report }; }
  const d = initMt(keys);
  if (Array.isArray(c?.cents) && c.cents.length >= 72) {
    for (let k = 0; k < keys; k++) {
      const ct = c.cents[keys === 12 ? 60 + k : k];
      if (!Number.isFinite(ct)) continue;
      let note = Math.floor(ct / 100);
      let fine = Math.round(((ct - note * 100) * 64) / 100);
      if (fine > 63) { note += 1; fine = 0; }
      if (note < 13) { note = 13; fine = 0; } else if (note > 108) { note = 108; fine = 63; }
      d[2 * k] = note; d[2 * k + 1] = fine;
    }
    report.approximated.push(`each key's pitch to the nearest 64th of a semitone${keys === 12 ? ' (the octave from C3)' : ''}`);
  } else report.dropped.push('no tuning in the source: equal temperament');
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ settings without a shared form
/** Effects and the program change table travel exactly between TX81Zs; elsewhere they are dropped. */
const rawToCommon = (kind, field) => (d) => ({ model: COMMON_MODEL, kind, extra: { family: 'yamaha-dx', model: 'TX81Z', [field]: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d)) } });
function rawFromCommon(field, init, what) {
  return (c) => {
    const report = emptyReport();
    const x = c?.extra?.[field];
    const d = init();
    if (x && fromBase64(x).length === d.length) { report.mapped.push(`the whole ${what} (TX81Z)`); return { data: fromBase64(x), report }; }
    report.dropped.push(`the source has no TX81Z ${what}: the initial one`);
    return { data: d, report };
  };
}

/** The TX81Z-style definition (also the DX11's, which adds its own data). */
export function buildTX81Z(V) {
  const full = !!V.full; // the TX81Z's own objects (memories, system, tables, effects), not checked for the DX11
  const isOther = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7e && /^LM {2}(8976(PM|S[0-4])|MCRTE[01]|976CRT)/.test(b.header || '')); };
  const kinds = full ? [
    { hdr: S0, size: SYS_SIZE, object: 'system', label: 'System setup' },
    { hdr: S1, size: PC_SIZE, object: 'pctable', label: 'Program change table' },
    { hdr: S2, size: FX_SIZE, object: 'effects', label: 'Effects' },
    { hdr: MT0, size: 24, object: 'microtune-oct', label: 'Micro tuning (octave)' },
    { hdr: MT1, size: 256, object: 'microtune-full', label: 'Micro tuning (full keyboard)' },
  ] : [];
  const kindOf = (raw) => kinds.find((x) => isHdr(raw, x.hdr, x.size));
  return buildDX4({
    id: V.id, name: V.name, T: TX81Z_TEXTS, init: V.init || TX81Z_INIT, aced: true, peg: false, chorus: false, requests: true,
    formats: [0x7e], coverage: V.coverage, deviceIds: V.deviceIds || [],
    notes: { voice: `The ${V.name} answers dump requests: Get from device reads the additional data ("LM  8976AE") and the voice (format 3). Every change is a parameter change (voice 12h, additional data 13h).` },
    moreRequests: [
      { label: 'Performance edit buffer', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, PE) },
      { label: 'Performance memories', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, PM), timeout: 4000 },
      { label: 'System setup', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, S0) },
      { label: 'Program change table', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, S1) },
      { label: 'Effects', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, S2) },
      { label: 'Micro tuning (octave)', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, MT0) },
      { label: 'Micro tuning (full)', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, MT1) },
      ...(V.moreRequests || []),
    ],
    recognise: (raw) => isPced(raw) || isOther(raw) || !!V.recognise?.(raw),
    prefer: V.prefer || ((msgs) => (msgs.some((m) => isPced(m) || isOther(m)) ? 2 : 1.2)),
    libraryItem: (m, k) => {
      if (isPced(m)) { const d = parseBulk(m).body; return [{ key: `p${k}`, label: `Performance "${textAt(d, 100)}"`, name: textAt(d, 100), object: 'performance', data: Uint8Array.from(d), msgs: [m] }]; }
      if (full && isPmem(m)) {
        const bank = parseBulk(m).body;
        const ch = parseBulk(m).channel;
        return Array.from({ length: 24 }, (_, i) => {
          const d = unpackPerf(bank.subarray(i * PMEM_REC, (i + 1) * PMEM_REC));
          return { key: `pm${k}-${i}`, label: `PF${String(i + 1).padStart(2, '0')} ${pmemName(bank, i)}`, name: pmemName(bank, i), object: 'performance', data: d, msgs: [Uint8Array.from(bulkHeader(ch, PE, d))] };
        });
      }
      const kd = kindOf(m);
      if (kd) return [{ key: `${kd.object}${k}`, label: kd.label, name: kd.object === 'system' ? textAt(parseBulk(m).body, 11, 16) : '', object: kd.object, data: Uint8Array.from(parseBulk(m).body), msgs: [m] }];
      if (isOther(m)) return [{ key: `o${k}`, label: parseBulk(m).header.trim(), name: '', msgs: [m] }];
      return V.libraryItem?.(m, k) ?? null;
    },
    simulateRequest: (unit, hdr, c) => {
      if (hdr === PE) return [bulkHeader(c, PE, unit.perf ||= initPerf())];
      if (!full) return [];
      if (hdr === PM) return [bulkHeader(c, PM, unit.pmem ||= initPmem())];
      const kd = kinds.find((x) => x.hdr === hdr);
      return kd ? [bulkHeader(c, hdr, (unit[kd.object] ||= INITS[kd.object]()))] : [];
    },
    simulateBulk: (unit, b) => {
      if (b?.ok && b.header === PE) unit.perf = Uint8Array.from(b.body);
      if (!full || !b?.ok) return;
      if (b.header === PM && b.body.length === PM_SIZE) unit.pmem = Uint8Array.from(b.body);
      const kd = kinds.find((x) => x.hdr === b.header && x.size === b.body.length);
      if (kd) unit[kd.object] = Uint8Array.from(b.body);
    },
    simulateParam: (unit, pc) => { if (pc.group === 4 && pc.num < PCED_SIZE) (unit.perf ||= initPerf())[pc.num] = pc.value; return []; },
    extend(def, { ch }) {
      const params = pcedParams();
      const pbankOf = (ctx) => ctx?.data?.[PBANK_KEY] || null;
      async function readPmem(api) {
        const raw = await api.request(dumpRequestHeader(ch(api.ctx), PM), isPmem, (r) => r);
        api.g.objectData[PBANK_KEY] = Uint8Array.from(parseBulk(raw).body);
        api.g.loadedKeys?.add(PBANK_KEY);
        return api.g.objectData[PBANK_KEY];
      }
      const perf = {
        key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: PCED_SIZE, init: () => initPerf(), params, cols: 3,
        sections: [{ key: 'common', label: 'Common' }, ...Array.from({ length: 8 }, (_, i) => ({ key: `i${i}`, label: `Inst ${i + 1}` }))],
        request: (ctx) => dumpRequestHeader(ch(ctx), PE),
        match: isPced,
        decode: (raw) => Uint8Array.from(parseBulk(raw).body),
        name: (d) => textAt(d, 100),
        setName: (d, n) => { for (let i = 0; i < 10; i++) d[100 + i] = Math.max(32, Math.min(126, String(n ?? '').charCodeAt(i) || 32)); return d; },
        note: 'Eight instruments, each with its voice, receive channel, key limits and share of the eight notes. Changes are parameter changes (group 4, number = byte).',
        sendParam: (p, _v, d, ctx) => (p.size === 2 ? [paramChange(ch(ctx), 4, p.offset, d[p.offset]), paramChange(ch(ctx), 4, p.offset + 1, d[p.offset + 1])] : paramChange(ch(ctx), 4, p.offset, d[p.offset])),
        sendAll: { label: 'Send', title: 'Send the performance edit buffer ("LM  8976PE")', build: (d, ctx) => bulkHeader(ch(ctx), PE, d) },
        toSyx: (d, ctx) => bulkHeader(ch(ctx), PE, d),
        fromSyx: (msgs) => {
          const m = msgs.find(isPced);
          if (m) return Uint8Array.from(parseBulk(m).body);
          const pm = full && msgs.find(isPmem);
          return pm ? unpackPerf(parseBulk(pm).body.subarray(0, PMEM_REC)) : null;
        },
        receive: (raw, d, ctx) => {
          if (isPced(raw)) return Uint8Array.from(parseBulk(raw).body);
          if (full && isPmem(raw) && ctx?.data) { ctx.data[PBANK_KEY] = Uint8Array.from(parseBulk(raw).body); ctx.loaded?.add?.(PBANK_KEY); return Uint8Array.from(d); }
          return null;
        },
        actions: [
          {
            label: 'Init', title: 'The Init function\'s templates (lower bank 87A6-8921): singl, dual, split, mono8, poly4; not sent until you press Send',
            run: async (api) => {
              const r = await api.form('Init performance', [{ key: 't', label: 'Template', type: 'select', value: 'singl', options: PERF_TEMPLATES.map((t) => [t.key, `${t.key} (${t.name})`]) }]);
              if (r) api.setData(initPerf(r.t));
            },
          },
          ...(full ? [
            { label: 'Get 24 performances', title: 'Read the performance memories ("LM  8976PM")', run: async (api) => { await readPmem(api); api.toast('24 performances received', 'good', 2000); api.setData(Uint8Array.from(api.data)); } },
            {
              label: 'Send memories', title: 'Send the editor\'s copy of the 24 performance memories ("LM  8976PM"): replaces every memory', run: async (api) => {
                const b = pbankOf(api.ctx);
                if (!b) { api.toast('The editor holds no performance memories yet: Get 24 performances first.', 'warn'); return; }
                if (!(await api.confirm('Send memories', `Replace all 24 performance memories of the ${V.name}? (Mem Protect off.)`, 'Send', true))) return;
                api.send(bulkHeader(ch(api.ctx), PM, b));
              },
            },
          ] : []),
        ],
        ...(full ? {
          slots: {
            label: 'Performance memories', banks: [[0, 'PF 1-24']], count: 24, slotLabel: (_b, i) => `PF${String(i + 1).padStart(2, '0')}`,
            names: (_b, ctx) => { const b = pbankOf(ctx); return b ? Array.from({ length: 24 }, (_, i) => pmemName(b, i)) : null; },
            scannable: () => true,
            scanBank: async (api, _bank, onName) => { const b = await readPmem(api); for (let i = 0; i < 24; i++) onName(i, pmemName(b, i)); },
            note: (_b, ctx) => (pbankOf(ctx) ? 'Names and Edit come from the editor\'s copy of the memories ("LM  8976PM"). Store packs the performance into the copy and sends all 32 records. A memory is played through the program change table (PF01-PF24).' : 'No memories yet: Get 24 performances (or Read names).'),
            name: (d) => textAt(d, 100),
            fetch: async (api, _b, i) => { const b = pbankOf(api.ctx) || await readPmem(api); return unpackPerf(b.subarray(i * PMEM_REC, (i + 1) * PMEM_REC)); },
            writable: (_b, ctx) => !!(pbankOf(ctx) && ctx.loaded?.has?.(PBANK_KEY)),
            store: (_b, i, ctx, d) => { const b = pbankOf(ctx); b.set(packPerf(d), i * PMEM_REC); return [bulkHeader(ch(ctx), PM, b)]; },
          },
        } : {}),
        multi: {
          page: 'MIDI channels', label: 'Instruments', count: 8, section: (i) => `i${i}`, partLabel: (i) => `Inst ${i + 1}`,
          columns: [
            { label: 'Notes', params: ['MAX NOTES'], role: 'on' },
            { label: 'Voice', params: ['Voice'], role: 'patch' },
            { label: 'MIDI channel', params: ['RECEIVE CH'], role: 'channel' },
            { label: 'Volume', params: ['Volume'] },
            { label: 'Key limits', params: ['LIMIT/L', 'LIMIT/H'] },
            { label: 'Note shift', params: ['NOTE SHIFT'] },
            { label: 'Out', params: ['OUT ASSIGN'] },
          ],
          on: (i, d) => d[i * 12] > 0,
          note: 'An instrument plays when it has notes (MAX NOTES above 0); the eight share eight notes.',
        },
        toCommon: perfToCommon,
        fromCommon: (c) => perfFromCommon(c),
      };
      def.objects.push(perf);
      if (full) {
        const simple = (kd, o) => ({
          key: kd.object, label: kd.label, size: kd.size,
          request: (ctx) => dumpRequestHeader(ch(ctx), kd.hdr),
          match: (raw) => isHdr(raw, kd.hdr, kd.size),
          decode: (raw) => Uint8Array.from(parseBulk(raw).body),
          sendAll: { label: 'Send', title: `Send the ${kd.label.toLowerCase()} ("${kd.hdr}")`, build: (d, ctx) => bulkHeader(ch(ctx), kd.hdr, d) },
          toSyx: (d, ctx) => bulkHeader(ch(ctx), kd.hdr, d),
          fromSyx: (msgs) => { const m = msgs.find((x) => isHdr(x, kd.hdr, kd.size)); return m ? Uint8Array.from(parseBulk(m).body) : null; },
          receive: (raw) => (isHdr(raw, kd.hdr, kd.size) ? Uint8Array.from(parseBulk(raw).body) : null),
          ...o,
        });
        const [ks0, ks1, ks2, kmt0, kmt1] = kinds;
        def.objects.push(simple(ks0, {
          page: 'System', icon: '⚙', init: initSystem, params: sysParams(), cols: 3,
          name: (d) => textAt(d, 11, 16),
          note: 'The UTILITY pages (master tune, memory protect, combine) and MIDI control. Each change is sent as F0 43 1n 10 7B pp vv F7. The 16-character message is shown at power-on ("<Good morning!!>" from the firmware) and under UTILITY MODE.',
          sendParam: (p, _v, d, ctx) => longChange(ch(ctx), 0x7b, p.offset, d[p.offset]),
          actions: [
            {
              label: 'Message', title: 'The 16-character power-on message', run: async (api) => {
                const r = await api.form('Power-on message', [{ key: 'm', label: 'Message (16 characters)', value: textAt(api.data, 11, 16), maxlength: 16 }]);
                if (!r) return;
                const d = Uint8Array.from(api.data);
                for (let i = 0; i < 16; i++) d[11 + i] = Math.max(32, Math.min(126, String(r.m ?? '').charCodeAt(i) || 32));
                api.send(Array.from({ length: 16 }, (_, i) => longChange(ch(api.ctx), 0x7b, 11 + i, d[11 + i])));
                api.setData(d);
              },
            },
            { label: 'Init', title: 'The firmware\'s initial setup (96C4, 954A; Mem Protect off), not sent until you press Send', run: (api) => api.setData(initSystem()) },
          ],
        }));
        def.objects.push(simple(ks1, {
          page: 'Program changes', icon: '⇄', init: initPc, params: pcParams(), cols: 4,
          sections: [0, 1, 2, 3].map((i) => ({ key: `p${i}`, label: `PGM ${i * 32 + 1}-${i * 32 + 32}` })),
          note: 'What each received program change selects (UTILITY "Edit P.Cng Tbl?"): a voice I01-D32 or a performance PF01-PF24. Each change is sent as F0 43 1n 10 7F pp hh ll F7.',
          sendParam: (p, _v, d, ctx) => longChange(ch(ctx), 0x7f, p.offset >> 1, d[p.offset], d[p.offset + 1]),
          actions: [{ label: 'Init', title: 'PGM n = voice n (the firmware\'s cold start, 99AB; UTILITY "Init P.Cng Tbl?"), not sent until you press Send', run: (api) => api.setData(initPc()) }],
          toCommon: rawToCommon('program-map', 'pc81'),
          fromCommon: rawFromCommon('pc81', initPc, 'program change table'),
        }));
        def.objects.push(simple(ks2, {
          page: 'Effects', icon: '◎', init: () => Uint8Array.from(FX_INIT), params: fxParams(), cols: 4,
          sections: [{ key: 'fx', label: 'Delay and pan' }, { key: 'chord', label: 'Chords' }],
          note: 'The performance effects (UTILITY "Edit Effect 1-3"): delay, pan and the chord of each key; the performance picks one (Effect). Each change is sent as F0 43 1n 10 7C pp vv F7.',
          sendParam: (p, _v, d, ctx) => longChange(ch(ctx), 0x7c, p.offset, d[p.offset]),
          actions: [{ label: 'Init', title: 'The firmware\'s initial effects (99C9), not sent until you press Send', run: (api) => api.setData(Uint8Array.from(FX_INIT)) }],
          toCommon: rawToCommon('effects-setup', 'fx81'),
          fromCommon: rawFromCommon('fx81', () => Uint8Array.from(FX_INIT), 'effects setup'),
        }));
        for (const [kd, keys] of [[kmt0, 12], [kmt1, 128]]) {
          def.objects.push(simple(kd, {
            page: keys === 12 ? 'Micro tune octave' : 'Micro tune full', icon: '♯', init: () => initMt(keys), params: mtParams(keys), cols: 4,
            sections: keys === 12 ? [{ key: 'oct', label: 'C3-B3' }] : Array.from({ length: 11 }, (_, o) => ({ key: `o${o}`, label: `${NOTE(o * 12)}-${NOTE(Math.min(127, o * 12 + 11))}` })),
            note: `${keys === 12 ? 'The user octave (MICRO OCT.): each note of the octave, repeated over the keyboard' : 'The user table for all 128 keys (MICRO FULL)'}; a performance uses it with MICTUN and the instrument's MICROTUNE switch. Each key is sent as F0 43 1n 10 ${keys === 12 ? '7D' : '7E'} kk note fine F7.`,
            sendParam: (p, _v, d, ctx) => { const k = p.offset >> 1; return longChange(ch(ctx), keys === 12 ? 0x7d : 0x7e, k, d[2 * k], d[2 * k + 1]); },
            actions: [{ label: 'Init', title: `Equal temperament (UTILITY "Init ${keys === 12 ? 'Octave' : 'Full Kbd'} ?"), not sent until you press Send`, run: (api) => api.setData(initMt(keys)) }],
            toCommon: (d) => mtToCommon(d, keys),
            fromCommon: (c) => mtFromCommon(c, keys),
          }));
        }
        const describe = def.describe;
        def.describe = (raw) => {
          const x = parseLong(raw);
          if (x) return `${V.name} ${{ 0x7b: 'system', 0x7c: 'effects', 0x7d: 'octave micro tuning', 0x7e: 'full micro tuning', 0x7f: 'program change table' }[x.num]} change ${x.args.join(' ')}`;
          return describe(raw);
        };
      }
      V.extend?.(def, { ch });
    },
  });
}
const INITS = { system: initSystem, pctable: initPc, effects: () => Uint8Array.from(FX_INIT), 'microtune-oct': () => initMt(12), 'microtune-full': () => initMt(128) };
function initPmem() {
  const b = new Uint8Array(PM_SIZE);
  for (let i = 0; i < 32; i++) b.set(PERF_TEMPLATES[0].record, i * PMEM_REC);
  return b;
}

const def = buildTX81Z({
  id: 'yamaha-tx81z', name: 'TX81Z', full: true,
  coverage: 'Every voice parameter (VCED) and the additional data (ACED: fixed frequency, fine, the eight waves, EG shift, reverb, foot controller) with the TX81Z\'s own frequency display, the 32 internal voices (packed VMEM, decoded and checked against the firmware\'s presets), the performance (eight instruments: notes, voice, receive channel, key limits, detune, note shift, volume, output, LFO, micro tuning; micro tuning table, assign mode, effect) with a MIDI channels page and its 24 memories (packed PMEM), the system setup, the program change table, the effects (delay, pan, chords) and both micro tuning tables; labels from the v1.6 firmware\'s screens. Not yet checked on a TX81Z.',
});

export const _test = { pcedParams, initPerf, isPced, PE, initPmem, longChange, parseLong, FX_INIT };
export default def;
