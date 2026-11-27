"""Tables from the Virus TI2 host OS (re/virusti/fw/host/bankNN.bin, see docs/devices/access-virus-ti2.md,
"The OS's parameter tables") -> js/devices/defs/access-virus-ti2-os.js.

  bank 2 at 8701: for each internal parameter class (00-07) a count byte, then per parameter the MIDI
                  page (70 71 6E 6F A-D, 72 multi, 73 global, 74 internal) and index it lives at
                  (index bit 7: the host keeps it, it is not sent to the sound engine)
  bank 2 at 8000: page (6E-74) x index -> internal parameter (FFFF: none; parameter messages ignored)
  bank 1 at D720: per class a count byte, then each parameter's value list (a bank 4 list number)
  bank 4 at 8000: offsets of the display lists: count, then half-addresses of strings in banks 10-13
  bank 2 at 8D16: per class a count byte, then each parameter's reordering table (FF none; read by 630B/6336)
  bank 2 at 9025 + 100h x n: reordering table n, display position -> stored value (630B, used when a value
                  is set from the screen); at 90A5 + 100h x n the inverse (6336, used to show a value)
  bank 2 at BB6D: per class / parameter the address of its range routine (called through 578E from the
                  screen code at 0B75): R6 = first, R7 = last display position (R4/R5: the routine's own
                  numbers). Most are MOV R4/R5/R6/R7 + SETB C + RET; seven depend on other settings (below)

Virus Control's parameters (re/virusti/vc/ti.json, from tools/virus/vc_xml.py) are matched to the internal
parameter at their page and index; where several share a byte, by comparing the value texts.
usage: python -I tools/virus/os_tables.py [ti2|snow]   (snow -> access-virus-snow-os.js from re/virusti/fw/snowhost and
re/virus/snow/snow.json; its moved tables: VALUE_LISTS, RANGES and the routine addresses below; no PANEL_KNOBS)
"""
import json, os, re, sys
# the model's host OS banks (common F000 + bank F0nn of its image): ti2 (= the TI's, which differs in one byte), snow
MODEL = sys.argv[1] if len(sys.argv) > 1 else 'ti2'
HOST = {'ti2': 're/virusti/fw/host', 'snow': 're/virusti/fw/snowhost'}[MODEL]
VC = {'ti2': 're/virusti/vc/ti.json', 'snow': 're/virus/snow/snow.json'}[MODEL]
# where the model's host keeps the tables that moved (the Snow: re/virus/snow/p5/find_tbl.py, probe2.py; bank 2 8000 /
# 8701 / 8D16 / 9025 and the bank 1 knob ranges at 8000 are the same in both)
VALUE_LISTS = {'ti2': 0xd720, 'snow': 0xd19d}[MODEL]      # bank 1
RANGES = {'ti2': 0xbb6d, 'snow': 0xbb19}[MODEL]           # bank 2
GET_PARAM = {'ti2': bytes([0x08, 0x26]), 'snow': bytes([0x01, 0xc5])}[MODEL]  # the common-code routine that reads an internal parameter
BANK_COUNT = {'ti2': bytes([0x01, 0x2a]), 'snow': bytes([0x01, 0x80])}[MODEL]  # LCALL target reading G 68 (the number of ROM banks)
USB_BIT = {'ti2': 0x13, 'snow': 0x14}[MODEL]  # the bit the output range routines test first (no USB audio)
B = {n: open(os.path.join(HOST, f'bank{n:02d}.bin'), 'rb').read() for n in (1, 2, 4, 10, 11, 12, 13)}
D2 = B[2]
PAGE = {0x70: 0, 0x71: 1, 0x6e: 2, 0x6f: 3}
VC_PAGE = {'cc': 0x70, 'pp': 0x71, 'Bank A (70) Single-1': 0x70, 'Bank B (71) Single-2': 0x71, 'Bank C (6E) Single-3': 0x6e,
           'Bank D (6F) Single-4': 0x6f, 'Bank E (72) Multi': 0x72, 'Bank F (73) Global': 0x73}


def string(h):
    d, a = B[10 + (h >> 14)], 0x8000 + 2 * (h & 0x3fff)
    return d[a + 2:d.index(0, a + 2)].decode('latin1')


def lists():
    b4, out, p = B[4], [], 0x8000
    offs = []
    while True:
        o = (b4[p] << 8) | b4[p + 1]
        if offs and o <= offs[-1]: break
        offs.append(o); p += 2
    for o in offs:
        a = 0x8000 + o
        if a >= 0x10000: out.append([]); continue
        out.append([string((b4[a + 1 + 2 * k] << 8) | b4[a + 2 + 2 * k]) for k in range(b4[a])])
    return out


def screen_text(t):
    """The text as the screen shows it: padding removed, the font's '^' is the degree sign, and a leading "-G"
    (the OS's and Virus Control's mark for an entry shown greyed: USB3 while Virus Control's third USB pair is
    off) becomes "(greyed)"."""
    t = t.strip().replace('^', '°')
    return f'{t[2:]} (greyed)' if t.startswith('-G') else t


def per_class(d, p, width):
    res = {}
    for cls in range(8):
        n = d[p]
        if n == 0 or n > 0x80: break
        for lo in range(n): res[(cls << 8) | lo] = p + 1 + lo * width
        p += 1 + n * width
    return res


def remap_index():
    res, p = {}, 0x8d16
    nc = D2[p]; p += 1
    for c in range(nc):
        n = D2[p]
        for lo in range(n):
            if D2[p + 1 + lo] != 0xff: res[(c << 8) | lo] = D2[p + 1 + lo]
        p += 1 + n
    return res


def handler(base, pid):
    c, lo = pid >> 8, pid & 0xff
    if c >= D2[base]: return None
    t = (D2[base + 1 + 2 * c] << 8) | D2[base + 2 + 2 * c]
    if lo >= D2[t]: return None
    return (D2[t + 1 + 2 * lo] << 8) | D2[t + 2 + 2 * lo]


RANGE_BLOCK = re.compile(rb'\x7c.\x7d.\x7e(.)\x7f(.)\xd3\x22', re.S)   # MOV R4,#k R5,#x R6,#lo R7,#hi; SETB C; RET


def blocks(h, n=80):
    return [(m.group(1)[0], m.group(2)[0]) for m in RANGE_BLOCK.finditer(D2[h:h + n])]


def range_of(pid):
    """[first, last] display position from the parameter's range routine, plus a note for the routines that
    depend on another setting; None when the parameter has no routine (index 7F of a class: Virus Control's range)."""
    h = handler(RANGES, pid)
    if h is None: return None, None
    b = blocks(h, 12)
    if b and D2[h] == 0x7c: return list(b[0]), None
    if D2[h] == 0x20 and D2[h + 1] == USB_BIT:   # JB 13h (Snow 14h) / MOVX A,@409: [no USB audio, Virus Control's third USB pair off, on]
        b = blocks(h, 0x2a)
        assert len(b) == 3 and D2[h + 0x0e:h + 0x11] == b'\x90\x04\x09', hex(h)
        return [0, max(x[1] for x in b)], {'usb': [x[1] for x in b]}
    if D2[h] == 0x7e and D2[h + 2] == 0x7f and D2[h + 4:h + 7] == b'\xad\x73\x12' and D2[h + 7:h + 9] == GET_PARAM:
        # MOV R6/R7 = the internal parameter it reads (LCALL 0826; the Snow's 01C5), then JNZ / CJNE #1 / CJNE #2: a range per value 0, 1, 2, other
        dep = (D2[h + 1] << 8) | D2[h + 3]
        assert D2[h + 12] == 0x70, hex(h)
        b = blocks(h, 0x45)
        return [0, max(x[1] for x in b)], {'by': dep, 'last': [x[1] for x in b]}
    if D2[h:h + 3] == b'\x7f\x68\x12' and D2[h + 3:h + 5] == BANK_COUNT:   # bank lists: last = min(number of ROM banks, 26) + 3 (RAM A-D first)
        return [0, 26 + 3], {'banks': True}
    raise ValueError(f'range routine {h:04x} of {pid:03x} not understood')


def knob_table(a, width):
    """A bank 1 panel knob table: a count (32 knobs), then per knob a length byte and that many entries."""
    d, n, p, out = B[1], B[1][a], a + 1, []
    for _ in range(n):
        k = d[p]
        out.append([int.from_bytes(d[p + 1 + width * j:p + 1 + width * (j + 1)], 'big') for j in range(k)])
        p += 1 + width * k
    return out


def panel_knobs(L):
    """The panel knobs 0-31 (bank 1; the knob handler at 0A8B, knob number in IRAM 2Dh). Per knob, D014 lists
    conditions (bank 2 C616 + c, checked by 47F6 in order; the first that holds picks the entry), D3FE the entry's
    function (dispatched through DA2E: 0 = edit internal parameter D209[k][i] (0B00), 1 = Remote mode: record k of
    the template the global Remote Patch (F 108) selects (0D09 -> 6168), 2-4 = the menu's soft knob 1-3
    assignment (0BD2/0BF2/0C12), 5-7 = soft knob 1-3 by the global Soft Knob Mode 1-3 (0C32/0CA7/0CD8: F 110,
    111, 114)), D614 the name the display shows for it (display list 45). Returns per knob [Remote mode uses
    its record, soft knob number or 0, the list 45 names of its parameter functions in table order]."""
    cond, func, names = knob_table(0xd014, 2), knob_table(0xd3fe, 1), knob_table(0xd614, 1)
    out = []
    for k in range(32):
        soft = next((t - 4 for t in func[k] if 5 <= t <= 7), 0)
        texts = []
        for i, t in enumerate(func[k]):
            x = names[k][i]
            if t == 0 and x and screen_text(L[45][x]) not in texts: texts.append(screen_text(L[45][x]))
        out.append([1 in func[k], soft, texts])
    return out


def main():
    L = lists()
    loc = {k: (D2[a], D2[a + 1]) for k, a in per_class(D2, 0x8701, 2).items()}
    vl = {k: B[1][a] for k, a in per_class(B[1], VALUE_LISTS, 1).items()}
    rmi = remap_index()
    FWD = [list(D2[0x9025 + 0x100 * n:0x90a5 + 0x100 * n]) for n in range(14)]
    INV = [list(D2[0x90a5 + 0x100 * n:0x9125 + 0x100 * n]) for n in range(14)]
    single = [[] for _ in range(512)]
    multi = {}
    for k, (c, x) in sorted(loc.items()):
        if c in PAGE and k < 0x500: single[PAGE[c] * 128 + (x & 0x7f)].append([k, vl.get(k), bool(x & 0x80)])
        if c == 0x72: multi.setdefault(x & 0x7f, []).append([k, vl.get(k)])
    names = [n.split('#')[0] for n in L[99]]   # the OS's controller names ("Foot#4" -> "Foot"; "" when unnamed)

    # ---- Virus Control's parameters -> the OS's internal parameter, display list, reordering and range
    J = json.load(open(VC, encoding='utf-8'))
    at = {}
    for k, (c, x) in loc.items(): at.setdefault((c, x & 0x7f), []).append(k)
    norm = lambda t: re.sub(r'\.0(?=\D|$)', '', re.sub(r'[\s%°^Â+]+', '', str(t).lower()))

    def os_text(k, r):
        l = L[vl[k]] if vl.get(k) is not None and vl[k] < len(L) else []
        pos = INV[rmi[k]][r] if k in rmi else r
        return l[pos] if pos < len(l) else None

    param, report, used = {}, [], set()
    for key, p in J['params'].items():
        pg = VC_PAGE.get(p['msg'])
        if pg is None: continue
        ent = J['valuelists'].get(p['vl'])
        vt = {e[0]: e[1] for e in ent['entries'] if p['min'] <= e[0] <= p['max']} if ent and ent['entries'] else {r: str(r) for r in range(p['min'], p['max'] + 1)}
        best = None
        for k in at.get((pg, p['ci']), []):
            same = sum(1 for r, t in vt.items() if os_text(k, r) is not None and norm(os_text(k, r)) == norm(t))
            if best is None or same > best[1]: best = (k, same)
        if best is None: report.append(f'{key}: no OS parameter'); continue
        k, same = best
        rng, note = range_of(k)
        if rng is None: rng = [p['min'], p['max']]
        param[key] = [k, vl.get(k), rmi.get(k), rng[0], rng[1]]
        if note: param[key].append(note)
        used.add(vl.get(k))
        if same < len(vt):
            diff = [f'{r}: {t!r} -> {screen_text(os_text(k, r) or "")!r}' for r, t in vt.items() if os_text(k, r) is None or norm(os_text(k, r)) != norm(t)]
            report.append(f'{key} (OS {k:03x}, list {vl.get(k)}): {same}/{len(vt)} texts equal; ' + '; '.join(diff))
        vr = sorted(FWD[rmi[k]][q] for q in range(rng[0], rng[1] + 1)) if k in rmi else list(range(rng[0], rng[1] + 1))
        if vr != list(range(p['min'], p['max'] + 1)):
            extra, miss = sorted(set(vr) - set(range(p['min'], p['max'] + 1))), sorted(set(range(p['min'], p['max'] + 1)) - set(vr))
            report.append(f'{key} (OS {k:03x}): values {vr[0]}-{vr[-1]}{" (reordered)" if k in rmi else ""}, Virus Control {p["min"]}-{p["max"]}'
                          + (f'; only the OS: {extra}' if extra and len(extra) < 12 else '') + (f'; only Virus Control: {miss}' if miss and len(miss) < 12 else ''))
    used |= {v for e in single for _, v, _ in e if v is not None}
    used.discard(None)
    tables = sorted({v[2] for v in param.values() if v[2] is not None})
    odd = sorted({c for i in used for t in L[i] for c in t if not (32 <= ord(c) < 127)})

    # ---- knob value ranges (bank 1 at 8000 + 100h x n: the value sent at each of 256 knob steps, for range type n;
    # the range routines' R5 and a remote template knob's byte 10 select one; CE00 refuses n >= 78 in remote mode).
    # Virus Control's remote page names 62 of them in an older numbering (its list "Val Remote Template Knob
    # Behaviours"); matched here by range (its 52-61 are the OS's 64, 65, 67, 69, 70, 73-77).
    curve = [B[1][0x8000 + 0x100 * n:0x8100 + 0x100 * n] for n in range(78)]
    beh = [e[1] for e in J['valuelists']['Val Remote Template Knob Behaviours']['entries']]
    vc_for = {}
    for i, t in enumerate(beh):
        m = re.match(r'Unipolar (\d+)-(\d+)$', t)
        if m:
            hits = [n for n in range(64) if (curve[n][0], curve[n][255]) == (int(m.group(1)), int(m.group(2)))]
            if hits: vc_for[hits[0]] = [i, t]
    for i, n in zip(range(52, 62), (64, 65, 67, 69, 70, 73, 74, 75, 76, 77)):
        assert (curve[n][0], curve[n][255]) == {52: (0, 127), 53: (16, 112), 54: (1, 22), 55: (1, 20), 56: (1, 17), 57: (1, 6),
                                                58: (1, 3), 59: (32, 126), 60: (0, 127), 61: (0, 127)}[i], (i, n)
        vc_for[n] = [i, beh[i]]
    knob_ranges = [[curve[n][0], curve[n][255], *(vc_for.get(n) or [None, None])] for n in range(78)]
    js = [f'// Generated by tools/virus/os_tables.py {MODEL} from the Virus {"TI2" if MODEL == "ti2" else "TI Snow"} host OS (OS 5.1.7). Do not edit.',
          '// SINGLE[offset] = [[internal parameter, value list, host only], ...] (empty: the OS has no parameter there)',
          f'export const SINGLE = {json.dumps(single, separators=(",", ":"))};',
          '// MULTI[page 72 index] = [[internal parameter, value list], ...]',
          f'export const MULTI = {json.dumps({str(k): v for k, v in sorted(multi.items())}, separators=(",", ":"))};',
          '// The OS\'s names of the MIDI controllers (its list 99, e.g. the soft knobs\' controller destinations)',
          f'export const CC_NAMES = {json.dumps(names)};',
          '// PARAM[Virus Control parameter] = [internal parameter, display list, reordering table (null: none), first and last',
          '// display position the screen offers (its range routine), {usb: last position without USB audio / third USB',
          '// pair off / on} | {by: internal parameter, last: last position for its value 0, 1, 2, other} | {banks}]',
          'export const PARAM = {\n' + ''.join(f'  {json.dumps(k)}: {json.dumps(v, separators=(",", ":"))},\n' for k, v in sorted(param.items())) + '};',
          '// REORDER[n] = the stored value at each display position (bank 2 9025 + 100h x n): the screen lists these values in this order',
          f'export const REORDER = {json.dumps({str(n): FWD[n] for n in tables}, separators=(",", ":"))};',
          '// The display lists (list number -> the screen texts, by display position; padding removed, "^" shown as the degree sign,',
          '// a leading "-G" (greyed entry) as "(greyed)")',
          f'export const LISTS = {json.dumps({str(i): [screen_text(t) for t in L[i]] for i in sorted(used)}, ensure_ascii=False, separators=(",", ":"))};',
          '// KNOB_RANGES[n] = [first value, last value, Virus Control\'s number, its name] of knob range type n (bank 1 8000 + 100h x n;',
          '// a remote template knob\'s byte 10). Virus Control numbers 62 of them differently (an older table); null: not in its list',
          f'export const KNOB_RANGES = {json.dumps(knob_ranges, separators=(",", ":"))};',
          '// PANEL_KNOBS[k] = [Remote mode sends record k of the remote template, soft knob number (0: none), the names the',
          '// display shows for the parameters the knob edits (list 45, in the order of its table: the panel selection picks one)]',
          '// for panel knob k (bank 1 D014 / D3FE / D209 / D614, knob handler 0A8B). Knob 16 is Master Volume, never remote:',
          '// a template\'s record 16 holds its name.',
          f'export const PANEL_KNOBS = {json.dumps(panel_knobs(L) if MODEL == "ti2" else [], separators=(",", ":"))};',
          '']
    open(f'js/devices/defs/access-virus-{MODEL}-os.js', 'w', encoding='utf-8', newline='\n').write('\n'.join(js))
    open('re/virusti/vc/os_vs_vc.txt' if MODEL == 'ti2' else f're/virus/{MODEL}/os_vs_vc.txt', 'w', encoding='utf-8', newline='\n').write('\n'.join(report) + '\n')
    print('single offsets with a parameter:', sum(1 for e in single if e), 'multi indexes:', len(multi), 'lists:', len(used),
          'Virus Control parameters matched:', len(param), 'reordering tables:', tables, 'differences:', 're/virusti/vc/os_vs_vc.txt' if MODEL == 'ti2' else f're/virus/{MODEL}/os_vs_vc.txt',
          len(report), 'non-ASCII in the lists:', odd)


if __name__ == '__main__':
    main()
