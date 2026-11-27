// Yamaha DX7II-D / DX7II-FD (and, through buildDX7II, the DX7s and the TX802's voices): the DX7 voice
// (VCED) plus the additional voice data (ACED, 49 bytes), the performance (PCED, 51 bytes) and the
// Branch Library. Labels, value lists, ranges and initial values from the DX7II v1.9 firmware
// (yamaha-dx7ii-fw.js, made by tools/yamaha/dx_fw.py); message formats from Yamaha's DX7II MIDI data
// format, matched with the firmware's bulk header table (8686) and its maximum tables (ECE9, ED1A).
// See docs/devices/yamaha-dx7ii.md. Not yet checked on a DX7II.
//
//   F0 43 0n 05 00 31 <ACED 49> cs F7         additional voice data (sent before the VCED)
//   F0 43 0n 00 01 1B <VCED 155> cs F7        voice
//   F0 43 0n 06 08 60 <AMEM 32 x 35> cs F7    additional data of 32 voices (before the VMEM; packing in
//                                             yamaha-dx7ii-data.js)
//   F0 43 0n 09 20 00 <VMEM 4096> cs F7       32 voices
//   F0 43 0n 7E cc cc "LM  8973PE" <51> cs F7 performance edit buffer; "LM  8973PM" 32 performances,
//                                             "LM  8973S " system setup, "LM  MCRYE"/"MCRYM"/"MCRYC" micro
//                                             tuning, "LM  FKSYE"/"FKSYC" fractional scaling (yamaha-dx7ii-data.js)
//   F0 43 1n 18 pp vv F7                      ACED byte pp (0-38), 40h + byte - 39 for bytes 39-48 (U E5EC)
//   F0 43 1n 19 pp vv F7                      performance byte pp (0-50, U E6AF); system 40h-53h
//   F0 43 2n ff F7 / F0 43 2n 7E "LM  ...." F7 dump requests (ff = 0, 5, 6, 9; device number on, L A776)
// The receiver (lower bank A20F-AF67; sysex states A6F2) and the senders (B2C4-B805) were read in the v1.9
// listings re/dx/dx7ii_lower.lst / _upper.lst (tools/yamaha/hd6303_dis.py with the cross-bank tables 8053 / E983).

import { buildDX } from './yamaha-dx.js';
import { bulkHeader, parseBulk, paramChange, parseParamChange, dumpRequest, dumpRequestHeader } from './yamaha-dx-sysex.js';
import * as D2 from './yamaha-dx7ii-data.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import { textAt, VCED_SIZE, vcedToVmem } from './yamaha-dx-voice.js';
import * as FW from './yamaha-dx7ii-fw.js';

const V = Object.fromEntries(FW.VALUES.items.map((x) => [x.addr, x.text.trim()]));
const list = (...addrs) => addrs.map((a) => V[a]);
const opts = (l) => l.map((t, i) => [i, t]);
const OFFON = list('F9FB', 'F9F7'); // off, on
const AB = list('FB99', 'FBA2', 'FBAB', 'FBB4').map((t) => t.replace(/\s+/g, ' ')); // A / B switch pairs
const NOTE = (n) => `${FW.NOTES.items[n % 12].trim()}${Math.floor(n / 12) - 2}`; // key number: 60 = C3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DX7II_TEXTS = {
  CURVES: [`-${V.FA0B}`, `-${V.FA0F}`, `+${V.FA0F}`, `+${V.FA0B}`],
  WAVES: list('FA29', 'FA32', 'FA3B', 'FA44', 'FA4D', 'FA56'),
  OFFON,
  OSC_MODES: list('F9FF', 'FA05'),
  NOTES: FW.NOTES.items.map((t) => t.trim()),
  DETUNE: Array.from({ length: 15 }, (_, i) => `${i > 7 ? '+' : ''}${i - 7}`),
  FIXED: FW.FIXED_FREQ.items,
};
// Voice labels: the edit screens (F39F..): "Osc >Mode >Coarse >Fine >Detune", "EG >Rs", "Outlvl >Level
// >Ld >Lc >Bp >Rc >Rd", ">R1..>L4", "Sens >Velocity >Ams >Pms", "LFO >Wave >Speed >Delay >Mode >Pmd >Amd
// >Sync", "Peg >Rng >Vel >Rs", ">Alg >Fbl >Osc.sync >Transpose >Voice name".
export const DX7II_LABELS = {
  r: 'R', l: 'L', bp: 'Bp', ld: 'Ld', rd: 'Rd', lc: 'Lc', rc: 'Rc', rs: 'Rs', ams: 'Ams (DX7 voice)', kvs: 'Velocity', tl: 'Level',
  pm: 'Mode', pc: 'Coarse', pf: 'Fine', pd: 'Detune', pr: 'Peg R', pl: 'Peg L', als: 'Alg', fbl: 'Fbl', opi: 'Osc.sync', lfs: 'Speed',
  lfd: 'Delay', lpmd: 'Pmd', lamd: 'Amd', lfks: 'Sync', lfw: 'Wave', lpms: 'Pms', trnp: 'Transpose', opon: 'OP on/off',
};
const HELP = {
  ams: 'The DX7 voice\'s amplitude modulation sensitivity (0-3), kept for DX7 compatibility; the DX7II plays the 0-7 Ams of the additional data.',
  trnp: 'Transpose: the note middle C plays (C3 = none).',
};

/** ACED parameters (offset = ACED byte; the builder adds the voice size). */
function acedParams(variant = {}) {
  const MAX = FW.ACED_MAX.items;
  const ps = [];
  // variant.aced: {key: {label, options, help...}}, a model's own screen texts for a byte (the DX7s)
  const P = (aced, key, label, group, section, extra = {}) => ps.push({ key, label, aced, min: 0, max: MAX[aced], group, section, ...extra, ...(variant.aced?.[key.replace(/^op\d_/, 'op_')] || {}) });
  for (let op = 1; op <= 6; op++) {
    P(6 - op, `op${op}_scm`, 'Scaling mode', `OP${op} Keyboard level scaling`, `op${op}`, { options: opts(list('FA13', 'FA1E')), help: 'normal, or fractional scaling (set on the Fractional scaling page).' });
    P(12 - op, `op${op}_ams7`, 'Ams', `OP${op} Output and sensitivity`, `op${op}`, { help: 'Amplitude modulation sensitivity 0-7.' });
  }
  P(12, 'pegr', 'Peg Rng', 'Pitch EG', 'voice', { options: opts(list('FAEF', 'FAF3', 'FAF7', 'FAFB')), help: 'Pitch EG range in octaves (8, 2, 1, 1/2).' });
  P(14, 'vpsw', 'Peg Vel', 'Pitch EG', 'voice', { options: opts(OFFON), help: 'Velocity changes the pitch EG.' });
  P(38, 'pgrs', 'Peg Rs', 'Pitch EG', 'voice', { help: 'Pitch EG rate scaling.' });
  P(13, 'ltrg', 'LFO Mode', 'LFO', 'voice', { options: opts(list('FD13', 'FA5F')), help: 'single: one LFO for every note; multi: one per note.' });
  P(15, 'pmod', 'Key mode', 'Key mode', 'voice', { options: opts(list('FA66', 'FA72', 'FA7E', 'FA8A')), relayout: true });
  P(47, 'udtn', 'Unison detune', 'Key mode', 'voice');
  P(19, 'rndp', 'Random pitch Depth', 'Key mode', 'voice');
  P(16, 'pbr', 'Pitch bend Range', 'Pitch bend', 'voice');
  P(17, 'pbs', 'Pitch bend Step', 'Pitch bend', 'voice');
  P(18, 'pbm', 'Pitch bend Mode', 'Pitch bend', 'voice', { options: opts(list('FA13', 'FA96', 'FA9D', 'FAA4')) });
  const PORTA = variant.texts?.PORTA || [list('FAAB', 'FABC'), list('FACD', 'FADE')]; // poly, mono
  P(20, 'porm', 'Portamento Mode', 'Portamento', 'voice', { dynamic: (d) => ({ options: opts(PORTA[d[VOICE_OFF + 15] & 1]) }) });
  P(21, 'pqnt', 'Portamento Step', 'Portamento', 'voice');
  P(22, 'pos', 'Portamento Time', 'Portamento', 'voice');
  const ctl = [['mw', 'Modulation wheel', [23, 24, 25]], ['fc1', 'Foot control 1', [26, 27, 28, 29]], ['bc', 'Breath control', [30, 31, 32, 33]],
    ['at', 'After touch', [34, 35, 36, 37]], ['fc2', 'Foot control 2', [39, 40, 41, 42]], ['mc', 'MIDI IN control', [43, 44, 45, 46]]];
  for (const [k, name, offs] of ctl) {
    offs.forEach((o, i) => {
      const last = i === 3 ? (k === 'bc' || k === 'at' ? 'Pbias' : 'Vol') : ['Pmod', 'Amod', 'EGbias'][i];
      P(o, `${k}_${last.toLowerCase()}`, `${name} ${last}`, 'Controllers', 'voice', last === 'Pbias' ? { format: (v) => `${v > 50 ? '+' : ''}${v - 50}`, help: 'Pitch bias: 50 = none.' } : {});
    });
  }
  P(48, 'fccs1', 'Foot control 1 CS1', 'Controllers', 'voice', { options: opts(OFFON), help: 'Foot control 1 acts as continuous slider 1.' });
  return ps;
}
const VOICE_OFF = 156; // where the ACED starts in the voice object

// ------------------------------------------------------------------ performance (PCED, 51 bytes)
export const PCED_SIZE = 51;
const PE = 'LM  8973PE';
const PM = 'LM  8973PM';
const voiceOpts = Array.from({ length: 128 }, (_, i) => [i, i < 64 ? `I${String(i + 1).padStart(2, '0')}` : `C${String(i - 63).padStart(2, '0')}`]);
// PCED byte 3 as the micro tuning page shows it (98AF): Preset 1-11, User 1-2, CRT 1-; names from table 859C.
const [MT_PRESET, MT_USER, MT_CRT] = FW.MICRO_GROUPS.items;
const MICRO_OPTS = Array.from({ length: FW.PCED_MAX.items[3] + 1 }, (_, i) => {
  const name = FW.MICRO_NAMES.items[Math.min(i, 13)];
  return [i, i < 11 ? `${MT_PRESET} ${i + 1} ${name}` : i < 13 ? `${MT_USER} ${i - 10} ${name}` : `${MT_CRT} ${i - 12} ${name}`];
});
const FOOT_SW = FW.VALUES2.items.filter((x) => ['FD7C', 'FD87', 'FD92', 'FD9D'].includes(x.addr)).map((x) => x.text.trim());
function pcedParams(variant) {
  const MAX = FW.PCED_MAX.items;
  const ps = [];
  const P = (o, label, group, extra = {}) => ps.push({ key: `p${o}`, label, offset: o, min: 0, max: MAX[o] ?? 127, group, ...extra });
  P(0, 'Voice mode', 'Voices', { options: opts(list('FD13', 'FD1A', 'FD21')), relayout: true });
  P(1, 'Voice A', 'Voices', { options: voiceOpts });
  P(2, 'Voice B', 'Voices', { options: voiceOpts, dynamic: (d) => ({ hidden: variant.single || d[0] === 0 }) });
  P(16, 'Total volume', 'Voices');
  P(15, 'Balance', 'Voices', { format: (v) => `${v > 50 ? '+' : ''}${v - 50}`, help: 'Output balance A/B: 50 = centre.' });
  P(6, 'Dual detune', 'Voices');
  P(7, 'Split point', 'Voices', { options: Array.from({ length: 128 }, (_, n) => [n, NOTE(n)]) });
  P(13, 'Note shift A', 'Voices', { format: (v) => `${v > 24 ? '+' : ''}${v - 24}` });
  P(14, 'Note shift B', 'Voices', { format: (v) => `${v > 24 ? '+' : ''}${v - 24}` });
  P(3, 'Micro tuning table', 'Micro tuning', { options: MICRO_OPTS, help: 'Micro tuning >Table select: Preset 1-11, the two internal user tables, or the cartridge\'s.' });
  P(4, 'Micro tuning key', 'Micro tuning', { options: opts(FW.NOTES.items.map((t) => t.trim())), help: 'The key of Pure (Major), Pure (Minor), Mean tone and Pythagorean (presets 2-5; the page shows >Key for them only).' });
  P(5, 'Micro tuning A B', 'Micro tuning', { options: opts(AB) });
  P(17, 'Continuous slider 1', 'Controllers', { options: opts(FW.CS_ASSIGN.items.map(csName)) });
  P(18, 'Continuous slider 2', 'Controllers', { options: opts(FW.CS_ASSIGN.items.map(csName)) });
  P(19, 'Continuous slider switch', 'Controllers', { input: 'number', help: '0-15: the A/B switches of the two sliders, one bit each.' });
  P(9, 'Sustain foot switch', 'Controllers', { options: opts(AB) });
  P(10, 'Foot switch Select', 'Controllers', { options: opts(FOOT_SW), relayout: true, help: 'Foot switch >Select: what the foot switch does.' });
  P(11, 'Foot switch A B', 'Controllers', { options: opts(AB) });
  P(8, 'EG forced damp', 'Controllers', { options: opts(OFFON) });
  P(12, 'Soft pedal range', 'Controllers', { dynamic: (d) => ({ hidden: d[10] !== 3 }), help: 'Foot switch >Range (0-7): the soft pedal range, shown when the foot switch is Soft.' });
  P(20, 'PAN Mode', 'PAN', { options: opts(list('FAFF', 'FB0F', 'FB1F', 'FB2F')) });
  P(21, 'PAN Range', 'PAN');
  P(22, 'PAN Select', 'PAN', { options: opts(list('FC2B', 'FC37', 'FC43')) });
  for (let i = 0; i < 4; i++) P(23 + i, `PAN EG R${i + 1}`, 'PAN EG');
  for (let i = 0; i < 4; i++) P(27 + i, `PAN EG L${i + 1}`, 'PAN EG');
  for (let i = 0; i < 20; i++) P(31 + i, `Name ${i + 1}`, 'Name', { max: 127, hidden: true });
  variant.pced?.(ps);
  return ps;
}
// The continuous slider list names an operator parameter once per operator (OP1-OP6, in order).
let csSeen = {};
function csName(t, i) {
  if (i === 0) csSeen = {};
  csSeen[t] = (csSeen[t] || 0) + 1;
  const many = FW.CS_ASSIGN.items.filter((x) => x === t).length > 1;
  return many ? `${t} OP${csSeen[t]}` : t;
}
const isPced = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === PE && b.body.length === PCED_SIZE); };
const isPmem = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === PM); };
const isOther = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7e && FW.HEADERS.items.some((h) => h.header.slice(0, 9) === b.header?.slice(0, 9))); };
const isAmem = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 6 && b.data.length === 32 * 35); };

function pcedToCommon(d, model) {
  const mode = d[0];
  const part = (v, shift, bal) => ({ on: true, channel: 0, program: v, transpose: shift - 24, level: bal });
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: ['single', 'layer', 'split'][mode] || 'single', splitPoint: d[7],
    parts: mode ? [part(d[1], d[13], Math.min(1, (100 - d[15]) / 50)), part(d[2], d[14], Math.min(1, d[15] / 50))] : [part(d[1], d[13], 1)],
    extra: { family: 'yamaha-dx', model, pced: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d.subarray(0, 31))) },
  };
}
function pcedFromCommon(c, init, variant) {
  const report = emptyReport();
  const d = init();
  if (c?.extra?.family === 'yamaha-dx' && c.extra.pced && fromBase64(c.extra.pced).length === PCED_SIZE) {
    d.set(fromBase64(c.extra.pced));
    report.mapped.push(`the whole performance (${c.extra.model})`);
    if (variant.single && d[0]) { d[0] = 0; report.dropped.push('voice B (single voice mode only)'); }
    return { data: d, report };
  }
  const parts = (c?.parts || []).filter((p) => p.on !== false);
  const prog = (p) => (Number.isInteger(p?.program) ? Math.max(0, Math.min(127, p.program)) : 0);
  if (parts[0]) { d[1] = prog(parts[0]); d[13] = Math.max(0, Math.min(48, 24 + Math.round(parts[0].transpose || 0))); report.mapped.push('voice A'); }
  if (parts[1] && !variant.single) {
    d[2] = prog(parts[1]);
    d[14] = Math.max(0, Math.min(48, 24 + Math.round(parts[1].transpose || 0)));
    d[0] = c.keyMode === 'split' ? 2 : 1;
    if (c.keyMode === 'split' && Number.isInteger(c.splitPoint)) d[7] = c.splitPoint;
    report.mapped.push('voice B and the voice mode');
  }
  if (variant.single) d[0] = 0;
  if (parts.length > (variant.single ? 1 : 2)) report.dropped.push(`parts after the ${variant.single ? 'first' : 'second'}`);
  return { data: d, report: tidy(report) };
}

const pad2 = (n) => String(n).padStart(2, '0');
/**
 * The 64 internal voices and the cartridge's 64 (variant.banks64: the DX7II and the DX7s). A 32-voice bulk carries
 * the 32 of system byte 12 "MIDI out voice bank" (VMEM at RAM 2000h or 3000h, L B520; AMEM 4000h or 4340h, L B561)
 * and goes into those of byte 13 "Receive block" (L AF74, AFB4; DX7s: system at 3058h, C256 / CA2A). A program
 * change selects I01-I64 with 0-63 and C01-C64 with 64-127 in voice play mode (L A3F6 queues event 0Bh to the upper
 * bank, U 8309: bit 6 = cartridge, stored as the voice number 5056h; DX7s 8A1C the same); in dual or split mode it
 * selects voice A on receive channel A and voice B on channel B (events 15h/16h, U 83E1 / 840D); while the panel
 * selects performances (RAM 536Eh bit 0, U 8890) it selects performance 1-32 (event 17h, U 8EE7). The editor sets
 * byte 12 (19h 4Ch) to read a bank and byte 13 (19h 4Dh) to write one, each back to the unit's value afterwards
 * (the system setup is read first).
 */
function voiceBanks(variant, ch) {
  const sysOf = (ctx) => (ctx?.loaded?.has?.('system') ? ctx.data?.system : null);
  const setSys = (c, o, v) => paramChange(c, 6, D2.sysNum(o), v);
  return {
    banks: [[0, 'INTERNAL I01-I32'], [1, 'INTERNAL I33-I64'], [2, 'CARTRIDGE C01-C64']],
    internal: (b) => b < 2,
    count: (b) => (b === 2 ? 64 : 32),
    program: (b, i) => (b === 2 ? 64 + i : 32 * b + i),
    slotOf: (n) => (n < 64 ? [n >> 5, n & 31] : [2, n - 64]),
    slotLabel: (b, i) => (b === 2 ? `C${pad2(i + 1)}` : `I${pad2(32 * b + i + 1)}`),
    read: async (api, b, go) => {
      const c = ch(api.ctx);
      const sys = Uint8Array.from(parseBulk(await api.request(dumpRequestHeader(c, D2.SYS), D2.isSys, (r) => r)).body);
      if (api.g?.setObjectData) api.g.setObjectData('system', sys);
      const was = sys[12] ? 1 : 0;
      if (was !== b) api.send(setSys(c, 12, b));
      try { return await go(); } finally { if (was !== b) api.send(setSys(c, 12, was)); }
    },
    storeMsgs: (ctx, b, msgs) => {
      const was = sysOf(ctx)?.[13] ? 1 : 0;
      return was === b ? msgs : [setSys(ch(ctx), 13, b), ...msgs, setSys(ch(ctx), 13, was)];
    },
    storeNote: '(the editor switches the Receive block to this bank for it, then back)',
    outBank: (ctx) => (sysOf(ctx)?.[12] ? 1 : 0),
    simOut: (unit) => (unit.sys?.[12] ? 1 : 0),
    simIn: (unit) => (unit.sys?.[13] ? 1 : 0),
    notes: { 2: `Edit selects the voice and reads the edit buffer; Read names reads each in turn. With no cartridge in, the ${variant.name} keeps the voice it had, so Edit reads that one. The cartridge's voices have no bulk dump: Store is not offered.` },
  };
}

/**
 * The parameter number of an ACED byte (U E5EC): 0-38 as they are, 39-48 as 40h-49h. variant.acedLow (the
 * TX802, which keeps bytes 0-38 only) leaves every byte at its own number.
 */
export const acedNum = (aced) => (aced < 39 ? aced : aced + 25);

/** A DX7II-family definition. variant: {id, name, single (no dual/split), coverage...}. */
export function buildDX7II(variant) {
  const initVoice = () => Uint8Array.from([...FW.INIT_VCED.items, ...FW.INIT_ACED.items]);
  const initPerf = () => Uint8Array.from(FW.INIT_PCED.items);
  const ch = (ctx) => ctx?.channel ?? 0;
  const own = !variant.noPerformance; // the DX7II's own performance, system, micro tuning and fractional scaling
  const num = (aced) => (variant.acedLow ? aced : acedNum(aced));
  const acedOfNum = (n) => (variant.acedLow ? n : n < 39 ? n : n >= 64 && n < 74 ? n - 25 : -1);
  return buildDX({
    id: variant.id,
    name: variant.name,
    fw: { ...DX7II_TEXTS, ...(variant.texts || {}), INIT: Array.from(vcedToVmem(Uint8Array.from(FW.INIT_VCED.items))) },
    initVoice,
    labels: { ...DX7II_LABELS, ...(variant.labels || {}) },
    help: { ...HELP, ...(variant.help || {}) },
    stage: (t, n) => `${t}${n}`,
    aced: { size: 49, format: 5, group: 6, label: 'additional voice data (ACED)', params: acedParams(variant) },
    amem: variant.noAmem ? null : { format: 6, size: D2.AMEM_SIZE, pack: D2.packAced, unpack: D2.unpackAmem, fromVoice: D2.acedFromVoice },
    voiceBanks: variant.voiceBanks ? variant.voiceBanks(ch) : variant.banks64 ? voiceBanks(variant, ch) : null,
    requests: true,
    functionParams: null,
    formats: [5, 6, 0x7e],
    deviceIds: variant.deviceIds || [],
    bankNote: variant.noAmem ? 'Memory protect INT must be off. The voices\' additional settings are not sent with them.'
      : 'Memory protect INT must be off. The voices\' additional settings go first, as the unit needs them: a bank without them gets them made from the voices.',
    coverage: variant.coverage,
    notes: { voice: `Get from device reads the voice being edited on the ${variant.name}, with its additional settings. Each change is sent as you make it.` },
    moreRequests: [
      ...(variant.noPerformance ? (variant.requests || []) : [
        { label: 'Performance edit buffer', bytes: (ctx) => dumpRequestHeader(ch(ctx), PE) },
        { label: '32 performances', bytes: (ctx) => dumpRequestHeader(ch(ctx), PM), timeout: 4000 },
      ]),
      { label: 'Additional data of 32 voices (AMEM)', bytes: (ctx) => dumpRequest(ch(ctx), 6), timeout: 3000 },
      ...(variant.noSystemRequest ? [] : [{ label: 'System setup', bytes: (ctx) => dumpRequestHeader(ch(ctx), D2.SYS) }]),
      { label: 'Micro tuning edit buffer', bytes: (ctx) => dumpRequestHeader(ch(ctx), D2.MCRYE) },
      ...(own ? [0, 1].map((t) => ({ label: `Micro tuning user table ${t + 1}`, bytes: (ctx) => dumpRequestHeader(ch(ctx), D2.mcrym(t)) })) : []),
      { label: 'Fractional scaling edit buffer', bytes: (ctx) => dumpRequestHeader(ch(ctx), D2.FKSYE) },
    ],
    recognise: (raw) => isPced(raw) || isPmem(raw) || isAmem(raw) || isOther(raw) || !!variant.recognise?.(raw),
    // ACED or DX7II headers say DX7II family; a plain DX7 voice reads better on a DX7
    prefer: (msgs) => (msgs.some((m) => variant.recognise?.(m)) ? 4 : msgs.some((m) => isPced(m) || isPmem(m) || isAmem(m) || isOther(m) || parseBulk(m)?.format === 5) ? 2 + (variant.preferBonus || 0) : 0.8),
    libraryItem: (m, k, msgs) => {
      const mine = variant.libraryItem?.(m, k, msgs);
      if (mine) return mine;
      if (isPced(m)) { const d = parseBulk(m).body; return [{ key: `p${k}`, label: `Performance "${textAt(d, 31, 20)}"`, name: textAt(d, 31, 20), object: 'performance', data: Uint8Array.from(d), msgs: [m] }]; }
      if (isPmem(m)) {
        const body = parseBulk(m).body;
        return Array.from({ length: Math.floor(body.length / PCED_SIZE) }, (_, i) => {
          const d = Uint8Array.from(body.subarray(i * PCED_SIZE, (i + 1) * PCED_SIZE));
          return { key: `pm${k}-${i}`, label: `${String(i + 1).padStart(2, '0')} ${textAt(d, 31, 20)}`, name: textAt(d, 31, 20), object: 'performance', data: d, msgs: [Uint8Array.from(bulkHeader(parseBulk(m).channel, PE, d))] };
        });
      }
      if (own) { const items = D2.dataItems(m, k, msgs); if (items) return items; }
      if (isAmem(m)) return [{ key: `am${k}`, label: 'Additional data of 32 voices (AMEM, without its voices)', name: '', msgs: [m] }];
      if (isOther(m) || variant.recognise?.(m)) return [{ key: `o${k}`, label: parseBulk(m).header.trim(), name: '', msgs: [m] }];
      return null;
    },
    simulateRequest: (unit, d) => {
      const hdr = d[3] === 0x7e ? String.fromCharCode(...d.slice(4, 14)) : '';
      if (variant.simulateRequest) return variant.simulateRequest(unit, d, hdr);
      if (hdr === PE) return [bulkHeader(d[2] & 15, PE, unit.perf ||= initPerf())];
      return (own && D2.simulateRequest(unit, d, hdr)) || [];
    },
    simulateBulk: (unit, b, d) => {
      if (variant.simulateBulk) return variant.simulateBulk(unit, b, d);
      if (b?.ok && b.header === PE) unit.perf = Uint8Array.from(b.body);
      else if (own) D2.simulateBulk(unit, d);
      return [];
    },
    simulateParam: (unit, pc, d) => {
      if (variant.simulateParam) return variant.simulateParam(unit, pc, d);
      if (pc.group === 6 && pc.num >= 64 && pc.num < 74 && !variant.acedLow) unit.voice[VOICE_OFF + pc.num - 25] = pc.value;
      if (own && pc.group === 6 && pc.num >= 128 && pc.num < 128 + PCED_SIZE) (unit.perf ||= initPerf())[pc.num - 128] = pc.value;
      else if (own) D2.simulateBulk(unit, d);
      return undefined;
    },
    // Edit in the slot list: select the voice, then read the edit buffer (exact, with its additional data).
    selectFetch: variant.selectFetch || (async (api, i, { ch: c, full, isAced }) => {
      api.send([0xc0 | c(api.ctx), i]);
      await sleep(250);
      const ac = await api.request(dumpRequest(c(api.ctx), 5), isAced, (r) => r);
      const vc = await api.request(dumpRequest(c(api.ctx), 0), (r) => { const b = parseBulk(r); return !!(b?.ok && b.format === 0 && b.data.length === VCED_SIZE); }, (r) => r);
      return full(parseBulk(vc).data, parseBulk(ac).data);
    }),
    extend(def, { full, isAced }) {
      const v = def.objects.find((o) => o.key === 'voice');
      v.fetch = async (api) => {
        const ac = await api.request(dumpRequest(ch(api.ctx), 5), isAced, (r) => r);
        const vc = await api.request(dumpRequest(ch(api.ctx), 0), (r) => { const b = parseBulk(r); return !!(b?.ok && b.format === 0 && b.data.length === VCED_SIZE); }, (r) => r);
        return full(parseBulk(vc).data, parseBulk(ac).data);
      };
      // ACED bytes 39-48 are parameters 40h-49h (U E5EC / E672); the shared code sends the byte number.
      const baseSend = v.sendParam;
      v.sendParam = (p, val, d, ctx) => (p.aced !== undefined ? paramChange(ch(ctx), 6, num(p.aced), d[p.offset]) : baseSend(p, val, d, ctx));
      const baseReceive = v.receive;
      v.receive = (raw, d, ctx) => {
        const pc = parseParamChange(raw);
        if (pc && pc.group === 6 && pc.num < 128 && pc.channel === ch(ctx)) {
          const a = acedOfNum(pc.num);
          if (a < 0 || a >= 49) return null;
          const next = Uint8Array.from(d);
          next[VOICE_OFF + a] = pc.value;
          return next;
        }
        return baseReceive(raw, d, ctx);
      };
      v.layout.splice(4, 0, { group: 'Key mode' }, { group: 'Pitch bend' }, { group: 'Portamento' },
        { group: 'Controllers', wide: true, rows: [['mw', 'Modulation wheel', ['pmod', 'amod', 'egbias']], ['fc1', 'Foot control 1', ['pmod', 'amod', 'egbias', 'vol']], ['bc', 'Breath control', ['pmod', 'amod', 'egbias', 'pbias']], ['at', 'After touch', ['pmod', 'amod', 'egbias', 'pbias']], ['fc2', 'Foot control 2', ['pmod', 'amod', 'egbias', 'vol']], ['mc', 'MIDI IN control', ['pmod', 'amod', 'egbias', 'vol']]].map(([k, l, f]) => ({ label: l, keys: [...f.map((x) => `${k}_${x}`), ...(k === 'fc1' ? ['fccs1'] : [])] })) });
      variant.voice?.(v);
      if (variant.noPerformance) { variant.extend?.(def, { ch }); return; }
      const params = pcedParams(variant);
      def.objects.push({
        key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: PCED_SIZE,
        init: initPerf, params, cols: 3,
        request: (ctx) => dumpRequestHeader(ch(ctx), PE),
        match: isPced,
        decode: (raw) => Uint8Array.from(parseBulk(raw).body),
        name: (d) => textAt(d, 31, 20),
        setName: (d, name) => { for (let i = 0; i < 20; i++) d[31 + i] = Math.max(32, Math.min(126, String(name ?? '').charCodeAt(i) || 32)); return d; },
        note: variant.single ? `The ${variant.name} plays one voice per performance: voice B, dual and split are kept but not used.` : 'Voice A and B play on the receive channels A and B of the system setup.',
        // F0 43 1n 19 pp vv F7: group 6, bit 7 of the number set (U E6AF takes pp 0-32h)
        sendParam: (p, _v, d, c2) => paramChange(ch(c2), 6, 128 + p.offset, d[p.offset]),
        receive: (raw, d, c2) => {
          if (isPced(raw)) return Uint8Array.from(parseBulk(raw).body);
          const pc = parseParamChange(raw);
          if (!pc || pc.channel !== ch(c2) || pc.group !== 6 || pc.num < 128 || pc.num >= 128 + PCED_SIZE) return null;
          const next = Uint8Array.from(d);
          next[pc.num - 128] = pc.value;
          return next;
        },
        sendAll: { label: 'Send', title: 'Send the performance to the unit\'s edit buffer', build: (d, c2) => bulkHeader(ch(c2), PE, d) },
        toSyx: (d, c2) => bulkHeader(ch(c2), PE, d),
        fromSyx: (msgs) => { const m = msgs.find(isPced); return m ? Uint8Array.from(parseBulk(m).body) : null; },
        actions: [{
          label: 'Rename', run: async (api) => {
            const r = await api.form('Performance name', [{ key: 'name', label: 'Name (20 characters)', value: textAt(api.data, 31, 20), maxlength: 20 }]);
            if (!r) return;
            const d = Uint8Array.from(api.data);
            for (let i = 0; i < 20; i++) d[31 + i] = Math.max(32, Math.min(126, r.name.charCodeAt(i) || 32));
            api.send(bulkHeader(ch(api.ctx), PE, d));
            api.setData(d);
          },
        }],
        toCommon: (d) => pcedToCommon(d, variant.name),
        fromCommon: (c) => pcedFromCommon(c, initPerf, variant),
      });
      def.objects.push(D2.systemObject(variant, ch), D2.microTuningObject(variant, ch), D2.fractionalObject(variant, ch));
      variant.extend?.(def, { ch });
    },
  });
}

const def = buildDX7II({
  id: 'yamaha-dx7ii',
  name: 'DX7II',
  banks64: true,
  deviceIds: ['yamaha-dx7s'],
  coverage: 'Edits the DX7II\'s voices, performances, system setup, micro tunings and fractional scaling. Every voice parameter with all of the additional voice settings (scaling mode, Ams 0-7, pitch EG range / velocity / rate scaling, LFO mode, key mode, unison, random pitch, pitch bend, portamento, six controllers), the performance (voice mode, voices A and B, balance, detune, split, note shift, micro tuning, sliders, foot switches, PAN and PAN EG), the system setup (MIDI pages, cartridge banks, master tuning, program change table), micro tuning (edit buffer and user tables) and fractional scaling, and the internal voices with their additional settings, all with the DX7II\'s own names, value lists, ranges and initial values. Not yet checked on a DX7II.',
});

export const _test = { acedParams, pcedParams, isPced, PE };
export default def;
