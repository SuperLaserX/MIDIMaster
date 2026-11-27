#!/usr/bin/env python3
"""Unpack the Roland SYSTEM-8 system update (SYSTEM8_UP.BIN).

SYSTEM8_UP.BIN is a plain tar archive holding ./_tmp/p1y01_*.bin:
  p1y01_m0c0a_up.bin  App1_Main  - main CPU program, 0x60-byte header, then an
                                    8-byte block cipher in ECB mode (not decoded)
  p1y01_p0m.bin / p0s.bin         - the SYSTEM-8 engine ("SYSTEM-8:Plugout"
                                    container, LZSS), loaded at 0x60800000 / 0x60200000
  p1y01_pl1m / pl1s / pl2m.bin    - PRELOAD_PLUGOUT wrappers (0x40-byte header)
                                    around a "SYSTEM-8:Plugout" container:
                                    JUPITER-8, JUNO-106, JX-3P

Container header ("SYSTEM-8:Plugout", 0x40 bytes, little endian):
  0x00 16  "SYSTEM-8:Plugout"
  0x10 16  build date "22-0331_13:04:49"
  0x20  8  version text "0.01136E"
  0x28  4  load address (0x60800000 / 0x60200000)
  0x2C  4  header size (0x40)
  0x30  4  compressed size (bytes after the header)
  0x34  4  checksum (sum of the compressed bytes, see below)
  0x38  4  load address again
  0x3C  4  uncompressed size
Compression: Okumura LZSS, 4096-byte ring buffer zero-filled, write position
0xFEE, flag byte LSB first (1 = literal), reference = 2 bytes
pos = b0 | (b1 & 0xF0) << 4, len = (b1 & 0x0F) + 3.

usage: python -I unpack_fw.py SYSTEM8_UP.BIN OUTDIR
"""
import io, os, struct, sys, tarfile


def lzss_decode(src, out_len=None):
    win = bytearray(4096)
    r = 0xFEE
    out = bytearray()
    i = 0
    n = len(src)
    while i < n:
        flags = src[i]; i += 1
        for bit in range(8):
            if i >= n or (out_len is not None and len(out) >= out_len):
                break
            if flags & (1 << bit):
                c = src[i]; i += 1
                out.append(c); win[r] = c; r = (r + 1) & 0xFFF
            else:
                if i + 1 >= n:
                    i = n; break
                b0, b1 = src[i], src[i + 1]; i += 2
                pos = b0 | ((b1 & 0xF0) << 4)
                ln = (b1 & 0x0F) + 3
                for k in range(ln):
                    c = win[(pos + k) & 0xFFF]
                    out.append(c); win[r] = c; r = (r + 1) & 0xFFF
    return bytes(out)


def parse_container(d):
    assert d[:16] == b'SYSTEM-8:Plugout', d[:16]
    load, hsz, csz, csum, load2, usz = struct.unpack_from('<6I', d, 0x28)
    return dict(date=d[16:32].decode('ascii', 'replace'), version=d[32:40].decode('ascii', 'replace'),
                load=load, hsz=hsz, csz=csz, csum=csum, usz=usz)


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    with tarfile.open(src) as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            d = t.extractfile(m).read()
            base = os.path.basename(m.name)
            open(os.path.join(outdir, base), 'wb').write(d)
            off = 0
            if d[:15] == b'PRELOAD_PLUGOUT':
                off = 0x40
            if d[off:off + 16] == b'SYSTEM-8:Plugout':
                h = parse_container(d[off:])
                body = d[off + h['hsz']: off + h['hsz'] + h['csz']]
                s = sum(body) & 0xFFFFFFFF
                raw = lzss_decode(body, h['usz'])
                name = base.replace('.bin', '.dec')
                open(os.path.join(outdir, name), 'wb').write(raw)
                print(f"{base}: load={h['load']:#x} csz={h['csz']} usz={h['usz']} got={len(raw)} "
                      f"csum={h['csum']:#x} sum={s:#x} ver={h['version']} date={h['date']}")
            else:
                print(f"{base}: {d[:16]!r} (not a plug-out container)")


if __name__ == '__main__':
    main()
