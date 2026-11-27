# Undo Inno Setup's (5.2.0+) CALL/JMP address transform on a decompressed file, as data.
# usage: python -I innocall.py <in> <out> [skip_bytes]
import sys, re
src, dst = sys.argv[1], sys.argv[2]
skip = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0
D = bytearray(open(src, 'rb').read()[skip:])
n = len(D); BLOCK = 0x10000
nxt = 0; changed = 0
for m in re.finditer(rb'[\xe8\xe9]', D):
    i = m.start()
    if i < nxt: continue
    blen = min(BLOCK, n - (i // BLOCK) * BLOCK)
    if (i % BLOCK) >= blen - 4: continue          # not enough bytes left in this 64 KB block
    a = i + 1
    hb = D[a + 3]
    nxt = a + 4                                    # the 4 address bytes are never scanned again
    if hb not in (0x00, 0xff):
        continue
    addr = (a + 4) & 0xffffff
    rel = (D[a] | D[a + 1] << 8 | D[a + 2] << 16) - addr
    rel &= 0xffffff
    D[a] = rel & 0xff; D[a + 1] = (rel >> 8) & 0xff; D[a + 2] = (rel >> 16) & 0xff
    if rel & 0x800000: D[a + 3] = hb ^ 0xff
    nxt = a + 4; changed += 1
open(dst, 'wb').write(D)
print('size %d, %d addresses restored' % (n, changed), file=sys.stderr)
