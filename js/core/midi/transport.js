// Web MIDI transport: port management, SysEx reassembly, traffic log.
// Requires a Chromium-based browser (Chrome, Edge, Opera) and a secure context
// (http://localhost or https). SysEx permission is requested explicitly.

import { Emitter } from '../emitter.js';

export class MidiTransport extends Emitter {
  constructor() {
    super();
    this.access = null;
    this.input = null;
    this.output = null;
    this.sysexBuffer = null;
    this.log = [];
    this.logLimit = 400;
    this._onMessage = (e) => this._receive(e.data, e.timeStamp);
  }

  get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; }
  get connected() { return !!(this.input && this.output); }

  async init() {
    if (!this.supported) throw new Error('This browser does not support Web MIDI. Use Chrome or Edge.');
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.emit('ports', this.ports());
    this.emit('ready', this.access);
    return this.ports();
  }

  ports() {
    if (!this.access) return { inputs: [], outputs: [] };
    const map = (m) => Array.from(m.values()).map((p) => ({ id: p.id, name: p.name, state: p.state }));
    return { inputs: map(this.access.inputs), outputs: map(this.access.outputs) };
  }

  /**
   * Open ports by name. Falls back to ports a definition prefers (`prefer`: {input, output} regexes, e.g.
   * the SYSTEM-8's "CTRL" port, the one that answers SysEx), then to the given defaults, then to ports
   * whose names match `hint` (a regex for the device), then to the first ports.
   */
  autoSelect({ input = '', output = '', defaultInput = '', defaultOutput = '', hint = null, prefer = null } = {}) {
    const { inputs, outputs } = this.ports();
    const pick = (list, ...names) => names.map((n) => n && list.find((p) => p.name === n)).find(Boolean) || null;
    const like = (list, re) => (re ? list.find((p) => re.test(p.name)) || null : null);
    let inp = pick(inputs, input) || like(inputs, prefer?.input) || pick(inputs, defaultInput);
    let out = pick(outputs, output) || like(outputs, prefer?.output) || pick(outputs, defaultOutput);
    if (!inp || !out) {
      const score = (n) => (hint && hint.test(n) ? 2 : 0) + (/midi/i.test(n) ? 1 : 0);
      inp = inp || [...inputs].sort((a, b) => score(b.name) - score(a.name))[0] || null;
      // Prefer an output with the same name as the chosen input.
      out = out || (inp && outputs.find((o) => o.name.replace(/\s*\d+$/, '') === inp.name.replace(/\s*\d+$/, ''))) || outputs[0] || null;
    }
    if (inp || out) this.open(inp?.id, out?.id);
    return { input: inp, output: out };
  }

  open(inputId, outputId) {
    this.close();
    this.input = (inputId && this.access.inputs.get(inputId)) || null;
    this.output = (outputId && this.access.outputs.get(outputId)) || null;
    if (this.input) this.input.addEventListener('midimessage', this._onMessage);
    // open the ports now, so a port another program holds is reported (Windows lets one program at a
    // time use a MIDI port: another MIDIMaster window or a browser tab with MIDIMaster)
    for (const p of [this.input, this.output].filter(Boolean)) {
      p.open?.().catch(() => this.emit('port-busy', p.name));
    }
    this.emit('connection', { input: this.input?.name, output: this.output?.name });
  }

  close() {
    if (this.input) this.input.removeEventListener('midimessage', this._onMessage);
    this.input = null;
    this.output = null;
    this.sysexBuffer = null;
  }

  /** Send now, or at `at` (a performance.now() timestamp) for sample-accurate scheduling. */
  send(bytes, at) {
    if (!this.output) throw new Error('No MIDI output selected');
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (at !== undefined) this.output.send(data, at); else this.output.send(data);
    this._record('out', data);
  }

  _receive(data, t) {
    // Chrome normally delivers whole SysEx messages, but some drivers fragment them.
    if (this.sysexBuffer) {
      const merged = new Uint8Array(this.sysexBuffer.length + data.length);
      merged.set(this.sysexBuffer);
      merged.set(data, this.sysexBuffer.length);
      if (data[data.length - 1] === 0xf7) { this.sysexBuffer = null; this._dispatch(merged, t); } else this.sysexBuffer = merged;
      return;
    }
    if (data[0] === 0xf0 && data[data.length - 1] !== 0xf7) { this.sysexBuffer = data.slice(); return; }
    this._dispatch(data, t);
  }

  _dispatch(data, t) {
    if (data[0] === 0xf8 || data[0] === 0xfe) return; // clock / active sensing
    this._record('in', data);
    if (data[0] === 0xf0) this.emit('sysex', data, t);
    else this.emit('midi', data, t);
  }

  _record(dir, data) {
    const entry = { dir, time: performance.now(), data };
    this.log.push(entry);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    this.emit('traffic', entry);
  }
}
