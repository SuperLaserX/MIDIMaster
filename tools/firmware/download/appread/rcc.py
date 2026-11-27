# Read Qt rcc resource blobs embedded in a binary as data (no execution).
# usage: python -I rcc.py <binary> <outdir> [list|extract]
import sys, struct, zlib, os, re
path, outdir = sys.argv[1], sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else 'list'
B = open(path, 'rb').read()

def qhash(name):
    h = 0
    for ch in name:
        h = ((h << 4) + ord(ch)) & 0xffffffff
        h ^= (h & 0xf0000000) >> 23
        h &= 0x0fffffff
    return h

# 1) find name entries: u16 len, u32 hash, utf16be name, where hash matches
names = {}
for m in re.finditer(rb'(?:\x00[\x20-\x7e]){2,120}', B):
    s = m.start()
    # candidate entry start is s-6
    for back in (6,):
        st = s - back
        if st < 0: continue
        ln = struct.unpack('>H', B[st:st+2])[0]
        n = (m.end() - s) // 2
        if ln < 1 or ln > n: continue
        nm = B[s:s+2*ln].decode('utf-16be', 'replace')
        h = struct.unpack('>I', B[st+2:st+6])[0]
        if qhash(nm) == h:
            names[st] = nm
print('name entries:', len(names), file=sys.stderr)
# group names into tables (contiguous runs)
starts = sorted(names)
tables = []
cur = []
for st in starts:
    if cur:
        prev = cur[-1]
        end = prev + 6 + 2 * len(names[prev])
        if st != end:
            tables.append(cur); cur = []
    cur.append(st)
if cur: tables.append(cur)
tables = [t for t in tables if len(t) >= 2]
print('name tables:', [(hex(t[0]), len(t)) for t in tables], file=sys.stderr)

def find_tree(nbase, nameoffs):
    # look for root node: name_off 0? root has name offset 0 and flags 2 (dir) in Qt; scan for nodes
    # node v2: u32 nameoff, u16 flags, u32 count/country, u32 child/data, u64 mtime (22 bytes); v1: 14 bytes
    cands = []
    rel = set(o - nbase for o in nameoffs)
    # find positions where u32 nameoff in rel and u16 flags in (0,1,2,4)
    for ver, size in ((2, 22), (1, 14), (3, 22)):
        best = None
        for p in range(0, len(B) - 64, 2):
            pass
        cands.append((ver, size))
    return cands

results = []
for t in tables:
    nbase = t[0]
    rel = {o - nbase: names[o] for o in t}
    # search tree: consecutive nodes whose name offsets are in rel. Use first child nodes pattern.
    # Build a bytes pattern search: look for any u32 BE equal to a rel offset followed by flags.
    found = None
    relset = set(rel)
    for size in (22, 14):
        # scan for 4 consecutive nodes with valid name offsets
        for p in range(0, len(B) - size * 4, 2):
            ok = True
            for k in range(1, 5):
                q = p + size * k
                no = struct.unpack('>I', B[q:q+4])[0]
                fl = struct.unpack('>H', B[q+4:q+6])[0]
                if no not in relset or fl not in (0, 1, 2, 4, 5):
                    ok = False; break
            if ok:
                # root node at p: name offset arbitrary(0), flags 2
                fl0 = struct.unpack('>H', B[p+4:p+6])[0]
                if fl0 == 2:
                    found = (p, size); break
        if found: break
    if not found:
        print('no tree for table at', hex(nbase), file=sys.stderr); continue
    tp, size = found
    print('table %x: tree at %x node size %d' % (nbase, tp, size), file=sys.stderr)
    def node(i):
        q = tp + size * i
        no, fl = struct.unpack('>IH', B[q:q+6])
        a, b = struct.unpack('>II', B[q+6:q+14])
        return no, fl, a, b
    files = []
    def walk(i, prefix):
        no, fl, a, b = node(i)
        nm = rel.get(no, '') if i else ''
        if fl & 2:
            for c in range(b, b + a):
                walk(c, prefix + nm + '/' if i else '/')
        else:
            files.append((prefix + nm, fl, b))
    try:
        walk(0, '')
    except (struct.error, RecursionError, IndexError) as e:
        print('  table %x: bad tree (%s), skipped' % (nbase, e), file=sys.stderr); continue
    # find data base: data entries u32 size then payload; find P with consistent sizes
    offs = sorted(set(f[2] for f in files))
    bestP = None
    if len(offs) >= 2:
        d0, d1 = offs[0], offs[1]
        need = d1 - d0 - 4
        pat = struct.pack('>I', need)
        for m in re.finditer(re.escape(pat), B):
            P = m.start() - d0
            if P < 0: continue
            good = 0
            for k in range(min(len(offs) - 1, 12)):
                x, y = offs[k], offs[k + 1]
                if struct.unpack('>I', B[P + x:P + x + 4])[0] == y - x - 4: good += 1
            if good >= min(len(offs) - 1, 12):
                bestP = P; break
    print('  files %d data base %s' % (len(files), hex(bestP) if bestP is not None else None), file=sys.stderr)
    for f in files:
        results.append((f, bestP))

os.makedirs(outdir, exist_ok=True)
for (name, fl, doff), P in results:
    if P is None:
        print('?', name); continue
    ln = struct.unpack('>I', B[P + doff:P + doff + 4])[0]
    raw = B[P + doff + 4:P + doff + 4 + ln]
    data = raw
    if fl & 1:
        try: data = zlib.decompress(raw[4:])
        except Exception as e: data = raw; name += '.zlibfail'
    elif fl & 4:
        name += '.zstd'
    print('%9d %s' % (len(data), name))
    if mode == "extract" and not name.endswith("/") and not name.startswith("/QtQuick") and not name.startswith("/qt-project") and not name.startswith("/Extras"):
        out = os.path.join(outdir, name.lstrip('/').replace('/', os.sep))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, 'wb').write(data)
