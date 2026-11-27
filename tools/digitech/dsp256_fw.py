"""DigiTech DSP-256 tables from the v1.05 EPROM, by running its own display routines (tools/yamaha/hd6303.py).

Usage: python -I tools/digitech/dsp256_fw.py FIRMWARE.bin OUT.js [--vectors VECTORS.json]

What runs (board model tools/digitech/dsp256_board.py; the system is booted from reset first, which loads the
factory presets as a battery failure does):
  - every configuration (program byte 0): its name from the Configuration page, its 22-word parameter list
    (6400h + 2Ch x c);
  - every parameter page of every configuration: the edit display (5034h) run for every value 0..max with the
    value in the edit buffer (0436h + p), the stored copy made different so the LCD shows the plain value (the
    unit puts the value in brackets while it equals the stored one); the label from line 1, the text from line 2,
    max from what the page routine leaves in ADh; each page run again with other values in the other bytes to
    show that no text depends on them;
  - the utility pages (46FAh: display, up, down routine per page): MIDI Channel, the "Linked to CC" list (the
    selector stepped through all names, each name's byte found by the value routine), the program map, Transmit
    Program Change, LCD Contrast, the foot controller function names (2A4Eh);
  - the 128 factory presets (titles 2A82h, 16 bytes; programs 3282h, 22 bytes);
  - --vectors: MIDI messages fed through the SCI interrupt and the main-loop parser: a 42h program dump, the 00h
    request (the 41h dump the unit sends), a program change through the map, the 01h request's jump to 0042h.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp256_board import Board  # noqa: E402

PROG_SIZE = 22
TITLE_LEN = 16
# Addresses: found in the image by code patterns (layout()), so the DSP-256 and DSP-256XL builds share this tool.
PATTERNS = {
    'lcd': ('C1 20 24 22 37 3C CE ?? ??', 7),                  # S3F83: the LCD shadow buffer
    'main': ('BD ?? ?? BD ?? ?? BD ?? ?? 20 F5', 0),          # the main loop
    'waitkey': ('7F 00 83 96 83 27 FC 4F 5F 97 83', 3),       # S43D6: a message waits for any key
    'repeat': ('96 83 26 04 96 88 26 F8', 0),                 # S51E8: the auto-repeat wait
    'edit': ('B6 ?? ?? 26 0B 86 FF 97 CD 86 ?? 4A 97 AD', 0),  # the edit display (5034h)
    'load': ('C1 7F 23 0A C0 80 86 16 3D C3 ?? ?? 20 06 86 16 3D C3 ?? ?? DD C0 CC ?? ?? DD C2 C6 16 BD ?? ?? CC ?? ?? FD ?? ?? '
             '7F ?? ?? F6 ?? ?? 86 2C 3D C3 ?? ?? DD C0 CC ?? ?? DD C2 C6 2C BD ?? ?? CC ?? ?? FD ?? ??', 0),
    'titles': ('C0 80 86 10 3D C3 ?? ?? 20 06 86 10 3D C3 ?? ?? 18 3C DF C0 CE ?? ??', 0),
    'util': ('96 91 C6 06 3D C3 ?? ??', 6),
    'dump': ('CC ?? ?? DD D7 CC ?? ?? DD D9 71 E7 D0', 0),
    'chan': ('F6 ?? ?? C1 10 2E 0B 36 84 0F', 1),
    'model': ('81 ?? 26 CE 96 C6 B7', 1),
    'pc': ('CE ?? ?? 3A A6 00 B7 ?? ?? BD', 0),
    'fn': ('87 CE ?? ?? 3A E6 00 5C C1 0E', 2),
    'patch': ('87 CE ?? ?? 3A E6 00 C1 FF', 2),
    'mode': ('B6 ?? ?? 26 22 5D 27 25', 1),
    'fnnames': ('37 58 CE ?? ?? 3A EE 00 BD', 3),
    'modetexts': ('CE ?? ?? BD ?? ?? 39 CE ?? ?? BD ?? ?? D6 87 CE', 0),
    'ids': ('24 09 CE ?? ?? F6 ?? ?? 3A A7 00 39', 3),
}


def find(d, pat):
    import re
    rx = re.compile(b''.join((b'.' if t == '??' else re.escape(bytes.fromhex(t))) for t in pat.split()), re.S)
    return [m.start() for m in rx.finditer(d)]


def layout(img):
    """Every address the tool uses, from the code that uses it."""
    at = {}
    for k, (pat, off) in PATTERNS.items():
        r = find(img, pat)
        assert r, 'pattern %s not found' % k
        at[k] = (r[0], r[0] + off)
    word = lambda a: w(img, a)
    m = at['load'][0]
    L = {
        'LCD_BUF': word(at['lcd'][1]), 'MAIN_LOOP': at['main'][0], 'WAIT_KEY': at['waitkey'][1], 'WAIT_REPEAT': at['repeat'][0],
        'EDIT_DISPLAY': at['edit'][0], 'PARAM': word(at['edit'][0] + 1), 'CONFIG_COUNT': img[at['edit'][0] + 10],
        'PRESET_PROGS': word(m + 10), 'USER_PROGS': word(m + 18), 'EDIT': word(m + 23), 'VALUE_PTR': word(m + 36),
        'CONFIG_TABLE': word(m + 48), 'PTR_TABLE': word(m + 53), 'TABLE_PTR': word(m + 66), 'CUR_PROG': word(m - 2),
        'PRESET_TITLES': word(at['titles'][0] + 6), 'USER_TITLES': word(at['titles'][0] + 14), 'TITLE_BUF': word(at['titles'][0] + 21),
        'UTIL_TABLE': word(at['util'][1]), 'DUMP_FROM': word(at['dump'][0] + 1), 'DUMP_TO': word(at['dump'][0] + 6),
        'CHANNEL': word(at['chan'][1]), 'MODEL': img[at['model'][1]], 'MAP': word(at['pc'][0] + 1),
        'FUNCS': word(at['fn'][1]), 'PATCHES': word(at['patch'][1]), 'MODE': word(at['mode'][1]),
        'FUNC_NAMES': word(at['fnnames'][1]), 'MODE_HAND': word(at['modetexts'][0] + 1), 'MODE_FOOT': word(at['modetexts'][0] + 8),
        'IDS': word(at['ids'][1]),
    }
    L['LINKS'] = L['CHANNEL'] + 1
    L['TRANSMIT'] = L['MAP'] + 128
    L['CONTRAST'] = L['DUMP_TO'] - 1
    assert L['CUR_PROG'] == L['CHANNEL'] - 1 and L['MODE'] == L['TRANSMIT'] + 1 and L['FUNCS'] == L['MODE'] + 1, L
    return L


# set by configure() from layout(); the DSP-256 v1.05 values are noted
CONFIG_TABLE = PRESET_PROGS = PRESET_TITLES = USER_PROGS = USER_TITLES = EDIT = TITLE_BUF = CUR_PROG = None  # 6400 3282 2A82 10CE 08CE 0436 0416 1E20
UTIL_TABLE = FUNC_NAMES = DUMP_FROM = DUMP_TO = LAYOUT = None  # 46FA 2A4E 08CE 1F24


def configure(img):
    global LAYOUT
    LAYOUT = layout(img)
    globals().update({k: v for k, v in LAYOUT.items() if k in (
        'CONFIG_TABLE', 'PRESET_PROGS', 'PRESET_TITLES', 'USER_PROGS', 'USER_TITLES', 'EDIT', 'TITLE_BUF', 'CUR_PROG',
        'UTIL_TABLE', 'FUNC_NAMES', 'DUMP_FROM', 'DUMP_TO')})
    return LAYOUT


def w(d, a):
    return (d[a] << 8) | d[a + 1]


def text_at(d, a):
    """A string record as S3F23 prints it: [blank from, blank count] or [control byte >= 80h], position, text, 0."""
    a += 2 if d[a] & 0x80 else 3
    s = bytearray()
    while d[a]:
        s.append(d[a])
        a += 1
    return s.decode('latin-1')


class Runner:
    def __init__(self, img):
        self.img = img
        self.L = configure(img)
        b = Board(img, self.L)
        b.boot()
        self.base = b

    def fresh(self):
        return copy.deepcopy(self.base)

    # ---------------------------------------------------------------- program pages
    def show(self, b, prog, p):
        """Run the edit display of parameter p for the 22 program bytes prog; returns (line1, line2, max, byte)."""
        r = b.ram
        r[CUR_PROG] = 0
        r[EDIT:EDIT + PROG_SIZE] = bytes(prog)
        stored = bytearray(prog)
        stored[p] = (prog[p] + 1) & 0xFF  # differs: the LCD shows the plain value, no brackets
        r[USER_PROGS:USER_PROGS + PROG_SIZE] = stored
        c = prog[0]
        L = self.L
        pt = L['PTR_TABLE']
        r[pt:pt + 0x2C] = self.img[CONFIG_TABLE + 0x2C * c:CONFIG_TABLE + 0x2C * (c + 1)]
        r[L['PARAM']] = p
        a = EDIT + p
        r[L['VALUE_PTR']], r[L['VALUE_PTR'] + 1] = a >> 8, a & 0xFF
        q = pt + 2 * p
        r[L['TABLE_PTR']], r[L['TABLE_PTR'] + 1] = q >> 8, q & 0xFF
        b.call(L['EDIT_DISPLAY'])
        l1, l2 = b.lcd()
        return l1.rstrip(), l2.strip(), r[0xAD], r[EDIT + p]

    def configs(self):
        b = self.fresh()
        out = []
        prog = bytearray(PROG_SIZE)
        names = []
        mx = None
        for c in range(self.L['CONFIG_COUNT']):  # the Configuration page's range (ldaa #count; deca)
            prog[0] = c
            l1, l2, m, _ = self.show(b, prog, 0)
            mx = m if mx is None else mx
            if c > m:
                break
            names.append(l2)
        for c, name in enumerate(names):
            ptrs = [w(self.img, CONFIG_TABLE + 0x2C * c + 2 * p) for p in range(PROG_SIZE)]
            n = 0
            while n < PROG_SIZE and ptrs[n]:
                n += 1
            out.append({'v': c, 'name': name, 'pages': n, 'ptrs': ptrs})
        return out, mx

    def pages(self, cfg, seeds=((0,), (5, 3, 7, 1, 9, 2, 4, 6, 8, 0, 3, 5, 7, 2, 1, 6, 9, 4, 8, 3, 2))):
        """Every parameter page 1..pages-1 of configuration cfg: label, max, texts; and a dependency check."""
        b = self.fresh()
        res = []
        for p in range(1, cfg['pages']):
            per_seed = []
            for seed in seeds:
                prog = bytearray(PROG_SIZE)
                prog[0] = cfg['v']
                for i in range(1, PROG_SIZE):
                    prog[i] = seed[(i - 1) % len(seed)]
                prog[p] = 0
                l1, l2, mx, _ = self.show(b, prog, p)
                texts, labels = [], set()
                for v in range(mx + 1):
                    prog[p] = v
                    l1, l2, m2, back = self.show(b, prog, p)
                    assert back == v and m2 == mx, (cfg['name'], p, v, back, m2, mx)
                    texts.append(l2)
                    labels.add(l1)
                per_seed.append((sorted(labels), mx, texts))
            labels, mx, texts = per_seed[0]
            dep = any(x != per_seed[0] for x in per_seed[1:])
            # the parameter's link id (5E8Dh stores it at 0400h + p): its "Linked to CC" byte
            by = None
            if dep:  # find the byte the texts follow and make a table for each of its values
                maxes = {}
                for q in range(1, cfg['pages']):
                    if q == p:
                        continue
                    prog = bytearray(PROG_SIZE)
                    prog[0] = cfg['v']
                    maxes[q] = self.show(b, prog, q)[2]
                deps = []
                for q, mq in maxes.items():
                    for vq in sorted({1, mq}):
                        prog = bytearray(PROG_SIZE)
                        prog[0] = cfg['v']
                        prog[q] = vq
                        if [self.show(b, prog, p)[1] for prog[p] in range(mx + 1)] != texts:
                            deps.append(q)
                            break
                assert len(deps) == 1, (cfg['name'], p, deps)
                q = deps[0]
                by = {'p': q, 'texts': []}
                for vq in range(maxes[q] + 1):
                    prog = bytearray(PROG_SIZE)
                    prog[0] = cfg['v']
                    prog[q] = vq
                    tt = []
                    for v in range(mx + 1):
                        prog[p] = v
                        l1, l2, m2, _ = self.show(b, prog, p)
                        assert m2 == mx
                        tt.append(l2)
                    by['texts'].append(tt)
                assert by['texts'][0] == texts
            res.append({'p': p, 'label': labels[0] if len(labels) == 1 else labels, 'max': mx, 'texts': texts, 'dep': dep, 'by': by,
                        'id': b.ram[self.L['IDS'] + p]})
        return res

    # ---------------------------------------------------------------- utility pages
    def util(self):
        img = self.img
        b = self.fresh()
        b.key(0x08, settle=6)
        L = self.L
        pages = []
        for i in range(self.page_count()):
            e = UTIL_TABLE + 6 * i
            pages.append((w(img, e), w(img, e + 2), w(img, e + 4)))
        out = {}
        shown = []
        for i, pg in enumerate(pages):
            try:
                shown.append(' '.join(self.fresh_page(i)))
            except Exception:  # an interactive page (the foot controller) waits for a switch
                shown.append('')
        idx = lambda text, n=0: [i for i, t in enumerate(shown) if text in t][n]
        out['pageTexts'] = shown

        def stepper(i, n, which=1):
            b2 = copy.deepcopy(b)
            b2.ram[0x91] = i
            b2.call(pages[i][0])
            seen = [b2.lcd()]
            snaps = [bytes(b2.ram[DUMP_FROM:DUMP_TO])]
            for _ in range(n):
                b2.call(pages[i][which])
                seen.append(b2.lcd())
                snaps.append(bytes(b2.ram[DUMP_FROM:DUMP_TO]))
            return b2, seen, snaps

        def changed(s0, s1):
            return [DUMP_FROM + k for k in range(len(s0)) if s0[k] != s1[k]]

        def reach(i, addr, start, line=1, prep=None):
            """Values the page's up and down routines reach from start, each with its LCD text: {byte: text}."""
            res = {}
            for which in (1, 2):
                if not pages[i][which]:
                    continue
                b2 = copy.deepcopy(b)
                if prep:
                    prep(b2)
                b2.ram[addr] = start
                b2.ram[0x91] = i
                b2.call(pages[i][0])
                res[b2.ram[addr]] = b2.lcd()[line].strip()
                for _ in range(300):
                    v0 = b2.ram[addr]
                    b2.call(pages[i][which])
                    v = b2.ram[addr]
                    if v == v0 or v in res:
                        break
                    res[v] = b2.lcd()[line].strip()
            return dict(sorted(res.items()))

        # MIDI Channel: 1E21h
        out['channel'] = {'label': 'MIDI Channel', 'texts': reach(idx('MIDI Channel'), L['CHANNEL'], 1)}
        # Linked to CC: the selector (CEh) through every name, each name's byte from the value routine
        links = []
        b2 = copy.deepcopy(b)
        sp, vp = idx('Linked to CC'), idx('Linked to CC', 1)
        b2.ram[0x91] = sp
        b2.call(pages[sp][0])
        first = b2.ram[0xCE]
        for _ in range(200):
            name = b2.lcd()[0].rstrip()
            sel = b2.ram[0xCE]
            b3 = copy.deepcopy(b2)
            b3.ram[0x91] = vp
            s0 = bytes(b3.ram[DUMP_FROM:DUMP_TO])
            b3.call(pages[vp][1])
            ch = changed(s0, b3.ram[DUMP_FROM:DUMP_TO])
            assert len(ch) == 1, (name, ch)
            links.append({'sel': sel, 'name': name, 'byte': ch[0]})
            b2.call(pages[sp][1])
            if b2.ram[0xCE] == first:
                break
        out['links'] = links
        # the values a link takes, on the first name's byte
        sel0 = links[0]
        out['linkTexts'] = {k: v.replace('Linked to CC', '').strip() for k, v in reach(vp, sel0['byte'], 0, prep=lambda bb: bb.ram.__setitem__(0xCE, sel0['sel'])).items()}
        # program map: MIDI program 1 (1E7Fh) -> internal program
        out['map'] = {'label': 'Midi Program / is ... on DSP256', 'texts': {k: v.replace('is', '').replace('on DSP256', '').strip() for k, v in reach(idx('Midi Program', 1), L['MAP'], 0).items()}}
        # Transmit Program Change: 1EFFh
        out['transmit'] = {'label': 'Transmit ProgramChange?', 'texts': {k: v.split()[-1] for k, v in reach(idx('Transmit'), L['TRANSMIT'], 1).items()}}
        # LCD Contrast: 1F23h
        out['contrast'] = {'label': 'LCD Contrast', 'texts': reach(idx('Contrast'), L['CONTRAST'], 0x40)}
        # foot controller: function names (pointer table 2A4Eh, 14 entries, 0-13) and the mode names
        out['functions'] = [text_at(img, w(img, FUNC_NAMES + 2 * k)) for k in range(14)]
        out['modes'] = {0xFF: text_at(img, L['MODE_HAND']), 0x00: text_at(img, L['MODE_FOOT'])}
        out['version'] = ' '.join(shown[idx('Version')].split())
        return out

    def version_page(self):
        for i in range(self.page_count()):
            try:
                l = self.fresh_page(i)
            except Exception:
                continue
            if 'Version' in l[1]:
                return l
        return ('', '')

    def page_count(self):
        r = find(self.img, '96 91 26 02 86 ?? 4A 97 91')  # page down: from page 0 to the last
        return self.img[r[0] + 5]

    def fresh_page(self, i):
        b = self.fresh()
        b.key(0x08, settle=6)
        b.ram[0x91] = i
        b.call(w(self.img, UTIL_TABLE + 6 * i))
        return b.lcd()

    # ---------------------------------------------------------------- presets
    def presets(self):
        img = self.img
        out = []
        for i in range(128):
            t = img[PRESET_TITLES + 16 * i:PRESET_TITLES + 16 * (i + 1)].decode('latin-1')
            p = img[PRESET_PROGS + PROG_SIZE * i:PRESET_PROGS + PROG_SIZE * (i + 1)]
            out.append([t.rstrip(), p.hex().upper()])
        return out

    def memory(self):
        """The dump area after the first power-up (factory init 42F7h)."""
        return bytes(self.base.ram[DUMP_FROM:DUMP_TO])

    # ---------------------------------------------------------------- vectors
    def vectors(self, presets):
        out = {}
        hdr = [0xF0, 0x00, 0x00, 0x10, 0x00, self.L['MODEL']]
        pairs = lambda data: [x for v in data for x in ((v >> 7) & 1, v & 0x7F)]
        # 42h: program 5 = factory preset 10 with a new title
        b = self.fresh()
        prog = bytes.fromhex(presets[10][1])
        title = b'Vector Program  '
        msg = hdr + [0x42] + pairs([5] + list(prog) + list(title)) + [0xF7]
        b.receive(msg)
        got = bytes(b.ram[USER_PROGS + 22 * 5:USER_PROGS + 22 * 6]), bytes(b.ram[USER_TITLES + 16 * 5:USER_TITLES + 16 * 6])
        assert got == (prog, title), got
        out['program'] = {'msg': msg, 'n': 5, 'program': list(prog), 'title': title.decode()}
        # 00h: the unit answers with the 41h dump of 08CEh-1F23h
        b = self.fresh()
        before = bytes(b.ram[DUMP_FROM:DUMP_TO])
        b.receive(hdr + [0x00, 0xF7], settle=4)
        guard = 0
        while (b.ram[0xD0] & 0x04) and guard < 4000:
            b.loop(1)
            guard += 1
        tx = b.tx
        assert tx[:7] == hdr + [0x41], tx[:8]
        data = [(tx[7 + 2 * k] << 7) | tx[8 + 2 * k] for k in range(DUMP_TO - DUMP_FROM)]
        assert bytes(data) == before and tx[-1] == 0xF7 and len(tx) == 8 + 2 * (DUMP_TO - DUMP_FROM)
        out['all'] = {'request': hdr + [0x00, 0xF7], 'length': len(tx), 'head': tx[:40], 'tail': tx[-9:]}
        # program change through the map: map MIDI program 3 to internal program 200 (factory 73)
        b = self.fresh()
        b.ram[self.L['MAP'] + 3] = 200
        b.receive([0xC0, 3], settle=8)
        out['programChange'] = {'map': [3, 200], 'current': b.ram[CUR_PROG], 'title': bytes(b.ram[TITLE_BUF:TITLE_BUF + 16]).decode('latin-1')}
        # wrong channel: ignored
        b = self.fresh()
        b.receive([0xF0, 0x00, 0x00, 0x10, 0x03, self.L['MODEL'], 0x42] + pairs([6] + list(prog) + list(title)) + [0xF7])
        out['otherChannel'] = {'stored': bytes(b.ram[USER_TITLES + 16 * 6:USER_TITLES + 16 * 7]) == title}
        # the device byte 06 and channel 17 (OMNI) take any channel
        b = self.fresh()
        b.ram[self.L['CHANNEL']] = 17
        b.receive([0xF0, 0x00, 0x00, 0x10, 0x03, self.L['MODEL'], 0x42] + pairs([6] + list(prog) + list(title)) + [0xF7])
        out['omni'] = {'stored': bytes(b.ram[USER_TITLES + 16 * 6:USER_TITLES + 16 * 7]) == title}
        return out


def emit(path, fw, cfgs, cfgmax, pages, util, presets, memory):
    tables, tindex = [], {}

    def tab(texts):
        k = json.dumps(texts)
        if k not in tindex:
            tindex[k] = len(tables)
            tables.append(texts)
        return tindex[k]

    configs = []
    for c in cfgs:
        ps = []
        for pg in pages[c['v']]:
            e = {'p': pg['p'], 'label': pg['label'], 'max': pg['max'], 't': tab(pg['texts']), 'id': pg['id']}
            if pg.get('by'):  # the texts follow another byte of the program: one table per value of it
                e['by'] = pg['by']['p']
                e['ts'] = [tab(t) for t in pg['by']['texts']]
            ps.append(e)
        configs.append({'v': c['v'], 'name': c['name'], 'params': ps})
    lines = [
        '// Generated by tools/digitech/dsp256_fw.py from the %s: do not edit.' % fw,
        '// CONFIGS: program byte 0 = v; params: program byte p, the label of its page (line 1), the highest value,',
        '// t = TABLES[t][value] the text the page shows for that value (line 2), id = its "Linked to CC" number;',
        '// by / ts: the texts follow program byte `by` (TABLES[ts[that byte]][value]).',
        'export const FIRMWARE = %s;' % json.dumps(fw),
        'export const CONFIG_MAX = %d;' % cfgmax,
        'export const CONFIGS = [',
    ]
    for c in configs:
        lines.append('  %s,' % json.dumps(c, separators=(',', ':')))
    lines.append('];')
    lines.append('export const TABLES = [')
    for t in tables:
        lines.append('  %s,' % json.dumps(t, separators=(',', ':')))
    lines.append('];')
    lines.append('// Utility pages: MIDI Channel (1E21h) texts per value, "Linked to CC" names in selector order with the')
    lines.append('// dump offset of each one\'s byte (1E22h + id), the CC values the link page shows, the program map texts')
    lines.append('// (1E7Fh + MIDI program: internal program), Transmit Program Change (1EFFh), LCD Contrast (1F23h),')
    lines.append('// the foot controller function names (1F01h + switch) and the controller modes (1F00h).')
    u = dict(util)
    u['links'] = [[x['byte'] - DUMP_FROM, x['name']] for x in util['links']]
    lines.append('export const UTILITY = %s;' % json.dumps(u, separators=(',', ':')))
    lines.append('// The 128 factory presets (programs 129-256): title, 22 program bytes.')
    lines.append('export const PRESETS = [')
    for t, h in presets:
        lines.append('  %s,' % json.dumps([t, h]))
    lines.append('];')
    lines.append('// The dump area (%04Xh-%04Xh, the 41h dump) after the first power-up: user titles and programs (the' % (LAYOUT['DUMP_FROM'], LAYOUT['DUMP_TO'] - 1))
    lines.append('// factory presets), each configuration\'s memory, the global settings.')
    lines.append('export const FIRST_POWER_UP = %s;' % json.dumps(memory.hex().upper()))
    L = LAYOUT
    f = L['DUMP_FROM']
    lay = {
        'model': L['MODEL'], 'dumpSize': L['DUMP_TO'] - f, 'titles': L['USER_TITLES'] - f, 'programs': L['USER_PROGS'] - f,
        'memory': L['USER_PROGS'] + 128 * PROG_SIZE - f, 'current': L['CUR_PROG'] - f, 'channel': L['CHANNEL'] - f, 'links': L['LINKS'] - f,
        'linkCount': L['MAP'] - L['LINKS'], 'map': L['MAP'] - f, 'transmit': L['TRANSMIT'] - f, 'mode': L['MODE'] - f,
        'functions': L['FUNCS'] - f, 'patches': L['PATCHES'] - f, 'contrast': L['CONTRAST'] - f,
        'spare': [a - f for a in list(range(L['FUNCS'] + 16, L['PATCHES'])) + list(range(L['PATCHES'] + 16, L['CONTRAST']))],
        'address': {'dump': f, 'links': L['LINKS'], 'map': L['MAP'], 'memory': L['USER_PROGS'] + 128 * PROG_SIZE,
                    'functions': L['FUNCS'], 'patches': L['PATCHES'], 'mode': L['MODE']},
    }
    lines.append('// Offsets in the 41h dump (address.dump = its first RAM address) and the model byte; found by code patterns.')
    lines.append('export const LAYOUT = %s;' % json.dumps(lay, separators=(',', ':')))
    open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')


def main():
    args = sys.argv[1:]
    vec = None
    if '--vectors' in args:
        i = args.index('--vectors')
        vec = args[i + 1]
        del args[i:i + 2]
    img = open(args[0], 'rb').read()
    out = args[1]
    r = Runner(img)
    ver = r.version_page()
    fw = 'DigiTech %s %s EPROM ("%s")' % (ver[0].strip().replace('DIGITECH ', ''), args[2] if len(args) > 2 else ver[1].strip().replace('Version ', 'v'), ver[0].strip() + ver[1].strip())
    cfgs, cfgmax = r.configs()
    print('configurations', len(cfgs), 'max', cfgmax)
    pages = {}
    for c in cfgs:
        pages[c['v']] = r.pages(c)
        deps = [p['p'] for p in pages[c['v']] if p['dep']]
        print(' %2d %-16s %2d pages%s' % (c['v'], c['name'], len(pages[c['v']]), (' texts follow ' + str([(p['p'], p['by']['p']) for p in pages[c['v']] if p['dep']])) if deps else ''))
    util = r.util()
    print('links', len(util['links']), 'functions', util['functions'])
    presets = r.presets()
    emit(out, fw, cfgs, cfgmax, pages, util, presets, r.memory())
    if vec:
        v = r.vectors(presets)
        json.dump(v, open(vec, 'w', encoding='utf-8', newline='\n'), indent=1)
        print('vectors', list(v))


if __name__ == '__main__':
    main()
