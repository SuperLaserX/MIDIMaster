// Port scan (js/devices/identify.js): simulated devices on fake Web MIDI ports, found by their identity
// reply, by answering an editor's read request, or by a definition's port names; a silent port stays silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeAccess(devs) {
  const inputs = new Map();
  const outputs = new Map();
  for (const d of devs) {
    const inp = { name: d.name, listeners: new Set(), addEventListener(_t, fn) { this.listeners.add(fn); }, removeEventListener(_t, fn) { this.listeners.delete(fn); } };
    inputs.set(d.name, inp);
    outputs.set(d.name, {
      name: d.name,
      send(bytes) {
        const out = d.handle?.(Uint8Array.from(bytes)) || [];
        setTimeout(() => { for (const m of out) for (const fn of inp.listeners) fn({ data: Uint8Array.from(m) }); }, 5);
      },
    });
  }
  return { inputs, outputs };
}

test('scan: identity reply, a read request answered, a port name, and silence', async () => {
  const { scanPorts, byPortName } = await import('../js/devices/identify.js');
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default.simulate();
  const ti = (await import('../js/devices/defs/access-virus-ti2.js')).default.simulate();
  const access = fakeAccess([
    { name: 'MIDI (OCTA-CAPTURE)', handle: (d) => jp.handle(d) },
    { name: 'Virus TI Synth', handle: (d) => (d[1] === 0x7e ? [] : ti.handle(d)) }, // the TI answers no identity request
    { name: 'Virus TI MIDI' }, // the TI's DIN sockets: the synth does not answer here
    { name: 'SYSTEM-8 CTRL' }, // silent in this test: found by the definition's port names
    { name: 'Some Interface' },
  ]);
  const r = await scanPorts(access, { identityMs: 40, probeMs: 120, gap: 0 });
  const by = Object.fromEntries(r.devices.map((d) => [d.output, d]));
  assert.match(by['MIDI (OCTA-CAPTURE)'].id, /^roland-jp80[08]0$/);
  assert.equal(by['MIDI (OCTA-CAPTURE)'].how, 'identity');
  assert.match(by['Virus TI Synth'].id, /^access-virus-ti/);
  assert.equal(by['Virus TI Synth'].how, 'request');
  assert.equal(by['Virus TI Synth'].input, 'Virus TI Synth');
  assert.equal(by['SYSTEM-8 CTRL'].id, 'roland-system8');
  assert.equal(by['SYSTEM-8 CTRL'].how, 'port');
  assert.equal(by['Virus TI MIDI'], undefined, 'no guess for another port of a device already found');
  assert.ok(r.silent.includes('Some Interface'));
  // port names alone
  assert.equal(byPortName('2- Supernova')[0]?.entry.id.startsWith('novation-supernova'), true);
});
