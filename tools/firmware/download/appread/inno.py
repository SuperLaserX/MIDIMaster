# Read Inno Setup 6.5+ setup data as plain data (no execution).
# usage: python -I inno.py <setup.exe> <outdir> blocks          -> writes header blocks block1.bin, block2.bin
#        python -I inno.py <setup.exe> <outdir> chunk <offset>  -> decompress one setup-1 chunk at offset (relative to setup-1) to chunk_<offset>.bin
import sys, struct, lzma, os, zlib

path, outdir, cmd = sys.argv[1], sys.argv[2], sys.argv[3]
B = open(path, 'rb').read()
os.makedirs(outdir, exist_ok=True)
t = B.find(b'rDlPtS\xcd\xe6\xd7\x7b\x0b\x2a')
ver = struct.unpack('<I', B[t+12:t+16])[0]
total, off_exe = struct.unpack('<QQ', B[t+16:t+32])
usize_exe, crc_exe = struct.unpack('<II', B[t+32:t+40])
off0, off1 = struct.unpack('<QQ', B[t+40:t+56])
print('table v%d total %d exe@%x setup-0@%x setup-1@%x' % (ver, total, off_exe, off0, off1), file=sys.stderr)

def lzma_raw(data):
    props = data[0]; dict_size = struct.unpack('<I', data[1:5])[0]
    lc = props % 9; props //= 9; lp = props % 5; pb = props // 5
    d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[{'id': lzma.FILTER_LZMA1, 'dict_size': dict_size, 'lc': lc, 'lp': lp, 'pb': pb}])
    return d.decompress(data[5:])

def read_block(p):
    crc, size, comp = struct.unpack('<IQB', B[p:p+13])
    assert zlib.crc32(B[p+4:p+13]) & 0xffffffff == crc, 'block header crc'
    q = p + 13; end = q + size; raw = bytearray()
    while q < end:
        n = min(4096, end - q - 4)
        ccrc = struct.unpack('<I', B[q:q+4])[0]
        chunk = B[q+4:q+4+n]
        assert zlib.crc32(chunk) & 0xffffffff == ccrc, 'chunk crc at %x' % q
        raw += chunk; q += 4 + n
    data = lzma_raw(bytes(raw)) if comp else bytes(raw)
    return data, end

if cmd == 'blocks':
    p = off0 + 64
    # Inno 6.5+: encryption header record (CRC + 49 bytes) before the compressed blocks
    ehcrc = struct.unpack('<I', B[p:p+4])[0]
    for ln in (49, 45, 53, 41):
        if zlib.crc32(B[p+4:p+4+ln]) & 0xffffffff == ehcrc:
            print('encryption header %d bytes, use=%d' % (ln, B[p+4]), file=sys.stderr); p += 4 + ln; break
    else:
        print('no encryption header crc match', file=sys.stderr)
    for i in (1, 2):
        data, p = read_block(p)
        open(os.path.join(outdir, 'block%d.bin' % i), 'wb').write(data)
        print('block%d %d bytes, next %x' % (i, len(data), p), file=sys.stderr)
elif cmd == 'chunk':
    rel = int(sys.argv[4], 0)
    p = off1 + rel
    assert B[p:p+4] == b'zlb\x1a', B[p:p+4]
    size = int(sys.argv[5], 0) if len(sys.argv) > 5 else None
    data = B[p+4:p+4+size] if size else B[p+4:]
    if data[0] <= 40 and (data[1] >= 0xe0 or data[1] == 0x01):
        # LZMA2: one dictionary-size byte, then the raw LZMA2 stream
        p2 = data[0]; dict_size = (2 | (p2 & 1)) << (p2 // 2 + 11)
        d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[{'id': lzma.FILTER_LZMA2, 'dict_size': dict_size}])
        pos = 1
    else:
        props = data[0]; dict_size = struct.unpack('<I', data[1:5])[0]
        lc = props % 9; pr = props // 9; lp = pr % 5; pb = pr // 5
        d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[{'id': lzma.FILTER_LZMA1, 'dict_size': dict_size, 'lc': lc, 'lp': lp, 'pb': pb}])
        pos = 5
    out = open(os.path.join(outdir, 'chunk_%x.bin' % rel), 'wb'); n = 0
    while pos < len(data) and not d.eof:
        piece = d.decompress(data[pos:pos + (1 << 20)], max_length=-1); pos += 1 << 20
        out.write(piece); n += len(piece)
        if d.needs_input is False and d.eof: break
    out.close()
    print('chunk %x -> %d bytes (eof=%s, used %d)' % (rel, n, d.eof, len(data) - len(d.unused_data) if d.eof else -1), file=sys.stderr)
