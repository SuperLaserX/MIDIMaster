"""Yamaha DX200 OS update (a standard MIDI file of SysEx, z:/firmwares/Yamaha/DX200/DX2_V101.MID) ->
a flash image candidate and a message summary. Read only: it never runs anything from the update.

Usage: python -I tools/yamaha/dx200_update.py FILE.MID OUTDIR [msb|lsb]

What the file holds (all Yamaha, model 67h; 4293 messages):
  F0 43 10 67 00 7F 7F 7F 7F "LDTAN DL" F7   / F0 43 10 67 0F "LDT^AN^PRG" F7   loader start texts
  73 data messages before the first block (a RAM loader, about 16 KB)
  per block (6 blocks):
    F0 43 10 67 01 00 s2 s1 s0 F7            block start; s = 21-bit value (7 bits each): 4004h, 2FFFCh,
                                             5BFF4h, 87FECh, B3FE4h, DFFDCh (each 2BFF8h after the last)
    F0 43 00 67 01 10 0A 7F 00 <146> cs F7   a 155-byte record (tables in plain bytes)
    F0 43 00 67 02 a3 a2 a1 a0 <256> cs F7   data, a = offset (7 bits each) stepping by 224: the 256
                                             bytes are 32 groups of a high-bit byte and 7 low-bit bytes
    F0 43 10 67 03 00 s2 s1 s0 ...  F7       block end (sums)
  F0 43 10 67 0E 00 40 00 00 02 3F 37 F7     the end
The readme (Japanese, Shift-JIS) says the unit shows the checksum 9FB7 when the update is done.

State (2026-11-26): the image this writes is NOT verified: neither bit order of the 7-bit groups
gives readable text or clear H8 code, the data checksums do not add up with the usual Yamaha sum,
and the block start values are not plain addresses, so the data may be compressed or scrambled.
The DX200 has a 7-segment LED only, so its firmware holds no screen texts.
"""
import os
import re
import sys


def vlq(t, i):
    v = 0
    while True:
        c = t[i]; i += 1
        v = (v << 7) | (c & 0x7f)
        if c < 0x80:
            return v, i


def read_sysex(path):
    """The SysEx messages of a standard MIDI file, in file order (F0 ... F7)."""
    d = open(path, 'rb').read()
    pos = 14
    msgs = []
    while pos < len(d):
        ln = int.from_bytes(d[pos + 4:pos + 8], 'big')
        t = d[pos + 8:pos + 8 + ln]
        pos += 8 + ln
        i = 0
        run = 0
        while i < len(t):
            _, i = vlq(t, i)
            st = t[i]
            if st == 0xff:
                n, i = vlq(t, i + 2)
                i += n
            elif st in (0xf0, 0xf7):
                n, i = vlq(t, i + 1)
                msgs.append(bytes(([0xf0] if st == 0xf0 else []) + list(t[i:i + n])))
                i += n
            else:
                if st & 0x80:
                    run = st; i += 1
                i += 2 if (run & 0xf0) not in (0xc0, 0xd0) else 1
    return msgs


def unpack7(body, msb_first=True):
    """Groups of 8: seven low-bit bytes, then the byte of their high bits (bit 6 = the first byte when
    msb_first, else bit 0)."""
    out = bytearray()
    for g in range(0, len(body) - 7, 8):
        hi = body[g + 7]
        for k in range(7):
            bit = (hi >> (6 - k)) & 1 if msb_first else (hi >> k) & 1
            out.append(body[g + k] | (bit << 7))
    return bytes(out)


def main():
    msgs = read_sysex(sys.argv[1])
    out = sys.argv[2]
    msb = (sys.argv[3] if len(sys.argv) > 3 else 'msb') == 'msb'
    os.makedirs(out, exist_ok=True)
    blocks = []  # [start, length, [(offset, bytes)]]
    loader = []
    cur = None
    for m in msgs:
        if len(m) == 10 and m[3] == 0x67 and m[2] & 0xf0 == 0x10 and m[4] == 0x01:
            cur = [(m[6] << 14) | (m[7] << 7) | m[8], None, []]
            blocks.append(cur)
        elif len(m) > 12 and m[3] == 0x67 and m[2] & 0xf0 == 0x10 and m[4] == 0x03 and cur:
            cur[1] = (m[9] << 14) | (m[10] << 7) | m[11]  # block length (0A 7F 78 = 2BFF8h)
        elif len(m) == 267 and m[4] == 0x02:
            a = (m[5] << 21) | (m[6] << 14) | (m[7] << 7) | m[8]
            (cur[2] if cur else loader).append((a, unpack7(m[9:9 + 256], msb)))
        elif m[2] & 0xf0 == 0 and m[3] == 0x67 and m[4] == 0x01 and cur:
            # the rest of the block after the full data messages: offset in bytes 6-8, then data
            a = (m[6] << 14) | (m[7] << 7) | m[8]
            cur[2].append((a, unpack7(m[9:-2], msb)))
    image = bytearray([0xff] * 0x100000)
    with open(os.path.join(out, 'summary.txt'), 'w') as f:
        f.write('messages %d, loader %d data messages' % (len(msgs), len(loader)) + chr(10))
        for s, ln, data in blocks:
            f.write('block start %06X length %s: %d data messages' % (s, '%06X' % ln if ln else '?', len(data)) + chr(10))
            for a, d in data:
                if ln:
                    d = d[:max(0, ln - a)]
                image[s + a:s + a + len(d)] = d
    size = max(a + len(d) for a, d in loader)
    img = bytearray([0xff] * size)
    for a, d in loader:
        img[a:a + len(d)] = d
    open(os.path.join(out, 'loader.bin'), 'wb').write(bytes(img))
    open(os.path.join(out, 'dx200_v101.bin'), 'wb').write(bytes(image))
    print('wrote', out, 'blocks', len(blocks))


if __name__ == '__main__':
    main()
