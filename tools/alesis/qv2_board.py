# Alesis Quadraverb 2 board model for the 8051 emulator (tools/alesis/i8051.py).
# 128 KB EPROM in two 64 KB banks: a MOVX write to 8008 selects the bank for code fetches and MOVC
# (0 = image 0-FFFF, 1 = image 10000-1FFFF); 0000-17C1 and FF00-FFFF are the same in both banks.
# XDATA 0000-7FFF is RAM (system 0000-1BFF, user programs 1C00 + 100h n; P1.5 selects a second RAM bank),
# 8004 / 8005 the LCD (command / data; the firmware keeps its 32-character buffer at 0200-021F),
# 8010-801C the DSP / ASIC registers.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i8051 import Cpu  # noqa: E402


class XMem:
    def __init__(self, img, cpu):
        self.img = img
        self.cpu = cpu
        self.ram = [bytearray(0x8000), bytearray(0x8000)]
        self.bank = 0
        self.io = {}
        self.reads = {}
        self.writes = []
        self.logging = False
        self.ack = 0
        self.keys = set()      # pressed keys as (column bit 4-7, row bit 0-3)

    def rbank(self):
        return 1 if (self.cpu.ram[0x90] & 0x20) else 0

    def __getitem__(self, a):
        if a < 0x8000:
            if a >= 0x1c00:
                return self.ram[self.rbank()][a]
            return self.ram[0][a]
        self.reads[a] = self.reads.get(a, 0) + 1
        if a == 0x801b:
            # ASIC status: bit 0 answers each write to 8017 (handshake), bit 2 set and bits 1 / 4 clear
            # (otherwise the firmware reports BAD SAMPLE CLOCK)
            return 0x04 | self.ack
        return self.io.get(a, 0xff)

    def __setitem__(self, a, v):
        v &= 0xff
        if a < 0x8000:
            if a >= 0x1c00:
                self.ram[self.rbank()][a] = v
            else:
                self.ram[0][a] = v
            return
        if a == 0x8002:
            # key matrix: bits 4-7 drive the columns (low = active), P1.0-P1.3 read the rows
            rows = 0x0f
            for col, row in self.keys:
                if not (v >> col) & 1:
                    rows &= ~(1 << row)
            p1 = self.cpu.ram[0x90]
            self.cpu.ram[0x90] = (p1 & 0xf0) | rows
        if a == 0x8017:
            self.ack ^= 1
        if a == 0x8008:
            self.bank = v & 1
            self.cpu.c = self.img[0x10000:] if self.bank else self.img[:0x10000]
            return
        if self.logging:
            self.writes.append((a, v))


def make(img):
    cpu = Cpu(img[:0x10000])
    cpu.x = XMem(img, cpu)
    return cpu


def lcd(cpu):
    r = cpu.x.ram[0]
    return bytes(r[0x200:0x220])


def run_until(cpu, stops, limit=2000000):
    n = 0
    while cpu.pc not in stops:
        cpu.step()
        n += 1
        if n > limit:
            raise RuntimeError('step limit at %04x' % cpu.pc)
    return cpu.pc
