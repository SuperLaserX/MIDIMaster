# Survey helpers for the Quadraverb 2 generator (qv2_fw.py): set up a block, walk the pages of a mode.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qv2_emu import QV2  # noqa: E402

N_TYPES = {1: 19, 2: 13, 3: 7, 4: 14}       # types per function (EQ, PITCH, DELAY, REVERB)


def s16(v):
    return v - 0x10000 if v & 0x8000 else v


def setblock(q, f, t, block=0):
    """Block `block` (0-7) to function f / type t through the CONFIG pages and ENTER."""
    q.restore()
    q.press('config')
    for _ in range(block):
        q.press('block')
    goto(q, f)
    q.enter()
    q.settle()
    if f:
        goto(q, t)
        q.enter()
        q.settle()
    return q.x[block]


def goto(q, v, limit=300):
    """Turn the encoder one step at a time until the page's value is v."""
    for _ in range(limit):
        cur = s16((q.x[0x50] << 8) | q.x[0x51])
        if cur == v:
            return True
        q.turn(1 if v > cur else -1)
    return False


def values(rec):
    """The raw values the panel steps through: min..max in steps of the record's step (signed 16-bit)."""
    step = rec[1] or 1
    signed = bool(rec[3] & 0x80)          # 2051 compares signed when the minimum is negative
    w = s16 if signed else (lambda v: v)
    lo = w((rec[3] << 8) | rec[4])
    hi = w((rec[5] << 8) | rec[6])
    return list(range(lo, hi + 1, step)), step, lo, hi, w((rec[7] << 8) | rec[8])


SAMPLE_OVER = 3000


def walk(q, texts=True, limit=60000):
    """Every page of the mode shown: group, page, LCD, record, parameter address, 16-bit flag, texts."""
    out = []
    u = q.ui()
    base = q.save()
    code = q.cpu.c
    for g in range(u['ng']):
        q.restore(base)
        q.group(g)
        gs = q.save()
        u = q.ui()
        for p in range(u['np']):
            a = u['rec'] + 15 * p
            rec = bytes(code[a:a + 15])
            vals, step, lo, hi, dflt = values(rec)
            if rec[11:13] in (b'TU', b'Tb'):
                # 5455 / 5462: the first two records of the trigger types only move the cursor round (their
                # display routines jump to another page); bytes 0 / 1 of the block are modulation-only triggers
                out.append({'g': g, 'p': p, 'stub': True, 'rec': rec, 'addr': p, 'w16': 0, 'min': lo, 'max': hi,
                            'step': step, 'def': dflt})
                continue
            q.restore(gs)
            try:
                q.page(p)
            except RuntimeError as e:
                out.append({'g': g, 'p': p, 'error': str(e), 'rec': rec})
                continue
            pg = {'g': g, 'p': p, 'screen': q.lcd(), 'rec': rec, 'addr': q.x[0x65], 'w16': q.cpu.bit(0x0e),
                  'page2': q.cpu.bit(0x17), 'step': step, 'min': lo, 'max': hi, 'def': dflt,
                  'cur': (q.x[0x50] << 8) | q.x[0x51]}
            if texts and len(vals) <= limit:
                st = q.save()
                if len(vals) > SAMPLE_OVER:
                    # long ranges (delay times up to 50000 values): every value of the first and last
                    # thousand and every 61st in between; qv2_fw.py extends the texts over the whole range
                    # and checks the extension against all of these
                    idx = sorted(set(range(1000)) | set(range(len(vals) - 1000, len(vals))) | set(range(0, len(vals), 61)))
                    pg['sample'] = idx
                    pg['lcds'] = [q.show(vals[i] & 0xffff) for i in idx]
                else:
                    pg['lcds'] = [q.show(v & 0xffff) for v in vals]
                q.restore(st)
            out.append(pg)
    q.restore(base)
    return out
