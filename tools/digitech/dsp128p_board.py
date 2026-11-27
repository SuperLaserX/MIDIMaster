# Memory model of the DigiTech DSP-128 Plus (HD6303, 32 KB EPROM at 8000-FFFF) for running its firmware in
# tools/yamaha/hd6303.py:
#   0000-001F  internal registers (SCI, timer, ports)
#   0020-007F  nothing: reads float, so they return the address byte the CPU fetched last (the firmware's
#              "andb $7F" in its character routine F687 masks with 7Fh this way)
#   0080-00FF  internal RAM (the 4-character display buffers live here)
#   2000-2006  outputs: DSP address / data latches (2000-2003), LED digit and lamp latches (2004-2006)
#   2008/2009  key inputs (active low; idle 2008 = 0Fh, 2009 = 00h: the standard panel, key codes 3xh)
#   4000-5FFF  RAM (battery backed: 47FFh = 99h after the first power-up; programs 5000-55FF)
#   6000-7FFF  expansion socket: empty (reads FFh, so the firmware keeps its 15 configurations)
#   8000-FFFF  EPROM
#
# Display texts: the firmware turns characters into 7-segment codes with its font (F6B0: '0' onwards, the
# digits again at E069 for numbers). Board(image, ascii=True) replaces both tables in its own copy of the
# image so that every character's code is (character << 1) (characters the real font shows blank stay 0),
# bit 0 being the decimal point as on the unit; lcd() then reads the four display bytes back as text.
#   b = Board(image); b.boot(); b.text()

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'yamaha'))
from hd6303 import HD6303, Halt  # noqa: E402,F401

MAIN_LOOP = 0xE07A
SHIFT_LOOP = 0xF203  # lsrd / dex / bne in the type-0F record handler: X can be 0 (65536 rounds)
WAIT_PRESS, WAIT_RELEASE = 0xE011, 0xE023  # the error display (DFA4, e.g. "bAtt") waits for any key
FONT = 0xF6B0   # character 30h onwards, 50h entries
HEX = 0xE069    # 16 hex digits + blank (E079) for numbers
RX_GAP = 300    # instructions between received bytes (MIDI: 320 us)
STACK = 0x47F0  # below the firmware's own stack top (47FE)


def real_font(img):
    f = {}
    for i in range(0x50):
        f[0x30 + i] = img[FONT - 0x8000 + i]
    return f


class Board:
    def __init__(self, image, ascii=True):
        rom = bytearray(image)
        self.font = real_font(image)
        if ascii:
            for i in range(0x50):
                c = 0x30 + i
                rom[FONT - 0x8000 + i] = 0 if self.font[c] == 0 else (c << 1) & 0xFF
            for i, ch in enumerate('0123456789ABCDEF'):
                rom[HEX - 0x8000 + i] = ord(ch) << 1
            rom[HEX - 0x8000 + 16] = 0
        self.rom = bytes(rom)
        self.ram = bytearray(0x2000)   # 4000-5FFF
        self.iram = bytearray(0x100)   # 0000-00FF (registers + internal RAM)
        self.io = bytearray(0x10)
        self.keys = 0x3F               # key code held (3Fh = none)
        self.tx = []
        self.rx = []
        self.last_rx = self.last_tx = 0
        self.dsp = []                  # DSP writes (address, data) the firmware made
        self.cpu = HD6303(self.read, self.write)
        self.cpu.hooks[SHIFT_LOOP] = self.fast_shift

    @staticmethod
    def fast_shift(c):
        """F203: lsrd / dex / bne, X times (65536 when X is 0): done at once."""
        n = c.x or 0x10000
        c.d = c.d >> n if n < 16 else 0
        c.x = 0
        c.pc = SHIFT_LOOP + 4
        return True

    def read(self, a):
        if a >= 0x8000:
            return self.rom[a - 0x8000]
        if 0x4000 <= a < 0x6000:
            return self.ram[a - 0x4000]
        if a < 0x100:
            if a == 0x11:  # TRCSR: TDRE at MIDI speed, RDRF while bytes wait, the enable bits as written
                tdre = 0x20 if self.cpu.steps - self.last_tx >= RX_GAP else 0
                return (self.iram[0x11] & 0x1F) | tdre | (0x80 if self.rx else 0)
            if a == 0x12:
                return self.rx.pop(0) if self.rx else 0
            if a == 0x06:
                return 0x04  # port 3: the key debounce count the timer interrupt reloads
            if 0x20 <= a < 0x80:
                return a & 0xFF  # floating bus: the operand byte fetched last
            return self.iram[a]
        if a == 0x2008:
            return 0xF0 | (self.keys & 0x0F)
        if a == 0x2009:
            return (self.keys >> 2) & 0x0C if (self.keys & 0x30) != 0x30 else 0x00
        if 0x6000 <= a < 0x8000:
            return 0xFF
        return 0xFF

    def write(self, a, v):
        if 0x4000 <= a < 0x6000:
            self.ram[a - 0x4000] = v
        elif a < 0x100:
            if a == 0x13:
                self.tx.append(v)
                self.last_tx = self.cpu.steps
            self.iram[a] = v
        elif 0x2000 <= a < 0x2010:
            self.io[a - 0x2000] = v

    # ------------------------------------------------------------------ memory helpers
    def peek(self, a):
        return self.read(a) if a not in (0x11, 0x12) else self.iram[a]

    def poke(self, a, v):
        if 0x4000 <= a < 0x6000:
            self.ram[a - 0x4000] = v & 0xFF
        elif a < 0x100:
            self.iram[a] = v & 0xFF

    def mem(self, a, n):
        return bytes(self.peek(a + i) for i in range(n))

    def setmem(self, a, data):
        for i, v in enumerate(data):
            self.poke(a + i, v)

    @staticmethod
    def decode(codes):
        """Four display bytes (leftmost first) in the ASCII encoding back to text; '.' after a decimal point."""
        s = ''
        for v in codes:
            ch = ' ' if (v >> 1) == 0 else chr(v >> 1)
            s += {':': ' .', ';': '-'}.get(ch, ch)  # the font: ':' is the point alone, ';' segment g alone (a minus)
            if v & 1:
                s += '.'
        return s

    def text(self, base=0x90):
        """The composition buffer 90-93 (93h leftmost) as text."""
        return self.decode([self.iram[base + 3], self.iram[base + 2], self.iram[base + 1], self.iram[base]])

    def shown(self):
        """The buffer the display scans now (pointer 8Fh, four bytes, leftmost first)."""
        p = self.iram[0x8F]
        return self.decode([self.iram[(p + i) & 0xFF] for i in range(4)])

    # ------------------------------------------------------------------ running
    def run_until(self, pc, max_steps=5_000_000, ocf_every=2000):
        c = self.cpu
        n = 0
        while c.pc != pc:
            if c.pc == WAIT_PRESS and self.keys == 0x3F:
                self.keys = 0x3E  # acknowledge a message with a key
            elif c.pc == WAIT_RELEASE and self.keys != 0x3F:
                self.keys = 0x3F
            c.step()
            n += 1
            if ocf_every and n % ocf_every == 0:
                c.interrupt(0xFFF4)
            elif (self.iram[0x11] & 0x04 and c.steps - self.last_tx >= RX_GAP) or \
                    (self.rx and self.iram[0x11] & 0x10 and c.steps - self.last_rx >= RX_GAP):
                if c.interrupt(0xFFF0):
                    self.last_rx = c.steps
            if n > max_steps:
                raise Halt('no %04X after %d steps (pc %04X)' % (pc, n, c.pc))
        return n

    def boot(self):
        c = self.cpu
        c.reset()
        self.run_until(MAIN_LOOP, max_steps=20_000_000)
        self.loop(4)

    def loop(self, times=4):
        for _ in range(times):
            self.cpu.step()
            self.run_until(MAIN_LOOP)

    def call(self, addr, max_steps=2_000_000):
        return self.cpu.call(addr, sp=STACK, max_steps=max_steps)

    def receive(self, data, settle=8):
        """Feed MIDI bytes through the SCI interrupt and let the main loop parse its queue (4800h, BC/BE)."""
        self.rx.extend(data)
        while self.rx or self.mem(0xBC, 2) != self.mem(0xBE, 2):
            self.cpu.step()
            self.run_until(MAIN_LOOP, max_steps=40_000_000)
        self.loop(settle)

    def press(self, code, hold=60_000, release=60_000):
        """Hold a key (its code as the timer interrupt reads it) and release it, the main loop running."""
        self.keys = code
        self.run_for(hold)
        self.keys = 0x3F
        self.run_for(release)

    def run_for(self, steps, ocf_every=2000):
        c = self.cpu
        for n in range(1, steps + 1):
            c.step()
            if n % ocf_every == 0:
                c.interrupt(0xFFF4)
            elif (self.iram[0x11] & 0x04 and c.steps - self.last_tx >= RX_GAP) or \
                    (self.rx and self.iram[0x11] & 0x10 and c.steps - self.last_rx >= RX_GAP):
                if c.interrupt(0xFFF0):
                    self.last_rx = c.steps
