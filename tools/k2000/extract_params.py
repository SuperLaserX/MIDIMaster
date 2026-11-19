"""Extract the K2000 front-panel parameter map from the OS image.

The K2000 OS keeps its whole user interface in ROM objects:
  * page layouts   (type 109, "mel..."): which parameters a page shows and where
  * page titles    (type 107): LAYER, PITCH, LFO ... (same id as the page)
  * parameter table (Table 100:8 "pids"): for every parameter group, the data
    location, bit field, value ranges and the routine that formats the value.

This script reads all of them and then runs every parameter's own display
routine under a 68000 emulator (tools/k2000/fwemu.py) to capture the exact text
the K2000 shows for each value. Outputs:
  * JSON with everything (for inspection)
  * an ES module consumed by the K2000 editor

usage: python3 -I extract_params.py <k2000_387J.bin> <out.json> <out.js>
"""
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fwemu import Firmware, ROM_BASE  # noqa: E402

MAX_ENUM = 4096          # enumerate values (and run the display routine) up to this many per parameter
T_TABLE, T_TITLE, T_PAGE = 100, 107, 109

fw = Firmware(sys.argv[1])
rom = fw.rom


def u8(a): return rom[a - ROM_BASE]
def u16(a): return struct.unpack('>H', rom[a - ROM_BASE:a - ROM_BASE + 2])[0]
def s16(a): return struct.unpack('>h', rom[a - ROM_BASE:a - ROM_BASE + 2])[0]


def cstr(a):
    start = a - ROM_BASE
    end = rom.index(bytes(1), start)
    return rom[start:end].decode('latin1')


objects = fw.objects

# ------------------------------------------------------------------ pages
pages = {}
for (typ, oid), obj in sorted(objects.items()):
    if typ != T_PAGE:
        continue
    a = obj['addr']
    cnt = u16(a)
    if cnt == 0 or cnt > 100:
        continue
    items = []
    for i in range(cnt):
        e = a + 2 + i * 6
        t = u16(e)
        tg = e + 2 + s16(e + 2)
        it = {'type': t, 'g': u8(e + 4), 'i': u8(e + 5)}
        if t == 1:
            it.update(label=cstr(tg + 6), lc=u8(tg), lr=u8(tg + 1), vc=u8(tg + 3), vr=u8(tg + 4), vw=u8(tg + 5))
        elif t == 2:
            it.update(label=cstr(tg + 3), lc=u8(tg), lr=u8(tg + 1), vw=u8(tg + 2))
        items.append(it)
    title = objects.get((T_TITLE, oid))
    pages[oid] = {'name': obj['name'], 'title': title['name'] if title else '', 'items': items}

labels = {}
page_of_group = {}
for pid, pg in pages.items():
    for it in pg['items']:
        if it['type'] != 1:
            continue
        key = (it['g'], it['i'])
        if it['label'].strip():
            labels.setdefault(key, it['label'].strip())
        page_of_group.setdefault(it['g'], set()).add(pid)

# ------------------------------------------------------------- display lists
lists = []
list_index = {}


def intern(strings):
    key = json.dumps(strings)
    if key not in list_index:
        list_index[key] = len(lists)
        lists.append(strings)
    return list_index[key]


def values_of(ranges):
    out = []
    for lo, span in ranges:
        out.extend(range(lo, lo + span + 1))
        if len(out) > MAX_ENUM:
            return None
    return out


def simple_fmt(fmt):
    m = re.fullmatch(r'([^%]*)%ld([^%]*)', fmt)
    return (m.group(1), m.group(2)) if m else None


def numeric_fmt(fmt, vals, texts):
    """printf-style spec when every text is the plain number with fixed text around it."""
    sf = simple_fmt(fmt)
    if not sf:
        return None
    pre, post = sf
    if all(t == f'{pre}{v}{post}' for v, t in zip(vals, texts)):
        return f'{pre}%d{post}'
    return None


# ------------------------------------------------------------- parameters
table = objects[(T_TABLE, 8)]['addr']
ngroups = (min(table + 2 * g + s16(table + 2 * g) for g in range(64) if s16(table + 2 * g)) - table) // 2
groups = {}
stats = {'params': 0, 'numeric': 0, 'list': 0, 'raw': 0, 'failed': 0}
for g in range(ngroups):
    rel = s16(table + 2 * g)
    if rel == 0:
        continue
    t = table + 2 * g + rel
    cnt = u16(t)
    params = []
    for i in range(cnt):
        e = t + 4 + i * 8
        D = e + s16(e)
        fmt_addr = D + 6 + s16(D + 6)
        fmt = cstr(fmt_addr)
        nr = u16(D + 12)
        ranges = [[s16(D + 14 + 4 * k), u16(D + 16 + 4 * k)] for k in range(min(nr, 64))]
        p = {
            'label': labels.get((g, i), ''),
            'loc': u16(e + 2), 'ctx': u16(e + 4), 'off': u16(e + 6),
            'fn': u16(D), 'disp': u16(D + 2), 'parse': u16(D + 4), 'fmt': fmt,
            'flags': u8(D + 8), 'big': u8(D + 9), 'shift': u8(D + 10), 'width': u8(D + 11),
            'ranges': ranges, 'desc': D,
        }
        stats['params'] += 1
        vals = values_of(ranges)
        show = None
        if p['disp'] == 0x268:
            # Object reference: the K2000 prints "<id> <object name>"; names come from the device.
            show = {'obj': p['shift']}
            vals = None
        if vals is not None:
            texts, failed = [], 0
            for v in vals:
                fw.reset_ram()
                s, err = fw.display(p['disp'], fmt_addr, v, D) if p['disp'] else fw.sprintf(fmt_addr, v)
                if err:
                    failed += 1
                texts.append(s)
            if failed:
                p['emuFailed'] = failed
                stats['failed'] += 1
            else:
                nf = numeric_fmt(fmt, vals, texts)
                if all(not t.strip() for t in texts):
                    pass
                elif nf:
                    show = nf
                    stats['numeric'] += 1
                else:
                    show = intern([s.strip() for s in texts])
                    stats['list'] += 1
        if show is None:
            sf = simple_fmt(fmt)
            show = f'{sf[0]}%d{sf[1]}' if sf else '%d'
            stats['raw'] += 1
        p['show'] = show
        params.append(p)
    groups[g] = {'hdr': u16(t + 2), 'pages': sorted(page_of_group.get(g, ())), 'params': params}

print(stats, 'lists', len(lists), file=sys.stderr)

# ------------------------------------------------------------- derived names
# Page layouts are 40x8 character grids. Labels may be column headers (above a
# value) or row headers (left of it), so each value gets a name from geometry:
# "<row header> <column header>", preferring labels drawn by items that edit the
# same data location (pages overlay variants, e.g. local LFO2 vs global LFO2).
def derive_names(pg):
    items = pg['items']
    params = groups.get
    texts = []
    for it in items:
        if it['type'] == 1 and it['label'].strip():
            texts.append(it)

    def loc_of(it):
        grp = params(it['g'])
        if not grp or it['i'] >= len(grp['params']):
            return None
        return grp['params'][it['i']]['loc']

    out_names = []
    for it in items:
        if it['type'] != 1:
            out_names.append('')
            continue
        vc, vr = it['vc'], it['vr']
        my_loc = loc_of(it)

        def pick(cands):
            same = [c for c in cands if loc_of(c) == my_loc]
            return (same or cands)
        rows = pick([c for c in texts if c['lr'] == vr and c['lc'] + len(c['label']) <= vc])
        row = max(rows, key=lambda c: c['lc'])['label'].strip() if rows else ''
        cols = pick([c for c in texts if c['lr'] < vr and c['lc'] <= vc < c['lc'] + max(len(c['label']), 1)])
        col = max(cols, key=lambda c: c['lr'])['label'].strip() if cols else ''
        own = it['label'].strip()
        own_is_here = own and ((it['lr'] == vr and it['lc'] + len(it['label']) <= vc) or (it['lr'] < vr and it['lc'] <= vc < it['lc'] + len(it['label'])))
        if own_is_here and it['lr'] == vr and vc - (it['lc'] + len(it['label'])) <= 3:
            name = own                      # row label right next to its value
        else:
            if own_is_here and it['lr'] < vr:
                col = own                   # column header above the value
            name = ' '.join(x for x in (row, col) if x) or own
        out_names.append(name)
    # Make duplicates unique with a hint taken from the value's unit.
    seen = {}
    for k, it in enumerate(items):
        n = out_names[k]
        if not n:
            continue
        seen.setdefault(n, []).append(k)
    for n, ks in seen.items():
        if len(ks) < 2:
            continue
        for rank, k in enumerate(ks[1:], 2):
            it = items[k]
            grp = params(it['g'])
            p = grp['params'][it['i']] if grp and it['i'] < len(grp['params']) else None
            hint = ''
            if p and isinstance(p['show'], int):
                sample = ' '.join(lists[p['show']][-3:])
                hint = 'level' if '%' in sample else 'count' if 'X' in sample or 'Inf' in sample else 'time' if sample.endswith('s') else ''
            out_names[k] = f'{n} {hint}' if hint else f'{n} ({rank})'
    return out_names


for pid, pg in pages.items():
    for it, name in zip(pg['items'], derive_names(pg)):
        it['name'] = name

# ------------------------------------------------------------- modes / titles
# Title objects (type 107) carry [page id][parameter group] and name the K2000's
# modes, editor pages and DSP function pages.
modes = {}
for (typ, oid), obj in sorted(objects.items()):
    if typ == T_TITLE:
        a = obj['addr']
        modes[oid] = {'title': obj['name'], 'page': u8(a), 'group': u8(a + 1)}

# ------------------------------------------------------------- DSP functions
# Function code -> name (display routine 0x89) and width in blocks (0x117C5A),
# and the (code, start block, block) -> title table at 0x1881CF that picks the
# parameter page for each DSP block.
dsp_desc = None
for g in range(0x28, 0x48):
    for p in groups.get(g, {'params': []})['params']:
        if p['fn'] == 0x183 and p['disp']:
            dsp_desc = p
            break
    if dsp_desc:
        break
dsp_funcs = {}
for code in range(0, 128):
    fw.reset_ram()
    name, err = fw.display(dsp_desc['disp'], dsp_desc['desc'] + 6 + s16(dsp_desc['desc'] + 6), code, dsp_desc['desc'])
    fw.reset_ram()
    width, err2 = fw.call(0x117C5A, words_first=(code,))
    if not err and name and name.strip() and name.strip() not in ('???', 'none'):
        dsp_funcs[code] = {'name': name.strip(), 'width': (width or 1) & 0xffff}
title_rows = []
a = 0x1881CF
while u8(a + 3):
    title_rows.append([u8(a), u8(a + 1), u8(a + 2), u8(a + 3)])
    a += 4

# Algorithm names come from the type 102 objects (one per algorithm).
algorithms = {oid: obj['name'] for (typ, oid), obj in objects.items() if typ == 102 and 1 <= oid <= 31}

# Names of ROM objects that parameters refer to (LFO shapes, FUN functions,
# velocity/pressure maps, intonation tables, songs, setups...).
REF_TYPES = (103, 104, 105, 111, 112, 114, 115, 156)
rom_names = {}
for (typ, oid), obj in objects.items():
    if typ in REF_TYPES:
        rom_names.setdefault(typ, {})[oid] = obj['name']

out = {
    'version': '3.87J',
    'pages': {str(k): v for k, v in pages.items()},
    'groups': {str(k): v for k, v in groups.items()},
    'lists': lists,
    'modes': modes,
    'dspFunctions': dsp_funcs,
    'dspTitles': title_rows,
    'algorithms': algorithms,
    'romNames': rom_names,
    'objects': [{k: v for k, v in o.items() if k != 'entry'} for o in objects.values()],
}
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1)

# ------------------------------------------------------------------ JS module
FLAG_NAMES = None


def js_str(s):
    return json.dumps(s, ensure_ascii=False)


lines = []
lines.append('// Generated by tools/k2000/extract_params.py from the K2000 v3.87J OS image. Do not edit.')
lines.append('//')
lines.append('// PAGES:  page id -> { name, title, items: [type, group, index, label, labelCol, labelRow, valueCol, valueRow, valueWidth, name] }')
lines.append('//         type 1 = parameter (name = full name derived from the screen layout), 2 = soft button')
lines.append('// GROUPS: group -> [ { l: label, loc, ctx, off, t: storage flags, sh: shift, w: width, r: [[min, span]...],')
lines.append('//                     s: display (index into LISTS, printf format, or {obj: type} for object references),')
lines.append('//                     fn: edit routine, big: coarse step } ]')
lines.append('// Storage flags: low 3 bits 1=s8 2=s16 3=s32 5=u8 6=u16; 0x08 bit field; 0x10 clamp at ends (no wrap); 0x20 +/- key negates.')
lines.append('// MODES:  title object id -> { title, page, group } (modes, editor pages and DSP function pages)')
lines.append('// DSP_FUNCTIONS: function code -> { name, width (blocks) }')
lines.append('// DSP_TITLES: [function code (0 = any), start block, block, title id] picks the page for each DSP block')
lines.append('')
lines.append(f'export const FW_VERSION = {js_str(out["version"])};')
lines.append('')
lines.append('export const MODES = {')
for oid, m in sorted(modes.items()):
    lines.append(f'  0x{oid:02x}: {{ title: {js_str(m["title"])}, page: 0x{m["page"]:02x}, group: 0x{m["group"]:02x} }},')
lines.append('};')
lines.append('')
lines.append('export const DSP_FUNCTIONS = {')
for code, f in sorted(dsp_funcs.items()):
    lines.append(f'  {code}: {{ name: {js_str(f["name"])}, width: {f["width"]} }},')
lines.append('};')
lines.append('')
lines.append(f'export const DSP_TITLES = {json.dumps(title_rows)};')
lines.append('')
lines.append(f'export const ALGORITHMS = {json.dumps({str(k): v for k, v in sorted(algorithms.items())}, ensure_ascii=False)};')
lines.append('')
master = objects[(T_TABLE, 16)]
mbytes = rom[master['addr'] - ROM_BASE:master['addr'] - ROM_BASE + master['size']]
lines.append('// Factory Master table (Table 100:16) as stored in ROM: used by the demo K2000.')
lines.append(f'export const MASTER_DEFAULT = {js_str(mbytes.hex())};')
lines.append('')
lines.append('export const ROM_NAMES = {')
for typ, names in sorted(rom_names.items()):
    lines.append(f'  {typ}: {json.dumps({str(k): v for k, v in sorted(names.items())}, ensure_ascii=False)},')
lines.append('};')
lines.append('')
lines.append('export const LISTS = [')
for lst in lists:
    lines.append('  ' + json.dumps(lst, ensure_ascii=False) + ',')
lines.append('];')
lines.append('')
lines.append('export const PAGES = {')
for pid, pg in sorted(pages.items()):
    items = []
    for it in pg['items']:
        if it['type'] == 1:
            items.append([1, it['g'], it['i'], it['label'], it['lc'], it['lr'], it['vc'], it['vr'], it['vw'], it.get('name', '')])
        elif it['type'] == 2:
            items.append([2, it['g'], it['i'], it['label'], it['lc'], it['lr'], 0, 0, it['vw']])
        else:
            items.append([it['type'], it['g'], it['i']])
    lines.append(f'  0x{pid:02x}: {{ name: {js_str(pg["name"])}, title: {js_str(pg["title"])}, items: {json.dumps(items, ensure_ascii=False)} }},')
lines.append('};')
lines.append('')
lines.append('export const GROUPS = {')
for g, grp in sorted(groups.items()):
    lines.append(f'  0x{g:02x}: [ // pages {", ".join(pages[p]["name"] for p in grp["pages"]) or "-"}')
    for p in grp['params']:
        s = p['show'] if isinstance(p['show'], int) else json.dumps(p['show'], ensure_ascii=False)
        lines.append(
            f'    {{ l: {js_str(p["label"])}, loc: 0x{p["loc"]:03x}, ctx: 0x{p["ctx"]:03x}, off: 0x{p["off"]:x}, '
            f't: 0x{p["flags"]:02x}, sh: {p["shift"]}, w: {p["width"]}, r: {json.dumps(p["ranges"])}, s: {s}, '
            f'fn: 0x{p["fn"]:03x}, big: {p["big"]} }},')
    lines.append('  ],')
lines.append('};')
lines.append('')
with open(sys.argv[3], 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(lines))
print('wrote', sys.argv[3], os.path.getsize(sys.argv[3]), 'bytes', file=sys.stderr)
