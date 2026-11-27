// The 94-byte DX1 / DX5 performance ("function data", bulk format 1), which the TX7 and the TX816's
// TF1 modules also send and take. Names, maxima and value texts from the DX5 v6 firmware (6809,
// 32 KB at 8000h; listing re/dx/dx5_v6.lst made by tools/yamaha/m6809_dis.py): the edit-parameter
// records at 8234 (label texts), table 866D (byte number and maximum of each function parameter),
// the value display table B8A7 (Poly/Mono BAC9, Off/On BAFB, Port/Glis BB01, Retain / Follow /
// Finger / FulTim BB20, EAP bits BB4C, signed key shift BB38, split note E0E2) and the format 1
// sender F0F5 (the DX5 sends its performance buffer 73A2h as it is). See docs/devices/yamaha-dx5.md.
//
//   0-29   channel A: voice, source, poly/mono, pitch bend, portamento, controllers, attenuation...
//   30-59  channel B: the same
//   60-63  key assign mode, single-mode channel, dual detune, split point
//   64-93  performance name (30 characters)
// Bytes 17-25 of each half are read by none of the DX5, TX7 and TF1 firmwares (they send 0, and 99
// for 24-25); they are the DX1's (no DX1 firmware in the collection).

import { bulk, parseBulk, dumpRequest } from './yamaha-dx-sysex.js';

export const FN_SIZE = 94;
const opts = (l) => l.map((t, i) => [i, t]);
const OFFON = ['Off', 'On'];
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`; // C3 = 60
/** The voice byte: bits 5-0 voice 1-64, bit 6 cartridge (FA9F). */
export const DX5_VOICES = Array.from({ length: 128 }, (_, n) => [n, `${n & 64 ? 'EXT' : 'INT'} ${String((n & 63) + 1).padStart(2, '0')}`]);
export const FIXED = { 1: 0, 8: 1, 24: 99, 25: 99, 27: 0, 28: 1, 29: 24, 61: 0, 63: 39 }; // what the TX7 and TF1 send

/** One half's parameters: {o (byte in the half), label, max, extra}. EAP bytes become three bit fields. */
export const HALF = [
  { o: 0, label: 'Voice', max: 127, extra: { options: DX5_VOICES, help: 'INT 01-64 internal, EXT 01-64 the cartridge.' } },
  { o: 1, label: 'Source', max: 16, extra: { options: [[0, '0 (keyboard)'], ...Array.from({ length: 16 }, (_, c) => [c + 1, `${c + 1} (MIDI)`])], help: 'Source select: 0 the DX5\'s own keyboard, 1-16 the MIDI channel that plays the channel.' } },
  { o: 2, label: 'Ply/Mon', max: 1, extra: { options: opts(['Poly', 'Mono']), relayout: true } },
  { o: 3, label: 'PB rng', max: 12, extra: { help: 'Pitch bend range (semitones); with a step set the DX5 shows 12.' } },
  { o: 4, label: 'PB stp', max: 12, extra: { help: 'Pitch bend step: 0 smooth, 1-12 semitone steps.' } },
  { o: 5, label: 'P time', max: 99, extra: { help: 'Portamento time.' } },
  { o: 6, label: 'PG sw', max: 1, extra: { options: opts(['Port', 'Glis']), help: 'Portamento or glissando.' } },
  { o: 7, label: 'P mode', max: 1, extra: { help: 'Portamento mode: Retain / Follow (poly), Finger / FulTim (mono).' }, mode: true },
  { o: 8, label: 'Por P&K', max: 1, extra: { options: opts(OFFON) } },
  { o: 9, label: 'Mod', max: 15, extra: { help: 'Modulation wheel range.' } },
  { o: 10, label: 'Mod EAP', max: 7, eap: true },
  { o: 11, label: 'Ft.', max: 15, extra: { help: 'Foot controller range.' } },
  { o: 12, label: 'Ft. EAP', max: 7, eap: true },
  { o: 13, label: 'Aft', max: 15, extra: { help: 'After touch range.' } },
  { o: 14, label: 'Aft EAP', max: 7, eap: true },
  { o: 15, label: 'Br.', max: 15, extra: { help: 'Breath controller range.' } },
  { o: 16, label: 'Br. EAP', max: 7, eap: true },
  ...Array.from({ length: 9 }, (_, i) => ({ o: 17 + i, label: `DX1 byte ${17 + i}`, max: 127, dx1: true })),
  { o: 26, label: 'Att', max: 7, extra: { help: 'Attenuation 0-7.' } },
  { o: 27, label: 'P out', max: 1, extra: { options: opts(OFFON), help: 'Whether this channel goes to the DX5\'s output P.' } },
  { o: 28, label: 'Sus pdl', max: 1, extra: { options: opts(OFFON), help: 'The sustain pedal acts on this channel.' } },
  { o: 29, label: 'Key sft', max: 48, extra: { format: (v) => `${v > 24 ? '+' : ''}${v - 24}`, help: 'Key shift -24 to +24 semitones.' } },
];
export const COMMON = [
  { o: 60, label: 'Key assign', max: 2, extra: { options: opts(['SNGL', 'DUAL', 'SPLT']), help: 'Single, dual or split (the status line\'s SNGL / DUAL / SPLT).' } },
  { o: 61, label: 'Single channel', max: 1, extra: { options: opts(['A', 'B']), help: 'The channel that plays (and is edited) in single mode.' } },
  { o: 62, label: 'Detune', max: 15, extra: { help: 'Dual detune between A and B.' } },
  { o: 63, label: 'Split', max: 96, extra: { options: Array.from({ length: 97 }, (_, v) => [v, noteName(v + 21)]), help: 'Split point: the DX5 shows the value + 21 as a note (C3 = 60).' } },
];
const EAP = ['P', 'A', 'E']; // bit 0 pitch, 1 amplitude, 2 EG bias (shown "EAP", bit 2 first)

/**
 * Parameters for the 94 bytes. M: {halves: ['A'] or ['A', 'B'], reads(byte) -> bool (else read-only),
 * readOnlyHelp(byte) -> text, labels: {byte: label}, extra(byte) -> extra fields, group(byte) -> card}.
 */
export function fn94Params(M = {}) {
  const ps = [];
  const reads = M.reads || (() => true);
  const add = (offset, label, max, extra, group) => {
    const ro = !reads(offset);
    ps.push({
      key: `p${offset}${extra?.keySuffix || ''}`, label: M.labels?.[offset] ?? label, offset, min: 0, max, group, ...extra, ...(M.extra?.(offset) || {}),
      ...(ro ? { readOnly: true, help: (!extra?.dx1 && M.readOnlyHelp?.(offset)) || extra?.help } : {}),
    });
  };
  ['A', 'B'].forEach((h, k) => {
    for (const f of HALF) {
      const off = k * 30 + f.o;
      const inUse = (M.halves || ['A', 'B']).includes(h);
      const group = M.group?.(off) || (f.dx1 ? 'DX1 bytes' : `Channel ${h}`);
      if (!inUse && !M.keepHalves) continue;
      if (f.eap) {
        EAP.forEach((t, b) => add(off, `${f.label} ${t}`, 1, { shift: b, bits: 1, options: opts(OFFON), keySuffix: `_${b}`, help: `${f.label.split(' ')[0]} to ${['pitch', 'amplitude', 'EG bias'][b]} (the ${'PAE'[b]} of the "EAP" display).` }, group));
      } else if (f.mode) {
        add(off, f.label, f.max, { ...f.extra, dynamic: (d) => ({ options: opts(d[k * 30 + 2] ? ['Finger', 'FulTim'] : ['Retain', 'Follow']) }) }, group);
      } else if (f.dx1) {
        add(off, f.label, f.max, { dx1: true, help: `Used only by the DX1; the DX5, TX7 and TX816 do not use it (they send ${FIXED[f.o] ?? 0}).` }, group);
      } else add(off, f.label, f.max, f.extra || {}, group);
    }
  });
  for (const f of COMMON) add(f.o, f.label, f.max, f.extra, M.group?.(f.o) || 'Key assign');
  for (let i = 0; i < 30; i++) add(64 + i, `P name ${i + 1}`, 127, { hidden: true }, 'Name');
  return ps;
}

// ------------------------------------------------------------------ performance memories (format 2)
// 64 memories of 64 bytes (4096). The DX5 keeps them so at 6000h, packs its 94-byte buffer with CB27 and
// unpacks with F999; the TX7 sends its 32 function memories in the same form, twice (E32A / E396).
//  0 / 16   voice bits 4-0 | (half B) 20h | Ply/Mon 40h        1 / 17  PB stp << 4 | PB rng
//  2 / 18   P time                                              3 / 19  Source << 3 | Por P&K 4 | P mode 2 | PG sw 1
//  4-7 / 20-23  Mod, Ft., Aft, Br.: EAP << 4 | range           8-13 / 24-29  DX1 bytes 17-25 (17 | the 8s of 19,
//               21, 23 as 10h, 20h, 40h; 19<<4|18; 21<<4|20; 23<<4|22; 24; 25)
//  14 / 30  Att | P out 8 | Sus pdl 10h | Source 16 20h | voice cartridge 40h    15 / 31  Key sft | PB stp 8 40h
//  32       Key assign | Single channel << 2 | Detune << 3     33  Split     34-63  P name
export const FMEM_SIZE = 64;
export function packFn94(h) {
  const r = new Uint8Array(FMEM_SIZE);
  for (let k = 0; k < 2; k++) {
    const s = k * 30;
    const o = k * 16;
    r[o] = (h[s] & 0x1f) | (h[s + 2] ? 0x40 : 0) | (k ? 0x20 : 0);
    r[o + 1] = ((h[s + 4] << 4) + h[s + 3]) & 0x7f;
    r[o + 2] = h[s + 5] & 0x7f;
    r[o + 3] = ((h[s + 1] << 3) | (h[s + 8] ? 4 : 0) | (h[s + 7] ? 2 : 0) | (h[s + 6] & 1)) & 0x7f;
    for (let i = 0; i < 4; i++) r[o + 4 + i] = ((h[s + 10 + 2 * i] << 4) + h[s + 9 + 2 * i]) & 0x7f;
    r[o + 8] = (h[s + 17] | (h[s + 19] & 8 ? 0x10 : 0) | (h[s + 21] & 8 ? 0x20 : 0) | (h[s + 23] & 8 ? 0x40 : 0)) & 0x7f;
    for (let i = 0; i < 3; i++) r[o + 9 + i] = ((h[s + 19 + 2 * i] << 4) + h[s + 18 + 2 * i]) & 0x7f;
    r[o + 12] = h[s + 24] & 0x7f;
    r[o + 13] = h[s + 25] & 0x7f;
    r[o + 14] = (h[s + 26] & 7) | (h[s + 27] ? 8 : 0) | (h[s + 28] ? 0x10 : 0) | (h[s + 1] & 0x10 ? 0x20 : 0) | (h[s] & 0x40);
    r[o + 15] = (h[s + 29] & 0x3f) | (h[s + 4] & 8 ? 0x40 : 0);
  }
  r[32] = (h[60] & 3) | (h[61] ? 4 : 0) | ((h[62] << 3) & 0x78);
  r[33] = h[63] & 0x7f;
  for (let i = 0; i < 30; i++) r[34 + i] = h[64 + i] & 0x7f;
  return r;
}
/**
 * The 94 bytes of a 64-byte memory, as the DX5 unpacks it (F999): voice A from 1-32 and B from 33-64,
 * PB rng shown 12 while a step is set, key assign held to 2. The DX5 leaves bytes 17-25 as they were;
 * here they are the inverse of its packing (the DX1's data).
 */
export function unpackFn94(r) {
  const h = new Uint8Array(FN_SIZE);
  for (let k = 0; k < 2; k++) {
    const s = k * 30;
    const o = k * 16;
    h[s] = (r[o] & 0x1f) | (k ? 0x20 : 0) | (r[o + 14] & 0x40);
    h[s + 1] = r[o + 14] & 0x20 ? 16 : (r[o + 3] >> 3) & 15;
    h[s + 2] = (r[o] >> 6) & 1;
    h[s + 3] = Math.min(r[o + 1], 12);
    h[s + 4] = Math.min(r[o + 1] >> 4, 12) | (r[o + 15] & 0x40 ? 8 : 0);
    h[s + 5] = r[o + 2];
    h[s + 6] = r[o + 3] & 1;
    h[s + 7] = (r[o + 3] >> 1) & 1;
    h[s + 8] = (r[o + 3] >> 2) & 1;
    for (let i = 0; i < 4; i++) { h[s + 9 + 2 * i] = r[o + 4 + i] & 15; h[s + 10 + 2 * i] = r[o + 4 + i] >> 4; }
    h[s + 17] = r[o + 8] & 15;
    for (let i = 0; i < 3; i++) { h[s + 18 + 2 * i] = r[o + 9 + i] & 15; h[s + 19 + 2 * i] = (r[o + 9 + i] >> 4) | ((r[o + 8] >> (4 + i)) & 1) << 3; }
    h[s + 24] = r[o + 12];
    h[s + 25] = r[o + 13];
    h[s + 26] = r[o + 14] & 7;
    h[s + 27] = (r[o + 14] >> 3) & 1;
    h[s + 28] = (r[o + 14] >> 4) & 1;
    h[s + 29] = r[o + 15] & 0x3f;
  }
  h[60] = Math.min(r[32] & 3, 2);
  h[61] = (r[32] >> 2) & 1;
  h[62] = r[32] >> 3;
  h[63] = r[33];
  for (let i = 0; i < 30; i++) h[64 + i] = r[34 + i];
  return h;
}
/** The 64 memories of a format 2 bulk (4096 bytes), unpacked. */
export const fmemPerformances = (data) => Array.from({ length: Math.floor(data.length / FMEM_SIZE) }, (_, i) => unpackFn94(data.subarray(i * FMEM_SIZE, (i + 1) * FMEM_SIZE)));
/**
 * Branch Library items for a format 2 bulk: one 94-byte performance each (object `object`, sent as format 1).
 * twice: the TX7 and the TF1 send their 32 memories twice, so the second 32 are listed only when they differ.
 */
export function fmemItems(b, k, { object = 'performance', twice = false, name = () => '', build }) {
  const data = b.data;
  const all = fmemPerformances(data);
  const same = twice && all.length === 64 && data.subarray(0, 2048).every((x, i) => x === data[2048 + i]);
  const list = same ? all.slice(0, 32) : all;
  return list.map((d, i) => ({ key: `fm${k}-${i}`, label: `${String(i + 1).padStart(2, '0')} ${name(d)}`.trim(), name: name(d), object, data: d, msgs: [Uint8Array.from(build(b.channel, d))] }));
}

// ------------------------------------------------------------------ format 2 written back (slot list)
export const FMEM_KEY = 'fmem-bank'; // g.objectData key of the editor's copy of the 64 records (format 2, 4096 bytes)
export const isFmemBulk = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 2 && b.data.length === 64 * FMEM_SIZE); };
/**
 * A slot list for the 94-byte object over the unit's format 2 memories. Every receiver takes a whole format 2
 * bulk (DX5 at 6000h, all 64; TX7 DE02: the first 32 records, bytes 0-7 and the attenuation of half A into the
 * voice's function memory; TF1 D151: the first 32, half A, or half B when the record is single mode on
 * channel B), so Store packs the memory into the editor's copy (read from the unit first) and sends it all.
 * o: {model, count (32 or 64), twice (the unit sends its 32 twice: the copy keeps both), perVoice (memory i is
 * voice i's: the voice bits are set to the slot), perChannel (a copy per MIDI channel: the TX816's modules),
 * name(d, i), recall(ch, i) (Play), note}.
 */
export function fmemSlots(o) {
  const ch = (ctx) => ctx?.channel ?? 0;
  const key = (ctx) => (o.perChannel ? `${FMEM_KEY}-ch${ch(ctx) + 1}` : FMEM_KEY);
  const copyOf = (ctx) => ctx?.data?.[key(ctx)] || null;
  const loaded = (ctx) => !!(copyOf(ctx) && ctx.loaded?.has?.(key(ctx)));
  const at = (c, i) => unpackFn94(c.subarray(i * FMEM_SIZE, (i + 1) * FMEM_SIZE));
  async function read(api) {
    const raw = await api.request(dumpRequest(ch(api.ctx), 2), isFmemBulk, (r) => r);
    const k = key(api.ctx);
    api.g.objectData[k] = Uint8Array.from(parseBulk(raw).data);
    api.g.loadedKeys?.add(k);
    return api.g.objectData[k];
  }
  return {
    label: o.label || 'Memories', banks: [[0, `MEMORIES 1-${o.count}`]], count: o.count,
    slotLabel: (_b, i) => String(i + 1).padStart(2, '0'),
    names: (_b, ctx) => { const c = copyOf(ctx); return c ? Array.from({ length: o.count }, (_, i) => o.name(at(c, i), i)) : null; },
    scannable: () => true,
    scanBank: async (api, _b, onName) => { const c = await read(api); for (let i = 0; i < o.count; i++) onName(i, o.name(at(c, i), i)); },
    note: (_b, ctx) => `${copyOf(ctx) ? `Names and Edit come from the editor's copy of the ${o.count} memories${loaded(ctx) ? ' (read from the unit)' : ''}.` : 'Read names (or Edit) reads the memories.'} Store puts the edited data into its memory and sends all of them${o.note ? `; ${o.note}` : ''}.`,
    name: (d) => o.name(d),
    ...(o.recall ? { recall: (_b, i, ctx) => o.recall(ch(ctx), i) } : {}),
    fetch: async (api, _b, i) => at(copyOf(api.ctx) || await read(api), i),
    writable: (_b, ctx) => loaded(ctx),
    store: (_b, i, ctx, d) => {
      const c = copyOf(ctx);
      const h = Uint8Array.from(d);
      if (o.perVoice) h[0] = (h[0] & 0x40) | i; // memory i belongs to voice i
      const rec = packFn94(h);
      c.set(rec, i * FMEM_SIZE);
      if (o.twice) c.set(rec, (i + 32) * FMEM_SIZE);
      return [bulk(ch(ctx), 2, c)];
    },
  };
}
/** The demo unit's format 2: answers the request, keeps a received bulk. */
export function simulateFmem(unit, d, init) {
  if (d[0] === 0xf0 && (d[2] & 0xf0) === 0x20 && d[3] === 2) {
    if (!unit.fmem) { unit.fmem = new Uint8Array(64 * FMEM_SIZE); const r = packFn94(init()); for (let i = 0; i < 64; i++) unit.fmem.set(r, i * FMEM_SIZE); }
    return [bulk(d[2] & 15, 2, unit.fmem)];
  }
  if (isFmemBulk(d)) { unit.fmem = Uint8Array.from(parseBulk(d).data); return []; }
  return null;
}
