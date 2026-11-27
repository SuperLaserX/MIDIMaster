// Complete dumps (js/devices/generic/fulldump.js): steps end when their replies are in, and the result
// is kept as one Branch Library entry per bank of sounds plus one for the rest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fullDumpSteps, dumpEntries, requestAndRecord, optionalGroups, estimateSeconds } from '../js/devices/generic/fulldump.js';
import { Emitter } from '../js/core/emitter.js';

test('complete dump: each bank of sounds is an entry of its own, settings and templates together', async () => {
  const DEF = (await import('../js/devices/defs/access-virus-ti2.js')).default;
  const sim = DEF.simulate();
  const ctx = { deviceId: 0x10 };
  const steps = fullDumpSteps(DEF);
  assert.equal(optionalGroups(steps)[0].steps.length, 26, 'the ROM banks are one optional group');
  assert.ok(estimateSeconds(steps) > 3600, 'the TI sends one dump a second: over an hour with ROM');
  const results = steps.map((step) => {
    const got = (sim.handle(Uint8Array.from(step.bytes(ctx))) || []).map((m) => Uint8Array.from(m));
    return { label: step.label, count: got.length, messages: got, step };
  });
  const keys = new Set(DEF.objects.filter((o) => o.toCommon).map((o) => o.key));
  const entries = dumpEntries(results, (msgs) => DEF.libraryItems(msgs, ctx).some((it) => keys.has(it.object)));
  const labels = entries.map((e) => e.label);
  for (const l of ['Single edit buffer', 'RAM A singles', 'RAM D singles', 'RAM multis', 'ROM A singles', 'ROM Z singles']) assert.ok(labels.includes(l), l);
  const rest = entries[entries.length - 1];
  assert.equal(rest.label, 'Settings and other data');
  assert.equal(rest.messages.length, 32 * 32, 'every remote template record, in one entry');
  assert.deepEqual(rest.merged, ['the 32 remote templates (one request per record)']);
});

test('complete dump: a step with `expect` ends when its replies are in', async () => {
  const transport = new Emitter();
  const sent = [];
  const client = { send: async (b) => { sent.push(b); setTimeout(() => { transport.emit('sysex', Uint8Array.of(0xf0, 1, 0xf7)); transport.emit('sysex', Uint8Array.of(0xf0, 2, 0xf7)); }, 5); } };
  const t0 = performance.now();
  const got = await requestAndRecord({ transport, client, ctx: {} }, { bytes: () => [0xf0, 9, 0xf7], expect: 2, quiet: 5000, timeout: 5000 });
  assert.equal(got.length, 2);
  assert.ok(performance.now() - t0 < 1000, 'no quiet wait after the last expected reply');
});

test('complete dump job: runs without its page, keeps going, saves each bank as an entry and says so', async () => {
  const { startCompleteDump, startCapture } = await import('../js/devices/generic/dumpjob.js');
  const transport = new Emitter();
  const saved = [];
  const events = [];
  const g = new Emitter();
  Object.assign(g, {
    entry: { id: 'test-synth', model: 'Test' }, def: null, ctx: {}, job: null, destroyed: false, transport,
    client: { s: { minGap: 0 }, send: async (b) => { setTimeout(() => { for (let i = 0; i < b[1]; i++) transport.emit('sysex', Uint8Array.of(0xf0, 0x40 + i, 0xf7)); }, 2); } },
    host: { device: { value: {} }, library: { put: async (e) => { saved.push(e); return saved.length; } } },
    setBusy: (n, t) => events.push(['busy', n, t]), error: (e) => { throw e; },
  });
  g.on('job', (j) => events.push(['job', j ? j.step?.label : null]));
  let libraryEvents = 0;
  g.on('library', () => { libraryEvents++; });
  const steps = [
    { label: 'Bank A', bytes: () => [0xf0, 3, 0xf7], expect: 3, timeout: 1000, seconds: 3, separate: true },
    { label: 'Bank B', bytes: () => [0xf0, 2, 0xf7], expect: 2, timeout: 1000, seconds: 2, separate: true },
    { label: 'Settings', bytes: () => [0xf0, 1, 0xf7], expect: 1, timeout: 1000, seconds: 1, separate: false },
  ];
  const done = startCompleteDump(g, steps);
  assert.ok(g.job, 'the job is on the device, not on a page');
  assert.throws(() => startCompleteDump(g, steps), /still running/, 'one job at a time');
  await done;
  assert.equal(g.job, null);
  assert.deepEqual(saved.map((e) => e.name.replace(/ complete dump .*: /, ': ')), ['Test: Bank A', 'Test: Bank B', 'Test: Settings and other data']);
  assert.equal(saved[0].bytes.length, 9);
  assert.equal(libraryEvents, 1);
  assert.ok(events.some(([k, l]) => k === 'job' && l === 'Bank B'), 'progress reaches the page when it is open');
  assert.deepEqual(events.filter(([k]) => k === 'busy').at(-1), ['busy', 0, undefined], 'the busy line goes away at the end');

  // a recording stopped by leaving the device keeps what arrived
  saved.length = 0;
  startCapture(g, { quiet: 5000 });
  transport.emit('sysex', Uint8Array.of(0xf0, 0x41, 0xf7));
  g.destroyed = true;
  g.emit('destroyed');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(saved.length, 1);
  assert.equal(g.job, null);
});

test('complete dump: a step counts only its own replies (a stray dump does not shift the steps after it)', async () => {
  const DEF = (await import('../js/devices/defs/access-virus-ti2.js')).default;
  const sim = DEF.simulate();
  const ctx = { deviceId: 0x10 };
  const steps = fullDumpSteps(DEF);
  const ramA = steps.find((s) => s.label === 'RAM A singles');
  const multis = steps.find((s) => s.label === 'RAM multis');
  const transport = new Emitter();
  // RAM A's answer, with the multis of another request arriving in the middle
  const strays = (sim.handle(Uint8Array.from(multis.bytes(ctx))) || []).slice(0, 5);
  const client = { send: async (b) => { const out = sim.handle(Uint8Array.from(b)) || []; setTimeout(() => { out.forEach((m, i) => { transport.emit('sysex', Uint8Array.from(m)); if (i === 10) strays.forEach((x) => transport.emit('sysex', Uint8Array.from(x))); }); }, 1); } };
  const got = await requestAndRecord({ transport, client, ctx }, ramA);
  assert.equal(got.length, 128);
  assert.ok(got.every((m) => m[6] === 0x10 && m[7] === 1), 'only RAM A singles');
  const { DeviceClient } = await import('../js/core/midi/device-client.js');
  const c = new DeviceClient(new Emitter(), { minGap: 0 });
  c.hold = 'A complete dump is running';
  await assert.rejects(c.request(Uint8Array.of(0xf0, 0xf7), { match: () => true }), /complete dump is running/, 'other pages wait');
});
