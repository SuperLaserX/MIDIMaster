// Random-access byte sources. Disk images can be hundreds of megabytes, so nothing
// here loads a whole file: every source reads byte ranges on demand through
// Blob.slice() and keeps a small cache of recently used chunks.
//
// All sources share one interface:
//   size                      total length in bytes
//   name                      display name
//   read(offset, length)      Promise<Uint8Array>, shorter than length at the end

const CHUNK = 64 * 1024;
const CACHE_CHUNKS = 96; // 6 MB

export class BlobSource {
  constructor(blob, name) {
    this.blob = blob;
    this.size = blob.size;
    this.name = name ?? blob.name ?? '';
    this.cache = new Map();
  }

  async _chunk(index) {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit); // most recently used last
      return hit;
    }
    const start = index * CHUNK;
    const p = this.blob.slice(start, Math.min(this.size, start + CHUNK)).arrayBuffer().then((b) => new Uint8Array(b));
    this.cache.set(index, p);
    if (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value);
    try { return await p; } catch (err) { this.cache.delete(index); throw err; }
  }

  async read(offset, length) {
    offset = Math.max(0, offset);
    const end = Math.min(this.size, offset + Math.max(0, length));
    if (end <= offset) return new Uint8Array(0);
    if (end - offset > 4 * CHUNK) return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
    const out = new Uint8Array(end - offset);
    for (let c = Math.floor(offset / CHUNK); c * CHUNK < end; c++) {
      const chunk = await this._chunk(c);
      const cs = c * CHUNK;
      const from = Math.max(offset, cs);
      const to = Math.min(end, cs + chunk.length);
      out.set(chunk.subarray(from - cs, to - cs), from - offset);
    }
    return out;
  }
}

/** A window [offset, offset + size) of another source. */
export class SliceSource {
  constructor(base, offset, size, name = base.name) {
    this.base = base;
    this.offset = offset;
    this.size = Math.max(0, Math.min(size, base.size - offset));
    this.name = name;
  }

  read(offset, length) {
    const o = Math.max(0, offset);
    const n = Math.max(0, Math.min(length, this.size - o));
    return this.base.read(this.offset + o, n);
  }
}

/** A file stored in pieces: extents = [{fileOffset, sourceOffset, length}] in file order. */
export class ExtentSource {
  constructor(base, extents, size, name = base.name) {
    this.base = base;
    this.extents = extents;
    this.size = size;
    this.name = name;
  }

  async read(offset, length) {
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    const out = new Uint8Array(end - offset);
    for (const e of this.extents) {
      const from = Math.max(offset, e.fileOffset);
      const to = Math.min(end, e.fileOffset + e.length);
      if (to <= from) continue;
      out.set(await this.base.read(e.sourceOffset + (from - e.fileOffset), to - from), from - offset);
    }
    return out;
  }
}

/**
 * Logical 2048-byte sectors of a CD image stored with larger raw sectors
 * (2352 bytes with sync and header, data at byte 16 for MODE1 or 24 for MODE2).
 */
export class SectorSource {
  constructor(base, { sectorSize = 2352, dataOffset = 16, start = 0 } = {}, name = base.name) {
    this.base = base;
    this.sectorSize = sectorSize;
    this.dataOffset = dataOffset;
    this.start = start;
    this.size = Math.floor((base.size - start) / sectorSize) * 2048;
    this.name = name;
  }

  async read(offset, length) {
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    const first = Math.floor(offset / 2048);
    const last = Math.floor((end - 1) / 2048);
    const raw = await this.base.read(this.start + first * this.sectorSize, (last - first + 1) * this.sectorSize);
    const out = new Uint8Array(end - offset);
    for (let s = first; s <= last; s++) {
      const ls = s * 2048;
      const from = Math.max(offset, ls);
      const to = Math.min(end, ls + 2048);
      const r = (s - first) * this.sectorSize + this.dataOffset + (from - ls);
      out.set(raw.subarray(r, r + (to - from)), from - offset);
    }
    return out;
  }
}

/** A source over bytes already in memory (tests, small files). */
export class BytesSource {
  constructor(bytes, name = '') {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.size = this.bytes.length;
    this.name = name;
  }

  async read(offset, length) {
    const o = Math.max(0, offset);
    return this.bytes.slice(o, Math.min(this.size, o + Math.max(0, length)));
  }
}

export const u16le = (b, p) => b[p] | (b[p + 1] << 8);
export const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
export const ascii = (b, p, n) => {
  let s = '';
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
};
