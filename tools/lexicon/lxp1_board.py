# Lexicon LXP-1 / LXP-5 board model for the Z80 emulator (tools/art/z80.py), found from the v1.06 / v1.12
# EPROMs. Memory: 0000-7FFF the 32 KB EPROM, 8000-FFFF RAM (C000-DBFF registers, active setup and settings;
# stack below E000; E000-E3FF the DSP host window, kept here as RAM). Interrupt: mode 1, RST 38h jumps
# through the word at D89Bh (LXP-1); a timer, taken here every IRQ_EVERY instructions.
# Ports: 8251 UART 00 data, 01 status / command (status: bit 0 TxRDY, bit 1 RxRDY, bit 2 TxEMPTY).
# LXP-1 panel: 80h high / low nibble two 16-position switches, C0h low nibble a third (gray code, table
# 580Eh), C0h bit 4 the button (active low). The LXP-5 (v1.12) has the same memory map with its 8251 at
# 80h data / 81h status (Board(img, uart=0x80)); RAM from A000h, interrupt through A05Fh.
import collections
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'art'))
from z80 import Z80  # noqa: E402


class Board:
    def __init__(self, img, uart=0x00):
        assert len(img) == 0x8000
        self.uart = uart
        self.img = img
        self.ram = bytearray(0x8000)
        self.rx = collections.deque()
        self.tx = []
        self.p80 = 0x00
        self.pc0 = 0x1F
        self.inlog = collections.Counter()
        self.outlog = collections.Counter()
        self.cpu = Z80(self.read, self.write, self.port_in, self.port_out)

    def read(self, a):
        if a < 0x8000:
            return self.img[a]
        return self.ram[a - 0x8000]

    def write(self, a, v):
        if a >= 0x8000:
            self.ram[a - 0x8000] = v

    def port_in(self, p):
        p &= 0xFF
        self.inlog[p] += 1
        if p == self.uart + 1:
            return 0x05 | (0x02 if self.rx else 0)
        if p == self.uart:
            return self.rx.popleft() if self.rx else 0
        if p == 0x80:
            return self.p80
        if p == 0xC0:
            return self.pc0
        return 0xFF

    def port_out(self, p, v):
        p &= 0xFF
        self.outlog[p] += 1
        if p == self.uart:
            self.tx.append(v)

    def peek(self, a, n=1):
        return bytes(self.read((a + i) & 0xFFFF) for i in range(n))

    def poke(self, a, data):
        for i, v in enumerate(data):
            self.write(a + i, v)

    def irq(self):
        c = self.cpu
        if c.iff:
            c.iff = 0
            c.halted = False
            c.push(c.pc)
            c.pc = 0x38
            return True
        return False
