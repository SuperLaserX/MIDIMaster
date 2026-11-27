// Roland SYSTEM-8 PLUG-OUT containers (Code8_<slot>.Dat) and their install from the editor: the Branch Library
// keeps the containers (def.files kind 'plugout'), installs one into PLUG-OUT slot 1-3 as a background transfer
// (generic/dumpjob.js startTransfer), restores the slot's patch bank from a backup entry, and backs a slot up
// (its container + its 64 patches). See docs/devices/roland-system8.md, "PLUG-OUT install".
//
// Container (tools/system8/codedat.py, community SDK enorrmann/roland-plugout-reveng vol. IV ch. 4): chained XOR
// over 32-bit LE words (plain[i] = c[i] ^ c[i-1], c[-1] = BACADABEh); header 0x80: "PLUGOUT_SYS_INF", name[16]
// @14h, u16 model @24h, u16 version @26h, START {offset, size} @30h, END @40h, data {offset, stride, count} @50h;
// each record = u32 length + one complete SysEx. Data records `70 30 00 nn` carry 2^nn flash bytes (7-in-8),
// `70 30 01 nn` [0 / 1] a block of 00 / FF; 4096 blocks of 512 = the 2 MB flash image of a SYSTEM-8 slot:
// region 0 (the model, run by the OS CPU) in the first half, region 1 (the engine) in the second; each region =
// a 0x40-byte "SYSTEM-8:Plugout" header + Okumura LZSS. The image starts with SYNINFO ("SYSTEM8_SYNINFO", name,
// model id, version, init pointer); the init pointer says which slot the image is linked for (base 61600000h /
// 60800000h + slot * 200000h): each slot has its own build.
//
// Install (the OS handler PLUGOUT_HandleInstallDT1 at 0x60006084, OS 1.32): START `70 10 00 00` [slot] ->
// `71 10 00 00` [code]; the records, with the flow-control query `70 30 03 00` [00] before every 32nd one (its
// reply `71 30 03 00` = the OS's record counter, 4 nibbles); `71 30 00 00` [code] = record refused; END
// `70 10 00 01` + the 16-bit sum of the image as 4 nibbles -> `71 10 00 01` [code]. The OS keeps the records in RAM
// and writes the slot's flash only after END passed its checks (sum, size, region 0 checksum), so a transfer that
// stops early leaves the slot as it was. `70 30 02 00` [00] drops a running transfer (answer `71 30 02 00` [00]).
// Afterwards Roland's plugin writes its patch bank between `70 20 01 01` [64] and `70 20 01 02` [0].

import * as M from './roland-system8-mem.js';
import { startTransfer } from '../generic/dumpjob.js';
import { pickFiles } from '../../core/ui/dom.js';
import { fromBase64 } from '../../core/mainlib/format.js';

const { A, dt1, parse } = M;
const REPLY = 1 << 21;
export const ADDR = {
  start: A(0x70, 0x10, 0, 0), end: A(0x70, 0x10, 0, 1),
  data: A(0x70, 0x30, 0, 0), fill: A(0x70, 0x30, 1, 0), abort: A(0x70, 0x30, 2, 0), flow: A(0x70, 0x30, 3, 0),
  deviceType: M.PLUG.deviceType, banks: A(0x70, 0, 2, 1), perBank: A(0x70, 0, 2, 2), slotCount: M.PLUG.slotCount, slotInfo: M.PLUG.slotInfo,
  bankStart: M.PLUG.bankStart, bankEnd: M.PLUG.bankEnd,
};
export const FLOW_EVERY = 32;
export const POWER_CYCLE = 'the SYSTEM-8 did not answer: power-cycle it, then install again';
const SLOT_STRIDE = 0x200000;
const LINK_BASE = [0x61600000, 0x60800000]; // region 0 (model), region 1 (engine), slot 0
const SLOT_NAMES = ['SYSTEM-8 (slot 0)', 'PLUG-OUT 1', 'PLUG-OUT 2', 'PLUG-OUT 3'];
export const MIN_OS = 0x131; // Roland's plugin: SYSTEM-8 OS 1.31 or later
const hexb = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
export const versionText = (v) => `${(v >> 8).toString(16).toUpperCase()}.${hexb(v & 0xff)}`;

// ------------------------------------------------------------------ container
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]); return s; };
const sum7 = (a) => a.reduce((s, x) => s + x, 0);
const checksum = (body) => (128 - (sum7(body) & 0x7f)) & 0x7f;

/** Undo the container's chained XOR (32-bit LE words, IV BACADABEh). */
export function decodeContainer(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const out = Uint8Array.from(src);
  let prev = 0xbacadabe;
  for (let i = 0; i + 4 <= src.length; i += 4) {
    const w = u32(src, i);
    const p = (w ^ prev) >>> 0;
    out[i] = p & 0xff; out[i + 1] = (p >>> 8) & 0xff; out[i + 2] = (p >>> 16) & 0xff; out[i + 3] = p >>> 24;
    prev = w;
  }
  return out;
}
/** The inverse of decodeContainer (tests build containers with it). */
export function encodeContainer(plain) {
  const out = Uint8Array.from(plain);
  let prev = 0xbacadabe;
  for (let i = 0; i + 4 <= plain.length; i += 4) {
    const c = (u32(plain, i) ^ prev) >>> 0;
    out[i] = c & 0xff; out[i + 1] = (c >>> 8) & 0xff; out[i + 2] = (c >>> 16) & 0xff; out[i + 3] = c >>> 24;
    prev = c;
  }
  return out;
}

/** 7-in-8: groups of <msb byte><up to 7 bytes>; bit j of the msb byte is bit 7 of byte j. */
export function unpack7(wire, n) {
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < wire.length && o < n; i += 8) for (let j = 0; j < 7 && o < n && i + 1 + j < wire.length; j++) out[o++] = wire[i + 1 + j] | (((wire[i] >> j) & 1) << 7);
  return out;
}

/** Okumura LZSS (4 KB ring zero-filled, write position FEEh, flag byte LSB first, 1 = literal): the first `n` bytes. */
export function lzss(src, n) {
  const win = new Uint8Array(4096);
  const out = new Uint8Array(n);
  let r = 0xfee; let o = 0; let i = 0;
  while (i < src.length && o < n) {
    const flags = src[i++];
    for (let bit = 0; bit < 8 && i < src.length && o < n; bit++) {
      if (flags & (1 << bit)) { const c = src[i++]; out[o++] = c; win[r] = c; r = (r + 1) & 0xfff; continue; }
      if (i + 1 >= src.length) { i = src.length; break; }
      const pos = src[i] | ((src[i + 1] & 0xf0) << 4); const len = (src[i + 1] & 15) + 3; i += 2;
      for (let k = 0; k < len && o < n; k++) { const c = win[(pos + k) & 0xfff]; out[o++] = c; win[r] = c; r = (r + 1) & 0xfff; }
    }
  }
  return out;
}

/** SYNINFO at the start of a region's image: {name, model, version, init}. */
function synInfo(raw) {
  if (ascii(raw, 0, 16) !== 'SYSTEM8_SYNINFO' && ascii(raw, 0, 16) !== 'SYSTEM1_SYNINFO') return null;
  return { tag: ascii(raw, 0, 16), name: ascii(raw, 16, 16), model: u16(raw, 0x20), version: u16(raw, 0x22), init: u32(raw, 0x24) };
}

/** The two regions of a flash image: header, checksum of the compressed bytes (the OS checks region 0's at END),
 *  SYNINFO and the slot the region is linked for. */
export function regionsOf(image) {
  const size = image.length;
  return [0, size >> 1].map((off, k) => {
    const magic = ascii(image, off, 16);
    const family = /^(SYSTEM-[18]):Plugout$/.exec(magic)?.[1] || null;
    const hsz = u32(image, off + 0x2c); const csz = u32(image, off + 0x30); const csum = u32(image, off + 0x34); const usz = u32(image, off + 0x3c);
    let sum = 0; let syn = null;
    if (family && hsz === 0x40 && off + hsz + csz <= size) {
      for (let i = 0; i < csz; i++) sum = (sum + image[off + hsz + i]) >>> 0;
      syn = synInfo(lzss(image.subarray(off + hsz, off + hsz + Math.min(csz, 0x100)), 0x28));
    }
    const slot = syn ? Math.floor((syn.init - LINK_BASE[k]) / SLOT_STRIDE) : null;
    return { magic, family, date: ascii(image, off + 16, 16), tool: ascii(image, off + 32, 8), csz, usz, sumOk: !!family && sum === csum, syn, slot: slot !== null && slot >= 0 && slot < 8 && syn.init - LINK_BASE[k] - slot * SLOT_STRIDE < usz ? slot : null };
  });
}

class NotContainer extends Error {}

/** Address and data of a container record (a complete Roland DT1 to model 00 00 7E), or null. */
function recordOf(m) {
  if (m.length < 13 || m[0] !== 0xf0 || m[1] !== 0x41 || m[3] !== 0 || m[4] !== 0 || m[5] !== 0x7e || m[6] !== 0x12 || m[m.length - 1] !== 0xf7) return null;
  const body = Array.from(m.subarray(7, m.length - 2));
  if (checksum(body) !== m[m.length - 2]) return null;
  return { addr: (body[0] << 21) | (body[1] << 14) | (body[2] << 7) | body[3], data: m.subarray(11, m.length - 2) };
}

/**
 * Open a PLUG-OUT container. Throws NotContainer when the bytes are not one, and Error (with the reason) when it is
 * one the SYSTEM-8 cannot take (a SYSTEM-1 build, slot 0, damaged).
 * Returns {name, model, version, versionText, slot (the slot it is built for), count, wireBytes, dataBlocks,
 * fillBlocks, sum16, regions, start, end, record(i)}.
 */
export function readContainer(bytes) {
  const b = decodeContainer(bytes);
  if (b.length < 0x60 || u32(b, 0) !== 0x80 || ascii(b, 4, 16) !== 'PLUGOUT_SYS_INF') throw new NotContainer('not a PLUG-OUT container (no PLUGOUT_SYS_INF header)');
  const rec = (off) => {
    const len = off + 4 <= b.length ? u32(b, off) : 0;
    if (len < 13 || off + 4 + len > b.length) throw new Error(`damaged PLUG-OUT container (record at ${hexb(off, 6)}h)`);
    return b.subarray(off + 4, off + 4 + len);
  };
  const name = ascii(b, 0x14, 16);
  const model = u16(b, 0x24);
  const version = u16(b, 0x26);
  const start = rec(u32(b, 0x30));
  const end = rec(u32(b, 0x40));
  const base = u32(b, 0x50); const stride = u32(b, 0x54); const count = u32(b, 0x58);
  if (!count || count > 8192 || base + (count - 1) * stride + 4 > b.length) throw new Error('damaged PLUG-OUT container (record table)');
  const s = recordOf(start); const e = recordOf(end);
  if (s && e && (s.addr !== ADDR.start || e.addr !== ADDR.end)) throw new Error(`not a PLUG-OUT install (${name || 'no name'}: its START record writes ${M.hexAddr(s.addr)}, an install starts at 70 10 00 00)`);
  if (!s || s.data.length !== 1 || !e || e.data.length !== 4) throw new Error('damaged PLUG-OUT container (START / END records)');
  // the flash image the records write, block by block (the OS's own sum and size checks at END)
  const offsets = new Uint32Array(count);
  const sizes = [];
  let size = 0; let wire = start.length + end.length; let dataBlocks = 0; let fillBlocks = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = base + i * stride;
    const m = rec(offsets[i]);
    const r = recordOf(m);
    const nn = r ? r.addr & 0x7f : -1;
    const kind = r && (r.addr & ~0x7f) === ADDR.data ? 'data' : r && (r.addr & ~0x7f) === ADDR.fill ? 'fill' : null;
    if (!kind || nn > 10) throw new Error(`damaged PLUG-OUT container (record ${i} is not a flash block)`);
    const n = 1 << nn;
    if (kind === 'data' && r.data.length !== Math.floor(n / 7) + n + 1) throw new Error(`damaged PLUG-OUT container (record ${i} has ${r.data.length} bytes)`);
    if (kind === 'fill' && (r.data.length !== 1 || r.data[0] > 1)) throw new Error(`damaged PLUG-OUT container (filler record ${i})`);
    sizes.push(n); size += n; wire += m.length;
    if (kind === 'data') dataBlocks++; else fillBlocks++;
  }
  const image = new Uint8Array(size);
  let at = 0; let sum16 = 0;
  for (let i = 0; i < count; i++) {
    const r = recordOf(rec(offsets[i]));
    const n = sizes[i];
    if ((r.addr & ~0x7f) === ADDR.data) image.set(unpack7(r.data, n), at); else image.fill(r.data[0] ? 0xff : 0, at, at + n);
    at += n;
  }
  for (let i = 0; i < size; i++) sum16 = (sum16 + image[i]) & 0xffff;
  const endSum = (e.data[0] << 12) | (e.data[1] << 8) | (e.data[2] << 4) | e.data[3];
  const regions = regionsOf(image);
  const families = regions.map((r) => r.family);
  if (families.some((f) => f === 'SYSTEM-1') || (count === 2048 && size === 0x100000)) throw new Error(`${name || 'this file'} is a SYSTEM-1 / SYSTEM-1m build (like the plugins' Code1.Dat): the SYSTEM-8 takes their Code8_<slot>.Dat files`);
  if (families.some((f) => f !== 'SYSTEM-8') || size !== 0x200000) throw new Error('not a SYSTEM-8 PLUG-OUT image (its regions are not SYSTEM-8:Plugout, or it is not 2 MB)');
  if (sum16 !== endSum) throw new Error(`damaged PLUG-OUT container (the image sum ${hexb(sum16, 4)}h differs from its END record ${hexb(endSum, 4)}h)`);
  if (!regions.every((r) => r.sumOk)) throw new Error('damaged PLUG-OUT container (a region checksum does not match)');
  const slots = regions.map((r) => r.slot);
  if (slots.some((x) => x === null) || slots[0] !== slots[1]) throw new Error('PLUG-OUT container without a slot: its regions are linked for no slot (or for different ones)');
  const syn = regions[0].syn;
  return {
    name, model, version, versionText: versionText(version), slot: slots[0], count, wireBytes: wire, dataBlocks, fillBlocks, sum16, regions,
    syn: { name: syn.name, model: syn.model, version: syn.version },
    start: Uint8Array.from(start), end: Uint8Array.from(end),
    record: (i) => rec(offsets[i]),
  };
}

const describe = (c) => `${c.name} ${c.versionText}`;
/** def.files identify(): the Branch Library name and notes of a container, null when the file is not one. */
export function identify(bytes, filename = '') {
  let c;
  try { c = readContainer(bytes); } catch (err) { if (err instanceof NotContainer) return null; throw err; }
  const fromName = /Code8_(\d)\.dat$/i.exec(filename || '');
  const notes = [
    `PLUG-OUT container: ${c.name}, model id ${c.model}, version ${c.versionText}, built for ${SLOT_NAMES[c.slot]} (Code8_${c.slot}.Dat)`,
    `${c.count} records (${c.dataBlocks} flash blocks, ${c.fillBlocks} fillers), ${Math.round(c.wireBytes / 1024)} KB to send; image sum ${hexb(c.sum16, 4)}h and region checksums correct`,
    `regions built ${c.regions[0].date} (tool ${c.regions[0].tool})`,
    ...(c.syn.name !== c.name || c.syn.model !== c.model || c.syn.version !== c.version ? [`its image says ${c.syn.name} ${c.syn.model} ${versionText(c.syn.version)}`] : []),
    ...(fromName && Number(fromName[1]) !== c.slot ? [`the file name says slot ${fromName[1]}, the image is linked for slot ${c.slot}`] : []),
    ...(filename ? [`file ${filename}`] : []),
  ].join('; ');
  if (c.slot === 0) throw new Error(`${describe(c)} is built for slot 0, the SYSTEM-8 engine itself (it comes with the system update); the PLUG-OUT slots are 1-3`);
  return { name: `${describe(c)} for PLUG-OUT ${c.slot}`, notes };
}

// ------------------------------------------------------------------ messages
const withDev = (m, dev) => { const out = Uint8Array.from(m); out[2] = dev & 0x7f; return out; };
/** The container's START record with the target slot (and the flags, 0 = install into the flash). */
export function startMessage(c, slot, dev = M.DEV, flags = 0) { return Uint8Array.from(dt1(ADDR.start, [(flags & 0x70) | (slot & 15)], dev)); }
const isReply = (addr, n) => (raw) => { const p = parse(raw); return !!(p?.ok && p.cmd === 0x12 && p.addr === addr + REPLY && (n === undefined || p.data.length === n)); };
const dataOf = (raw) => parse(raw).data;
const nibbles = (a) => a.reduce((v, x) => (v << 4) | (x & 15), 0);

/** A slot record (`71 00 01 00`, 48 nibbles): OS version, engine interface, model id (FFFFh = empty), version, name. */
export function parseSlotInfo(slot, d) {
  let name = '';
  for (let i = 0; i < 16; i++) { const ch = ((d[16 + 2 * i] & 15) << 4) | (d[17 + 2 * i] & 15); if (!ch) break; name += String.fromCharCode(ch); }
  const model = nibbles(d.slice(8, 12));
  return { slot, os: nibbles(d.slice(0, 4)), iface: nibbles(d.slice(4, 8)), model, version: nibbles(d.slice(12, 16)), name: name.trim(), empty: model === 0xffff };
}
export const slotText = (s) => (!s ? 'unknown' : s.empty ? 'empty' : `${s.name || `model ${s.model}`} ${versionText(s.version)}`);

const START_CODES = {
  7: 'the SYSTEM-8 refused the install (code 07: it is busy with another screen or job; go to its play screen and install again)',
  8: 'the SYSTEM-8 refused the slot number (code 08)',
  0x64: 'the SYSTEM-8 was still in an earlier transfer and has dropped it now (code 64h): install again',
};
const END_CODES = {
  2: 'the image did not arrive complete (code 02: not 2 MB)',
  3: 'the image sum did not match (code 03: records were lost or damaged on the way)',
  4: 'the image check failed (code 04: region checksum or unpacking)',
  8: 'the slot number was lost (code 08)',
};
const KEPT = 'The slot keeps its PLUG-OUT (the SYSTEM-8 writes the flash only after a complete transfer).';

/**
 * A pacer: wait so that the bytes go out at `rate` bytes per second plus `gap` ms per message. Allows running
 * `lag` ms ahead (more while the page is hidden: Chrome slows its timers then; the flow control bounds a burst).
 */
export function pacer({ rate = 32000, gap = 0, now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal = null } = {}) {
  let due = -Infinity;
  return async (bytes) => {
    const lag = typeof document !== 'undefined' && document.hidden ? 1000 : 20;
    const t = now();
    due = Math.max(due, t - lag) + gap + (bytes * 1000) / rate;
    const wait = due - t - lag;
    if (wait > 0) await sleep(wait);
    if (signal?.aborted) throw new Error('Stopped.');
  };
}

/**
 * Install container `c` into `slot` inside a transfer job (io from startTransfer). opts:
 *   dev            device ID (10h)
 *   listen(fn)     -> off: every incoming SysEx (to catch a refused record at any time)
 *   sendRaw(bytes) sends outside io (the abort after a Stop)
 *   bank           the patch bank to write afterwards: DT1 messages (bankMessages), or null
 *   rate           bytes per second of the records (32000, the SDK web installer's pace)
 *   bankRate, bankGap  the patch bank: bytes per second and ms per message (restore.py's proven pace)
 *   sleep, now, settle, timeouts {start, flow, end, query} (ms)   waits (tests)
 * Resolves {slot, info (the slot record afterwards), flows (the OS's record counters), bank}.
 */
export async function installPlugout(io, c, slot, { dev = M.DEV, listen, sendRaw = null, bank = null, rate = 32000, bankRate = 50000, bankGap = 4, sleep, now, settle = 1000, timeouts = {} } = {}) {
  const T = { start: 5000, flow: 5000, end: 20000, query: 5000, ...timeouts };
  let refused = null;
  const off = listen ? listen((raw) => { if (isReply(ADDR.data, 1)(raw)) refused = dataOf(raw)[0]; }) : () => {};
  const refusedError = (i) => new Error(`the SYSTEM-8 refused record ${i} (71 30 00 00, code ${hexb(refused)}h). ${KEPT}`);
  let running = false;
  const flows = [];
  const total = c.count + (bank ? bank.length : 0);
  try {
    if (slot < 1 || slot > 3) throw new Error('the PLUG-OUT slots are 1-3');
    if (c.slot !== slot) throw new Error(`${describe(c)} is built for PLUG-OUT ${c.slot}: use its Code8_${slot}.Dat for PLUG-OUT ${slot}`);
    io.progress(0, total, 'START');
    io.send(startMessage(c, slot, dev));
    const s = await io.waitFor(isReply(ADDR.start, 1), T.start);
    if (!s) throw new Error('the SYSTEM-8 did not answer START (71 10 00 00): nothing was sent. Check that input and output are SYSTEM-8 CTRL, then install again.');
    const code = dataOf(s)[0];
    if (code) throw new Error(START_CODES[code] || `the SYSTEM-8 refused the install (code ${hexb(code)}h)`);
    running = true;
    const pace = pacer({ rate, sleep, now, signal: io.signal });
    for (let i = 0; i < c.count; i++) {
      if (i % FLOW_EVERY === FLOW_EVERY - 1) {
        io.send(dt1(ADDR.flow, [0], dev));
        const r = await io.waitFor((raw) => isReply(ADDR.flow, 4)(raw) || isReply(ADDR.data, 1)(raw), T.flow);
        if (r && isReply(ADDR.data, 1)(r)) refused = dataOf(r)[0];
        if (refused !== null) throw refusedError(i);
        if (!r) throw new Error(`${POWER_CYCLE} (no flow-control reply after record ${i} of ${c.count}). ${KEPT}`);
        const counter = nibbles(dataOf(r));
        flows.push(counter);
        if (counter !== i) throw new Error(`the SYSTEM-8 counted ${counter} of the ${i} records sent: records were lost on the way. ${KEPT} Install again.`);
      }
      const m = withDev(c.record(i), dev);
      await pace(m.length);
      io.send(m);
      if (refused !== null) throw refusedError(i);
      if ((i & 15) === 15 || i === c.count - 1) io.progress(i + 1, total, `record ${i + 1} of ${c.count}`);
    }
    io.progress(c.count, total, 'END: the SYSTEM-8 checks the image and writes the slot');
    io.send(withDev(c.end, dev));
    const e = await io.waitFor((raw) => isReply(ADDR.end, 1)(raw) || isReply(ADDR.data, 1)(raw), T.end);
    if (e && isReply(ADDR.data, 1)(e)) throw new Error(`the SYSTEM-8 refused END (code ${hexb(dataOf(e)[0])}h). ${KEPT}`);
    if (!e) throw new Error(`${POWER_CYCLE} (no answer to END within 20 s; check the slot afterwards)`);
    running = false;
    const endCode = dataOf(e)[0];
    if (endCode) throw new Error(`${END_CODES[endCode] || `the SYSTEM-8 refused the image (code ${hexb(endCode)}h)`}. ${KEPT}`);
    // the slot record afterwards
    if (settle) await (sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(settle);
    io.send(dt1(ADDR.slotInfo, [slot], dev));
    const q = await io.waitFor(isReply(ADDR.slotInfo, 48), T.query);
    if (!q) throw new Error(`the install was accepted (END 00), but the SYSTEM-8 did not answer the slot query afterwards: power-cycle it and check PLUG-OUT ${slot}${bank ? ', then restore its patches from the backup entry' : ''}`);
    const info = parseSlotInfo(slot, dataOf(q));
    if (info.model !== c.syn.model || info.version !== c.syn.version) throw new Error(`the install was accepted (END 00), but PLUG-OUT ${slot} now reports ${slotText(info)}`);
    // the patch bank, as Roland's plugin writes it
    let sent = 0;
    if (bank) {
      const bpace = pacer({ rate: bankRate, gap: bankGap, sleep, now, signal: io.signal });
      for (const m of bank) {
        await bpace(m.length);
        io.send(m);
        sent++;
        if ((sent & 63) === 0 || sent === bank.length) io.progress(c.count + sent, total, `patch bank: message ${sent} of ${bank.length}`);
      }
    }
    return { slot, info, flows, bank: sent };
  } catch (err) {
    // drop the transfer on the SYSTEM-8 (after a Stop, a refused record or a missing reply): nothing is written
    if (running && sendRaw) { try { sendRaw(dt1(ADDR.abort, [0], dev)); } catch { /* port gone */ } }
    throw err;
  } finally {
    off();
  }
}

// ------------------------------------------------------------------ patch banks
const FULL_PATCH = M.FULL_SIZE;
/** The patches of one slot in DT1 messages: Map slot -> Map patch -> {data, have} (have = bytes placed). */
export function slotPatches(msgs) {
  const out = new Map();
  for (const m of msgs) {
    const p = parse(m);
    if (!p?.ok || p.cmd !== 0x12) continue;
    const l = M.locate(p.addr);
    if (!l || l.kind !== 'slot') continue;
    if (!out.has(l.slot)) out.set(l.slot, new Map());
    const s = out.get(l.slot);
    if (!s.has(l.patch)) s.set(l.patch, { data: new Uint8Array(FULL_PATCH), have: new Uint8Array(FULL_PATCH) });
    const e = s.get(l.patch);
    const rel = p.addr - l.base;
    p.data.forEach((b, i) => { const c = l.struct.compact(rel + i); if (c >= 0) { e.data[c] = b; e.have[c] = 1; } });
  }
  return out;
}
const complete = (e) => e.have.every(Boolean);
/** {slot, patches: [64 x data]} when the messages hold the 64 complete patches of one slot, else null. */
export function bankOf(msgs) {
  const by = slotPatches(msgs);
  if (by.size !== 1) return null;
  const [slot, ps] = [...by.entries()][0];
  if (ps.size !== 64 || ![...ps.values()].every(complete)) return null;
  return { slot, patches: Array.from({ length: 64 }, (_, i) => ps.get(i).data) };
}
/** The patch bank as Roland's plugin writes it after an install: 70 20 01 01 [64], the 64 patches, 70 20 01 02 [flag]. */
export function bankMessages(patches, slot, dev = M.DEV, flag = 0) {
  return [
    Uint8Array.from(dt1(ADDR.bankStart, [64], dev)),
    ...patches.flatMap((d, i) => M.fullMessages(M.slotBases(slot, i), d, dev).map((m) => Uint8Array.from(m))),
    Uint8Array.from(dt1(ADDR.bankEnd, [flag], dev)),
  ];
}
// what a backup entry records about its slot (machine-readable tail of its notes)
const BACKUP_TAG = /PLUG-OUT backup: slot (\d), model (\d+), version ([0-9A-F]+)h/;
export const backupTag = (slot, info) => `PLUG-OUT backup: slot ${slot}, model ${info.model}, version ${hexb(info.version, 3)}h`;
export function backupOf(notes = '') { const m = BACKUP_TAG.exec(notes); return m ? { slot: Number(m[1]), model: Number(m[2]), version: parseInt(m[3], 16) } : null; }

/** Library entries that hold a whole patch bank of one PLUG-OUT slot: [{entry, slot, patches, backup}]. */
export function bankSources(entries, splitMessages) {
  const out = [];
  for (const e of entries) {
    if (e.kind && e.kind !== 'sysex') continue;
    const b = bankOf(splitMessages(e.bytes));
    if (b) out.push({ entry: e, slot: b.slot, patches: b.patches, backup: backupOf(e.notes) });
  }
  return out;
}

// ------------------------------------------------------------------ reading the 64 patches of a slot (backup)
/**
 * Read the 64 patches of `slot` inside a transfer job (RQ1 per struct, the unit's DT1 leaves collected).
 * Resolves the messages as the unit sent them (6144 for a slot), in order.
 */
export async function readSlotPatches(io, slot, { dev = M.DEV, listen, timeout = 4000 } = {}) {
  const all = [];
  for (let i = 0; i < 64; i++) {
    const bases = M.slotBases(slot, i);
    for (let k = 0; k < 3; k++) {
      const st = M.FULL[k];
      const have = new Uint8Array(st.size);
      const got = [];
      await new Promise((resolve, reject) => {
        let timer = null;
        const finish = (err) => { clearTimeout(timer); off(); io.signal?.removeEventListener?.('abort', onAbort); if (err) reject(err); else resolve(); };
        const onAbort = () => finish(new Error('Stopped.'));
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(have.every(Boolean) ? null : new Error(`${SLOT_NAMES[slot]} ${'ABCDEFGH'[i >> 3]}-${(i & 7) + 1}: the ${st.key} struct came back incomplete`)), timeout); };
        const off = listen((raw) => {
          const p = parse(raw);
          if (!p?.ok || p.cmd !== 0x12) return;
          const rel = p.addr - bases[k];
          if (rel < 0 || rel >= st.span) return;
          got.push(Uint8Array.from(raw));
          p.data.forEach((_, j) => { const c = st.compact(rel + j); if (c >= 0) have[c - st.at] = 1; });
          if (have.every(Boolean)) finish(null); else arm();
        });
        io.signal?.addEventListener?.('abort', onAbort);
        arm();
        try { io.send(M.rq1(bases[k], st.span, dev)); } catch (err) { finish(err); }
      });
      all.push(...got);
    }
    io.progress(i + 1, 64, `${SLOT_NAMES[slot]} ${'ABCDEFGH'[i >> 3]}-${(i & 7) + 1}`);
  }
  return all;
}

// ------------------------------------------------------------------ the unit (normal requests, before a job)
async function query(api, addr, data, n) {
  const r = await api.g.client.request(Uint8Array.from(dt1(addr, data, devOf(api))), {
    collect: (_m, raw) => isReply(addr, n)(raw), complete: (got) => got.length > 0, timeout: 3000,
  });
  const m = r?.messages?.[0];
  const raw = m?.raw ?? m; // the device client keeps {name, sub, raw}
  if (!raw) throw new Error(`the SYSTEM-8 did not answer ${M.hexAddr(addr)}`);
  return dataOf(raw);
}
const devOf = (api) => (api.ctx?.deviceId ?? M.DEV) & 0x7f;
/** Device type, OS version and the four slot records (70 00 ..). */
export async function readSlots(api) {
  const type = (await query(api, ADDR.deviceType, [0], 1))[0];
  if (type !== 2) throw new Error(`this unit answers as device type ${type}, not a SYSTEM-8 (2)`);
  const n = (await query(api, ADDR.slotCount, [0], 1))[0];
  const slots = [];
  for (let s = 0; s < Math.min(n, 4); s++) slots.push(parseSlotInfo(s, await query(api, ADDR.slotInfo, [s], 48)));
  return { type, os: slots[0]?.os ?? 0, slots };
}

/** Why `c` cannot go into `slot` of a unit with `slots` (readSlots), or null. Roland's plugin rules. */
export function installProblem(c, slot, unit) {
  if (slot < 1 || slot > 3) return 'the PLUG-OUT slots are 1-3';
  if (c.slot !== slot) return `${describe(c)} is built for PLUG-OUT ${c.slot} (its Code8_${c.slot}.Dat). Each slot has its own build: import the Code8_${slot}.Dat of the same plugin for PLUG-OUT ${slot}.`;
  if (unit) {
    if (unit.os < MIN_OS) return `the SYSTEM-8 runs OS ${versionText(unit.os)}; PLUG-OUTs need ${versionText(MIN_OS)} or later`;
    const other = unit.slots.find((s) => s.slot !== slot && s.slot > 0 && !s.empty && s.model === c.syn.model);
    if (other) return `${c.name} is already in PLUG-OUT ${other.slot}: the SYSTEM-8 keeps one copy of each PLUG-OUT (Roland's plugin refuses this too). Install it there, or replace that slot first.`;
  }
  return null;
}

// ------------------------------------------------------------------ the actions
const stamp = () => new Date().toLocaleString();
const listenOn = (api) => (fn) => api.g.transport.on('sysex', fn);
async function libraryEntries(api) { return api.g.host.library.list(api.g.entry.id); }
function splitter(bytes) {
  const out = [];
  let s = -1;
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0xf0) s = i; else if (bytes[i] === 0xf7 && s >= 0) { out.push(bytes.subarray(s, i + 1)); s = -1; } }
  return out;
}
const joinMsgs = (msgs) => { const out = new Uint8Array(msgs.reduce((a, m) => a + m.length, 0)); let o = 0; for (const m of msgs) { out.set(m, o); o += m.length; } return out; };
const seconds = (c, bank) => Math.round(c.wireBytes / 32000 + 2 + (bank ? (6144 * 4) / 1000 + 1.3e6 / 50000 : 0));

/** Branch Library action on a 'plugout' entry: install it into a PLUG-OUT slot, then restore a patch bank. */
export async function installAction(api, entry, opts = {}) {
  const c = readContainer(entry.bytes);
  const unit = await readSlots(api);
  // backups of this PLUG-OUT first (newest first), then other whole slot banks (complete dumps: the PLUG-OUT unknown)
  const sources = bankSources(await libraryEntries(api), splitter).filter((s) => !s.backup || s.backup.model === c.syn.model)
    .sort((x, y) => (y.backup ? 1 : 0) - (x.backup ? 1 : 0) || (y.entry.created || 0) - (x.entry.created || 0));
  const slotOpts = [1, 2, 3].map((s) => ({ value: String(s), label: `PLUG-OUT ${s}: now ${slotText(unit.slots[s])}${s === c.slot ? '' : ' (this container is not built for it)'}` }));
  const bankOpts = [{ value: '', label: 'None: leave the patch memory of the slot as it is' },
    ...sources.map((s, i) => ({ value: String(i), label: `${s.entry.name} (64 patches of PLUG-OUT ${s.slot}${s.backup ? `, ${c.name}` : ''})` }))];
  const pick = await api.form(`Install ${describe(c)}`, [
    { key: 'slot', label: 'Into', type: 'select', value: String(c.slot), options: slotOpts },
    { key: 'bank', label: 'Then restore the patch bank from', type: 'select', value: sources[0]?.backup ? '0' : '', options: bankOpts },
  ], 'Next', `Built for PLUG-OUT ${c.slot}, ${Math.round(c.wireBytes / 1024)} KB. Back up the slot first (PLUG-OUT patches page: Back up a PLUG-OUT slot): the SYSTEM-8 cannot send a PLUG-OUT back. The PLUG-OUT goes into the flash and stays; the patch bank is written as Roland's plugin writes it, but the SYSTEM-8 keeps it only until it is switched off (checked: no DT1 write into user memory survives a power cycle).`);
  if (!pick) return null;
  const slot = Number(pick.slot);
  const problem = installProblem(c, slot, unit);
  if (problem) throw new Error(problem);
  const src = pick.bank === '' ? null : sources[Number(pick.bank)];
  const now = unit.slots[slot];
  const ok = await api.confirm(`Install into PLUG-OUT ${slot}`,
    `PLUG-OUT ${slot} (now ${slotText(now)}) and its 64 patches are replaced by ${describe(c)}${src ? `; then its 64 patches are written from "${src.entry.name}"` : ''}. Do not switch the SYSTEM-8 off and do not use it until the install ends (about ${seconds(c, src)} s; keep this tab in front). If it stops answering, power-cycle it and install again: the slot keeps its old PLUG-OUT unless the transfer completed.`,
    'Install', true);
  if (!ok) return null;
  const dev = devOf(api);
  const bank = src ? bankMessages(src.patches, slot, dev, 0) : null;
  const g = api.g;
  const res = await startTransfer(g, {
    title: `PLUG-OUT install (PLUG-OUT ${slot})`,
    text: `${describe(c)} into PLUG-OUT ${slot}: START, ${c.count} records with flow control every ${FLOW_EVERY}, END${bank ? ', then the patch bank' : ''}.`,
    warning: 'Do not switch the SYSTEM-8 off and do not use it until this ends.',
    run: (io) => installPlugout(io, c, slot, { dev, listen: listenOn(api), sendRaw: (b) => g.transport.send(Uint8Array.from(b)), bank, ...opts }),
  });
  if (res) api.toast(`PLUG-OUT ${slot} now holds ${slotText(res.info)}${res.bank ? `; ${res.bank} patch-bank messages written` : ''}.`, 'good', 10000);
  return res;
}

/** Find the container of what a slot holds: a library entry, else a file the user picks (the Roland Cloud plugin's). */
async function containerFor(api, slot, info, entries) {
  const fits = (c) => c.slot === slot && c.syn.model === info.model && c.syn.version === info.version && c.syn.name === info.name;
  for (const e of entries.filter((x) => x.kind === 'plugout')) {
    try { if (fits(readContainer(e.bytes))) return { entry: e }; } catch { /* another file */ }
  }
  const go = await api.confirm('Container for the backup', `No container of ${slotText(info)} for PLUG-OUT ${slot} is in the Branch Library. Choose its file: the Roland Cloud plugin keeps it as Code8_${slot}.Dat (C:\\Program Files\\Common Files\\VST3\\Roland\\${info.name}\\Script\\). Cancel backs up the 64 patches only.`, 'Choose the file');
  if (!go) return null;
  const files = await pickFiles('.dat,.Dat', false);
  const f = files?.[0];
  if (!f) return null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const c = readContainer(bytes);
  if (!fits(c)) throw new Error(`${f.name} is ${describe(c)} built for PLUG-OUT ${c.slot}; PLUG-OUT ${slot} holds ${slotText(info)}`);
  return { bytes, file: f.name };
}

/** Back up a PLUG-OUT slot: the container of its PLUG-OUT (library or file) + its 64 patches, as a pair of entries. */
export async function backupAction(api, presetSlot = null, opts = {}) {
  const unit = await readSlots(api);
  let slot = presetSlot;
  if (!slot) {
    const pick = await api.form('Back up a PLUG-OUT slot', [{ key: 'slot', label: 'Slot', type: 'select', value: '3', options: [1, 2, 3].map((s) => ({ value: String(s), label: `PLUG-OUT ${s}: ${slotText(unit.slots[s])}` })) }], 'Next',
      'Saves the PLUG-OUT container of the slot and its 64 patches in the Branch Library (the SYSTEM-8 cannot send a PLUG-OUT back: the container is the file that was installed).');
    if (!pick) return null;
    slot = Number(pick.slot);
  }
  const info = unit.slots[slot];
  if (!info || info.empty) throw new Error(`PLUG-OUT ${slot} is empty`);
  const lib = api.g.host.library;
  const device = api.g.entry.id;
  const cont = await containerFor(api, slot, info, await libraryEntries(api));
  const dev = devOf(api);
  const base = `PLUG-OUT ${slot} backup ${stamp()}: ${slotText(info)}`;
  const msgs = await startTransfer(api.g, {
    title: `Backup of PLUG-OUT ${slot}`,
    text: `Reading the 64 patches of PLUG-OUT ${slot} (${slotText(info)}), about 15 seconds.`,
    run: (io) => readSlotPatches(io, slot, { dev, listen: listenOn(api), ...opts }),
  });
  if (!msgs) return null;
  let contNote = 'no container (the patches only)';
  if (cont?.entry) contNote = `container: library entry "${cont.entry.name}"`;
  if (cont?.bytes) {
    await lib.put({ device, name: `${base} (container)`, bytes: cont.bytes, kind: 'plugout', notes: `${identify(cont.bytes, cont.file).notes}; ${backupTag(slot, info)}` });
    contNote = `container: entry "${base} (container)"`;
  }
  await lib.put({ device, name: `${base} (64 patches)`, bytes: joinMsgs(msgs), kind: 'sysex', notes: `The 64 patches of PLUG-OUT ${slot} (${msgs.length} DT1 messages as the unit sent them); ${contNote}. To restore: Install the container with this entry as its patch bank. ${backupTag(slot, info)}` });
  api.g.emit?.('library');
  api.toast(`PLUG-OUT ${slot} backed up in the Branch Library: "${base}"${cont ? ' (container and 64 patches)' : ' (64 patches; no container)'}.`, 'good', 10000);
  return { slot, info, messages: msgs.length, container: !!cont };
}

// ------------------------------------------------------------------ PLUG-OUTs kept in the Head Library
/** The Head Library's PLUG-OUT containers (rows of kind 'plugout' for the SYSTEM-8, e.g. the "PlugOuts" sub-library
 *  that tools/system8/plugouts_to_library.mjs writes): {lib, rows}. */
export async function headLibraryContainers(api) {
  const shell = api.g.host?.shell;
  if (!shell?.mainLibrary) throw new Error('The Head Library is not available here.');
  const lib = await shell.mainLibrary();
  const isOurs = (d) => (typeof d === 'string' ? d : d?.id) === 'roland-system8';
  const rows = (await lib.allRows()).filter((r) => r.kind === 'plugout' && isOurs(r.device)).sort((a, b) => a.name.localeCompare(b.name));
  return { lib, rows };
}

/** "Install a PLUG-OUT from the Head Library...": pick a container there, then the same install as from the Branch
 *  Library (installAction: slot, patch bank, checks, the background transfer). */
export async function installFromHeadLibraryAction(api, opts = {}) {
  const { lib, rows } = await headLibraryContainers(api);
  if (!rows.length) throw new Error('The Head Library has no SYSTEM-8 PLUG-OUT files. Put them there first (for example the PlugOuts folder made from the Roland plugins on this computer).');
  const pick = await api.form('Install a PLUG-OUT from the Head Library', [
    { key: 'row', label: 'PLUG-OUT', type: 'select', value: '0', options: rows.map((r, i) => ({ value: String(i), label: `${r.name}${r.subName ? ` (${r.subName})` : ''}` })) },
  ], 'Next', 'Each file is made for one slot: "for PLUG-OUT 2" goes only into PLUG-OUT 2. Next you choose the slot and whether to put its patches back afterwards.');
  if (!pick) return null;
  const r = rows[Number(pick.row)];
  const patch = await lib.getPatch(r.sub, r.id);
  if (!patch?.native?.bytes) throw new Error(`"${r.name}" holds no PLUG-OUT file`);
  const bytes = fromBase64(patch.native.bytes);
  readContainer(bytes); // refuses anything the SYSTEM-8 cannot take, with the reason
  return installAction(api, { bytes, name: patch.name, notes: patch.notes || '' }, opts);
}

// ------------------------------------------------------------------ keeping a bank over MIDI
// What the OS does with the patch-bank markers (OS 1.32, master core 0; doc "Saving over MIDI"): `70 20 01 01` [n]
// opens the "Receiving" screen (FUN_60028EAA: n expected patches, a 15 s timer); its job (FUN_60028E52) counts the
// patches written since they were last saved (the parameter manager's flags of PAT / PAT2 / PAT3), which must all
// be in one slot and number n; after `70 20 01 02` [flag] it shows "Writing!" and saves the slot's 64 patches into
// the flash (FUN_60028CB8 -> FUN_60028C40, the same save WRITE uses). Patches written into another slot since the
// last save stop it; 15 s without progress reloads the slot from the flash instead. On the unit (2026-11-27, right after a
// power cycle, twice, the second time after the plugin's queries) the markers did not open that screen: the condition
// sits in the kernel's SysEx library, which the OS dump does not hold. keepBank stays for a later test; no page offers it.
export const KEEP_WAIT = 15000;
/** The messages that make the OS save a whole bank: the bank markers around the 64 patches of one slot. */
export function keepBankMessages(msgs, dev = M.DEV) {
  return [Uint8Array.from(dt1(ADDR.bankStart, [64], dev)), ...msgs.map((m) => Uint8Array.from(m)), Uint8Array.from(dt1(ADDR.bankEnd, [1], dev))];
}
/** Inside a job: read the 64 patches of `slot` as the SYSTEM-8 holds them and send them back between the markers,
 *  then give the SYSTEM-8 time to save them. */
export async function keepBank(io, slot, { dev = M.DEV, listen, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now, wait = KEEP_WAIT, readTimeout } = {}) {
  const msgs = await readSlotPatches(io, slot, { dev, listen, ...(readTimeout ? { timeout: readTimeout } : {}) });
  const out = keepBankMessages(msgs, dev);
  const pace = pacer({ rate: 50000, gap: 4, sleep, now, signal: io.signal });
  for (const [i, m] of out.entries()) {
    await pace(m.length);
    io.send(m);
    if ((i & 63) === 63 || i === out.length - 1) io.progress(i + 1, out.length + 1, `sending back: message ${i + 1} of ${out.length}`);
  }
  io.progress(out.length, out.length + 1, 'the SYSTEM-8 saves the bank ("Writing!")');
  await sleep(wait);
  return { slot, messages: out.length };
}
export const _test = { NotContainer, SLOT_NAMES, LINK_BASE, splitter, START_CODES, END_CODES };
