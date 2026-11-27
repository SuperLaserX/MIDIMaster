# Memory model of the DigiTech MEQ 28 / MEQ 14 / MEQ 7 (one HD6303RP firmware for the three models, 32 KB EPROM whose
# upper half is the program at C000-FFFF) for running it in tools/yamaha/hd6303.py:
#   0000-001F  internal registers (port 1 at 02h drives the DSP filter chips' serial lines and a serial EEPROM, bit 1
#              its answer; SCI 10h-13h; timer)
#   0020-007F  nothing: reads float, so they return the address byte (the program up / down keys compare with "$63",
#              direct address 0063h, which reads 63h = 99 this way)
#   0080-00FF  internal RAM (display bytes 89h right digit, 8Ah left digit, 8Bh lamps; LED column patterns B2h-EFh)
#   2000-2003  output latches (channel levels, bypass relays)
#   4000       inputs: the key matrix column bits 0-4 of the row selected by 4004h (low = pressed), the encoder on bits
#              6-7, and with row 7 (4004h = 7Fh) the model jumpers: bit 3 high = MEQ 14, else bit 4 high = MEQ 28,
#              else MEQ 7 (C79C)
#   4000-4006  outputs: LED column drivers (4000-4003), row select (4004), display strobes and digits (4005 / 4006)
#   8000-9FFF  RAM (battery backed: programs 816Bh-8EF3h, settings 813Dh-816Ah, MIDI ring 8F7Ah-977Ah)
#   C000-FFFF  EPROM (file offsets 4000h-7FFFh)
#
#   b = Board(image, model=1); b.boot(); b.display()
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'yamaha'))
from hd6303 import HD6303, Halt  # noqa: E402,F401

MAIN_LOOP = 0xC8FA     # jsr C90E (keys) / jsr C902 (MIDI queue) / bra
FONT = 0xD6C7          # 7-segment codes of the characters '0' (30h) onwards
KEY_RING, KEY_IN, KEY_OUT = 0x8073, 0x8083, 0x8084   # 16-entry key ring (DCC6 puts, DCDC takes)
RX_GAP = 300           # instructions between received bytes (MIDI: 320 us)
STACK = 0x8050         # below the firmware's own stack top (8062h)
MODEL_JUMPERS = {0: 0x10, 1: 0x08, 2: 0x00}   # 4000h read with row 7 (C79C): bit 3 high MEQ 14 (FC 1), else bit 4 high MEQ 28 (FC 0), else MEQ 7 (FC 2)


def segment_map(img):
    """7-segment code -> character, from the firmware's own font (digits first, then letters; duplicates keep the
    first). 40h is the minus, 00h a blank digit; 46h ("-" and "1" in one digit) and 49h (three bars) are shown by the
    level and dump pages without going through the font."""
    m = {}
    for i in range(0x50):
        c = 0x30 + i
        v = img[FONT - 0x8000 + i]
        ch = chr(c)
        if ch in ':;<=>?@[\\]^_`':
            continue
        if v and v not in m:
            m[v] = ch
    m[0x40] = '-'
    m[0x00] = ' '
    m[0x46] = '-1'
    m[0x49] = '≡'
    return m


class Board:
    def __init__(self, image, model=1):
        assert len(image) == 0x8000
        self.rom = bytes(image[0x4000:])
        self.ram = bytearray(0x2000)   # 8000-9FFF
        self.iram = bytearray(0x100)   # 0000-00FF
        self.io = bytearray(0x10)
        self.latch = bytearray(4)      # 2000-2003
        self.model = model
        self.segs = segment_map(image)
        self.tx = []
        self.rx = []
        self.last_rx = self.last_tx = 0
        self.cpu = HD6303(self.read, self.write)
        # the waits "ldaa #$FF / staa $84 / ldaa $84 / bne" (255 timer ticks): done at once
        for a in range(0xC000, 0xFFFC):
            if self.rom[a - 0xC000:a - 0xC000 + 4] == b'\x96\x84\x26\xFC':
                self.cpu.hooks[a] = self.skip_wait
        self.cpu.hooks[0xD55E] = self.no_eeprom

    @staticmethod
    def no_eeprom(c):
        """D55E (factory initialisation, MEQ 28 only): programs 1-7 to / from the serial EEPROM, which retries until the
        chip answers (DC0B / DC14). No EEPROM on this board: go on at D5A2 as the other models do."""
        c.pc = 0xD5A2
        return True

    def skip_wait(self, c):
        self.iram[0x84] = 0
        return False

    def read(self, a):
        if a >= 0xC000:
            return self.rom[a - 0xC000]
        if 0x8000 <= a < 0xA000:
            return self.ram[a - 0x8000]
        if a < 0x100:
            if a == 0x11:  # TRCSR: TDRE at MIDI speed, RDRF while bytes wait
                tdre = 0x20 if self.cpu.steps - self.last_tx >= RX_GAP else 0
                return (self.iram[0x11] & 0x1F) | tdre | (0x80 if self.rx else 0)
            if a == 0x12:
                return self.rx.pop(0) if self.rx else 0
            if a == 0x02:  # port 1: bit 1 high = no serial EEPROM answers (its writes give up, D9C1 / DA09)
                return (self.iram[0x02] & 0xFC) | 0x02
            if 0x20 <= a < 0x80:
                return a & 0xFF  # floating bus
            return self.iram[a]
        if a == 0x4000:
            row = self.io[4]
            if row == 0x7F:
                return MODEL_JUMPERS[self.model]
            return 0xFF
        return 0xFF

    def write(self, a, v):
        if 0x8000 <= a < 0xA000:
            self.ram[a - 0x8000] = v
        elif a < 0x100:
            if a == 0x13:
                self.tx.append(v)
                self.last_tx = self.cpu.steps
            self.iram[a] = v
        elif 0x2000 <= a < 0x2004:
            self.latch[a - 0x2000] = v
        elif 0x4000 <= a < 0x4010:
            self.io[a - 0x4000] = v

    # ------------------------------------------------------------------ memory helpers
    def peek(self, a):
        return self.read(a) if a not in (0x02, 0x11, 0x12) else self.iram[a]

    def poke(self, a, v):
        if 0x8000 <= a < 0xA000:
            self.ram[a - 0x8000] = v & 0xFF
        elif a < 0x100:
            self.iram[a] = v & 0xFF

    def mem(self, a, n):
        return bytes(self.peek(a + i) for i in range(n))

    def setmem(self, a, data):
        for i, v in enumerate(data):
            self.poke(a + i, v)

    def text(self, left, right):
        """Two digit codes (bit 7 = the digit's point) as text; a point after its digit ('.' alone on a blank digit)."""
        s = ''
        for v in (left, right):
            s += self.segs.get(v & 0x7F, '?')
            if v & 0x80:
                s += '.'
        return s

    def display(self):
        """The two digits as the timer interrupt shows them: 8Ah left, 89h right."""
        return self.text(self.iram[0x8A], self.iram[0x89])

    # ------------------------------------------------------------------ running
    def run_until(self, pc, max_steps=5_000_000, ocf_every=2000):
        c = self.cpu
        n = 0
        while c.pc != pc:
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

    def key(self, code):
        """Put a key code into the key ring as the timer interrupt's matrix scan does (DCC6)."""
        i = self.peek(KEY_IN)
        self.poke(KEY_RING + i, code)
        self.poke(KEY_IN, (i + 1) & 15)

    def boot(self):
        """From reset. Empty RAM fails the A5h fill check (97A5h-9FFFh): error "E1" waits for a key, then the factory
        initialisation ("FP", D4E3) and a restart."""
        c = self.cpu
        c.reset()
        if self.run_until_any((MAIN_LOOP, 0xDCDC), max_steps=40_000_000) and c.pc == 0xDCDC:
            self.boot_error = self.display()
            self.key(0x20)  # acknowledge the error display with a key
            self.run_until(MAIN_LOOP, max_steps=80_000_000)
        self.loop(4)

    def run_until_any(self, pcs, max_steps=5_000_000, ocf_every=2000):
        c = self.cpu
        n = 0
        c.step()
        while c.pc not in pcs:
            c.step()
            n += 1
            if ocf_every and n % ocf_every == 0:
                c.interrupt(0xFFF4)
            elif (self.iram[0x11] & 0x04 and c.steps - self.last_tx >= RX_GAP) or \
                    (self.rx and self.iram[0x11] & 0x10 and c.steps - self.last_rx >= RX_GAP):
                if c.interrupt(0xFFF0):
                    self.last_rx = c.steps
            if n > max_steps:
                raise Halt('none of %s after %d steps (pc %04X)' % (pcs, n, c.pc))
        return n

    def loop(self, times=4):
        for _ in range(times):
            self.cpu.step()
            self.run_until(MAIN_LOOP)

    def press(self, code, settle=3):
        """A key as the main loop takes it from the ring."""
        self.key(code)
        self.loop(settle)

    def call(self, addr, max_steps=2_000_000):
        return self.cpu.call(addr, sp=STACK, max_steps=max_steps)

    def receive(self, data, settle=8, max_steps=80_000_000):
        """Feed MIDI bytes through the SCI interrupt and let the main loop parse its queue (8F7Ah, 80E0h / 80E2h).
        A 41h message restarts the unit at its end (D289: jmp C744): run on to the main loop again."""
        self.rx.extend(data)
        while self.rx or self.mem(0x80E0, 2) != self.mem(0x80E2, 2):
            self.cpu.step()
            self.run_until(MAIN_LOOP, max_steps=max_steps)
        self.loop(settle)
        while self.iram[0x11] & 0x04:  # a dump still going out
            self.loop(1)
