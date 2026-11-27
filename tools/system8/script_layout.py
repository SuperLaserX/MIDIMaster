#!/usr/bin/env python3
"""Parse a Roland Cloud PLUG-OUT Script.xml (the plugin's model of the device
memory) into a flat JSON list of leaves and values.

usage: python -I script_layout.py Script.xml out.json [root-type ...]
Default roots: patch patch2 patch3.  Addresses are 7-bit packed integers
("01 70" -> 0xF0) relative to the struct type root; value offsets are byte
offsets inside the leaf (each byte carries 7 bits; intNxM = N bytes of M bits,
most significant first; stringNx4 = 2 nibbles per character).
"""
import json, re, sys
import xml.etree.ElementTree as ET


def a7(text):
    v = 0
    for x in text.split():
        v = (v << 7) + int(x, 16)
    return v


def main():
    src, out = sys.argv[1], sys.argv[2]
    roots = sys.argv[3:] or ['patch', 'patch2', 'patch3']
    root = ET.parse(src).getroot()
    types = {}
    for e in root.findall('structType'):
        types.setdefault(e.findtext('type'), e)

    def vsize(v):
        m = re.match(r'int(\d+)x(\d+)$', v.findtext('type'))
        if m:
            return int(m.group(1))
        return a7(v.findtext('size'))

    def leaves(t, base, path):
        e = types[t]
        subs = e.findall('struct')
        if not subs:
            vals = []
            off = 0
            for v in e.findall('value'):
                size = vsize(v)
                addrs = [a7(a.text) for a in v.findall('address')]
                rec = {k: v.findtext(k) for k in ('name', 'type', 'range', 'default') if v.findtext(k) is not None}
                rec['size'] = size
                rec['offset'] = addrs[0] if addrs else off
                if len(addrs) > 1:
                    rec['addresses'] = addrs
                for k in ('min', 'max', 'enum', 'text', 'unit', 'offsetValue'):
                    if v.findtext(k) is not None:
                        rec[k] = v.findtext(k)
                extra = sorted(set(c.tag for c in v) - {'name', 'type', 'range', 'default', 'size', 'address'})
                if extra:
                    rec['extra'] = {x: v.findtext(x) for x in extra}
                vals.append(rec)
                if not addrs:
                    off += size
            size = a7(e.findtext('size')) if e.findtext('size') else max([x['offset'] + x['size'] for x in vals] or [0])
            yield {'path': path or t, 'type': t, 'base': base, 'size': size, 'values': vals}
            return
        for c in subs:
            name = c.findtext('name') or c.findtext('type')
            yield from leaves(c.findtext('type'), base + a7(c.findtext('address')),
                              f'{path}.{name}' if path else name)

    res = {r: list(leaves(r, 0, '')) for r in roots}
    json.dump(res, open(out, 'w'), indent=1)
    for r in roots:
        tot = sum(l['size'] for l in res[r])
        nv = sum(len(l['values']) for l in res[r])
        print(f'{r}: {len(res[r])} leaves, {nv} values, {tot} bytes')


if __name__ == '__main__':
    main()
