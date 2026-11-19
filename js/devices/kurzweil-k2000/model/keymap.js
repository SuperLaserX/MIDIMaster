// K2000 keymap object.
// Header (16-bit big-endian): sampleId, method, basePitch, centsPerEntry, numEntries-1,
// entrySize, then 8 level offsets (ppp..fff), each pointing from its own field to an
// entry table. Method bits: 0x10 16-bit tuning, 0x08 8-bit tuning, 0x04 volume adjust,
// 0x02 per-entry sample ID, 0x01 sub-sample number.

import { s16be, u16be, toS8, put16be, fromS8 } from '../../../core/bits.js';

export const LEVELS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
const HEADER = 12;
const LEVEL_FIELDS = 16;

export function entrySize(method) {
  return ((method & 0x10) ? 2 : (method & 0x08) ? 1 : 0) + ((method & 0x04) ? 1 : 0) +
    ((method & 0x02) ? 2 : 0) + ((method & 0x01) ? 1 : 0);
}

export class Keymap {
  constructor(data, { id = 0, name = '' } = {}) {
    this.id = id;
    this.name = name;
    this.data = Uint8Array.from(data);
    this.parse();
  }

  parse() {
    const d = this.data;
    this.sampleId = s16be(d, 0);
    this.method = u16be(d, 2);
    this.basePitch = s16be(d, 4);
    this.centsPerEntry = s16be(d, 6);
    this.numEntries = s16be(d, 8) + 1;
    this.entrySize = u16be(d, 10) || entrySize(this.method);
    this.levelTable = [];
    for (let i = 0; i < 8; i++) {
      const fieldPos = HEADER + i * 2;
      const tableStart = fieldPos + s16be(d, fieldPos); // self-relative pointer
      this.levelTable.push(tableStart);
    }
    this.tables = [...new Set(this.levelTable)].sort((a, b) => a - b);
  }

  /** MIDI note that entry i responds to. */
  entryNote(i) { return 12 + (this.basePitch + i * this.centsPerEntry) / 100; }

  entryOffset(tableStart, i) { return tableStart + i * this.entrySize; }

  readEntry(tableStart, i) {
    const d = this.data;
    let p = this.entryOffset(tableStart, i);
    const e = { offset: p };
    if (this.method & 0x10) { e.tuning = s16be(d, p); e.tuningOff = p; p += 2; } else if (this.method & 0x08) { e.tuning = toS8(d[p]); e.tuningOff = p; p += 1; }
    if (this.method & 0x04) { e.volume = toS8(d[p]); e.volumeOff = p; p += 1; }
    if (this.method & 0x02) { e.sampleId = s16be(d, p); e.sampleOff = p; p += 2; } else e.sampleId = this.sampleId;
    if (this.method & 0x01) { e.subSample = d[p]; e.subOff = p; p += 1; }
    return e;
  }

  entries(level = 4) {
    const t = this.levelTable[level];
    return Array.from({ length: this.numEntries }, (_, i) => ({ index: i, note: this.entryNote(i), ...this.readEntry(t, i) }));
  }

  /** Contiguous runs of entries that share a sample, for a compact zone view. */
  zones(level = 4) {
    const list = this.entries(level);
    const step = Math.max(1, this.centsPerEntry / 100); // keys covered by one entry
    const zones = [];
    for (const e of list) {
      const hi = e.note + step - 1;
      const last = zones[zones.length - 1];
      if (last && last.sampleId === e.sampleId && last.subSample === e.subSample) { last.hi = hi; last.entries.push(e); } else zones.push({ sampleId: e.sampleId, subSample: e.subSample, lo: e.note, hi, entries: [e] });
    }
    return zones;
  }

  /** Patch helpers return {offset, bytes, before} for LOAD. */
  setSample(entry, sampleId) {
    if (entry.sampleOff === undefined) return null;
    const before = this.data.slice(entry.sampleOff, entry.sampleOff + 2);
    put16be(this.data, entry.sampleOff, sampleId);
    return { offset: entry.sampleOff, bytes: this.data.slice(entry.sampleOff, entry.sampleOff + 2), before };
  }

  setVolume(entry, v) {
    if (entry.volumeOff === undefined) return null;
    const before = this.data.slice(entry.volumeOff, entry.volumeOff + 1);
    this.data[entry.volumeOff] = fromS8(v);
    return { offset: entry.volumeOff, bytes: this.data.slice(entry.volumeOff, entry.volumeOff + 1), before };
  }

  setTuning(entry, v) {
    if (entry.tuningOff === undefined) return null;
    const size = (this.method & 0x10) ? 2 : 1;
    const before = this.data.slice(entry.tuningOff, entry.tuningOff + size);
    if (size === 2) put16be(this.data, entry.tuningOff, v & 0xffff); else this.data[entry.tuningOff] = fromS8(v);
    return { offset: entry.tuningOff, bytes: this.data.slice(entry.tuningOff, entry.tuningOff + size), before };
  }

  /** Sample IDs referenced by this keymap (for dependency views). */
  referencedSamples() {
    const ids = new Set();
    for (const t of this.tables) for (let i = 0; i < this.numEntries; i++) ids.add(this.readEntry(t, i).sampleId);
    ids.delete(0);
    return [...ids].sort((a, b) => a - b);
  }
}

export { LEVEL_FIELDS };
