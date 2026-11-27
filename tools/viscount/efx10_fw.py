# Viscount EFX-10 firmware tables for js/devices/defs/viscount-efx10-fw.js.
# Runs the v1.02 EPROM (128 KB, 8051) in the emulator (tools/alesis/i8051.py + efx10_board.py):
#   - every edit page of every algorithm: the page is shown (1AC7) and stepped down to its lowest value and
#     up to its highest through the page handler (1152, table 116F); the preset bytes each step changes and
#     the LCD text it shows are recorded (MIDI CTRL target pages are shown while a controller is assigned)
#   - the MIDI EDIT EXC. message (SysEx 03): the parser (1FEE, table 2039) is explored by following the
#     values it compares message bytes with; each section / index / parameter path is matched to a page
#   - preset bytes no page edits: whether the DSP update (3982) reads them
#   - the menu pages (16A7 / 0FF8) and their value texts
# Usage: python -I tools/viscount/efx10_fw.py <efx10 image> <out.js> [--cache DIR] [algorithm ...]
#        (about 40 minutes; with --cache each algorithm's result is kept in DIR and reused)
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from efx10_board import make, run_until  # noqa: E402

STOP = {0x09b4, 0x05e5}
EB = 0x3d80          # edit buffer
REC = 0x1d6a2        # factory (ROM) presets: 81-byte records, one per algorithm
NALG = 27
USER0 = 0x10000      # factory user presets 28-128 (copied to RAM 2000 by the init 032B), 64 bytes each
NUSER = 101


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Unit:
    def __init__(self, img):
        self.img = img
        self.cpu = make(img)
        self.cpu.pc = 0
        run_until(self.cpu, {0x09b4})
        c = self.cpu
        self.snap = (bytes(c.ram), bytes(c.hi), bytes(c.x.ram))

    def restore(self):
        c = self.cpu
        c.ram[:] = self.snap[0]
        c.hi[:] = self.snap[1]
        c.x.ram[:] = self.snap[2]

    def checkpoint(self):
        c = self.cpu
        self.mark = (bytes(c.ram), bytes(c.hi), bytes(c.x.ram))

    def rollback(self):
        c = self.cpu
        c.ram[:] = self.mark[0]
        c.hi[:] = self.mark[1]
        c.x.ram[:] = self.mark[2]

    def lcd(self):
        return bytes(self.cpu.hi[0:32])

    def eb(self):
        return bytes(self.cpu.x.ram[EB:EB + 64])

    def set_eb(self, b):
        self.cpu.x.ram[EB:EB + 64] = b

    def run(self, pc, limit=2000000):
        self.cpu.pc = pc
        run_until(self.cpu, STOP, limit)

    def rom_record(self, alg):
        return self.img[REC + alg * 81:REC + alg * 81 + 81]

    def load(self, alg):
        """Factory preset `alg` stored as user preset 28 and recalled (0D68): the edit buffer holds it."""
        self.restore()
        rec = self.rom_record(alg)
        p = bytearray(b'    ' + rec[4:16] + rec[32:80])
        cs = 0
        for x in p[:62]:
            cs ^= x
        p[62] = cs
        self.cpu.x.ram[0x2000:0x2040] = p
        c = self.cpu
        c.ram[0x30] = 0x1b
        c.ram[0x38] = 0x1b
        c.ram[0x42] = 0
        self.run(0x0d68)
        return self.eb()

    def page(self, n):
        c = self.cpu
        c.ram[0x42] = 6
        c.ram[0x35] = n
        self.run(0x1ac7)
        return self.lcd()

    def step(self, up):
        c = self.cpu
        c.setbit(0x02, 1 if up else 0)
        c.setbit(0x05, 0)
        c.ram[0x24] = 0
        self.run(0x1152)
        return self.lcd()

    def walk(self, n, limit=4000):
        """[(edit buffer, lcd)] from the page's lowest value up to its highest."""
        self.page(n)
        last = self.eb()
        for _ in range(limit):
            self.step(False)
            cur = self.eb()
            if cur == last:
                break
            last = cur
        seq = [(last, self.page(n))]
        for _ in range(limit):
            t = self.step(True)
            cur = self.eb()
            if cur == last:
                break
            last = cur
            seq.append((cur, t))
        return seq


# ------------------------------------------------------------------ LCD text
LCD_MAP = {0x7e: '\u2192', 0x7f: '\u2190', 0xdf: '\u00b0', 0xe4: '\u00b5', 0xf4: '\u03a9'}


def lcd_text(b):
    return ''.join(chr(x) if 0x20 <= x < 0x7e else LCD_MAP.get(x, '\u25af') for x in b)


def split_page(seq):
    """Block (line 1 after the program number), label and the value text of every step."""
    screens = [lcd_text(t) for _, t in seq]
    var = sorted({i for s in screens for i in range(32) if s[i] != screens[0][i]})
    line = 1 if var and var[0] >= 16 else 0
    texts = []
    if line == 1:
        block = ' '.join(screens[0][4:16].split())
        f = var[0] - 16
        head = screens[0][16:16 + f]
        m = list(re.finditer(r'  +', head)) or list(re.finditer(r' ', head))
        cut = m[-1].start() if m else len(head.rstrip())
        label = ' '.join(head[:cut].split())
        for s in screens:
            texts.append(s[16 + cut:32].strip())
    else:
        # value on line 1 (ASSIGN): the line 2 text names the page
        f = var[0] if var else 16
        head = screens[0][4:f]
        m = list(re.finditer(r'  +', head)) or list(re.finditer(r' ', head))
        cut = m[-1].start() if m else len(head.rstrip())
        block = ' '.join(head[:cut].split())
        label = ' '.join(screens[0][16:32].split())
        for s in screens:
            texts.append(s[4 + cut:16].strip())
    return block, label, texts, screens


def field_of(seq, base):
    """Offset, size, bits, shift of the bits the walk changes (big-endian, as the handlers store them)."""
    mask = bytearray(64)
    for b, _ in seq:
        for i in range(64):
            mask[i] |= b[i] ^ base[i]
    idx = [i for i in range(64) if mask[i]]
    if not idx:
        return None
    off, end = idx[0], idx[-1]
    size = end - off + 1
    word = 0
    for i in range(off, end + 1):
        word = (word << 8) | mask[i]
    shift = (word & -word).bit_length() - 1
    bits = word.bit_length() - shift
    raw = []
    for b, _ in seq:
        w = 0
        for i in range(off, end + 1):
            w = (w << 8) | b[i]
        raw.append((w >> shift) & ((1 << bits) - 1))
    full = shift == 0 and bits == 8 * size
    return {'off': off, 'size': size, 'bits': None if full else bits, 'shift': shift or None, 'raw': raw}


# ------------------------------------------------------------------ compact value texts
NUM = re.compile(r'( *)([+-]?)(\d+)(?:\.(\d+))?')


def template(t):
    parts, fields, pos = [], [], 0
    for m in NUM.finditer(t):
        parts.append(t[pos:m.start()].replace('{', '{{').replace('}', '}}'))
        pad, sign, ip, fp = m.groups()
        dec = len(fp) if fp else 0
        v = int(ip + (fp or ''))
        if sign == '-':
            v = -v
        width = len(m.group(0)) if m.start() > 0 else 0
        zp = len(ip) if len(ip) > 1 and ip[0] == '0' else 0
        fields.append([v, 0, width, dec, (2 if v == 0 else 1) if sign == '+' else 0, zp])
        parts.append('{%d}' % (len(fields) - 1))
        pos = m.end()
    parts.append(t[pos:].replace('{', '{{').replace('}', '}}'))
    return ''.join(parts), fields


def fmt_field(v, width, dec, plus, zp):
    a = abs(v)
    ip = a // 10 ** dec
    s = ('%0*d' % (zp, ip)) if zp else '%d' % ip
    if dec:
        s += '.%0*d' % (dec, a % 10 ** dec)
    if v < 0:
        s = '-' + s
    elif (plus == 1 and v > 0) or (plus == 2 and v >= 0):
        s = '+' + s
    return s.rjust(width)


def render(tmpl, fields, i):
    vals = [fmt_field(f[0] + f[1] * i, f[2], f[3], f[4], f[5]) for f in fields]
    out, k = [], 0
    while k < len(tmpl):
        ch = tmpl[k]
        if ch == '{' and tmpl[k + 1:k + 2] == '{':
            out.append('{')
            k += 2
        elif ch == '}' and tmpl[k + 1:k + 2] == '}':
            out.append('}')
            k += 2
        elif ch == '{':
            e = tmpl.index('}', k)
            out.append(vals[int(tmpl[k + 1:e])])
            k = e + 1
        else:
            out.append(ch)
            k += 1
    return ''.join(out)


def compress(texts):
    """Segments [count, template, [[start, step, width, decimals, plus, zero-pad digits], ...]]."""
    segs = []
    i = 0
    while i < len(texts):
        tm, fl = template(texts[i])
        n = 1
        if fl and i + 1 < len(texts):
            tm2, fl2 = template(texts[i + 1])
            if tm2 == tm and len(fl2) == len(fl):
                for k in range(len(fl)):
                    fl[k][1] = fl2[k][0] - fl[k][0]
                while i + n < len(texts) and render(tm, fl, n) == texts[i + n]:
                    n += 1
                if n == 1:
                    for f in fl:
                        f[1] = 0
        assert render(tm, fl, 0) == texts[i], texts[i]
        segs.append([n, tm, fl])
        i += n
    return segs


def runs(raw):
    out = []
    for v in raw:
        if out and out[-1][0] + out[-1][1] == v:
            out[-1][1] += 1
        else:
            out.append([v, 1])
    return out


# ------------------------------------------------------------------ MIDI EDIT EXC. (03) parser
STOP03 = {0x3982, 0x1152, 0x05e5, 0x09b4}


def run03(u, data, base, trace=False):
    c = u.cpu
    u.set_eb(base)
    buf = list(data) + [0xf7]
    for i, b in enumerate(buf):
        c.x.ram[0x3c00 + i] = b
    # the rest of the page as the end of earlier messages: a malformed message makes some parsers scan on
    # over zero bytes (2C64) and would wrap around the page for ever
    for i in range(len(buf), 256):
        c.x.ram[0x3c00 + i] = 0xf7
    c.ram[0x3f] = 0
    c.ram[0x3e] = len(buf)
    c.ram[0x42] = 0
    cmp = []
    last = [None]
    orig = c.step
    if trace:
        def st():
            pc = c.pc
            op = c.c[pc]
            if op in (0xe2, 0xe3) and c.ram[0xa0] == 0x3c:
                last[0] = c.r(op - 0xe2)
            elif op == 0xb4 and last[0] is not None:
                cmp.append((last[0], c.c[pc + 1]))
            orig()
        c.step = st
    try:
        c.pc = 0x1fee
        run_until(c, STOP03, 300000)   # stop before the DSP update (3982) / page display (1152)
    except RuntimeError:
        return base, cmp
    finally:
        c.step = orig
    return u.eb(), cmp


def explore03(u, base):
    paths = []

    def cands(prefix):
        S = {0, 0x7e}
        done = set()
        while S - done:
            v = min(S - done)
            done.add(v)
            _, cmp = run03(u, list(prefix) + [v] + [0] * (5 - len(prefix)), base, True)
            for p, cv in cmp:
                if p == len(prefix) and cv < 0x7f:
                    S.add(cv)
        return sorted(done - {0x7e})

    def rec(prefix):
        if len(prefix) == 3:
            paths.append(tuple(prefix))
            return
        for cv in cands(prefix):
            rec(prefix + [cv])
    rec([])
    return paths


def enc_bytes(enc, v):
    if enc == 2:
        return [(v >> 7) & 0x7f, v & 0x7f]
    if enc == 3:  # controller: 128 (OFF) as 7F
        return [0x7f if v >= 0x7f else v]
    if enc == 5:  # sign-magnitude byte (bit 7 = +) as 14 bits centred on 2000h
        w = 0x2000 + ((v & 0x7f) if v & 0x80 else -v)
        return [(w >> 7) & 0x7f, w & 0x7f]
    return [v & 0x7f]


def match03(u, alg, base0, pages):
    """For each page, the 03 path and value encoding that stores its values the way the page does."""
    paths = explore03(u, base0)
    touch = {}
    for p in paths:
        t = set()
        for probe in ([5, 5, 5], [10, 10, 10], [0x41, 0x41, 0x41], [0x40, 5, 5], [0x3f, 0x70, 5], [1, 5, 5], [0, 5, 5], [2, 2, 2], [3, 3, 3]):
            got, _ = run03(u, list(p) + probe, base0)
            t.update(i for i in range(64) if got[i] != base0[i])
        touch[p] = t
    res = {}
    for pg in pages:
        f = pg['field']
        if not f or pg['kind'] == 'ctrl':
            continue
        base = pg['seq'][0][0]
        want = pg['seq']
        span = set(range(f['off'], f['off'] + f['size']))
        for p in [q for q in paths if touch[q] & span]:
            for enc in (1, 2, 3, 5):
                ok = True
                for k in sorted({0, len(want) // 3, len(want) // 2, len(want) - 1, 1 % len(want)}):
                    target_eb = want[k][0]
                    v = f['raw'][k]
                    extra = []
                    if pg['kind'] == 'cc':
                        extra = [base[60 + (pg['n_ctrl'] - 1)]]
                    got, _ = run03(u, list(p) + enc_bytes(enc, v) + extra, base)
                    seen = [i for i in range(64) if got[i] != base[i] or target_eb[i] != base[i]]
                    if any(got[i] != target_eb[i] for i in seen if i in range(f['off'], f['off'] + f['size'])) or \
                       any(got[i] != base[i] for i in seen if i not in range(f['off'], f['off'] + f['size'])):
                        ok = False
                        break
                if ok:
                    res[pg['n']] = [p[0], p[1], p[2], enc]
                    break
            if pg['n'] in res:
                break
        if pg['n'] in res:
            continue
        # values the parser converts from 0-127 (its own scale): the raw value each message value stores
        rawset = set(f['raw'])
        for p in [q for q in paths if touch[q] & span]:
            table = []
            for v in range(128):
                got, _ = run03(u, list(p) + [v], base)
                if any(got[i] != base[i] for i in range(64) if i not in span):
                    table = None
                    break
                w = 0
                for i in range(f['off'], f['off'] + f['size']):
                    w = (w << 8) | got[i]
                table.append((w >> (f['shift'] or 0)) & ((1 << (f['bits'] or 8 * f['size'])) - 1))
            if table and len(set(table) & rawset) > 1:
                res[pg['n']] = [p[0], p[1], p[2], 4, table]
                break
    return res, paths


# ------------------------------------------------------------------ DSP use of bytes no page edits
def dsp_log(u, b):
    u.rollback()
    u.set_eb(b)
    c = u.cpu
    c.x.dsp = []
    c.x.logging = True
    c.setbit(0x18, 1)
    c.ram[0x75] = 0
    try:
        u.run(0x3982, 3000000)
    except RuntimeError as e:
        c.x.dsp.append(('stuck', str(e)))
    finally:
        c.x.logging = False
    return c.x.dsp


def dsp_reads(u, alg, base, offs):
    u.load(alg)
    u.checkpoint()
    ref = dsp_log(u, base)
    if dsp_log(u, base) != ref:
        log('  alg %d: the DSP update is not repeatable' % alg)
        return None
    used = []
    for o in offs:
        for v in (0x00, 0x40, 0x7f, base[o] ^ 0x01):
            if v == base[o]:
                continue
            b = bytearray(base)
            b[o] = v
            if dsp_log(u, bytes(b)) != ref:
                used.append(o)
                break
    return used


# ------------------------------------------------------------------ algorithms
def visible(u, state, n):
    u.set_eb(state)
    u.page(n)
    return u.cpu.ram[0x35] == n


def page_entry(u, n, state):
    u.set_eb(state)
    seq = u.walk(n)
    f = field_of(seq, seq[0][0])
    block, label, texts, screens = split_page(seq)
    kind = 'value'
    if f and f['off'] in (58, 59) and f['size'] == 1:
        kind = 'cc'
    elif f and f['off'] in (60, 61) and f['size'] == 1:
        kind = 'ctrl'
    pg = {'n': n, 'block': block, 'label': label, 'texts': texts, 'field': f, 'seq': seq, 'kind': kind,
          'screen': screens[0], 'base': state}
    if kind in ('cc', 'ctrl'):
        pg['n_ctrl'] = 1 + (f['off'] - (58 if kind == 'cc' else 60))
    return pg


def widen(pages):
    """A field whose bytes no other page uses takes the whole bytes (the walk only shows the bits its range
    reaches); fields sharing a byte keep the bits they change (flags, tap time + pan)."""
    users = {}
    for pg in pages:
        f = pg['field']
        if f:
            for i in range(f['off'], f['off'] + f['size']):
                users.setdefault(i, set()).add((f['off'], f['size'], f['bits'], f['shift']))
    for pg in pages:
        f = pg['field']
        if not f or not (f['bits'] or f['shift']):
            continue
        if all(len(users[i]) == 1 for i in range(f['off'], f['off'] + f['size'])):
            raw = []
            for b, _ in pg['seq']:
                w = 0
                for i in range(f['off'], f['off'] + f['size']):
                    w = (w << 8) | b[i]
                raw.append(w)
            f.update({'bits': None, 'shift': None, 'raw': raw})


def algorithm(u, alg):
    base = u.load(alg)
    npg = u.cpu.ram[0x3a]
    rec = u.rom_record(alg)
    found = {}
    hidden = []
    assigned = bytearray(base)
    assigned[58] = assigned[59] = 1      # MIDI CTRL target pages show only while a controller is assigned
    assigned = bytes(assigned)
    for n in range(1, npg + 1):
        for st in (base, assigned):
            if visible(u, st, n):
                found[n] = page_entry(u, n, st)
                break
        else:
            hidden.append(n)
    # pages other values hide (blocks switched off, modes): try the states the option-like pages step through
    if hidden:
        states = []
        for pg in found.values():
            if pg['kind'] == 'value' and len(pg['seq']) <= 32:
                states += [b for b, _ in pg['seq']]
        for n in hidden:
            for st in states:
                if visible(u, st, n):
                    found[n] = page_entry(u, n, st)
                    why = [i for i in range(64) if st[i] != base[i]]
                    found[n]['when'] = [[i, st[i]] for i in why]
                    break
            else:
                log('  alg %d page %d stays hidden' % (alg, n))
    pages = [found[n] for n in sorted(found)]
    widen(pages)
    msgs, paths = match03(u, alg, base, pages)
    covered = set()
    for pg in pages:
        f = pg['field']
        if f:
            covered.update(range(f['off'], f['off'] + f['size']))
    free = [o for o in range(17, 55) if o not in covered]
    used = dsp_reads(u, alg, base, free)
    name = lcd_text(rec[16:32]).strip()
    out = {
        'name': name, 'title': lcd_text(rec[4:16]).rstrip(), 'pages': [], 'pageCount': npg,
        'dsp': used, 'unused': [o for o in free if o not in (used or [])],
        'paths': [list(p) for p in paths],
    }
    for pg in pages:
        f = pg['field']
        e = {'n': pg['n'], 'block': pg['block'], 'label': pg['label']}
        if pg.get('when'):
            e['when'] = pg['when']
        if f:
            e.update({'off': f['off'], 'size': f['size']})
            if f['bits']:
                e['bits'] = f['bits']
            if f['shift']:
                e['shift'] = f['shift']
            e['v'] = runs(f['raw'])
        e['t'] = compress(pg['texts'])
        if pg['kind'] != 'value':
            e['kind'] = pg['kind']
        if pg['n'] in msgs:
            e['msg'] = msgs[pg['n']]
        out['pages'].append(e)
        # check the compression
        dec = []
        for cnt, tm, fl in e['t']:
            dec += [render(tm, fl, k) for k in range(cnt)]
        assert dec == pg['texts'], (alg, pg['n'])
    miss = [pg['n'] for pg in pages if pg['field'] and pg['kind'] != 'ctrl' and pg['n'] not in msgs]
    if miss:
        log('  alg %d: no 03 path for pages %s' % (alg, miss))
    return out


def field_raw(e, b):
    w = 0
    for i in range(e['off'], e['off'] + e['size']):
        w = (w << 8) | b[i]
    return (w >> e.get('shift', 0)) & ((1 << e.get('bits', 8 * e['size'])) - 1)


def postprocess(u, alg, out):
    """'when' as [page, value] of the page that shows it; one-byte fields whose display also reads the free
    byte before them (PRE DELAY 37 with 36: 1 there shows 276ms) become two-byte fields."""
    base = u.load(alg)
    pages = out['pages']
    for e in pages:
        w = e.get('when')
        if w and isinstance(w[0], list) and len(w[0]) == 2 and w[0][0] >= 17 and not e.get('whenPage'):
            st = bytearray(base)
            for o, v in w:
                st[o] = v
            for q in pages:
                if q is e or q.get('when') or 'off' not in q:
                    continue
                if field_raw(q, st) != field_raw(q, base) and any(q['off'] <= o < q['off'] + q['size'] for o, _ in w):
                    e['when'] = [q['n'], field_raw(q, st)]
                    e['whenPage'] = True
                    break
    for e in pages:
        e.pop('whenPage', None)
    covered = set()
    for e in pages:
        if 'off' in e:
            covered.update(range(e['off'], e['off'] + e['size']))
    for e in pages:
        o = e.get('off')
        if o is None or e.get('bits') or e.get('kind') or o - 1 < 17 or (o - 1) in covered:
            continue
        lcds = []
        for v in (0, 1):
            b = bytearray(base)
            b[o - 1] = v
            if e.get('when'):
                q = next(x for x in pages if x['n'] == e['when'][0])
                w = 0
                for i in range(q['off'], q['off'] + q['size']):
                    w = (w << 8) | b[i]
                mask = ((1 << q.get('bits', 8 * q['size'])) - 1) << q.get('shift', 0)
                w = (w & ~mask) | ((e['when'][1] << q.get('shift', 0)) & mask)
                for i in range(q['off'] + q['size'] - 1, q['off'] - 1, -1):
                    b[i] = w & 0xff
                    w >>= 8
            u.set_eb(bytes(b))
            lcds.append(u.page(e['n']))
        if lcds[0] != lcds[1]:
            e['off'] = o - 1
            e['size'] += 1
            covered.add(o - 1)
            out['dsp'] = [x for x in (out['dsp'] or []) if x != o - 1]
            out['unused'] = [x for x in out['unused'] if x != o - 1]
            log('  alg %d page %d: two bytes from %d' % (alg, e['n'], o - 1))
    return out


# ------------------------------------------------------------------ menu pages
def menus(u):
    u.load(0)
    c = u.cpu
    out = []
    for k in range(1, 17):
        c.ram[0x40] = (k - 1) & 0xff
        u.run(0x16a7)
        state = c.ram[0x42]
        screens = [lcd_text(u.lcd())]
        for _ in range(3):
            c.setbit(0x02, 1)
            c.setbit(0x05, 0)
            u.run(0x0ff8)
            s = lcd_text(u.lcd())
            if s not in screens:
                screens.append(s)
        out.append({'k': k, 'state': state, 'screens': screens})
    return out


def main():
    img = open(sys.argv[1], 'rb').read()
    out_path = sys.argv[2]
    args = sys.argv[3:]
    cache = None
    if args[:1] == ['--cache']:
        cache = args[1]
        os.makedirs(cache, exist_ok=True)
        args = args[2:]
    only = [int(x) for x in args] or list(range(NALG))
    u = Unit(img)
    t0 = time.time()
    algs = []
    for a in only:
        cf = cache and os.path.join(cache, 'alg%02d.json' % a)
        if cf and os.path.exists(cf):
            res = json.load(open(cf, encoding='utf-8'))
        else:
            log('algorithm %d' % a)
            res = algorithm(u, a)
            if cf:
                json.dump(res, open(cf, 'w', encoding='utf-8'))
            log('  %.0f s' % (time.time() - t0))
        algs.append(postprocess(u, a, res))
    roms = []
    for a in range(NALG):
        r = u.rom_record(a)
        roms.append({'line1': lcd_text(r[0:16]), 'line2': lcd_text(r[16:32]), 'data': r[32:80].hex(), 'pages': r[80]})
    users = [img[USER0 + 64 * i:USER0 + 64 * i + 64].hex() for i in range(NUSER)]
    settings = img[0x00e0:0x0120].hex()
    signature = img[0x00a0:0x00e0].hex()
    identity = []
    p = 0x0b7a
    while img[p] != 0xf7:
        identity.append(img[p])
        p += 1
    menu = menus(u)
    data = {
        'FIRMWARE': 'EFX-10 v1.02 (16/10/1995)', 'ALGOS': algs, 'ROM_PRESETS': roms, 'USER_PRESETS': users,
        'SETTINGS': settings, 'SIGNATURE': signature, 'IDENTITY': [0xf0] + identity + [0xf7], 'MENUS': menu,
    }
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Generated by tools/viscount/efx10_fw.py from the Viscount EFX-10 v1.02 EPROM (16/10/1995, 128 KB,\n')
        f.write('// 8051). Do not edit by hand: run the tool again.\n')
        f.write('// ALGOS[a]: algorithm a (preset byte 16): name and the ROM preset\'s title (records at 1D6A2, 81 bytes);\n')
        f.write('// pages: every edit page (handlers 116F) as the emulator showed it: block (LCD line 1), label, the bytes\n')
        f.write('// the page changes (off, size, bits, shift: big-endian), v = runs [first raw value, count] in the order\n')
        f.write('// the page steps through them, t = the display texts in the same order as segments [count, template,\n')
        f.write('// fields [start, step, width, decimals, plus (1: +n, 2: +0 too), zero-padded digits]]; when = [page,\n')
        f.write('// value]: the unit shows the page only while that page has that value; msg = the MIDI EDIT EXC. (03) section,\n')
        f.write('// index, parameter and value form: 1 one byte, 2 two 7-bit bytes, 3 controller (OFF as 7F), 4 one byte\n')
        f.write('// the parser converts (table: raw value stored for message values 0-127), 5 sign-magnitude byte (bit 7\n')
        f.write('// = +) as two 7-bit bytes around 2000h; dsp = bytes no page edits that the DSP update (3982) reads;\n')
        f.write('// unused = bytes neither touches; paths = every section / index / parameter the 03 parser takes.\n')
        f.write('// ROM_PRESETS: presets 001-027 (LCD lines, 48 data bytes from byte 16, page count); USER_PRESETS:\n')
        f.write('// what the init (032B) copies into 028-128; SETTINGS: 3FC0-3FFF defaults (code 00E0); SIGNATURE:\n')
        f.write('// 3F80-3FBF (code 00A0); IDENTITY: the identity reply (0B7A); MENUS: the menu pages (16A7).\n')
        for k, v in data.items():
            f.write('export const %s = %s;\n' % (k, json.dumps(v, ensure_ascii=False, separators=(',', ':'))))
    log('done in %.0f s' % (time.time() - t0))


if __name__ == '__main__':
    main()
