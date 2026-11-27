// The Oberheim Matrix-1000 board around the 6809 core (tools/m6809/cpu.mjs): its own OS and patch ROM
// run as on the unit, so that the editor's messages can be checked against the device's own receiver
// and transmitter (tools/matrix1000/check_editor.mjs) and so that every master byte's readers can be
// found (watch()).
//
// Memory map (the OS code; gligli's m1k-emu matches it):
//   0000-0FFF  four 8254s, the DCO timers (2 MHz: 4545 counts = 440 Hz); the voice update reads
//              their counts and OUT states back (read-back), so they count here (Pit8253)
//   1000-13FF  CV DAC registers (write only)
//   1406/1407  6850 ACIA (MIDI): status/control, data; its interrupt is the 6809 FIRQ
//   1600-1603  8253 system timer; counter 2 (mode 3, 40000 counts at 1 MHz) gives the 50 Hz IRQ
//   1800-1802  front panel switches (1 = pressed; the key scan at DDC7 reads all three)
//   1C00-1D7F  output latches (gates, multiplexers); 1D80 bank latch (bits 0-2)
//   1E00/1E80/1F00  the three 7-segment digits (inverted); 1F80 the LEDs (inverted)
//   2000-3FFF  patch ROM page (bank latch 0-7: banks 2-9, 100 patches of 80 bytes each)
//   6000-7FFF  RAM page (bank latch bits 0-1: 0 work RAM, 1 bank 0, 2 bank 1)
//   8000-FFFF  OS ROM
// The first IRQ never returns: its handler (85E7) is the OS's main loop (voice update, MIDI parser as
// a coroutine at C42B, panel) and jumps back to its own start, so the CPU runs with IRQ masked from
// then on; the RAM page swap while a patch is copied (FIRQ masked by the code) is safe for that reason.
//
//   const m = new Matrix1000(osRom, patchRom); m.powerOn({ cold: true }); m.midiIn([...]); m.settle(); m.messages()

import { M6809 } from '../m6809/cpu.mjs';

const CPU_HZ = 2000000;
export const BYTE_CYCLES = Math.round(CPU_HZ * 10 / 31250); // 640 cycles per MIDI byte
export const MASTER = 0x7485; // master table (172 bytes) in work RAM

export class Matrix1000 {
  constructor(os, presets) {
    this.os = os;
    this.presets = presets;
    this.ram = new Uint8Array(0x8000);
    this.latch = 0;
    this.digits = [0xff, 0xff, 0xff];
    this.leds = 0xff;
    this.swa = 0; this.swb = 0; this.swc = 0;
    this.acia = { ctrl: 0, rx: [], rdr: 0, rdrf: false, nextRx: 0, txBusyUntil: 0 };
    this.tx = []; // bytes sent: [cycle, byte]
    this.t2 = { load: 0, count: 40000 }; // system timer counter 2
    this.pits = [0, 1, 2, 3].map(() => new Pit8253(() => this.cpu.cycles));
    this.watches = null; // Map address -> [{ pc, write, value }]
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.segToChar = segmentTable(os);
  }

  // ---------------------------------------------------------------- bus
  ramIndex(a) { return ((this.latch & 3) << 13) | (a & 0x1fff); }
  read(a) {
    if (a >= 0x8000) return this.os[a - 0x8000];
    if (a >= 0x6000) {
      const i = this.ramIndex(a);
      if (this.watches && this.latch === 0 && this.watches.has(a)) this.watches.get(a).push({ pc: this.cpu.lastPc, write: false, value: this.ram[i] });
      return this.ram[i];
    }
    if (a >= 0x4000) return 0;
    if (a >= 0x2000) return this.presets[((this.latch & 7) << 13) | (a & 0x1fff)];
    return this.ioRead(a);
  }
  write(a, v) {
    if (a >= 0x8000) return;
    if (a >= 0x6000) {
      if (this.watches && this.latch === 0 && this.watches.has(a)) this.watches.get(a).push({ pc: this.cpu.lastPc, write: true, value: v });
      this.ram[this.ramIndex(a)] = v;
      return;
    }
    if (a >= 0x2000) return;
    this.ioWrite(a, v);
  }
  ioRead(a) {
    if (a < 0x1000) return this.pits[(a >> 10) & 3].read(a & 3);
    const blk = a & 0x1c00;
    if (blk === 0x1400) {
      if (a & 0x200) return 0; // system timer: counters are not read back by the paths checked here
      if ((a & 7) === 6) return this.aciaStatus();
      if ((a & 7) === 7) { this.acia.rdrf = false; this.updateFirq(); return this.acia.rdr; }
      return 0;
    }
    if (blk === 0x1800) { const r = a & 3; return r === 0 ? this.swa : r === 1 ? this.swb : r === 2 ? this.swc : 0; }
    return 0;
  }
  ioWrite(a, v) {
    if (a < 0x1000) { this.pits[(a >> 10) & 3].write(a & 3, v); return; }
    const blk = a & 0x1c00;
    if (blk === 0x1400) {
      if (a & 0x200) {
        if ((a & 3) === 3 && (v >> 6) === 2) this.t2.load = this.cpu.cycles; // counter 2 programmed: OUT high again
        if ((a & 3) === 2) this.t2.load = this.cpu.cycles;
        return;
      }
      if ((a & 7) === 6) {
        if ((v & 3) === 3) { this.acia.rdrf = false; this.acia.txBusyUntil = 0; }
        this.acia.ctrl = v;
        this.updateFirq();
      } else if ((a & 7) === 7) {
        this.tx.push([this.cpu.cycles, v]);
        this.acia.txBusyUntil = this.cpu.cycles + BYTE_CYCLES;
        this.updateFirq();
      }
      return;
    }
    if (blk === 0x1c00) {
      const sub = a & 0x380;
      if (sub === 0x180) { this.latch = v & 7; return; }
      if (sub === 0x200) this.digits[0] = v; else if (sub === 0x280) this.digits[1] = v;
      else if (sub === 0x300) this.digits[2] = v; else if (sub === 0x380) this.leds = v;
    }
  }
  aciaStatus() {
    const tdre = this.cpu.cycles >= this.acia.txBusyUntil;
    return (this.acia.rdrf ? 1 : 0) | (tdre ? 2 : 0);
  }
  updateFirq() {
    const c = this.acia.ctrl;
    const rxInt = (c & 0x80) && this.acia.rdrf;
    const txInt = (c & 0x60) === 0x20 && this.cpu.cycles >= this.acia.txBusyUntil;
    this.cpu.firq = !!(rxInt || txInt) && (c & 3) !== 3;
  }

  // ---------------------------------------------------------------- running
  /** Runs for the given number of CPU cycles (2 MHz). */
  run(cycles) {
    const end = this.cpu.cycles + cycles;
    while (this.cpu.cycles < end) this.stepOne();
  }
  /** One instruction with the devices updated first. */
  stepOne() {
    const cpu = this.cpu;
    // MIDI in: one byte every 640 cycles while bytes are queued
    if (this.acia.rx.length && cpu.cycles >= this.acia.nextRx) {
      if (this.acia.rdrf) this.overruns = (this.overruns || 0) + 1;
      this.acia.rdr = this.acia.rx.shift();
      this.acia.rdrf = true;
      this.acia.nextRx = cpu.cycles + BYTE_CYCLES;
    }
    cpu.irq = (cpu.cycles - this.t2.load) >= this.t2.count; // 1 MHz timer: N/2 counts = N cycles
    this.updateFirq();
    cpu.step();
  }
  /** Queues MIDI bytes for the ACIA. */
  midiIn(bytes) {
    if (!this.acia.rx.length) this.acia.nextRx = Math.max(this.acia.nextRx, this.cpu.cycles);
    this.acia.rx.push(...bytes);
  }
  /** Runs until the queued MIDI bytes are taken and the OS has been quiet for `quiet` cycles. */
  settle(quiet = 200000, max = 200000000) {
    const start = this.cpu.cycles;
    while (this.cpu.cycles - start < max) {
      const before = this.tx.length;
      this.run(quiet);
      if (!this.acia.rx.length && this.tx.length === before && this.cpu.cycles >= this.acia.txBusyUntil) return;
    }
    throw new Error('Matrix-1000 did not settle');
  }
  /** Bytes sent since index `from`, split into messages. */
  messages(from = 0) {
    const out = [];
    let cur = null;
    for (const [, b] of this.tx.slice(from)) {
      if (b === 0xf0) { cur = [b]; continue; }
      if (cur) { cur.push(b); if (b === 0xf7) { out.push(cur); cur = null; } continue; }
      // data bytes belong to the last channel message (running status), never to a finished SysEx
      if (b & 0x80) out.push([b]); else if (out.length && out[out.length - 1][0] !== 0xf0 && out[out.length - 1][0] < 0xf0) out[out.length - 1].push(b);
    }
    return out;
  }

  /** Power on. `cold` holds the panel keys the OS reads at reset to reinitialise its memory. */
  powerOn({ cold = false } = {}) {
    // The DCO update adds the last period (voice page offsets A0 and A2) until a timer count turns
    // positive; on a unit those words hold the last periods from battery RAM. Seed them with the
    // OS's own start-up count (11C1h = 440 Hz) when they are still 0, as after a first power-on.
    for (let v = 0; v < 6; v++) for (const o of [0xa0, 0xa2]) {
      const i = (v * 3) * 256 + o;
      if (!this.ram[i] && !this.ram[i + 1]) { this.ram[i] = 0x11; this.ram[i + 1] = 0xc1; }
    }
    this.cpu.reset();
    if (cold) {
      // 1801 bit 2 at reset (8178) makes the OS restart and reinitialise its memory (DC41); bit 3,
      // read once at the end of that (DD02), skips the oscillator calibration that would follow.
      this.swb = 0x04 | 0x08;
      const until = (pc, max = 40000000) => { const s = this.cpu.cycles; while (this.cpu.pc !== pc) { this.stepOne(); if (this.cpu.cycles - s > max) throw new Error(`Matrix-1000 cold start did not reach ${pc.toString(16)}`); } };
      const find = (sig) => { for (let i = 0; i < this.os.length - sig.length; i++) if (sig.every((b, k) => this.os[i + k] === b)) return 0x8000 + i; throw new Error('Matrix-1000 OS: reset code not found'); };
      const bit2 = find([0xb6, 0x18, 0x01, 0x85, 0x04, 0x27]); // lda $1801; bita #4; beq (8178 in v1.03-v1.14)
      let restart = bit2 + 6; while (this.os[restart - 0x8000] !== 0x7e) restart++; // its jmp to the restart
      const bit3 = find([0xb6, 0x18, 0x01, 0x85, 0x08, 0x26]) + 3; // after lda $1801 (DD02 in v1.11-v1.14, D98F in v1.03)
      until(restart); // bit 2 seen: release it before the OS starts again
      this.swb = 0x08;
      until(bit3); // bit 3 read
      this.swb = 0;
    }
    this.run(4000000);
  }

  // ---------------------------------------------------------------- views
  get master() { return this.ram.slice(MASTER - 0x6000, MASTER - 0x6000 + 172); }
  setMaster(bytes) { this.ram.set(bytes, MASTER - 0x6000); }
  /** RAM byte as the CPU sees it with the work page (latch 0). */
  peek(a) { return this.ram[a - 0x6000]; }
  /** The three display digits as text (a dot after a digit when its point is lit). */
  display() {
    let s = '';
    for (const d of this.digits) {
      const v = (~d) & 0xff;
      s += this.segToChar.get(v & ~4) ?? '?';
      if (v & 4) s += '.';
    }
    return s;
  }
  /** Patch RAM bank 0/1 slot n as stored (80 bytes, packed). */
  storedPatch(bank, n) { const o = ((bank + 1) << 13) + n * 80; return this.ram.slice(o, o + 80); }

  /** Records every read and write of the given work-RAM addresses (with the instruction address). */
  watch(addrs) { this.watches = new Map(addrs.map((a) => [a, []])); return this.watches; }

  /** Presses a panel key for `hold` cycles: key 0-9 = digits (1800 bits 0-7, 1801 bits 0-1), or a 1801 bit. */
  press(key, hold = 200000) {
    if (typeof key === 'number') { if (key < 8) this.swa = 1 << key; else this.swb = 1 << (key - 8); } else this.swb = key.bit;
    this.run(hold);
    this.swa = 0; this.swb = 0;
    this.run(hold);
  }

  snapshot() { return { ram: this.ram.slice(), cpu: { ...this.cpu, bus: undefined }, latch: this.latch, t2: { ...this.t2 }, acia: JSON.parse(JSON.stringify(this.acia)), pits: this.pits.map((p) => JSON.stringify(p.c)) }; }
  restore(s) {
    this.ram.set(s.ram); this.latch = s.latch; this.t2 = { ...s.t2 }; this.acia = JSON.parse(JSON.stringify(s.acia));
    s.pits.forEach((j, i) => { this.pits[i].c = JSON.parse(j); });
    for (const k of ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc', 'irq', 'firq', 'nmi', 'nmiArmed', 'nmiPrev', 'waiting', 'cycles', 'lastPc']) this.cpu[k] = s.cpu[k];
  }
}

/** An 8254 timer, enough for what the OS reads back: counter latch, read-back of count and status (the
 *  DCO code waits for OUT through the status byte), LSB/MSB access, modes 0-5 with the gate high. */
export class Pit8253 {
  constructor(now, cyclesPerCount = 1) {
    this.now = now;
    this.k = cyclesPerCount;
    this.c = [0, 1, 2].map(() => ({ mode: 0, rw: 3, n: 0x10000, load: 0, latch: null, status: null, readHi: false, writeHi: false, lo: 0, nullCount: true }));
  }
  elapsed(c) { return Math.floor((this.now() - c.load) / this.k); }
  value(c) {
    const e = this.elapsed(c);
    if (c.mode === 3) return (c.n - ((2 * e) % c.n) + c.n) % c.n || c.n & 0xffff;
    if (c.mode === 2) return c.n - (e % c.n);
    return (c.n - e) & 0xffff;
  }
  out(c) {
    const e = this.elapsed(c);
    if (c.mode === 3) return (e % c.n) < Math.ceil(c.n / 2);
    if (c.mode === 2) return (e % c.n) !== c.n - 1;
    if (c.mode === 0 || c.mode === 4) return c.mode === 0 ? e >= c.n : e !== c.n;
    return true;
  }
  write(r, v) {
    if (r === 3) {
      const sel = v >> 6;
      if (sel === 3) { // read-back: bit 5 = 0 latches counts, bit 4 = 0 latches status, bits 1-3 select counters
        for (let i = 0; i < 3; i++) {
          if (!(v & (2 << i))) continue;
          const c = this.c[i];
          if (!(v & 0x10) && c.status === null) c.status = ((this.out(c) ? 0x80 : 0) | (c.nullCount ? 0x40 : 0) | (c.rw << 4) | (c.mode << 1)) & 0xff;
          if (!(v & 0x20) && c.latch === null) { c.latch = this.value(c) & 0xffff; c.readHi = false; }
        }
        return;
      }
      const c = this.c[sel];
      const rw = (v >> 4) & 3;
      if (rw === 0) { if (c.latch === null) { c.latch = this.value(c) & 0xffff; c.readHi = false; } return; }
      c.rw = rw; c.mode = (v >> 1) & 7; if (c.mode > 5) c.mode -= 4; c.writeHi = false; c.readHi = false; c.latch = null; c.status = null; c.nullCount = true;
      return;
    }
    const c = this.c[r];
    const loaded = (n) => { c.n = n; c.load = this.now(); c.nullCount = false; };
    if (c.rw === 1) { loaded(v || 0x100); return; }
    if (c.rw === 2) { loaded((v << 8) || 0x10000); return; }
    if (!c.writeHi) { c.lo = v; c.writeHi = true; return; }
    c.writeHi = false;
    loaded(((v << 8) | c.lo) || 0x10000);
  }
  read(r) {
    if (r === 3) return 0xff;
    const c = this.c[r];
    if (c.status !== null) { const s = c.status; c.status = null; return s; }
    const v = c.latch ?? (this.value(c) & 0xffff);
    if (c.rw === 1) { c.latch = null; return v & 0xff; }
    if (c.rw === 2) { c.latch = null; return v >> 8; }
    if (!c.readHi) { c.readHi = true; return v & 0xff; }
    c.readHi = false; c.latch = null;
    return v >> 8;
  }
}

/** Segment code -> character, from the OS's own tables (digits at D15E, letters at D16F; v1.03-v1.14). */
function segmentTable(os) {
  const B = 0x8000;
  const find = (sig) => { for (let i = 0; i < os.length - sig.length; i++) if (sig.every((b, k) => os[i + k] === b)) return i; return -1; };
  // the display routine: ldx #letters; cmpa #$20 ... ldx #digits; suba #$30
  const r = find([0x84, 0x3f, 0x8e]);
  const map = new Map([[0, ' '], [0x08, '-']]);
  if (r < 0) return map;
  const letters = (os[r + 3] << 8) | os[r + 4];
  const k = find([0x8e]) && (() => { for (let i = r; i < r + 40; i++) if (os[i] === 0x8e && os[i + 3] === 0x80 && os[i + 4] === 0x30) return i; return -1; })();
  const digits = k > 0 ? (os[k + 1] << 8) | os[k + 2] : -1;
  for (let c = 0; c < 10 && digits > 0; c++) map.set(os[digits - B + c], String(c));
  for (let c = 1; c < 27; c++) { const v = os[letters - B + c]; if (!map.has(v)) map.set(v, String.fromCharCode(64 + c)); }
  return map;
}
