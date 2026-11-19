"""List the JV-2080 edit screens with each field's parameter ID (v1.02 flash image).

Screen table (0x0E078ECC, 288 screens): 12-byte records [u32 text][u32 fields][u16 count][u16 flags].
Text: title, subtitle, then [x][y](glyph)label\\0 entries, 0xFF ends.
Fields: 16-byte records [u16 field][u8][u8][u16 display][u16 arg][u16][u8 x][u8 y][nav x4].
Field table (0x0E08C0AC): 8 bytes per field, u16 parameter ID first.

usage: python3 -I jv2080_screens.py <jv2080_v102.bin> [filter-hex-ids]
"""
import re
import struct
import sys

BASE = 0x0E000000
SCREENS = 0x078ECC
FIELDS = 0x08C0AC


def main():
    d = open(sys.argv[1], 'rb').read()
    want = None
    if len(sys.argv) > 2:
        want = set()
        for part in sys.argv[2].split(','):
            a, _, b = part.partition('-')
            want.update(range(int(a, 16), int(b or a, 16) + 1))
    r = SCREENS
    while True:
        text, items, count, flags = struct.unpack_from('>IIHH', d, r)
        if not (BASE <= text < BASE + len(d)):
            break
        t = text - BASE
        end = d.find(b'\xff', t)
        labels = []
        for m in re.finditer(rb'([\x00-\x3f])([\x00-\x0f])\x01?([\x20-\x7e]{2,})\x00', d[t:end + 1]):
            labels.append((m.group(1)[0], m.group(2)[0], m.group(3).decode()))
        title = ' / '.join(s.strip() for s in re.findall(r'[\x20-\x7e]{3,}', d[t:t + 40].decode('latin-1'))[:2])
        fields = []
        if BASE <= items < BASE + len(d):
            for i in range(count):
                a = items - BASE + i * 16
                fid, = struct.unpack_from('>H', d, a)
                disp, arg = struct.unpack_from('>HH', d, a + 4)
                x, y = d[a + 10], d[a + 11]
                pid, = struct.unpack_from('>H', d, FIELDS + fid * 8)
                fields.append((fid, pid, disp, arg, x, y))
        if want is None or any(f[1] in want for f in fields):
            print(f'screen {r + BASE:08x}  {title}')
            print('   labels:', '; '.join(f'({x},{y}) {s}' for x, y, s in labels))
            for fid, pid, disp, arg, x, y in fields:
                mark = ' <==' if want and pid in want else ''
                print(f'   field {fid:03x} -> param {pid:03x}  disp {disp:04x}/{arg:04x} at ({x},{y}){mark}')
        r += 12


if __name__ == '__main__':
    main()
