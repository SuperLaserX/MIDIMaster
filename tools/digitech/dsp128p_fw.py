"""DigiTech DSP-128 Plus tables from the v2.00 EPROM, by running its own display routines (tools/yamaha/hd6303.py).

Usage: python -I tools/digitech/dsp128p_fw.py FIRMWARE.bin OUT.js [--vectors VECTORS.json]

What runs (board model tools/digitech/dsp128p_board.py, whose copy of the image has the character font replaced so that
the four display bytes read back as text; the system is booted from reset first, which loads the factory programs as a
battery failure does):
  - every configuration (program byte 0, 0-14): its page 1 text (the record interpreter ED4F on the configuration
    record) and its parameter list (12 words at 8040h + 18h x c);
  - every parameter page (program bytes 1-11) of every configuration: the record interpreter run for every value 0..max
    with the value in the program, as the panel's page and value keys run it ($8C = page, $A8 = 0, 400Ch = FFh: one
    record); the text from the display composition buffer (90h-93h) at the display call (F737), max from what the
    record leaves in 86h, the MIDI link number from the record (byte 2); each page run again with other values in the
    other bytes, and a page whose texts follow another byte gets one table per value of that byte;
  - the MIDI pages (F84C: page 0 the channel, pages 1-44 the controller of each link number, names from F93Bh);
  - the 128 factory programs (D8F0h, 12 bytes each: what the first power-up writes into 5000h) and the 15
    configuration start programs (DEF0h: what switching the configuration on the panel loads, E8AF);
  - --vectors: MIDI messages fed through the SCI interrupt and the main-loop parser: the 00 request (the 41h dump the
    unit sends), a 41h dump received, a program change, a controller moving a linked parameter, the wrong channel.
"""
import copy
import json
from collections import Counter
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp128p_board import Board  # noqa: E402

PROG = 12
CONFIG_TABLE = 0x8040   # 18h bytes per configuration: 12 record pointers (page 1 = the configuration record)
FACTORY = 0xD8F0        # 128 x 12: the first power-up's programs (D86E copies them to 5000h)
STARTS = 0xDEF0         # 15 x 12: the program a configuration switch loads (E8AF)
LINK_NAMES = 0xF93B     # 2 characters per link number 1..50 (MIDI pages F84C)
LINK_MAX = 0xF4B8       # type 14h records: the value range by record byte 3
PROGRAMS = 0x5000
SETTINGS = 0x4049       # 51 bytes in the dump: channel, links 1-50
SETTINGS_END = 0x407B
CONFIGS = 15            # $C5 - 1 without an expansion ROM at 6000h
EDIT = 0xED4F           # record interpreter
SHOW = 0xF737           # display buffer select: the text is in 90h-93h when it is called
MIDI_PAGE = 0xF84C


def cells_of(text):
    """A display text as its four digits: (character, point)."""
    out = []
    i = 0
    while i < len(text):
        dp = i + 1 < len(text) and text[i + 1] == '.'
        out.append((text[i], dp))
        i += 2 if dp else 1
    return out


def w(img, a):
    return (img[a - 0x8000] << 8) | img[a - 0x8000 + 1]


def by(img, a):
    return img[a - 0x8000]


class Runner:
    def __init__(self, img):
        self.img = img
        b = Board(img)
        b.boot()
        self.base = b
        self.shots = []

    def fresh(self):
        b = copy.deepcopy(self.base)
        self.shots = []
        b.cpu.hooks[SHOW] = lambda c: (self.shots.append(b.text()), False)[1]
        return b

    def ptrs(self, c):
        return [w(self.img, CONFIG_TABLE + 0x18 * c + 2 * i) for i in range(PROG)]

    # ---------------------------------------------------------------- program pages
    def show(self, b, prog, page):
        """Run page `page` (1 = configuration, 2-12 = program byte page-1) for the 12 program bytes; (text, max)."""
        b.setmem(PROGRAMS, prog)
        b.poke(0xAD, 0)
        b.poke(0x80, prog[0])
        b.call(0xD6D8)  # table base for the configuration
        ps = self.ptrs(prog[0])
        p = ps[page - 1]
        assert p, (prog[0], page)
        # the range records (13h) keep their value in RAM (408Fh ...) for the next record (14h) to show: run them first,
        # without display, as loading the program does (EC5C runs every record)
        for q in range(2, PROG + 1):
            if q != page and ps[q - 1] and by(self.img, ps[q - 1]) == 0x13:
                self.run_record(b, ps[q - 1], q, display=False)
        self.run_record(b, p, page, display=True)
        assert self.shots, (prog[0], page)
        return self.shots[-1], b.iram[0x86], b.peek(PROGRAMS + page - 1)

    def run_record(self, b, rec, page, display):
        b.poke(0xC9, rec >> 8)
        b.poke(0xCA, rec & 0xFF)
        b.poke(0x8C, page)
        b.poke(0xA8, 0 if display else 0xFF)
        b.poke(0x409B, 0xFF)  # no scrolling: the plain display mode
        b.poke(0x400C, 0xFF)  # one record
        del self.shots[:]
        b.call(EDIT)

    def configs(self):
        b = self.fresh()
        out = []
        for c in range(CONFIGS):
            prog = bytearray(self.img[STARTS - 0x8000 + PROG * c:STARTS - 0x8000 + PROG * (c + 1)])
            assert prog[0] == c
            text, _, _ = self.show(b, prog, 1)
            ps = self.ptrs(c)
            rec = ps[0]
            out.append({'v': c, 'name': text, 'lamps': [by(self.img, rec + 5), by(self.img, rec + 6)],
                        'pages': [i + 1 for i in range(1, PROG) if ps[i]], 'ptrs': ps})
        return out

    def texts(self, b, prog, page, mx):
        prog = bytearray(prog)
        out = []
        for v in range(mx + 1):
            prog[page - 1] = v
            t, m2, back = self.show(b, prog, page)
            assert m2 == mx and back == v, (prog[0], page, v, m2, mx, back)
            out.append(t)
        return out

    def pages(self, cfg):
        b = self.fresh()
        c = cfg['v']
        start = bytearray(self.img[STARTS - 0x8000 + PROG * c:STARTS - 0x8000 + PROG * (c + 1)])
        res = []
        for page in cfg['pages']:
            rec = cfg['ptrs'][page - 1]
            prog = bytearray(start)
            _, mx, _ = self.show(b, prog, page)
            texts = self.texts(b, prog, page, mx)
            # other values in the other bytes (each within its own page's range)
            maxes = {}
            for q in cfg['pages']:
                maxes[q] = self.show(b, bytearray(start), q)[1]
            dep = []
            for q in cfg['pages']:
                if q == page:
                    continue
                for vq in sorted({0, maxes[q]}):
                    p2 = bytearray(start)
                    p2[q - 1] = vq
                    if self.texts(b, p2, page, mx) != texts:
                        dep.append(q)
                        break
            assert len(dep) <= 1, (cfg['name'], page, dep)
            entry = {'p': page - 1, 'rec': rec, 'type': by(self.img, rec), 'link': by(self.img, rec + 2), 'max': mx, 'texts': texts,
                     'label': self.label(rec, texts)}
            if dep:
                q = dep[0]
                tables = []
                for vq in range(maxes[q] + 1):
                    p2 = bytearray(start)
                    p2[q - 1] = vq
                    tables.append(self.texts(b, p2, page, mx))
                entry['by'] = q - 1
                entry['tables'] = tables
                entry['texts'] = tables[start[q - 1]]
            res.append(entry)
        return res

    def label(self, rec, texts):
        """The characters a page shows before its value: the record's two prefix characters (rec + 4, + 5) for the
        number records, the first two digits most of a text table's values share for the text records (0Dh)."""
        if by(self.img, rec) != 0x0D:
            return ''.join(chr(by(self.img, rec + 4 + i) & 0x7F) for i in range(2)).replace('@', ' ').strip()
        cells = [cells_of(x) for x in texts]
        out = ''
        for i in range(2):
            ch, n = Counter(c[i][0] for c in cells).most_common(1)[0]
            if n * 2 <= len(cells):
                break
            out += ch
        return out.strip()

    # ---------------------------------------------------------------- MIDI pages
    def midi_page(self, b, k, v):
        b.poke(0xB2, k)
        b.poke(SETTINGS + k, v)
        b.poke(0x409B, 0xFF)
        b.poke(0xCF, 0)
        b.poke(0xD3, 0)
        del self.shots[:]
        b.call(MIDI_PAGE)
        return self.shots[-1], b.iram[0x86], b.peek(SETTINGS + k)

    def midi(self):
        b = self.fresh()
        chan = []
        for v in range(18):
            t, mx, back = self.midi_page(b, 0, v)
            assert back == v, (v, back)
            chan.append(t)
        t, mx, back = self.midi_page(b, 0, 18)
        over = {'max': mx, 'shows': t, 'becomes': back}  # 18-45: shown as the last text, set back to 17
        links = []
        for k in range(1, 45):
            name = self.img[LINK_NAMES - 0x8000 + 2 * (k - 1):LINK_NAMES - 0x8000 + 2 * k].decode('latin-1')
            tt = []
            for v in range(101):
                t, mx, back = self.midi_page(b, k, v)
                assert mx == 100 and back == v
                tt.append(t)
            links.append({'k': k, 'name': name, 'texts': tt})
        names = [self.img[LINK_NAMES - 0x8000 + 2 * i:LINK_NAMES - 0x8000 + 2 * i + 2].decode('latin-1') for i in range(50)]
        return {'channel': chan, 'channelOver': over, 'links': links, 'names': names}

    # ---------------------------------------------------------------- tables in ROM
    def factory(self):
        return [self.img[FACTORY - 0x8000 + PROG * i:FACTORY - 0x8000 + PROG * (i + 1)].hex().upper() for i in range(128)]

    def starts(self):
        return [self.img[STARTS - 0x8000 + PROG * i:STARTS - 0x8000 + PROG * (i + 1)].hex().upper() for i in range(CONFIGS)]

    def memory(self):
        b = self.base
        return b.mem(PROGRAMS, 128 * PROG) + b.mem(SETTINGS, SETTINGS_END - SETTINGS + 1)

    # ---------------------------------------------------------------- vectors
    def vectors(self, cfgs, pages):
        out = {}
        hdr = [0xF0, 0x00, 0x00, 0x10, 0x00, 0x03]
        pairs = lambda data: [x for v in data for x in ((v >> 7) & 1, v & 0x7F)]
        size = 128 * PROG + SETTINGS_END - SETTINGS + 1
        # 00 request: the unit sends 41h with programs 5000-55FF, then 4049-407B
        b = self.fresh()
        before = self.memory()
        b.receive(hdr + [0x00, 0xF7], settle=2)
        guard = 0
        while (b.iram[0x11] & 0x04) and guard < 4000:  # the SCI sends with its transmit interrupt (TIE)
            b.run_for(1000)
            guard += 1
        tx = b.tx
        assert tx[:7] == hdr + [0x41], tx[:8]
        data = bytes(((tx[7 + 2 * k] & 1) << 7) | tx[8 + 2 * k] for k in range(size))
        assert data == before and tx[-1] == 0xF7 and len(tx) == 8 + 2 * size, (len(tx), tx[-3:])
        out['request'] = {'msg': hdr + [0x00, 0xF7], 'length': len(tx), 'head': tx[:24], 'tail': tx[-7:]}
        # 41h: every byte stored; the program loaded is loaded again at F7
        b = self.fresh()
        mem = bytearray(before)
        mem[PROG * 5:PROG * 6] = bytes.fromhex('0705011E0A28045080B4B404')  # program 6 = configuration 7
        mem[PROG * 0:PROG * 1] = bytes.fromhex('020901060364020A02052808')  # program 1 (loaded) = configuration 2 start
        mem[128 * PROG + 0] = 4      # channel 5
        mem[128 * PROG + 23] = 64    # bypass (link 23) on CC 64
        msg = hdr + [0x41] + pairs(mem) + [0xF7]
        b.receive(msg, settle=8)
        got = b.mem(PROGRAMS, 128 * PROG) + b.mem(SETTINGS, SETTINGS_END - SETTINGS + 1)
        assert got == bytes(mem)
        out['dump'] = {'program6': list(mem[PROG * 5:PROG * 6]), 'channel': 4, 'stored': got == bytes(mem),
                       'loaded': b.iram[0xAD], 'config': b.iram[0x80], 'shown': b.shown()}
        # a 41h dump cut after program 2: programs 1-2 written, the rest (and the settings) kept; the receiver takes
        # each byte pair as it comes and F7 ends the message (only a half pair is an error, 0E)
        b2 = self.fresh()
        cut = bytearray(before[:PROG * 2])
        cut[0:PROG] = bytes.fromhex('0B0505' + '0E06045C0108140A14')
        cut[PROG:2 * PROG] = bytes.fromhex('0705011E0A28045080B4B404')
        b2.receive(hdr + [0x41] + pairs(cut) + [0xF7], settle=8)
        got2 = b2.mem(PROGRAMS, 128 * PROG) + b2.mem(SETTINGS, SETTINGS_END - SETTINGS + 1)
        assert got2[:2 * PROG] == bytes(cut) and got2[2 * PROG:] == before[2 * PROG:]
        out['cut'] = {'msg': hdr + [0x41] + pairs(cut) + [0xF7], 'programs': [list(cut[:PROG]), list(cut[PROG:])], 'restKept': True,
                      'loaded': b2.iram[0xAD], 'config': b2.iram[0x80], 'shown': b2.shown()}
        # program change 6 (on channel 5 now): program 6 loaded, its configuration
        b.receive([0xC4, 5], settle=8)
        out['programChange'] = {'msg': [0xC4, 5], 'loaded': b.iram[0xAD], 'config': b.iram[0x80], 'shown': b.shown()}
        # a wrong channel is ignored
        b.receive([0xC0, 9], settle=8)
        out['otherChannel'] = {'msg': [0xC0, 9], 'loaded': b.iram[0xAD]}
        # a controller moves the parameters linked to it: link of program 6's page 2 (byte 1) on CC 20
        b = self.fresh()
        cfg7 = [p for p in pages[7] if p['p'] == 1][0]
        b.poke(SETTINGS + cfg7['link'], 20)
        b.receive([0xC0, 5], settle=8)
        prog = bytes.fromhex('0705011E0A28045080B4B404')
        b.setmem(PROGRAMS + PROG * 5, prog)
        b.receive([0xC0, 5], settle=8)
        b.receive([0xB0, 20, 100], settle=8)
        v = b.peek(PROGRAMS + PROG * 5 + 1)
        out['control'] = {'link': cfg7['link'], 'cc': 20, 'value': 100, 'max': cfg7['max'], 'byte1': v,
                          'formula': ((100 * 2) * (cfg7['max'] + 1)) >> 8}
        assert v == out['control']['formula'], out['control']
        return out


def emit(path, fw, cfgs, pages, midi, factory, starts, memory):
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
            e = {'p': pg['p'], 'label': pg['label'], 'max': pg['max'], 't': tab(pg['texts']), 'link': pg['link'], 'type': pg['type'], 'rec': '%04X' % pg['rec']}
            if pg.get('by') is not None:
                e['by'] = pg['by']
                e['ts'] = [tab(t) for t in pg['tables']]
            ps.append(e)
        configs.append({'v': c['v'], 'name': c['name'], 'lamps': c['lamps'], 'params': ps})
    m = {'channel': midi['channel'], 'channelOver': midi['channelOver'], 'names': midi['names'],
         'links': [{'k': x['k'], 'name': x['name'], 't': tab(x['texts'])} for x in midi['links']]}
    lines = [
        '// Generated by tools/digitech/dsp128p_fw.py from the %s: do not edit.' % fw,
        '// CONFIGS: program byte 0 = v, name = its page 1 text; lamps = the two lamp bytes of its record (latches 2004h /',
        '// 2005h); params: program byte p, label = the characters its page shows before the value (the unit shows no other',
        '// name), the highest value, t = TABLES[t][value] the text the 4-character display shows for that value, link = its',
        '// MIDI link number (the MIDI page that sets its controller), type / rec = the record that shows it; by / ts: the',
        '// texts follow program byte `by` (TABLES[ts[that byte]][value]). A blank digit with only its point lit is " .";',
        '// ";" (segment g alone) is written "-".',
        'export const FIRMWARE = %s;' % json.dumps(fw),
        'export const CONFIGS = [',
    ]
    for c in configs:
        lines.append('  %s,' % json.dumps(c, separators=(',', ':')))
    lines.append('];')
    lines.append('export const TABLES = [')
    for t in tables:
        lines.append('  %s,' % json.dumps(t, separators=(',', ':')))
    lines.append('];')
    lines.append('// MIDI pages (F84C): page 0 the channel (4049h; texts for 0-17, values 18-45 show the last text and are set back')
    lines.append('// to 17), pages 1-44 the controller of each link number (4049h + k: TABLES[t] for 0-100), names = the 50 link')
    lines.append('// names at F93Bh (45-50 have no page).')
    lines.append('export const MIDI = %s;' % json.dumps(m, separators=(',', ':')))
    lines.append('// The 128 factory programs (D8F0h: the first power-up writes them into user programs 1-128).')
    lines.append('export const FACTORY = %s;' % json.dumps(factory))
    lines.append('// The program each configuration switch on the panel loads (DEF0h, E8AF).')
    lines.append('export const STARTS = %s;' % json.dumps(starts))
    lines.append('// The 41h dump after the first power-up: 5000h-55FFh (programs), 4049h-407Bh (MIDI channel, links 1-50).')
    lines.append('export const FIRST_POWER_UP = %s;' % json.dumps(memory.hex().upper()))
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
    ver = img[4:img.index(b'x', 4)].decode('latin-1').replace('_', ' ').strip()  # 8004h, ended by 'x'
    fw = 'DigiTech DSP-128 Plus v2.00 EPROM ("%s")' % ver
    r = Runner(img)
    cfgs = r.configs()
    pages = {}
    for c in cfgs:
        pages[c['v']] = r.pages(c)
        deps = [(p['p'], p['by']) for p in pages[c['v']] if p.get('by') is not None]
        print(' %2d %-5s %2d pages %s%s' % (c['v'], c['name'], len(pages[c['v']]), ' '.join(p['label'] for p in pages[c['v']]),
                                            (' texts follow ' + str(deps)) if deps else ''))
    midi = r.midi()
    print('channel', midi['channel'], midi['channelOver'])
    emit(out, fw, cfgs, pages, midi, r.factory(), r.starts(), r.memory())
    if vec:
        v = r.vectors(cfgs, pages)
        json.dump(v, open(vec, 'w', encoding='utf-8', newline='\n'), indent=1)
        print('vectors', list(v))


if __name__ == '__main__':
    main()
