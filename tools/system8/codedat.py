#!/usr/bin/env python3
"""Decode a PLUG-OUT container (Code8_<slot>.Dat / Code1.Dat) as written by Roland's
plug-out software or the community SDK (github.com/enorrmann/roland-plugout-reveng).

Container: chained XOR over 32-bit LE words, plain[i] = c[i] ^ c[i-1], c[-1] = 0xBACADABE.
Header (decrypted): u32 0x80, "PLUGOUT_SYS_INF\0", name[16] @0x14, u16 model @0x24,
u16 version @0x26, START {off,size,count} @0x30, END @0x40, DATA {off,stride,count} @0x50.
Each record = u32 length + one complete SysEx (F0 41 10 00 00 7E 12 aa aa aa aa data sum F7).
Data records 70 30 00 09 carry 512 flash bytes (7-in-8 packed, 586 bytes); 70 30 01 09 are
filler (an erased 512-byte block). The flash image (4096 blocks on SYSTEM-8) holds two regions:
region 0 (model, blocks 0-2047) and region 1 (engine, blocks 2048-4095), each a 0x40-byte
"SYSTEM-8:Plugout" header + LZSS stream (see unpack_fw.py).
END data = 16-bit sum of the whole flash image, one nibble per byte.

usage: python -I codedat.py FILE.Dat [--image OUTPREFIX]
"""
import struct, sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack_fw import lzss_decode, parse_container


def decrypt(raw):
    n = len(raw) // 4
    w = struct.unpack('<%dI' % n, raw[:n * 4])
    prev = 0xBACADABE
    out = []
    for x in w:
        out.append(x ^ prev)
        prev = x
    return struct.pack('<%dI' % n, *out) + raw[n * 4:]


def unpack7(b):
    """7-in-8: groups of <msb byte><up to 7 bytes>; bit j of the msb byte is bit 7 of byte j."""
    out = bytearray()
    for i in range(0, len(b), 8):
        g = b[i:i + 8]
        hi = g[0]
        for k, x in enumerate(g[1:]):
            out.append(x | (((hi >> k) & 1) << 7))
    return bytes(out)


def parse(path):
    d = decrypt(open(path, 'rb').read())
    assert d[4:19] == b'PLUGOUT_SYS_INF', d[:32]
    name = d[0x14:0x24].rstrip(b'\0').decode('ascii', 'replace')
    model, ver = struct.unpack_from('<HH', d, 0x24)
    s_off, s_size, s_cnt = struct.unpack_from('<III', d, 0x30)
    e_off, e_size, e_cnt = struct.unpack_from('<III', d, 0x40)
    d_off, d_stride, d_cnt = struct.unpack_from('<III', d, 0x50)

    def rec(off):
        ln = struct.unpack_from('<I', d, off)[0]
        return d[off + 4: off + 4 + ln]
    start = rec(s_off)
    end = rec(e_off)
    recs = [rec(d_off + i * d_stride) for i in range(d_cnt)]
    return dict(name=name, model=model, version='%X.%02X' % (ver >> 8, ver & 0xFF), start=start, end=end, records=recs)


def flash_image(info):
    img = bytearray()
    for m in info['records']:
        addr = m[7:11]
        if addr == b'\x70\x30\x00\x09':
            img += unpack7(m[11:-2])[:512]
        elif addr == b'\x70\x30\x01\x09':
            img += b'\xff' * 512
        else:
            raise ValueError(m[:12].hex())
    return bytes(img)


def main():
    path = sys.argv[1]
    info = parse(path)
    img = flash_image(info)
    s16 = sum(img) & 0xFFFF
    endsum = int(''.join('%X' % x for x in info['end'][11:15]), 16)
    print(f"{path}: name={info['name']} model={info['model']:#x} version={info['version']} records={len(info['records'])} "
          f"image={len(img)} sum16={s16:#06x} END={endsum:#06x} {'OK' if s16 == endsum else 'MISMATCH'}")
    print('  START', info['start'].hex(' '), ' END', info['end'].hex(' '))
    half = len(img) // 2
    for k, off in enumerate((0, half)):
        h = parse_container(img[off:])
        body = img[off + h['hsz']: off + h['hsz'] + h['csz']]
        ok = (sum(body) & 0xFFFFFFFF) == h['csum']
        raw = lzss_decode(body, h['usz'])
        syn = raw[0x10:0x20].rstrip(b'\0').decode('ascii', 'replace')
        mid, ver = struct.unpack_from('<HH', raw, 0x20)
        print(f"  region {k}: load={h['load']:#x} csz={h['csz']} usz={h['usz']} sum {'OK' if ok else 'BAD'} "
              f"SYNINFO {syn} model={mid:#x} ver={ver >> 8:X}.{ver & 0xFF:02X} built {h['date']} {h['version']}")
        if '--image' in sys.argv:
            pre = sys.argv[sys.argv.index('--image') + 1]
            open(f'{pre}region{k}.bin', 'wb').write(raw)


if __name__ == '__main__':
    main()
