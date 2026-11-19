// Open disk and CD images (.iso, .bin with or without .cue, .img) and find their
// file system: FAT (what Kurzweil uses) or ISO 9660, optionally behind an MBR.

import { BlobSource, SectorSource, SliceSource, u32le } from './source.js';
import { FatVolume, isFatBootSector } from './fat.js';
import { IsoVolume, isIso9660 } from './iso9660.js';
import { parseCue, firstDataTrack } from './cue.js';

export const IMAGE_FILE = /\.(iso|bin|img|ima|cdr|hda|hds)$/i;
export const CUE_FILE = /\.cue$/i;

/** Raw CD sectors start with a 12-byte sync pattern; byte 15 is the sector mode. */
export async function detectRawSectors(src) {
  if (src.size < 2352 * 17) return null;
  for (const sector of [0, 16]) {
    const h = await src.read(sector * 2352, 16);
    const sync = h[0] === 0 && h[11] === 0 && h.subarray(1, 11).every((b) => b === 0xff);
    if (sync) return { sectorSize: 2352, dataOffset: h[15] === 2 ? 24 : 16, start: 0 };
  }
  return null;
}

const FAT_PARTITION_TYPES = new Set([0x01, 0x04, 0x06, 0x0b, 0x0c, 0x0e]);

/** Find the file system in a source of logical bytes. */
export async function openVolume(src) {
  const boot = await src.read(0, 512);
  if (isFatBootSector(boot)) return FatVolume.open(src, 0);
  if (await isIso9660(src)) return IsoVolume.open(src);
  if (boot[510] === 0x55 && boot[511] === 0xaa) {
    for (let i = 0; i < 4; i++) {
      const e = 446 + i * 16;
      const lba = u32le(boot, e + 8);
      if (!FAT_PARTITION_TYPES.has(boot[e + 4]) || !lba) continue;
      const pb = await src.read(lba * 512, 512);
      if (isFatBootSector(pb)) return FatVolume.open(src, lba * 512);
    }
  }
  throw new Error('No FAT or ISO 9660 file system found in this image.');
}

/**
 * Open an image file. Pass the text of its .cue sheet when there is one; without a
 * cue sheet, raw 2352-byte sectors are detected from the sync pattern.
 * Returns {volume, layout, source}.
 */
export async function openImage(blob, { cueText = null, name = blob.name } = {}) {
  const raw = new BlobSource(blob, name);
  let layout = null;
  if (cueText) layout = firstDataTrack(parseCue(cueText));
  if (!layout) layout = await detectRawSectors(raw);
  if (!layout) layout = { sectorSize: 2048, dataOffset: 0, start: 0 };
  let src = raw;
  if (layout.sectorSize !== 2048 || layout.dataOffset) src = new SectorSource(raw, layout, name);
  else if (layout.start) src = new SliceSource(raw, layout.start, raw.size - layout.start, name);
  const volume = await openVolume(src);
  const sectors = layout.sectorSize === 2048 ? '2048-byte sectors' : `raw ${layout.sectorSize}-byte sectors (MODE${layout.dataOffset === 24 ? 2 : 1})`;
  return { volume, layout: { ...layout, description: sectors }, source: src };
}

/** List every file in a volume whose name matches `pattern`: [{path, entry}]. */
export async function findFiles(volume, pattern, { limit = 20000 } = {}) {
  const out = [];
  for await (const f of volume.walk()) {
    if (pattern.test(f.entry.name)) out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}
