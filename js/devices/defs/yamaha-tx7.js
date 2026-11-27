// Yamaha TX7: the DX7's tone generator as a module, with function data (performance) per voice.
// From the TX7 v1.4 firmware (HD6303, 16 KB at C000h; parser DA08, transmitters E152-E32A) and the
// DX7 v1.8 firmware for the voice (the TX7 has no voice edit display: its voice labels and value
// displays are the DX7's). Shared DX code: yamaha-dx.js. Not yet checked on a TX7.
//
//   receives  formats 0 (voice), 1 (function data, 94 bytes), 2 (function memories, 4096 bytes), 9 (32 voices);
//             parameter changes group 0 (voice), 1 (function data, number = byte), 2 (DX7 function 64-77),
//             4 (+128: system settings)
//   answers   dump requests F0 43 2n ff F7 for ff = 0, 1, 2, 9 and 7Dh (system, "LM  8951  ")
//
// Function data (format 1) is the DX1/DX5 performance layout: two 30-byte halves (A, B), 4 common bytes
// and a 30-character name. The TX7 uses half A (routine E29D): the bytes below; it fills the rest with
// fixed values (B = a copy of A with voice + 32, name " YAMAHA  TX7  FUNCTION  DATA   ") and reads them
// nowhere, so the editor shows them read-only, named as the DX5 shows them (yamaha-dx-fn94.js).

import { buildDX } from './yamaha-dx.js';
import { bulk, parseBulk, paramChange, dumpRequest } from './yamaha-dx-sysex.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import { textAt } from './yamaha-dx-voice.js';
import { DX7_FW, DX7_LABELS, DX7_HELP } from './yamaha-dx7.js';
import { fn94Params, FIXED, fmemItems, fmemSlots, simulateFmem } from './yamaha-dx-fn94.js';

const PERF_SIZE = 94;
const opts = (list) => list.map((t, i) => [i, t]);
// TX7 LCD texts (length-prefixed strings at C95A-CA7F)
const TX = { POLYMONO: ['POLY', 'MONO'], PORTA_POLY: ['RTN', 'FLW'], PORTA_MONO: ['FGD', 'FUL'], GLISS: ['PRT', 'GLS'], OFFON: ['OFF', 'ON'] };
const CTL = [['MW', 9], ['FC', 11], ['AT', 13], ['BC', 15]];

function perfParams() {
  const ps = [];
  const P = (offset, label, max, extra = {}) => ps.push({ key: `p${offset}${extra.keySuffix || ''}`, label, offset, min: 0, max, group: extra.group || 'Function data', ...extra });
  P(0, 'Voice number', 63, { options: Array.from({ length: 64 }, (_, i) => [i, i < 32 ? `I${String(i + 1).padStart(2, '0')}` : `C${String(i - 31).padStart(2, '0')}`]), help: 'The voice this function data goes with (selected when the data arrives; 33-64 are DX7 cartridge voices).' });
  P(2, 'PLAY MODE', 1, { options: opts(TX.POLYMONO), relayout: true });
  P(3, 'PW RNG', 12, { help: 'Pitch wheel range (semitones).' });
  P(4, 'STP', 12, { help: 'Pitch wheel step: 0 smooth, 1-12 semitone steps.' });
  P(7, 'PORTA mode', 1, { dynamic: (d) => ({ options: opts(d[2] ? TX.PORTA_MONO : TX.PORTA_POLY) }), help: 'Poly: RTN (sustain-key pitch retain) / FLW (follow); mono: FGD (fingered) / FUL (full time).' });
  P(5, 'PORTA time', 99);
  P(6, 'PORTA / GLISS', 1, { options: opts(TX.GLISS) });
  for (const [name, off] of CTL) {
    P(off, `${name}= (range)`, 15, { group: 'Controllers' });
    ['P', 'A', 'E'].forEach((t, b) => P(off + 1, `${name} ${t}`, 1, { shift: b, bits: 1, options: opts(TX.OFFON), group: 'Controllers', keySuffix: `_${b}`, help: `${name} to ${['pitch (LFO PM)', 'amplitude (LFO AM)', 'EG bias'][b]}.` }));
  }
  P(26, 'ATTENUATION', 7);
  // The bytes the TX7 never reads, named as the DX5 shows them (yamaha-dx-fn94.js), read-only.
  const used = new Set(ps.map((p) => p.offset));
  const dx5 = fn94Params({
    reads: () => false,
    group: (o) => (o < 30 ? 'Not used by the TX7 (DX5 channel A)' : o < 60 ? 'Not used by the TX7 (DX5 channel B)' : o < 64 ? 'Not used by the TX7 (DX5 key assign)' : 'Name'),
    readOnlyHelp: (o) => (o >= 64 ? 'Performance name character; the TX7 always sends " YAMAHA  TX7  FUNCTION  DATA  " (C87C).'
      : o >= 30 && o < 60 ? 'Channel B of the DX5 performance: the TX7 sends a copy of channel A (voice number + 32) and never reads it.'
        : `The DX5's ${o < 60 ? 'channel A' : 'performance'} value; the TX7 sends ${FIXED[o] ?? 0} here and never reads it.`),
  }).filter((p) => !used.has(p.offset)).map((p) => ({ ...p, label: p.offset >= 64 ? p.label : `${p.label} (DX5)` }));
  return [...ps, ...dx5];
}
const SENT = new Set([2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 26]); // group 1 numbers the TX7 applies (DFAB)

function initPerf() {
  const d = new Uint8Array(PERF_SIZE);
  const half = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 99, 0, 0, 1, 24];
  d.set(half, 0); d.set(half, 30); d[30] = 32; d[63] = 39;
  d.set([...' YAMAHA  TX7  FUNCTION  DATA  '].map((c) => c.charCodeAt(0)), 64);
  return d;
}
const isPerf = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 1 && b.data.length === PERF_SIZE); };
const isPmem = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 2 && b.data.length === 4096); };

function perfToCommon(d) {
  const mono = !!d[2];
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'single',
    parts: [{ on: true, channel: 0, program: d[0], level: 1 - d[26] / 7 }],
    voice: { mode: mono ? 'mono' : 'poly', portamento: { on: d[5] > 0 && !d[6], time: d[5] / 99 }, bendUp: d[3], bendDown: d[3] },
    extra: { family: 'yamaha-dx', model: 'TX7', pced: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d.subarray(0, 30))) },
  };
}
function perfFromCommon(c) {
  const report = emptyReport();
  const d = initPerf();
  if (c?.extra?.family === 'yamaha-dx' && c.extra.pced) {
    const v = fromBase64(c.extra.pced);
    d.set(v.subarray(0, Math.min(PERF_SIZE, v.length)));
    report.mapped.push(`function data (${c.extra.model})`);
    return { data: d, report };
  }
  const p = c?.parts?.find((x) => x.on !== false) || c?.parts?.[0];
  if (Number.isInteger(p?.program)) { d[0] = Math.max(0, Math.min(31, p.program)); report.mapped.push('voice number'); }
  if (c?.parts?.length > 1) report.dropped.push('parts after the first (the TX7 plays one voice)');
  if (p?.level !== undefined) d[26] = Math.max(0, Math.min(7, Math.round((1 - p.level) * 7)));
  const v = c?.voice || {};
  if (v.mode) { d[2] = v.mode === 'mono' || v.mode === 'legato' ? 1 : 0; report.mapped.push('poly/mono'); }
  if (v.bendUp !== undefined) { d[3] = Math.max(0, Math.min(12, Math.round(v.bendUp))); report.mapped.push('pitch wheel range'); }
  if (v.portamento) { d[5] = v.portamento.on ? Math.max(1, Math.round((v.portamento.time ?? 0.3) * 99)) : 0; report.approximated.push('portamento time'); }
  d[30] = d[0] + 32;
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ system (7Dh answer, parameter changes)
// The TX7 answers F0 43 2n 7D F7 (E2F7) with F0 43 0n 7D 00 10 + 16 bytes + cs F7: "LM  8951  ", 01 04
// (constants, C0CE), the flags of RAM 7B68-7B6E as bits 6-0 (E442: bit set = value not 0), MIDI RCV.CH.
// (7B7C), the battery reading (7B7D, CDBF: 0.1 V steps; "CHANGE BATTERY" below 17h) and the volume level it
// writes to the volume DAC (7B7E, inverted to 4800h). It takes no 7Dh bulk (its bulk receiver DA89 takes
// formats 0, 1, 2, 9 only); the settings are changed with parameter changes: F0 43 1n 11 pp vv F7 (group 4,
// number 80h + pp, handler DF0F, RAM table C85E: 0 7B68, 1 7B6B, 2 7B6C, 3 7B6D, 5 74D9, 6 74D8, 7 7B69;
// 4 shows the CMB / IND page, 0Bh 7B37, 0Ch VOICE INIT D6EE; 8-0Ah ignored), group 1 number 1 (MIDI
// RCV.CH. = value - 1, E028) and 40h (MASTER TUNE 7B7F, E004), and control changes 7Ch / 7Dh (OMNI MODE
// off / on, D8AF / D8C0). Page titles (length-prefixed texts C959-CB80; each display routine starts
// with the title's address): "D.ENTRY RCV." and "D.ENTRY VOL" exclude each other (DF94 / DF9D);
// "SP L=    ,H=    " the key limits, set by a key (D85B); "LOAD FUNC ?" INT / EXT (CB34 / CB38).
// Power-on sets MEM. PROTECT on (CD5E); cold start (FBFE): channel 1, omni off, both D.ENTRY off, tune 64.
const SYS_HDR = 'LM  8951  ';
const SYS_SIZE = 14;
const isSys = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7d && b.data.length === 16 && String.fromCharCode(...b.data.subarray(0, 10)) === SYS_HDR); };
const SYS_INIT = [0, 0, 0, 1, 0, 0, 1, 0, 30, 0, 64, 0, 127, 0];
const NOTE = (n) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12]}${Math.floor(n / 12) - 2}`; // note names C89A
/** [offset, label, max, how it is sent, group, extra]; send: {sys: pp} | {fn: number, add} | 'omni' | null (read only). */
const SYS_PARAMS = [
  [10, 'MASTER TUNE', 127, { fn: 0x40 }, 'TX7', { format: (v) => String(v - 64), help: 'Shown -64..+63 (D38A); sent as group 1 number 40h (E004). Not in the 7Dh answer: the page shows what was sent.' }],
  [1, 'MEM. PROTECT', 1, { sys: 7 }, 'TX7', { options: opts(TX.OFFON), help: 'Memory protect: the TX7 turns it ON at every power-on (CD5E). Shown OFF, your usual setting.' }],
  [13, 'LOAD FUNC', 1, { sys: 0x0b }, 'TX7', { options: opts(['INT', 'EXT']), help: 'Which set of function memories the voices use (RAM 7B37: INT 70CAh, EXT 72CAh). Not in the 7Dh answer.' }],
  [7, 'MIDI RCV.CH.', 15, { fn: 1, add: 1 }, 'MIDI', { options: Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]), help: 'Sent as group 1 number 1 = channel (E028). The TX7 then takes messages on the new channel: set the editor\'s MIDI channel to it.' }],
  [2, 'OMNI MODE', 1, 'omni', 'MIDI', { options: opts(TX.OFFON), help: 'Sent as control change 7Dh (omni on) / 7Ch (omni off), as the TX7 takes them (D8C0 / D8AF).' }],
  [3, 'CTL.CHNG.RCV.', 1, { sys: 1 }, 'MIDI', { options: opts(TX.OFFON), help: 'Control changes (modulation, breath, foot, portamento, volume, sustain) received.' }],
  [0, 'D.ENTRY RCV.', 1, { sys: 0 }, 'MIDI', { options: opts(TX.OFFON), help: 'Data entry (control change 6, and 60h / 61h increment / decrement) received; turning it on turns D.ENTRY VOL off (DF94).' }],
  [4, 'D.ENTRY VOL', 1, { sys: 2 }, 'MIDI', { options: opts(TX.OFFON), help: 'The data entry slider sets the volume; turning it on turns D.ENTRY RCV. off (DF9D).' }],
  [11, 'SP L', 127, { sys: 6 }, 'Key limits', { options: Array.from({ length: 128 }, (_, n) => [n, NOTE(n)]), help: '"SP L=    ,H=    ": the lowest key the TX7 plays (RAM 74D8; on its panel set by playing the key). Not in the 7Dh answer.' }],
  [12, 'SP H', 127, { sys: 5 }, 'Key limits', { options: Array.from({ length: 128 }, (_, n) => [n, NOTE(n)]), help: 'The highest key (RAM 74D9). Not in the 7Dh answer.' }],
  [6, 'Internal voice', 1, null, 'Status (7Dh answer)', { options: opts(['no (cartridge)', 'yes']), help: 'Flag 7B6E: set when a program change selected an internal voice (0-31), clear for a cartridge voice (D9CE); the TX7 then loads the voice\'s function memory (D3B6).' }],
  [5, 'Flag 7B6D', 1, null, 'Status (7Dh answer)', { options: opts(TX.OFFON), help: 'Set only by system parameter 3 (which then also sets CTL.CHNG.RCV. on, D.ENTRY RCV. on or off and the internal flag, DF68) and cleared whenever the TX7 changes page (CFF7); no page shows it.' }],
  [8, 'BATTERY VOLT', 127, null, 'Status (7Dh answer)', { format: (v) => `${Math.floor(v / 10)}.${v % 10} V`, help: 'The backup battery as the TX7 measures it (CDB9, shown as "BATTERY VOLT= . "); below 2.3 V it shows CHANGE BATTERY.' }],
  [9, 'Volume level', 127, null, 'Status (7Dh answer)', { help: 'The level the TX7 sets its output volume to (RAM 7B7E, written inverted to the volume DAC: data entry slider or MIDI volume).' }],
];
function sysParams() {
  return SYS_PARAMS.map(([offset, label, max, send, group, extra]) => ({ key: `sys${offset}`, label, offset, min: 0, max, group, how: send, ...(send ? {} : { readOnly: true }), ...extra }));
}
function sysMsg(c, p, d) {
  const v = d[p.offset];
  if (p.how === 'omni') return [0xb0 | (c & 15), v ? 0x7d : 0x7c, 0];
  if (p.how?.sys !== undefined) return paramChange(c, 4, 0x80 + p.how.sys, v);
  if (p.how?.fn !== undefined) return paramChange(c, 1, p.how.fn, v + (p.how.add || 0));
  return null;
}
/** The 7Dh answer into the page's bytes (the values it does not carry kept from `base`). */
function decodeSys(raw, base) {
  const b = parseBulk(raw).data;
  const d = Uint8Array.from(base && base.length === SYS_SIZE ? base : SYS_INIT);
  for (let i = 0; i < 7; i++) d[i] = (b[12] >> (6 - i)) & 1;
  d[7] = b[13] & 15; d[8] = b[14]; d[9] = b[15];
  return d;
}

const def = buildDX({
  id: 'yamaha-tx7',
  name: 'TX7',
  fw: DX7_FW, // the TX7's own INIT VOICE (C4FD) is byte for byte the DX7's
  labels: DX7_LABELS,
  help: DX7_HELP,
  requests: true,
  deviceIds: ['yamaha-dx7'],
  functionParams: null,
  formats: [1, 2, 0x7d],
  bankNote: 'MEM. PROTECT must be off.',
  coverage: 'Every voice parameter (the DX7 voice format: labels and displays from the DX7 v1.8 firmware, as the TX7 has no voice edit display) and the TX7\'s function data (format 1: play mode, pitch wheel, portamento, controllers, attenuation) with the TX7 v1.4 display texts; voice, function data and 32-voice dumps on request, parameter changes for both. The function memories (format 2, the DX5 64-byte packing, which the TX7 sends twice) are split by the Branch Library and read and written back from the Function data page\'s slot list. The System page: the status message (7Dh, "LM  8951  ": MIDI switches, MIDI RCV.CH., battery, volume) read on request, and the settings the TX7 takes as parameter changes (MASTER TUNE, MEM. PROTECT, LOAD FUNC, OMNI MODE, CTL.CHNG.RCV., D.ENTRY RCV. / VOL, key limits) with its page titles. Not yet checked on a TX7.',
  notes: { voice: 'The TX7 answers dump requests: Get from device reads the voice edit buffer. Every change is a parameter change (group 0).' },
  moreRequests: [
    { label: 'Function data (performance edit)', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 1) },
    { label: 'Function memories', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 2), timeout: 5000 },
    { label: 'System status (7Dh, "LM  8951  ")', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 0x7d) },
  ],
  recognise: (raw) => isPerf(raw) || isPmem(raw) || isSys(raw),
  // TX7 data (format 1 / 2) says TX7; plain voices read as well as on a DX7, so a DX7 wins those.
  prefer: (msgs) => (msgs.some((m) => isPerf(m) || isPmem(m) || isSys(m)) ? 3 : 0.9),
  libraryItem: (m, k) => {
    if (isSys(m)) return [{ key: `s${k}`, label: 'System status (LM  8951)', name: '', object: 'system', data: decodeSys(m), msgs: [m] }];
    if (isPerf(m)) return [{ key: `p${k}`, label: `Function data, voice ${parseBulk(m).data[0] + 1}`, name: '', object: 'performance', data: parseBulk(m).data, msgs: [m] }];
    // format 2: the 32 function memories in the DX5's 64-byte form, sent twice (E32A / E396)
    if (isPmem(m)) return fmemItems(parseBulk(m), k, { twice: true, name: (d) => `voice ${d[0] + 1}`, build: (c, d) => bulk(c, 1, d) });
    return null;
  },
  simulateRequest: (unit, d) => {
    if (d[3] === 0x7d) {
      const s = unit.sys7 ||= Uint8Array.from(SYS_INIT);
      const flags = Array.from({ length: 7 }, (_, i) => (s[i] ? 1 << (6 - i) : 0)).reduce((a, b) => a | b, 0);
      return [bulk(d[2] & 15, 0x7d, [...[...SYS_HDR].map((c) => c.charCodeAt(0)), 1, 4, flags, s[7], s[8], s[9]])];
    }
    return d[3] === 1 ? [bulk(d[2] & 15, 1, unit.perf ||= initPerf())] : simulateFmem(unit, d, initPerf) || [];
  },
  simulateParam: (unit, pc) => {
    const s = unit.sys7 ||= Uint8Array.from(SYS_INIT);
    const p = SYS_PARAMS.find(([, , , how]) => (how?.sys !== undefined && pc.group === 4 && pc.num === 0x80 + how.sys) || (how?.fn !== undefined && pc.group === 1 && pc.num === how.fn));
    if (p) s[p[0]] = p[3].add ? Math.max(0, pc.value - 1) : pc.value;
    if (pc.group === 4 && pc.num === 0x80 && pc.value) s[4] = 0; // D.ENTRY RCV. on: D.ENTRY VOL off (DF94)
    if (pc.group === 4 && pc.num === 0x82 && pc.value) s[0] = 0; // and the other way (DF9D)
  },
  simulateBulk: (unit, b, d) => { if (b?.ok && b.format === 1) unit.perf = Uint8Array.from(b.data); else simulateFmem(unit, d, initPerf); return []; },
  extend(def2, { ch }) {
    // the voice edit buffer can be read
    const v = def2.objects.find((o) => o.key === 'voice');
    v.request = (ctx) => dumpRequest(ch(ctx), 0);
    v.match = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0 && b.data.length === 155); };
    v.decode = (raw) => { const d = new Uint8Array(156); d.set(parseBulk(raw).data); d[155] = 0x3f; return d; };
    const params = perfParams();
    def2.objects.push({
      key: 'performance', page: 'Function data', icon: '▦', label: 'Function data', size: PERF_SIZE,
      init: initPerf, params, cols: 3,
      request: (ctx) => dumpRequest(ch(ctx), 1),
      match: isPerf,
      decode: (raw) => Uint8Array.from(parseBulk(raw).data),
      name: (d) => `voice ${d[0] + 1}${textAt(d, 64, 30) ? '' : ''}`,
      note: 'The TX7\'s function data for one voice (the DX1/DX5 performance format, half A). Changes are parameter changes (group 1, number = byte); the read-only bytes are what the TX7 sends and never reads.',
      sendParam: (p, _v, d, ctx) => (SENT.has(p.offset) ? paramChange(ch(ctx), 1, p.offset, d[p.offset]) : bulk(ch(ctx), 1, d)),
      sendAll: { label: 'Send', title: 'Send the function data (format 1)', build: (d, ctx) => bulk(ch(ctx), 1, d) },
      toSyx: (d, ctx) => bulk(ch(ctx), 1, d),
      fromSyx: (msgs) => { const m = msgs.find(isPerf); return m ? Uint8Array.from(parseBulk(m).data) : null; },
      // the 32 function memories (format 2, E32A; received by DE02: bytes 0-7 and the attenuation of half A)
      slots: fmemSlots({ label: 'Function memories', count: 32, twice: true, perVoice: true, name: (d) => `${d[2] ? 'MONO' : 'POLY'}, PW RNG ${d[3]}`, recall: (c, i) => [0xc0 | c, i], note: 'memory n belongs to voice n (Play selects the voice and its function data); the TX7 takes the play mode, pitch wheel, portamento, controllers and attenuation from it' }),
      toCommon: perfToCommon,
      fromCommon: (c) => perfFromCommon(c),
    });
    const sp = sysParams();
    def2.objects.push({
      key: 'system', page: 'System', icon: '⚙', label: 'System', size: SYS_SIZE, cols: 3,
      init: () => Uint8Array.from(SYS_INIT), params: sp,
      layout: [{ group: 'TX7' }, { group: 'MIDI' }, { group: 'Key limits' }, { group: 'Status (7Dh answer)' }],
      request: (ctx) => dumpRequest(ch(ctx), 0x7d),
      match: isSys,
      decode: (raw, ctx) => decodeSys(raw, ctx?.data?.system),
      note: 'Get from device asks for the TX7\'s status message (7Dh, "LM  8951  "): its MIDI switches, MIDI RCV.CH., battery and volume. MASTER TUNE, LOAD FUNC and the key limits are not in it: they show the defaults (or what was sent) until changed here. The TX7 takes no 7Dh bulk: each change is sent on its own (system parameter changes F0 43 1n 11 pp vv F7, group 1 numbers 1 and 40h, control changes 7Ch / 7Dh for OMNI MODE). MEM. PROTECT is shown OFF, your usual setting (the TX7 sets it ON at power-on).',
      sendParam: (p, _v, d, ctx) => sysMsg(ch(ctx), p, d),
      receive: (raw, d, ctx) => (isSys(raw) ? decodeSys(raw, d) : null),
      fromSyx: (msgs) => { const m = msgs.find(isSys); return m ? decodeSys(m) : null; },
      actions: [
        { label: 'Send all', title: 'Send every setting the TX7 takes (not the status values)', run: (api) => api.send(sp.filter((p) => p.how).map((p) => sysMsg(ch(api.ctx), p, api.data))) },
        { label: 'VOICE INIT', title: 'System parameter 0Ch (D6EE): the TX7 puts its INIT VOICE into the edit buffer and sets MASTER TUNE to 0; read the voice again afterwards', run: (api) => api.send(paramChange(ch(api.ctx), 4, 0x8c, 1)) },
      ],
    });
  },
});

export const _test = { initPerf, perfParams, isPerf };
export default def;
