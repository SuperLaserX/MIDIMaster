// What a connection carries (def.link, js/devices/generic/module.js): over DIN MIDI a device like the
// SYSTEM-8 takes no SysEx, so reads, stores and SysEx edits are refused with the reason; channel
// messages still go out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../js/core/emitter.js';

test('connection: def.link decides what may be sent and read', async () => {
  const { GenericContext } = await import('../js/devices/generic/module.js');
  const { sendOut, loadObject } = await import('../js/devices/generic/objects.js');
  const sent = [];
  const transport = Object.assign(new Emitter(), { input: { name: 'MIDI (OCTA-CAPTURE)' }, output: { name: 'MIDI (OCTA-CAPTURE)' }, send: (b) => sent.push(Array.from(b)) });
  const host = {
    demo: false, transport, useTransport() {},
    settings: { on: () => () => {}, value: { midi: { sysexGap: 0, replyTimeout: 500, bytesPerSecond: 3125 } } },
    device: { value: {}, update(v) { Object.assign(this.value, v); } },
    setBusy() {}, error: (e) => { throw e; }, setStatus() {}, setOnline() {}, shell: { real: {} },
  };
  const def = {
    link: ({ output }) => (/SYSTEM-8 CTRL/.test(output) ? { key: 'ctrl', label: 'USB (SYSTEM-8 CTRL)', can: ['sysex', 'cc', 'pc', 'notes'] } : { key: 'din', label: 'MIDI (DIN or the SYSTEM-8 port)', can: ['cc', 'pc', 'notes'] }),
    linkNeeds: { sysex: 'the USB connection (SYSTEM-8 CTRL)' },
    objects: [{ key: 'patch', label: 'Patch', needs: 'sysex', params: [], init: () => new Uint8Array(4), request: () => [0xf0, 0x41, 0xf7], match: () => true, decode: () => new Uint8Array(4) }],
  };
  const g = new GenericContext(host, { id: 'test', model: 'Test' }, def);
  g.client.s.minGap = 0;
  assert.equal(g.link.key, 'din');
  assert.equal(g.can('cc'), true);
  assert.equal(g.can('sysex'), false);
  assert.match(g.cannot('sysex'), /USB connection \(SYSTEM-8 CTRL\)/);
  await assert.rejects(loadObject(g, def.objects[0]), /Not available over MIDI/);
  sendOut(g, [[0xf0, 0x41, 0x12, 0xf7], [0xb0, 74, 64]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [[0xb0, 74, 64]], 'the controller goes out, the SysEx does not');
  transport.output = { name: 'SYSTEM-8 CTRL' };
  assert.equal(g.can('sysex'), true);
  assert.equal(g.ctx.link.key, 'ctrl');
  g.destroy();
});
