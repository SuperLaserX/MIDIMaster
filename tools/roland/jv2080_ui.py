"""Extract the JV-2080 user-interface tables from the v1.02 flash image into
js/devices/defs/roland-jv2080-ui.js:

  LISTS        every option list (table of pointers at 0x0E091958; each list is a width
               byte followed by fixed-width strings). Display routine 0x36 with argument
               n shows list n.
  PARAM_UI     per SysEx block and byte offset: the label the edit screen shows and the
               option list it uses. Screens: table at 0x0E078ECC, 12-byte records
               [u32 text][u32 fields][u16 count][u16 flags]; fields are 16-byte records
               [u16 field][..][u16 display][u16 arg][..][x][y]..; the field table at
               0x0E08C0AC (8 bytes per field) gives the parameter ID.
  EFX_TYPES    for each of the 40 EFX types, the label and display of EFX parameters 1-12
               (list: option list; pan: L64-R63; gain: display 0x68/0x1C, -15..+15 dB).
               The 40 'EFX Param' screens are in type order; within a type the virtual
               parameter ID minus the type's first ID is the slot (hidden slots, such as
               the unused feedback slot of the chorus types, keep their place).
  (The 60-byte name records at 0x0E061FC8 are not in wave-number order, so wave names
  are not exported; the JV-2080 keeps its wave list in the wave ROM.)
  CATEGORIES   patch categories (list 52).

usage: python3 -I jv2080_ui.py <jv2080_v102.bin> <out.js>
"""
import json
import re
import struct
import sys

B = 0x0E000000
SCREENS = 0x078ECC
FIELDS = 0x08C0AC
LIST_TABLE = 0x091958
WAVE_TABLE = 0x061FC8

BLOCKS = {  # key: (first ID, last ID), as in jv2080_params.py
    'system': (0x000, 0x061), 'systemScalePerform': (0x08B, 0x096), 'systemScalePatch': (0x098, 0x0A3),
    'performCommon': (0x0C7, 0x10A), 'performPart': (0x113, 0x12C), 'patchCommon': (0x13A, 0x183),
    'patchTone': (0x19F, 0x21F), 'rhythmCommon': (0x23B, 0x246), 'rhythmNote': (0x24B, 0x284),
}


def u16(d, a):
    return struct.unpack_from('>H', d, a)[0]


def u32(d, a):
    return struct.unpack_from('>I', d, a)[0]


def lists(d):
    ptrs = []
    a = LIST_TABLE
    while B + 0x8F000 <= u32(d, a) < B + 0x92000:
        ptrs.append(u32(d, a) - B)
        a += 4
    starts = sorted(set(ptrs))
    out = []
    for p in ptrs:
        w = d[p]
        nxt = min([s for s in starts if s > p] + [p + 1 + w * 64])
        body = d[p + 1:nxt]
        n = len(body) // w if w else 0
        out.append([body[k * w:(k + 1) * w].decode('latin-1').strip() for k in range(n)])
    return out[:118]  # the last entry is not a list


def screens(d):
    r = SCREENS
    while B <= u32(d, r) < B + len(d):
        text, items, count, _flags = struct.unpack_from('>IIHH', d, r)
        t = text - B
        end = d.find(b'\xff', t)
        title = ' / '.join(s.strip() for s in re.findall(r'[\x20-\x7e]{3,}', d[t:t + 40].decode('latin-1'))[:2])
        labels = [(m.group(1)[0], m.group(2)[0], m.group(3).decode().strip(' [](:'))
                  for m in re.finditer(rb'([\x00-\x3f])([\x00-\x0f])\x01?([\x20-\x7e]{2,})\x00', d[t:end + 1])]
        fields = []
        if B <= items < B + len(d):
            for i in range(count):
                a = items - B + i * 16
                fid = u16(d, a)
                disp, arg = struct.unpack_from('>HH', d, a + 4)
                x, y = d[a + 10], d[a + 11]
                pid = u16(d, FIELDS + fid * 8)
                cand = [l for l in labels if l[1] == y and l[0] < x]
                lab = max(cand, key=lambda l: l[0])[2] if cand else None
                fields.append({'id': pid, 'label': lab, 'disp': disp, 'arg': arg})
        yield r + B, title, fields
        r += 12


def main():
    d = open(sys.argv[1], 'rb').read()
    L = lists(d)
    param_ui = {k: {} for k in BLOCKS}
    efx = []
    for addr, title, fields in screens(d):
        if title.startswith('EFX Param'):
            fs = sorted((f for f in fields if f['id'] != 0x2A2), key=lambda f: f['id'])
            efx.append(fs)
            continue
        for f in fields:
            for k, (a, b) in BLOCKS.items():
                if a <= f['id'] <= b:
                    off = f['id'] - a
                    e = param_ui[k].setdefault(off, {})
                    if f['label'] and 'label' not in e:
                        e['label'] = f['label']
                    if f['disp'] == 0x36 and 'list' not in e:
                        e['list'] = f['arg']
                    e.setdefault('screens', [])
                    if title not in e['screens']:
                        e['screens'].append(title)
    # EFX types: contiguous virtual ID ranges, one screen per type in type order.
    firsts = [fs[0]['id'] for fs in efx]
    efx_types = []
    for i, fs in enumerate(efx):
        base = firsts[i]
        slots = [None] * 12
        for f in fs:
            s = f['id'] - base
            if 0 <= s < 12:
                slots[s] = {'label': f['label'], **({'list': f['arg']} if f['disp'] == 0x36 else {}),
                            **({'pan': 1} if f['disp'] == 0x65 else {}),
                            **({'gain': 1} if (f['disp'], f['arg']) == (0x68, 0x1C) else {})}
        efx_types.append(slots)
    waves = []
    a = WAVE_TABLE
    while all(32 <= c < 127 for c in d[a:a + 12]):
        waves.append(d[a:a + 12].decode().rstrip())
        a += 60
    used = range(len(L))
    nl = chr(10)
    out = ['// Generated by tools/roland/jv2080_ui.py from the JV-2080 v1.02 flash image. Do not edit.',
           '// LISTS: firmware option lists by index. PARAM_UI: per block, byte offset ->',
           '// {label, list} as the edit screens show them. EFX_TYPES: per EFX type, EFX parameters 1-12.',
           '',
           'export const LISTS = {']
    for i in used:
        out.append(f'  {i}: {json.dumps(L[i])},')
    out.append('};')
    out.append('')
    out.append('export const PARAM_UI = {')
    for k, m in param_ui.items():
        items = ', '.join(f'{o}: {json.dumps({x: y for x, y in e.items() if x != "screens"})}' for o, e in sorted(m.items()))
        out.append(f'  {k}: {{ {items} }},')
    out.append('};')
    out.append('')
    out.append('export const EFX_TYPES = [')
    for t in efx_types:
        out.append('  ' + json.dumps(t) + ',')
    out.append('];')
    out.append('')
    open(sys.argv[2], 'w', newline=nl).write(nl.join(out))
    print(len(L), 'lists;', len(efx_types), 'EFX types;', {k: len(v) for k, v in param_ui.items()})


if __name__ == '__main__':
    main()
