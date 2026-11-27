# Alesis Wedge: build js/devices/defs/alesis-wedge-fw.js from the W1 v1.02 EPROM image
# (2-31-0077, 06-30-97, 27C512, 8051 code).
#
#   python -I tools/alesis/wedge_fw.py "<image .bin>" > js/devices/defs/alesis-wedge-fw.js
#
# What it reads (addresses in the image):
#   F856 + 70*n   28 algorithm descriptors ("configurations"): +3 name (11 chars), +12h page masks
#                 (low nibble: sliders A-D in use), +18h page title (high nibble = first character
#                 of the name, low nibble = length), +1Eh the 24 parameter maxima, +36h page table,
#                 +44h display routine table (one routine per parameter).
#   page table    32 bytes per page: 24-character column heading (4 x 6 characters), then 4 pointers
#                 to the 24-character long names shown while a slider moves.
#   4E0B          128 preset programs (38 bytes each); 610B (100 programs) + 6FE3 ("BlankProgram",
#                 copied 28 times): the user bank's factory contents (copy loops at 360F and 3629).
#   display       each parameter's display routine is run in an 8051 emulator (i8051.py) for every
#                 value; the LCD segments it lights are read back as the text the Wedge shows: three
#                 7-segment digits (groups in the table at 0550, font at 09A1), the decimal points
#                 (segments 30+23c and 22+23c) and the unit icons
#                 (190+c %, 198+c k, 202+c Hz, 206+c m, 210+c s; c = slider column).
#   48A9 / 4901   MIDI modulator source (Mod#) and amplitude (Amp) displays.
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i8051 import Cpu
from alesis_lcd import Lcd

DESC, NALG = 0xF856, 28
PRESETS, USER1, USER2 = 0x4E0B, 0x610B, 0x6FE3
def word(d, a): return (d[a] << 8) | d[a + 1]


def text_at(d, a, n): return d[a:a + n].decode('latin-1')


def main():
    d = open(sys.argv[1], 'rb').read()
    assert len(d) == 65536 and b'ALESIS WEDGE' in d[:0x100], 'not a Wedge image'
    # segment set 07B3 / clear 07D8 / by carry 07B1, digit groups 0550, font 09A1; edit buffer page A2
    w = Lcd(d, font=0x9a1, groups=0x550, set_=0x07b3, clear=0x07d8, by_carry=0x07b1, skip=[0x0f9f], page=0xa2)
    formats, fmt_index, cache = [], {}, {}
    algs = []
    for n in range(NALG):
        a = DESC + 70 * n
        name = text_at(d, a + 3, 11)
        masks = list(d[a + 0x12: a + 0x18])
        titles = list(d[a + 0x18: a + 0x1e])
        maxima = list(d[a + 0x1e: a + 0x36])
        ptab = word(d, a + 0x36)
        rtab = word(d, a + 0x44)
        pages = []
        for p in range(6):
            if not masks[p] & 15: continue
            pa = ptab + 32 * p
            head = text_at(d, pa, 24)
            cols = [head[6 * s: 6 * s + 6].strip() for s in range(4)]
            longs = [text_at(d, word(d, pa + 24 + 2 * s), 24).strip() for s in range(4)]
            t = titles[p]
            pages.append({'page': p, 'title': name[t >> 4: (t >> 4) + (t & 15)].strip(), 'sliders': masks[p] & 15,
                          'icons': masks[p] >> 4, 'cols': cols, 'long': longs})
        fmts = []
        for i in range(24):
            mx = maxima[i]
            page = next((pg for pg in pages if pg['page'] == i // 4), None)
            if not mx or not page or not (page['sliders'] >> (i & 3)) & 1:
                fmts.append(-1); continue
            r = word(d, rtab + 2 * i)
            key = (r, mx)
            if key not in cache:
                def setup(cpu, a=a, i=i):
                    cpu.wr(0x56, a & 0xff); cpu.wr(0x57, a >> 8)
                    cpu.a = i
                vals = []
                for v in range(mx + 1):
                    def s2(cpu, v=v): setup(cpu); cpu.x[0xa2c2 + i] = v
                    try: vals.append(w.text(w.run(s2, 0x2299), i & 3))
                    except Exception as e: raise RuntimeError('%s: alg %d param %d routine %04X value %d' % (e, n, i, r, v))
                k = json.dumps(vals)
                if k not in fmt_index:
                    fmt_index[k] = len(formats); formats.append({'routine': '%04X' % r, 'texts': vals})
                cache[key] = fmt_index[k]
            fmts.append(cache[key])
        algs.append({'name': name.strip(), 'pages': pages, 'max': maxima, 'fmt': fmts})

    def prog(a):
        p = d[a:a + 38]
        alg = p[1]
        assert alg < NALG and all(32 <= c < 128 for c in p[2:14]), 'bad program at %04X' % a
        assert all(v <= m for v, m in zip(p[14:], algs[alg]['max'])), 'value above maximum at %04X' % a
        return p.hex()
    presets = [prog(PRESETS + 38 * i) for i in range(128)]
    user = [prog(USER1 + 38 * i) for i in range(100)] + [prog(USER2)] * 28  # 362C reloads 6FE3 each time

    def col_texts(entry, xaddr, col, count):
        out = []
        for v in range(count):
            def s(cpu, v=v): cpu.x[xaddr] = v
            out.append(w.text(w.run(s, entry), col))
        return out
    mod_src = col_texts(0x48A9, 0xA28A, 0, 124)
    mod_amp = col_texts(0x4901, 0xA28C, 1, 199)

    js = []
    js.append('// Generated by tools/alesis/wedge_fw.py from the Alesis Wedge W1 v1.02 EPROM image')
    js.append('// (2-31-0077, 06-30-97). Do not edit by hand: run the tool again.')
    js.append('// ALGORITHMS[n]: descriptor n at F856 + 70n (name, pages, the 24 parameter maxima and the')
    js.append('// display format of each parameter: an index into FORMATS, -1 when the parameter is unused).')
    js.append('// FORMATS[f].texts[v]: what the LCD shows for value v (run through the display routine).')
    js.append('export const FIRMWARE = ' + json.dumps('Wedge W1 v1.02 (2-31-0077, 06-30-97)') + ';')
    js.append('export const ALGORITHMS = ' + json.dumps(algs, separators=(',', ':')) + ';')
    js.append('export const FORMATS = ' + json.dumps(formats, separators=(',', ':')) + ';')
    js.append('/** Preset bank (4E0B) and the user bank as a reset leaves it (610B, 6FE3): 38 bytes each, hex. */')
    js.append('export const PRESETS = ' + json.dumps(presets, separators=(',', ':')) + ';')
    js.append('export const USER_FACTORY = ' + json.dumps(user, separators=(',', ':')) + ';')
    js.append('/** Modulator source (Mod#, 48A9) and amplitude (Amp, 4901) as the Util page shows them. */')
    js.append('export const MOD_SOURCES = ' + json.dumps(mod_src, separators=(',', ':')) + ';')
    js.append('export const MOD_AMOUNTS = ' + json.dumps(mod_amp, separators=(',', ':')) + ';')
    sys.stdout.write('\n'.join(js) + '\n')


if __name__ == '__main__':
    main()
