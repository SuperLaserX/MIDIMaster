# The host OS of the Virus A / B / C family (an 8051 with a 2 x 16 LCD) run in the 8051 emulator of
# tools/alesis/i8051.py (imported, not changed) to read what its screen shows: the edit-menu records (title, label,
# parameter, range, display type) and the panel knobs, with the screen text of every value. Firmware is untrusted
# data: it is only read and its code only runs inside the emulator.
#
# Memory: code 0000-7FFF fixed, 8000-FFFF a 32 KB bank of the flash chosen by SFR F8 bits 4-7 (routine 2AC6 in
# B 4.9). The LCD routines (command 0CD9, character 0D1E in B 4.9) are hooked; every cursor command starts a "run"
# of characters, so the text a display routine prints can be told from the label and the markers.
# The parameter reader (65ED in B 4.9: part 53h, page 54h, index 55h -> 56h) runs as it is, with its per-parameter
# handlers and their remapping (the alphabetical destination lists); only the leaf routines that fetch a stored
# byte are hooked, so every stored value is shown as the OS shows it.
import importlib.util, os, re

_p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'alesis', 'i8051.py')
_s = importlib.util.spec_from_file_location('i8051', _p)
i8051 = importlib.util.module_from_spec(_s); _s.loader.exec_module(i8051)

# Per OS build: the addresses used (found with re/virus/old/sigs.py and maproutines.py; docs/devices/access-virus-abc.md).
B49 = dict(
    name='Virus B OS 4.9 (T, build 049, 09.01.04)', models=['Single mode', 'Multi Single mode', 'Multi mode'], mode_var=0x7f02,
    tables=[0x8000, 0x96f9, 0xae82], bank=2, rec=24, titles=0xdb66, labels=0xe086, lcd_cmd=0x0cd9, lcd_chr=0x0d1e,
    read=0x65ed, main=0x1940, loader=0x40d2, display=0x1164, label_print=0x1029, model_param=(2, 0x7a),
    leaves={0x6752: 0, 0x675e: 1, 0x667a: 2, 0x67a2: 2, 0x67db: 2, 0x680e: 2, 0x660a: None, 0x66b4: 0},
    stores={0: (0x0000,), 1: (0x0080,), 2: (0x2400, 0x1200)},  # single-mode edit buffer, global store, multi
    # stored ranges wider than a menu offers: Knob Display (the menu steps 0-3, the store keeps 0-127: 6653 shows <15,
    # <50, <99, more); LFO 1 / 2 Shape (the menus offer S&H ... Wave 64, the panel's shape button Sine ... Square)
    ranges={(2, 97): (0, 127), (0, 68): (0, 67), (0, 80): (0, 67)},
    handlers=0x7724, dispatch=0x267a, knob_index=0x5b9c, knobs=32, names=0x8bc8, raw=0x65d7, state=0x2f0e,
    kdisplay=0x130b, orig=0x2db8, knob_text=0xcadb, cc_names=0xaf22,
    classes={0x6752: 'single', 0x675e: 'single', 0x66b4: 'controller', 0x660a: 'dsp', 0x667a: 'global', 0x67a2: 'multi',
             0x6684: 'single', 0x676d: 'single', 0x6780: 'panel', 0x6697: 'global',
             0x6653: 'global',  # Knob Display: global 2461h in four bands (<15, <50, <99, more)
             # part rows (67AD-67D9: the multi's 1220h + 10h x row + part; C 31 and 32 both read row 20h) and part
             # switches (67F0-6809: bits 0-3, 5, 6 of 12F0h + part; C 76, bit 4 on the TI, is a global setting here)
             **{0x67ad + 4 * k: 'part' for k in range(12)}, **{0x67f0 + 5 * k: 'part' for k in range(5)}, 0x6809: 'part'},
)
# The Classic's build is the B's with the code from 2A3C on moved (its reader 65A9 = B 65ED - 44h, the handlers too).
CLASSIC = dict(B49, name='Virus Classic OS 4.9 (build 061, 26.03.04)',
               read=0x65a9, loader=0x40bc, leaves={0x670e: 0, 0x671a: 1, 0x6636: 2, 0x675e: 2, 0x6797: 2, 0x67ca: 2, 0x65c6: None, 0x6670: 0},
               dispatch=0x2664, knob_index=0x5b58, raw=0x6593, state=0x2ef8, orig=0x2da2, handlers=0x76e0,
               classes={a - 0x44: c for a, c in B49['classes'].items()})

# The Virus C OS 6.6 (the C, KC and Indigo 2; the flash dump am29f040b_6v6): a reorganised build. The menus are 18 edit
# modes (pointer table bank 2 B598: a count byte, 24-byte records ending FEh, FDh after the last; the OS's own table
# test 679D checks them), loaded by 5300 (R7 edit mode, R6 record) and shown by 0B10 from the main loop 3259. The play
# mode is XRAM 4302 (page C 122), the part IRAM 4Eh (40h single mode). The reader 1425 (part 51h, page 52h, index 53h
# -> 54h) takes a handler number per index from bank 1 F71A (per page: count, numbers) and jumps through 1482.
# Knobs: dispatch 3A20 (knob number from 71BB, 32 knobs), each handler sets R6 name (12-byte texts D5B3), R5 display
# type, R3 page, R2 index and jumps to 3F11, which stores them for the knob display 0D15.
C66 = dict(
    name='Virus C OS 6.6 (flash dump am29f040b_6v6)', style='c', bank=2, rec=24, marker=0xfe,
    table_ptrs=(0xb598, 18), playmode_var=0x4302, part_var=0x4e,
    models=[(0, 0, 'LFO 1 amounts'), (1, 0, 'LFO 2 amounts'), (2, 0, 'LFO 3 amounts'), (3, 0, 'Mod matrix'), (4, 0, 'LFO edit'),
            (5, 0, 'Arpeggiator'), (6, 0, 'Effects'), (7, 0, 'Effects (phaser)'), (8, 0, 'Effects (chorus)'), (9, 0, 'Delay / reverb'),
            (10, 0, 'Oscillators'), (11, 0, 'Filters'), (12, 0, 'Common'), (13, 0, 'Multi / global (single mode)'),
            (13, 2, 'Multi / global (multi mode)'), (9, 2, 'Delay / reverb (multi mode)'), (14, 0, 'Program select'), (16, 0, 'Other')],
    titles=0xc373, labels=0xc9a3, title_count=0x63, label_count=0xc1, lcd_cmd=0x0089, lcd_chr=0x00d1, regs=(0x51, 0x52, 0x53, 0x54),
    read=0x1425, main=0x3259, loader=0x5300, display=0x0b10, label_print=0x0551, model_param=None,
    leaves={0x1614: 0, 0x1620: 1, 0x153f: 2, 0x1661: 2, 0x169c: 2, 0x16cf: 2, 0x14e8: None, 0x1569: 0},
    stores={0: (0x0000, 0x0300), 1: (0x0080, 0x0380), 2: (0x2400, 0x2300)},  # single mode / part 1 edit buffers, global, multi
    ranges={(2, 97): (0, 127)},
    handler_bytes=(0xf71a, 0x1482), dispatch=0x3a20, knob_index=0x71bb, knobs=32, names=0xd5b3, raw=0x1401,
    carry=(0x1f26, 0x50e1, 0x50f1), knob_bit=0x3d, knob_store=0x3f11, kdisplay=0x0d15, orig=0x1f71, knob_text=None,
    cc_names=0xa939,
    # LFO 3 Dest (page B 11) is the record edit mode 2 shows (4CB1: value -> record id at 4CD7, 0E68 writes it back)
    synth={(1, 11): dict(table=2, ids=0x4cd7, n=7, title='LFO 3', label='Dest')},
    label_fix={(1, 12): 'Amount'},
    trim_knobs=True,  # knob-only ranges end where the knob display's texts stop changing  # LFO 3's amount: edit mode 2 labels each record with its destination
    # knob-only page B parameters (no menu in the C): the knob edits them when its section selects Osc 3 / Distortion
    knob_groups={(1, 41): 'Oscillator 3', (1, 43): 'Oscillator 3', (1, 44): 'Oscillator 3', (1, 100): 'Distortion', (1, 101): 'Distortion',
                 (1, 7): 'LFO 3', (1, 89): 'Phaser', (0, 107): 'Chorus', (0, 113): 'Delay'},
    classes={0x14e0: 'none', 0x14e8: 'none', 0x1519: 'global', 0x1638: 'single', 0x162f: 'single', 0x15f0: 'panel', 0x153f: 'global',
             0x1549: 'global', 0x1564: 'global', 0x1569: 'controller', 0x1661: 'multi', 0x155b: 'single', 0x1620: 'single', 0x1614: 'single',
             0x1552: 'single',
             # part rows 166C-1698 (2300h + row + part) and part switches 16B1-16CA (bits 0-3, 5, 6 of 23F0h + part)
             **{a: 'part' for a in (0x166c, 0x1670, 0x1674, 0x1678, 0x167c, 0x1680, 0x1684, 0x1688, 0x168c, 0x1690, 0x1694, 0x1698,
                                    0x16b1, 0x16b6, 0x16bb, 0x16c0, 0x16c5, 0x16ca)}},
)

# The Virus Rack XL OS 6.5 build 079 (the update's first MIDI file): the C's build for the rack, with 23-byte records
# (the C's with one byte fewer between the parameter and the flags: 7 is the record's knob page) ending AAh / ABh
# (bit 0 a flag); 11 edit-mode tables (pointers in the fixed code at 0138, no count), loader 3E24 (R7 mode, R6 record),
# item display 6FB7, main loop 1E94, reader 0788 (part 54h, page 55h, index 56h -> 57h; a 2-byte handler per index at
# 1408 + 100h x page, as on the B). Knobs: the value knob and four parameter knobs whose parameters the shown record's
# knob page picks (bank 2 9FE1: 24 pages of 4 x 16 bytes: kind, page, index, range, title, short name, display type;
# dispatch 2AB0 by kind, store 2CC5, knob display 71C0).
RXL = dict(
    name='Virus Rack XL OS 6.5 (build 079)', style='c', bank=2, rec=23, marker=0xaa, marker_mask=0xfe,
    fields=dict(kind=3, page=5, index=6, page2=None, index2=None, min=0x0a, max=0x0b, d=0x0e, sub=0x0f, layout=0x10, dtype=0x11,
                title=0x12, label=0x13, marker=0x16),
    table_ptrs=(0x0138, 11), ptr_bank=0, count_byte=False, playmode_var=0x4202, part_var=0x51,
    models=[(0, 0, 'Program select'), (1, 0, 'Program select (2)'), (2, 0, 'Oscillators'), (3, 0, 'Filters'), (4, 0, 'Envelopes'),
            (5, 0, 'LFOs'), (6, 0, 'Effects'), (7, 0, 'Common'), (8, 0, 'Arpeggiator / setup'), (9, 0, 'Multi parts (single mode)'),
            (9, 2, 'Multi parts (multi mode)'), (6, 2, 'Effects (multi mode)'), (8, 2, 'Arpeggiator / setup (multi mode)')],
    titles=0xd6d6, labels=0xdd06, title_count=0x63, label_count=0xc3, lcd_cmd=0x697c, lcd_chr=0x69d7, regs=(0x54, 0x55, 0x56, 0x57),
    read=0x0788, main=0x1e94, loader=0x3e24, display=0x6fb7, label_print=0x6e7b, model_param=None,
    leaves={0x08a4: 0, 0x08ba: 1, 0x0805: 2, 0x0928: 2, 0x0963: 2, 0x0996: 2, 0x07a4: None, 0x081d: 0},
    stores={0: (0x0000, 0x0300), 1: (0x0080, 0x0380), 2: (0x2400, 0x2300)},
    ranges={(2, 97): (0, 127)}, trim_knobs=True, value_text='last',
    handlers=0x1408, knobs=5, names=0xe936, raw=0x0769, orig=0x01bd, knob_text=None, cc_names=0xbfbb,
    # the value knob and the four parameter knobs (no knob texts in the OS); a parameter only the vocoder menu shows
    # (A 41 / 42 / 55 / 57 ...) is named by the knob that edits it outside the vocoder
    knob_names=['Value', 'Parameter knob 1', 'Parameter knob 2', 'Parameter knob 3', 'Parameter knob 4'], knob_over_titles=['VOCODER'],
    knob_style='rxl', knob_entry=0x2ab0, knob_value=0x4eeb, rec_byte=0x0150, knob_store=0x2cc5, kdisplay=0x71c0, knob_pages=24,
    classes={0x07a4: 'none', 0x0805: 'global', 0x080f: 'single', 0x0818: 'global', 0x081d: 'controller', 0x08a4: 'single',
             0x08b0: 'single', 0x08ba: 'single', 0x08c9: 'single', 0x08d2: 'single', 0x08db: 'global', 0x08e4: 'panel',
             0x0928: 'multi', 0x07df: 'global',
             # B 126 / 127: the selected filter's resonance / env amount (page A 42 / 43, 44 / 45 by the filter select)
             0x0908: 'alias', 0x091a: 'alias',
             **{0x0933 + 4 * k: 'part' for k in range(12)}, **{0x0978 + 5 * k: 'part' for k in range(5)}, 0x0991: 'part'},
)

# The Virus A OS 2.8 (the update Virus_A_Series_OS280: re/virus/upd/bin/a280.bin): the B's ancestor. Three play-mode
# tables of 25-byte records (bank 2 8000 / 98E8 / B1D0 by XRAM 7F02, record 7F04, marker AAh at 18h; the B's fields 3
# earlier, the second parameter at 12h / 13h), loader 726E (R6 record), item display 333C, main loop 5A74, reader 3963
# (part 52h, page 53h, index 54h -> 55h; a 2-byte handler per index at 3BAF + 100h x page). Knobs: dispatch 5B3B (knob
# number from 19A6, handlers 5B89-5E8C), each sets R6 name (a label: 16-byte texts ABC0), R5 display type, R3 page, R2
# index and jumps to 5E93, which stores them (7F2E / 7F30 / 7F33 / 7F34) for the knob display 34A2.
A28 = dict(
    name='Virus A OS 2.8 (Virus_A_Series_OS280)', models=['Single mode', 'Multi Single mode', 'Multi mode'], mode_var=0x7f02,
    tables=[0x8000, 0x98e8, 0xb1d0], bank=2, rec=25, marker=0xaa,
    fields=dict(kind=0, page=4, index=5, page2=0x12, index2=0x13, min=8, max=9, d=0x0c, sub=0x0d, layout=0x0e, dtype=0x0f,
                title=0x10, label=0x11, marker=0x18),
    titles=0xa3c0, labels=0xabc0, title_count=0x80, label_count=0x100, lcd_cmd=0x2eb4, lcd_chr=0x2ef9, regs=(0x52, 0x53, 0x54, 0x55),
    read=0x3963, main=0x5a74, loader=0x726e, display=0x333c, label_print=0x323f, model_param=None, part_var=0x4f,
    leaves={0x3a82: 0, 0x3a8e: 1, 0x39df: 2, 0x3abf: 2, 0x3af6: 2, 0x3b24: 2, 0x3980: None, 0x3a01: 0},
    stores={0: (0x0000,), 1: (0x0080,), 2: (0x2400, 0x1200)},
    ranges={(2, 97): (0, 127)}, trim_knobs=True, value_vars=(0x7f2b,),
    handlers=0x3baf, knobs=32, names=0xabc0, name_len=16, raw=0x394d, orig=None, knob_text=0xecc7, cc_names=None,
    knob_style='a', dispatch=0x5b3b, knob_index=0x19a6, carry=(), knob_bit=None, knob_store=0x5e93, kdisplay=0x34a2,
    classes={0x3980: 'none', 0x39df: 'global', 0x39bc: 'global', 0x3a01: 'controller', 0x3a82: 'single', 0x3a8e: 'single',
             0x3a9d: 'panel', 0x3abf: 'multi',
             **{0x3aca + 4 * k: 'part' for k in range(11)}, **{a: 'part' for a in (0x3b0b, 0x3b10, 0x3b15, 0x3b1a, 0x3b1f)}},
)
OSES = {'b49': B49, 'classic': CLASSIC, 'c66': C66, 'rxl': RXL, 'a28': A28}


def tables_of(img, A):
    """[(model name, table (C: number, else address), play mode, file offset of the first record, record count or None)]."""
    bank = A['bank'] * 0x8000 - 0x8000
    if A.get('style') == 'c':
        at, n = A['table_ptrs']
        pb = A.get('ptr_bank', A['bank']) * 0x8000 - 0x8000 if at >= 0x8000 else 0
        ptr = [(img[pb + at + 2 * i] << 8) | img[pb + at + 2 * i + 1] for i in range(n)]
        if not A.get('count_byte', True): return [(name, t, mode, bank + ptr[t], None) for t, mode, name in A['models']]
        return [(name, t, mode, bank + ptr[t] + 1, img[bank + ptr[t]]) for t, mode, name in A['models']]
    return [(A['models'][m] if m < len(A['models']) else f'table {m}', tab, m, bank + tab, None) for m, tab in enumerate(A['tables'])]


class Code:
    def __init__(self, img, cpu): self.img, self.cpu = img, cpu
    def __getitem__(self, a):
        a &= 0xffff
        if a < 0x8000: return self.img[a]
        o = (self.cpu.ram[0xf8] >> 4) * 0x8000 + (a - 0x8000)
        return self.img[o] if o < len(self.img) else 0xff
    def __len__(self): return 0x10000


class Host:
    def __init__(self, img, lcd_cmd, lcd_chr, bank=1):
        self.cpu = i8051.Cpu(bytes(0x10000))
        self.cpu.c = Code(img, self.cpu)
        self.cpu.ram[0xf8] = bank << 4
        self.cursor = 0
        self.lines = [[' '] * 40, [' '] * 40]
        self.runs = []
        self.cpu.hooks[lcd_cmd] = self._cmd
        self.cpu.hooks[lcd_chr] = self._chr

    def _cmd(self, c):
        a = c.a
        if a & 0x80: self.cursor = a & 0x7f; self.runs.append([self.cursor, ''])
        elif a == 1: self.clear()
        return True

    def _chr(self, c):
        line = 1 if self.cursor >= 0x40 else 0
        col = self.cursor - 0x40 * line
        ch = chr(c.a) if 32 <= c.a < 127 else f'<{c.a:02x}>'
        if col < 40: self.lines[line][col] = ch
        if not self.runs: self.runs.append([self.cursor, ''])
        self.runs[-1][1] += ch
        self.cursor += 1
        return True

    def clear(self): self.lines = [[' '] * 40, [' '] * 40]
    def text(self, line): return ''.join(self.lines[line][:16])
    def snapshot(self): c = self.cpu; return (bytes(c.ram), bytes(c.hi), bytes(c.x), c.pc)
    def restore(self, s):
        c = self.cpu
        c.ram[:], c.hi[:], c.x[:] = s[0], s[1], s[2]
        c.pc = s[3]
        self.runs = []
    def call(self, addr, limit=400000):
        self.cpu.ram[0x81] = 0x7f
        self.cpu.call(addr, limit=limit)


CUSTOM = re.compile(r'<[0-9a-f]{2}>')
MARKERS = (0x4b, 0x4f)  # one-character markers the B 4.9 display routines print at line 2 columns 11 and 15


def line2_text(h):
    """What a menu display printed on line 2 after the label (spacing collapsed: "Wave" + "64" -> "Wave 64")."""
    cols = set()
    for start, s in h.runs:
        if start < 0x40: continue
        n = len(re.findall(r'<[0-9a-f]{2}>|.', s))
        if n <= 1 and start in MARKERS: continue
        cols.update(range(start - 0x40, start - 0x40 + n))
    cols = [c for c in cols if c < 16]
    if not cols: return ''
    return re.sub(r' +', ' ', CUSTOM.sub('', ''.join(h.lines[1][min(cols):max(cols) + 1]))).strip()


def last_text(runs):
    """The last text printed (the new value of a knob display, after the stored value)."""
    for start, s in reversed(runs):
        plain = CUSTOM.sub('', s)
        if len(plain) <= 1 and start in MARKERS: continue
        if plain.strip(): return plain.strip()
    return ''


class Done(Exception): pass


class Menu:
    """One model's menu records: load(i, target) runs the loader once, show(v) the display for a stored value."""
    def __init__(self, img, A, model):
        self.img, self.A, self.model = img, A, model
        self.h = Host(img, A['lcd_cmd'], A['lcd_chr'])
        self.value, self.target, self.reads = 0, None, []
        for a, page in A['leaves'].items(): self.h.cpu.hooks[a] = self._leaf(page)
        self.h.cpu.hooks[A['label_print']] = self._label

    def _leaf(self, fixed):
        _part, rpage, ridx, rval = self.A.get('regs', (0x53, 0x54, 0x55, 0x56))
        def hook(cpu):
            page = cpu.ram[rpage] if fixed is None else fixed
            idx = cpu.ram[ridx] & 0x7f if fixed == 1 else cpu.ram[ridx]
            if (page, idx) == self.A['model_param']: v = self.model
            else:
                self.reads.append((page, idx))
                v = self.value if (page, idx) == self.target else 0
            cpu.ram[rval] = v; cpu.a = v
            return True
        return hook

    def _label(self, cpu):  # the label printer: 16 characters from the label table, '$' leaves a character as it is
        base = self.A['labels'] + 16 * cpu.a
        for k in range(16):
            ch = self.img[base + k]
            if ch != 0x24: self.h.lines[1][k] = chr(ch)
        self.h.cursor = 0x50
        return True

    def load(self, i, target, table=0):
        h, c = self.h, self.h.cpu
        self.target = target
        def stop(cpu): raise Done()
        c.hooks[self.A['main']] = stop
        if self.A.get('style') == 'c':  # loader 5300: R7 edit mode, R6 record; play mode 4302, part 4Eh (40h single mode)
            c.x[self.A['playmode_var']] = self.model
            c.ram[self.A['part_var']] = 0x40 if self.model == 0 else 0
            c.setr(7, table)
        else:
            c.x[0x7f04] = i
            c.x[self.A['mode_var']] = self.model  # the play mode (page C 122, read from 7F02) picks the menu table
        c.setr(6, i)
        try: h.call(self.A['loader'])
        except Done: pass
        except Exception as e: return f'loader: {e}'
        finally: del c.hooks[self.A['main']]
        self.snap = h.snapshot()
        return ''

    def show(self, v):
        h = self.h
        h.restore(self.snap)
        h.clear()
        self.value, self.reads = v, []
        page, idx = self.target
        # handlers that read a stored byte themselves (B 4.9: Knob Display 6653 reads 2461h): put the value there too
        for base in self.A.get('stores', {}).get(page, ()): h.cpu.x[base + idx] = v
        # displays that print the value the loader read (the A's 333C prints 7F2B): put the value there too
        for at in self.A.get('value_vars', ()): h.cpu.x[at] = v
        try: h.call(self.A['display'])
        except Exception as e: return None, f'display: {e}'
        # the Rack XL prints the stored value and then the edited one: its text is the last printed
        return (h.text(0), h.text(1), last_text(h.runs) if self.A.get('value_text') == 'last' else line2_text(h)), ''


class Knob(Menu):
    def __init__(self, img, A):
        super().__init__(img, A, 0)
        del self.h.cpu.hooks[A['label_print']]
        if A.get('orig'): self.h.cpu.hooks[A['orig']] = self._orig

    def _orig(self, cpu): cpu.a = self.value; return True

    def show_knob(self, dtype, name, page, index, v, title=0):
        h, c = self.h, self.h.cpu
        h.clear(); h.runs = []
        self.value, self.target = v, (page, index)
        if self.A.get('knob_style') == 'a':  # 34A2: type 7F2E, name 7F30 (a label), page 7F33, index 7F34; ends in the main loop
            c.ram[self.A['part_var']] = 0x40
            c.x[0x7f2e], c.x[0x7f30], c.x[0x7f33], c.x[0x7f34], c.x[0x7f35], c.x[0x2461] = dtype, name, page, index, 0, 0x7f
            def stop(cpu): raise Done()
            c.hooks[self.A['main']] = stop
            try: h.call(self.A['kdisplay'], limit=100000)
            except Done: pass
            except Exception as e: return '!' + str(e)
            finally: del c.hooks[self.A['main']]
            return last_text(h.runs)
        if self.A.get('knob_style') == 'rxl':  # 71C0: type 425C, title 425E, name 425F, page 4262, index 4263
            c.ram[self.A['part_var']] = 0x40
            c.ram[0x23] &= ~0x04
            c.x[0x425c], c.x[0x425e], c.x[0x425f], c.x[0x4262], c.x[0x4263], c.x[0x2461] = dtype, title, name, page, index, 0x7f
            try: h.call(self.A['kdisplay'], limit=100000)
            except Exception as e: return '!' + str(e)
            return last_text(h.runs)
        if self.A.get('style') == 'c':  # 0D15: type 4373, name 4376, page 4379, index 437A; shown while Knob Display (2461) is on
            c.ram[self.A['part_var']] = 0x40
            c.ram[0x23] &= ~0x04  # bit 23.2 (1Ah) set skips the display
            c.x[0x4373], c.x[0x4376], c.x[0x4379], c.x[0x437a], c.x[0x437b], c.x[0x2461] = dtype, name, page, index, 0, 0x7f
            try: h.call(self.A['kdisplay'], limit=100000)
            except Exception as e: return '!' + str(e)
            return last_text(h.runs)
        c.ram[0x50] = 0x40
        c.x[0x7f49], c.x[0x7f4b], c.x[0x7f4e], c.x[0x7f4f], c.x[0x7f50] = dtype, name, page, index, 0
        try: h.call(self.A['kdisplay'], limit=100000)
        except Exception as e: return '!' + str(e)
        return last_text(h.runs)

    def target_of(self, k, raw_bytes, carry):
        """Knob k's handler in a panel state: (display type, short name, page, index) it stores for the display."""
        h = Host(self.img, self.A['lcd_cmd'], self.A['lcd_chr'])
        c = h.cpu
        def kidx(cpu): cpu.a = k; return True
        def raw(cpu): cpu.a = raw_bytes.get(cpu.a, 0); return True
        def st(cpu): cpu.cy = carry; return True
        def rd(cpu): cpu.ram[0x56] = 0; cpu.a = 0; return True
        c.hooks[self.A['knob_index']] = kidx
        c.hooks[self.A['raw']] = raw
        c.hooks[self.A['state']] = st
        c.hooks[self.A['read']] = rd
        for a in (0x7f49, 0x7f4b, 0x7f4e, 0x7f4f): c.x[a] = 0xee
        try: h.call(self.A['dispatch'], limit=100000)
        except Exception: return None
        r = tuple(c.x[a] for a in (0x7f49, 0x7f4b, 0x7f4e, 0x7f4f))
        return None if r[2] == 0xee else r


    def explore_rxl(self, k):
        """Rack XL: parameter knob k (1-4) on every knob page (the shown record's byte 7): every (display type, short name,
        page, index, title) its kind's handler (dispatch 2AB0) stores at 2CC5, over the sound bytes (0769) and parameters
        (0788) it tests."""
        A = self.A
        RAW = (0, 1, 2, 3, 0x20, 0x40, 0x7f)
        seen = {}
        for pg in range(A['knob_pages'] if k else 0):
            def run(asg, consulted):
                h = Host(self.img, A['lcd_cmd'], A['lcd_chr'])
                c = h.cpu
                out = []
                def get(key, dom):
                    if key not in consulted: consulted.append(key)
                    return asg.get(key, dom[0])
                def value(cpu): cpu.a = 0x40; return True
                def rec(cpu):  # the shown record: byte 7 is the knob page
                    cpu.ram[0xf8] = (cpu.ram[0xf8] & 0x0f) | 0x20
                    cpu.a = pg if cpu.a == 7 else 0; cpu.cy = 1; return True
                def raw(cpu): cpu.a = get(('raw', cpu.a), RAW) & 0x7f; return True
                def rd(cpu):
                    v = get(('read', cpu.ram[0x55], cpu.ram[0x56]), (0, 1, 2))
                    cpu.ram[0x57] = v; cpu.a = v; return True
                def store(cpu): out.append((cpu.r(5), cpu.r(6), cpu.r(3), cpu.r(2), cpu.ram[0x2e])); raise Done()
                c.hooks[A['knob_value']] = value
                c.hooks[A['rec_byte']] = rec
                c.hooks[A['raw']] = raw
                c.hooks[A['read']] = rd
                c.hooks[A['knob_store']] = store
                c.ram[A['part_var']] = 0x40
                c.setr(0, k)
                try: h.call(A['knob_entry'], limit=100000)
                except Done: pass
                except Exception: return None
                return out[0] if out else None
            stack, tried = [{}], set()
            while stack:
                asg = stack.pop()
                consulted = []
                r = run(asg, consulted)
                if r: seen[r] = seen.get(r, 0) + 1
                for key in consulted:
                    if key in asg: continue
                    for val in (RAW if key[0] == 'raw' else (0, 1, 2))[1:]:
                        new = dict(asg); new[key] = val
                        f = tuple(sorted(new.items()))
                        if f not in tried and len(new) <= 3: tried.add(f); stack.append(new)
        return seen

    def explore_c(self, k):
        """C style: every (display type, short name, page, index) knob k's handler (dispatch 3A20) stores at 3F11, over every
        panel state it tests: the sound bytes it reads (1401), the state routines (carry) and bit 27.5, each branch
        explored as the handler consults it."""
        A = self.A
        RAW = (0, 1, 2, 3, 0x20, 0x40, 0x7f)
        def run(asg, consulted, bit):
            h = Host(self.img, A['lcd_cmd'], A['lcd_chr'])
            c = h.cpu
            out = []
            def get(key, dom):
                if key not in consulted: consulted.append(key)
                return asg.get(key, dom[0])
            def kidx(cpu): cpu.a = k; return True
            def raw(cpu): cpu.a = get(('raw', cpu.a), RAW) & 0x7f; return True
            def carry(a):
                def f(cpu): cpu.cy = get(('carry', a), (0, 1)); return True
                return f
            def rd(cpu): cpu.ram[A['regs'][3]] = 0; cpu.a = 0; return True
            def store(cpu): out.append((cpu.r(5), cpu.r(6), cpu.r(3), cpu.r(2))); raise Done()
            c.hooks[A['knob_index']] = kidx
            c.hooks[A['raw']] = raw
            for a in A['carry']: c.hooks[a] = carry(a)
            c.hooks[A['read']] = rd
            c.hooks[A['knob_store']] = store
            if A.get('knob_bit') is not None:
                byte, b = 0x20 + (A['knob_bit'] >> 3), 1 << (A['knob_bit'] & 7)
                c.ram[byte] = (c.ram[byte] | b) if bit else (c.ram[byte] & ~b)
            c.ram[A['part_var']] = 0x40
            try: h.call(A['dispatch'], limit=100000)
            except Done: pass
            except Exception: return None
            return out[0] if out else None
        seen = {}
        stack, tried = [{}], set()
        while stack:
            asg = stack.pop()
            for bit in (0, 1):
                consulted = []
                r = run(asg, consulted, bit)
                if r: seen[r] = seen.get(r, 0) + 1
                for key in consulted:
                    if key in asg: continue
                    for val in (RAW if key[0] == 'raw' else (0, 1))[1:]:
                        new = dict(asg); new[key] = val
                        f = tuple(sorted(new.items()))
                        if f not in tried and len(new) <= 4: tried.add(f); stack.append(new)
        return seen


def text16(img, at, n=16): return img[at:at + n].decode('latin1').replace('$', ' ').strip()


# record byte offsets (B / C): kind, parameter, second parameter, range, reset value, layout, display type, title, label, marker
FIELDS = dict(kind=3, page=5, index=6, page2=7, index2=8, min=0x0b, max=0x0c, d=0x0f, sub=0x10, layout=0x11, dtype=0x12, title=0x13,
              label=0x14, marker=0x17)


def extract_menus(img, A, log=print):
    out = []
    cache = {}
    cstyle = A.get('style') == 'c'
    for name, tab, model, base, count in tables_of(img, A):
        recs = []
        menu = Menu(img, A, model)
        F = A.get('fields', FIELDS)
        for i in range(count if count is not None else 400):
            r = img[base + A['rec'] * i: base + A['rec'] * (i + 1)]
            if len(r) < A['rec'] or r[F['marker']] & A.get('marker_mask', 0xff) != A.get('marker', 0xaa): break
            f = {k: (r[o] if o is not None else 0xff) for k, o in F.items()}
            e = dict(i=i, raw=r.hex(' '), kind=f['kind'], page=f['page'], index=f['index'], page2=f['page2'], index2=f['index2'], min=f['min'],
                     max=f['max'], d=f['d'], sub=f['sub'], layout=f['layout'], dtype=f['dtype'], title=text16(img, A['titles'] + 16 * f['title']),
                     label=text16(img, A['labels'] + 16 * f['label']) if f['label'] != 0xff else '')
            if f['page'] <= 2 and f['index'] < 0x80:
                key = (model, bytes(r)) if cstyle else r[3:]
                got = cache.get(key)
                if got is None or got['model_read']:
                    err = menu.load(i, (f['page'], f['index']), tab)
                    texts, extra, model_read = {}, {}, False
                    for v in range(128):
                        if err: texts[v] = '!' + err; continue
                        res, err2 = menu.show(v)
                        if err2: texts[v] = '!' + err2; continue
                        texts[v] = res[2]
                        if v == f['min']: extra = dict(screen=[res[0], res[1]], reads=sorted(set(menu.reads)))
                    got = dict(texts=texts, model_read=False, **extra)
                    cache[key] = got
                e.update({k: v for k, v in got.items() if k != 'model_read'})
            recs.append(e)
        out.append(dict(model=name, table=tab, records=recs))
        log(f'table {tab:04x}: {len(recs)} records')
    return out


def extract_knobs(img, A, log=print):
    kn = Knob(img, A)
    texts = img[A['knob_text']:A['knob_text'] + 0x400].split(b'\x00')[:A['knobs']] if A.get('knob_text') else [b''] * A['knobs']
    out = []
    for k in range(A['knobs']):
        seen = {}
        if A.get('knob_style') == 'rxl': seen = kn.explore_rxl(k)
        elif A.get('style') == 'c' or A.get('knob_style') == 'a': seen = kn.explore_c(k)
        else:
          for b in (0, 1, 2, 0x20, 0x40, 0x7f):
            for carry in (0, 1):
                for b4 in (0, 1, 2, 3, 0x20, 0x40):
                    r = kn.target_of(k, {0x04: b4, 0x93: b, 0xa0: b, 0x92: b, 0x7a: b}, carry)
                    if r: seen[r] = seen.get(r, 0) + 1
        targets = []
        for tg, n in seen.items():
            dtype, name, page, index = tg[:4]
            nl = A.get('name_len', 12)
            t = dict(dtype=dtype, name=text16(img, A['names'] + nl * name, nl), page=page, index=index, states=n,
                     texts={v: kn.show_knob(dtype, name, page, index, v, *tg[4:]) for v in range(128)} if page <= 2 else {})
            if len(tg) > 4: t['title'] = text16(img, A['titles'] + 16 * tg[4]) if tg[4] < A['title_count'] else ''
            targets.append(t)
        out.append(dict(knob=k, text=texts[k].decode('latin1').strip(), targets=targets))
    log(f'knobs: {len(out)}')
    return out


def cc_names(img, A):
    """The page A names per index (15-byte records "name ... number", the definable MIDI controller list)."""
    out = {}
    if not A.get('cc_names'): return out
    a = A['cc_names']
    for _ in range(128):
        r = img[a:a + 15].decode('latin1')
        m = re.fullmatch(r'(.*?)\s*(\d{1,3})', r)
        if not m: break
        out[int(m.group(2))] = m.group(1).strip()
        a += 15
    return out


def handler_classes(img, A):
    """Page A / B / C index -> the class of the reader's handler (A['classes']), from its jump table."""
    if A.get('handler_bytes'):  # C style: per page (bank 1 pointers) a handler number per index, numbers -> jump table
        tab, jump = A['handler_bytes']
        out = {}
        for p in range(3):
            ptr = (img[tab + 2 * p] << 8) | img[tab + 2 * p + 1]
            n = img[ptr]
            for i in range(128):
                num = img[ptr + 1 + i] if i < n else 0
                h = (img[jump + 2 * num] << 8) | img[jump + 2 * num + 1]
                out[(p, i)] = A['classes'].get(h, f'{h:04x}')
        return out
    if not A.get('handlers'): return {}
    out = {}
    for p in range(3):
        for i in range(128):
            at = A['handlers'] + 256 * p + 2 * i
            h = (img[at] << 8) | img[at + 1]
            out[(p, i)] = A['classes'].get(h, f'{h:04x}')
    return out
