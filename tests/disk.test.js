import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { BlobSource, BytesSource } from '../js/core/disk/source.js';
import { FatVolume } from '../js/core/disk/fat.js';
import { IsoVolume } from '../js/core/disk/iso9660.js';
import { parseCue, firstDataTrack, baseName } from '../js/core/disk/cue.js';
import { openImage, openVolume } from '../js/core/disk/image.js';
import { readKrz, readAudio, decodeHash, programIssue, convertProgramForK2000, findKurzweilFiles } from '../js/devices/kurzweil-k2000/disk/krz.js';
import { describeObjects, buildPlan, createImportJob, keymapSamples, programKeymaps, closure } from '../js/devices/kurzweil-k2000/disk/importer.js';
import { sdsIdForNumber, sdsNumberForId } from '../js/devices/kurzweil-k2000/sds-ids.js';
import { MockK2000 } from '../js/devices/kurzweil-k2000/mock.js';
import { seedDemo } from '../js/devices/kurzweil-k2000/demo.js';
import { K2Client } from '../js/devices/kurzweil-k2000/client.js';
import { Soundblock } from '../js/devices/kurzweil-k2000/model/soundblock.js';
import { Program } from '../js/devices/kurzweil-k2000/model/program.js';
import { buildPattern } from '../js/core/ui/keyboard.js';

// ------------------------------------------------------------ builders
const put16le = (b, p, v) => { b[p] = v & 0xff; b[p + 1] = (v >> 8) & 0xff; };
const put32le = (b, p, v) => { put16le(b, p, v & 0xffff); put16le(b, p + 2, v >>> 16); };
const put16 = (b, p, v) => { b[p] = (v >> 8) & 0xff; b[p + 1] = v & 0xff; };
const put32 = (b, p, v) => { b[p] = (v >>> 24) & 0xff; b[p + 1] = (v >>> 16) & 0xff; b[p + 2] = (v >>> 8) & 0xff; b[p + 3] = v & 0xff; };
const putStr = (b, p, s) => { for (let i = 0; i < s.length; i++) b[p + i] = s.charCodeAt(i); };

/** A 1.44 MB FAT12 floppy with a fragmented long-named file in a subdirectory. */
function fatImage() {
  const img = new Uint8Array(2880 * 512);
  img.set([0xeb, 0x3c, 0x90]);
  putStr(img, 3, 'KMSI    ');
  put16le(img, 11, 512); img[13] = 1; put16le(img, 14, 1); img[16] = 2; put16le(img, 17, 224);
  put16le(img, 19, 2880); img[21] = 0xf0; put16le(img, 22, 9); img[38] = 0x29; putStr(img, 43, 'K2000 DISK ');
  img[510] = 0x55; img[511] = 0xaa;
  const fat = new Uint8Array(9 * 512);
  const setFat = (c, v) => {
    const o = c + (c >> 1);
    if (c & 1) { fat[o] = (fat[o] & 0x0f) | ((v << 4) & 0xf0); fat[o + 1] = (v >> 4) & 0xff; } else { fat[o] = v & 0xff; fat[o + 1] = (fat[o + 1] & 0xf0) | ((v >> 8) & 0x0f); }
  };
  setFat(0, 0xff0); setFat(1, 0xfff);
  setFat(2, 3); setFat(3, 0xfff); // README.TXT
  setFat(4, 0xfff); // SOUNDS directory
  setFat(5, 7); setFat(7, 6); setFat(6, 0xfff); // fragmented file
  img.set(fat, 512); img.set(fat, 10 * 512);
  const cluster = (c) => (33 + c - 2) * 512;
  const dirent = (p, name, ext, attr, cl, size) => { putStr(img, p, name.padEnd(8)); putStr(img, p + 8, ext.padEnd(3)); img[p + 11] = attr; put16le(img, p + 26, cl); put32le(img, p + 28, size); };
  const root = 19 * 512;
  dirent(root, 'README', 'TXT', 0x20, 2, 600);
  dirent(root + 32, 'SOUNDS', '', 0x10, 4, 0);
  for (let i = 0; i < 600; i++) img[cluster(2) + i] = 65 + (i % 26);
  const sub = cluster(4);
  dirent(sub, '.', '', 0x10, 4, 0);
  dirent(sub + 32, '..', '', 0x10, 0, 0);
  const short = 'LONGPI~1KRZ';
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) ? 0x80 : 0) + (sum >> 1) + short.charCodeAt(i)) & 0xff;
  const long = 'Long Piano Name.krz';
  const lfn = (p, seq, part) => {
    img[p] = seq; img[p + 11] = 0x0f; img[p + 13] = sum;
    const pos = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    pos.forEach((o, i) => put16le(img, p + o, i < part.length ? part.charCodeAt(i) : i === part.length ? 0 : 0xffff));
  };
  lfn(sub + 64, 0x42, long.slice(13));
  lfn(sub + 96, 0x01, long.slice(0, 13));
  dirent(sub + 128, 'LONGPI~1', 'KRZ', 0x20, 5, 1300);
  const content = Uint8Array.from({ length: 1300 }, (_, i) => (i * 7) & 255);
  img.set(content.subarray(0, 512), cluster(5));
  img.set(content.subarray(512, 1024), cluster(7));
  img.set(content.subarray(1024), cluster(6));
  return { img, content };
}

/** Wrap logical 2048-byte sectors into raw 2352-byte MODE1 CD sectors. */
function rawCd(logical) {
  const n = Math.ceil(logical.length / 2048);
  const raw = new Uint8Array(n * 2352);
  for (let s = 0; s < n; s++) {
    const o = s * 2352;
    raw[o] = 0; raw.fill(0xff, o + 1, o + 11); raw[o + 11] = 0; raw[o + 15] = 1;
    raw.set(logical.subarray(s * 2048, s * 2048 + 2048), o + 16);
  }
  return raw;
}

function isoImage() {
  const img = new Uint8Array(20 * 2048);
  const rec = (p, name, lba, size, dir) => {
    const len = 33 + name.length + ((33 + name.length) % 2);
    img[p] = len; put32le(img, p + 2, lba); put32le(img, p + 10, size); img[p + 25] = dir ? 2 : 0; img[p + 32] = name.length; putStr(img, p + 33, name);
    return len;
  };
  const pvd = 16 * 2048;
  img[pvd] = 1; putStr(img, pvd + 1, 'CD001'); img[pvd + 6] = 1; putStr(img, pvd + 40, 'TESTCD'.padEnd(32)); put16le(img, pvd + 128, 2048);
  rec(pvd + 156, '\0', 18, 2048, true);
  img[17 * 2048] = 255; putStr(img, 17 * 2048 + 1, 'CD001');
  let p = 18 * 2048;
  p += rec(p, '\0', 18, 2048, true);
  p += rec(p, '\u0001', 18, 2048, true);
  rec(p, 'SAMPLE.KRZ;1', 19, 100, false);
  for (let i = 0; i < 100; i++) img[19 * 2048 + i] = i;
  return img;
}

function seg(tag, len, fill = {}) {
  const s = new Uint8Array(len);
  s[0] = tag;
  for (const [k, v] of Object.entries(fill)) s[1 + Number(k)] = v & 0xff;
  return s;
}
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

function programData(keymapId, mode = 2, extra = []) {
  return cat(seg(0x08, 16, { 0: mode, 1: 1 }), seg(0x09, 16, { 3: 0, 4: 127 }), seg(0x40, 32, { 11: keymapId >> 8, 12: keymapId }), ...extra, new Uint8Array(2));
}

function keymapData(samples) {
  const n = 12;
  const size = 6;
  const d = new Uint8Array(12 + 16 + n * size);
  put16(d, 0, samples[0]); put16(d, 2, 0x17); put16(d, 4, 2400); put16(d, 6, 400); put16(d, 8, n - 1); put16(d, 10, size);
  for (let i = 0; i < 8; i++) put16(d, 12 + i * 2, (8 - i) * 2);
  for (let i = 0; i < n; i++) put16(d, 28 + i * size + 3, samples[i % samples.length]);
  return d;
}

function soundblockData(start, frames) {
  const d = new Uint8Array(12 + 32);
  put16(d, 4, 8);
  d[12] = 60; d[13] = 0x40;
  put32(d, 20, start); put32(d, 24, start); put32(d, 28, start + Math.floor(frames / 2)); put32(d, 32, start + frames - 1); put32(d, 40, 22676);
  return d;
}

/** A KRZ file: objects [{type, id, name, data}] plus 16-bit audio. */
function krzFile(objects, audio = new Int16Array(0)) {
  const entries = objects.map((o) => {
    const hash = o.type >= 128 ? ((o.type - 96) << 10) | o.id : (o.type << 8) | o.id;
    const nameLen = o.name.length + 1 + ((o.name.length + 1) % 2);
    const nameOffset = 2 + nameLen;
    const size = 4 + nameOffset + o.data.length;
    const e = new Uint8Array(size + (size & 1));
    put16(e, 0, hash); put16(e, 2, size); put16(e, 4, nameOffset); putStr(e, 6, o.name); e.set(o.data, 4 + nameOffset);
    return e;
  });
  const body = cat(...entries);
  const block = new Uint8Array(4 + body.length);
  put32(block, 0, -(4 + body.length)); block.set(body, 4);
  const head = new Uint8Array(32);
  putStr(head, 0, 'PRAM');
  const sampleOffset = 32 + block.length + 4;
  put32(head, 4, sampleOffset); put16(head, 18, 387); head[20] = 4;
  const pcm = new Uint8Array(audio.length * 2);
  audio.forEach((v, i) => put16(pcm, i * 2, v & 0xffff));
  return cat(head, block, new Uint8Array(4), pcm);
}

// ------------------------------------------------------------ tests
test('FAT12: long names, subdirectories and fragmented files', async () => {
  const { img, content } = fatImage();
  const vol = await FatVolume.open(new BytesSource(img));
  assert.equal(vol.bits, 12);
  assert.equal(vol.label, 'K2000 DISK');
  const root = await vol.list();
  assert.deepEqual(root.map((e) => e.name), ['README.TXT', 'SOUNDS']);
  const files = [];
  for await (const f of vol.walk()) files.push(f);
  assert.deepEqual(files.map((f) => f.path), ['README.TXT', 'SOUNDS/Long Piano Name.krz']);
  const krz = files[1];
  assert.equal(krz.entry.shortName, 'LONGPI~1.KRZ');
  assert.equal(vol.extents(krz.entry.cluster, 1300).length, 3); // clusters 5, 7, 6: no two adjacent in order
  const bytes = await vol.fileSource(krz.entry).read(0, 1300);
  assert.deepEqual(bytes, content);
  assert.deepEqual(await vol.fileSource(krz.entry).read(500, 30), content.subarray(500, 530));
});

test('Raw 2352-byte CD images are detected and translated', async () => {
  const { img, content } = fatImage();
  const raw = rawCd(img);
  const { volume, layout } = await openImage(new Blob([raw]), { name: 'disc.bin' });
  assert.equal(layout.sectorSize, 2352);
  assert.equal(layout.dataOffset, 16);
  const found = await findKurzweilFiles(volume);
  assert.equal(found.length, 1);
  assert.deepEqual(await volume.fileSource(found[0].entry).read(0, 1300), content);
  // Plain 2048-byte images and blob sources work too.
  const plain = await openVolume(new BlobSource(new Blob([img])));
  assert.equal(plain.kind, 'FAT');
});

test('Cue sheets: data track layout and file names', () => {
  const cue = parseCue('FILE "C:\\Rips\\K2000 CD.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    INDEX 01 10:00:00\r\n');
  const t = firstDataTrack(cue);
  assert.equal(t.fileName, 'K2000 CD.bin');
  assert.equal(t.sectorSize, 2352);
  assert.equal(t.dataOffset, 16);
  assert.equal(t.start, 0);
  assert.equal(baseName('/home/x/disc.BIN'), 'disc.BIN');
});

test('ISO 9660 directories and files', async () => {
  const vol = await IsoVolume.open(new BytesSource(isoImage()));
  assert.equal(vol.label, 'TESTCD');
  const list = await vol.list();
  assert.deepEqual(list.map((e) => e.name), ['SAMPLE.KRZ']);
  const data = await vol.fileSource(list[0]).read(0, 100);
  assert.equal(data[0], 0); assert.equal(data[99], 99);
});

test('KRZ files: objects, hashes, audio and dependencies', async () => {
  assert.deepEqual(decodeHash(0x9000 | 200), { fileType: 36, id: 200, type: 132 });
  assert.deepEqual(decodeHash((113 << 8) | 5), { fileType: 113, id: 5, type: 113 });
  const audio = Int16Array.from({ length: 100 }, (_, i) => (i - 50) * 600);
  const file = krzFile([
    { type: 132, id: 200, name: 'Test Prog', data: programData(200) },
    { type: 133, id: 200, name: 'Test Map', data: keymapData([200]) },
    { type: 134, id: 200, name: 'Test Wave', data: soundblockData(0, 100) },
    { type: 141, id: 1, name: 'KDFX thing', data: new Uint8Array(8) },
  ], audio);
  const krz = await readKrz(new BytesSource(file, 'TEST.KRZ'));
  assert.equal(krz.osVersion, 3.87);
  assert.deepEqual(krz.objects.map((o) => `${o.type}:${o.id}:${o.name}`), ['132:200:Test Prog', '133:200:Test Map', '134:200:Test Wave', '141:1:KDFX thing']);
  assert.deepEqual(await readAudio(krz, 10, 5), audio.subarray(10, 15));
  const items = describeObjects(krz);
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.deepEqual(byKey['132:200'].deps, ['133:200']);
  assert.deepEqual(byKey['133:200'].deps, ['134:200']);
  assert.equal(byKey['134:200'].audio.words, 100);
  assert.equal(byKey['141:1'].status, 'unsupported');
  assert.deepEqual([...closure(items, ['132:200'])].sort(), ['132:200', '133:200', '134:200']);
});

test('K2600 programs: detection and experimental conversion', () => {
  const k26 = programData(5, 4, [seg(0x68, 8)]);
  assert.match(programIssue(k26), /K2600/);
  assert.equal(programIssue(programData(5)), null);
  const { data, notes } = convertProgramForK2000(k26);
  assert.equal(data[1], 2);
  assert.ok(notes.length >= 2);
  const p = new Program(data);
  assert.deepEqual(p.segments.map((s) => s.tag), [0x08, 0x09, 0x40]);
  assert.deepEqual(programKeymaps(data), [5]);
});

test('Import plan: free IDs and remapped references', async () => {
  const file = krzFile([
    { type: 132, id: 200, name: 'P', data: programData(200) },
    { type: 133, id: 200, name: 'K', data: keymapData([200, 201]) },
    { type: 134, id: 200, name: 'S1', data: soundblockData(0, 40) },
    { type: 134, id: 201, name: 'S2', data: soundblockData(40, 40) },
  ], new Int16Array(80));
  const items = describeObjects(await readKrz(new BytesSource(file)));
  const existing = new Map([[132, new Set([200])], [133, new Set([200, 201])], [134, new Set([200, 202])]]);
  const plan = buildPlan(items, ['132:200'], { mode: 'free', existing });
  const ids = Object.fromEntries(plan.steps.map((s) => [`${s.type}:${s.id}`, s.newId]));
  assert.deepEqual(ids, { '134:200': 201, '134:201': 203, '133:200': 202, '132:200': 201 });
  assert.deepEqual(plan.steps.map((s) => s.type), [134, 134, 133, 132]); // samples first
  const km = plan.steps.find((s) => s.type === 133);
  assert.deepEqual(keymapSamples(km.data).sort(), [201, 203]);
  assert.deepEqual(programKeymaps(plan.steps.find((s) => s.type === 132).data), [202]);
  assert.equal(plan.replacements.length, 0);
  const keep = buildPlan(items, ['132:200'], { mode: 'keep', existing });
  assert.equal(keep.replacements.length, 3);
  const bank = buildPlan(items, ['132:200'], { mode: 'bank', bank: 5, existing });
  assert.deepEqual(bank.steps.map((s) => s.newId), [500, 501, 500, 500]);
});

test('SDS sample numbers follow the firmware placement rule', () => {
  assert.equal(sdsIdForNumber(204), 205);
  assert.equal(sdsIdForNumber(5), 206);
  assert.equal(sdsIdForNumber(0, (id) => id === 200), 201);
  assert.equal(sdsNumberForId(205), 204);
  assert.equal(sdsIdForNumber(sdsNumberForId(999)), 999);
});

test('Import job: samples by SDS into temporary IDs, then rebased WRITEs', async () => {
  const audio = Int16Array.from({ length: 120 }, (_, i) => Math.round(Math.sin(i / 5) * 20000));
  const file = krzFile([
    { type: 132, id: 200, name: 'Imported', data: programData(200) },
    { type: 133, id: 200, name: 'Map', data: keymapData([200]) },
    { type: 134, id: 200, name: 'Wave', data: soundblockData(20, 100) },
  ], audio);
  const krz = await readKrz(new BytesSource(file));
  const mock = new MockK2000();
  seedDemo(mock);
  const client = new K2Client(mock, { deviceId: 0, minGap: 0, timeout: 2000 });
  const existing = new Map([[134, new Set([200, 201])], [133, new Set([200])], [132, new Set([200, 201])]]);
  const plan = buildPlan(describeObjects(krz), ['132:200'], { mode: 'free', existing });
  const job = createImportJob(plan, { client, transport: mock, deviceId: 0, krz, existing, settleMs: 5 });
  const res = await job.run();
  assert.equal(res.failed.length, 0, res.failed.map((f) => f.error.message).join());
  assert.equal(res.done.length, 3);
  const sent = mock.sdsLog[0];
  assert.equal(sent.id, 999); // temporary ID
  assert.equal(mock.get(134, 999), undefined); // deleted again
  assert.deepEqual(sent.samples, audio.subarray(20, 120));
  const blk = new Soundblock(mock.get(134, 202).data);
  assert.equal(blk.headers[0].start, sent.base);
  assert.equal(blk.headers[0].end, sent.base + 99);
  assert.equal(blk.headers[0].loopStart, sent.base + 50);
  assert.equal(mock.get(134, 202).name, 'Wave');
  assert.deepEqual(keymapSamples(mock.get(133, 201).data), [202]);
  assert.deepEqual(programKeymaps(mock.get(132, 202).data), [201]);
});

test('Test pattern: progression, run and overlapping glide notes', () => {
  const { events, beats } = buildPattern('all');
  assert.equal(beats, 4 * 4 + 8 + 8, 'the 1-5-6-4 progression, a run and a glide');
  const ons = events.filter((e) => e.on);
  assert.equal(ons.length, events.length / 2);
  assert.equal(ons.filter((e) => e.beat === 0).length, 3); // the first chord
  // Glide: the second note starts before the first one ends.
  const glide = buildPattern('glide').events;
  const firstOff = glide.find((e) => !e.on && e.id === 0).beat;
  const secondOn = glide.find((e) => e.on && e.id === 1).beat;
  assert.ok(secondOn < firstOff);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].beat >= events[i - 1].beat);
});

const REAL_KRZ = 'D:/midi/K2000/New/TR909-0.KRZ';
test('Real files from D:/midi (skipped when absent)', { skip: !fs.existsSync(REAL_KRZ) }, async () => {
  const krz = await readKrz(new BlobSource(await fs.openAsBlob(REAL_KRZ), 'TR909-0.KRZ'));
  const items = describeObjects(krz);
  assert.equal(items.filter((i) => i.type === 134).length, 11);
  assert.ok(items.every((i) => i.status === 'ok'));
  const iso = fs.readdirSync('D:/midi/K2000').find((n) => /\.iso$/i.test(n));
  if (iso) {
    const { volume } = await openImage(await fs.openAsBlob(`D:/midi/K2000/${iso}`), { name: iso });
    const found = await findKurzweilFiles(volume);
    assert.ok(found.length > 0);
    const first = await readKrz(volume.fileSource(found[0].entry));
    assert.ok(first.objects.length > 0);
  }
});

test('Head Library: K2000 programs with samples go to the library and back through the import job', async () => {
  const { importFiles } = await import('../js/core/mainlib/importers.js');
  const { krzFromPatches, programFromK2000 } = await import('../js/devices/kurzweil-k2000/disk/mainlib.js');
  const { getDevice } = await import('../js/devices/registry.js');
  const audio = Int16Array.from({ length: 120 }, (_, i) => Math.round(Math.sin(i / 5) * 20000));
  const file = krzFile([
    { type: 132, id: 200, name: 'BA Imported', data: programData(200) },
    { type: 133, id: 200, name: 'Map', data: keymapData([200]) },
    { type: 134, id: 200, name: 'Wave', data: soundblockData(20, 100) },
  ], audio);
  const r = await importFiles([{ name: 'set.krz', bytes: file }]);
  assert.equal(r.patches.length, 1);
  const p = r.patches[0];
  assert.equal(p.kind, 'program');
  assert.equal(p.category.id, 'synth-bass');
  assert.deepEqual(p.native.objects.map((o) => `${o.type}:${o.id}`), ['132:200', '133:200', '134:200']);
  assert.deepEqual(p.samples.map((s) => s.words), [[20, 119]]);
  const wav = new Map(r.samples.map((s) => [s.id, s]));

  // back: a Kurzweil file in memory, sent by the normal import job
  const krz = await krzFromPatches([p], async (id) => wav.get(id) || null, 'lib');
  assert.deepEqual(Array.from(await readAudio(krz, 20, 100)), Array.from(audio.subarray(20, 120)), 'the sample area is rebuilt word for word');
  const mock = new MockK2000();
  seedDemo(mock);
  const client = new K2Client(mock, { deviceId: 0, minGap: 0, timeout: 2000 });
  const existing = new Map([[134, new Set([200, 201])], [133, new Set([200])], [132, new Set([200, 201])]]);
  const plan = buildPlan(describeObjects(krz), ['132:200'], { mode: 'free', existing });
  const res = await createImportJob(plan, { client, transport: mock, deviceId: 0, krz, existing, settleMs: 5 }).run();
  assert.equal(res.failed.length, 0, res.failed.map((f) => f.error.message).join());
  assert.equal(res.done.length, 3);
  assert.deepEqual(mock.sdsLog[0].samples, audio.subarray(20, 120), 'the audio reached the K2000');
  assert.equal(mock.get(132, 202).name, 'BA Imported');

  // and from the K2000 into the library again, audio by Sample Dump (stubbed here)
  const got = await programFromK2000(client, getDevice('kurzweil-k2000'), 202, {
    receive: async (sid, index) => (sid === 202 && index === 0 ? { samples: mock.sdsLog[0].samples, sampleRate: 44100, loop: false } : null),
  });
  assert.deepEqual(got.patch.native.objects.map((o) => `${o.type}:${o.id}`), ['132:202', '133:201', '134:202']);
  assert.equal(got.samples.length, 1);
  const base = new Soundblock(mock.get(134, 202).data).headers[0].start;
  assert.deepEqual(got.patch.samples[0].words, [base, base + 99], 'audio placed where the K2000 keeps it');
  const krz2 = await krzFromPatches([got.patch], async (id) => got.samples.find((s) => s.id === id) || null);
  assert.deepEqual(Array.from(await readAudio(krz2, base, 100)), Array.from(audio.subarray(20, 120)));
  const plan2 = buildPlan(describeObjects(krz2), ['132:202'], { mode: 'free', existing: new Map() });
  assert.equal(plan2.skipped.length, 0, plan2.skipped.map((s) => s.reason).join());
  assert.equal(plan2.steps.length, 3);
});
