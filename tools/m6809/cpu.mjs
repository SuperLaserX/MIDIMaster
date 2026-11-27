// Motorola 6809 CPU core, for running the operating systems of 6809-based instruments (first user:
// the Oberheim Matrix-1000, tools/matrix1000/emu.mjs). Written from the MC6809 data sheet; every
// documented opcode of pages 0, 10h and 11h, the interrupts (NMI, FIRQ, IRQ, SWI 1-3), CWAI and
// SYNC. Cycle counts follow the data sheet (indexed modes included), close enough to pace timers
// and serial input. Undefined opcodes throw M6809Error with the address.
//
//   const cpu = new M6809({ read(a), write(a, v) });   // 16-bit addresses, big-endian words
//   cpu.reset(); cpu.step() -> cycles;  cpu.irq / cpu.firq / cpu.nmi: input lines (level, NMI edge)
//
// Self test: node tools/m6809/selftest.mjs

export class M6809Error extends Error {}

const C = 1, V = 2, Z = 4, N = 8, I = 16, H = 32, F = 64, E = 128;

// Base cycles of page-0 opcodes (indexed modes add the postbyte's extra cycles).
const CYC0 = [
  6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6, // 00
  0, 0, 2, 4, 0, 0, 5, 9, 0, 2, 3, 0, 3, 2, 8, 6, // 10
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, // 20
  4, 4, 4, 4, 5, 5, 5, 5, 0, 5, 3, 6, 20, 11, 0, 19, // 30
  2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2, // 40
  2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2, // 50
  6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6, // 60
  7, 0, 0, 7, 7, 0, 7, 7, 7, 7, 7, 0, 7, 7, 4, 7, // 70
  2, 2, 2, 4, 2, 2, 2, 0, 2, 2, 2, 2, 4, 7, 3, 0, // 80
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 7, 5, 5, // 90
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 7, 5, 5, // A0
  5, 5, 5, 7, 5, 5, 5, 5, 5, 5, 5, 5, 7, 8, 6, 6, // B0
  2, 2, 2, 4, 2, 2, 2, 0, 2, 2, 2, 2, 3, 0, 3, 0, // C0
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, // D0
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, // E0
  5, 5, 5, 7, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, // F0
];

export class M6809 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.b = 0; this.x = 0; this.y = 0; this.u = 0; this.s = 0;
    this.pc = 0; this.dp = 0; this.cc = I | F;
    this.irq = false; this.firq = false; this.nmi = false;
    this.nmiArmed = false; this.nmiPrev = false;
    this.waiting = 0; // 1 = CWAI (state pushed), 2 = SYNC
    this.cycles = 0;
    this.lastPc = 0;
  }

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xff; this.b = v & 0xff; }

  // ---------------------------------------------------------------- memory
  r8(a) { return this.bus.read(a & 0xffff) & 0xff; }
  w8(a, v) { this.bus.write(a & 0xffff, v & 0xff); }
  r16(a) { return (this.r8(a) << 8) | this.r8(a + 1); }
  w16(a, v) { this.w8(a, v >> 8); this.w8(a + 1, v); }
  imm8() { const v = this.r8(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  imm16() { const v = this.r16(this.pc); this.pc = (this.pc + 2) & 0xffff; return v; }
  push8s(v) { this.s = (this.s - 1) & 0xffff; this.w8(this.s, v); }
  push16s(v) { this.push8s(v); this.push8s(v >> 8); }
  pull8s() { const v = this.r8(this.s); this.s = (this.s + 1) & 0xffff; return v; }
  pull16s() { const h = this.pull8s(); return (h << 8) | this.pull8s(); }

  reset() {
    this.cc = I | F; this.dp = 0; this.waiting = 0; this.nmiArmed = false;
    this.pc = this.r16(0xfffe);
  }

  // ---------------------------------------------------------------- flags
  setNZ8(v) { this.cc = (this.cc & ~(N | Z)) | (v & 0x80 ? N : 0) | ((v & 0xff) === 0 ? Z : 0); }
  setNZ16(v) { this.cc = (this.cc & ~(N | Z)) | (v & 0x8000 ? N : 0) | ((v & 0xffff) === 0 ? Z : 0); }
  add8(a, b, c = 0) {
    const r = a + b + c;
    this.cc &= ~(H | N | Z | V | C);
    if (((a & 15) + (b & 15) + c) & 0x10) this.cc |= H;
    if (r & 0x100) this.cc |= C;
    if ((~(a ^ b) & (a ^ r)) & 0x80) this.cc |= V;
    this.setNZ8(r);
    return r & 0xff;
  }
  sub8(a, b, c = 0) {
    const r = a - b - c;
    this.cc &= ~(N | Z | V | C);
    if (r & 0x100) this.cc |= C;
    if (((a ^ b) & (a ^ r)) & 0x80) this.cc |= V;
    this.setNZ8(r);
    return r & 0xff;
  }
  add16(a, b) {
    const r = a + b;
    this.cc &= ~(N | Z | V | C);
    if (r & 0x10000) this.cc |= C;
    if ((~(a ^ b) & (a ^ r)) & 0x8000) this.cc |= V;
    this.setNZ16(r);
    return r & 0xffff;
  }
  sub16(a, b) {
    const r = a - b;
    this.cc &= ~(N | Z | V | C);
    if (r & 0x10000) this.cc |= C;
    if (((a ^ b) & (a ^ r)) & 0x8000) this.cc |= V;
    this.setNZ16(r);
    return r & 0xffff;
  }
  logic8(v) { this.cc &= ~V; this.setNZ8(v); return v & 0xff; }
  ld16(v) { this.cc &= ~V; this.setNZ16(v); return v & 0xffff; }

  // Read-modify-write unary operations (NEG ... CLR), op = low nibble of the opcode.
  unary(op, v) {
    switch (op) {
      case 0x0: { const r = (-v) & 0xff; this.cc &= ~(N | Z | V | C); if (v === 0x80) this.cc |= V; if (v) this.cc |= C; this.setNZ8(r); return r; } // NEG
      case 0x3: { const r = (~v) & 0xff; this.cc = (this.cc & ~V) | C; this.setNZ8(r); return r; } // COM
      case 0x4: { this.cc = (this.cc & ~(N | Z | C)) | (v & 1 ? C : 0); const r = v >> 1; this.setNZ8(r); return r; } // LSR
      case 0x6: { const r = ((v >> 1) | (this.cc & C ? 0x80 : 0)) & 0xff; this.cc = (this.cc & ~C) | (v & 1 ? C : 0); this.setNZ8(r); return r; } // ROR
      case 0x7: { const r = ((v >> 1) | (v & 0x80)) & 0xff; this.cc = (this.cc & ~C) | (v & 1 ? C : 0); this.setNZ8(r); return r; } // ASR
      case 0x8: { const r = (v << 1) & 0xff; this.cc = (this.cc & ~(C | V)) | (v & 0x80 ? C : 0) | (((v ^ (v << 1)) & 0x80) ? V : 0); this.setNZ8(r); return r; } // ASL
      case 0x9: { const r = ((v << 1) | (this.cc & C)) & 0xff; this.cc = (this.cc & ~(C | V)) | (v & 0x80 ? C : 0) | (((v ^ (v << 1)) & 0x80) ? V : 0); this.setNZ8(r); return r; } // ROL
      case 0xa: { const r = (v - 1) & 0xff; this.cc = (this.cc & ~V) | (v === 0x80 ? V : 0); this.setNZ8(r); return r; } // DEC
      case 0xc: { const r = (v + 1) & 0xff; this.cc = (this.cc & ~V) | (v === 0x7f ? V : 0); this.setNZ8(r); return r; } // INC
      case 0xd: { this.cc &= ~V; this.setNZ8(v); return null; } // TST (no write)
      case 0xf: { this.cc = (this.cc & ~(N | V | C)) | Z; return 0; } // CLR
      default: throw new M6809Error(`illegal unary op at ${hex4(this.lastPc)}`);
    }
  }

  // ---------------------------------------------------------------- addressing
  idxReg(r) { return r === 0 ? this.x : r === 1 ? this.y : r === 2 ? this.u : this.s; }
  setIdxReg(r, v) { v &= 0xffff; if (r === 0) this.x = v; else if (r === 1) this.y = v; else if (r === 2) this.u = v; else this.s = v; }
  /** Effective address of an indexed operand; adds the postbyte's cycles to this.extra. */
  indexed() {
    const pb = this.imm8();
    const r = (pb >> 5) & 3;
    let ea;
    if (!(pb & 0x80)) { // 5-bit offset
      const o = pb & 0x10 ? (pb & 0x1f) - 32 : pb & 0x1f;
      this.extra += 1;
      return (this.idxReg(r) + o) & 0xffff;
    }
    const ind = pb & 0x10;
    switch (pb & 0x0f) {
      case 0x0: ea = this.idxReg(r); this.setIdxReg(r, ea + 1); this.extra += 2; break;
      case 0x1: ea = this.idxReg(r); this.setIdxReg(r, ea + 2); this.extra += 3; break;
      case 0x2: this.setIdxReg(r, this.idxReg(r) - 1); ea = this.idxReg(r); this.extra += 2; break;
      case 0x3: this.setIdxReg(r, this.idxReg(r) - 2); ea = this.idxReg(r); this.extra += 3; break;
      case 0x4: ea = this.idxReg(r); break;
      case 0x5: ea = this.idxReg(r) + sx8(this.b); this.extra += 1; break;
      case 0x6: ea = this.idxReg(r) + sx8(this.a); this.extra += 1; break;
      case 0x8: { const o = sx8(this.imm8()); ea = this.idxReg(r) + o; this.extra += 1; break; }
      case 0x9: { const o = this.imm16(); ea = this.idxReg(r) + o; this.extra += 4; break; }
      case 0xb: ea = this.idxReg(r) + this.d; this.extra += 4; break;
      case 0xc: { const o = sx8(this.imm8()); ea = this.pc + o; this.extra += 1; break; }
      case 0xd: { const o = this.imm16(); ea = this.pc + o; this.extra += 5; break; }
      case 0xf: ea = this.imm16(); this.extra += 2; break; // [n16] only (with the indirect cycles: 5)
      default: throw new M6809Error(`illegal indexed postbyte ${hex2(pb)} at ${hex4(this.lastPc)}`);
    }
    ea &= 0xffff;
    if (ind) { ea = this.r16(ea); this.extra += 3; }
    return ea;
  }
  /** Effective address for opcode groups by mode bits (hi nibble 1 = dir, 2 = idx, 3 = ext). */
  ea(mode) {
    if (mode === 1) return (this.dp << 8) | this.imm8();
    if (mode === 2) return this.indexed();
    return this.imm16();
  }

  // ---------------------------------------------------------------- registers by TFR/EXG code
  getReg(code) {
    switch (code) {
      case 0: return this.d; case 1: return this.x; case 2: return this.y; case 3: return this.u;
      case 4: return this.s; case 5: return this.pc; case 8: return this.a; case 9: return this.b;
      case 10: return this.cc; case 11: return this.dp; default: return 0xff;
    }
  }
  setReg(code, v) {
    switch (code) {
      case 0: this.d = v & 0xffff; break; case 1: this.x = v & 0xffff; break; case 2: this.y = v & 0xffff; break;
      case 3: this.u = v & 0xffff; break; case 4: this.s = v & 0xffff; this.nmiArmed = true; break; case 5: this.pc = v & 0xffff; break;
      case 8: this.a = v & 0xff; break; case 9: this.b = v & 0xff; break; case 10: this.cc = v & 0xff; break; case 11: this.dp = v & 0xff; break;
      default: break;
    }
  }
  /** TFR / EXG: 8-bit to 16-bit gives FFxx, 16-bit to 8-bit keeps the low byte. */
  transfer(pb, exchange) {
    const s = pb >> 4, d = pb & 15;
    const wide = (c) => c < 8;
    const conv = (v, from, to) => (wide(from) === wide(to) ? v : wide(to) ? (0xff00 | v) : v & 0xff);
    const vs = this.getReg(s), vd = this.getReg(d);
    this.setReg(d, conv(vs, s, d));
    if (exchange) this.setReg(s, conv(vd, d, s));
  }

  // ---------------------------------------------------------------- stacks
  pushRegs(post, user) {
    const sp = user ? 'u' : 's';
    const other = user ? this.s : this.u;
    const p8 = (v) => { this[sp] = (this[sp] - 1) & 0xffff; this.w8(this[sp], v); this.extra += 1; };
    const p16 = (v) => { p8(v & 0xff); p8(v >> 8); };
    if (post & 0x80) p16(this.pc);
    if (post & 0x40) p16(other);
    if (post & 0x20) p16(this.y);
    if (post & 0x10) p16(this.x);
    if (post & 0x08) p8(this.dp);
    if (post & 0x04) p8(this.b);
    if (post & 0x02) p8(this.a);
    if (post & 0x01) p8(this.cc);
  }
  pullRegs(post, user) {
    const sp = user ? 'u' : 's';
    const g8 = () => { const v = this.r8(this[sp]); this[sp] = (this[sp] + 1) & 0xffff; this.extra += 1; return v; };
    const g16 = () => { const h = g8(); return (h << 8) | g8(); };
    if (post & 0x01) this.cc = g8();
    if (post & 0x02) this.a = g8();
    if (post & 0x04) this.b = g8();
    if (post & 0x08) this.dp = g8();
    if (post & 0x10) this.x = g16();
    if (post & 0x20) this.y = g16();
    if (post & 0x40) { const v = g16(); if (user) { this.s = v; this.nmiArmed = true; } else this.u = v; }
    if (post & 0x80) this.pc = g16();
  }
  pushAll() {
    this.push16s(this.pc); this.push16s(this.u); this.push16s(this.y); this.push16s(this.x);
    this.push8s(this.dp); this.push8s(this.b); this.push8s(this.a); this.push8s(this.cc);
  }

  // ---------------------------------------------------------------- interrupts
  /** Takes a pending interrupt; returns cycles used, or 0. */
  interrupt() {
    const nmiEdge = this.nmi && !this.nmiPrev;
    this.nmiPrev = this.nmi;
    if (nmiEdge && this.nmiArmed) {
      if (this.waiting !== 1) { this.cc |= E; this.pushAll(); }
      this.cc |= I | F; this.waiting = 0; this.pc = this.r16(0xfffc); return 19;
    }
    if (this.firq && !(this.cc & F)) {
      if (this.waiting !== 1) { this.cc &= ~E; this.push16s(this.pc); this.push8s(this.cc); }
      this.cc |= I | F; this.waiting = 0; this.pc = this.r16(0xfff6); return 10;
    }
    if (this.irq && !(this.cc & I)) {
      if (this.waiting !== 1) { this.cc |= E; this.pushAll(); }
      this.cc |= I; this.waiting = 0; this.pc = this.r16(0xfff8); return 19;
    }
    if (this.waiting === 2 && (this.irq || this.firq || this.nmi)) this.waiting = 0; // SYNC ends on any line
    return 0;
  }

  branch(cond) {
    switch (cond) {
      case 0x0: return true;
      case 0x1: return false;
      case 0x2: return !(this.cc & (C | Z));
      case 0x3: return !!(this.cc & (C | Z));
      case 0x4: return !(this.cc & C);
      case 0x5: return !!(this.cc & C);
      case 0x6: return !(this.cc & Z);
      case 0x7: return !!(this.cc & Z);
      case 0x8: return !(this.cc & V);
      case 0x9: return !!(this.cc & V);
      case 0xa: return !(this.cc & N);
      case 0xb: return !!(this.cc & N);
      case 0xc: return !(this.cc & N) === !(this.cc & V);
      case 0xd: return !(this.cc & N) !== !(this.cc & V);
      case 0xe: return !(this.cc & Z) && !(this.cc & N) === !(this.cc & V);
      default: return !!(this.cc & Z) || !(this.cc & N) !== !(this.cc & V);
    }
  }

  // ---------------------------------------------------------------- execution
  /** Runs one instruction (or takes an interrupt); returns the cycles used. */
  step() {
    const ic = this.interrupt();
    if (ic) { this.cycles += ic; return ic; }
    if (this.waiting) { this.cycles += 1; return 1; }
    this.lastPc = this.pc;
    this.extra = 0;
    const op = this.imm8();
    let cyc;
    if (op === 0x10) cyc = this.page2(this.imm8());
    else if (op === 0x11) cyc = this.page3(this.imm8());
    else cyc = this.page0(op);
    cyc += this.extra;
    this.cycles += cyc;
    return cyc;
  }

  page0(op) {
    const hi = op >> 4, lo = op & 15;
    const base = CYC0[op];
    switch (hi) {
      case 0x0: case 0x6: case 0x7: { // memory unary / JMP
        const ea = this.ea(hi === 0 ? 1 : hi === 6 ? 2 : 3);
        if (lo === 0xe) { this.pc = ea; return base; }
        const r = this.unary(lo, lo === 0xf ? 0 : this.r8(ea));
        if (r !== null) this.w8(ea, r);
        return base;
      }
      case 0x4: { const r = this.unary(lo, this.a); if (r !== null) this.a = r; return base; }
      case 0x5: { const r = this.unary(lo, this.b); if (r !== null) this.b = r; return base; }
      case 0x2: { const o = sx8(this.imm8()); if (this.branch(lo)) this.pc = (this.pc + o) & 0xffff; return 3; }
      case 0x1: return this.misc1(op);
      case 0x3: return this.misc3(op);
      default: return this.alu(op);
    }
  }

  misc1(op) {
    switch (op) {
      case 0x12: return 2; // NOP
      case 0x13: this.waiting = 2; return 4; // SYNC
      case 0x16: { const o = this.imm16(); this.pc = (this.pc + o) & 0xffff; return 5; } // LBRA
      case 0x17: { const o = this.imm16(); this.push16s(this.pc); this.pc = (this.pc + o) & 0xffff; return 9; } // LBSR
      case 0x19: { // DAA
        let cf = 0;
        const lsn = this.a & 15, msn = this.a >> 4;
        if ((this.cc & H) || lsn > 9) cf |= 0x06;
        if ((this.cc & C) || msn > 9 || (msn > 8 && lsn > 9)) cf |= 0x60;
        const r = this.a + cf;
        this.cc &= ~(N | Z | V);
        if (r & 0x100) this.cc |= C;
        this.a = r & 0xff; this.setNZ8(this.a);
        return 2;
      }
      case 0x1a: this.cc |= this.imm8(); return 3; // ORCC
      case 0x1c: this.cc &= this.imm8(); return 3; // ANDCC
      case 0x1d: this.a = this.b & 0x80 ? 0xff : 0; this.cc &= ~V; this.setNZ16(this.d); return 2; // SEX
      case 0x1e: this.transfer(this.imm8(), true); return 8; // EXG
      case 0x1f: this.transfer(this.imm8(), false); return 6; // TFR
      default: throw new M6809Error(`illegal opcode ${hex2(op)} at ${hex4(this.lastPc)}`);
    }
  }

  misc3(op) {
    switch (op) {
      case 0x30: { this.x = this.indexed(); this.cc = (this.cc & ~Z) | (this.x === 0 ? Z : 0); return 4; } // LEAX
      case 0x31: { this.y = this.indexed(); this.cc = (this.cc & ~Z) | (this.y === 0 ? Z : 0); return 4; } // LEAY
      case 0x32: { this.s = this.indexed(); this.nmiArmed = true; return 4; } // LEAS
      case 0x33: { this.u = this.indexed(); return 4; } // LEAU
      case 0x34: this.pushRegs(this.imm8(), false); return 5; // PSHS
      case 0x35: this.pullRegs(this.imm8(), false); return 5; // PULS
      case 0x36: this.pushRegs(this.imm8(), true); return 5; // PSHU
      case 0x37: this.pullRegs(this.imm8(), true); return 5; // PULU
      case 0x39: this.pc = this.pull16s(); return 5; // RTS
      case 0x3a: this.x = (this.x + this.b) & 0xffff; return 3; // ABX
      case 0x3b: { // RTI
        this.cc = this.pull8s();
        if (this.cc & E) {
          this.a = this.pull8s(); this.b = this.pull8s(); this.dp = this.pull8s();
          this.x = this.pull16s(); this.y = this.pull16s(); this.u = this.pull16s(); this.pc = this.pull16s();
          return 15;
        }
        this.pc = this.pull16s();
        return 6;
      }
      case 0x3c: { const m = this.imm8(); this.cc = (this.cc & m) | E; this.pushAll(); this.waiting = 1; return 20; } // CWAI
      case 0x3d: { const r = this.a * this.b; this.d = r; this.cc = (this.cc & ~(Z | C)) | (r === 0 ? Z : 0) | (r & 0x80 ? C : 0); return 11; } // MUL
      case 0x3f: { this.cc |= E; this.pushAll(); this.cc |= I | F; this.pc = this.r16(0xfffa); return 19; } // SWI
      default: throw new M6809Error(`illegal opcode ${hex2(op)} at ${hex4(this.lastPc)}`);
    }
  }

  /** Opcodes 80-FF: accumulator and 16-bit register operations. */
  alu(op) {
    const lo = op & 15, mode = (op >> 4) & 3; // 0 imm, 1 dir, 2 idx, 3 ext
    const isB = op >= 0xc0;
    const base = CYC0[op];
    // BSR (8D)
    if (op === 0x8d) { const o = sx8(this.imm8()); this.push16s(this.pc); this.pc = (this.pc + o) & 0xffff; return 7; }
    // stores and JSR need an address, never an immediate
    if (mode === 0 && ((!isB && (lo === 7 || lo === 0xf)) || (isB && (lo === 7 || lo === 0xd || lo === 0xf)))) {
      throw new M6809Error(`illegal opcode ${hex2(op)} at ${hex4(this.lastPc)}`);
    }
    let ea = 0;
    if (mode !== 0) ea = this.ea(mode);
    const v8 = () => (mode === 0 ? this.imm8() : this.r8(ea));
    const v16 = () => (mode === 0 ? this.imm16() : this.r16(ea));
    if (!isB) {
      switch (lo) {
        case 0x0: this.a = this.sub8(this.a, v8()); break;
        case 0x1: this.sub8(this.a, v8()); break;
        case 0x2: this.a = this.sub8(this.a, v8(), this.cc & C); break;
        case 0x3: this.d = this.sub16(this.d, v16()); break;
        case 0x4: this.a = this.logic8(this.a & v8()); break;
        case 0x5: this.logic8(this.a & v8()); break;
        case 0x6: this.a = this.logic8(v8()); break;
        case 0x7: this.logic8(this.a); this.w8(ea, this.a); break;
        case 0x8: this.a = this.logic8(this.a ^ v8()); break;
        case 0x9: this.a = this.add8(this.a, v8(), this.cc & C); break;
        case 0xa: this.a = this.logic8(this.a | v8()); break;
        case 0xb: this.a = this.add8(this.a, v8()); break;
        case 0xc: this.sub16(this.x, v16()); break;
        case 0xd: this.push16s(this.pc); this.pc = ea; break; // JSR
        case 0xe: this.x = this.ld16(v16()); break;
        default: this.ld16(this.x); this.w16(ea, this.x); break;
      }
    } else {
      switch (lo) {
        case 0x0: this.b = this.sub8(this.b, v8()); break;
        case 0x1: this.sub8(this.b, v8()); break;
        case 0x2: this.b = this.sub8(this.b, v8(), this.cc & C); break;
        case 0x3: this.d = this.add16(this.d, v16()); break;
        case 0x4: this.b = this.logic8(this.b & v8()); break;
        case 0x5: this.logic8(this.b & v8()); break;
        case 0x6: this.b = this.logic8(v8()); break;
        case 0x7: this.logic8(this.b); this.w8(ea, this.b); break;
        case 0x8: this.b = this.logic8(this.b ^ v8()); break;
        case 0x9: this.b = this.add8(this.b, v8(), this.cc & C); break;
        case 0xa: this.b = this.logic8(this.b | v8()); break;
        case 0xb: this.b = this.add8(this.b, v8()); break;
        case 0xc: this.d = this.ld16(v16()); break;
        case 0xd: this.ld16(this.d); this.w16(ea, this.d); break;
        case 0xe: this.u = this.ld16(v16()); break;
        default: this.ld16(this.u); this.w16(ea, this.u); break;
      }
    }
    return base;
  }

  page2(op) {
    if (op >= 0x21 && op <= 0x2f) {
      const o = this.imm16();
      if (this.branch(op & 15)) { this.pc = (this.pc + o) & 0xffff; return 6; }
      return 5;
    }
    if (op === 0x3f) { this.cc |= E; this.pushAll(); this.pc = this.r16(0xfff4); return 20; } // SWI2
    const lo = op & 15, mode = (op >> 4) & 3;
    const cyc = [5, 7, 7, 8][mode];
    const cycLd = [4, 6, 6, 7][mode];
    let ea = 0;
    if (mode !== 0) ea = this.ea(mode);
    const v16 = () => (mode === 0 ? this.imm16() : this.r16(ea));
    if (op < 0xc0) {
      if (lo === 0x3) { this.sub16(this.d, v16()); return cyc; } // CMPD
      if (lo === 0xc) { this.sub16(this.y, v16()); return cyc; } // CMPY
      if (lo === 0xe) { this.y = this.ld16(v16()); return cycLd; } // LDY
      if (lo === 0xf && mode !== 0) { this.ld16(this.y); this.w16(ea, this.y); return cycLd; } // STY
    } else {
      if (lo === 0xe) { this.s = this.ld16(v16()); this.nmiArmed = true; return cycLd; } // LDS
      if (lo === 0xf && mode !== 0) { this.ld16(this.s); this.w16(ea, this.s); return cycLd; } // STS
    }
    throw new M6809Error(`illegal opcode 10 ${hex2(op)} at ${hex4(this.lastPc)}`);
  }

  page3(op) {
    if (op === 0x3f) { this.cc |= E; this.pushAll(); this.pc = this.r16(0xfff2); return 20; } // SWI3
    const lo = op & 15, mode = (op >> 4) & 3;
    if (op < 0xc0 && (lo === 0x3 || lo === 0xc)) {
      let ea = 0;
      if (mode !== 0) ea = this.ea(mode);
      const v = mode === 0 ? this.imm16() : this.r16(ea);
      this.sub16(lo === 3 ? this.u : this.s, v);
      return [5, 7, 7, 8][mode];
    }
    throw new M6809Error(`illegal opcode 11 ${hex2(op)} at ${hex4(this.lastPc)}`);
  }

  /** Register dump for error messages. */
  state() {
    return `PC=${hex4(this.pc)} A=${hex2(this.a)} B=${hex2(this.b)} X=${hex4(this.x)} Y=${hex4(this.y)} U=${hex4(this.u)} S=${hex4(this.s)} DP=${hex2(this.dp)} CC=${hex2(this.cc)}`;
  }
}

const sx8 = (v) => (v & 0x80 ? v - 256 : v);
export const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
