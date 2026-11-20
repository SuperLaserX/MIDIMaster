"""Map Korg M1 parameter-change numbers onto program / combination data by asking a unit.

For each parameter number: read the edit buffer, send a parameter change (41h) with a
nearby value, read it back and report which bytes and bits changed. Only the edit buffer
is touched; the original data is sent back (40h / 49h) at the end. Nothing is written to
memory.

usage: python3 -I m1probe.py prog NUMBERS [--fast] [--port "2- M1"] [--ch 1]   (program edit buffer)
       python3 -I m1probe.py combi NUMBERS [--fast]                            (combination edit buffer)
NUMBERS: e.g. 0-27,128-159 (--fast: one value pair each, no range)
prints one JSON line per parameter: {"p": n, "sent": v, "changed": [[offset, before, after], ...]}
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1live  # noqa: E402

ARGS = m1live.ARGS


def unpack(b):
    out = bytearray()
    for k in range(0, len(b), 8):
        g = b[k:k + 8]
        hi = g[0]
        for i, x in enumerate(g[1:]):
            out.append(x | (((hi >> i) & 1) << 7))
    return bytes(out)


def pack(b):
    out = bytearray()
    for k in range(0, len(b), 7):
        g = b[k:k + 7]
        out.append(sum(((x >> 7) & 1) << i for i, x in enumerate(g)))
        out.extend(x & 0x7F for x in g)
    return bytes(out)


def hdr(func):
    return [0xF0, 0x42, 0x30 | m1live.CH, 0x19, func]


def read(mi, mo, kind):
    func, reply = (0x10, 0x40) if kind == 'prog' else (0x19, 0x49)
    for r in m1live.exchange(mi, mo, hdr(func) + [0xF7]):
        if len(r) > 6 and r[4] == reply:
            return unpack(r[5:-1])
    raise SystemExit(f'no {kind} dump')


def param(mo, p, v):
    v &= 0x3FFF
    mo.send_message(hdr(0x41) + [p & 0x7F, p >> 7, v & 0x7F, v >> 7, 0xF7])


def main():
    m1live.QUIET = 0.25
    m1live.FIRST = 1.5
    fast = '--fast' in ARGS
    if fast:
        ARGS.remove('--fast')
    kind = ARGS[0]
    numbers = []
    for part in ARGS[1].split(','):
        a, _, b = part.partition('-')
        numbers.extend(range(int(a), int(b or a) + 1))
    mi, mo = m1live.open_ports()
    # Parameter changes apply in the edit modes: switch (4Eh) and switch back at the end.
    mode = next((r[5] for r in m1live.exchange(mi, mo, hdr(0x12) + [0xF7]) if len(r) > 6 and r[4] == 0x42), None)
    m1live.exchange(mi, mo, hdr(0x4E) + [3 if kind == 'prog' else 1, 0, 0xF7])
    orig = read(mi, mo, kind)
    size = len(orig)
    def state(p, v):
        param(mo, p, v)
        time.sleep(0.06)
        return read(mi, mo, kind)

    try:
        for p in numbers:
            before = read(mi, mo, kind)
            result = {'p': p, 'changed': []}
            # Two neighbouring values show which bytes and bits hold the parameter; the
            # extremes show its range (the unit clamps out-of-range values).
            for a, b in ((0, 1),) if fast else ((0, 1), (1, 2), (-1, 0), (2, 3)):
                da, db = state(p, a), state(p, b)
                changed = [[i, da[i], db[i]] for i in range(size) if da[i] != db[i]]
                if changed and fast:
                    result = {'p': p, 'values': [a, b], 'changed': changed}
                    break
                if changed:
                    lo, hi = state(p, -8192), state(p, 8191)
                    result = {'p': p, 'values': [a, b], 'changed': changed,
                              'lo': [lo[i] for i, _x, _y in changed], 'hi': [hi[i] for i, _x, _y in changed]}
                    break
            print(json.dumps(result), flush=True)
            # put the byte back before the next parameter
            mo.send_message(hdr(0x40 if kind == 'prog' else 0x49) + list(pack(before)) + [0xF7])
            time.sleep(0.15)
    finally:
        mo.send_message(hdr(0x40 if kind == 'prog' else 0x49) + list(pack(orig)) + [0xF7])
        time.sleep(0.3)
        back = read(mi, mo, kind)
        if mode is not None:
            m1live.exchange(mi, mo, hdr(0x4E) + [mode, 0, 0xF7])
        print(json.dumps({'restored': back == orig, 'mode': mode}), flush=True)


if __name__ == '__main__':
    main()
