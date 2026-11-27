// Port choice (js/core/midi/transport.js autoSelect): a definition's preferred ports (def.ports) come
// before the global defaults when the device has none remembered.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MidiTransport } from '../js/core/midi/transport.js';

test('ports: remembered names first, then the ports a definition prefers, then the defaults', () => {
  const port = (id, name) => [id, { id, name, state: 'connected', addEventListener() {}, removeEventListener() {} }];
  const t = new MidiTransport();
  t.access = {
    inputs: new Map([port('i1', 'Virus TI Synth'), port('i2', 'SYSTEM-8'), port('i3', 'SYSTEM-8 CTRL')]),
    outputs: new Map([port('o1', 'Virus TI Synth'), port('o2', 'SYSTEM-8'), port('o3', 'SYSTEM-8 CTRL')]),
  };
  const prefer = { input: /SYSTEM-8 CTRL/i, output: /SYSTEM-8 CTRL/i };
  let r = t.autoSelect({ defaultInput: 'Virus TI Synth', defaultOutput: 'Virus TI Synth', hint: /Roland|System/i, prefer });
  assert.equal(r.input.name, 'SYSTEM-8 CTRL');
  assert.equal(r.output.name, 'SYSTEM-8 CTRL');
  r = t.autoSelect({ input: 'SYSTEM-8', output: 'SYSTEM-8', prefer });
  assert.equal(r.output.name, 'SYSTEM-8', 'a remembered choice stays');
  r = t.autoSelect({ defaultInput: 'Virus TI Synth', defaultOutput: 'Virus TI Synth' });
  assert.equal(r.output.name, 'Virus TI Synth', 'without a preference the defaults as before');
});
