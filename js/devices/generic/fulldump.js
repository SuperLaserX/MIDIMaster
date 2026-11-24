// Complete dump: request every kind of data a device holds, in turn, and record the replies.
//
// A definition lists the requests that together hold all of its data:
//   fullDump: [request label | {request: label, timeout?, quiet?} | {label, bytes(ctx), timeout?, quiet?}]
// Without fullDump, a definition's requests are all used. Each request is sent and every SysEx
// reply recorded until `quiet` ms pass without one (the first reply may take `timeout` ms); a
// request with no reply (e.g. an empty memory) is noted and skipped.

import { splitSysex } from '../../core/midi/describe.js';

/** The steps of a complete dump for definition `def`, or null when it has no requests. */
export function fullDumpSteps(def) {
  const requests = def?.requests || [];
  const spec = def?.fullDump || (requests.length ? requests : null);
  if (!spec) return null;
  return spec.map((s) => {
    if (typeof s === 'string') return requests.find((r) => r.label === s);
    if (s.request) { const r = requests.find((x) => x.label === s.request); return r ? { ...r, ...s } : null; }
    return s;
  }).filter(Boolean);
}

const isHandshake = (d) => d[1] === 0x7e && (d[3] === 0x06 || d[3] >= 0x7c); // identity, ACK/NAK/WAIT

/** Send one step's request(s) and collect every SysEx reply until the device goes quiet. */
export function requestAndRecord({ transport, client, ctx }, step, { cancelled = () => false, progress = () => {} } = {}) {
  return new Promise((resolve) => {
    const got = [];
    let bytes = 0;
    let timer = null;
    const done = () => { clearTimeout(timer); clearInterval(poll); off(); resolve(got); };
    const out = step.bytes(ctx);
    const list = (Array.isArray(out[0]) || out[0] instanceof Uint8Array ? out : [out]).map((m) => Uint8Array.from(m));
    const parts = list.flatMap((b) => (b[0] === 0xf0 ? splitSysex(b) : [b]));
    // A request coming back (MIDI thru or a merging interface) is not part of the dump.
    const sent = new Set(parts.map((b) => b.join(',')));
    const off = transport.on('sysex', (d) => {
      if (isHandshake(d) || sent.has(Array.from(d).join(','))) return;
      got.push(Uint8Array.from(d));
      bytes += d.length;
      progress(got.length, bytes);
      clearTimeout(timer);
      timer = setTimeout(done, step.quiet ?? 2000);
    });
    const poll = setInterval(() => { if (cancelled()) done(); }, 200);
    timer = setTimeout(done, step.timeout ?? 5000);
    for (const part of parts) client.send(part).catch(() => {});
  });
}

/**
 * Run every step. Returns {messages, results: [{label, count, bytes}], cancelled}.
 * hooks: onStep(i, step), onProgress(messages, bytes), cancelled() -> bool
 */
export async function runFullDump(io, steps, { onStep = () => {}, onProgress = () => {}, cancelled = () => false } = {}) {
  const messages = [];
  const results = [];
  let total = 0;
  for (let i = 0; i < steps.length && !cancelled(); i++) {
    onStep(i, steps[i]);
    const got = await requestAndRecord(io, steps[i], { cancelled, progress: (n, b) => onProgress(messages.length + n, total + b) });
    const bytes = got.reduce((a, m) => a + m.length, 0);
    messages.push(...got);
    total += bytes;
    results.push({ label: steps[i].label, count: got.length, bytes });
  }
  return { messages, results, cancelled: cancelled() };
}
