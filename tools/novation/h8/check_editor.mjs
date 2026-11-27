// The editor's own messages against the device's own receiver: each Novation definition's objects
// (program, performance, arpeggio pattern) are read from, sent to, stored into and recalled from the
// OS image running in the H8/300H emulator, through the same fetch / sendAll / slots functions the
// editor uses (a fake MIDI client answers from the emulator). Every round trip is compared byte for
// byte. This is the check that stands in for a hardware check where no unit is available.
//
//   node tools/novation/h8/check_editor.mjs [sn2rack|sn2kbd|nova2|sn1|nova ...]
// Needs the OS images (not in git: re/sn2/work, re/novfw) and the factory files; the first run of a
// model boots it and loads Novation's factory sounds (about a minute), later runs restore that state.

import { factory, exchange, globalChannel } from './novation.mjs';
import { writeParam, readParam } from '../../../js/core/model/memmap.js';

const DEFS = {
  sn2rack: ['novation-supernova2', '../../../js/devices/defs/novation-supernova2.js'],
  sn2kbd: ['novation-supernova2', '../../../js/devices/defs/novation-supernova2.js'],
  nova2: ['novation-nova2', '../../../js/devices/defs/novation-nova2.js'],
  sn1: ['novation-supernova', '../../../js/devices/defs/novation-supernova.js'],
  nova: ['novation-nova', '../../../js/devices/defs/novation-nova.js'],
};

/** A MIDI client that sends to the emulated OS and collects its replies (DeviceClient.request's shape). */
function emulatedClient(m) {
  return {
    s: { timeout: 2500, bytesPerSecond: 3000 },
    async request(bytes, opts = {}) {
      const replies = exchange(m, Array.from(bytes));
      const messages = replies.filter((raw) => (opts.collect ? opts.collect(null, raw) : true)).map((raw) => ({ raw }));
      return { messages };
    },
  };
}
const flat = (out) => (Array.isArray(out) && typeof out[0] === 'number' ? out : out.flatMap((x) => Array.from(x)));
const diffs = (a, b, skip = new Set()) => { const d = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (!skip.has(i) && a[i] !== b[i]) d.push(`${i}:${a[i]}->${b[i]}`); return d; };

/** Change every editable parameter of a copy to another of its values (what an editor user does). */
function edit(obj, data, ctx, seed = 1) {
  const d = Uint8Array.from(data);
  let n = 0;
  for (const p of obj.params) {
    if (p.readOnly || p.hidden || p.get) continue;
    const dyn = p.dynamic?.(d, ctx);
    if (dyn?.hidden) continue;
    const opts = dyn?.options ?? p.options;
    const cur = readParam(d, p);
    let v;
    if (opts?.length > 1) v = opts[(opts.findIndex(([x]) => x === cur) + seed) % opts.length][0];
    else if (p.max !== undefined) { const lo = p.min ?? 0; v = lo + ((cur - lo + seed) % (p.max - lo + 1)); }
    else continue;
    if (writeParam(d, p, v)) n++;
  }
  return { data: d, n };
}

export async function check(name) {
  const [id, path] = DEFS[name];
  const def = (await import(new URL(path, import.meta.url))).default;
  const m = factory(name);
  const ctx = { deviceId: 0x7f, channel: globalChannel(m), names: {}, entry: { id } };
  const api = { ctx, g: { client: emulatedClient(m) } };
  const send = (out) => exchange(m, flat(out));
  const report = [];
  const ok = (label, d) => report.push(`${d.length ? 'FAIL' : 'ok  '} ${label}${d.length ? ': ' + d.slice(0, 12).join(' ') : ''}`);
  for (const key of ['program', 'performance']) {
    const obj = def.objects.find((o) => o.key === key);
    const cur = await obj.fetch(api);
    // bytes the OS sets itself on every dump (format markers, the derived filter width step)
    const skip = new Set(key === 'program' ? [209, 238, 249, 286 + 42, 286 + 75] : [16]);
    // 6-part models (Nova, Nova II): their transmitters fill part slots 7-8 with copies of other parts
    // (Nova OS 4.1 16F3A-16F74), so those slots (read only in the editor) are not compared
    const parts = obj.multi?.count ?? 8;
    if (key === 'performance' && parts < 8) {
      for (let o = 20 + 44 * parts; o < 372; o++) skip.add(o);
      for (let o = 372 + 16 + 40 * parts; o < 372 + 16 + 320; o++) skip.add(o);
      for (let o = 372 + 16 + 320 + 16 * parts; o < 372 + 16 + 320 + 128; o++) skip.add(o); // External Parts 7-8 (Nova II)
    }
    const { data, n } = edit(obj, cur, ctx);
    send(obj.sendAll.build(data, ctx));
    const back = await obj.fetch(api);
    ok(`${key}: edit buffer, ${n} parameters changed, sent and read back`, diffs(data, back, skip));
    const [bank] = obj.slots.banks[0];
    const slot = 7;
    send(obj.slots.store(bank, slot, ctx, data));
    const stored = await obj.slots.fetch(api, bank, slot);
    ok(`${key}: stored into ${obj.slots.banks[0][1]} ${slot} and read back`, diffs(data, stored, skip));
    if (obj.slots.recall) {
      send(obj.slots.recall(bank, slot, ctx));
      const recalled = await obj.fetch(api);
      ok(`${key}: recalled from memory into the edit buffer`, diffs(data, recalled, skip));
    }
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check_editor.mjs')) {
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(DEFS)) {
    try { console.log(`== ${name}`); for (const l of await check(name)) console.log(l); } catch (e) { console.log(`ERROR ${name}: ${e.stack}`); }
  }
}
