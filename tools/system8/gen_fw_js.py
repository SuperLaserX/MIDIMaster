#!/usr/bin/env python3
"""Generate js/devices/defs/roland-system8-fw.js from the SYSTEM-8 sources:
  * the Roland Cloud SYSTEM-8 plugin's Script.xml  (patch values: names, ranges, defaults)
  * its string tables                              (value texts the plugin shows)
  * the region 0 display tables of the SYSTEM-8 image (pages, parameter ids, value lists)
  * the OS parameter catalog (tools/system8/os_tables.py: names, screen texts, ranges, SysEx addresses, CC map)
usage: python -I gen_fw_js.py SCRIPT.xml REGION0.bin OUT.js [OS_PARAMS.json]
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import region0_tables as R0
import xml.etree.ElementTree as ET


def a7(t):
    v = 0
    for x in t.split():
        v = (v << 7) + int(x, 16)
    return v


# OS groups reachable by SysEx that the editor uses (pat3 steps: step 0 only, the others are the same)
OS_KEEP = re.compile(r'^(stp_com|pfm_.*|lfo|osc1|osc2|mix|pit|flt|amp|efx|ctrl|extend|pat_name|pat2_.*|pat3_seq_com|pat3_seq_step0|g129)$')


def os_data(osj):
    groups = {}
    for p in osj['params']:
        if not p['addr'] or not OS_KEEP.match(p['gkey']):
            continue
        a = p['addr']
        packed = (a[0] << 21) | (a[1] << 14) | (a[2] << 7) | a[3]
        g = groups.setdefault(p['gkey'], {'addr': None, 'size': 0, 'rows': [], 'reserved': []})
        if g['addr'] is None:
            g['addr'] = packed
        off = packed - g['addr']
        n = 1 if (p['type'] & 0xFF) == 0x14 else (p['type'] & 0xF0) >> 4
        g['size'] = max(g['size'], off + n)
        if p['name'] == '_reserve_':
            r = g['reserved']
            if r and r[-1][0] + r[-1][1] == off:
                r[-1][1] += n
            else:
                r.append([off, n])
            continue
        flags = (1 if p['type'] & 0x100 else 0) | (2 if p['type'] & 0x200 else 0)
        g['rows'].append([p['i'], p['name'], off, n, p['min'], p['max'], p['default'], p['bias'], flags, p['text']])
    cc = [[c['cc'], c['group'], c['i'], c['name']] for c in osj['cc'] if c]
    leaves = [[(l['addr'][0] << 21) | (l['addr'][1] << 14) | (l['addr'][2] << 7) | l['addr'][3], l['size'], l['group']] for l in osj['leaves']]
    return {'OS_GROUPS': groups, 'OS_TABLES': osj['tables'], 'OS_CC': cc, 'OS_LEAVES': leaves}


def main():
    script, region0, out = sys.argv[1:4]
    root = ET.parse(script).getroot()
    types = {}
    for e in root.findall('structType'):
        types.setdefault(e.findtext('type'), e)

    def leaves(t, base, path):
        e = types[t]
        subs = e.findall('struct')
        if not subs:
            yield path or t, t, base, e
            return
        for c in subs:
            name = c.findtext('name') or c.findtext('type')
            yield from leaves(c.findtext('type'), base + a7(c.findtext('address')), f'{path}.{name}' if path else name)

    def values(struct):
        res = []
        for path, t, base, e in leaves(struct, 0, ''):
            off = 0
            for v in e.findall('value'):
                vt = v.findtext('type')
                m = re.match(r'int(\d+)x(\d+)$', vt or '')
                n, bits = (int(m.group(1)), int(m.group(2))) if m else (a7(v.findtext('size') or '00'), 4)
                addrs = [a7(a.text) for a in v.findall('address')]
                o = addrs[0] if addrs else off
                rng = v.findtext('range')
                lo, hi = (int(x) for x in rng.split(',')) if rng else (None, None)
                d = v.findtext('default')
                rec = [v.findtext('name'), path, base + o, n, bits, lo, hi, int(d) if d and re.match(r'-?\d+$', d) else d]
                if vt == 'stringNx4':
                    rec[3] = n
                    rec.append('text')
                res.append(rec)
                if not addrs:
                    off += n
        return res

    tables = {}
    for st in root.iter('stringTable'):
        items = [x.strip().replace('&amp;', '&') for x in (st.findtext('table') or '').replace('\n', '').split(',')]
        if items and items[-1] == '':
            items.pop()
        tables[st.findtext('name')] = items

    d = open(region0, 'rb').read()
    flat = [r for t in R0.find_tables(d) for r in t]
    pages, lists, cur, curl = [], [], None, None
    for r in flat:
        if r['kind'] == 'page':
            cur = {'name': r['name'], 'params': []}
            pages.append(cur)
        elif r['kind'] == 'param':
            cur['params'].append([r['id'], r['name']] + r['w'][:8])
        elif r['kind'] == 'list':
            curl = {'n': r['w'][0], 'items': []}
            lists.append(curl)
        else:
            curl['items'].append(r['text'])

    data = {}
    if len(sys.argv) > 4:
        data.update(os_data(json.load(open(sys.argv[4]))))
    data.update({
        'PATCH': values('patch'),
        'PATCH2': [v for v in values('patch2') if v[0] != '_reserve_'],
        'PATCH3_COM': [v for v in values('patch3') if v[1] in ('PAT3_SEQ_COM', 'SEQ_STEP0') and v[0] != '_reserve_'],
        'TABLES': tables,
        'PAGES': pages,
        'LISTS': {l['n']: l['items'] for l in lists},
    })
    hdr = ('// Generated by tools/system8/gen_fw_js.py from the Roland Cloud SYSTEM-8 plugin (Script.xml: the device\n'
           '// memory map with Roland\'s names, ranges, defaults and string tables) and the display tables in region 0\n'
           '// of the SYSTEM-8 image (pages, parameter ids, value lists). Do not edit by hand.\n'
           '//\n'
           '// PATCH / PATCH2 / PATCH3_COM rows: [name, leaf, offset (packed 7-bit address = byte offset), bytes,\n'
           '// bits per byte, min, max, default(, "text")]. PAGES: [{name, params: [[id, label, size class, min, max,\n'
           '// ?, ?, list, display, index]]}]. LISTS: {list number: [texts]}.\n\n')
    with open(out, 'w', newline='\n') as f:
        f.write(hdr)
        for k, v in data.items():
            f.write(f'export const {k} = ' + json.dumps(v, separators=(',', ':'), ensure_ascii=False) + ';\n')
    print(out, {k: len(v) for k, v in data.items()})


if __name__ == '__main__':
    main()
