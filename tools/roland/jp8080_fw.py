"""Build the firmware table modules of the JP-8080 (OS v1.04) and JP-8000 (OS v1.05) editors.

usage: python -I jp8080_fw.py jp8080_v1.04.bin js/devices/defs/roland-jp8080-fw.js
       python -I jp8080_fw.py jp8000_v1.05.bin js/devices/defs/roland-jp8000-fw.js

The JP-8080 addresses are listed below; the JP-8000 equivalents are in CFG (same layouts:
menu records 2Ch bytes instead of 2Eh, knob/switch flags 81h/82h instead of 82h/83h).

The image is the flash file loaded at CPU 10000h (CPU 0-FFFFh is the boot ROM). Tables used
(CPU addresses, see docs/devices/roland-jp8080.md):
  D251E  SysEx parameter table, 6 bytes per entry: internal id (word), sub, min, max, 0.
         Index ranges per address block are those of the address decoder at 45556.
  DE1CA  UI parameter table, 8 bytes: internal id, -, -, class.
  D81BC  knob display descriptors (22h bytes): label pointer, fields [col col, type, fmt, arg, ui].
  D3364  menu page records (2Eh bytes): header, label pointer, three fields as above.
  DF6D4  option list blob [width][strings...], list n at offset word E2CF8[n].
  8FFE2  patch records (B0h): INIT PATCH, << No Card >>, << Empty >>, then banks of 128; banks 1-3
         are PRESET 1-3 (checked by selecting them on a JP-8080).
  A63A2  performance records (1E0h): the same three entries, then banks of 64; banks 1-3 are PRESET 1-3.
  8D30C  per patch byte (0-49h): min, max, init, -, 82h knob / 83h switch, MODE2 factory CC,
         MODE1 CC (60h = none), Tx/Rx slot, ...
"""
import json
import sys

JP8000 = 'jp8000' in sys.argv[1].lower()
CFG = dict(base=0, sx=0x6D830, nsx=0x190, ui=0x72F88, knob=0x70B04, menu=0x6E4F0, mstride=0x2C, blob=0x73E10, offs=0x753FE,
           labels=(0x6F000, 0x74000), cc=0x53E8C, knobflag=0x81, name='JP-8000 OS v1.05', skipfmt=(0, 0x14, 0xFE),
           blocks={'SYSTEM': [(0, 0xF0, 0x17), (0x800, 0x107, 0x30), (0x1000, 0x137, 4), (0x1800, 0x13B, 0x2A)],
                   'PERF': [(0, 0x16C, 0x24)], 'PART': [(0, 0x165, 7)], 'PATCH': [(0, 0, 0xF0)]},
           presets=[(0x562B6, 0xA0, 0, 128, 1), (0x5B2B6, 0x180, 0, 64, 1)]) if JP8000 else \
    dict(base=0x10000, sx=0xD251E, nsx=0x1C5, ui=0xDE1CA, knob=0xD81BC, menu=0xD3364, mstride=0x2E, blob=0xDF6D4, offs=0xE2CF8,
         labels=(0xD5000, 0xE0000), cc=0x8D30C, knobflag=0x82, name='JP-8080 OS v1.04', skipfmt=(0, 0x1D, 0xFE),
         blocks={'SYSTEM': [(0x00, 0xF8, 0x19), (0x1000, 0x141, 4), (0x1800, 0x145, 0x2A)], 'PERF': [(0, 0x177, 0x25)],
                 'VMOD': [(0, 0x19C, 0x29)], 'PART': [(0, 0x16F, 8)], 'PATCH': [(0, 0, 0xF8)]},
         presets=[(0x8FFE2, 0xB0, 3, 128, 3), (0xA63A2, 0x1E0, 3, 64, 3)])
D = bytes(CFG['base']) + open(sys.argv[1], 'rb').read()
w = lambda a: int.from_bytes(D[a:a + 2], 'big')
l = lambda a: int.from_bytes(D[a:a + 4], 'big')


def cstr(a):
    e = D.find(b'\0', a)
    return D[a:e].decode('latin1')


def optlist(n, count):
    b = CFG['blob'] + w(CFG['offs'] + 2 * n)
    width = D[b]
    return [D[b + 1 + i * width:b + 1 + (i + 1) * width].decode('latin1').strip() for i in range(count)]


T0 = CFG['sx']
SX = [(w(T0 + 6 * i), D[T0 + 6 * i + 2], D[T0 + 6 * i + 3], D[T0 + 6 * i + 4]) for i in range(CFG['nsx'])]
UI = []
while True:
    a = CFG['ui'] + 8 * len(UI)
    if w(a + 6) > 0x20:
        break
    UI.append((w(a), w(a + 6)))


def fields(a, n):
    out = []
    for j in range(n):
        f = a + 10 * j
        if D[f] != 0xFF:
            out.append(dict(fmt=w(f + 4), arg=w(f + 6), ui=w(f + 8)))
    return out


labels = {}  # ui -> (label, fmt, arg, source)
a = CFG['knob']
while CFG['labels'][0] <= l(a) < CFG['labels'][1]:
    lab = cstr(l(a)).rstrip()
    for f in fields(a + 4, 3):
        labels.setdefault(f['ui'], (lab, f['fmt'], f['arg'], 'knob'))  # menus below override
    a += 0x22
a = CFG['menu']
while CFG['labels'][0] <= l(a + 10) < CFG['labels'][1]:
    lab = cstr(l(a + 10)).rstrip()
    for f in fields(a + 14, 3):
        if f['ui'] and f['fmt'] not in CFG['skipfmt'] and labels.get(f['ui'], ('', 0, 0, 'knob'))[3] == 'knob':
            labels[f['ui']] = (lab, f['fmt'], f['arg'], 'menu')
    a += CFG['mstride']
iid2ui = {}
for u, (iid, _cls) in enumerate(UI):
    iid2ui.setdefault(iid, []).append(u)

BLOCKS = CFG['blocks']
used_lists = set()
out = {}
for name, ranges in BLOCKS.items():
    rows = []
    for off0, i0, n in ranges:
        for j in range(n):
            iid, sub, mn, mx = SX[i0 + j]
            lab = next((labels[u] for u in iid2ui.get(iid, []) if u in labels), None)
            row = [off0 + j, mn, mx, sub]
            if lab:
                row += [lab[0], lab[1], lab[2], lab[3]]
                if lab[1] == 4:
                    used_lists.add(lab[2])
            rows.append(row)
    out[name] = rows

# Patch byte 0 is the name's first character (32-125, like bytes 1-15), but its SysEx table id is
# shared with a voice modulator knob (VOCAL MIX on the JP-8080): give it the name's label.
p0, p1 = out['PATCH'][0], out['PATCH'][1]
if p0[1:3] == [32, 125] and len(p1) > 4:
    out['PATCH'][0] = p0[:4] + p1[4:8]

# option list counts: the largest max among the parameters using each list
counts = {}
for rows in out.values():
    for r in rows:
        if len(r) > 4 and r[5] == 4:
            counts[r[6]] = max(counts.get(r[6], 0), r[2] + 1)
CC_LIST = 10 if JP8000 else 11  # CC list (Tx/Rx setting): list 10 in the JP-8000 OS, 11 in the JP-8080 OS
counts[CC_LIST] = max(counts.get(CC_LIST, 0), 97)
for r in out['PATCH']:  # OSC2 RANGE: its list holds -WIDE/+WIDE (JP-8080 format 1Ch list 30, JP-8000 format 13h list 23)
    if len(r) > 6 and r[5] in (0x1C, 0x13):
        counts[r[6]] = 2
counts[4] = max(counts.get(4, 0), 46)  # Pedal Assign targets (performance 1Ch, a JP-8000 setting)
counts[18] = max(counts.get(18, 0), 2)  # SET A / SET B (system 0Dh, Motion Set; JP-8080 list 18)
if JP8000:  # system 12h / 13h: the Initialize and Bulk Dump pages' lists (menu records 6EB20 / 6EB4C)
    counts[16] = max(counts.get(16, 0), 14)
    counts[17] = max(counts.get(17, 0), 18)
LISTS = {n: optlist(n, c) for n, c in sorted(counts.items())}

# Two-byte values (sub 1/2): their combined range and initial value are in the per-id table (cc):
# [min, max, init, ...], e.g. TEMPO 20-250 (init 120), Trig Source Note 0-128 (128 = ALL), depths
# 0-254 (127 = 0) with the OSC2 range / fine depths narrower. Keyed by block and high-byte offset.
RANGES2 = {}
for name, ranges in BLOCKS.items():
    for off0, i0, n in ranges:
        for j in range(n):
            iid, sub, mn, mx = SX[i0 + j]
            if sub == 1:
                e = D[CFG['cc'] + 12 * iid:CFG['cc'] + 12 * iid + 12]
                RANGES2.setdefault(name, {})[off0 + j] = [e[0], e[1], e[2]]

PATCH_CC = []
for i in range(0x4A):
    e = D[CFG['cc'] + 12 * i:CFG['cc'] + 12 * i + 12]
    PATCH_CC.append([e[2], 1 if e[4] == CFG['knobflag'] else 0, e[5], e[6], e[7] if e[7] != 0xFF else -1])

js = [f'// {CFG["name"]} firmware tables, generated by tools/roland/jp8080_fw.py. Do not edit by hand.',
      '// Rows: [offset, min, max, sub (1/2: high/low byte of a two-byte value), label, display format, argument, knob|menu]',
      '']
for name, rows in out.items():
    js.append(f'export const {name} = {json.dumps(rows)};')
js.append(f'export const LISTS = {json.dumps({str(k): v for k, v in LISTS.items()})};')
js.append('// Patch bytes 0-49h: [init value, 1 = knob / 0 = switch, MODE2 factory CC, MODE1 CC (96 = none), Tx/Rx slot (-1 = none)]')
js.append(f'export const PATCH_CC = {json.dumps(PATCH_CC)};')
js.append('// Two-byte values: [min, max, init] of the combined value (high byte x 128 + low), by block and high-byte offset.')
js.append(f'export const RANGES2 = {json.dumps({k: {str(o): r for o, r in v.items()} for k, v in RANGES2.items()})};')
name16 = lambda a: D[a:a + 16].decode('latin1').rstrip()
(pa, ps, p0, pn, pb), (fa, fs, f0, fn, fb) = CFG['presets']
PRESET_PATCHES = [[name16(pa + ps * (p0 + pn * b + i)) for i in range(pn)] for b in range(pb)]
PRESET_PERFS = [[name16(fa + fs * (f0 + fn * b + i)) for i in range(fn)] for b in range(fb)]
js.append('// Preset patch names (PRESET 1-3, A11-B88) and preset performance names (PRESET 1-3, 11-88) from the ROM records.')
js.append(f'export const PRESET_PATCHES = {json.dumps(PRESET_PATCHES)};')
js.append(f'export const PRESET_PERFORMANCES = {json.dumps(PRESET_PERFS)};')
open(sys.argv[2], 'w', encoding='utf-8').write('\n'.join(js) + '\n')
print('written', sys.argv[2], {k: len(v) for k, v in out.items()}, 'lists', sorted(LISTS))
