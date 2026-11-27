// Background dumps: a complete dump (the definition's requests in turn, fulldump.js) or a recording
// of a dump started on the device. The job belongs to the device (GenericContext.job), not to the
// Branch Library page: it goes on while other pages of the device are shown, the page shows it again
// when it is opened, and the result is saved in the Branch Library by itself with a message when it is
// done. One job at a time. Leaving the device (another device, the home page) asks first (shell/app.js).
//
// g.job: {kind: 'dump' | 'capture', title, text, started, step: {i, n, label}, count, bytes, last,
//         percent (null when unknown), left (seconds, or null), stop(save)}; g emits 'job' on every
// change (with null once it is over) and 'library' after it saved something.

import { toast } from '../../core/ui/dom.js';
import { describeMessage } from '../../core/midi/describe.js';
import { runFullDump, estimateSeconds, durationText, dumpEntries } from './fulldump.js';

export const joinMsgs = (msgs) => {
  const out = new Uint8Array(msgs.reduce((a, m) => a + m.length, 0));
  let o = 0;
  for (const m of msgs) { out.set(m, o); o += m.length; }
  return out;
};

/** (messages) -> true when they hold sounds (patches, performances...): items of an object with a translator. */
export function soundTester(g) {
  const keys = new Set((g.def?.objects || []).filter((o) => o.toCommon).map((o) => o.key));
  return (msgs) => {
    if (!g.def?.libraryItems || !keys.size) return false;
    try { return g.def.libraryItems(msgs, g.ctx).some((it) => keys.has(it.object)); } catch { return false; }
  };
}

const isHandshake = (d) => d[1] === 0x7e && (d[3] === 0x06 || d[3] >= 0x7c); // identity and ACK/NAK/WAIT
const elapsedText = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim(); };

function begin(g, job) {
  if (g.job) throw new Error(`A ${g.job.title.toLowerCase()} is still running.`);
  g.job = job;
  // a request from another page would cut a dump short (the Virus TI keeps only the latest request;
  // many devices drop a dump to answer): requests wait for the end, live edits still go out
  if (job.kind === 'dump' && g.client) g.client.hold = `A complete dump of the ${g.entry.model} is running: reading from it now would interrupt the dump. Wait until it is saved, or stop it on the Branch Library page.`;
  g.emit('job', job);
  return job;
}

function end(g, job) {
  if (g.job === job) g.job = null;
  if (g.client && job.kind === 'dump') g.client.hold = null;
  g.setBusy(0);
  g.emit('job', null);
}

function update(g, job, patch) {
  Object.assign(job, patch);
  if (!g.destroyed) g.setBusy(1, job.busy?.() || job.title);
  g.emit('job', job);
}

/** Save a finished dump in the Branch Library: each bank of sounds as an entry of its own, the rest
 *  together (dumpEntries); returns the number of entries. */
async function saveDump(g, results, { base, notes }) {
  const lib = g.host.library;
  const device = g.entry.id;
  const entries = dumpEntries(results, soundTester(g));
  if (entries.length < 2) {
    const msgs = results.flatMap((r) => r.messages);
    await lib.put({ device, name: base, bytes: joinMsgs(msgs), kind: 'sysex', notes });
    return 1;
  }
  for (const e of entries) {
    await lib.put({ device, name: `${base}: ${e.label ?? 'complete dump'}`, bytes: joinMsgs(e.messages), kind: 'sysex', notes: `Complete dump (${base}): ${e.merged.join('; ')}` });
  }
  return entries.length;
}

/**
 * Start a complete dump of `steps` (fullDumpSteps, the ones the user chose) in the background.
 * Resolves when it is over (saved, cancelled or nothing received).
 */
export function startCompleteDump(g, steps) {
  const model = g.entry.model;
  const timed = steps.some((s) => s.seconds);
  const total = estimateSeconds(steps);
  let cancel = false;
  let keep = false;
  const abort = new AbortController();
  const job = begin(g, {
    kind: 'dump', title: 'Complete dump', started: Date.now(), count: 0, bytes: 0, last: '',
    step: { i: 0, n: steps.length, label: steps[0]?.label || '' }, percent: 0, left: timed ? total : null,
    text: '',
    busy: () => `Complete dump ${job.step.i + 1}/${job.step.n}${job.left != null ? `, ${durationText(job.left)} left` : ''}`,
    stop: (save = false) => { keep = save; cancel = true; abort.abort(); },
  });
  const t0 = performance.now();
  const offClose = g.on('destroyed', () => abort.abort()); // leaving the device ends it at once
  return (async () => {
    let run = { messages: [], results: [] };
    try {
      run = await runFullDump({ transport: g.transport, client: g.client, ctx: g.ctx }, steps, {
        cancelled: () => cancel || g.destroyed,
        signal: abort.signal,
        onStep: (i, s) => {
          const doneSec = estimateSeconds(steps.slice(0, i));
          const spent = (performance.now() - t0) / 1000;
          // the definition's estimate, scaled by how fast the steps so far really went
          const left = timed ? (i && doneSec ? Math.max(0, spent * (total / doneSec) - spent) : total) : null;
          update(g, job, { step: { i, n: steps.length, label: s.label }, percent: Math.round((timed ? doneSec / total : i / steps.length) * 100), left });
        },
        onProgress: (n, bytes) => update(g, job, { count: n, bytes }),
      });
    } catch (err) { g.error(err, 'Complete dump'); } finally { offClose?.(); end(g, job); }
    const took = elapsedText(performance.now() - t0);
    // leaving the device stops the dump; what arrived is kept (the shell asked first)
    if (g.destroyed) { cancel = true; keep = true; }
    if (cancel && !keep) { toast(`${model}: complete dump cancelled.`, 'warn'); return; }
    const results = run.results.filter((r) => r.count);
    if (!results.length) { toast(`${model}: the complete dump got no reply. Check the MIDI ports and the device ID on the Connect page.`, 'bad', 8000); return; }
    const empty = run.results.filter((r) => !r.count).map((r) => r.label);
    const when = new Date().toLocaleString();
    const base = `${model} ${cancel ? 'partial dump' : 'complete dump'} ${when}`;
    try {
      const n = await saveDump(g, run.results, { base, notes: `${cancel ? 'Stopped early; ' : ''}Complete dump: ${run.results.map((r) => `${r.label} ${r.count ? `${r.count} msg` : 'no reply'}`).join('; ')}` });
      toast(`${model} ${cancel ? 'dump stopped' : 'complete dump finished'} (${took}): saved in the Branch Library as ${n === 1 ? 'one entry' : `${n} entries`}${empty.length ? `; no reply for ${empty.length} request${empty.length === 1 ? '' : 's'}` : ''}.`, 'good', 12000);
      g.emit('library');
    } catch (err) { g.error(err, 'Saving the complete dump'); }
  })();
}

/**
 * Record SysEx in the background until `quiet` ms pass after the last message, `expect` messages are
 * in (count or (list) => bool), or the user stops it; then save it as one Branch Library entry.
 * requestBytes: messages sent first (a dump request), or null for a dump started on the device.
 */
export function startCapture(g, { requestBytes = null, name = null, notes = '', text = '', quiet = 2500, expect = null, splitSysex = null }) {
  const model = g.entry.model;
  const complete = typeof expect === 'function' ? expect : expect ? (list) => list.length >= expect : null;
  const messages = [];
  let timer = null;
  let finished = false;
  const job = begin(g, {
    kind: 'capture', title: name ? 'Complete dump' : 'Recording SysEx', started: Date.now(), count: 0, bytes: 0, last: 'Waiting...',
    step: null, percent: null, left: null, text,
    busy: () => `Recording SysEx: ${job.count} message(s)`,
    stop: (save = true) => finish(save),
  });
  const off = g.transport.on('sysex', (d) => {
    if (isHandshake(d)) return;
    messages.push(Uint8Array.from(d));
    update(g, job, { count: messages.length, bytes: job.bytes + d.length, last: describeMessage(d, g.def?.describe || g.host.shell?.device?.instance?.decode) });
    clearTimeout(timer);
    if (complete?.(messages)) { finish(true); return; }
    timer = setTimeout(() => finish(true), quiet);
  });
  // the device goes away (another device opened): stop listening and keep what arrived
  const offClose = g.on('destroyed', () => finish(true));
  async function finish(save) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    off();
    offClose();
    end(g, job);
    if (!save) { if (!g.destroyed) toast('Recording cancelled.', 'warn'); return; }
    if (!messages.length) { toast(`${model}: nothing was received.`, 'warn'); return; }
    const label = name || `${model} dump ${new Date().toLocaleString()}`;
    try {
      await g.host.library.put({ device: g.entry.id, name: label, bytes: joinMsgs(messages), kind: 'sysex', notes });
      toast(`${model}: "${label}" saved in the Branch Library (${messages.length} message${messages.length === 1 ? '' : 's'}, ${job.bytes} bytes).`, 'good', 8000);
      g.emit('library', label);
    } catch (err) { g.error(err, 'Saving the dump'); }
  }
  if (requestBytes) for (const m of splitSysex ? splitSysex(requestBytes) : [requestBytes]) g.client.send(m).catch((err) => g.error(err, 'Dump request'));
  return job;
}

/**
 * A long transfer to the device (e.g. a SYSTEM-8 PLUG-OUT install: 4096 SysEx records with flow control),
 * run by the definition's own `run(io)` as a background job with exclusive use of the port: while it
 * runs, requests are refused (client.hold) and sendOut sends nothing else (job.exclusive).
 *   io.send(bytes)                 sends at once (no queue); Web MIDI keeps the order
 *   io.waitFor(match, ms)          the next incoming SysEx that match(raw) takes, or null after ms
 *   io.progress(done, total, text) progress (bytes or records)
 *   io.signal                      aborted when the user stops it or leaves the device
 * opts: {title, text, warning (shown on the Branch Library page while it runs)}. Resolves with run()'s
 * result; a thrown error is shown (with run's own words: e.g. "power-cycle the unit") and never retried.
 */
export function startTransfer(g, { title, text = '', warning = '', run }) {
  const abort = new AbortController();
  const t0 = performance.now();
  const job = begin(g, {
    kind: 'transfer', title, text: [text, warning].filter(Boolean).join(' '), started: Date.now(), count: 0, bytes: 0, last: '',
    step: { i: 0, n: 1, label: '' }, percent: 0, left: null, exclusive: true,
    busy: () => `${title}: ${job.percent ?? 0} %`,
    stop: () => abort.abort(),
  });
  g.client.hold = `${title} is running: nothing else can be sent to the ${g.entry.model} until it ends.`;
  const offClose = g.on('destroyed', () => abort.abort());
  const io = {
    signal: abort.signal,
    send: (bytes) => { if (abort.signal.aborted) throw new Error('Stopped.'); g.transport.send(Uint8Array.from(bytes)); job.count++; job.bytes += bytes.length; },
    waitFor: (match, ms) => new Promise((resolve, reject) => {
      let timer = null;
      const done = (v) => { clearTimeout(timer); off(); abort.signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => { clearTimeout(timer); off(); reject(new Error('Stopped.')); };
      const off = g.transport.on('sysex', (d) => { try { if (match(d)) done(Uint8Array.from(d)); } catch { /* not this one */ } });
      timer = setTimeout(() => done(null), ms);
      abort.signal.addEventListener('abort', onAbort);
    }),
    progress: (doneN, total, label = '') => {
      const spent = (performance.now() - t0) / 1000;
      update(g, job, { step: { i: Math.min(doneN, total - 1), n: total, label }, percent: Math.round((doneN / Math.max(1, total)) * 100), left: doneN ? Math.max(0, (spent / doneN) * (total - doneN)) : null });
    },
  };
  return (async () => {
    try {
      const r = await run(io);
      toast(`${g.entry.model}: ${title} done (${elapsedText(performance.now() - t0)}).`, 'good', 10000);
      return r;
    } catch (err) {
      if (abort.signal.aborted) toast(`${g.entry.model}: ${title} stopped.`, 'warn', 8000);
      else g.error(err, title);
      return null;
    } finally {
      offClose?.();
      g.client.hold = null;
      end(g, job);
    }
  })();
}
