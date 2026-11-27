// Roland JV-2080: address map, ranges and defaults from the v1.02 firmware (flash image
// rebuilt from the official updater; see docs/devices/roland-jv2080.md), checked against a
// JV-2080 over MIDI.
//
// The DT1 builder (0x0E12294C) turns internal parameter IDs into addresses with the decoder
// at 0x0E122554: each block is a contiguous ID range mapping one to one onto byte offsets.
// Default, minimum and maximum per byte come from the descriptor table at 0x0E058100
// (roland-jv2080-fw.js). Labels and option lists come from the firmware's edit screens and
// option lists (roland-jv2080-ui.js), including the names of EFX parameters 1-12 for each
// of the 40 EFX types. Bank select follows the decoder at 0x0E1230BC.

import { named, readText, readParam } from '../../core/model/memmap.js';
import { dt1, dt1Chunks, rq1, parseDt1, readBlock, intToAddr, addrToInt } from '../../core/midi/roland.js';
import { JV2080_BLOCKS as FW } from './roland-jv2080-fw.js';
import { LISTS, EFX_TYPES } from './roland-jv2080-ui.js';
import { categoryFromRoland } from '../../core/mainlib/categories.js';
import { PRESET_PATCHES, PRESET_PERFORMANCES } from './roland-jv2080-presets.js';
import { SRJV80_BOARDS } from './roland-srjv80.js';
import { INT_A_WAVES, INT_B_WAVES } from './roland-jv2080-waves.js';
import { PRESET_RHYTHM_SETS, FACTORY_USER_RHYTHM_SETS, BOARD_RHYTHM_SETS } from './roland-jv2080-rhythm.js';
import { jvTranslator, setJvName } from './roland-jv2080-translate.js';

const MODEL = [0x6a];
const A = (s) => addrToInt(s.split(' ').map((x) => parseInt(x, 16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ value displays
const signed = (centre, unit = '') => ({ format: (v) => `${v - centre > 0 ? '+' : ''}${v - centre}${unit}` });
const NOTE = (v) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][v % 12]}${Math.floor(v / 12) - 1}`;
const PAN = (v) => (v === 64 ? 'C' : v < 64 ? `L${64 - v}` : `R${v - 64}`);
const L = (n, f = (x) => x) => named(LISTS[n].map(f));
const dB = (x) => `${x} dB`;
const CC_NAMES = { 1: 'MODULATION', 2: 'BREATH', 4: 'FOOT', 5: 'PORTAMENTO TIME', 7: 'VOLUME', 8: 'BALANCE', 10: 'PAN', 11: 'EXPRESSION', 64: 'HOLD-1', 65: 'PORTAMENTO', 66: 'SOSTENUTO', 67: 'SOFT' };
const sysCtl = (v) => (v <= 95 ? `CC${String(v).padStart(2, '0')}${CC_NAMES[v] ? ` ${CC_NAMES[v]}` : ''}` : v === 96 ? 'PITCH BEND' : 'AFTERTOUCH');

const O = {
  onoff: L(0),
  waveGain: L(46, dB),
  fxmColor: named(['1', '2', '3', '4']),
  delayMode: L(38), // the eighth value (7) has no name in the firmware list
  panSw: L(40),
  dest: L(23),
  lfoWave: named(LISTS[24].slice(0, 8)),
  lfoOffset: L(25),
  fadeMode: L(28),
  extSync: named(['OFF', 'CLK', 'TAP']),
  filter: L(42),
  curve: named(['1', '2', '3', '4', '5', '6', '7']),
  bias: L(43),
  toneOut: named(['MIX', 'EFX', 'DIR1', 'DIR2']),
  efx: named(LISTS[70].slice(1)),
  efxOut: L(57),
  efxCtl: named(LISTS[20].slice(0, 11)),
  patchCtl: L(20),
  efxSrc: L(54),
  choOut: L(58),
  revType: L(60),
  hfDamp: L(62),
  keyAssign: L(33),
  portaMode: L(26),
  portaType: L(35),
  portaStart: L(36),
  holdPeak: L(19),
  octave: named(['-3', '-2', '-1', '0', '+1', '+2', '+3']),
  stretch: named(['OFF', '1', '2', '3']),
  priority: L(37),
  structure: named(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
  booster: L(45, dB),
  patchClock: L(15),
  perfClock: L(14),
  sysClock: L(13),
  category: L(52),
  partOut: named(['MIX', 'EFX', 'DIR1', 'DIR2', 'PATCH']),
  panelMode: L(1),
  ctlSw: L(97),
  volSrc: L(98),
  atSrc: L(99),
  ctrlCh: named([...Array.from({ length: 16 }, (_, i) => `Ch ${i + 1}`), 'OFF']),
  channel: named(Array.from({ length: 16 }, (_, i) => `Ch ${i + 1}`)),
  rhythmEdit: L(16),
  preview: L(100),
  muteGroup: named(['OFF', ...Array.from({ length: 31 }, (_, i) => String(i + 1))]),
  envMode: L(44),
  sysCtlSrc: Array.from({ length: 97 }, (_, i) => [i + 1, sysCtl(i + 1)]),
};

// Patch groups: [group type, group ID] as the JV-2080 reports them (checked on a unit).
const INT_GROUPS = { 1: 'USER', 2: 'CARD', 3: 'PR-A', 4: 'PR-B', 5: 'PR-C', 6: 'PR-D (GM)', 7: 'PR-E' };
const PRESET_KEYS = ['PR-A', 'PR-B', 'PR-C', 'PR-D', 'PR-E'];
const BOARDS = { 1: 'Pop', 2: 'Orchestral', 3: 'Piano', 4: 'Vintage Synth', 5: 'World', 6: 'Dance', 7: 'Super Sound Set', 8: "Keyboards of the 60s & 70s", 9: 'Session', 10: 'Bass & Drum', 11: 'Techno', 12: 'Hip Hop', 13: 'Vocal', 14: 'Asia', 15: 'Special FX', 16: 'Orchestral II', 17: 'Country', 18: 'Latin', 19: 'House', 97: 'Experience III', 98: 'Experience II', 99: 'Experience' };
const boardName = (id) => `SR-JV80-${String(id).padStart(2, '0')}${BOARDS[id] ? ` ${BOARDS[id]}` : ''}`;
const groupName = (type, id) => (type === 0 ? INT_GROUPS[id] ?? `INT ${id}` : type === 2 ? boardName(id) : `PCM ${id}`);
const waveGroupName = (type, id) => (type === 0 ? (id === 1 ? 'INT-A' : id === 2 ? 'INT-B' : `INT ${id}`) : type === 2 ? boardName(id) : `PCM ${id}`);
const SLOTS = 'ABCDEFGH';
const num3 = (i) => String(i + 1).padStart(3, '0');
const boardsOf = (ctx) => ctx?.settings?.jvBoards || null;

// Group types. PCM cards belong to the JV-1080: Roland's address map puts PCM in angle brackets
// ("ignored if received by the JV-2080"), and the JV-2080 has no PCM card slot. PCM is shown
// only when the data already holds it.
const PCM_LABEL = 'PCM (JV-1080 card; ignored by the JV-2080)';
const groupTypeOptions = (current) => [[0, 'INT'], ...(current === 1 ? [[1, PCM_LABEL]] : []), [2, 'EXP']];
const groupTypeParam = (label, extra = {}) => ({ label, relayout: true, ...extra, dynamic: (data, _ctx, p) => ({ options: groupTypeOptions(data[p.offset]) }) });

// Expansion board contents from the board ROMs (roland-srjv80.js): wave and patch names in
// number order. Patch names not on a board (SR-JV80-97) are read from the unit once and kept
// in the device settings (jvBoardNames).
const boardWaveNames = (id) => SRJV80_BOARDS[id]?.waves || null;
function boardPatchNames(id, ctx) {
  const rom = SRJV80_BOARDS[id]?.patches;
  if (rom) return rom;
  const read = ctx?.settings?.jvBoardNames?.[id];
  return read?.length ? read : null;
}

/**
 * Boards to choose from: the installed ones once Find boards has run (marked with their slot),
 * else every known board. `current` (the value in the data) is always offered, marked when that
 * board is not installed; `keep(id)` narrows the list (e.g. boards with rhythm sets).
 */
function boardOptions(ctx, current, keep = () => true) {
  const installed = boardsOf(ctx);
  const ids = installed ? installed.filter(Boolean) : Object.keys(BOARDS).map(Number);
  const list = [...new Set(ids)].filter(keep).sort((a, b) => a - b);
  const out = list.map((id) => {
    const slots = (installed || []).map((x, k) => (x === id ? SLOTS[k] : null)).filter(Boolean);
    return [id, `${boardName(id)}${slots.length ? ` (slot ${slots.join(', ')})` : ''}`];
  });
  if (current !== undefined && current > 0 && !list.includes(current)) {
    const why = installed && !installed.includes(current) ? ' (not installed)' : !keep(current) ? ' (no rhythm sets)' : '';
    out.push([current, `${boardName(current)}${why}`]);
    out.sort((a, b) => a[0] - b[0]);
  }
  return out;
}
const numbered = (count, nameOf = () => '') => Array.from({ length: count }, (_, i) => { const n = nameOf(i); return [i, n ? `${num3(i)} ${n}` : num3(i)]; });
const pcmGroup = (current) => [[current, `PCM ${current}`]];

/** Wave group IDs for a group type: INT-A/B or the installed expansion boards (PCM: the value held). */
const waveGroupOptions = (type, ctx, current) => (type === 0 ? [[1, 'INT-A'], [2, 'INT-B']] : type === 2 ? boardOptions(ctx, current) : pcmGroup(current));
/** Wave numbers, named: INT-A/INT-B from the owner's manual (the names are not in the flash), boards from their ROMs. */
function waveNumberOptions(type, id) {
  const names = type === 2 ? boardWaveNames(id) : type === 0 ? (id === 1 ? INT_A_WAVES : id === 2 ? INT_B_WAVES : null) : null;
  return names ? numbered(names.length, (i) => names[i]) : numbered(256);
}

/** Patch group IDs for a group type (performance parts, system selection). */
const intGroups = () => Object.entries(INT_GROUPS).map(([k, v]) => [Number(k), v]);
const patchGroupOptions = (type, ctx, current) => (type === 0 ? intGroups() : type === 2 ? boardOptions(ctx, current) : pcmGroup(current));

// Rhythm sets (part 10). The JV-2080 selects them through the same groups as patches (bank select
// decoder 0x0E1230BC) and counts them per group (0x0E12467E): USER 2 (memory), CARD 2, the preset
// groups 2 each (in the flash: roland-jv2080-rhythm.js) and an expansion board's own sets (header
// byte 0x68); a program change past a group's last set is ignored (0x0E12A4C6).
const boardRhythmSets = (id) => BOARD_RHYTHM_SETS[id] || [];
const rhythmGroupOptions = (type, ctx, current) => (type === 0 ? intGroups() : type === 2 ? boardOptions(ctx, current, (id) => boardRhythmSets(id).length > 0) : pcmGroup(current));
/** Names of the rhythm sets in a group: presets from the flash, user sets as read, boards from their ROM. */
function rhythmSetNames(type, id, ctx) {
  if (type === 0 && id === 1) return [0, 1].map((i) => ctx?.names?.rhythm?.get(`0:${i}`) ?? '');
  if (type === 0 && id === 2) return ['', ''];
  if (type === 0 && id >= 3 && id <= 7) return PRESET_RHYTHM_SETS[PRESET_KEYS[id - 3]].map((n) => n.trim());
  if (type === 2) return boardRhythmSets(id);
  return [];
}
const rhythmNumberOptions = (type, id, ctx) => { const names = rhythmSetNames(type, id, ctx); return numbered(names.length, (i) => names[i]); };
/** Name of patch n of a group, if known (presets, user patches read so far, board ROMs). */
function patchName(type, id, n, ctx) {
  if (type === 0 && id >= 3 && id <= 7) return PRESET_PATCHES[['PR-A', 'PR-B', 'PR-C', 'PR-D', 'PR-E'][id - 3]]?.[n] ?? '';
  if (type === 0 && id === 1) return ctx?.names?.patch?.get(`0:${n}`) ?? '';
  if (type === 2) return boardPatchNames(id, ctx)?.[n] ?? '';
  return '';
}
function patchNumberOptions(type, id, ctx) {
  if (type === 0) return numbered(128, (n) => patchName(type, id, n, ctx));
  if (type === 2) return numbered(boardPatchCount(id, ctx) ?? 256, (n) => patchName(type, id, n, ctx) || '');
  return numbered(256);
}

/** Performance numbers as system byte 01 holds them (Roland's address map: USER:01-32, CARD:01-32, PR-A, PR-B). */
function performanceOptions(ctx) {
  return Array.from({ length: 128 }, (_, v) => {
    const bank = ['USER', 'CARD', 'PR-A', 'PR-B'][v >> 5];
    const i = v & 31;
    const name = bank === 'USER' ? ctx?.names?.performance?.get(`0:${i}`) : PRESET_PERFORMANCES[bank]?.[i];
    return [v, `${bank} ${String(i + 1).padStart(2, '0')}${name ? ` ${name}` : ''}`];
  });
}

const t = {
  name: (label) => ({ label, kind: 'char' }),
  plain: (label, extra = {}) => ({ label, ...extra }),
  opt: (label, options, extra = {}) => ({ label, options, ...extra }),
  s63: (label) => ({ label, ...signed(63) }),
  kf16: (label) => ({ label, options: L(47) }),
  kf15: (label) => ({ label, options: L(48) }),
  sens: (label) => ({ label, format: (v) => `${(v - 50) * 2 > 0 ? '+' : ''}${(v - 50) * 2}%` }), // 0-125 = -100..+150%
  note: (label) => ({ label, format: NOTE }),
  pan: (label) => ({ label, format: PAN }),
  plus1: (label) => ({ label, format: (v) => String(v + 1) }),
};

// ------------------------------------------------------------------ block layouts (by byte offset)
const NAME12 = Array.from({ length: 12 }, (_, i) => ({ ...t.name(`Name ${i + 1}`), hidden: true }));

// Settings of the JV-1080 and XP-80 that the data format keeps. Roland's address map in the
// JV-2080 owner's manual names them and puts their values in angle brackets: "for the JV-1080 or
// XP-80, and will be ignored if received by the JV-2080". No JV-2080 screen shows them (the screen
// table 0x0E078ECC has no field for them).
const XP_GROUP = 'JV-1080 / XP-80 settings';
const XP_NOTE = 'Settings for the JV-1080 and XP-80 (so named in the JV-2080 owner\'s manual) that the JV-2080 does not use; it has no screen for them.';
const XP_SYSTEM_NOTE = `${XP_NOTE} The JV-2080 stores them (they read back as written), so a backup restores them; Transmit program change and Transmit bank select also switch whether its MIDI output sends those messages.`;
const XP_PART_NOTE = `${XP_NOTE} The JV-2080 does not keep them: it ignores what is sent and always reports the defaults shown (octave shift 0, local and transmit OFF, PATCH, transmit volume OFF).`;
const xp = (label, extra = {}) => ({ label, ...extra });
const ONOFF = (v) => (v ? 'ON' : 'OFF');
const signedFrom = (centre) => (v) => `${v - centre > 0 ? '+' : ''}${v - centre}`;

// Wave group and number (tones and rhythm notes): lists, so an exact wave is easy to pick.
// The group ID list follows the group type; the wave list follows the group (board waves by name).
const waveGroupId = () => ({
  label: 'Wave group ID', relayout: true,
  dynamic: (data, ctx, p) => ({ options: waveGroupOptions(data[p.offset - 1], ctx, data[p.offset]), format: (v) => waveGroupName(data[p.offset - 1], v) }),
});
const waveNumber = () => ({
  label: 'Wave number', nibbles: 2,
  dynamic: (data, _ctx, p) => {
    const opts = waveNumberOptions(data[p.offset - 2], data[p.offset - 1]);
    return { options: opts, format: (v) => opts.find(([x]) => x === v)?.[1] ?? num3(v) };
  },
});

const TONE = [
  t.opt('Tone switch', O.onoff), groupTypeParam('Wave group type'), waveGroupId(), waveNumber(), null,
  t.opt('Wave gain', O.waveGain), t.opt('FXM switch', O.onoff), t.opt('FXM color', O.fxmColor), t.plus1('FXM depth'),
  t.opt('Delay mode', O.delayMode), t.plain('Delay time'), t.plain('Velocity cross fade'),
  t.plain('Velocity range lower'), t.plain('Velocity range upper'), t.note('Key range lower'), t.note('Key range upper'),
  t.opt('Redamper control', O.onoff), t.opt('Volume control', O.onoff), t.opt('Hold-1 control', O.onoff), t.opt('Pitch bend control', O.onoff), t.opt('Pan control', O.panSw),
  ...[1, 2, 3].flatMap((c) => [1, 2, 3, 4].flatMap((n) => [t.opt(`Ctrl ${c} dest ${n}`, O.dest), t.s63(`Ctrl ${c} depth ${n}`)])),
  ...[1, 2].flatMap((n) => [t.opt(`LFO${n} waveform`, O.lfoWave), t.opt(`LFO${n} key sync`, O.onoff), t.plain(`LFO${n} rate`),
    t.opt(`LFO${n} offset`, O.lfoOffset), t.plain(`LFO${n} delay time`), t.opt(`LFO${n} fade mode`, O.fadeMode), t.plain(`LFO${n} fade time`),
    t.opt(`LFO${n} external sync`, O.extSync)]),
  { label: 'Coarse tune', ...signed(48) }, { label: 'Fine tune', ...signed(50) }, t.plain('Random pitch depth'), t.kf16('Pitch keyfollow'),
  { label: 'P-env depth', ...signed(12) }, t.sens('P-env velocity sens'), t.kf15('P-env velocity time 1'), t.kf15('P-env velocity time 4'), t.kf15('P-env time keyfollow'),
  t.plain('P-env time 1'), t.plain('P-env time 2'), t.plain('P-env time 3'), t.plain('P-env time 4'),
  t.s63('P-env level 1'), t.s63('P-env level 2'), t.s63('P-env level 3'), t.s63('P-env level 4'),
  t.s63('LFO1 pitch depth'), t.s63('LFO2 pitch depth'),
  t.opt('Filter type', O.filter), t.plain('Cutoff frequency'), t.kf16('Cutoff keyfollow'), t.plain('Resonance'), t.sens('Resonance velocity sens'),
  t.s63('F-env depth'), t.opt('F-env velocity curve', O.curve), t.sens('F-env velocity sens'), t.kf15('F-env velocity time 1'), t.kf15('F-env velocity time 4'), t.kf15('F-env time keyfollow'),
  t.plain('F-env time 1'), t.plain('F-env time 2'), t.plain('F-env time 3'), t.plain('F-env time 4'),
  t.plain('F-env level 1'), t.plain('F-env level 2'), t.plain('F-env level 3'), t.plain('F-env level 4'),
  t.s63('LFO1 filter depth'), t.s63('LFO2 filter depth'),
  t.plain('Tone level'), t.opt('Bias direction', O.bias), t.note('Bias position'), t.kf15('Bias level'),
  t.opt('A-env velocity curve', O.curve), t.sens('A-env velocity sens'), t.kf15('A-env velocity time 1'), t.kf15('A-env velocity time 4'), t.kf15('A-env time keyfollow'),
  t.plain('A-env time 1'), t.plain('A-env time 2'), t.plain('A-env time 3'), t.plain('A-env time 4'),
  t.plain('A-env level 1'), t.plain('A-env level 2'), t.plain('A-env level 3'),
  t.s63('LFO1 level depth'), t.s63('LFO2 level depth'),
  t.pan('Tone pan'), t.kf15('Pan keyfollow'), t.plain('Random pan depth'), { label: 'Alternate pan depth', ...signed(64) },
  t.s63('LFO1 pan depth'), t.s63('LFO2 pan depth'),
  t.opt('Output assign', O.toneOut), t.plain('Mix/EFX send level'), t.plain('Chorus send level'), t.plain('Reverb send level'),
];
const TONE_GROUPS = [[0, 21, 'Wave and ranges'], [21, 45, 'Controllers'], [45, 61, 'LFOs'], [61, 81, 'Pitch'], [81, 101, 'Filter'], [101, 119, 'Amplifier'], [119, 129, 'Pan and output']];

// EFX parameters 1-12 take their label and display from the EFX type (firmware EFX screens).
function efxParam(slot) {
  return {
    label: `EFX parameter ${slot + 1}`,
    dynamic: (data, _ctx, p) => {
      const type = EFX_TYPES[data[p.typeOffset]];
      if (!type) return {};
      const s = type[slot];
      if (!s) return { hidden: true };
      if (s.list !== undefined && LISTS[s.list]) return { label: s.label, options: named(LISTS[s.list]) };
      if (s.gain) return { label: s.label, max: 30, format: (v) => `${v - 15 > 0 ? '+' : ''}${v - 15} dB` };
      return { label: s.label, ...(s.pan ? { format: PAN } : {}) };
    },
  };
}

const EFX_BLOCK = [
  t.opt('EFX type', O.efx, { relayout: true }), ...Array.from({ length: 12 }, (_, i) => efxParam(i)),
  t.opt('EFX output assign', O.efxOut), t.plain('EFX mix out send'), t.plain('EFX chorus send'), t.plain('EFX reverb send'),
  t.opt('EFX control source 1', O.efxCtl), t.s63('EFX control depth 1'), t.opt('EFX control source 2', O.efxCtl), t.s63('EFX control depth 2'),
  t.plain('Chorus level'), t.plain('Chorus rate'), t.plain('Chorus depth'), t.plain('Chorus pre-delay'), t.plain('Chorus feedback'), t.opt('Chorus output', O.choOut),
  t.opt('Reverb type', O.revType), t.plain('Reverb level'), t.plain('Reverb time'), t.opt('Reverb HF damp', O.hfDamp), t.plain('Delay feedback'),
  { label: 'Tempo', nibbles: 2 }, null,
];

const PATCH_COMMON = [
  ...NAME12, ...EFX_BLOCK,
  t.plain('Patch level'), t.pan('Patch pan'), t.plain('Analog feel'),
  t.plain('Bend range up'), t.plain('Bend range down'), t.opt('Key assign mode', O.keyAssign), t.opt('Solo legato', O.onoff),
  t.opt('Portamento switch', O.onoff), t.opt('Portamento mode', O.portaMode), t.opt('Portamento type', O.portaType), t.opt('Portamento start', O.portaStart), t.plain('Portamento time'),
  t.opt('Patch control source 2', O.patchCtl), t.opt('Patch control source 3', O.patchCtl),
  t.opt('EFX control hold/peak', O.holdPeak), t.opt('Ctrl 1 hold/peak', O.holdPeak), t.opt('Ctrl 2 hold/peak', O.holdPeak), t.opt('Ctrl 3 hold/peak', O.holdPeak),
  t.opt('Velocity range switch', O.onoff), t.opt('Octave shift', O.octave), t.opt('Stretch tune depth', O.stretch), t.opt('Voice priority', O.priority),
  t.opt('Structure type 1&2', O.structure), t.opt('Booster 1&2', O.booster), t.opt('Structure type 3&4', O.structure), t.opt('Booster 3&4', O.booster),
  t.opt('Clock source', O.patchClock), t.opt('Category', O.category),
];

const PERFORM_COMMON = [
  ...NAME12, t.opt('EFX-A source', O.efxSrc), ...EFX_BLOCK,
  t.opt('Key range switch', O.onoff),
  ...Array.from({ length: 16 }, (_, i) => t.plain(`Voice reserve part ${i + 1}`)),
  // 40h: stored (descriptor 0x107), set only when JV-1080 data is converted (0x0E124FCC), on no screen
  xp('Keyboard mode', { options: named(['LAYER', 'SINGLE']) }), t.opt('Clock source', O.perfClock),
  t.opt('EFX-B source', O.efxSrc), t.opt('EFX-C source', O.efxSrc),
];

// Patch group ID and number (performance parts, system selection) as lists, named where the
// names are known: presets, user patches read so far, expansion boards. Part 10 plays rhythm sets:
// the same bytes select a rhythm set there (the part apply 0x0E1290BA reloads the part when bytes
// 02-05 change), so its lists hold the rhythm sets of each group.
const isRhythmPart = (p) => p.section === 'p9';
const patchGroupParam = (label) => ({
  label, relayout: true,
  dynamic: (data, ctx, p) => {
    const type = data[p.offset - 1];
    const options = isRhythmPart(p) ? rhythmGroupOptions(type, ctx, data[p.offset]) : patchGroupOptions(type, ctx, data[p.offset]);
    return { options, format: (v) => groupName(type, v), ...(isRhythmPart(p) ? { help: 'Part 10 plays a rhythm set: USER 1-2, CARD 1-2, PR-A to PR-E 1-2 or the rhythm sets of an expansion board.' } : {}) };
  },
});
const patchNumberParam = (label) => ({
  label, nibbles: 2,
  dynamic: (data, ctx, p) => {
    const [type, id] = [data[p.offset - 2], data[p.offset - 1]];
    const opts = isRhythmPart(p) ? rhythmNumberOptions(type, id, ctx) : patchNumberOptions(type, id, ctx);
    return { options: opts, format: (v) => opts.find(([x]) => x === v)?.[1] ?? num3(v) };
  },
});
const PART = [
  t.opt('Receive switch', O.onoff), t.opt('Receive channel', O.channel), groupTypeParam('Patch group type'),
  patchGroupParam('Patch group ID'), patchNumberParam('Patch number'), null,
  t.plain('Part level'), t.pan('Part pan'), { label: 'Coarse tune', ...signed(48) }, { label: 'Fine tune', ...signed(50) },
  t.opt('Output assign', O.partOut), t.plain('Mix/EFX send level'), t.plain('Chorus send level'), t.plain('Reverb send level'),
  t.opt('Rx program change', O.onoff), t.opt('Rx volume', O.onoff), t.opt('Rx hold-1', O.onoff), t.note('Key range lower'), t.note('Key range upper'),
  // 13h-18h: JV-1080 / XP-80 part settings; descriptors 0x126-0x12B have no storage (mask 0), so
  // the getter 0x0E127388 returns their defaults and a DT1 changes nothing.
  xp('Octave shift', { options: O.octave, readOnly: true }), xp('Local switch', { options: O.onoff, readOnly: true }),
  xp('Transmit switch', { options: O.onoff, readOnly: true }), xp('Transmit bank select group', { options: L(17), readOnly: true }),
  xp('Transmit volume', { nibbles: 2, max: 128, readOnly: true, format: (v) => (v === 128 ? 'OFF' : String(v)) }), null,
  // 19h: which EFX (A, B or C) the part goes through when Output assign is EFX or PATCH; the
  // JV-2080's Output field shows both as one value (list 66: MIX, EFX-A..C, DIR1, DIR2, PAT-A..C; 0x0E12E3BC)
  t.opt('Output select', named(['A', 'B', 'C']), { help: 'With Output assign EFX or PATCH: EFX-A, EFX-B or EFX-C (the JV-2080 shows them as EFX-A..C and PAT-A..C).' }),
];

const SYSTEM = [
  t.opt('Panel mode', O.panelMode, { help: 'PERFORM, PATCH or GM: what the JV-2080 is playing. Changing it switches the mode.' }),
  { label: 'Current performance', help: 'The performance selected for performance mode (USER, CARD, PR-A or PR-B).',
    dynamic: (_data, ctx) => ({ options: performanceOptions(ctx) }) },
  groupTypeParam('Current patch group type', { help: 'The patch selected for patch mode: INT (user, card, presets) or EXP (expansion board).' }),
  patchGroupParam('Current patch group'), patchNumberParam('Current patch number'), null,
  { label: 'Master tune', format: (v) => `${(427.4 + v * 0.2).toFixed(1)} Hz` }, t.opt('Scale tune switch', O.onoff),
  t.opt('EFX switch', O.onoff), t.opt('Chorus switch', O.onoff), t.opt('Reverb switch', O.onoff), t.opt('Patch remain', O.onoff),
  t.opt('Clock source', O.sysClock), t.opt('Tap control', O.ctlSw), t.opt('Hold control', O.ctlSw), t.opt('Peak control', O.ctlSw),
  t.opt('Volume control', O.volSrc), t.opt('Aftertouch control', O.atSrc), t.opt('System control 1 source', O.sysCtlSrc), t.opt('System control 2 source', O.sysCtlSrc),
  t.opt('Rx program change', O.onoff), t.opt('Rx bank select', O.onoff), t.opt('Rx control change', O.onoff), t.opt('Rx modulation', O.onoff),
  t.opt('Rx volume', O.onoff), t.opt('Rx hold-1', O.onoff), t.opt('Rx pitch bend', O.onoff), t.opt('Rx aftertouch', O.onoff),
  t.opt('Control channel', O.ctrlCh), t.opt('Patch receive channel', O.channel), t.opt('Rhythm edit source', O.rhythmEdit), t.opt('Preview mode', O.preview),
  ...[1, 2, 3, 4].flatMap((n) => [t.note(`Preview key ${n}`), t.plain(`Preview velocity ${n}`)]),
];
// 28h-5Fh: JV-1080 / XP-80 settings, named and ranged as Roland's address map gives them (values in
// angle brackets, ignored by the JV-2080). The firmware stores them (52h-5Fh through IDs 6Dh-7Ah,
// remapped by the SysEx getter 0x0E12C14E and setter 0x0E12C1CC). 60h-61h: System Tempo (the
// SYSTEM Setup screen), 20-250 in two nibbles.
const OUT_MODE = named(['OFF', 'INT', 'MIDI', 'INT&MIDI']);
const POLARITY = named(['STANDARD', 'REVERSE']);
const ccList = (n) => [...Array.from({ length: 5 }, (_, i) => i + 1), ...Array.from({ length: 25 }, (_, i) => i + 7), ...Array.from({ length: 32 }, (_, i) => i + 64)]
  .map((v) => [v, `CC${String(v).padStart(2, '0')}`]).concat([[96, 'PITCH BEND'], [97, 'AFTERTOUCH']]).concat(n > 97
    ? ['PROG-UP', 'PROG-DOWN', 'START/STOP', 'PUNCH-IN/OUT', 'TAP-TEMPO', 'OCTAVE-UP', 'OCTAVE-DOWN'].map((l, i) => [98 + i, l]) : []);
const PEDAL_ASSIGN = ccList(104);
const C_ASSIGN = ccList(97);
const realVelocity = (v) => (v === 0 ? 'REAL' : String(v));
const pedalXp = (n) => [xp(`Pedal ${n} assign`, { options: PEDAL_ASSIGN }), xp(`Pedal ${n} output mode`, { options: OUT_MODE }), xp(`Pedal ${n} polarity`, { options: POLARITY })];
SYSTEM.push(
  xp('Transmit program change', { options: O.onoff }), xp('Transmit bank select', { options: O.onoff }),
  xp('Patch transmit channel', { options: named([...Array.from({ length: 16 }, (_, i) => `Ch ${i + 1}`), 'RX-CH', 'OFF']) }),
  xp('Transpose switch', { options: O.onoff }), xp('Transpose value', { options: Array.from({ length: 12 }, (_, v) => [v, signedFrom(5)(v)]) }),
  xp('Octave shift', { options: O.octave }), xp('Keyboard velocity', { input: 'number', format: realVelocity }),
  xp('Keyboard sens', { options: named(['LIGHT', 'STANDARD', 'HEAVY']) }), xp('Aftertouch sens', { input: 'number' }),
  ...pedalXp(1), ...pedalXp(2),
  xp('C1 assign', { options: C_ASSIGN }), xp('C1 output mode', { options: OUT_MODE }),
  xp('C2 assign', { options: C_ASSIGN }), xp('C2 output mode', { options: OUT_MODE }),
  xp('Hold pedal output mode', { options: OUT_MODE }), xp('Hold pedal polarity', { options: POLARITY }),
  ...[1, 2, 3, 4, 5, 6, 7].flatMap((k) => [xp(`Bank select group ${k} switch`, { options: O.onoff }),
    xp(`Bank select group ${k} MSB`, { input: 'number' }), xp(`Bank select group ${k} LSB`, { input: 'number' })]),
  ...pedalXp(3), ...pedalXp(4),
  xp('Arpeggio style', { input: 'number', format: (v) => String(v + 1) }), xp('Arpeggio motif', { input: 'number', format: (v) => String(v + 1) }),
  xp('Arpeggio beat pattern', { input: 'number', format: (v) => String(v + 1) }), xp('Arpeggio accent rate', { input: 'number' }),
  xp('Arpeggio shuffle rate', { input: 'number' }), xp('Arpeggio keyboard velocity', { input: 'number', format: realVelocity }),
  xp('Arpeggio octave range', { options: O.octave }), xp('Arpeggio part number', { options: Array.from({ length: 16 }, (_, i) => [i, `PART${i + 1}`]) }),
  { label: 'System tempo', nibbles: 2, min: 20, max: 250, help: 'The tempo of the system clock (SYSTEM Setup: System Tempo), 20-250.' }, null,
);
if (SYSTEM.length !== FW.system.size) throw new Error('JV-2080 system layout');

const SCALE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((n) => ({ label: n, ...signed(64, ' ct') }));

const RHYTHM_NOTE = [
  t.opt('Tone switch', O.onoff), groupTypeParam('Wave group type'), waveGroupId(), waveNumber(), null,
  t.opt('Wave gain', O.waveGain), t.plain('Bend range'), t.opt('Mute group', O.muteGroup), t.opt('Envelope mode', O.envMode),
  t.opt('Volume control', O.onoff), t.opt('Hold-1 control', O.onoff), t.opt('Pan control', O.panSw),
  t.note('Source key'), { label: 'Fine tune', ...signed(50) }, t.plain('Random pitch depth'), { label: 'P-env depth', ...signed(12) },
  t.sens('P-env velocity sens'), t.kf15('P-env velocity time'),
  t.plain('P-env time 1'), t.plain('P-env time 2'), t.plain('P-env time 3'), t.plain('P-env time 4'),
  t.s63('P-env level 1'), t.s63('P-env level 2'), t.s63('P-env level 3'), t.s63('P-env level 4'),
  t.opt('Filter type', O.filter), t.plain('Cutoff frequency'), t.plain('Resonance'), t.sens('Resonance velocity sens'),
  t.s63('F-env depth'), t.sens('F-env velocity sens'), t.kf15('F-env velocity time'),
  t.plain('F-env time 1'), t.plain('F-env time 2'), t.plain('F-env time 3'), t.plain('F-env time 4'),
  t.plain('F-env level 1'), t.plain('F-env level 2'), t.plain('F-env level 3'), t.plain('F-env level 4'),
  t.plain('Tone level'), t.sens('A-env velocity sens'), t.kf15('A-env velocity time'),
  t.plain('A-env time 1'), t.plain('A-env time 2'), t.plain('A-env time 3'), t.plain('A-env time 4'),
  t.plain('A-env level 1'), t.plain('A-env level 2'), t.plain('A-env level 3'),
  t.pan('Tone pan'), t.plain('Random pan depth'), { label: 'Alternate pan depth', ...signed(64) },
  t.opt('Output assign', O.toneOut), t.plain('Mix/EFX send level'), t.plain('Chorus send level'), t.plain('Reverb send level'),
];

// ------------------------------------------------------------------ object building
/**
 * Lay out several blocks one after the other in an object's data.
 * blocks: [{key, fw, names, address (7-bit int), section, group(i)}]
 * rebase(address) maps the addresses to the copy being edited (e.g. a performance part's
 * patch instead of the patch-mode patch). Returns {size, params, parts: [{address, offset, size}]}.
 */
function build(blocks, rebase = (a) => a) {
  const params = [];
  const parts = [];
  let offset = 0;
  for (const b of blocks) {
    const fw = FW[b.fw];
    parts.push({ address: b.address, offset, size: fw.size });
    const efxAt = b.names.findIndex((n) => n?.label === 'EFX type');
    b.names.forEach((n, i) => {
      if (!n || i >= fw.size) return;
      const [def, min, max] = fw.ranges[i];
      const p = {
        key: `${b.key}_${i}`, group: b.group(i), section: b.section, offset: offset + i,
        min: n.nibbles ? 0 : min, max: n.nibbles ? (max << 4) | fw.ranges[i + 1][2] : max,
        default: n.nibbles ? (def << 4) | fw.ranges[i + 1][0] : def,
        address: b.address + i, ...n,
      };
      if (efxAt >= 0) p.typeOffset = offset + efxAt;
      delete p.kind;
      if (n.kind === 'char') p.hidden = true;
      if (n.dynamic) { const dyn = n.dynamic; p.dynamic = (data, ctx) => dyn(data, ctx, p); }
      p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(rebase(p.address)), Array.from(data.slice(p.offset, p.offset + (p.nibbles || 1))));
      params.push(p);
    });
    offset += fw.size;
  }
  return { size: offset, params, parts, rebase };
}

function defaults(built) {
  const d = new Uint8Array(built.size);
  for (const p of built.params) {
    if (p.nibbles) { d[p.offset] = (p.default >> 4) & 15; d[p.offset + 1] = p.default & 15; } else d[p.offset] = p.default;
  }
  return d;
}

const nameOf = (data, offset = 0) => readText(data, offset, 12);

/** Read every block of an object; `base` relocates it (default: the object's current copy). */
async function fetchParts(api, built, base) {
  const out = new Uint8Array(built.size);
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

/** Apply a DT1 the JV-2080 sent on its own (panel edits with Tx Edit Data on) to an object. */
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

/** Parse every DT1 in a .syx into an object, relocating memory copies onto the object's layout. */
function fromSyxInto(built, bases) {
  return (msgs) => {
    const d = defaults(built);
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

// ------------------------------------------------------------------ the objects
// Patch: patch mode at 03 00 00 00, or the patch of performance part p at 02 pp 00 00
// (part 10 is the rhythm set). Tones follow at +00 00 10 00 + tone × 00 00 02 00.
const PATCH_BASE = A('03 00 00 00');
const partPatchBase = (part) => A('02 00 00 00') + part * A('00 01 00 00');
const patchTarget = { key: 'patch', base: PATCH_BASE };
const patchBuilt = build([
  { key: 'c', fw: 'patchCommon', names: PATCH_COMMON, address: PATCH_BASE, section: 'common',
    group: (i) => (i < 12 ? 'Name' : i < 0x21 ? 'EFX' : i < 0x2e ? 'Chorus, reverb and tempo' : i < 0x3a ? 'Common' : 'Controls and structure') },
  ...[0, 1, 2, 3].map((n) => ({ key: `t${n}`, fw: 'patchTone', names: TONE, address: PATCH_BASE + A('00 00 10 00') + n * A('00 00 02 00'), section: `t${n}`,
    group: (i) => TONE_GROUPS.find(([a, b]) => i >= a && i < b)[2] })),
], (a) => a - PATCH_BASE + patchTarget.base);

// Performance: common at 01 00 00 00, parts at 01 00 10 00 + part × 00 00 01 00.
const PERF_BASE = A('01 00 00 00');
const perfBuilt = build([
  { key: 'c', fw: 'performCommon', names: PERFORM_COMMON, address: PERF_BASE, section: 'common',
    group: (i) => (i < 12 ? 'Name' : i < 0x22 ? 'EFX' : i < 0x2f ? 'Chorus, reverb and tempo' : i < 0x40 ? 'Key range and voice reserve' : i === 0x40 ? XP_GROUP : 'Clock and EFX sources') },
  ...Array.from({ length: 16 }, (_, n) => ({ key: `p${n}`, fw: 'performPart', names: PART, address: PERF_BASE + A('00 00 10 00') + n * A('00 00 01 00'), section: `p${n}`,
    group: (i) => (i < 6 ? 'Patch' : i < 14 || i === 0x19 ? 'Level and output' : i < 0x13 ? 'MIDI and range' : XP_GROUP) })),
]);
// A part's Output assign received by SysEx resets its Output select to A first (setter 0x0E12C1CC
// resets ID 12Ch when ID 11Dh arrives; a whole part sends 19h after 0Ah, so it keeps its value).
for (const p of perfBuilt.params.filter((x) => x.label === 'Output assign')) {
  p.after = (d) => { d[p.offset + 0x19 - 0x0a] = 0; return null; };
}

// System: common at 00 00 00 00, patch-mode scale tune at 00 00 20 00, per-part scale tune at 00 00 1p 00.
const sysBuilt = build([
  { key: 's', fw: 'system', names: SYSTEM, address: 0, section: 'common',
    group: (i) => (i < 6 ? 'Current mode and selection' : i < 0x14 ? 'Tuning, effects and controls' : i < 0x20 ? 'MIDI' : i < 0x28 ? 'Preview' : i < 0x60 ? XP_GROUP : 'Tuning, effects and controls') },
  { key: 'sp', fw: 'systemScalePatch', names: SCALE, address: A('00 00 20 00'), section: 'scale', group: () => 'Scale tune (patch mode)' },
  ...Array.from({ length: 16 }, (_, n) => ({ key: `sc${n}`, fw: 'systemScalePerform', names: SCALE, address: A('00 00 10 00') + n * A('00 00 01 00'),
    section: 'scale', group: () => `Scale tune part ${n + 1}` })),
]);

// Rhythm set: the performance's part 10 at 02 09 00 00, or user rhythm set 1/2 at 10 40/41 00 00.
const RHY_BASE = A('02 09 00 00');
const RHY_KEYS = Array.from({ length: 64 }, (_, i) => 35 + i);
const rhythmTarget = { key: 'temp', base: RHY_BASE };
const rhythmBuilt = build([
  { key: 'rc', fw: 'rhythmCommon', names: NAME12, address: RHY_BASE, section: 'common', group: () => 'Name' },
  ...RHY_KEYS.map((k) => ({ key: `k${k}`, fw: 'rhythmNote', names: RHYTHM_NOTE, address: RHY_BASE + k * 128, section: `k${k}`,
    group: (i) => (i < 12 ? 'Wave and controls' : i < 26 ? 'Pitch' : i < 41 ? 'Filter' : i < 51 ? 'Amplifier' : 'Pan and output') })),
], (a) => a - RHY_BASE + rhythmTarget.base);

const userPatch = (n) => A('11 00 00 00') + n * A('00 01 00 00');
const userPerf = (n) => A('10 00 00 00') + n * A('00 01 00 00');
const userRhythm = (n) => A('10 40 00 00') + n * A('00 01 00 00');

// ------------------------------------------------------------------ banks and selection
// Patch banks (bank select MSB/LSB, decoder at 0x0E1230BC): USER 80/0, CARD 82/0,
// PR-A..PR-E 81/0-4, expansion slot k: 84/2k (patches 1-128) and 84/2k+1 (129-256).
const PATCH_BANKS = [
  { label: 'USER', msb: 80, lsb: 0, user: true },
  ...['PR-A', 'PR-B', 'PR-C', 'PR-D', 'PR-E'].map((k, i) => ({ label: k === 'PR-D' ? 'PR-D (GM)' : k, msb: 81, lsb: i, preset: k })),
  { label: 'CARD', msb: 82, lsb: 0, card: true },
  ...Array.from({ length: 16 }, (_, j) => ({ label: `XP-${'ABCDEFGH'[j >> 1]} ${j & 1 ? '129-256' : '1-128'}`, msb: 84, lsb: j, slot: j >> 1 })),
];
// Performances on the control channel: USER 80/0, PR-A 81/0, PR-B 81/1, and a data card's
// 82/0 (the decoder's CARD group; system byte 01 = 32 + n, CARD:01-32 in the address map).
const PERF_BANKS = [
  { label: 'USER', msb: 80, lsb: 0, user: true },
  { label: 'PR-A', msb: 81, lsb: 0, preset: 'PR-A' },
  { label: 'PR-B', msb: 81, lsb: 1, preset: 'PR-B' },
  { label: 'CARD', msb: 82, lsb: 0, card: true },
];

// Rhythm sets for part 10, by patch group (type, ID) as performance part 10 bytes 02-05 hold them;
// an expansion slot's group ID is the number of the board installed there.
const RHYTHM_BANKS = [
  { label: 'USER', type: 0, id: 1, user: true },
  ...PRESET_KEYS.map((k, i) => ({ label: k === 'PR-D' ? 'PR-D (GM)' : k, type: 0, id: 3 + i, preset: k })),
  { label: 'CARD', type: 0, id: 2, card: true },
  ...Array.from({ length: 8 }, (_, k) => ({ label: `XP-${SLOTS[k]}`, type: 2, slot: k })),
];
const PART10 = A('01 00 19 00'); // temporary performance, part 10
const rhythmBankId = (b, ctx) => (b.slot !== undefined ? boardsOf(ctx)?.[b.slot] || 0 : b.id);
function rhythmBankCount(bank, ctx) {
  const b = RHYTHM_BANKS[bank];
  if (b.slot === undefined) return 2;
  const id = rhythmBankId(b, ctx);
  return id ? boardRhythmSets(id).length : 0;
}
/** Select rhythm set n of a group into performance part 10 (bytes 02-05: group type, ID, number). */
const rhythmSelect = (ctx, type, id, n) => dt1(MODEL, ctx.deviceId, intToAddr(PART10 + 2), [type, id, n >> 4, n & 15]);

/** System data if it has been read from the device. */
const sysData = (ctx) => (ctx?.loaded?.has('system') ? ctx.data.system : null);
const patchChannel = (ctx) => sysData(ctx)?.[0x1d] ?? ctx.channel;
const controlChannel = (ctx) => { const c = sysData(ctx)?.[0x1c]; return c !== undefined && c < 16 ? c : ctx.channel; };
const select = (ch, msb, lsb, pc) => [[0xb0 | ch, 0, msb], [0xb0 | ch, 32, lsb], [0xc0 | ch, pc]];
/** Panel mode message (0 performance, 1 patch); also updates the system data read earlier. */
const panelMode = (ctx, mode) => {
  const sys = sysData(ctx);
  if (sys) sys[0] = mode;
  return dt1(MODEL, ctx.deviceId, [0, 0, 0, 0], [mode]);
};

function patchBankLabel(b, ctx) {
  if (b.slot === undefined) return b.label;
  const id = boardsOf(ctx)?.[b.slot];
  return id ? `${b.label} (${boardName(id)})` : id === 0 ? `${b.label} (empty)` : b.label;
}

/** Patches on a board: from its ROM, or the count found when its names were read from the unit. */
const boardPatchCount = (id, ctx) => SRJV80_BOARDS[id]?.patches?.length ?? ctx?.settings?.jvBoardCounts?.[id] ?? null;
const bankOffset = (b) => (b.lsb & 1 ? 128 : 0);

/** Patches in a bank (expansion banks hold what the board has past the bank's first number). */
function bankCount(bank, ctx) {
  const b = PATCH_BANKS[bank];
  if (b.slot === undefined) return 128;
  const id = boardsOf(ctx)?.[b.slot];
  const n = id ? boardPatchCount(id, ctx) : null;
  return n === null ? 128 : Math.max(0, Math.min(128, n - bankOffset(b)));
}

/**
 * Names of a whole bank when known without asking the unit: presets, and expansion banks of a
 * board whose names are in its ROM or were read once (complete for that bank). Else null, and
 * the bank's names are read from the unit.
 */
function bankPatchNames(bank, ctx) {
  const b = PATCH_BANKS[bank];
  if (b.preset) return PRESET_PATCHES[b.preset];
  if (b.slot === undefined) return null;
  const id = boardsOf(ctx)?.[b.slot];
  const names = id ? boardPatchNames(id, ctx) : null;
  if (!names) return null;
  const want = bankCount(bank, ctx);
  const part = names.slice(bankOffset(b), bankOffset(b) + want);
  return part.length === want && part.every((x) => typeof x === 'string') ? part : null;
}

// Selecting on the JV-2080. A panel mode change takes it about half a second, and a program
// change sent during that time lands late, so a selection is confirmed by reading system
// bytes 00-05 (panel mode, performance number, patch group type/ID/number) until they show
// it, before anything is read from the temporary area.
async function readSystemHead(api) {
  const s = await readBlock(api.g.client, MODEL, api.ctx.deviceId, [0, 0, 0, 0], 6);
  const sys = sysData(api.ctx);
  if (sys) sys.set(s, 0);
  return s;
}

/** Read system bytes 00-05 until `check` passes; null after `ms`. */
async function waitForSystem(api, check, ms = 2500) {
  const t0 = Date.now();
  for (;;) {
    const s = await readSystemHead(api);
    if (check(s)) return s;
    if (Date.now() - t0 > ms) return null;
    await sleep(100);
  }
}

/** Switch the panel mode (0 performance, 1 patch) only when it differs, and wait for it. */
async function ensureMode(api, mode) {
  const s = await readSystemHead(api);
  if (s[0] === mode) return s;
  api.send(panelMode(api.ctx, mode));
  const now = await waitForSystem(api, (x) => x[0] === mode, 3000);
  if (!now) throw new Error(`The JV-2080 did not switch to ${mode ? 'patch' : 'performance'} mode.`);
  return now;
}

const patchNumber = (s) => (s[4] << 4) | s[5];
/** Does system data `s` show patch i of bank b? (Expansion boards: any board ID.) */
const showsPatch = (b, i) => (s) => (b.slot !== undefined
  ? s[2] === 2 && patchNumber(s) === i + (b.lsb & 1 ? 128 : 0)
  : s[2] === 0 && s[3] === (b.user ? 1 : b.card ? 2 : 3 + b.lsb) && patchNumber(s) === i);
const perfNumber = (b, i) => (b.user ? i : b.card ? 32 + i : 64 + b.lsb * 32 + i);

/** Select patch i of bank b in patch mode; resolves to the confirmed system bytes or null. */
async function selectPatch(api, b, i, ms = 2500) {
  await ensureMode(api, 1);
  api.send(select(patchChannel(api.ctx), b.msb, b.lsb, i));
  return waitForSystem(api, showsPatch(b, i), ms);
}

async function selectPerformance(api, b, i) {
  await ensureMode(api, 0);
  api.send(select(controlChannel(api.ctx), b.msb, b.lsb, i));
  const s = await waitForSystem(api, (x) => x[1] === perfNumber(b, i));
  if (!s) throw new Error(`The JV-2080 did not select performance ${b.label} ${i + 1}. ${b.card ? 'Is a data card with performances inserted?' : 'Check the control channel (System page).'}`);
  return s;
}

/**
 * Put rhythm set i of a rhythm bank on part 10 of the temporary performance (performance mode),
 * the way the PERFORM Part page does: a DT1 to part 10 bytes 02-05. The JV-2080 loads the set into
 * 02 09 00 00 when those bytes change (part apply 0x0E1290BA); it answers the next request after
 * that. The editor copy of the performance follows.
 */
async function selectRhythm(api, bank, i) {
  const b = RHYTHM_BANKS[bank];
  const id = rhythmBankId(b, api.ctx);
  if (!id) throw new Error(`No expansion board with rhythm sets was found in slot ${SLOTS[b.slot]} (Find boards on the Patch page).`);
  await ensureMode(api, 0);
  api.send(rhythmSelect(api.ctx, b.type, id, i));
  const perf = api.ctx?.loaded?.has('performance') ? api.ctx.data.performance : null;
  if (perf) perf.set([b.type, id, i >> 4, i & 15], perfBuilt.parts[10].offset + 2);
  await sleep(api.g?.demo ? 0 : 150);
  rhythmTarget.key = 'temp';
  rhythmTarget.base = RHY_BASE;
}

/** Select a patch (patch mode) and read the temporary patch. */
async function selectAndReadPatch(api, b, i) {
  const s = await selectPatch(api, b, i);
  if (!s) throw new Error(`The JV-2080 did not select ${b.label} ${i + 1}${b.slot !== undefined || b.card ? ' (no board or card there?)' : '. Check the patch receive channel (System page)'}.`);
  patchTarget.key = 'patch';
  patchTarget.base = PATCH_BASE;
  return fetchParts(api, patchBuilt, PATCH_BASE);
}

/** The bank and number that reach what system bytes 02-05 say is selected, if known. */
function currentPatchSelect(sys, ctx) {
  const [type, id] = [sys[2], sys[3]];
  const n = patchNumber(sys);
  if (type === 0 && id === 1) return [80, 0, n];
  if (type === 0 && id === 2) return [82, 0, n];
  if (type === 0 && id >= 3 && id <= 7) return [81, id - 3, n];
  const slot = type === 2 ? boardsOf(ctx)?.indexOf(id) : -1;
  if (slot >= 0) return [84, slot * 2 + (n >= 128 ? 1 : 0), n & 127];
  return null;
}

/** Put back the patch (and panel mode) that was selected before a scan. */
async function restorePatch(api, before) {
  const sel = currentPatchSelect(before, api.ctx);
  const same = (s) => s[2] === before[2] && s[3] === before[3] && patchNumber(s) === patchNumber(before);
  if (sel) {
    api.send(select(patchChannel(api.ctx), ...sel));
    await waitForSystem(api, same, 2500);
  } else {
    api.send(dt1(MODEL, api.ctx.deviceId, [0, 0, 0, 2], Array.from(before.slice(2, 6))));
    await sleep(300);
  }
  if (before[0] !== 1) await ensureMode(api, before[0]);
}

/**
 * Read a bank's names by selecting each patch (expansion boards, card), then restore. A
 * board may hold fewer than 128 patches in a bank: the first number the JV-2080 does not
 * select ends the scan.
 */
async function scanPatchBank(api, bank, onName, shouldStop) {
  const b = PATCH_BANKS[bank];
  const before = await readSystemHead(api);
  const keep = await fetchParts(api, patchBuilt, PATCH_BASE);
  const names = [];
  let board = null;
  let end = null;
  try {
    await ensureMode(api, 1);
    const ch = patchChannel(api.ctx);
    for (let i = 0; i < 128; i++) {
      if (shouldStop?.()) break;
      api.send(select(ch, b.msb, b.lsb, i));
      const s = await waitForSystem(api, showsPatch(b, i), api.g?.demo ? 300 : 1500);
      if (!s) {
        end = i;
        api.toast(i ? `${b.label} holds ${i} patches.` : `Nothing answers in ${b.label}: no board or card there.`, i ? 'info' : 'warn');
        break;
      }
      if (b.slot !== undefined) board = s[3];
      names[i] = nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(PATCH_BASE), 12));
      onName(i, names[i]);
    }
  } finally {
    await restorePatch(api, before);
    api.send(writeParts(patchBuilt, keep, api.ctx.deviceId, PATCH_BASE));
  }
  // Names of a board read from the unit are kept, so the bank is not read again.
  if (board && names.length && !SRJV80_BOARDS[board]?.patches) {
    const s = api.ctx.settings || {};
    const all = [...(s.jvBoardNames?.[board] || [])];
    names.forEach((n, i) => { all[bankOffset(b) + i] = n; });
    for (let i = 0; i < all.length; i++) all[i] ??= null;
    api.g.host.device.update({
      jvBoardNames: { [board]: all },
      ...(end !== null && end > 0 ? { jvBoardCounts: { [board]: bankOffset(b) + end } } : {}),
    });
  }
}

/**
 * Board IDs in slots A-H, found by selecting patch 1 of each slot (an empty slot leaves the
 * selection where it was, so each try starts from USER 001). Afterwards the previous patch,
 * panel mode and the temporary patch with any edits are put back.
 */
async function findBoards(api) {
  const before = await readSystemHead(api);
  const keep = await fetchParts(api, patchBuilt, PATCH_BASE);
  const emptyMs = api.g?.demo ? 300 : 1200;
  const boards = [];
  let atUser = false;
  try {
    for (let k = 0; k < 8; k++) {
      api.g.setBusy?.(1, `Looking for an expansion board in slot ${SLOTS[k]}`);
      if (!atUser && !(await selectPatch(api, PATCH_BANKS[0], 0))) throw new Error('The JV-2080 did not select USER 001. Check the patch receive channel (System page).');
      const s = await selectPatch(api, PATCH_BANKS.find((x) => x.slot === k), 0, emptyMs);
      boards.push(s ? s[3] : 0);
      atUser = !s;
    }
    api.g.host.device.update({ jvBoards: boards, jvBoardsFound: Date.now() });
  } finally {
    await restorePatch(api, before);
    api.send(writeParts(patchBuilt, keep, api.ctx.deviceId, PATCH_BASE));
  }
  return boards;
}

const boardList = (boards) => boards.map((id, k) => (id ? `XP-${SLOTS[k]}: ${boardName(id)}` : null)).filter(Boolean).join(', ');

/** Find boards: from the button (asks first) or when connecting (quiet; reports changes only). */
async function detectBoards(api) {
  if (!api.quiet && !(await api.confirm('Find expansion boards',
    'This selects patch 1 of each expansion slot in turn, then the current patch again, and puts back the temporary patch with any edits. The result is remembered; it is also checked each time the JV-2080 connects (Connect page).', 'Find boards'))) return;
  const old = boardsOf(api.ctx);
  let boards;
  try { boards = await findBoards(api); } finally { if (!api.quiet) api.g.setBusy?.(0); }
  const changed = !old || old.join() !== boards.join();
  if (!api.quiet || changed) api.toast(boards.some(Boolean) ? `Expansion boards: ${boardList(boards)}` : 'No expansion boards found.', 'good', 6000);
  api.refresh();
}

// ------------------------------------------------------------------ simulator (demo mode, tests)
// Expansion boards in slots A-H: World and House (names from their ROMs) and an Experience III,
// whose patches are not on the board, with 40 made-up names.
const SIM_BOARDS = [5, 19, 97, 0, 0, 0, 0, 0];
const simBoardPatches = (id) => SRJV80_BOARDS[id]?.patches || Array.from({ length: 40 }, (_, i) => `Exp III ${String(i + 1).padStart(3, '0')}`);

function simulate() {
  const mem = new Map(); // 7-bit address int -> byte
  const put = (built, base, d) => { const first = built.parts[0].address; for (const p of built.parts) for (let i = 0; i < p.size; i++) mem.set(base + (p.address - first) + i, d[p.offset + i]); };
  const nm = (base, s) => { for (let i = 0; i < 12; i++) mem.set(base + i, (s.charCodeAt(i) || 32)); };
  const pd = defaults(patchBuilt);
  put(patchBuilt, PATCH_BASE, pd);
  for (let p = 0; p < 16; p++) if (p !== 9) put(patchBuilt, partPatchBase(p), pd);
  put(perfBuilt, PERF_BASE, defaults(perfBuilt));
  put(sysBuilt, 0, defaults(sysBuilt));
  put(rhythmBuilt, RHY_BASE, defaults(rhythmBuilt));
  for (let n = 0; n < 2; n++) { put(rhythmBuilt, userRhythm(n), defaults(rhythmBuilt)); nm(userRhythm(n), `User Drums ${n + 1}`); }
  for (let n = 0; n < 128; n++) { put(patchBuilt, userPatch(n), pd); nm(userPatch(n), `User ${String(n + 1).padStart(3, '0')}`); }
  for (let n = 0; n < 32; n++) { put(perfBuilt, userPerf(n), defaults(perfBuilt)); nm(userPerf(n), `Perform ${String(n + 1).padStart(2, '0')}`); }
  nm(PATCH_BASE, 'Demo Patch'); nm(PERF_BASE, 'Demo Perform'); nm(RHY_BASE, 'Demo Drums');
  const bank = Array.from({ length: 16 }, () => [80, 0]);
  const copy = (from, to, size) => { for (let i = 0; i < size; i++) mem.set(to + i, mem.get(from + i) ?? 0); };
  function programChange(ch, pc) {
    const [msb, lsb] = bank[ch];
    if (mem.get(0) === 1 && ch === mem.get(0x1d) && msb === 84) {
      // An empty slot, or a number past the board's last patch, leaves the selection as it was.
      const id = SIM_BOARDS[lsb >> 1];
      const n = pc + (lsb & 1 ? 128 : 0);
      const names = id ? simBoardPatches(id) : [];
      if (n >= names.length) return;
      put(patchBuilt, PATCH_BASE, pd); nm(PATCH_BASE, names[n]);
      mem.set(2, 2); mem.set(3, id); mem.set(4, n >> 4); mem.set(5, n & 15);
    } else if (mem.get(0) === 1 && ch === mem.get(0x1d)) {
      const b = PATCH_BANKS.find((x) => x.msb === msb && x.lsb === lsb && !x.card && x.slot === undefined);
      if (!b) return;
      if (b.user) for (const part of patchBuilt.parts) copy(userPatch(pc) + part.address - PATCH_BASE, part.address, part.size);
      else { put(patchBuilt, PATCH_BASE, pd); nm(PATCH_BASE, PRESET_PATCHES[b.preset][pc]); }
      mem.set(2, 0); mem.set(3, b.user ? 1 : 3 + b.lsb); mem.set(4, pc >> 4); mem.set(5, pc & 15);
    } else if (mem.get(0) === 0 && ch === mem.get(0x1c)) {
      const b = PERF_BANKS.find((x) => x.msb === msb && x.lsb === lsb);
      if (!b || b.card) return; // no data card in the simulator
      if (b.user) for (const part of perfBuilt.parts) copy(userPerf(pc) + part.address - PERF_BASE, part.address, part.size);
      else { put(perfBuilt, PERF_BASE, defaults(perfBuilt)); nm(PERF_BASE, PRESET_PERFORMANCES[b.preset][pc]); }
      mem.set(1, b.user ? pc : 64 + b.lsb * 32 + pc);
    }
  }
  // Part 10's group / number changed: load that rhythm set into 02 09 (user sets from memory,
  // presets and board sets as defaults with their names; a number past the group's last set,
  // an empty slot or no card leaves the part's rhythm set as it was).
  function loadRhythm() {
    const [type, id, hi, lo] = [2, 3, 4, 5].map((k) => mem.get(PART10 + k));
    const n = (hi << 4) | lo;
    const names = type === 0 && id === 1 ? [0, 1].map((i) => String.fromCharCode(...Array.from({ length: 12 }, (_, k) => mem.get(userRhythm(i) + k))))
      : type === 0 && id >= 3 && id <= 7 ? PRESET_RHYTHM_SETS[PRESET_KEYS[id - 3]]
        : type === 2 && SIM_BOARDS.includes(id) ? boardRhythmSets(id) : [];
    if (n >= names.length) return;
    if (type === 0 && id === 1) for (const part of rhythmBuilt.parts) copy(userRhythm(n) + part.address - RHY_BASE, part.address, part.size);
    else { put(rhythmBuilt, RHY_BASE, defaults(rhythmBuilt)); nm(RHY_BASE, names[n]); }
  }
  return {
    mem,
    handle(d) {
      const st = d[0] & 0xf0;
      if (st === 0xb0 && (d[1] === 0 || d[1] === 32)) { bank[d[0] & 15][d[1] ? 1 : 0] = d[2]; return []; }
      if (st === 0xc0) { programChange(d[0] & 15, d[1]); return []; }
      if (d[0] !== 0xf0) return null;
      if (d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) return [[0xf0, 0x7e, 0x10, 0x06, 0x02, 0x41, 0x6a, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf7]];
      if (d[1] !== 0x41 || d[3] !== 0x6a) return null;
      if (d[4] === 0x12) {
        const p = parseDt1(d, MODEL);
        if (!p?.ok) return [];
        const a = addrToInt(p.addr);
        p.data.forEach((b, i) => mem.set(a + i, b));
        if (a <= PART10 + 5 && a + p.data.length > PART10 + 2) loadRhythm();
        return [];
      }
      if (d[4] === 0x11) {
        const a = addrToInt(Array.from(d.slice(5, 9)));
        const size = addrToInt(Array.from(d.slice(9, 13)));
        const data = Array.from({ length: size }, (_, i) => mem.get(a + i) ?? 0);
        return dt1Chunks(MODEL, d[2], intToAddr(a), data, 128);
      }
      return [];
    },
  };
}

function describe(raw) {
  const p = parseDt1(raw, MODEL);
  if (p) return `JV-2080 DT1 ${p.addr.map((b) => b.toString(16).padStart(2, '0')).join(' ')} (${p.data.length} bytes)${p.ok ? '' : ' checksum error'}`;
  if (raw[1] === 0x41 && raw[3] === 0x6a && raw[4] === 0x11) return `JV-2080 RQ1 ${Array.from(raw.slice(5, 9), (b) => b.toString(16).padStart(2, '0')).join(' ')} size ${addrToInt(Array.from(raw.slice(9, 13)))}`;
  return null;
}

// Head Library: the shared synth model (roland-jv2080-translate.js)
const TR = jvTranslator({ patch: patchBuilt.params, perf: perfBuilt.params, rhythm: rhythmBuilt.params });

const TONE_SECTIONS = [{ key: 'common', label: 'Common' }, ...[0, 1, 2, 3].map((n) => ({ key: `t${n}`, label: `Tone ${n + 1}` }))];
const PATCH_TARGETS = [['patch', 'Patch mode'], ...Array.from({ length: 16 }, (_, p) => p).filter((p) => p !== 9).map((p) => [`p${p}`, `Performance part ${p + 1}`])];
const hex4 = (n) => intToAddr(n).map((b) => b.toString(16).padStart(2, '0')).join(' ');

function expansionNote(bank, ctx) {
  const b = PATCH_BANKS[bank];
  if (b.slot === undefined) return '';
  const id = boardsOf(ctx)?.[b.slot];
  if (!id) return id === 0 ? ' No board was found in this slot (Find boards checks again).' : ' Press Find boards to see which board is in this slot.';
  const src = SRJV80_BOARDS[id]?.patchSource;
  const n = boardPatchCount(id, ctx);
  return ` ${boardName(id)}${n !== null ? ` holds ${n} patches` : ''}${src === 'rom' ? '; the names come from the board ROM.' : src === 'list' ? '; the names come from its patch list.' : n !== null ? '; the names were read from the unit once.' : '.'}`;
}

/**
 * Split a SysEx dump into the objects it holds (Branch Library): user patches, performances and
 * rhythm sets, the temporary areas and the system block, by DT1 address. Each item has the
 * page it can be opened in.
 */
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
      const [aa, bb] = [a >> 21, (a >> 14) & 127];
      base = a & ~A('00 00 7f 7f');
      if (aa === 0x11) { key = `up${bb}`; label = `User patch ${num3(bb)}`; object = 'patch'; }
      else if (aa === 0x10 && bb < 0x20) { key = `uf${bb}`; label = `User performance ${String(bb + 1).padStart(2, '0')}`; object = 'performance'; }
      else if (aa === 0x10 && bb >= 0x40 && bb < 0x42) { key = `ur${bb}`; label = `User rhythm set ${bb - 0x3f}`; object = 'rhythm'; }
      else if (aa === 0x03) { key = 'tp'; label = 'Temporary patch (patch mode)'; object = 'patch'; }
      else if (aa === 0x02 && bb === 9) { key = 'tr'; label = 'Temporary rhythm set (part 10)'; object = 'rhythm'; }
      else if (aa === 0x02) { key = `pp${bb}`; label = `Patch of performance part ${bb + 1}`; object = 'patch'; }
      else if (aa === 0x01) { key = 'tf'; label = 'Temporary performance'; object = 'performance'; }
      else if (aa === 0x00) { key = 'sys'; label = 'System'; object = 'system'; base = 0; }
      else { key = `x${hex4(base)}`; label = `Data at ${hex4(base)}`; }
    } else if (m[1] === 0x41 && m[3] === 0x6a) { key = 'req'; label = 'Requests and other JV-2080 messages'; }
    let item = byKey.get(key);
    if (!item) { item = { key, label, object, name: '', msgs: [] }; byKey.set(key, item); items.push(item); }
    item.msgs.push(m);
    if (p?.ok && object && object !== 'system' && addrToInt(p.addr) === base && p.data.length >= 12) item.name = readText(p.data, 0, 12);
  }
  return items;
}

export default {
  coverage: 'Edits the JV-2080\'s patches, performances, rhythm sets and system settings, read from and written to the unit. Every parameter has the JV-2080\'s own ranges, defaults, names and option lists (EFX parameters named for each EFX type); the JV-1080 / XP-80 settings carry the names of Roland\'s owner\'s manual. Patch, performance and rhythm memories, the preset names, rhythm sets on part 10 (presets and expansion boards), expansion boards and bank select. Checked on a JV-2080.',
  sysex: { manufacturer: [0x41], model: MODEL, deviceIdDefault: 0x10 },
  minGap: 25,
  describe,
  // Head Library import: the messages this definition reads (DT1 for model 6A).
  recognise: (raw) => !!parseDt1(raw, MODEL)?.ok,
  // Roland model 6A messages, readable or not (a damaged DT1 is still this device's data)
  isOwn: (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === MODEL[0],
  isRequest: (raw) => raw?.[1] === 0x41 && raw[3] === MODEL[0] && raw[4] === 0x11,
  simulate,
  // Which board sits in each expansion slot cannot be asked for by SysEx; it is found by
  // selecting patch 1 of each slot when the JV-2080 connects, and remembered.
  connectTasks: [{ label: 'Finding expansion boards', enabled: (ctx) => ctx.settings?.jvScanBoards !== false, run: detectBoards }],
  connectOptions: [{
    key: 'jvScanBoards', label: 'Find expansion boards when connecting', default: true,
    help: 'Selects patch 1 of each expansion slot, then puts back the current patch and its edits (about 10 seconds). Board patch and wave names come from the board ROMs, so they need no reading. The last result is kept either way.',
  }],
  libraryItems,
  // Branch Library "Complete dump": the system, the temporary areas and every user memory.
  fullDump: ['System', 'Temporary patch (patch mode)', 'Temporary performance', 'All user patches', 'All user performances', 'User rhythm sets'],
  objects: [
    {
      key: 'system', page: 'System', icon: '⚙', label: 'System', size: sysBuilt.size, autoLoad: true,
      init: () => defaults(sysBuilt),
      fetch: (api) => fetchParts(api, sysBuilt),
      params: sysBuilt.params,
      receive: receiver(sysBuilt),
      sections: [{ key: 'common', label: 'System' }, { key: 'scale', label: 'Scale tune' }], cols: 3,
      groupInfo: {
        'Current mode and selection': { note: 'What the JV-2080 has selected right now: the panel mode, the performance used in performance mode and the patch used in patch mode.' },
        [XP_GROUP]: { note: XP_SYSTEM_NOTE, wide: true },
      },
      note: 'Read when the JV-2080 connects; the patch and performance pages use its receive and control channels. The JV-1080 / XP-80 settings card holds values the JV-2080 keeps but does not use.',
      sendAll: { label: 'Send to JV-2080', build: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId) },
      toSyx: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId).flat(),
      fromSyx: fromSyxInto(sysBuilt, () => [0]),
    },
    {
      key: 'patch', page: 'Patch', icon: '◆', label: 'Patch', size: patchBuilt.size, autoLoad: true,
      // Head Library: the patch's own Category (same 38 categories as the Head Library).
      category: (d) => categoryFromRoland(readParam(d, patchBuilt.params.find((x) => x.label === 'Category'))),
      setCategory: (d, id) => TR.patchSetCategory(d, id),
      setName: setJvName,
      toCommon: (d) => TR.patchToCommon(d),
      fromCommon: (c, base) => TR.patchFromCommon(c, base),
      init: () => defaults(patchBuilt),
      fetch: (api) => fetchParts(api, patchBuilt),
      params: patchBuilt.params,
      receive: receiver(patchBuilt),
      sections: TONE_SECTIONS, cols: 3,
      name: (d) => nameOf(d),
      target: {
        label: 'Edit', title: 'The patch-mode patch, or the patch a performance part plays',
        options: () => PATCH_TARGETS,
        value: () => patchTarget.key,
        set: (v) => { patchTarget.key = v; patchTarget.base = v === 'patch' ? PATCH_BASE : partPatchBase(Number(v.slice(1))); },
      },
      note: () => `Edits the patch being played (the temporary patch); changes are heard at once and kept until another patch is selected. Store saves it into a user memory.`,
      actions: [
        { label: 'Rename', run: async (api) => {
          const r = await api.form('Patch name', [{ key: 'name', label: 'Name (12 characters)', value: nameOf(api.data), maxlength: 12 }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          for (let i = 0; i < 12; i++) d[i] = Math.max(32, Math.min(127, r.name.charCodeAt(i) || 32));
          api.send(dt1(MODEL, api.ctx.deviceId, intToAddr(patchTarget.base), Array.from(d.slice(0, 12))));
          api.setData(d);
        } },
        { label: 'Find boards', title: 'Find the expansion boards installed in slots A-H', run: detectBoards },
      ],
      sendAll: { label: 'Send to JV-2080', title: 'Send the whole patch to the JV-2080\'s temporary patch, to hear it', build: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId) },
      toSyx: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId, PATCH_BASE).flat(),
      // Accepts the patch-mode patch, a part's patch and user patches (relocated onto the patch layout).
      fromSyx: fromSyxInto(patchBuilt, (a) => {
        const aa = a >> 21;
        if (aa === 0x03) return [PATCH_BASE];
        if (aa === 0x02) return [a & ~A('00 00 7f 7f')];
        if (aa === 0x11) return [a & ~A('00 00 7f 7f')];
        return [];
      }),
      slots: {
        label: 'Patches',
        banks: (ctx) => PATCH_BANKS.map((b, i) => [i, patchBankLabel(b, ctx)]),
        count: bankCount,
        slotLabel: (bank, i) => `${PATCH_BANKS[bank].label.split(' ')[0]} ${String(i + 1 + (PATCH_BANKS[bank].lsb & 1 && PATCH_BANKS[bank].slot !== undefined ? 128 : 0)).padStart(3, '0')}`,
        name: (d) => nameOf(d),
        names: bankPatchNames,
        recall: (bank, i, ctx) => [...(sysData(ctx)?.[0] === 1 ? [] : [panelMode(ctx, 1)]), ...select(patchChannel(ctx), PATCH_BANKS[bank].msb, PATCH_BANKS[bank].lsb, i)],
        play: async (api, bank, i) => { if (!(await selectPatch(api, PATCH_BANKS[bank], i))) api.toast(`The JV-2080 did not select ${PATCH_BANKS[bank].label} ${i + 1}.`, 'warn'); },
        fetch: (api, bank, i) => selectAndReadPatch(api, PATCH_BANKS[bank], i),
        fetchName: async (api, bank, i) => nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPatch(i)), 12)),
        scanBank: (api, bank, onName, stop) => (PATCH_BANKS[bank].user
          ? (async () => { for (let i = 0; i < 128 && !stop?.(); i++) onName(i, nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPatch(i)), 12))); })()
          : scanPatchBank(api, bank, onName, stop)),
        scanNote: (bank) => (PATCH_BANKS[bank].user ? null
          : `The JV-2080 can only show these names by selecting each patch, so reading ${PATCH_BANKS[bank].label} selects each in turn, then the current patch again, and puts back the temporary patch with any edits.${PATCH_BANKS[bank].slot !== undefined ? ' The names of an expansion board are remembered, so this is needed once per board.' : ''}`),
        store: (bank, i, ctx, data) => writeParts(patchBuilt, data, ctx.deviceId, userPatch(i)),
        writable: (bank) => !!PATCH_BANKS[bank].user,
        autoNames: [0],
        note: (bank, ctx) => `Play selects the patch on the patch receive channel (${patchChannel(ctx) + 1}); Edit also reads it into the editor.${PATCH_BANKS[bank].user ? ' Store writes the editor\'s patch into user memory.' : ''}${expansionNote(bank, ctx)}`,
      },
    },
    {
      key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: perfBuilt.size, autoLoad: true,
      setName: setJvName,
      toCommon: (d) => TR.perfToCommon(d),
      fromCommon: (c, base) => TR.perfFromCommon(c, base),
      init: () => defaults(perfBuilt),
      fetch: (api) => fetchParts(api, perfBuilt),
      params: perfBuilt.params,
      receive: receiver(perfBuilt),
      sections: [{ key: 'common', label: 'Common' }, ...Array.from({ length: 16 }, (_, n) => ({ key: `p${n}`, label: `Part ${n + 1}` }))],
      sectionLabel: 'Part', cols: 3,
      multi: {
        page: 'MIDI channels', label: 'Parts', count: 16, section: (i) => `p${i}`,
        partLabel: (i) => `Part ${i + 1}${i === 9 ? ' (rhythm)' : ''}`,
        columns: [
          { label: 'Receive', params: ['Receive switch'], role: 'on' },
          { label: 'Channel', params: ['Receive channel'], role: 'channel' },
          { label: 'Patch', params: ['Patch group type', 'Patch group ID', 'Patch number'], role: 'patch' },
          { label: 'Level', params: ['Part level'] },
          { label: 'Pan', params: ['Part pan'] },
          { label: 'Key range', params: ['Key range lower', 'Key range upper'] },
        ],
        note: 'The JV-2080 plays these parts in performance mode (System page: Panel mode PERFORM). Each change goes to the temporary performance; store it on the Performance page to keep the setup.',
      },
      groupInfo: { [XP_GROUP]: { note: `${XP_PART_NOTE} Keyboard mode is stored but likewise unused.`, wide: true } },
      name: (d) => nameOf(d),
      note: 'Edits the performance being played (the temporary performance). To edit the patch a part plays, choose that part under Edit on the Patch page.',
      sendAll: { label: 'Send to JV-2080', build: (data, ctx) => writeParts(perfBuilt, data, ctx.deviceId) },
      toSyx: (data, ctx) => writeParts(perfBuilt, data, ctx.deviceId).flat(),
      fromSyx: fromSyxInto(perfBuilt, (a) => ((a >> 21) === 0x01 ? [PERF_BASE] : (a >> 21) === 0x10 && ((a >> 14) & 127) < 32 ? [a & ~A('00 00 7f 7f')] : [])),
      slots: {
        label: 'Performances',
        banks: PERF_BANKS.map((b, i) => [i, b.label]),
        count: 32,
        slotLabel: (bank, i) => `${PERF_BANKS[bank].label} ${String(i + 1).padStart(2, '0')}`,
        name: (d) => nameOf(d),
        names: (bank) => (PERF_BANKS[bank].preset ? PRESET_PERFORMANCES[PERF_BANKS[bank].preset] : null),
        recall: (bank, i, ctx) => [...(sysData(ctx)?.[0] === 0 ? [] : [panelMode(ctx, 0)]), ...select(controlChannel(ctx), PERF_BANKS[bank].msb, PERF_BANKS[bank].lsb, i)],
        play: (api, bank, i) => selectPerformance(api, PERF_BANKS[bank], i),
        fetch: async (api, bank, i) => { await selectPerformance(api, PERF_BANKS[bank], i); return fetchParts(api, perfBuilt); },
        fetchName: async (api, bank, i) => nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPerf(i)), 12)),
        store: (bank, i, ctx, data) => writeParts(perfBuilt, data, ctx.deviceId, userPerf(i)),
        writable: (bank) => !!PERF_BANKS[bank].user,
        autoNames: [0],
        note: (bank, ctx) => `Play switches to performance mode and selects the performance on the control channel (${controlChannel(ctx) + 1}).`,
      },
    },
    {
      key: 'rhythm', page: 'Rhythm set', icon: '▤', label: 'Rhythm set', size: rhythmBuilt.size,
      setName: setJvName,
      toCommon: (d) => TR.rhythmToCommon(d),
      fromCommon: (c, base) => TR.rhythmFromCommon(c, base),
      init: () => defaults(rhythmBuilt),
      fetch: (api) => fetchParts(api, rhythmBuilt),
      params: rhythmBuilt.params,
      receive: receiver(rhythmBuilt),
      sections: RHY_KEYS.map((k) => ({ key: `k${k}`, label: `Key ${k} ${NOTE(k)}` })),
      sectionLabel: 'Key', cols: 3,
      name: (d) => nameOf(d),
      target: {
        label: 'Edit', title: 'The rhythm set of the performance (part 10), or a user rhythm set in memory',
        options: () => [['temp', 'Performance part 10'], ['u0', 'User rhythm set 1 (memory)'], ['u1', 'User rhythm set 2 (memory)']],
        value: () => rhythmTarget.key,
        set: (v) => { rhythmTarget.key = v; rhythmTarget.base = v === 'temp' ? RHY_BASE : userRhythm(Number(v.slice(1))); },
      },
      note: () => (rhythmTarget.key === 'temp'
        ? 'Edits the rhythm set the performance being played uses on part 10, one key at a time.'
        : `Edits user rhythm set ${Number(rhythmTarget.key.slice(1)) + 1} directly in memory: every change is stored at once.`),
      // Rhythm sets by group, as part 10 selects them: Play puts the set on part 10 of the
      // temporary performance, Edit also reads it; the two user sets store from the editor.
      slots: {
        label: 'Rhythm sets',
        banks: (ctx) => RHYTHM_BANKS.map((b, i) => {
          if (b.slot === undefined) return [i, b.label];
          const id = boardsOf(ctx)?.[b.slot];
          return [i, id ? `${b.label} (${boardName(id)})` : id === 0 ? `${b.label} (empty)` : b.label];
        }),
        count: rhythmBankCount,
        slotLabel: (bank, i) => `${RHYTHM_BANKS[bank].label} ${num3(i)}`,
        name: (d) => nameOf(d),
        names: (bank, ctx) => {
          const b = RHYTHM_BANKS[bank];
          if (b.preset) return PRESET_RHYTHM_SETS[b.preset].map((n) => n.trim());
          if (b.slot !== undefined) { const id = rhythmBankId(b, ctx); return id ? boardRhythmSets(id) : []; }
          return null;
        },
        fetchName: async (api, bank, i) => (RHYTHM_BANKS[bank].user ? nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userRhythm(i)), 12)) : ''),
        scannable: (bank) => !!RHYTHM_BANKS[bank].user,
        autoNames: [0],
        recall: (bank, i, ctx) => {
          const b = RHYTHM_BANKS[bank];
          const id = rhythmBankId(b, ctx);
          return id ? [...(sysData(ctx)?.[0] === 0 ? [] : [panelMode(ctx, 0)]), rhythmSelect(ctx, b.type, id, i)] : null;
        },
        play: (api, bank, i) => selectRhythm(api, bank, i),
        fetch: async (api, bank, i) => { await selectRhythm(api, bank, i); return fetchParts(api, rhythmBuilt, RHY_BASE); },
        store: (bank, i, ctx, data) => writeParts(rhythmBuilt, data, ctx.deviceId, userRhythm(i)),
        writable: (bank) => !!RHYTHM_BANKS[bank].user,
        note: (bank, ctx) => {
          const b = RHYTHM_BANKS[bank];
          const id = rhythmBankId(b, ctx);
          const what = b.preset ? ' The names come from the JV-2080 firmware.'
            : b.card ? ' The card sets need a data card in the JV-2080.'
              : b.user ? ' Store writes the editor\'s set into the user set.'
                : !id ? ' Press Find boards on the Patch page to see which board is in this slot.'
                  : ` ${boardName(id)} holds ${boardRhythmSets(id).length} rhythm sets in the JV-80 format, which have no name: the JV-2080 calls each "JV rhythm".`;
          return `Play puts the set on part 10 of the performance being played (in performance mode); Edit also reads it into the editor.${what}`;
        },
      },
      sendAll: { label: 'Send to JV-2080', build: (data, ctx) => writeParts(rhythmBuilt, data, ctx.deviceId) },
      toSyx: (data, ctx) => writeParts(rhythmBuilt, data, ctx.deviceId, RHY_BASE).flat(),
      fromSyx: fromSyxInto(rhythmBuilt, (a) => ((a >> 14) === (RHY_BASE >> 14) ? [RHY_BASE] : (a >> 21) === 0x10 && ((a >> 14) & 127) >= 0x40 ? [a & ~A('00 00 7f 7f')] : [])),
    },
  ],
  requests: [
    { label: 'Temporary patch (patch mode)', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(PATCH_BASE), A('00 00 17 01')) },
    { label: 'Temporary performance', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(PERF_BASE), A('00 00 20 00')) },
    { label: 'System', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(0), A('00 00 30 00')) },
    { label: 'All user patches', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('11 00 00 00')), A('00 7f 7f 7f')) },
    { label: 'All user performances', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(A('10 00 00 00')), A('00 20 00 00')) },
    { label: 'User rhythm sets', bytes: (ctx) => rq1(MODEL, ctx.deviceId, intToAddr(userRhythm(0)), A('00 02 00 00')) },
  ],
  templates: [
    { label: 'Panel mode: patch', bytes: (ctx) => panelMode(ctx, 1) },
    { label: 'Panel mode: performance', bytes: (ctx) => panelMode(ctx, 0) },
    { label: 'GM System On', bytes: () => [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7] },
  ],
};

export const _test = { patchBuilt, perfBuilt, sysBuilt, rhythmBuilt, defaults, MODEL, PATCH_BASE, PERF_BASE, PATCH_BANKS, PERF_BANKS, patchTarget, rhythmTarget, partPatchBase, userRhythm, currentPatchSelect };
