// Read-only FAT12/16/32 reader. The K2000 formats floppies, SCSI disks and its
// CD-ROMs (KMSI, KCDM) as plain DOS FAT volumes, usually without a partition table.

import { ExtentSource, u16le, u32le, ascii } from './source.js';

/** True when 512 bytes look like a FAT boot sector with a sane BIOS parameter block. */
export function isFatBootSector(b) {
  if (!b || b.length < 512) return false;
  const bps = u16le(b, 11);
  const spc = b[13];
  const reserved = u16le(b, 14);
  const fats = b[16];
  const total = u16le(b, 19) || u32le(b, 32);
  const fatSize = u16le(b, 22) || u32le(b, 36);
  if (![512, 1024, 2048, 4096].includes(bps)) return false;
  if (!spc || (spc & (spc - 1)) || spc > 128) return false;
  if (!reserved || fats < 1 || fats > 4 || !total || !fatSize) return false;
  if (b[21] < 0xf0 && b[21] !== 0) return false; // media descriptor
  return b[0] === 0xeb || b[0] === 0xe9 || (b[510] === 0x55 && b[511] === 0xaa);
}

const cleanLabel = (s) => s.replace(/[\u0000-\u001f]/g, '').trim();

function fatDate(date, time) {
  if (!date) return null;
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

export class FatVolume {
  constructor(src, offset, boot) {
    this.src = src;
    this.offset = offset;
    this.kind = 'FAT';
    const bps = u16le(boot, 11);
    const spc = boot[13];
    const reserved = u16le(boot, 14);
    const fats = boot[16];
    const rootEntries = u16le(boot, 17);
    const total = u16le(boot, 19) || u32le(boot, 32);
    const fatSize = u16le(boot, 22) || u32le(boot, 36);
    const rootSectors = Math.ceil((rootEntries * 32) / bps);
    this.bytesPerSector = bps;
    this.clusterSize = bps * spc;
    this.fatOffset = offset + reserved * bps;
    this.fatBytes = fatSize * bps;
    this.rootOffset = offset + (reserved + fats * fatSize) * bps;
    this.rootBytes = rootEntries * 32;
    this.dataOffset = this.rootOffset + rootSectors * bps;
    this.clusterCount = Math.floor((total - reserved - fats * fatSize - rootSectors) / spc);
    this.bits = this.clusterCount < 4085 ? 12 : this.clusterCount < 65525 ? 16 : 32;
    if (this.bits === 32) this.kind = 'FAT32';
    this.rootCluster = this.bits === 32 ? u32le(boot, 44) : 0;
    this.oem = ascii(boot, 3, 8).trim();
    const labelAt = this.bits === 32 ? 71 : 43;
    const sig = boot[this.bits === 32 ? 66 : 38];
    this.label = sig === 0x29 ? cleanLabel(ascii(boot, labelAt, 11)) : '';
    if (this.label === 'NO NAME') this.label = '';
  }

  static async open(src, offset = 0) {
    const boot = await src.read(offset, 512);
    if (!isFatBootSector(boot)) throw new Error('Not a FAT volume');
    const v = new FatVolume(src, offset, boot);
    const width = v.bits === 12 ? 1.5 : v.bits / 8;
    const need = Math.min(v.fatBytes, Math.ceil((v.clusterCount + 2) * width) + 4);
    if (need > 64 * 1024 * 1024) throw new Error('FAT table too large');
    v.fat = await src.read(v.fatOffset, need);
    // The root directory may hold the volume label when the boot sector has none.
    if (!v.label) {
      const raw = await v._readDirBytes(null);
      for (let p = 0; p + 32 <= raw.length && raw[p]; p += 32) {
        if (raw[p] !== 0xe5 && raw[p + 11] !== 0x0f && (raw[p + 11] & 0x08)) { v.label = cleanLabel(ascii(raw, p, 11)); break; }
      }
    }
    return v;
  }

  /** Next cluster in a chain, or null at the end of the chain. */
  next(c) {
    const f = this.fat;
    let v;
    if (this.bits === 12) {
      const o = c + (c >> 1);
      if (o + 1 >= f.length) return null;
      v = f[o] | (f[o + 1] << 8);
      v = c & 1 ? v >> 4 : v & 0xfff;
      if (v >= 0xff7) return null;
    } else if (this.bits === 16) {
      if (c * 2 + 1 >= f.length) return null;
      v = u16le(f, c * 2);
      if (v >= 0xfff7) return null;
    } else {
      if (c * 4 + 3 >= f.length) return null;
      v = u32le(f, c * 4) & 0x0fffffff;
      if (v >= 0x0ffffff7) return null;
    }
    return v >= 2 && v < this.clusterCount + 2 ? v : null;
  }

  chain(start) {
    const out = [];
    let c = start;
    while (c !== null && c >= 2 && out.length <= this.clusterCount) {
      out.push(c);
      c = this.next(c);
    }
    return out;
  }

  clusterOffset(c) { return this.dataOffset + (c - 2) * this.clusterSize; }

  /** Merge a cluster chain into contiguous extents. */
  extents(start, size) {
    const list = [];
    let fileOffset = 0;
    for (const c of this.chain(start)) {
      if (fileOffset >= size) break;
      const sourceOffset = this.clusterOffset(c);
      const len = Math.min(this.clusterSize, size - fileOffset);
      const last = list[list.length - 1];
      if (last && last.sourceOffset + last.length === sourceOffset) last.length += len;
      else list.push({ fileOffset, sourceOffset, length: len });
      fileOffset += len;
    }
    return list;
  }

  async _readDirBytes(dir) {
    if (!dir && this.bits !== 32) return this.src.read(this.rootOffset, this.rootBytes);
    const start = dir ? dir.cluster : this.rootCluster;
    const clusters = this.chain(start);
    const size = clusters.length * this.clusterSize;
    if (!size) return new Uint8Array(0);
    return new ExtentSource(this.src, this.extents(start, size), size).read(0, size);
  }

  /** Entries of a directory (null = root): [{name, shortName, isDir, size, cluster, date}]. */
  async list(dir = null) {
    const raw = await this._readDirBytes(dir);
    const entries = [];
    let lfn = [];
    for (let p = 0; p + 32 <= raw.length; p += 32) {
      const first = raw[p];
      if (first === 0) break;
      if (first === 0xe5) { lfn = []; continue; }
      const attr = raw[p + 11];
      if (attr === 0x0f) {
        const seq = first & 0x1f;
        if (first & 0x40) lfn = [];
        let s = '';
        for (const o of [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]) {
          const ch = u16le(raw, p + o);
          if (ch === 0 || ch === 0xffff) break;
          s += String.fromCharCode(ch);
        }
        if (seq >= 1 && seq <= 20) lfn[seq - 1] = s;
        continue;
      }
      if (attr & 0x08) { lfn = []; continue; } // volume label
      let base = ascii(raw, p, 8).trimEnd();
      if (first === 0x05) base = 'å' + base.slice(1);
      const ext = ascii(raw, p + 8, 3).trimEnd();
      const shortName = ext ? `${base}.${ext}` : base;
      const useLfn = lfn.length > 0 && !lfn.includes(undefined); // includes() also finds holes
      const name = useLfn ? lfn.join('') : shortName;
      lfn = [];
      if (shortName === '.' || shortName === '..') continue;
      const cluster = u16le(raw, p + 26) + (this.bits === 32 ? u16le(raw, p + 20) * 65536 : 0);
      entries.push({
        name, shortName, isDir: !!(attr & 0x10), size: u32le(raw, p + 28), cluster,
        date: fatDate(u16le(raw, p + 24), u16le(raw, p + 22)),
      });
    }
    return entries;
  }

  /** Recursively list every file: yields {path, entry}. */
  async* walk(dir = null, path = '', depth = 0, seen = new Set()) {
    if (depth > 24) return;
    for (const e of await this.list(dir)) {
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.isDir) {
        if (!e.cluster || seen.has(e.cluster)) continue;
        seen.add(e.cluster);
        yield* this.walk(e, p, depth + 1, seen);
      } else yield { path: p, entry: e };
    }
  }

  fileSource(entry) {
    return new ExtentSource(this.src, entry.size ? this.extents(entry.cluster, entry.size) : [], entry.size, entry.name);
  }
}
