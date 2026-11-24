"""Unpack the Roland V-Synth XT update files (OS v2.02) into flash images for analysis.

usage: python -I vsynth_rom.py <V-SynthXT.rom> <out dir>
       python -I vsynth_rom.py <MI004.BIN | V-SynthXTDiskImage.bin> <out dir>

V-SynthXT.rom: "MI004   " + total size, then a table of 16-byte entries
    address (CPU, A0000000 = flash 0), size, checksum (16 bits), flags (0100h = block left empty),
    index (16 bits), type (0880h boot sector 8 KB, 2880h, 4880h 64 KB block)
  and the blocks' data in index order. Written out as flash.bin (8 MB from A0000000).
MI004.BIN / V-SynthXTDiskImage.bin: "MI004   " header with a version and lengths, then zlib streams;
  each stream is written out as <name>.<n>.bin.
"""
import struct
import sys
import zlib
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
data = src.read_bytes()

if data[:8] == b'MI004   ':
    entries = []
    p = 0x10
    while p + 16 <= len(data):
        addr, size, cks, flags, idx, typ = struct.unpack('>IIHHHH', data[p:p + 16])
        if addr & 0xFF000000 != 0xA0000000:
            break
        entries.append((addr, size, cks, flags, idx, typ))
        p += 16
    used = [e for e in entries if not e[3] & 0x0100]
    used.sort(key=lambda e: e[4])
    top = max(e[0] + e[1] for e in entries) - 0xA0000000
    flash = bytearray(b'\xff' * top)
    off = p
    # the data starts after the table, padded to 16 bytes; blocks follow in index order
    for e in used:
        chunk = data[off:off + e[1]]
        flash[e[0] - 0xA0000000:e[0] - 0xA0000000 + len(chunk)] = chunk
        s = sum(struct.unpack('>%dH' % (len(chunk) // 2), chunk)) & 0xFFFF
        print('%08X %6X idx %3d type %04X cks %04X sum16 %04X %s' % (e[0], e[1], e[4], e[5], e[2], s, 'ok' if s == e[2] else ''))
        off += e[1]
    print('table', len(entries), 'entries,', len(used), 'with data; data end', hex(off), 'file', hex(len(data)))
    (out / 'flash.bin').write_bytes(bytes(flash))
    print('written', out / 'flash.bin', hex(len(flash)))
else:
    # MI004.BIN-style: 4-byte length, "MI004   ", version, then zlib streams
    name = src.stem
    print('header', data[:0x20].hex(' '))
    n = 0
    i = 0
    while True:
        i = data.find(b'\x78\xda', i)
        if i < 0:
            break
        d = zlib.decompressobj()
        try:
            raw = d.decompress(data[i:])
        except zlib.error:
            i += 2
            continue
        used = len(data) - i - len(d.unused_data)
        (out / ('%s.%d.bin' % (name, n))).write_bytes(raw)
        print('stream %d at %X: %d -> %d bytes' % (n, i, used, len(raw)))
        n += 1
        i += used
