// Novation SuperNova (model 20) and Nova (model 21), both on OS 4.1: one builder for the two
// editors, made from their own OS images (decoded from Novation's OS-update MIDI files with
// tools/novation/os_mid.py; see docs/devices/novation-supernova.md and novation-nova.md).
//
// Both are Hitachi H8/300H images linear from 0, the same code base as the SuperNova II. SysEx
// F0 00 20 29 01 mm dd tt ... F7 (dd the global channel or 7F). Receiver: model bytes 20-25 accepted
// (SuperNova 143FA, Nova 15A32); expected lengths per type (SuperNova table 36A7C, Nova 36D4C):
//   00 pp <286> program edit buffer      02 bb nn <286> program in memory
//   05 <372> performance edit buffer     07 bb nn <372> performance in memory
//   0F <272> global (16 settings and the program change map)   15 <288> global, second part
//   0A pp <194> / 0C pp <194> arpeggio pattern; 03 08 10 13 requests; 12 14 16 bank/pattern requests
//   Nova only: 1B <16> / 1C bb nn <16> the performance's vocoder settings, 1D 1 byte
// Types 01 02 06 07 0B 0C 0F 15 16 write memory and are refused while Memory protect is on (RAM
// 23496 / 27498 = 78h). The SuperNova accepts types 00-16, the Nova 00-1D.
//
// Program bytes: the controller map (CC/NRPN -> byte; SuperNova 36AAA, Nova 36D88) is the SuperNova
// II Rack OS 2.0 table (6525C) word for word, and every CC, NRPN and packed-NRPN setter (SuperNova
// tables 87C2, 8E86, 921E, D3AC) writes the same byte and bits as the SuperNova II's, except CC 9
// (no program-mode arpeggio speed), NRPN 102 (no program vocoder balance) and NRPN 1 59-69, 94-97.
// So the SuperNova II's first-format parameters apply; labels, ranges and lists are this OS's menus
// (menu records 3A944-3F88A on the SuperNova, 3A7B2-3F676 on the Nova).

import { named } from '../../core/model/memmap.js';
import * as SN2 from './novation-supernova2.js';
import * as TR from './novation-supernova2-translate.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';

export const PROG = 286;
export const PERF = 372;
export const VOC = 16;
export const GLOB = 272;
export const GLOB_EXT = 288;
const MAKER = [0x00, 0x20, 0x29, 0x01];
const PART = SN2._test.PART; // part n at 20 + 44n
const G2 = GLOB;
const num = (i) => String(i).padStart(3, '0');
const P = (offset, label, group, section, extra = {}) => ({ offset, label, group, section, ...extra });
const RES = (o, label, group, section, help, mask = 0x7f) => P(o, label, group, section, {
  input: 'number', readOnly: true, min: 0, max: 127, help,
  ...(mask === 0x7f ? {} : { get: (d) => d[o] & mask, set: (d, v) => { d[o] = (d[o] & ~mask) | (v & mask); } }),
});
const opts = (list, first = 0) => named(list, first);
const ON_OFF_INV = ['On', 'Off'];

/** Labels the OS 4.1 menus use for SuperNova II parameters at the same byte (same menu field id). */
const RENAME = {
  Semitone: 'Coarse tune', 'Harden level': 'Soften level', 'Noise harden level': 'Noise soften level',
  'Speed 1': 'Speed', 'Wheel level': 'Chorus wheel', Keysync: 'Key reset', 'Sus/sw2': 'Sustain',
};
const rename = (l) => RENAME[l] ?? l.replace(/^Harden mod\./, 'Soften mod.').replace(/^Noise harden mod\./, 'Noise soften mod.');

/** Program parameters the OS 4.1 does not have (setter missing or OS 2 only), dropped from the SuperNova II list. */
const PROG_DROP = new Set(['Vocoder balance', 'Vocoder input (program mode)', 'Drum one-shot', 'Fill in', 'Note ordering',
  'Arp gate time (OS 1)', 'Filter width step (derived)', 'VCO drift on (derived)', 'Format marker', 'Format marker (2)', 'Arp mute', 'Constant gate', 'Category', 'Pattern bank']);
const CATEGORIES = ['Bass', 'Hard bass', 'Soft lead', 'Hard lead', 'Portalead', 'Arpeggio', 'Motion', 'Bell', 'Pad', 'Strings', 'Keyboard', 'SFX', 'Drums', 'Pianos', 'Organ', 'User 1', 'User 2', 'User 3', 'User 4', 'User 5'];
const CHORUS_TYPES = ['Quad chorus', 'Chorus/flanger', 'Phaser']; // menu 'Type' 52-54 (OS 4.1 order; the SuperNova II lists Phaser first)

function programParams(V) {
  const base = SN2.programParams.filter((p) => p.offset < PROG && p.group !== 'Spare bytes' && !PROG_DROP.has(p.label))
    .map((p) => ({ ...p, label: rename(p.label), ...(p.label === 'Osc page' ? { options: p.options.map(([v, n]) => [v, n === 'Harden' ? 'Soften' : n]) } : {}), ...(p.offset === 239 ? { help: 'The arpeggio speed a program keeps, as on the SuperNova II (on this model CC 9 does not change it; the factory programs carry values)' } : {}) }));
  const voice = 'voice';
  return [
    ...base,
    P(17, 'Category', 'Program', voice, { options: opts(CATEGORIES), help: 'Menu "Category -" (0-19): User 1-5 where the SuperNova II has Brass and User 1-4' }),
    P(209, 'Filter width', 'Filter', 'filter', { bits: 3, options: opts(['00', '08', '16', '24', '32', '40', '48', '56']), help: 'Menu values 102-109. The SuperNova II derives this byte from its own 0-127 filter width' }),
    P(209, 'DCO / VCO mode', 'Voice', voice, { shift: 3, bits: 1, options: opts(['DCO', 'VCO']), help: 'Menu values 92/93' }),
    ...(V.constantGate ? [P(237, 'Constant gate', 'Voice', voice, { shift: 3, bits: 1, options: opts(['Off', 'On']), help: 'Nova menu values 79/80' })] : []),
    P(240, 'Pattern bank', 'Arpeggiator', 'arp', { options: opts(['Mono', 'Poly', 'User'], 76) }),
    P(244, 'Fill in', 'Arpeggiator', 'arp', { options: opts(['Off - Up', 'On - Up', 'Off - Down', 'On - Down', 'Off - Played', 'On - Played'], 122), help: 'Fill in and note order in one menu field (122-127)' }),
    P(253, 'Gate time', 'Arpeggiator', 'arp', { options: opts(['25%', '50%', '75%', '99%']), help: 'Menu values 5-8' }),
    P(249, 'Mute status', 'Arpeggiator', 'arp', { bits: 1, options: opts(['Sounding', 'Muted']), help: 'Menu values 90/91' }),
    P(254 + 21, 'Type', 'Chorus', 'fx', { bits: 2, options: opts(CHORUS_TYPES), help: 'Menu values 52-54' }),
    P(238, 'Format marker', 'Format', voice, { shift: 6, bits: 1, readOnly: true, options: opts(['Off', 'On']), help: 'Set before a program is sent, as on the SuperNova II; shown for information' }),
    P(249, 'Format marker (2)', 'Format', voice, { shift: 2, bits: 1, readOnly: true, options: opts(['Off', 'On']), help: 'Marks programs in the newer value scale; without it the synth converts the program when it arrives' }),
    RES(16, '00: 10h', 'Reserved', voice, 'The SuperNova II\'s program-mode vocoder balance (NRPN 102); OS 4.1 has no handler for NRPN 102'),
  ];
}

/** Performance (message 05, and 1B on the Nova). */
function performanceParams(V) {
  const keep = (p) => p.offset < PERF && p.group !== 'Spare bytes' && p.section !== 'keyboard' && p.label !== 'Expression pedal (Nova)';
  const SUS = ['Enable', 'Arp latch', 'Arp mute', 'Part mute', 'Enable(I)', 'Arp latch(I)', 'Arp mute(I)', 'Part mute(I)', 'Program + 1', 'Program - 1', 'Pattern + 1', 'Pattern - 1', ...(V.vocoder ? ['Voc freeze'] : []), 'Off'];
  const OUTS = ['1 & 2', '3 & 4', '5 & 6', '7 & 8'].slice(0, V.parts === 6 ? 3 : 4);
  const banks = V.progBanks;
  const out = SN2.performanceParams.filter(keep).map((p) => {
    const q = { ...p, label: rename(p.label) };
    const part = /^part(\d)$/.exec(p.section);
    if (q.label === 'Sustain') q.options = opts(SUS, 77);
    if (q.label === 'Part outputs') q.options = opts(OUTS, 98);
    if (q.label === 'Bank' && part) q.options = banks;
    if (q.label === 'MIDI channel' && !V.vocoder) q.label = 'Midi channel';
    if (part && Number(part[1]) >= V.parts) Object.assign(q, { readOnly: true, help: `The ${V.name} has ${V.parts} parts; kept so a backup restores exactly` });
    return q;
  });
  for (let i = 0; i < 8; i++) {
    const ro = i >= V.parts ? { readOnly: true } : {};
    out.push(P(PART(i) + 12 + 21, 'Type', 'FX Chorus', `part${i}`, { bits: 2, options: opts(CHORUS_TYPES), ...ro }));
    if (V.vocoder) out.push(P(PART(i) + 10, 'Expression pedal', 'MIDI', `part${i}`, { shift: 5, bits: 1, options: opts(['Off', 'On']), help: 'Nova menu values 118/119', ...ro }));
  }
  if (V.vocoder) {
    const X = PERF;
    const parts = Array.from({ length: V.parts }, (_, i) => `Part ${i + 1}`);
    out.push(
      P(X, 'Format', 'Vocoder', 'common', { input: 'number', readOnly: true, help: '21h in the Nova\'s factory data' }),
      P(X + 1, 'Voc input', 'Vocoder', 'common', { options: opts(['Input (1)', 'Input (2)', ...parts], 18), help: 'Menu values 18-25 (a higher value is taken as 25)' }),
      P(X + 2, 'Voc insert', 'Vocoder', 'common', { options: opts(parts, 28), help: 'Menu values 28-33 (a higher value is taken as 33)' }),
      P(X + 3, 'Vocoder width', 'Vocoder', 'common', { bias: 112, min: 0, max: 15, help: 'Menu values 112-127' }),
      P(X + 4, 'Vocoder balance', 'Vocoder', 'common', { min: 0, max: 127 }),
      P(X + 6, 'Sibilance level', 'Vocoder', 'common', { bias: 96, min: 0, max: 15, help: 'Menu values 96-111' }),
      P(X + 7, 'Sibilance type', 'Vocoder', 'common', { options: opts(['Hpass', 'Noise']), help: 'Menu values 16/17' }),
      RES(X + 5, '1B: 05h', 'Reserved', 'common', 'No Nova menu field, CC or NRPN writes it; 3 or 4 in the factory performances. The transmitter (16EE0) takes the block from the performance at +148h and sends this byte as stored; the receiver fix-up (1761C) limits bytes 1-2 only; no other code addresses the block at a fixed offset'),
      ...Array.from({ length: 8 }, (_, i) => RES(X + 8 + i, `1B: ${(8 + i).toString(16).toUpperCase().padStart(2, '0')}h`, 'Reserved', 'common', i === 0 ? 'No Nova menu field, CC or NRPN writes it; sent as stored (transmitter 16EE0); 0 in the factory performances' : 'The transmitter clears it before sending (Nova 16F18-16F34): never sent other than 0')),
    );
  }
  return out;
}

/** Global: message 0F (272) then message 15 (288), the SuperNova II layout (same RAM order, base 23486 on the SuperNova, 27488 on the Nova). */
const GLOBAL_DROP = new Set(['Aftertouch Tx (Keyboard)', 'Key velocity Tx (Keyboard)', 'Arp kbd notes Tx (Keyboard)', 'Input/sw 1', 'Input/sw 2', 'Pedal/sw 3', 'Gain 1', 'Gain 2',
  'Button clicks', 'Sysex Tx delay', 'Temp disp time', 'User pattern bank', 'Sample rate', 'Sync', 'Opt in', 'Opt out', 'Elect in', 'Elect out', 'Format']);
function globalParams(V) {
  const G = 'global';
  const within = (p, [lo, hi]) => p.options.filter(([v]) => v >= lo && v <= hi);
  const mapBanks = [[0, 'Current bank'], ...V.perfBanks, ...V.progBanks];
  const base = SN2.globalParams.filter((p) => !GLOBAL_DROP.has(p.label) && p.group !== 'Reserved').map((p) => {
    const q = { ...p };
    if (q.label === 'Pedal/breath') q.label = 'Breath control';
    if (q.label === 'MIDI clock') q.options = opts(['Int', 'Ext'], 105);
    if (q.label === 'Sysex transmission') Object.assign(q, { options: within(q, V.sysexTx), help: `The dump the MIDI button sends (menu values ${V.sysexTx.join('-')})` });
    if (q.label === 'Sysex reception') Object.assign(q, { options: within(q, V.sysexRx), help: `Menu values ${V.sysexRx.join('-')}` });
    if (q.label === 'Power-up program bank') Object.assign(q, { options: V.progBanks, get: undefined, set: undefined });
    if (q.label === 'Power-up performance bank') q.options = V.perfBanks;
    if (/^Map \d+ bank$/.test(q.label)) q.options = mapBanks;
    return q;
  });
  const rs = (k, help, mask) => RES(G2 + k, `15 ${k}${mask ? `: bits` : ''}`, 'Reserved', G, help, mask);
  return [
    ...base,
    P(G2, 'Format', 'MIDI', G, { input: 'number', readOnly: true, help: 'Always 21h: marks global settings of this system (OS 4.1)' }),
    ...(V.vocoder ? [
      P(G2 + 12, 'Pedal mode', 'Inputs', G, { options: opts(['Off', 'Breath-R', 'Breath-T', 'Sustain', 'Sustain-I'], 11), help: 'Menu values 11-15' }),
      P(G2 + 13, 'Headphones out', 'Inputs', G, { options: opts(['1 & 2', '3 & 4', '5 & 6', 'Mix'], 92), help: 'Menu values 92-95' }),
      P(G2 + 24, 'Trim1', 'Inputs', G, { bias: 64, min: -10, max: 10, format: (v) => `${v > 0 ? '+' : ''}${v}`, help: 'Menu values 54-74' }),
      P(G2 + 25, 'Trim2', 'Inputs', G, { bias: 64, min: -10, max: 10, format: (v) => `${v > 0 ? '+' : ''}${v}` }),
    ] : [
      rs(12, 'Always 0Bh on the SuperNova: it has no pedal setting'),
      rs(13, 'Always 5Fh on the SuperNova (not used)'),
      ...[24, 25].map((k) => rs(k, 'Always 40h on the SuperNova (not used)')),
    ]),
    RES(10, '0F 10: bits 2-6', 'Reserved', G, 'Always 0: message 0F carries the low bits; the rest travels in message 15 byte 1', 0x7c),
    RES(11, '0F 11: bits 4-6', 'Reserved', G, 'Always 0: the high bits travel in message 15 byte 2', 0x70),
    RES(13, '0F 13: bits 4-6', 'Reserved', G, 'Always 0: the high bits travel in message 15 byte 3', 0x70),
    RES(G2 + 1, '15 1: bits 0-1', 'Reserved', G, 'Always 0 (not used)', 0x03),
    RES(G2 + 2, '15 2: bits 0-3, 6', 'Reserved', G, 'Always 0 (not used)', 0x4f),
    RES(G2 + 3, '15 3: bits 0-3', 'Reserved', G, 'Always 0 (not used)', 0x0f),
    ...[4, 5, 6, 7, 8, 9, 10, 11].map((k) => rs(k, 'Always 0 (not used)')),
    RES(G2 + 14, '15 14: bits 5-6', 'Reserved', G, 'Cleared when the global settings are written; no menu field', 0x60),
    rs(15, 'No OS 4.1 menu field (the SuperNova II Keyboard keeps its favourites slot here)'),
    RES(G2 + 16, '15 16: bits 3-6', 'Reserved', G, 'Keyboard Tx flags and button clicks on the SuperNova II; no OS 4.1 menu field', 0x78),
    ...[17, 18, 19, 20, 21, 22, 23].map((k) => rs(k, 'No menu of this model sets it; sent as it is (the SuperNova II keeps inputs, Sysex Tx delay, display time, user pattern bank and digital I/O here)')),
    ...[26, 27].map((k) => rs(k, 'Always 40h (not used)')),
    ...[28, 29, 30, 31].map((k) => rs(k, 'Always 0 (not used)')),
  ];
}

// ------------------------------------------------------------------ data
function initProgram() { return SN2.initProgram().slice(0, PROG); }
function initPerformance(V) {
  const d = new Uint8Array(PERF + (V.vocoder ? VOC : 0));
  d.set(SN2.initPerformance().slice(0, PERF));
  if (V.vocoder) d.set([0x21, 18, 28, 127, 0, 3, 111, 0], PERF); // as the Nova's factory performances
  return d;
}
/** The global of the OS 4.1 factory data (total.mid): 0F settings, then message 15. */
function initGlobal() {
  const d = new Uint8Array(GLOB + GLOB_EXT);
  d.set([0, 0x66, 0x40, 0, 0x7f, 0x3c, 0x69, 0x7f, 0, 0, 2, 5, 0, 1, 0, 0x43]);
  d.set([0x21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b, 0x5f, 0, 0, 0, 0, 0, 0x64, 0x6e, 0, 0, 0, 0x40, 0x40, 0x40, 0x40], G2);
  for (let i = 0; i < 128; i++) { d[17 + 2 * i] = i; d[G2 + 33 + 2 * i] = i; }
  return d;
}
/** The map is edited in message 15's copy (as on the SuperNova II); message 0F gets the same entries. */
function mirrorMap(d) {
  const out = Uint8Array.from(d);
  for (let i = 0; i < 256; i++) out[16 + i] = d[G2 + 32 + i];
  return out;
}

export function buildOS4(V) {
  const hdr = (ctx, t) => [0xf0, ...MAKER, V.model, (ctx?.deviceId ?? 0x7f) & 0x7f, t];
  const body = (d) => Array.from(d, (x) => x & 0x7f);
  const msg = {
    currentProgramRequest: (ctx) => [...hdr(ctx, 0x03), 0xf7],
    currentPerformanceRequest: (ctx) => [...hdr(ctx, 0x08), 0xf7],
    globalRequest: (ctx) => [...hdr(ctx, 0x10), 0xf7],
    singleRequest: (ctx, bank, slot) => [...hdr(ctx, 0x13), bank, slot, 0xf7],
    program: (ctx, d, part = 9) => [...hdr(ctx, 0x00), part, ...body(d.slice(0, PROG)), 0xf7],
    storeProgram: (ctx, bank, slot, d) => [...hdr(ctx, 0x02), bank, slot, ...body(d.slice(0, PROG)), 0xf7],
    performance: (ctx, d) => [[...hdr(ctx, 0x05), ...body(d.slice(0, PERF)), 0xf7], ...(V.vocoder ? [[...hdr(ctx, 0x1b), ...body(d.slice(PERF, PERF + VOC)), 0xf7]] : [])],
    storePerformance: (ctx, bank, slot, d) => [[...hdr(ctx, 0x07), bank, slot, ...body(d.slice(0, PERF)), 0xf7], ...(V.vocoder ? [[...hdr(ctx, 0x1c), bank, slot, ...body(d.slice(PERF, PERF + VOC)), 0xf7]] : [])],
    global: (ctx, d) => { const m = mirrorMap(d); return [[...hdr(ctx, 0x0f), ...body(m.slice(0, GLOB)), 0xf7], [...hdr(ctx, 0x15), ...body(m.slice(G2, G2 + GLOB_EXT)), 0xf7]]; },
  };
  const isMine = (raw) => raw?.[0] === 0xf0 && raw[1] === 0 && raw[2] === 0x20 && raw[3] === 0x29 && raw[4] === 1 && (raw[5] === 0x20 || raw[5] === 0x21);
  const typeOf = (raw) => (isMine(raw) ? raw[7] : -1);
  const AT = { 0x00: 9, 0x02: 10, 0x05: 8, 0x07: 10, 0x0f: 8, 0x15: 8, 0x1b: 8, 0x1c: 10 };
  const dataOf = (raw) => Uint8Array.from(raw.slice(AT[typeOf(raw)] ?? 8, -1));
  const sized = (src, size, at = 0, into = new Uint8Array(size)) => { into.set(src.slice(0, size - at), at); return into; };
  const programOf = (m) => sized(dataOf(m), PROG);
  const PSIZE = PERF + (V.vocoder ? VOC : 0);
  const performanceOf = (main, voc) => { const d = initPerformance(V); d.set(dataOf(main).slice(0, PERF)); if (V.vocoder && voc) d.set(dataOf(voc).slice(0, VOC), PERF); return d; };
  const globalOf = (a, b) => { const d = initGlobal(); d.set(dataOf(a).slice(0, GLOB)); if (b) d.set(dataOf(b).slice(0, GLOB_EXT), G2); else d.set(d.slice(16, GLOB), G2 + 32); return d; };
  const nameOf = SN2.nameOf;
  const setName = (d, name) => { for (let i = 0; i < 16; i++) d[i] = Math.max(32, Math.min(126, name.charCodeAt(i) || 32)); };

  async function collect(api, request, types, done) {
    const c = api.g.client;
    const r = await c.request(Uint8Array.from(request), { collect: (_m, raw) => types.includes(typeOf(raw)), complete: done, timeout: (c.s?.timeout ?? 2500) + 3000, quiet: 2500, resolveOnQuiet: true });
    return (r.messages || []).map((m) => Uint8Array.from(m.raw ?? m));
  }
  const has = (l, t) => l.some((m) => typeOf(Uint8Array.from(m.raw ?? m)) === t);
  const fail = (what) => { throw new Error(`The ${V.name} did not send its ${what}.`); };
  async function fetchProgram(api, req = msg.currentProgramRequest(api.ctx), type = 0x00) {
    const m = (await collect(api, req, [type], (l) => has(l, type))).find((x) => typeOf(x) === type);
    return m ? programOf(m) : fail('program');
  }
  async function fetchPerformance(api, req = msg.currentPerformanceRequest(api.ctx), main = 0x05, voc = 0x1b) {
    const l = await collect(api, req, [main, voc], (x) => has(x, main) && (!V.vocoder || has(x, voc)));
    const a = l.find((x) => typeOf(x) === main);
    return a ? performanceOf(a, l.find((x) => typeOf(x) === voc)) : fail('performance');
  }
  async function fetchGlobal(api) {
    const l = await collect(api, msg.globalRequest(api.ctx), [0x0f, 0x15], (x) => has(x, 0x0f) && has(x, 0x15));
    const a = l.find((x) => typeOf(x) === 0x0f);
    return a ? globalOf(a, l.find((x) => typeOf(x) === 0x15)) : fail('global data');
  }
  const ch = (ctx) => (ctx?.channel ?? 0) & 15;
  const select = (ctx, bank, slot) => [[0xb0 | ch(ctx), 0, 0], [0xb0 | ch(ctx), 32, bank], [0xc0 | ch(ctx), slot]];
  const PTR = TR.perfTranslator({ PART, PFX: SN2._test.PFX });
  const progLetter = (b) => 'ABCDEFGH'[b - 5];
  const perfLetter = (b) => 'ABCD'[b - 1];
  const NAMES = { 0x00: 'current program', 0x02: 'program', 0x05: 'current performance', 0x07: 'performance', 0x0f: 'global data', 0x15: 'global data (2)', 0x1b: 'current vocoder settings', 0x1c: 'vocoder settings', 0x0a: 'arpeggio pattern edit buffer', 0x0c: 'user arpeggio pattern' };
  const MODEL_NAMES = { 0x20: 'SuperNova', 0x21: 'Nova' };
  function describe(raw) {
    if (!isMine(raw)) return null;
    return `${MODEL_NAMES[raw[5]]} ${NAMES[raw[7]] || `type ${raw[7].toString(16)}`} (${raw.length} bytes)`;
  }
  function libraryItems(msgs) {
    const items = [];
    msgs.forEach((m, i) => {
      const t = typeOf(m);
      if (t === 0x1c || t === 0x1b || t === 0x15) return; // carried with their 07 / 05 / 0F
      const object = { 0x00: 'program', 0x02: 'program', 0x05: 'performance', 0x07: 'performance', 0x0f: 'global' }[t] || null;
      const name = object === 'program' || object === 'performance' ? nameOf(dataOf(m)) : '';
      const label = t === 0x02 ? `${progLetter(m[8])}${num(m[9])}` : t === 0x07 ? `${perfLetter(m[8])}${num(m[9])}` : describe(m) || 'Other message';
      const extra = t === 0x07 ? msgs.filter((x) => typeOf(x) === 0x1c && x[8] === m[8] && x[9] === m[9]) : t === 0x05 ? msgs.filter((x) => typeOf(x) === 0x1b) : t === 0x0f ? msgs.filter((x) => typeOf(x) === 0x15) : [];
      items.push({ key: `s${i}`, label, name, object, msgs: [m, ...extra.slice(0, 1)] });
    });
    return items;
  }
  const first = (msgs, types) => msgs.find((x) => types.includes(typeOf(x)));
  const progSlots = { label: 'Programs', banks: V.progBanks, count: 128, slotLabel: (b, i) => `${progLetter(b)}${num(i)}`, name: nameOf };
  const perfSlots = { label: 'Performances', banks: V.perfBanks, count: 128, slotLabel: (b, i) => `${perfLetter(b)}${num(i)}`, name: nameOf };
  const UNVERIFIED = `Built from the ${V.name}'s system software (OS 4.1); not checked on a ${V.name} (none was available).`;
  const partSections = Array.from({ length: 8 }, (_, i) => ({ key: `part${i}`, label: i < V.parts ? `Part ${i + 1}` : `Part ${i + 1} (unused)` }));

  // Arpeggio patterns: the SuperNova II's 194-byte format (same receivers and lengths: 0A/0C 204
  // bytes; the factory patterns in total.mid follow it), one user bank U (the OS 4.1 menus have no
  // V/W). 0D asks for the edit buffer (reply 0A), 14 pp for pattern pp of bank U (reply 0C), 0C pp
  // writes it (memory).
  /**
   * Nova message 1D (handler 1675A): accepted with model byte 21 and data 7F, right after CC 99 = 127
   * (the CC 99 handler, C8CA, arms it), and only while RAM 27487 is not FFh (it is set to FFh then):
   * the Nova copies program banks A-B (5-6) into C-D (7-8) and performance bank A into bank B.
   */
  msg.copyBanks = (ctx) => [[0xb0 | ((ctx?.channel ?? 0) & 15), 99, 127], [...hdr(ctx, 0x1d), 0x7f, 0xf7]];
  const PAT = 1 + SN2.PATTERN_SIZE;
  msg.patternRequest = (ctx) => [...hdr(ctx, 0x0d), 0xf7];
  msg.patternSlotRequest = (ctx, n) => [...hdr(ctx, 0x14), n, 0xf7];
  msg.pattern = (ctx, data) => { const d = SN2.patternFixup(data); return [...hdr(ctx, 0x0a), d[0] & 127, ...body(d.slice(1, PAT)), 0xf7]; };
  msg.storePattern = (ctx, n, data) => { const d = SN2.patternFixup(data); return [...hdr(ctx, 0x0c), n & 127, ...body(d.slice(1, PAT)), 0xf7]; };
  const patternOf = (raw) => { const d = new Uint8Array(PAT); d[0] = raw[8]; d.set(Uint8Array.from(raw.slice(9, -1)).slice(0, SN2.PATTERN_SIZE), 1); return d; };
  async function fetchPattern(api, req, type) {
    const m = (await collect(api, req, [type], (l) => has(l, type))).find((x) => typeOf(x) === type);
    return m ? patternOf(m) : fail('arpeggio pattern');
  }
  const SN2PAT = SN2.default.objects.find((o) => o.key === 'pattern');
  const patternObject = {
    ...SN2PAT,
    fetch: (api) => fetchPattern(api, msg.patternRequest(api.ctx), 0x0a),
    sendParam: (_p, _v, d, ctx) => msg.pattern(ctx, d),
    note: `Changes go to the pattern edit buffer, which the arpeggiator plays when a program or part uses this user pattern. Store writes it into user bank U (Memory protect Off). ${UNVERIFIED}`,
    sendAll: { label: `Send to ${V.name}`, title: 'Send the pattern into the pattern edit buffer', build: (d, ctx) => msg.pattern(ctx, d) },
    toSyx: (d, ctx) => [msg.pattern(ctx, d)],
    fromSyx: (msgs) => { const m = first(msgs, [0x0a, 0x0c]); return m ? patternOf(m) : null; },
    slots: {
      label: 'User patterns', banks: [[15, 'User bank U']], count: 128,
      slotLabel: (_b, i) => `U${num(i)} ${i < 64 ? 'mono' : 'poly'}`, name: () => '',
      fetch: (api, _b, i) => fetchPattern(api, msg.patternSlotRequest(api.ctx, i), 0x0c),
      store: (_b, i, ctx, d) => { const x = Uint8Array.from(d); x[0] = i; return msg.storePattern(ctx, i, x); },
      writable: () => true,
      note: () => 'Read reads one pattern. Store writes it into bank U (Memory protect Off). Patterns 000-063 are mono, 064-127 poly.',
    },
  };

  const def = {
    coverage: `Edits the ${V.name}'s programs, performances and global settings. Programs (oscillators, mixer, LFOs, envelopes, filter, voice, arpeggiator, effects), performances (${V.parts} parts, MIDI channels page${V.vocoder ? ', vocoder' : ''}) and global settings. ${UNVERIFIED}`,
    sysex: { manufacturer: [0x00, 0x20, 0x29], model: V.model, deviceIdDefault: 0x7f },
    minGap: 40,
    describe,
    libraryItems,
    objects: [
      {
        key: 'program', page: 'Program', icon: '◆', label: 'Program', size: PROG, autoLoad: true,
        init: initProgram, fetch: (api) => fetchProgram(api), params: finish(programParams(V), 'p', 'program'), name: nameOf, cols: 3,
        sections: [{ key: 'osc', label: 'Oscillators' }, { key: 'mix', label: 'Mixer' }, { key: 'lfo', label: 'LFOs' }, { key: 'env', label: 'Envelopes' }, { key: 'filter', label: 'Filter' }, { key: 'voice', label: 'Voice' }, { key: 'arp', label: 'Arpeggiator' }, { key: 'fx', label: 'Effects' }],
        groupInfo: { Reserved: { note: 'Values this model does not use. Kept so a backup restores exactly.', table: true } },
        sendParam: (_p, _v, d, ctx) => msg.program(ctx, d),
        note: `Every change sends the program to the edit buffer, so it is heard at once. ${UNVERIFIED}`,
        sendAll: { label: `Send to ${V.name}`, build: (d, ctx) => msg.program(ctx, d) },
        toSyx: (d, ctx) => [msg.program(ctx, d)],
        fromSyx: (msgs) => { const m = first(msgs, [0x00, 0x02]); return m ? programOf(m) : null; },
        toCommon: (d) => TR.sn1ProgramToCommon(d, V.id),
        fromCommon: (c, base) => TR.sn1ProgramFromCommon(c, base),
        setName,
        slots: {
          ...progSlots,
          recall: (bank, i, ctx) => select(ctx, bank, i),
          fetch: (api, bank, i) => fetchProgram(api, msg.singleRequest(api.ctx, bank, i), 0x02),
          store: (bank, i, ctx, d) => msg.storeProgram(ctx, bank, i, d), writable: () => true,
          note: () => (V.progBanks.length > 4 ? 'Banks E-H exist only on a SuperNova with 1024 programs. ' : '') + 'Storing needs Memory protect Off.',
        },
      },
      {
        key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: PSIZE, autoLoad: false,
        init: () => initPerformance(V), fetch: (api) => fetchPerformance(api), params: finish(performanceParams(V), 'f', 'performance'), name: nameOf, cols: 3,
        sections: [{ key: 'common', label: 'Common' }, ...partSections],
        groupInfo: { Reserved: { note: 'Values this model does not use. Kept so a backup restores exactly.', table: true } },
        sendParam: (_p, _v, d, ctx) => msg.performance(ctx, d),
        note: `Every change sends the performance to the edit buffer. ${UNVERIFIED}`,
        sendAll: { label: `Send to ${V.name}`, build: (d, ctx) => msg.performance(ctx, d) },
        toSyx: (d, ctx) => msg.performance(ctx, d),
        fromSyx: (msgs) => { const m = first(msgs, [0x05, 0x07]); return m ? performanceOf(m, first(msgs, [0x1b, 0x1c])) : null; },
        toCommon: (d) => { const pad = new Uint8Array(SN2.PERF_DATA); pad.set(d.slice(0, PERF)); const c = PTR.perfToCommon(pad); c.extra.model = V.id; c.extra.performance = toBase64(d); return c; },
        fromCommon: (c, base) => {
          if (c.extra?.model === V.id && c.extra.performance) { const d = Uint8Array.from(base); d.set(fromBase64(c.extra.performance).slice(0, d.length)); return { data: d, report: { mapped: ['all performance bytes (same model)'], approximated: [], dropped: [] } }; }
          const pad = new Uint8Array(SN2.PERF_DATA); pad.set(base.slice(0, PERF)); const r = PTR.perfFromCommon(c, pad); const d = Uint8Array.from(base); d.set(r.data.slice(0, PERF)); return { data: d, report: r.report };
        },
        setName,
        multi: {
          page: 'MIDI channels', label: 'Parts', count: V.parts, section: (i) => `part${i}`, partLabel: (i) => `Part ${i + 1}`,
          columns: [
            { label: 'Program', params: ['Bank', 'Program'], role: 'patch' },
            { label: 'MIDI channel', params: [V.vocoder ? 'MIDI channel' : 'Midi channel'], role: 'channel' },
            { label: 'Polyphony', params: ['Part polyphony'], role: 'on' },
            { label: 'Level', params: ['Part level'] },
            { label: 'Key range', params: ['Lowest note', 'Highest note'] },
          ],
          on: (i, d) => (d[PART(i) + 10] & 3) !== 0,
          channels: [...Array.from({ length: 16 }, (_, i) => [i, String(i + 1)]), [16, 'Omni'], [17, 'Global']],
          note: `In performance mode each of the ${V.parts} parts plays its program on its MIDI channel.`,
        },
        slots: {
          ...perfSlots,
          recall: (bank, i, ctx) => select(ctx, bank, i),
          fetch: (api, bank, i) => fetchPerformance(api, msg.singleRequest(api.ctx, bank, i), 0x07, 0x1c),
          store: (bank, i, ctx, d) => msg.storePerformance(ctx, bank, i, d), writable: () => true,
        },
      },
      patternObject,
      {
        key: 'global', page: 'Global', icon: '⚙', label: 'Global', size: GLOB + GLOB_EXT,
        init: initGlobal, fetch: fetchGlobal, params: finish(globalParams(V), 'g', 'global'), cols: 3,
        sections: [{ key: 'global', label: 'Settings' }, { key: 'map', label: 'Program change map' }],
        groupInfo: { 'Program change map': { table: true, wide: true }, Reserved: { note: 'Values this model does not use. Kept so a backup restores exactly.', table: true } },
        note: `Changes here are not sent as you make them, because sending global settings writes them into memory: use Write global settings (Memory protect Off). ${UNVERIFIED}`,
        actions: [
          { label: 'Write global settings', run: async (api) => { if (await api.confirm('Write global settings', `Replace the ${V.name}'s global settings?`, 'Write', true)) api.send(msg.global(api.ctx, api.data)); } },
          ...(V.copyBanks ? [{ label: 'Copy banks', title: 'Copies program banks A-B into C-D and performance bank A into B, once', run: async (api) => {
            if (await api.confirm('Copy banks', 'The Nova copies program banks A-B over its banks C-D and performance bank A over bank B. It does this only once: afterwards it ignores the command. Continue?', 'Copy', true)) api.send(msg.copyBanks(api.ctx));
          } }] : []),
        ],
        toSyx: (d, ctx) => msg.global(ctx, d),
        fromSyx: (msgs) => { const a = first(msgs, [0x0f]); return a ? globalOf(a, first(msgs, [0x15])) : null; },
      },
    ],
    requests: [
      { label: 'Current program', bytes: (ctx) => msg.currentProgramRequest(ctx) },
      { label: 'Current performance', bytes: (ctx) => msg.currentPerformanceRequest(ctx) },
      { label: 'Global data', bytes: (ctx) => msg.globalRequest(ctx) },
    ],
  };
  return { def, msg, isMine, typeOf, dataOf, nameOf };
}

function finish(list, prefix, sendKey) {
  return list.map((p, i) => ({ ...p, key: `${prefix}${i}`, sendKey }));
}

/**
 * The models. Banks: the SuperNova's menus default to programs A-D and performances A-B, but its
 * Sysex lists (SuperNova 2119A, 21D41) also name program banks E-H and performance banks C-D: the
 * 1024-program SuperNova. The Nova's menus offer programs A-B and performance bank A. Sysex
 * transmission / reception: the value ranges of the OS 4.1 string lists (SuperNova II values).
 */
export const SUPERNOVA = {
  id: 'novation-supernova', model: 0x20, name: 'SuperNova', parts: 8, vocoder: false, constantGate: false,
  progBanks: SN2.PROG_BANKS, perfBanks: SN2.PERF_BANKS, sysexTx: [88, 127], sysexRx: [66, 79],
};
export const NOVA = {
  id: 'novation-nova', model: 0x21, name: 'Nova', parts: 6, vocoder: true, constantGate: true, copyBanks: true,
  progBanks: SN2.PROG_BANKS.slice(0, 2), perfBanks: SN2.PERF_BANKS.slice(0, 1), sysexTx: [88, 115], sysexRx: [66, 73],
};
