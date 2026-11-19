// Demo transport for devices without their own simulator: records everything that is
// sent, answers identity requests, and echoes dump requests with a small fake dump so
// the librarian can be tried without hardware.

import { Emitter } from '../emitter.js';

export class LoopbackTransport extends Emitter {
  constructor(entry, def) {
    super();
    this.entry = entry;
    this.def = def;
    this.log = [];
    this.logLimit = 400;
    this.access = {};
    this.input = { id: 'loop-in', name: `Demo ${entry.model} (simulated)` };
    this.output = { id: 'loop-out', name: `Demo ${entry.model} (simulated)` };
    // A definition can bring its own simulator: sim.handle(bytes) -> reply messages or null.
    this.sim = def?.simulate ? def.simulate() : null;
  }

  get supported() { return true; }
  get connected() { return true; }
  async init() { return this.ports(); }
  ports() { return { inputs: [this.input], outputs: [this.output] }; }
  autoSelect() { return { input: this.input, output: this.output }; }
  open() { this.emit('connection', { input: this.input.name, output: this.output.name }); }
  close() {}

  send(bytes, at) {
    const d = Uint8Array.from(bytes);
    this._record('out', d);
    if (this.sim) {
      const replies = this.sim.handle(d);
      if (replies) { replies.forEach((r, i) => this._reply(r, 15 + i * 5)); return; }
    }
    if (d[0] !== 0xf0) return;
    // Identity request -> identity reply with the device's manufacturer ID.
    if (d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x01) {
      const id = (this.entry.sysex || '7D').split(' ').map((x) => parseInt(x, 16));
      this._reply([0xf0, 0x7e, d[2], 0x06, 0x02, ...id, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0xf7]);
      return;
    }
    // Anything else addressed to the device: answer with a short fake dump.
    if (d[1] !== 0x7e && d[1] !== 0x7f && d.length < 32) {
      const head = Array.from(d.slice(0, Math.min(d.length - 1, 6)));
      const body = Array.from({ length: 48 }, (_, i) => (i * 7) & 0x7f);
      this._reply([...head, ...body, 0xf7]);
    }
  }

  _reply(bytes, delay = 15) {
    setTimeout(() => {
      const d = Uint8Array.from(bytes);
      this._record('in', d);
      this.emit('sysex', d);
    }, delay);
  }

  _record(dir, data) {
    const entry = { dir, time: performance.now(), data };
    this.log.push(entry);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    this.emit('traffic', entry);
  }
}
