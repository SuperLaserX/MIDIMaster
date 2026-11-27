# Alesis Microverb 4: build js/devices/defs/alesis-microverb4-fw.js from the C4C v1.02 EPROM image
# (2-31-0066, 8051 code; the Wedge / MIDIVerb 4 software family without their LCD).
#
#   python -I tools/alesis/microverb4_fw.py "<image .bin>" > js/devices/defs/alesis-microverb4-fw.js
#
# What it reads (addresses in the C4C v1.02 image):
#   3000 + 80h*n  32 configuration descriptors: +00h name (16 characters), +10h / +11h Edit A / Edit B
#                 maxima, +14h page masks, +18h page titles, +1Ch the 16 parameter maxima, +2Ch page table
#                 (144-byte records as on the MIDIVerb 4), +36h / +38h the Edit A / Edit B routines
#                 (MOV A,13h or 12h; LCALL <display>; ...; LJMP into the DSP routine of the parameter they
#                 drive, or addressing several parameters), +40h the 16 parameter DSP routines.
#   C2A2 / CFA2   the 100 preset programs and the 100 programs the user bank starts from (26 bytes each);
#                 a user program keeps only Edit A, Edit B and which of the two it builds on (BA75).
#   C0A2 / C1A2   Edit A / B of each preset, and the user programs as a reset writes them (bit 7 of A = base).
#   display       the Edit A / B display routine of each configuration run in the 8051 emulator for every
#                 value; the 3-digit LED is read back from IRAM 7Eh, 7Dh, 7Ch (7-segment patterns, bit 7 =
#                 decimal point; digit font AF7E).
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i8051 import Cpu, dis
from alesis_lcd import SEG

DESC, STRIDE, NALG = 0x3000, 0x80, 32
TABLES = (0xC2A2, 0xCFA2)
SIZE = 26


def word(d, a): return (d[a] << 8) | d[a + 1]


def text_at(d, a, n): return d[a:a + n].decode('latin-1').replace(chr(0), ' ')


def flow(d, start, inside, limit=80):
    """What a short Edit A / B routine does: (calls, parameters). The parameters are the one whose DSP
    routine it jumps into, or else every edit-buffer parameter it addresses (MOV R0/R1,#D6h+i), for knobs
    that scale several parameters (MULTI TAP DELAY). Unconditional jumps inside the routine are followed."""
    calls, regs, pc = [], [], start
    for _ in range(limit):
        t, n, targets, falls = dis(d, pc)
        if t.startswith('LCALL') or t.startswith('ACALL'): calls.append(targets[0])
        if d[pc] in (0x78, 0x79) and 0xd6 <= d[pc + 1] < 0xe6 and d[pc + 1] - 0xd6 not in regs: regs.append(d[pc + 1] - 0xd6)
        if t.startswith('LJMP') or t.startswith('AJMP') or t.startswith('SJMP'):
            if inside(targets[0]) is not None: return calls, [inside(targets[0])]
            pc = targets[0]
            continue
        if t.startswith('RET'): break
        pc += n
    return calls, regs


def main():
    d = open(sys.argv[1], 'rb').read()
    assert len(d) == 65536 and d[0xb6d6:0xb6d9] == bytes([0xba, 0x0e, 0x13]), 'not a Microverb 4 C4C v1.02 image'
    seg = dict(SEG)
    for i in range(10): seg[d[0xAF7E + i]] = str(i)

    def led(start, stop, a, v, reg):
        # run the knob routine from its start until its display call has returned (stop)
        cpu = Cpu(d)
        cpu.ram[0x81] = 0x30
        cpu.wr(0x28, a & 0xff); cpu.wr(0x29, a >> 8)
        cpu.wr(reg, v); cpu.a = v
        cpu.pc = start
        for _ in range(200000):
            if cpu.pc == stop: break
            cpu.step()
        else: raise RuntimeError('display call did not return')
        chars = []
        for r in (0x7e, 0x7d, 0x7c):
            p = cpu.ram[r]
            if (p & 0x7f) not in seg: raise ValueError('LED pattern %02x' % p)
            chars.append(seg[p & 0x7f] + ('.' if p & 0x80 else ''))
        if any(c[0].isalpha() for c in chars): chars = [{'0': 'O', '5': 'S'}.get(c[0], c[0]) + c[1:] for c in chars]
        return ''.join(chars).strip()

    algs = []
    texts_index, formats = {}, []
    for n in range(NALG):
        a = DESC + STRIDE * n
        name = text_at(d, a, 16)
        masks, titles = list(d[a + 0x14: a + 0x18]), list(d[a + 0x18: a + 0x1c])
        maxima = list(d[a + 0x1c: a + 0x2c])
        ptab = word(d, a + 0x2c)
        pages = []
        for p in range(4):
            if not masks[p] & 15: continue
            pa = ptab + 144 * p
            head = text_at(d, pa, 24)
            t = titles[p]
            pages.append({'page': p, 'title': name[t >> 4: (t >> 4) + (t & 15)].strip(), 'sliders': masks[p] & 15,
                          'cols': [head[6 * s: 6 * s + 6].strip() for s in range(4)],
                          'long': [text_at(d, pa + 48 + 24 * s, 24).strip() for s in range(4)]})
        handlers = sorted({word(d, a + 0x40 + 2 * i): i for i in range(16) if maxima[i]}.items())
        knobs = []
        for k, (off, reg) in enumerate(((0x36, 0x13), (0x38, 0x12))):
            mx = d[a + 0x10 + k]
            def inside(x):
                for j, (start, i) in enumerate(handlers):
                    end = handlers[j + 1][0] if j + 1 < len(handlers) else start + 0x80
                    if start <= x < min(end, start + 0x80): return i
                return None
            start = word(d, a + off)
            calls, target = flow(d, start, inside)
            assert target and calls, 'config %d knob %d: no parameter or display call found' % (n, k)
            pc = start
            while not dis(d, pc)[0].startswith(('LCALL', 'ACALL')): pc += dis(d, pc)[1]
            vals = [led(start, pc + dis(d, pc)[1], a, v, reg) for v in range(mx + 1)]
            key = json.dumps(vals)
            if key not in texts_index: texts_index[key] = len(formats); formats.append({'routine': '%04X' % calls[0], 'texts': vals})
            knobs.append({'param': target, 'max': mx, 'fmt': texts_index[key]})
        algs.append({'name': name.strip(), 'pages': pages, 'max': maxima, 'knobs': knobs})

    def prog(a):
        p = d[a:a + SIZE]
        assert p[1] < NALG and all(32 <= c < 128 for c in p[2:10]), 'bad program at %04X' % a
        return p.hex()
    tables = [[prog(t + SIZE * i) for i in range(100)] for t in TABLES]
    # Edit A / B of the presets (C0A2, read on recall at BC0F) and the user bank as a reset writes it to the
    # EEPROM (C1A2, BAAF): [A (bit 7 = builds on the user factory program), B] per program
    ab = [list(d[0xC0A2 + 2 * i: 0xC0A2 + 2 * i + 2]) for i in range(100)]
    user = [list(d[0xC1A2 + 2 * i: 0xC1A2 + 2 * i + 2]) for i in range(100)]

    js = ['// Generated by tools/alesis/microverb4_fw.py from the Alesis Microverb 4 C4C v1.02 EPROM image.',
          '// Do not edit by hand. ALGORITHMS[n]: descriptor at 3000 + 80h n, with knobs[0] / knobs[1] = Edit A / B: the',
          '// parameters each drives, its maximum and its LED texts (FORMATS). PRESETS / USER_BASE: tables C2A2 / CFA2.',
          'export const FIRMWARE = ' + json.dumps('Microverb 4 C4C v1.02 (2-31-0066)') + ';']
    for k, v in [('ALGORITHMS', algs), ('FORMATS', formats), ('PRESETS', tables[0]), ('USER_BASE', tables[1]),
                 ('PRESET_AB', ab), ('USER_FACTORY', user)]:
        js.append('export const %s = %s;' % (k, json.dumps(v, separators=(',', ':'))))
    sys.stdout.write('\n'.join(js) + '\n')


if __name__ == '__main__':
    main()
