# Read an Enigma Virtual Box file table from a binary, as data (no execution).
# usage: python -I evb.py <binary> <outdir> [list|extract] [path-regex]
import sys, struct, os, re
path, outdir = sys.argv[1], sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else 'list'
rx = re.compile(sys.argv[4], re.I) if len(sys.argv) > 4 else None
B = open(path, 'rb').read()
sig = B.find(b'EVB\x00')
p = sig + 0x53  # first node (found by inspection: 0x72e0f3 for sig 0x72e0a0)
nodes = []
def cstr16(p):
    e = p
    while B[e:e+2] != b'\x00\x00': e += 2
    return B[p:e].decode('utf-16le'), e + 2
stack = []  # [name, remaining]
files = []
end_tab = None
while True:
    a, b, cnt = struct.unpack('<III', B[p:p+12])
    name, q = cstr16(p + 12)
    t = B[q]
    if t == 3:
        nxt = q + 30
        kind = 'dir'
    elif t == 2:
        osize = struct.unpack('<Q', B[q+3:q+11])[0]
        off = struct.unpack('<Q', B[q+42:q+50])[0]
        ssize = struct.unpack('<Q', B[q+50:q+58])[0]
        nxt = q + 58
        kind = 'file'
    else:
        print('unknown type', t, 'at', hex(q), name, file=sys.stderr); break
    prefix = '/'.join(s[0] for s in stack)
    full = (prefix + '/' + name) if prefix else name
    if kind == 'file':
        files.append((full, osize, off, ssize))
    # pop finished parents
    if stack:
        stack[-1][1] -= 1
    if kind == 'dir' and cnt > 0:
        stack.append([name, cnt])
    while stack and stack[-1][1] == 0:
        stack.pop()
    p = nxt
    if not stack:
        end_tab = p; break
print('nodes end at', hex(end_tab), 'files', len(files), file=sys.stderr)
# data base: first file with off 0
base = None
f0 = [f for f in files if f[2] == 0]
for cand in range(end_tab, end_tab + 0x2000):
    if B[cand:cand+2] == b'MZ' or (f0 and not f0[0][0].lower().endswith('.dll')):
        base = cand; break
print('data base', hex(base), 'first', f0[0][0] if f0 else None, file=sys.stderr)
for full, osize, off, ssize in files:
    if rx and not rx.search(full): continue
    print('%10d %10d %s%s' % (osize, ssize, full, '' if osize == ssize else '  [packed]'))
    if mode == 'extract':
        out = os.path.join(outdir, *full.split('/'))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, 'wb') as fo:
            fo.write(B[base + off: base + off + ssize])
