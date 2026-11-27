// Shared fixtures of the SYSTEM-8 tests (not a test file itself): a PLUG-OUT container built here (no Roland file
// needed) and a device module around the simulator (roland-system8.js simulate) for the background jobs.
import S8 from '../js/devices/defs/roland-system8.js';
import * as I from '../js/devices/defs/roland-system8-install.js';
import * as M from '../js/devices/defs/roland-system8-mem.js';
import { Emitter } from '../js/core/emitter.js';

export const FAST = { rate: 1e9, bankRate: 1e9, bankGap: 0, settle: 0, timeouts: { start: 300, flow: 300, end: 300, query: 300 } };

// ------------------------------------------------------------------ a container built here (no Roland file needed)
const put32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = v >>> 24; };
const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; };
const putStr = (b, o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
const literals = (raw) => { const out = []; for (let i = 0; i < raw.length; i += 8) { out.push(0xff); for (let k = 0; k < 8; k++) out.push(raw[i + k] ?? 0); } return out; };
function region(name, model, version, init, extra = 600) {
  const raw = new Uint8Array(0x28 + extra);
  putStr(raw, 0, 'SYSTEM8_SYNINFO'); putStr(raw, 16, name); put16(raw, 0x20, model); put16(raw, 0x22, version); put32(raw, 0x24, init);
  for (let i = 0x28; i < raw.length; i++) raw[i] = (i * 31) & 0xff;
  const body = literals(raw);
  const h = new Uint8Array(0x40);
  putStr(h, 0, 'SYSTEM-8:Plugout'); putStr(h, 16, '26-1127_12:00:00'); putStr(h, 32, '0.0114A6');
  put32(h, 0x28, 0x60800000); put32(h, 0x2c, 0x40); put32(h, 0x30, body.length); put32(h, 0x34, body.reduce((a, x) => a + x, 0)); put32(h, 0x38, 0x60800000); put32(h, 0x3c, 0x120000); // the size the image claims (the init pointer lies inside)
  return Uint8Array.from([...h, ...body]);
}
const pack7 = (b) => { const out = []; for (let i = 0; i < b.length; i += 7) { const g = b.slice(i, i + 7); out.push(g.reduce((m, x, j) => m | ((x >> 7) << j), 0), ...Array.from(g, (x) => x & 0x7f)); } return out; };
/** A Code8_<slot>.Dat for `slot` (both regions linked there) of PLUG-OUT `name`. */
const built = new Map();
export function buildContainer(o = {}) {
  const k = JSON.stringify(o);
  if (!built.has(k)) built.set(k, build(o));
  return Uint8Array.from(built.get(k));
}
function build({ name = 'JUNO-106', model = 7, version = 0x107, slot = 3, slot1 = slot } = {}) {
  const image = new Uint8Array(0x200000).fill(0xff);
  image.set(region(name, model, version, 0x61600000 + slot * 0x200000 + 0x1823d), 0);
  image.set(region('SYSTEM-8', 10, 1, 0x60800000 + slot1 * 0x200000 + 0x10e21), 0x100000);
  const recs = [];
  for (let k = 0; k < 4096; k++) {
    const blk = image.subarray(k * 512, k * 512 + 512);
    recs.push(blk.every((x) => x === 0xff) ? M.dt1(M.A(0x70, 0x30, 1, 9), [1]) : M.dt1(M.A(0x70, 0x30, 0, 9), pack7(blk)));
  }
  let sum = 0; for (const x of image) sum = (sum + x) & 0xffff;
  const start = M.dt1(M.A(0x70, 0x10, 0, 0), [0]);
  const end = M.dt1(M.A(0x70, 0x10, 0, 1), [sum >> 12, (sum >> 8) & 15, (sum >> 4) & 15, sum & 15]);
  const plain = new Uint8Array(0xc0 + 4096 * 0x260);
  put32(plain, 0, 0x80); putStr(plain, 4, 'PLUGOUT_SYS_INF'); putStr(plain, 0x14, name); put16(plain, 0x24, model); put16(plain, 0x26, version);
  put32(plain, 0x30, 0x80); put32(plain, 0x34, 0x20); put32(plain, 0x40, 0xa0); put32(plain, 0x44, 0x20); put32(plain, 0x50, 0xc0); put32(plain, 0x54, 0x260); put32(plain, 0x58, 4096);
  const rec = (o, m) => { put32(plain, o, m.length); plain.set(m, o + 4); };
  rec(0x80, start); rec(0xa0, end); recs.forEach((m, i) => rec(0xc0 + i * 0x260, m));
  return I.encodeContainer(plain);
}

// ------------------------------------------------------------------ a device: the simulator behind startTransfer
export function device() {
  const sim = S8.simulate();
  const transport = new Emitter();
  const sent = [];
  transport.send = (b) => {
    const d = Uint8Array.from(b);
    sent.push(d);
    for (const r of sim.handle(d) || []) setTimeout(() => transport.emit('sysex', Uint8Array.from(r)), 1);
  };
  const entries = [];
  const library = {
    list: async (device) => entries.filter((e) => e.device === device),
    put: async (e) => { const x = { id: entries.length + 1, created: Date.now(), kind: 'sysex', notes: '', ...e, bytes: Uint8Array.from(e.bytes) }; entries.push(x); return x.id; },
  };
  const g = new Emitter();
  const errors = [];
  const client = {
    s: { minGap: 0 }, hold: null, pending: 0, send: async () => {}, sendNow: () => {},
    request: (bytes, opts) => new Promise((resolve, reject) => {
      if (client.hold) { reject(new Error(client.hold)); return; }
      const got = [];
      for (const r of sim.handle(Uint8Array.from(bytes)) || []) { const msg = { name: 'SYSEX', raw: r }; if (opts.collect(msg, r)) { got.push(msg); if (opts.complete?.(got)) break; } } // as DeviceClient keeps them
      resolve({ messages: got });
    }),
  };
  Object.assign(g, {
    entry: { id: 'roland-system8', model: 'SYSTEM-8' }, def: S8, job: null, destroyed: false, transport, client,
    host: { library }, ctx: { deviceId: 0x10, channel: 0 }, setBusy() {}, error: (e) => errors.push(e),
  });
  const choices = { form: null, confirm: true };
  const toasts = [];
  const api = { g, get ctx() { return g.ctx; }, form: async () => choices.form, confirm: async () => choices.confirm, toast: (t) => toasts.push(t) };
  return { g, sim, sent, entries, library, errors, api, choices, toasts };
}
export const addr = (m) => (m[7] << 21) | (m[8] << 14) | (m[9] << 7) | m[10];
export const sentTo = (sent, a) => sent.filter((m) => m[0] === 0xf0 && m.length > 11 && addr(m) === a);

