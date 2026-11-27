// Access Virus TI family over USB and DIN (def.link, docs/devices/access-virus-ti2.md "DIN and USB"): "Virus TI Synth"
// carries everything, "Virus TI MIDI" is the Virus's own MIDI sockets (nothing reaches the synth), any other port is a
// MIDI interface on the sockets (everything, with the answers on its input, while the Virus's USB MIDI is off).
import test from 'node:test';
import assert from 'node:assert/strict';

import { Emitter } from '../js/core/emitter.js';
import def, * as V from '../js/devices/defs/access-virus-ti2.js';
import snow from '../js/devices/defs/access-virus-snow.js';

const MODELS = ['access-virus-ti-desktop', 'access-virus-ti-keyboard', 'access-virus-ti-polar', 'access-virus-ti2-keyboard', 'access-virus-ti2-polar'];
const OCTA = 'MIDI (OCTA-CAPTURE)';

test('Virus TI link: what each pair of ports carries', () => {
  const l = (input, output) => V.tiLink({ input, output });
  const usb = l('Virus TI Synth', 'Virus TI Synth');
  assert.equal(usb.key, 'usb');
  assert.deepEqual(usb.can, V.LINK_ALL);
  // Windows numbers a second unit's ports ("2- Virus TI Synth")
  assert.equal(l('2- Virus TI Synth', '2- Virus TI Synth').key, 'usb');
  // the synth's output with another input: messages reach it, its answers are not read
  for (const input of ['Virus TI MIDI', OCTA, '']) {
    const x = l(input, 'Virus TI Synth');
    assert.equal(x.key, 'usb-out', input);
    assert.ok(x.can.includes('sysex') && !x.can.includes('reply'), input);
  }
  // "Virus TI MIDI": the Virus's MIDI Out socket, never the synth
  for (const input of ['Virus TI Synth', 'Virus TI MIDI', OCTA]) {
    const x = l(input, 'Virus TI MIDI');
    assert.equal(x.key, 'thru', input);
    assert.deepEqual(x.can, []);
    assert.match(x.note, /never reaches the synth/);
  }
  // any other port: DIN through an interface; answers need its input (not the Virus's USB inputs)
  const din = l(OCTA, OCTA);
  assert.equal(din.key, 'din');
  assert.deepEqual(din.can, V.LINK_ALL);
  assert.match(din.note, /USB MIDI is off/);
  for (const input of ['Virus TI Synth', 'Virus TI MIDI', '']) {
    const x = l(input, OCTA);
    assert.equal(x.key, 'din-out', input);
    assert.ok(x.can.includes('sysex') && x.can.includes('cc') && !x.can.includes('reply'), input);
  }
  // every capability has its reason
  for (const c of V.LINK_ALL) assert.ok(V.LINK_NEEDS[c], c);
});

test('Virus TI link: every object, slot, action and the requests declare what they need', async () => {
  const defs = [['TI2', def], ['Snow', snow], ...await Promise.all(MODELS.map(async (id) => [id, (await import(`../js/devices/defs/${id}.js`)).default]))];
  for (const [name, d] of defs) {
    assert.equal(d.link, V.tiLink, name);
    assert.equal(d.linkNeeds, V.LINK_NEEDS, name);
    assert.deepEqual(d.requestNeeds, ['sysex', 'reply'], name);
    assert.ok(d.ports.output.test('Virus TI Synth') && !d.ports.output.test('Virus TI MIDI'), name);
    const known = (n) => [].concat(n ?? []).every((c) => V.LINK_ALL.includes(c));
    for (const o of d.objects) {
      assert.ok(o.needs, `${name} ${o.key}`);
      assert.ok(known(o.needs), `${name} ${o.key}`);
      // reading an object needs the answers; sending one only SysEx
      if (o.fetch) assert.deepEqual([].concat(o.needs).sort(), ['reply', 'sysex'], `${name} ${o.key}`);
      if (o.sendAll) assert.equal(o.sendAll.needs, 'sysex', `${name} ${o.key}`);
      if (o.slots) {
        assert.deepEqual(o.slots.needs, V.READ, `${name} ${o.key}`);
        assert.equal(o.slots.storeNeeds, 'sysex', `${name} ${o.key}`);
        if (o.slots.play) assert.deepEqual(o.slots.recallNeeds, V.READ, `${name} ${o.key}`); // Play reads the slot first
      }
      for (const a of o.actions || []) assert.ok(known(a.needs), `${name} ${o.key} ${a.label}`);
    }
  }
  const write = def.objects.find((o) => o.key === 'setup').actions.find((a) => a.label === 'Write to the Virus');
  assert.equal(write.needs, 'sysex');
});

/** A GenericContext on fake ports; the Virus (the simulator) gets what reaches it and answers where it answers. */
async function context(d, input, output, { usbMidi = false } = {}) {
  const { GenericContext } = await import('../js/devices/generic/module.js');
  const sim = d.simulate();
  const sent = [];
  const transport = Object.assign(new Emitter(), {
    input: { name: input }, output: { name: output },
    send(b) {
      const out = this.output.name;
      sent.push(Array.from(b));
      // what reaches the synth: "Virus TI Synth"; another port (DIN) only while its USB MIDI is off
      const reaches = V.SYNTH_PORT.test(out) || (!V.MIDI_PORT.test(out) && !usbMidi);
      if (!reaches) return;
      const replies = sim.handle(Uint8Array.from(b)) || [];
      // answers: over USB on "Virus TI Synth", over DIN at the MIDI Out (the interface the request went out of)
      const at = V.SYNTH_PORT.test(out) ? 'Virus TI Synth' : out;
      if (this.input.name === at) for (const r of replies) setTimeout(() => this.emit('sysex', Uint8Array.from(r)), 1);
    },
  });
  const host = {
    demo: false, transport, useTransport() {},
    settings: { on: () => () => {}, value: { midi: { sysexGap: 0, replyTimeout: 300, bytesPerSecond: 1e6 } } },
    device: { value: {}, update(v) { Object.assign(this.value, v); } },
    setBusy() {}, error: (e) => { throw e; }, setStatus() {}, setOnline() {}, shell: { real: {} },
  };
  const g = new GenericContext(host, { id: 'access-virus-ti2', model: 'Virus TI2 Desktop' }, d);
  g.client.s.minGap = 0;
  return { g, sent, transport, sim };
}

test('Virus TI link: over DIN the editor reads, edits and stores as over USB (USB MIDI off)', async () => {
  const { loadObject, sendOut } = await import('../js/devices/generic/objects.js');
  const single = def.objects.find((o) => o.key === 'single');
  for (const port of ['Virus TI Synth', OCTA]) {
    const { g, sent, sim } = await context(def, port, port);
    assert.equal(g.link.key, port === OCTA ? 'din' : 'usb');
    assert.equal(g.cannot(def.requestNeeds), null);
    const d = await loadObject(g, single);
    assert.equal(V.nameOf(d), V.nameOf(sim.state.single));
    // a live edit: the SysEx parameter message (page A), taken from the MIDI In like from USB
    sendOut(g, V.msg.param(g.ctx, 0x70, V.SINGLE_PART, 40, 99));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sim.state.single[40], 99);
    assert.deepEqual(sent.at(-1), [0xf0, 0x00, 0x20, 0x33, 0x01, 0x10, 0x70, 0x40, 40, 99, 0xf7]);
    // the warning names the global settings DIN needs; none over USB
    const w = V.dinWarning(g.ctx);
    if (port === OCTA) {
      for (const s of ['"USB MidiPort active" No', 'play mode not Remote', '"Receive Dump" Enable', '"Soft Thru" Off', '"Virus TI Synth"']) assert.ok(w.includes(s), s);
      assert.equal(typeof single.warning, 'function'); // the page shows it
      assert.equal(single.warning(g.ctx), w);
    } else {
      assert.equal(w, '');
      assert.equal(single.warning, undefined); // no empty note on the page
    }
    g.destroy();
  }
  // the Snow has no Remote mode
  const { g } = await context(snow, OCTA, OCTA);
  const w = V.dinWarning(g.ctx, { remote: false });
  assert.ok(w.includes('"USB MidiPort active" No') && !w.includes('Remote'));
  assert.equal(snow.objects[0].warning(g.ctx), w);
  g.destroy();
});

test('Virus TI link: "Virus TI MIDI" and missing answers are refused with the reason; nothing is sent to the sockets', async () => {
  const { loadObject, readBankNames, sendOut } = await import('../js/devices/generic/objects.js');
  const single = def.objects.find((o) => o.key === 'single');
  {
    const { g, sent } = await context(def, 'Virus TI MIDI', 'Virus TI MIDI');
    assert.equal(g.link.key, 'thru');
    await assert.rejects(loadObject(g, single), /Not available over "Virus TI MIDI".*"Virus TI Synth"/);
    await assert.rejects(readBankNames(g, single, 1), /Not available/);
    assert.match(g.cannot(def.requestNeeds), /Virus TI Synth/);
    sendOut(g, [V.msg.param(g.ctx, 0x70, V.SINGLE_PART, 40, 1), [0xb0, 40, 1], [0xc0, 3], [0x90, 60, 100]]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent, [], 'nothing goes out of the Virus\'s MIDI Out socket');
    g.destroy();
  }
  for (const [input, output, key] of [['Virus TI MIDI', 'Virus TI Synth', 'usb-out'], ['Virus TI Synth', OCTA, 'din-out']]) {
    const { g, sent, sim } = await context(def, input, output);
    assert.equal(g.link.key, key);
    await assert.rejects(loadObject(g, single), /answers/);
    assert.ok(g.cannot(def.requestNeeds));
    assert.equal(g.can('sysex'), true);
    // edits and stores still go out (they need no answer)
    sendOut(g, V.msg.param(g.ctx, 0x71, V.SINGLE_PART, 5, 77));
    sendOut(g, single.slots.store(1, 0, g.ctx, V.initSingle()));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 2, key);
    assert.equal(sim.state.single[128 + 5], 77, key);
    g.destroy();
  }
});

test('Virus TI link: over DIN with the Virus\'s USB MIDI on, nothing reaches the synth (the editor times out)', async () => {
  const { loadObject } = await import('../js/devices/generic/objects.js');
  const single = def.objects.find((o) => o.key === 'single');
  const { g, sim } = await context(def, OCTA, OCTA, { usbMidi: true });
  // the editor cannot tell from the port names: the link allows it, the warning says why it fails
  assert.equal(g.link.key, 'din');
  await assert.rejects(loadObject(g, single), /No reply|did not send/);
  assert.match(V.dinWarning(g.ctx), /passes its MIDI In to the computer/);
  assert.equal(sim.state.single[40], V.initSingle()[40]);
  g.destroy();
});
