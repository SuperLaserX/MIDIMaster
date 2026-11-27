# Alesis Quadraverb family (Quadraverb 1989, Quadraverb Plus = v2 software, Quadraverb GT 1991): build the
# editor tables from an EPROM dump.
#
#   python -I tools/alesis/quadraverb_fw.py "<EPROM dump .bin>" > js/devices/defs/alesis-quadraverb-fw.js
#   python -I tools/alesis/quadraverb_fw.py "<EPROM dump .bin>" --report     (page lists and descriptors)
#
# The dump is first put into CPU order (qv_unscramble.py: low address lines reversed). 8031 code. Every
# address the tool needs is found from a code pattern (detect()); in the Quadraverb v1.07 CPU image:
#   3174       page tree (MOV DPTR at 30A7): [configuration, 8392h] -> [function, 838Eh] -> [variant,
#              8383h + function] -> page list (count-1, then page stubs; bit 7 set: "NOT USED IN THIS
#              CONFIGURATION"). The variant of a function is a program byte the firmware copies to
#              8383h + f: reverb type (32h) for function 1, delay type (27h) for 2, pitch mode (1Ah) for 3,
#              direct signal select (45h) for 8 (writers 78A7, 6EDD, 74AD, 6BA6).
#   page stub  MOV 73h,#lo / MOV 72h,#hi / LJMP 359C (-> 5A96): descriptor at hi:lo, 16 bytes, then the
#              32-character screen (line 1 + line 2) and, for lists, 16 characters per value:
#              +0 program byte (function 5 reads 85xx, the MIDI settings; others the edit buffer 83xx),
#              +1 LCD position of the value (10h = line 2 column 0), +2 characters per step (16 = list),
#              +3 flags, +4 offset added for the display (signed 16), +6 minimum, +8 maximum (16 bits:
#              a value is two bytes, big-endian, when the maximum is above 255), +10 initial value,
#              +12 display routine, +14 the routine that sends the value to the DSP.
#   display    every value of every page is drawn by running the page in the 8051 emulator and reading
#              the screen buffer 83E0-83FF (LCD characters 7Eh/7Fh are the right/left arrows); the LCD
#              output routine (0F63) and its cursor routine (0F86) are skipped.
#   MOD TARGET value = group * 16 + item; the group's function (14C5) picks the variant, the lists at
#              1681 [configuration][group][variant] the names (16 characters, 184C).
#   D2FE       the 90 factory programs (128 bytes each; RECALL copies them with 5EE4).
#   SysEx      receiver A44B: F0 00 00 0E 02 <op>; op 01 <function> <page> <3 bytes> edits a page's
#              value (A611), 02 <n> <data> loads program n (0-99), the edit buffer (100) or all 100 (101,
#              A54C), 03 <n> requests the same (A540 -> A7C9), 04 writes DSP registers (A502).
# Quadraverb GT (v1.03, model byte 07): function 10 is the preamp; values in work bytes 83A8h-83C9h are
#   packed into program bits (PACK, found by running the pack routine 1476), EQ MODE (83AF) selects the EQ
#   pages, pages FDh-FFh are indexed by RESONATOR NUMB (INDEXED), EQ MODE / EQ PRESET rewrite the EQ
#   (EFFECTS, run in the emulator), and CAB SIMULATOR PROGRAM / GLOBAL is a setting at 8590 (GLOBAL).
#   See docs/devices/alesis-quadraverb-gt.md.
import sys, os, re, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i8051 import Cpu
from qv_unscramble import unscramble

SIZE = 128
WORK = 0xca  # the program, the multi-tap work area (8380h-83A7h, v2) and the GT's work bytes (to 83C9h)
FUNC_NAMES = ['Program', 'Reverb', 'Delay', 'Pitch', 'EQ', 'MIDI', 'Store', 'Configuration', 'Mix', 'Modulation', 'Name']


def lcd(b):
    return ''.join({0x7e: '→', 0x7f: '←'}.get(c, chr(c) if 32 <= c < 127 else '?') for c in b)


def w16(d, a): return (d[a] << 8) | d[a + 1]


def find(d, pat, what):
    m = re.search(pat, d, re.S)
    assert m, 'pattern for %s not found' % what
    return m


def detect(d):
    """Every table and variable the tool needs, from code patterns (works on v1.07, Plus v2.03, GT v1.03)."""
    M = {}
    # 308B: MOV DPTR,#func / ADD A,#varbase / ... / MOV DPTR,#cfg / ... / MOV DPTR,#root
    m = find(d, rb'\x90\x83(.)\xe0\x24(.)\xf5\x82\x75\x83\x83\xe0\xf8\x90\x83(.)\xe0\xf5\xf0\x90\x83\1\xe0\xc5\xf0\x90(..)', 'page tree')
    M['func_var'], M['var_base'], M['cfg_var'] = 0x8300 | m.group(1)[0], 0x8300 | m.group(2)[0], 0x8300 | m.group(3)[0]
    M['root'] = w16(m.group(4), 0)
    M['ncfg'] = (w16(d, M['root']) - M['root']) // 2
    M['nfunc'] = (w16(d, M['root'] + 2) - w16(d, M['root'])) // 2
    # the variant writers: MOV DPTR,#83xx / MOVX A,@DPTR / [ANL A,#1] / MOV DPTR,#varbase+f / MOVX @DPTR,A
    # (the GT's EQ pages follow EQ MODE, work byte AFh: 7983)
    sel = {}
    for m in re.finditer(rb'\x90\x83(.)\xe0(?:\x54\x01)?\x90\x83(.)\xf0', d, re.S):
        f = (0x8300 | m.group(2)[0]) - M['var_base']
        if 0 < f < M['nfunc'] and m.group(1)[0] < 0xb3: sel.setdefault(f, m.group(1)[0])
    M['selector'] = dict(sorted(sel.items()))
    # page stubs: MOV <lo reg>,#lo / MOV <hi reg>,#hi (the first page of configuration 0, function 1)
    t3 = w16(d, w16(d, w16(d, M['root']) + 2))
    s = w16(d, t3 + 1)
    for k in range(s, s + 24):
        if d[k] == 0x75 and d[k + 3] == 0x75 and d[k + 4] == d[k + 1] - 1:
            M['stub_regs'] = (d[k + 1], d[k + 4]); break
    assert 'stub_regs' in M, 'page stub registers'
    # MIDI settings page: CJNE A,#05 then DPH = 85h (5ABD; the GT tests two pages of function 10 first)
    m = find(d, rb'\xb4(.).\x85.\x82\x85.\x83\xe4\x93\x75\x83([^\x83])\xf5\x82\xe0\x22', 'MIDI page')
    M['midi_func'], M['midi_page'] = m.group(1)[0], m.group(2)[0] << 8
    # LCD output (0F63): MOV R0,#E0h ... MOV A,#80h / LCALL cursor / LCALL line / MOV A,#C0h
    m = find(d, rb'\x78\xe0\x75.\x83\x75\xa0\x83\x74\x80\x12(..)\x12(..)\x74\xc0\x12', 'LCD output')
    M['lcd_out'] = (m.start(), w16(m.group(1), 0))
    # factory programs: MUL AB by 80h, DPTR = base + 80h n, copied with MOVC (5EE4)
    for m in re.finditer(rb'\x75\xf0\x80\xa4\x24(.)\xf5\x82\xe5\xf0\x34(.)\xf5\x83', d, re.S):
        if b'\x93' in d[m.end():m.end() + 16]: M['presets'] = (m.group(2)[0] << 8) | m.group(1)[0]
    m = find(d, rb'RECALL ALL (\d+)', 'preset count')
    M['npresets'] = int(m.group(1))
    # MOD TARGET lists: MOV DPTR,#tree / three LCALLs of the table walker (14D8)
    m = find(d, rb'\x90(..)\x12(..)\xea\x12\2\xe8\x12\2\xe4\x93', 'target tree')
    M['target_tree'] = w16(m.group(1), 0)
    # group -> function (14C5): INC A / CJNE A,#n / ... MOV A,#m [/ JC / MOV A,#k]; the GT (1711):
    # CJNE A,#5 / MOV A,#8 / LJMP / JC / CJNE A,#8 / MOV A,#0Ah / LJMP / MOV A,#2
    m = find(d, rb'\xfa\x04\xb4(.)(.)\x74(.)(?:\x02..(?:\x40\x02\x74(.)|\x40.\xb4(.).\x74(.)\x02..\x74(.)))?', 'target groups')
    g = lambda i: m.group(i)[0] if m.group(i) else None
    M['target_fn'] = (g(1), g(3), g(4) if g(4) is not None else g(7), g(5), g(6))
    # multi-tap delay (v2): the eight taps (5 bytes each) are edited at 8380h + 5 * TAP NUMBER and kept in
    # 40 program bytes listed at `tap_map` (13A5 swaps them on recall and around a dump)
    m = re.search(rb'\x90(..)\x75.\x83\x85.\xa0\x78\x80\x7a\x28', d, re.S)
    M['tap_map'] = list(d[w16(m.group(1), 0):w16(m.group(1), 0) + 40]) if m else None
    # Quadraverb GT: the preamp and a few other values live in work bytes 83A8h-83C9h while a program is
    # edited; 1476 (MOV DPTR,#83A8 / MOV 7Ah,#83 / MOV P2,7Ah / MOV R0,#7C) packs them into program bits
    # before a store or dump, 13DB unpacks them on recall (pack_map() runs 1476 to find every field)
    m = re.search(rb'\x90\x83\xa8\x75(.)\x83\x85\1\xa0\x78.', d, re.S)
    M['pack_at'] = m.start() if m else None
    # value resolver (677A): descriptor bytes FDh-FFh are indexed, 83xx = table[83xx index] (682D...)
    M['indexed'] = {}
    for m in re.finditer(rb'\xb4([\xfd-\xff]).\x90(..)', d, re.S):
        M['indexed'][m.group(1)[0]] = w16(m.group(2), 0)
    if M['indexed']:
        m = find(d, rb'\x90\x83(.)\xe0\xd0\x83\xd0\x82\x93', 'index byte')
        M['index_byte'] = m.group(1)[0]
        tabs = sorted(M['indexed'].values())
        n = tabs[1] - tabs[0]
        M['indexed'] = {k: list(d[a:a + n]) for k, a in M['indexed'].items()}
    # GT: function 10 page p1 is the global CAB SIMULATOR PROGRAM (85xx); page p2 reads 85yy instead of the
    # program while it is GLOBAL (677A)
    m = re.search(rb'\xb4(.).\xc0\xe0\x90\x83(.)\xe0\xb4(.).\xd0\xe0\x02..\xb4(.).\x90\x85(.)\xe0\x60.\xd0\xe0\x90\x85(.)\xe0\x22', d, re.S)
    M['global_pages'] = {'func': m.group(1)[0], 'page_var': 0x8300 | m.group(2)[0], 'select': [m.group(3)[0], m.group(5)[0]],
                         'alt': [m.group(4)[0], m.group(6)[0]]} if m else None
    # GT: routines run when a page changes other values: EQ MODE (9E98: MOV DPTR,#83AF / MOVX / JNB ACC.0 /
    # MOV DPTR,#8344 / MOVX / CJNE A,#3) loads the new mode's defaults, EQ PRESET (CF94: MOV DPTR,#83B2 / MOVX /
    # JZ / DEC A / MOV R3,A / MOV R4,#0) copies a preset EQ from the tables at D064...
    M['effects'] = {}
    for off, pat in [(0xaf, rb'\x90\x83\xaf\xe0\x30\xe0.\x90\x83\x44\xe0\xb4\x03'), (0xb2, rb'\x90\x83\xb2\xe0\x60.\x14\xfb\x7c\x00')]:
        m = re.search(pat, d, re.S)
        if m: M['effects'][off] = m.start()
    v = find(d, rb'VERSIONNUMBER: ([0-9.]+)', 'version').group(1).decode()
    name = find(d, rb'(QUADRAVERB(?: Plus|  GT|)) ', 'model name').group(1).decode()
    M['model'] = ' '.join(w.capitalize() if w.isupper() and len(w) > 2 else w for w in name.split())
    M['version'] = v
    return M


class Image:
    def __init__(self, d, M):
        self.d, self.M = d, M
        self.root = M['root']

    def w(self, a): return w16(self.d, a)

    def s16(self, a):
        v = self.w(a)
        return v - 65536 if v & 0x8000 else v

    def stub(self, s):
        # MOV lo,#.. / MOV hi,#.., at the start or after a few instructions (4A08 tests a MIDI setting first)
        d, (lo, hi) = self.d, self.M['stub_regs']
        for k in range(s, s + 24):
            if d[k] == 0x75 and d[k + 1] == lo and d[k + 3] == 0x75 and d[k + 4] == hi:
                return (d[k + 5] << 8) | d[k + 2]
        raise AssertionError('page stub %04X' % s)

    def desc(self, a):
        d = self.d
        return {
            'desc': a, 'off': d[a], 'pos': d[a + 1], 'step': d[a + 2], 'flags': d[a + 3], 'add': self.s16(a + 4),
            'min': self.w(a + 6), 'max': self.w(a + 8), 'init': self.w(a + 10), 'disp': self.w(a + 12), 'dsp': self.w(a + 14),
            'screen': lcd(d[a + 16:a + 48]),
        }

    def lists(self):
        """[(cfg, func, variant, list address or None, [stub, ...])]"""
        out = []
        for c in range(self.M['ncfg']):
            t1 = self.w(self.root + 2 * c)
            for f in range(self.M['nfunc']):
                t2 = self.w(t1 + 2 * f)
                for v in range(self.nvar(f)):
                    t3 = self.w(t2 + 2 * v)
                    n = self.d[t3]
                    if n & 0x80:
                        out.append((c, f, v, None, [])); continue
                    out.append((c, f, v, t3, [self.w(t3 + 1 + 2 * p) for p in range(n + 1)]))
        return out

    def nvar(self, f):
        if f not in self.M['selector']: return 1
        # the largest maximum of the pages that edit the selector byte (reverb type, delay type...)
        best = 0
        for c in range(self.M['ncfg']):
            t3 = self.w(self.w(self.w(self.root + 2 * c) + 2 * f))
            if self.d[t3] & 0x80: continue
            for p in range(self.d[t3] + 1):
                ds = self.desc(self.stub(self.w(t3 + 1 + 2 * p)))
                if ds['off'] == self.M['selector'][f]: best = max(best, ds['max'])
        return best + 1

    def target_func(self, g):
        n, m, k, p, q = self.M['target_fn']
        f = g + 1
        if f == n: return m
        if f < n: return f
        if p is not None and f == p: return q
        return k if k is not None else f


def run_page(img, stub, func, prog, glob=None, variants=None, cfg=0, xram=None, page=None):
    M = img.M
    cpu = Cpu(img.d)
    cpu.ram[0x81] = 0x30
    cpu.x[0x8300:0x8300 + len(prog)] = bytes(prog)
    if glob: cpu.x[M['midi_page']:M['midi_page'] + len(glob)] = bytes(glob)
    for f, v in (variants or {}).items(): cpu.x[M['var_base'] + f] = v  # the page variant of function f
    cpu.x[M['cfg_var']] = cfg
    cpu.x[M['func_var']] = func
    # the GT's function 9 holds the name pages (0-13, 836A + page) and the MOD pages: its resolver reads the page
    if page is not None and M['global_pages']: cpu.x[M['global_pages']['page_var']] = page
    for a, v in (xram or {}).items(): cpu.x[a] = v
    for a in M['lcd_out']: cpu.hooks[a] = lambda c: True  # LCD port writes and their delay loops
    cpu.call(stub, limit=400000)
    return bytes(cpu.x[0x83E0:0x8400])


def pack_map(img):
    """GT: {work byte: [program byte, shift, bits]} found by running the pack routine (1476) with one bit
    set at a time and seeing which program bit it lands in."""
    if img.M['pack_at'] is None: return None
    hits = {}
    for w in range(0x80, 0xd0):
        for b in range(8):
            cpu = Cpu(img.d)
            cpu.ram[0x81] = 0x30
            cpu.x[0x8300 + w] = 1 << b
            cpu.call(img.M['pack_at'], limit=100000)
            for a in range(SIZE):
                if cpu.x[0x8300 + a]:
                    hits.setdefault(w, []).append((b, a, cpu.x[0x8300 + a].bit_length() - 1))
    out = {}
    for w, h in hits.items():
        b0, at, s = h[0]
        assert b0 == 0 and all(a == at and bit == s + b for b, a, bit in h), 'pack field %02X: %s' % (w, h)
        out[w] = [at, s, len(h)]
    return out


def page_effects(img, base, pack):
    """GT: {page byte: {configuration: [writes for value v | null]}}: what the routine behind a page writes
    into the program and work bytes (83xx below WORK) for each value, run in the emulator. A write is
    [byte, value]; an empty list changes nothing (EQ PRESET USER restores a copy the editor does not see)."""
    out = {}
    for off, at in img.M['effects'].items():
        rng = img.M['effect_range'][off]
        per = {}
        for c in range(img.M['ncfg']):
            vals = []
            for v in range(rng[0], rng[1] + 1):
                if off == 0xb2 and v == 0: vals.append([]); continue  # USER: restores the copy at 8298 (CF4E)
                finals = []
                for run in (0, 1):  # a byte is written when it ends the same from two different starts
                    p = bytearray(base) if run == 0 else bytearray(b ^ 0xff for b in base)
                    p[0x44] = c; p[off] = v
                    if off != 0xaf: p[0xaf] = run  # read-modify-write of bit 0
                    cpu = Cpu(img.d)
                    cpu.ram[0x81] = 0x30
                    cpu.x[0x8300:0x8300 + WORK] = bytes(p)
                    cpu.call(at, limit=100000)
                    finals.append(bytes(cpu.x[0x8300:0x8300 + WORK]))
                vals.append([[a, finals[0][a]] for a in range(WORK) if a not in (0x44, off) and finals[0][a] == finals[1][a]])
            per[c] = vals
        out[off] = per
    return out


def unpack_work(prog, pack):
    """The edit buffer and work bytes a program recall leaves (13DB): fields taken out of the program,
    host bytes keep only their own low bits."""
    p = bytearray(prog) + bytearray(WORK - SIZE)
    for w, (at, s, n) in (pack or {}).items(): p[w] = (prog[at] >> s) & ((1 << n) - 1)
    for w, (at, s, n) in (pack or {}).items():
        if s: p[at] &= (1 << s) - 1
    return p


def squash(s):
    return ' '.join(s.split()).rstrip(':').strip()


def page_texts(img, ds, base, xram=None):
    """(label, [value text]) for a page: the screen run in the emulator for every value.
    The value field starts at the descriptor's LCD position (or the first column a value changes,
    with a sign before it) and runs to the end of its line; the label is the screen before it. A mix
    page (arrows between two sources) keeps its whole second line as the value. A page whose value
    position is off the screen (the graphic EQ: bars of custom characters, no number) lists
    value + the descriptor's display offset. xram(v): external RAM to set instead of the page's byte
    (the GT's global CAB SIMULATOR)."""
    tmpl = ds['screen']
    if ds['pos'] >= 0x20:
        return squash(tmpl), ['%+d' % (v + ds['add']) if v + ds['add'] else '0' for v in range(ds['min'], ds['max'] + 1)]
    func = ds['func']
    screens = []
    for v in range(ds['min'], ds['max'] + 1):
        p = bytearray(base)
        g = bytearray(16)
        tgt = g if func == img.M['midi_func'] else p
        off = ds['off']
        if off in img.M['indexed']:  # RESONATOR x pages: shown for resonator 1
            p[img.M['index_byte']] = 0
            off = img.M['indexed'][off][0]
        if xram: pass
        elif ds['max'] > 255: tgt[off] = v >> 8; tgt[off + 1] = v & 255
        else: tgt[off] = v
        screens.append(lcd(run_page(img, ds['stub'], func, p, g, xram=xram(v) if xram else None, page=ds['page'])))
    # columns a value changes, on the value's own line (TAP x pages also print the tap number on line 1)
    diff = [i for i in range(32) if i // 16 == ds['pos'] // 16 and any(s[i] != tmpl[i] for s in screens)]
    start = min([ds['pos']] + diff[:1])
    line = start // 16
    if '←' in tmpl[16:] or '→' in tmpl[16:]:
        return squash(tmpl[:16]), [s[16:].strip() for s in screens]
    while start > line * 16 and tmpl[start - 1] in '+-' and start - 1 not in diff: start -= 1
    end = line * 16 + 16
    label = squash(tmpl[:16] + ' ' + tmpl[16:start]) if start > 16 else squash(tmpl[:start])
    return label, [s[start:end].strip() for s in screens]


def int_format(texts, lo):
    """A formula for a long numeric list: zero-padded decimal with a fixed suffix, checked for every value."""
    t0 = texts[0]
    digits = len(t0) - len(t0.lstrip('0123456789'))
    suffix = t0[digits:]
    for i, t in enumerate(texts):
        if t != str(lo + i).zfill(digits) + suffix: return None
    return {'pad': digits, 'suffix': suffix}


def main():
    sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
    raw = open(sys.argv[1], 'rb').read()
    d = unscramble(raw)
    assert b'QUADRAVERB' in d, 'not a Quadraverb family dump'
    M = detect(d)
    sys.stderr.write('%s v%s: %s\n' % (M['model'], M['version'], ', '.join(
        '%s=%s' % (k, ('%04X' % v) if isinstance(v, int) and v > 255 else v) for k, v in M.items() if k not in ('model', 'version'))))
    img = Image(d, M)
    ncfg, nfunc, midi = M['ncfg'], M['nfunc'], M['midi_func']
    lists = img.lists()
    presets = [d[M['presets'] + SIZE * i: M['presets'] + SIZE * (i + 1)] for i in range(M['npresets'])]
    descs = {}
    for c, f, v, la, stubs in lists:
        for i, s in enumerate(stubs):
            a = img.stub(s)
            if a not in descs:
                ds = img.desc(a); ds['stub'] = s; ds['func'] = f; ds['page'] = i
                descs[a] = ds
    if '--report' in sys.argv:
        for c, f, v, la, stubs in lists:
            print('cfg %d f%-2d v%d %s' % (c, f, v, 'NOT USED' if la is None else ' '.join('%02x' % img.desc(img.stub(s))['off'] for s in stubs)))
        for a, ds in sorted(descs.items(), key=lambda kv: (kv[1]['func'], kv[1]['off'])):
            print('%04X f%-2d off=%02X pos=%02X step=%02X fl=%02X add=%d min=%d max=%d init=%d disp=%04X dsp=%04X |%s|' % (
                a, ds['func'], ds['off'], ds['pos'], ds['step'], ds['flags'], ds['add'], ds['min'], ds['max'], ds['init'], ds['disp'], ds['dsp'], ds['screen']))
        return
    # value texts of every page (program pages and the MIDI page; not program select, store, name)
    pack = pack_map(img)
    gp = M['global_pages']
    base = unpack_work(presets[0], pack)
    formats, fmt_index, cache, out_descs, ids = [], {}, {}, [], {}

    def kept(ds):
        o = ds['off']
        if ds['func'] in (0, 6): return False  # program number, store
        if ds['min'] == 32 and 0x6a <= o < 0x78: return False  # EDIT NAME characters
        return (o < SIZE or ds['func'] == midi or (M['tap_map'] and 0x80 <= o < 0x85) or o in (pack or {}) or o in M['indexed']
                or (gp and ds['func'] == gp['func'] and o == gp['select'][1]))

    def add_format(texts, lo):
        f = int_format(texts, lo) if len(texts) > 1100 else None
        entry = {'min': lo, **({'int': f} if f else {'texts': texts})}
        k = json.dumps(entry, sort_keys=True)
        if k not in fmt_index: fmt_index[k] = len(formats); formats.append(entry)
        return fmt_index[k], f

    for a, ds in sorted(descs.items()):
        if not kept(ds): continue
        key = (ds['disp'], ds['min'], ds['max'], ds['add'], ds['step'], ds['pos'], ds['screen'], ds['func'] == midi)
        if key not in cache:
            sel = gp and ds['func'] == gp['func'] and ds['off'] == gp['select'][1]  # read from 85xx
            label, texts = page_texts(img, ds, base, xram=(lambda v: {M['midi_page'] + gp['select'][1]: v}) if sel else None)
            fi, f = add_format(texts, ds['min'])
            assert f or len(texts) <= 1100, 'long list %04X' % a
            cache[key] = (label, fi)
            sys.stderr.write('%04X %-28s %s .. %s\n' % (a, label, texts[0], texts[-1]))
        label, fi = cache[key]
        ids[a] = len(out_descs)
        out_descs.append({'off': ds['off'], 'size': 2 if ds['max'] > 255 else 1, 'min': ds['min'], 'max': ds['max'],
                          'init': ds['init'], 'func': ds['func'], 'label': label, 'fmt': fi, 'at': '%04X' % a})
    # page lists: PAGES[cfg][func] = [list per variant (desc ids) | null]
    pages = [[[] for _ in range(nfunc)] for _ in range(ncfg)]
    for c, f, v, la, stubs in lists:
        if la is None: pages[c][f].append(None); continue
        pages[c][f].append([ids.get(img.stub(s), -1) for s in stubs])
    cfg_desc = next(ds for ds in out_descs if ds['off'] == 0x44 and ds['size'] == 1)
    configs = formats[cfg_desc['fmt']]['texts']  # the CONFIGURATION page's list
    for p in presets:
        assert p[0x44] < ncfg and all(32 <= c < 128 for c in p[0x6A:0x78]), 'bad preset'
    # MOD TARGET: the names depend on the configuration and the target group's variant
    tgt = next(ds for ds in descs.values() if ds['off'] == 0x51 and ds['func'] != midi)
    tdesc = next(ds for ds in out_descs if ds['at'] == '%04X' % tgt['desc'])
    ngroups = (tgt['max'] >> 4) + 1
    target_funcs = [img.target_func(g) for g in range(ngroups)]
    targets = []
    for c in range(ncfg):
        groups = []
        for gi, f in enumerate(target_funcs):
            per = []
            for var in range(img.nvar(f)):
                p = bytearray(base); p[0x44] = c
                if f in M['selector']: p[M['selector'][f]] = var
                t3 = img.w(img.w(img.w(M['target_tree'] + 2 * c) + 2 * gi) + 2 * var)
                if d[t3] & 0x80: per.append([]); continue  # group not in this configuration
                texts = []
                for v in range(16 * gi, 16 * gi + d[t3] + 1):  # the list's last index
                    p[0x51] = v
                    s = lcd(run_page(img, tgt['stub'], tgt['func'], p, variants={f: var}, cfg=c, page=tgt['page']))
                    texts.append(s[16:].strip())
                per.append(texts)
            groups.append(per)
        targets.append(groups)
    formats[tdesc['fmt']] = {'min': 0, 'targets': True, 'texts': formats[tdesc['fmt']]['texts']}
    extra = []
    if M['effects']:
        M['effect_range'] = {off: next((ds['min'], ds['max']) for ds in descs.values() if ds['off'] == off) for off in M['effects']}
        eff = page_effects(img, base, pack)
        extra += ['// EFFECTS[page byte][configuration][value - min]: the [byte, value] writes the unit makes when that page',
                  '//   is set (EQ MODE loads its defaults (9E98), EQ PRESET copies a preset EQ (CF94); USER restores a copy',
                  '//   of the EQ made at recall, not listed)',
                  'export const EFFECTS = ' + json.dumps({str(k): {str(c): v for c, v in per.items()} for k, per in eff.items()}, separators=(',', ':')) + ';']
    if pack:
        extra += ['// PACK[work byte]: [program byte, shift, bits]: the GT edits these values in work bytes 83xx and',
                  '//   keeps them in program bits (packed by 1476 for a store or dump, unpacked by 13DB on recall)',
                  'export const PACK = ' + json.dumps({str(k): v for k, v in sorted(pack.items())}) + ';']
    if M['indexed']:
        extra += ['// INDEXED[descriptor byte]: the bytes pages FDh-FFh edit, by the value of program byte INDEX_BYTE',
                  'export const INDEXED = ' + json.dumps({str(k): v for k, v in sorted(M['indexed'].items())}) + ';',
                  'export const INDEX_BYTE = %d;' % M['index_byte']]
    if gp:
        # the page that reads the global value while the select page is GLOBAL, with the texts shown then
        t3 = img.w(img.w(img.w(M['root']) + 2 * gp['func']))  # configuration 0, variant 0
        alt = descs[img.stub(img.w(t3 + 1 + 2 * gp['alt'][0]))]
        sel_at, alt_at = M['midi_page'] + gp['select'][1], M['midi_page'] + gp['alt'][1]
        label, texts = page_texts(img, alt, base, xram=lambda v: {sel_at: 1, gp['page_var']: gp['alt'][0], alt_at: v})
        fi, _ = add_format(texts, alt['min'])
        sys.stderr.write('global %-28s %s .. %s\n' % (label, texts[0], texts[-1]))
        extra += ['// GLOBAL: function `func` page select[0] sets settings byte select[1] (PROGRAM / GLOBAL); while it is',
                  '//   GLOBAL, page alt[0] reads and writes settings byte alt[1] instead of program byte alt[2] (FORMATS[alt[3]])',
                  'export const GLOBAL = ' + json.dumps({'func': gp['func'], 'select': gp['select'], 'alt': [gp['alt'][0], gp['alt'][1], alt['off'], fi]}) + ';']
    title = '%s v%s' % (M['model'], M['version'])
    js = ['// Generated by tools/alesis/quadraverb_fw.py from the Alesis %s EPROM (CPU order: low' % title,
          '// address lines reversed). Do not edit by hand: run the tool again.',
          '// DESCS[i]: one page (descriptor at `at`): program byte `off` (MIDI settings for function MIDI_FUNC),',
          '//   size 1 or 2 (big-endian), range, initial value, the LCD label and FORMATS[fmt] (texts[v - min] as',
          '//   the LCD shows value v, or int: zero-padded decimal + suffix). PAGES[configuration][function][variant]:',
          '//   the pages in front-panel order (null: not used in that configuration); the variant of a function',
          '//   is the program byte SELECTOR[function]. TARGETS[configuration][group][variant]: the MOD TARGET',
          '//   names of values group*16 + 0.. (group g is function TARGET_FUNCS[g]; [] = not in that',
          '//   configuration). PRESETS: the factory programs.',
          'export const FIRMWARE = ' + json.dumps(title) + ';',
          'export const MIDI_FUNC = %d;' % midi,
          'export const SELECTOR = ' + json.dumps({str(k): v for k, v in M['selector'].items()}) + ';',
          'export const TARGET_FUNCS = ' + json.dumps(target_funcs) + ';',
          '// TAP_MAP[5 n + k]: the program byte holding field k of multi-tap delay tap n (pages 80h + k)',
          'export const TAP_MAP = ' + json.dumps(M['tap_map']) + ';'] + extra
    for k, v in [('CONFIGS', configs), ('DESCS', out_descs), ('FORMATS', formats), ('PAGES', pages), ('TARGETS', targets),
                 ('PRESETS', [p.hex() for p in presets])]:
        js.append('export const %s = %s;' % (k, json.dumps(v, separators=(',', ':'), ensure_ascii=False)))
    sys.stdout.write('\n'.join(js) + '\n')


if __name__ == '__main__':
    main()
