# ART Multiverb Alpha 2 / Alpha 2 SE board model for the Z80 emulator (tools/art/z80.py): the EPROM image
# is CPU 0000-9FFF fixed; A000-BFFF an 8 KB page selected by port 28h (page p = image p * 2000h: 5 and 6
# the configurations' DSP data, 7 the Alpha 2's preset ROM (image E000) and the SE's first preset bank,
# 8-10 the SE's other banks); C000-FFFF RAM (battery-backed C000-DFFF). Pages beyond the image read FFh.
# The LCD (HD44780 at ports 70h / 71h, busy flag 72h) keeps a 32-character shadow in RAM (line 1 then 2;
# C265 on the Alpha 2, C268 on the SE); CG RAM writes (custom characters) are kept in cgram.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from z80 import Z80  # noqa: E402


class Board:
    def __init__(self, img, lcd=0xC265):
        self.img = img
        self.lcd_at = lcd
        self.ram = bytearray(0x4000)
        self.bank = 5
        self.cgram = bytearray(64)
        self._cg = None  # CG RAM address while the LCD is in CG RAM mode
        self.cpu = Z80(self.read, self.write, self.port_in, self.port_out)

    def read(self, a):
        if a < 0xA000:
            return self.img[a]
        if a < 0xC000:
            o = self.bank * 0x2000 + (a - 0xA000)
            return self.img[o] if o < len(self.img) else 0xFF
        return self.ram[a - 0xC000]

    def write(self, a, v):
        if a >= 0xC000:
            self.ram[a - 0xC000] = v

    def port_in(self, p):
        return 0x00  # LCD never busy, UART idle

    def port_out(self, p, v):
        if p == 0x28:
            self.bank = v
        elif p == 0x70:  # LCD command: set CG RAM address (40h-7Fh) or DD RAM address (80h-FFh)
            if v & 0xC0 == 0x40:
                self._cg = v & 0x3F
            elif v & 0x80:
                self._cg = None
        elif p == 0x71 and self._cg is not None:
            self.cgram[self._cg] = v
            self._cg = (self._cg + 1) & 0x3F

    # ------------------------------------------------------------ helpers
    def peek(self, a, n=1):
        return bytes(self.read(a + i) for i in range(n))

    def poke(self, a, data):
        for i, v in enumerate(data):
            self.write(a + i, v)

    def lcd(self):
        s = self.peek(self.lcd_at, 32)
        return s[:16], s[16:]

    def call(self, addr, **kw):
        self.cpu.sp = 0xC096  # the firmware's stack
        return self.cpu.call(addr, **kw)
