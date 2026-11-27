// MIDI inputs: up to four controllers (keyboards, control surfaces) connected to MIDIMaster, apart from
// the open device's own ports. What they play goes to the open device (thru, on its channel); a
// controller mapped to a function (CC n -> Filter Cutoff) changes that parameter of the open device
// through its editor, so the editor shows it and the device gets its own message (SysEx or NRPN).
//
// Settings (core/settings.js, kept in the browser and loaded at startup):
//   inputs.slots[0-3]: {port, enabled, thru, toChannel}
//   inputs.mappings:   global mappings, [{id, input: 'any'|0-3, channel: 'any'|0-15, cc, target}]
// Each device's settings may hold inputMappings of the same shape: they come first, so a device
// mapping overrides a global one for the same controller (target {type: 'none'} blocks it there).
// target: {type: 'function', fn} | {type: 'param', object, param} | {type: 'action', action} |
//         {type: 'cc', cc} | {type: 'none'}  (see functions.js)

import { Emitter } from '../emitter.js';

export const MAX_INPUTS = 4;
export const emptySlot = () => ({ port: '', enabled: true, thru: true, toChannel: true });

/** The four slots of a settings value, filled up to MAX_INPUTS. */
export function slotsOf(inputs) {
  const s = Array.isArray(inputs?.slots) ? inputs.slots : [];
  return Array.from({ length: MAX_INPUTS }, (_, i) => ({ ...emptySlot(), ...(s[i] || {}) }));
}

/** The mapping in `list` for controller `cc` from input slot `slot` on channel `ch`: the most specific. */
export function matchMapping(list, slot, ch, cc) {
  let best = null;
  let bestScore = -1;
  for (const m of list || []) {
    if (m.cc !== cc) continue;
    if (m.input !== 'any' && m.input !== slot) continue;
    if (m.channel !== 'any' && m.channel !== ch) continue;
    const score = (m.input !== 'any' ? 2 : 0) + (m.channel !== 'any' ? 1 : 0);
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return best;
}

/** The mapping that applies: the device's own first, then the global ones. */
export const effectiveMapping = (deviceList, globalList, slot, ch, cc) => matchMapping(deviceList, slot, ch, cc) || matchMapping(globalList, slot, ch, cc);

export const newMappingId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class MidiInputs extends Emitter {
  /** settings: core/settings.js Settings; route(slot, data): what to do with a message. */
  constructor(settings, route) {
    super();
    this.settings = settings;
    this.route = route;
    this.access = null;
    this.ports = Array(MAX_INPUTS).fill(null); // open MIDIInput per slot
    this.handlers = Array(MAX_INPUTS).fill(null);
    this.lastSeen = Array(MAX_INPUTS).fill(0);
    this.learn = null; // ({input, channel, cc}) => void: the next controller moved is learned
    this._onState = () => this.reopen();
  }

  get slots() { return slotsOf(this.settings.value.inputs); }

  /** Start with a MIDIAccess (the shell's, once MIDI is allowed). */
  attach(access) {
    if (this.access === access) return;
    this.access?.removeEventListener?.('statechange', this._onState);
    this.access = access;
    access.addEventListener?.('statechange', this._onState);
    this.reopen();
  }

  /** Input port names the browser offers. */
  portNames() { return this.access ? [...this.access.inputs.values()].map((p) => p.name) : []; }

  /** 'off' | 'no-midi' | 'missing' | 'open' for slot i. */
  status(i) {
    const s = this.slots[i];
    if (!s.port || !s.enabled) return 'off';
    if (!this.access) return 'no-midi';
    return this.ports[i] ? 'open' : 'missing';
  }

  reopen() {
    for (let i = 0; i < MAX_INPUTS; i++) {
      if (this.ports[i] && this.handlers[i]) this.ports[i].removeEventListener('midimessage', this.handlers[i]);
      this.ports[i] = null;
      this.handlers[i] = null;
    }
    if (!this.access) { this.emit('status'); return; }
    this.slots.forEach((s, i) => {
      if (!s.port || !s.enabled) return;
      const port = [...this.access.inputs.values()].find((p) => p.name === s.port && p.state !== 'disconnected');
      if (!port) return;
      const fn = (e) => this.receive(i, e.data);
      port.addEventListener('midimessage', fn);
      this.ports[i] = port;
      this.handlers[i] = fn;
    });
    this.emit('status');
  }

  receive(i, data) {
    if (!data?.length || data[0] >= 0xf0) return; // SysEx and system messages are the device ports' business
    this.lastSeen[i] = performance.now();
    this.emit('activity', i, data);
    if ((data[0] & 0xf0) === 0xb0 && this.learn) {
      const fn = this.learn;
      this.learn = null;
      fn({ input: i, channel: data[0] & 15, cc: data[1] });
      return;
    }
    try { this.route(i, data); } catch (err) { console.error(err); }
  }

  destroy() {
    this.access?.removeEventListener?.('statechange', this._onState);
    this.access = null;
    this.reopen();
  }
}
