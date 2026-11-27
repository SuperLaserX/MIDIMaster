# Small HD6303 / 6801 emulator (documented instructions and flags) for running firmware routines:
# display routines, page handlers, MIDI parsers. Memory goes through callables, so a board models its
# own I/O, bank latches and the CPU's internal registers (0000-001F). No cycle timing: a board that
# needs timer or serial interrupts raises them itself with cpu.interrupt(vector).
#   cpu = HD6303(read, write); cpu.reset(); cpu.call(addr); cpu.run(until=lambda c: ...)
# The opcode table is the one of tools/yamaha/hd6303_dis.py (shared, so both agree on every byte).

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hd6303_dis import OPS, SIZE  # noqa: E402

H, I, N, Z, V, C = 0x20, 0x10, 0x08, 0x04, 0x02, 0x01


class Halt(Exception):
    pass


class HD6303:
    def __init__(self, read, write):
        self.rd = read
        self.wr = write
        self.a = self.b = 0
        self.x = 0
        self.sp = 0x00FF
        self.pc = 0
        self.cc = 0xD0  # bits 7-6 read as 1; I set
        self.steps = 0
        self.hooks = {}  # address -> fn(cpu) returning True when it handled the instruction itself
        self.trace = None  # fn(cpu) called before each instruction
        self.waiting = False

    # ---------------------------------------------------------------- helpers
    @property
    def d(self):
        return (self.a << 8) | self.b

    @d.setter
    def d(self, v):
        self.a = (v >> 8) & 0xFF
        self.b = v & 0xFF

    def rw(self, a):
        return (self.rd(a & 0xFFFF) << 8) | self.rd((a + 1) & 0xFFFF)

    def ww(self, a, v):
        self.wr(a & 0xFFFF, (v >> 8) & 0xFF)
        self.wr((a + 1) & 0xFFFF, v & 0xFF)

    def push(self, v):
        self.wr(self.sp, v & 0xFF)
        self.sp = (self.sp - 1) & 0xFFFF

    def pull(self):
        self.sp = (self.sp + 1) & 0xFFFF
        return self.rd(self.sp)

    def pushw(self, v):
        self.push(v & 0xFF)
        self.push(v >> 8)

    def pullw(self):
        h = self.pull()
        return (h << 8) | self.pull()

    def fetch(self):
        v = self.rd(self.pc)
        self.pc = (self.pc + 1) & 0xFFFF
        return v

    def fetchw(self):
        v = self.rw(self.pc)
        self.pc = (self.pc + 2) & 0xFFFF
        return v

    def flag(self, f, on):
        if on:
            self.cc |= f
        else:
            self.cc &= ~f & 0xFF

    def nz8(self, r):
        self.cc = (self.cc & ~(N | Z)) | (N if r & 0x80 else 0) | (Z if r == 0 else 0)

    def nz16(self, r):
        self.cc = (self.cc & ~(N | Z)) | (N if r & 0x8000 else 0) | (Z if r == 0 else 0)

    def ld8(self, r):
        self.nz8(r)
        self.cc &= ~V
        return r

    def reset(self):
        self.cc = 0xD0
        self.pc = self.rw(0xFFFE)

    def interrupt(self, vector, force=False):
        """Take the interrupt whose vector is at `vector` (FFF8 IRQ1, FFF4 OCF, FFF0 SCI ...) unless I is set."""
        if (self.cc & I) and not force:
            return False
        if not self.waiting:
            self.pushw(self.pc)
            self.pushw(self.x)
            self.push(self.a)
            self.push(self.b)
            self.push(self.cc)
        self.waiting = False
        self.cc |= I
        self.pc = self.rw(vector)
        return True

    # ---------------------------------------------------------------- arithmetic
    def add8(self, r, m, c=0):
        s = r + m + c
        res = s & 0xFF
        f = self.cc & ~(H | N | Z | V | C)
        if (r ^ m ^ res) & 0x10:
            f |= H
        if res & 0x80:
            f |= N
        if res == 0:
            f |= Z
        if (r ^ res) & (m ^ res) & 0x80:
            f |= V
        if s > 0xFF:
            f |= C
        self.cc = f
        return res

    def sub8(self, r, m, c=0):
        s = r - m - c
        res = s & 0xFF
        f = self.cc & ~(N | Z | V | C)
        if res & 0x80:
            f |= N
        if res == 0:
            f |= Z
        if (r ^ m) & (r ^ res) & 0x80:
            f |= V
        if s < 0:
            f |= C
        self.cc = f
        return res

    def add16(self, r, m):
        s = r + m
        res = s & 0xFFFF
        self.nz16(res)
        self.flag(V, (r ^ res) & (m ^ res) & 0x8000)
        self.flag(C, s > 0xFFFF)
        return res

    def sub16(self, r, m):
        s = r - m
        res = s & 0xFFFF
        self.nz16(res)
        self.flag(V, (r ^ m) & (r ^ res) & 0x8000)
        self.flag(C, s < 0)
        return res

    def unary(self, op, r):
        c = self.cc & C
        if op == 0x0:  # neg
            res = (-r) & 0xFF
            self.nz8(res)
            self.flag(V, res == 0x80)
            self.flag(C, res != 0)
        elif op == 0x3:  # com
            res = (~r) & 0xFF
            self.nz8(res)
            self.cc = (self.cc & ~V) | C
        elif op in (0x4, 0x6, 0x7):  # lsr ror asr
            if op == 0x4:
                res = r >> 1
            elif op == 0x6:
                res = (r >> 1) | (0x80 if c else 0)
            else:
                res = (r >> 1) | (r & 0x80)
            self.nz8(res)
            self.flag(C, r & 1)
            self.flag(V, bool(self.cc & N) != bool(self.cc & C))
        elif op in (0x8, 0x9):  # asl rol
            res = ((r << 1) | (c if op == 0x9 else 0)) & 0xFF
            self.nz8(res)
            self.flag(C, r & 0x80)
            self.flag(V, bool(self.cc & N) != bool(self.cc & C))
        elif op == 0xA:  # dec
            res = (r - 1) & 0xFF
            self.nz8(res)
            self.flag(V, r == 0x80)
        elif op == 0xC:  # inc
            res = (r + 1) & 0xFF
            self.nz8(res)
            self.flag(V, r == 0x7F)
        elif op == 0xD:  # tst
            self.nz8(r)
            self.cc &= ~(V | C)
            return None
        elif op == 0xF:  # clr
            self.cc = (self.cc & ~(N | V | C)) | Z
            return 0
        else:
            raise Halt('bad unary %X at %04X' % (op, self.pc))
        return res

    def cond(self, k):
        c, z, n, v = self.cc & C, self.cc & Z, bool(self.cc & N), bool(self.cc & V)
        return [True, False, not (c or z), bool(c or z), not c, bool(c), not z, bool(z),
                not v, v, not n, n, n == v, n != v, (not z) and n == v, bool(z) or n != v][k]

    def daa(self):
        a = self.a
        lo, hi = a & 0x0F, a >> 4
        corr = 0
        c = self.cc & C
        if (self.cc & H) or lo > 9:
            corr |= 0x06
        if c or hi > 9 or (hi > 8 and lo > 9):
            corr |= 0x60
            c = 1
        res = (a + corr) & 0xFF
        self.nz8(res)
        self.flag(C, c)
        self.a = res

    # ---------------------------------------------------------------- execution
    def ea(self, mode):
        if mode == 'dir':
            return self.fetch()
        if mode == 'ext':
            return self.fetchw()
        if mode == 'idx':
            return (self.x + self.fetch()) & 0xFFFF
        raise Halt('mode %s' % mode)

    def step(self):
        if self.trace:
            self.trace(self)
        h = self.hooks.get(self.pc)
        if h and h(self):
            self.steps += 1
            return
        pc0 = self.pc
        op = self.fetch()
        self.steps += 1
        e = OPS.get(op)
        if e is None:
            raise Halt('illegal opcode %02X at %04X' % (op, pc0))
        m, mode = e
        hi, lo = op >> 4, op & 0x0F
        if hi == 0x2:  # branches
            off = self.fetch()
            if self.cond(lo):
                self.pc = (self.pc + (off - 256 if off & 0x80 else off)) & 0xFFFF
            return
        if m == 'jmp':
            self.pc = self.ea(mode)
            return
        if 0x4 <= hi <= 0x7 and m not in ('aim', 'oim', 'eim', 'tim'):
            u = lo
            if hi == 0x4:
                r = self.unary(u, self.a)
                if r is not None:
                    self.a = r
            elif hi == 0x5:
                r = self.unary(u, self.b)
                if r is not None:
                    self.b = r
            else:
                a = self.ea('idx' if hi == 0x6 else 'ext')
                r = self.unary(u, self.rd(a))
                if r is not None:
                    self.wr(a, r)
            return
        if m in ('aim', 'oim', 'eim', 'tim'):
            imm = self.fetch()
            a = (self.x + self.fetch()) & 0xFFFF if mode == 'bimx' else self.fetch()
            v = self.rd(a)
            r = {'aim': v & imm, 'oim': v | imm, 'eim': v ^ imm, 'tim': v & imm}[m]
            self.nz8(r)
            self.cc &= ~V
            if m != 'tim':
                self.wr(a, r)
            return
        if hi >= 0x8:
            self.alu(op, m, mode)
            return
        self.inherent(op, m)

    def operand8(self, mode):
        if mode == 'imm8':
            return self.fetch()
        return self.rd(self.ea(mode))

    def operand16(self, mode):
        if mode == 'imm16':
            return self.fetchw()
        return self.rw(self.ea(mode))

    def alu(self, op, m, mode):
        lo = op & 0x0F
        if m == 'bsr':
            off = self.fetch()
            self.pushw(self.pc)
            self.pc = (self.pc + (off - 256 if off & 0x80 else off)) & 0xFFFF
            return
        if m == 'jsr':
            a = self.ea(mode)
            self.pushw(self.pc)
            self.pc = a
            return
        if m == 'jmp':
            self.pc = self.ea(mode)
            return
        if m in ('subd', 'addd', 'cpx', 'ldd', 'ldx', 'lds'):
            v = self.operand16(mode)
            if m == 'subd':
                self.d = self.sub16(self.d, v)
            elif m == 'addd':
                self.d = self.add16(self.d, v)
            elif m == 'cpx':
                self.sub16(self.x, v)
            else:
                self.nz16(v)
                self.cc &= ~V
                if m == 'ldd':
                    self.d = v
                elif m == 'ldx':
                    self.x = v
                else:
                    self.sp = v
            return
        if m in ('std', 'stx', 'sts'):
            a = self.ea(mode)
            v = {'std': self.d, 'stx': self.x, 'sts': self.sp}[m]
            self.ww(a, v)
            self.nz16(v)
            self.cc &= ~V
            return
        isb = op >= 0xC0
        r = self.b if isb else self.a
        base = m[:-1]
        if base == 'sta':
            a = self.ea(mode)
            self.wr(a, r)
            self.ld8(r)
            return
        v = self.operand8(mode)
        c = self.cc & C
        if base == 'sub':
            r = self.sub8(r, v)
        elif base == 'cmp':
            self.sub8(r, v)
            return
        elif base == 'sbc':
            r = self.sub8(r, v, c)
        elif base == 'and':
            r = self.ld8(r & v)
        elif base == 'bit':
            self.ld8(r & v)
            return
        elif base == 'lda':
            r = self.ld8(v)
        elif base == 'eor':
            r = self.ld8(r ^ v)
        elif base == 'adc':
            r = self.add8(r, v, c)
        elif base == 'ora':
            r = self.ld8(r | v)
        elif base == 'add':
            r = self.add8(r, v)
        else:
            raise Halt('alu %s' % m)
        if isb:
            self.b = r
        else:
            self.a = r

    def inherent(self, op, m):
        if m == 'nop':
            pass
        elif m == 'lsrd':
            d = self.d
            r = d >> 1
            self.nz16(r)
            self.flag(C, d & 1)
            self.flag(V, d & 1)
            self.d = r
        elif m == 'asld':
            d = self.d
            r = (d << 1) & 0xFFFF
            self.nz16(r)
            self.flag(C, d & 0x8000)
            self.flag(V, bool(r & 0x8000) != bool(d & 0x8000))
            self.d = r
        elif m == 'tap':
            self.cc = self.a | 0xC0
        elif m == 'tpa':
            self.a = self.cc | 0xC0
        elif m == 'inx':
            self.x = (self.x + 1) & 0xFFFF
            self.flag(Z, self.x == 0)
        elif m == 'dex':
            self.x = (self.x - 1) & 0xFFFF
            self.flag(Z, self.x == 0)
        elif m == 'clv':
            self.cc &= ~V
        elif m == 'sev':
            self.cc |= V
        elif m == 'clc':
            self.cc &= ~C
        elif m == 'sec':
            self.cc |= C
        elif m == 'cli':
            self.cc &= ~I
        elif m == 'sei':
            self.cc |= I
        elif m == 'sba':
            self.a = self.sub8(self.a, self.b)
        elif m == 'cba':
            self.sub8(self.a, self.b)
        elif m == 'tab':
            self.b = self.ld8(self.a)
        elif m == 'tba':
            self.a = self.ld8(self.b)
        elif m == 'xgdx':
            self.x, self.d = self.d, self.x
        elif m == 'daa':
            self.daa()
        elif m == 'slp':
            raise Halt('slp at %04X' % ((self.pc - 1) & 0xFFFF))
        elif m == 'aba':
            self.a = self.add8(self.a, self.b)
        elif m == 'tsx':
            self.x = (self.sp + 1) & 0xFFFF
        elif m == 'ins':
            self.sp = (self.sp + 1) & 0xFFFF
        elif m == 'pula':
            self.a = self.pull()
        elif m == 'pulb':
            self.b = self.pull()
        elif m == 'des':
            self.sp = (self.sp - 1) & 0xFFFF
        elif m == 'txs':
            self.sp = (self.x - 1) & 0xFFFF
        elif m == 'psha':
            self.push(self.a)
        elif m == 'pshb':
            self.push(self.b)
        elif m == 'pulx':
            self.x = self.pullw()
        elif m == 'rts':
            self.pc = self.pullw()
        elif m == 'abx':
            self.x = (self.x + self.b) & 0xFFFF
        elif m == 'rti':
            self.cc = self.pull() | 0xC0
            self.b = self.pull()
            self.a = self.pull()
            self.x = self.pullw()
            self.pc = self.pullw()
        elif m == 'pshx':
            self.pushw(self.x)
        elif m == 'mul':
            r = self.a * self.b
            self.d = r
            self.flag(C, r & 0x80)
        elif m == 'wai':
            self.pushw(self.pc)
            self.pushw(self.x)
            self.push(self.a)
            self.push(self.b)
            self.push(self.cc)
            self.waiting = True
            raise Halt('wai at %04X' % ((self.pc - 1) & 0xFFFF))
        elif m == 'swi':
            self.pushw(self.pc)
            self.pushw(self.x)
            self.push(self.a)
            self.push(self.b)
            self.push(self.cc)
            self.cc |= I
            self.pc = self.rw(0xFFFA)
        else:
            raise Halt('inherent %s' % m)

    def run(self, until, max_steps=5_000_000):
        n = 0
        while not until(self):
            self.step()
            n += 1
            if n > max_steps:
                raise Halt('step limit at %04X' % self.pc)
        return n

    def call(self, addr, max_steps=5_000_000, sp=None, sentinel=0xFFFF):
        """Run the subroutine at addr until it returns (to a sentinel return address)."""
        if sp is not None:
            self.sp = sp
        self.pushw(sentinel)
        depth_sp = self.sp
        self.pc = addr
        n = 0
        while not (self.pc == sentinel and self.sp == (depth_sp + 2) & 0xFFFF):
            self.step()
            n += 1
            if n > max_steps:
                raise Halt('step limit in call %04X at %04X' % (addr, self.pc))
        return n
