// Long transfers (js/devices/generic/dumpjob.js startTransfer): exclusive use of the port, flow control by
// waitFor, progress, and a stop that ends it at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../js/core/emitter.js';

function device() {
  const transport = new Emitter();
  const sent = [];
  transport.send = (b) => {
    sent.push(Array.from(b));
    if (b[1] === 0x7d && b[2] === 1) setTimeout(() => transport.emit('sysex', Uint8Array.of(0xf0, 0x7d, 2, sent.length & 127, 0xf7)), 2); // a flow-control answer
  };
  const g = new Emitter();
  Object.assign(g, {
    entry: { id: 'test', model: 'Test' }, def: null, job: null, destroyed: false, transport,
    client: { s: { minGap: 0 }, hold: null, send: async () => {}, sendNow: () => {}, pending: 0 },
    host: { device: { value: {} } }, setBusy() {}, error: (e) => { throw e; },
  });
  return { g, sent };
}

test('transfer: records with flow control, nothing else gets through meanwhile', async () => {
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const { sendOut } = await import('../js/devices/generic/objects.js');
  const { g, sent } = device();
  const done = startTransfer(g, {
    title: 'Install',
    run: async (io) => {
      for (let i = 0; i < 64; i++) {
        if (i % 32 === 0) { io.send([0xf0, 0x7d, 1, 0xf7]); const r = await io.waitFor((d) => d[1] === 0x7d && d[2] === 2, 500); if (!r) throw new Error('no flow control: power-cycle'); }
        io.send([0xf0, 0x7d, 3, i, 0xf7]);
        io.progress(i + 1, 64, 'records');
      }
      return 'ok';
    },
  });
  assert.equal(g.job.kind, 'transfer');
  assert.ok(g.client.hold, 'requests are refused while it runs');
  sendOut(g, [0xb0, 7, 100]);
  assert.equal(await done, 'ok');
  assert.equal(sent.filter((m) => m[2] === 3).length, 64);
  assert.ok(!sent.some((m) => m[0] === 0xb0), 'the live edit was not sent during the transfer');
  assert.equal(g.job, null);
  assert.equal(g.client.hold, null);
});

test('transfer: stopping ends it at once', async () => {
  const { startTransfer } = await import('../js/devices/generic/dumpjob.js');
  const { g } = device();
  const done = startTransfer(g, { title: 'Install', run: async (io) => { await io.waitFor(() => false, 60000); return 'never'; } });
  setTimeout(() => g.job.stop(), 10);
  const t0 = Date.now();
  assert.equal(await done, null);
  assert.ok(Date.now() - t0 < 1000);
});
