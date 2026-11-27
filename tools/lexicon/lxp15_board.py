# Lexicon LXP-15 board model for the Z80 emulator (tools/art/z80.py), found from the v2.00 EPROM.
# Memory: CPU 0000-7FFF = one 32 KB bank of the 64 KB EPROM (OUT (80h) bank A = image 0000-7FFF, OUT (40h)
# bank B = image 8000-FFFF; the firmware keeps the bank in the I register), 8000-FFFF RAM (8000-A17F the 128
# registers of 67 bytes, A180-BC7F work RAM and stack, BD00 / BE00 the event queues, E000-E3FF shared with the
# slave). Interrupt: mode 1 (RST 38h -> handler address at A372), a timer of roughly 300 instructions.
# Ports: LCD (2 x 40) 03 command, 02 data write, 01 status, 00 data read. UART 8251: 28h data, 29h
# status / control. 20h: bits 0-3 meter LEDs, bit 4 / 5 select a key row (10h keys 0-2, 20h keys 3-5) read
# active low on 30h bits 0-2; 30h bit 4 = ADC ready, 18h ADC data (OUT 18h-1Eh start a channel). 38h: two
# 4-bit gray-coded encoders (high nibble ADJUST, low nibble PAGE; ENC = position -> code, table 69CA).
import collections
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'art'))
from z80 import Z80  # noqa: E402

DECODE = [0x05, 0x06, 0x04, 0x03, 0x08, 0x07, 0x09, 0x0A, 0x00, 0x0F, 0x01, 0x02, 0x0D, 0x0E, 0x0C, 0x0B]
ENC = [DECODE.index(p) for p in range(16)]


class Board:
    def __init__(self, img):
        self.img = img
        self.bank = 0  # 0 = A, 1 = B
        self.ram = bytearray(0x8000)
        self.ddram = bytearray(b' ' * 0x80)
        self.cgram = bytearray(64)
        self.addr = 0
        self.cg = False
        self.row = 0          # last key row selected on port 20h
        self.keys = set()     # key bits pressed: 0-2 row 10h, 3-5 row 20h
        self.adjust = 0       # encoder positions 0-15
        self.page = 0
        self.rx = collections.deque()
        self.tx = []
        self.uart_mode = True
        self.outlog = collections.Counter()
        self.inlog = collections.Counter()
        self.on_out = None
        self.cpu = Z80(self.read, self.write, self.port_in, self.port_out)

    def read(self, a):
        if a < 0x8000:
            return self.img[self.bank * 0x8000 + a]
        return self.ram[a - 0x8000]

    def write(self, a, v):
        if a >= 0x8000:
            self.ram[a - 0x8000] = v

    def port_in(self, p):
        p &= 0xFF
        self.inlog[p] += 1
        if p == 0x01:
            return self.addr & 0x7F  # never busy
        if p == 0x00:  # LCD data read
            if self.cg:
                v = self.cgram[self.addr & 0x3F]
                self.addr = (self.addr + 1) & 0x3F
            else:
                v = self.ddram[self.addr & 0x7F]
                self.addr = self._next(self.addr)
            return v
        if p == 0x29:  # 8251 status: TxRDY, TxEMPTY, RxRDY when a byte waits
            return 0x05 | (0x02 if self.rx else 0)
        if p == 0x28:
            return self.rx.popleft() if self.rx else 0
        if p == 0x30:
            v = 0xFF & ~0x10  # ADC never ready
            if self.row & 0x10:
                v &= ~sum(1 << k for k in self.keys if k < 3)
            if self.row & 0x20:
                v &= ~sum(1 << (k - 3) for k in self.keys if k >= 3)
            return v & 0xFF
        if p == 0x38:
            return (ENC[self.adjust & 15] << 4) | ENC[self.page & 15]
        return 0xFF

    def port_out(self, p, v):
        p &= 0xFF
        self.outlog[p] += 1
        if self.on_out:
            self.on_out(p, v)
        if p == 0x80:
            self.bank = 0
        elif p == 0x40:
            self.bank = 1
        elif p == 0x20:
            self.row = v & 0x30
        elif p == 0x28:
            self.tx.append(v)
        elif p == 0x03:
            if v & 0x80:
                self.addr = v & 0x7F
                self.cg = False
            elif v & 0x40:
                self.addr = v & 0x3F
                self.cg = True
            elif v == 0x01:
                self.ddram[:] = b' ' * 0x80
                self.addr = 0
                self.cg = False
            elif v & 0xFE == 0x02:
                self.addr = 0
        elif p == 0x02:
            if self.cg:
                self.cgram[self.addr & 0x3F] = v
                self.addr = (self.addr + 1) & 0x3F
            else:
                self.ddram[self.addr & 0x7F] = v
                self.addr = self._next(self.addr)

    @staticmethod
    def _next(a):
        # two-line mode: 00-27 line 1, 40-67 line 2; the counter runs from 27 to 40 and from 67 to 00
        a = (a + 1) & 0x7F
        return 0x40 if a == 0x28 else 0x00 if a == 0x68 else a

    def lcd(self):
        return (bytes(self.ddram[0:40]).decode('latin-1'), bytes(self.ddram[0x40:0x68]).decode('latin-1'))

    def peek(self, a, n=1):
        return bytes(self.read((a + i) & 0xFFFF) for i in range(n))

    def poke(self, a, data):
        for i, v in enumerate(data):
            self.write(a + i, v)

    def irq(self):
        """Take a mode-1 interrupt when enabled."""
        c = self.cpu
        if c.iff:
            c.iff = 0
            c.halted = False
            c.push(c.pc)
            c.pc = 0x38
            return True
        return False
