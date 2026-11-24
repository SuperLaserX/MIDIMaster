// Main Library importers: files of any supported kind -> Main Library patches and samples.
//
//   .syx              SysEx: each mapped device's definition picks its messages (def.recognise) and
//                     splits them into objects (def.libraryItems); every object becomes a patch with
//                     all its settings. SysEx no definition reads is kept as a data entry.
//   .mid .midi        the SysEx inside a Standard MIDI File, as above
//   .krz .k25 .k26    Kurzweil object files: each program with its keymaps and soundblocks; the
//                     sample audio becomes WAV files
//   .wav              a sample
//   .json             Main Library patch files (one, or an array)
//   .j8k              SysEx (JP-8000/8080 plug-in banks), as .syx
//   other formats     a definition's readFile(name, bytes) hook (e.g. the JP-8000's WinJPLib .pat/.pfm)
//   .iso .bin .img (+ .cue)  disk and CD images: every importable file inside is imported
//   .zip              archives: every importable file inside (Mac resource forks skipped)
//
// importFiles(files, opts) -> {patches, samples, report}
//   files: [{name, blob}] (a File is fine); opts.onProgress(text); opts.hint: device id to prefer
//   when a dump fits several models equally well; opts.device: the device the files are from (see
//   importSysex).

import { splitSysex, manufacturerName, manufacturerId } from '../midi/describe.js';
import { smfSysex, isSmf, repairSmfLengths } from '../midi/smf.js';
import { DEVICES, DEF_IDS, loadDef, getDevice } from '../../devices/registry.js';
import { patchFromObject, dataPatch } from '../../devices/patches.js';
import { makePatch, isPatch, newId } from './format.js';
import { categorize } from './categories.js';
import { parseWav } from '../wav.js';
import { BlobSource, BytesSource } from '../disk/source.js';
import { isZip } from '../disk/zip.js';

export const IMPORTABLE = /\.(syx|mid|midi|krz|k25|k26|wav|json|j8k|pat|pfm|zip|iso|bin|img|ima|cue)$/i;
const INSIDE_IMAGES = /\.(syx|mid|midi|krz|k25|k26|wav|json|j8k|pat|pfm|zip)$/i;
// inside a ZIP: the same, disk images too (one level of archives inside archives)
const INSIDE_ZIP = /\.(syx|mid|midi|krz|k25|k26|wav|json|j8k|pat|pfm|zip|iso|img|ima)$/i;

// A File (or Blob) has a bytes() method in current browsers, so test for Blob first.
const isBlob = (f) => typeof Blob !== 'undefined' && f instanceof Blob;
const bytesOf = async (f) => (f.blob ? new Uint8Array(await f.blob.arrayBuffer()) : Uint8Array.from(f.bytes));

// ------------------------------------------------------------------ SysEx
let defsCache = null;
async function mappedDefs() {
  if (defsCache) return defsCache;
  const seen = new Map();
  for (const id of DEF_IDS) {
    const def = await loadDef(id);
    if (!def?.recognise) continue;
    if ([...seen.values()].some((x) => x.def === def)) continue; // M1 and M1R share one definition
    seen.set(id, { id, def });
  }
  defsCache = [...seen.values()];
  return defsCache;
}

/**
 * Patches from a list of SysEx messages.
 * opts.hint: the device id to prefer when messages fit several models equally.
 * opts.device: the device the messages came from (a device's Librarian, or chosen on import): it is
 * also the hint, and SysEx of its manufacturer that no definition reads is kept as its data.
 */
export async function importSysex(msgs, { file = '', hint = null, device = null } = {}) {
  const defs = await mappedDefs();
  const patches = [];
  const report = [];
  hint = hint || device;
  const reads = (d, m) => { try { return !!d.def.recognise(m); } catch { return false; } };
  // messages cut out of a MIDI file as raw SysEx (older Librarian entries): F0 <length> <data> F7
  const repaired = repairSmfLengths(msgs, (m) => defs.some((d) => reads(d, m)));
  if (repaired !== msgs) { msgs = repaired; report.push({ file, note: 'the messages still carried MIDI-file length bytes (a .mid read as raw SysEx); removed' }); }
  // messages each definition reads; a message read by several (JP-8000 / JP-8080) goes to the best fit
  const byDef = new Map();
  const unknown = [];
  // requests (a device's own RQ1, identity requests) are not data: e.g. echoed back by MIDI thru
  const requests = msgs.filter((m) => (m[1] === 0x7e && m[3] === 0x06) || defs.some((d) => d.def.isRequest?.(m)));
  if (requests.length) { msgs = msgs.filter((m) => !requests.includes(m)); report.push({ file, note: `${requests.length} request message(s) left out` }); }
  const claimants = msgs.map((m) => defs.filter((d) => reads(d, m)));
  const groups = new Map(); // claimant set key -> messages
  msgs.forEach((m, i) => {
    if (!claimants[i].length) { unknown.push(m); return; }
    const key = claimants[i].map((d) => d.id).join('|');
    if (!groups.has(key)) groups.set(key, { cands: claimants[i], msgs: [] });
    groups.get(key).msgs.push(m);
  });
  for (const { cands, msgs: gm } of groups.values()) {
    let best = cands[0];
    if (cands.length > 1) {
      const scored = cands.map((d) => ({ d, s: d.def.prefer ? d.def.prefer(gm) : 1 })).sort((a, b) => b.s - a.s || (b.d.id === hint) - (a.d.id === hint));
      best = scored[0].d;
      if (scored[0].s === scored[1].s) report.push({ file, note: `${gm.length} message(s) fit ${cands.map((d) => getDevice(d.id).model).join(' and ')} equally; read as ${getDevice(best.id).model}.` });
    }
    if (!byDef.has(best.id)) byDef.set(best.id, []);
    byDef.get(best.id).push(...gm);
  }
  for (const [id, dm] of byDef) {
    const entry = getDevice(id);
    const { def } = defs.find((d) => d.id === id);
    const counts = {};
    const items = def.libraryItems ? def.libraryItems(dm, {}) : dm.map((m, i) => ({ key: String(i), label: `Message ${i + 1}`, msgs: [m] }));
    const out = [];
    for (const it of items) {
      const made = objectPatch(entry, def, it, file) || dataPatch(entry, it.label, it.msgs, { source: { file, slot: it.label } });
      out.push(made);
      linkParts(entry, def, made, def.libraryParts?.(it) || [], file, out);
    }
    for (const p of out) counts[p.kind] = (counts[p.kind] || 0) + 1;
    patches.push(...out);
    report.push({ file, device: entry.model, counts });
  }
  // A device's own messages that its definition cannot read (checksum errors, cut short in the
  // file): kept as that device's data, credited to the model the rest of the file was read as.
  const damaged = new Map();
  const rest = [];
  for (const m of unknown) {
    const own = defs.filter((d) => { try { return d.def.isOwn?.(m); } catch { return false; } });
    if (!own.length) { rest.push(m); continue; }
    const pick = own.find((d) => d.id === device) || own.slice().sort((a, b) => (byDef.get(b.id)?.length || 0) - (byDef.get(a.id)?.length || 0))[0];
    if (!damaged.has(pick.id)) damaged.set(pick.id, []);
    damaged.get(pick.id).push(m);
  }
  for (const [id, mm] of damaged) {
    const entry = getDevice(id);
    const p = dataPatch(entry, `Damaged ${entry.model} messages (${mm.length})`, mm, { source: { file } });
    p.notes = `These ${mm.length} message(s) failed their checksum or are cut short in the file, so the ${entry.model} editor cannot read them. They are kept exactly as found.`;
    patches.push(p);
    report.push({ file, device: entry.model, counts: { data: 1 }, note: `${mm.length} damaged message(s) (checksum errors or cut short in the file), kept as data` });
  }
  if (rest.length) {
    // grouped by manufacturer, kept so nothing is lost; the device can be set later
    const byMaker = new Map();
    for (const m of rest) {
      const id = manufacturerId(m) || '??';
      if (!byMaker.has(id)) byMaker.set(id, []);
      byMaker.get(id).push(m);
    }
    const dev = device ? getDevice(device) : null;
    for (const [id, mm] of byMaker) {
      const maker = manufacturerName(id);
      if (dev?.sysex && dev.sysex.toUpperCase() === id.toUpperCase()) {
        // from this device's Librarian (or chosen on import): its own SysEx, not read by an editor yet
        const p = dataPatch(dev, `${dev.model} SysEx (${mm.length} messages)`, mm, { source: { file } });
        p.notes = `${maker} SysEx from the ${dev.model} that no editor reads yet; kept exactly as found.`;
        patches.push(p);
        report.push({ file, device: dev.model, counts: { data: 1 }, note: `${mm.length} message(s) no editor reads yet, kept as data` });
        continue;
      }
      const candidates = DEVICES.filter((d) => d.sysex && d.sysex.toUpperCase() === id.toUpperCase()).map((d) => d.model);
      const entry = { id: 'unknown', maker, model: `Unknown ${maker} device`, type: 'oth' };
      const p = dataPatch(entry, `${maker} SysEx (${mm.length} messages)`, mm, { source: { file } });
      p.notes = candidates.length ? `No editor reads these yet. ${maker} devices in the catalog: ${candidates.slice(0, 12).join(', ')}${candidates.length > 12 ? '...' : ''}.` : 'No editor reads these yet.';
      patches.push(p);
      report.push({ file, device: `${maker} (not mapped)`, counts: { data: 1 }, note: `${mm.length} message(s) kept as data` });
    }
  }
  return { patches, samples: [], report };
}

/** A patch from one item ({object, data | msgs, label, name}), or null when no object reads it. */
function objectPatch(entry, def, it, file) {
  const objs = it.object ? def.objects.filter((o) => o.key === it.object) : def.libraryItems ? [] : def.objects.filter((o) => o.fromSyx);
  for (const obj of objs) {
    let data = it.data || null;
    if (!data) { try { data = obj.fromSyx?.(it.msgs) ?? null; } catch { data = null; } }
    if (data) return patchFromObject(entry, def, obj, data, { name: it.name || '', source: { file, slot: it.label } });
  }
  return null;
}

/**
 * Objects carried inside another (a performance's own patches): patches of their own, linked from
 * the main one (main.links, and a "Patches" settings group with their names).
 */
function linkParts(entry, def, main, parts, file, out) {
  for (const part of parts) {
    const p = objectPatch(entry, def, { object: part.object, data: part.data, msgs: part.msgs, label: `${main.source.slot || main.name}, ${part.role.toLowerCase()}` }, file);
    if (!p) continue;
    // a part patch left with its default name is listed under its performance's name and category
    if (!p.name.trim() || /^init(ial)?\s*(patch|tone|sound)?\s*\d*$/i.test(p.name.trim())) p.name = `${main.name} (${part.role.toLowerCase()})`;
    if (p.category.id === 'none' && main.category.id !== 'none') p.category = { ...main.category, source: 'performance' };
    out.push(p);
    (main.links ??= []).push({ role: part.role, id: p.id, name: p.name, kind: p.kind });
    (main.settings.Patches ??= {})[part.role] = p.name;
  }
}

/** Files a definition reads itself (readFile hook): {patches, samples, report} or null. */
async function importByDefs(bytes, file) {
  for (const { id, def } of await mappedDefs()) {
    if (!def.readFile) continue;
    let items = null;
    try { items = def.readFile(file, bytes); } catch { items = null; }
    if (!items) continue;
    const entry = getDevice(id);
    const out = [];
    for (const it of items) {
      const made = objectPatch(entry, def, it, file);
      if (!made) continue;
      out.push(made);
      linkParts(entry, def, made, it.parts || [], file, out);
    }
    const counts = {};
    for (const p of out) counts[p.kind] = (counts[p.kind] || 0) + 1;
    return { patches: out, samples: [], report: [{ file, device: entry.model, counts }] };
  }
  return null;
}

// ------------------------------------------------------------------ Kurzweil
async function importKrz(src, file) {
  const { readKrz, readAudio } = await import('../../devices/kurzweil-k2000/disk/krz.js');
  const { describeObjects, closure, soundblockRanges } = await import('../../devices/kurzweil-k2000/disk/importer.js');
  const { k2000Patch, k2000Sample } = await import('../../devices/kurzweil-k2000/disk/mainlib.js');
  const { Soundblock } = await import('../../devices/kurzweil-k2000/model/soundblock.js');
  const { T, typeName } = await import('../../devices/kurzweil-k2000/model/types.js');
  const krz = await readKrz(src);
  const items = describeObjects(krz);
  const entry = getDevice('kurzweil-k2000');
  const patches = [];
  const samples = [];
  const sampleRefs = new Map(); // soundblock key -> sample refs
  async function samplesOf(it) {
    if (sampleRefs.has(it.key)) return sampleRefs.get(it.key);
    const out = [];
    if (it.audio && !it.audio.romOnly && it.status !== 'unsupported') {
      const ranges = soundblockRanges(new Soundblock(it.data, { id: it.id, name: it.name }));
      for (const [n, r] of ranges.entries()) {
        const pcm = await readAudio(krz, r.lo, r.hi - r.lo + 1); // Int16Array, as writeWav takes it
        const s = k2000Sample(pcm, { rate: r.rate || 44100, name: `${it.name}${ranges.length > 1 ? ` ${n + 1}` : ''}`, soundblock: it.id, lo: r.lo, source: file });
        out.push(s.ref);
        samples.push(s.file);
      }
    }
    sampleRefs.set(it.key, out);
    return out;
  }
  const programs = items.filter((i) => i.type === T.PROGRAM);
  const used = new Set();
  for (const pg of programs) {
    const keys = closure(items, [pg.key]);
    const objs = [pg, ...items.filter((i) => keys.has(i.key) && i !== pg)];
    const smp = [];
    for (const o of objs.filter((i) => i.type === T.SOUNDBLOCK)) smp.push(...(await samplesOf(o)));
    for (const k of keys) used.add(k);
    patches.push(k2000Patch(entry, { name: pg.name, kind: 'program', file, slot: `Program ${pg.id}`, objs, samples: smp, note: pg.issue || '' }));
  }
  // objects no program uses (lone keymaps, samples, effects, setups...)
  for (const o of items.filter((i) => !used.has(i.key))) {
    const smp = o.type === T.SOUNDBLOCK ? await samplesOf(o) : [];
    patches.push(k2000Patch(entry, {
      name: o.name || `${typeName(o.type)} ${o.id}`, kind: o.type === T.SOUNDBLOCK ? 'sample' : typeName(o.type).toLowerCase(),
      file, slot: `${typeName(o.type)} ${o.id}`, objs: [o], samples: smp, note: o.issue || '',
    }));
  }
  return { patches, samples, report: [{ file, device: entry.model, counts: { program: programs.length, other: patches.length - programs.length, samples: samples.length }, note: krz.warnings.join(' ') || undefined }] };
}

// ------------------------------------------------------------------ WAV and JSON
function importWav(bytes, file) {
  const w = parseWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const id = newId();
  const name = file.replace(/\.[^.]+$/, '');
  const info = { name, rate: w.sampleRate, channels: w.channels.length, frames: w.channels[0]?.length || 0, loop: w.loop || null, source: file };
  return {
    patches: [makePatch({
      name, kind: 'sample', device: { id: 'sample', maker: '', model: 'Sample', types: ['Sample'] }, category: categorize(name),
      source: { file }, settings: { Sample: { Rate: `${w.sampleRate} Hz`, Channels: String(info.channels), Length: `${(info.frames / w.sampleRate).toFixed(2)} s`, Loop: w.loop ? `${w.loop.start}-${w.loop.end}` : 'none' } },
      samples: [{ id, file: `samples/${id}.wav`, name, rate: w.sampleRate }],
    })],
    samples: [{ id, bytes, info }],
    report: [{ file, device: 'Sample', counts: { sample: 1 } }],
  };
}

function importJson(bytes, file) {
  const j = JSON.parse(new TextDecoder().decode(bytes));
  const list = (Array.isArray(j) ? j : [j]).filter(isPatch);
  return { patches: list, samples: [], report: [{ file, device: 'Main Library file', counts: { patch: list.length }, note: list.length ? undefined : 'no Main Library patches in it' }] };
}

// ------------------------------------------------------------------ one file, any kind
async function importOne(name, getBytes, src, opts) {
  const lower = name.toLowerCase();
  if (/\.(krz|k25|k26)$/.test(lower)) return importKrz(src || new BytesSource(await getBytes(), name), name);
  const bytes = await getBytes();
  if (/\.wav$/.test(lower)) return importWav(bytes, name);
  if (/\.json$/.test(lower)) return importJson(bytes, name);
  if (/\.zip$/.test(lower) || isZip(bytes)) return importZip({ name, bytes }, opts);
  const sx = { file: name, hint: opts.hint, device: opts.device };
  if (/\.(mid|midi)$/.test(lower) || isSmf(bytes)) return importSysex(smfSysex(bytes), sx);
  if (bytes[0] !== 0xf0) {
    const own = await importByDefs(bytes, name);
    if (own) return own;
    if (/\.(pat|pfm)$/.test(lower)) return { patches: [], samples: [], report: [{ file: name, error: 'not a file layout the Main Library knows' }] };
  }
  return importSysex(splitSysex(bytes), sx);
}

/** Every importable file in a ZIP archive. */
async function importZip(f, opts, depth = 0) {
  const { readZip } = await import('../disk/zip.js');
  const zip = await readZip(f.blob ? new BlobSource(f.blob, f.name) : new BytesSource(f.bytes, f.name));
  const files = zip.entries.filter((e) => !e.dir && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\._/.test(e.name));
  const usable = files.filter((e) => INSIDE_ZIP.test(e.name) && (depth < 1 || !/\.zip$/i.test(e.name)));
  const out = { patches: [], samples: [], report: [{ file: f.name, note: `ZIP archive: ${usable.length} importable of ${files.length} file(s)` }] };
  for (const [i, e] of usable.entries()) {
    const path = `${f.name}/${e.name}`;
    const base = e.name.split('/').pop();
    opts.onProgress?.(`${f.name}: ${e.name} (${i + 1}/${usable.length})`);
    try {
      const bytes = await zip.read(e);
      let r;
      if (/\.zip$/i.test(base)) r = await importZip({ name: base, bytes }, opts, depth + 1);
      else if (/\.(iso|img|ima)$/i.test(base)) r = await importImage({ name: base, blob: new Blob([bytes]) }, null, opts);
      else r = await importOne(base, async () => bytes, new BytesSource(bytes, base), opts);
      for (const p of r.patches) p.source = { ...p.source, file: `${path}${p.source.file && p.source.file !== base ? `/${p.source.file.split('/').slice(1).join('/')}` : ''}`.replace(/\/$/, '') };
      out.patches.push(...r.patches); out.samples.push(...r.samples); out.report.push(...r.report.map((x) => ({ ...x, file: path })));
    } catch (err) { out.report.push({ file: path, error: err.message }); }
  }
  return out;
}

async function importImage(f, cueText, opts) {
  const { openImage, findFiles } = await import('../disk/image.js');
  const { volume, layout } = await openImage(f.blob, { cueText, name: f.name });
  const files = await findFiles(volume, INSIDE_IMAGES);
  const out = { patches: [], samples: [], report: [{ file: f.name, note: `${layout.description}; ${files.length} importable file(s) inside` }] };
  for (const [i, x] of files.entries()) {
    opts.onProgress?.(`${f.name}: ${x.path} (${i + 1}/${files.length})`);
    const src = volume.fileSource(x.entry);
    try {
      const r = await importOne(x.path, async () => src.read(0, src.size), src, opts);
      for (const p of r.patches) p.source = { ...p.source, file: `${f.name}/${x.path}` };
      out.patches.push(...r.patches); out.samples.push(...r.samples); out.report.push(...r.report.map((e) => ({ ...e, file: `${f.name}/${x.path}` })));
    } catch (err) { out.report.push({ file: `${f.name}/${x.path}`, error: err.message }); }
  }
  return out;
}

/** Import files ([{name, blob}] or Files). A .cue is paired with the .bin it names. */
export async function importFiles(files, opts = {}) {
  const list = [...files].map((f) => (isBlob(f) ? { name: f.name, blob: f } : f));
  const cues = list.filter((f) => /\.cue$/i.test(f.name));
  const out = { patches: [], samples: [], report: [] };
  const used = new Set();
  for (const cue of cues) {
    const text = await cue.blob.text();
    const binName = /FILE\s+"([^"]+)"/i.exec(text)?.[1]?.split(/[\\/]/).pop();
    const bin = list.find((f) => f.name.toLowerCase() === binName?.toLowerCase());
    used.add(cue);
    if (!bin) { out.report.push({ file: cue.name, error: `select ${binName || 'its .bin file'} together with the .cue` }); continue; }
    used.add(bin);
    try { merge(out, await importImage(bin, text, opts)); } catch (err) { out.report.push({ file: bin.name, error: err.message }); }
  }
  for (const [i, f] of list.entries()) {
    if (used.has(f)) continue;
    opts.onProgress?.(`${f.name} (${i + 1}/${list.length})`);
    try {
      if (/\.(iso|img|ima)$/i.test(f.name) || (/\.bin$/i.test(f.name) && (f.blob?.size || 0) > 1 << 20)) merge(out, await importImage(f, null, opts));
      else if (/\.zip$/i.test(f.name)) merge(out, await importZip(f.blob ? f : { name: f.name, bytes: Uint8Array.from(f.bytes) }, opts));
      else if (IMPORTABLE.test(f.name)) merge(out, await importOne(f.name, () => bytesOf(f), f.blob ? new BlobSource(f.blob, f.name) : null, opts));
      else out.report.push({ file: f.name, error: 'not a format the Main Library reads yet' });
    } catch (err) { out.report.push({ file: f.name, error: err.message }); }
  }
  return out;
}

function merge(out, r) { out.patches.push(...r.patches); out.samples.push(...r.samples); out.report.push(...r.report); }
