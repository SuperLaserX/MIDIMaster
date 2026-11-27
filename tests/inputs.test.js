// MIDI inputs (core/midi/inputs.js): controllers connected to MIDIMaster, global mappings with
// per-device overrides, functions found on each device (core/midi/functions.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MidiInputs, matchMapping, effectiveMapping, slotsOf } from '../js/core/midi/inputs.js';
import { resolveFunction, scaleToParam } from '../js/core/midi/functions.js';
import { SETTING_DEFAULTS } from '../js/core/settings.js';
import { readParam } from '../js/core/model/memmap.js';

test('inputs: four slots by default; a mapping for one input or channel wins over "any"', () => {
  assert.equal(slotsOf(SETTING_DEFAULTS.inputs).length, 4);
  assert.equal(slotsOf({ slots: [{ port: 'A' }] })[3].thru, true, 'short lists are filled up');
  const list = [
    { id: 'a', input: 'any', channel: 'any', cc: 74, target: { type: 'function', fn: 'cutoff' } },
    { id: 'b', input: 1, channel: 'any', cc: 74, target: { type: 'function', fn: 'resonance' } },
    { id: 'c', input: 1, channel: 2, cc: 74, target: { type: 'none' } },
  ];
  assert.equal(matchMapping(list, 0, 0, 74).id, 'a');
  assert.equal(matchMapping(list, 1, 0, 74).id, 'b');
  assert.equal(matchMapping(list, 1, 2, 74).id, 'c');
  assert.equal(matchMapping(list, 0, 0, 1), null);
  // a device's own mapping overrides the global one for the same controller
  const dev = [{ id: 'd', input: 'any', channel: 'any', cc: 74, target: { type: 'param', object: 'patch', param: 'x' } }];
  assert.equal(effectiveMapping(dev, list, 0, 0, 74).id, 'd');
  assert.equal(effectiveMapping(null, list, 0, 0, 74).id, 'a');
});

test('inputs: messages from the open ports are routed; Learn takes the next controller', () => {
  const listeners = [];
  const port = { name: 'Keys', state: 'connected', addEventListener: (_e, fn) => listeners.push(fn), removeEventListener: () => {} };
  const access = { inputs: new Map([['1', port]]), addEventListener() {}, removeEventListener() {} };
  const settings = { value: { inputs: { slots: [{ port: 'Keys', enabled: true }], mappings: [] } } };
  const routed = [];
  const inputs = new MidiInputs(settings, (slot, data) => routed.push([slot, [...data]]));
  inputs.attach(access);
  assert.equal(inputs.status(0), 'open');
  assert.equal(inputs.status(1), 'off');
  listeners[0]({ data: Uint8Array.of(0x90, 60, 100) });
  listeners[0]({ data: Uint8Array.of(0xf8) }); // clock: not a controller's business here
  let learned = null;
  inputs.learn = (x) => { learned = x; };
  listeners[0]({ data: Uint8Array.of(0xb3, 21, 64) });
  listeners[0]({ data: Uint8Array.of(0xb0, 7, 100) });
  assert.deepEqual(learned, { input: 0, channel: 3, cc: 21 });
  assert.deepEqual(routed, [[0, [0x90, 60, 100]], [0, [0xb0, 7, 100]]]);
});

test('functions: each device finds its own parameter', async () => {
  const { loadDef } = await import('../js/devices/registry.js');
  const find = async (id, key, fn) => {
    const obj = (await loadDef(id)).objects.find((o) => o.key === key);
    const sec = new Map((obj.sections || []).map((s) => [s.key, s.label]));
    return resolveFunction(fn, obj.params, { groupOf: (p) => `${p.group || ''} ${sec.get(p.section) || ''}` })?.label;
  };
  assert.equal(await find('roland-jp8080', 'patch', 'cutoff'), 'FLT CUTOFF FREQ', 'not "Cutoff slope"');
  assert.equal(await find('roland-jp8080', 'patch', 'attack'), 'AMP ENV ATTACK');
  assert.equal(await find('access-virus-ti2', 'single', 'cutoff'), 'Filter 1 Cutoff');
  assert.equal(await find('access-virus-ti2', 'single', 'release'), 'Release');
  assert.equal(await find('korg-m1', 'program', 'cutoff'), 'Cutoff', 'the VDF cutoff, not the pitch MG frequency');
  assert.equal(await find('oberheim-matrix1000', 'patch', 'resonance'), 'VCF resonance');
  assert.equal(await find('yamaha-dx7', 'voice', 'volume'), undefined, 'an operator output level is not the volume');
  // a controller value over the parameter's range; option lists by position
  assert.equal(scaleToParam({}, 127, { min: 0, max: 99 }), 99);
  assert.equal(scaleToParam({}, 64, { min: -64, max: 63 }), 0);
  assert.equal(scaleToParam({ options: [[0, 'a'], [5, 'b'], [9, 'c']] }, 127, {}), 9);
});

test('inputs: a mapped controller changes the open device\'s parameter and sends it', async () => {
  const { GenericContext } = await import('../js/devices/generic/module.js');
  const jp = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const host = {
    demo: true, transport: null, useTransport(tr) { this.transport = tr; },
    settings: { on: () => () => {}, value: { midi: { sysexGap: 0, replyTimeout: 500, bytesPerSecond: 3000 } } },
    device: { value: {}, update(v) { Object.assign(this.value, v); } },
    setBusy() {}, error: (e) => { throw e; }, setStatus() {}, setOnline() {}, connectPorts: async () => {}, shell: { real: {} },
  };
  const g = new GenericContext(host, { id: 'roland-jp8080', model: 'JP-8080', sysex: '41' }, jp);
  g.client.setSettings({ minGap: 1 });
  g.renderStatus = () => {};
  await g.connect();
  const sent = [];
  const send = g.transport.send.bind(g.transport);
  g.transport.send = (b, at) => { sent.push([...b]); return send(b, at); };
  const r = g.applyMapped({ type: 'function', fn: 'cutoff' }, 127);
  assert.equal(r.p.label, 'FLT CUTOFF FREQ');
  assert.equal(readParam(g.objectData.patch, r.p), 127, 'the editor\'s data holds the new value');
  await g.client.drain();
  assert.ok(sent.some((m) => m[0] === 0xf0 && m.includes(127)), 'sent as the JP-8080\'s own parameter message');
  // a device mapping can name any parameter exactly
  const q = jp.objects.find((o) => o.key === 'patch').params.find((p) => p.label === 'FLT RESONANCE');
  assert.equal(g.applyMapped({ type: 'param', object: 'patch', param: q.key }, 0).p, q);
  assert.equal(g.applyMapped({ type: 'function', fn: 'no-such' }, 1), null);
  g.destroy();
});
