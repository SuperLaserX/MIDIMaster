// Read-only ISO 9660 reader with Joliet long names. Most Kurzweil CD-ROMs are FAT,
// but the K2000 also reads ISO 9660 discs, and third-party libraries used them.

import { SliceSource, u16le, u32le, ascii } from './source.js';

const SECTOR = 2048;

export async function isIso9660(src) {
  if (src.size < 17 * SECTOR) return false;
  const b = await src.read(16 * SECTOR, 8);
  return ascii(b, 1, 5) === 'CD001';
}

function ucs2be(b, p, n) {
  let s = '';
  for (let i = 0; i + 1 < n; i += 2) {
    const c = (b[p + i] << 8) | b[p + i + 1];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export class IsoVolume {
  constructor(src) {
    this.src = src;
    this.kind = 'ISO 9660';
  }

  static async open(src) {
    const v = new IsoVolume(src);
    let pvd = null;
    let joliet = null;
    for (let s = 16; s < 64; s++) {
      const d = await src.read(s * SECTOR, SECTOR);
      if (ascii(d, 1, 5) !== 'CD001') break;
      if (d[0] === 1 && !pvd) pvd = d;
      if (d[0] === 2 && d[88] === 0x25 && d[89] === 0x2f && [0x40, 0x43, 0x45].includes(d[90])) joliet = d;
      if (d[0] === 255) break;
    }
    if (!pvd) throw new Error('No ISO 9660 primary volume descriptor');
    const vd = joliet || pvd;
    v.joliet = !!joliet;
    if (joliet) v.kind = 'ISO 9660 (Joliet)';
    v.blockSize = u16le(vd, 128) || SECTOR;
    v.root = v._record(vd, 156);
    v.label = (joliet ? ucs2be(vd, 40, 32) : ascii(vd, 40, 32)).trim();
    return v;
  }

  _record(b, p) {
    const nameLen = b[p + 32];
    let name;
    if (nameLen === 1 && (b[p + 33] === 0 || b[p + 33] === 1)) name = b[p + 33] ? '..' : '.';
    else name = (this.joliet ? ucs2be(b, p + 33, nameLen) : ascii(b, p + 33, nameLen)).replace(/;\d+$/, '').replace(/\.$/, '');
    return { name, lba: u32le(b, p + 2), size: u32le(b, p + 10), isDir: !!(b[p + 25] & 2) };
  }

  async list(dir = null) {
    const d = dir || this.root;
    const bs = this.blockSize;
    const raw = await this.src.read(d.lba * bs, d.size);
    const out = [];
    let p = 0;
    while (p < raw.length) {
      const len = raw[p];
      if (!len) { p = (Math.floor(p / bs) + 1) * bs; continue; } // records never cross a block
      if (p + 33 > raw.length) break;
      const r = this._record(raw, p);
      if (r.name !== '.' && r.name !== '..') out.push(r);
      p += len;
    }
    return out;
  }

  async* walk(dir = null, path = '', depth = 0, seen = new Set()) {
    if (depth > 24) return;
    for (const e of await this.list(dir)) {
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.isDir) {
        if (seen.has(e.lba)) continue;
        seen.add(e.lba);
        yield* this.walk(e, p, depth + 1, seen);
      } else yield { path: p, entry: e };
    }
  }

  fileSource(entry) { return new SliceSource(this.src, entry.lba * this.blockSize, entry.size, entry.name); }
}
