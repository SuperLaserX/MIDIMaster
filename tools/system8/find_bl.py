"""Find Thumb-2 BL / B.W instructions in the SYSTEM-8 OS dump that target given addresses.

Ghidra's auto-analysis misses calls from code it did not disassemble; this scans every halfword.
Usage: python -I tools/system8/find_bl.py re/system8/osdump/os_full.bin 0x60079114 [more targets...]
"""
import struct
import sys

BASE = 0x60000000


def bl_target(b, o):
    hw1, hw2 = struct.unpack_from('<HH', b, o)
    if (hw1 & 0xF800) != 0xF000:
        return None
    kind = None
    if (hw2 & 0xD000) == 0xD000:
        kind = 'BL'
    elif (hw2 & 0xD000) == 0xC000:
        kind = 'BLX'
    elif (hw2 & 0xD000) == 0x9000:
        kind = 'B.W'
    else:
        return None
    s = (hw1 >> 10) & 1
    imm10 = hw1 & 0x3FF
    j1 = (hw2 >> 13) & 1
    j2 = (hw2 >> 11) & 1
    imm11 = hw2 & 0x7FF
    i1 = 1 - (j1 ^ s)
    i2 = 1 - (j2 ^ s)
    off = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1)
    if s:
        off -= 1 << 25
    pc = BASE + o + 4
    t = pc + off
    if kind == 'BLX':
        t &= ~3
    return kind, t


def main():
    b = open(sys.argv[1], 'rb').read()
    targets = {int(x, 16) for x in sys.argv[2:]}
    for o in range(0, len(b) - 4, 2):
        r = bl_target(b, o)
        if r and r[1] in targets:
            print(f'{BASE + o:08x} {r[0]} -> {r[1]:08x}')


if __name__ == '__main__':
    main()
