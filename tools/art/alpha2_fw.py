# ART Multiverb Alpha 2 and Alpha 2 SE: build the editor's firmware tables and test vectors from an EPROM
# image (Z80 code). The two models share their software; the SE (1993-94) moved the code, added four
# ROM preset banks, a bit-packed preset format and other SysEx messages. Every address is found by code
# pattern (PATTERNS, A2_PATTERNS, SE_PATTERNS below), so one tool reads both:
#
#   python -I tools/art/alpha2_fw.py "<image .bin>" <out .js> <vectors .json>
#   Alpha 2 v2.02 (27C512):  ... js/devices/defs/art-multiverb-alpha2-fw.js tests/art-multiverb-alpha2.vectors.json
#   Alpha 2 SE (27C1001):    ... js/devices/defs/art-multiverb-alpha2-se-fw.js tests/art-multiverb-alpha2-se.vectors.json
#   (the SE module is made from v1.03: the v1.04 image's configuration table has two bytes that break
#   PRODUCTION presets 27 and 28, which the tool reports; see docs/devices/art-multiverb-alpha2-se.md)
#
# Board model in tools/art/alpha2_board.py; listings (re/fx/tools/z80dis.py) and notes in re/fx/art-alpha2/
# and re/fx/art-alpha2se/. What it reads (Alpha 2 addresses; the image's own are printed to stderr and the
# SE table module's header names them):
#   1897 + 2t     the long names of effect types 0-24 (length-prefixed, as ADD EFFECT shows them);
#                 1679 + 3t: the three-letter abbreviations of types 0-27 (LPF ... MIX EQL AES)
#   20BA + 3t     type t: number of parameters and the address of its 11-byte parameter records
#                 (name pointer, min, max, the value the DSP gets while the effect is not in the preset
#                 (1BC8), the value while its X-15 switch is off (80h = not affected, 1BDD), default, type,
#                 X-15 switch, order (not used by the MIDI code), display format)
#   1788 + 5c     configuration c (0-53): the effect types of its chain (FFh = end); every chain starts
#                 with LOW-PASS; 210E: the sizes of the EQ (7) and A.E.S. (1) blocks
#   2CD7          the parameter display of edit mode (C155 = parameter number 1-29, descriptors from
#                 C1EF built by 1F7E): run in the emulator for every value of every parameter of every
#                 configuration; the LCD shadow C265 holds the text
#   381B / 382A   UTILITY and MIDI pages (C151 / C152 = page); 2A54 / 2989 their value limits
#   2D63          a controller's name (PERFORMANCE MIDI page 2 and the FX ON/OFF controllers)
#   3AEA + 12n    the eleven X-15 FX ON/OFF switch names
#   04C7          what a factory reset (0305) copies to C0B1-C0D8 (MIDI and utility settings)
#   B32B (bank 7) the 115 factory preset pointers; B09E the empty preset; 6A38 loads a preset into the
#                 edit buffer C0E6 (98 bytes), 6CDB packs it back (C5D4 = length, C5D5 = bytes)
# SE only (v1.03 addresses): page 7 + b (image E000 + 2000h * b) holds ROM bank b (A000 name, A002 count,
# A003 preset pointers, A005 lengths); the directory C6B9 holds per preset slot a RAM address or a ROM
# reference (L = preset, H = 0 the selected BANK C0DA, 1-4 bank H - 1; 6FED); 7062 loads slot C0B1, 72BC
# packs the edit buffer (bit fields, 6C27) to C630 / C631; 6FC6 the empty preset; UTILITY pages SLOT (3F39,
# C0E7 = slot) and BANK (3FBD), their custom characters from 4DA5.
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from alpha2_board import Board  # noqa: E402

N_CONFIGS = 0x36
TUNER = 22

# '?? ' any byte, '<name' a 16-bit operand (2 bytes), '<name.' a byte, '=name' the address at that point;
# ' | ' separates alternatives. A pattern may match more than once when every match reads the same values.
PATTERNS = {
    'names': 'd5 21 <names cd ?? ?? d1 c9 cd',
    'abbr': '80 6f 26 00 11 <abbr 19 eb c9',
    'types': 'c5 47 21 <types 87 80 c1 cf c9',
    'configs': '54 5d 29 29 19 11 <configs 19',
    'chunks': '3e 03 90 21 <chunks 47 16 04',
    'x15': '80 87 87 21 <x15 cf eb 06 0c',
    'defaults': '21 <defaults 11 b1 c0 01 <ndefaults. 00 ed b0',
    'directory': '06 c8 11 <directory cd ?? ?? 3e 00 32',
    'lcd': 'e5 f5 21 <lcd 3a <cursor',
    'display': '=display cd ?? ?? 3a <pnum cd ?? ?? 32 ?? ?? ed 43 ?? ?? ed 53 ?? ?? 22 ?? ?? 78 cd ?? ?? 3e 3a cd',
    'descs': '21 ?? ?? 11 <descs 01 06 00 ed b0 21 ?? ?? 06 34',
    'tuner': 'fe 08 20 06 3a <auto 32',
    'pages': '=util 3a <uvar 21 ?? ?? fe <nutil. da ?? ?? af c3 ?? ?? =midi 3a <mvar 21 ?? ?? fe <nmidi. da',
    'apply': '=apply 21 <rxbuf 11 <edit 01 62 00 ed b0 3a',
    'clear': '=clear 2a ?? ?? 22 ?? ?? eb 21 8e dd af ed 52',
    'pagevar': '3a <pagevar d3 28 c9 3a ?? c0 21 ?? ?? cf 32 | 3a <pagevar 18 f8 3a ?? c0 21 ?? ?? cf 32',
    # routine entries (signatures of their first instructions, address operands masked)
    'build': '=build 3a ?? ?? 21 ?? ?? be 20 18 3a ?? ?? 21 ?? ?? be 20 0f ed 5b ?? ?? 2a ?? ??',
    'ctrlname': '=ctrlname cd ?? ?? 11 ?? ?? 06 0b cd ?? ?? 11 ?? ?? 06 03 cd ?? ?? cd ?? ?? dd 7e 00 fe 80',
    'pmparam': '=pmparam cd ?? ?? 11 ?? ?? 06 03 cd ?? ?? 11 ?? ?? cd ?? ?? 11 ?? ?? cd ?? ?? af dd be 03',
    'pmlow': '=pmlow 11 ?? ?? 06 05 21 ?? ?? 18 08 11 ?? ?? 06 06 21 ?? ?? e5 c5 d5',
    'pmhigh': '=pmhigh 11 ?? ?? 06 06 21 ?? ?? e5 c5 d5 cd ?? ?? d1 c1 c5',
    'switch': '=switch f5 47 87 80 87 87 21 ?? ?? cf eb 06 0c',
    'store': '=store 3a ?? ?? b7 28 1f 4f 06 08 dd 21 ?? ?? 11 ?? ?? cb 39 30 0d dd 7e 03',
}
A2_PATTERNS = {
    'load': '=load cd ?? ?? 30 01 2b 23 cd ?? ?? 2b 11 <ledit cd',
    'pack': '=pack 11 <pbuf d5 cd ?? ?? 21 ?? ?? 01 06 00 ed b0',
}
SE_PATTERNS = {
    'load': '=load cd ?? ?? 38 01 23 11 <ledit cd ?? ?? eb cd',
    'pack': '=pack 11 <pedit cd ?? ?? 11 <pbuf 21 ?? ?? cd ?? ?? 32 <plen',
    'empty': '7d 21 02 a0 be 38 05 21 <empty 18',
    'slotvar': '3a <slotvar cd ?? ?? 38 ?? 28 ?? e5 3d 11',  # UTILITY page SLOT
    'glyphs': 'cb 27 21 <glyphs cf cd ?? ?? 3e 02',  # its custom characters (U, A-E)
}
SWITCH_STATES = 0xC0CF  # the X-15 switch states (same in both)


def w(img, a):
    return struct.unpack_from('<H', img, a)[0]


def match(img, pattern, end=0xA000):
    for alt in pattern.split(' | '):
        got, n = match1(img, alt, end)
        if got:
            return got, n
    return None, 0


def match1(img, pattern, end):
    toks = pattern.split()
    rx = b''
    caps = []  # (name, kind, offset)
    off = 0
    for t in toks:
        if t == '??':
            rx += b'.'
            off += 1
        elif t.startswith('='):
            caps.append((t[1:], 'at', off))
        elif t.startswith('<'):
            one = t.endswith('.')
            caps.append((t[1:].rstrip('.'), 'b' if one else 'w', off))
            rx += b'.' if one else b'..'
            off += 1 if one else 2
        else:
            rx += re.escape(bytes([int(t, 16)]))
            off += 1
    hits = [m.start() for m in re.finditer(rx, img[:end], re.S)]
    seen = []
    for h in hits:
        seen.append({name: h + o if kind == 'at' else img[h + o] if kind == 'b' else w(img, h + o) for name, kind, o in caps})
    if not hits or any(x != seen[0] for x in seen):
        return None, len(hits)
    return seen[0], len(hits)


def detect(img):
    """The addresses this image keeps its tables and routines at (PATTERNS), and which model it is."""
    L = {}
    for key, pat in PATTERNS.items():
        got, n = match(img, pat)
        assert got, f'pattern {key}: {n} matches'
        L.update(got)
    se = match(img, SE_PATTERNS['load'])[0] is not None
    for key, pat in (SE_PATTERNS if se else A2_PATTERNS).items():
        got, n = match(img, pat)
        assert got, f'pattern {key}: {n} matches'
        L.update(got)
    assert L['ledit'] == L['edit'] and L.get('pedit', L['edit']) == L['edit']
    L['plen'] = L.get('plen', L['pbuf'] - 1)
    L['pm'] = L['edit'] + 0x32
    L['se'] = se
    return L


def lcd_line(b, n):
    return b.lcd()[n].decode('latin1')


def main():
    img = open(sys.argv[1], 'rb').read()
    out_js, out_vec = sys.argv[2], sys.argv[3]
    banner = img[0x0F:0x1F].decode('latin1')
    date = img[0x21:0x31].split(b'\xff')[0].decode('latin1')
    L = detect(img)
    SE = L['se']
    if SE:
        assert banner.startswith('Alpha 2 SE'), banner
    else:
        assert len(img) == 0x10000 and banner == '  ALPHA v2.02   ', 'not the Alpha 2 v2.02 image'
    EDIT, LCD = L['edit'], L['lcd']
    print('addresses:', ' '.join(f'{k}={v:04X}' for k, v in sorted(L.items()) if isinstance(v, int) and not isinstance(v, bool)), file=sys.stderr)

    # ------------------------------------------------------------ effect types and configurations
    names = []
    for t in range(25):
        p = w(img, L['names'] + 2 * t)
        names.append(img[p + 1:p + 1 + img[p]].decode('latin1'))
    names += ['MIX', 'EQUALIZER', 'ACU ENV SIM']  # ADD EFFECT list (16D1) for 26 / 27
    types = []
    desc_at = {}
    for t in range(28):
        n = img[L['types'] + 3 * t]
        p = w(img, L['types'] + 3 * t + 1)
        params = []
        for i in range(n):
            e = img[p + 11 * i:p + 11 * i + 11]
            nm = img[w(e, 0):w(e, 0) + 6].decode('latin1')
            assert e[7] == t
            params.append({'name': nm.strip(), 'min': e[2], 'max': e[3], 'unused': e[4], 'off': e[5], 'def': e[6], 'x15': e[8], 'order': e[9], 'fmt': e[10]})
            desc_at[p + 11 * i] = (t, i)
        types.append({'name': names[t], 'abbr': img[L['abbr'] + 3 * t:L['abbr'] + 3 * t + 3].decode('latin1'), 'params': params})
    configs = []
    broken = []
    for c in range(N_CONFIGS):
        row = []
        for k in range(5):
            v = img[L['configs'] + 5 * c + k]
            if v >= 0x80:
                break
            row.append(v)
        ok = row[0] == 0 and len(set(row)) == len(row) and sum(len(types[t]['params']) for t in row) <= 18
        if not ok:
            assert SE, f'configuration {c}: {row}'
            broken.append(c)
        configs.append(row)
    assert list(img[L['chunks']:L['chunks'] + 2]) == [7, 1]
    ndef = L['ndefaults']
    defaults = list(img[L['defaults']:L['defaults'] + ndef])

    b = Board(img, LCD)
    if SE:
        for i in range(200):
            b.poke(L['directory'] + 2 * i, [i, 0])  # 7020: slot k = the selected bank's preset k
    else:
        fact = [w(img, 0xC000 - 0x8000 + w(img, 0x31) + 2 * i) for i in range(115)]
        null = w(img, 0x33)
        assert w(img, 0x31) == 0xB32B and null == 0xB09E
        for i in range(200):
            p = fact[i] if i < 115 else null
            b.poke(L['directory'] + 2 * i, [p & 0xFF, p >> 8])
    b.poke(L['pagevar'], [5])
    b.call(L['clear'])
    b.poke(0xC0B1, defaults)

    def clear():
        b.poke(LCD, b' ' * 32)
        b.poke(L['cursor'], [0, 0])  # cursor: line 1, column 1

    def defaults_for(cfg):
        """The 98-byte edit buffer the editor starts from: header zero, every value at its default."""
        e = bytearray(98)
        e[2] = cfg
        for i, p in enumerate(types[25]['params']):
            e[4 + i] = p['def']
        for i, p in enumerate(types[26]['params']):
            e[7 + i] = p['def']
        e[14] = types[27]['params'][0]['def']
        at = 15
        for t in configs[cfg]:
            for p in types[t]['params']:
                if at < 33:
                    e[at] = p['def']
                at += 1
        e[0x21:0x31] = b' ' * 16
        for k in range(8):
            e[0x32 + 6 * k:0x38 + 6 * k] = bytes([4, 0, 0x7F, 0, 0, 0xFF])
        return e

    # ------------------------------------------------------------ parameter display texts
    def show(n):
        clear()
        b.poke(L['pnum'], [n])
        b.call(L['display'])
        return lcd_line(b, 1)

    def split(line, t, i):
        ab = types[t]['abbr'].rstrip()
        s = line
        assert s.startswith(types[t]['abbr'][:3].rstrip()) or s[:3].rstrip() == ab, (line, t)
        rest = s[4:]
        if '=' in rest:
            k = rest.index('=')
            return rest[:k].strip(), rest[k + 1:].strip()
        return types[t]['params'][i]['name'], rest.strip()

    variants = {}  # (t, i) -> list of {label, values, configs}
    tuner_refs = {}

    def record(cfg, t, i, label, values):
        lst = variants.setdefault((t, i), [])
        for v in lst:
            if v['label'] == label and v['values'] == values:
                v['configs'].append(cfg)
                return
        lst.append({'label': label, 'values': values, 'configs': [cfg]})

    tuner_type = types[TUNER]['params'][0]
    for cfg in range(N_CONFIGS):
        if cfg in broken:
            continue
        e = defaults_for(cfg)
        e[1], e[3] = 3, 0x1F
        b.poke(EDIT, e)
        b.call(L['build'])
        total = 11 + sum(len(types[t]['params']) for t in configs[cfg])
        for n in range(1, total + 1):
            dp = b.peek(L['descs'] + 2 * (n - 1), 2)
            t, i = desc_at[dp[0] | dp[1] << 8]
            if cfg and t >= 25:
                continue  # MIX, EQ and A.E.S. look the same in every configuration
            p = types[t]['params'][i]
            at = EDIT + 4 + n - 1

            def enumerate_values():
                label = None
                values = []
                for v in range(p['min'], p['max'] + 1):
                    b.poke(at, [v])
                    lb, txt = split(show(n), t, i)
                    if label is None:
                        label = lb
                    assert lb == label, (cfg, t, i, v, lb, label)
                    values.append(txt)
                b.poke(at, [p['def']])
                return label, values
            if (t, i) == (TUNER, 1):
                # REFRNC (32DC) lists the notes of the strings TYPE picks, the byte before it; value 8 shows
                # the note AUTO has picked (DDAA), which reads AUTO until it has picked one
                b.poke(L['auto'], [8])
                order = [tuner_type['def']] + [ty for ty in range(tuner_type['min'], tuner_type['max'] + 1) if ty != tuner_type['def']]
                for ty in order:
                    b.poke(at - 1, [ty])
                    label, values = enumerate_values()
                    tuner_refs[ty] = {'label': label, 'values': values, 'when': [0, ty]}
                b.poke(at - 1, [tuner_type['def']])
                continue
            label, values = enumerate_values()
            record(cfg, t, i, label, values)
    variants[(TUNER, 1)] = list(tuner_refs.values())
    texts = []
    for t in range(28):
        row = []
        for i in range(len(types[t]['params'])):
            if 'when' in variants[(t, i)][0]:
                row.append(variants[(t, i)])  # chosen by another parameter's value: [parameter, value]
                continue
            lst = sorted(variants[(t, i)], key=lambda v: -len(v['configs']))
            out = []
            for k, v in enumerate(lst):
                x = {'label': v['label'], 'values': v['values']}
                if k:
                    x['configs'] = v['configs']
                out.append(x)
            row.append(out)
        texts.append(row)

    # ------------------------------------------------------------ utility and MIDI pages
    def page(var, entry, idx, poke=None):
        clear()
        if poke:
            b.poke(*poke)
        b.poke(var, [idx])
        b.call(entry)
        return lcd_line(b, 0).strip(), lcd_line(b, 1)

    def values(var, entry, idx, addr, lo, hi, clean):
        out = []
        title = None
        for v in range(lo, hi + 1):
            t1, l2 = page(var, entry, idx, (addr, [v]))
            title = title or t1
            out.append(clean(t1, l2))
        return title, out

    eqs = lambda _t, s: s.strip().lstrip('=').strip()  # noqa: E731
    U, M = (L['uvar'], L['util']), (L['mvar'], L['midi'])
    nu = L['nutil']
    ux = nu - 9  # the SE puts SLOT and BANK before the Alpha 2's nine UTILITY pages
    util = {}
    for key, (vm, idx, addr, hi) in {
        'bypassLevel': (U, ux + 0, 0xC0B9, 0x20), 'remote1': (U, ux + 1, 0xC0B7, 0x7F), 'remote2': (U, ux + 2, 0xC0B8, 3),
        'autoPm': (U, ux + 3, 0xC0C2, 2), 'lcdAngle': (U, ux + 4, 0xC0BC, 7), 'lock': (U, ux + 8, 0xC0B3, 1),
        'channel': (M, 2, 0xC0B4, 16), 'omni': (M, 3, 0xC0B5, 1), 'fxEnable': (M, 6, 0xC0C3, 1),
    }.items():
        title, vals = values(vm[0], vm[1], idx, addr, 0, hi, eqs)
        util[key] = {'title': title, 'values': vals}
    util['autoPm']['title'] = 'AUTO PM DISPLAY'
    util['lcdAngle']['values'] = [v.split('=')[-1].strip() for v in util['lcdAngle']['values']]
    util['lcdAngle']['title'] = 'LCD VIEW ANGLE'
    lock_title = re.search(r'PRESET 1\.\.\d+', img[:0xA000].decode('latin1')).group(0)
    util['lock']['title'] = lock_title
    n_factory = int(lock_title.split('..')[1])
    util['channel']['values'] = [v.split('=')[-1].strip() for v in util['channel']['values']]
    util['channel']['title'] = 'MIDI CHANNEL'
    util['omni']['values'] = [v.split('=')[-1].strip() for v in util['omni']['values']]
    util['omni']['title'] = 'OMNI MODE'
    util['fxEnable']['values'] = [v.replace('(USING X-15)', '').strip() for v in util['fxEnable']['values']]
    for key, addr in (('pm', 0xC0BE), ('prog', 0xC0BD)):  # checked at 5ACA (controllers) / 5A93 (program change)
        vals = []
        for v in (0, 1):
            b.poke(0xC0BD, [0]); b.poke(0xC0BE, [0])
            _t, l2 = page(M[0], M[1], 0, (addr, [v]))
            part = l2.split('PROG=') if key == 'prog' else l2.split('PROG=')[0].split('PM=')
            vals.append(part[1].strip())
        util[key] = {'title': 'MIDI ENABLE ' + key.upper(), 'values': vals}
    t1, l2 = page(M[0], M[1], 4, (0xC0B6, [5]))
    util['mpt'] = {'title': t1, 'value': l2.strip()}
    pages = {'utility': [page(U[0], U[1], i)[0] for i in range(nu)], 'midi': [page(M[0], M[1], i)[0] for i in range(L['nmidi'])]}
    util['version'] = ' '.join(x.strip() for x in page(U[0], U[1], ux + 5))

    # controllers (2D63): 0-120 MC n, 121-127 other sources, 128 OFF
    ctrl = []
    slot = L['pm']
    for v in range(0x81):
        b.poke(slot, [v])
        clear()
        b.cpu.ix = slot
        b.cpu.r[1] = 1
        b.call(L['ctrlname'])
        ctrl.append(lcd_line(b, 1).strip())
    pm_titles = {}
    for key, entry, at3 in (('param', L['pmparam'], 1), ('controller', L['ctrlname'], 1), ('low', L['pmlow'], 1), ('high', L['pmhigh'], 1), ('none', L['pmparam'], 0)):
        b.poke(slot, [4, 0, 0x1F, at3, 0, 0xFF])
        clear()
        b.cpu.ix = slot
        b.cpu.r[1] = 1
        b.call(entry)
        pm_titles[key] = lcd_line(b, 0).strip() if key != 'none' else lcd_line(b, 1).strip()
    x15 = [img[L['x15'] + 12 * k:L['x15'] + 12 * k + 12].decode('latin1').strip() for k in range(11)]
    # 3ACD (A = switch) shows the switch name and its ON/OFF status
    fx_status = []
    for st in (0, 1):
        b.poke(SWITCH_STATES + 4, [st])
        clear()
        b.cpu.a = 4
        b.call(L['switch'])
        fx_status.append(lcd_line(b, 0)[12:].strip().lstrip('='))

    if SE:
        se_presets(img, L, b, types, configs, broken, texts, util, pages, pm_titles, fx_status, ctrl, x15, defaults, n_factory, banner, date, out_js, out_vec, defaults_for)
        return

    # ------------------------------------------------------------ factory presets
    def load(n, base):
        b.poke(EDIT, base)
        b.poke(0xC0B1, [n])
        b.call(L['load'])
        return b.peek(EDIT, 98)

    def pack():
        b.call(L['pack'])
        n = b.peek(L['plen'])[0]
        return b.peek(L['pbuf'], n)

    bank7 = lambda a: a - 0x8000 + 0xC000  # noqa: E731
    factory = []
    titles = []
    vectors = []
    for n in range(115):
        src = bank7(fact[n])
        cfg = img[src + 2]
        e = load(n, defaults_for(cfg))
        pk = pack()
        assert pk == img[src:src + len(pk)], f'factory preset {n + 1}: packing differs from ROM'
        factory.append(pk.hex())
        titles.append(e[0x21:0x31].decode('latin1'))
        vectors.append({'n': n, 'packed': pk.hex(), 'expanded': e.hex()})
    nl = bank7(null)
    e = load(150, defaults_for(img[nl + 2]))
    empty = pack()
    assert empty == img[nl:nl + len(empty)]
    vectors.append({'n': 150, 'packed': empty.hex(), 'expanded': e.hex()})
    # packing round trips of edited buffers: every configuration with everything present
    for cfg in range(N_CONFIGS):
        e = defaults_for(cfg)
        e[0], e[1], e[3] = 0x2D, 3, (1 << len(configs[cfg])) - 1
        e[0x21:0x31] = b'Config %2d chain ' % cfg
        e[0x31] = 0x85
        for k in range(8):
            # controller, low, high, parameter 1 + k; byte 4 holds the parameter's value (6AEE stores it back)
            e[0x32 + 6 * k:0x38 + 6 * k] = bytes([4 + k, 1, 30, 1 + k, e[4 + k], 0xFF])
        # as an edit buffer message (05) arrives: its bytes in C49D, then task 13 (5DB6) takes them
        b.poke(L['rxbuf'], e)
        b.call(L['apply'])
        pk = pack()
        b.poke(0xC0B1, [150])
        # store it as preset 151 the way STORE does (6AEE), then load it back into a cleared buffer
        b.call(L['store'])
        back = load(150, defaults_for(cfg))
        vectors.append({'cfg': cfg, 'source': e.hex(), 'packed': pk.hex(), 'expanded': back.hex()})

    # ------------------------------------------------------------ output
    js = []
    js.append('// Generated by tools/art/alpha2_fw.py from the ART Multiverb Alpha 2 v2.02 EPROM image')
    js.append('// ("ART Jul 15, 1992", 27C512, Z80). Do not edit by hand: run the tool again.')
    js.append('// TYPES[t]: effect type t (0-24 the digital effects, 25 MIX, 26 EQUALIZER, 27 A.E.S.): name (1897 /')
    js.append('// 16D1), LCD abbreviation (1679), parameters from the 11-byte records of table 20BA: min, max, the DSP')
    js.append('// value while the effect is not in the preset, value while its X-15 switch is off (128 = not affected),')
    js.append('// default, X-15 switch, order,')
    js.append('// display format. CONFIGS[c]: the effect types of configuration c in chain order (1788).')
    js.append('// TEXTS[t][i]: the LCD label and value texts of parameter i of type t (min..max), as the edit-mode')
    js.append('// display (2CD7) shows them, run in a Z80 emulator; later entries apply to the listed configurations,')
    js.append('// or (when) while parameter when[0] of the same effect has value when[1] (TUNER REFRNC follows TYPE).')
    js.append('// UTIL: the UTILITY / MIDI page titles and value texts (381B / 382A); CTRL: controller names')
    js.append('// 0-128 (2D63); X15: the FX ON/OFF switch names (3AEA); DEFAULTS: C0B1-C0D8 after a factory reset')
    js.append('// (04C7); FACTORY: the 115 factory presets as packed in ROM (pointers B32B, bank 7); EMPTY: the')
    js.append('// empty preset (B09E).')
    js.append('export const FIRMWARE = ' + json.dumps('Multiverb Alpha 2 v2.02 (Jul 15, 1992)') + ';')
    common_out(js, types, configs, texts, util, pages, pm_titles, fx_status, ctrl, x15, defaults)
    js.append('export const FACTORY = ' + json.dumps(factory, separators=(',', ':')) + ';')
    js.append('export const FACTORY_TITLES = ' + json.dumps(titles, separators=(',', ':')) + ';')
    js.append('export const EMPTY = ' + json.dumps(empty.hex()) + ';')
    with open(out_js, 'w', newline='\n') as f:
        f.write('\n'.join(js) + '\n')
    with open(out_vec, 'w', newline='\n') as f:
        json.dump({'firmware': 'Multiverb Alpha 2 v2.02', 'note': 'Generated by tools/art/alpha2_fw.py: presets loaded (6A38) and packed (6CDB) by the firmware in the emulator', 'vectors': vectors}, f, separators=(',', ':'))
    print('types', len(types), 'configs', len(configs), 'factory', len(factory), 'steps', b.cpu.steps, file=sys.stderr)


def common_out(js, types, configs, texts, util, pages, pm_titles, fx_status, ctrl, x15, defaults):
    js.append('export const TYPES = ' + json.dumps(types, separators=(',', ':')) + ';')
    js.append('export const CONFIGS = ' + json.dumps(configs, separators=(',', ':')) + ';')
    js.append('export const TEXTS = ' + json.dumps(texts, separators=(',', ':')) + ';')
    js.append('export const UTIL = ' + json.dumps(util, separators=(',', ':')) + ';')
    js.append('export const PAGES = ' + json.dumps(pages, separators=(',', ':')) + ';')
    js.append('export const PM_TITLES = ' + json.dumps(pm_titles, separators=(',', ':')) + ';')
    js.append('export const FX_STATUS = ' + json.dumps(fx_status, separators=(',', ':')) + ';')
    js.append('export const CTRL = ' + json.dumps(ctrl, separators=(',', ':')) + ';')
    js.append('export const X15 = ' + json.dumps(x15, separators=(',', ':')) + ';')
    js.append('export const DEFAULTS = ' + json.dumps(bytes(defaults).hex()) + ';')


def se_presets(img, L, b, types, configs, broken, texts, util, pages, pm_titles, fx_status, ctrl, x15, defaults, n_factory, banner, date, out_js, out_vec, defaults_for):
    """The SE's ROM banks, packed format and SLOT / BANK pages."""
    EDIT, DIR = L['edit'], L['directory']
    U = (L['uvar'], L['util'])

    def page_of(bk):
        b.bank = 7 + bk
        return lambda a, n=1: b.peek(a, n)

    def load(slot, base):
        b.poke(EDIT, base)
        b.poke(0xC0B1, [slot])
        b.call(L['load'])
        return b.peek(EDIT, 98)

    def pack():
        b.call(L['pack'])
        n = b.peek(L['plen'])[0]
        return b.peek(L['pbuf'], n)

    cfg_of = lambda p: (p[1] >> 2) & 0x3F  # noqa: E731  6 bits switches, 2 bits blocks, 6 bits configuration
    banks = []
    vectors = []
    slot = 199
    for bk in range(4):
        pg = page_of(bk)
        hdr = pg(0xA000, 7)
        name_at, count, ptrs, lens = w(hdr, 0), hdr[2], w(hdr, 3), w(hdr, 5)
        name = pg(name_at, 24).split(bytes(1))[0].decode('latin1')
        presets, titles = [], []
        for i in range(count):
            pg = page_of(bk)
            at, n = w(pg(ptrs + 2 * i, 2), 0), pg(lens + i)[0]
            rom = pg(at, n)
            b.poke(DIR + 2 * slot, [i, bk + 1])  # a ROM reference: preset i of bank bk
            e = load(slot, defaults_for(min(cfg_of(rom), N_CONFIGS - 1)))
            pk = pack()
            if cfg_of(rom) in broken:  # the image's chain cannot hold what the preset was made with
                print(f'bank {bk} preset {i + 1}: configuration {cfg_of(rom)} is broken in this image', file=sys.stderr)
                pk = rom
            assert pk == rom, f'bank {bk} preset {i + 1}: packing differs from ROM'
            presets.append(pk.hex())
            titles.append(e[0x21:0x31].decode('latin1'))
            vectors.append({'bank': bk, 'n': i, 'packed': pk.hex(), 'expanded': e.hex()})
        banks.append({'name': name.strip('"'), 'presets': presets, 'titles': titles})
    # an OPEN slot past the selected bank's last preset, or a reference to none: the empty preset (6FC7)
    b.poke(DIR + 2 * slot, [0xFF, 0])
    e = load(slot, defaults_for(0))
    empty = pack()
    assert empty == img[L['empty']:L['empty'] + len(empty)]
    vectors.append({'n': -1, 'packed': empty.hex(), 'expanded': e.hex()})
    # packing round trips of edited buffers: every configuration with everything present
    for cfg in range(N_CONFIGS):
        if cfg in broken:
            continue
        e = defaults_for(cfg)
        e[0], e[1], e[3] = 0x2D, 3, (1 << len(configs[cfg])) - 1
        e[0x21:0x31] = b'Config %2d chain ' % cfg
        e[0x31] = 0x85
        for k in range(8):
            e[0x32 + 6 * k:0x38 + 6 * k] = bytes([4 + k, 1, 30, 1 + k, e[4 + k], 0xFF])
        b.poke(L['rxbuf'], e)
        b.call(L['apply'])
        pk = pack()
        b.poke(0xC0B1, [150])
        b.call(L['store'])  # STORE (70A7): into user RAM unless it equals a ROM preset
        ent = b.peek(DIR + 2 * 150, 2)
        assert 0xC0 <= ent[1] < 0xE0, f'configuration {cfg}: not stored in RAM'
        back = load(150, defaults_for(cfg))
        vectors.append({'cfg': cfg, 'source': e.hex(), 'packed': pk.hex(), 'expanded': back.hex()})

    # ------------------------------------------------------------ SLOT and BANK pages (UTILITY 0 and 1)
    glyphs = {}
    for k in range(6):
        p = w(img, L['glyphs'] + 2 * k)
        glyphs[bytes(img[p:p + 8])] = 'UABCDE'[k]

    def page(idx, pokes=()):
        b.poke(L['lcd'], b' ' * 32)
        b.poke(L['cursor'], [0, 0])
        for a, v in pokes:
            b.poke(a, v)
        b.poke(U[0], [idx])
        b.call(U[1])
        l1, l2 = b.lcd()
        g = glyphs.get(bytes(b.cgram[16:24]), '?')
        return (l1.decode('latin1').replace('\x02', g), l2.decode('latin1').replace('\x02', g))

    bank_page = []
    for bk in range(4):
        l1, l2 = page(1, [(0xC0DA, [bk])])
        bank_page.append([l1.rstrip(), l2.rstrip()])
    slot_page = {}
    for key, ent in (('ram', None), ('open', [5, 0]), ('bank1', [5, 1]), ('bank2', [5, 2]), ('bank3', [5, 3]), ('bank4', [5, 4])):
        s = 150 if ent is None else 7
        if ent:
            b.poke(DIR + 2 * s, ent)
        l1, l2 = page(0, [(L['slotvar'], [s])])
        slot_page[key] = [l1.rstrip(), l2.rstrip()]
    pages['utility'][0] = slot_page['open'][1].split('=')[0].strip()  # the pages' line 1 is their value
    pages['utility'][1] = bank_page[0][1].split('=')[0].strip()
    # line 1 the bank's name, line 2 "BANK = <letter>"
    bank_util = {'title': bank_page[0][1].split('=')[0].strip(), 'values': [x[1].split('=', 1)[1].strip() + ' ' + x[0].strip() for x in bank_page]}

    # ------------------------------------------------------------ output
    ver = banner.split()[-1]
    js = []
    js.append(f'// Generated by tools/art/alpha2_fw.py from the ART Multiverb Alpha 2 SE v{ver} EPROM image')
    js.append(f'// ("{date}", 27C1001, Z80). Do not edit by hand: run the tool again.')
    js.append('// The tables have the Alpha 2\'s meaning (art-multiverb-alpha2-fw.js); here at: names %04X, abbreviations' % L['names'])
    js.append('// %04X, parameter records %04X, configurations %04X, edit display %04X, UTILITY / MIDI pages %04X / %04X,' % (L['abbr'], L['types'], L['configs'], L['display'], L['util'], L['midi']))
    js.append('// controller names %04X, switch names %04X; DEFAULTS: C0B1-C0%02X after a factory reset (%04X).' % (L['ctrlname'], L['x15'], 0xB0 + len(defaults), L['defaults']))
    js.append('// BANKS: the four ROM preset banks (page 7 + b at A000: name, count, preset pointers, lengths), each')
    js.append('// preset as packed in ROM (bit fields, packed by %04X) and its title; EMPTY: the empty preset (%04X).' % (L['pack'], L['empty']))
    js.append('// BANK_PAGE / SLOT_PAGE: the UTILITY pages BANK (C0DA) and SLOT as the LCD shows them (custom')
    js.append('// characters as the letters they draw: U = user RAM, A-D = the banks; SLOT shows bank 4 as a number).')
    js.append('// BROKEN: configurations whose chain the image gets wrong (not offered by the editor).')
    js.append('export const FIRMWARE = ' + json.dumps(f'Multiverb Alpha 2 SE v{ver} ({date})') + ';')
    common_out(js, types, configs, texts, util, pages, pm_titles, fx_status, ctrl, x15, defaults)
    js.append('export const N_FACTORY = ' + json.dumps(n_factory) + ';')
    js.append('export const BANKS = ' + json.dumps(banks, separators=(',', ':')) + ';')
    js.append('export const EMPTY = ' + json.dumps(empty.hex()) + ';')
    js.append('export const BANK_UTIL = ' + json.dumps(bank_util, separators=(',', ':')) + ';')
    js.append('export const SLOT_PAGE = ' + json.dumps(slot_page, separators=(',', ':')) + ';')
    js.append('export const BROKEN = ' + json.dumps(broken) + ';')
    with open(out_js, 'w', newline='\n') as f:
        f.write('\n'.join(js) + '\n')
    with open(out_vec, 'w', newline='\n') as f:
        json.dump({'firmware': f'Multiverb Alpha 2 SE v{ver}', 'note': 'Generated by tools/art/alpha2_fw.py: presets loaded (%04X) and packed (%04X) by the firmware in the emulator' % (L['load'], L['pack']), 'vectors': vectors}, f, separators=(',', ':'))
    print('types', len(types), 'configs', len(configs), 'broken', broken, 'banks', [(x['name'], len(x['presets'])) for x in banks], 'steps', b.cpu.steps, file=sys.stderr)


if __name__ == '__main__':
    main()
