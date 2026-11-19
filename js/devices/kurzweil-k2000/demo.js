// Demo mode: a simulated K2000 so the whole UI can be tried without hardware.
// Open MIDIMaster with ?demo in the URL.

import { Emitter } from '../../core/emitter.js';
import { MockK2000 } from './mock.js';
import { TAG } from './model/program.js';
import { MASTER_DEFAULT } from './model/fwparams.js';

function seg(tag, len, fill = {}) {
  const s = new Uint8Array(len);
  s[0] = tag;
  for (const [k, v] of Object.entries(fill)) s[1 + Number(k)] = v & 0xff;
  return s;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Segment contents follow the K2000 parameter table (fwmodel.js); keys here are data
// offsets without the tag byte, so firmware offset N is key N - 1.
function layer({ lo = 0, hi = 127, keymap = 1, alg = 2, codes = [2, 0, 40, 1], cutoff = 20, res = 30, att = 8, rel = 60, lfoRate = 90, vel = [0, 7] }) {
  return [
    seg(TAG.LAYER, 16, { 1: 0x18, 3: lo, 4: hi, 5: (vel[0] << 3) | (7 - vel[1]), 6: 127 }),
    seg(TAG.ASR1, 8, { 1: 0, 2: 0, 3: 0, 4: 20, 6: 40 }),
    seg(TAG.FUN1, 4, { 0: 1, 1: 1, 2: 0 }),
    seg(TAG.LFO1, 8, { 1: 0, 2: lfoRate, 3: lfoRate + 20, 4: 0, 5: 1 }),
    seg(TAG.ENVCTL, 16),
    seg(TAG.AMPENV, 16, { 0: 0, 1: 100, 2: att, 3: 100, 4: 0, 5: 100, 6: 0, 7: 80, 8: 40, 9: 0, 10: rel }),
    seg(TAG.ENV2, 16, { 1: 100, 2: 4, 7: 30, 8: 70, 9: 0, 10: 50 }),
    seg(TAG.CAL, 32, { 0: 0x7f, 3: 43, 11: keymap >> 8, 12: keymap, 19: 43, 21: 114, 22: 8, 29: alg }),
    seg(TAG.F1, 16, { 0: codes[0], 1: cutoff, 3: 4, 4: 10, 5: 121, 6: 40, 7: 1 }),
    seg(TAG.F2, 16, { 0: codes[1], 1: res }),
    seg(TAG.F3, 16, { 0: codes[2], 14: 0x70 }),
    seg(TAG.AMP, 16, { 0: codes[3], 4: 12, 5: 100, 6: 0, 14: 0x70 }),
  ];
}

function program(layers) {
  return concat([seg(TAG.PROGRAM, 16, { 0: 2, 1: layers.length, 3: 0x37, 4: 64 }), ...layers.flat(), new Uint8Array(2)]);
}

function keymap(samples) {
  const method = 0x17;
  const n = 48;
  const size = 6;
  const d = new Uint8Array(12 + 16 + n * size);
  const put16 = (o, v) => { d[o] = (v >> 8) & 0xff; d[o + 1] = v & 0xff; };
  put16(0, samples[0]); put16(2, method); put16(4, 2400); put16(6, 200); put16(8, n - 1); put16(10, size);
  for (let i = 0; i < 8; i++) put16(12 + i * 2, (8 - i) * 2);
  for (let i = 0; i < n; i++) {
    const o = 28 + i * size;
    put16(o, 0); d[o + 2] = 0; put16(o + 3, samples[Math.floor((i * samples.length) / n)]); d[o + 5] = 0;
  }
  return d;
}

function soundblock(frames, period, stereo = false, names = [], base = 0) {
  const count = stereo ? 2 : 1;
  const nameBytes = names.map((n) => [...n].map((c) => c.charCodeAt(0)).concat(0));
  const d = new Uint8Array(12 + 32 * count + nameBytes.reduce((a, b) => a + b.length, 0));
  const put16 = (o, v) => { d[o] = (v >> 8) & 0xff; d[o + 1] = v & 0xff; };
  const put32 = (o, v) => { d[o] = (v >>> 24) & 0xff; d[o + 1] = (v >> 16) & 0xff; d[o + 2] = (v >> 8) & 0xff; d[o + 3] = v & 0xff; };
  put16(2, count - 1); put16(4, 8); d[6] = stereo ? 1 : 0;
  let nameAt = 12 + 32 * count;
  for (let i = 0; i < count; i++) {
    const h = 12 + i * 32;
    d[h] = 60; d[h + 1] = 0x40; d[h + 2] = 0;
    put16(h + 4, 2400);
    const at = base + i * frames;
    put32(h + 8, at); put32(h + 12, at); put32(h + 16, at + Math.floor(frames / 2)); put32(h + 20, at + frames - 1);
    put32(h + 28, period);
    if (nameBytes[i]) { put16(h + 6, nameAt - (h + 6)); d.set(nameBytes[i], nameAt); nameAt += nameBytes[i].length; }
  }
  return d;
}

export function seedDemo(k2) {
  const roms = ['Acoustic Piano', 'Stage Piano', 'BriteGrand', 'ClassicPiano&Vox', 'Real Strings', 'Synth Brass', 'Fat Saw Lead', 'Choir Pad'];
  roms.forEach((n, i) => k2.put(132, i + 1, n, program([layer({ keymap: (i % 3) + 1, cutoff: 10 + i * 5, lfoRate: 60 + i * 10 })]), false));
  k2.put(132, 200, 'Demo Split Pad', program([
    layer({ lo: 0, hi: 59, keymap: 200, cutoff: 5, att: 60, rel: 120 }),
    layer({ lo: 60, hi: 127, keymap: 2, alg: 1, codes: [50, 0, 40, 1], cutoff: 30, res: 50, vel: [2, 7] }),
  ]), true);
  k2.put(132, 201, 'Demo Bass', program([layer({ keymap: 3, cutoff: -10, att: 3, rel: 20 })]), true);
  ['Grand Piano', 'Strings', 'Synth'].forEach((n, i) => k2.put(133, i + 1, n, keymap([i + 1]), false));
  k2.put(133, 200, 'My Keymap', keymap([200, 201]), true);
  ['Piano C4', 'Strings A3', 'Saw Wave'].forEach((n, i) => k2.put(134, i + 1, n, soundblock(40000, 22676), false));
  k2.put(134, 200, 'Stereo Loop', soundblock(88200, 22676, true, ['Loop L', 'Loop R']), true);
  k2.put(134, 201, 'Kick', soundblock(12000, 22676), true);
  k2.put(113, 1, 'Room Reverb', new Uint8Array(64), false);
  k2.put(135, 1, 'Basic Setup', new Uint8Array(128), false);
  k2.put(100, 16, 'Master', Uint8Array.from(MASTER_DEFAULT.match(/../g), (x) => parseInt(x, 16)), true);
  k2.makeSoundblock = (frames, period) => soundblock(frames, period);
  k2.sampleData = Int16Array.from({ length: 4000 }, (_, i) => Math.round(Math.sin(i / 10) * 12000 * Math.exp(-i / 2000)));
}

/**
 * A small .KRZ file built in memory for trying Disk Import in demo mode: a program,
 * its keymap, two looped samples, an effect and a K2600-only object.
 */
export function buildDemoKrz() {
  const frames = 2000;
  const audio = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    audio[i] = Math.round(Math.sin((i / 50) * 2 * Math.PI) * 16000);
    audio[frames + i] = Math.round(((i % 50) / 25 - 1) * 14000);
  }
  const objects = [
    { type: 132, id: 200, name: 'Demo Import Pad', data: program([layer({ keymap: 200, cutoff: 25, att: 40, rel: 90 })]) },
    { type: 133, id: 200, name: 'Demo Waves', data: keymap([200, 201]) },
    { type: 134, id: 200, name: 'Sine 882Hz', data: soundblock(frames, 22676, false, [], 0) },
    { type: 134, id: 201, name: 'Saw 882Hz', data: soundblock(frames, 22676, false, [], frames) },
    { type: 113, id: 5, name: 'Demo Hall', data: new Uint8Array(64) },
    { type: 141, id: 1, name: 'KDFX Preset', data: new Uint8Array(16) },
  ];
  const entries = objects.map((o) => {
    const hash = o.type >= 128 ? ((o.type - 96) << 10) | o.id : (o.type << 8) | o.id;
    const nameLen = o.name.length + 1 + ((o.name.length + 1) % 2);
    const size = 6 + nameLen + o.data.length;
    const e = new Uint8Array(size + (size & 1));
    e[0] = hash >> 8; e[1] = hash & 255; e[2] = size >> 8; e[3] = size & 255; e[4] = 0; e[5] = 2 + nameLen;
    for (let i = 0; i < o.name.length; i++) e[6 + i] = o.name.charCodeAt(i);
    e.set(o.data, 6 + nameLen);
    return e;
  });
  const body = concat(entries);
  const blockSize = 4 + body.length;
  const head = new Uint8Array(32);
  head.set([0x50, 0x52, 0x41, 0x4d]); // PRAM
  const sampleOffset = 32 + blockSize + 4;
  head.set([sampleOffset >>> 24, (sampleOffset >> 16) & 255, (sampleOffset >> 8) & 255, sampleOffset & 255], 4);
  head[18] = 387 >> 8; head[19] = 387 & 255; head[20] = 4;
  const block = new Uint8Array(blockSize);
  const neg = -blockSize;
  block.set([(neg >>> 24) & 255, (neg >>> 16) & 255, (neg >>> 8) & 255, neg & 255]);
  block.set(body, 4);
  const pcm = new Uint8Array(audio.length * 2);
  audio.forEach((v, i) => { pcm[i * 2] = (v >> 8) & 255; pcm[i * 2 + 1] = v & 255; });
  return new File([concat([head, block, new Uint8Array(4), pcm])], 'DEMO.KRZ');
}

export class DemoTransport extends Emitter {
  constructor() {
    super();
    this.mock = new MockK2000();
    seedDemo(this.mock);
    this.log = [];
    this.logLimit = 400;
    this.access = {};
    this.input = { id: 'demo-in', name: 'Demo K2000 (simulated)' };
    this.output = { id: 'demo-out', name: 'Demo K2000 (simulated)' };
    this.mock.on('sysex', (d) => { this._record('in', d); this.emit('sysex', d); });
  }

  get supported() { return true; }
  get connected() { return true; }
  async init() { return this.ports(); }
  ports() { return { inputs: [this.input], outputs: [this.output] }; }
  autoSelect() { return { input: this.input, output: this.output }; }
  open() { this.emit('connection', { input: this.input.name, output: this.output.name }); }
  close() {}

  send(bytes, at) {
    const d = Uint8Array.from(bytes);
    const record = () => this._record('out', d);
    if (at !== undefined && at > performance.now()) setTimeout(record, at - performance.now()); else record();
    if (d[0] === 0xf0) this.mock.send(d);
  }

  _record(dir, data) {
    const entry = { dir, time: performance.now(), data };
    this.log.push(entry);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    this.emit('traffic', entry);
  }
}
