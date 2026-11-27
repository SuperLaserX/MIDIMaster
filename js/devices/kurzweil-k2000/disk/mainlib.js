// K2000 objects <-> Head Library patches.
//
// A K2000 patch is a program with the RAM keymaps and soundblocks it uses (or one object no program
// uses), kept as the objects' exact data in native.objects. Sample audio is stored as 16-bit WAV
// files, each marked with the word range it fills ("words": [first, last]) in the sample memory of
// where it came from: a Kurzweil file's sample area, or the K2000's sample RAM.
//
// To send patches back, krzFromPatches() rebuilds a Kurzweil file in memory (objects plus a sparse
// sample area made of the WAVs), which the Disk Import page sends like a file from disk: objects
// over SysEx, audio by Sample Dump (see importer.js).

import { makePatch, toBase64, fromBase64, newId } from '../../../core/mainlib/format.js';
import { categorize } from '../../../core/mainlib/categories.js';
import { deviceTypes } from '../../../core/mainlib/devicetypes.js';
import { parseWav, writeWav } from '../../../core/wav.js';
import { T, typeName } from '../model/types.js';
import { Soundblock } from '../model/soundblock.js';
import { programKeymaps, keymapSamples } from './importer.js';

/**
 * A Head Library patch from K2000 objects.
 * objs: [{type, id, name, data}] (the first is the program, or the lone object);
 * samples: [{id, file, name, rate, soundblock, words}] already added to `stored` by the caller.
 */
export function k2000Patch(entry, { name, kind, file = '', slot = '', objs, samples = [], note = '' }) {
  const main = objs[0];
  const keymaps = objs.filter((o) => o.type === T.KEYMAP).map((o) => `${o.id} ${o.name}`);
  const blocks = objs.filter((o) => o.type === T.SOUNDBLOCK).map((o) => `${o.id} ${o.name}`);
  const settings = kind === 'program'
    ? {
      Program: { Name: name, ID: String(main.id), ...(note ? { Note: note } : {}) },
      Keymaps: Object.fromEntries(keymaps.map((k, i) => [`Keymap ${i + 1}`, k])),
      Samples: Object.fromEntries(blocks.map((k, i) => [`Soundblock ${i + 1}`, k])),
    }
    : { Object: { Type: typeName(main.type), ID: String(main.id), Size: `${main.data.length} bytes`, ...(note ? { Note: note } : {}) } };
  return makePatch({
    name, kind,
    device: { id: entry.id, maker: entry.maker, model: entry.model, types: deviceTypes(entry) },
    category: categorize(name),
    source: { file, slot },
    settings,
    native: { object: 'krz', objects: objs.map((o) => ({ type: o.type, id: o.id, name: o.name, data: toBase64(o.data) })) },
    samples,
  });
}

/** A sample entry and its file: {ref (for patch.samples), file ({id, bytes, info})}. */
export function k2000Sample(pcm, { rate, name, soundblock, lo, source = '', loop = null }) {
  const id = newId();
  const hi = lo + pcm.length - 1;
  return {
    ref: { id, file: `samples/${id}.wav`, name, rate, soundblock, words: [lo, hi] },
    file: { id, bytes: new Uint8Array(writeWav([pcm], rate, loop)), info: { name, rate, soundblock, words: [lo, hi], source } },
  };
}

/**
 * A Kurzweil file in memory, as readKrz() returns it, from Head Library K2000 patches.
 * getSample(id) -> {bytes} | null reads a sample's WAV.
 */
export async function krzFromPatches(patches, getSample, name = 'Head Library') {
  const objects = [];
  const seen = new Set();
  const pieces = [];
  const warnings = [];
  for (const p of patches) {
    for (const o of p.native?.objects || []) {
      const k = `${o.type}:${o.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      objects.push({ type: o.type, id: o.id, name: o.name, data: fromBase64(o.data) });
    }
    for (const s of p.samples || []) {
      if (!s.words) continue;
      const smp = await getSample(s.id);
      if (!smp) { warnings.push(`The audio of "${s.name || s.id}" is not reachable.`); continue; }
      const w = parseWav(smp.bytes.buffer.slice(smp.bytes.byteOffset, smp.bytes.byteOffset + smp.bytes.byteLength));
      const f = w.channels[0];
      const pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)));
      pieces.push({ lo: s.words[0], pcm });
    }
  }
  const words = pieces.reduce((n, x) => Math.max(n, x.lo + x.pcm.length), 0);
  const size = words * 2;
  // A sparse sample area: big-endian 16-bit words, as in a Kurzweil file.
  const source = {
    name, size,
    async read(offset, len) {
      const out = new Uint8Array(Math.max(0, Math.min(len, size - offset)));
      const w0 = Math.floor(offset / 2);
      const w1 = Math.floor((offset + out.length) / 2);
      for (const x of pieces) {
        const a = Math.max(w0, x.lo);
        const b = Math.min(w1, x.lo + x.pcm.length);
        for (let w = a; w < b; w++) {
          const v = x.pcm[w - x.lo];
          const o = w * 2 - offset;
          if (o >= 0 && o < out.length) out[o] = (v >> 8) & 255;
          if (o + 1 >= 0 && o + 1 < out.length) out[o + 1] = v & 255;
        }
      }
      return out;
    },
  };
  return { name, size, source, sampleOffset: 0, audioBytes: size, osVersion: 0, format: 0, objects, warnings };
}

/**
 * A program on the K2000 with the RAM keymaps and soundblocks it uses, as a Head Library patch.
 * receive(soundblockId, headerIndex, label) -> {samples (Int16Array), sampleRate, loop...} | null
 * downloads audio by Sample Dump (slow); without it the patch keeps the objects only.
 * Returns {patch, samples: [{id, bytes, info}]}.
 */
export async function programFromK2000(client, entry, id, { receive = null, onStep = () => {} } = {}) {
  onStep(`Program ${id}`);
  const prog = await client.fetchObject(T.PROGRAM, id);
  const objs = [{ type: T.PROGRAM, id, name: prog.name, data: prog.data }];
  const refs = [];
  const files = [];
  const romRefs = [];
  for (const kid of programKeymaps(prog.data)) {
    let km;
    try { km = await client.fetchObject(T.KEYMAP, kid); } catch { continue; }
    if (!km.inRam) { romRefs.push(`keymap ${kid}`); continue; }
    onStep(`Keymap ${kid} ${km.name}`);
    objs.push({ type: T.KEYMAP, id: kid, name: km.name, data: km.data });
    for (const sid of keymapSamples(km.data)) {
      if (objs.some((o) => o.type === T.SOUNDBLOCK && o.id === sid)) continue;
      let sb;
      try { sb = await client.fetchObject(T.SOUNDBLOCK, sid); } catch { continue; }
      if (!sb.inRam) { romRefs.push(`sample ${sid}`); continue; }
      objs.push({ type: T.SOUNDBLOCK, id: sid, name: sb.name, data: sb.data });
      if (!receive) continue;
      const block = new Soundblock(sb.data, { id: sid, name: sb.name });
      for (const hd of block.headers.filter((x) => x.inRam && x.end >= x.start)) {
        const r = await receive(sid, hd.index, `${sb.name} ${hd.index + 1}/${block.headers.length}`);
        if (!r?.samples?.length) continue;
        const s = k2000Sample(r.samples, {
          rate: r.sampleRate || hd.rate || 44100, name: `${sb.name}${block.headers.length > 1 ? ` ${hd.index + 1}` : ''}`, soundblock: sid,
          lo: hd.start, source: `K2000 soundblock ${sid}`, loop: r.loop ? { start: r.loopStart, end: r.loopEnd } : null,
        });
        refs.push(s.ref);
        files.push(s.file);
      }
    }
  }
  const ramBlocks = objs.filter((o) => o.type === T.SOUNDBLOCK).length;
  const note = [
    romRefs.length ? `Uses ROM ${romRefs.join(', ')} (on every K2000)` : '',
    ramBlocks && !receive ? 'RAM sample audio not included' : '',
  ].filter(Boolean).join('; ');
  const patch = k2000Patch(entry, { name: prog.name, kind: 'program', file: 'K2000', slot: `Program ${id}`, objs, samples: refs, note });
  return { patch, samples: files };
}
