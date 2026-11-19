// Roland address-map SysEx (DT1 data set, RQ1 data request), used from the late 1980s on
// (D-110 to JV/XP/JD/MC and later). Addresses are 3 or 4 bytes of 7 bits each.
//
//   RQ1: F0 41 dev model.. 11 addr size cs F7
//   DT1: F0 41 dev model.. 12 addr data cs F7
// cs = (128 - (sum of addr and data or size) % 128) % 128

export const ROLAND = 0x41;

export function checksum(bytes) {
  let s = 0;
  for (const b of bytes) s += b;
  return (128 - (s % 128)) % 128;
}

/** 7-bit address bytes -> integer, and back. */
export const addrToInt = (a) => a.reduce((v, b) => v * 128 + (b & 0x7f), 0);
export function intToAddr(n, len = 4) {
  const out = new Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = n % 128; n = Math.floor(n / 128); }
  return out;
}
/** Add an offset to an address in 7-bit arithmetic. */
export const addAddr = (a, offset) => intToAddr(addrToInt(a) + offset, a.length);

export function rq1(model, dev, addr, size) {
  const body = [...addr, ...intToAddr(size, addr.length)];
  return [0xf0, ROLAND, dev & 0x7f, ...model, 0x11, ...body, checksum(body), 0xf7];
}

export function dt1(model, dev, addr, data) {
  const body = [...addr, ...data];
  return [0xf0, ROLAND, dev & 0x7f, ...model, 0x12, ...body, checksum(body), 0xf7];
}

/**
 * Split a block into several DT1 messages of at most `chunk` data bytes, as Roland
 * devices expect for large writes.
 */
export function dt1Chunks(model, dev, addr, data, chunk = 128) {
  const out = [];
  for (let i = 0; i < data.length; i += chunk) out.push(dt1(model, dev, addAddr(addr, i), Array.from(data.slice(i, i + chunk))));
  return out;
}

/** Parse a DT1 message for `model`. Returns {dev, addr, data, ok} or null. */
export function parseDt1(raw, model) {
  if (raw[0] !== 0xf0 || raw[1] !== ROLAND) return null;
  const m = model.length;
  for (let i = 0; i < m; i++) if (raw[3 + i] !== model[i]) return null;
  if (raw[3 + m] !== 0x12) return null;
  const alen = 4;
  const addr = Array.from(raw.slice(4 + m, 4 + m + alen));
  const data = raw.slice(4 + m + alen, raw.length - 2);
  const ok = checksum([...addr, ...data]) === raw[raw.length - 2];
  return { dev: raw[2], addr, data, ok };
}

/**
 * Request `size` bytes at `addr` and assemble the reply, which may arrive as several DT1
 * messages. client is a DeviceClient. Resolves to a Uint8Array.
 *
 * Devices can take a while to start answering (a JV-2080 sometimes needs over 400 ms) and
 * pause between the messages of a long reply, so the first reply gets the full timeout and
 * a gap of `quiet` ms ends the reply. Bytes that did not arrive are requested again
 * (`retries` times) before the read fails.
 */
export async function readBlock(client, model, dev, addr, size, { timeout = 2500, quiet = 800, retries = 2 } = {}) {
  const start = addrToInt(addr);
  const out = new Uint8Array(size);
  const have = new Uint8Array(size);
  let count = 0;
  for (let attempt = 0; attempt <= retries && count < size; attempt++) {
    const from = have.indexOf(0);
    let to = from;
    while (to < size && !have[to]) to++;
    const take = (raw) => {
      const p = parseDt1(raw, model);
      if (!p || !p.ok) return false;
      const off = addrToInt(p.addr) - start;
      if (off + p.data.length <= 0 || off >= size) return false;
      for (let i = 0; i < p.data.length; i++) {
        const k = off + i;
        if (k < 0 || k >= size) continue;
        out[k] = p.data[i];
        if (!have[k]) { have[k] = 1; count++; }
      }
      return true;
    };
    try {
      await client.request(Uint8Array.from(rq1(model, dev, intToAddr(start + from, addr.length), to - from)), {
        collect: (m, r) => take(r ?? m.raw),
        complete: () => have.subarray(from, to).every(Boolean),
        quiet,
        resolveOnQuiet: true,
        timeout,
      });
    } catch (err) {
      if (attempt === retries) { if (!count) throw new Error('No reply to the data request.'); break; }
    }
  }
  if (count < size) throw new Error(`Incomplete reply: ${count} of ${size} bytes at ${intToAddr(start, addr.length).map((b) => b.toString(16).padStart(2, '0')).join(' ')}.`);
  return out;
}
