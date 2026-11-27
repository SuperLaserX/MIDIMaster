#!/usr/bin/env python3
"""Parse the panel/display tables in a PLUG-OUT region 0 image (the SYNINFO "model" image
that runs on the OS CPU): TLV records, little endian.
  type 0, len 0x20: page   {u32 count, char name[16], u32 x}
  type 1, len 0x4C: param  {u32 id, u32 a, i32 min, i32 max, u32 c, u32 d, u32 e, ... char name[16] @0x38, u32 f}
  type 2, len 0x14: list   {u32 a, u32 count, u32 b}
  type 3, len 0x1C: item   {char text[16], u32 value}
usage: python -I region0_tables.py region0.bin [out.json]
"""
import json, struct, sys


def cstr(b):
    return b.split(b'\0')[0].decode('latin-1')


def walk(d, start):
    out = []
    i = start
    while i + 8 <= len(d):
        t, ln = struct.unpack_from('<II', d, i)
        if (t, ln) == (0, 0x20):
            cnt, = struct.unpack_from('<I', d, i + 8)
            out.append({'off': i, 'kind': 'page', 'count': cnt, 'name': cstr(d[i + 12:i + 28]), 'x': struct.unpack_from('<I', d, i + 28)[0]})
        elif (t, ln) == (1, 0x4C):
            w = struct.unpack_from('<14i', d, i + 8)
            out.append({'off': i, 'kind': 'param', 'id': w[0], 'w': list(w[1:12]), 'name': cstr(d[i + 0x38:i + 0x48]),
                        'f': struct.unpack_from('<i', d, i + 0x48)[0]})
        elif (t, ln) == (2, 0x14):
            out.append({'off': i, 'kind': 'list', 'w': list(struct.unpack_from('<3i', d, i + 8))})
        elif (t, ln) == (3, 0x1C):
            out.append({'off': i, 'kind': 'item', 'text': cstr(d[i + 8:i + 24]), 'value': struct.unpack_from('<i', d, i + 24)[0]})
        else:
            break
        i += ln
    return out, i


def find_tables(d):
    """every run of records that starts with a page record"""
    res = []
    i = 0
    while True:
        j = d.find(struct.pack('<II', 0, 0x20), i)
        if j < 0:
            break
        if j % 4 == 0:
            recs, end = walk(d, j)
            if len(recs) > 1 and recs[1]['kind'] in ('param', 'page', 'list'):
                res.append(recs)
                i = end
                continue
        i = j + 4
    return res


def main():
    d = open(sys.argv[1], 'rb').read()
    tabs = find_tables(d)
    flat = [r for t in tabs for r in t]
    for r in flat:
        if r['kind'] == 'page':
            print(f"\n== PAGE {r['name']!r} count={r['count']} x={r['x']}  @{r['off']:#x}")
        elif r['kind'] == 'param':
            print(f"  param id={r['id']:#05x} {r['name']!r:18} w={r['w']} f={r['f']}")
        elif r['kind'] == 'list':
            print(f"    list {r['w']}")
        else:
            print(f"      {r['value']:4d} {r['text']!r}")
    if len(sys.argv) > 2:
        json.dump(flat, open(sys.argv[2], 'w'), indent=0)


if __name__ == '__main__':
    main()
