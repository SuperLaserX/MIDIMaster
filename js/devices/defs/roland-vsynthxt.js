// Roland V-Synth XT: the V-Synth engine's MIDI implementation, from the OS 2.02 firmware (SH-4,
// application "VAPP1" unpacked by tools/roland/vsynth_rom.py; tables by tools/roland/vsynth_fw.py;
// see docs/devices/roland-vsynth-xt.md). Roland SysEx, model 00 53, 4-byte addresses, RQ1 11h / DT1 12h.
//
//   01 00 00 00  setup (37h): part bank/program, transpose, palette
//   02 00 00 00  system (38h)     02 00 40 00  system controllers (1Bh)     02 00 50 00  user sets (48h)
//   10 0n 00 00  temporary patch (the XT answers the same patch for n = 0-F)
//   20 00 00 00 + n x 00 01 00 00   user patch n (512: 20 00 - 23 7F)
//   patch: +00 00 common (72h)  +02 00 MFX (84h)  +04 00 chorus (33h)  +06 00 reverb (62h)
//          +08 00 beam, pad, arpeggio (0Dh)  +09 00 zone knob sets (10h)  +0A 00 step sequencer (62h)
//          zone z (1-16): +10 00+z-1 tone (80h)  +20 00+2(z-1) envelopes (A9h)  +40 00+z-1 LFOs (28h)
//                         +50 00+z-1 COSM 1 (42h)  +60 00+z-1 COSM 2 (42h)
//          +70 00+n-1 arpeggio step pattern n (42h)
// The VC-1 (D-50) and VC-2 (Vocal Designer) engines are separate applications with their own
// SysEx: roland-vsynthxt-vc1.js (model 14h) and roland-vsynthxt-vc2.js (model 00 00 0D). The VC-2
// reuses the effect tables of this framework, so fxSlot takes the table set as an argument.

import { readText, readParam } from '../../core/model/memmap.js';
import { dt1, dt1Chunks, parseDt1, readBlock, intToAddr, addrToInt, checksum } from '../../core/midi/roland.js';
import { P, E, FX, FX_BLOCKS, CATEGORIES } from './roland-vsynthxt-fw.js';
import { vsTranslator } from './roland-vsynthxt-translate.js';
import { isP00, readP00, writeP00, p00FileName } from './roland-vsynthxt-p00.js';
import { presentSystem, presentOscillators, presentStepModulator, presentArpeggio } from './roland-vsynthxt-ui.js';

export const MODEL = [0x00, 0x53];
export const A = (s) => addrToInt(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const hex4 = (a) => intToAddr(a).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => `${NOTES[n % 12]}${Math.floor(n / 12) - 1}`;
export const ZONES = 16;
const TABLES = { P, E, FX, FX_BLOCKS };

// ------------------------------------------------------------------ value display (firmware specs)
const segLen = (s) => ({ L: 1, N: s[1], K: s[1], T: s[1]?.length, A: 96 }[s[0]] ?? Infinity);
function segLabel(s, k, unit) {
  switch (s[0]) {
    case 'L': return s[1];
    case 'T': { const t = s[1][k]?.trim() ?? ''; return unit && /^[+-]?[\d.]+$/.test(t) ? `${t} ${unit}` : t; }
    case 'K': return noteName(s[2] + k);
    case 'N': {
      const [, , first, step, dec, plus, pre, post, pad] = s;
      const v = first + k * step;
      let t = Math.abs(v).toFixed(dec);
      if (pad) t = t.padStart(pad + (dec ? dec + 1 : 0), '0');
      const sign = v < 0 ? '-' : plus && v > 0 ? '+' : '';
      return `${pre}${sign}${t}${post}${unit ? ` ${unit}` : ''}`;
    }
    default: return String(k);
  }
}

/** {options} for named values, else {format}, from a firmware display spec (segments). */
export function display(segs, unit, min, max) {
  if (segs.length === 1 && segs[0][0] === 'X') return { format: (v) => `${(v >>> 0).toString(16).toUpperCase().padStart(segs[0][1], '0')}h` };
  if (segs.length === 1 && segs[0][0] === 'A') return { format: (v) => `'${String.fromCharCode(v)}'` };
  const label = (v) => {
    let k = v - min;
    for (const s of segs) {
      const n = segLen(s);
      if (k < n) return segLabel(s, k, unit);
      k -= n;
    }
    return String(v);
  };
  const named = segs.some((s) => s[0] !== 'N');
  if (named && max - min < 400) return { options: Array.from({ length: max - min + 1 }, (_, k) => [min + k, label(min + k)]) };
  return { format: label };
}

// ------------------------------------------------------------------ parameter groups
// Envelopes and LFOs in the order of the Matrix Control destinations (and the long names
// "OSC 1 Pit Env", "Time/PW Env", "Fmt/Fat Env", "TVA Env", "COSM [..] ENV (A)/(B)").
export const ENV_NAMES = ['OSC 1 pitch', 'OSC 1 time/PW', 'OSC 1 formant/fat', 'OSC 1 level', 'OSC 2 pitch', 'OSC 2 time/PW', 'OSC 2 formant/fat', 'OSC 2 level', 'COSM 1 A', 'COSM 1 B', 'COSM 2 A', 'COSM 2 B', 'TVA'];
export const LFO_NAMES = ['OSC 1', 'OSC 2', 'COSM 1', 'COSM 2', 'TVA'];
function groupOf(name, block) {
  let m;
  if (block.group) return block.group;
  if ((m = /^Env (\d+)/.exec(name))) return `Envelope ${m[1]} (${ENV_NAMES[m[1] - 1]})`;
  if ((m = /^LFO (\d+)/.exec(name))) return `LFO ${m[1]} (${LFO_NAMES[m[1] - 1]})`;
  if ((m = /^(OSC \d)/.exec(name))) return m[1];
  if ((m = /^(Matrix Control \d+)/.exec(name))) return m[1];
  if ((m = /^(Track \d+)/.exec(name))) return m[1];
  if ((m = /^Part (\d+)/.exec(name))) return `Part ${m[1]}`;
  if ((m = /^(User Set \d+)/.exec(name))) return m[1];
  if (/^Patch Name/.test(name)) return 'Name';
  if (/Scale Tune/.test(name)) return 'Scale tune';
  if (/^Zone \d+ Range/.test(name) || name === 'Current Zone') return 'Zones';
  if (/^Zone \d+ Knob Set/.test(name)) return 'Zone knob sets';
  if (/^(MOD|Structure)/.test(name)) return 'Structure and MOD';
  if (/^TVA|Send Level|Output Assign/.test(name)) return 'TVA and output';
  if (/^Arpeggio/.test(name)) return 'Arpeggio';
  if (/^(Beam|Pad)/.test(name)) return 'Beam and pad';
  if (/^EQ/.test(name)) return 'EQ';
  if (/^(Knob|Pedal|Hold|Time Trip Assign)/.test(name)) return 'Controllers';
  if (/^(Master Switch|Key Sync|Track Loop)/.test(name)) return 'Step sequencer';
  if (/^(Control|Step)/.test(name)) return 'Steps';
  return block.defaultGroup || 'Common';
}

// ------------------------------------------------------------------ blocks and objects
/**
 * Lay out blocks one after the other in an object's data. A block: {key, id (first parameter id),
 * size, at (address offset, 7-bit int), section, prefix, group, fx: 'mfx'|'chorus'|'reverb'|'cosm',
 * typeAt (offset of the effect type)}. Returns {size, params, parts: [{address offset, offset, size}]}.
 */
export function build(blocks, T = TABLES) {
  const params = [];
  const parts = [];
  let offset = 0;
  for (const b of blocks) {
    parts.push({ at: b.at, offset, size: b.size, key: b.key });
    let typeParam = null;
    const fxBase = b.fx ? T.FX_BLOCKS[b.fx][0] : 0;
    for (let k = 0; k < b.size; k++) {
      const f = T.P[b.id + k];
      if (!f) continue; // a nibble of a later value, or unused
      const [name, nib, min, max, def, segs, unit] = f;
      const start = k - nib + 1;
      const p = {
        key: `${b.key}_${k}`, fwId: b.id + k, label: `${b.prefix || ''}${name}`, name, section: b.section, group: groupOf(name, b),
        offset: offset + start, at: b.at + start, min, max, default: def,
      };
      if (nib > 1) p.nibbles = nib;
      if (segs[0]?.[0] === 'A') { p.kind = 'char'; p.hidden = true; }
      if (segs[0]?.[0] === 'E') {
        // "Parameter n" of an effect: value + 32768 in 4 nibbles; meaning per effect type
        const n = Number(/(\d+)$/.exec(name)?.[1]);
        p.bias = 32768; p.min = -20000; p.max = 20000; p.default = 0;
        const tp = typeParam;
        const kind = b.fx;
        p.dynamic = (data) => fxSlot(kind, n, data ? readParam(data, tp) : 0, T);
        p.fxSlot = n;
      } else if (b.fx && k === b.typeAt) {
        // the type: named after the effect types the block can hold
        const types = T.FX.slice(fxBase, T.FX_BLOCKS[b.fx][1]);
        p.options = Array.from({ length: max - min + 1 }, (_, v) => [min + v, types[min + v]?.[0] ?? String(min + v)]);
        typeParam = p;
      } else Object.assign(p, display(segs, unit, min, max));
      params.push(p);
    }
    offset += b.size;
  }
  return { size: offset, params, parts };
}

/** What effect parameter slot n means for effect type t of block kind (label, range, display). */
export function fxSlot(kind, n, t, T = TABLES) {
  const fx = T.FX[T.FX_BLOCKS[kind][0] + t];
  if (fx) {
    for (let i = fx[1]; i <= fx[2]; i++) {
      const e = T.E[i];
      if (e && e[1] === n) {
        const [name, , def, min, max, segs, unit] = e;
        return { label: `${fx[0]}: ${name.replace(/\s*\*\d+$/, '')}`, min, max, default: def, hidden: false, ...display(segs, unit, min, max) };
      }
    }
  }
  return { hidden: true, label: `Parameter ${n} (not used by ${fx?.[0] ?? 'this type'})` };
}

const PATCH = A('10 00 00 00');
export const userPatch = (n) => A('20 00 00 00') + n * A('00 01 00 00');
const zoneBlocks = (z) => [
  { key: `t${z}`, id: 0x293, size: 0x80, at: A('00 10 00') + z * A('00 01 00'), section: `z${z}` },
  { key: `e${z}`, id: 0x314, size: 0xa9, at: A('00 20 00') + z * A('00 02 00'), section: `z${z}` },
  { key: `l${z}`, id: 0x3be, size: 0x28, at: A('00 40 00') + z * A('00 01 00'), section: `z${z}` },
  { key: `ca${z}`, id: 0x3e7, size: 0x42, at: A('00 50 00') + z * A('00 01 00'), section: `z${z}`, prefix: 'COSM 1 ', group: 'COSM 1', fx: 'cosm', typeAt: 1 },
  { key: `cb${z}`, id: 0x3e7, size: 0x42, at: A('00 60 00') + z * A('00 01 00'), section: `z${z}`, prefix: 'COSM 2 ', group: 'COSM 2', fx: 'cosm', typeAt: 1 },
];
export const patchBuilt = build([
  { key: 'c', id: 0x103, size: 0x72, at: 0, section: 'common' },
  { key: 'm', id: 0x177, size: 0x84, at: A('00 02 00'), section: 'fx', group: 'MFX', fx: 'mfx', typeAt: 0 },
  { key: 'ch', id: 0x1fc, size: 0x33, at: A('00 04 00'), section: 'fx', group: 'Chorus', fx: 'chorus', typeAt: 0 },
  { key: 'rv', id: 0x230, size: 0x62, at: A('00 06 00'), section: 'fx', group: 'Reverb', fx: 'reverb', typeAt: 0 },
  { key: 'ar', id: 0x42b, size: 0x0d, at: A('00 08 00'), section: 'arp' },
  { key: 'zk', id: 0x439, size: 0x10, at: A('00 09 00'), section: 'common' },
  { key: 'sq', id: 0x48d, size: 0x62, at: A('00 0a 00'), section: 'seq' },
  ...Array.from({ length: ZONES }, (_, z) => zoneBlocks(z)).flat(),
  ...Array.from({ length: 16 }, (_, n) => ({ key: `st${n}`, id: 0x44a, size: 0x42, at: A('00 70 00') + n * A('00 01 00'), section: 'steps', group: `Step pattern ${n + 1}` })),
]);
const SYS = 0;
const sysBuilt = build([
  { key: 's0', id: 0, size: 0x37, at: A('01 00 00 00'), section: 'setup', defaultGroup: 'Setup' },
  { key: 's1', id: 0x39, size: 0x38, at: A('02 00 00 00'), section: 'system', defaultGroup: 'System' },
  { key: 's2', id: 0x7f, size: 0x1b, at: A('02 00 40 00'), section: 'controllers', defaultGroup: 'Controllers' },
  { key: 's3', id: 0xba, size: 0x48, at: A('02 00 50 00'), section: 'usersets', defaultGroup: 'Knob CC assign' },
]);

/** The parameter at block key + firmware name (translator, tests). */
export const pByName = (built, blockKey, name) => built.params.find((p) => p.key.startsWith(`${blockKey}_`) && p.name === name);

export function defaults(built) {
  const d = new Uint8Array(built.size);
  for (const p of built.params) {
    if (p.get) continue; // a value made of other parameters (Part n Patch)
    let v = (p.default ?? 0) + (p.bias || 0);
    if (p.nibbles) { for (let i = p.nibbles - 1; i >= 0; i--) { d[p.offset + i] = v & 15; v >>>= 4; } } else d[p.offset] = v & 127;
  }
  return d;
}
export const patchDefaults = () => defaults(patchBuilt);
export const nameOf = (d) => readText(d, 0, 12);

export async function fetchParts(api, built, base, onPart) {
  const out = new Uint8Array(built.size);
  for (const [i, part] of built.parts.entries()) {
    out.set(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(base + part.at), part.size), part.offset);
    onPart?.(i + 1, built.parts.length);
  }
  return out;
}

/**
 * Read a whole patch with one RQ1 over its address range (00 01 00 00): the XT walks the range and
 * answers every block (103 DT1, about 10 KB, 5 s at MIDI speed). Blocks that did not arrive are
 * read one by one.
 */
export const readPatch = (api, base, onProgress) => readPatchOf(api, patchBuilt, base, onProgress);
export async function readPatchOf(api, built, base, onProgress) {
  const out = defaults(built);
  const have = new Set();
  const total = built.parts.length;
  const take = (raw) => {
    const p = parseDt1(raw, MODEL);
    if (!p?.ok) return false;
    const a = addrToInt(p.addr);
    const part = built.parts.find((x) => base + x.at === a);
    if (!part) return false;
    out.set(p.data.subarray(0, part.size), part.offset);
    have.add(part.key);
    onProgress?.(have.size, total);
    return true;
  };
  try {
    await api.g.client.request(Uint8Array.from(rq1Msg(api.ctx.deviceId, base, A('00 01 00 00'))), {
      collect: (m, r) => take(r ?? m.raw), complete: () => have.size === total, quiet: 1500, resolveOnQuiet: true, timeout: 4000,
    });
  } catch { /* fall back below */ }
  for (const part of built.parts) {
    if (have.has(part.key)) continue;
    out.set(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(base + part.at), part.size), part.offset);
    have.add(part.key);
    onProgress?.(have.size, total);
  }
  return out;
}

export function rq1Msg(dev, addr, size) {
  const body = [...intToAddr(addr), ...intToAddr(size)];
  let s = 0;
  for (const x of body) s += x;
  return [0xf0, 0x41, dev & 0x7f, ...MODEL, 0x11, ...body, (128 - (s % 128)) % 128, 0xf7];
}

// ------------------------------------------------------------------ digital output frequency (device 7E)
// The XT's factory-test remote: DT1 at device ID 7E to 00 00 00 00 with one byte. 0-2 set system
// parameter 119 Digital Output Frequency (44.1/48/96 kHz), which has no SysEx address of its own,
// and clear the sampling mode; 3/4 open the coaxial sampling screen for the left/right channel for
// an instant (the test screen's DIGITAL IN checks) and are not offered. Nothing reads the value back.
// Checked on the unit: 0 showed 44.1 kHz, 1 put back 48 kHz.
export const DIGITAL_OUT = ['44.1 kHz', '48 kHz', '96 kHz'];
export function digitalOutMsg(sub) {
  const body = [0, 0, 0, 0, sub & 0x7f];
  return [0xf0, 0x41, 0x7e, ...MODEL, 0x12, ...body, checksum(body), 0xf7];
}
export const digitalOutAction = {
  label: 'Digital output frequency',
  title: 'Set the XT\'s Digital Output Frequency (the XT cannot report it back)',
  run: async (api) => {
    const r = await api.form('Digital Output Frequency', [{
      key: 'f', label: 'Digital Output Frequency', type: 'select', value: '0',
      options: DIGITAL_OUT.map((label, i) => ({ value: String(i), label })),
    }], 'Send', 'The XT has no way to report this setting, so the editor cannot show the current one. It also takes the XT out of sampling standby. Keep it with SYSTEM WRITE on the XT.');
    if (!r) return;
    api.send([digitalOutMsg(Number(r.f))]);
    api.toast(`Digital Output Frequency ${DIGITAL_OUT[Number(r.f)]} sent`, 'good', 2000);
  },
};

// ------------------------------------------------------------------ patch files (.p00, USB storage)
// The XT keeps its user patches as V:\Internal.prj\Patch\nnn <name>.p00 (roland-vsynthxt-p00.js).
export const p00Actions = [
  {
    label: 'Open .p00',
    title: 'Load a V-Synth patch file (from the XT\'s drive in USB storage mode) into the editor',
    run: async (api) => {
      const { pickFiles } = await import('../../core/ui/dom.js');
      const [file] = await pickFiles('.p00', false);
      if (!file) return;
      const d = readP00(new Uint8Array(await file.arrayBuffer()), patchBuilt, patchDefaults());
      if (!d) { api.toast('Not a V-Synth patch file (.p00).', 'warn'); return; }
      api.setData(d);
      api.toast('Loaded into the editor. Use Send to V-Synth to hear it.', 'info');
    },
  },
  {
    label: 'Save .p00',
    title: 'Save the patch as a V-Synth patch file, named for a user patch, to copy onto the XT\'s drive',
    run: async (api) => {
      const r = await api.form('Save as a .p00 file', [{ key: 'n', label: 'User patch number (1-512)', type: 'number', value: 1, min: 1, max: 512 }], 'Save',
        'The XT reads its user patches from V:\\Internal.prj\\Patch\\ in USB storage mode, as "nnn Name.p00". Replace the file of the same number there.');
      if (!r) return;
      const n = Math.max(1, Math.min(512, Math.round(r.n) || 1));
      const { downloadBlob } = await import('../../core/ui/dom.js');
      downloadBlob(writeP00(api.data, patchBuilt), p00FileName(n, nameOf(api.data)));
    },
  },
];

// ------------------------------------------------------------------ wave names (model 00 24)
// The XT also answers RQ1 for the undocumented model 00 24 (5-byte addresses, size 5 bytes too):
// address kind << 28 | (n - 1) << 14 | low. Kind 4 (or 5), low 0 is wave n's 16-character name
// (unused numbers answer zeros); kind 6 gives facts about the sample. DT1 to the same addresses
// rename waves (kind 4 is the name the XT shows), change their key-map rows and, kind 1, put wave
// n on OSC 1/2 (also sets OSC Type PCM); checked on the unit, but the editor sends none of them.
// The names come from a table of the waves loaded into wave memory (FUN_89477740: n up to a count;
// FUN_89480e30 enters wave n, 1-500, when FUN_893c5c60 loads it from the drive and raises the count
// to the highest number loaded): numbers after the count answer zeros, so a read stops at the first
// empty one. A WAV copied onto the drive in USB storage mode is not in it until the XT loads it.
// The 224 factory waves read in 38 s (2026-11-25; slower while other requests share the queue).
export const MODEL_FILES = [0x00, 0x24];
export function fileRq1(dev, kind, n, low, size) {
  const body = [...intToAddr(kind * 2 ** 28 + (n - 1) * 16384 + low, 5), ...intToAddr(size, 5)];
  return [0xf0, 0x41, dev & 0x7f, ...MODEL_FILES, 0x11, ...body, checksum(body), 0xf7];
}
/** Wave number -> name, as read from the XT in V-Synth mode (the VC-2 keeps its own map). */
export const WAVE_NAMES = new Map();
/** Read wave names from 1 on until `stopAfter` numbers in a row have none (or `last`); `into`
 *  then holds exactly the names read. Returns [{n, old, name}] for names that changed. */
export async function readWaveNames(api, { last = 999, stopAfter = 2, onProgress, into = WAVE_NAMES } = {}) {
  const before = new Map(into);
  const found = new Map();
  let empty = 0;
  for (let n = 1; n <= last && empty < stopAfter; n++) {
    let name = null;
    try {
      await api.g.client.request(Uint8Array.from(fileRq1(api.ctx.deviceId, 4, n, 0, 16)), {
        collect: (m, r) => {
          const p = parseDt1(r ?? m.raw, MODEL_FILES, 5);
          if (!p?.ok) return false;
          name = String.fromCharCode(...p.data.subarray(0, 16)).replace(/\0/g, '').trim();
          return true;
        },
        complete: () => name !== null, quiet: 300, resolveOnQuiet: true, timeout: 1500,
      });
    } catch { /* no reply */ }
    if (name) { found.set(n, name); empty = 0; } else empty++;
    onProgress?.(n, found.size);
  }
  into.clear();
  for (const [n, name] of found) into.set(n, name);
  const changes = [];
  for (const n of new Set([...before.keys(), ...found.keys()])) if (before.get(n) !== found.get(n)) changes.push({ n, old: before.get(n), name: found.get(n) });
  return changes;
}
/** Wave names remembered from the last read (per device) replace those in `into` (connect task). */
export async function rememberedWaves(api, into, list = 'waves') {
  const { loadList } = await import('../generic/namecache.js');
  const m = loadList(api.ctx.entry.id, api.ctx.deviceId, list);
  if (m.size) { into.clear(); for (const [n, name] of m) into.set(n, name); api.refresh?.(); }
  return m.size;
}
/** Read the wave names, remember them and say what changed. */
export async function readAndRememberWaves(api, into, list = 'waves', opts = {}) {
  const had = into.size;
  try {
    const changes = await readWaveNames(api, { into, ...opts, onProgress: (n, k) => api.g?.setBusy?.(1, `Reading wave names: ${n} (${k} found)`) });
    const { saveList } = await import('../generic/namecache.js');
    saveList(api.ctx.entry.id, api.ctx.deviceId, list, into);
    const ch = had ? changes : [];
    api.toast(`${into.size} wave names read${ch.length ? `; changed since last time: ${ch.slice(0, 6).map((c) => `${c.n} ${c.old ?? '(none)'} → ${c.name ?? '(none)'}`).join('; ')}${ch.length > 6 ? '; ...' : ''}` : ''}`, 'good', ch.length ? 8000 : 2500);
    api.refresh();
  } finally { api.g?.setBusy?.(0); }
}
/** Show the names read from the XT next to the OSC wave numbers of a built patch. */
export function nameWaves(built) {
  for (const p of built.params) {
    if (!/^OSC [12] Wave Number$/.test(p.name) || !p.format) continue;
    const base = p.format;
    p.format = (v) => (WAVE_NAMES.has(v) ? `${base(v)} ${WAVE_NAMES.get(v)}` : base(v));
  }
}
export const waveNamesAction = {
  label: 'Read wave names',
  title: 'Read the names of the waves loaded on the XT (about 40 s for the 224 factory waves); they are remembered for next time',
  run: (api) => readAndRememberWaves(api, WAVE_NAMES),
};

export function writeParts(built, data, dev, base) {
  const msgs = [];
  for (const part of built.parts) msgs.push(...dt1Chunks(MODEL, dev, intToAddr(base + part.at), data.slice(part.offset, part.offset + part.size)));
  return msgs;
}

/** Bases (object address 0) a DT1 at address a can belong to. */
export function patchBases(a) {
  if (a >= A('10 00 00 00') && a < A('11 00 00 00')) return [a - (a % A('00 01 00 00'))];
  if (a >= A('20 00 00 00') && a < A('24 00 00 00')) return [a - (a % A('00 01 00 00'))];
  return [];
}

export function fromSyxInto(built, bases) {
  return (msgs) => {
    const d = defaults(built);
    let hit = false;
    for (const m of msgs) {
      const p = parseDt1(m, MODEL);
      if (!p?.ok) continue;
      const a = addrToInt(p.addr);
      for (const base of bases(a)) {
        for (const part of built.parts) {
          const pa = base + part.at;
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

/** Apply a DT1 the V-Synth sent (Transmit Edit Data) to the edited object. */
export function receiver(built, base) {
  return (raw, data) => {
    const p = parseDt1(raw, MODEL);
    if (!p?.ok) return null;
    const a = addrToInt(p.addr);
    let d = null;
    for (const part of built.parts) {
      for (let i = 0; i < p.data.length; i++) {
        const k = a + i - (base + part.at);
        if (k >= 0 && k < part.size) { d ??= Uint8Array.from(data); d[part.offset + k] = p.data[i]; }
      }
    }
    return d;
  };
}

for (const p of patchBuilt.params) p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(PATCH + p.at), Array.from(data.slice(p.offset, p.offset + (p.nibbles || 1))));
nameWaves(patchBuilt);
for (const p of sysBuilt.params) p.send = (_v, ctx, data) => dt1(MODEL, ctx.deviceId, intToAddr(SYS + p.at), Array.from(data.slice(p.offset, p.offset + (p.nibbles || 1))));
// how the pages present them (roland-vsynthxt-ui.js)
presentSystem(sysBuilt, { dt1Of: (at, bytes, ctx) => dt1(MODEL, ctx.deviceId, intToAddr(SYS + at), bytes), slotNo: (n) => slotNo(n) });
presentOscillators(patchBuilt, WAVE_NAMES);
const PATCH_GROUPS = {};
presentStepModulator(patchBuilt, PATCH_GROUPS);
presentArpeggio(patchBuilt, PATCH_GROUPS);

// ------------------------------------------------------------------ Branch Library
export const slotNo = (n) => `U${String(n + 1).padStart(3, '0')}`;
const libraryItems = libraryItemsFor('V-Synth');
/** Branch Library items of a dump for an engine of this framework (V-Synth, VC-2). */
export function libraryItemsFor(engine) {
  return (msgs) => libraryItemsOf(msgs, engine);
}
function libraryItemsOf(msgs, engine) {
  const items = [];
  const byKey = new Map();
  for (const m of msgs) {
    const p = parseDt1(m, MODEL);
    let key = 'other';
    let label = `Other ${engine} messages`;
    let object = null;
    let base = null;
    if (p?.ok) {
      const a = addrToInt(p.addr);
      if (a < A('10 00 00 00')) { key = 'sys'; label = 'System'; object = 'system'; }
      else if (a < A('11 00 00 00')) { const n = (a - PATCH) >> 14; key = `tp${n}`; label = n ? `Temporary area ${n + 1}` : 'Temporary patch'; object = 'patch'; base = PATCH + n * A('00 01 00 00'); }
      else if (a >= A('20 00 00 00') && a < A('24 00 00 00')) { const n = (a - userPatch(0)) >> 14; key = `up${n}`; label = `User patch ${slotNo(n)}`; object = 'patch'; base = userPatch(n); }
      else { key = `x${(a >> 21).toString(16)}`; label = `Data at ${hex4(a & ~0x1fffff)}`; }
      let item = byKey.get(key);
      if (!item) { item = { key, label, object, name: '', msgs: [] }; byKey.set(key, item); items.push(item); }
      item.msgs.push(m);
      if (base !== null && a === base && p.data.length >= 12) item.name = readText(p.data, 0, 12);
      continue;
    }
    let item = byKey.get(key);
    if (!item) { item = { key, label, object, name: '', msgs: [] }; byKey.set(key, item); items.push(item); }
    item.msgs.push(m);
  }
  return items;
}

const describe = describeFor('V-Synth');
export function describeFor(engine) {
  return (raw) => describeOf(raw, engine);
}
function describeOf(raw, engine) {
  if (raw[1] !== 0x41 || raw[3] !== MODEL[0] || raw[4] !== MODEL[1]) return null;
  const cmd = raw[5];
  const addr = Array.from(raw.slice(6, 10));
  const a = addrToInt(addr);
  const where = a < A('02 00 00 00') ? 'setup' : a < A('10 00 00 00') ? 'system' : a < A('11 00 00 00') ? 'temporary patch' : a < A('24 00 00 00') ? `user patch ${slotNo((a - userPatch(0)) >> 14)}` : '';
  if (cmd === 0x12) return `${engine} DT1 ${hex4(a)} ${where} (${raw.length - 12} bytes)`;
  if (cmd === 0x11) return `${engine} RQ1 ${hex4(a)} ${where} size ${addrToInt(Array.from(raw.slice(10, 14)))}`;
  return null;
}

const BANKS = [0, 1, 2, 3].map((b) => [b, `User ${slotNo(b * 128)}-${slotNo(b * 128 + 127)}`]);
const sysOf = (ctx) => ctx.data?.system;
const patchChannel = (ctx) => {
  const s = sysOf(ctx);
  const p = sysBuilt.params.find((x) => x.name === 'Part 1 Receive Channel');
  return s && p ? readParam(s, p) : ctx.channel ?? 0;
};

const TR = vsTranslator({ built: patchBuilt, defaults: patchDefaults, fxSlot, FX, FX_BLOCKS, nameOf });

// The V-Synth's 16 patch categories (firmware names) and the nearest Head Library categories.
export const CATEGORY_IDS = ['none', 'other-synth', 'hard-lead', 'soft-pad', 'vox', 'keyboards', 'bass', 'wind', 'bell', 'pulsating', 'beat-groove', 'pulsating', 'synth-fx', 'ethnic', 'drums', 'combination'];
export const FROM_CATEGORY = {
  'ac-piano': 5, 'el-piano': 5, keyboards: 5, organ: 5, accordion: 5, harmonica: 7, bell: 8, mallet: 8, 'hit-stab': 8,
  'ac-guitar': 6, 'el-guitar': 6, 'dist-guitar': 6, bass: 6, 'synth-bass': 6, fretted: 6, plucked: 6,
  strings: 3, orchestra: 3, 'bright-pad': 3, 'soft-pad': 3, wind: 7, flute: 7, 'ac-brass': 7, 'synth-brass': 1, sax: 7,
  'hard-lead': 2, 'soft-lead': 2, 'techno-synth': 1, 'other-synth': 1, pulsating: 9, 'synth-fx': 12, 'sound-fx': 12,
  vox: 4, ethnic: 13, percussion: 14, drums: 14, 'beat-groove': 10, combination: 15,
};
const categoryParam = patchBuilt.params.find((p) => p.name === 'Patch Category');
categoryParam.options = CATEGORIES.map((c, i) => [i, c]);
delete categoryParam.format;

const ZONE_SECTIONS = Array.from({ length: ZONES }, (_, z) => ({ key: `z${z}`, label: `Zone ${z + 1}` }));

export default {
  coverage: 'Edits the V-Synth engine\'s patches and system settings. Every parameter (common, MFX, chorus, reverb, beam / pad / arpeggio, step sequencer, 16 zones with tone, 13 envelopes, 5 LFOs and two COSM blocks, and the arpeggio pattern of 32 steps by 16 lines, as a step grid or tracker) with the XT\'s own names, ranges, defaults and value displays, and effect parameters named for each effect type. The 512 user patches; .p00 patch files from the XT\'s drive (USB storage) open, save and import; Digital Output Frequency can be set but not read. The VC-1 and VC-2 engines are separate devices (V-Synth XT VC-1, V-Synth XT VC-2).',
  sysex: { manufacturer: [0x41], model: MODEL, deviceIdDefault: 0x10 },
  minGap: 20,
  // wave names remembered from the last Read wave names (reading them again takes about 40 s)
  connectTasks: [{ label: 'Remembered wave names', run: (api) => rememberedWaves(api, WAVE_NAMES) }],
  describe,
  recognise: (raw) => !!parseDt1(raw, MODEL)?.ok,
  isOwn: (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === MODEL[0] && raw[4] === MODEL[1],
  isRequest: (raw) => raw?.[1] === 0x41 && raw[3] === MODEL[0] && raw[4] === MODEL[1] && raw[5] === 0x11,
  libraryItems,
  // V-Synth patch files (.p00) from the XT's drive: one patch each (also inside a drive image)
  readFile: (name, bytes) => {
    if (!isP00(bytes)) return null;
    return [{ object: 'patch', data: readP00(bytes, patchBuilt, patchDefaults()), label: String(name).split(/[\\/]/).pop().replace(/\.p00$/i, '') }];
  },
  // One RQ1 per range: the XT answers every block inside it. A bank of 128 patches is about 1.3 MB
  // (7 minutes at MIDI speed); all 512 take about half an hour.
  fullDump: ['System', 'Temporary patch', 'User patches U001-U128', 'User patches U129-U256', 'User patches U257-U384', 'User patches U385-U512'],
  requests: [
    { label: 'System', bytes: (ctx) => sysBuilt.parts.map((p) => rq1Msg(ctx.deviceId, SYS + p.at, p.size)) },
    { label: 'Temporary patch', bytes: (ctx) => rq1Msg(ctx.deviceId, PATCH, A('00 01 00 00')), quiet: 2500 },
    ...[0, 1, 2, 3].map((b) => ({ label: `User patches ${slotNo(b * 128)}-${slotNo(b * 128 + 127)}`, bytes: (ctx) => rq1Msg(ctx.deviceId, userPatch(b * 128), A('01 00 00 00')), quiet: 3000, timeout: 8000 })),
    ...[0, 1, 2, 3].map((b) => ({ label: `User patch names ${slotNo(b * 128)}-${slotNo(b * 128 + 127)}`, bytes: (ctx) => Array.from({ length: 128 }, (_, i) => rq1Msg(ctx.deviceId, userPatch(b * 128 + i), 12)) })),
  ],
  objects: [
    {
      key: 'system', page: 'System', icon: '⚙', label: 'System', size: sysBuilt.size, autoLoad: true,
      init: () => defaults(sysBuilt),
      fetch: (api) => fetchParts(api, sysBuilt, SYS),
      params: sysBuilt.params,
      receive: receiver(sysBuilt, SYS),
      sections: [{ key: 'setup', label: 'Setup' }, { key: 'system', label: 'System' }, { key: 'controllers', label: 'Controllers' }, { key: 'usersets', label: 'User sets and knob CCs' }], cols: 3,
      note: 'Power Up Mode, Transmit Edit Data, Receive Exclusive, Device ID, the USB and V-LINK settings and the local switches cannot be set over MIDI: set them on the XT. Digital Output Frequency can be set with its button but not read.',
      actions: [digitalOutAction],
      sendAll: { label: 'Send to V-Synth', build: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId, SYS) },
      toSyx: (data, ctx) => writeParts(sysBuilt, data, ctx.deviceId, SYS).flat(),
      fromSyx: fromSyxInto(sysBuilt, (a) => (a < A('10 00 00 00') ? [0] : [])),
    },
    {
      key: 'patch', page: 'Patch', icon: '◆', label: 'Patch', size: patchBuilt.size, autoLoad: true,
      init: patchDefaults,
      fetch: (api) => readPatch(api, PATCH, (n, t) => api.g?.setBusy?.(1, `Reading the patch ${n}/${t}`)),
      params: patchBuilt.params,
      receive: receiver(patchBuilt, PATCH),
      sections: [{ key: 'common', label: 'Common' }, { key: 'fx', label: 'Effects' }, { key: 'arp', label: 'Beam, pad, arpeggio' }, { key: 'seq', label: 'Step sequencer' }, ...ZONE_SECTIONS, { key: 'steps', label: 'Arpeggio pattern' }],
      cols: 3,
      groupInfo: PATCH_GROUPS,
      name: nameOf,
      category: (d) => CATEGORY_IDS[readParam(d, categoryParam)] || 'none',
      setCategory: (d, id) => { if (FROM_CATEGORY[id] !== undefined) d[categoryParam.offset] = FROM_CATEGORY[id]; },
      setName: (d, name) => { for (let i = 0; i < 12; i++) d[i] = Math.max(32, Math.min(125, String(name ?? '').charCodeAt(i) || 32)); },
      toCommon: (d) => TR.patchToCommon(d),
      fromCommon: (c, base) => TR.patchFromCommon(c, base),
      actions: [waveNamesAction, ...p00Actions],
      note: `Edits the patch being played (the temporary patch); changes are heard at once. Store writes it into a user patch. Reading a whole patch takes ${patchBuilt.parts.length} requests, a few seconds.`,
      sendAll: { label: 'Send to V-Synth', title: 'Send the whole patch to the XT\'s temporary patch, to hear it', build: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId, PATCH) },
      toSyx: (data, ctx) => writeParts(patchBuilt, data, ctx.deviceId, PATCH).flat(),
      fromSyx: fromSyxInto(patchBuilt, patchBases),
      slots: {
        label: 'Patches',
        banks: BANKS,
        count: 128,
        slotLabel: (bank, i) => slotNo(bank * 128 + i),
        name: nameOf,
        recall: (bank, i, ctx) => select(patchChannel(ctx), 87, bank, i),
        fetch: (api, bank, i) => readPatch(api, userPatch(bank * 128 + i), (n, t) => api.g?.setBusy?.(1, `Reading ${slotNo(bank * 128 + i)} ${n}/${t}`)),
        fetchName: async (api, bank, i) => nameOf(await readBlock(api.g.client, MODEL, api.ctx.deviceId, intToAddr(userPatch(bank * 128 + i)), 12)),
        store: (bank, i, ctx, data) => writeParts(patchBuilt, data, ctx.deviceId, userPatch(bank * 128 + i)),
        writable: () => true,
        autoNames: [0, 1, 2, 3], // all 512 names when the XT connects (12 bytes each)
        note: (bank, ctx) => `Play selects the patch on channel ${patchChannel(ctx) + 1} (the Part 1 receive channel). Edit reads the user patch; Store writes the editor\'s patch into it.`,
      },
    },
  ],
};

export function select(ch, msb, lsb, pc) {
  return [[0xb0 | ch, 0, msb], [0xb0 | ch, 32, lsb], [0xc0 | ch, pc]];
}

export const _test = { patchBuilt, sysBuilt, libraryItems, display, fxSlot, patchBases, PATCH, defaults, TR };
