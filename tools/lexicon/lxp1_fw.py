# Lexicon LXP-1 tables for js/devices/defs/lexicon-lxp1-fw.js, from the LXP-1 v1.06 EPROM and the MRC v4.00
# EPROMs. The LXP-1 has no display: its parameters are shown and edited on the MRC (MIDI Remote Controller),
# whose LXP-1 module (U102 bank A 0038h-1AFFh) holds the algorithm names, the page labels, the parameter
# records (MRC slot, steps, send routine, LXP-1 parameter, display routine) and the patch page. Every value
# text comes from running the MRC's own display routine for that value (tools/lexicon/mrc_board.py); the
# patch Src / Dest / Scale texts from running its patch page (067Bh) for every value.
# Test vectors come from the LXP-1 firmware run in the Z80 emulator (tools/lexicon/lxp1_board.py): what it
# answers to requests and what its receiver does with dumps and parameter messages.
#   python -I lxp1_fw.py <lxp1.bin> <mrc_dir> <out.js> [--vectors tests/lexicon-lxp1.vectors.json]
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mrc_board import MRC, load  # noqa: E402
from lxp1_board import Board  # noqa: E402

PRESETS_AT, PRESET_LEN, N_PRESETS = 0x3380, 0x3B, 16   # LXP-1 ROM presets 128-143 (04A9: setup form)
ALG_TABLE = 0x1326                                     # LXP-1: count, then descriptor pointers (word 0 = code)
MRC_LXP1 = 0x0038                                      # MRC module: JP 8010, name, header
MRC_ALGS = 0x0060                                      # 8 pointers: name, code, pages, page list
MRC_PAGE = 0x067B                                      # page display (F7E2 setup record, F7E4 page)
SEND = {0x10A0: 'a', 0x1112: 'b'}                      # a: 8000h + v * 4000h / steps; b: 4000h + v * 8000h / steps


def register_of(setup):
    """Setup form (59 bytes: alg, 11 words, name 16, patches 12, work 8) -> the 49 bytes a register / dump holds."""
    return setup[0:1] + setup[1:21] + setup[23:39] + setup[39:51]


def word_of(kind, steps, v):
    if steps == 255:
        v2 = v + 1 if v > 0x79 else v
        return (0x8000 + v2 * 0x40) if kind == 'a' else (0x4000 + v2 * 0x80)
    return (0x8000 + v * (0x4000 // steps)) if kind == 'a' else (0x4000 + v * (0x8000 // steps))


def mrc_tables(mrc_dir):
    D = mrc_dir
    m = MRC(load(os.path.join(D, 'mrc400_u102.bin'), os.path.join(D, 'mrc400_u103.bin'), os.path.join(D, 'mrc400_u104.bin')))
    assert m.cstr(MRC_LXP1 + 3) == 'LXP-1'
    tables, tkey = [], {}
    algs = []

    def table(disp, steps, arg):
        k = (disp, steps, arg)
        if k not in tkey:
            n = 255 if steps == 255 else steps
            tkey[k] = len(tables)
            tables.append([m.display(disp, v, steps, arg).strip() for v in range(n)])
        return tkey[k]

    def page_screen(rec, page):
        for i, b in enumerate(rec):
            m.write(0xE000 + i, b)
        m.write(0xF7E2, 0x00)
        m.write(0xF7E3, 0xE0)
        m.write(0xF7E4, page)
        return m.screen(MRC_PAGE)

    blank = bytearray(29)
    blank[0:8] = b'Big Hall'
    for k in range(17, 25):
        blank[k] = 0x7F
    for i in range(8):
        r = m.w(MRC_ALGS + 2 * i)
        name, code, npages, plist = m.cstr(m.w(r)).strip(), m.read(r + 2), m.read(r + 3), m.w(r + 4)
        pages = []
        for p in range(npages):
            pg = m.w(plist + 2 * p)
            label = m.cstr(m.w(pg))
            items = []
            for k in range(10):
                rec = m.w(pg + 2 + 2 * k)
                if not rec:
                    continue
                b = [m.read(rec + j) for j in range(8)]
                slot, steps, send, w, disp, arg = b[0], b[1], b[2] | (b[3] << 8), b[4], b[5] | (b[6] << 8), b[7]
                items.append({'name': label[6 * k:6 * k + 6].strip(), 'slot': slot, 'w': w, 'steps': steps,
                              'send': SEND[send], 't': table(disp, steps, arg), 'disp': '%04X' % disp})
            pages.append({'label': label, 'items': items})
        dest = []
        for v in range(11):
            rec = bytearray(blank)
            rec[8] = i
            rec[21] = v
            dest.append(page_screen(rec, 1)[1][12:18].strip())
        algs.append({'v': code, 'name': name, 'mrc': i, 'pages': pages, 'dest': dest})
    src = []
    for v in list(range(0x46)) + [0x7F]:
        rec = bytearray(blank)
        rec[17] = v
        src.append([v, page_screen(rec, 1)[1][0:12].strip()])
    scale = []
    for v in range(256):
        rec = bytearray(blank)
        rec[25] = v
        scale.append(page_screen(rec, 1)[1][18:24].strip())
    labels = [page_screen(blank, p)[0].strip() for p in range(1, 5)]
    return algs, tables, src, scale, labels


def lxp1_tables(img):
    n = img[ALG_TABLE]
    codes = []
    for i in range(n):
        d = img[ALG_TABLE + 1 + 2 * i] | (img[ALG_TABLE + 2 + 2 * i] << 8)
        t6 = img[d + 6] | (img[d + 7] << 8)
        codes.append((img[d], img[t6]))   # algorithm code, number of 16-bit parameters
    presets = []
    for i in range(N_PRESETS):
        s = img[PRESETS_AT + i * PRESET_LEN:PRESETS_AT + (i + 1) * PRESET_LEN]
        reg = register_of(s)
        nm = bytes(c for c in reg[21:37] if c).decode('latin-1').strip()
        presets.append([nm, reg.hex(), s.hex()])
    return codes, presets


# ------------------------------------------------------------------ vectors from the LXP-1 firmware
class Unit:
    def __init__(self, img):
        self.b = Board(img)
        self.c = self.b.cpu
        self.n = 0
        self.c.pc, self.c.sp = 0x017E, 0xE000   # after the power-up tests (they need the DSP)
        self.run(2_000_000)

    def run(self, k):
        c, b = self.c, self.b
        for _ in range(k):
            c.step()
            self.n += 1
            if self.n % 300 == 0:
                b.irq()

    def send(self, msg, steps=1_500_000):
        self.b.tx.clear()
        self.b.rx.extend(bytes(msg))
        self.run(steps)
        return list(self.b.tx)


def pack(d):
    out = []
    for i in range(0, len(d), 7):
        g = d[i:i + 7]
        out.append(sum(1 << k for k, x in enumerate(g) if x & 0x80))
        out += [x & 0x7F for x in g]
    return out


def vectors(img, presets):
    u = Unit(img)
    v = {}
    reg = list(bytes.fromhex(presets[1][1]))
    p = pack(reg)
    setup_msg = [0xF0, 6, 2, 0x00, 0x38] + p + [sum(p) & 0x7F, 0xF7]
    v['setupIn'] = setup_msg
    u.send(setup_msg)
    v['setupOut'] = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7])
    v['param2'] = u.send([0xF0, 6, 2, 0x30, 0x62, 0x00, 0xF7])
    v['param5'] = u.send([0xF0, 6, 2, 0x30, 0x65, 0x02, 0xF7])
    v['paramName'] = u.send([0xF0, 6, 2, 0x30, 0x62, 0x20, 0xF7])
    # a 5n word, a 2n word (hb lo hi), an algorithm change, a name character, a patch byte
    u.send([0xF0, 6, 2, 0x50, 0x00, 0x0A, 0x0C, 0x04, 0x00, 0xF7])
    u.send([0xF0, 6, 2, 0x20, 0x01, 0x03, 0x40, 0x11, 0xF7])
    u.send([0xF0, 6, 2, 0x50, 0x21, 0x00, 0x00, 0x04, 0x01, 0xF7])
    u.send([0xF0, 6, 2, 0x50, 0x30, 0x00, 0x00, 0x04, 0x01, 0xF7])
    u.send([0xF0, 6, 2, 0x50, 0x38, 0x00, 0x00, 0x08, 0x00, 0xF7])
    v['edits'] = [[0xF0, 6, 2, 0x50, 0x00, 0x0A, 0x0C, 0x04, 0x00, 0xF7], [0xF0, 6, 2, 0x20, 0x01, 0x03, 0x40, 0x11, 0xF7],
                  [0xF0, 6, 2, 0x50, 0x21, 0x00, 0x00, 0x04, 0x01, 0xF7], [0xF0, 6, 2, 0x50, 0x30, 0x00, 0x00, 0x04, 0x01, 0xF7],
                  [0xF0, 6, 2, 0x50, 0x38, 0x00, 0x00, 0x08, 0x00, 0xF7]]
    v['afterEdits'] = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7])
    u.send([0xF0, 6, 2, 0x50, 0x41, 0x00, 0x00, 0x00, 0x07, 0xF7])
    v['algChange'] = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7])
    u.send([0xF0, 6, 2, 0x60, 0x70, 0x05, 0xF7])
    v['register5'] = u.send([0xF0, 6, 2, 0x30, 0x61, 0x05, 0xF7])
    u.send([0xF0, 6, 2, 0x50, 0x41, 0x00, 0x00, 0x00, 0x03, 0xF7])
    u.send([0xF0, 6, 2, 0x60, 0x71, 0x05, 0xF7])
    v['afterLoad'] = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7])
    u.send([0xF0, 6, 2, 0x50, 0x41, 0x00, 0x00, 0x00, 0x03, 0xF7])
    u.send([0xC0, 0x05])
    v['afterProgramChange'] = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7])
    # register dump in, read back
    reg2 = list(bytes.fromhex(presets[8][1]))
    p = pack(reg2)
    msg = [0xF0, 6, 2, 0x10, 0x09, 0x38] + p + [sum(p) & 0x7F, 0xF7]
    v['registerIn'] = msg
    u.send(msg)
    v['register9'] = u.send([0xF0, 6, 2, 0x30, 0x61, 0x09, 0xF7])
    allm = u.send([0xF0, 6, 2, 0x30, 0x64, 0xF7], steps=8_000_000)
    v['allLength'] = len(allm)
    v['allHead'] = allm[:6]
    v['allRegister9'] = None
    if len(allm) > 8:
        data = allm[6:-2]
        dec = []
        for i, x in enumerate(data):
            if i % 8 == 0:
                hb = x
            else:
                dec.append(x | (0x80 if (hb >> (i % 8 - 1)) & 1 else 0))
        v['allRegister9'] = dec[9 * 49:10 * 49]
        v['allChecksumOk'] = (sum(data) & 0x7F) == allm[-2]
    # wrong checksum: the setup must stay as it is
    bad = list(setup_msg)
    bad[-2] ^= 1
    before = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7])
    u.send(bad)
    v['badChecksumKept'] = u.send([0xF0, 6, 2, 0x30, 0x60, 0xF7]) == before
    return v


def js(o):
    return json.dumps(o, separators=(',', ':'), ensure_ascii=True)


def main():
    img = open(sys.argv[1], 'rb').read()
    mrc_dir, out = sys.argv[2], sys.argv[3]
    codes, presets = lxp1_tables(img)
    if '--vectors' in sys.argv:
        vp = sys.argv[sys.argv.index('--vectors') + 1]
        with open(vp, 'w', encoding='utf-8') as f:
            json.dump(vectors(img, presets), f, separators=(',', ':'))
        print('vectors', vp)
    algs, tables, src, scale, labels = mrc_tables(mrc_dir)
    for a in algs:
        n = dict(codes).get(a['v'])
        assert n == 11, (a['v'], n)
    lines = [
        '// Generated by tools/lexicon/lxp1_fw.py from the Lexicon LXP-1 v1.06 EPROM and the MRC v4.00 EPROMs: do not edit.',
        "// ALGS: the MRC's LXP-1 algorithms (v = setup byte 0, the LXP-1 code; mrc = place on the MRC algorithm page),",
        '// pages (label line, items: name, MRC slot, w = the 16-bit word it sets, steps, send kind a / b, t = text table),',
        '// dest = the patch Dest names (words 0-10). TABLES: the MRC display texts for v = 0..steps-1. SRC / SCALE: patch',
        '// page texts. PRESETS: the LXP-1 ROM presets 1-16 [name, the 49 register bytes, the 59 setup bytes].',
        "export const FIRMWARE = 'LXP-1 v1.06 EPROM (LXP Version 1.06, Copyright 1988 Lexicon) and the MRC v4.00 EPROMs (U102 / U103 / U104)';",
        'export const ALGS = %s;' % js([{k: a[k] for k in ('v', 'name', 'mrc', 'pages', 'dest')} for a in algs]),
        'export const TABLES = %s;' % js(tables),
        'export const SRC = %s;' % js(src),
        'export const SCALE = %s;' % js(scale),
        'export const PATCH_LABELS = %s;' % js(labels),
        'export const PRESETS = %s;' % js(presets),
        '',
    ]
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    print('wrote', out, 'algs', len(algs), 'tables', len(tables), 'presets', len(presets))


if __name__ == '__main__':
    main()
