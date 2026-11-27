// Device objects (patches, performances, settings) shared by the object editor and the
// connect-time loader: reading an object, sending messages, and slot (memory) names.
//
// Slot definitions may add, besides fetch/recall/store (see views/editor.js):
//   names(bank) -> [name...] | null      names known without asking the device (e.g. presets)
//   fetchName(api, bank, i) -> name      a quick name-only read
//   scanBank(api, bank, onName)          reads a whole bank's names itself (for banks that
//                                        can only be read by selecting each slot)
//   scanNote(bank) -> string             shown before scanBank runs (it may change the device)
//   autoNames: [bank...]                 banks whose names are read when the device connects

import { formDialog, confirmDialog, toast } from '../../core/ui/dom.js';

export const asList = (out) => (!out ? [] : Array.isArray(out[0]) || out[0] instanceof Uint8Array ? out : [out]);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Send one message or a list. SysEx goes through the throttled queue; channel messages go
 * out at once unless SysEx is queued ahead of them, in which case they queue behind it so
 * the order holds (e.g. "switch to patch mode" before "select patch").
 */
/** The capability a message needs over a connection (GenericContext.link). */
export function capabilityOf(b) {
  const s = b[0] & 0xf0;
  if (b[0] === 0xf0) return 'sysex';
  if (s === 0xb0) return [98, 99, 6, 38].includes(b[1]) ? 'nrpn' : 'cc';
  if (s === 0xc0) return 'pc';
  if (s === 0x80 || s === 0x90) return 'notes';
  if (s === 0xa0) return 'poly';
  if (s === 0xd0) return 'pressure';
  if (s === 0xe0) return 'bend';
  return null;
}

/** May the connection carry message b? Poly / channel pressure and pitch bend travel wherever notes do,
 *  unless the link names them itself. */
function linkAllows(g, b) {
  const cap = capabilityOf(b);
  if (!cap) return true;
  const l = g.link;
  if (['poly', 'pressure', 'bend'].includes(cap) && l?.can && !l.can.includes(cap)) return g.can('notes');
  return g.can(cap);
}

export function sendOut(g, out, key) {
  g.recentSent ??= new Map();
  const now = performance.now();
  let list = asList(out).map((bytes) => Uint8Array.from(bytes));
  // a transfer with exclusive use of the port (dumpjob.js startTransfer, e.g. a PLUG-OUT install)
  if (g.job?.exclusive && list.length) {
    if (!g._jobToast || now - g._jobToast > 8000) { g._jobToast = now; toast(`Not sent: ${g.job.title} is running.`, 'warn', 5000); }
    return;
  }
  // messages the connection cannot carry (def.link: e.g. SysEx over DIN) are not sent; say so once a while
  if (g.link) {
    const dropped = list.filter((b) => !linkAllows(g, b));
    if (dropped.length) {
      list = list.filter((b) => linkAllows(g, b));
      if (!g._linkToast || now - g._linkToast > 8000) { g._linkToast = now; toast(`Not sent: ${g.cannot(capabilityOf(dropped[0]))}`, 'warn', 6000); }
    }
  }
  const ordered = list.some((b) => b[0] === 0xf0) && list.length > 1;
  for (const b of list) {
    if (b[0] === 0xf0) g.recentSent.set(hex(b), now);
    if (b[0] === 0xf0 || ordered || g.client.pending) {
      g.client.send(b, key && !ordered ? { key } : {}).catch((err) => g.error(err, 'Send'));
    } else g.client.sendNow(b);
  }
  if (g.recentSent.size > 200) for (const [k, t] of g.recentSent) if (now - t > 3000) g.recentSent.delete(k);
}

/** True when `raw` is an echo of something sent in the last few seconds (MIDI thru, merge). */
export function isEcho(g, raw) {
  const t = g.recentSent?.get(hex(raw));
  return t !== undefined && performance.now() - t < 3000;
}

export async function requestObject(g, bytes, match, decode) {
  const reply = await g.client.request(Uint8Array.from(bytes), { match: (_m, r) => match(r), timeout: g.client.s.timeout + 1500 });
  return decode(reply.raw ?? reply, g.ctx);
}

/** The `api` handed to definition callbacks. */
export function objectApi(g, obj, extra = {}) {
  return {
    g, obj,
    get ctx() { return g.ctx; },
    get data() { return g.objectData[obj.key] || obj.init(); },
    send: (out, key) => sendOut(g, out, key),
    request: (bytes, match, decode) => requestObject(g, bytes, match, decode),
    setData: (data) => g.setObjectData(obj.key, data),
    form: formDialog,
    confirm: confirmDialog,
    toast,
    refresh: () => {},
    ...extra,
  };
}

export const canFetch = (obj) => !!(obj.fetch || obj.request);

/** Read an object from the device and store it in g.objectData. */
export async function loadObject(g, obj, api = objectApi(g, obj)) {
  if (g.cannot && !g.can(obj.needs)) throw new Error(g.cannot(obj.needs));
  const data = obj.fetch ? await obj.fetch(api) : await requestObject(g, obj.request(g.ctx), obj.match, obj.decode);
  g.setObjectData(obj.key, data);
  return data;
}

/** Names known for a bank: static names from the definition, else names read so far. */
export function bankNames(g, obj, bank) {
  const fixed = obj.slots?.names?.(bank, g.ctx);
  if (fixed) return { get: (i) => fixed[i] ?? null, fixed: true };
  const m = g.slotNames[obj.key];
  return { get: (i) => m?.get(`${bank}:${i}`) ?? null, fixed: false };
}

export const canScan = (obj, bank, ctx) => {
  const s = obj.slots;
  if (!s || s.names?.(bank, ctx)) return false;
  if (s.scannable && !s.scannable(bank, ctx)) return false;
  return !!(s.scanBank || s.fetchName || s.fetch);
};

/** Read every name in a bank, one slot at a time, so other messages can go in between. */
export async function readBankNames(g, obj, bank, { onProgress, shouldStop } = {}) {
  const s = obj.slots;
  if (g.cannot && !g.can(s.needs ?? obj.needs)) throw new Error(g.cannot(s.needs ?? obj.needs));
  const api = objectApi(g, obj);
  const count = typeof s.count === 'function' ? s.count(bank, g.ctx) : s.count;
  if (s.scanBank) {
    await s.scanBank(api, bank, (i, name) => { g.setSlotName(obj.key, bank, i, name); onProgress?.(i + 1, count); }, shouldStop);
    return;
  }
  for (let i = 0; i < count; i++) {
    if (shouldStop?.()) break;
    const name = s.fetchName ? await s.fetchName(api, bank, i) : s.name?.(await s.fetch(api, bank, i)) ?? '';
    g.setSlotName(obj.key, bank, i, name);
    onProgress?.(i + 1, count);
  }
}
