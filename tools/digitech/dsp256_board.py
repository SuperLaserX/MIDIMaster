# Memory model of the DigiTech DSP-256 (HD6303, 64 KB EPROM of which 2000-FFFF is mapped) for running its
# firmware in tools/yamaha/hd6303.py: internal registers 0000-001F, RAM 0020-1FFF (8 KB, with the HD44780
# LCD at 0100 instruction / 0101 data and output latches 0300-0305 inside it), EPROM 2000-FFFF.
# The LCD text is kept as the firmware keeps it too: its shadow buffer 04C2-04E1 (2 x 16 characters).
#   b = Board(image); b.boot(); b.key(code); b.lcd()

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'yamaha'))
from hd6303 import HD6303, Halt  # noqa: E402,F401

LCD_BUF = 0x04C2
MAIN_LOOP = 0x3E62
KEY_FLAG, KEY_CODE = 0x83, 0xAE
WAIT_KEY = 0x4415  # S43D6 shows a message and waits for $83 (any key)
RX_GAP = 300  # instructions between received bytes (MIDI: 320 us, about 600 cycles at 2 MHz)
STACK = 0x1FF0  # below the firmware's own stack top (1FFE), above the dump area (08CE-1F23)
WAIT_REPEAT = 0x51F7  # S51E8 waits for the repeat delay or a new key event


class Board:
    def __init__(self, image, layout=None):
        L = layout or {}
        self.lcd_buf = L.get('LCD_BUF', LCD_BUF)
        self.main_loop = L.get('MAIN_LOOP', MAIN_LOOP)
        self.wait_key = L.get('WAIT_KEY', WAIT_KEY)
        self.wait_repeat = L.get('WAIT_REPEAT', WAIT_REPEAT)
        self.rom = image
        self.ram = bytearray(0x2000)
        self.tx = []  # bytes the SCI sent
        self.rx = []  # bytes waiting in the SCI receiver
        self.last_rx = self.last_tx = 0
        self.cpu = HD6303(self.read, self.write)

    def read(self, a):
        if a >= 0x2000:
            return self.rom[a]
        if a == 0x0100:
            return 0x00  # LCD never busy
        if a == 0x11:  # TRCSR: TDRE always, RDRF while bytes wait, the enable bits as written
            tdre = 0x20 if self.cpu.steps - self.last_tx >= RX_GAP else 0
            return (self.ram[0x11] & 0x1F) | tdre | (0x80 if self.rx else 0)
        if a == 0x12:
            return self.rx.pop(0) if self.rx else 0
        return self.ram[a]

    def write(self, a, v):
        if a >= 0x2000:
            return
        if a == 0x13:
            self.tx.append(v)
            self.last_tx = self.cpu.steps
        self.ram[a] = v

    def lcd(self):
        b = self.ram[self.lcd_buf:self.lcd_buf + 32]
        t = ''.join(chr(c) if 32 <= c < 127 else '~' for c in b)
        return t[:16], t[16:]

    def run_until(self, pc, max_steps=3_000_000, ocf_every=4000):
        c = self.cpu
        n = 0
        while c.pc != pc:
            if c.pc == self.wait_key and not self.ram[KEY_FLAG]:
                self.ram[KEY_FLAG] = 1  # acknowledge a message that waits for any key
            if c.pc == self.wait_repeat and not self.ram[KEY_FLAG]:
                self.ram[KEY_FLAG] = 1  # release a key before its auto-repeat
                self.ram[KEY_CODE] = 0
            c.step()
            n += 1
            if ocf_every and n % ocf_every == 0:
                c.interrupt(0xFFF4)
            elif (self.ram[0x11] & 0x04 and c.steps - self.last_tx >= RX_GAP) or (self.rx and self.ram[0x11] & 0x10 and c.steps - self.last_rx >= RX_GAP):
                if c.interrupt(0xFFF0):  # SCI: the transmitter empty (TIE) or a byte received (RIE), at MIDI speed
                    self.last_rx = c.steps
            if n > max_steps:
                raise Halt('no %04X after %d steps (pc %04X)' % (pc, n, c.pc))
        return n

    def boot(self):
        c = self.cpu
        c.reset()
        self.run_until(self.main_loop)
        # let the main loop settle
        for _ in range(3):
            c.step()
            self.run_until(self.main_loop)

    def loop(self, times=4):
        c = self.cpu
        for _ in range(times):
            c.step()
            self.run_until(self.main_loop)

    def call(self, addr, max_steps=2_000_000):
        return self.cpu.call(addr, sp=STACK, max_steps=max_steps)

    def receive(self, data, settle=8):
        """Feed MIDI bytes through the SCI interrupt and let the main loop parse them."""
        self.rx.extend(data)
        r = self.ram
        while self.rx or (r[0x85], r[0x86]) != (r[0x8B], r[0x8C]):  # until the 100-byte queue (0725h) is parsed
            self.cpu.step()
            self.run_until(self.main_loop, max_steps=20_000_000)  # a dump request holds the main loop while it sends
        self.loop(settle)

    def key(self, code, settle=4):
        self.ram[KEY_CODE] = code
        self.ram[KEY_FLAG] = 1
        self.loop(settle)
