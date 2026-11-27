# Lexicon LXP-15 panel driver: runs the v2.00 firmware in the Z80 emulator from its system start (00E5:
# the power-up tests before it need the slave processor) and works the panel: six keys, the ADJUST and
# PAGE encoders, MIDI in / out through the 8251.
#   e = Emu(img); e.boot(); e.press(k); e.turn('adjust', +1); e.lcd(); e.snap() / e.restore(s)
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lxp15_board import Board  # noqa: E402

IRQ_EVERY = 300
SOFT = [5, 4, 3, 2, 1]   # board key bits of soft buttons 1-5 (left to right)
VIEW = 0                 # board key bit of VIEW
EDIT = 0xA180            # the active setup's register part (67 bytes); setup parameters follow elsewhere
SCREEN = 0xADEB          # 80-character display buffer the firmware composes (line 1, line 2)
COMPOSED = 0x01C6        # common-page instruction reached right after a compose (display refresh)
ACCEL = 0xA6A2           # ADJUST: interrupts since the last detent, fast-turn count (68EF)


class Emu:
    def __init__(self, img):
        self.b = Board(img)
        self.c = self.b.cpu
        self.n = 0
        self.composes = 0
        self.c.hooks[COMPOSED] = self._composed

    def _composed(self, cpu):
        self.composes += 1
        return False

    def run(self, steps):
        c, b = self.c, self.b
        n = self.n
        end = n + steps
        while n < end:
            c.step()
            n += 1
            if n % IRQ_EVERY == 0:
                b.irq()
        self.n = n

    def boot(self, steps=3_000_000):
        self.c.pc = 0x00E5
        self.run(steps)

    def lcd(self):
        return self.b.lcd()

    def screen(self):
        """The last composed 80 characters as (line 1, line 2)."""
        s = bytes(self.b.peek(SCREEN, 80)).decode('latin-1')
        return s[:40], s[40:]

    def drain(self, chunk=1_500, idle=6_000, limit=2_000_000):
        """Run until the UART has sent a whole message (ends F7) and nothing more follows for `idle` steps."""
        tx = bytes(self.take_tx())
        spent = quiet = 0
        while spent < limit:
            self.run(chunk)
            spent += chunk
            more = bytes(self.take_tx())
            if more:
                tx += more
                quiet = 0
            else:
                quiet += chunk
                if quiet >= idle and (not tx or tx[-1] == 0xF7):
                    break
        return tx

    def adj(self, d, quiet=6_000, wait=90_000, chunk=1_500):
        """One ADJUST detent (d = +1 / -1), slow enough for no acceleration. -> (tx bytes, screen after the
        refresh that follows the change) or (b'', None) when nothing changed."""
        self.take_tx()
        self.b.poke(ACCEL, bytes([0xFF, 0x00]))  # ADJUST timers: long since the last detent (no acceleration)
        self.b.adjust = (self.b.adjust + (1 if d > 0 else -1)) & 15
        self.run(quiet)
        tx = bytes(self.take_tx())
        spent = quiet
        while not tx and spent < wait:
            self.run(chunk)
            spent += chunk
            tx += bytes(self.take_tx())
        if not tx:
            return b'', None
        c0 = self.composes
        self.b.tx = list(tx)
        tx = self.drain(chunk)
        spent = 0
        while self.composes == c0 and spent < 400_000:
            self.run(chunk)
            spent += chunk
        tx += bytes(self.take_tx())
        return tx, self.screen()

    def fast(self, d, n, gap=10_000):
        """n quick detents (the firmware accelerates them)."""
        step = 1 if d > 0 else -1
        self.take_tx()
        for _ in range(n):
            self.b.adjust = (self.b.adjust + step) & 15
            self.run(gap)
        return self.drain()

    def press(self, k, hold=60_000, after=200_000):
        self.b.keys = {k}
        self.run(hold)
        self.b.keys = set()
        self.run(after)

    def turn(self, which, d, each=30_000, after=150_000):
        step = 1 if d > 0 else -1
        for _ in range(abs(d)):
            setattr(self.b, which, (getattr(self.b, which) + step) & 15)
            self.run(each)
        self.run(after)

    def midi_in(self, data, after=300_000):
        self.b.rx.extend(data)
        self.run(after)

    def take_tx(self):
        t = self.b.tx
        self.b.tx = []
        return t

    # ------------------------------------------------------------ state
    def snap(self):
        c, b = self.c, self.b
        return {
            'cpu': (list(c.r), c.f, c.ix, c.iy, c.sp, c.pc, list(c.alt), c.altf, c.i, c.rr, c.iff, c.halted),
            'ram': bytes(b.ram), 'dd': bytes(b.ddram), 'cg': bytes(b.cgram),
            'misc': (b.bank, b.addr, b.cg, b.row, set(b.keys), b.adjust, b.page, list(b.rx), list(b.tx)), 'n': self.n,
        }

    def restore(self, s):
        c, b = self.c, self.b
        (r, c.f, c.ix, c.iy, c.sp, c.pc, alt, c.altf, c.i, c.rr, c.iff, c.halted) = s['cpu']
        c.r = list(r)
        c.alt = list(alt)
        b.ram[:] = s['ram']
        b.ddram[:] = s['dd']
        b.cgram[:] = s['cg']
        (b.bank, b.addr, b.cg, b.row, keys, b.adjust, b.page, rx, tx) = s['misc']
        b.keys = set(keys)
        b.rx = copy.copy(b.rx.__class__(rx))
        b.tx = list(tx)
        self.n = s['n']

    def peek(self, a, n=1):
        return self.b.peek(a, n)

    def poke(self, a, data):
        self.b.poke(a, data)
