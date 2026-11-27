# Viscount EFX-10 board model for the 8051 emulator (tools/alesis/i8051.py).
# 128 KB EPROM: code fetches and MOVC read the low 64 KB; MOVX reads at 8000-FFFF read the high 64 KB
# (image 10000 + address); with P1.7 low, MOVX reads at 0000-7FFF also read the high half (DSP tables,
# factory user presets); otherwise 0000-7FFF is RAM (edit buffer 3D80, user presets 2000 + n*40h,
# program change table 3F00, settings 3FC0). MOVX writes at 8000+ go to the DSP and the port latch E000.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'alesis'))
from i8051 import Cpu  # noqa: E402


class XMem:
    def __init__(self, img, cpu):
        self.img = img
        self.cpu = cpu
        self.ram = bytearray(0x8000)
        self.dsp = []
        self.logging = False   # record DSP / latch writes in self.dsp

    def __getitem__(self, a):
        if a >= 0x8000 or not (self.cpu.ram[0x90] & 0x80):
            return self.img[0x10000 + a]
        return self.ram[a]

    def __setitem__(self, a, v):
        if a < 0x8000 and (self.cpu.ram[0x90] & 0x80):
            self.ram[a] = v & 0xff
        elif self.logging:
            self.dsp.append((a, v & 0xff))


def ret_hook(cpu):
    return True


# routines skipped in emulation: LCD transfers and delays
SKIP = [0x0a49, 0x0a6c, 0x0a7c, 0x0ad2, 0x0b31]


def short_wait(cpu):
    # 4065: the level ramp's wait (B x 20 loops per step): once is enough here
    cpu.b = 1
    return False


def interrupt_done(cpu):
    # 9EB0: the DSP update waits for an interrupt to clear 22.0 (no interrupts run here)
    cpu.setbit(0x10, 0)
    return False


def make(img):
    cpu = Cpu(img[:0x10000])
    cpu.x = XMem(img, cpu)
    for a in SKIP:
        cpu.hooks[a] = ret_hook
    cpu.hooks[0x4065] = short_wait
    cpu.hooks[0x9eb0] = interrupt_done
    return cpu


def lcd(cpu):
    """The LCD buffer (IRAM 80h-9Fh) as two 16-character lines."""
    s = ''.join(chr(cpu.hi[i]) if 32 <= cpu.hi[i] < 127 else '~%02x' % cpu.hi[i] for i in range(32))
    return s


def run_until(cpu, stops, limit=2000000):
    n = 0
    while cpu.pc not in stops:
        cpu.step()
        n += 1
        if n > limit:
            raise RuntimeError('step limit at %04x' % cpu.pc)
    return cpu.pc
