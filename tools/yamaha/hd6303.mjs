// HD6303 / HD6301 (6801 family) CPU with the on-chip timer and serial port, for running the Yamaha DX
// family operating systems in Node (tools/yamaha/dx_emu.mjs). Instruction semantics follow
// tools/yamaha/hd6303.py (the Python emulator written for the DigiTech units) and its opcode table in
// hd6303_dis.py; cycle counts follow the HD6301V1 / HD6303R data sheet, close enough to pace the free
// running counter and MIDI input.
//
//   const cpu = new HD6303({ read(a), write(a, v) });  // external bus: everything but 00-1F, 80-FF
//   cpu.reset(); cpu.step() -> cycles; cpu.midiIn(bytes); cpu.tx: bytes the serial port sent
//
// On-chip (mode 2 / 3, expanded): registers 00-1F (ports 1-4, timer 08-0E, serial 10-13, RAM control 14)
// and 128 bytes of RAM at 80-FF. Serial: 31250 baud from the board's clock (byteCycles per byte); a
// received byte sets RDRF and, with RIE, raises the SCI interrupt (FFF0); a byte written to TDR is sent
// and TDRE comes back one byte time later. Timer: FRC counts cycles; OCF at FRC = OCR (OCI FFF4 with
// EOCI), TOF on overflow (TOI FFF2 with ETOI). IRQ1 (FFF8): the board's irq1 line (level).

export class HD6303Error extends Error {}

const H = 0x20, I = 0x10, N = 0x08, Z = 0x04, V = 0x02, C = 0x01;

// opcode -> [mnemonic, mode, cycles]
const OPS = new Array(256).fill(null);
const op = (c, m, mode, cyc) => { OPS[c] = [m, mode, cyc]; };
{
  const inh = {
    0x01: ['nop', 1], 0x04: ['lsrd', 1], 0x05: ['asld', 1], 0x06: ['tap', 1], 0x07: ['tpa', 1], 0x08: ['inx', 1], 0x09: ['dex', 1],
    0x0a: ['clv', 1], 0x0b: ['sev', 1], 0x0c: ['clc', 1], 0x0d: ['sec', 1], 0x0e: ['cli', 1], 0x0f: ['sei', 1], 0x10: ['sba', 1], 0x11: ['cba', 1],
    0x16: ['tab', 1], 0x17: ['tba', 1], 0x18: ['xgdx', 2], 0x19: ['daa', 2], 0x1a: ['slp', 4], 0x1b: ['aba', 1], 0x30: ['tsx', 1], 0x31: ['ins', 1],
    0x32: ['pula', 3], 0x33: ['pulb', 3], 0x34: ['des', 1], 0x35: ['txs', 1], 0x36: ['psha', 4], 0x37: ['pshb', 4], 0x38: ['pulx', 4], 0x39: ['rts', 5],
    0x3a: ['abx', 1], 0x3b: ['rti', 10], 0x3c: ['pshx', 5], 0x3d: ['mul', 7], 0x3e: ['wai', 9], 0x3f: ['swi', 12],
  };
  for (const [c, [m, cy]] of Object.entries(inh)) op(Number(c), m, 'inh', cy);
  const br = ['bra', 'brn', 'bhi', 'bls', 'bcc', 'bcs', 'bne', 'beq', 'bvc', 'bvs', 'bpl', 'bmi', 'bge', 'blt', 'bgt', 'ble'];
  br.forEach((m, i) => op(0x20 + i, m, 'rel', 3));
  const un = { 0: 'neg', 3: 'com', 4: 'lsr', 6: 'ror', 7: 'asr', 8: 'asl', 9: 'rol', 0xa: 'dec', 0xc: 'inc', 0xd: 'tst', 0xf: 'clr' };
  for (const [lo, m] of Object.entries(un)) {
    const l = Number(lo);
    op(0x40 + l, m, 'a', 1); op(0x50 + l, m, 'b', 1);
    op(0x60 + l, m, 'idx', m === 'tst' ? 4 : m === 'clr' ? 5 : 6);
    op(0x70 + l, m, 'ext', m === 'tst' ? 4 : m === 'clr' ? 5 : 6);
  }
  op(0x6e, 'jmp', 'idx', 3); op(0x7e, 'jmp', 'ext', 3);
  for (const [lo, m] of Object.entries({ 1: 'aim', 2: 'oim', 5: 'eim', 0xb: 'tim' })) {
    op(0x60 + Number(lo), m, 'bimx', m === 'tim' ? 5 : 7);
    op(0x70 + Number(lo), m, 'bimd', m === 'tim' ? 4 : 6);
  }
  const aops = { 0: 'sub', 1: 'cmp', 2: 'sbc', 4: 'and', 5: 'bit', 6: 'lda', 7: 'sta', 8: 'eor', 9: 'adc', 0xa: 'ora', 0xb: 'add' };
  const modes = [['imm8', 2, 3], ['dir', 3, 4], ['idx', 4, 5], ['ext', 4, 5]];
  modes.forEach(([mode, c8, c16], k) => {
    for (const [hiBase, reg] of [[0x80, 'a'], [0xc0, 'b']]) {
      const hi = hiBase + k * 0x10;
      for (const [lo, m] of Object.entries(aops)) {
        if (mode === 'imm8' && m === 'sta') continue;
        op(hi + Number(lo), m + reg, mode, c8);
      }
    }
    const hiA = 0x80 + k * 0x10, hiB = 0xc0 + k * 0x10;
    const w = mode === 'imm8' ? 'imm16' : mode;
    op(hiA + 3, 'subd', w, c16); op(hiA + 0xc, 'cpx', w, c16); op(hiA + 0xe, 'lds', w, c16);
    op(hiB + 3, 'addd', w, c16); op(hiB + 0xc, 'ldd', w, c16); op(hiB + 0xe, 'ldx', w, c16);
    if (mode !== 'imm8') {
      op(hiA + 0xf, 'sts', mode, c16); op(hiA + 0xd, 'jsr', mode, mode === 'ext' ? 6 : 5);
      op(hiB + 0xd, 'std', mode, c16); op(hiB + 0xf, 'stx', mode, c16);
    }
  });
  op(0x8d, 'bsr', 'rel', 5);
}
export { OPS };

export class HD6303 {
  constructor(bus, { byteCycles = 640 } = {}) {
    this.bus = bus;
    this.a = 0; this.b = 0; this.x = 0; this.sp = 0xff; this.pc = 0; this.cc = 0xd0;
    this.cycles = 0;
    this.waiting = false; // WAI: state pushed, waiting for an interrupt
    this.sleeping = false; // SLP
    this.lastPc = 0;
    this.irq1 = false; // external IRQ1 line (level)
    this.nmiPending = false;
    this.hooks = new Map(); // pc -> fn(cpu): true when it handled the instruction
    this.ram = new Uint8Array(128); // 80-FF
    this.reg = new Uint8Array(32);
    this.ports = { read: [null, null, null, null], write: [null, null, null, null] }; // port 1-4 callbacks
    // timer
    this.frc = 0; this.ocr = 0xffff; this.tcsr = 0; this.tcsrRead = 0; this.frcLatch = 0; this.frcWriteHi = 0;
    // serial
    this.byteCycles = byteCycles;
    this.trcsr = 0x20; this.rmcr = 0; this.rdr = 0;
    this.rx = []; this.nextRx = 0;
    this.tx = []; // [cycle, byte]
    this.tdreAt = 0;
  }

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xff; this.b = v & 0xff; }

  // ---------------------------------------------------------------- bus
  read(a) {
    a &= 0xffff;
    if (a < 0x20) return this.readReg(a);
    if (a >= 0x80 && a < 0x100 && (this.reg[0x14] & 0x40 || true)) return this.ram[a - 0x80];
    return this.bus.read(a) & 0xff;
  }
  write(a, v) {
    a &= 0xffff; v &= 0xff;
    if (a < 0x20) { this.writeReg(a, v); return; }
    if (a >= 0x80 && a < 0x100) { this.ram[a - 0x80] = v; return; }
    this.bus.write(a, v);
  }
  rw(a) { return (this.read(a) << 8) | this.read(a + 1); }
  ww(a, v) { this.write(a, v >> 8); this.write(a + 1, v); }

  readReg(r) {
    switch (r) {
      case 0x02: case 0x03: case 0x06: case 0x07: {
        const p = { 2: 0, 3: 1, 6: 2, 7: 3 }[r];
        const f = this.ports.read[p];
        return f ? f(this) & 0xff : this.reg[r];
      }
      case 0x08: this.tcsrRead = this.tcsr; return this.tcsr;
      case 0x09: if (this.tcsrRead & 0x20) this.tcsr &= ~0x20; this.frcLatch = this.frc & 0xff; return (this.frc >> 8) & 0xff;
      case 0x0a: return this.frcLatch;
      case 0x0b: return this.ocr >> 8;
      case 0x0c: return this.ocr & 0xff;
      case 0x10: return this.rmcr;
      case 0x11: this.trcsrRead = this.trcsr; return this.trcsr | (this.cycles >= this.tdreAt ? 0x20 : 0);
      case 0x12: this.trcsr &= ~0xc0; return this.rdr;
      default: return this.reg[r];
    }
  }
  writeReg(r, v) {
    this.reg[r] = v;
    switch (r) {
      case 0x02: case 0x03: case 0x06: case 0x07: {
        const p = { 2: 0, 3: 1, 6: 2, 7: 3 }[r];
        this.ports.write[p]?.(v, this);
        break;
      }
      case 0x08: this.tcsr = (this.tcsr & 0xe0) | (v & 0x1f); break;
      case 0x09: this.frcWriteHi = v; this.frc = 0xfff8; break;
      case 0x0a: this.frc = (this.frcWriteHi << 8) | v; break;
      case 0x0b: this.ocr = (v << 8) | (this.ocr & 0xff); if (this.tcsrRead & 0x40) this.tcsr &= ~0x40; break;
      case 0x0c: this.ocr = (this.ocr & 0xff00) | v; if (this.tcsrRead & 0x40) this.tcsr &= ~0x40; break;
      case 0x10: this.rmcr = v; break;
      case 0x11: this.trcsr = (this.trcsr & 0xe0) | (v & 0x1f); break;
      case 0x13:
        this.tx.push([this.cycles, v]);
        this.tdreAt = this.cycles + this.byteCycles;
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- MIDI
  midiIn(bytes) { for (const b of bytes) this.rx.push(b & 0xff); if (this.nextRx < this.cycles) this.nextRx = this.cycles; }
  /** Bytes sent from position n of the tx log. */
  sent(n = 0) { return this.tx.slice(n).map(([, b]) => b); }

  tick(cyc) {
    this.cycles += cyc;
    // free running counter
    const before = this.frc;
    const after = before + cyc;
    const o = this.ocr;
    if ((o > before && o <= after) || (after > 0xffff && o <= (after & 0xffff))) this.tcsr |= 0x40;
    if (after > 0xffff) this.tcsr |= 0x20;
    this.frc = after & 0xffff;
    // serial receive
    if (this.rx.length && this.cycles >= this.nextRx && (this.trcsr & 0x08)) {
      if (this.trcsr & 0x80) this.trcsr |= 0x40; // overrun
      this.rdr = this.rx.shift();
      this.trcsr |= 0x80;
      this.nextRx = this.cycles + this.byteCycles;
    } else if (this.rx.length && this.cycles >= this.nextRx) {
      this.nextRx = this.cycles + this.byteCycles; // receiver off: the byte is lost
      this.rx.shift();
      this.lost = (this.lost || 0) + 1;
    }
  }

  pendingVector() {
    if (this.nmiPending) { this.nmiPending = false; return [0xfffc, true]; }
    if (this.cc & I) return null;
    if (this.irq1) return [0xfff8];
    if ((this.tcsr & 0x80) && (this.tcsr & 0x10)) return [0xfff6];
    if ((this.tcsr & 0x40) && (this.tcsr & 0x08)) return [0xfff4];
    if ((this.tcsr & 0x20) && (this.tcsr & 0x04)) return [0xfff2];
    const t = this.trcsr | (this.cycles >= this.tdreAt ? 0x20 : 0);
    if (((t & 0xc0) && (t & 0x10)) || ((t & 0x20) && (t & 0x04))) return [0xfff0];
    return null;
  }

  interrupt(vector) {
    if (!this.waiting) {
      this.pushw(this.pc); this.pushw(this.x); this.push(this.a); this.push(this.b); this.push(this.cc);
    }
    this.waiting = false; this.sleeping = false;
    this.cc |= I;
    this.pc = this.rw(vector);
  }

  reset() { this.cc = 0xd0; this.pc = this.rw(0xfffe); this.waiting = false; this.sleeping = false; this.trcsr = 0x20; this.tcsr = 0; this.frc = 0; this.ocr = 0xffff; }

  // ---------------------------------------------------------------- helpers
  push(v) { this.write(this.sp, v); this.sp = (this.sp - 1) & 0xffff; }
  pull() { this.sp = (this.sp + 1) & 0xffff; return this.read(this.sp); }
  pushw(v) { this.push(v & 0xff); this.push(v >> 8); }
  pullw() { const h = this.pull(); return (h << 8) | this.pull(); }
  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetchw() { const v = this.rw(this.pc); this.pc = (this.pc + 2) & 0xffff; return v; }
  flag(f, on) { if (on) this.cc |= f; else this.cc &= ~f & 0xff; }
  nz8(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x80 ? N : 0) | (r === 0 ? Z : 0); }
  nz16(r) { this.cc = (this.cc & ~(N | Z)) | (r & 0x8000 ? N : 0) | (r === 0 ? Z : 0); }
  ld8(r) { this.nz8(r); this.cc &= ~V; return r; }

  add8(r, m, c = 0) {
    const s = r + m + c, res = s & 0xff;
    let f = this.cc & ~(H | N | Z | V | C);
    if ((r ^ m ^ res) & 0x10) f |= H;
    if (res & 0x80) f |= N;
    if (res === 0) f |= Z;
    if ((r ^ res) & (m ^ res) & 0x80) f |= V;
    if (s > 0xff) f |= C;
    this.cc = f;
    return res;
  }
  sub8(r, m, c = 0) {
    const s = r - m - c, res = s & 0xff;
    let f = this.cc & ~(N | Z | V | C);
    if (res & 0x80) f |= N;
    if (res === 0) f |= Z;
    if ((r ^ m) & (r ^ res) & 0x80) f |= V;
    if (s < 0) f |= C;
    this.cc = f;
    return res;
  }
  add16(r, m) { const s = r + m, res = s & 0xffff; this.nz16(res); this.flag(V, (r ^ res) & (m ^ res) & 0x8000); this.flag(C, s > 0xffff); return res; }
  sub16(r, m) { const s = r - m, res = s & 0xffff; this.nz16(res); this.flag(V, (r ^ m) & (r ^ res) & 0x8000); this.flag(C, s < 0); return res; }

  unary(m, r) {
    const c = this.cc & C;
    let res;
    switch (m) {
      case 'neg': res = (-r) & 0xff; this.nz8(res); this.flag(V, res === 0x80); this.flag(C, res !== 0); return res;
      case 'com': res = (~r) & 0xff; this.nz8(res); this.cc = (this.cc & ~V) | C; return res;
      case 'lsr': res = r >> 1; break;
      case 'ror': res = (r >> 1) | (c ? 0x80 : 0); break;
      case 'asr': res = (r >> 1) | (r & 0x80); break;
      case 'asl': case 'rol':
        res = ((r << 1) | (m === 'rol' ? c : 0)) & 0xff;
        this.nz8(res); this.flag(C, r & 0x80); this.flag(V, !!(this.cc & N) !== !!(this.cc & C)); return res;
      case 'dec': res = (r - 1) & 0xff; this.nz8(res); this.flag(V, r === 0x80); return res;
      case 'inc': res = (r + 1) & 0xff; this.nz8(res); this.flag(V, r === 0x7f); return res;
      case 'tst': this.nz8(r); this.cc &= ~(V | C); return null;
      case 'clr': this.cc = (this.cc & ~(N | V | C)) | Z; return 0;
      default: throw new HD6303Error(`unary ${m}`);
    }
    this.nz8(res); this.flag(C, r & 1); this.flag(V, !!(this.cc & N) !== !!(this.cc & C));
    return res;
  }

  cond(k) {
    const c = !!(this.cc & C), z = !!(this.cc & Z), n = !!(this.cc & N), v = !!(this.cc & V);
    switch (k) {
      case 0: return true; case 1: return false; case 2: return !(c || z); case 3: return c || z;
      case 4: return !c; case 5: return c; case 6: return !z; case 7: return z;
      case 8: return !v; case 9: return v; case 10: return !n; case 11: return n;
      case 12: return n === v; case 13: return n !== v; case 14: return !z && n === v; default: return z || n !== v;
    }
  }

  daa() {
    const a = this.a, lo = a & 0x0f, hi = a >> 4;
    let corr = 0, c = this.cc & C;
    if ((this.cc & H) || lo > 9) corr |= 0x06;
    if (c || hi > 9 || (hi > 8 && lo > 9)) { corr |= 0x60; c = 1; }
    const res = (a + corr) & 0xff;
    this.nz8(res); this.flag(C, c); this.a = res;
  }

  ea(mode) {
    if (mode === 'dir') return this.fetch();
    if (mode === 'ext') return this.fetchw();
    if (mode === 'idx') return (this.x + this.fetch()) & 0xffff;
    throw new HD6303Error(`mode ${mode}`);
  }

  // ---------------------------------------------------------------- execution
  /** One instruction (or one interrupt entry, or an idle tick while waiting). Returns the cycles. */
  step() {
    const v = this.pendingVector();
    if (v) { this.interrupt(v[0]); this.tick(12); return 12; }
    if (this.waiting || this.sleeping) { this.tick(4); return 4; }
    const h = this.hooks.get(this.pc);
    if (h && h(this)) { this.tick(4); return 4; }
    this.lastPc = this.pc;
    const opc = this.fetch();
    const e = OPS[opc];
    if (!e) throw new HD6303Error(`illegal opcode ${opc.toString(16)} at ${this.lastPc.toString(16)}`);
    const [m, mode, cyc] = e;
    this.exec(opc, m, mode);
    this.tick(cyc);
    return cyc;
  }

  exec(opc, m, mode) {
    const hi = opc >> 4;
    if (mode === 'rel') {
      const off = this.fetch();
      const t = (this.pc + (off & 0x80 ? off - 256 : off)) & 0xffff;
      if (m === 'bsr') { this.pushw(this.pc); this.pc = t; return; }
      if (this.cond(opc & 0x0f)) this.pc = t;
      return;
    }
    if (m === 'jmp') { this.pc = this.ea(mode); return; }
    if (m === 'aim' || m === 'oim' || m === 'eim' || m === 'tim') {
      const imm = this.fetch();
      const a = mode === 'bimx' ? (this.x + this.fetch()) & 0xffff : this.fetch();
      const v = this.read(a);
      const r = m === 'aim' ? v & imm : m === 'oim' ? v | imm : m === 'eim' ? v ^ imm : v & imm;
      this.nz8(r); this.cc &= ~V;
      if (m !== 'tim') this.write(a, r);
      return;
    }
    if (hi >= 4 && hi <= 7) {
      if (mode === 'a') { const r = this.unary(m, this.a); if (r !== null) this.a = r; return; }
      if (mode === 'b') { const r = this.unary(m, this.b); if (r !== null) this.b = r; return; }
      const a = this.ea(mode);
      const r = this.unary(m, m === 'clr' ? 0 : this.read(a));
      if (r !== null) this.write(a, r);
      return;
    }
    if (hi >= 8) { this.alu(m, mode); return; }
    this.inherent(m);
  }

  operand8(mode) { return mode === 'imm8' ? this.fetch() : this.read(this.ea(mode)); }
  operand16(mode) { return mode === 'imm16' ? this.fetchw() : this.rw(this.ea(mode)); }

  alu(m, mode) {
    switch (m) {
      case 'jsr': { const a = this.ea(mode); this.pushw(this.pc); this.pc = a; return; }
      case 'subd': this.d = this.sub16(this.d, this.operand16(mode)); return;
      case 'addd': this.d = this.add16(this.d, this.operand16(mode)); return;
      case 'cpx': this.sub16(this.x, this.operand16(mode)); return;
      case 'ldd': case 'ldx': case 'lds': {
        const v = this.operand16(mode); this.nz16(v); this.cc &= ~V;
        if (m === 'ldd') this.d = v; else if (m === 'ldx') this.x = v; else this.sp = v;
        return;
      }
      case 'std': case 'stx': case 'sts': {
        const a = this.ea(mode), v = m === 'std' ? this.d : m === 'stx' ? this.x : this.sp;
        this.ww(a, v); this.nz16(v); this.cc &= ~V; return;
      }
      default: break;
    }
    const isb = m.endsWith('b');
    let r = isb ? this.b : this.a;
    const base = m.slice(0, -1);
    if (base === 'sta') { this.write(this.ea(mode), r); this.ld8(r); return; }
    const v = this.operand8(mode);
    const c = this.cc & C;
    switch (base) {
      case 'sub': r = this.sub8(r, v); break;
      case 'cmp': this.sub8(r, v); return;
      case 'sbc': r = this.sub8(r, v, c); break;
      case 'and': r = this.ld8(r & v); break;
      case 'bit': this.ld8(r & v); return;
      case 'lda': r = this.ld8(v); break;
      case 'eor': r = this.ld8(r ^ v); break;
      case 'adc': r = this.add8(r, v, c); break;
      case 'ora': r = this.ld8(r | v); break;
      case 'add': r = this.add8(r, v); break;
      default: throw new HD6303Error(`alu ${m}`);
    }
    if (isb) this.b = r; else this.a = r;
  }

  inherent(m) {
    switch (m) {
      case 'nop': return;
      case 'lsrd': { const d = this.d, r = d >> 1; this.nz16(r); this.flag(C, d & 1); this.flag(V, d & 1); this.d = r; return; }
      case 'asld': { const d = this.d, r = (d << 1) & 0xffff; this.nz16(r); this.flag(C, d & 0x8000); this.flag(V, !!(r & 0x8000) !== !!(d & 0x8000)); this.d = r; return; }
      case 'tap': this.cc = this.a | 0xc0; return;
      case 'tpa': this.a = this.cc | 0xc0; return;
      case 'inx': this.x = (this.x + 1) & 0xffff; this.flag(Z, this.x === 0); return;
      case 'dex': this.x = (this.x - 1) & 0xffff; this.flag(Z, this.x === 0); return;
      case 'clv': this.cc &= ~V; return;
      case 'sev': this.cc |= V; return;
      case 'clc': this.cc &= ~C; return;
      case 'sec': this.cc |= C; return;
      case 'cli': this.cc &= ~I; return;
      case 'sei': this.cc |= I; return;
      case 'sba': this.a = this.sub8(this.a, this.b); return;
      case 'cba': this.sub8(this.a, this.b); return;
      case 'tab': this.b = this.ld8(this.a); return;
      case 'tba': this.a = this.ld8(this.b); return;
      case 'xgdx': { const t = this.x; this.x = this.d; this.d = t; return; }
      case 'daa': this.daa(); return;
      case 'slp': this.sleeping = true; return;
      case 'aba': this.a = this.add8(this.a, this.b); return;
      case 'tsx': this.x = (this.sp + 1) & 0xffff; return;
      case 'ins': this.sp = (this.sp + 1) & 0xffff; return;
      case 'pula': this.a = this.pull(); return;
      case 'pulb': this.b = this.pull(); return;
      case 'des': this.sp = (this.sp - 1) & 0xffff; return;
      case 'txs': this.sp = (this.x - 1) & 0xffff; return;
      case 'psha': this.push(this.a); return;
      case 'pshb': this.push(this.b); return;
      case 'pulx': this.x = this.pullw(); return;
      case 'rts': this.pc = this.pullw(); return;
      case 'abx': this.x = (this.x + this.b) & 0xffff; return;
      case 'rti': this.cc = this.pull() | 0xc0; this.b = this.pull(); this.a = this.pull(); this.x = this.pullw(); this.pc = this.pullw(); return;
      case 'pshx': this.pushw(this.x); return;
      case 'mul': { const r = this.a * this.b; this.d = r; this.flag(C, r & 0x80); return; }
      case 'wai': this.pushw(this.pc); this.pushw(this.x); this.push(this.a); this.push(this.b); this.push(this.cc); this.waiting = true; return;
      case 'swi': this.pushw(this.pc); this.pushw(this.x); this.push(this.a); this.push(this.b); this.push(this.cc); this.cc |= I; this.pc = this.rw(0xfffa); return;
      default: throw new HD6303Error(`inherent ${m}`);
    }
  }

  /** Run the subroutine at addr until it returns. */
  call(addr, { maxCycles = 50_000_000, a, b, x } = {}) {
    if (a !== undefined) this.a = a & 0xff;
    if (b !== undefined) this.b = b & 0xff;
    if (x !== undefined) this.x = x & 0xffff;
    const SENT = 0xfffe;
    this.pushw(SENT);
    const sp0 = this.sp;
    this.pc = addr;
    const end = this.cycles + maxCycles;
    while (!(this.pc === SENT && this.sp === ((sp0 + 2) & 0xffff))) {
      this.step();
      if (this.cycles > end) throw new HD6303Error(`call ${addr.toString(16)}: cycle limit at ${this.pc.toString(16)}`);
    }
  }
}
