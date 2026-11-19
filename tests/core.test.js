import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeBitstream, decodeBitstream, encodeNibbles, decodeNibbles, enc7, dec7, checksum } from '../js/core/bits.js';
import { build, parse, MSG, decodeScreenText } from '../js/devices/kurzweil-k2000/protocol.js';
import { K2Client } from '../js/devices/kurzweil-k2000/client.js';
import { SampleDump, sdsSampleNumber } from '../js/core/midi/sds.js';
import { Program, TAG } from '../js/devices/kurzweil-k2000/model/program.js';
import { ProgramMap, pageEntries, formatParam, readAt, writeAt, GROUPS, MASTER_DEFAULT_BYTES } from '../js/devices/kurzweil-k2000/model/fwmodel.js';
import { Keymap } from '../js/devices/kurzweil-k2000/model/keymap.js';
import { Soundblock } from '../js/devices/kurzweil-k2000/model/soundblock.js';
import { fmt } from '../js/devices/kurzweil-k2000/model/tables.js';
import { MockK2000 } from '../js/devices/kurzweil-k2000/mock.js';

const fast = { minGap: 1, timeout: 400 };

test('bit-stream and nibble encodings match the Kurzweil manual example', () => {
  const data = [0x4f, 0xd8, 0x01, 0x29];
  assert.deepEqual([...encodeBitstream(data)], [0x27, 0x76, 0x00, 0x12, 0x48]);
  assert.deepEqual([...encodeNibbles(data)], [0x04, 0x0f, 0x0d, 0x08, 0x00, 0x01, 0x02, 0x09]);
  assert.deepEqual([...decodeBitstream([0x27, 0x76, 0x00, 0x12, 0x48], 4)], data);
  assert.deepEqual([...decodeNibbles(encodeNibbles(data), 4)], data);
});

test('bit-stream round trip for every length 0..64', () => {
  for (let n = 0; n <= 64; n++) {
    const d = Uint8Array.from({ length: n }, (_, i) => (i * 73 + n * 11) & 0xff);
    assert.deepEqual([...decodeBitstream(encodeBitstream(d), n)], [...d], `length ${n}`);
  }
});

test('7-bit fields', () => {
  assert.deepEqual(enc7(132, 2), [1, 4]);
  assert.equal(dec7([1, 4], 0, 2), 132);
  assert.deepEqual(enc7(0x1fffff, 3), [0x7f, 0x7f, 0x7f]);
  assert.throws(() => enc7(128, 1));
});

test('LOAD and WRITE build/parse round trip with checksum', () => {
  const data = Uint8Array.from([1, 2, 250, 0, 99]);
  const load = parse(build.load(0, 132, 201, 37, data));
  assert.equal(load.msg, MSG.LOAD);
  assert.equal(load.type, 132); assert.equal(load.id, 201); assert.equal(load.offs, 37);
  assert.equal(load.checksumOk, true);
  assert.deepEqual([...load.data], [...data]);
  const w = parse(build.write(5, 133, 300, 0, 'Glass Kazoo', data));
  assert.equal(w.objName, 'Glass Kazoo');
  assert.equal(w.dev, 5);
  assert.deepEqual([...w.data], [...data]);
  // LOAD payload checksum is the low 7 bits of the encoded data sum
  const enc = encodeBitstream(data);
  const raw = build.load(0, 132, 201, 37, data);
  assert.equal(raw[raw.length - 2], checksum(enc));
});

test('hidden messages encode as the firmware expects', () => {
  assert.deepEqual([...build.memQuery(0)], [0xf0, 7, 0, 0x78, 0x12, 0xf7]);
  assert.deepEqual([...build.objAddr(0, 132, 201)], [0xf0, 7, 0, 0x78, 0x7c, 1, 4, 1, 0x49, 0xf7]);
  assert.deepEqual([...build.splitBlock(0, 210, 300)], [0xf0, 7, 0, 0x78, 0x79, 1, 0x52, 2, 0x2c, 0xf7]);
  const sub = build.subName(0, 210, 1, 'Left');
  assert.equal(sub.length, 5 + 4 + 32 + 1);
  assert.equal(sub[4], 0x7e);
  const mem = parse(Uint8Array.from([0xf0, 7, 0, 0x78, 0x13, 0, 3, 0x1e, 0, 5, 0x22, 0xf7]));
  assert.equal(mem.programFreeK, 414);
  assert.equal(mem.sampleFreeK, 1348);
  const addr = parse(Uint8Array.from([0xf0, 7, 0, 0x78, 0x7d, 1, 4, 1, 0x49, 0, 0, 1, 2, 0x0a, 0x0b, 0x0c, 0x0d, 0xf7]));
  assert.equal(addr.address, 0x0012abcd);
});

test('screen text decodes reverse-video bits', () => {
  const data = new Array(320).fill(0x20);
  data[0] = 0x41 | 0x80;
  const t = decodeScreenText(data);
  assert.equal(t.rows[0][0], 'A');
  assert.equal(t.inverse[0][0], true);
});

function sampleProgram() {
  const seg = (tag, len, fill = {}) => { const s = new Uint8Array(len); s[0] = tag; for (const [k, v] of Object.entries(fill)) s[1 + Number(k)] = v; return s; };
  const parts = [
    seg(TAG.PROGRAM, 16, { 1: 1, 3: 0x37, 4: 64 }),
    seg(TAG.LAYER, 16, { 1: 0x18, 3: 21, 4: 108, 5: (1 << 3) | (7 - 6), 6: 127, 8: 0x24 }),
    seg(TAG.LFO1, 8, { 2: 120 }),
    seg(TAG.ENVCTL, 16),
    seg(TAG.AMPENV, 16, { 0: 10, 1: 100, 7: 100, 8: 40 }),
    seg(TAG.CAL, 32, { 0: 0x7f, 1: 0xfe, 3: 43, 11: 0, 12: 199, 19: 43, 22: 130, 29: 1 }),
    seg(TAG.F1, 16, { 0: 2, 1: 9, 5: 121, 6: 20 }),
    seg(TAG.F2, 16, { 0: 16, 1: 30 }),
    seg(TAG.F3, 16, { 0: 60 }),
    seg(TAG.AMP, 16, { 0: 1, 4: 12 }),
    new Uint8Array(2),
  ];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const d = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { d.set(p, o); o += p.length; }
  return d;
}

test('program parser finds layers, segments and fields', () => {
  const p = new Program(sampleProgram(), { id: 201, name: 'Test' });
  assert.equal(p.warnings.length, 0);
  assert.equal(p.layerCount, 1);
  assert.equal(p.common.length, 1);
  const s = p.layerSummary(0);
  assert.equal(s.loKey, 21); assert.equal(s.hiKey, 108);
  assert.equal(s.loVel, 1); assert.equal(s.hiVel, 6);
  assert.equal(s.keymap, 199); assert.equal(s.algorithm, 1);
  // Field access through the parameter table extracted from the K2000 OS.
  const map = new ProgramMap(p);
  const entry = (page, name) => pageEntries(page).find((e) => e.name === name);
  const xpose = entry(0x53, 'Xpose');
  assert.equal(map.read(xpose.p, 0), -2);
  assert.equal(formatParam(xpose.p, -2), '-2ST');
  const blocks = map.dspBlocks(0);
  assert.equal(blocks[0].name, '2POLE LOWPASS');
  assert.equal(blocks[0].label, 'FRQ');
  const coarse = pageEntries(blocks[0].page, blocks[0].group).find((e) => e.name === 'Coarse');
  assert.match(formatParam(coarse.p, map.read(coarse.p, 0, 1)), /440Hz/);
});

test('firmware parameter writes produce minimal patches at absolute offsets', () => {
  const p = new Program(sampleProgram(), { id: 201 });
  const map = new ProgramMap(p);
  const lyr = p.segment(0, TAG.LAYER);
  const entry = (page, name) => pageEntries(page).find((e) => e.name === name);
  const hiVel = entry(0x52, 'HiVel').p;
  const loVel = entry(0x52, 'LoVel').p;
  assert.equal(formatParam(hiVel, map.read(hiVel, 0)), 'ff', 'stored as 7 - mark');
  const patch = map.write(hiVel, 0, null, 0);
  assert.equal(patch.offset, lyr.offset + 6);
  assert.equal(formatParam(hiVel, map.read(hiVel, 0)), 'fff');
  assert.equal(formatParam(loVel, map.read(loVel, 0)), 'pp', 'packed neighbour unchanged');
  assert.equal(map.write(hiVel, 0, null, 0), null, 'no-op write gives no patch');
  const km = entry(0x53, 'KeyMap').p; // KeyMap and KeyMap1 share one field
  const kp = map.write(km, 0, null, 300);
  assert.equal(kp.bytes.length, 2);
  assert.deepEqual([...kp.bytes], [1, 44]);
  // Bit fields in signed and unsigned containers.
  const d = new Uint8Array([0b10110100]);
  const bf = { t: 0x0d, sh: 2, w: 3 };
  assert.equal(readAt(d, 0, bf), 0b101);
  assert.deepEqual([...writeAt(d, 0, bf, 0b010).bytes], [0b10101000]);
  assert.ok(Object.keys(GROUPS).length > 100);
  assert.ok(MASTER_DEFAULT_BYTES.length > 300);
});

test('client: DIR, READ, live LOAD, editor lock and coalescing against the mock K2000', async () => {
  const k2 = new MockK2000();
  const prog = sampleProgram();
  k2.put(132, 201, 'Test Prog', prog);
  const c = new K2Client(k2, fast);

  const info = await c.dir(132, 201);
  assert.equal(info.objName, 'Test Prog');
  const obj = await c.fetchObject(132, 201);
  assert.deepEqual([...obj.data], [...prog]);

  const r = await c.load(132, 201, 20, Uint8Array.from([77]));
  assert.equal(r.msg, MSG.DACK);
  assert.equal(k2.get(132, 201).data[20], 77);

  k2.editing = '132:201';
  await assert.rejects(c.load(132, 201, 20, Uint8Array.from([78])), /open in the K2000 editor/);
  k2.editing = null;

  // Five rapid edits to one byte: queued ones are superseded by the latest.
  const ps = [1, 2, 3, 4, 5].map((v) => c.load(132, 201, 21, Uint8Array.from([v]), { key: 'x' }));
  const results = await Promise.all(ps);
  assert.ok(results.some((x) => x.superseded));
  assert.equal(k2.get(132, 201).data[21], 5);
});

test('client: DIRBANK collects INFO until ENDOFBANK; wrong device ID gets no reply', async () => {
  const k2 = new MockK2000();
  k2.put(132, 200, 'A', [1, 2]);
  k2.put(132, 201, 'B', [1, 2]);
  k2.put(133, 200, 'KM', [1, 2]);
  const c = new K2Client(k2, fast);
  const list = await c.dirBank(132, 127);
  assert.deepEqual(list.map((x) => x.objName), ['A', 'B']);
  const mem = await c.memory();
  assert.equal(mem.programFreeK, 414);
  c.setSettings({ deviceId: 5 });
  assert.equal(await c.ping(), false);
  c.setSettings({ deviceId: 0 });
  assert.equal(await c.ping(), true);
});

test('client: scanDeviceId finds the K2000', async () => {
  const k2 = new MockK2000({ deviceId: 3 });
  const c = new K2Client(k2, fast);
  assert.equal(await c.scanDeviceId([0, 1, 2, 3, 4]), 3);
});

test('SDS: send packets with handshake and receive a dump', async () => {
  const k2 = new MockK2000();
  const sds = new SampleDump(k2, 0);
  const pcm = Int16Array.from({ length: 100 }, (_, i) => (i * 655) - 32768);
  const res = await sds.send(pcm, { number: 205, sampleRate: 44100 });
  assert.equal(res.packets, 3);
  assert.equal(k2.sds.number, 205);
  assert.equal(k2.sds.packets.length, 3);

  k2.sampleData = Int16Array.from([0, 1000, -1000, 32767, -32768, 12345]);
  const got = await sds.receive(sdsSampleNumber(205, 1));
  assert.equal(got.samples.length, 6);
  assert.deepEqual([...got.samples], [0, 1000, -1000, 32767, -32768, 12345]);
  assert.equal(got.sampleRate, 44100);
  assert.equal(sdsSampleNumber(205, 1), 205 | 1024);
});

test('keymap parser reads level tables and entries', () => {
  const method = 0x17; // tuning16 + volume + sampleId + subSample
  const n = 3;
  const size = 6;
  const d = new Uint8Array(12 + 16 + n * size);
  const put16 = (o, v) => { d[o] = (v >> 8) & 0xff; d[o + 1] = v & 0xff; };
  put16(0, 0); put16(2, method); put16(4, 0); put16(6, 2400); put16(8, n - 1); put16(10, size);
  for (let i = 0; i < 8; i++) put16(12 + i * 2, (8 - i) * 2); // every level -> first table
  for (let i = 0; i < n; i++) { const o = 28 + i * size; put16(o, -5 & 0xffff); d[o + 2] = 0xfe; put16(o + 3, 200 + i); d[o + 5] = 0; }
  const km = new Keymap(d, { id: 300 });
  assert.equal(km.numEntries, 3);
  const e = km.entries(4);
  assert.deepEqual(e.map((x) => x.sampleId), [200, 201, 202]);
  assert.equal(e[0].tuning, -5);
  assert.equal(e[0].volume, -2);
  assert.equal(e[1].note, 36);
  const patch = km.setSample(e[2], 250);
  assert.equal(patch.offset, 28 + 2 * size + 3);
});

test('soundblock parser reads headers and sub-sample names', () => {
  const d = new Uint8Array(12 + 32 + 8);
  const put16 = (o, v) => { d[o] = (v >> 8) & 0xff; d[o + 1] = v & 0xff; };
  const put32 = (o, v) => { d[o] = (v >>> 24) & 0xff; d[o + 1] = (v >> 16) & 0xff; d[o + 2] = (v >> 8) & 0xff; d[o + 3] = v & 0xff; };
  put16(0, 0); put16(2, 0); put16(4, 8); d[6] = 0;
  const h = 12;
  d[h] = 60; d[h + 1] = 0x40; d[h + 2] = 0xfc;
  put16(h + 6, 44 - (h + 6)); // name right after the header, relative to this field
  put32(h + 8, 0); put32(h + 16, 100); put32(h + 20, 44099); put32(h + 28, 22676);
  d.set([76, 101, 102, 116, 0], 44);
  const sb = new Soundblock(d, { id: 210 });
  assert.equal(sb.headers.length, 1);
  const hd = sb.headers[0];
  assert.equal(hd.rootName, 'C4');
  assert.equal(hd.volAdjust, -2);
  assert.equal(hd.looped, true);
  assert.equal(hd.rate, 44100);
  assert.equal(hd.frames, 44100);
  assert.equal(hd.subName, 'Left');
});

test('master table: firmware MIDI settings read and live LOAD against the mock K2000', async () => {
  const { pageEntries: pe, modePage, masterOffset } = await import('../js/devices/kurzweil-k2000/model/fwmodel.js');
  const k2 = new MockK2000();
  k2.put(100, 16, 'Master', MASTER_DEFAULT_BYTES);
  const c = new K2Client(k2, fast);
  const obj = await c.fetchObject(100, 16);
  const m = modePage(0x06); // MIDI RECEIVE
  const sysexId = pe(m.page, m.group).find((e) => e.name === 'SysEx ID');
  const off = masterOffset(sysexId.p);
  const patch = writeAt(obj.data, off, sysexId.p, 5);
  await c.load(100, 16, patch.offset, patch.bytes);
  assert.equal(readAt(k2.get(100, 16).data, off, sysexId.p), 5);
  const chan = modePage(0x07);
  const vol = pe(chan.page, chan.group).find((e) => e.name === 'Volume');
  assert.equal(masterOffset(vol.p, 3) - masterOffset(vol.p, 1), 32, 'channel rows are 16 bytes apart');
});
