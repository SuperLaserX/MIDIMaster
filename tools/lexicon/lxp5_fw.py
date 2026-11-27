# Lexicon LXP-5 tables for js/devices/defs/lexicon-lxp5-fw.js, from the LXP-5 v1.12 EPROM and the MRC v4.00
# EPROMs. The LXP-5 shows only a program number: its parameters are shown and edited on the MRC (MIDI Remote
# Controller), whose LXP-5 module (U102 bank A 1B03h-2CFFh) holds the algorithm names, page labels and
# parameter records (MRC slot, steps, send routine, LXP-5 parameter, display routine, argument). Every value
# text comes from running the MRC's own display routine with the value stored where the routine reads it
# (CC20h points at the MRC's setup record, values at +9 + slot); the delay pairs (coarse / FINE) are read
# together by their routines, so they get one text per pair of values. The patch page texts come from running
# the module's page routine (2143h) for every value.
# Test vectors come from the LXP-5 firmware run in the Z80 emulator (tools/lexicon/lxp1_board.py, uart 80h).
#   python -I lxp5_fw.py <lxp5.bin> <mrc_dir> <out.js> [--vectors tests/lexicon-lxp5.vectors.json] [--cache DIR]
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mrc_board import MRC, load  # noqa: E402
from lxp1_board import Board  # noqa: E402

PRESETS_AT, REG, N_PRESETS = 0x3AA5, 57, 65   # LXP-5 ROM presets: programs 80h-C0h (03AE), register form
MODULE = 0x1B09                               # MRC LXP-5 module header (name, RAM, count, size, algs, table...)
PAGE = 0x2143                                 # module page routine (FAD6h setup record, FAD8h page)
REC = 0xE000
SEND = {0x43AB: 'plain', 0x43D5: 'pitch'}     # plain: 2n pp v; pitch: v 0 -> pp-1 = 0, else pp-1 = 1, pp = v - 1
DEST_REMAP = {23: 0x2F, 24: 0x34, 25: 0x39, 26: 0x3E}   # bae1 / BBBDh: Dest 23-26 sent as the patch Scale parameters


def mrc_open(mrc_dir):
    D = mrc_dir
    m = MRC(load(os.path.join(D, 'mrc400_u102.bin'), os.path.join(D, 'mrc400_u103.bin'), os.path.join(D, 'mrc400_u104.bin')))
    m.write(0xCC24, 2)   # current device: LXP-5
    m.write(0xCC20, REC & 0xFF)
    m.write(0xCC21, REC >> 8)
    m.write(0xFAD6, REC & 0xFF)
    m.write(0xFAD7, REC >> 8)
    return m


def rle(texts):
    out = []
    for t in texts:
        if out and out[-1][0] == t:
            out[-1][1] += 1
        else:
            out.append([t, 1])
    return out


def mrc_tables(mrc_dir, cache):
    m = mrc_open(mrc_dir)
    assert m.cstr(0x1B03) == 'LXP-5'
    tables, tkey, pairs, pkey = [], {}, [], {}

    def clear(alg):
        for i in range(0x2F):
            m.write(REC + i, 0)
        m.write(REC + 8, alg)

    def single(alg, slot, disp, steps, arg):
        k = (disp, steps, arg)
        if k not in tkey:
            clear(alg)
            texts = []
            for v in range(steps):
                m.write(REC + 9 + slot, v)
                texts.append(m.display(disp, v, steps, arg).strip())
            tkey[k] = len(tables)
            tables.append(texts)
        return tkey[k]

    def pair(alg, a, b, disp, steps, arg):
        k = (disp, a, b, steps, arg)
        if k not in pkey:
            path = cache and os.path.join(cache, 'pair_%04X_%d_%d_%d_%d.json' % k)
            if path and os.path.exists(path):
                texts = json.load(open(path, encoding='utf-8'))
            else:
                clear(alg)
                texts = []
                for c in range(steps):
                    m.write(REC + 9 + a, c)
                    for f in range(128):
                        m.write(REC + 9 + b, f)
                        texts.append(m.display(disp, c, steps, arg).strip())
                if path:
                    json.dump(texts, open(path, 'w', encoding='utf-8'))
            pkey[k] = len(pairs)
            pairs.append({'coarse': steps, 'rle': rle(texts)})
        return pkey[k]

    def deps(alg, slot, disp, steps, arg):
        clear(alg)
        m.write(REC + 9 + slot, 5)
        t0 = m.display(disp, 5, steps, arg)
        out = []
        for s in range(23):
            if s == slot:
                continue
            m.write(REC + 9 + s, 77)
            if m.display(disp, 5, steps, arg) != t0:
                out.append(s)
            m.write(REC + 9 + s, 0)
        return out

    nalg, tab = m.read(MODULE + 7), m.w(MODULE + 8)
    algs = []
    for i in range(nalg):
        r = m.w(tab + 2 * i)
        name, code, npages, plist = m.cstr(m.w(r)).strip(), m.read(r + 2), m.read(r + 3), m.w(r + 4)
        pages = []
        recs = []
        for p in range(npages):
            pg = m.w(plist + 2 * p)
            label = m.cstr(m.w(pg))
            items = []
            for k in range(10):
                rec = m.w(pg + 2 + 2 * k)
                if not rec:
                    continue
                b = [m.read(rec + j) for j in range(8)]
                it = {'name': label[6 * k:6 * k + 6].strip(), 'slot': b[0], 'p': b[4], 'steps': b[1],
                      'send': SEND[b[2] | (b[3] << 8)], 'disp': '%04X' % (b[5] | (b[6] << 8)), 'arg': b[7]}
                items.append(it)
                recs.append(it)
            words = label.split()
            if len(words) == len(items):   # the label line's words, in fader order (they do not keep 6 columns)
                for it, w in zip(items, words):
                    it['name'] = w
            pages.append({'label': label, 'items': items})
        # pairs: an item whose routine reads another slot
        for it in recs:
            disp = int(it['disp'], 16)
            d = deps(i, it['slot'], disp, it['steps'], it['arg'])
            if d:
                assert len(d) == 1, (it, d)
                other = d[0]
                coarse = min(it['slot'], other)
                fine = max(it['slot'], other)
                csteps = next(x['steps'] for x in recs if x['slot'] == coarse)
                it['pair'] = pair(i, coarse, fine, disp, csteps, it['arg'])
                it['coarseSlot'], it['fineSlot'] = coarse, fine
            else:
                it['t'] = single(i, it['slot'], disp, it['steps'], it['arg'])
        # patch page: Src, Thrsh, Dest, Scale (fields 0-3 of four bytes at record + 1Fh)
        algs.append({'v': code, 'name': name, 'mrc': i, 'pages': pages})
    patch = {}

    def screen(page):
        m.write(0xFAD8, page)
        return m.screen(PAGE)

    def fill(alg):
        clear(alg)
        m.cstr(0x1B03)
        for k in range(16):
            m.write(REC + 0x1F + k, 0x7F if k % 4 in (0, 2) else 0)

    fill(0)
    src = []
    for v in list(range(0x48)) + [0x7F]:
        m.write(REC + 0x1F, v)
        src.append([v, screen(1)[1][0:6].strip()])
    fill(0)
    thr = []
    for v in range(128):
        m.write(REC + 0x20, v)
        thr.append(screen(1)[1][6:12].strip())
    fill(0)
    scale = []
    for v in range(128):
        m.write(REC + 0x22, v)
        scale.append(screen(1)[1][18:24].strip())
    dest = []
    for a in range(nalg):
        fill(a)
        names = []
        for v in list(range(0x1C)) + [0x7F]:
            m.write(REC + 0x21, v)
            names.append([v, screen(1)[1][12:18].strip()])
        dest.append(names)
    fill(0)
    labels = [screen(p)[0].strip() for p in range(1, 5)]
    patch = {'src': src, 'thresh': thr, 'scale': scale, 'dest': dest, 'labels': labels, 'destRemap': {str(k): v for k, v in DEST_REMAP.items()}}
    return algs, tables, pairs, patch


def presets(img):
    out = []
    for i in range(N_PRESETS):
        r = img[PRESETS_AT + i * REG:PRESETS_AT + (i + 1) * REG]
        nm = bytes(c for c in r[24:35] if c).decode('latin-1').rstrip()
        out.append([nm, r.hex()])
    return out


# ------------------------------------------------------------------ vectors from the LXP-5 firmware
class Unit:
    def __init__(self, img):
        self.b = Board(img, uart=0x80)
        self.c = self.b.cpu
        self.n = 0
        self.c.pc, self.c.sp = 0x0239, 0xA263   # after the power-up tests (4FA4)
        self.run(3_000_000)

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


def vectors(img, pre):
    u = Unit(img)
    v = {}
    q = lambda *a: [0xF0, 6, 5, *a, 0xF7]  # noqa: E731
    v['setup0'] = u.send(q(0x30, 0x60))
    reg = list(bytes.fromhex(pre[16][1]))
    msg = [0xF0, 6, 5, 0x10, 0x07, 0x39] + reg + [sum(reg) & 0x7F, 0xF7]
    v['registerIn'] = msg
    u.send(msg)
    v['register7'] = u.send(q(0x30, 0x61, 0x07))
    u.send(q(0x60, 0x71, 0x07))
    v['afterLoad'] = u.send(q(0x30, 0x60))
    v['param0'] = u.send(q(0x30, 0x62, 0x00))
    u.send(q(0x20, 0x00, 0x11))
    u.send(q(0x20, 0x08, 0x01))
    u.send(q(0x20, 0x09, 0x0C))
    u.send(q(0x20, 0x2E, 0x2F))
    v['edits'] = [q(0x20, 0x00, 0x11), q(0x20, 0x08, 0x01), q(0x20, 0x09, 0x0C), q(0x20, 0x2E, 0x2F)]
    v['afterEdits'] = u.send(q(0x30, 0x60))
    s = u.send(q(0x30, 0x60))
    setup = s[5:-2]
    setup[1] = 0x22
    msg = [0xF0, 6, 5, 0x00, 0x5E] + setup + [sum(setup) & 0x7F, 0xF7]
    v['setupIn'] = msg
    u.send(msg)
    v['afterSetupIn'] = u.send(q(0x30, 0x60))
    u.send(q(0x60, 0x70, 0x0A))
    v['register10'] = u.send(q(0x30, 0x61, 0x0A))
    u.send(q(0x60, 0x71, 0x07))
    u.send([0xC0, 0x0A])
    v['afterProgramChange'] = u.send(q(0x30, 0x60))
    allm = u.send(q(0x30, 0x64), steps=8_000_000)
    v['allLength'] = len(allm)
    v['allHead'] = allm[:6]
    v['allRegister7'] = allm[6 + 7 * REG:6 + 8 * REG] if len(allm) > 8 else None
    v['allChecksumOk'] = len(allm) > 8 and (sum(allm[6:-2]) & 0x7F) == allm[-2]
    return v


def js(o):
    return json.dumps(o, separators=(',', ':'), ensure_ascii=True)


def main():
    img = open(sys.argv[1], 'rb').read()
    mrc_dir, out = sys.argv[2], sys.argv[3]
    cache = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else None
    if cache:
        os.makedirs(cache, exist_ok=True)
    pre = presets(img)
    if '--vectors' in sys.argv:
        vp = sys.argv[sys.argv.index('--vectors') + 1]
        with open(vp, 'w', encoding='utf-8') as f:
            json.dump(vectors(img, pre), f, separators=(',', ':'))
        print('vectors', vp)
    algs, tables, pairs, patch = mrc_tables(mrc_dir, cache)
    lines = [
        '// Generated by tools/lexicon/lxp5_fw.py from the Lexicon LXP-5 v1.12 EPROM and the MRC v4.00 EPROMs: do not edit.',
        '// ALGS: the MRC LXP-5 algorithms (v = setup byte 0), pages (label line, items: name, MRC slot, p = the LXP-5',
        '// parameter it sends, steps, send kind, t = text table, or pair = a coarse / FINE text table with the coarse and',
        '// fine slots). TABLES: MRC texts for v = 0..steps-1. PAIRS: texts for coarse x 128 + fine, run-length coded.',
        '// PATCH: the patch page texts (Src, Thrsh, Dest per algorithm with the Dest values the MRC sends, Scale).',
        '// PRESETS: the 65 ROM presets (programs 128-192) [name, the 57 register bytes].',
        "export const FIRMWARE = 'LXP-5 v1.12 EPROM (LXP5 Version 1.12, Copyright 1989 Lexicon) and the MRC v4.00 EPROMs (U102 / U103 / U104)';",
        'export const ALGS = %s;' % js(algs),
        'export const TABLES = %s;' % js(tables),
        'export const PAIRS = %s;' % js(pairs),
        'export const PATCH = %s;' % js(patch),
        'export const PRESETS = %s;' % js(pre),
        '',
    ]
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    print('wrote', out, 'algs', len(algs), 'tables', len(tables), 'pairs', len(pairs), 'presets', len(pre))


if __name__ == '__main__':
    main()
