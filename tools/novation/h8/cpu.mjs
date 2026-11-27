// Hitachi H8/300H CPU core (advanced mode, 24-bit addresses) for running Novation's own operating
// systems (SuperNova, Nova, SuperNova II, Nova II: all H8/3002-based). Written from the H8/300H
// programming manual; checked by booting the OS images (tools/novation/h8/machine.mjs).
//
// const cpu = new H8(bus)   bus: { r8(a), w8(a, v) } (24-bit addresses; words are big-endian)
// cpu.reset(); cpu.step() -> cycles (approximate); cpu.interrupt(vector) -> true when accepted.

const C = 1, V = 2, Z = 4, N = 8, H = 32, UI = 64, I = 128;
const MASK = [0xff, 0xffff, 0xffffffff];
const MSB = [0x80, 0x8000, 0x80000000];

export class H8Error extends Error {}

export class H8 {
  constructor(bus) {
    this.bus = bus;
    this.r = new Uint32Array(8);
    this.pc = 0;
    this.ccr = I;
    this.sleeping = false;
    this.ue = true; // SYSCR UE (set by the machine): false = UI masks priority-1 interrupts
    this.lastPc = 0;
  }

  // ---------------------------------------------------------------- memory
  r8(a) { return this.bus.r8(a & 0xffffff); }
  w8(a, v) { this.bus.w8(a & 0xffffff, v & 0xff); }
  r16(a) { a &= 0xfffffe; return (this.bus.r8(a) << 8) | this.bus.r8(a + 1); }
  w16(a, v) { a &= 0xfffffe; this.bus.w8(a, (v >> 8) & 0xff); this.bus.w8(a + 1, v & 0xff); }
  r32(a) { a &= 0xfffffe; return ((this.r16(a) << 16) | this.r16(a + 2)) >>> 0; }
  w32(a, v) { a &= 0xfffffe; this.w16(a, v >>> 16); this.w16(a + 2, v & 0xffff); }
  rd(a, sz) { return sz === 0 ? this.r8(a) : sz === 1 ? this.r16(a) : this.r32(a); }
  wr(a, v, sz) { if (sz === 0) this.w8(a, v); else if (sz === 1) this.w16(a, v); else this.w32(a, v); }
  fetch16() { const v = this.r16(this.pc); this.pc = (this.pc + 2) & 0xffffff; return v; }

  // ---------------------------------------------------------------- registers
  getB(i) { return i < 8 ? (this.r[i] >>> 8) & 0xff : this.r[i - 8] & 0xff; }
  setB(i, v) { if (i < 8) this.r[i] = (this.r[i] & 0xffff00ff) | ((v & 0xff) << 8); else this.r[i - 8] = (this.r[i - 8] & 0xffffff00) | (v & 0xff); }
  getW(i) { return i < 8 ? this.r[i] & 0xffff : this.r[i - 8] >>> 16; }
  setW(i, v) { if (i < 8) this.r[i] = (this.r[i] & 0xffff0000) | (v & 0xffff); else this.r[i - 8] = ((v & 0xffff) << 16) | (this.r[i - 8] & 0xffff); }
  getL(i) { return this.r[i & 7]; }
  setL(i, v) { this.r[i & 7] = v >>> 0; }
  get(i, sz) { return sz === 0 ? this.getB(i) : sz === 1 ? this.getW(i) : this.r[i & 7]; }
  set(i, v, sz) { if (sz === 0) this.setB(i, v); else if (sz === 1) this.setW(i, v); else this.r[i & 7] = v >>> 0; }
  get sp() { return this.r[7]; }
  set sp(v) { this.r[7] = v >>> 0; }

  // ---------------------------------------------------------------- flags
  flag(f, on) { if (on) this.ccr |= f; else this.ccr &= ~f; }
  nz(v, sz) { this.flag(N, v & MSB[sz]); this.flag(Z, (v & MASK[sz]) === 0); }
  logic(v, sz) { v = (v & MASK[sz]) >>> 0; this.nz(v, sz); this.ccr &= ~V; return v; }
  add(a, b, sz, cin = 0, keepZ = false) {
    const m = MASK[sz], s = MSB[sz], hm = sz === 0 ? 0xf : sz === 1 ? 0xfff : 0xfffffff;
    const full = a + b + cin;
    const r = (full % 0x100000000) >>> 0 & m;
    const rr = sz === 2 ? (full % 0x100000000) >>> 0 : r;
    this.flag(H, (a & hm) + (b & hm) + cin > hm);
    this.flag(C, full > m);
    this.flag(V, ((a ^ rr) & (b ^ rr) & s) !== 0);
    this.flag(N, rr & s);
    if (keepZ) { if (rr !== 0) this.ccr &= ~Z; } else this.flag(Z, rr === 0);
    return rr >>> 0;
  }
  sub(a, b, sz, bin = 0, keepZ = false) {
    const m = MASK[sz], s = MSB[sz], hm = sz === 0 ? 0xf : sz === 1 ? 0xfff : 0xfffffff;
    let rr = a - b - bin;
    const borrow = rr < 0;
    rr = sz === 2 ? (rr >>> 0) : (rr & m);
    this.flag(H, (a & hm) < (b & hm) + bin);
    this.flag(C, borrow);
    this.flag(V, ((a ^ b) & (a ^ rr) & s) !== 0);
    this.flag(N, rr & s);
    if (keepZ) { if (rr !== 0) this.ccr &= ~Z; } else this.flag(Z, rr === 0);
    return rr >>> 0;
  }
  cond(c) {
    const f = this.ccr, cy = f & C, z = f & Z, n = !!(f & N), v = !!(f & V);
    switch (c) {
      case 0: return true; case 1: return false;
      case 2: return !(cy || z); case 3: return !!(cy || z);
      case 4: return !cy; case 5: return !!cy;
      case 6: return !z; case 7: return !!z;
      case 8: return !v; case 9: return v;
      case 10: return !n; case 11: return n;
      case 12: return n === v; case 13: return n !== v;
      case 14: return !z && n === v; default: return !!z || n !== v;
    }
  }

  // ---------------------------------------------------------------- control
  reset() {
    this.pc = this.r32(0) & 0xffffff;
    this.ccr = I;
    this.sleeping = false;
  }
  push32(v) { this.sp = this.sp - 4; this.w32(this.sp, v); }
  pop32() { const v = this.r32(this.sp); this.sp = this.sp + 4; return v; }
  /** Take an exception through vector n (interrupt or TRAPA). */
  exception(n) {
    this.push32(((this.ccr << 24) | this.pc) >>> 0);
    this.ccr |= I;
    if (!this.ue) this.ccr |= UI;
    this.pc = this.r32(n * 4) & 0xffffff;
    this.sleeping = false;
  }
  /** Request interrupt vector n with priority level (0/1); returns true when taken. */
  interrupt(n, prio = 0) {
    const f = this.ccr;
    const ok = this.ue ? !(f & I) : prio ? !((f & I) && (f & UI)) : !(f & I);
    if (!ok) return false;
    this.exception(n);
    return true;
  }

  // ---------------------------------------------------------------- bit operations
  bitop(kind, bit, val) {
    const m = 1 << (bit & 7), b = (val & m) !== 0, c = (this.ccr & C) !== 0;
    switch (kind) {
      case 'bset': return val | m;
      case 'bclr': return val & ~m;
      case 'bnot': return val ^ m;
      case 'btst': this.flag(Z, !b); return null;
      case 'bld': this.flag(C, b); return null;
      case 'bild': this.flag(C, !b); return null;
      case 'bst': return c ? val | m : val & ~m;
      case 'bist': return c ? val & ~m : val | m;
      case 'band': this.flag(C, c && b); return null;
      case 'biand': this.flag(C, c && !b); return null;
      case 'bor': this.flag(C, c || b); return null;
      case 'bior': this.flag(C, c || !b); return null;
      case 'bxor': this.flag(C, c !== b); return null;
      case 'bixor': this.flag(C, c === !b); return null;
      default: throw new H8Error(`bitop ${kind}`);
    }
  }
  /** Bit instruction on memory: second word y:z of 7C/7D/7E/7F. */
  bitMem(addr, y, z, write) {
    let kind, bit;
    const inv = (z & 0x80) !== 0;
    switch (y) {
      case 0x60: kind = 'bset'; bit = this.getB(z >> 4); break;
      case 0x61: kind = 'bnot'; bit = this.getB(z >> 4); break;
      case 0x62: kind = 'bclr'; bit = this.getB(z >> 4); break;
      case 0x63: kind = 'btst'; bit = this.getB(z >> 4); break;
      case 0x67: kind = inv ? 'bist' : 'bst'; bit = z >> 4; break;
      case 0x70: kind = 'bset'; bit = z >> 4; break;
      case 0x71: kind = 'bnot'; bit = z >> 4; break;
      case 0x72: kind = 'bclr'; bit = z >> 4; break;
      case 0x73: kind = 'btst'; bit = z >> 4; break;
      case 0x74: kind = inv ? 'bior' : 'bor'; bit = z >> 4; break;
      case 0x75: kind = inv ? 'bixor' : 'bxor'; bit = z >> 4; break;
      case 0x76: kind = inv ? 'biand' : 'band'; bit = z >> 4; break;
      case 0x77: kind = inv ? 'bild' : 'bld'; bit = z >> 4; break;
      default: throw new H8Error(`bit op ${y.toString(16)} at ${this.lastPc.toString(16)}`);
    }
    const v = this.r8(addr);
    const nv = this.bitop(kind, bit, v);
    if (nv !== null && write) this.w8(addr, nv);
  }

  shift(op, sub, v, sz) {
    const m = MASK[sz], s = MSB[sz];
    const top = sz === 2 ? 31 : sz === 1 ? 15 : 7;
    let r, c;
    const arith = sub >= 8;
    switch (op) {
      case 0x10: // shll / shal
        c = (v & s) !== 0; r = (v * 2) % (m + 1);
        this.flag(V, arith ? ((v ^ r) & s) !== 0 : false); break;
      case 0x11: // shlr / shar
        c = (v & 1) !== 0; r = arith ? (v >>> 1) | (v & s) : v >>> 1; this.ccr &= ~V; break;
      case 0x12: // rotxl / rotl
        c = (v & s) !== 0; r = ((v * 2) % (m + 1)) | (arith ? (c ? 1 : 0) : (this.ccr & C ? 1 : 0)); this.ccr &= ~V; break;
      default: // rotxr / rotr
        c = (v & 1) !== 0; r = (v >>> 1) | ((arith ? c : (this.ccr & C)) ? s : 0); this.ccr &= ~V; break;
    }
    r = sz === 2 ? r >>> 0 : r & m;
    this.flag(C, c);
    this.nz(r, sz);
    return r;
  }

  // ---------------------------------------------------------------- execution
  step() {
    const pc0 = this.pc;
    this.lastPc = pc0;
    const w0 = this.fetch16();
    const op = w0 >> 8, x = w0 & 0xff, hi = x >> 4, lo = x & 15;
    switch (op >> 4) {
      case 0x2: this.setB(op & 15, this.logic(this.r8(0xffff00 | x), 0)); return 4;
      case 0x3: { const v = this.getB(op & 15); this.w8(0xffff00 | x, v); this.logic(v, 0); return 4; }
      case 0x4: if (this.cond(op & 15)) this.pc = (this.pc + ((x << 24) >> 24)) & 0xffffff; return 4;
      case 0x8: this.setB(op & 15, this.add(this.getB(op & 15), x, 0)); return 2;
      case 0x9: this.setB(op & 15, this.add(this.getB(op & 15), x, 0, this.ccr & C, true)); return 2;
      case 0xa: this.sub(this.getB(op & 15), x, 0); return 2;
      case 0xb: this.setB(op & 15, this.sub(this.getB(op & 15), x, 0, this.ccr & C, true)); return 2;
      case 0xc: this.setB(op & 15, this.logic(this.getB(op & 15) | x, 0)); return 2;
      case 0xd: this.setB(op & 15, this.logic(this.getB(op & 15) ^ x, 0)); return 2;
      case 0xe: this.setB(op & 15, this.logic(this.getB(op & 15) & x, 0)); return 2;
      case 0xf: this.setB(op & 15, this.logic(x, 0)); return 2;
      default: break;
    }
    switch (op) {
      case 0x00: return 2; // nop
      case 0x01: return this.op01(x);
      case 0x02: this.setB(lo, this.ccr); return 2;
      case 0x03: this.ccr = this.getB(lo); return 2;
      case 0x04: this.ccr |= x; return 2;
      case 0x05: this.ccr ^= x; return 2;
      case 0x06: this.ccr &= x; return 2;
      case 0x07: this.ccr = x; return 2;
      case 0x08: this.setB(lo, this.add(this.getB(hi), this.getB(lo), 0)); return 2;
      case 0x09: this.setW(lo, this.add(this.getW(hi), this.getW(lo), 1)); return 2;
      case 0x0a:
        if (hi === 0) { const a = this.getB(lo), r = (a + 1) & 0xff; this.nz(r, 0); this.flag(V, a === 0x7f); this.setB(lo, r); return 2; }
        this.setL(lo, this.add(this.getL(hi), this.getL(lo), 2)); return 2;
      case 0x0b: case 0x1b: {
        const dec = op === 0x1b;
        if (hi === 0 || hi === 8 || hi === 9) { const n = hi === 0 ? 1 : hi === 8 ? 2 : 4; this.setL(lo, this.getL(lo) + (dec ? -n : n)); return 2; }
        const n = hi & 8 ? 2 : 1, sz = (hi & 7) === 5 ? 1 : 2;
        const a = this.get(lo, sz), r = sz === 1 ? (a + (dec ? -n : n)) & 0xffff : (a + (dec ? -n : n)) >>> 0;
        this.nz(r, sz);
        this.flag(V, dec ? ((a & ~r) & MSB[sz]) !== 0 : ((~a & r) & MSB[sz]) !== 0);
        this.set(lo, r, sz); return 2;
      }
      case 0x0c: this.setB(lo, this.logic(this.getB(hi), 0)); return 2;
      case 0x0d: this.setW(lo, this.logic(this.getW(hi), 1)); return 2;
      case 0x0e: this.setB(lo, this.add(this.getB(hi), this.getB(lo), 0, this.ccr & C, true)); return 2;
      case 0x0f:
        if (hi === 0) { this.setB(lo, this.daa(this.getB(lo), false)); return 2; }
        this.setL(lo, this.logic(this.getL(hi), 2)); return 2;
      case 0x10: case 0x11: case 0x12: case 0x13: {
        const szc = hi & 7, sz = szc === 0 ? 0 : szc === 1 ? 1 : 2;
        if (szc !== 0 && szc !== 1 && szc !== 3) throw new H8Error(`shift ${w0.toString(16)} at ${pc0.toString(16)}`);
        this.set(lo, this.shift(op, hi, this.get(lo, sz), sz), sz); return 2;
      }
      case 0x14: this.setB(lo, this.logic(this.getB(hi) | this.getB(lo), 0)); return 2;
      case 0x15: this.setB(lo, this.logic(this.getB(hi) ^ this.getB(lo), 0)); return 2;
      case 0x16: this.setB(lo, this.logic(this.getB(hi) & this.getB(lo), 0)); return 2;
      case 0x17: return this.op17(hi, lo, w0, pc0);
      case 0x18: this.setB(lo, this.sub(this.getB(lo), this.getB(hi), 0)); return 2;
      case 0x19: this.setW(lo, this.sub(this.getW(lo), this.getW(hi), 1)); return 2;
      case 0x1a:
        if (hi === 0) { const a = this.getB(lo), r = (a - 1) & 0xff; this.nz(r, 0); this.flag(V, a === 0x80); this.setB(lo, r); return 2; }
        this.setL(lo, this.sub(this.getL(lo), this.getL(hi), 2)); return 2;
      case 0x1c: this.sub(this.getB(lo), this.getB(hi), 0); return 2;
      case 0x1d: this.sub(this.getW(lo), this.getW(hi), 1); return 2;
      case 0x1e: this.setB(lo, this.sub(this.getB(lo), this.getB(hi), 0, this.ccr & C, true)); return 2;
      case 0x1f:
        if (hi === 0) { this.setB(lo, this.daa(this.getB(lo), true)); return 2; }
        this.sub(this.getL(lo), this.getL(hi), 2); return 2;
      case 0x50: this.setW(lo, (this.getW(lo) & 0xff) * this.getB(hi)); return 14;
      case 0x52: this.setL(lo, ((this.getL(lo) & 0xffff) * this.getW(hi)) >>> 0); return 22;
      case 0x51: { // divxu.b Rs,Rd
        const d = this.getB(hi), a = this.getW(lo);
        this.flag(N, d & 0x80); this.flag(Z, d === 0);
        if (d) { const q = Math.floor(a / d), rem = a % d; this.setW(lo, ((rem & 0xff) << 8) | (q & 0xff)); }
        return 14;
      }
      case 0x53: { // divxu.w Rs,ERd
        const d = this.getW(hi), a = this.getL(lo);
        this.flag(N, d & 0x8000); this.flag(Z, d === 0);
        if (d) { const q = Math.floor(a / d), rem = a % d; this.setL(lo, (((rem & 0xffff) << 16) | (q & 0xffff)) >>> 0); }
        return 22;
      }
      case 0x54: this.pc = this.pop32() & 0xffffff; return 10;
      case 0x55: this.push32(this.pc); this.pc = (this.pc + ((x << 24) >> 24)) & 0xffffff; return 10;
      case 0x56: { const v = this.pop32(); this.ccr = v >>> 24; this.pc = v & 0xffffff; return 10; }
      case 0x57: this.exception(8 + ((x >> 4) & 3)); return 14;
      case 0x58: { const d = (this.fetch16() << 16) >> 16; if (this.cond(hi)) this.pc = (this.pc + d) & 0xffffff; return 6; }
      case 0x59: this.pc = this.getL(hi) & 0xffffff; return 4;
      case 0x5a: { const lo16 = this.fetch16(); this.pc = ((x << 16) | lo16) & 0xffffff; return 6; }
      case 0x5b: this.pc = this.r32(x) & 0xffffff; return 10;
      case 0x5c: { const d = (this.fetch16() << 16) >> 16; this.push32(this.pc); this.pc = (this.pc + d) & 0xffffff; return 12; }
      case 0x5d: this.push32(this.pc); this.pc = this.getL(hi) & 0xffffff; return 10;
      case 0x5e: { const lo16 = this.fetch16(); this.push32(this.pc); this.pc = ((x << 16) | lo16) & 0xffffff; return 12; }
      case 0x5f: { const t = this.r32(x) & 0xffffff; this.push32(this.pc); this.pc = t; return 14; }
      case 0x60: case 0x61: case 0x62: case 0x63: {
        const nv = this.bitop(['bset', 'bnot', 'bclr', 'btst'][op - 0x60], this.getB(hi), this.getB(lo));
        if (nv !== null) this.setB(lo, nv); return 2;
      }
      case 0x64: this.setW(lo, this.logic(this.getW(hi) | this.getW(lo), 1)); return 2;
      case 0x65: this.setW(lo, this.logic(this.getW(hi) ^ this.getW(lo), 1)); return 2;
      case 0x66: this.setW(lo, this.logic(this.getW(hi) & this.getW(lo), 1)); return 2;
      case 0x67: this.setB(lo, this.bitop(hi & 8 ? 'bist' : 'bst', hi & 7, this.getB(lo))); return 2;
      case 0x68: case 0x69: { // @ERn
        const sz = op === 0x68 ? 0 : 1, a = this.getL(hi & 7);
        if (hi & 8) { const v = this.get(lo, sz); this.wr(a, v, sz); this.logic(v, sz); } else this.set(lo, this.logic(this.rd(a, sz), sz), sz);
        return 4;
      }
      case 0x6a: case 0x6b: { // @aa:16 / @aa:24
        const sz = op === 0x6a ? 0 : 1;
        let a;
        if ((hi & 7) === 0) { const aa = this.fetch16(); a = aa & 0x8000 ? 0xff0000 | aa : aa; } else if ((hi & 7) === 2) { a = ((this.fetch16() << 16) | this.fetch16()) & 0xffffff; } else throw new H8Error(`movfpe/movtpe ${w0.toString(16)} at ${pc0.toString(16)}`);
        if (hi & 8) { const v = this.get(lo, sz); this.wr(a, v, sz); this.logic(v, sz); } else this.set(lo, this.logic(this.rd(a, sz), sz), sz);
        return 6;
      }
      case 0x6c: case 0x6d: { // @ERn+ / @-ERn
        const sz = op === 0x6c ? 0 : 1, n = sz + 1, er = hi & 7;
        if (hi & 8) { const a = (this.getL(er) - n) >>> 0; this.setL(er, a); const v = this.get(lo, sz); this.wr(a, v, sz); this.logic(v, sz); } else { const a = this.getL(er); const v = this.rd(a, sz); this.setL(er, a + n); this.set(lo, this.logic(v, sz), sz); }
        return 6;
      }
      case 0x6e: case 0x6f: { // @(d:16,ERn)
        const sz = op === 0x6e ? 0 : 1, d = (this.fetch16() << 16) >> 16, a = (this.getL(hi & 7) + d) >>> 0;
        if (hi & 8) { const v = this.get(lo, sz); this.wr(a, v, sz); this.logic(v, sz); } else this.set(lo, this.logic(this.rd(a, sz), sz), sz);
        return 6;
      }
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77: {
        const kinds = [['bset', 'bset'], ['bnot', 'bnot'], ['bclr', 'bclr'], ['btst', 'btst'], ['bor', 'bior'], ['bxor', 'bixor'], ['band', 'biand'], ['bld', 'bild']];
        const nv = this.bitop(kinds[op - 0x70][hi >> 3], hi & 7, this.getB(lo));
        if (nv !== null) this.setB(lo, nv); return 2;
      }
      case 0x78: { // @(d:24,ERn)
        const w1 = this.fetch16(), w2 = this.fetch16(), w3 = this.fetch16();
        const z = w1 & 0xff, sz = (w1 >> 8) === 0x6a ? 0 : 1, d = (((w2 & 0xff) << 16) | w3) << 8 >> 8;
        const a = (this.getL(hi & 7) + d) >>> 0;
        if ((z >> 4) === 0xa) { const v = this.get(z & 15, sz); this.wr(a, v, sz); this.logic(v, sz); } else this.set(z & 15, this.logic(this.rd(a, sz), sz), sz);
        return 8;
      }
      case 0x79: case 0x7a: {
        const sz = op === 0x79 ? 1 : 2;
        const imm = sz === 1 ? this.fetch16() : ((this.fetch16() << 16) | this.fetch16()) >>> 0;
        const rd = sz === 1 ? lo : lo & 7, a = this.get(rd, sz);
        switch (hi) {
          case 0: this.set(rd, this.logic(imm, sz), sz); break;
          case 1: this.set(rd, this.add(a, imm, sz), sz); break;
          case 2: this.sub(a, imm, sz); break;
          case 3: this.set(rd, this.sub(a, imm, sz), sz); break;
          case 4: this.set(rd, this.logic(a | imm, sz), sz); break;
          case 5: this.set(rd, this.logic(a ^ imm, sz), sz); break;
          case 6: this.set(rd, this.logic(a & imm, sz), sz); break;
          default: throw new H8Error(`${w0.toString(16)} at ${pc0.toString(16)}`);
        }
        return sz === 1 ? 4 : 6;
      }
      case 0x7b: { // eepmov
        this.fetch16();
        const word = x === 0xd4;
        let n = word ? this.getW(4) : this.getB(12);
        let cyc = 8;
        while (n) {
          this.w8(this.getL(6), this.r8(this.getL(5)));
          this.setL(5, this.getL(5) + 1); this.setL(6, this.getL(6) + 1);
          n--; cyc += 4;
        }
        if (word) this.setW(4, 0); else this.setB(12, 0);
        return cyc;
      }
      case 0x7c: case 0x7d: { const w1 = this.fetch16(); this.bitMem(this.getL(hi & 7), w1 >> 8, w1 & 0xff, op === 0x7d); return 6; }
      case 0x7e: case 0x7f: { const w1 = this.fetch16(); this.bitMem(0xffff00 | x, w1 >> 8, w1 & 0xff, op === 0x7f); return 6; }
      default: throw new H8Error(`opcode ${w0.toString(16).padStart(4, '0')} at ${pc0.toString(16)}`);
    }
  }

  daa(v, sub) {
    const c = (this.ccr & C) !== 0, h = (this.ccr & H) !== 0;
    let adj = 0, cy = c;
    if (!sub) {
      if (h || (v & 0xf) > 9) adj |= 0x06;
      if (c || v > 0x99) { adj |= 0x60; cy = true; }
      v = (v + adj) & 0xff;
    } else {
      if (h) adj |= 0x06;
      if (c) adj |= 0x60;
      v = (v - adj) & 0xff;
    }
    this.flag(C, cy); this.nz(v, 0);
    return v;
  }

  op17(hi, lo, w0, pc0) {
    switch (hi) {
      case 0x0: this.setB(lo, this.logic(~this.getB(lo), 0)); return 2;
      case 0x1: this.setW(lo, this.logic(~this.getW(lo), 1)); return 2;
      case 0x3: this.setL(lo, this.logic(~this.getL(lo), 2)); return 2;
      case 0x5: this.setW(lo, this.logic(this.getW(lo) & 0xff, 1)); return 2;
      case 0x7: this.setL(lo, this.logic(this.getL(lo) & 0xffff, 2)); return 2;
      case 0x8: this.setB(lo, this.sub(0, this.getB(lo), 0)); return 2;
      case 0x9: this.setW(lo, this.sub(0, this.getW(lo), 1)); return 2;
      case 0xb: this.setL(lo, this.sub(0, this.getL(lo), 2)); return 2;
      case 0xd: { const v = this.getW(lo) & 0xff; this.setW(lo, this.logic(v & 0x80 ? v | 0xff00 : v, 1)); return 2; }
      case 0xf: { const v = this.getL(lo) & 0xffff; this.setL(lo, this.logic(v & 0x8000 ? (v | 0xffff0000) >>> 0 : v, 2)); return 2; }
      default: throw new H8Error(`${w0.toString(16)} at ${pc0.toString(16)}`);
    }
  }

  op01(x) {
    const pc0 = this.lastPc;
    if (x === 0x00) { // mov.l memory forms
      const w1 = this.fetch16(), sub = w1 >> 8, y = w1 & 0xff;
      switch (sub) {
        case 0x69: { const a = this.getL((y >> 4) & 7); if (y & 0x80) { const v = this.getL(y & 7); this.w32(a, v); this.logic(v, 2); } else this.setL(y & 7, this.logic(this.r32(a), 2)); return 8; }
        case 0x6b: {
          const k = y >> 4;
          let a;
          if ((k & 7) === 0) { const aa = this.fetch16(); a = aa & 0x8000 ? 0xff0000 | aa : aa; } else { a = ((this.fetch16() << 16) | this.fetch16()) & 0xffffff; }
          if (k & 8) { const v = this.getL(y & 7); this.w32(a, v); this.logic(v, 2); } else this.setL(y & 7, this.logic(this.r32(a), 2));
          return 10;
        }
        case 0x6d: {
          const er = (y >> 4) & 7;
          if (y & 0x80) { const a = (this.getL(er) - 4) >>> 0; this.setL(er, a); const v = this.getL(y & 7); this.w32(a, v); this.logic(v, 2); } else { const a = this.getL(er); const v = this.r32(a); this.setL(er, a + 4); this.setL(y & 7, this.logic(v, 2)); }
          return 10;
        }
        case 0x6f: { const d = (this.fetch16() << 16) >> 16, a = (this.getL((y >> 4) & 7) + d) >>> 0; if (y & 0x80) { const v = this.getL(y & 7); this.w32(a, v); this.logic(v, 2); } else this.setL(y & 7, this.logic(this.r32(a), 2)); return 10; }
        case 0x78: {
          const w2 = this.fetch16(), w3 = this.fetch16(), w4 = this.fetch16();
          const z = w2 & 0xff, d = (((w3 & 0xff) << 16) | w4) << 8 >> 8, a = (this.getL((y >> 4) & 7) + d) >>> 0;
          if ((z >> 4) === 0xa) { const v = this.getL(z & 7); this.w32(a, v); this.logic(v, 2); } else this.setL(z & 7, this.logic(this.r32(a), 2));
          return 12;
        }
        default: throw new H8Error(`0100${w1.toString(16)} at ${pc0.toString(16)}`);
      }
    }
    if (x === 0x40) { // ldc/stc ccr with memory (word access, CCR in the even byte)
      const w1 = this.fetch16(), sub = w1 >> 8, y = w1 & 0xff, st = (y & 0x80) !== 0, er = (y >> 4) & 7;
      let a;
      switch (sub) {
        case 0x69: a = this.getL(er); break;
        case 0x6d: if (st) { a = (this.getL(er) - 2) >>> 0; this.setL(er, a); } else { a = this.getL(er); this.setL(er, a + 2); } break;
        case 0x6f: a = (this.getL(er) + ((this.fetch16() << 16) >> 16)) >>> 0; break;
        case 0x6b: if ((y & 0x70) === 0) { const aa = this.fetch16(); a = aa & 0x8000 ? 0xff0000 | aa : aa; } else a = ((this.fetch16() << 16) | this.fetch16()) & 0xffffff; break;
        case 0x78: { const w2 = this.fetch16(), w3 = this.fetch16(), w4 = this.fetch16(); a = (this.getL(er) + ((((w3 & 0xff) << 16) | w4) << 8 >> 8)) >>> 0; if ((w2 & 0xff) >> 4 === 0xa) { this.w16(a, this.ccr << 8); } else this.ccr = this.r16(a) >> 8; return 10; }
        default: throw new H8Error(`0140${w1.toString(16)} at ${pc0.toString(16)}`);
      }
      if (sub === 0x6b ? (y & 0x80) !== 0 : st) this.w16(a, this.ccr << 8); else this.ccr = this.r16(a) >> 8;
      return 8;
    }
    if (x === 0x80) { this.sleeping = true; return 2; }
    if (x === 0xc0) { // mulxs
      const w1 = this.fetch16(), sub = w1 >> 8, y = w1 & 0xff;
      if (sub === 0x50) { const a = (this.getB(y >> 4) << 24) >> 24, b = ((this.getW(y & 15) & 0xff) << 24) >> 24, r = (a * b) & 0xffff; this.setW(y & 15, r); this.nz(r, 1); return 16; }
      const a = (this.getW(y >> 4) << 16) >> 16, b = ((this.getL(y & 7) & 0xffff) << 16) >> 16, r = (a * b) >>> 0; this.setL(y & 7, r); this.nz(r, 2); return 24;
    }
    if (x === 0xd0) { // divxs
      const w1 = this.fetch16(), sub = w1 >> 8, y = w1 & 0xff;
      if (sub === 0x51) {
        const d = (this.getB(y >> 4) << 24) >> 24, a = (this.getW(y & 15) << 16) >> 16;
        this.flag(Z, d === 0);
        if (d) { const q = Math.trunc(a / d), rem = a - q * d; this.setW(y & 15, ((rem & 0xff) << 8) | (q & 0xff)); this.flag(N, q < 0); }
        return 16;
      }
      const d = (this.getW(y >> 4) << 16) >> 16, a = this.getL(y & 7) | 0;
      this.flag(Z, d === 0);
      if (d) { const q = Math.trunc(a / d), rem = a - q * d; this.setL(y & 7, (((rem & 0xffff) << 16) | (q & 0xffff)) >>> 0); this.flag(N, q < 0); }
      return 24;
    }
    if (x === 0xf0) { // or/xor/and.l ERs,ERd
      const w1 = this.fetch16(), sub = w1 >> 8, y = w1 & 0xff, s = this.getL(y >> 4), d = this.getL(y & 7);
      const r = sub === 0x64 ? s | d : sub === 0x65 ? s ^ d : sub === 0x66 ? s & d : null;
      if (r === null) throw new H8Error(`01f0${w1.toString(16)} at ${pc0.toString(16)}`);
      this.setL(y & 7, this.logic(r >>> 0, 2));
      return 4;
    }
    throw new H8Error(`opcode 01${x.toString(16).padStart(2, '0')} at ${pc0.toString(16)}`);
  }
}
