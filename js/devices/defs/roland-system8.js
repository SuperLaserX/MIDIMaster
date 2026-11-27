// Roland SYSTEM-8 (OS 1.32): editor for the SYSTEM-8 engine (slot 0), its performances and system block, and
// the patch memory of the PLUG-OUT slots. See docs/devices/roland-system8.md (protocol, address map, value
// sources) and docs/devices/roland-system8-handoff.md (work state, next phases).
//
// Connections (checked on the unit 2026-11-26, tools/system8/port_caps.py):
//   USB "SYSTEM-8 CTRL"  Roland SysEx RQ1/DT1 (model 00 00 7E, device 10h), program change + bank select,
//                        PLUG-OUT install. Every read and write of this editor.
//   USB "SYSTEM-8"       notes, CC, program change + bank select, clock; DT1 is ignored, RQ1 unanswered.
//   DIN MIDI IN/OUT      per the MIDI implementation chart: notes, CC, program change, SysEx; whether the
//                        RQ1/DT1 parameter SysEx is taken there is unchecked (no DIN cable on this unit).
//
// A sound is three structs (roland-system8-mem.js): `patch` (panel values, name, arpeggio, patch cords),
// `patch2` (effect details, chord memory, velocity sensitivities, patch tempo, comment) and `patch3` (step
// sequencer); the patch object holds all three (20195 bytes). Labels: Roland's plugin script names; value
// texts: the OS 1.32 parameter catalog (every value's range and screen text, roland-system8-os.js) and, for the
// engine's own values (waves, ranges, variations, filter types, patch cords), the unit's region-0 lists; the
// performance and the system block come from the OS catalog alone. See the doc's "Value sources" table.

import { readParam, writeParam } from '../../core/model/memmap.js';
import { PATCH as ROWS, PATCH2 as ROWS2, PATCH3_COM as ROWS3, LISTS, TABLES, OS_GROUPS } from './roland-system8-fw.js';
import { osParams, osDescribe, osRowsByAddr, osStore, osText, TAGS } from './roland-system8-os.js';
import * as M from './roland-system8-mem.js';
import * as TR from './roland-system8-translate.js';
import * as INST from './roland-system8-install.js';
import * as SD from './roland-system8-sd.js';

export { MODEL, DEV, A, a28, dt1, rq1, parse, isS8, slotPatchAddr, slotBases, perfAddr } from './roland-system8-mem.js';
const { A, dt1, rq1, parse, S_PATCH, S_PATCH2, S_PATCH3, S_PERF, S_SYSTEM, FULL_SIZE } = M;
export const PATCH_SIZE = 640;
export const TEMP = { patch: A(0x03), upper: A(0x03, 0x20), lower: A(0x03, 0x30) };
export const LEAVES = M.PATCH_LEAVES;
const dev = (ctx) => (ctx?.deviceId ?? M.DEV) & 0x7f;
const channel = (ctx) => (ctx?.channel ?? 0) & 15;
const slotLabel = (_bank, i) => `${'ABCDEFGH'[i >> 3]}-${(i & 7) + 1}`;

// ------------------------------------------------------------------ value texts
const ONOFF = [[0, 'OFF'], [1, 'ON']];
const list = (n) => LISTS[n] || [];
const opts = (texts, min = 0) => texts.map((t, i) => [i + min, t]);
const signed = (bias) => (v) => (v - bias > 0 ? `+${v - bias}` : String(v - bias));
const off255 = (v) => (v ? String(v) : 'OFF');
const fromTable = (name, offset = 0) => (v) => TABLES[name]?.[v + offset] ?? String(v);
const slice6 = (n, variation) => opts(list(n).slice(variation * 6, variation * 6 + 6));
const NOTE = (n) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12]}${Math.floor(n / 12) - 1}`;
const noteOpts = (max = 127) => Array.from({ length: max + 1 }, (_, n) => [n, NOTE(n)]);
// reference manual p. 15-16 (Patch Effects: DELAY/CHORUS and REVERB parameters)
const HI_CUT = ['630Hz', '800Hz', '1kHz', '1.25kHz', '1.6kHz', '2kHz', '2.5kHz', '3.15kHz', '4kHz', '5kHz', '6.3kHz', '8kHz', '10kHz', '12.5kHz', 'FLAT'];
const LO_CUT = ['FLAT', '20Hz', '25Hz', '31.5Hz', '40Hz', '50Hz', '63Hz', '80Hz', '100Hz', '125Hz', '160Hz', '200Hz', '250Hz', '315Hz', '400Hz', '500Hz', '630Hz', '800Hz'];
const DAMP_LO_F = ['80.0Hz', '100Hz', '125Hz', '160Hz', '200Hz', '250Hz', '315Hz', '400Hz', '500Hz', '630Hz', '800Hz'];
const damp = (v) => (v >= 81 ? '-INF' : `${(-v / 2).toFixed(1)} dB`.replace('-0.0', '0.0'));
const level127 = (v) => (v === 0 ? '-INF' : `${(-53 + (v - 1) / 2).toFixed(1)} dB`); // -INF, -53.0 .. +10.0 dB
const PAN11 = ['L5', 'L4', 'L3', 'L2', 'L1', 'CENTER', 'R1', 'R2', 'R3', 'R4', 'R5'];
const floatOf = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v >>> 0); return b.getFloat32(0); };
const MODELS = { 1: 'SH-101', 2: 'SH-2', 3: 'SYSTEM-100', 4: 'PROMARS', 5: 'SYSTEM-8', 6: 'JUPITER-8', 7: 'JUNO-106', 8: 'JX-3P', 10: 'JUNO-60', 11: 'JUPITER-4' };

// ------------------------------------------------------------------ patch struct parameters
const GROUPS = [
  [/^LFO (CV|RING|PITCH|FILTER|AMP) IN$|^OSC1 X-MOD IN$|^OSC2 (SYNC|RING) IN$|^OSC3 EXT IN$|^(P|F|A) ENV GATE IN$|^(PITCH|FILTER|AMP) ENV IN$|^LFO CV GAIN$/, 'Routing'],
  [/^LFO/, 'LFO'], [/^OSC1/, 'OSC1'], [/^OSC2/, 'OSC2'], [/^OSC3/, 'OSC3'], [/^MIXER/, 'Mixer'], [/^PITCH/, 'Pitch'],
  [/^FILTER|^F ENV/, 'Filter'], [/^AMP|^A ENV/, 'Amp'], [/^EFFECT|^REVERB|^DELAY/, 'Effects'],
  [/^ARP|^SCATTER|^OCTAVE|^KEY HOLD|^INPUT/, 'Arpeggio / keyboard'], [/^BEND|^MOD SENS/, 'Bend / mod'],
  [/./, 'Control'],
];
const groupOf = (name) => GROUPS.find(([re]) => re.test(name))[1];
const keyOf = (name) => name.replace(/[()]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Region 0 list numbers: 1 LFO waves, 2 OSC waves, 3 ranges, 4 OSC MOD sources, 5 OSC3 waves, 6 variation numbers,
// 7 filter variations, 8 filter types, 9 patch-cord sources.
const EXTRA = {
  'LFO WAVE': { dynamic: (d) => ({ options: slice6(1, Math.min(2, varOf(d, 'lfo_variation'))) }) },
  'LFO VARIATION': { options: opts(['1', '2', '3']), help: 'Region 0: LFO variations 1-3 (wave lists SIN..RND, SINx2..RNDx2, TYPE1..TYPE6)' },
  'OSC1 VARIATION': { options: opts(list(6)) }, 'OSC2 VARIATION': { options: opts(list(6)) },
  'OSC1 WAVE': { dynamic: (d) => ({ options: slice6(2, Math.min(3, varOf(d, 'osc1_variation'))) }) },
  'OSC2 WAVE': { dynamic: (d) => ({ options: slice6(2, Math.min(3, varOf(d, 'osc2_variation'))) }) },
  'OSC1 MOD': { options: opts(list(4)) }, 'OSC2 MOD': { options: opts(list(4)) },
  'OSC1 RANGE': { options: opts(list(3)) }, 'OSC2 RANGE': { options: opts(list(3)) },
  'OSC3 WAVE': { options: opts(list(5)) },
  'FILTER VARIATION': { options: opts(list(7)) },
  'FILTER TYPE': { dynamic: (d) => ({ options: slice6(8, Math.min(7, varOf(d, 'filter_variation'))) }) },
  'PORTA TYPE': { options: opts(TABLES.portamentoType), help: 'The OS catalog has no text for this byte ((MOD ASIGN)); the plugin list' },
  'DELAY TIME': { dynamic: (d) => (varOf(d, 'tempo_sync') ? { format: fromTable('efxDelayTime') } : {}) },
  'LFO RATE': { dynamic: (d) => (varOf(d, 'tempo_sync') ? { format: fromTable('modulatorRate') } : {}) },
};
for (const n of ['SCATTER TYPE', 'SCATTER DEPTH']) EXTRA[n] = { help: 'Kept from the SYSTEM-1 layout (OS catalog texts); the SYSTEM-8 has no scatter control' };
EXTRA['INPUT JACK USING'] = { input: 'number', help: 'OS: INPUT JACK USING (SYSTEM1m), 0-65535; the SYSTEM-8 has no patch-cord jacks' };
for (const n of ['LFO CV IN', 'LFO RING IN', 'LFO PITCH IN', 'LFO FILTER IN', 'LFO AMP IN', 'OSC1 X-MOD IN', 'OSC2 SYNC IN', 'OSC2 RING IN', 'OSC3 EXT IN', 'P ENV GATE IN', 'PITCH ENV IN', 'F ENV GATE IN', 'FILTER ENV IN', 'A ENV GATE IN', 'AMP ENV IN']) EXTRA[n] = { options: opts(list(9)) };

// The OS catalog row of a struct value: by its address in the temporary area (patch 03, patch2 05, patch3 06;
// steps 2-64 have step 1's descriptions).
const OS_BY_ADDR = osRowsByAddr();
const OS_B0 = new Map([[S_PATCH, 0x03], [S_PATCH2, 0x05], [S_PATCH3, 0x06]]);
function osRowOf(st, offset) {
  let o = offset;
  if (st === S_PATCH3 && o >= 0x1000 && o < 65 * 0x800) o = 0x800 + (o % 0x800);
  return OS_BY_ADDR.get(A(OS_B0.get(st)) + o) || null;
}
/** The OS's screen texts of a row (its catalog record), merged into parameter `p`. patch2 / patch3 values are
 *  the OS's own (effects, chord memory, step sequencer): their range and storage come from the catalog too. The
 *  patch struct's panel values belong to the engine (PLUG-OUT): the plugin script's range and storage stay, the
 *  catalog gives the texts (mapped through its bias), and the region-0 lists (EXTRA) override them. */
function withOs(p, st, offset, bytes) {
  const r = osRowOf(st, offset);
  if (!r || r[3] !== bytes) return p;
  const [i, name, , , min, max, def, bias, flags, text] = r;
  const os = { os: i, osLabel: name.trim(), ...(st !== S_PATCH ? { osDefault: def } : {}) };
  if (max < min) return { ...p, ...os, input: 'number', help: `OS: ${name.trim()} (${text.replace(/[\x00-\x1f]+/g, ' ').trim()}), a raw 32-bit word` };
  if (st !== S_PATCH) return { ...p, ...os, min, max, signed: undefined, bias: undefined, ...osStore(flags, bias, min), ...osDescribe(text, min, max), input: undefined };
  const b = flags & 2 ? bias : 0;
  const lo = p.min; const hi = p.max;
  const d = osDescribe(text, min, max);
  if (d.options) {
    const by = new Map(d.options);
    const opts = [];
    for (let v = lo; v <= hi; v++) opts.push([v, by.get(v - b) ?? osText(text, v - b, min)]);
    return { ...p, ...os, options: opts };
  }
  return { ...p, ...os, format: (v) => d.format(v - b), ...(d.help ? { help: d.help } : {}), ...(d.input ? { input: d.input } : {}) };
}

/** A parameter from a plugin-script row: [name, leaf, packed offset, bytes, bits, min, max, default]. */
function rowParam([name, leaf, offset, bytes, bits, min, max], st = S_PATCH, extra = EXTRA, at = 0) {
  const hidden = /^\(/.test(name) && min === max;
  let p = {
    key: (/^\(/.test(name) ? 'x_' : '') + keyOf(name), label: name.replace(/[()]/g, ''), group: groupOf(name.replace(/[()]/g, '')),
    offset: st.compact(offset + at), ...(bits === 4 ? { nibbles: bytes } : { size: 1 }),
    min, max, ...(min < 0 ? { signed: true } : {}),
    ...(hidden ? { hidden: true } : {}),
    leaf,
  };
  p = withOs(p, st, offset + at, bits === 4 ? bytes : 1);
  if (/^\(/.test(name)) p.help = `The SYSTEM-8 keeps this value off its panel and menus (name in parentheses in the plugin's Script.xml, ${p.osLabel || name} in the OS); ${p.help || 'raw value'}.`;
  return Object.fromEntries(Object.entries({ ...p, ...(extra[name] || {}) }).filter(([, v]) => v !== undefined));
}

// patch2: effect details, chord memory, sensitivities, tempo, comment, rating. Ranges and texts: the OS catalog
// (withOs); labels: the OS's menu names (the same as the reference manual p. 15-16).
const DC = 'Delay / chorus';
const P2 = {
  'LFO RATE H': { group: 'High resolution', label: 'LFO RATE (float)', format: (v) => floatOf(v).toFixed(5), help: 'IEEE float 0.0-1.0 (3F800000 = 1.0): the fine LFO rate the plugin keeps beside the 8-bit panel value (OS: LFO RATE, 0-1065353216)' },
  'FILTER CUTOFF H': { group: 'High resolution', label: 'FILTER CUTOFF (float)', format: (v) => floatOf(v).toFixed(5), help: 'IEEE float 0.0-1.0: the fine cutoff beside the 8-bit panel value (OS: FILTER CUTOFF, 0-1065353216)' },
  'FILTER VELOCITY SENS': { group: 'Velocity / tempo', label: 'FILTER Velo Sens' }, 'AMP VELOCITY SENS': { group: 'Velocity / tempo', label: 'AMP Velo Sens' },
  'Patch Tempo': { group: 'Velocity / tempo', label: 'PatchTempo', help: 'TEMPO: PatchTempo 40.0-300.0 (used when SYSTEM: SYNC/TEMPO: Patch Tempo is ON)' },
  'CHORD MEMORY SW': { group: 'Chord memory' }, 'CHORD MEMORY Form': { group: 'Chord memory' },
  rating: { group: 'Comment', options: opts(['0', '1', '2', '3']), help: 'The plugin patch rating (0-3 stars); the OS keeps this word as reserved' },
};
const P2_GROUP = { PAT2_DLY: DC, PAT2_CHO: DC, PAT2_FL: DC, PAT2_MFX: 'MFX (no menu)', PAT2_REV: 'Reverb', PAT2_CHORD: 'Chord memory' };
function p2Param(r, st = S_PATCH2, at = 0, prefix = '') {
  const name = r[0];
  const p = rowParam(r, st, {}, at);
  const x = P2[name] || {};
  const group = x.group || P2_GROUP[r[1]] || 'Effects';
  const label = x.label || p.osLabel || p.label;
  const help = /SEPARATIOIN|LFO SOURCE|LFO EXT|^MFX/.test(name) ? `${p.help ? `${p.help}. ` : ''}No SYSTEM-8 menu shows it (reference manual p. 15-16); OS catalog name ${p.osLabel || name}` : p.help;
  return Object.fromEntries(Object.entries({ ...p, group, ...x, label, help: x.help || help, key: prefix + p.key }).filter(([, v]) => v !== undefined));
}
const PATCH2_ROWS = ROWS2.filter((r) => r[1] !== 'NAME');

// patch3: step sequencer common + 64 steps (leaf 1 + step). Ranges and texts: the OS catalog (withOs; the steps
// share step 1's records), labels: the OS's names.
function p3Params() {
  const out = [];
  for (const r of ROWS3.filter((x) => x[1] === 'PAT3_SEQ_COM')) {
    const p = rowParam(r, S_PATCH3, {});
    out.push({ ...p, label: p.osLabel || p.label, group: 'Step sequencer', section: 'seq', ...(/DUMMY/.test(r[0]) ? { help: 'OS: DUMMY1/DUMMY2 0-1, no menu' } : {}) });
  }
  const stepRows = ROWS3.filter((x) => x[1] === 'SEQ_STEP0');
  for (let s = 0; s < 64; s++) {
    for (const r of stepRows) {
      const p = rowParam([r[0], `SEQ_STEP${s}`, r[2] + s * 0x800, ...r.slice(3)], S_PATCH3, {});
      const flag = /Flag$|Assign \d (Target|Value)/.test(r[0]);
      out.push({
        ...p, key: `s${s + 1}_${p.key.replace(/^step_seq_/, '')}`, label: r[0].replace(/^STEP SEQ /, ''), group: `Step ${s + 1}`, section: `step${s}`,
        ...(flag ? { help: `OS: ${p.osLabel} (${{ 'NOTE FLAG': 'bit per voice: the voice plays a note', 'SLIDE FLAG': 'bit per voice: slide', 'MUTE FLAG': 'bit per voice: muted', 'ASSIGN FLAG': 'bit per assign slot: a recorded knob', 'PARAMETER ID': 'the OS parameter number of the recorded knob', 'PARAMETER VALUE': 'the recorded value' }[(OS_BY_ADDR.get(A(6) + 0x800 + (r[2] % 0x800)) || [])[9]] || 'raw word'}), a raw 32-bit word` } : {}),
      });
    }
  }
  return out;
}

const NAME_AT = 0x80;
const COMMENT_AT = S_PATCH2.compact(18432);
export const PARAMS = [
  ...ROWS.filter((r) => r[1] !== 'NAME0').map((r) => ({ ...rowParam(r), section: 'panel' })),
  ...Array.from({ length: 16 }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: NAME_AT + 2 * i, nibbles: 2, min: 32, max: 126, kind: 'char', hidden: true, section: 'panel' })),
  // the OS keeps room for 64 name characters (PATCH NAME 000-003 .. 060-063, 4 characters per 32-bit word); the
  // unit shows and the plugin writes 16; the rest is 0 in every patch of the backup
  ...Array.from({ length: 12 }, (_, k) => ({ key: `name_x${k}`, group: 'Name (unused)', label: `PATCH NAME ${String(16 + 4 * k).padStart(3, '0')}-${String(19 + 4 * k).padStart(3, '0')}`, offset: NAME_AT + 32 + 8 * k, nibbles: 8, min: 0, max: 0xffffffff, input: 'number', section: 'effects', help: 'OS: name characters 17-64 (2 nibbles each); unused by the SYSTEM-8, 0 in every patch' })),
  ...PATCH2_ROWS.map((r) => ({ ...p2Param(r), section: /^CHORD/.test(r[0]) ? 'chord' : 'effects' })),
  ...Array.from({ length: 40 }, (_, i) => ({ key: `comment${i}`, group: 'Comment', label: `Comment ${i + 1}`, offset: COMMENT_AT + 2 * i, nibbles: 2, min: 0, max: 126, kind: 'char', hidden: true, section: 'effects' })),
  ...p3Params(),
];
const byKey = new Map(PARAMS.map((p) => [p.key, p]));
TR.setParams(PARAMS);
function varOf(d, key) { const p = byKey.get(key); return p ? readParam(d, p) : 0; }

const charsAt = (d, at, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(((d[at + 2 * i] & 15) << 4) | (d[at + 2 * i + 1] & 15)); return s.replace(/[^\x20-\x7e]/g, ' ').trimEnd(); };
const putChars = (d, at, n, text) => { const s = String(text).padEnd(n).slice(0, n); for (let i = 0; i < n; i++) { const c = s.charCodeAt(i) >= 32 && s.charCodeAt(i) < 127 ? s.charCodeAt(i) : 32; d[at + 2 * i] = c >> 4; d[at + 2 * i + 1] = c & 15; } };
export const nameOf = (d) => charsAt(d, NAME_AT, 16);
export const setName = (d, name) => putChars(d, NAME_AT, 16, name);
export const commentOf = (d) => charsAt(d, COMMENT_AT, 40);

/** The default sound: the plugin script's defaults in the patch struct, the OS catalog's in patch2 / patch3. */
export function initPatch() {
  const d = new Uint8Array(FULL_SIZE);
  const put = (c, bytes, bits, def) => { let v = def >>> 0; for (let i = bytes - 1; i >= 0; i--) { d[c + i] = bits === 4 ? v & 15 : v & 0x7f; v = bits === 4 ? v >>> 4 : v >>> 7; } };
  for (const [, , o, bytes, bits, , , def] of ROWS) if (typeof def === 'number') put(S_PATCH.compact(o), bytes, bits, def);
  for (const [, , o, bytes, bits, , , def] of ROWS2) if (typeof def === 'number') put(S_PATCH2.compact(o), bytes, bits, def);
  for (const [, leaf, o, bytes, bits, , , def] of ROWS3) {
    if (typeof def !== 'number') continue;
    if (leaf === 'SEQ_STEP0') for (let s = 0; s < 64; s++) put(S_PATCH3.compact(o + s * 0x800), bytes, bits, def);
    else put(S_PATCH3.compact(o), bytes, bits, def);
  }
  // patch2 / patch3 are the OS's: its defaults (the plugin's differ: Patch Tempo 800 = 80.0, step Gate 49 = 49 %;
  // the OS clamps to its own ranges, checked on the unit with tools/system8/clamp_check.py)
  for (const p of PARAMS) if (p.osDefault !== undefined && p.offset >= S_PATCH.size) writeParam(d, p, p.osDefault);
  setName(d, 'INIT PATCH');
  return d;
}

// ------------------------------------------------------------------ the temporary area being edited
const unit = { target: 0 }; // 0 patch mode, 1 upper part, 2 lower part (performance mode)
const TARGETS = [[0, 'Patch mode'], [1, 'Performance: upper part'], [2, 'Performance: lower part']];
/** DT1 of one parameter into the temporary struct it belongs to. */
function sendParam(p, _v, data, ctx) {
  const st = M.structOf(p.offset);
  const n = p.nibbles || p.size || 1;
  const base = M.tempBases(unit.target)[[S_PATCH, S_PATCH2, S_PATCH3].indexOf(st)];
  const bytes = Array.from(data.slice(p.offset, p.offset + n));
  return dt1(base + st.packed(p.offset), bytes, dev(ctx));
}

/** Read a full patch, or only its name (fetchName: the 32-byte name leaf). */
const readFullAt = (api, bases) => M.readFull(api.g.client, bases, dev(api.ctx), initPatch());
async function readName(api, base) {
  const d = new Uint8Array(PATCH_SIZE);
  await M.readStruct(api.g.client, { ...S_PATCH, leaves: [[0x80, 32]], starts: [0x80], size: 32, span: 32, at: 0x80, compact: (p) => (p < 32 ? 0x80 + p : -1) }, base + 0x80, d, dev(api.ctx));
  return nameOf(d);
}

// ------------------------------------------------------------------ performance (12 leaves, 2709 bytes)
// Every byte from the OS catalog (groups pfm_com, pfm_upper, pfm_lower, pfm_cvgate, pfm_input, pfm_in_dly / cho / fl /
// mfx / rev, pfm_name): names, ranges, storage and screen texts; the menu placement from the reference manual p. 17-21
// (PERFORM EDIT, PART EDIT). The CV/GATE OUT Src texts are the menu's own list (0x6009A9A4, value map 0x6009A925).
const PL = (leaf, o) => S_PERF.starts[leaf] + o;
const atPerf = (packed) => S_PERF.compact(packed);
const MODEL_OPTS = Array.from({ length: 256 }, (_, v) => [v, MODELS[v] || String(v)]);
const SLOT_OPTS = opts(['SYSTEM-8', 'PLUG-OUT 1', 'PLUG-OUT 2', 'PLUG-OUT 3']);
const CV_SRC = new Map([[0, 'ALL'], [1, 'USB OMNI'], ...Array.from({ length: 16 }, (_, i) => [2 + i, `USB CH${i + 1}`]), [18, 'MIDI IN OMNI'], ...Array.from({ length: 16 }, (_, i) => [19 + i, `MIDI IN CH${i + 1}`]), [35, 'KBD(U&L)'], [36, 'KBD(U)'], [37, 'KBD(L)'], [38, 'STEP SEQ(U)'], [39, 'STEP SEQ(L)']]);
const perfGroup = (gkey, o) => osParams(gkey, { structBase: M.TEMP_PERF, at: atPerf, ...o });
const COMMON_GROUP = { 1312: 'Arpeggio / chord', 1313: 'Arpeggio / chord', 1314: 'Arpeggio / chord', 1315: 'Arpeggio / chord', 1316: 'Arpeggio / chord', 1317: 'Arpeggio / chord' };
const part = (gkey, prefix, label, section) => perfGroup(gkey, {
  prefix, group: label, section,
  over: {
    'PART SW': { help: 'PART ON/OFF button of the part' },
    'PART Slot': { options: SLOT_OPTS, help: 'The model button: SYSTEM-8 or PLUG-OUT 1-3 (OS catalog text "PLUUG-OUT n", the menu shows PLUG-OUT n)' },
    'PART Model': { options: MODEL_OPTS, help: 'Model id of the engine the part\'s patch was made for (5 SYSTEM-8, 6 JUPITER-8, 7 JUNO-106 ..., the PLUG-OUT\'s SYNINFO id); OS catalog: NATIVE / PLUG-OUT' },
  },
});
export const PERF_PARAMS = [
  ...perfGroup('pfm_com', { group: 'Common', section: 'common' }).map((p) => {
    if (p.os === 1318) return { ...p, key: 'cv_perf_prm_src', label: 'Prm Src', group: 'CV/GATE OUT', section: 'cv', help: 'CV/GATE OUT: follow the SYSTEM setting or this performance' };
    if (p.os === 1319) return { ...p, key: 'voc_carrier', group: 'INPUT (Voc)', section: 'input' };
    if (p.os === 1320) return { ...p, key: 'in_perf_prm_src', label: 'Prm Src', group: 'INPUT', section: 'input', help: 'INPUT: follow the SYSTEM setting or this performance' };
    return { ...p, group: COMMON_GROUP[p.os] || 'Common' };
  }),
  ...part('pfm_upper', 'up_', 'Upper part', 'upper'),
  ...part('pfm_lower', 'lw_', 'Lower part', 'lower'),
  ...perfGroup('pfm_cvgate', { prefix: 'cv_', group: 'CV/GATE OUT', section: 'cv' }).map((p) => (p.os === 1433 ? { ...p, options: [...CV_SRC], help: 'The menu\'s Src list; its PATCH (L) / PATCH (U) entries set Prm Src = SOUND MODULE and the second Src (UPPER / LOWER)' } : p.os === 1432 ? { ...p, help: 'CONTROLLER: the Src below; SOUND MODULE: the menu\'s PATCH (L) / PATCH (U) (the part in the second Src)' } : p)),
  ...perfGroup('pfm_input', { prefix: 'in_', group: 'INPUT', section: 'input' }).map((p) => {
    if (p.os >= 1470 && p.os <= 1472) return { ...p, key: `in_dly_${p.key.slice(3)}`, group: 'INPUT(Dly)' };
    if (p.os >= 1473 && p.os <= 1475) return { ...p, key: `in_rev_${p.key.slice(3).replace(/_2$/, '')}`, group: 'INPUT(Rev)' };
    if (p.os >= 1477) return { ...p, group: 'INPUT (Voc)' };
    if (p.os === 1469) return { ...p, input: 'number', help: 'OS: INPUT EFFECT TYPE 0-255, 0 = VOCODER (the only type the catalog names)' };
    return p;
  }),
  ...perfGroup('pfm_in_dly', { prefix: 'in_', group: 'INPUT(Dly)', section: 'input' }),
  ...perfGroup('pfm_in_cho', { prefix: 'in_', group: 'INPUT(Dly)', section: 'input' }),
  ...perfGroup('pfm_in_fl', { prefix: 'in_', group: 'INPUT(Dly)', section: 'input' }),
  ...perfGroup('pfm_in_mfx', { prefix: 'in_', group: 'INPUT MFX (no menu)', section: 'input' }),
  ...perfGroup('pfm_in_rev', { prefix: 'in_', group: 'INPUT(Rev)', section: 'input' }),
  ...Array.from({ length: 16 }, (_, i) => ({ key: `pname${i}`, label: `Name ${i + 1}`, offset: PL(10, 2 * i), nibbles: 2, min: 32, max: 126, kind: 'char', hidden: true, group: 'Name', section: 'common' })),
  ...Array.from({ length: 12 }, (_, k) => ({ key: `pname_x${k}`, group: 'Name (unused)', label: `PERFORM NAME ${String(16 + 4 * k).padStart(3, '0')}-${String(19 + 4 * k).padStart(3, '0')}`, offset: PL(10, 32 + 8 * k), nibbles: 8, min: 0, max: 0xffffffff, input: 'number', section: 'common', help: 'OS: name characters 17-64 (2 nibbles each); unused, 0 in every factory performance' })),
];
export const perfNameOf = (d) => charsAt(d, PL(10, 0), 16);
export const setPerfName = (d, s) => putChars(d, PL(10, 0), 16, s);
/** INIT PERFORM: every value at its OS default (catalog records), name INIT PERFORM. */
export function initPerf() {
  const d = new Uint8Array(S_PERF.size);
  for (const p of PERF_PARAMS) if (p.osDefault !== undefined) writeParam(d, p, p.osDefault);
  setPerfName(d, 'INIT PERFORM');
  return d;
}
const perfBase = (n) => (n < 0 ? M.TEMP_PERF : M.perfAddr(n));
const readPerf = (api, n) => M.readStruct(api.g.client, S_PERF, perfBase(n), new Uint8Array(S_PERF.size), dev(api.ctx));
const perfMessages = (n, d, ctx) => M.structMessages(S_PERF, perfBase(n), d, dev(ctx));

// ------------------------------------------------------------------ system block (01 50: 240 + 96 bytes)
// The OS catalog names it: group stp_com ("Setup Common"), the unit's current state (model, current patch and
// performance numbers, edited / manual flags, panel select, system mode); the rest are reserved 32-bit words. The
// SYSTEM menu's settings (Device ID, MIDI channels, Rx/Tx Edit Data, Local Sw ...: groups sys_com, sys_cvgate,
// sys_input ...) have no SysEx address in the catalog: the unit keeps them out of the SysEx map.
const atSys = (packed) => S_SYSTEM.compact(packed);
export const SYSTEM_PARAMS = [
  ...osParams('stp_com', { structBase: M.SYSTEM_BASE, at: atSys, group: 'Setup Common', over: { 'MODEL (Read Only)': { options: [[2, 'SYSTEM-8']], help: 'Read only: the device type (SYSTEM-1 / SYSTEM-1m / SYSTEM-8 = 0 / 1 / 2)' } } }),
  ...OS_GROUPS.stp_com.reserved.flatMap(([o, n]) => Array.from({ length: n / 8 }, (_, k) => {
    const packed = OS_GROUPS.stp_com.addr - M.SYSTEM_BASE + o + 8 * k;
    return { key: `res${packed}`, label: `_reserve_ ${M.hexAddr(M.SYSTEM_BASE + packed)}`, offset: atSys(packed), nibbles: 8, min: 0, max: 0xffffffff, input: 'number', group: 'Reserved', help: 'Reserved by the OS (_reserve_); 0 on this unit' };
  })),
];
// ------------------------------------------------------------------ simulator (demo mode, tests)
function simulate() {
  const mem = new Map(); // packed address -> byte
  const put = (bases, d, structs = M.FULL) => structs.forEach((st, k) => st.leaves.forEach(([p, n], j) => { for (let i = 0; i < n; i++) mem.set(bases[k] + p + i, d[st.starts[j] + i]); }));
  const leafStarts = new Map();
  const addLeaves = (bases, structs) => structs.forEach((st, k) => st.leaves.forEach(([p, n]) => leafStarts.set(bases[k] + p, n)));
  const demo = initPatch();
  for (let t = 0; t < 3; t++) { put(M.tempBases(t), demo); addLeaves(M.tempBases(t), M.FULL); }
  for (let s = 0; s < 4; s++) for (let p = 0; p < 64; p++) {
    const d = initPatch(); setName(d, `${['SYSTEM-8', 'PLG1', 'PLG2', 'PLG3'][s]} ${slotLabel(0, p)}`);
    put(M.slotBases(s, p), d); addLeaves(M.slotBases(s, p), M.FULL);
  }
  for (let n = -1; n < 64; n++) { const d = initPerf(); if (n >= 0) setPerfName(d, `Perf ${slotLabel(0, n)}`); put([perfBase(n)], d, [S_PERF]); addLeaves([perfBase(n)], [S_PERF]); }
  put([M.SYSTEM_BASE], new Uint8Array(S_SYSTEM.size), [S_SYSTEM]); addLeaves([M.SYSTEM_BASE], [S_SYSTEM]);
  // PLUG-OUT slots as on the unit (2026-11-26) and the install protocol of the OS handler (0x60006084)
  const slots = [[5, 0x120, 'SYSTEM-8'], [6, 0x106, 'JUPITER-8'], [1, 0x107, 'SH-101'], [7, 0x107, 'JUNO-106']].map(([model, version, name]) => ({ model, version, name }));
  const nib = (v, n) => Array.from({ length: n }, (_, k) => (v >> (4 * (n - 1 - k))) & 15);
  const slotInfo = (i) => [...nib(0x0132, 4), ...nib(0x136e, 4), ...nib(slots[i].model, 4), ...nib(slots[i].version, 4),
    ...[...slots[i].name.padEnd(16, '\0')].flatMap((c) => nib(c.charCodeAt(0), 2))];
  const xfer = { mode: 0, slot: 0, count: 0, pos: 0, sum: 0, image: null };
  const reset = () => Object.assign(xfer, { mode: 0, count: 0, pos: 0, sum: 0, image: null });
  // test hooks: hangAfter (no flow-control reply once that many records are in), refuseAt (refuse that record)
  const state = { mem, slots, xfer, hangAfter: null, refuseAt: null, banks: [], installs: 0 };
  // user memory as the OS keeps it (doc "Saving over MIDI"): what DT1 writes stays until power-off; the patches written
  // since the last save are flagged; the bank markers make the OS save one slot's bank when exactly the announced
  // number of flagged patches, all in that slot, came in. saved: the value before the first unsaved write.
  Object.assign(state, { saved: new Map(), dirty: new Set(), receiving: null, saves: [], refused: [] });
  state.powerCycle = () => { for (const [a, v] of state.saved) mem.set(a, v); state.saved.clear(); state.dirty.clear(); state.receiving = null; };
  function bankMarker(which, v) {
    if (which === 1) { state.receiving = { n: v }; return; }
    if (which !== 2 || !state.receiving) return;
    const slotsHit = new Set([...state.dirty].map((k) => Number(k.split(':')[0])));
    const n = state.receiving.n;
    state.receiving = null;
    if (slotsHit.size !== 1 || state.dirty.size !== n) { state.refused.push({ slots: [...slotsHit].sort((x, y) => x - y), count: state.dirty.size, expected: n }); return; }
    const slot = [...slotsHit][0];
    for (const a of [...state.saved.keys()]) { const l = M.locate(a); if (l?.kind === 'slot' && l.slot === slot) state.saved.delete(a); }
    for (const k of [...state.dirty]) if (k.startsWith(`${slot}:`)) state.dirty.delete(k);
    state.saves.push(slot);
  }
  function plugout(p) {
    const a = M.a28(p.addr);
    const reply = (data) => [dt1(p.addr + (1 << 21), data)];
    if (a[1] === 0 && a[2] === 2) return reply([[2, 8, 8, 4][a[3]] ?? 0]);
    if (a[1] === 0 && a[2] === 1) return reply(slotInfo(p.data[0] & 3));
    if (a[1] === 0x10 && a[2] === 0 && a[3] === 0) { // START [slot | flags]
      const slot = p.data[0] & 15;
      if (slot > 3) return reply([8]);
      if (xfer.mode) { reset(); return reply([0x64]); }
      Object.assign(xfer, { mode: p.data[0] & 0x40 ? 2 : 1, slot, count: 0, pos: 0, sum: 0, image: new Uint8Array(0x200000) });
      return reply([0]);
    }
    if (a[1] === 0x30 && (a[2] === 0 || a[2] === 1)) { // a flash block: 2^nn bytes, 7-in-8 or a fill
      if (!xfer.mode) return [];
      if (state.refuseAt !== null && xfer.count === state.refuseAt) { reset(); return [dt1(M.A(0x71, 0x30, 0, 0), [1])]; }
      const n = 1 << a[3];
      if (xfer.pos + n > 0x200000) { reset(); return [dt1(M.A(0x71, 0x30, 0, 0), [1])]; }
      const block = a[2] === 0 ? INST.unpack7(p.data, n) : new Uint8Array(n).fill(p.data[0] ? 0xff : 0);
      xfer.image.set(block, xfer.pos);
      for (const b of block) xfer.sum = (xfer.sum + b) & 0xffff;
      xfer.pos += n; xfer.count++;
      return [];
    }
    if (a[1] === 0x30 && a[2] === 3) return state.hangAfter !== null && xfer.count >= state.hangAfter ? [] : reply(nib(xfer.count, 4)); // flow control
    if (a[1] === 0x30 && a[2] === 2) { reset(); return reply([0]); } // abort
    if (a[1] === 0x10 && a[2] === 0 && a[3] === 1) { // END [sum16 as 4 nibbles]
      const want = p.data.reduce((v, x) => (v << 4) | (x & 15), 0);
      let code = 0;
      if (xfer.mode && xfer.sum !== want) code = 3;
      else if (xfer.mode && xfer.pos !== 0x200000) code = 2;
      else if (xfer.mode) {
        const r = INST.regionsOf(xfer.image);
        if (!r[0].sumOk || !r[0].syn) code = 4;
        else if (xfer.mode === 1) { slots[xfer.slot] = { model: r[0].syn.model, version: r[0].syn.version, name: r[0].syn.name }; state.installs++; }
      }
      reset();
      return reply([code]);
    }
    if (a[1] === 0x20 && a[2] === 1) { state.banks.push([a[3], p.data[0]]); bankMarker(a[3], p.data[0]); return []; } // patch bank start / end
    return [];
  }
  return {
    state,
    handle(d) {
      const p = parse(d);
      if (!p) return null;
      if (p.cmd === 0x11) {
        const size = (p.data[0] << 21) | (p.data[1] << 14) | (p.data[2] << 7) | p.data[3];
        const out = [];
        for (const [a, n] of leafStarts) {
          if (a < p.addr || a >= p.addr + size) continue;
          const len = Math.min(n, p.addr + size - a);
          for (let o = 0; o < len; o += 240) out.push([a + o, dt1(a + o, Array.from({ length: Math.min(240, len - o) }, (_, k) => mem.get(a + o + k) ?? 0))]);
        }
        return out.sort((x, y) => x[0] - y[0]).map(([, m]) => m);
      }
      if (p.cmd === 0x12) {
        if ((p.addr >>> 21) === 0x70) return plugout(p);
        const loc = M.locate(p.addr);
        const user = loc && (loc.kind === 'slot' || loc.kind === 'perf');
        p.data.forEach((b, i) => { const a = p.addr + i; if (!mem.has(a)) return; if (user && !state.saved.has(a)) state.saved.set(a, mem.get(a)); mem.set(a, b); });
        if (loc?.kind === 'slot') state.dirty.add(`${loc.slot}:${loc.patch}`);
        return [];
      }
      return [];
    },
  };
}

// ------------------------------------------------------------------ connections, Branch Library, complete dump
/** What the open ports carry (see the header). */
function link({ input, output } = {}) {
  const name = String(output || input || '');
  if (/SYSTEM-8 CTRL/i.test(name)) return { key: 'ctrl', label: 'USB (SYSTEM-8 CTRL)', short: 'USB CTRL', can: ['sysex', 'pc', 'notes', 'cc'], note: 'Roland SysEx (every read and write), program change and bank select. Checked on the unit.' };
  if (/SYSTEM-8/i.test(name)) return { key: 'usb', label: 'USB (SYSTEM-8)', short: 'USB', can: ['notes', 'cc', 'pc'], note: 'Notes, CC, program change and bank select; the unit ignores DT1 and answers no RQ1 on this port (checked).' };
  return { key: 'din', label: `MIDI (${name || 'DIN'})`, short: 'DIN', can: ['notes', 'cc', 'pc'], note: 'The DIN sockets: notes, CC, program change and bank select. The MIDI chart lists SysEx, but the parameter RQ1/DT1 over DIN is unchecked, so this editor reads and writes only over USB (SYSTEM-8 CTRL).' };
}

const DATA = (raw) => { const p = parse(raw); return p?.ok && p.cmd === 0x12 ? p : null; };
const recognise = (raw) => { const p = DATA(raw); if (!p) return false; const loc = M.locate(p.addr); return !!loc; };

/** Items of a dump: full patches (per slot and patch), performances, the system block. */
function libraryItems(msgs) {
  const groups = new Map();
  for (const m of msgs) {
    const p = DATA(m);
    const loc = p && M.locate(p.addr);
    if (!loc) continue;
    let key;
    if (loc.kind === 'slot') key = `s${loc.slot}:${loc.patch}`;
    else if (loc.kind === 'temp') key = `t${loc.temp}`;
    else if (loc.kind === 'perf') key = `p${loc.perf}`;
    else if (loc.kind === 'tempPerf') key = 'pt';
    else key = 'sys';
    if (!groups.has(key)) groups.set(key, { loc, msgs: [] });
    groups.get(key).msgs.push(m);
  }
  const items = [];
  for (const [key, { loc, msgs: ms }] of groups) {
    if (loc.kind === 'slot' || loc.kind === 'temp') {
      const r = M.fullFrom(ms, initPatch());
      const label = loc.kind === 'temp' ? `Temporary patch (${TARGETS[loc.temp][1]})` : `${['SYSTEM-8', 'PLUG-OUT 1', 'PLUG-OUT 2', 'PLUG-OUT 3'][loc.slot]} ${slotLabel(0, loc.patch)}`;
      items.push({ key, label, name: r ? nameOf(r.data) : '', object: loc.kind === 'slot' && loc.slot > 0 ? 'plugoutpatch' : 'patch', data: r?.data, msgs: ms });
    } else if (loc.kind === 'perf' || loc.kind === 'tempPerf') {
      const d = new Uint8Array(S_PERF.size);
      for (const m of ms) M.place(d, S_PERF, loc.base, DATA(m));
      items.push({ key, label: loc.kind === 'perf' ? `Performance ${slotLabel(0, loc.perf)}` : 'Temporary performance', name: perfNameOf(d), object: 'performance', data: d, msgs: ms });
    } else items.push({ key, label: 'System', name: '', object: 'system', msgs: ms });
  }
  return items;
}
const fromMsgs = (msgs) => M.fullFrom(msgs, initPatch())?.data ?? null;

// One step per bank, so the Branch Library keeps each bank of 64 as one entry (dumpEntries: one entry per step that
// brings sounds). Measured on the unit 2026-11-27 (browser, SYSTEM-8 CTRL): a full patch (96 DT1) comes back in about
// 0.15 s, the whole dump in about 2 minutes.
const bankLabel = (s) => (s ? `PLUG-OUT ${s} patches (64)` : 'SYSTEM-8 patches (64)');
const fullDump = [
  { label: 'System', bytes: (ctx) => rq1(M.SYSTEM_BASE, S_SYSTEM.span, dev(ctx)), expect: 2, timeout: 3000, seconds: 0.3, accept: (raw) => DATA(raw)?.addr >>> 14 === M.SYSTEM_BASE >>> 14 },
  {
    label: 'Performances (64)', bytes: (ctx) => Array.from({ length: 64 }, (_, n) => rq1(M.perfAddr(n), S_PERF.span, dev(ctx))),
    expect: 64 * 12, timeout: 4000, quiet: 4000, seconds: 12,
    accept: (raw) => { const l = DATA(raw) && M.locate(DATA(raw).addr); return l?.kind === 'perf'; },
  },
  ...[0, 1, 2, 3].map((s) => ({
    label: bankLabel(s),
    bytes: (ctx) => Array.from({ length: 64 }, (_, i) => M.FULL.map((st, k) => rq1(M.slotBases(s, i)[k], st.span, dev(ctx)))).flat(),
    expect: 64 * (13 + 17 + 66), timeout: 4000, quiet: 4000, seconds: 30,
    group: bankLabel(s), optional: s > 0,
    accept: (raw) => { const l = DATA(raw) && M.locate(DATA(raw).addr); return l?.kind === 'slot' && l.slot === s; },
  })),
];

const recall = (slot) => (_bank, i, ctx) => [[0xb0 | channel(ctx), 0, 85], [0xb0 | channel(ctx), 32, slot], [0xc0 | channel(ctx), i]];
const PANEL_LAYOUT = ['LFO', 'OSC1', 'OSC2', 'OSC3', 'Mixer', 'Pitch', 'Filter', 'Amp', 'Effects', 'Control', 'Bend / mod', 'Arpeggio / keyboard', 'Routing', 'Delay / chorus', 'Reverb', 'MFX (no menu)', 'Velocity / tempo', 'High resolution', 'Comment', 'Chord memory', 'Step sequencer'].map((group) => ({ group }));
const SECTIONS = [{ key: 'panel', label: 'Panel' }, { key: 'effects', label: 'Effects / more' }, { key: 'chord', label: 'Chord memory' }, { key: 'seq', label: 'Step sequencer' }, ...Array.from({ length: 64 }, (_, s) => ({ key: `step${s}`, label: `Step ${s + 1}` }))];
// Checked on the unit 2026-11-27 with two power cycles (tools/system8/persist_test.py): DT1 writes into user memory,
// plain or a whole bank between the patch-bank brackets with flag 1 or flag 0 (Roland's plugin), before or after the
// brackets, in the SYSTEM-8 slot and in PLUG-OUT slots, were all gone: the unit keeps them until it is switched off.
const KEEP_NOTE = 'The SYSTEM-8 keeps what Store writes only until it is switched off: to keep a patch or performance, select it on the unit and press WRITE.';
const STORE_NOTE = `Store writes the sound (patch, effects/chord memory and step sequencer structs) into user memory over SYSTEM-8 CTRL, the way Roland's plugin writes patches. ${KEEP_NOTE} Play sends bank select 85/0-3 and a program change (taken on both USB ports).`;

// "Save to SD card..." (roland-system8-sd.js): the PLUG-OUTs the editor knows, for a patch whose slot is unknown
const engineList = async () => Object.values((await import('./roland-system8-plugouts.js')).ENGINES).map(({ model, version, name }) => ({ model, version, name }));
const saveToCard = async (api, page) => SD.saveAction(api, { page, engines: await engineList(), initSound: initPatch });
const SD_TITLE = 'Write a file the SYSTEM-8 can load from its SD card (UTILITY: IMPORT loads one patch at a time into the edit buffer; WRITE on the unit keeps it)';

export default {
  coverage: 'SYSTEM-8 engine sounds in full: the panel values, name, arpeggio and patch cords (patch struct), the effect details, chord memory, velocity sensitivities, patch tempo, comment and rating (patch2) and the 64-step sequencer (patch3); every value with the range and screen text of the OS 1.32 parameter catalog (the lists of the engine from its region 0), every byte a parameter or a slot the OS reserves; temporary patch (patch mode, upper and lower part) read and live edits; user memory A-1..H-8 read, store and recall; the 64 performances, every byte from the OS catalog (common, parts, CV/GATE OUT, INPUT and its effects, name); the setup block (01 50, the current state of the unit); the patch memory of the PLUG-OUT slots (raw here, each engine has its own editor: SYSTEM-8 PLUG-OUT JUPITER-8 ...); PLUG-OUT containers (Code8_<slot>.Dat) in the Branch Library, installed into slot 1-3 by the OS protocol (flow control, reply codes, abort) with the patch bank restored afterwards, and slot backups (container + 64 patches), and installed from the Head Library; the SD-card patch and performance exports (.s8p, .s8f) written by Save to SD card in the OS format (checked byte for byte against the Roland factory bank; the unit imports one patch at a time into the edit buffer); complete dump, Branch Library items, translator. The SYSTEM menu settings have no SysEx address (OS catalog).',
  sysex: { manufacturer: [0x41], model: M.MODEL, deviceIdDefault: M.DEV },
  // only "SYSTEM-8 CTRL" answers SysEx; "SYSTEM-8" is the plain MIDI port (notes, CC, program change)
  ports: { input: /SYSTEM-8 CTRL/i, output: /SYSTEM-8 CTRL/i },
  link,
  linkNeeds: { sysex: 'the USB connection SYSTEM-8 CTRL (choose it as input and output)' },
  minGap: 5,
  recognise,
  isOwn: M.isS8,
  isRequest: (raw) => parse(raw)?.cmd === 0x11,
  libraryItems,
  fullDump,
  fullDumpPace: 'The unit answers each struct at once over USB; a sound is 96 messages (patch, effects, step sequencer); a bank of 64 is one step.',
  // PLUG-OUT containers (Code8_<slot>.Dat) in the Branch Library: install into a slot, back the slot up
  // (roland-system8-install.js)
  files: [{
    kind: 'plugout', label: 'PLUG-OUT container', accept: '.dat,.Dat', ext: '.Dat',
    identify: (bytes, filename) => INST.identify(bytes, filename),
    actions: [
      { label: 'Install...', needs: 'sysex', title: 'Install this PLUG-OUT into the slot it is built for over SYSTEM-8 CTRL (a background transfer of about 15 s), then restore a patch bank if you choose one', run: (api, entry) => INST.installAction(api, entry) },
      { label: 'Back up this slot', needs: 'sysex', title: 'Save the container of the PLUG-OUT in the slot this file is built for and the 64 patches of that slot in the Branch Library', run: (api, entry) => INST.backupAction(api, INST.readContainer(entry.bytes).slot) },
    ],
  }],
  simulate,
  objects: [
    {
      key: 'patch', page: 'Patch', icon: '♪', label: 'Patch', size: FULL_SIZE, autoLoad: true, needs: 'sysex',
      init: initPatch,
      fetch: (api) => readFullAt(api, M.tempBases(unit.target)),
      target: { label: 'Temporary area', title: 'Which temporary patch the page reads and edits', options: () => TARGETS, value: () => unit.target, set: (v) => { unit.target = Number(v); } },
      params: PARAMS,
      sections: SECTIONS,
      sectionLabel: 'Section',
      sendParam,
      name: nameOf,
      setName,
      layout: PANEL_LAYOUT,
      cols: 4,
      note: 'Every change is sent at once to the temporary patch over SYSTEM-8 CTRL. WRITE on the unit (or Store here) keeps it.',
      actions: [
        { label: 'Save to SD card...', title: SD_TITLE, run: (api) => saveToCard(api, 'patch') },
      ],
      sendAll: { label: 'Send to temporary patch', needs: 'sysex', title: 'Write the whole sound (all three structs) into the temporary area', build: (data, ctx) => M.fullMessages(M.tempBases(unit.target), data, dev(ctx)) },
      toSyx: (data, ctx) => M.fullMessages(M.tempBases(0), data, dev(ctx)),
      fromSyx: fromMsgs,
      toCommon: (d) => TR.toCommon(d),
      fromCommon: (c, base) => TR.fromCommon(c, base),
      slots: {
        label: 'SYSTEM-8 patches', banks: [[0, 'SYSTEM-8']], count: 64, slotLabel,
        namesOnOpen: true, needs: 'sysex', recallNeeds: 'pc', storeNeeds: 'sysex',
        name: nameOf,
        writable: () => true,
        fetch: (api, _bank, i) => readFullAt(api, M.slotBases(0, i)),
        fetchName: (api, _bank, i) => readName(api, M.slotPatchAddr(0, i)),
        recall: recall(0),
        store: (_bank, i, ctx, data) => M.fullMessages(M.slotBases(0, i), data, dev(ctx)),
        note: () => STORE_NOTE,
      },
    },
    {
      key: 'plugoutpatch', page: 'PLUG-OUT patches', icon: '♫', label: 'PLUG-OUT patch', size: FULL_SIZE, needs: 'sysex',
      init: initPatch,
      params: [],
      name: nameOf,
      setName,
      note: 'The patch memory of PLUG-OUT slots 1-3: each patch read and stored whole (its three structs) as raw data. Each PLUG-OUT has its own editor in the device list (SYSTEM-8 PLUG-OUT JUPITER-8, SH-101, JUNO-106 ...). Names use the same 16 characters at 0x80. PLUG-OUT containers (Code8_<slot>.Dat) are kept and installed on the Branch Library page.',
      actions: [
        { label: 'Install a PLUG-OUT from the Head Library...', needs: 'sysex', title: 'Choose a PLUG-OUT file kept in the Head Library and install it into the slot it is made for (the same install as on the Branch Library page)', run: (api) => INST.installFromHeadLibraryAction(api) },
        { label: 'Save to SD card...', title: SD_TITLE, run: (api) => saveToCard(api, 'plugout') },
        { label: 'Back up a PLUG-OUT slot...', needs: 'sysex', title: 'Save the container of a slot (from the Branch Library or the Roland Cloud file) and its 64 patches in the Branch Library', run: (api) => INST.backupAction(api) },
        { label: 'Show the PLUG-OUT slots', needs: 'sysex', title: 'Read the slot records (70 00 01 00): which PLUG-OUT and version each slot holds', run: async (api) => { const u = await INST.readSlots(api); api.toast(`OS ${INST.versionText(u.os)}: ${u.slots.map((s) => `${s.slot ? `PLUG-OUT ${s.slot}` : 'slot 0'} ${INST.slotText(s)}`).join(', ')}`, 'info', 10000); return u; } },
      ],
      toSyx: (data, ctx) => M.fullMessages(M.slotBases(1, 0), data, dev(ctx)),
      fromSyx: fromMsgs,
      toCommon: (d) => TR.rawToCommon(d),
      fromCommon: (c, base) => TR.rawFromCommon(c, base),
      slots: {
        label: 'PLUG-OUT slots', banks: [[1, 'PLUG-OUT 1'], [2, 'PLUG-OUT 2'], [3, 'PLUG-OUT 3']], count: 64, slotLabel,
        namesOnOpen: true, needs: 'sysex', recallNeeds: 'pc', storeNeeds: 'sysex',
        name: nameOf,
        writable: () => true,
        fetch: (api, bank, i) => readFullAt(api, M.slotBases(bank, i)),
        fetchName: (api, bank, i) => readName(api, M.slotPatchAddr(bank, i)),
        recall: (bank, i, ctx) => recall(bank)(bank, i, ctx),
        store: (bank, i, ctx, data) => M.fullMessages(M.slotBases(bank, i), data, dev(ctx)),
        note: () => 'A PLUG-OUT patch belongs to the engine installed in its slot: store it only into a slot that holds the same PLUG-OUT. ' + STORE_NOTE,
      },
    },
    {
      key: 'performance', page: 'Performance', icon: '◫', label: 'Performance', size: S_PERF.size, needs: 'sysex',
      init: initPerf,
      fetch: (api) => readPerf(api, -1),
      params: PERF_PARAMS,
      sections: [{ key: 'common', label: 'Common' }, { key: 'upper', label: 'Upper part' }, { key: 'lower', label: 'Lower part' }, { key: 'cv', label: 'CV/GATE OUT' }, { key: 'input', label: 'INPUT' }],
      // the two parts of a performance; their MIDI channels (SYSTEM: MIDI Upper Ch / Lower Ch) are SYSTEM menu
      // settings, which have no SysEx address (OS catalog): set on the unit
      multi: {
        page: 'Parts (MIDI channels)', label: 'Parts', count: 2, section: (i) => ['upper', 'lower'][i], partLabel: (i) => ['Upper', 'Lower'][i],
        columns: [
          { label: 'Patch', params: ['PART Slot', 'PART Memory'], role: 'patch' },
          { label: 'Model', params: ['PART Model'] },
          { label: 'On', params: ['PART SW'], role: 'on' },
          { label: 'Mute', params: ['Mute'] },
          { label: 'Level / pan', params: ['Level', 'Pan'] },
          { label: 'Octave / transpose / fine', params: ['Octave', 'Transpose', 'Fine Tune'] },
          { label: 'Key range', params: ['Range Lower', 'Range Upper'] },
          { label: 'Receive', params: ['Rx Bend', 'Rx Mod', 'Rx Hold', 'Rx Express'] },
        ],
        on: (i, d) => readParam(d, PERF_PARAMS.find((p) => p.key === `${['up', 'lw'][i]}_part_sw`)) === 1,
        note: 'A performance plays an upper and a lower part (DUAL or SPLIT: Perf Mode, Range Lower / Upper). The parts receive on the SYSTEM: MIDI Upper Ch and Lower Ch, which the SYSTEM-8 keeps out of its SysEx map (no editor can read or set them): set them on the unit. Changes go to the temporary performance.',
      },
      groupInfo: { Common: { table: false }, INPUT: { table: true, note: 'The INPUT leaf: byte meanings still to be confirmed (see the doc).' } },
      sendParam: (p, _v, data, ctx) => dt1(M.TEMP_PERF + S_PERF.packed(p.offset), Array.from(data.slice(p.offset, p.offset + (p.nibbles || 1))), dev(ctx)),
      name: perfNameOf,
      setName: setPerfName,
      note: 'Changes go to the temporary performance (04 00 00 00). The two patches it plays are referenced by model button and number.',
      actions: [{ label: 'Save to SD card...', title: SD_TITLE, run: (api) => saveToCard(api, 'performance') }],
      sendAll: { label: 'Send to temporary performance', needs: 'sysex', build: (data, ctx) => perfMessages(-1, data, ctx) },
      toSyx: (data, ctx) => perfMessages(-1, data, ctx),
      fromSyx: (msgs) => { const d = initPerf(); let any = false; for (const m of msgs) { const p = DATA(m); const l = p && M.locate(p.addr); if (l && l.struct === S_PERF && M.place(d, S_PERF, l.base, p)) any = true; } return any ? d : null; },
      toCommon: (d) => TR.perfToCommon(d, PERF_PARAMS),
      fromCommon: (c, base) => TR.perfFromCommon(c, base, PERF_PARAMS),
      slots: {
        label: 'Performances', banks: [[0, 'Performances']], count: 64, slotLabel,
        namesOnOpen: true, needs: 'sysex', recallNeeds: 'pc', storeNeeds: 'sysex',
        name: perfNameOf,
        writable: () => true,
        fetch: (api, _bank, i) => readPerf(api, i),
        recall: (_bank, i, ctx) => [[0xc0 | channel(ctx), i]],
        store: (_bank, i, ctx, data) => perfMessages(i, data, ctx),
        note: () => `Play sends a program change on the Perf Ch (SYSTEM: MIDI), set here as the device channel. Store writes the performance into memory over SYSTEM-8 CTRL. ${KEEP_NOTE}`,
      },
    },
    {
      key: 'system', page: 'System', icon: '⚙', label: 'System (Setup Common)', size: S_SYSTEM.size, needs: 'sysex', notLive: true,
      init: () => { const d = new Uint8Array(S_SYSTEM.size); for (const p of SYSTEM_PARAMS) if (p.osDefault !== undefined) writeParam(d, p, p.osDefault); writeParam(d, SYSTEM_PARAMS[0], 2); return d; },
      fetch: (api) => M.readStruct(api.g.client, S_SYSTEM, M.SYSTEM_BASE, new Uint8Array(S_SYSTEM.size), dev(api.ctx)),
      params: SYSTEM_PARAMS,
      groupInfo: { 'Setup Common': { note: 'The current state of the unit as the OS keeps it (Setup Common, 01 50 00 00). The SYSTEM menu settings are not reachable by SysEx.' }, Reserved: { table: true } },
      warning: 'This block is the current state of the unit (current patch, flags), not the SYSTEM menu: nothing is sent unless you press Send. The SYSTEM menu (Device ID, MIDI, Rx Edit Data ...) has no SysEx address.',
      sendAll: { label: 'Send setup block', needs: 'sysex', build: (data, ctx) => M.structMessages(S_SYSTEM, M.SYSTEM_BASE, data, dev(ctx)) },
      toSyx: (data, ctx) => M.structMessages(S_SYSTEM, M.SYSTEM_BASE, data, dev(ctx)),
      fromSyx: (msgs) => { const d = new Uint8Array(S_SYSTEM.size); let any = false; for (const m of msgs) { const p = DATA(m); if (p && M.place(d, S_SYSTEM, M.SYSTEM_BASE, p)) any = true; } return any ? d : null; },
    },
  ],
};

export const _test = { simulate, LEAVES, PARAMS, PERF_PARAMS, initPatch, initPerf, libraryItems, link, unit };
/** What the PLUG-OUT engine editors (roland-system8-engines.js) share with this definition. */
export const SHARED = { unit, TARGETS, sendParam, readFullAt, readName, simulate, link, DATA, recall, SECTIONS, STORE_NOTE, slotLabel, dev, initPatch, PARAMS };
