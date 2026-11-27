// Import objects from a Kurzweil file (KRZ/K25/K26) into a K2000 over MIDI.
//
// Programs, keymaps, effects and setups go over SysEx WRITE. Sample audio can only
// enter the K2000 through the Sample Dump Standard, and each SDS transfer creates a
// one-sample soundblock. So for every soundblock with audio:
//   1. each audio range of the file is sent by SDS into a free temporary ID,
//   2. the temporary soundblock is dumped back to learn where the K2000 put the audio,
//   3. the original soundblock (all headers, loops, names, flags) is written at its
//      final ID with its sample pointers moved to that address,
//   4. the temporary soundblocks are deleted.
// The K2000 allocates sample RAM like a stack and never moves or frees audio when an
// object is deleted (only Delete Everything or a restart does), so the audio stays
// where step 2 found it. The flip side: audio from a cancelled import stays allocated.

import { T, TYPE_BY_ID } from '../model/types.js';
import { Soundblock } from '../model/soundblock.js';
import { Keymap } from '../model/keymap.js';
import { Program, TAG } from '../model/program.js';
import { put16be, put32be, s32be, u16be, sleep } from '../../../core/bits.js';
import { SampleDump, sdsTransferSeconds, SDS_MAX_SAMPLES } from '../../../core/midi/sds.js';
import { sdsNumberForId } from '../sds-ids.js';
import { readAudio, programIssue, convertProgramForK2000, completeProgram, K2600_ONLY_TYPES } from './krz.js';

const ORDER = { [T.SOUNDBLOCK]: 0, [T.KEYMAP]: 1, [T.PROGRAM]: 2 };
const REMAPPED_TYPES = new Set([T.SOUNDBLOCK, T.KEYMAP, T.PROGRAM]);
const CAL_KEYMAP_FIELDS = [7, 11]; // keymap 2 and keymap 1, u16 in the CAL segment

export const keyOf = (type, id) => `${type}:${id}`;

/** Keymap IDs used by a program (layer CAL segments). */
export function programKeymaps(data) {
  const ids = new Set();
  try {
    const p = new Program(data);
    for (const s of p.segments) {
      if (s.tag !== TAG.CAL) continue;
      for (const f of CAL_KEYMAP_FIELDS) { const v = u16be(data, s.offset + 1 + f); if (v) ids.add(v); }
    }
  } catch { /* unparseable program */ }
  return [...ids];
}

/** Sample IDs used by a keymap (header default plus per-entry samples). */
export function keymapSamples(data) {
  try { return [...new Keymap(data).referencedSamples()].filter((id) => id > 0); } catch { return []; }
}

/** Audio ranges of a soundblock: overlapping header spans merged, in file words. */
export function soundblockRanges(block) {
  const spans = block.headers.filter((hd) => hd.inRam && hd.end >= hd.start).map((hd) => ({
    lo: Math.min(hd.start, hd.altStart, hd.loopStart),
    hi: Math.max(hd.end, hd.altStart, hd.loopStart),
    rate: hd.rate,
    headers: [hd.index],
  })).filter((s) => s.lo >= 0).sort((a, b) => a.lo - b.lo);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.lo <= last.hi + 1) { last.hi = Math.max(last.hi, s.hi); last.headers.push(...s.headers); } else merged.push({ ...s });
  }
  return merged;
}

/** Describe every object of a parsed file for the import table. */
export function describeObjects(krz) {
  const items = krz.objects.map((o) => {
    const it = { key: keyOf(o.type, o.id), type: o.type, id: o.id, name: o.name, data: o.data, size: o.data.length, deps: [], status: 'ok', issue: null, audio: null };
    if (K2600_ONLY_TYPES.has(o.type)) { it.status = 'unsupported'; it.issue = 'K2500/K2600 object, not available on the K2000'; return it; }
    if (!TYPE_BY_ID[o.type]) { it.status = 'unsupported'; it.issue = `object type ${o.type} does not exist on the K2000`; return it; }
    if (o.type === T.PROGRAM) {
      it.issue = programIssue(o.data);
      if (it.issue) it.status = /segment tag|Truncated|not a program/i.test(it.issue) ? 'unsupported' : 'convert';
      it.refs = programKeymaps(o.data).map((id) => keyOf(T.KEYMAP, id));
    } else if (o.type === T.KEYMAP) {
      it.refs = keymapSamples(o.data).map((id) => keyOf(T.SOUNDBLOCK, id));
    } else if (o.type === T.SOUNDBLOCK) {
      try {
        const b = new Soundblock(o.data, { id: o.id, name: o.name });
        const ranges = soundblockRanges(b);
        const words = ranges.reduce((a, r) => a + r.hi - r.lo + 1, 0);
        const missing = ranges.some((r) => krz.sampleOffset + (r.hi + 1) * 2 > krz.size);
        it.audio = {
          ranges, words, stereo: b.stereo, headers: b.headers.length,
          rate: b.headers[0]?.rate || 0, seconds: b.headers.reduce((a, hd) => Math.max(a, hd.seconds || 0), 0),
          romOnly: !ranges.length,
        };
        if (missing) { it.status = 'unsupported'; it.issue = 'sample data missing from the file'; }
        if (ranges.some((r) => r.hi - r.lo + 1 > SDS_MAX_SAMPLES)) { it.status = 'unsupported'; it.issue = 'sample longer than a Sample Dump can carry'; }
      } catch (err) { it.status = 'unsupported'; it.issue = `damaged soundblock (${err.message})`; }
    }
    return it;
  });
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const it of items) {
    it.deps = (it.refs || []).filter((k) => byKey.has(k));
    it.external = (it.refs || []).filter((k) => !byKey.has(k));
  }
  return items;
}

/** Selected keys plus everything they need from the same file. */
export function closure(items, selected) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out = new Set();
  const visit = (k) => {
    if (out.has(k) || !byKey.has(k)) return;
    out.add(k);
    for (const d of byKey.get(k).deps) visit(d);
  };
  for (const k of selected) visit(k);
  return out;
}

/**
 * Choose the ID each object will get on the K2000.
 * mode 'keep': same IDs (replaces RAM objects with those IDs)
 *      'bank': same position in another bank (ID % 100 + bank * 100)
 *      'free': the first free RAM IDs from 200 up
 * Only programs, keymaps and soundblocks move (their references are rewritten);
 * other types keep their IDs.
 */
export function assignIds(list, { mode = 'keep', bank = 2, existing = new Map() } = {}) {
  const ids = new Map();
  const used = new Map();
  const taken = (type) => {
    if (!used.has(type)) used.set(type, new Set(existing.get(type) || []));
    return used.get(type);
  };
  const sorted = [...list].sort((a, b) => a.type - b.type || a.id - b.id);
  for (const it of sorted) {
    let id = it.id;
    if (REMAPPED_TYPES.has(it.type)) {
      if (mode === 'bank') id = bank * 100 + (it.id % 100);
      else if (mode === 'free') {
        id = 200;
        while (taken(it.type).has(id) && id < 999) id++;
      }
    }
    taken(it.type).add(id);
    ids.set(it.key, id);
  }
  return ids;
}

function remapKeymap(data, idMap) {
  const out = Uint8Array.from(data);
  const km = new Keymap(out);
  const map = (sid) => idMap.get(keyOf(T.SOUNDBLOCK, sid));
  const head = map(km.sampleId);
  if (head !== undefined) put16be(out, 0, head);
  if (km.method & 0x02) {
    for (const t of km.tables) {
      for (let i = 0; i < km.numEntries; i++) {
        const e = km.readEntry(t, i);
        const n = map(e.sampleId);
        if (n !== undefined && e.sampleOff !== undefined) put16be(out, e.sampleOff, n);
      }
    }
  }
  return out;
}

function remapProgram(data, idMap) {
  const out = Uint8Array.from(data);
  const p = new Program(out);
  for (const s of p.segments) {
    if (s.tag !== TAG.CAL) continue;
    for (const f of CAL_KEYMAP_FIELDS) {
      const at = s.offset + 1 + f;
      const n = idMap.get(keyOf(T.KEYMAP, u16be(out, at)));
      if (n !== undefined) put16be(out, at, n);
    }
  }
  return out;
}

/**
 * Work out exactly what will be sent. existing: Map type -> Set of IDs already in
 * K2000 RAM (from DIRBANK), used for free IDs and to report replacements.
 */
export function buildPlan(items, selected, { mode = 'keep', bank = 2, existing = new Map(), convert = false } = {}) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const keys = closure(items, selected);
  const skipped = [];
  const chosen = [];
  for (const k of keys) {
    const it = byKey.get(k);
    if (it.status === 'unsupported') { skipped.push({ item: it, reason: it.issue }); continue; }
    if (it.status === 'convert' && !convert) { skipped.push({ item: it, reason: `${it.issue}; turn on program conversion to import it` }); continue; }
    chosen.push(it);
  }
  const idMap = assignIds(chosen, { mode, bank, existing });
  const steps = [];
  const warnings = [];
  for (const it of chosen) {
    const newId = idMap.get(it.key);
    let data = it.data;
    const notes = [];
    try {
      if (it.type === T.PROGRAM) {
        if (it.status === 'convert') { const c = convertProgramForK2000(data); data = c.data; notes.push(...c.notes); }
        // the K2000 takes a program only with every segment (see completeProgram in krz.js)
        const full = completeProgram(data);
        data = full.data;
        if (full.added) notes.push(`${full.added} unused segment${full.added > 1 ? 's' : ''} added with the K2000's defaults`);
        data = remapProgram(data, idMap);
      } else if (it.type === T.KEYMAP) data = remapKeymap(data, idMap);
    } catch (err) { skipped.push({ item: it, reason: `could not be prepared (${err.message})` }); continue; }
    if (newId < 200 && REMAPPED_TYPES.has(it.type)) notes.push('ID below 200 shadows a ROM object');
    const replaces = existing.get(it.type)?.has(newId) || false;
    steps.push({ item: it, type: it.type, id: it.id, newId, name: it.name.slice(0, 16), data, notes, replaces, sample: it.type === T.SOUNDBLOCK && !it.audio?.romOnly });
  }
  steps.sort((a, b) => (ORDER[a.type] ?? 3) - (ORDER[b.type] ?? 3) || a.newId - b.newId);
  if (mode !== 'keep' && steps.some((s) => s.type === T.SETUP)) warnings.push('Setups keep their IDs and still point at the original program IDs.');
  const audioWords = steps.reduce((a, s) => a + (s.sample ? s.item.audio.words : 0), 0);
  const objectBytes = steps.reduce((a, s) => a + s.data.length, 0);
  const sampleCount = steps.filter((s) => s.sample).length;
  const seconds = sdsTransferSeconds(audioWords) + sampleCount * 3 + objectBytes / 2600 + steps.length * 0.3;
  return { steps, skipped, warnings, idMap, audioWords, audioBytes: audioWords * 2, objectBytes, seconds, replacements: steps.filter((s) => s.replaces) };
}

/**
 * Run a plan. ctx: {client, transport, deviceId, krz, existing (Map), log(text, kind),
 * progress({index, total, step, fraction, text}), setExclusive(bool)}.
 * Returns a job {run(): Promise<result>, cancel()}.
 */
export function createImportJob(plan, ctx) {
  const ctl = { cancelled: false, sds: null };
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const settle = ctx.settleMs ?? 600;
  const reserved = new Set(ctx.existing?.get(T.SOUNDBLOCK) || []);
  for (const s of plan.steps) if (s.type === T.SOUNDBLOCK) reserved.add(s.newId);
  let nextTemp = 999;
  const tempId = () => {
    while (reserved.has(nextTemp) && nextTemp > 200) nextTemp--;
    if (nextTemp <= 200) throw new Error('No free soundblock ID left for temporary samples');
    reserved.add(nextTemp);
    return nextTemp--;
  };
  const check = () => { if (ctl.cancelled) throw new Error('Cancelled'); };

  async function waitIdle() {
    while (ctx.client.pending) await sleep(50);
    await sleep(ctx.client.s?.minGap ?? 150);
  }

  async function sendRange(step, range, n, total, report) {
    const count = range.hi - range.lo + 1;
    const pcm = await readAudio(ctx.krz, range.lo, count);
    if (pcm.length !== count) throw new Error('Sample data is missing from the file');
    const temp = tempId();
    await waitIdle();
    check();
    const sds = new SampleDump(ctx.transport, ctx.deviceId);
    ctl.sds = sds;
    ctx.setExclusive?.(true);
    try {
      await sds.send(pcm, {
        number: sdsNumberForId(temp),
        sampleRate: range.rate || 44100,
        onProgress: (f) => report(f, `audio${total > 1 ? ` ${n + 1}/${total}` : ''} ${Math.round(f * 100)}%`),
      });
    } finally {
      ctl.sds = null;
      ctx.setExclusive?.(false);
    }
    await sleep(settle);
    const info = await ctx.client.dir(T.SOUNDBLOCK, temp);
    if (!info.size) throw new Error(`The K2000 did not create temporary sample ${temp} (sample memory full?)`);
    const tdata = await ctx.client.dump(T.SOUNDBLOCK, temp, 0, info.size, info.size);
    const th = new Soundblock(tdata).headers[0];
    if (!th || th.end - th.start + 1 < count) throw new Error(`Temporary sample ${temp} is shorter than what was sent`);
    return { temp, base: th.start };
  }

  async function runSample(step, report) {
    const out = Uint8Array.from(step.data);
    const block = new Soundblock(out);
    const ranges = step.item.audio.ranges;
    const temps = [];
    try {
      for (let r = 0; r < ranges.length; r++) {
        check();
        const { temp, base } = await sendRange(step, ranges[r], r, ranges.length, report);
        temps.push(temp);
        const delta = base - ranges[r].lo;
        for (const hi of ranges[r].headers) {
          const hd = block.headers[hi];
          for (const f of [8, 12, 16, 20]) put32be(out, hd.offset + f, s32be(out, hd.offset + f) + delta);
        }
      }
      report(1, 'writing soundblock');
      await ctx.client.writeObject(T.SOUNDBLOCK, step.newId, step.name, out);
    } finally {
      for (const t of temps) {
        try { await ctx.client.deleteObject(T.SOUNDBLOCK, t); } catch (err) { log(`Could not delete temporary sample ${t}: ${err.message}`, 'warn'); }
      }
    }
  }

  async function run() {
    const total = plan.steps.length;
    const result = { done: [], failed: [], cancelled: false };
    for (let i = 0; i < total; i++) {
      const step = plan.steps[i];
      const label = `${step.name || '(unnamed)'} -> ${step.newId}`;
      const report = (fraction, text) => progress({ index: i, total, step, fraction, text: text ? `${label}: ${text}` : label });
      try {
        check();
        report(0, step.sample ? 'starting' : 'writing');
        if (step.sample) await runSample(step, report);
        else await ctx.client.writeObject(step.type, step.newId, step.name, step.data);
        result.done.push(step);
        report(1, 'done');
        log(`Sent ${label}${step.notes.length ? ` (${step.notes.join('; ')})` : ''}`, 'good');
      } catch (err) {
        if (ctl.cancelled) { result.cancelled = true; log('Import cancelled.', 'warn'); break; }
        result.failed.push({ step, error: err });
        log(`Failed ${label}: ${err.message}`, 'bad');
        // A failed sample transfer usually means memory is full or the link is down.
        if (step.sample) break;
      }
    }
    return result;
  }

  return {
    run,
    cancel() { ctl.cancelled = true; ctl.sds?.cancel(); },
    get cancelled() { return ctl.cancelled; },
  };
}
