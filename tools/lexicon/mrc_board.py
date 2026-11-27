# Lexicon MRC (MIDI Remote Controller) v4.00 memory model for the Z80 emulator (tools/art/z80.py): the MRC is
# the display of the LXP-1 and LXP-5 (neither has a screen), so their parameter names and value texts are in
# its firmware. U102 (64 KB) is two 32 KB banks seen at 0000-7FFF (bank A: the LXP-1, LXP-5 and LXP-15
# modules and the text formatting; each bank starts JP 80A7 and has JP 8010 at 38h), U103 at 8000-9FFF,
# U104 at A000-BFFF, RAM C000-FFFF. The 2 x 24 LCD is composed in RAM at C068h (48 bytes) and sent to ports
# 40h / 41h.
# A module's parameter record (8 bytes, from its page records): MRC slot, number of steps (FFh = 0-255),
# send routine (LXP-1: 10A0h = 8000h + v * 4000h / steps, 1112h = 4000h + v * 8000h / steps, sent as
# 5n pp with four nibbles; FFh steps: 40h / 80h per step and one step skipped above 79h), the unit's
# parameter number, display routine (HL = column slot, DE = value, BC = steps, the record's last byte on
# the stack; it writes its text at C068h + 24 + 6 * slot), last byte.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'art'))
from z80 import Z80  # noqa: E402

LCD = 0xC068


def load(u102, u103, u104, bank=0):
    a = open(u102, 'rb').read()
    return a[bank * 0x8000:(bank + 1) * 0x8000] + open(u103, 'rb').read() + open(u104, 'rb').read()


class MRC:
    def __init__(self, view):
        assert len(view) == 0xC000
        self.rom = view
        self.ram = bytearray(0x4000)
        self.ram[:] = b'\x00' * 0x4000
        self.cpu = Z80(self.read, self.write, self.port_in, lambda p, v: None)

    @staticmethod
    def port_in(p):
        return 0x00 if (p & 0xFF) == 0x42 else 0xFF  # 42h bit 7: LCD busy

    def read(self, a):
        return self.rom[a] if a < 0xC000 else self.ram[a - 0xC000]

    def write(self, a, v):
        if a >= 0xC000:
            self.ram[a - 0xC000] = v

    def w(self, a):
        return self.read(a) | (self.read(a + 1) << 8)

    def cstr(self, a):
        out = bytearray()
        while self.read(a):
            out.append(self.read(a))
            a += 1
        return out.decode('latin-1')

    def display(self, routine, value, steps, arg, slot=0):
        """Run a parameter display routine; -> the 6 characters it leaves at its column of line 2."""
        c = self.cpu
        for i in range(48):
            self.ram[LCD - 0xC000 + i] = 0x20
        c.sp = 0xFF00
        c.push(arg & 0xFF)
        c.setpair(0, steps & 0xFF)
        c.setpair(1, value & 0xFFFF)
        c.setpair(2, slot)
        c.call(routine)
        s = bytes(self.ram[LCD - 0xC000 + 24 + 6 * slot:LCD - 0xC000 + 30 + 6 * slot])
        return s.decode('latin-1')

    def screen(self, routine, max_steps=2_000_000):
        """Run a page routine (no arguments) that composes the whole LCD; -> (line 1, line 2)."""
        c = self.cpu
        c.sp = 0xFF00
        c.call(routine, max_steps=max_steps)
        s = bytes(self.ram[LCD - 0xC000:LCD - 0xC000 + 48]).decode('latin-1')
        return s[:24], s[24:]
