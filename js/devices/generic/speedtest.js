// Measure how fast a device really takes and sends MIDI, instead of assuming 1980s DIN MIDI (31250
// baud, about 3125 bytes/s, and a gap after every SysEx message). A device on USB MIDI can often take
// messages back to back; an old one may need time to process each.
//
// 1. Reply speed: an edit buffer is read and its bytes timed (request to last byte: a lower bound of
//    what the link carries, with the device's own turnaround in it).
// 2. Send speed: bursts of parameter changes (one per parameter, each to a new value) go out at
//    shrinking gaps; after each burst the edit buffer is read back and every change checked. The
//    smallest gap with nothing lost is the device's pace.
// 3. The edit buffer is sent back as it was and read again to confirm.
// Only the edit buffer of one object is touched. The result is kept with the device's settings
// (speed: {sendGap, receiveBps, measured, object}) and used by its request queue.

import { readParam, writeParam, paramRange } from '../../core/model/memmap.js';
import { loadObject, canFetch, asList } from './objects.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SPEED_GAPS = [0, 2, 5, 10, 20, 50, 100, 200];
export const BULK_GAPS = [0, 20, 50, 100, 200, 400, 800];

/** The object a speed test uses: readable, with a whole-object send and parameters sent one by one. */
export function speedObject(def) {
  return (def?.objects || []).find((o) => canFetch(o) && o.sendAll && o.sendParam && !o.notLive && testParams(o, o.init()).length >= 4) || null;
}

/** Up to n parameters that can each be moved by one step and sent alone. */
function testParams(obj, data, n = 16) {
  // plain parameters only: none that changes others (after, relayout), depends on others (dynamic) or
  // has its own message (send)
  const ok = obj.params.filter((p) => !p.readOnly && !p.hidden && !p.dynamic && !p.after && !p.relayout && !p.send && p.kind !== 'char');
  const usable = ok.filter((p) => { const r = paramRange(p); return r.max > r.min; });
  // spread over the object, one per byte
  const seen = new Set();
  const picked = [];
  const step = Math.max(1, Math.floor(usable.length / n));
  for (let i = 0; i < usable.length && picked.length < n; i += step) {
    const p = usable[i];
    if (seen.has(p.offset)) continue;
    seen.add(p.offset);
    picked.push(p);
  }
  return picked;
}

/** The value one step from the current one, inside the range (option lists: the next option). */
function nextValue(p, v) {
  if (p.options?.length) {
    const vals = p.options.map(([x]) => x);
    const i = vals.indexOf(v);
    return vals[i >= 0 && i + 1 < vals.length ? i + 1 : Math.max(0, i - 1)];
  }
  const { min, max } = paramRange(p);
  return v < max ? v + 1 : Math.max(min, v - 1);
}

/**
 * Run the test on device module g. onProgress(text). Returns {object, receiveBps, sendGap, runs:
 * [{gap, ok, total}], restored}. Throws when the device does not answer.
 */
export async function measureSpeed(g, { onProgress = () => {}, gaps = SPEED_GAPS } = {}) {
  const obj = speedObject(g.def);
  if (!obj) throw new Error(`The ${g.entry.model} editor has no edit buffer the test can use.`);
  if (!g.connected) throw new Error('Choose the MIDI ports on the Connect page first.');
  await g.client.drain();
  const ctx = g.ctx;
  const send = (bytes, at) => (at === undefined ? g.transport.send(bytes) : g.transport.send(bytes, at));

  // 1. reply speed: time the bytes of a read
  onProgress(`Reading the ${obj.label}...`);
  let bytes = 0;
  const off = g.transport.on('sysex', (d) => { bytes += d.length; });
  const t0 = performance.now();
  let original;
  try { original = Uint8Array.from(await loadObject(g, obj)); } finally { off(); }
  const seconds = (performance.now() - t0) / 1000;
  const receiveBps = Math.round(bytes / Math.max(0.001, seconds));

  const params = testParams(obj, original);
  const runs = [];
  let sendGap = null;
  let bulkGap = null; // ms a whole buffer needs before the next message
  let bulkBytes = 0;
  try {
    for (const gap of gaps) {
      onProgress(`Sending ${params.length} changes ${gap} ms apart...`);
      const expected = new Map(params.map((p) => [p, nextValue(p, readParam(original, p))]));
      const msgs = [];
      for (const [p, v] of expected) {
        // each message as the editor sends it, for the value on its own
        const view = Uint8Array.from(original);
        writeParam(view, p, v);
        msgs.push(...asList(obj.sendParam(p, readParam(view, p), view, ctx)).map((m) => Uint8Array.from(m)));
      }
      const start = performance.now() + 20;
      msgs.forEach((m, i) => send(m, start + i * gap));
      await sleep(20 + msgs.length * gap + 300);
      const back = await loadObject(g, obj);
      const ok = [...expected].filter(([p, v]) => readParam(back, p) === v).length;
      runs.push({ gap, ok, total: expected.size });
      // put it back before the next burst
      for (const m of asList(obj.sendAll.build(original, ctx))) send(Uint8Array.from(m));
      await sleep(300);
      if (ok === expected.size) { sendGap = gap; break; }
    }
    // long messages: the whole buffer three times back to back (each with one more change), then a
    // parameter change; all of it must be there when read back. Passing means a long message needs no
    // wait for its bytes to go out (USB), so the queue stops allowing DIN-MIDI time after it.
    // (the gap after each whole buffer: shrinking until something is lost)
    for (const gap of sendGap === null ? [] : BULK_GAPS) {
      onProgress(`Sending the whole buffer three times, ${gap} ms apart...`);
      const d = Uint8Array.from(original);
      const want = [];
      const start = performance.now() + 20;
      let at = start;
      for (let k = 0; k < 3 && k < params.length - 1; k++) {
        const p = params[k];
        writeParam(d, p, nextValue(p, readParam(original, p)));
        want.push([p, readParam(d, p)]);
        for (const m of asList(obj.sendAll.build(Uint8Array.from(d), ctx))) { bulkBytes = m.length; send(Uint8Array.from(m), at); at += Math.max(gap, sendGap); }
      }
      const last = params[params.length - 1];
      const view = Uint8Array.from(d);
      writeParam(view, last, nextValue(last, readParam(original, last)));
      want.push([last, readParam(view, last)]);
      for (const m of asList(obj.sendParam(last, readParam(view, last), view, ctx))) send(Uint8Array.from(m), at);
      await sleep(at - performance.now() + 600);
      const back = await loadObject(g, obj);
      const ok = want.filter(([p, v]) => readParam(back, p) === v).length;
      runs.push({ gap, ok, total: want.length, bulk: true });
      for (const m of asList(obj.sendAll.build(original, ctx))) send(Uint8Array.from(m));
      await sleep(Math.max(300, gap));
      if (ok === want.length) { bulkGap = gap; break; }
    }
  } finally {
    // restore and confirm
    onProgress(`Restoring the ${obj.label}...`);
    for (const m of asList(obj.sendAll.build(original, ctx))) send(Uint8Array.from(m));
    await sleep(400);
  }
  const after = await loadObject(g, obj);
  const restored = params.every((p) => readParam(after, p) === readParam(original, p));
  // every byte compared too (a device may keep status bytes of its own, e.g. an "edited" flag)
  const diff = [];
  for (let i = 0; i < Math.max(original.length, after.length); i++) if (original[i] !== after[i]) diff.push(i);
  // the pace whole buffers were taken at, as bytes/s: the queue waits (bytes / sendBps) after a long
  // message; back to back (0 ms) means no wait at all (a link faster than DIN MIDI)
  const sendBps = bulkGap === null ? null : bulkGap === 0 ? 1000000 : Math.round(bulkBytes / (bulkGap / 1000));
  return { object: obj.label, receiveBps, sendBps, bulkGap, bytes, seconds, sendGap, runs, restored, diff, params: params.length };
}
