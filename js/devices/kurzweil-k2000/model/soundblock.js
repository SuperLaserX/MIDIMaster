// K2000 soundblock (sample) object: 12-byte header + 32-byte sample headers.
// Header: baseId(2) numHeaders-1(2) offsetToFirstHeader(2, =8 from its own field)
//         flags(1, bit0 = stereo pair) pad(1) copyId(2) pad(2)
// Sample header ("soundfilehead"), 32 bytes:
//   0 rootKey  1 flags (0x80 = one-shot/not looped, 0x40 = RAM data)  2 volAdjust (s8, 0.5 dB)
//   3 altVolAdjust  4 maxPitch(s16, cents)  6 nameOffset(s16, from this field)
//   8 start(s32 words)  12 altStart  16 loopStart  20 end (inclusive)  24 envOffset  26 altEnvOffset
//   28 period (s32 ns per sample)

import { s16be, s32be, toS8, readCString, put32be, fromS8 } from '../../../core/bits.js';
import { noteName } from './tables.js';
import { rateFromPeriod } from '../../../core/midi/sds.js';

export class Soundblock {
  constructor(data, { id = 0, name = '' } = {}) {
    this.id = id;
    this.name = name;
    this.data = Uint8Array.from(data);
    this.parse();
  }

  parse() {
    const d = this.data;
    this.baseId = s16be(d, 0);
    this.count = s16be(d, 2) + 1;
    this.firstHeader = 4 + s16be(d, 4);
    this.flags = d[6];
    this.stereo = !!(this.flags & 1);
    this.copyId = s16be(d, 8);
    this.headers = [];
    for (let i = 0; i < this.count; i++) {
      const o = this.firstHeader + i * 32;
      if (o + 32 > d.length) break;
      const nameRel = s16be(d, o + 6);
      const h = {
        index: i, offset: o,
        rootKey: d[o], flags: d[o + 1],
        looped: !(d[o + 1] & 0x80), inRam: !!(d[o + 1] & 0x40),
        volAdjust: toS8(d[o + 2]) / 2, altVolAdjust: toS8(d[o + 3]) / 2,
        maxPitch: s16be(d, o + 4),
        start: s32be(d, o + 8), altStart: s32be(d, o + 12), loopStart: s32be(d, o + 16), end: s32be(d, o + 20),
        period: s32be(d, o + 28),
        subName: '',
      };
      if (nameRel) [h.subName] = readCString(d, o + 6 + nameRel);
      h.frames = h.end - h.start + 1;
      h.rate = rateFromPeriod(h.period);
      h.seconds = h.frames / h.rate;
      h.rootName = noteName(h.rootKey);
      this.headers.push(h);
    }
  }

  totalFrames() { return this.headers.reduce((a, h) => a + h.frames, 0); }

  // Patches (offset into object, bytes) for LOAD.
  setRootKey(h, key) { return this._patch(h.offset, [key & 0x7f]); }
  setLooped(h, looped) { return this._patch(h.offset + 1, [looped ? this.data[h.offset + 1] & 0x7f : this.data[h.offset + 1] | 0x80]); }
  setVolAdjust(h, db) { return this._patch(h.offset + 2, [fromS8(Math.round(db * 2))]); }
  setLoopStart(h, word) { const b = new Uint8Array(4); put32be(b, 0, word); return this._patch(h.offset + 16, b); }
  setAltStart(h, word) { const b = new Uint8Array(4); put32be(b, 0, word); return this._patch(h.offset + 12, b); }

  _patch(offset, bytes) {
    const before = this.data.slice(offset, offset + bytes.length);
    this.data.set(bytes, offset);
    return { offset, bytes: Uint8Array.from(bytes), before };
  }
}
