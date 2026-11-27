// Access Virus TI Snow: the TI's sound engine and SysEx in a smaller unit with its own host OS build
// (vti_snow.bin in the Virus TI Software Suite 5.1.7; host banks re/virusti/fw/snowhost/, Ghidra project
// re/virus/ghidra_snow). Singles, the multi page layout and the parameter messages are the TI's
// (access-virus-ti2.js); what differs, all from the Snow's own host OS (docs/devices/access-virus-snow.md):
//
//   parts            4 (parameter messages and edit-buffer dumps to parts 4-15 are refused: 352E CJNE R7,#04)
//   single banks     banks of 64 sounds, named RAM 1-8 and ROM 1-8 by the screen (display list 68); SysEx keeps
//                    banks of 128: bank 1 = RAM 1 (slots 0-63) + RAM 2 (64-127), ... 4 = RAM 7+8, 5-8 = ROM 1+2 ...
//                    7+8 (slot address 5A52: memory bank 2 + 2 x (bank - 1) + slot / 64). Single requests and bank
//                    requests take banks 1-4 and 5 + the ROM banks (4597); stores 10 01-04 pp (receiver 34FF)
//   multis           64, each holding its 4 part singles (memory banks 0A-0D: 16 multis of 256 + 4 x 512 bytes).
//                    10 / 30 (20h + m) pp = part pp (0-3) of multi m (receiver 34FF: banks 20h-5Fh, slots 0-3;
//                    store 3696); 11 32 mm stores multi mm (0-63; bank 1 is refused, 3791); 31 01 mm / 31 (20h + m)
//                    reads it; 33 01 sends the 64 multis (11 01 mm); 34 (20h + m) sends multi m and its 4 singles
//                    (11 01 m, 10 (20h + m) 00-03), 34 00 the multi edit buffer and the part singles (11 00 7F,
//                    10 00 pp; request kinds at 3B8D, state table 3216)
//   output selects   the Snow's own lists (117 / 119 / 121) and screen orders (reordering tables 4 / 6 / 7): Out 1,
//                    USB 1-3, then the greyed Out 2 / Out 3; Virus Control's "pr" output parameters
// Nothing here was checked on a Snow (none was connected).

import { readParam } from '../../core/model/memmap.js';
import TI, {
  msg, SINGLE_PART, OMNI, MULTI_STORE_LOW, isVirus, cmdOf, singleFrom, multiFrom, upgradeSingle, initSingle, nameOf, multiNameOf,
  setName, slotNumber, collect, singleReceiver, makeTables, multiParams, initMulti, globalParams, initGlobal, tiSigns, snowSigns, longSingles,
} from './access-virus-ti2.js';
import * as FW from './access-virus-snow-fw.js';
import * as OS from './access-virus-snow-os.js';
import * as TR from './access-virus-snow-translate.js';

const T = makeTables(FW, OS);
export const { PARTS, PART_SINGLES, MULTI_DATA } = TR;
export const MULTIS = 64;
export const PART_BANK = 0x20;
/** Banks of 64 as the Snow's screen names them (display list 68): ids 1-8 RAM 1-8, 9-16 ROM 1-8. */
export const BANKS = Array.from({ length: 16 }, (_, i) => [i + 1, i < 8 ? `RAM ${i + 1}` : `ROM ${i - 7}`]);
export const sysexBank = (id) => 1 + ((id - 1) >> 1);
export const sysexSlot = (id, i) => 64 * ((id - 1) & 1) + i;
const bankLabel = (id) => (id <= 8 ? `RAM ${id}` : `ROM ${id - 8}`);
const slot64 = (i) => String(i + 1).padStart(2, '0');
/** "RAM 3 05" for SysEx bank / slot. */
export const slotText = (sb, slot) => `${bankLabel(2 * (sb - 1) + (slot >> 6) + 1)} ${slot64(slot & 63)}`;
const PAIR_LABEL = (sb) => (sb <= 4 ? `RAM ${2 * sb - 1}+${2 * sb}` : `ROM ${2 * sb - 9}+${2 * sb - 8}`);
const partLabel = (p) => (p === SINGLE_PART ? 'Single mode' : `Part ${p + 1}`);
const req = (ctx, cmd, ...b) => [0xf0, 0x00, 0x20, 0x33, 0x01, (ctx?.deviceId ?? OMNI) & 0x7f, cmd, ...b, 0xf7];
export const snowMsg = {
  arrangementRequest: (ctx, bank = 0) => req(ctx, 0x34, bank),
  multiSlotRequest: (ctx, m) => req(ctx, 0x31, 1, m),
  /** A multi with its 4 part singles into slot m (0-63): 11 32 m, then 10 (20h + m) 00-03. */
  multiStore: (ctx, m, d) => [msg.multi(ctx, MULTI_STORE_LOW, m, d.subarray(0, 256)), ...Array.from({ length: PARTS }, (_, p) => msg.single(ctx, PART_BANK + m, p, partSingle(d, p)))],
  /** The multi edit buffer and the part edit buffers: 11 00 7F, 10 00 00-03. */
  editBuffers: (ctx, d) => [msg.multi(ctx, 0, 0x7f, d.subarray(0, 256)), ...Array.from({ length: PARTS }, (_, p) => msg.single(ctx, 0, p, partSingle(d, p)))],
};
export const partSingle = (d, p) => d.subarray(PART_SINGLES + 512 * p, PART_SINGLES + 512 * (p + 1));
const hasSingle = (d, p) => partSingle(d, p).some((b) => b !== 0);

const unit = { part: SINGLE_PART };

// ------------------------------------------------------------------ multi (256 bytes + the 4 part singles)
export const initSnowMulti = () => {
  const d = initMulti({ parts: PARTS, T, size: MULTI_DATA });
  for (let p = 0; p < PARTS; p++) d.set(initSingle(), PART_SINGLES + 512 * p);
  return d;
};
const partName = (d, p) => (d && d.length >= MULTI_DATA && hasSingle(d, p) ? nameOf(partSingle(d, p)) : undefined);
export const snowMultiParams = multiParams({ parts: PARTS, T, names: (d) => Array.from({ length: PARTS }, (_, p) => partName(d, p)) });
const findMulti = (part, ci) => snowMultiParams.find((p) => p.part === part && p.page === ci);

/** A Snow multi from messages: an 11 and the part singles (10 00 pp or 10 (20h + m) pp). */
export function snowMultiFrom(msgs, base = initSnowMulti()) {
  const m = msgs.find((x) => cmdOf(x) === 0x11);
  const md = m && multiFrom(m);
  if (!md) return null;
  const d = Uint8Array.from(base);
  d.set(md, 0);
  const bank = m[7] === 0 ? 0 : PART_BANK + m[8];
  for (const x of msgs) {
    if (cmdOf(x) !== 0x10 || x[7] !== bank || x[8] >= PARTS) continue;
    const s = singleFrom(x);
    if (s) d.set(bank ? upgradeSingle(s) : s, PART_SINGLES + 512 * x[8]);
  }
  return d;
}

// ------------------------------------------------------------------ device I/O
async function fetchSingle(api, sb, slot) {
  const m = await collect(api, msg.singleRequest(api.ctx, sb, slot), [0x10], 1, (raw) => raw[7] === sb && raw[8] === slot);
  const d = m[0] && singleFrom(m[0]);
  if (!d) throw new Error(`The Virus did not send ${sb ? slotText(sb, slot) : `the ${partLabel(slot)} edit buffer`}.`);
  return sb ? upgradeSingle(d) : d; // slots send older sounds unconverted; edit buffers hold them converted
}
/** 34 bb: the multi edit buffer (bb 0) or stored multi m (bb 20h + m) with its part singles (up to 5 dumps). */
async function fetchArrangement(api, bank) {
  const m = await collect(api, snowMsg.arrangementRequest(api.ctx, bank), [0x10, 0x11], 1 + PARTS,
    (raw) => (raw[6] === 0x11 ? (bank ? raw[7] === 1 && raw[8] === bank - PART_BANK : raw[7] === 0) : raw[7] === bank && raw[8] < PARTS));
  const multi = m.find((x) => cmdOf(x) === 0x11);
  if (!multi) throw new Error(`The Virus did not send ${bank ? `multi ${slotNumber(bank - PART_BANK)}` : 'its multi edit buffer'}.`);
  return snowMultiFrom(m); // 11 01 m comes with 10 (20h + m) pp, 11 00 7F with 10 00 pp
}
function scanSingles(api, id, onName) {
  const sb = sysexBank(id);
  const half = (id - 1) & 1;
  return collect(api, msg.singleBankRequest(api.ctx, sb), [0x10], 128, (raw) => raw[7] === sb, (x) => { if (x[8] >> 6 === half) onName(x[8] & 63, nameOf(singleFrom(x))); });
}
const scanMultis = (api, _bank, onName) => collect(api, msg.multiBankRequest(api.ctx, 1), [0x11], MULTIS, (raw) => raw[7] === 1, (x) => onName(x[8], multiNameOf(multiFrom(x))));
const PAGES = [0x70, 0x71, 0x6e, 0x6f];
const sendSingleParam = (ctx, offset, value) => msg.param(ctx, PAGES[offset >> 7], unit.part, offset & 127, value);

function describe(raw) {
  if (!isVirus(raw)) return null;
  const c = raw[6];
  if (c === 0x10 && raw.length > 250) {
    const where = raw[7] === 0 ? `edit buffer (${partLabel(raw[8])})` : raw[7] >= PART_BANK ? `multi ${slotNumber(raw[7] - PART_BANK)} part ${raw[8] + 1}` : slotText(raw[7], raw[8]);
    return `Virus Snow single ${where} "${nameOf(singleFrom(raw))}"`;
  }
  if (c === 0x11 && raw.length > 250) return `Virus Snow multi ${raw[7] === 0 ? 'edit buffer' : slotNumber(raw[8])} "${multiNameOf(multiFrom(raw))}"`;
  if (c === 0x34) return `Virus Snow arrangement request (${raw[7] ? `multi ${slotNumber(raw[7] - PART_BANK)}` : 'edit buffer'})`;
  return TI.describe(raw);
}

// Messages the Head Library reads (singles and multis that parse); requests are 30-3B. A file read without a device hint
// goes to the Snow when it holds part singles of multis 16-63 (banks 30h-5Fh), to the TI when it holds what only a TI
// has (ROM banks past 8, parts 4-15, multis 64-127).
const recognise = (m) => (cmdOf(m) === 0x10 && !!singleFrom(m)) || (cmdOf(m) === 0x11 && !!multiFrom(m));
const isRequest = (m) => cmdOf(m) >= 0x30 && cmdOf(m) <= 0x3b;
const prefer = (msgs) => 1 + longSingles(msgs) + (snowSigns(msgs) ? 0.5 : 0) - (tiSigns(msgs) ? 0.5 : 0);

function libraryItems(msgs) {
  const items = [];
  const used = new Set();
  msgs.forEach((m, i) => {
    if (cmdOf(m) !== 0x11) return;
    const bank = m[7] === 0 ? 0 : PART_BANK + m[8];
    const parts = msgs.filter((x, j) => { const ok = cmdOf(x) === 0x10 && x[7] === bank && x[8] < PARTS && (bank || j > i); if (ok) used.add(x); return ok; });
    items.push({ key: `m${m[7]}:${m[8]}:${i}`, label: m[7] ? `Multi ${slotNumber(m[8])}` : 'Multi edit buffer', name: multiNameOf(multiFrom(m)), object: 'multi', msgs: [m, ...parts.slice(0, PARTS)] });
  });
  msgs.forEach((m, i) => {
    if (cmdOf(m) !== 0x10 || used.has(m)) return;
    const d = singleFrom(m);
    // a part single of a stored multi without its multi in the file: kept as a single of its own
    const label = m[7] >= PART_BANK ? `Multi ${slotNumber(m[7] - PART_BANK)} part ${m[8] + 1}` : m[7] ? slotText(m[7], m[8]) : `Single edit buffer (${partLabel(m[8])})`;
    if (d) items.push({ key: `s${m[7]}:${m[8]}:${i}`, label, name: nameOf(d), object: 'single', msgs: [m] });
  });
  return items;
}

/** The Snow as its host OS answers (banks, slots and refusals as traced; docs/devices/access-virus-snow.md). */
function simulate() {
  const named = (d, s) => { setName(d, 240, s); return d; };
  const singles = new Map();
  for (let sb = 1; sb <= 8; sb++) for (let i = 0; i < 128; i++) singles.set(`${sb}:${i}`, named(initSingle(), slotText(sb, i).replace(' ', '')));
  const multis = Array.from({ length: MULTIS }, (_, m) => { const d = initSnowMulti(); setName(d, 4, `Multi ${slotNumber(m)}`); return d; });
  const s = { single: initSingle(), multi: initSnowMulti(), global: initGlobal(T), singles, multis };
  const ctx = { deviceId: 0x00 };
  const buf = (p) => (p === SINGLE_PART ? s.single : partSingle(s.multi, p));
  const okPart = (p) => p === SINGLE_PART || p < PARTS;
  return {
    state: s,
    handle(raw) {
      const d = Array.from(raw);
      if (d[0] !== 0xf0) return [];
      if (!isVirus(d)) return null;
      const [c, b, p] = [d[6], d[7], d[8]];
      const inMulti = b >= PART_BANK && b < 0x60;
      switch (c) {
        case 0x30:
          if (b === 0) return okPart(p) ? [msg.single(ctx, 0, p, buf(p))] : [];
          if (inMulti) return p < PARTS ? [msg.single(ctx, b, p, partSingle(multis[b - PART_BANK], p))] : [];
          return singles.has(`${b}:${p}`) ? [msg.single(ctx, b, p, singles.get(`${b}:${p}`))] : [];
        case 0x31:
          if (b === 0) return [msg.multi(ctx, 0, 0x7f, s.multi)];
          if (b === 1 && p < MULTIS) return [msg.multi(ctx, 1, p, multis[p])];
          return inMulti ? [msg.multi(ctx, 1, b - PART_BANK, multis[b - PART_BANK])] : [];
        case 0x32:
          if (inMulti) return Array.from({ length: PARTS }, (_, i) => msg.single(ctx, b, i, partSingle(multis[b - PART_BANK], i)));
          return singles.has(`${b}:0`) ? Array.from({ length: 128 }, (_, i) => msg.single(ctx, b, i, singles.get(`${b}:${i}`))) : [];
        case 0x33: return b === 1 ? multis.map((m, i) => msg.multi(ctx, 1, i, m)) : [];
        case 0x34:
          if (b === 0) return snowMsg.editBuffers(ctx, s.multi);
          return inMulti ? [msg.multi(ctx, 1, b - PART_BANK, multis[b - PART_BANK]), ...Array.from({ length: PARTS }, (_, i) => msg.single(ctx, b, i, partSingle(multis[b - PART_BANK], i)))] : [];
        case 0x10: {
          const data = singleFrom(Uint8Array.from(d));
          if (!data) return [];
          if (b === 0 && okPart(p)) buf(p).set(data);
          else if (s.global[118] !== 0) return [];
          else if (b >= 1 && b <= 4) singles.get(`${b}:${p}`)?.set(data);
          else if (inMulti && p < PARTS) multis[b - PART_BANK].set(data, PART_SINGLES + 512 * p);
          return [];
        }
        case 0x11: {
          const data = multiFrom(Uint8Array.from(d));
          if (data && b === 0) s.multi.set(data, 0);
          else if (data && s.global[118] === 0 && b === MULTI_STORE_LOW && p < MULTIS) multis[p].set(data, 0); // bank 1 is refused (3791)
          return [];
        }
        case 0x70: case 0x71: case 0x6e: case 0x6f: if (okPart(b)) buf(b)[PAGES.indexOf(c) * 128 + p] = d[9]; return [];
        case 0x72:
          if (b >= PARTS && p >= 32) return [];
          if (p >= 72 && p <= 78) { const at = 240 + b; s.multi[at] = (s.multi[at] & ~(1 << (p - 72))) | ((d[9] & 1) << (p - 72)); } else if (p >= 32) s.multi[32 + 16 * (p - 32) + b] = d[9]; else s.multi[p] = d[9];
          return [];
        case 0x73: s.global[p] = d[9]; return [];
        default: return [];
      }
    },
  };
}

// ------------------------------------------------------------------ definition
const [tiSingle, , tiGlobal] = TI.objects;
const PART_TARGET = {
  label: 'Edit buffer', title: 'Which edit buffer the page reads and edits: the single of single mode, or one of the 4 parts of the multi',
  options: () => [[SINGLE_PART, 'Single mode'], ...Array.from({ length: PARTS }, (_, i) => [i, `Multi part ${i + 1}`])],
  value: () => unit.part, set: (v) => { unit.part = Number(v); },
};
const partSections = Array.from({ length: PARTS }, (_, i) => ({ key: `part${i}`, label: `Part ${i + 1}` }));

const DEF = {
  model: 'Virus TI Snow',
  coverage: 'Virus TI Snow, mapped from its own host OS (vti_snow.bin, Software Suite 5.1.7) and Virus Control\'s Snow description; not checked on a Snow. Singles (the TI\'s: all 388 parameters with the screen\'s value lists), the multi with its 4 parts and the singles they hold (MIDI channels page), the global settings (sent only), RAM 1-8 and ROM 1-8 single banks of 64 with names, the 64 multis with their part singles, store to RAM, Branch Library, translator, simulator. Output selects show the Snow\'s own lists and order (Out 1, USB 1-3, then the greyed Out 2 / Out 3).',
  sysex: { manufacturer: [0x00, 0x20, 0x33], model: 0x01, deviceIdDefault: OMNI },
  minGap: 20,
  describe,
  simulate,
  libraryItems,
  recognise,
  isRequest,
  isOwn: (m) => isVirus(m),
  prefer,
  objects: [
    {
      ...tiSingle,
      fetch: (api) => fetchSingle(api, 0, unit.part),
      target: PART_TARGET,
      sendParam: (p, _v, data, ctx) => sendSingleParam(ctx, p.offset, data[p.offset]),
      receive: singleReceiver(() => unit.part),
      note: 'Each change is sent as a SysEx parameter (pages A-D) to the edit buffer chosen above (single mode or one of the 4 parts). Store writes the single into a RAM slot.',
      sendAll: { label: 'Send to Virus', title: 'Send the whole single into the chosen edit buffer (message 10)', build: (data, ctx) => msg.single(ctx, 0, unit.part, data) },
      toCommon: (d) => TR.singleToCommon(d),
      fromCommon: (c, base) => TR.singleFromCommon(c, base),
      slots: {
        label: 'Singles', banks: BANKS, count: 64,
        slotLabel: (bank, i) => `${bankLabel(bank)} ${slot64(i)}`, name: nameOf,
        fetch: (api, bank, i) => fetchSingle(api, sysexBank(bank), sysexSlot(bank, i)),
        play: async (api, bank, i) => { const d = await fetchSingle(api, sysexBank(bank), sysexSlot(bank, i)); api.send(msg.single(api.ctx, 0, unit.part, d)); },
        scanBank: scanSingles, namesOnOpen: true,
        store: (bank, i, ctx, data) => msg.single(ctx, sysexBank(bank), sysexSlot(bank, i), data),
        writable: (bank) => bank >= 1 && bank <= 8,
        note: (bank) => `The Snow answers in banks of 128 (SysEx bank ${sysexBank(bank)} = ${PAIR_LABEL(sysexBank(bank))}): Read names asks for both (about two minutes) and shows this one's 64. Play reads the single and sends it into the edit buffer chosen above.${bank > 8 ? ' ROM banks cannot be written.' : ' Store writes into this RAM slot (Memory Protect Disabled and MIDI Dump RX Enable: the other settings force the bank or keep the sound in the edit buffer).'}`,
      },
    },
    {
      key: 'multi', page: 'Multi', icon: '▦', label: 'Multi', size: MULTI_DATA, autoLoad: false,
      init: () => initSnowMulti(), params: snowMultiParams, name: multiNameOf, cols: 3,
      fetch: (api) => fetchArrangement(api, 0),
      sections: [{ key: 'common', label: 'Common' }, ...partSections, { key: 'reserved', label: 'Reserved bytes' }],
      groupInfo: { 'Reserved bytes': { note: 'Multi bytes the Snow OS has no parameter for, and the places of parts 5-16 (the Snow has 4 parts; its OS refuses parameter messages for the others). Kept so a backup restores exactly (docs/devices/access-virus-snow.md).', table: true, wide: true } },
      sendParam: (p, _v, data, ctx) => (p.part === undefined ? msg.param(ctx, 0x72, 0, p.offset, data[p.offset]) : msg.param(ctx, 0x72, p.part, p.page, readParam(data, p))),
      note: 'A Snow multi holds its 4 part singles: Get from device reads the multi edit buffer and the part edit buffers (34 00), a slot reads the stored multi with its singles (34 20h + m). Each change here is sent as a multi parameter (message 72); edit the part sounds on the Single page (Edit buffer: Multi part n).',
      sendAll: { label: 'Send to Virus', title: 'Send the multi and its 4 part singles into the edit buffers (11 00 7F, 10 00 00-03)', build: (data, ctx) => snowMsg.editBuffers(ctx, data) },
      toSyx: (data, ctx) => snowMsg.editBuffers(ctx, data),
      fromSyx: (msgs) => snowMultiFrom(msgs),
      toCommon: (d) => TR.multiToCommon(d),
      fromCommon: (c, base) => TR.multiFromCommon(c, base),
      setName: (d, name) => setName(d, 4, name),
      multi: {
        page: 'MIDI channels', label: 'Parts', count: PARTS, section: (i) => `part${i}`, partLabel: (i) => `Part ${i + 1}`,
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
        note: 'The Snow plays 4 parts, each with its own single (Sound) on its MIDI channel; Part enable switches it on. Get from device reads the multi and the part singles (34 00). Changes go to the multi edit buffer; store the multi to keep them.',
      },
      slots: {
        label: 'Multis', banks: [[1, 'Multis']], count: MULTIS,
        slotLabel: (_bank, i) => slotNumber(i), name: multiNameOf,
        fetch: (api, _bank, i) => fetchArrangement(api, PART_BANK + i),
        scanBank: scanMultis, namesOnOpen: true,
        store: (_bank, i, ctx, data) => snowMsg.multiStore(ctx, i, data),
        writable: () => true,
        note: () => 'Read names asks for the 64 multis (33 01, about one a second). A slot reads the multi with its 4 singles (34 20h + m). Store writes the multi (11 32 m) and its 4 singles (10 20h + m 00-03): Memory Protect Disabled, MIDI Dump RX Enable.',
      },
    },
    {
      ...tiGlobal,
      init: () => initGlobal(T), params: globalParams(T),
      note: 'The Snow cannot send its global settings (no global request), so the values shown are Virus Control\'s defaults until you change them here; each change is sent at once (message 73). Memory Protect is shown Disabled.',
    },
  ],
  // Each step ends as soon as its dumps are in (expect); seconds assume the TI's pace (one dump a second, measured on
  // a TI2; the Snow runs the same host code family, not measured on a Snow). ROM banks: optional, ticked.
  fullDump: [
    { request: 'Single edit buffer', expect: 1, timeout: 3000, seconds: 1 },
    { request: 'Multi edit buffer and part singles', expect: 1 + PARTS, timeout: 12000, seconds: 1 + PARTS },
    ...[1, 2, 3, 4].map((sb) => ({ request: `${PAIR_LABEL(sb)} singles`, expect: 128, timeout: 20000, seconds: 128 })),
    { request: 'Multis', expect: MULTIS, timeout: 20000, seconds: MULTIS },
    ...Array.from({ length: MULTIS }, (_, m) => ({ label: `Multi ${slotNumber(m)} with its singles`, bytes: (ctx) => snowMsg.arrangementRequest(ctx, PART_BANK + m), expect: 1 + PARTS, timeout: 9000, quiet: 1500, seconds: 1 + PARTS })),
    ...[5, 6, 7, 8].map((sb) => ({ request: `${PAIR_LABEL(sb)} singles`, expect: 128, timeout: 20000, seconds: 128, group: 'ROM banks 1-8 (the factory sounds)', optional: true })),
  ],
  requests: [
    { label: 'Single edit buffer', bytes: (ctx) => msg.singleRequest(ctx, 0, SINGLE_PART) },
    ...Array.from({ length: PARTS }, (_, i) => ({ label: `Part ${i + 1} single`, bytes: (ctx) => msg.singleRequest(ctx, 0, i) })),
    { label: 'Multi edit buffer', bytes: (ctx) => msg.multiRequest(ctx, 0, 0) },
    { label: 'Multi edit buffer and part singles', bytes: (ctx) => snowMsg.arrangementRequest(ctx, 0) },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((sb) => ({ label: `${PAIR_LABEL(sb)} singles`, bytes: (ctx) => msg.singleBankRequest(ctx, sb) })),
    { label: 'Multis', bytes: (ctx) => msg.multiBankRequest(ctx, 1) },
  ],
};

export default DEF;
export const _test = { unit, T, findMulti };
