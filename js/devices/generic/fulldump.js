// Complete dump: request every kind of data a device holds, in turn, and record the replies.
//
// A definition lists the requests that together hold all of its data:
//   fullDump: [request label | {request: label, ...options} | {label, bytes(ctx), ...options}]
//   options: timeout (ms for the first reply), quiet (ms after the last reply), expect (the number of
//            replies, or (got) => true once complete: the step ends at once when they are in, with no
//            timer, so a background tab is not slowed by Chrome's timer throttling), seconds (how long
//            the step usually takes, for the estimate), group (steps listed under one name in the
//            start dialog), optional (with group: steps the user may leave out together, e.g. 'ROM banks'),
//            accept(raw) (the replies that belong to this step; others, e.g. a knob the user turns or
//            the answer to another page's request, are not recorded and do not count)
// Without fullDump, a definition's requests are all used. Each request is sent and every SysEx
// reply recorded until the expected replies are in, or `quiet` ms pass without one (the first reply
// may take `timeout` ms); a request with no reply (e.g. an empty memory) is noted and skipped.

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
export function requestAndRecord({ transport, client, ctx }, step, { cancelled = () => false, progress = () => {}, signal = null } = {}) {
  return new Promise((resolve) => {
    const got = [];
    let bytes = 0;
    let timer = null;
    let over = false;
    const done = () => { if (over) return; over = true; clearTimeout(timer); clearInterval(poll); off(); signal?.removeEventListener('abort', done); resolve(got); };
    // stopping ends the step at once (the poll below is slowed in a background tab)
    signal?.addEventListener('abort', done);
    const out = step.bytes(ctx);
    const list = (Array.isArray(out[0]) || out[0] instanceof Uint8Array ? out : [out]).map((m) => Uint8Array.from(m));
    const parts = list.flatMap((b) => (b[0] === 0xf0 ? splitSysex(b) : [b]));
    // A request coming back (MIDI thru or a merging interface) is not part of the dump.
    const sent = new Set(parts.map((b) => b.join(',')));
    const complete = typeof step.expect === 'function' ? step.expect : step.expect ? (list) => list.length >= step.expect : null;
    const off = transport.on('sysex', (d) => {
      if (isHandshake(d) || sent.has(Array.from(d).join(',')) || (step.accept && !step.accept(d))) return;
      got.push(Uint8Array.from(d));
      bytes += d.length;
      progress(got.length, bytes);
      clearTimeout(timer);
      if (complete?.(got)) { done(); return; }
      // still waiting for more: a reply may be slow (expected), or the dump has ended (quiet)
      timer = setTimeout(done, complete ? Math.max(step.quiet ?? 2000, step.timeout ?? 5000) : step.quiet ?? 2000);
    });
    const poll = setInterval(() => { if (cancelled() || signal?.aborted) done(); }, 200);
    timer = setTimeout(done, step.timeout ?? 5000);
    for (const part of parts) client.send(part).catch(() => {});
  });
}

/**
 * How a complete dump is kept in the Branch Library: each step that brought sounds (patches,
 * performances, banks of them) is an entry of its own, named after the step; the rest (settings,
 * templates, system data) goes into one entry together. step.separate: true / false overrides.
 * isSound(messages) -> bool. Returns [{label, messages, merged: [labels]}].
 */
export function dumpEntries(results, isSound) {
  const own = [];
  const rest = { label: null, messages: [], merged: [] };
  for (const r of results) {
    if (!r.count) continue;
    const separate = r.step?.separate ?? isSound(r.messages);
    if (separate) own.push({ label: r.label, messages: r.messages, merged: [r.label] });
    else {
      rest.messages.push(...r.messages);
      const name = r.step?.group || r.label;
      if (!rest.merged.includes(name)) rest.merged.push(name);
    }
  }
  if (rest.messages.length) own.push({ ...rest, label: own.length ? 'Settings and other data' : null });
  return own;
}

/** The optional groups of `steps`: [{group, steps, seconds}] in order. */
export function optionalGroups(steps) {
  const out = [];
  for (const s of steps) {
    if (!s.optional) continue;
    let g = out.find((x) => x.group === (s.group || s.label));
    if (!g) out.push(g = { group: s.group || s.label, steps: [], seconds: 0 });
    g.steps.push(s);
    g.seconds += s.seconds || 0;
  }
  return out;
}

/** Estimated seconds for `steps` (the definition's own estimates; steps without one count 1 s). */
export const estimateSeconds = (steps) => steps.reduce((n, s) => n + (s.seconds ?? 1), 0);

/** "about 1 h 12 min" / "about 4 min" / "under a minute". */
export function durationText(sec) {
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  return m < 60 ? `about ${m} min` : `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * Run every step. Returns {messages, results: [{label, count, bytes}], cancelled}.
 * hooks: onStep(i, step), onProgress(messages, bytes), cancelled() -> bool; signal: an AbortSignal
 * that stops it at once
 */
export async function runFullDump(io, steps, { onStep = () => {}, onProgress = () => {}, cancelled = () => false, signal = null } = {}) {
  const messages = [];
  const results = [];
  let total = 0;
  const stop = () => cancelled() || !!signal?.aborted;
  for (let i = 0; i < steps.length && !stop(); i++) {
    onStep(i, steps[i]);
    const got = await requestAndRecord(io, steps[i], { cancelled, signal, progress: (n, b) => onProgress(messages.length + n, total + b) });
    const bytes = got.reduce((a, m) => a + m.length, 0);
    messages.push(...got);
    total += bytes;
    results.push({ label: steps[i].label, count: got.length, bytes, messages: got, step: steps[i] });
  }
  return { messages, results, cancelled: stop() };
}
