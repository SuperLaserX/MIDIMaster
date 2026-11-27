# Alesis Quadraverb 2 firmware tables for js/devices/defs/alesis-quadraverb2-fw.js.
# Runs the v2.01e EPROM (128 KB, 8031, two banks) in the 8051 emulator as the front panel drives it
# (tools/alesis/qv2_emu.py): every block type is set up on block 1 through the CONFIG pages (ENTER), then every
# EDIT page is shown and its display routine run for each value the encoder steps through; the parameter's
# place in the block data comes from the page set-up (XDATA 0065, 16-bit flag 21.6). The same for the MOD,
# GEN, MIX, routing, GLOBAL and MIDI pages. The 100 ROM presets are recalled and requested over SysEx (03 64);
# the SysEx formats and what CONFIG does to a program are checked in the emulator.
# Usage: python -I tools/alesis/qv2_fw.py <qv2 image> <out.js> --cache DIR [stage ...]
#        stages: blocks mods modes routes presets sysex config emit (all when none is named)
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qv2_emu import QV2  # noqa: E402
from qv2_survey import N_TYPES, setblock, walk, goto  # noqa: E402


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def jpage(pg):
    d = dict(pg)
    if 'screen' in d:
        d['screen'] = d['screen'].decode('latin1')
    if 'rec' in d:
        d['rec'] = d['rec'].hex()
    if 'lcds' in d:
        d['lcds'] = [x.decode('latin1') for x in d['lcds']]
    return d


# ------------------------------------------------------------------ survey stages (cached as JSON)
def survey_blocks(q, cache):
    out = {}
    for f in (1, 2, 3, 4):
        for t in range(N_TYPES[f]):
            fn = os.path.join(cache, 'type_%d_%02d.json' % (f, t))
            if os.path.exists(fn):
                out['%d.%d' % (f, t)] = json.load(open(fn))
                continue
            t0 = time.time()
            cfg = setblock(q, f, t)
            q.press('edit')
            pages = walk(q)
            packed = q.pack()
            r = {'f': f, 't': t, 'cfg': cfg, 'data': bytes(q.x[0x100:0x100 + 26]).hex(), 'packed': packed.hex(),
                 'pages': [jpage(p) for p in pages]}
            json.dump(r, open(fn, 'w'))
            out['%d.%d' % (f, t)] = r
            log('type', f, t, '%.0fs' % (time.time() - t0))
    return out


def load_preset(q, n):
    """Recall ROM preset n in PROG mode (encoder, ENTER)."""
    q.restore()
    goto(q, n)
    q.enter()
    q.settle()


def navigate(q, g, p, limit=80):
    """Press the cursor key until page p of group g is shown."""
    for _ in range(limit):
        u = q.ui()
        if u['g'] == g and u['p'] == p:
            return True
        q.press('right')
    raise RuntimeError('page %d/%d not reached' % (g, p))


def texts_of(q, rec, vals):
    st = q.save()
    out = [q.show(v & 0xffff).decode('latin1') for v in vals]
    q.restore(st)
    return out


def survey_mods(q, cache):
    """MOD pages: per block type the target list (TO parameter, stepped with the encoder), sources, amplitude."""
    fn = os.path.join(cache, 'mods.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    res = {'types': {}}
    for f in (1, 2, 3, 4):
        for t in range(N_TYPES[f]):
            setblock(q, f, t)
            q.press('mod')
            q.press('right')
            q.press('right')                 # MOD 1 TO: block 1, its parameter
            for _ in range(160):
                if q.x[0x51] == 0:
                    break
                q.turn(-1)
            seen = []
            for _ in range(200):
                v = q.x[0x51]
                seen.append([v, q.lcd()[15:].decode('latin1').rstrip()])
                q.turn(1)
                if q.x[0x51] == v:
                    break
            res['types']['%d.%d' % (f, t)] = seen
            log('mods', f, t, len(seen))
    # sources and amplitude, the block page (1-11) and the MIX target names, on preset 4 (eight blocks)
    load_preset(q, 4)
    q.press('mod')
    pages = walk(q)
    res['pages'] = [jpage(p) for p in pages if p['g'] < 3]
    q.press('right')
    for _ in range(12):
        q.turn(1)                            # TO block: MIX
    q.press('right')
    rec = q.record()
    res['mix'] = texts_of(q, rec, range(128, 146))
    q.press('left')
    q.turn(-1)                               # OUT R
    q.press('right')
    res['outR'] = texts_of(q, rec, range(64, 98))
    json.dump(res, open(fn, 'w'))
    return res


def survey_modes(q, cache):
    """GEN pages per generator type, the MIX, routing, GLOBAL, MIDI and NAME pages (preset 4: eight blocks)."""
    fn = os.path.join(cache, 'modes.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    res = {}
    gens = []
    for k in range(5):
        load_preset(q, 4)
        q.press('mod')
        navigate(q, 3, 1)                    # GEN 1 TYPE
        goto(q, k)
        q.enter()
        q.settle()
        q.press('mod')
        pages = [p for p in walk(q) if p['g'] >= 3]
        gens.append({'type': k, 'gen': bytes(q.x[0xa9:0xb3]).hex(), 'pages': [jpage(p) for p in pages]})
        log('gen', k, len(pages))
    res['gens'] = gens
    for mode in ('mix', 'routing', 'global', 'midi', 'name'):
        load_preset(q, 4)
        q.press(mode)
        res[mode] = [jpage(p) for p in walk(q)]
        log(mode, len(res[mode]))
    json.dump(res, open(fn, 'w'))
    return res


def survey_routes(q, cache):
    """Per block type on block 1: the source names of its four route columns (ADD ROUTE FROM)."""
    fn = os.path.join(cache, 'routes.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    res = {}
    for f in (1, 2, 3, 4):
        for t in range(N_TYPES[f]):
            setblock(q, f, t)
            q.press('routing')
            rec = q.record()
            names = [x[16:].rstrip() for x in texts_of(q, rec, range(34))]
            res['%d.%d' % (f, t)] = {'names': names}
            log('routes', f, t)
    json.dump(res, open(fn, 'w'))
    return res


def pack7(data):
    bits = ''.join('{:08b}'.format(b) for b in data)
    bits += '0' * (-len(bits) % 7)
    return [int(bits[i:i + 7], 2) for i in range(0, len(bits), 7)]


def unpack7(b7, n):
    bits = ''.join('{:07b}'.format(b) for b in b7)
    return bytes(int(bits[i:i + 8], 2) for i in range(0, n * 8, 8))


HEAD = [0xf0, 0x00, 0x00, 0x0e, 0x0f]


def survey_presets(q, cache):
    """The 100 ROM presets as the edit buffer dump (03 64) sends them after a recall."""
    fn = os.path.join(cache, 'presets.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    out = []
    for n in range(100):
        load_preset(q, n)
        q.capture()
        q.midi_in(HEAD + [0x03, 0x64, 0xf7])
        q.run(6)
        tx = q.tx
        assert tx[:7] == HEAD + [0x02, 0x64] and tx[-1] == 0xf7, tx[:8]
        prog = unpack7(tx[7:-1], 256)
        assert prog == q.pack()
        out.append(prog.hex())
        del q.cpu.hooks[0xbb94]
        log('preset', n, prog[:14])
    json.dump(out, open(fn, 'w'))
    return out


def check_sysex(q, cache):
    """The SysEx formats: global dump (07 / 08), program table (11 / 12), bypass (0F / 10), parameter edit (01)."""
    fn = os.path.join(cache, 'sysex.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    res = {}
    q.restore()
    q.capture()
    q.midi_in(HEAD + [0x08, 0xf7])
    q.run(6)
    res['global'] = q.tx[:]
    g = unpack7(q.tx[6:-1], 14)
    res['global_bytes'] = g.hex()
    res['xdata_f0'] = bytes(q.x[0xf0:0x100]).hex()
    # a changed global dump back in: which XDATA byte each of the 14 takes
    probe = {}
    for i in range(14):
        q.restore()
        b = bytearray(g)
        b[i] ^= 0x01
        q.midi_in(HEAD + [0x07] + pack7(bytes(b)) + [0xf7])
        q.run(6)
        base = bytes.fromhex(res['xdata_f0'])
        probe[i] = [hex(a) for a in range(0xf0, 0x100) if q.x[a] != base[a - 0xf0]]
    res['global_probe'] = probe
    q.restore()
    q.capture()
    q.midi_in(HEAD + [0x12, 0xf7])
    q.run(6)
    res['table'] = q.tx[:]
    q.restore()
    q.capture()
    q.midi_in(HEAD + [0x10, 0xf7])
    q.run(6)
    res['bypass'] = q.tx[:]
    # parameter edit: EDIT block 1 group 1 page 1 (DECAY of the boot program) to 7
    q.restore()
    q.midi_in(HEAD + [0x01, 0x00, 0x01, 0x01, 0x01] + pack7(bytes([7, 0])) + [0xf7])
    q.run(8)
    res['edit01'] = q.x[0x100]
    json.dump(res, open(fn, 'w'))
    return res


CONFIG_CASES = [(0, 0, 0x20), (0, 0, 0x41), (3, 1, 0x60), (3, 4, 0x00), (4, 6, 0x8d), (5, 1, 0x8a),
                (3, 0, 0x41), (3, 3, 0x61), (14, 0, 0x28), (3, 3, 0x86), (3, 0, 0x45)]


def check_config(q, cache):
    """What the CONFIG pages do to a program: preset, block, new function / type -> the packed program."""
    fn = os.path.join(cache, 'config.json')
    if os.path.exists(fn):
        return json.load(open(fn))
    out = []
    for n, k, cfg in CONFIG_CASES:
        load_preset(q, n)
        st = q.save()
        before = q.pack()            # a direct call: the panel state is put back before the keys
        q.restore(st)
        q.press('config')
        for _ in range(k):
            q.press('block')
        goto(q, cfg >> 5)
        q.enter()
        q.settle()
        if cfg:
            goto(q, cfg & 31)
            q.enter()
            q.settle()
        out.append({'preset': n, 'block': k, 'cfg': cfg, 'before': before.hex(), 'after': q.pack().hex()})
        log('config', n, k, hex(cfg))
    json.dump(out, open(fn, 'w'))
    return out


# ------------------------------------------------------------------ compact value texts (as tools/viscount/efx10_fw.py)
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
        if render(tm, fl, 0) != texts[i]:          # e.g. "User0-00": taken as it is
            tm, fl = texts[i].replace('{', '{{').replace('}', '}}'), []
        n = 1
        if not fl:
            while i + n < len(texts) and texts[i + n] == texts[i]:
                n += 1
        elif i + 1 < len(texts):
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


# ------------------------------------------------------------------ labels and value texts of a group's pages
def full_texts(pg):
    """The texts of every value of a page; a sampled page (qv2_survey SAMPLE_OVER) is extended over the whole
    range by the last template of its first thousand values and checked against every sampled value."""
    if 'sample' not in pg:
        return pg['lcds']
    idx, ls = pg['sample'], pg['lcds']
    n = len(range(pg['min'], pg['max'] + 1, pg['step'] or 1))
    if len(set(ls)) == 1:
        log('the same text for every value of', pg['screen'])
        return None
    seg = compress(ls[:1000])
    start = 1000 - seg[-1][0]                     # the last template of the first thousand runs on
    tm, fl = seg[-1][1], seg[-1][2]
    head = [render(t, f, k) for c, t, f in seg for k in range(c)]
    full = head[:start] + [render(tm, fl, i - start) for i in range(start, n)]
    for i, t in zip(idx, ls):
        if full[i] != t:
            # SAMPLING's MAXIMUM SAMPLE LENGTH / START / END show the sampler's state, not a function of the
            # value alone: these pages are typed in raw
            log('no single template for', pg['screen'], i, t, full[i])
            return None
    return full


def fields_of(pages):
    """Per page of one screen: (start, end) of the columns its values change (from the cursor column on)."""
    out = []
    for pg in pages:
        ls = pg.get('lcds') or []
        var = sorted({i for t in ls for i in range(32) if t[i] != ls[0][i]}) if ls else []   # (samples suffice)
        col = int(pg['rec'][:2], 16) if isinstance(pg['rec'], str) else pg['rec'][0]   # the cursor column
        out.append((min(var[0], col), var[-1]) if var else (col, col))
    return out


LCD = {0x7e: '→', 0x7f: '←'}       # the HD44780 arrows


def lcd_text(t):
    return ''.join(LCD.get(ord(c), c) for c in t)


def split_group(pages):
    """Label and value texts of each page of one screen (one group)."""
    fl = fields_of(pages)
    starts = sorted(set(a for a, _ in fl))
    res = []
    for k, pg in enumerate(pages):
        a, b = fl[k]
        nxt = min([x for x in starts if x > b] + [32])
        prev = max([fl[j][1] for j in range(len(pages)) if fl[j][1] < a] + [-1])
        scr = pg['screen']
        # the label: the text before the field, after the previous field's value and its unit
        # ("s  DAMPING HI:", ",R=", "mS MIX:DIRECT")
        seg = scr[prev + 1:a]
        if prev >= 0 and seg[:1] != ' ':
            m = re.match(r'^\S*\s+(.*)$', seg)
            seg = m.group(1) if m else seg.lstrip(',;')
        if '  ' in seg.strip():
            seg = seg.strip().split('  ')[-1]
        if seg.endswith(('-', '+')):
            a -= 1
            seg = seg[:-1]
        label = ' '.join(seg.split()).rstrip(':=').strip()

        # the value text runs on from its last changing column over a unit, up to two spaces, the next field's
        # label ("60 LO:", "1mS MIX:DIRECT", "+0dB L<") or the next field
        def cut(t):
            e = b + 1
            while e < nxt and not (t[e] == ' ' and (e + 1 >= 32 or t[e + 1] == ' ')) and t[e] != '|':
                if t[e] == ' ':
                    word = t[e + 1:].split(' ')[0]
                    if ':' in word or '=' in word or word.startswith('[') or e + 1 + len(word) >= nxt:
                        break
                e += 1
            return t[a:e].strip()
        pre = ''
        if label.endswith('/'):              # the note value "1/4": the "1/" before the field belongs to it
            pre, label = label.split()[-1], ''
        ft = full_texts(pg) if pg.get('lcds') else None
        res.append((lcd_text(label), [lcd_text(pre + cut(t)) for t in ft] if ft else [], (a, b)))
    return res


def type_size(code, f, t):
    """Block data bytes of a type, as the pack routine counts them (74C3): one per page, two for 16-bit pages."""
    w = lambda a: (code[a] << 8) | code[a + 1]
    d = w(w(0x2a67 + 2 * f) + 2 * t)
    ng = code[d]
    p = d + 1
    n = 0
    while True:
        b = code[p]
        p += 1
        n += bin(b & 0x7f).count('1')
        if not b & 0x80:
            break
    pages = 0
    for g in range(ng):
        title, pl = w(p + 4 * g), w(p + 4 * g + 2)
        pages += code[pl + 0x20 - code[title]]
    return n + pages, pages


def align_mods(pages, names):
    """Pair the type's MOD target names (in their order) with its pages (in page order): a monotonic
    alignment that maximises the words a page label shares with a name; stubs take the first names."""
    syn = {'L': 'LEFT', 'R': 'RIGHT', 'DLY': 'DELAY', 'FDBACK': 'FEEDBACK', 'FB': 'FEEDBACK', 'CHR': 'CHORUS'}
    words = lambda t: {syn.get(w, w) for w in re.findall(r'[A-Z]+', (t or '').upper())}
    n, m = len(pages), len(names)
    if n == m:
        return list(names)
    best = [[0.0] * (m + 1) for _ in range(n + 1)]
    take = [[False] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m, -1, -1):
            skip = best[i + 1][j] if m - j <= n - i - 1 or j == m else -1e9
            use = -1e9
            if j < m:
                pg = pages[i]
                lab = pg.get('label') if re.search(r'[A-Za-z]', pg.get('label') or '') else ''
                sc = 2.0 if pg.get('stub') else len(words(lab) & words(names[j])) or (0.5 if not lab else 0.1)
                use = sc + best[i + 1][j + 1]
            if use >= skip:
                best[i][j], take[i][j] = use, True
            else:
                best[i][j] = skip
    out, j = [None] * n, 0
    for i in range(n):
        if j < m and take[i][j]:
            out[i] = names[j]
            j += 1
    return out


def page_entries(pages, mods=None):
    """The JS page list of one mode: label, value texts (compressed) and place of every page."""
    out = []
    groups = {}
    for pg in pages:
        groups.setdefault(pg['g'], []).append(pg)
    o = 0
    for g in sorted(groups):
        real = [pg for pg in groups[g] if 'lcds' in pg or ('screen' in pg and 'stub' not in pg)]
        split = dict(zip([id(x) for x in real], split_group(real))) if real else {}
        for pg in groups[g]:
            e = {'o': o, 'g': pg['g'], 'p': pg['p'], 'off': pg['addr'], 'w': pg.get('w16', 0), 'min': pg['min'],
                 'max': pg['max'], 'step': pg['step'], 'def': pg['def']}
            if 'stub' in pg:
                e['stub'] = 1
            elif id(pg) in split:
                label, texts, (a, b) = split[id(pg)]
                e['label'] = label
                e['screen'] = lcd_text(pg['screen'])
                e['col'] = a
                if texts:
                    e['t'] = compress(texts)
                elif pg.get('lcds'):
                    e['raw'] = 1                    # no text for every value (see full_texts)
            out.append(e)
            o += 1
    if mods:
        for e, name in zip(out, align_mods(out, mods)):
            if name:
                e['mod'] = name
    for g in sorted(groups):            # labels the screen leaves out: the MOD name, else the group's first label
        es = [e for e in out if e['g'] == g and not e.get('stub')]
        first = next((e['label'] for e in es if re.search(r'[A-Za-z]', e.get('label', ''))), '')
        for k, e in enumerate(es):
            if 'label' in e and not re.search(r'[A-Za-z]', e['label']):
                e['label'] = ' '.join(e['mod'].split()) if e.get('mod') else ('%s (%d)' % (first, k + 1) if first else e['label'])
    return out


TYPE_NAMES = {1: (0xe2bf, 22), 2: (0xe462, 19), 3: (0xe55a, 20), 4: (0xe5e7, 11)}   # hi bank, the TYPE page texts


def emit(img, out, blocks, mods, modes, routes, presets, sx, config):
    code = img[:0x10000]
    hi = img[0x10000:]
    types = []
    for f in (1, 2, 3, 4):
        a, w = TYPE_NAMES[f]
        for t in range(N_TYPES[f]):
            key = '%d.%d' % (f, t)
            r = blocks[key]
            size, npages = type_size(code, f, t)
            own = [n for v, n in mods['types'][key] if v < 64]
            idx = [v for v, n in mods['types'][key] if v < 64]
            assert idx == list(range(len(idx))), (key, idx)
            pages = page_entries(r['pages'], own)
            assert len(pages) == npages, (key, len(pages), npages)
            assert sum(1 for p in pages if 'mod' in p) == len(own), (key, own)
            last = max(p['off'] + (2 if p['w'] else 1) for p in pages)
            assert last == size, (key, last, size)
            rt = routes[key]
            types.append({'f': f, 't': t, 'cfg': (f << 5) | t, 'name': hi[a + w * t:a + w * t + w].decode('latin1').strip(),
                          'size': size, 'def': r['data'][:2 * size], 'mods': own,
                          'outs': [n.split()[-1] for n in rt['names'][2:6]], 'pages': pages})
    mp = mods['pages']
    src = next(p for p in mp if p['g'] == 1 and p['p'] == 1)
    amp = next(p for p in mp if p['g'] == 2 and p['p'] == 1)
    blk = next(p for p in mp if p['g'] == 0 and p['p'] == 1)
    gens = []
    gen_types = [x[12:].strip() for x in next(p for p in modes['gens'][0]['pages'] if p['addr'] == 0xa9)['lcds']]
    for k, gdef in enumerate(modes['gens']):
        pages = [p for p in gdef['pages'] if p['p'] >= 1 and 'past last' not in p['screen']]
        ents = page_entries(pages)
        for e in ents:
            e['off'] -= 0xa9
            e['label'] = re.sub(r'^GEN \d ', '', e.get('label', ''))
        gens.append({'name': gen_types[k], 'def': gdef['gen'], 'pages': ents})
    js = ['// Generated by tools/alesis/qv2_fw.py from the Alesis Quadraverb 2 v2.01e EPROM (Alesis_QV2_v2.01e_D9AB.bin).',
          '// Do not edit: rerun the generator. See docs/devices/alesis-quadraverb2.md.', '']

    def put(name, v):
        js.append('export const %s = %s;' % (name, json.dumps(v, separators=(',', ':'), ensure_ascii=False)))
    put('FIRMWARE', 'v2.01e (128 KB EPROM, Alesis_QV2_v2.01e_D9AB.bin)')
    put('TYPES', types)
    put('MOD_SOURCES', [x[15:].strip() for x in src['lcds']])
    put('MOD_BLOCKS', [x[9:14].strip().rstrip(' -') for x in blk['lcds']])
    put('MOD_AMOUNT', {'min': amp['min'], 'max': amp['max'], 't': compress([x[17:].strip() for x in amp['lcds']])})
    put('MIX_TARGETS', [x[15:].strip() for x in mods['mix']])
    put('GENS', gens)
    lev = next(p for p in modes['routing'] if p['g'] == 1 and p['p'] == 1)
    put('ROUTE_LEVELS', [x[24:].strip() for x in lev['lcds']])
    put('MIX_PAGES', page_entries(modes['mix']))
    put('GLOBAL_PAGES', page_entries(modes['global']))
    put('MIDI_PAGES', page_entries(modes['midi']))
    put('PRESETS', [p[:2 * (len(bytes.fromhex(p).rstrip(bytes(1))))] for p in presets])
    put('CHECKS', {'global': sx['global_bytes'], 'globalMsg': sx['global'], 'tableMsg': sx['table'][:12],
                   'edit01': [0xf0, 0, 0, 0x0e, 0x0f, 0x01, 0x00, 0x01, 0x01, 0x01] + pack7(bytes([7, 0])) + [0xf7],
                   'edit01Result': sx['edit01'], 'config': config})
    open(out, 'w', encoding='utf-8').write(chr(10).join(js) + chr(10))
    log('wrote', out, sum(len(x) for x in js))


def main():
    img = open(sys.argv[1], 'rb').read()
    args = sys.argv[3:]
    cache = args[args.index('--cache') + 1]
    os.makedirs(cache, exist_ok=True)
    q = QV2(img, cache=os.path.join(cache, 'boot.pkl'))
    stages = [a for a in args if not a.startswith('--') and a != cache]
    if not stages or 'blocks' in stages:
        survey_blocks(q, cache)
    if not stages or 'mods' in stages:
        survey_mods(q, cache)
    if not stages or 'modes' in stages:
        survey_modes(q, cache)
    if not stages or 'routes' in stages:
        survey_routes(q, cache)
    if not stages or 'presets' in stages:
        survey_presets(q, cache)
    if not stages or 'sysex' in stages:
        check_sysex(q, cache)
    if not stages or 'config' in stages:
        check_config(q, cache)
    if not stages or 'emit' in stages:
        emit(img, sys.argv[2], survey_blocks(q, cache), survey_mods(q, cache), survey_modes(q, cache),
             survey_routes(q, cache), survey_presets(q, cache), check_sysex(q, cache), check_config(q, cache))


if __name__ == '__main__':
    main()
