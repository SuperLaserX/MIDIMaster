# Rocktron Intellifex LTD: build js/devices/defs/rocktron-intellifex-fw.js from the v1.0 EPROM image
# (Jan 1995, 27C256, 8031 code at 12 MHz).
#
#   python -I tools/rocktron/intellifex_fw.py "<image .bin>" > js/devices/defs/rocktron-intellifex-fw.js
#
# What it reads (addresses in the image; listing and Ghidra project in re/fx/rocktron-intellifex/):
#   45A0 + 16c    names of the six configurations (block diagrams; 9B-9E are a letter with an arrow)
#   320F + 64c    the parameter pages a preset of configuration c keeps, in byte order (byte 1 + i)
#   3209 + c      the highest PARA number (controller assignment) of configuration c
#   368F + 18c    the blocks (menu columns) of configuration c; 37AF + 15b: the pages of block b
#                 (row 2 on), title = record 6C + b; blocks 80h and up are the utility menus (3944 + 9n)
#   39B0 + 16p    page p's LCD label; 12C8 + p: how many values page p takes (0 = unused page)
#   08F4          display routine of the edit pages (jump table 0905, one entry per page): run in the
#                 8051 emulator (tools/alesis/i8051.py) for every value; the 16 characters it leaves
#                 in IRAM 70-7F are decoded through the segment font at 1834 (two bytes per character
#                 from 20h; bit 15 = decimal point, so 60-7F are '0.'-'9.' etc.; '!' is a small 'o')
#   0AF8          display routine of the utility pages (MIDI channel, mapping, controller assignments)
#   1C54 + 13n    names of the 80 factory presets (81-160); 2084 + 55n: their parameter bytes
#   2064          the controller assignments a factory restore gives every user preset
#   1BCA / 1BCF   globals 1BEA-1BEE after restore code 10 / 249; 1BD4: code 10's program map
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'alesis'))
from i8051 import Cpu  # noqa: E402

FONT, LABELS, COUNTS = 0x1834, 0x39B0, 0x12C8
PAGE_LIST, PARA_MAX, BLOCKS, BLOCK_PAGES, CONFIG_NAMES = 0x320F, 0x3209, 0x368F, 0x37AF, 0x45A0
ROM_NAMES, ROM_DATA, CTRL_DEFAULT = 0x1C54, 0x2084, 0x2064
ARROW = {0x9B: 'Y', 0x9C: 'H', 0x9D: 'S', 0x9E: 'T'}


class Image:
    def __init__(self, d):
        self.d = d
        self.img = d + bytes(65536 - len(d))
        self.glyph = {}
        for c in range(0x20, 0x60):
            self.glyph.setdefault(self.font(c), chr(c))

    def font(self, c):
        a = FONT + (c - 0x20) * 2
        return (self.d[a] << 8) | self.d[a + 1]

    def char(self, c):
        """What the 16-segment display shows for character code c."""
        if c in ARROW:
            return ARROW[c] + '>'
        if c == 0x21:
            return 'o'  # segments c, d, e, g: a small o (-oo is minus infinity)
        f = self.font(c)
        base = self.glyph.get(f & 0x7FFF, '?') if f & 0x7FFF else ''
        if f & 0x8000:
            return (base if base != ' ' else '') + '.'
        return base or ' '

    def text(self, bs):
        return ''.join(self.char(c) for c in bs)

    def label(self, p):
        return self.d[LABELS + 16 * p: LABELS + 16 * p + 16].decode('latin-1')

    def cpu(self):
        c = Cpu(self.img)
        c.ram[0x81] = 0x30
        return c


def page_texts(im, p, count, extra=None):
    out = []
    for v in range(count):
        c = im.cpu()
        c.ram[0x2D] = p
        for i in range(16):
            c.ram[0x70 + i] = im.d[LABELS + 16 * p + i]
        for k, x in (extra or {}).items():
            c.setind(0x80 + k, x)
        c.setind(0x80 + p, v)
        c.call(0x08F4)
        out.append(im.text(bytes(c.ram[0x70:0x80])))
    return out


def util_text(im, page, block, xram):
    c = im.cpu()
    c.ram[0x2D] = page
    c.ram[0x2B] = block
    for a, v in xram.items():
        c.x[a] = v
    c.call(0x0AF8)
    return im.text(bytes(c.ram[0x70:0x80]))


def split(lines):
    """(name, values): the common prefix of the 16-character lines cut back to a word, and the rest."""
    k = 0
    while all(len(s) > k for s in lines) and len({s[k] for s in lines}) == 1:
        k += 1
    pre = lines[0][:k]
    if ' ' in pre and not pre.endswith(' '):
        k = pre.rfind(' ') + 1
    return ' '.join(lines[0][:k].split()), [' '.join(s[k:].split()) for s in lines]


def values(lines):
    return split(lines)[1]


def main():
    d = open(sys.argv[1], 'rb').read()
    assert len(d) == 32768 and b'ROCKTRON INTELLIFEX-LTD' in d and b'LTD VERSION m00' in d, 'not an Intellifex LTD v1.0 image'
    im = Image(d)
    counts = d[COUNTS:COUNTS + 0x6C]

    configs = []
    used = set()
    for c in range(6):
        lst = []
        for p in d[PAGE_LIST + 64 * c: PAGE_LIST + 64 * c + 64]:
            if not p:
                break
            lst.append(p)
        blocks = []
        for b in d[BLOCKS + 18 * c: BLOCKS + 18 * c + 18]:
            if b < 2 or b >= 0x80:
                continue
            pages = [p for p in d[BLOCK_PAGES + 15 * b + 2: BLOCK_PAGES + 15 * b + 15] if p]
            pages = pages[:pages.index(0)] if 0 in pages else pages
            blocks.append({'block': b, 'title': ' '.join(im.label(0x6C + b).replace('*', ' ').split()), 'pages': pages})
        in_blocks = [p for b in blocks for p in b['pages']]
        # (a page may sit in two blocks: REVERB LVL is in MIXER and REVERB of configurations 0 and 1)
        assert set(in_blocks) == set(lst) and len(set(lst)) == len(lst), 'config %d: block pages differ from the preset list' % c
        assert len(lst) <= 54 and d[PARA_MAX + c] == len(lst) - 1
        used.update(lst)
        name = ' '.join(im.text(d[CONFIG_NAMES + 16 * c: CONFIG_NAMES + 16 * c + 16]).split()).replace('> ', '>')
        configs.append({'name': name, 'params': lst, 'blocks': blocks})

    pages = [None] * 0x6C
    for p in sorted(used):
        n = counts[p]
        assert n, 'page %02X has no range' % p
        name, texts = split(page_texts(im, p, n))
        plain = all(t == str(v) for v, t in enumerate(texts))
        pages[p] = {'label': name, 'screen': im.label(p), 'count': n, 'texts': None if plain else texts}
    # DLY TIME1 / TIME2 read page 23h (D TYPE): 2-TAP doubles the step (09E3)
    two_tap = {p: values(page_texts(im, p, counts[p], {0x23: 2})) for p in (0x1D, 0x21)}
    assert two_tap[0x1D] != pages[0x1D]['texts']

    # utility pages as the unit shows them
    numb = values([util_text(im, 2, 0x82, {0x81: v}) for v in range(0x7A)])
    chan = values([util_text(im, 0x24, 0x87, {0x1BEE: v}) for v in range(0x12)])
    onoff = values([util_text(im, 0x22, 0x86, {0x1BEA: v}) for v in range(2)])
    foot = values([util_text(im, 0x25, 0x88, {0x1BEB: v}) for v in range(2)])
    mapto = [' '.join(util_text(im, 0x23, 0x86, {0x0001: v})[12:].split()) for v in range(0xA1)]
    util = {
        'numb': numb, 'midiChannel': chan, 'offOn': onoff, 'footswitch': foot, 'mapTo': mapto,
        'labels': {k: ' '.join(d[0x42E0 + 16 * p: 0x42F0 + 16 * p].decode('latin-1').split()) for k, p in
                   (('numb', 2), ('para', 3), ('ulim', 4), ('llim', 5), ('progMapping', 0x22), ('mapTo', 0x23),
                    ('midiChannel', 0x24), ('bypass', 0x25), ('incDec', 0x26), ('enterCode', 0x27))},
        'blocks': {k: ' '.join(im.label(r).replace('*', ' ').split()) for k, r in
                   (('title', 0x87), ('controller', 0x89), ('mapping', 0x8D), ('channel', 0x8E), ('footswitch', 0x8F), ('dump', 0x90), ('restore', 0x92))},
    }

    rom_names = [d[ROM_NAMES + 13 * n: ROM_NAMES + 13 * n + 13].decode('latin-1') for n in range(80)]
    rom = []
    for n in range(80):
        r = d[ROM_DATA + 55 * n: ROM_DATA + 55 * n + 55]
        c = r[0] & 7
        c = c if c < 6 else 0
        for i, p in enumerate(configs[c]['params']):
            assert r[1 + i] < counts[p], 'factory preset %d byte %d out of range' % (n, i + 1)
        rom.append(r.hex())

    js = []
    js.append('// Generated by tools/rocktron/intellifex_fw.py from the Rocktron Intellifex LTD v1.0 EPROM image')
    js.append('// (Jan 1995, 27C256). Do not edit by hand: run the tool again.')
    js.append('// CONFIGS[c]: name (45A0), params = the pages a preset keeps in bytes 1.. (320F), blocks = the')
    js.append('// menu columns with their pages (368F / 37AF). PAGES[p]: LCD label (39B0), value count (12C8) and')
    js.append('// the text the display routine (08F4, run in an 8051 emulator) shows for each value; texts null')
    js.append('// when the display is the plain number.')
    js.append('export const FIRMWARE = ' + json.dumps('Intellifex LTD v1.0 (Jan 1995)') + ';')
    js.append('export const CONFIGS = ' + json.dumps(configs, separators=(',', ':')) + ';')
    js.append('export const PAGES = ' + json.dumps(pages, separators=(',', ':')) + ';')
    js.append('/** DLY TIME1 / DLY TIME2 when D TYPE is 2-TAP (09E3: 10 ms steps instead of 5). */')
    js.append('export const TWO_TAP_TIMES = ' + json.dumps(two_tap[0x1D], separators=(',', ':')) + ';')
    js.append('/** Utility pages (0AF8) and block titles. */')
    js.append('export const UTIL = ' + json.dumps(util, separators=(',', ':')) + ';')
    js.append('/** Factory presets 81-160: 13-character titles (1C54) and 55 parameter bytes (2084, hex; byte 0 =')
    js.append(' *  configuration + 8, 14 for 160 BYPASS). CTRL_DEFAULT: the 32 controller-assignment bytes (2064). */')
    js.append('export const ROM_NAMES = ' + json.dumps(rom_names, separators=(',', ':')) + ';')
    js.append('export const ROM_PRESETS = ' + json.dumps(rom, separators=(',', ':')) + ';')
    js.append('export const CTRL_DEFAULT = ' + json.dumps(d[CTRL_DEFAULT:CTRL_DEFAULT + 32].hex()) + ';')
    js.append('/** FACTORY RESTORE: globals 1BEA-1BEE and the program map for ENTER CODE 249 (108A) and 10 (10AF). */')
    js.append('export const RESTORE = ' + json.dumps({
        '249': {'marker': 0x17, 'globals': list(d[0x1BCF:0x1BD4]), 'map': list(range(128))},
        '10': {'marker': 0x0A, 'globals': list(d[0x1BCA:0x1BCF]), 'map': list(d[0x1BD4:0x1C54])},
    }, separators=(',', ':')) + ';')
    sys.stdout.write('\n'.join(js) + '\n')


if __name__ == '__main__':
    main()
