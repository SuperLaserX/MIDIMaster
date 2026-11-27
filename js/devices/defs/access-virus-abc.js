// Access Virus A / B / C family: the editor shared by the Virus A, B, kb, Indigo, Rack, Classic, C, KC, Indigo 2
// and Rack XL (one file per model: access-virus-<model>.js, built with abcModel()). Every parameter, its range and
// the text the screen shows for each value come from the model's own host OS (an 8051 driving a 2 x 16 LCD), run
// in an emulator by tools/virus/abc_tables.py -> access-virus-<os>-os.js. See docs/devices/access-virus-abc.md.
//
// SysEx F0 00 20 33 01 dd cc ... F7 (00 20 33 Access, 01 Virus, dd device ID 0-15, 10 = omni), as the TI kept it:
//   10 bb pp <256> cs        single: page A (bytes 0-127, the MIDI controller numbers) and page B (128-255);
//                            cs = sum of dd .. last data byte & 7F. bb 0 = edit buffer (pp 40 single mode, 0-15 a
//                            multi part), 1-2 RAM banks A-B, 3 on ROM banks (C-H on the B / C)
//   11 bb pp <256> cs        multi: page C as the TI kept it (common bytes = page C index, part p of page C index ci
//                            at 32 + 16 * (ci - 32) + p, the part switches C 72-78 as bits of byte 240 + p); bb 0 =
//                            the edit buffer, 1 = the RAM multis
//   12 bb pp <256> cs        global settings: byte i = page C index i (the host's global store 2400h + i)
//   30 bb pp / 31 bb pp      single / multi request; 32 bb / 33 bb single / multi bank request; 34 multi edit buffer
//                            and the 16 part singles; 35 global request
//   70 / 71 / 72 pp ii vv    parameter page A / B / C: index ii of part pp (40 = single mode); page C holds the
//                            multi and the global settings (global ones ignore pp)
// The dumps' layout is confirmed by the dumps Access shipped with the OS updates (ABM.mid of the B and C, the C's
// "Analog Filter Sounds.syx": every checksum as above). The receiver itself runs on the DSP (56300 code, not traced):
// the request numbers are Access's documented ones, the same the Virus TI still answers. Nothing here was checked on
// a unit (none connected).

import { readParam } from '../../core/model/memmap.js';
import { msg, OMNI, SINGLE_PART, isVirus, cmdOf, multiFrom, multiNameOf, setName, slotNumber, collect } from './access-virus-ti2.js';
import * as TR from './access-virus-abc-translate.js';

export const SINGLE_SIZE = 256;
export const MULTI_SIZE = 256;
export const GLOBAL_SIZE = 256;
export { SINGLE_PART, OMNI };
const MAKER = [0x00, 0x20, 0x33, 0x01];
const PAGES = [0x70, 0x71, 0x72];
const dev = (ctx) => (ctx?.deviceId ?? OMNI) & 0x7f;
const hdr = (ctx, cmd) => [0xf0, ...MAKER, dev(ctx), cmd];
const sum7 = (m) => { let s = 0; for (let i = 5; i < m.length; i++) s += m[i]; return s & 0x7f; };
const dump = (ctx, cmd, bank, prog, data) => { const m = [...hdr(ctx, cmd), bank & 0x7f, prog & 0x7f, ...Array.from(data.subarray(0, 256), (x) => x & 0x7f)]; m.push(sum7(m), 0xf7); return m; };

export const abcMsg = {
  single: (ctx, bank, prog, data) => dump(ctx, 0x10, bank, prog, data),
  multi: (ctx, bank, prog, data) => dump(ctx, 0x11, bank, prog, data),
  global: (ctx, data) => dump(ctx, 0x12, 0, 0, data),
  singleRequest: msg.singleRequest, multiRequest: msg.multiRequest, singleBankRequest: msg.singleBankRequest, multiBankRequest: msg.multiBankRequest,
  arrangementRequest: msg.arrangementRequest,
  globalRequest: (ctx) => [...hdr(ctx, 0x35), 0xf7],
  param: (ctx, page, part, index, value) => msg.param(ctx, PAGES[page], part, index, value),
};
/** The 256 data bytes of a 10 / 11 / 12 dump (a Virus TI single's 524 bytes give its pages A / B). */
export function dataFrom(raw, cmd) {
  if (cmdOf(raw) !== cmd || raw.length < 267) return null;
  return Uint8Array.from(raw.slice(9, 265));
}
export const singleFrom = (raw) => dataFrom(raw, 0x10);
export const globalFrom = (raw) => dataFrom(raw, 0x12);
export const nameOf = (d) => Array.from(d.subarray(240, 250), (b) => (b < 32 || b > 126 ? ' ' : String.fromCharCode(b))).join('').trimEnd();
export { multiNameOf, slotNumber };

// ------------------------------------------------------------------ parameters from a model's OS tables
const SECTION_OF_TITLE = [
  [/ENVELOPE$/, 'env'], [/^OSC|^SUB OSC|^NOISE|^RINGMOD/, 'osc'], [/^FILTER|^SATURATION/, 'filter'], [/^LFO/, 'lfo'],
  [/^ASSIGN|^VELOCITY|^DEF \d SINGLE|^KNOB \d SINGLE/, 'mod'], [/^CHORUS|^DELAY|^REVERB|^PHASER|^EFFECTS|^V-FILTER|^EQUALIZER|^ANALOG BOOST|^DISTORTION|^INPUT RINGMOD/, 'fx'],
  [/^ARPEGGIATOR|^CLOCK/, 'arp'], [/^INPUT|^VOCODER/, 'input'],
];
const KNOB_SECTION = [[/Amp|Filt(er)? (Attack|Decay|Sustain|Release|Time)|Filt Sus|Filt Rel/, 'env'], [/Cutoff|Reso|Keyfollow|FilterBal|EnvAmount/, 'filter'], [/Lfo/, 'lfo'], [/Osc|Mixer/, 'osc']];
export const SINGLE_SECTIONS = [
  { key: 'common', label: 'Common' }, { key: 'osc', label: 'Oscillators' }, { key: 'filter', label: 'Filters' }, { key: 'env', label: 'Envelopes' },
  { key: 'lfo', label: 'LFOs' }, { key: 'mod', label: 'Modulation' }, { key: 'fx', label: 'Effects' }, { key: 'arp', label: 'Arpeggiator' },
  { key: 'input', label: 'Vocoder / input' }, { key: 'reserved', label: 'Not in the sound' },
];
const sectionOf = (title, knobText) => {
  if (title === 'Panel knobs') return (KNOB_SECTION.find(([re]) => re.test(knobText || '')) || [0, 'common'])[1];
  return (SECTION_OF_TITLE.find(([re]) => re.test(title.toUpperCase())) || [0, 'common'])[1];
};
const titleCase = (t) => t.replace(/^FILTERENVELOPE$/, 'FILTER ENVELOPE').toLowerCase().replace(/(^|[\s/(])([a-z])/g, (_m, a, b) => a + b.toUpperCase()).replace(/\bLfo\b/g, 'LFO').replace(/\bMidi\b/g, 'MIDI');
// (the LCD cuts long frequencies to five characters: "1831.")
const NUMERIC = /^(Off|[+-]?\d+(\.\d*)?(%|dB| dB|ms)?|- dB)$/;

/** Options (a selection: the screen's texts) or a knob with the screen's text (a continuous amount). */
function display(T, min, max, list) {
  const texts = T.LISTS[list] || [];
  const entries = texts.map((t, i) => [min + i, t]);
  // mostly numbers, unless the list opens with names (the C's Osc 3 mode: Off, Slave, Saw, Pulse, Sin, Tri, then waves 3-64)
  const numeric = texts.filter((t) => NUMERIC.test(t)).length >= texts.length * 0.9 && texts.slice(0, 3).filter((t) => !NUMERIC.test(t)).length < 2;
  if (numeric && max - min > 24) { const map = new Map(entries); return { format: (v) => map.get(v) ?? String(v) }; }
  // a wide stored range the screen shows in a few bands (Knob Display: Off < 15, Short < 50, Long < 99, On): a knob
  // showing the band, the stored value kept exact
  const bands = texts.filter((t, i) => i === 0 || t !== texts[i - 1]).length;
  if (max - min > 24 && bands <= 8) { const map = new Map(entries); return { format: (v) => `${map.get(v) ?? '?'} (${v})` }; }
  return { options: entries };
}
const KNOB_TEXT = (T) => new Map(T.KNOBS.flatMap(([k, text, tg]) => tg.map(([, o]) => [o, `${k}: ${text}`])));
/** The card a knob-only parameter goes on: its panel area, by the knob's screen text (the OS cuts names at 13 characters). */
const KNOB_GROUP = [
  [/^Mixer|^Osc\s*(Bal|Main|Vol)|^Sub\s*Osc|^Noise|^Ring/i, 'Mixer'], [/^Osc\s*1/i, 'Oscillator 1'], [/^Osc\s*2/i, 'Oscillator 2'], [/^Osc\s*3/i, 'Oscillator 3'],
  [/^Lfo\s*1/i, 'LFO 1'], [/^Lfo\s*2/i, 'LFO 2'], [/^Lfo\s*3/i, 'LFO 3'], [/^Amp/i, 'Amp Envelope'],
  [/^Filt(er)?\s*(Attack|Decay|Sustain|Release|Time|Sus|Rel|Att|Dec)/i, 'Filter Envelope'], [/^Cutoff|^F\s|^Filt|^Reso/i, 'Filters'],
];
const GROUP_SECTION = { Mixer: 'osc', 'Oscillator 1': 'osc', 'Oscillator 2': 'osc', 'Oscillator 3': 'osc', 'LFO 1': 'lfo', 'LFO 2': 'lfo', 'LFO 3': 'lfo', 'Amp Envelope': 'env', 'Filter Envelope': 'env', Filters: 'filter' };
const knobGroup = (...texts) => {
  for (const t of texts) { const g = t && KNOB_GROUP.find(([re]) => re.test(t)); if (g) return g[1]; }
  return titleCase(texts.at(-1) || 'Panel knobs');
};
const pageIndex = (o) => `${'AB'[o >> 7]} ${o & 127}`;
/** Sound parameters set with panel buttons and shown by LEDs only (no screen text): page A index -> [group, values]. */
const PANEL_BUTTONS = {
  28: ['Oscillator 2', ['Off', 'On'], 'Osc2Sync'], 51: ['Filter 1', ['LP', 'HP', 'BP', 'BS'], 'Filt1Mode'], 52: ['Filter 2', ['LP', 'HP', 'BP', 'BS'], 'Filt2Mode'],
  53: ['Filters', ['Ser4', 'Ser6', 'Par4', 'Split'], 'FiltRouting'], 69: ['LFO 1', ['Off', 'On'], 'Lfo1EnvMode'], 81: ['LFO 2', ['Off', 'On'], 'Lfo2EnvMode'],
};
/** Page A 4 of a B / Classic sound: the panel selections the knob handlers test (B 4.9: 6780 bits 0-1, 26E8 bit 6, 27C8 bit 5). */
const hex2 = (v) => `${v.toString(16).toUpperCase().padStart(2, '0')}h`;
const PANEL_BITS = (v) => `${['none', 'Filter 1', 'Filter 2', 'Filter 1+2'][v & 3]}; Osc 1 knob ${v & 0x20 ? 'Pulse Width' : 'Wave'}; Osc 2 knob ${v & 0x40 ? 'Pulse Width' : 'Wave'} (${hex2(v)})`;
/** The panel selections a sound keeps (offset -> parameter): the B / Classic keep them in page A 4. */
export const B_PANEL = {
  4: { label: 'Panel selections', format: PANEL_BITS, help: "Page A 4 holds the panel selections stored with the sound: bits 0-1 the filter the Cutoff / Resonance knobs edit, bit 5 / 6 whether the Osc 1 / Osc 2 knob edits Wave or Pulse Width. Controller 4 (Foot) is a performance control, not stored here." },
};
/** The C OS 6.6 keeps the filter select in page A 4 and the panel's section selections in page B 125-127 (its knob
 * handlers read them: 3A76 LFO, 3B4C / 3DA7 / 3E11 / 3E75 oscillator, 3BF2 / 3D37 effects, 3CCE / 3EA8 filter). */
/** The Rack XL keeps only the filter select (page A 4 bits 0-1; its knob pages replace the C's section selects). */
export const RXL_PANEL = { get 4() { return C_PANEL[4]; } };
export const C_PANEL = {
  4: { label: 'Filter select', group: 'Panel selections', format: (v) => `${['none', 'Filter 1', 'Filter 2', 'Filter 1+2'][v & 3]} (${hex2(v)})`, help: "Page A 4 bits 0-1: the filter the Cutoff, Resonance, Env Amount and Keyfollow knobs edit (stored with the sound). Controller 4 (Foot) is a performance control, not stored here." },
  253: { label: 'Effects select', group: 'Panel selections', readOnly: false, input: undefined, max: 2, options: [[0, 'Distortion'], [1, 'Phaser'], [2, 'Chorus']], help: "Page B 125: the effect the two effects knobs edit (Distortion type / intensity, Phaser mix / feedback, Chorus mix / depth); stored with the sound, set with the panel's effects button (no screen text: the names are the parameters the knobs edit)." },
  254: { label: 'LFO select', group: 'Panel selections', readOnly: false, input: undefined, max: 2, options: [[0, 'LFO 1'], [1, 'LFO 2'], [2, 'LFO 3']], help: "Page B 126: the LFO the LFO Rate knob edits (its rate, or its clock when the clock is on); stored with the sound, set with the panel's LFO button." },
  255: { label: 'Oscillator select', group: 'Panel selections', readOnly: false, input: undefined, max: 2, options: [[0, 'Osc 1'], [1, 'Osc 2'], [2, 'Osc 3']], help: "Page B 127: the oscillator the Wave / PW, Detune, Semitone and Sub / Osc 3 knobs edit (Osc 1 / 2: Wave while its Shape is below 64, else Pulse Width; Osc 3: its mode); stored with the sound, set with the panel's oscillator button." },
};

function singleParams(T, panel) {
  const out = [];
  const knobOf = KNOB_TEXT(T);
  const seen = new Set();
  for (const [page, rows] of [[0, T.PAGE_A], [1, T.PAGE_B]]) {
    for (const [i, label, title, min, max, list, knobNames, more, modes] of rows) {
      const offset = 128 * page + i;
      if (offset >= 240 && offset < 250) continue; // the name
      seen.add(offset);
      const knob = knobOf.get(offset);
      const isKnob = title.startsWith('Panel knobs');
      // a knob-only parameter: its controller name; without one (the A's OS has no numbered controller list) the knob's
      // text, or the knob display's numbered name when one knob edits several (F Resonance: Reso1 / Reso2)
      const shared = isKnob && rows.filter((r) => r[2].startsWith('Panel knobs') && r[1] === label).length > 1;
      const name = isKnob ? (T.CC_NAMES[i] && page === 0 ? T.CC_NAMES[i] : (shared && knobNames.find((n) => /\d$/.test(n))) || label) : label;
      // a knob-only parameter goes on its panel area's card ('Panel knobs: <menu title>' when the tables name it)
      const group = !isKnob ? titleCase(title) : title.includes(': ') ? titleCase(title.slice(title.indexOf(': ') + 2)) : knobGroup(name, knob?.replace(/^\d+: /, ''));
      const helpBits = [`${pageIndex(offset)}`, isKnob ? `panel knob ${knob}` : `menu ${title}${more.length ? `, also ${more.join(', ')}` : ''}`];
      if (knobNames.length) helpBits.push(`knob display ${knobNames.join(' / ')}`);
      if (page === 0 && T.CC_NAMES[i]) helpBits.push(`controller ${i} "${T.CC_NAMES[i]}"`);
      if (modes.length && modes.length < T.MODES.length) helpBits.push(`menu shown in ${modes.join(', ')}`);
      out.push({
        key: `s${offset}`, offset, label: name, group, section: isKnob ? GROUP_SECTION[group] || sectionOf(group, knob) : sectionOf(title, knob),
        min, max, help: helpBits.join('; '), ...display(T, min, max, list),
      });
    }
  }
  // bytes no menu or knob shows: what the parameter reader does with them (CLASS) and the controller names
  for (let o = 0; o < 256; o++) {
    if (seen.has(o) || (o >= 240 && o < 250)) continue;
    const i = o & 127;
    const cls = T.CLASS[`${'AB'[o >> 7]}${i}`];
    const cc = o < 128 ? T.CC_NAMES[i] : '';
    const p = { key: `s${o}`, offset: o, group: 'Not in the sound', section: 'reserved', min: 0, max: 127, input: 'number', readOnly: true };
    if (o === 0) { out.push({ ...p, label: 'Sound format', group: 'Common', section: 'common', help: 'Page A 0: the sound\'s version (6 in Virus B sounds, 7 in Virus C sounds); the Virus updates older sounds when they arrive. No screen shows it.' }); continue; }
    if (panel?.[o]) { out.push({ ...p, group: 'Common', section: 'common', ...panel[o] }); continue; }
    const button = PANEL_BUTTONS[o];
    if (button && cls === 'single') {
      out.push({ key: `s${o}`, offset: o, label: cc || button[2], group: button[0], section: sectionOf(button[0].toUpperCase()), min: 0, max: button[1].length - 1, options: button[1].map((t, v) => [v, t]),
        help: `${pageIndex(o)}: set with a panel button and shown by its LEDs only (no menu or screen text); the value names are from Access's documentation.` });
      continue;
    }
    const what = cls === 'controller' ? `a performance controller (${cc || `controller ${i}`}), not part of the sound`
      : cls === 'dsp' ? 'used inside the Virus\'s sound engine; no menu shows it'
        : cls === 'alias' ? 'the Virus uses this number for another setting (on the Rack XL, B 126 / 127 are the resonance / env amount of the selected filter, kept at A 42 / 43 or 44 / 45), not this value'
          : 'no menu, knob or screen of the Virus shows it';
    out.push({ ...p, label: o < 128 ? `Controller ${i}${cc ? ` (${cc})` : ''}` : `Reserved (${pageIndex(o)})`, help: `${pageIndex(o)}: ${what}. Kept as the Virus sends it.` });
  }
  return out;
}

// multi: page C indexes of the multi class (common) and the part rows / bits, as the TI kept the layout
export const partAt = (ci, part) => 32 + 16 * (ci - 32) + part;
const PART_LABEL = { 32: 'Bank', 33: 'Patch', 34: 'MIDI channel', 72: 'Part enable' };
/** Page C indexes the reader takes from a part's row (1220h + 10h x row + part) or switch bits (12F0h + part); C 31 reads
 * the same row as C 32 (Bank). */
const isPartIndex = (T, ci) => T.CLASS[`C${ci}`] === 'part' && ci !== 31;
function multiParams(T, names = () => []) {
  const out = [];
  const known = new Set();
  for (const [ci, label, title, min, max, list] of T.PAGE_C) {
    const cls = T.CLASS[`C${ci}`];
    if (ci >= 4 && ci <= 13) continue; // multi name
    if (cls !== 'multi') continue;
    known.add(ci);
    out.push({ key: `m${ci}`, offset: ci, label, group: titleCase(title), section: 'common', min, max, help: `page C ${ci} (menu ${title})`, ...display(T, min, max, list) });
  }
  const partRows = T.PAGE_C.filter(([ci]) => isPartIndex(T, ci));
  for (let part = 0; part < 16; part++) {
    const g = `Part ${part + 1}`;
    for (const [ci, label, title, min, max, list] of partRows) {
      const base = { key: `p${part}_${ci}`, label: PART_LABEL[ci] || label, group: g, section: `part${part}`, min, max, page: ci, part, help: `page C ${ci} (menu ${title})`, ...display(T, min, max, list) };
      if (ci >= 72) out.push({ ...base, offset: 240 + part, shift: ci - 72, bits: 1 });
      else out.push({ ...base, offset: partAt(ci, part) });
    }
    const at = partAt(33, part);
    out.push({ key: `p${part}_sound`, offset: at, label: 'Sound', group: g, section: `part${part}`, min: 0, max: 127, readOnly: true, part,
      help: 'The single this part holds now (read with the multi)', dynamic: (d) => ({ options: [[d[at], names(d)[part] ?? '(not read)']] }) });
  }
  const used = new Set(out.filter((p) => !p.bits).map((p) => p.offset));
  for (let o = 0; o < MULTI_SIZE; o++) {
    if (used.has(o) || (o >= 4 && o <= 13) || o >= 240) continue;
    const page = o >= 32 ? 32 + ((o - 32) >> 4) : o;
    out.push({ key: `m${o}`, offset: o, group: 'Reserved bytes', section: 'reserved', min: 0, max: 127, input: 'number', readOnly: true,
      label: o >= 32 ? `Part ${((o - 32) & 15) + 1} (page C ${page})` : `Multi byte ${o}`,
      help: o >= 32 ? `Page C ${page} of part ${((o - 32) & 15) + 1}: no menu of the Virus shows it. Kept as the Virus sends it.` : `Page C ${o}: ${T.CLASS[`C${o}`] === 'global' ? 'a global setting (Global page), not the multi\'s' : 'not a multi setting'}. Kept as the Virus sends it.` });
  }
  return out;
}
/** Global settings whose screen prints no label (the program screen): [label, group, what the OS does with it]. */
const UNLABELLED_GLOBAL = {
  71: ['Category (program select)', 'Program select', 'Shown under the bank and program on the program screen, with no label: stepping the program skips to the next sound whose Category 1 or Category 2 (single page B 123 / 124) is this one (B 4.9 36C7 / 372A, C 6.6 42D5).'],
};
function globalParams(T) {
  const out = [];
  for (const [ci, label, title, min, max, list, , more, modes] of T.PAGE_C) {
    if (T.CLASS[`C${ci}`] !== 'global' || ci === 122) continue;
    const [ul, ug, uh] = /^Unlabelled/.test(label) ? UNLABELLED_GLOBAL[ci] || [] : [];
    out.push({ key: `g${ci}`, offset: ci, label: ul || label || titleCase(title), group: ug || titleCase(title) || 'Other', section: 'global', min, max,
      help: `page C ${ci} (menu ${title || 'none'}${more.length ? `, also ${more.join(', ')}` : ''})${modes.length < T.MODES.length ? `; shown in ${modes.join(', ')}` : ''}${uh ? `. ${uh}` : ''}`, ...display(T, min, max, list) });
  }
  return out;
}

// ------------------------------------------------------------------ init data
/** Starting values of the knob-only parameters (no menu record, so no reset value in the OS): an open saw sound. */
const KNOB_INIT = { 20: 64, 171: 64, 217: 64, 17: 64, 18: 64, 22: 64, 23: 64, 25: 64, 33: 64, 36: 64, 40: 127, 41: 64, 47: 64, 55: 64, 56: 64, 57: 64, 58: 32, 60: 64, 61: 127, 62: 64, 63: 32, 67: 64, 79: 64 };
function initSingle(T, format) {
  const d = new Uint8Array(SINGLE_SIZE);
  for (const [page, rows] of [[0, T.PAGE_A], [1, T.PAGE_B]]) {
    for (const [i, , , min, max, , , , , init] of rows) d[128 * page + i] = Math.max(min, Math.min(max, init ?? KNOB_INIT[128 * page + i] ?? min));
  }
  d[0] = format;
  setName(d, 240, 'Init');
  return d;
}
function initMulti() {
  const d = new Uint8Array(MULTI_SIZE);
  d[0] = 1;
  setName(d, 4, 'Init Multi');
  for (let p = 0; p < 16; p++) {
    d[partAt(33, p)] = p; d[partAt(34, p)] = p; d[partAt(36, p)] = 127; d[partAt(37, p)] = 64; d[partAt(38, p)] = 64;
    d[partAt(39, p)] = 64; d[partAt(41, p)] = 1; d[partAt(43, p)] = 64; d[240 + p] = 0x47;
  }
  d[15] = 57; // 120 bpm
  return d;
}

/** Single banks of the B / Classic / C (1024 sounds since B OS 4.5): RAM A-B (SysEx banks 1-2), ROM C-H (3-8). */
export const BANKS_AH = [[1, 'RAM A', true], [2, 'RAM B', true], ...'CDEFGH'.split('').map((l, i) => [3 + i, `ROM ${l}`, false])];

// ------------------------------------------------------------------ the editor of one model
/**
 * model: display name; T: the OS tables (access-virus-<os>-os.js); banks: [[sysex bank, name, writable]] of singles;
 * multis: number of RAM multis; init: a factory single (256 bytes) to start from; note: what the doc says of the model.
 */
export function abcModel({ model, id, T, banks, multis = 128, format = 6, note, parts = 16, panelByte = false, panel = panelByte ? B_PANEL : null }) {
  const unit = { part: SINGLE_PART, partNames: [] };
  const sParams = singleParams(T, panel);
  const catMax = T.PAGE_B.find(([i]) => i === 123)?.[4] ?? 16;
  const byOffset = new Map(sParams.map((p) => [p.offset, p]));
  const mParams = multiParams(T, () => unit.partNames);
  const gParams = globalParams(T);
  const findMulti = (part, ci) => mParams.find((p) => p.part === part && p.page === ci);
  const initS = () => initSingle(T, format);
  const bankName = (b) => (b === 0 ? 'Edit buffer' : banks.find(([x]) => x === b)?.[1] ?? `bank ${b}`);
  const slotText = (b, i) => `${bankName(b)} ${slotNumber(i)}`;
  const partLabel = (p) => (p === SINGLE_PART ? 'Single mode' : `Part ${p + 1}`);
  const fxModes = T.PAGE_A.find(([i]) => i === 112) ? T.LISTS[T.PAGE_A.find(([i]) => i === 112)[5]] : null;

  async function fetchSingle(api, bank, prog) {
    const m = await collect(api, abcMsg.singleRequest(api.ctx, bank, prog), [0x10], 1, (raw) => raw[7] === bank && raw[8] === prog);
    const d = m[0] && singleFrom(m[0]);
    if (!d) throw new Error(`The Virus did not send ${bank ? slotText(bank, prog) : `the ${partLabel(prog)} edit buffer`}.`);
    return d;
  }
  async function fetchArrangement(api) {
    const m = await collect(api, abcMsg.arrangementRequest(api.ctx), [0x10, 0x11], 17, (raw) => raw[7] === 0 && (raw[6] === 0x11 || raw[8] < 16));
    for (const raw of m) if (cmdOf(raw) === 0x10) unit.partNames[raw[8]] = nameOf(singleFrom(raw));
    const d = dataFrom(m.find((raw) => cmdOf(raw) === 0x11) || [], 0x11);
    if (!d) throw new Error('The Virus did not send its multi edit buffer.');
    return d;
  }
  async function fetchMulti(api, prog) {
    const m = await collect(api, abcMsg.multiRequest(api.ctx, 1, prog), [0x11], 1, (raw) => raw[7] === 1 && raw[8] === prog);
    const d = m[0] && dataFrom(m[0], 0x11);
    if (!d) throw new Error(`The Virus did not send multi ${slotNumber(prog)}.`);
    return d;
  }
  async function fetchGlobal(api) {
    const m = await collect(api, abcMsg.globalRequest(api.ctx), [0x12], 1);
    const d = m[0] && globalFrom(m[0]);
    if (!d) throw new Error('The Virus did not send its global settings.');
    return d;
  }
  const scan = (cmd) => async (api, bank, onName) => {
    const single = cmd === 0x10;
    await collect(api, single ? abcMsg.singleBankRequest(api.ctx, bank) : abcMsg.multiBankRequest(api.ctx, 1), [cmd], 128,
      (raw) => raw[7] === (single ? bank : 1), (x) => onName(x[8], single ? nameOf(singleFrom(x)) : multiNameOf(dataFrom(x, 0x11))));
  };

  const receive = (raw, data, ctx) => {
    const part = unit.part;
    if (isVirus(raw)) {
      const page = PAGES.indexOf(raw[6]);
      if (page >= 0 && page < 2 && raw[7] === part && raw.length >= 11) { const d = Uint8Array.from(data); d[page * 128 + raw[8]] = raw[9]; return d; }
      if (raw[6] === 0x10 && raw[7] === 0 && raw[8] === part) return singleFrom(raw);
      return null;
    }
    const ch = (ctx?.channel ?? 0) & 15;
    const st = raw[0] & 0xf0;
    if ((raw[0] & 15) !== ch || part !== SINGLE_PART) return null;
    if (st === 0xb0 && byOffset.has(raw[1]) && !byOffset.get(raw[1]).readOnly) { const d = Uint8Array.from(data); d[raw[1]] = raw[2]; return d; }
    if (st === 0xa0 && byOffset.has(128 + raw[1]) && !byOffset.get(128 + raw[1]).readOnly) { const d = Uint8Array.from(data); d[128 + raw[1]] = raw[2]; return d; }
    return null;
  };

  function describe(raw) {
    if (!isVirus(raw)) return null;
    const c = raw[6];
    if (c === 0x10 && raw.length >= 267) return `${model} single ${raw[7] === 0 ? `edit buffer (${partLabel(raw[8])})` : slotText(raw[7], raw[8])} "${nameOf(singleFrom(raw))}"`;
    if (c === 0x11 && raw.length >= 267) return `${model} multi ${raw[7] === 0 ? 'edit buffer' : slotNumber(raw[8])} "${multiNameOf(dataFrom(raw, 0x11))}"`;
    if (c === 0x12) return `${model} global settings`;
    const names = { 0x30: 'single request', 0x31: 'multi request', 0x32: 'single bank request', 0x33: 'multi bank request', 0x34: 'arrangement request', 0x35: 'global request', 0x70: 'page A parameter', 0x71: 'page B parameter', 0x72: 'page C parameter' };
    return `${model} ${names[c] || `command ${c.toString(16)}`}`;
  }
  function libraryItems(msgs) {
    const items = [];
    msgs.forEach((m, i) => {
      const c = cmdOf(m);
      if (c === 0x10 && m.length >= 267) items.push({ key: `s${m[7]}:${m[8]}:${i}`, label: m[7] ? slotText(m[7], m[8]) : `Single edit buffer (${partLabel(m[8])})`, name: nameOf(singleFrom(m)), object: 'single', msgs: [m] });
      else if (c === 0x11 && m.length >= 267) items.push({ key: `m${m[7]}:${m[8]}:${i}`, label: m[7] ? `Multi ${slotNumber(m[8])}` : 'Multi edit buffer', name: multiNameOf(dataFrom(m, 0x11)), object: 'multi', msgs: [m] });
      else if (c === 0x12 && m.length >= 267) items.push({ key: `g${i}`, label: 'Global settings', name: 'Global', object: 'global', msgs: [m] });
    });
    return items;
  }
  // Head Library: dumps 10 / 11 / 12 that parse; requests 30-35. A file read without a device hint: A / B / C singles
  // are 267 bytes (a TI's 524) and carry their OS's sound format in page A 0 (6 B / Classic, 7 C), so the family whose
  // format the singles carry wins; models of one OS score alike (the device hint, else the first, decides).
  const recognise = (m) => [0x10, 0x11, 0x12].includes(cmdOf(m)) && !!dataFrom(m, cmdOf(m));
  const isRequest = (m) => cmdOf(m) >= 0x30 && cmdOf(m) <= 0x35;
  const prefer = (msgs) => {
    const short = msgs.filter((m) => cmdOf(m) === 0x10 && m.length < 524);
    const s = msgs.filter((m) => cmdOf(m) === 0x10).length;
    return 1 + (s ? short.length / s : 0) + (short.length ? 0.5 * short.filter((m) => m[9] === format).length / short.length : 0);
  };

  function simulate() {
    const singles = new Map();
    for (const [b] of banks) for (let i = 0; i < 128; i++) { const d = initS(); setName(d, 240, `${bankName(b).slice(-1)}${slotNumber(i)} Sgl`); singles.set(`${b}:${i}`, d); }
    const multisM = Array.from({ length: multis }, (_, i) => { const d = initMulti(); setName(d, 4, `Multi ${slotNumber(i)}`); return d; });
    const s = { single: initS(), parts: Array.from({ length: 16 }, () => initS()), multi: initMulti(), global: new Uint8Array(GLOBAL_SIZE), singles, multis: multisM };
    const ctx = { deviceId: 0x00 };
    const buf = (p) => (p === SINGLE_PART ? s.single : s.parts[p & 15]);
    const writable = (b) => banks.some(([x, , w]) => x === b && w);
    return {
      state: s,
      handle(raw) {
        const d = Array.from(raw);
        if (d[0] !== 0xf0) return [];
        if (!isVirus(d)) return null;
        const [c, b, p] = [d[6], d[7], d[8]];
        switch (c) {
          case 0x30: return b === 0 ? [abcMsg.single(ctx, 0, p, buf(p))] : singles.has(`${b}:${p}`) ? [abcMsg.single(ctx, b, p, singles.get(`${b}:${p}`))] : [];
          case 0x31: return b === 0 ? [abcMsg.multi(ctx, 0, 0x7f, s.multi)] : b === 1 && p < multis ? [abcMsg.multi(ctx, 1, p, multisM[p])] : [];
          case 0x32: return singles.has(`${b}:0`) ? Array.from({ length: 128 }, (_, i) => abcMsg.single(ctx, b, i, singles.get(`${b}:${i}`))) : [];
          case 0x33: return b === 1 ? multisM.map((m, i) => abcMsg.multi(ctx, 1, i, m)) : [];
          case 0x34: return [abcMsg.multi(ctx, 0, 0x7f, s.multi), ...s.parts.map((x, i) => abcMsg.single(ctx, 0, i, x))];
          case 0x35: return [abcMsg.global(ctx, s.global)];
          case 0x10: { const x = singleFrom(Uint8Array.from(d)); if (!x) return []; if (b === 0) buf(p).set(x); else if (writable(b) && s.global[118] === 0) singles.get(`${b}:${p}`)?.set(x); return []; }
          case 0x11: { const x = dataFrom(Uint8Array.from(d), 0x11); if (!x) return []; if (b === 0) s.multi.set(x); else if (b === 1 && p < multis && s.global[118] === 0) multisM[p].set(x); return []; }
          case 0x12: { const x = globalFrom(Uint8Array.from(d)); if (x) s.global.set(x); return []; }
          case 0x70: case 0x71: buf(b)[(c - 0x70) * 128 + p] = d[9]; return [];
          case 0x72:
            if (p >= 72 && p <= 78) { const at = 240 + (b & 15); s.multi[at] = (s.multi[at] & ~(1 << (p - 72))) | ((d[9] & 1) << (p - 72)); } else if (T.CLASS[`C${p}`] === 'part') s.multi[partAt(Math.max(32, p), b & 15)] = d[9];
            else if (T.CLASS[`C${p}`] === 'multi') s.multi[p] = d[9]; else s.global[p] = d[9];
            return [];
          default: return [];
        }
      },
    };
  }

  const PART_TARGET = {
    label: 'Edit buffer', title: 'Which edit buffer the page reads and edits: the single of single mode, or a part of the multi',
    options: () => [[SINGLE_PART, 'Single mode'], ...Array.from({ length: parts }, (_, i) => [i, `Multi part ${i + 1}`])],
    value: () => unit.part, set: (v) => { unit.part = Number(v); },
  };
  const singleBanks = banks.map(([b, n]) => [b, n]);
  const DEF = {
    model,
    coverage: `${model}: ${note} Edits the singles (every parameter the Virus's menus and panel knobs edit, with its own labels, ranges and value texts; values no screen shows are kept read-only), the multi (16 parts, with a MIDI channels page) and the global settings; the single banks with their names, the RAM multis, Store to RAM, the Branch Library and Head Library. Not checked on a unit.`,
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
        key: 'single', page: 'Single', icon: '◆', label: 'Single', size: SINGLE_SIZE, autoLoad: true,
        init: initS, params: sParams, name: nameOf, cols: 3,
        fetch: (api) => fetchSingle(api, 0, unit.part),
        target: PART_TARGET,
        sections: SINGLE_SECTIONS,
        groupInfo: { 'Not in the sound': { note: 'Values no menu, panel knob or screen of the Virus shows: performance controllers (page A 1-16, 64-66, not part of the sound) and places without a setting. Kept as the Virus sends them, so a backup restores exactly.', table: true, wide: true } },
        sendParam: (p, _v, data, ctx) => abcMsg.param(ctx, p.offset >> 7, unit.part, p.offset & 127, data[p.offset]),
        receive,
        note: 'Each change is sent at once to the edit buffer chosen above. Store writes the single into a RAM slot.',
        sendAll: { label: 'Send to Virus', title: 'Send the whole single into the chosen edit buffer', build: (data, ctx) => abcMsg.single(ctx, 0, unit.part, data) },
        toSyx: (data, ctx) => [abcMsg.single(ctx, 0, SINGLE_PART, data)],
        fromSyx: (msgs) => { const m = msgs.find((x) => cmdOf(x) === 0x10); return m ? singleFrom(m) : null; },
        toCommon: (d) => TR.singleToCommon(d, id, fxModes),
        fromCommon: (c, base) => TR.singleFromCommon(c, base),
        category: (d) => TR.singleCategory(d),
        setCategory: (d, cat) => TR.singleSetCategory(d, cat, catMax),
        setName: (d, name) => setName(d, 240, name),
        slots: {
          label: 'Singles', banks: singleBanks, count: 128,
          slotLabel: (bank, i) => slotText(bank, i), name: nameOf,
          fetch: (api, bank, i) => fetchSingle(api, bank, i),
          play: async (api, bank, i) => { const d = await fetchSingle(api, bank, i); api.send(abcMsg.single(api.ctx, 0, unit.part, d)); },
          scanBank: scan(0x10), namesOnOpen: true,
          store: (bank, i, ctx, data) => abcMsg.single(ctx, bank, i, data),
          writable: (bank) => banks.some(([b, , w]) => b === bank && w),
          note: (bank) => `Play reads the single and sends it into the edit buffer chosen above. Read names reads the whole bank.${banks.some(([b, , w]) => b === bank && w) ? ' Store writes into this RAM slot (Memory Protect Off, MIDI Dump RX Enable).' : ' ROM banks cannot be written.'}`,
        },
      },
      {
        key: 'multi', page: 'Multi', icon: '▦', label: 'Multi', size: MULTI_SIZE, autoLoad: false,
        init: initMulti, params: mParams, name: multiNameOf, cols: 3,
        fetch: (api) => fetchArrangement(api),
        sections: [{ key: 'common', label: 'Common' }, ...Array.from({ length: 16 }, (_, i) => ({ key: `part${i}`, label: `Part ${i + 1}` })), { key: 'reserved', label: 'Reserved bytes' }],
        groupInfo: { 'Reserved bytes': { note: 'Multi values no menu of the Virus shows. Kept as the Virus sends them.', table: true, wide: true } },
        sendParam: (p, _v, data, ctx) => (p.part === undefined ? abcMsg.param(ctx, 2, 0, p.offset, data[p.offset]) : abcMsg.param(ctx, 2, p.part, p.page, readParam(data, p))),
        note: 'Each change is sent at once. A part plays the single of its Bank and Patch on its MIDI channel; in multi mode the parts\' sounds are in their part edit buffers (Single page, Edit buffer: Multi part n).',
        sendAll: { label: 'Send to Virus', title: 'Send the multi into the Virus\'s multi edit buffer', build: (data, ctx) => abcMsg.multi(ctx, 0, 0x7f, data) },
        toSyx: (data, ctx) => [abcMsg.multi(ctx, 0, 0x7f, data)],
        fromSyx: (msgs) => { const m = msgs.find((x) => cmdOf(x) === 0x11); return m ? dataFrom(m, 0x11) : null; },
        toCommon: (d) => TR.multiToCommon(d, id),
        fromCommon: (c, base) => TR.multiFromCommon(c, base),
        setName: (d, name) => setName(d, 4, name),
        multi: {
          page: 'MIDI channels', label: 'Parts', count: parts, section: (i) => `part${i}`, partLabel: (i) => `Part ${i + 1}`,
          columns: [
            { label: 'Sound', params: ['Sound'], role: 'patch' },
            { label: 'Bank / patch', params: ['Bank', 'Patch'] },
            { label: 'MIDI channel', params: ['MIDI channel'], role: 'channel' },
            { label: 'On', params: ['Part enable'], role: 'on' },
            { label: 'Volume', params: [mParams.find((p) => p.part === 0 && p.page === 39)?.label ?? 'PartVolume'] },
            { label: 'Pan', params: [mParams.find((p) => p.part === 0 && p.page === 43)?.label ?? 'PartPan'] },
            { label: 'Key range', params: [mParams.find((p) => p.part === 0 && p.page === 35)?.label ?? 'LowKey', mParams.find((p) => p.part === 0 && p.page === 36)?.label ?? 'HighKey'] },
          ].filter((c) => c.params.every((n) => mParams.some((p) => p.part === 0 && p.label === n))), // the A's parts have no pan
          on: (i, d) => readParam(d, findMulti(i, 72)) === 1,
          note: 'Each part plays the single in its edit buffer (Sound) on its MIDI channel; Part enable switches it on. Get from device reads the multi and the 16 part singles. Changes go to the multi edit buffer; store the multi to keep them.',
        },
        slots: {
          label: 'Multis', banks: [[1, 'RAM multis']], count: multis,
          slotLabel: (_bank, i) => slotNumber(i), name: multiNameOf,
          fetch: (api, _bank, i) => fetchMulti(api, i),
          scanBank: scan(0x11), namesOnOpen: true,
          store: (_bank, i, ctx, data) => abcMsg.multi(ctx, 1, i, data),
          writable: () => true,
          note: () => 'Read names reads all multis. Store writes the multi into its slot (Memory Protect Off).',
        },
      },
      {
        key: 'global', page: 'Global', icon: '⚙', label: 'Global', size: GLOBAL_SIZE, autoLoad: false,
        init: () => { const d = new Uint8Array(GLOBAL_SIZE); d[118] = 0; return d; }, params: gParams, cols: 3,
        fetch: (api) => fetchGlobal(api),
        sections: [{ key: 'global', label: 'Settings' }],
        sendParam: (p, _v, data, ctx) => abcMsg.param(ctx, 2, 0, p.offset, data[p.offset]),
        toSyx: (data, ctx) => [abcMsg.global(ctx, data)],
        fromSyx: (msgs) => { const m = msgs.find((x) => cmdOf(x) === 0x12); return m ? globalFrom(m) : null; },
        note: 'The global settings. Get from device reads them; each change is sent at once. Memory Protect should stay Off.',
      },
    ],
    // Each step ends as soon as its dumps are in (expect). The seconds are an estimate (not measured on these models:
    // a 267-byte dump takes 86 ms at MIDI speed); the ROM banks are an optional group, ticked.
    fullDump: [
      { request: 'Single edit buffer', expect: 1, timeout: 3000, seconds: 1 },
      { request: 'Arrangement (multi and its 16 singles)', expect: 17, timeout: 30000, seconds: 3 },
      { request: 'Global settings', expect: 1, timeout: 3000, seconds: 1 },
      ...banks.filter(([, , w]) => w).map(([, n]) => ({ request: `${n} singles`, expect: 128, timeout: 30000, seconds: 15 })),
      { request: 'RAM multis', expect: multis, timeout: 30000, seconds: 15 },
      ...banks.filter(([, , w]) => !w).map(([, n]) => ({ request: `${n} singles`, expect: 128, timeout: 30000, seconds: 15,
        group: `ROM banks ${banks.filter(([, , w]) => !w).map(([, x]) => x.replace(/^ROM /, '')).join('').replace(/^(.).*(.)$/, '$1-$2')} (the factory sounds)`, optional: true })),
    ],
    requests: [
      { label: 'Single edit buffer', bytes: (ctx) => abcMsg.singleRequest(ctx, 0, SINGLE_PART) },
      ...Array.from({ length: 16 }, (_, i) => ({ label: `Part ${i + 1} single`, bytes: (ctx) => abcMsg.singleRequest(ctx, 0, i) })),
      { label: 'Multi edit buffer', bytes: (ctx) => abcMsg.multiRequest(ctx, 0, 0) },
      { label: 'Arrangement (multi and its 16 singles)', bytes: (ctx) => abcMsg.arrangementRequest(ctx) },
      { label: 'Global settings', bytes: (ctx) => abcMsg.globalRequest(ctx) },
      ...banks.map(([b, n]) => ({ label: `${n} singles`, bytes: (ctx) => abcMsg.singleBankRequest(ctx, b) })),
      { label: 'RAM multis', bytes: (ctx) => abcMsg.multiBankRequest(ctx, 1) },
    ],
  };
  DEF._test = { unit, sParams, mParams, gParams, byOffset, findMulti, initMulti, partAt };
  return DEF;
}
