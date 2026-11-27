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
    text: `Requests go out ${g.client.s.minGap} ms apart (${g.host.device.value.speed ? 'measured on the Connect page' : 'the default pace; Measure speed on the Connect page'}); the ${model} sends its replies at its own pace.`,
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
