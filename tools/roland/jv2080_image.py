"""Rebuild the Roland JV-2080 flash image from the v1.02 updater.

The updater (JV2080 (1.02).exe) is an LZH self-extractor holding MIDI files. Each file is
a run of DT1 messages to model 6A at address 70 aa bb cc: 256 seven-bit data bytes that
carry 224 bytes. Every group of 8 holds the high bits first (bit 0 = first byte's bit 7),
then 7 low-bit bytes. The 7-bit address (aa << 14 | bb << 7 | cc) is the byte offset.

usage: python3 -I jv2080_image.py <folder with the extracted .mid files> <out.bin>
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smf_sysex import sysex_messages  # noqa: E402


def unpack87(b):
    out = bytearray()
    for k in range(0, len(b), 8):
        g = b[k:k + 8]
        hi = g[0]
        for i, x in enumerate(g[1:]):
            out.append(x | (((hi >> i) & 1) << 7))
    return bytes(out)


def build(folder):
    image = bytearray(b'\xff' * (2 << 20))
    count = 0
    for path in sorted(glob.glob(os.path.join(folder, '*.mid'))):
        for m in sysex_messages(path):
            if m[:5] != bytes([0xF0, 0x41, 0x10, 0x6A, 0x12]) or m[5] != 0x70:
                continue
            body = m[9:-2]
            if (sum(m[5:-2]) + m[-2]) & 0x7F:
                raise ValueError(f'{path}: checksum error')
            addr = (m[6] << 14) | (m[7] << 7) | m[8]
            data = unpack87(body)
            image[addr:addr + len(data)] = data
            count += 1
    return bytes(image), count


if __name__ == '__main__':
    img, n = build(sys.argv[1])
    open(sys.argv[2], 'wb').write(img)
    print(f'{n} messages, wrote {len(img)} bytes to {sys.argv[2]}')
