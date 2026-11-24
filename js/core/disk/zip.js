// ZIP archives (sound sets are often shipped zipped): the central directory, and each file read on
// demand from a byte source (source.js), stored or deflated (the browser's DecompressionStream).
// Not handled: ZIP64 (archives over 4 GB or 65535 files) and encrypted entries.

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);

/** {entries: [{name, size, method, encrypted, dir}], read(entry) -> Promise<Uint8Array>} */
export async function readZip(src) {
  const tailLen = Math.min(src.size, 65557);
  const tail = await src.read(src.size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error(`${src.name || 'File'} is not a ZIP archive (no end of central directory).`);
  const count = u16(tail, e + 10);
  const cdSize = u32(tail, e + 12);
  const cdOffset = u32(tail, e + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported.');
  const cd = await src.read(cdOffset, cdSize);
  const entries = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length && u32(cd, p) === 0x02014b50; n++) {
    const flags = u16(cd, p + 8);
    const nameLen = u16(cd, p + 28);
    const raw = cd.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? new TextDecoder().decode(raw) : String.fromCharCode(...raw);
    entries.push({
      name, method: u16(cd, p + 10), compSize: u32(cd, p + 20), size: u32(cd, p + 24), local: u32(cd, p + 42),
      encrypted: !!(flags & 1), dir: name.endsWith('/'),
    });
    p += 46 + nameLen + u16(cd, p + 30) + u16(cd, p + 32);
  }
  async function read(entry) {
    if (entry.encrypted) throw new Error(`${entry.name} is encrypted.`);
    const lh = await src.read(entry.local, 30);
    if (u32(lh, 0) !== 0x04034b50) throw new Error(`${entry.name}: damaged local header.`);
    const data = await src.read(entry.local + 30 + u16(lh, 26) + u16(lh, 28), entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} is not supported.`);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { entries, read };
}
