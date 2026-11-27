# Minimal 8051 disassembler and emulator for firmware analysis (effects units).
# Usage as a module: dis(code, addr) -> (text, length, targets); Cpu(code) for emulation.
# Command line: python -I i8051.py <image> <start hex> <end hex>   (linear disassembly)

import sys

REGS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']
SFR = {0x80: 'P0', 0x81: 'SP', 0x82: 'DPL', 0x83: 'DPH', 0x87: 'PCON', 0x88: 'TCON', 0x89: 'TMOD', 0x8a: 'TL0',
       0x8b: 'TL1', 0x8c: 'TH0', 0x8d: 'TH1', 0x90: 'P1', 0x98: 'SCON', 0x99: 'SBUF', 0xa0: 'P2', 0xa8: 'IE',
       0xb0: 'P3', 0xb8: 'IP', 0xd0: 'PSW', 0xe0: 'ACC', 0xf0: 'B'}


def dname(a):
    return SFR.get(a, '%02xh' % a)


def bname(b):
    if b < 0x80:
        return '%02x.%d' % (0x20 + (b >> 3), b & 7)
    return '%s.%d' % (dname(b & 0xf8), b & 7)


def dis(c, pc):
    """Disassemble one instruction. Returns (text, length, [jump targets], falls_through)."""
    op = c[pc]
    b1 = c[(pc + 1) & 0xffff]
    b2 = c[(pc + 2) & 0xffff]
    rel = lambda x, n: (pc + n + (x - 256 if x > 127 else x)) & 0xffff
    lo = op & 0x0f
    hi = op >> 4
    # register / indirect forms
    if lo >= 8 or lo in (6, 7):
        r = REGS[lo - 8] if lo >= 8 else '@R%d' % (lo - 6)
        tbl = {0x0: ('INC %s', 1), 0x1: ('DEC %s', 1), 0x2: ('ADD A,%s', 1), 0x3: ('ADDC A,%s', 1), 0x4: ('ORL A,%s', 1),
               0x5: ('ANL A,%s', 1), 0x6: ('XRL A,%s', 1), 0x7: ('MOV %s,#%02xh', 2), 0x8: ('MOV %s,%s', 2),
               0x9: ('SUBB A,%s', 1), 0xa: ('MOV %s,%s', 2), 0xb: ('CJNE %s,#%02xh,%04x', 3), 0xc: ('XCH A,%s', 1),
               0xd: ('DJNZ %s,%04x', 2) if lo >= 8 else ('XCHD A,%s', 1), 0xe: ('MOV A,%s', 1), 0xf: ('MOV %s,A', 1)}
        f, n = tbl[hi]
        if hi == 0x7: return (f % (r, b1), 2, [], True)
        if hi == 0x8: return ('MOV %s,%s' % (dname(b1), r), 2, [], True)
        if hi == 0xa: return ('MOV %s,%s' % (r, dname(b1)), 2, [], True)
        if hi == 0xb: return (f % (r, b1, rel(b2, 3)), 3, [rel(b2, 3)], True)
        if hi == 0xd and lo >= 8: return (f % (r, rel(b1, 2)), 2, [rel(b1, 2)], True)
        return (f % r, n, [], True)
    if lo == 1:
        a11 = ((pc + 2) & 0xf800) | ((op & 0xe0) << 3) | b1
        if op & 0x10: return ('ACALL %04x' % a11, 2, [a11], True)
        return ('AJMP %04x' % a11, 2, [a11], False)
    T = {
        0x00: ('NOP', 1), 0x02: ('LJMP', 3), 0x03: ('RR A', 1), 0x04: ('INC A', 1), 0x05: ('INC d', 2),
        0x10: ('JBC', 3), 0x12: ('LCALL', 3), 0x13: ('RRC A', 1), 0x14: ('DEC A', 1), 0x15: ('DEC d', 2),
        0x20: ('JB', 3), 0x22: ('RET', 1), 0x23: ('RL A', 1), 0x24: ('ADD A,#', 2), 0x25: ('ADD A,d', 2),
        0x30: ('JNB', 3), 0x32: ('RETI', 1), 0x33: ('RLC A', 1), 0x34: ('ADDC A,#', 2), 0x35: ('ADDC A,d', 2),
        0x40: ('JC', 2), 0x42: ('ORL d,A', 2), 0x43: ('ORL d,#', 3), 0x44: ('ORL A,#', 2), 0x45: ('ORL A,d', 2),
        0x50: ('JNC', 2), 0x52: ('ANL d,A', 2), 0x53: ('ANL d,#', 3), 0x54: ('ANL A,#', 2), 0x55: ('ANL A,d', 2),
        0x60: ('JZ', 2), 0x62: ('XRL d,A', 2), 0x63: ('XRL d,#', 3), 0x64: ('XRL A,#', 2), 0x65: ('XRL A,d', 2),
        0x70: ('JNZ', 2), 0x72: ('ORL C,b', 2), 0x73: ('JMP @A+DPTR', 1), 0x74: ('MOV A,#', 2), 0x75: ('MOV d,#', 3),
        0x80: ('SJMP', 2), 0x82: ('ANL C,b', 2), 0x83: ('MOVC A,@A+PC', 1), 0x84: ('DIV AB', 1), 0x85: ('MOV d,d', 3),
        0x90: ('MOV DPTR,#', 3), 0x92: ('MOV b,C', 2), 0x93: ('MOVC A,@A+DPTR', 1), 0x94: ('SUBB A,#', 2), 0x95: ('SUBB A,d', 2),
        0xa0: ('ORL C,/b', 2), 0xa2: ('MOV C,b', 2), 0xa3: ('INC DPTR', 1), 0xa4: ('MUL AB', 1), 0xa5: ('???', 1),
        0xb0: ('ANL C,/b', 2), 0xb2: ('CPL b', 2), 0xb3: ('CPL C', 1), 0xb4: ('CJNE A,#', 3), 0xb5: ('CJNE A,d', 3),
        0xc0: ('PUSH', 2), 0xc2: ('CLR b', 2), 0xc3: ('CLR C', 1), 0xc4: ('SWAP A', 1), 0xc5: ('XCH A,d', 2),
        0xd0: ('POP', 2), 0xd2: ('SETB b', 2), 0xd3: ('SETB C', 1), 0xd4: ('DA A', 1), 0xd5: ('DJNZ d', 3),
        0xe0: ('MOVX A,@DPTR', 1), 0xe2: ('MOVX A,@R0', 1), 0xe3: ('MOVX A,@R1', 1), 0xe4: ('CLR A', 1), 0xe5: ('MOV A,d', 2),
        0xf0: ('MOVX @DPTR,A', 1), 0xf2: ('MOVX @R0,A', 1), 0xf3: ('MOVX @R1,A', 1), 0xf4: ('CPL A', 1), 0xf5: ('MOV d,A', 2),
    }
    m, n = T[op]
    if op == 0x02: t = (b1 << 8) | b2; return ('LJMP %04x' % t, 3, [t], False)
    if op == 0x12: t = (b1 << 8) | b2; return ('LCALL %04x' % t, 3, [t], True)
    if op in (0x10, 0x20, 0x30): t = rel(b2, 3); return ('%s %s,%04x' % (m, bname(b1), t), 3, [t], True)
    if op in (0x40, 0x50, 0x60, 0x70): t = rel(b1, 2); return ('%s %04x' % (m, t), 2, [t], True)
    if op == 0x80: t = rel(b1, 2); return ('SJMP %04x' % t, 2, [t], False)
    if op in (0x22, 0x32): return (m, 1, [], False)
    if op == 0x73: return (m, 1, [], False)
    if op == 0x90: return ('MOV DPTR,#%04xh' % ((b1 << 8) | b2), 3, [], True)
    if op == 0x75: return ('MOV %s,#%02xh' % (dname(b1), b2), 3, [], True)
    if op == 0x85: return ('MOV %s,%s' % (dname(b2), dname(b1)), 3, [], True)
    if op in (0x43, 0x53, 0x63): return ('%s %s,#%02xh' % (m.split()[0], dname(b1), b2), 3, [], True)
    if op == 0xb4: t = rel(b2, 3); return ('CJNE A,#%02xh,%04x' % (b1, t), 3, [t], True)
    if op == 0xb5: t = rel(b2, 3); return ('CJNE A,%s,%04x' % (dname(b1), t), 3, [t], True)
    if op == 0xd5: t = rel(b2, 3); return ('DJNZ %s,%04x' % (dname(b1), t), 3, [t], True)
    if m.endswith('#'): return ('%s%02xh' % (m, b1), 2, [], True)
    if m.endswith(',d') or m.endswith(' d'): return (m[:-1] + dname(b1), 2, [], True)
    if 'd,A' in m or 'd,#' in m: return (m.replace('d', dname(b1), 1), 2, [], True)
    if m in ('PUSH', 'POP'): return ('%s %s' % (m, dname(b1)), 2, [], True)
    if m.endswith('b') or m.endswith('/b'): return (m[:-1] + bname(b1), 2, [], True)
    if m == 'MOV b,C': return ('MOV %s,C' % bname(b1), 2, [], True)
    return (m, n, [], True)


def listing(c, start, end):
    pc = start
    out = []
    while pc < end:
        t, n, _, _ = dis(c, pc)
        out.append('%04x  %-9s %s' % (pc, c[pc:pc + n].hex(), t))
        pc += n
    return out


class Cpu:
    """Enough of an 8051 to run display and data routines: code, 256 bytes IRAM+SFR, 64K XRAM.
    MOVX @Ri uses P2 as the high byte. Hooks: {addr: fn(cpu)} called before executing addr;
    a hook returning True skips the instruction (acts as RET when hooked at a routine entry)."""

    def __init__(self, code):
        self.c = code
        self.ram = bytearray(256)   # 0-7f IRAM, 80-ff SFR (direct) ; upper IRAM via @Ri kept in iram_hi
        self.hi = bytearray(128)
        self.x = bytearray(65536)
        self.pc = 0
        self.ram[0x81] = 0x07
        self.hooks = {}
        self.steps = 0

    # --- registers
    @property
    def a(self): return self.ram[0xe0]
    @a.setter
    def a(self, v): self.ram[0xe0] = v & 0xff
    @property
    def b(self): return self.ram[0xf0]
    @b.setter
    def b(self, v): self.ram[0xf0] = v & 0xff
    @property
    def cy(self): return self.ram[0xd0] >> 7
    @cy.setter
    def cy(self, v): self.ram[0xd0] = (self.ram[0xd0] & 0x7f) | (0x80 if v else 0)
    @property
    def dptr(self): return (self.ram[0x83] << 8) | self.ram[0x82]
    @dptr.setter
    def dptr(self, v): self.ram[0x83] = (v >> 8) & 0xff; self.ram[0x82] = v & 0xff

    def rbase(self): return self.ram[0xd0] & 0x18
    def r(self, n): return self.ram[self.rbase() + n]
    def setr(self, n, v): self.ram[self.rbase() + n] = v & 0xff

    def ind(self, a):  # indirect IRAM
        return self.ram[a] if a < 0x80 else self.hi[a - 0x80]
    def setind(self, a, v):
        if a < 0x80: self.ram[a] = v & 0xff
        else: self.hi[a - 0x80] = v & 0xff

    def rd(self, a): return self.ram[a]
    def wr(self, a, v): self.ram[a] = v & 0xff

    def bit(self, b):
        a = (0x20 + (b >> 3)) if b < 0x80 else (b & 0xf8)
        return (self.ram[a] >> (b & 7)) & 1
    def setbit(self, b, v):
        a = (0x20 + (b >> 3)) if b < 0x80 else (b & 0xf8)
        m = 1 << (b & 7)
        self.ram[a] = (self.ram[a] | m) if v else (self.ram[a] & ~m & 0xff)

    def push(self, v):
        sp = (self.ram[0x81] + 1) & 0xff; self.ram[0x81] = sp; self.setind(sp, v)
    def pop(self):
        sp = self.ram[0x81]; v = self.ind(sp); self.ram[0x81] = (sp - 1) & 0xff; return v

    def xaddr_ri(self, i): return (self.ram[0xa0] << 8) | self.r(i)

    def flags_add(self, a, b, c=0):
        s = a + b + c
        self.cy = s > 0xff
        ac = ((a & 15) + (b & 15) + c) > 15
        ov = ((a ^ s) & (b ^ s) & 0x80) != 0
        self.ram[0xd0] = (self.ram[0xd0] & ~0x44 & 0xff) | (0x40 if ac else 0) | (0x04 if ov else 0)
        return s & 0xff

    def flags_sub(self, a, b, c):
        s = a - b - c
        self.cy = s < 0
        ac = ((a & 15) - (b & 15) - c) < 0
        ov = ((a ^ b) & (a ^ s) & 0x80) != 0
        self.ram[0xd0] = (self.ram[0xd0] & ~0x44 & 0xff) | (0x40 if ac else 0) | (0x04 if ov else 0)
        return s & 0xff

    def call(self, addr, ret=0xfffe, limit=200000):
        """Call a routine; returns when it returns to `ret`."""
        self.push(ret & 0xff); self.push(ret >> 8)
        self.pc = addr
        n = 0
        while self.pc != ret:
            self.step()
            n += 1
            if n > limit: raise RuntimeError('step limit at %04x' % self.pc)

    def step(self):
        pc = self.pc
        h = self.hooks.get(pc)
        if h and h(self):
            # hooked routine: return
            hi_ = self.pop(); lo_ = self.pop(); self.pc = (hi_ << 8) | lo_
            return
        c = self.c
        op = c[pc]
        b1 = c[(pc + 1) & 0xffff]
        b2 = c[(pc + 2) & 0xffff]
        _, n, _, _ = dis(c, pc)
        npc = (pc + n) & 0xffff
        rel = lambda x: (npc + (x - 256 if x > 127 else x)) & 0xffff
        lo = op & 15
        hi = op >> 4
        # operand fetch helpers for register/indirect forms
        if lo >= 6:
            if lo >= 8:
                get = lambda: self.r(lo - 8); put = lambda v: self.setr(lo - 8, v)
            else:
                ri = self.r(lo - 6)
                get = lambda: self.ind(ri); put = lambda v: self.setind(ri, v)
            if hi == 0: put(get() + 1)
            elif hi == 1: put(get() - 1)
            elif hi == 2: self.a = self.flags_add(self.a, get())
            elif hi == 3: self.a = self.flags_add(self.a, get(), self.cy)
            elif hi == 4: self.a = self.a | get()
            elif hi == 5: self.a = self.a & get()
            elif hi == 6: self.a = self.a ^ get()
            elif hi == 7: put(b1)
            elif hi == 8: self.wr(b1, get())
            elif hi == 9: self.a = self.flags_sub(self.a, get(), self.cy)
            elif hi == 0xa: put(self.rd(b1))
            elif hi == 0xb:
                v = get(); self.cy = v < b1
                if v != b1: npc = rel(b2)
            elif hi == 0xc: v = get(); put(self.a); self.a = v
            elif hi == 0xd:
                if lo >= 8:
                    v = (get() - 1) & 0xff; put(v)
                    if v: npc = rel(b1)
                else:
                    v = get(); put((v & 0xf0) | (self.a & 15)); self.a = (self.a & 0xf0) | (v & 15)
            elif hi == 0xe: self.a = get()
            elif hi == 0xf: put(self.a)
            self.pc = npc
            return
        if lo == 1:
            a11 = (npc & 0xf800) | ((op & 0xe0) << 3) | b1
            if op & 0x10: self.push(npc & 0xff); self.push(npc >> 8)
            self.pc = a11
            return
        A = self.a
        if op == 0x00: pass
        elif op == 0x02: npc = (b1 << 8) | b2
        elif op == 0x03: self.a = (A >> 1) | ((A & 1) << 7)
        elif op == 0x04: self.a = A + 1
        elif op == 0x05: self.wr(b1, self.rd(b1) + 1)
        elif op == 0x10:
            if self.bit(b1): self.setbit(b1, 0); npc = rel(b2)
        elif op == 0x12: self.push(npc & 0xff); self.push(npc >> 8); npc = (b1 << 8) | b2
        elif op == 0x13: c0 = self.cy; self.cy = A & 1; self.a = (A >> 1) | (c0 << 7)
        elif op == 0x14: self.a = A - 1
        elif op == 0x15: self.wr(b1, self.rd(b1) - 1)
        elif op == 0x20:
            if self.bit(b1): npc = rel(b2)
        elif op in (0x22, 0x32): h_ = self.pop(); l_ = self.pop(); npc = (h_ << 8) | l_
        elif op == 0x23: self.a = ((A << 1) | (A >> 7)) & 0xff
        elif op == 0x24: self.a = self.flags_add(A, b1)
        elif op == 0x25: self.a = self.flags_add(A, self.rd(b1))
        elif op == 0x30:
            if not self.bit(b1): npc = rel(b2)
        elif op == 0x33: c0 = self.cy; self.cy = A >> 7; self.a = ((A << 1) | c0) & 0xff
        elif op == 0x34: self.a = self.flags_add(A, b1, self.cy)
        elif op == 0x35: self.a = self.flags_add(A, self.rd(b1), self.cy)
        elif op == 0x40:
            if self.cy: npc = rel(b1)
        elif op == 0x42: self.wr(b1, self.rd(b1) | A)
        elif op == 0x43: self.wr(b1, self.rd(b1) | b2)
        elif op == 0x44: self.a = A | b1
        elif op == 0x45: self.a = A | self.rd(b1)
        elif op == 0x50:
            if not self.cy: npc = rel(b1)
        elif op == 0x52: self.wr(b1, self.rd(b1) & A)
        elif op == 0x53: self.wr(b1, self.rd(b1) & b2)
        elif op == 0x54: self.a = A & b1
        elif op == 0x55: self.a = A & self.rd(b1)
        elif op == 0x60:
            if A == 0: npc = rel(b1)
        elif op == 0x62: self.wr(b1, self.rd(b1) ^ A)
        elif op == 0x63: self.wr(b1, self.rd(b1) ^ b2)
        elif op == 0x64: self.a = A ^ b1
        elif op == 0x65: self.a = A ^ self.rd(b1)
        elif op == 0x70:
            if A != 0: npc = rel(b1)
        elif op == 0x72: self.cy = self.cy | self.bit(b1)
        elif op == 0x73: npc = (self.dptr + A) & 0xffff
        elif op == 0x74: self.a = b1
        elif op == 0x75: self.wr(b1, b2)
        elif op == 0x80: npc = rel(b1)
        elif op == 0x82: self.cy = self.cy & self.bit(b1)
        elif op == 0x83: self.a = c[(npc + A) & 0xffff]
        elif op == 0x84:
            B = self.b
            if B == 0: self.ram[0xd0] |= 4
            else: self.a = A // B; self.b = A % B; self.ram[0xd0] &= ~4 & 0xff
            self.cy = 0
        elif op == 0x85: self.wr(b2, self.rd(b1))
        elif op == 0x90: self.dptr = (b1 << 8) | b2
        elif op == 0x92: self.setbit(b1, self.cy)
        elif op == 0x93: self.a = c[(self.dptr + A) & 0xffff]
        elif op == 0x94: self.a = self.flags_sub(A, b1, self.cy)
        elif op == 0x95: self.a = self.flags_sub(A, self.rd(b1), self.cy)
        elif op == 0xa0: self.cy = self.cy | (1 - self.bit(b1))
        elif op == 0xa2: self.cy = self.bit(b1)
        elif op == 0xa3: self.dptr = (self.dptr + 1) & 0xffff
        elif op == 0xa4:
            p = A * self.b; self.a = p & 0xff; self.b = p >> 8
            self.cy = 0; self.ram[0xd0] = (self.ram[0xd0] & ~4 & 0xff) | (4 if p > 255 else 0)
        elif op == 0xb0: self.cy = self.cy & (1 - self.bit(b1))
        elif op == 0xb2: self.setbit(b1, 1 - self.bit(b1))
        elif op == 0xb3: self.cy = 1 - self.cy
        elif op == 0xb4:
            self.cy = A < b1
            if A != b1: npc = rel(b2)
        elif op == 0xb5:
            v = self.rd(b1); self.cy = A < v
            if A != v: npc = rel(b2)
        elif op == 0xc0: self.push(self.rd(b1))
        elif op == 0xc2: self.setbit(b1, 0)
        elif op == 0xc3: self.cy = 0
        elif op == 0xc4: self.a = ((A << 4) | (A >> 4)) & 0xff
        elif op == 0xc5: v = self.rd(b1); self.wr(b1, A); self.a = v
        elif op == 0xd0: self.wr(b1, self.pop())
        elif op == 0xd2: self.setbit(b1, 1)
        elif op == 0xd3: self.cy = 1
        elif op == 0xd4:
            v = A
            if (v & 15) > 9 or (self.ram[0xd0] & 0x40): v += 6
            if (v >> 4) > 9 or self.cy or v > 0xff: v += 0x60; self.cy = 1
            self.a = v & 0xff
        elif op == 0xd5:
            v = (self.rd(b1) - 1) & 0xff; self.wr(b1, v)
            if v: npc = rel(b2)
        elif op == 0xe0: self.a = self.x[self.dptr]
        elif op == 0xe2: self.a = self.x[self.xaddr_ri(0)]
        elif op == 0xe3: self.a = self.x[self.xaddr_ri(1)]
        elif op == 0xe4: self.a = 0
        elif op == 0xe5: self.a = self.rd(b1)
        elif op == 0xf0: self.x[self.dptr] = A
        elif op == 0xf2: self.x[self.xaddr_ri(0)] = A
        elif op == 0xf3: self.x[self.xaddr_ri(1)] = A
        elif op == 0xf4: self.a = ~A & 0xff
        elif op == 0xf5: self.wr(b1, A)
        else: raise RuntimeError('opcode %02x at %04x' % (op, pc))
        # parity flag
        p = bin(self.ram[0xe0]).count('1') & 1
        self.ram[0xd0] = (self.ram[0xd0] & 0xfe) | p
        self.pc = npc


if __name__ == '__main__':
    code = open(sys.argv[1], 'rb').read()
    code = code + bytes(65536 - len(code)) if len(code) < 65536 else code[:65536]
    for l in listing(code, int(sys.argv[2], 16), int(sys.argv[3], 16)):
        print(l)
