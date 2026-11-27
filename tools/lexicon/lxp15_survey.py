# Lexicon LXP-15 panel survey (tools/lexicon/lxp15_emu.py): for a page and soft button, the parameter the
# button gives to ADJUST (its number from the SysEx message every change sends: F0 06 06 2n pp vv F7 or
# 5n pp lo hi F7), its range (turned to both ends) and the screen for each value (ADJUST stepped one detent
# at a time, or, for long ranges, the value set in the active setup and the screen composed again).
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lxp15_emu import SOFT, EDIT  # noqa: E402

MSG = re.compile(rb'\xf0\x06\x06([\x20-\x2f])(.)(.)\xf7|\xf0\x06\x06([\x50-\x5f])(.)(.)(.)\xf7', re.S)
REDRAW = 0xAD91    # set to FFh by the firmware after a parameter change: the screen is composed again


def msgs(tx):
    """[(param, value, form)] of the parameter messages in tx (form 1: 2n, form 2: 5n with lo / hi 7 bits)."""
    out = []
    for m in MSG.finditer(tx):
        if m.group(1):
            out.append((m.group(2)[0], m.group(3)[0], 1))
        else:
            out.append((m.group(5)[0], m.group(6)[0] | (m.group(7)[0] << 7), 2))
    return out


def value_of(tx, p):
    v = [x[1] for x in msgs(tx) if x[0] == p]
    return v[-1] if v else None


def select(e, base, pg, s):
    """Page pg, soft button s (0-4) pressed. -> (screen before, screen after the press)."""
    e.restore(base)
    e.b.page = pg
    e.run(400_000)
    before = e.screen()
    e.press(SOFT[s])
    e.drain()
    return before, e.screen()


def to_end(e, p, d, rounds=200, n=12):
    """Turn quickly in direction d until parameter p stops changing. -> True when it stopped (no wrap)."""
    last = None
    for _ in range(rounds):
        t = e.fast(d, n)
        v = value_of(t, p)
        if v is None:
            return True
        if last is not None and ((d > 0 and v < last) or (d < 0 and v > last)):
            return False  # wrapped round
        last = v
    return False


def set_value(e, p, form, v):
    """Put value v of parameter p in the active setup (as a received parameter message stores it)."""
    if form == 2:
        e.poke(EDIT + p, bytes([v & 0x7F, (v >> 7) & 0x7F]))
    else:
        e.poke(EDIT + p, bytes([v & 0xFF]))


def compose(e, limit=600_000, chunk=1_500):
    """Ask for the screen again and wait for it. -> screen."""
    e.poke(REDRAW, bytes([0xFF]))
    c0 = e.composes
    spent = 0
    while e.composes == c0 and spent < limit:
        e.run(chunk)
        spent += chunk
    # the redraw flag may be served in two passes (selection, then value): one more
    c1 = e.composes
    spent = 0
    while e.composes == c1 and spent < 60_000:
        e.run(chunk)
        spent += chunk
    return e.screen()


def survey(e, base, pg, s, walk=700, log=None):
    """Everything about soft button s of page pg from snapshot base."""
    before, sel = select(e, base, pg, s)
    r = {'page': pg, 'soft': s, 'names': before[1], 'selected': sel}
    tx, sc = e.adj(+1)
    if not msgs(tx):
        tx, sc = e.adj(-1)
    m = msgs(tx)
    if not m:
        r['none'] = True
        r['tx'] = tx.hex()
        r['screen'] = sc
        return r
    p, _, form = m[-1]
    r.update({'param': p, 'form': form, 'others': sorted({x[0] for x in m if x[0] != p})})
    stop_lo = to_end(e, p, -1)
    tx1, sc1 = e.adj(+1)
    tx2, sc2 = e.adj(-1)
    v1, v2 = value_of(tx1, p), value_of(tx2, p)
    if v1 is None:
        # a single value, or turning up does nothing from here
        r.update({'min': None, 'max': None, 'values': [], 'stop_lo': stop_lo})
        return r
    vmin = v2 if v2 is not None else v1
    vals = [[vmin, list(sc2 or sc1), [list(x) for x in msgs(tx2)]]]
    snap_lo = e.snap()
    stop_hi = to_end(e, p, +1)
    tx3, sc3 = e.adj(-1)
    vmax = (value_of(tx3, p) or vmin) + 1 if stop_hi else None
    r.update({'min': vmin, 'max': vmax, 'stop_lo': stop_lo, 'stop_hi': stop_hi})
    e.restore(snap_lo)
    count = (vmax - vmin + 1) if vmax is not None else walk
    if count <= walk:
        while True:
            tx, sc = e.adj(+1)
            v = value_of(tx, p)
            if v is None or len(vals) > walk + 2:
                break
            vals.append([v, list(sc), [list(x) for x in msgs(tx)]])
            if vmax is not None and v >= vmax:
                break
        r['values'] = vals
        r['how'] = 'walk'
        return r
    # long range: step the first values, then set each value in the active setup and compose the screen
    for _ in range(60):
        tx, sc = e.adj(+1)
        v = value_of(tx, p)
        if v is None:
            break
        vals.append([v, list(sc), [list(x) for x in msgs(tx)]])
    stepped = {v[0]: v[1] for v in vals}
    checks = []
    for v in range(vals[-1][0] + 1, vmax + 1):
        set_value(e, p, form, v)
        vals.append([v, list(compose(e)), None])
    # the composed screens must agree with the stepped ones
    for v, scr in list(stepped.items())[1:]:
        set_value(e, p, form, v)
        got = compose(e)
        checks.append([v, list(got) == list(scr)])
    r['values'] = vals
    r['how'] = 'compose'
    r['checks'] = checks
    if log:
        log('  compose checks', sum(c[1] for c in checks), '/', len(checks))
    return r
