// Roland SYSTEM-8 memory: SysEx framing, the address map and the leaf layout of every struct, the
// reads (RQ1, then the unit's DT1 leaves) and writes (DT1 per leaf). See docs/devices/roland-system8.md.
//
// A sound ("full patch") is three structs at three addresses: `patch` (640 bytes: panel values, name,
// arpeggio, patch cords...), `patch2` (3975 bytes in 17 leaves: effect details, chord memory, velocity
// sensitivities, patch tempo, comment) and `patch3` (15580 bytes in 66 leaves: the step sequencer). The
// editor keeps them back to back ("compact" offsets): patch at 0, patch2 at 640, patch3 at 4615.
// Inside a struct, addresses are 7-bit packed: leaf k of patch2/patch3 starts at packed offset k * 0x800
// (b2 += 0x10 per leaf, b1 += 1 per 8 leaves).

export const MODEL = [0x00, 0x00, 0x7e];
export const DEV = 0x10;
export const A = (b0, b1 = 0, b2 = 0, b3 = 0) => (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
export const a28 = (a) => [(a >>> 21) & 0x7f, (a >>> 14) & 0x7f, (a >>> 7) & 0x7f, a & 0x7f];
export const hexAddr = (a) => a28(a).map((b) => b.toString(16).padStart(2, '0')).join(' ');
const checksum = (body) => (128 - (body.reduce((s, b) => s + b, 0) & 0x7f)) & 0x7f;

export function dt1(addr, data, id = DEV) {
  const body = [...a28(addr), ...data];
  return [0xf0, 0x41, id & 0x7f, ...MODEL, 0x12, ...body, checksum(body), 0xf7];
}
export function rq1(addr, size, id = DEV) {
  const body = [...a28(addr), ...a28(size)];
  return [0xf0, 0x41, id & 0x7f, ...MODEL, 0x11, ...body, checksum(body), 0xf7];
}
export const isS8 = (raw) => raw?.[0] === 0xf0 && raw[1] === 0x41 && raw[3] === 0x00 && raw[4] === 0x00 && raw[5] === 0x7e;
/** {cmd, addr, data, ok} of a SYSTEM-8 DT1/RQ1, or null. */
export function parse(raw) {
  if (!isS8(raw) || raw.length < 13) return null;
  const body = Array.from(raw.slice(7, raw.length - 2));
  const addr = (body[0] << 21) | (body[1] << 14) | (body[2] << 7) | body[3];
  return { cmd: raw[6], addr, data: body.slice(4), ok: checksum(body) === raw[raw.length - 2] };
}

// ------------------------------------------------------------------ struct layouts
const leafList = (sizes) => sizes.map((n, k) => [k * 0x800, n]);
/** The leaves the unit answers with, [packed offset, length]: the patch struct in ten panel blocks and 240-byte chunks. */
export const PATCH_LEAVES = [[0x00, 14], [0x0e, 10], [0x18, 16], [0x28, 12], [0x34, 6], [0x3a, 20], [0x4e, 10], [0x58, 8], [0x60, 12], [0x6c, 20], [0x80, 240], [0x170, 240], [0x260, 32]];
export const PATCH2_LEAVES = leafList([240, 240, 240, 240, 240, 234, 234, 240, 240, 240, 230, 216, 212, 233, 222, 234, 240]);
export const PATCH3_LEAVES = leafList([...Array(65).fill(236), 240]);
/** Performance (12 leaves: common, upper, lower, CV/GATE, INPUT, the INPUT delay / chorus / flanger / MFX / reverb, name, a reserved leaf). */
export const PERF_LEAVES = leafList([228, 226, 226, 225, 211, 230, 216, 212, 233, 222, 240, 240]);
/** System settings: two leaves (01 50 00 00, 240 bytes; 01 50 01 70, 96 bytes). */
export const SYSTEM_LEAVES = [[0, 240], [0xf0, 96]];

/** A struct: its leaves and where they sit in the compact data. */
function struct(key, leaves, at = 0) {
  let o = at;
  const starts = leaves.map(([, n]) => { const s = o; o += n; return s; });
  const size = o - at;
  const span = leaves.at(-1)[0] + leaves.at(-1)[1];
  return {
    key, leaves, at, size, span, starts,
    /** compact offset of packed offset `p` (inside a leaf), or -1 */
    compact(p) { for (let k = leaves.length - 1; k >= 0; k--) if (p >= leaves[k][0]) return p - leaves[k][0] < leaves[k][1] ? starts[k] + p - leaves[k][0] : -1; return -1; },
    /** packed offset of compact offset `c` */
    packed(c) { for (let k = leaves.length - 1; k >= 0; k--) if (c >= starts[k]) return leaves[k][0] + c - starts[k]; return -1; },
  };
}
export const S_PATCH = struct('patch', PATCH_LEAVES, 0);
export const S_PATCH2 = struct('patch2', PATCH2_LEAVES, S_PATCH.size);
export const S_PATCH3 = struct('patch3', PATCH3_LEAVES, S_PATCH.size + S_PATCH2.size);
export const FULL = [S_PATCH, S_PATCH2, S_PATCH3];
export const FULL_SIZE = S_PATCH.size + S_PATCH2.size + S_PATCH3.size; // 20195
export const S_PERF = struct('performance', PERF_LEAVES, 0);
export const S_SYSTEM = struct('system', SYSTEM_LEAVES, 0);
export const structOf = (c) => FULL.find((s) => c >= s.at && c < s.at + s.size);

// ------------------------------------------------------------------ address map
/** Temporary areas: patch mode, upper part, lower part (performance mode) for the three structs. */
export const TEMP_B1 = [0x00, 0x20, 0x30];
export const tempBases = (t = 0) => [A(0x03, TEMP_B1[t]), A(0x05, TEMP_B1[t]), A(0x06, TEMP_B1[t])];
export const TEMP_PERF = A(0x04);
export const SYSTEM_BASE = A(0x01, 0x50);
const PATCH_BASE = { 0: A(0x20), 1: A(0x40), 2: A(0x0e), 3: A(0x0f) };
const P2_B0 = [0x28, 0x30, 0x38, 0x68];
const P3_B0 = [0x48, 0x50, 0x58, 0x60];
/** Address of the `patch` struct of user patch p (0-63) in slot 0-3 (SYSTEM-8, PLUG-OUT 1-3). */
export function slotPatchAddr(slot, p) {
  const b = p >> 3; const i = p & 7;
  return slot < 2 ? PATCH_BASE[slot] + (b << 21) + (i << 14) : PATCH_BASE[slot] + (((b << 4) + i) << 14);
}
/** The three struct addresses of user patch p in slot s. */
export const slotBases = (s, p) => [slotPatchAddr(s, p), A(P2_B0[s] + (p >> 3), (p & 7) << 4), A(P3_B0[s] + (p >> 3), (p & 7) << 4)];
/** Performance n (0-63): bank A-H = 10-17, number 1-8 = b1 00, 10 ... 70. */
export const perfAddr = (n) => A(0x10 + (n >> 3), (n & 7) << 4);
/** PLUG-OUT control (70 ..) and its replies (71 ..). */
export const PLUG = { deviceType: A(0x70, 0, 2, 0), slotCount: A(0x70, 0, 2, 3), slotInfo: A(0x70, 0, 1, 0), bankStart: A(0x70, 0x20, 1, 1), bankEnd: A(0x70, 0x20, 1, 2) };

/** Which struct a DT1 address belongs to: {kind, slot?, patch?, temp?, perf?, struct (S_*), base}. */
export function locate(addr) {
  const [b0, b1] = a28(addr);
  const off = addr & 0x3fff;
  if (b0 === 0x01 && b1 === 0x50) return { kind: 'system', struct: S_SYSTEM, base: SYSTEM_BASE };
  if (b0 >= 0x03 && b0 <= 0x06 && b0 !== 0x04) {
    const t = TEMP_B1.indexOf(b1 & 0x70);
    if (t < 0) return null;
    const st = { 3: S_PATCH, 5: S_PATCH2, 6: S_PATCH3 }[b0];
    return { kind: 'temp', temp: t, struct: st, base: A(b0, TEMP_B1[t]) };
  }
  if (b0 === 0x04) return { kind: 'tempPerf', struct: S_PERF, base: TEMP_PERF };
  if (b0 >= 0x10 && b0 <= 0x17) return { kind: 'perf', perf: ((b0 - 0x10) << 3) + (b1 >> 4), struct: S_PERF, base: A(b0, b1 & 0x70) };
  if ((b0 >= 0x20 && b0 <= 0x27) || (b0 >= 0x40 && b0 <= 0x47)) { const slot = b0 >= 0x40 ? 1 : 0; return { kind: 'slot', slot, patch: ((b0 & 7) << 3) + b1, struct: S_PATCH, base: A(b0, b1) }; }
  if (b0 === 0x0e || b0 === 0x0f) return { kind: 'slot', slot: b0 - 0x0c, patch: ((b1 >> 4) << 3) + (b1 & 7), struct: S_PATCH, base: A(b0, b1) };
  for (let s = 0; s < 4; s++) {
    if (b0 >= P2_B0[s] && b0 < P2_B0[s] + 8) return { kind: 'slot', slot: s, patch: ((b0 - P2_B0[s]) << 3) + (b1 >> 4), struct: S_PATCH2, base: A(b0, b1 & 0x70) };
    if (b0 >= P3_B0[s] && b0 < P3_B0[s] + 8) return { kind: 'slot', slot: s, patch: ((b0 - P3_B0[s]) << 3) + (b1 >> 4), struct: S_PATCH3, base: A(b0, b1 & 0x70) };
  }
  void off;
  return null;
}

// ------------------------------------------------------------------ reads and writes
/** DT1 messages writing struct `st` (compact data `d`) at `base`, leaf by leaf as the unit answers. */
export const structMessages = (st, base, d, id = DEV) => st.leaves.map(([p, n], k) => dt1(base + p, Array.from(d.slice(st.starts[k], st.starts[k] + n)), id));
/** DT1 messages writing a full patch (patch, patch2, patch3) at `bases`. */
export const fullMessages = (bases, d, id = DEV) => FULL.flatMap((st, i) => structMessages(st, bases[i], d, id));

/** Put the data of DT1 `p` (parsed) into compact data `d` when it belongs to struct `st` at `base`. */
export function place(d, st, base, p) {
  const rel = p.addr - base;
  if (rel < 0 || rel >= st.span) return false;
  let any = false;
  p.data.forEach((b, i) => { const c = st.compact(rel + i); if (c >= 0) { d[c] = b; any = true; } });
  return any;
}

/** Read struct `st` at `base` into `d` (RQ1 of its span, then every leaf until all bytes are in). */
export async function readStruct(client, st, base, d, id = DEV, timeout = 4000) {
  const have = new Uint8Array(st.size);
  const full = () => have.every(Boolean);
  await client.request(Uint8Array.from(rq1(base, st.span, id)), {
    collect: (_m, raw) => {
      const p = parse(raw);
      if (!p?.ok || p.cmd !== 0x12) return false;
      const rel = p.addr - base;
      if (rel < 0 || rel >= st.span) return false;
      p.data.forEach((b, i) => { const c = st.compact(rel + i); if (c >= 0) { d[c] = b; have[c - st.at] = 1; } });
      return true;
    },
    complete: full, quiet: 500, resolveOnQuiet: true, timeout,
  });
  if (!full()) throw new Error(`SYSTEM-8: ${st.key} at ${hexAddr(base)} came back incomplete`);
  return d;
}

/** Read a full patch (the three structs) at `bases`. */
export async function readFull(client, bases, id = DEV, init = null) {
  const d = init ? Uint8Array.from(init) : new Uint8Array(FULL_SIZE);
  await readStruct(client, S_PATCH, bases[0], d, id);
  await readStruct(client, S_PATCH2, bases[1], d, id);
  await readStruct(client, S_PATCH3, bases[2], d, id, 8000);
  return d;
}

/** A full patch from DT1 messages of any one patch (temporary area or a slot): {data, slot, patch, temp} or null. */
export function fullFrom(msgs, init) {
  const d = Uint8Array.from(init);
  let any = false; let where = null;
  for (const m of msgs) {
    const p = parse(m);
    if (!p?.ok || p.cmd !== 0x12) continue;
    const loc = locate(p.addr);
    if (!loc || !FULL.includes(loc.struct)) continue;
    if (place(d, loc.struct, loc.base, p)) { any = true; where ??= loc; }
  }
  return any ? { data: d, where } : null;
}
