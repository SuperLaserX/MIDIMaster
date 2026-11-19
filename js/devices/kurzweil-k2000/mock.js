// A minimal software K2000 for tests: answers the Kurzweil SysEx protocol and
// the Sample Dump Standard the way the firmware does.

import { Emitter } from '../../core/emitter.js';
import { build, parse, MSG } from './protocol.js';
import { enc7, put32be } from '../../core/bits.js';
import { sdsIdForNumber } from './sds-ids.js';

export class MockK2000 extends Emitter {
  constructor({ deviceId = 0 } = {}) {
    super();
    this.dev = deviceId;
    this.objects = new Map(); // `${type}:${id}` -> {name, data, inRam}
    this.editing = null; // `${type}:${id}` open in the editor
    this.received = [];
    this.connected = true;
    this.sds = null;
    this.sdsLog = [];
    this.sampleTop = 0x40000; // next free word of simulated sample RAM
    this.log = [];
  }

  /** Decode the 16-bit samples of the SDS transfer in progress. */
  _sdsSamples() {
    const out = new Int16Array(this.sds.length);
    let n = 0;
    for (const d of this.sds.packets) {
      for (let i = 0; i < 40 && n < out.length; i++, n++) {
        const p = 5 + i * 3;
        const u = (d[p] << 9) | (d[p + 1] << 2) | (d[p + 2] >> 5);
        out[n] = (u & 0xffff) - 0x8000;
      }
    }
    return out;
  }

  put(type, id, name, data, inRam = true) { this.objects.set(`${type}:${id}`, { name, data: Uint8Array.from(data), inRam }); }
  get(type, id) { return this.objects.get(`${type}:${id}`); }

  // MidiTransport interface ---------------------------------------------
  send(bytes) {
    const data = Uint8Array.from(bytes);
    this.received.push(data);
    setTimeout(() => this._handle(data), 2);
  }

  reply(bytes) { setTimeout(() => this.emit('sysex', Uint8Array.from(bytes)), 2); }

  _handle(d) {
    if (d[0] !== 0xf0) return;
    if (d[1] === 0x7e) { this._universal(d); return; }
    if (d[1] !== 0x07 || d[3] !== 0x78) return;
    if (d[2] !== this.dev && this.dev !== 127) return; // device ID rule from the firmware
    const m = parse(d);
    const dev = this.dev;
    const ack = (type, id, offs, size) => [0xf0, 7, dev, 0x78, MSG.DACK, ...enc7(type, 2), ...enc7(id, 2), ...enc7(offs, 3), ...enc7(size, 3), 0xf7];
    const nak = (type, id, offs, size, code) => [0xf0, 7, dev, 0x78, MSG.DNAK, ...enc7(type, 2), ...enc7(id, 2), ...enc7(offs, 3), ...enc7(size, 3), code, 0xf7];
    const info = (type, id) => {
      const o = this.get(type, id);
      return [0xf0, 7, dev, 0x78, MSG.INFO, ...enc7(type, 2), ...enc7(id, 2), ...enc7(o ? o.data.length : 0, 3), o?.inRam ? 1 : 0,
        ...[...(o?.name || '')].map((c) => c.charCodeAt(0)), 0, 0xf7];
    };
    switch (m.msg) {
      case MSG.DIR: this.reply(info(m.type, m.id)); break;
      case MSG.DUMP: {
        const o = this.get(m.type, m.id);
        if (!o) return; // the real K2000 stays silent
        const end = Math.min(o.data.length, m.offs + m.size);
        this.reply(build.load(dev, m.type, m.id, m.offs, o.data.slice(m.offs, end)));
        break;
      }
      case MSG.LOAD: {
        const o = this.get(m.type, m.id);
        if (this.editing === `${m.type}:${m.id}`) { this.reply(nak(m.type, m.id, m.offs, m.size, 1)); return; }
        if (!o || !o.inRam) { this.reply(nak(m.type, m.id, m.offs, m.size, 4)); return; }
        if (!m.checksumOk) { this.reply(nak(m.type, m.id, m.offs, m.size, 2)); return; }
        o.data.set(m.data, m.offs);
        this.reply(ack(m.type, m.id, m.offs, m.size));
        break;
      }
      case MSG.READ: {
        const o = this.get(m.type, m.id);
        if (!o) return;
        this.reply(build.write(dev, m.type, m.id, 0, o.name, o.data));
        break;
      }
      case MSG.WRITE:
        this.put(m.type, m.id, m.objName, m.data, true);
        this.reply(ack(m.type, m.id, 0, m.size));
        break;
      case MSG.CHANGE: {
        const o = this.get(m.type, m.id);
        if (o && m.objName) o.name = m.objName;
        if (o && m.newid && m.newid !== m.id) { this.objects.delete(`${m.type}:${m.id}`); this.objects.set(`${m.type}:${m.newid}`, o); }
        this.reply(info(m.type, m.newid || m.id));
        break;
      }
      case MSG.DEL: this.objects.delete(`${m.type}:${m.id}`); this.reply(info(m.type, m.id)); break;
      case MSG.DIRBANK: {
        const list = [...this.objects.entries()]
          .map(([k, o]) => { const [type, id] = k.split(':').map(Number); return { type, id, o }; })
          .filter((x) => x.type === m.type && (m.bank === 127 || Math.floor(x.id / 100) === m.bank) && (!m.ramOnly || x.o.inRam))
          .sort((a, b) => a.id - b.id);
        list.forEach((x, i) => setTimeout(() => this.emit('sysex', Uint8Array.from(info(x.type, x.id))), 2 + i));
        setTimeout(() => this.emit('sysex', Uint8Array.from([0xf0, 7, dev, 0x78, MSG.ENDOFBANK, ...enc7(m.type, 2), m.bank, 0xf7])), 4 + list.length);
        break;
      }
      case MSG.MEMQUERY: this.reply([0xf0, 7, dev, 0x78, MSG.MEMREPLY, 0, 3, 0x1e, 0, 5, 0x22, 0xf7]); break;
      case MSG.ALLTEXT: this.reply([0xf0, 7, dev, 0x78, MSG.SCREENREPLY, ...this.screenText(), 0, 0xf7]); break;
      case MSG.GETGRAPHICS: this.reply([0xf0, 7, dev, 0x78, MSG.SCREENREPLY, ...this.screenGraphics(), 0, 0xf7]); break;
      case MSG.PARAMNAME: this.reply([0xf0, 7, dev, 0x78, MSG.SCREENREPLY, ...[...'Program'].map((c) => c.charCodeAt(0)), 0, 0xf7]); break;
      case MSG.PARAMVALUE: this.reply([0xf0, 7, dev, 0x78, MSG.SCREENREPLY, ...[...String(this.currentProgram)].map((c) => c.charCodeAt(0)), 0, 0xf7]); break;
      case MSG.PANEL: this.panel(m.events); break;
      case MSG.NEW: {
        if (!this.get(m.type, m.id)) this.put(m.type, m.id, m.objName, new Uint8Array(m.size), true);
        this.reply(info(m.type, m.id));
        break;
      }
      case MSG.READBANK: {
        const list = [...this.objects.entries()]
          .map(([k, o]) => { const [type, id] = k.split(':').map(Number); return { type, id, o }; })
          .filter((x) => (m.type === 0 || x.type === m.type) && (m.bank === 127 || Math.floor(x.id / 100) === m.bank) && (!m.ramOnly || x.o.inRam));
        list.forEach((x, i) => setTimeout(() => this.emit('sysex', build.write(dev, x.type, x.id, 0, x.o.name, x.o.data)), 3 + i * 3));
        setTimeout(() => this.emit('sysex', Uint8Array.from([0xf0, 7, dev, 0x78, MSG.ENDOFBANK, ...enc7(m.type, 2), m.bank, 0xf7])), 6 + list.length * 3);
        break;
      }
      case MSG.DELBANK: {
        for (const k of [...this.objects.keys()]) {
          const [type, id] = k.split(':').map(Number);
          if ((m.type === 0 || type === m.type) && Math.floor(id / 100) === m.bank && this.objects.get(k).inRam) this.objects.delete(k);
        }
        if (m.type === 0) this.reply([0xf0, 7, dev, 0x78, MSG.ENDOFBANK, 0, 0, m.bank, 0xf7]);
        break;
      }
      case MSG.MOVEBANK: {
        for (const [k, o] of [...this.objects.entries()]) {
          const [type, id] = k.split(':').map(Number);
          if ((m.type === 0 || type === m.type) && Math.floor(id / 100) === m.bank && o.inRam) {
            this.objects.delete(k);
            this.objects.set(`${type}:${m.newBank * 100 + (id % 100)}`, o);
          }
        }
        this.reply([0xf0, 7, dev, 0x78, MSG.ENDOFBANK, ...enc7(m.type, 2), m.newBank, 0xf7]);
        break;
      }
      case MSG.OBJADDR: {
        const o = this.get(m.type, m.id);
        const a = o ? 0x00012000 + m.id * 64 : 0;
        this.reply([0xf0, 7, dev, 0x78, MSG.OBJADDRREPLY, ...enc7(m.type, 2), ...enc7(m.id, 2), ...Array.from({ length: 8 }, (_, i) => (a >>> (28 - 4 * i)) & 15), 0xf7]);
        break;
      }
      default: break;
    }
  }

  // Simulated display ---------------------------------------------------------
  get currentProgram() { return this._prog ?? 200; }

  panel(events) {
    for (const e of events) {
      if (e.type !== 0x09 && e.type !== 0x0d) continue;
      if (e.type === 0x0d) { this._prog = Math.max(1, Math.min(999, this.currentProgram + e.clicks)); continue; }
      if (e.button <= 9) { this._entry = (this._entry || '') + e.button; continue; }
      if (e.button === 0x0d && this._entry) { this._prog = Number(this._entry); this._entry = ''; continue; }
      if (e.button === 0x16 || e.button === 0x13) this._prog = Math.min(999, this.currentProgram + 1);
      if (e.button === 0x17 || e.button === 0x12) this._prog = Math.max(1, this.currentProgram - 1);
    }
  }

  screenText() {
    const name = this.get(132, this.currentProgram)?.name || '(empty)';
    const lines = [
      'ProgramMode    Xpose:0ST   <>Channel:1 ',
      '                                        ',
      `   ${String(this.currentProgram).padStart(3)} ${name.padEnd(16)}                `,
      '                                        ',
      '  MIDIMaster demo K2000                 ',
      '  (simulated, no MIDI hardware)         ',
      '                                        ',
      'Octav- Octav+ Panic  Sample Chan-  Chan+',
    ];
    const out = [];
    lines.forEach((l, r) => [...l.padEnd(40).slice(0, 40)].forEach((c) => out.push(r === 2 ? c.charCodeAt(0) | 0x80 : c.charCodeAt(0))));
    return out;
  }

  screenGraphics() {
    const out = new Array(2560).fill(0);
    for (let x = 0; x < 40; x++) out[8 * 40 + x] = 0x3f; // a horizontal rule under the title line
    return out;
  }

  // Sample Dump Standard ----------------------------------------------------
  _universal(d) {
    const sub = d[3];
    const ack = (pk) => this.reply([0xf0, 0x7e, this.dev, 0x7f, pk, 0xf7]);
    if (sub === 0x01) {
      const rd = (p, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 128 + d[p + i]; return v; };
      this.sds = { number: d[4] | (d[5] << 7), bits: d[6], period: rd(7, 3), length: rd(10, 3), packets: [] };
      ack(0);
    } else if (sub === 0x02 && this.sds) {
      this.sds.packets.push(d);
      ack(d[4]);
      if (this.sds.packets.length * 40 >= this.sds.length && !this.sds.done) {
        // Same placement rule as the firmware, and audio appended to sample RAM like a stack.
        this.sds.done = true;
        const id = sdsIdForNumber(this.sds.number, (i) => !!this.get(134, i));
        const base = this.sampleTop;
        this.sampleTop += this.sds.length;
        this.sdsLog.push({ id, number: this.sds.number, length: this.sds.length, base, period: this.sds.period, samples: this._sdsSamples() });
        if (this.makeSoundblock) {
          const data = this.makeSoundblock(this.sds.length, this.sds.period);
          const hd = 4 + ((data[4] << 8) | data[5]);
          put32be(data, hd + 8, base); put32be(data, hd + 12, base); put32be(data, hd + 16, base); put32be(data, hd + 20, base + this.sds.length - 1);
          this.put(134, id, `Sample ${id}`, data, true);
        }
      }
    } else if (sub === 0x03) {
      const number = d[4] | (d[5] << 7);
      const samples = this.sampleData || new Int16Array([0, 1000, -1000, 32767, -32768]);
      const lsb = (v, n) => Array.from({ length: n }, (_, i) => Math.floor(v / 128 ** i) & 0x7f);
      this.reply([0xf0, 0x7e, this.dev, 0x01, ...lsb(number, 2), 16, ...lsb(22676, 3), ...lsb(samples.length, 3), ...lsb(0, 3), ...lsb(samples.length - 1, 3), 0x7f, 0xf7]);
      this.pendingDump = { samples, packet: 0 };
    } else if (sub === 0x7f && this.pendingDump) {
      const { samples } = this.pendingDump;
      const p = this.pendingDump.packet;
      if (p * 40 >= samples.length) { this.pendingDump = null; return; }
      const body = new Array(120).fill(0);
      for (let i = 0; i < 40; i++) {
        const s = p * 40 + i < samples.length ? samples[p * 40 + i] : 0;
        const u = (s + 0x8000) & 0xffff;
        body[i * 3] = (u >> 9) & 0x7f; body[i * 3 + 1] = (u >> 2) & 0x7f; body[i * 3 + 2] = (u << 5) & 0x60;
      }
      const msg = [0xf0, 0x7e, this.dev, 0x02, p & 0x7f, ...body];
      let x = 0;
      for (let i = 1; i < msg.length; i++) x ^= msg[i];
      msg.push(x & 0x7f, 0xf7);
      this.pendingDump.packet++;
      this.reply(msg);
    }
  }
}
