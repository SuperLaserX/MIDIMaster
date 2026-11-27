# Lexicon LXP-15 firmware tables for js/devices/defs/lexicon-lxp15-fw.js.
# Runs the v2.00 EPROM (64 KB, Z80, two 32 KB banks) in the emulator (tools/lexicon/lxp15_emu.py) from its
# system start and works the front panel: for every algorithm (byte 0 of the setup, 1-5) every PAGE position
# and soft button is pressed and ADJUST turned; the SysEx message each change sends (F0 06 06 2n pp vv F7 /
# 5n pp lo hi F7) names the parameter, both ends of its range are found by turning, and the text the unit
# shows for each value comes from the parameter's own display routine (the one the firmware keeps at A6ACh for
# the selected parameter, bank B), run for every value with the value put in the active setup (A180h + number)
# and checked against the panel for the first values. The panel-only pages (setup, SysEx transmit, program
# map, name, store) are stepped through value by value. The 128 ROM presets come from bank A (42DCh, 67 bytes
# each: what the unit copies into the registers on first power-up).
# Usage: python -I tools/lexicon/lxp15_fw.py <lxp15 v2 image> <out.js> --cache DIR [stage ...]
#        stages: boot params texts emit (all when none is named)
import hashlib
import json
import os
import pickle
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lxp15_emu import Emu, EDIT  # noqa: E402
from lxp15_survey import msgs, value_of, select, to_end  # noqa: E402

ALGS = [1, 2, 3, 4, 5]
ALG_PAGES = [1, 2, 3, 4, 5, 7, 8, 9, 10]   # pages whose buttons depend on the algorithm
SYS_PAGES = [0, 11, 12, 13, 14, 15]        # the same for every algorithm
SEL_ROUTINE = 0xA6AC                       # display routine of the parameter ADJUST works on (bank B)
VALUE_TEXT = 0xADC3 + 20                   # where the routine leaves the value text (adjust line, column 20)
PRESETS_AT = 0x42DC
PRESET_SIZE = 67


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ helpers
def alg_base(e, s0, a):
    """The boot state with algorithm a, set as a received parameter message sets it (screen unchanged)."""
    e.restore(s0)
    e.midi_in([0xF0, 6, 6, 0x20, 0, a, 0xF7], after=1_500_000)
    e.take_tx()
    return e.snap()


def sval(v, signed):
    return v - 16384 if signed and v >= 8192 else v


def call_display(e, routine, param):
    """Run display routine `routine` (bank B) for parameter `param`, as 1423 does. -> 40-char adjust line."""
    b, c = e.b, e.c
    keep = (list(c.r), c.f, c.ix, c.iy, c.sp, c.pc, c.iff, b.bank, c.i)
    b.bank = 1
    c.i = 0x40
    c.r[3] = param & 0xFF   # E
    c.r[2] = 0              # D
    c.r[5] = 0x3D           # L: the column 1423 passes
    c.r[4] = 0
    c.iff = 0
    c.call(routine, sp=0xBB00)
    (r, c.f, c.ix, c.iy, c.sp, c.pc, c.iff, b.bank, c.i) = keep
    c.r = list(r)
    return bytes(b.peek(0xADC3, 40)).decode('latin-1')


def put(e, p, form, v):
    if form == 2:
        e.poke(EDIT + p, bytes([v & 0x7F, (v >> 7) & 0x7F]))
    else:
        e.poke(EDIT + p, bytes([v & 0x7F]))


# ------------------------------------------------------------------ stage: parameters (panel)
def survey_button(e, base, pg, s, walk_all):
    before, sel = select(e, base, pg, s)
    r = {'page': pg, 'soft': s, 'names': before, 'selected': sel}
    slow = False

    def step(d):
        tx, sc = e.adj(d)
        if not msgs(tx):
            # busy (Size, a preset loading): the change may be sent later
            e.run(600_000)
            tx += bytes(e.take_tx())
            if msgs(tx):
                sc = e.screen()
        return tx, sc

    tx, sc = e.adj(+1)
    if not msgs(tx):
        # some changes (Size) are sent and shown only after the DSP has been set up again
        e.run(400_000)
        tx += bytes(e.take_tx())
        sc = e.screen()
        slow = bool(msgs(tx))
    if not msgs(tx):
        tx, sc = step(-1)
    m = msgs(tx)
    if not m:
        r['none'] = True
        r['screen'] = sc
        return r
    p, _, form = m[-1]
    routine = int.from_bytes(e.peek(SEL_ROUTINE, 2), 'little')
    r.update({'param': p, 'form': form, 'routine': routine, 'slow': slow, 'others': sorted({x[0] for x in m if x[0] != p}),
              'first': [value_of(tx, p), list(sc) if sc else None]})
    if slow:
        stop_lo = True
        while value_of(step(-1)[0], p) is not None:
            pass
    else:
        stop_lo = to_end(e, p, -1)
        e.run(600_000)
        e.take_tx()
    signed = not stop_lo and form == 2   # turns round through 0: a signed 14-bit value (the whole range)
    r['signed'] = signed
    if signed:
        r.update({'min': -8192, 'max': 8191, 'wrap': True})
        vals = []
        for d in (+1, -1):
            put(e, p, form, 0)
            for _ in range(12):
                t, scr = e.adj(d)
                v = value_of(t, p)
                if v is None:
                    break
                vals.append([sval(v, True), list(scr)])
        r['walk'] = vals
        return r
    tx1, sc1 = step(+1)
    tx2, sc2 = step(-1)
    v1, v2 = value_of(tx1, p), value_of(tx2, p)
    if v1 is None:
        r.update({'min': None, 'max': None, 'walk': []})
        return r
    vmin = v2 if v2 is not None else v1 - 1
    vals = [[vmin, list(sc2 or sc1)]]
    at_min = e.snap()
    if slow:
        stop_hi = True
        last = vmin
        while True:
            v = value_of(step(+1)[0], p)
            if v is None:
                break
            last = v
        vmax = last
    else:
        stop_hi = to_end(e, p, +1)
        e.run(600_000)
        e.take_tx()
        tx3, sc3 = step(-1)
        v3 = value_of(tx3, p)
        vmax = v3 + 1 if v3 is not None else vmin
    r.update({'min': vmin, 'max': vmax, 'stop': [stop_lo, stop_hi]})
    e.restore(at_min)
    limit = (vmax - vmin) if walk_all else min(8 if slow else 24, vmax - vmin)
    for _ in range(limit):
        t, scr = step(+1)
        v = value_of(t, p)
        if v is None:
            break
        vals.append([v, list(scr)])
    r['walk'] = vals
    return r


def stage_params(e, s0, cache):
    out = {}
    for a in ALGS:
        fn = os.path.join(cache, 'params_%d.json' % a)
        if os.path.exists(fn):
            out[a] = json.load(open(fn))
            continue
        t0 = time.time()
        base = alg_base(e, s0, a)
        res = {'pages': {}}
        e.restore(base)
        e.b.page = 6
        e.run(400_000)
        res['line1'] = e.screen()[0]
        for pg in (ALG_PAGES + SYS_PAGES if a == 1 else ALG_PAGES):
            e.restore(base)
            e.b.page = pg
            e.run(400_000)
            names = e.screen()
            items = []
            for s in range(5):
                nm = names[1][s * 8:s * 8 + 8] if pg != 13 else names[0][s * 8:s * 8 + 8]
                if nm.strip() in ('-', ''):
                    continue
                it = survey_button(e, base, pg, s, walk_all=pg in SYS_PAGES)
                it['name'] = nm
                items.append(it)
                log('  alg', a, 'page', pg, 'soft', s, repr(nm), it.get('param'), it.get('min'), it.get('max'), hex(it.get('routine', 0)))
            res['pages'][str(pg)] = {'names': names, 'items': items}
        json.dump(res, open(fn, 'w'))
        out[a] = res
        log('alg', a, '%.0fs' % (time.time() - t0))
    return out


# ------------------------------------------------------------------ stage: value texts (display routines)
def stage_texts(e, s0, params, cache):
    out = {}
    for a in sorted(params):
        fn = os.path.join(cache, 'texts2_%d.json' % a)
        if os.path.exists(fn):
            out[a] = json.load(open(fn))
            continue
        t0 = time.time()
        base = alg_base(e, s0, a)
        res = {}
        for pg, page in params[a]['pages'].items():
            if int(pg) not in ALG_PAGES and int(pg) != 11:
                continue
            for it in page['items']:
                if it.get('none') or it.get('min') is None:
                    continue
                p, form, routine = it['param'], it['form'], it['routine']
                e.restore(base)
                texts = []
                # 7-bit parameters: every byte value (the ROM presets keep some outside the panel's range)
                lo, hi = (it['min'], it['max']) if form == 2 else (0, 127)
                for v in range(lo, hi + 1):
                    put(e, p, form, v & 0x3FFF)
                    # the routine leaves at most 7 characters at column 20 of its buffer; the screen shows them at 21
                    texts.append(call_display(e, routine, p)[20:27].strip())
                # the panel's own screens for the values it stepped through must agree
                bad = [[v, scr[1][20:28], texts[v - lo]] for v, scr in it['walk'] if scr and scr[1][20:28].strip() != texts[v - lo]]
                how = 'routine'
                if bad and form == 1:
                    # this routine does not read the value from the active setup (LFO Rate): step the panel instead,
                    # each value reached from its neighbour
                    texts = [None] * 128
                    select(e, base, int(pg), it['soft'])
                    for v in range(128):
                        put(e, p, 1, v - 1 if v else 1)
                        t, scr = e.adj(+1 if v else -1)
                        if value_of(t, p) == v and scr:
                            texts[v] = scr[1][20:28].strip()
                    bad = [[v, scr[1][20:28], texts[v]] for v, scr in it['walk'] if scr and scr[1][20:28].strip() != texts[v]]
                    how = 'panel'
                res['%s:%d' % (pg, it['soft'])] = {'texts': texts, 'from': lo, 'bad': bad, 'how': how}
                log('  texts alg', a, 'page', pg, 'soft', it['soft'], len(texts), how, 'mismatches', len(bad), bad[:2])
        json.dump(res, open(fn, 'w'))
        out[a] = res
        log('texts alg', a, '%.0fs' % (time.time() - t0))
    return out


# ------------------------------------------------------------------ stage: program map (PgmChg = Map n)
def stage_map(e, s0, cache):
    """MapVal (parameter 94) as the unit shows it while PgmChg (96) names a map entry, and where the value
    lands in the map (A253h, the 256 bytes the 7n dump carries)."""
    fn = os.path.join(cache, 'map.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    t0 = time.time()
    res = {}
    for entry in (1, 2, 128):
        e.restore(s0)
        e.midi_in([0xF0, 6, 6, 0x50, 96, (entry + 2) & 0x7F, (entry + 2) >> 7, 0xF7], after=1_500_000)
        e.b.page = 13
        e.run(400_000)
        before, sel = select(e, e.snap(), 13, 1)
        m0 = bytes(e.peek(0xA253, 256))
        walk = []
        put(e, 94, 2, 0)
        tx, sc = e.adj(+1)
        tx2, sc2 = e.adj(-1)
        walk.append([value_of(tx2, 94), list(sc2) if sc2 else None, bytes(e.peek(0xA253, 256)).hex()])
        while True:
            tx, sc = e.adj(+1)
            v = value_of(tx, 94)
            if v is None:
                break
            walk.append([v, list(sc), bytes(e.peek(0xA253, 256)).hex() if v in (1, 2, 129, 130, 256) else None])
        res[str(entry)] = {'before': before, 'selected': sel, 'map0': m0.hex(), 'walk': walk}
        log('map entry', entry, len(walk), '%.0fs' % (time.time() - t0))
    json.dump(res, open(fn, 'w'))
    return res


# ------------------------------------------------------------------ stage: the settings pages again
def stage_sys(e, s0, cache):
    """PAGE 0, 12-15 for every button (patience for the loads and DSP set-ups some changes start); Mode on
    PAGE 13 with a global patch source chosen (with Source Off it has one value)."""
    fn = os.path.join(cache, 'sys.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    t0 = time.time()
    res = {}
    base = alg_base(e, s0, 1)
    for pg in (0, 12, 13, 14, 15):
        e.restore(base)
        e.b.page = pg
        e.run(400_000)
        names = e.screen()
        items = []
        for s in range(5):
            nm = names[1][s * 8:s * 8 + 8] if pg != 13 else names[0][s * 8:s * 8 + 8]
            if nm.strip() in ('-', ''):
                continue
            it = survey_button(e, base, pg, s, walk_all=True)
            it['name'] = nm
            items.append(it)
            log('  sys page', pg, 'soft', s, repr(nm), it.get('param'), it.get('min'), it.get('max'), len(it.get('walk', [])))
        res[str(pg)] = {'names': names, 'items': items}
    e.restore(base)
    e.midi_in([0xF0, 6, 6, 0x20, 85, 1, 0xF7], after=1_500_000)
    with_src = e.snap()
    it = survey_button(e, with_src, 13, 4, walk_all=True)
    it['name'] = names[0][32:40]
    it['with'] = 'Source = 1'
    res['13mode'] = it
    log('  sys mode with a source', it.get('min'), it.get('max'), '%.0fs' % (time.time() - t0))
    json.dump(res, open(fn, 'w'))
    return res


# ------------------------------------------------------------------ stage: message vectors for the tests
def stage_vectors(e, s0, out):
    """Replies to every request in the first power-up state, and what the receiver does with dumps."""
    def ask(msg, after=3_000_000):
        e.restore(s0)
        e.take_tx()
        e.midi_in(msg, after=after)
        return e.drain()
    v = {
        'setup': ask([0xF0, 6, 6, 0x30, 0x60, 0xF7]).hex(),
        'register0': ask([0xF0, 6, 6, 0x30, 0x61, 0, 0xF7]).hex(),
        'register127': ask([0xF0, 6, 6, 0x30, 0x61, 127, 0xF7]).hex(),
        'map': ask([0xF0, 6, 6, 0x30, 0x66, 0xF7]).hex(),
        'param12': ask([0xF0, 6, 6, 0x30, 0x62, 12, 0xF7]).hex(),
        'param4w': ask([0xF0, 6, 6, 0x30, 0x65, 4, 0xF7]).hex(),
        'other_channel': ask([0xF0, 6, 6, 0x31, 0x60, 0xF7]).hex(),
    }
    allr = ask([0xF0, 6, 6, 0x30, 0x64, 0xF7], after=30_000_000)
    v['all_len'] = len(allr)
    v['all_sha1'] = hashlib.sha1(allr).hexdigest()
    # receiving: a register dump into register 5 (Memory Protect Off), the setup dumps (7D refused, 81 taken)
    reg = bytearray(s0['ram'][0x8000 - 0x8000 + 0 * 67:67])
    reg[55:67] = b'VECTOR TEST '
    d = list(reg)
    msg = [0xF0, 6, 6, 0x10, 5, 0x43] + d + [sum(d) & 0x7F, 0xF7]
    e.restore(s0)
    e.midi_in(msg, after=3_000_000)
    v['reg_rx_ok'] = bytes(e.peek(0x8000 + 5 * 67, 67)) == bytes(reg)
    e.midi_in([0xF0, 6, 6, 0x20, 82, 1, 0xF7], after=1_000_000)   # Memory Protect On
    reg2 = bytearray(reg)
    reg2[55:67] = b'PROTECTED   '
    d2 = list(reg2)
    e.midi_in([0xF0, 6, 6, 0x10, 6, 0x43] + d2 + [sum(d2) & 0x7F, 0xF7], after=3_000_000)
    v['reg_rx_protected_kept'] = bytes(e.peek(0x8000 + 6 * 67, 67)) != bytes(reg2)
    setup = bytearray(s0['ram'][0xA180 - 0x8000:0xA180 - 0x8000 + 129])
    setup[55:67] = b'SETUP TEST  '
    for count in (0x7D, 0x81):
        e.restore(s0)
        dd = list(setup[:count])
        e.midi_in([0xF0, 6, 6, 0x00, count] + dd + [sum(dd) & 0x7F, 0xF7], after=3_000_000)
        v['setup_rx_%02x' % count] = bytes(e.peek(0xA180 + 55, 12)).decode('latin-1')
    # store (6n 70) and load (6n 71)
    e.restore(s0)
    e.midi_in([0xF0, 6, 6, 0x20, 12, 3, 0xF7], after=1_000_000)
    e.midi_in([0xF0, 6, 6, 0x60, 0x70, 9, 0xF7], after=3_000_000)
    v['store_reg9_byte12'] = e.peek(0x8000 + 9 * 67 + 12, 1)[0]
    e.midi_in([0xF0, 6, 6, 0x60, 0x71, 20, 0xF7], after=3_000_000)
    v['load_reg20_name'] = bytes(e.peek(0xA180 + 55, 12)).decode('latin-1')
    json.dump(v, open(out, 'w'), indent=1)
    log('vectors', out)
    return v


# ------------------------------------------------------------------ stage: every value of the 7-bit parameters
def stage_walk7(e, s0, params, cache):
    """The values ADJUST really reaches for each 7-bit parameter (some lists end with a jump to 127: an unused
    patch Src / Dest), stepped one detent at a time from the bottom."""
    out = {}
    for a in sorted(params):
        fn = os.path.join(cache, 'walk7_%d.json' % a)
        if os.path.exists(fn):
            out[a] = json.load(open(fn))
            continue
        t0 = time.time()
        base = alg_base(e, s0, a)
        res = {}
        for pg in ALG_PAGES:
            for it in params[a]['pages'][str(pg)]['items']:
                if it.get('none') or it.get('form') != 1 or it.get('min') is None:
                    continue
                p = it['param']
                select(e, base, pg, it['soft'])
                put(e, p, 1, it['min'])
                tx, sc = e.adj(+1)
                tx2, sc2 = e.adj(-1)
                v0 = value_of(tx2, p)
                vals = [v0 if v0 is not None else it['min']]
                while len(vals) < 140:
                    tx, sc = e.adj(+1)
                    v = value_of(tx, p)
                    if v is None:
                        e.run(600_000)
                        v = value_of(bytes(e.take_tx()), p)
                        if v is None:
                            break
                    vals.append(v)
                res['%d:%d' % (pg, it['soft'])] = vals
                log('  walk7 alg', a, 'page', pg, 'soft', it['soft'], vals[0], vals[-1], len(vals))
        json.dump(res, open(fn, 'w'))
        out[a] = res
        log('walk7 alg', a, '%.0fs' % (time.time() - t0))
    return out


def stage_boot(img, cache):
    fn = os.path.join(cache, 'boot.pkl')
    e = Emu(img)
    if os.path.exists(fn):
        e.restore(pickle.load(open(fn, 'rb')))
        return e, e.snap()
    e.boot(4_000_000)
    s0 = e.snap()
    pickle.dump(s0, open(fn, 'wb'))
    return e, s0


# ------------------------------------------------------------------ compact text tables
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
        width = len(m.group(0))
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


RUN_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'


def encode_table(texts):
    """{d: distinct texts in order (compressed), r: run lengths (one character each, 1-61; longer runs split)}
    or {t: compressed texts} when every value has its own text."""
    runs = []
    for t in texts:
        if runs and runs[-1][0] == t and runs[-1][1] < 61:
            runs[-1][1] += 1
        else:
            runs.append([t, 1])
    if len(runs) == len(texts):
        return {'t': compress(texts)}
    return {'d': compress([r[0] for r in runs]), 'r': ''.join(RUN_CHARS[r[1]] for r in runs)}


def decode_table(enc):
    def expand(segs):
        return [render(tm, fl, i) for n, tm, fl in segs for i in range(n)]
    if 't' in enc:
        return expand(enc['t'])
    d = expand(enc['d'])
    out = []
    for t, ch in zip(d, enc['r']):
        out.extend([t] * RUN_CHARS.index(ch))
    return out


# ------------------------------------------------------------------ emit
def cg(s):
    """Screen text with the LCD's own characters 0B-0D (selection marks) blanked."""
    return ''.join(' ' if ord(c) < 32 else c for c in s)


def routine_of(pr, key):
    pg, soft = key.split(':')
    return next((it.get('routine') for it in pr['pages'][pg]['items'] if str(it['soft']) == soft), None)


def emit(img, params, texts, pmap, psys, walk7, s0, out_js):
    tables = {}       # sha -> encoded table
    table_ids = []

    def table(tx):
        h = hashlib.sha1('\n'.join(tx).encode('latin-1')).hexdigest()[:12]
        if h not in tables:
            enc = encode_table(tx)
            assert decode_table(enc) == tx
            tables[h] = enc
            table_ids.append(h)
        return table_ids.index(h)

    def long_of(it):
        sc = it.get('first', [None, None])[1]
        return sc[1][8:20].strip() if sc else ''

    def with_table(x, tx):
        # a signed walk starts by putting 0 in the setup: its first screen may still show the earlier value
        bad = [b for b in tx['bad'] if not (x.get('signed') and b[0] == 0)]
        assert not bad, (x, bad[:3])
        x['t'] = table([(s or '').strip() for s in tx['texts']])
        if tx.get('from', x['min']) != x['min']:
            x['tmin'] = tx['from']
        return x

    # panel-stepped tables (LFO Rate) with a value the walk missed in a busy spell: the same button of another
    # algorithm, when every value both have agrees
    for a in ALGS:
        for key, tx in texts[a].items():
            if tx.get('how') != 'panel' or all(tx['texts']):
                continue
            for b in ALGS:
                other = texts[b].get(key)
                if b == a or not other or other.get('how') != 'panel' or len(other['texts']) != len(tx['texts']):
                    continue
                if all(x == y for x, y in zip(tx['texts'], other['texts']) if x and y):
                    tx['texts'] = [x or y for x, y in zip(tx['texts'], other['texts'])]
            assert all(tx['texts']), (a, key)
    algs = []
    for a in ALGS:
        pr = params[a]
        name = pr['line1'].split('alg:')[1].strip()
        pages = []
        for pg in ALG_PAGES:
            page = pr['pages'][str(pg)]
            items = []
            for it in page['items']:
                if it.get('none') or it.get('min') is None:
                    items.append({'soft': it['soft'], 'name': it['name'].strip(), 'none': True})
                    continue
                x = {'soft': it['soft'], 'name': it['name'].strip(), 'long': long_of(it), 'p': it['param'], 'form': it['form'],
                     'min': it['min'], 'max': it['max']}
                if it.get('signed'):
                    x['signed'] = 1
                vals = (walk7.get(a) or {}).get('%d:%d' % (pg, it['soft'])) if it['form'] == 1 else None
                if vals and vals == list(range(vals[0], vals[-1] + 1)) and vals[-1] < it['max']:
                    # the step-by-step walk stopped early (a busy spell): a list of the same routine that ends with
                    # a jump (patch Src / Dest), else the range turning to the ends found
                    ref = next((w for k, w in (walk7.get(a) or {}).items() if w != list(range(w[0], w[-1] + 1))
                                and routine_of(params[a], k) == it['routine']), None)
                    vals = ref if ref else list(range(vals[0], it['max'] + 1))
                if vals:
                    x['min'], x['max'] = vals[0], vals[-1]
                    if vals != list(range(vals[0], vals[-1] + 1)):
                        x['vals'] = vals
                tx = texts[a].get('%d:%d' % (pg, it['soft']))
                if tx:
                    with_table(x, tx)
                items.append(x)
            pages.append({'page': pg, 'names': [cg(page['names'][1])[i * 8:i * 8 + 8].strip() for i in range(5)], 'items': items})
        algs.append({'v': a, 'name': name, 'pages': pages})

    # settings pages: PAGE 11 from its display routines, the others from their screens
    def field(pg, it, scr):
        l1, l2 = cg(scr[0]), cg(scr[1])
        if pg == 13:
            t = l2[it['soft'] * 8:it['soft'] * 8 + 8].strip()
            # the last field is cut at the end of the line while it carries the selection marks
            return {'Delaye': 'Delayed'}.get(t, t)
        if pg == 0:
            m = re.match(r'\s*(Preset|Register)\s+(\d+)', l1)
            return '%s %s' % (m.group(1), m.group(2)) if m else None
        if pg == 12:
            t = l1.replace('SysEx Transmit', '').strip()
            m = re.match(r'Registr\s+(\d+)', t)
            return 'Registr %s' % m.group(1) if m else re.sub(r'\s+', ' ', t)
        if pg == 15:
            m = re.match(r'\s*Store into Register\s+(\d+)', l1)
            return 'Register %s' % m.group(1) if m else None
        if pg == 14:
            return None
        return None

    sys_pages = []
    pr = params[1]
    for pg in SYS_PAGES:
        page = psys[str(pg)] if pg != 11 else pr['pages']['11']
        items = []
        for it in page['items']:
            # the first survey stepped some buttons further (PgmChg): keep the longer walk
            old = next((o for o in pr['pages'][str(pg)]['items'] if o['soft'] == it['soft']), None)
            if old and len(old.get('walk') or []) > len(it.get('walk') or []):
                it = old
            x = {'soft': it['soft'], 'name': cg(it['name']).strip()}
            if it.get('none') or it.get('min') is None:
                x['none'] = True
                items.append(x)
                continue
            if pg == 13 and it['soft'] == 4 and psys.get('13mode', {}).get('max') is not None:
                it = dict(psys['13mode'], soft=4, name=it['name'])
                x['with'] = 'a global patch Source'
            x.update({'p': it['param'], 'form': it['form'], 'min': it['min'], 'max': it['max']})
            tx = texts[1].get('%d:%d' % (pg, it['soft'])) if pg == 11 else None
            if tx:
                with_table(x, tx)
                x['long'] = long_of(it)
            else:
                vals = [[v, field(pg, it, s)] for v, s in it['walk'] if s]
                seen = {}
                for v, t in vals:
                    seen.setdefault(v, t)
                if seen and all(seen.values()):
                    x['texts'] = sorted(seen.items())
                    x['min'], x['max'] = min(seen), max(seen)
            items.append(x)
        sys_pages.append({'page': pg, 'names': [cg(page['names'][0]), cg(page['names'][1])], 'items': items})

    # SysEx Transmit page: the name it gives each parameter number (algorithm 1)
    pnames = [None] * 127
    for it in psys['12']['items']:
        if it.get('param') == 86:
            for v, s in it['walk']:
                if s and v < 127:
                    t = cg(s[0]).replace('SysEx Transmit', '').strip()
                    t = re.sub(r'^Parameter\s+', '', t).strip()
                    pnames[v] = None if re.fullmatch(r'\d+', t) else t
    # program map values (MapVal while PgmChg names a map entry)
    w = pmap['2']['walk']
    mapvals = [cg(x[1][1])[8:16].strip() for x in w]
    assert len(mapvals) == 257 and mapvals[0].startswith('Reg') and mapvals[128].startswith('Pre') and mapvals[256] == 'OFF', mapvals[:3]
    setup0 = list(s0['ram'][0xA180 - 0x8000:0xA180 - 0x8000 + 129])
    presets = []
    for i in range(128):
        rec = img[PRESETS_AT + i * PRESET_SIZE:PRESETS_AT + (i + 1) * PRESET_SIZE]
        presets.append([rec[55:67].decode('latin-1'), rec.hex()])
    data = {'algs': algs, 'sys': sys_pages, 'tables': [tables[h] for h in table_ids], 'presets': presets}
    js = ['// Generated by tools/lexicon/lxp15_fw.py from the LXP-15 v2.00 EPROM: do not edit.',
          '// ALGS: per algorithm (setup byte 0) the PAGE 1-5 and 7-10 soft buttons: short name, long name (adjust',
          '// display), parameter number p (= setup byte; form 1: 2n p vv, form 2: 5n p lo hi, 7 bits each), panel range',
          '// and the index of its text table in TABLES (one text per value from tmin, else min). SYS: the setup, MIDI,',
          '// SysEx, program change, name and store pages. PRESETS: the 128 ROM presets [name, 67 bytes hex]. MAPVALS:',
          '// the program map values 0-256 as MapVal shows them. SETUP0: the active setup after the first power-up.',
          '// PARAM_NAMES: what the SysEx Transmit page calls parameters 0-126 (algorithm 1).',
          "export const FIRMWARE = 'LXP-15 v2.00 (\"Lexicon LXP-15  Version 2.00\", 1994; 64 KB EPROM, Z80)';",
          'export const ALGS = %s;' % json.dumps(data['algs'], separators=(',', ':')),
          'export const SYS = %s;' % json.dumps(data['sys'], separators=(',', ':')),
          'export const TABLES = %s;' % json.dumps(data['tables'], separators=(',', ':')),
          'export const PRESETS = %s;' % json.dumps(data['presets'], separators=(',', ':')),
          'export const MAPVALS = %s;' % json.dumps(mapvals, separators=(',', ':')),
          'export const SETUP0 = %s;' % json.dumps(setup0, separators=(',', ':')),
          'export const PARAM_NAMES = %s;' % json.dumps(pnames, separators=(',', ':')),
          '']
    open(out_js, 'w', encoding='utf-8', newline='\n').write('\n'.join(js))
    log('wrote', out_js, os.path.getsize(out_js), 'bytes;', len(tables), 'tables')


def main():
    img = open(sys.argv[1], 'rb').read()
    out_js = sys.argv[2]
    cache = sys.argv[sys.argv.index('--cache') + 1]
    stages = [s for s in sys.argv[3:] if not s.startswith('--') and s != cache] or ['boot', 'params', 'texts', 'emit']
    os.makedirs(cache, exist_ok=True)
    e, s0 = stage_boot(img, cache)
    if stages == ['map']:
        stage_map(e, s0, cache)
        return
    if stages == ['sys']:
        stage_sys(e, s0, cache)
        return
    if stages == ['vectors']:
        stage_vectors(e, s0, out_js)
        return
    if stages == ['texts']:
        stage_texts(e, s0, {a: json.load(open(os.path.join(cache, 'params_%d.json' % a))) for a in ALGS if os.path.exists(os.path.join(cache, 'params_%d.json' % a))}, cache)
        return
    if stages == ['walk7']:
        stage_walk7(e, s0, {a: json.load(open(os.path.join(cache, 'params_%d.json' % a))) for a in ALGS if os.path.exists(os.path.join(cache, 'params_%d.json' % a))}, cache)
        return
    params = stage_params(e, s0, cache) if any(s in stages for s in ('params', 'texts', 'emit')) else None
    texts = stage_texts(e, s0, params, cache) if any(s in stages for s in ('texts', 'emit')) else None
    pmap = stage_map(e, s0, cache) if any(s in stages for s in ('map', 'emit')) else None
    psys = stage_sys(e, s0, cache) if any(s in stages for s in ('sys', 'emit')) else None
    walk7 = stage_walk7(e, s0, params, cache) if 'emit' in stages else None
    if 'emit' in stages:
        emit(img, params, texts, pmap, psys, walk7, s0, out_js)


if __name__ == '__main__':
    main()
