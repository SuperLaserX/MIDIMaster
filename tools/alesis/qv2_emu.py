# Alesis Quadraverb 2: the v2.01e firmware run in the 8051 emulator (tools/alesis/i8051.py, qv2_board.py) as
# the front panel drives it: reset, the main loop (its timer flags ticked by hand), the key matrix (8002 /
# P1.0-P1.3), the encoder (timer 0 count in 13h:14h, flag 21.5) and its push button (P3.5, ENTER).
import os
import pickle
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qv2_board import make  # noqa: E402

MAIN = 0xdc05          # the main loop head (DF0D jumps back to it once per pass)
KEYS = {               # (column bit of 8002, row bit of P1)
    'block': (4, 0), 'k41': (4, 1), 'k42': (4, 2), 'program': (4, 3),
    'right': (5, 0), 'left': (5, 1), 'bypass': (5, 2), 'store': (5, 3),
    'config': (6, 0), 'routing': (6, 1), 'edit': (6, 2), 'mix': (6, 3),
    'global': (7, 0), 'name': (7, 1), 'midi': (7, 2), 'mod': (7, 3),
}


class QV2:
    def __init__(self, img, cache=None):
        self.img = img
        self.cpu = make(img)
        self.cpu.hooks[0x8735] = self._tick
        snap = None
        if cache and os.path.exists(cache):
            snap = pickle.load(open(cache, 'rb'))
        if snap is None:
            self.cpu.pc = 0
            n = 0
            while n < 3:
                if self.cpu.pc == MAIN:
                    n += 1
                self.cpu.step()
            while self.cpu.bit(0x28):      # the power-up banner holds the keys (25.0) until 0059 runs out
                self.run(loops=1)
            snap = self.save()
            if cache:
                pickle.dump(snap, open(cache, 'wb'))
        self.boot = snap
        self.restore()

    def midi_in(self, data):
        """Bytes into the MIDI receive ring (1000-13FF; write pointer R1 of bank 3 = 19h, page 16h)."""
        c = self.cpu
        x = self.x
        for b in data:
            x[(c.ram[0x16] << 8) | c.ram[0x19]] = b
            c.ram[0x19] = (c.ram[0x19] + 1) & 0xff
            if c.ram[0x19] == 0:
                c.ram[0x16] = ((c.ram[0x16] + 1) & 0x13) | 0x10

    def capture(self):
        """Collect what the firmware sends (BB94 sends A) in self.tx instead of the UART."""
        self.tx = []

        def send(c):
            self.tx.append(c.a)
            return True
        self.cpu.hooks[0xbb94] = send

    @staticmethod
    def _tick(c):
        c.setbit(0, 1)       # 20.0: timer 1 tick the wait loop 8735 needs
        return False

    def save(self):
        c = self.cpu
        return (bytes(c.ram), bytes(c.hi), bytes(c.x.ram[0]), bytes(c.x.ram[1]), c.x.bank, c.pc, c.x.ack)

    def restore(self, s=None):
        s = s or self.boot
        c = self.cpu
        c.ram[:] = s[0]
        c.hi[:] = s[1]
        c.x.ram[0][:] = s[2]
        c.x.ram[1][:] = s[3]
        c.x.bank = s[4]
        c.c = self.img[0x10000:] if s[4] else self.img[:0x10000]
        c.pc = s[5]
        c.x.ack = s[6]
        c.x.keys = set()

    @property
    def x(self):
        return self.cpu.x.ram[0]

    def lcd(self):
        return bytes(self.x[0x200:0x220])

    def run(self, loops=1, cap=5000000):
        c = self.cpu
        k = n = 0
        while True:
            if c.pc == MAIN:
                k += 1
                c.ram[0x31] = (c.ram[0x31] - 8) & 0xff    # timer 1 count: the key scan runs when bit 3 changes
                c.setbit(0, 1)
                if k > loops:
                    return
            c.step()
            n += 1
            if n > cap:
                raise RuntimeError('step cap at %04x' % c.pc)

    def settle(self, limit=60):
        """Run the main loop until a message the firmware holds on the LCD (25.0) has gone."""
        n = 0
        while self.cpu.bit(0x28) and n < limit:
            self.run(1)
            n += 1

    def press(self, key, hold=3):
        c = self.cpu
        c.x.keys = {KEYS[key] if isinstance(key, str) else key}
        self.run(hold)
        c.x.keys = set()
        c.ram[0x90] |= 0x0f
        self.run(hold)

    def turn(self, d, loops=3):
        c = self.cpu
        v = d & 0xffff
        c.ram[0x13] = v & 0xff
        c.ram[0x14] = v >> 8
        c.setbit(0x0d, 1)
        self.run(loops)

    def enter(self, hold=3):
        c = self.cpu
        c.ram[0xb0] &= 0xdf
        self.run(hold)
        c.ram[0xb0] |= 0x20
        self.run(hold)

    def call(self, addr, limit=5000000):
        self.cpu.call(addr, limit=limit)

    def group(self, g):
        self.cpu.ram[0x38] = g
        self.call(0x1d7a)

    def page(self, p):
        self.cpu.ram[0x39] = p
        self.call(0x1e78)

    def ui(self):
        c = self.cpu
        return {'mode': c.ram[0x3a], 'g': c.ram[0x38], 'ng': c.ram[0x36], 'p': c.ram[0x39], 'np': c.ram[0x37],
                'tab': (self.x[0x56] << 8) | self.x[0x57], 'rec': (self.x[0x54] << 8) | self.x[0x55]}

    def record(self):
        """The 15-byte page record of the page shown."""
        u = self.ui()
        a = u['rec'] + 15 * u['p']
        code = self.cpu.c
        return bytes(code[a:a + 15])

    def show(self, v):
        """The LCD with the page's value set to v (display routine of the page, 2471)."""
        x = self.x
        x[0x50] = (v >> 8) & 0xff
        x[0x51] = v & 0xff
        self.call(0x2471)
        return self.lcd()

    def pack(self):
        """The program as STORE and the SysEx dumps keep it (7488 into 0900-09FF)."""
        c = self.cpu
        save = (c.ram[0x30], c.ram[0xa0])
        b4 = c.bit(0x04)
        c.setbit(0x04, 1)
        c.a = 0x09
        c.ram[0x83] = 0
        self.call(0x7488)
        c.setbit(0x04, b4)
        c.ram[0x30] = save[0]
        c.ram[0xa0] = save[1]
        return bytes(self.x[0x900:0xa00])
