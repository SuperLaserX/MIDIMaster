// MIDI pacing without page timers: the device client and Sample Dump schedule messages with Web MIDI
// timestamps (core/midi/schedule.js) instead of sleeping between them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceClient } from '../js/core/midi/device-client.js';
import { Emitter } from '../js/core/emitter.js';

class FakeTransport extends Emitter {
  constructor() { super(); this.out = []; }
  send(bytes, at) { this.out.push({ bytes: Array.from(bytes), at, now: performance.now() }); }
}

test('device client: messages after the first go out at timestamps a gap apart', async () => {
  const t = new FakeTransport();
  const c = new DeviceClient(t, { minGap: 40, timeout: 500 });
  const sent = [1, 2, 3].map((n) => c.send([0xf0, n, 0xf7]));
  await Promise.all(sent);
  assert.equal(t.out.length, 3);
  assert.equal(t.out[0].at, undefined, 'the first goes out at once');
  for (let i = 1; i < 3; i++) {
    assert.ok(t.out[i].at > t.out[i].now, `message ${i + 1} is scheduled, not slept for`);
    const prev = t.out[i - 1].at ?? t.out[i - 1].now;
    assert.ok(Math.abs(t.out[i].at - prev - 40) < 2, `message ${i + 1}: 40 ms after the one before`);
  }
  assert.ok(t.out[2].now - t.out[0].now < 30, 'queued messages are handed over without waiting a gap each');
});

test('device client: gapAfter leaves room for a long message; keyed edits still coalesce', async () => {
  const t = new FakeTransport();
  const c = new DeviceClient(t, { minGap: 20, timeout: 500 });
  const a = await c.send([0xf0, 1, 0xf7], { gapAfter: 100 });
  await c.send([0xf0, 2, 0xf7]);
  const second = t.out[1].at;
  assert.ok(Math.abs(second - ((a.at ?? t.out[0].now) + 120)) < 2, 'the next message waits gap + gapAfter');
  // live edits with the same key replace each other while they wait
  const k = [5, 6, 7].map((v) => c.send([0xb0, 7, v], { key: 'vol' }));
  const r = await Promise.all(k);
  assert.ok(r.filter((x) => x.superseded).length >= 1, 'coalesced');
  assert.deepEqual(t.out[t.out.length - 1].bytes, [0xb0, 7, 7], 'the last value is the one sent');
});

test('device client: a request scheduled later waits for its reply that much longer', async () => {
  const t = new FakeTransport();
  const c = new DeviceClient(t, { minGap: 150, timeout: 60 });
  await c.send([0xf0, 1, 0xf7]);
  const p = c.request([0xf0, 0x7e, 0, 6, 1, 0xf7], { match: (m, raw) => raw[3] === 6 && raw[4] === 2 });
  // the request goes out about 150 ms from now; answer 120 ms after that (past the plain 60 ms timeout from now)
  setTimeout(() => t.emit('sysex', Uint8Array.from([0xf0, 0x7e, 0, 6, 2, 0xf7])), 190);
  const reply = await p;
  assert.equal(reply.raw[4], 2);
  assert.ok(t.out[1].at > t.out[1].now, 'the request was scheduled');
});
