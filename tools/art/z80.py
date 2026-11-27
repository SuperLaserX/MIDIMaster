# Small Z80 emulator (documented instructions and flags, no interrupts or timing) for running firmware
# display routines. Memory and I/O go through callables so a board's bank switching can be modelled.
#   cpu = Z80(read, write, port_in, port_out); cpu.call(addr, stop_at=0xFFFF)
# Instruction decoding follows the x/y/z/p/q scheme of "Decoding Z80 opcodes".

SZ = [0] * 256
SZP = [0] * 256
for _v in range(256):
    SZ[_v] = (_v & 0x80) | (0x40 if _v == 0 else 0) | (_v & 0x28)
    SZP[_v] = SZ[_v] | (0x04 if bin(_v).count('1') % 2 == 0 else 0)


class Z80:
    def __init__(self, read, write, port_in=None, port_out=None):
        self.rd = read
        self.wr = write
        self.pin = port_in or (lambda p: 0xFF)
        self.pout = port_out or (lambda p, v: None)
        self.r = [0] * 8  # B C D E H L (F) A ; index 6 unused (memory), F kept apart
        self.f = 0
        self.ix = self.iy = 0
        self.sp = 0xFFF0
        self.pc = 0
        self.alt = [0] * 8
        self.altf = 0
        self.i = self.rr = 0
        self.iff = 0
        self.halted = False
        self.steps = 0
        self.hooks = {}  # address -> fn(cpu) returning True when it handled the instruction (did RET itself)

    # ---------------------------------------------------------------- helpers
    def rw(self, a):
        return self.rd(a & 0xFFFF) | (self.rd((a + 1) & 0xFFFF) << 8)

    def ww(self, a, v):
        self.wr(a & 0xFFFF, v & 0xFF)
        self.wr((a + 1) & 0xFFFF, (v >> 8) & 0xFF)

    def push(self, v):
        self.sp = (self.sp - 2) & 0xFFFF
        self.ww(self.sp, v)

    def pop(self):
        v = self.rw(self.sp)
        self.sp = (self.sp + 2) & 0xFFFF
        return v

    def fetch(self):
        v = self.rd(self.pc)
        self.pc = (self.pc + 1) & 0xFFFF
        return v

    def fetchw(self):
        v = self.rw(self.pc)
        self.pc = (self.pc + 2) & 0xFFFF
        return v

    @property
    def a(self):
        return self.r[7]

    @a.setter
    def a(self, v):
        self.r[7] = v & 0xFF

    def pair(self, p, idx=None, af=False):
        if p == 0: return (self.r[0] << 8) | self.r[1]
        if p == 1: return (self.r[2] << 8) | self.r[3]
        if p == 2:
            if idx == 'IX': return self.ix
            if idx == 'IY': return self.iy
            return (self.r[4] << 8) | self.r[5]
        return ((self.r[7] << 8) | self.f) if af else self.sp

    def setpair(self, p, v, idx=None, af=False):
        v &= 0xFFFF
        if p == 0: self.r[0], self.r[1] = v >> 8, v & 0xFF
        elif p == 1: self.r[2], self.r[3] = v >> 8, v & 0xFF
        elif p == 2:
            if idx == 'IX': self.ix = v
            elif idx == 'IY': self.iy = v
            else: self.r[4], self.r[5] = v >> 8, v & 0xFF
        elif af: self.r[7], self.f = v >> 8, v & 0xFF
        else: self.sp = v

    @property
    def hl(self):
        return (self.r[4] << 8) | self.r[5]

    @property
    def bc(self):
        return (self.r[0] << 8) | self.r[1]

    @property
    def de(self):
        return (self.r[2] << 8) | self.r[3]

    def cond(self, y):
        f = self.f
        return [not f & 0x40, bool(f & 0x40), not f & 1, bool(f & 1), not f & 4, bool(f & 4), not f & 0x80, bool(f & 0x80)][y]

    # ---------------------------------------------------------------- ALU
    def alu(self, y, v):
        a = self.a
        c = self.f & 1
        if y in (0, 1):  # ADD, ADC
            cy = c if y == 1 else 0
            r = a + v + cy
            h = ((a & 0xF) + (v & 0xF) + cy) & 0x10
            ov = ((a ^ ~v) & (a ^ r) & 0x80) != 0
            self.f = SZ[r & 0xFF] | (0x10 if h else 0) | (4 if ov else 0) | (1 if r > 0xFF else 0)
            self.a = r
        elif y in (2, 3, 7):  # SUB, SBC, CP
            cy = c if y == 3 else 0
            r = a - v - cy
            h = ((a & 0xF) - (v & 0xF) - cy) & 0x10
            ov = ((a ^ v) & (a ^ r) & 0x80) != 0
            f = SZ[r & 0xFF] | (0x10 if h else 0) | (4 if ov else 0) | 2 | (1 if r < 0 else 0)
            if y == 7:
                self.f = (f & ~0x28) | (v & 0x28)
            else:
                self.f = f
                self.a = r
        elif y == 4:
            self.a = a & v
            self.f = SZP[self.a] | 0x10
        elif y == 5:
            self.a = a ^ v
            self.f = SZP[self.a]
        else:
            self.a = a | v
            self.f = SZP[self.a]

    def inc8(self, v):
        r = (v + 1) & 0xFF
        self.f = (self.f & 1) | SZ[r] | (0x10 if (v & 0xF) == 0xF else 0) | (4 if v == 0x7F else 0)
        return r

    def dec8(self, v):
        r = (v - 1) & 0xFF
        self.f = (self.f & 1) | SZ[r] | 2 | (0x10 if (v & 0xF) == 0 else 0) | (4 if v == 0x80 else 0)
        return r

    def rot(self, y, v):
        c = self.f & 1
        if y == 0: r = ((v << 1) | (v >> 7)) & 0xFF; co = v >> 7
        elif y == 1: r = ((v >> 1) | (v << 7)) & 0xFF; co = v & 1
        elif y == 2: r = ((v << 1) | c) & 0xFF; co = v >> 7
        elif y == 3: r = (v >> 1) | (c << 7); co = v & 1
        elif y == 4: r = (v << 1) & 0xFF; co = v >> 7
        elif y == 5: r = (v >> 1) | (v & 0x80); co = v & 1
        elif y == 6: r = ((v << 1) | 1) & 0xFF; co = v >> 7
        else: r = v >> 1; co = v & 1
        self.f = SZP[r] | co
        return r

    def add16(self, a, b):
        r = a + b
        self.f = (self.f & 0xC4) | (0x10 if ((a & 0xFFF) + (b & 0xFFF)) & 0x1000 else 0) | (1 if r > 0xFFFF else 0) | ((r >> 8) & 0x28)
        return r & 0xFFFF

    def adc16(self, a, b):
        c = self.f & 1
        r = a + b + c
        ov = ((a ^ ~b) & (a ^ r) & 0x8000) != 0
        self.f = ((r >> 8) & 0xA8) | (0x40 if (r & 0xFFFF) == 0 else 0) | (0x10 if ((a & 0xFFF) + (b & 0xFFF) + c) & 0x1000 else 0) | (4 if ov else 0) | (1 if r > 0xFFFF else 0)
        return r & 0xFFFF

    def sbc16(self, a, b):
        c = self.f & 1
        r = a - b - c
        ov = ((a ^ b) & (a ^ r) & 0x8000) != 0
        self.f = ((r >> 8) & 0xA8) | (0x40 if (r & 0xFFFF) == 0 else 0) | (0x10 if ((a & 0xFFF) - (b & 0xFFF) - c) & 0x1000 else 0) | (4 if ov else 0) | 2 | (1 if r < 0 else 0)
        return r & 0xFFFF

    def daa(self):
        a = self.a
        f = self.f
        corr = 0
        c = f & 1
        if (f & 0x10) or (a & 0xF) > 9: corr |= 0x06
        if c or a > 0x99:
            corr |= 0x60
            c = 1
        if f & 2:
            h = (f & 0x10) and (a & 0xF) < 6
            a = (a - corr) & 0xFF
        else:
            h = (a & 0xF) > 9
            a = (a + corr) & 0xFF
        self.a = a
        self.f = SZP[a] | (f & 2) | (0x10 if h else 0) | c

    # ---------------------------------------------------------------- operand access
    def getr(self, i, idx, d):
        if i == 6:
            return self.rd(self.addr6(idx, d))
        if idx and i in (4, 5):
            v = self.ix if idx == 'IX' else self.iy
            return (v >> 8) if i == 4 else v & 0xFF
        return self.r[i]

    def setr(self, i, v, idx, d):
        v &= 0xFF
        if i == 6:
            self.wr(self.addr6(idx, d), v)
        elif idx and i in (4, 5):
            if idx == 'IX': self.ix = ((v << 8) | (self.ix & 0xFF)) if i == 4 else ((self.ix & 0xFF00) | v)
            else: self.iy = ((v << 8) | (self.iy & 0xFF)) if i == 4 else ((self.iy & 0xFF00) | v)
        else:
            self.r[i] = v

    def addr6(self, idx, d):
        if idx == 'IX': return (self.ix + d) & 0xFFFF
        if idx == 'IY': return (self.iy + d) & 0xFFFF
        return self.hl

    # ---------------------------------------------------------------- step
    def step(self):
        self.steps += 1
        h = self.hooks.get(self.pc)
        if h and h(self):
            return
        op = self.fetch()
        idx = None
        if op in (0xDD, 0xFD):
            idx = 'IX' if op == 0xDD else 'IY'
            op = self.fetch()
        if op == 0xCB:
            return self.cb(idx)
        if op == 0xED:
            return self.ed()
        x, y, z = op >> 6, (op >> 3) & 7, op & 7
        p, q = y >> 1, y & 1
        uses_d = idx and ((x == 1 and (y == 6 or z == 6) and not (y == 6 and z == 6)) or (x == 2 and z == 6) or (x == 0 and z in (4, 5, 6) and y == 6))
        d = 0
        if uses_d:
            d = self.fetch()
            d = d - 256 if d > 127 else d
        if x == 0:
            if z == 0:
                if y == 0: return
                if y == 1:
                    self.r[7], self.alt[7] = self.alt[7], self.r[7]
                    self.f, self.altf = self.altf, self.f
                    return
                e = self.fetch()
                e = e - 256 if e > 127 else e
                if y == 2:
                    self.r[0] = (self.r[0] - 1) & 0xFF
                    if self.r[0]: self.pc = (self.pc + e) & 0xFFFF
                    return
                if y == 3 or self.cond(y - 4):
                    self.pc = (self.pc + e) & 0xFFFF
                return
            if z == 1:
                if q == 0: self.setpair(p, self.fetchw(), idx)
                else: self.setpair(2, self.add16(self.pair(2, idx), self.pair(p, idx)), idx)
                return
            if z == 2:
                if y == 0: self.wr(self.bc, self.a)
                elif y == 1: self.a = self.rd(self.bc)
                elif y == 2: self.wr(self.de, self.a)
                elif y == 3: self.a = self.rd(self.de)
                elif y == 4: self.ww(self.fetchw(), self.pair(2, idx))
                elif y == 5: self.setpair(2, self.rw(self.fetchw()), idx)
                elif y == 6: self.wr(self.fetchw(), self.a)
                else: self.a = self.rd(self.fetchw())
                return
            if z == 3:
                self.setpair(p, self.pair(p, idx) + (1 if q == 0 else -1), idx)
                return
            if z == 4:
                self.setr(y, self.inc8(self.getr(y, idx, d)), idx, d)
                return
            if z == 5:
                self.setr(y, self.dec8(self.getr(y, idx, d)), idx, d)
                return
            if z == 6:
                self.setr(y, self.fetch(), idx, d)
                return
            a = self.a
            c = self.f & 1
            if y == 0: self.a = (a << 1) | (a >> 7); self.f = (self.f & 0xC4) | (a >> 7) | (self.a & 0x28)
            elif y == 1: self.a = (a >> 1) | (a << 7); self.f = (self.f & 0xC4) | (a & 1) | (self.a & 0x28)
            elif y == 2: self.a = (a << 1) | c; self.f = (self.f & 0xC4) | (a >> 7) | (self.a & 0x28)
            elif y == 3: self.a = (a >> 1) | (c << 7); self.f = (self.f & 0xC4) | (a & 1) | (self.a & 0x28)
            elif y == 4: self.daa()
            elif y == 5: self.a = ~a; self.f = (self.f & 0xC5) | 0x12 | (self.a & 0x28)
            elif y == 6: self.f = (self.f & 0xC4) | 1 | (a & 0x28)
            else: self.f = ((self.f & 0xC5) | (0x10 if c else 0) | (a & 0x28)) ^ 1
            return
        if x == 1:
            if y == 6 and z == 6:
                self.halted = True
                return
            if idx and (y == 6 or z == 6):
                v = self.getr(z, idx if z == 6 else None, d)
                self.setr(y, v, idx if y == 6 else None, d)
            else:
                self.setr(y, self.getr(z, idx, d), idx, d)
            return
        if x == 2:
            self.alu(y, self.getr(z, idx, d))
            return
        if z == 0:
            if self.cond(y): self.pc = self.pop()
            return
        if z == 1:
            if q == 0:
                self.setpair(p, self.pop(), idx, af=True)
            elif p == 0: self.pc = self.pop()
            elif p == 1:
                for k in (0, 1, 2, 3, 4, 5):
                    self.r[k], self.alt[k] = self.alt[k], self.r[k]
            elif p == 2: self.pc = self.pair(2, idx)
            else: self.sp = self.pair(2, idx)
            return
        if z == 2:
            nn = self.fetchw()
            if self.cond(y): self.pc = nn
            return
        if z == 3:
            if y == 0: self.pc = self.fetchw()
            elif y == 2: self.pout(self.fetch(), self.a)
            elif y == 3: self.a = self.pin(self.fetch())
            elif y == 4:
                v = self.rw(self.sp)
                self.ww(self.sp, self.pair(2, idx))
                self.setpair(2, v, idx)
            elif y == 5:
                de, hl = self.de, self.hl
                self.setpair(1, hl)
                self.setpair(2, de)
            elif y == 6: self.iff = 0
            else: self.iff = 1
            return
        if z == 4:
            nn = self.fetchw()
            if self.cond(y):
                self.push(self.pc)
                self.pc = nn
            return
        if z == 5:
            if q == 0:
                self.push(self.pair(p, idx, af=True))
            elif p == 0:
                nn = self.fetchw()
                self.push(self.pc)
                self.pc = nn
            return
        if z == 6:
            self.alu(y, self.fetch())
            return
        self.push(self.pc)
        self.pc = y * 8

    def cb(self, idx):
        if idx:
            d = self.fetch()
            d = d - 256 if d > 127 else d
            o = self.fetch()
            ad = (((self.ix if idx == 'IX' else self.iy) + d) & 0xFFFF)
            x, y, z = o >> 6, (o >> 3) & 7, o & 7
            v = self.rd(ad)
            if x == 0:
                r = self.rot(y, v)
                self.wr(ad, r)
            elif x == 1:
                self.f = (self.f & 1) | 0x10 | (SZP[v & (1 << y)] & 0xC4) | ((ad >> 8) & 0x28)
            elif x == 2:
                self.wr(ad, v & ~(1 << y))
            else:
                self.wr(ad, v | (1 << y))
            return
        o = self.fetch()
        x, y, z = o >> 6, (o >> 3) & 7, o & 7
        v = self.getr(z, None, 0)
        if x == 0:
            self.setr(z, self.rot(y, v), None, 0)
        elif x == 1:
            self.f = (self.f & 1) | 0x10 | (SZP[v & (1 << y)] & 0xC4) | (v & 0x28)
        elif x == 2:
            self.setr(z, v & ~(1 << y), None, 0)
        else:
            self.setr(z, v | (1 << y), None, 0)

    def ed(self):
        o = self.fetch()
        x, y, z = o >> 6, (o >> 3) & 7, o & 7
        p, q = y >> 1, y & 1
        if x == 1:
            if z == 0:
                v = self.pin(self.r[1])
                if y != 6: self.r[y] = v
                self.f = (self.f & 1) | SZP[v]
            elif z == 1:
                self.pout(self.r[1], self.r[y] if y != 6 else 0)
            elif z == 2:
                hl = self.hl
                self.setpair(2, self.sbc16(hl, self.pair(p)) if q == 0 else self.adc16(hl, self.pair(p)))
            elif z == 3:
                nn = self.fetchw()
                if q == 0: self.ww(nn, self.pair(p))
                else: self.setpair(p, self.rw(nn))
            elif z == 4:
                v = self.a
                self.a = 0
                self.alu(2, v)
            elif z == 5:
                self.pc = self.pop()
            elif z == 6:
                pass
            else:
                if y == 0: self.i = self.a
                elif y == 1: self.rr = self.a
                elif y == 2: self.a = self.i; self.f = (self.f & 1) | SZ[self.a] | (4 if self.iff else 0)
                elif y == 3: self.a = self.rr; self.f = (self.f & 1) | SZ[self.a] | (4 if self.iff else 0)
                elif y == 4:  # RRD
                    m = self.rd(self.hl)
                    a = self.a
                    self.wr(self.hl, ((a << 4) | (m >> 4)) & 0xFF)
                    self.a = (a & 0xF0) | (m & 0x0F)
                    self.f = (self.f & 1) | SZP[self.a]
                elif y == 5:  # RLD
                    m = self.rd(self.hl)
                    a = self.a
                    self.wr(self.hl, ((m << 4) | (a & 0x0F)) & 0xFF)
                    self.a = (a & 0xF0) | (m >> 4)
                    self.f = (self.f & 1) | SZP[self.a]
            return
        if x == 2 and y >= 4:
            inc = 1 if y in (4, 6) else -1
            rep = y >= 6
            while True:
                hl, de, bc = self.hl, self.de, self.bc
                if z == 0:  # LDI/LDD
                    self.wr(de, self.rd(hl))
                    self.setpair(1, de + inc)
                    self.setpair(2, hl + inc)
                    bc = (bc - 1) & 0xFFFF
                    self.setpair(0, bc)
                    self.f = (self.f & 0xC1) | (4 if bc else 0)
                    if rep and bc: continue
                    return
                if z == 1:  # CPI/CPD
                    v = self.rd(hl)
                    r = (self.a - v) & 0xFF
                    self.setpair(2, hl + inc)
                    bc = (bc - 1) & 0xFFFF
                    self.setpair(0, bc)
                    self.f = (self.f & 1) | SZ[r] | 2 | (4 if bc else 0) | (0x10 if ((self.a & 0xF) - (v & 0xF)) & 0x10 else 0)
                    if rep and bc and r: continue
                    return
                if z == 2:  # INI/IND
                    self.wr(hl, self.pin(self.r[1]))
                    self.setpair(2, hl + inc)
                    self.r[0] = (self.r[0] - 1) & 0xFF
                    self.f = (self.f & 1) | 2 | (0x40 if self.r[0] == 0 else 0)
                    if rep and self.r[0]: continue
                    return
                self.pout(self.r[1], self.rd(hl))  # OUTI/OUTD
                self.setpair(2, hl + inc)
                self.r[0] = (self.r[0] - 1) & 0xFF
                self.f = (self.f & 1) | 2 | (0x40 if self.r[0] == 0 else 0)
                if rep and self.r[0]: continue
                return
        # undefined ED opcodes act as NOP

    def call(self, addr, max_steps=2_000_000, sp=None):
        """Run a subroutine at addr until it returns to a sentinel."""
        if sp is not None:
            self.sp = sp
        self.push(0xFFFF)
        self.pc = addr
        n = 0
        while self.pc != 0xFFFF:
            self.step()
            n += 1
            if n > max_steps:
                raise RuntimeError('Z80 call %04X did not return (pc %04X)' % (addr, self.pc))
            if self.halted:
                raise RuntimeError('HALT at %04X' % self.pc)
        return n
