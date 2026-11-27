// MIDI speed measurement (js/devices/generic/speedtest.js) against the Virus TI2 simulator: bursts of
// parameter changes and whole buffers, read back, and the edit buffer restored byte for byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('speed test: the fastest pace with nothing lost, then the edit buffer back as it was', async () => {
  const { GenericContext } = await import('../js/devices/generic/module.js');
  const { measureSpeed, speedObject } = await import('../js/devices/generic/speedtest.js');
  const def = (await import('../js/devices/defs/access-virus-ti2.js')).default;
  const host = {
    demo: true, transport: null, useTransport(tr) { this.transport = tr; },
    settings: { on: () => () => {}, value: { midi: { sysexGap: 150, replyTimeout: 1500, bytesPerSecond: 2900 } } },
    device: { value: {}, update(v) { Object.assign(this.value, v); } },
    setBusy() {}, error: (e) => { throw e; }, setStatus() {}, setOnline() {}, connectPorts: async () => {}, shell: { real: {} },
  };
  const g = new GenericContext(host, { id: 'access-virus-ti2', model: 'Virus TI2', sysex: '002033' }, def);
  g.renderStatus = () => {};
  await g.connect();
  assert.equal(speedObject(def).key, 'single');
  const r = await measureSpeed(g);
  assert.equal(r.sendGap, 0, 'the simulator takes parameter changes back to back');
  assert.equal(r.bulkGap, 0);
  assert.equal(r.restored, true);
  assert.deepEqual(r.diff, [], 'restored byte for byte');
  // a measured pace replaces the DIN defaults; the definition's own minimum stays
  host.device.update({ speed: { sendGap: r.sendGap, sendBps: r.sendBps } });
  g.demo = false; // the demo transport always runs at 10 ms
  const s = g.clientSettings();
  assert.equal(s.minGap, def.minGap ?? 0);
  assert.equal(s.bytesPerSecond, 1000000);
  // measured on one port only: another port (DIN through an interface) keeps the defaults
  host.device.update({ speed: { sendGap: 0, sendBps: 1000000, port: 'Virus TI Synth' } });
  g.transport.output = { name: 'Virus TI Synth' };
  assert.equal(g.clientSettings().bytesPerSecond, 1000000);
  g.transport.output = { name: 'MIDI (OCTA-CAPTURE)' };
  assert.equal(g.clientSettings().bytesPerSecond, 2900, 'USB speed is not used over DIN');
  assert.equal(g.clientSettings().minGap, 150);
  g.destroy();
});
