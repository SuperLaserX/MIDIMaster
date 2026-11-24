import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { categorize, categoryFromName, CATEGORIES } from '../js/core/mainlib/categories.js';
import { deviceTypes } from '../js/core/mainlib/devicetypes.js';
import { toBase64, fromBase64, makePatch, indexRow } from '../js/core/mainlib/format.js';
import { smfSysex } from '../js/core/midi/smf.js';
import { MainLibrary, MemoryFolder, KvStore } from '../js/core/mainlib/store.js';
import { importFiles, importSysex } from '../js/core/mainlib/importers.js';
import { patchFromObject, objectFromPatch, loadMode } from '../js/devices/patches.js';
import { getDevice } from '../js/devices/registry.js';

const LIVE = (f) => new URL(`../re/jp8080/live/${f}`, import.meta.url);
const has = (u) => fs.existsSync(u);

test('Main Library: categories from names and devices, device types', () => {
  assert.equal(categorize('BA ActuallySkrlx').id, 'synth-bass');
  assert.equal(categorize('PD:Warm Strings').id, 'soft-pad', 'the prefix wins over words');
  assert.equal(categorize('LEADS').id, 'hard-lead');
  assert.equal(categorize('Juno Bass').id, 'bass');
  assert.equal(categorize('Den U').id, 'none');
  assert.equal(categorize('Anything', 'el-piano').source, 'device');
  assert.equal(categoryFromName('Fat Basses').id, 'bass');
  assert.equal(CATEGORIES.length, 39, 'No category + the 38 Roland categories');
  assert.deepEqual(deviceTypes(getDevice('kurzweil-k2000')), ['Synthesizer', 'Sampler']);
  assert.deepEqual(deviceTypes(getDevice('roland-jv2080')), ['Rompler', 'Synthesizer']);
  assert.deepEqual(deviceTypes({ id: 'x', type: 'drm' }), ['Drum machine']);
});

test('Main Library: base64 and the SMF SysEx reader', () => {
  for (const n of [0, 1, 2, 3, 4, 255]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.deepEqual(Array.from(fromBase64(toBase64(b))), Array.from(b), `length ${n}`);
  }
  // MThd + MTrk with a SysEx split over an F0 and an F7 event, a program change and a meta event
  const trk = [0x00, 0xf0, 0x03, 0x41, 0x10, 0x00, 0x00, 0xf7, 0x02, 0x06, 0xf7, 0x00, 0xc0, 0x05, 0x00, 0xff, 0x2f, 0x00];
  const smf = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
  assert.deepEqual(smfSysex(smf).map((m) => Array.from(m)), [[0xf0, 0x41, 0x10, 0x00, 0x06, 0xf7]]);
});

test('Main Library store: cache before a folder, folder writes, permission lapse, unregister', async () => {
  const kv = new KvStore(null);
  const folder = new MemoryFolder();
  const lib = await new MainLibrary(kv, { pickFolder: async () => folder }).load();
  assert.equal(lib.state, 'none');
  const a = await lib.createSub('JP sounds');
  const p1 = makePatch({ name: 'BA One', device: { id: 'roland-jp8080', maker: 'Roland', model: 'JP-8080', types: ['Synthesizer'] }, category: categorize('BA One'), samples: [{ id: 's1', file: 'samples/s1.wav' }] });
  await lib.addPatches(a, [p1], [{ id: 's1', bytes: Uint8Array.from([1, 2, 3]), info: { name: 'x' } }]);
  assert.ok((await lib.pendingCount()) >= 3, 'kept in the cache until a folder is chosen');
  assert.equal(folder.files.size, 0);
  assert.ok(await lib.chooseFolder());
  assert.equal(lib.state, 'connected');
  assert.equal(await lib.pendingCount(), 0);
  const path = lib.subs()[0].path;
  for (const f of ['mainlibrary.json', `${path}/sublibrary.json`, `${path}/patches/${p1.id}.json`, `${path}/samples/s1.wav`]) assert.ok(folder.files.has(f), f);
  assert.deepEqual((await lib.getSub(a)).patches, [indexRow(p1)]);

  // A later session whose folder permission has lapsed: reads come from the cache, writes wait.
  let granted = false;
  const lapsed = Object.assign(Object.create(folder), { permission: async (req) => (req ? (granted = true, 'granted') : granted ? 'granted' : 'prompt') });
  const lib2 = await new MainLibrary(kv, { pickFolder: async () => lapsed, wrap: (hd) => (hd === folder ? lapsed : hd) }).load();
  assert.equal(lib2.state, 'disconnected');
  assert.equal((await lib2.getSub(a)).name, 'JP sounds');
  const p2 = makePatch({ name: 'PD Two', device: p1.device });
  await lib2.addPatches(a, [p2]);
  assert.ok(!folder.files.has(`${path}/patches/${p2.id}.json`));
  assert.ok(await lib2.reconnect());
  assert.ok(folder.files.has(`${path}/patches/${p2.id}.json`), 'written once access is back');

  // move, delete, an external sub-library, unregister
  const b = await lib2.createSub('Other');
  await lib2.movePatch(a, b, p1.id);
  assert.deepEqual((await lib2.getSub(b)).patches.map((r) => r.id), [p1.id]);
  assert.ok((await lib2.getSample(b, 's1')).bytes.length === 3, 'samples move with the patch');
  const ext = new MemoryFolder();
  await ext.writeText('sublibrary.json', JSON.stringify({ format: 'midimaster-sublibrary', version: 1, id: 'ext-1', name: 'Shared set', patches: [] }));
  const id = await lib2.registerFolder(ext);
  assert.equal(id, 'ext-1');
  await lib2.addPatches(id, [p2]);
  assert.ok(ext.files.has(`patches/${p2.id}.json`), 'an external sub-library writes into its own folder');
  await lib2.unregister(a);
  assert.ok(!lib2.subs().some((s) => s.id === a));
  assert.ok(folder.files.has(`${path}/sublibrary.json`), 'unregistering leaves the files');
  assert.ok(!JSON.parse(folder.files.get('mainlibrary.json')).sublibraries.some((s) => s.id === a));
});

test('Main Library import: device dumps become patches with readable settings', async () => {
  if (has(LIVE('fulldump.syx'))) {
    const r = await importFiles([{ name: 'fulldump.syx', bytes: fs.readFileSync(LIVE('fulldump.syx')) }]);
    const k = (kind) => r.patches.filter((p) => p.kind === kind).length;
    // 128 user patches, 2 temporary patches and the 2 patches inside each of the 64 user performances
    assert.deepEqual([k('patch'), k('performance'), k('system'), k('data')], [130 + 128, 65, 1, 4], 'JP-8080 complete dump');
    const user = r.patches.filter((p) => p.kind === 'performance' && /^User/.test(p.source.slot));
    assert.equal(user.length, 64);
    assert.ok(user.every((p) => p.links?.length === 2), 'each user performance links its upper and lower patch');
    const den = r.patches.find((p) => p.name === 'Den U');
    assert.equal(den.device.model, 'JP-8080');
    assert.equal(den.settings.OSC1['OSC1 waveform'], 'FEEDBACK OSC');
    assert.ok(den.common?.extra?.family === 'roland-jp');
  }
  if (has(LIVE('fulldump_roland-jv2080.syx'))) {
    const r = await importFiles([{ name: 'jv.syx', bytes: fs.readFileSync(LIVE('fulldump_roland-jv2080.syx')) }]);
    assert.equal(r.patches.filter((p) => p.device.id === 'roland-jv2080' && p.kind === 'patch').length, 129);
    assert.ok(r.report.some((e) => /request message/.test(e.note || '')), 'echoed requests are left out');
  }
  // Without files: a JP-8000-sized patch dump is read as JP-8000, a JP-8080 one as JP-8080.
  const { dt1 } = await import('../js/core/midi/roland.js');
  const mk = (n) => dt1([0x00, 0x06], 0x10, [0x02, 0x00, 0x00, 0x00], Array.from({ length: n }, (_, i) => (i < 16 ? 'BA Test Bass    '.charCodeAt(i) : 0)));
  assert.equal((await importSysex([mk(0xf0)])).patches[0].device.id, 'roland-jp8000');
  assert.equal((await importSysex([mk(0xf8)])).patches[0].device.id, 'roland-jp8080');
  assert.equal((await importSysex([Uint8Array.from([0xf0, 0x43, 0x00, 0x09, 0x20, 0x00, 0xf7])])).patches[0].device.maker, 'Yamaha', 'unmapped SysEx is kept as data');
});

test('Main Library: JP-8080 <-> JP-8000 through the shared model', async () => {
  const jp80 = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jp00 = (await import('../js/devices/defs/roland-jp8000.js')).default;
  const e80 = getDevice('roland-jp8080');
  const e00 = getDevice('roland-jp8000');
  const p80 = jp80.objects.find((o) => o.key === 'patch');
  const p00 = jp00.objects.find((o) => o.key === 'patch');
  const raw = has(LIVE('stored_patch_upper.bin')) ? new Uint8Array(fs.readFileSync(LIVE('stored_patch_upper.bin'))) : p80.init();
  raw[0x21] = 3; raw[0x3d] = 12; raw[0xf3] = 1; // OSC2 NOISE, DISTORTION, unison: things the JP-8000 lacks
  const patch = patchFromObject(e80, jp80, p80, raw);
  assert.equal(loadMode(e80, jp80, p80, patch), 'native');
  assert.deepEqual(Array.from(objectFromPatch(e80, jp80, p80, patch).data), Array.from(raw), 'same model: bit exact');
  assert.equal(loadMode(e00, jp00, p00, patch), 'translate');
  const to00 = objectFromPatch(e00, jp00, p00, patch);
  assert.equal(to00.data[0x21], 0);
  assert.equal(to00.data[0x3e], 0, 'an effect the JP-8000 lacks is switched off');
  assert.ok(to00.report.approximated.some((x) => /NOISE/.test(x)));
  assert.ok(to00.report.dropped.some((x) => /DISTORTION|Multi-FX/.test(x)));
  assert.ok(to00.report.dropped.some((x) => /Unison/.test(x)));
  for (let o = 0; o < 0xf0; o++) if (![0x21, 0x3d, 0x3e].includes(o)) assert.equal(to00.data[o], raw[o], `byte ${o.toString(16)}`);
  // the semantic fields alone (as another device would give them) rebuild the sound
  const semantic = { ...patch.common };
  delete semantic.extra;
  const fromSem = objectFromPatch(e80, jp80, p80, { ...patch, common: semantic, device: { ...patch.device, id: 'other' } });
  for (const o of [0x10, 0x17, 0x1e, 0x23, 0x24, 0x27, 0x29, 0x2a, 0x2f, 0x36, 0x3d, 0x40, 0x45, 0x47, 0x48, 0x6a]) assert.equal(fromSem.data[o], raw[o], `semantic byte ${o.toString(16)}`);
});

test('Main Library import: real collections (skipped when absent)', { skip: !has('D:/midi/jp8080/AlanM/Alan_M_JP80x0_v1.0.mid') }, async () => {
  const r = await importFiles([{ name: 'a.mid', bytes: fs.readFileSync('D:/midi/jp8080/AlanM/Alan_M_JP80x0_v1.0.mid') }]);
  assert.equal(r.patches.length, 128);
  assert.ok(r.patches.every((p) => p.device.id === 'roland-jp8000'));
  assert.equal(r.patches.filter((p) => p.category.id === 'synth-bass').length, 23);
  if (has('D:/midi/K2000/New/TR909-0.KRZ')) {
    const k = await importFiles([{ name: 'TR909-0.KRZ', blob: await fs.openAsBlob('D:/midi/K2000/New/TR909-0.KRZ') }]);
    assert.equal(k.patches[0].device.id, 'kurzweil-k2000');
    assert.equal(k.patches[0].samples.length, k.samples.length);
    assert.ok(k.samples.length > 0 && k.samples.every((s) => String.fromCharCode(...s.bytes.subarray(0, 4)) === 'RIFF'));
    const { parseWav } = await import('../js/core/wav.js');
    const { readKrz, readAudio } = await import('../js/devices/kurzweil-k2000/disk/krz.js');
    const { BlobSource } = await import('../js/core/disk/source.js');
    const krz = await readKrz(new BlobSource(await fs.openAsBlob('D:/midi/K2000/New/TR909-0.KRZ'), 'TR909-0.KRZ'));
    const s0 = k.samples[0];
    const w = parseWav(s0.bytes.buffer.slice(s0.bytes.byteOffset, s0.bytes.byteOffset + s0.bytes.byteLength));
    const pcm = await readAudio(krz, s0.info.words[0], s0.info.words[1] - s0.info.words[0] + 1);
    assert.equal(w.frames, pcm.length);
    assert.ok(pcm.some((x) => x !== 0), 'the sample has sound');
    assert.ok(pcm.every((x, i) => Math.round(w.channels[0][i] * 32768) === x), 'the WAV holds the exact 16-bit audio');
  }
});

test('Main Library import: JP .pat, .pfm and .j8k files (skipped when absent)', { skip: !has('D:/midi/jp8080/JP-8000 Light Perfs Vol 1.pfm') }, async () => {
  const { fromBase64 } = await import('../js/core/mainlib/format.js');
  const read = async (f) => importFiles([{ name: f.split('/').pop(), bytes: fs.readFileSync(`D:/midi/jp8080/${f}`) }]);
  // .pat: the same 128 patches as the set's .mid, byte for byte (00-EE)
  const pat = await read('AlanM/Alan_M_JP80x0_v1.0.pat');
  const mid = await read('AlanM/Alan_M_JP80x0_v1.0.mid');
  assert.equal(pat.patches.length, 128);
  assert.ok(pat.patches.every((p) => p.device.id === 'roland-jp8000' && p.kind === 'patch'));
  pat.patches.forEach((p, i) => {
    assert.equal(p.name, mid.patches[i].name);
    assert.deepEqual(Array.from(fromBase64(p.native.bytes).subarray(0, 0xef)), Array.from(fromBase64(mid.patches[i].native.bytes).subarray(0, 0xef)), p.name);
  });
  // .pfm: performances with their two patches, linked
  const pfm = await read('_Presets/AZS JP-Eternal/JP-8000/WinJPLib/AZS Eternal JP-8000 Performances.pfm');
  const perfs = pfm.patches.filter((p) => p.kind === 'performance');
  assert.equal(perfs.length, 64);
  assert.equal(pfm.patches.filter((p) => p.kind === 'patch').length, 128);
  const ids = new Set(pfm.patches.map((p) => p.id));
  assert.ok(perfs.every((p) => p.links.length === 2 && p.links.every((l) => ids.has(l.id))));
  assert.equal(perfs[0].name, 'LD SYNAESTHESIA');
  const up = pfm.patches.find((p) => p.id === perfs[0].links[0].id);
  assert.equal(up.name, 'LD SYNAESTHESIA (upper)', 'an INIT PATCH part is listed under its performance');
  assert.equal(up.category.id, 'hard-lead');
  // .j8k (SysEx) of the same set: the same performance and upper patch bytes
  const j8k = await read('_Presets/AZS JP-Eternal/JP-8000/Mystery Island Plugin/AZS Eternal JP-8000 Performances.j8k');
  const jperf = j8k.patches.find((p) => p.kind === 'performance' && p.name === 'LD SYNAESTHESIA');
  const jup = j8k.patches.find((p) => p.id === jperf.links.find((l) => l.role === 'Upper').id);
  assert.deepEqual(Array.from(fromBase64(jup.native.bytes).subarray(0, 0xef)), Array.from(fromBase64(up.native.bytes).subarray(0, 0xef)));
});

test('SysEx from files: MIDI files, and messages cut out of one as raw SysEx', async () => {
  const { sysexMessages, repairSmfLengths } = await import('../js/core/midi/smf.js');
  const { splitSysex } = await import('../js/core/midi/describe.js');
  const { dt1 } = await import('../js/core/midi/roland.js');
  const msgs = [dt1([0x00, 0x06], 0x10, [0x02, 0, 0, 0], Array(19).fill(1)), dt1([0x00, 0x06], 0x10, [0x03, 0, 0x10, 0], Array(7).fill(2)), dt1([0x00, 0x06], 0x10, [0x03, 0, 0, 0], Array(150).fill(3))].map((m) => Uint8Array.from(m));
  // a MIDI file: each message an F0 event with its length (one or two bytes)
  const vl = (n) => (n < 128 ? [n] : [0x80 | (n >> 7), n & 127]);
  const trk = msgs.flatMap((m) => [0x00, 0xf0, ...vl(m.length - 1), ...m.subarray(1)]).concat([0x00, 0xff, 0x2f, 0x00]);
  const smf = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, trk.length >> 8, trk.length & 255, ...trk]);
  assert.deepEqual(sysexMessages(smf).map((m) => Array.from(m)), msgs.map((m) => Array.from(m)), 'a MIDI file is read as MIDI');
  const raw = splitSysex(smf); // what the Librarian used to store: F0 <length> 41 10 ...
  assert.equal(raw[0][1], 30, 'the event length (30 bytes after F0) sits where the maker ID should be: 1Eh');
  assert.deepEqual(repairSmfLengths(raw).map((m) => Array.from(m)), msgs.map((m) => Array.from(m)));
  assert.equal(repairSmfLengths(msgs), msgs, 'proper messages are left alone');
  const r = await importSysex(raw, { file: 'old entry' });
  assert.ok(r.patches.every((p) => p.device.maker === 'Roland'), 'no made-up vendors');
  assert.ok(r.report.some((e) => /length bytes/.test(e.note || '')));
});

test('Main Library import: damaged messages, the device a dump came from, ZIP archives', async () => {
  const { dt1 } = await import('../js/core/midi/roland.js');
  const good = Uint8Array.from(dt1([0x00, 0x06], 0x10, [0x02, 0, 0, 0], Array.from({ length: 0xf0 }, (_, i) => (i < 16 ? 'BA Good         '.charCodeAt(i) : 0))));
  const bad = Uint8Array.from(good.subarray(0, 60));
  bad[58] = 0x11; bad[59] = 0xf7; // cut short, wrong checksum
  const r = await importSysex([good, bad], { file: 'x.syx' });
  assert.deepEqual(r.patches.map((p) => [p.device.id, p.kind]), [['roland-jp8000', 'patch'], ['roland-jp8000', 'data']]);
  assert.match(r.patches[1].name, /Damaged JP-8000/);
  // Roland SysEx no editor reads, from the JP-8080's Librarian: the JP-8080's data
  const other = Uint8Array.from([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]);
  assert.equal((await importSysex([other])).patches[0].device.id, 'unknown');
  assert.equal((await importSysex([other], { device: 'roland-jp8080' })).patches[0].device.id, 'roland-jp8080');
  // ZIP: one stored and one deflated entry, a Mac resource fork, and a text file
  const deflate = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const zip = makeZip([['set/a.syx', good, 0], ['set/b.syx', good, 8, await deflate(good)], ['__MACOSX/set/._a.syx', good, 0], ['set/readme.txt', new TextEncoder().encode('hi'), 0]]);
  const z = await importFiles([{ name: 'Some_Sound_Set.zip', bytes: zip }]);
  assert.equal(z.patches.length, 2);
  assert.deepEqual(z.patches.map((p) => p.source.file), ['Some_Sound_Set.zip/set/a.syx', 'Some_Sound_Set.zip/set/b.syx']);
  if (has('D:/midi/jp8080/AlanM/jp80x0_rev_1.zip')) {
    const a = await importFiles([{ name: 'jp80x0_rev_1.zip', blob: await fs.openAsBlob('D:/midi/jp8080/AlanM/jp80x0_rev_1.zip') }]);
    assert.equal(a.patches.length, 384, 'the same 128 patches as .mid, .pat and .syx');
  }
  if (has('D:/midi/jp8080/_Presets/X-Plorations/X-Plorations_vol2.mid')) {
    const x = await importFiles([{ name: 'v2.mid', bytes: fs.readFileSync('D:/midi/jp8080/_Presets/X-Plorations/X-Plorations_vol2.mid') }]);
    assert.deepEqual(x.patches.map((p) => p.device.id + p.kind).filter((k, i, a) => a.indexOf(k) === i), ['roland-jp8000patch', 'roland-jp8000data']);
  }
});

/** A ZIP file from [name, bytes, method, compressed?]. */
function makeZip(entries) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const le = (n, w) => Array.from({ length: w }, (_, i) => (n >>> (8 * i)) & 255);
  const parts = [];
  const cd = [];
  let off = 0;
  for (const [name, data, method, comp = data] of entries) {
    const nm = [...new TextEncoder().encode(name)];
    const local = [...le(0x04034b50, 4), 20, 0, 0, 0, ...le(method, 2), 0, 0, 0, 0, ...le(crc(data), 4), ...le(comp.length, 4), ...le(data.length, 4), ...le(nm.length, 2), 0, 0, ...nm, ...comp];
    cd.push(...le(0x02014b50, 4), 20, 0, 20, 0, 0, 0, ...le(method, 2), 0, 0, 0, 0, ...le(crc(data), 4), ...le(comp.length, 4), ...le(data.length, 4), ...le(nm.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(off, 4), ...nm);
    parts.push(...local);
    off += local.length;
  }
  return Uint8Array.from([...parts, ...cd, ...le(0x06054b50, 4), 0, 0, 0, 0, ...le(entries.length, 2), ...le(entries.length, 2), ...le(cd.length, 4), ...le(off, 4), 0, 0]);
}

test('Main Library store: a sub-library device, edit, merge with samples', async () => {
  const folder = new MemoryFolder();
  const lib = await new MainLibrary(new KvStore(null), { pickFolder: async () => folder }).load();
  await lib.chooseFolder();
  const dev = { id: 'roland-jp8080', maker: 'Roland', model: 'JP-8080' };
  const a = await lib.createSub('A set', { device: dev });
  const b = await lib.createSub('B set');
  assert.deepEqual(lib.subs().find((s) => s.id === a).device, dev);
  assert.deepEqual((await lib.getSub(a)).device, dev);
  await lib.editSub(b, { name: 'B renamed', device: dev });
  assert.equal(lib.subs().find((s) => s.id === b).name, 'B renamed');
  const p1 = makePatch({ name: 'One', device: { ...dev, types: [] }, samples: [{ id: 'w1', file: 'samples/w1.wav' }] });
  const p2 = makePatch({ name: 'Two', device: { ...dev, types: [] } });
  await lib.addPatches(a, [p1], [{ id: 'w1', bytes: Uint8Array.from([9, 9]), info: {} }]);
  await lib.addPatches(b, [p2]);
  const bPath = lib.subs().find((s) => s.id === b).path;
  assert.equal(await lib.mergeSubs([a, b], b), 1);
  assert.ok(!lib.subs().some((s) => s.id === a), 'the merged-away sub-library is gone');
  assert.deepEqual((await lib.getSub(b)).patches.map((r) => r.name).sort(), ['One', 'Two']);
  assert.deepEqual(Array.from((await lib.getSample(b, 'w1')).bytes), [9, 9], 'samples come along');
  assert.ok(![...folder.files.keys()].some((k) => k.startsWith('A set/')), 'its folder is deleted');
  assert.ok(folder.files.has(`${bPath}/patches/${p1.id}.json`));
  const { niceName } = await import('../js/core/mainlib/format.js');
  assert.equal(niceName('X-Plorations_vol1'), 'X-Plorations vol1');
  assert.equal(niceName('Alan__M_ JP80x0'), 'Alan M JP80x0');
});

test('Main Library duplicates: by name, by settings, across models, and performance links', async () => {
  const { findDuplicates, applyDedup } = await import('../js/core/mainlib/dedup.js');
  const jp80 = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jp00 = (await import('../js/devices/defs/roland-jp8000.js')).default;
  const o80 = jp80.objects.find((o) => o.key === 'patch');
  const o00 = jp00.objects.find((o) => o.key === 'patch');
  const mk = (def, obj, entry, name, tweak = 0) => {
    const d = obj.init();
    d.set([...name.padEnd(16)].map((c) => c.charCodeAt(0)));
    d[0x29] = 50 + tweak; // filter cutoff
    return patchFromObject(getDevice(entry), def, obj, d);
  };
  const lib = await new MainLibrary(new KvStore(null), { pickFolder: async () => new MemoryFolder() }).load();
  const s1 = await lib.createSub('one');
  const s2 = await lib.createSub('two');
  const a = mk(jp80, o80, 'roland-jp8080', 'BA Fat');
  const aRenamed = mk(jp80, o80, 'roland-jp8080', 'BA Fat copy'); // same sound, other name
  const aOtherSound = mk(jp80, o80, 'roland-jp8080', 'ba  FAT', 7); // same name, other sound
  const a8000 = mk(jp00, o00, 'roland-jp8000', 'BA Fat'); // same sound on the JP-8000
  const perf = makePatch({ name: 'Perf', kind: 'performance', device: a.device, links: [{ role: 'Upper', id: aRenamed.id, name: aRenamed.name, kind: 'patch' }] });
  await lib.addPatches(s1, [a, aOtherSound, a8000]);
  await lib.addPatches(s2, [aRenamed, perf]);
  const byName = await findDuplicates(lib, { mode: 'name' });
  assert.equal(byName.length, 1);
  assert.equal(byName[0].members.length, 2);
  assert.ok(byName[0].differs, 'same name, different settings');
  const bySettings = await findDuplicates(lib, { mode: 'settings' });
  assert.deepEqual(bySettings.map((g) => g.members.map((m) => m.name).sort()), [['BA Fat', 'BA Fat copy']], 'names ignored');
  const anyModel = await findDuplicates(lib, { mode: 'settings', sameDevice: false, prefer: 'roland-jp8000' });
  assert.deepEqual(anyModel.map((g) => g.members.length), [3]);
  assert.equal(anyModel[0].members[0].device, 'roland-jp8000', 'the preferred model is kept');
  // keep "BA Fat" (sub one): the renamed copy in sub two goes, and the performance follows
  const r = await applyDedup(lib, bySettings);
  assert.deepEqual(r, { deleted: 1, relinked: 1 });
  const p = await lib.getPatch(s2, perf.id);
  assert.deepEqual([p.links[0].id, p.links[0].sub], [a.id, s1]);
  assert.equal(await lib.getPatch(s2, aRenamed.id), null);
});

test('Every device definition translates its sounds (the backlog shrinks, never grows)', async () => {
  const { DEF_IDS, loadDef } = await import('../js/devices/registry.js');
  // Definitions from before translators were required; remove an entry once its translator exists.
  const BACKLOG = { 'oberheim-matrix1000': ['patch'], 'roland-jv2080': ['patch', 'performance', 'rhythm'], 'korg-m1': ['program', 'combination'], 'korg-m1r': ['program', 'combination'] };
  const SETTINGS = /^(system|global|master|setup|utility)$/; // device settings, not sounds
  for (const id of DEF_IDS) {
    const def = await loadDef(id);
    for (const obj of def.objects || []) {
      if (SETTINGS.test(obj.key)) continue;
      const done = !!(obj.toCommon && obj.fromCommon);
      const listed = (BACKLOG[id] || []).includes(obj.key);
      assert.ok(done || listed, `${id} ${obj.key}: a new device needs obj.toCommon / obj.fromCommon (docs/MAIN_LIBRARY.md)`);
      assert.ok(!(done && listed), `${id} ${obj.key} has a translator now: take it off the backlog`);
    }
  }
});
