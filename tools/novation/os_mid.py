"""Novation OS-update MIDI files (.mid with SysEx): list and decode.

Format (read from the loader in the SuperNova II Keyboard OS 2.0 EPROM, 000E1C-000F3A, run at
power-up "Waiting for midi O/S"): every message starts F0 00 20 29 01 mm 7F, then a type byte.

  7F start  00 v1 v2  w(0)  w(packet count)  d(image length in bytes)
  7E data   00 v1 v2  w(0)  w(packet number)  w(group count) groups  d(packet checksum)
  7D end    00 v1 v2  w(0)  d(image checksum)

w = two 7-bit bytes, low first (14 bits); d = w, w, then one byte holding bits 28-31.
A group is 8 words (16 MIDI bytes) and carries 7 16-bit words of the image, big-endian:
  out[k] = (word[k] >> 2k) | (word[k+1] << (14 - 2k)) & 0xFFFF, for k = 0..6
The packet checksum is the 32-bit sum of the packet's 16-bit image words, the image checksum the
sum of all the image's 16-bit words. v1 v2 must match the start message's. Extra bytes before F7 are ignored.

usage: python -I os_mid.py list FILE.mid             the SysEx messages (count, lengths, headers)
       python -I os_mid.py decode FILE.mid OUT.bin    decode the image (checks every checksum)
       python -I os_mid.py compare OUT.bin EPROM.bin  where the decoded image sits in an EPROM image
"""
import sys


def smf_sysex(path):
    d = open(path, 'rb').read()
    out = []
    i = 14
    while i < len(d):
        assert d[i:i + 4] == b'MTrk', d[i:i + 4]
        n = int.from_bytes(d[i + 4:i + 8], 'big')
        j, end, run = i + 8, i + 8 + n, 0
        while j < end:
            while d[j] & 0x80: j += 1
            j += 1  # delta
            st = d[j]
            if st == 0xF0 or st == 0xF7:
                j += 1
                ln = 0
                while True:
                    b = d[j]; j += 1; ln = (ln << 7) | (b & 0x7f)
                    if not b & 0x80: break
                out.append(bytes([0xF0]) + d[j:j + ln] if st == 0xF0 else d[j:j + ln]); j += ln
            elif st == 0xFF:
                ln = d[j + 2]; j += 3 + ln
            else:
                if st & 0x80: run = st; j += 1
                j += 1 if (run & 0xF0) in (0xC0, 0xD0) else 2
        i = end
    return out


class Reader:
    def __init__(self, m, pos):
        self.m, self.p = m, pos

    def byte(self):
        b = self.m[self.p]; self.p += 1
        assert b < 0x80, f'data byte {b:02x} at {self.p - 1}'
        return b

    def w(self):
        lo = self.byte()
        return (self.byte() << 7) | lo

    def d(self):
        w1 = self.w()
        w2 = self.w()
        return ((self.byte() & 15) << 28) | (w2 << 14) | w1


def decode(msgs):
    """-> (model, (v1, v2), image bytes, report dict)"""
    head = msgs[0][:6]
    assert head == bytes([0xF0, 0, 0x20, 0x29, 1, head[5]]), head.hex()
    model = head[5]
    start = [m for m in msgs if m[6:8] == b'\x7f\x7f']
    data = [m for m in msgs if m[6:8] == b'\x7f\x7e']
    end = [m for m in msgs if m[6:8] == b'\x7f\x7d']
    assert len(start) == 1 and len(end) == 1, (len(start), len(end))
    r = Reader(start[0], 8)
    assert r.byte() == 0
    ver = (r.byte(), r.byte())
    assert r.w() == 0
    count = r.w()
    length = r.d()
    assert count == len(data), (count, len(data))
    out = bytearray()
    for n, m in enumerate(data):
        r = Reader(m, 8)
        assert m[:6] == head and r.byte() == 0 and (r.byte(), r.byte()) == ver
        assert r.w() == 0
        assert r.w() == n, f'packet {n} out of order'
        groups = r.w()
        csum = 0
        for _ in range(groups):
            prev = r.w()
            for k in range(7):
                word = r.w()
                prod = word << (14 - 2 * k)
                o = (prod | prev) & 0xFFFF
                out += o.to_bytes(2, 'big')
                csum = (csum + o) & 0xFFFFFFFF
                prev = prod >> 16
        assert r.d() == csum, f'packet {n} checksum'
    r = Reader(end[0], 8)
    assert r.byte() == 0 and (r.byte(), r.byte()) == ver and r.w() == 0
    total = r.d()
    assert len(out) >= length, (len(out), length)
    img = bytes(out[:length])
    s = sum(int.from_bytes(img[i:i + 2], 'big') for i in range(0, length & ~1, 2)) & 0xFFFFFFFF
    assert s == total, f'image checksum {s:08x} != {total:08x}'
    return model, ver, img, {'packets': count, 'length': length, 'checksum': total}


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'list':
        msgs = smf_sysex(sys.argv[2])
        from collections import Counter
        print(len(msgs), 'messages', Counter(len(m) for m in msgs).most_common(4))
        for m in msgs[:3] + msgs[-2:]:
            print(len(m), m[:24].hex(' '))
    elif cmd == 'decode':
        model, ver, img, rep = decode(smf_sysex(sys.argv[2]))
        open(sys.argv[3], 'wb').write(img)
        print(f'model {model:02x} version bytes {ver[0]:02x} {ver[1]:02x}', rep)
    elif cmd == 'compare':
        img = open(sys.argv[2], 'rb').read()
        rom = open(sys.argv[3], 'rb').read()
        probe = img[0x100:0x140]
        at = rom.find(probe)
        if at < 0:
            print('not found'); sys.exit(1)
        base = at - 0x100
        diff = [i for i in range(len(img)) if base + i >= len(rom) or rom[base + i] != img[i]]
        print(f'image at EPROM offset {base:06x}; {len(diff)} bytes differ', [hex(i) for i in diff[:8]])
