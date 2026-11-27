// A Novation SuperNova / Nova / SuperNova II / Nova II board around the H8/300H core: the OS image
// in memory, the H8/3002's on-chip peripherals the OS uses (SCI0 = MIDI, ITU timers, A/D, interrupt
// controller, ports) and stubs for the external chips (DSP host ports, LCD, LED latches), so that the
// device's own code boots, takes MIDI and answers.
//
// The external chips are not modelled: reads return a fixed value (configurable per address), and
// every access is counted so that unknown ones can be found (machine.ioLog).

import { gzipSync, gunzipSync } from 'node:zlib';
import { H8, H8Error } from './cpu.mjs';

const VEC = { IMIA: [24, 28, 32, 36, 40], IMIB: [25, 29, 33, 37, 41], OVI: [26, 30, 34, 38, 42], ERI0: 52, RXI0: 53, TXI0: 54, TEI0: 55, ERI1: 56, RXI1: 57, TXI1: 58, TEI1: 59, ADI: 60 };
const ITU_BASE = [0xff64, 0xff6e, 0xff78, 0xff82, 0xff92];

export class Machine {
  /**
   * @param {Uint8Array} image   OS image, placed at 000000 (writable: the OS keeps its variables in
   *                             the same address range; see docs/devices/novation-supernova2.md)
   * @param {object} opt         { ram: [[start, end]...] extra RAM areas, extRead(a) -> value|undefined,
   *                               extWrite(a, v), portA, byteGap (cycles between MIDI bytes in) }
   */
  constructor(image, opt = {}) {
    this.mem = new Uint8Array(0x1000000);
    this.mem.set(image.subarray(0, Math.min(image.length, 0x200000)), 0);
    this.page = new Uint8Array(0x10000); // 256-byte pages: 0 RAM, 1 external I/O, 2 internal I/O
    for (let p = 0x3000; p < 0xfffd; p++) this.page[p] = 1;
    this.page[0xffff] = 2;
    for (const [s, e] of opt.ram || []) for (let p = s >> 8; p < e >> 8; p++) this.page[p] = 0;
    this.opt = opt;
    this.reg = new Uint8Array(256); // internal registers FFFF00-FFFFFF
    this.ioLog = new Map(); // address -> {r, w, pc, last}
    this.watch = null; // (addr, isWrite, value, pc) for watched RAM ranges (setWatch)
    this.watchMap = null;
    this.cycles = 0;
    this.cpu = new H8(this);
    // SCI0 (MIDI)
    this.midiIn = [];
    this.midiOut = [];
    this.rxReadyAt = 0;
    this.txBusyUntil = 0;
    this.txPending = false;
    this.ssr = [0x84, 0x84];
    this.rdr = [0, 0];
    this.byteGap = opt.byteGap ?? 600;
    // ITU
    this.tcnt = new Float64Array(5);
    // A/D
    this.adDoneAt = 0;
    this.adValue = opt.adValue ?? 0x8000;
    this.pending = new Set();
    this.lcd = [];
    this.stopAt = null;
    this.reg[0xd3] = 0xff;
  }

  // ---------------------------------------------------------------- bus
  r8(a) {
    const t = this.page[a >> 8];
    if (t === 0) {
      if (this.watchMap && this.watchMap[a]) this.watch?.(a, false, this.mem[a], this.cpu.lastPc);
      return this.mem[a];
    }
    if (t === 2) return this.ioRead(a & 0xff);
    if (a < 0xffff00 && a >= 0xfffd00) return this.mem[a];
    return this.extRead(a);
  }
  w8(a, v) {
    const t = this.page[a >> 8];
    if (t === 0) {
      if (this.watchMap && this.watchMap[a]) this.watch?.(a, true, v, this.cpu.lastPc);
      this.mem[a] = v;
      return;
    }
    if (t === 2) { this.ioWrite(a & 0xff, v); return; }
    this.extWrite(a, v);
  }
  /** Call this.watch(addr, isWrite, value, pc) on every access to the [start, end) ranges (null clears). */
  setWatch(ranges) {
    if (!ranges || !ranges.length) { this.watchMap = null; return; }
    this.watchMap = new Uint8Array(0x1000000);
    for (const [s, e] of ranges) this.watchMap.fill(1, s, e);
  }
  log(a, w, v) {
    let e = this.ioLog.get(a);
    if (!e) { e = { r: 0, w: 0, pc: this.cpu.lastPc, last: 0 }; this.ioLog.set(a, e); }
    if (w) { e.w++; e.last = v; } else e.r++;
  }
  extRead(a) {
    this.log(a, false);
    const v = this.opt.extRead?.(a, this);
    return v === undefined ? (this.opt.extDefault ?? 0) : v;
  }
  extWrite(a, v) {
    this.log(a, true, v);
    this.opt.extWrite?.(a, v, this);
  }

  // ---------------------------------------------------------------- on-chip registers
  ioRead(r) {
    const a = 0xffff00 | r;
    switch (r) {
      case 0xb4: return this.ssr[0];
      case 0xb5: return this.rdr[0];
      case 0xbc: return this.ssr[1];
      case 0xbd: return this.rdr[1];
      case 0xd3: return this.opt.portA?.(this) ?? 0xff; // port A: front-panel switch rows (1 = not pressed)
      case 0xe8: return this.reg[r];
      default:
        if (r >= 0xe0 && r <= 0xe7) return (r & 1) ? this.adValue & 0xc0 : this.adValue >> 8;
        for (let ch = 0; ch < 5; ch++) {
          const b = ITU_BASE[ch] & 0xff;
          if (r === b + 4) return (this.tcnt[ch] >> 8) & 0xff;
          if (r === b + 5) return this.tcnt[ch] & 0xff;
        }
        if (this.opt.ioRead) { const v = this.opt.ioRead(a, this); if (v !== undefined) return v; }
        return this.reg[r];
    }
  }
  ioWrite(r, v) {
    switch (r) {
      case 0xb4: case 0xbc: { // SSR: writing 0 clears TDRE / RDRF / errors
        const ch = r === 0xb4 ? 0 : 1, old = this.ssr[ch];
        let nv = old & (v | 0x07); // bits 7-3 are cleared by writing 0
        if (!(v & 0x80) && (old & 0x80)) { // TDRE cleared: transmit TDR
          nv &= ~0x04; // TEND
          if (ch === 0) { this.midiOut.push(this.reg[0xb3]); this.txBusyUntil = this.cycles + this.byteGap; if (this.onTx) this.onTx(this.reg[0xb3]); }
          else { this.sci1Out = this.sci1Out || []; this.sci1Out.push(this.reg[0xbb]); this.txBusyUntil1 = this.cycles + this.byteGap; }
        }
        if (!(v & 0x40) && (old & 0x40) && ch === 0) this.rxReadyAt = this.cycles + this.byteGap;
        this.ssr[ch] = nv;
        return;
      }
      case 0xf2: this.reg[r] = v; this.cpu.ue = (v & 8) !== 0; return;
      case 0xe8: { // ADCSR
        const old = this.reg[r];
        let nv = (v & 0x7f) | (old & 0x80 & v); // ADF cleared by writing 0
        if ((v & 0x20) && !(old & 0x20)) this.adDoneAt = this.cycles + 270;
        this.reg[r] = nv;
        return;
      }
      default:
        for (let ch = 0; ch < 5; ch++) {
          const b = ITU_BASE[ch] & 0xff;
          if (r === b + 3) { this.reg[r] &= v | 0xf8; return; } // TSR flags cleared by writing 0
          if (r === b + 4) { this.tcnt[ch] = (v << 8) | (this.tcnt[ch] & 0xff); return; }
          if (r === b + 5) { this.tcnt[ch] = (this.tcnt[ch] & 0xff00) | v; return; }
        }
        this.reg[r] = v;
        this.opt.ioWrite?.(0xffff00 | r, v, this);
    }
  }

  // ---------------------------------------------------------------- peripherals
  tick(c) {
    this.cycles += c;
    const reg = this.reg;
    // ITU channels
    const tstr = reg[0x60];
    if (tstr & 0x1f) {
      for (let ch = 0; ch < 5; ch++) {
        if (!(tstr & (1 << ch))) continue;
        const b = ITU_BASE[ch] & 0xff, tcr = reg[b], psc = tcr & 7;
        const div = psc < 4 ? 1 << psc : 8;
        const before = this.tcnt[ch];
        let now = before + c / div;
        const gra = (reg[b + 6] << 8) | reg[b + 7], grb = (reg[b + 8] << 8) | reg[b + 9];
        const cclr = (tcr >> 5) & 3;
        if (before < gra + 1 && now >= gra + 1 || (before < gra && now >= gra)) { reg[b + 3] |= 1; if (cclr === 1) now -= gra + 1; }
        if (before < grb && now >= grb) { reg[b + 3] |= 2; if (cclr === 2) now -= grb + 1; }
        if (now >= 0x10000) { now -= 0x10000; reg[b + 3] |= 4; }
        this.tcnt[ch] = now;
        const tier = reg[b + 2], tsr = reg[b + 3];
        if ((tier & 1) && (tsr & 1)) this.pending.add(VEC.IMIA[ch]);
        if ((tier & 2) && (tsr & 2)) this.pending.add(VEC.IMIB[ch]);
        if ((tier & 4) && (tsr & 4)) this.pending.add(VEC.OVI[ch]);
      }
    }
    // SCI0
    const scr = reg[0xb2];
    if (!(this.ssr[0] & 0x80) && this.cycles >= this.txBusyUntil) this.ssr[0] |= 0x84;
    if ((scr & 0x80) && (this.ssr[0] & 0x80)) this.pending.add(VEC.TXI0);
    if ((scr & 0x10) && !(this.ssr[0] & 0x40) && this.midiIn.length && this.cycles >= this.rxReadyAt) {
      this.rdr[0] = this.midiIn.shift();
      this.ssr[0] |= 0x40;
    }
    if ((scr & 0x40) && (this.ssr[0] & 0x40)) this.pending.add(VEC.RXI0);
    // SCI1 (transmit only)
    if (!(this.ssr[1] & 0x80) && this.cycles >= (this.txBusyUntil1 || 0)) this.ssr[1] |= 0x84;
    if ((reg[0xba] & 0x80) && (this.ssr[1] & 0x80)) this.pending.add(VEC.TXI1);
    // A/D
    if ((reg[0xe8] & 0x20) && this.cycles >= this.adDoneAt) {
      reg[0xe8] |= 0x80;
      if (reg[0xe8] & 0x10) this.adDoneAt = this.cycles + 270; else reg[0xe8] &= ~0x20;
    }
    if ((reg[0xe8] & 0xc0) === 0xc0) this.pending.add(VEC.ADI);
    if (this.opt.tick) this.opt.tick(this);
  }
  priority(v) {
    // IPRA: IRQ0-5 (bits 7-2), WDT/refresh (1), ITU0 (0); IPRB: ITU1-4 (7-4), DMAC (3), SCI0 (2? H8/3002: bit 3), SCI1, A/D
    const ipra = this.reg[0xf8], iprb = this.reg[0xf9];
    if (v >= 12 && v <= 17) return (ipra >> (7 - (v - 12))) & 1;
    if (v >= 24 && v <= 26) return (ipra >> 0) & 1; // H8/3002: IPRA0 = ITU0? (approximation)
    if (v >= 28 && v <= 42) return (iprb >> (7 - Math.floor((v - 28) / 4))) & 1;
    if (v >= 52 && v <= 55) return (iprb >> 3) & 1;
    if (v >= 56 && v <= 59) return (iprb >> 2) & 1;
    if (v === 60) return (iprb >> 1) & 1;
    return 0;
  }
  serviceInterrupts() {
    if (!this.pending.size) return;
    let best = -1, bp = -1;
    for (const v of this.pending) {
      const p = this.priority(v);
      if (p > bp || (p === bp && v < best)) { best = v; bp = p; }
    }
    if (this.cpu.interrupt(best, bp)) this.pending.clear();
    else this.pending.clear();
  }

  // ---------------------------------------------------------------- running
  reset() { this.cpu.reset(); }
  /** Run until `cycles` more have passed, stop() is called, or until(m) is true (checked every 256 steps). */
  run(cycles, until) {
    const end = this.cycles + cycles;
    const cpu = this.cpu;
    let n = 0;
    this.stopped = false;
    while (this.cycles < end && !this.stopped) {
      let c;
      if (cpu.sleeping) c = 16;
      else {
        if (this.breakpoints && this.breakpoints.has(cpu.pc)) { const f = this.breakpoints.get(cpu.pc); if (f(this) === 'stop') { this.stopped = true; break; } }
        c = cpu.step();
      }
      this.tick(c);
      if (this.pending.size) this.serviceInterrupts();
      if (until && (++n & 255) === 0 && until(this)) break;
    }
  }
  stop() { this.stopped = true; }
  /** Queue MIDI bytes for SCI0. */
  send(bytes) { for (const b of bytes) this.midiIn.push(b); }
  /** Take the SysEx messages the OS has sent so far (and other bytes as 'other'). */
  takeSysex() {
    const out = [];
    let cur = null;
    for (const b of this.midiOut) {
      if (b === 0xf0) cur = [b];
      else if (cur) { cur.push(b); if (b === 0xf7) { out.push(Uint8Array.from(cur)); cur = null; } }
    }
    this.midiOut = cur ? cur.slice() : [];
    return out;
  }
  /** Machine state (RAM, flash, registers, peripherals) as one compressed buffer. */
  snapshot() {
    const st = {
      r: [...this.cpu.r], pc: this.cpu.pc, ccr: this.cpu.ccr, sleeping: this.cpu.sleeping, ue: this.cpu.ue,
      ssr: this.ssr, rdr: this.rdr, tcnt: [...this.tcnt], cycles: this.cycles, rxReadyAt: this.rxReadyAt,
      txBusyUntil: this.txBusyUntil, adDoneAt: this.adDoneAt,
    };
    const json = Buffer.from(JSON.stringify(st));
    const flash = this.opt.flash || new Uint8Array(0);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(json.length, 0); head.writeUInt32LE(flash.length, 4); head.writeUInt32LE(0x300000, 8);
    return gzipSync(Buffer.concat([head, json, this.mem.subarray(0, 0x300000), this.mem.subarray(0xfffd00), this.reg, flash]));
  }
  restore(buf) {
    const b = gunzipSync(buf);
    const jl = b.readUInt32LE(0), fl = b.readUInt32LE(4), ml = b.readUInt32LE(8);
    let o = 12;
    const st = JSON.parse(b.subarray(o, o + jl).toString()); o += jl;
    this.mem.set(b.subarray(o, o + ml), 0); o += ml;
    this.mem.set(b.subarray(o, o + 0x300), 0xfffd00); o += 0x300;
    this.reg.set(b.subarray(o, o + 256)); o += 256;
    if (fl && this.opt.flash) this.opt.flash.set(b.subarray(o, o + fl));
    this.cpu.r.set(st.r); this.cpu.pc = st.pc; this.cpu.ccr = st.ccr; this.cpu.sleeping = st.sleeping; this.cpu.ue = st.ue;
    this.ssr = st.ssr; this.rdr = st.rdr; this.tcnt.set(st.tcnt); this.cycles = st.cycles; this.rxReadyAt = st.rxReadyAt;
    this.txBusyUntil = st.txBusyUntil; this.adDoneAt = st.adDoneAt;
    this.midiIn = []; this.midiOut = []; this.pending.clear();
  }
  ioReport(limit = 60) {
    return [...this.ioLog.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit).map(([a, e]) => `${a.toString(16).padStart(6, '0')} r${e.r} w${e.w} last=${e.last.toString(16)} pc=${e.pc.toString(16)}`);
  }
}

export { H8Error };
