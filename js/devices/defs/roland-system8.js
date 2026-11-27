// Roland SYSTEM-8 (OS 1.32): editor for the SYSTEM-8's own sound engine (slot 0). See
// docs/devices/roland-system8.md (protocol, address map, PLUG-OUT format) and
// docs/devices/roland-system8-handoff.md (work state, next phases).
//
// Ports: "SYSTEM-8 CTRL" carries every message below (Roland SysEx, model 00 00 7E; RQ1 11h / DT1 12h,
// device ID 10h = Device ID 17). "SYSTEM-8" is the normal MIDI port (notes, CC, program change) and
// answers no SysEx; nor is Identity Request answered on any port. Choose SYSTEM-8 CTRL as both input
// and output.
//
// Memory (7-bit packed addresses): 03 00 00 00 temporary patch (patch mode); 20+b i 00 00 user patch
// b*8+i of the SYSTEM-8 (slot 0), 640 bytes each: the 64 panel values (2 nibbles each), the name
// (16 characters, 2 nibbles each) and 48 values of 8 nibbles (arpeggio, scatter, patch cords,
// variations...). The layout is the one Roland's SYSTEM-8 plugin uses (its Script.xml, `fm.usrX`);
// value texts are the unit's own display lists from region 0 of its SYSTEM-8 1.20 image, or the
// plugin's string tables where region 0 has none (generated into roland-system8-fw.js).
//
// Not done yet (phase 2-4, see the handoff file): patch2 (effect details, chord memory), patch3 (step
// sequencer), performances (10-17), system (01 50), PLUG-OUT slots and their engines, PLUG-OUT install.

import { readParam } from '../../core/model/memmap.js';
import { PATCH as ROWS, LISTS, TABLES } from './roland-system8-fw.js';
import * as TR from './roland-system8-translate.js';

export const MODEL = [0x00, 0x00, 0x7e];
export const DEV = 0x10;
export const PATCH_SIZE = 640;
export const A = (b0, b1 = 0, b2 = 0, b3 = 0) => (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
export const a28 = (a) => [(a >>> 21) & 0x7f, (a >>> 14) & 0x7f, (a >>> 7) & 0x7f, a & 0x7f];
const checksum = (body) => (128 - (body.reduce((s, b) => s + b, 0) & 0x7f)) & 0x7f;
const dev = (ctx) => (ctx?.deviceId ?? DEV) & 0x7f;

export function dt1(addr, data, id = DEV) {
  const body = [...a28(addr), ...data];
  return [0xf0, 0x41, id, ...MODEL, 0x12, ...body, checksum(body), 0xf7];
}
export function rq1(addr, size, id = DEV) {
  const body = [...a28(addr), ...a28(size)];
  return [0xf0, 0x41, id, ...MODEL, 0x11, ...body, checksum(body), 0xf7];
}
export const isS8 = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === 0x00 && raw[4] === 0x00 && raw[5] === 0x7e;
/** {cmd, addr, data, ok} of a SYSTEM-8 DT1/RQ1, or null. */
export function parse(raw) {
  if (!isS8(raw) || raw.length < 13) return null;
  const body = Array.from(raw.slice(7, raw.length - 2));
  const addr = (body[0] << 21) | (body[1] << 14) | (body[2] << 7) | body[3];
  return { cmd: raw[6], addr, data: body.slice(4), ok: checksum(body) === raw[raw.length - 2] };
}

/** Temporary patch areas (patch mode; the two performance parts still to be confirmed live). */
export const TEMP = { patch: A(0x03), upper: A(0x03, 0x20), lower: A(0x03, 0x30) };
const PATCH_BASE = { 0: A(0x20), 1: A(0x40), 2: A(0x0e), 3: A(0x0f) };
/** Address of the `patch` struct of user patch p (0-63) in slot 0-3 (SYSTEM-8, PLUG-OUT 1-3). */
export function slotPatchAddr(slot, p) {
  const b = p >> 3; const i = p & 7;
  return slot < 2 ? PATCH_BASE[slot] + (b << 21) + (i << 14) : PATCH_BASE[slot] + (((b << 4) + i) << 14);
}
/** The leaves the unit answers with (start, length): ten panel blocks, then 240-byte chunks. */
export const LEAVES = [[0x00, 14], [0x0e, 10], [0x18, 16], [0x28, 12], [0x34, 6], [0x3a, 20], [0x4e, 10], [0x58, 8], [0x60, 12], [0x6c, 20], [0x80, 240], [0x170, 240], [0x260, 32]];

// ------------------------------------------------------------------ parameters
const NAME_AT = 0x80;
const ONOFF = [[0, 'OFF'], [1, 'ON']];
const list = (n) => LISTS[n] || [];
const opts = (texts, min = 0) => texts.map((t, i) => [i + min, t]);
const signed = (bias) => (v) => (v - bias > 0 ? `+${v - bias}` : String(v - bias));
const off255 = (v) => (v ? String(v) : 'OFF');
const fromTable = (name, offset = 0) => (v) => TABLES[name]?.[v + offset] ?? String(v);
const slice6 = (n, variation) => opts(list(n).slice(variation * 6, variation * 6 + 6));

const GROUPS = [
  [/^LFO (CV|RING|PITCH|FILTER|AMP) IN$|^OSC1 X-MOD IN$|^OSC2 (SYNC|RING) IN$|^OSC3 EXT IN$|^(P|F|A) ENV GATE IN$|^(PITCH|FILTER|AMP) ENV IN$|^LFO CV GAIN$/, 'Routing'],
  [/^LFO/, 'LFO'], [/^OSC1/, 'OSC1'], [/^OSC2/, 'OSC2'], [/^OSC3/, 'OSC3'], [/^MIXER/, 'Mixer'], [/^PITCH/, 'Pitch'],
  [/^FILTER|^F ENV/, 'Filter'], [/^AMP|^A ENV/, 'Amp'], [/^EFFECT|^REVERB|^DELAY/, 'Effects'],
  [/^ARP|^SCATTER|^OCTAVE|^KEY HOLD|^INPUT/, 'Arpeggio / keyboard'], [/^BEND|^MOD SENS/, 'Bend / mod'],
  [/./, 'Control'],
];
const groupOf = (name) => GROUPS.find(([re]) => re.test(name))[1];
const keyOf = (name) => name.replace(/[()]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Display rules by Roland's value name (region 0 list numbers: 1 LFO waves, 2 OSC waves, 3 ranges,
// 4 OSC MOD sources, 5 OSC3 waves, 7 filter variations, 8 filter types, 9 patch-cord sources).
const EXTRA = {
  'LFO WAVE': { dynamic: (d) => ({ options: slice6(1, Math.min(2, varOf(d, 'lfo_variation'))) }) },
  'OSC1 WAVE': { dynamic: (d) => ({ options: slice6(2, Math.min(3, varOf(d, 'osc1_variation'))) }) },
  'OSC2 WAVE': { dynamic: (d) => ({ options: slice6(2, Math.min(3, varOf(d, 'osc2_variation'))) }) },
  'OSC1 MOD': { options: opts(list(4)) }, 'OSC2 MOD': { options: opts(list(4)) },
  'OSC1 RANGE': { options: opts(list(3)) }, 'OSC2 RANGE': { options: opts(list(3)) },
  'OSC3 WAVE': { options: opts(list(5)) },
  'FILTER VARIATION': { options: opts(list(7)) },
  'FILTER TYPE': { dynamic: (d) => ({ options: slice6(8, Math.min(7, varOf(d, 'filter_variation'))) }) },
  'EFFECT TYPE': { options: opts(TABLES.effectTypeL) }, 'DELAY TYPE': { options: opts(TABLES.delayTypeL) },
  'REVERB TYPE': { options: opts(TABLES.reverbTypeL) },
  'ARP TYPE': { options: opts(TABLES.arpType) }, 'ARP STEP': { options: opts(TABLES.arpStep) },
  'PORTA TYPE': { options: opts(TABLES.portamentoType) },
  'OSC1 COARSE TUNE': { format: signed(11) }, 'OSC2 COARSE TUNE': { format: signed(11) },
  'OSC1 FINE TUNE': { format: signed(128) }, 'OSC2 FINE TUNE': { format: signed(128) },
  'OSC3 TUNE': { format: fromTable('oscTune'), unit: ' cent' },
  'BEND RANGE': { format: (v) => String(v + 1) },
  'EFFECT DEPTH': { format: off255 }, 'DELAY LEVEL': { format: off255 }, 'REVERB LEVEL': { format: off255 }, PORTAMENTO: { format: off255 },
  'DELAY TIME': { dynamic: (d) => (varOf(d, 'tempo_sync') ? { format: fromTable('efxDelayTime') } : {}) },
  'LFO RATE': { dynamic: (d) => (varOf(d, 'tempo_sync') ? { format: fromTable('modulatorRate') } : {}) },
  'MONO SW': { input: 'number', help: 'MONO button: 0-2 (POLY, MONO, UNISON in some order: to be checked on the unit)' },
  'INPUT JACK USING': { input: 'number', help: 'Raw 16-bit value (the plugin hides it)' },
};
for (const n of ['LFO PITCH DEPTH', 'LFO FILTER DEPTH', 'LFO AMP DEPTH', 'PITCH ENV', 'FILTER ENV', 'FILTER KEY FOLLOW', 'AMP TONE', 'CONDITION']) EXTRA[n] = { format: signed(128) };
for (const n of ['LFO CV IN', 'LFO RING IN', 'LFO PITCH IN', 'LFO FILTER IN', 'LFO AMP IN', 'OSC1 X-MOD IN', 'OSC2 SYNC IN', 'OSC2 RING IN', 'OSC3 EXT IN', 'P ENV GATE IN', 'PITCH ENV IN', 'F ENV GATE IN', 'FILTER ENV IN', 'A ENV GATE IN', 'AMP ENV IN']) EXTRA[n] = { options: opts(list(9)) };

function rowParam([name, leaf, offset, bytes, bits, min, max]) {
  const hidden = /^\(/.test(name) && min === max;
  const p = {
    key: (/^\(/.test(name) ? 'x_' : '') + keyOf(name), label: name.replace(/[()]/g, ''), group: groupOf(name.replace(/[()]/g, '')), offset,
    ...(bits === 4 ? { nibbles: bytes } : { size: 1 }),
    min, max, ...(min < 0 ? { signed: true } : {}),
    ...(max === 1 && min === 0 ? { options: ONOFF } : {}),
    ...(hidden ? { hidden: true } : {}),
    leaf,
  };
  if (/^\(/.test(name) && !hidden) p.help = 'The SYSTEM-8 plugin keeps this value out of its panel (name in parentheses in its Script.xml).';
  return { ...p, ...(EXTRA[name] || {}) };
}

export const PARAMS = [
  ...ROWS.filter((r) => r[1] !== 'NAME0').map(rowParam),
  ...Array.from({ length: 16 }, (_, i) => ({ key: `name${i}`, group: 'Name', label: `Name ${i + 1}`, offset: NAME_AT + 2 * i, nibbles: 2, min: 32, max: 126, kind: 'char', hidden: true })),
];
const byKey = new Map(PARAMS.map((p) => [p.key, p]));
TR.setParams(PARAMS);
function varOf(d, key) { const p = byKey.get(key); return p ? readParam(d, p) : 0; }

export function nameOf(d) {
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(((d[NAME_AT + 2 * i] & 15) << 4) | (d[NAME_AT + 2 * i + 1] & 15));
  return s.replace(/[^\x20-\x7e]/g, ' ').trimEnd();
}
export function setName(d, name) {
  const s = String(name).padEnd(16).slice(0, 16);
  for (let i = 0; i < 16; i++) {
    const c = s.charCodeAt(i) >= 32 && s.charCodeAt(i) < 127 ? s.charCodeAt(i) : 32;
    d[NAME_AT + 2 * i] = c >> 4; d[NAME_AT + 2 * i + 1] = c & 15;
  }
}

/** The default patch of Roland's script (every value at its default, name INIT PATCH). */
export function initPatch() {
  const d = new Uint8Array(PATCH_SIZE);
  for (const [, , offset, bytes, bits, , , def] of ROWS) {
    if (typeof def !== 'number') continue;
    let v = def >>> 0;
    for (let i = bytes - 1; i >= 0; i--) { d[offset + i] = bits === 4 ? v & 15 : v & 0x7f; v = bits === 4 ? v >>> 4 : v >>> 7; }
  }
  setName(d, 'INIT PATCH');
  return d;
}

// ------------------------------------------------------------------ reads and writes
/** DT1 messages that write a whole patch struct at `base`, split as the unit answers (LEAVES). */
export const patchMessages = (base, d, id = DEV) => LEAVES.map(([o, n]) => dt1(base + o, Array.from(d.slice(o, o + n)), id));

/** Read the 640-byte patch struct at `base` (RQ1, then the DT1 leaves until every byte is in). */
export async function readPatch(client, base, id = DEV, timeout = 2500) {
  const d = new Uint8Array(PATCH_SIZE);
  const have = new Uint8Array(PATCH_SIZE);
  const full = () => have.every(Boolean);
  await client.request(Uint8Array.from(rq1(base, PATCH_SIZE, id)), {
    collect: (_m, raw) => {
      const p = parse(raw);
      if (!p?.ok || p.cmd !== 0x12) return false;
      const off = p.addr - base;
      if (off < 0 || off >= PATCH_SIZE) return false;
      p.data.forEach((b, i) => { if (off + i < PATCH_SIZE) { d[off + i] = b; have[off + i] = 1; } });
      return true;
    },
    complete: full, quiet: 400, resolveOnQuiet: true, timeout,
  });
  if (!full()) throw new Error(`SYSTEM-8: patch at ${a28(base).map((b) => b.toString(16).padStart(2, '0')).join(' ')} came back incomplete`);
  return d;
}

const sendParam = (p, _v, data, ctx) => dt1(TEMP.patch + p.offset, Array.from(data.slice(p.offset, p.offset + (p.nibbles || p.size || 1))), dev(ctx));
const slotLabel = (_bank, i) => `${'ABCDEFGH'[i >> 3]}-${(i & 7) + 1}`;
const channel = (ctx) => (ctx?.channel ?? 0) & 15;

// ------------------------------------------------------------------ simulator (demo mode, tests)
function simulate() {
  const mem = new Map(); // packed address -> byte
  const put = (addr, bytes) => bytes.forEach((b, i) => mem.set(addr + i, b));
  const demo = initPatch();
  put(TEMP.patch, demo);
  for (let p = 0; p < 64; p++) { const d = initPatch(); setName(d, `SYSTEM-8 ${slotLabel(0, p)}`); put(slotPatchAddr(0, p), d); }
  const slotInfo = (i) => {
    const name = ['SYSTEM-8', 'JUPITER-8', 'SH-101', 'JUNO-106'][i];
    const nib = (v, n) => Array.from({ length: n }, (_, k) => (v >> (4 * (n - 1 - k))) & 15);
    return [...nib(0x0132, 4), ...nib(0x136e, 4), ...nib([5, 6, 1, 7][i], 4), ...nib([0x120, 0x106, 0x107, 0x107][i], 4),
      ...[...name.padEnd(16, '\0')].flatMap((c) => nib(c.charCodeAt(0), 2))];
  };
  return {
    state: { mem },
    handle(d) {
      const p = parse(d);
      if (!p) return null;
      if (p.cmd === 0x11) {
        const size = (p.data[0] << 21) | (p.data[1] << 14) | (p.data[2] << 7) | p.data[3];
        const out = [];
        // answer per known leaf when the area is a patch struct, else as one block
        const base = p.addr;
        const leaves = mem.has(base) ? LEAVES.filter(([o]) => o < size).map(([o, n]) => [base + o, Math.min(n, size - o)]) : [];
        for (const [a, n] of leaves) {
          if (!mem.has(a)) continue;
          out.push(dt1(a, Array.from({ length: n }, (_, k) => mem.get(a + k) ?? 0)));
        }
        return out;
      }
      if (p.cmd === 0x12) {
        if ((p.addr >>> 21) === 0x70) {
          const a = a28(p.addr);
          const reply = (data) => [dt1(p.addr + (1 << 21), data)];
          if (a[1] === 0 && a[2] === 2) return reply([[2, 8, 8, 4][a[3]] ?? 0]);
          if (a[1] === 0 && a[2] === 1) return reply(slotInfo(p.data[0] & 3));
          return [];
        }
        put(p.addr, p.data);
        return [];
      }
      return [];
    },
  };
}

// ------------------------------------------------------------------ definition
const LAYOUT = ['LFO', 'OSC1', 'OSC2', 'OSC3', 'Mixer', 'Pitch', 'Filter', 'Amp', 'Effects', 'Control', 'Bend / mod', 'Arpeggio / keyboard', 'Routing'].map((group) => ({ group }));

export default {
  coverage: 'The SYSTEM-8 engine\'s patch values (the 640-byte patch struct of slot 0: 64 panel values, the name and 48 extended values) with Roland\'s names and ranges from the SYSTEM-8 plugin script and the value lists of the unit\'s region-0 display tables; temporary patch read and live edits, user patch memory A-1..H-8 over SYSTEM-8 CTRL. Phase 1 of the SYSTEM-8 job: effects details, chord memory, step sequencer, performances, system and the PLUG-OUT slots follow.',
  sysex: { manufacturer: [0x41], model: MODEL },
  minGap: 5,
  recognise: (raw) => { const p = parse(raw); return !!p && p.cmd === 0x12 && ((p.addr >>> 21) === 0x03 || ((p.addr >>> 21) >= 0x20 && (p.addr >>> 21) <= 0x27)); },
  isOwn: isS8,
  isRequest: (raw) => parse(raw)?.cmd === 0x11,
  simulate,
  objects: [
    {
      key: 'patch', page: 'Patch', icon: '♪', label: 'Patch', size: PATCH_SIZE, autoLoad: true,
      init: initPatch,
      fetch: (api) => readPatch(api.g.client, TEMP.patch, dev(api.ctx)),
      params: PARAMS,
      sendParam,
      name: nameOf,
      setName,
      layout: LAYOUT,
      cols: 4,
      note: 'Every change is sent at once to the temporary patch (03 00 00 00) over SYSTEM-8 CTRL. WRITE on the unit (or Store here) keeps it.',
      sendAll: { label: 'Send to temporary patch', title: 'Write the whole patch into the temporary patch (03 00 00 00)', build: (data, ctx) => patchMessages(TEMP.patch, data, dev(ctx)) },
      toSyx: (data, ctx) => patchMessages(TEMP.patch, data, dev(ctx)),
      fromSyx: (msgs) => {
        const d = initPatch();
        let any = false;
        for (const m of msgs) {
          const p = parse(m);
          if (!p?.ok || p.cmd !== 0x12) continue;
          const off = p.addr & 0x3fff; // the offset inside any patch struct (each starts on a 1 << 14 boundary)
          if (off + p.data.length > PATCH_SIZE) continue;
          d.set(p.data, off); any = true;
        }
        return any ? d : null;
      },
      toCommon: (d) => TR.toCommon(d),
      fromCommon: (c, base) => TR.fromCommon(c, base),
      slots: {
        label: 'SYSTEM-8 patches', banks: [[0, 'SYSTEM-8']], count: 64, slotLabel,
        namesOnOpen: true,
        name: nameOf,
        writable: () => true,
        fetch: (api, _bank, i) => readPatch(api.g.client, slotPatchAddr(0, i), dev(api.ctx)),
        // Bank select MSB 85 / LSB 0 (SYSTEM-8) and program change, on the patch channel (MIDI chart *2).
        recall: (_bank, i, ctx) => [[0xb0 | channel(ctx), 0, 85], [0xb0 | channel(ctx), 32, 0], [0xc0 | channel(ctx), i]],
        store: (_bank, i, ctx, data) => patchMessages(slotPatchAddr(0, i), data, dev(ctx)),
        note: () => 'Store writes the patch straight into user memory (the way Roland\'s plugin writes its patch banks). Play sends bank select 85/0 and a program change: they are channel messages, which the unit takes on its SYSTEM-8 port (choose an output that reaches it).',
      },
    },
  ],
};

export const _test = { simulate, LEAVES, PARAMS, initPatch };
