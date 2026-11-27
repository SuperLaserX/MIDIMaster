# Alesis MIDIVerb III: build js/devices/defs/alesis-midiverb3-fw.js from the v1.01 EPROM image
# (27C256, 8031 code, 3-digit 7-segment LED).
#
#   python -I tools/alesis/midiverb3_fw.py "<image .bin>" > js/devices/defs/alesis-midiverb3-fw.js
#
# What it reads (addresses in the v1.01 image):
#   0ECF + 11*n   21 parameter descriptors (0D15): +0 storage 44xx (the work copy of EEPROM 06xx), +1 / +2
#                 minimum / maximum (a 2-byte value: maximum high / low byte), +3 default (both VALUE
#                 buttons, 0BD5), +4 marks the program edited, +5 display routine, +7 DSP routine,
#                 +9 VALUE button handler (100C one byte, 1012 two bytes, 1018 INT. PROG).
#   0DB2 + 19*c   the 19 button positions of configuration c (4400: 0-4 REVERB..MIX with the lower EDIT LED,
#                 5-9 with the upper one, 10 CONFIG, 11/12 MOD, 13 MIDI PROG, 14 INT. PROG, 15-18 MIDI)
#                 as descriptor numbers (1028-10D0 move between them).
#   0D2B          the longest DELAY TIME of each configuration (11AF limits the program to it).
#   31A3 / 31C1   DSP routine and limit of each parameter number of the SysEx parameter edit (opcode 03).
#   31D0          the limit of each program byte when a stored program is recalled (29EB, read backwards).
#   4000          the 100 factory programs, 16 bytes each (copied to the user bank by a reset, 010B).
#   display       every descriptor's display routine is run in an 8051 emulator (i8051.py) for every value;
#                 the LED digits are read back from IRAM 2Ah / 29h / 28h (left to right, active low:
#                 a = bit 3, b = 5, c = 7, d = 0, e = 1, f = 4, g = 6, decimal point = bit 2; digit font 01F1).
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i8051 import Cpu
from alesis_lcd import SEG

DESC, NDESC, PAGES, NCFG, NPOS = 0x0ECF, 21, 0x0DB2, 15, 19
DELAY_MAX, SX_DSP, SX_LIMIT, RECALL_LIMIT, FACTORY = 0x0D2B, 0x31A3, 0x31C1, 0x31D0, 0x4000
BITS = {'a': 3, 'b': 5, 'c': 7, 'd': 0, 'e': 1, 'f': 4, 'g': 6}


def word(d, a): return (d[a] << 8) | d[a + 1]


def main():
    d = open(sys.argv[1], 'rb').read()
    assert len(d) == 32768, 'a 27C256 image'
    # SysEx header check (2FF0: model 03) and the version shown with PROGRAM + EDIT (2B75: 1.01)
    assert d[0x3018:0x301a] == bytes([0xb4, 0x03]), 'not a MIDIVerb III image (SysEx model 03 at 3018)'
    assert d[0x2b75:0x2b7e] == bytes([0x75, 0x2a, 0x5b, 0x75, 0x29, 0x44, 0x75, 0x28, 0x5f]), 'not the v1.01 image (version 1.01 at 2B75)'

    seg = {}
    for p in range(256):  # every LED pattern -> character (digits from the font)
        s = 0
        for i, k in enumerate('abcdefg'):
            if not (p >> BITS[k]) & 1: s |= 1 << i
        seg[p] = SEG.get(s)
    for p, c in ((0x3f, '0'), (0x06, '1'), (0x5b, '2'), (0x4f, '3'), (0x66, '4'), (0x6d, '5'), (0x7d, '6'), (0x07, '7'), (0x7f, '8'), (0x6f, '9'), (0x67, '9')):
        for q in range(256):
            s = sum(1 << i for i, k in enumerate('abcdefg') if not (q >> BITS[k]) & 1)
            if s == p and seg[q] is None: seg[q] = c
    for i in range(10): seg[d[0x1f1 + i]] = str(i)

    def led(p):
        c = seg[p | 0x04]
        if c is None: raise ValueError('LED pattern %02x' % p)
        return c + ('.' if not p & 0x04 else '')

    def words(t):
        # a text with letters: the 7-segment 0 / 5 / 9 next to a letter are O / S / g (OFF, SC1, gt1, Pcs, Snd)
        if not any(c.isalpha() for c in t): return t
        out = []
        for i, c in enumerate(t):
            prev = out[-1] if out else ''
            nxt = t[i + 1] if i + 1 < len(t) else ''
            if c == '0' and nxt.isalpha(): c = 'O'
            elif c == '5' and nxt.isalpha(): c = 'S'
            elif c == '5' and prev.isalpha() and prev.islower(): c = 's'
            elif c == '9' and nxt.isalpha(): c = 'g'
            out.append(c)
        return ''.join(out)

    def show(n, v):
        desc = d[DESC + 11 * n: DESC + 11 * n + 11]
        cpu = Cpu(d)
        cpu.ram[0x81] = 0x30
        cpu.x[0x4403] = n
        st = 0x4400 | desc[0]
        if desc[1]:  # two bytes, high first (DELAY TIME 4444 / 4445)
            cpu.x[st], cpu.x[st + 1] = v >> 8, v & 0xff
        elif word(d, DESC + 11 * n + 5) == 0x041D:  # INT. PROG: the map entry the MIDI PROG page selects
            cpu.x[0x4452] = 0
            cpu.x[0x4456] = v
        else:
            cpu.x[st] = v
        cpu.call(word(d, DESC + 11 * n + 5))
        t = ''.join(led(cpu.ram[r]) for r in (0x2a, 0x29, 0x28)).strip()
        return words(t)

    descs, formats, fmt_index = [], [], {}
    for n in range(NDESC):
        a = DESC + 11 * n
        r = d[a:a + 11]
        two = r[0] == 0x44 and r[1] != 0  # DELAY TIME of configurations 14 / 15: maximum 01EAh
        mx = (r[1] << 8 | r[2]) if two else r[2]
        mn = 1 if two else r[1]  # 0CA5: a two-byte value stops at 1
        routine = word(d, a + 5)
        descs.append({'storage': 0x4400 | r[0] if r[0] else None, 'min': mn, 'max': mx, 'def': r[3], 'program': r[4],
                      'routine': '%04X' % routine, 'dsp': '%04X' % word(d, a + 7), 'handler': '%04X' % word(d, a + 9)})
    # one text list per display routine, as long as the largest maximum that uses it
    for n, x in enumerate(descs):
        k = x['routine']
        top = max(y['max'] for y in descs if y['routine'] == k)
        if k not in fmt_index:
            fmt_index[k] = len(formats)
            big = next(m for m, y in enumerate(descs) if y['routine'] == k and y['max'] == top)
            formats.append({'routine': k, 'texts': [show(big, v) for v in range(top + 1)]})
        x['fmt'] = fmt_index[k]
    pages = [list(d[PAGES + NPOS * c: PAGES + NPOS * (c + 1)]) for c in range(NCFG)]
    delay_max = [word(d, DELAY_MAX + 2 * c) for c in range(NCFG)]
    sx = [{'dsp': '%04X' % word(d, SX_DSP + 2 * p), 'limit': d[SX_LIMIT + p]} for p in range(15)]
    recall = [d[RECALL_LIMIT + 15 - i] for i in range(16)]
    factory = [d[FACTORY + 16 * i: FACTORY + 16 * i + 16].hex() for i in range(100)]
    for h in factory:
        p = bytes.fromhex(h)
        assert all(p[i] <= recall[i] for i in range(14)), 'factory program out of range: ' + h

    js = ['// Generated by tools/alesis/midiverb3_fw.py from the Alesis MIDIVerb III v1.01 EPROM image (27C256, 8031).',
          '// Do not edit by hand: run the tool again. DESCRIPTORS[n]: parameter descriptor at 0ECF + 11 n (storage, range,',
          '// default, display routine); FORMATS[f].texts[v]: what the 3-digit LED shows for value v (the display routine',
          '// run in an 8051 emulator); PAGES[c]: the descriptor of each of the 19 button positions in configuration c (0DB2).',
          'export const FIRMWARE = ' + json.dumps('MIDIVerb III v1.01') + ';']
    for k, v in [('DESCRIPTORS', descs), ('FORMATS', formats), ('PAGES', pages), ('DELAY_MAX', delay_max),
                 ('SYSEX_PARAMS', sx), ('RECALL_LIMIT', recall), ('FACTORY', factory)]:
        js.append('export const %s = %s;' % (k, json.dumps(v, separators=(',', ':'))))
    sys.stdout.write('\n'.join(js) + '\n')


if __name__ == '__main__':
    main()
