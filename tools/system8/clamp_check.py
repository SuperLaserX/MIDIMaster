#!/usr/bin/env python3
"""Range check on the SYSTEM-8's temporary patch (patch mode): write out-of-range values with DT1, read them back,
then write the original leaves back and verify them. Shows whether the OS clamps a value to its catalog range
(OS 1.32 records, tools/system8/os_tables.py) or keeps what was sent.

  python -I tools/system8/clamp_check.py
Touches only 05 01 00 00 (patch2 leaf 8, Patch Tempo), 05 01 70 00 (leaf 15, chord memory) and 06 00 10 00 (patch3
step 1) of the temporary patch; the originals are written back and verified before it exits.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s8midi import S8, dt1, hexs

A = lambda b0, b1=0, b2=0, b3=0: (b0 << 21) | (b1 << 14) | (b2 << 7) | b3
LEAVES = {'patch2 leaf 8 (tempo)': (A(5, 1, 0), 240), 'patch2 leaf 15 (chord)': (A(5, 1, 0x70), 234), 'patch3 step 1': (A(6, 0, 0x10), 236)}
nib = lambda v, n: [(v >> (4 * (n - 1 - i))) & 15 for i in range(n)]
unnib = lambda b: sum(x << (4 * (len(b) - 1 - i)) for i, x in enumerate(b))
TESTS = [  # (what, address, bytes to send, nibbles?)
    ('Patch Tempo = 0 (OS 400-3000, plugin 0-2600)', A(5, 1, 0), nib(0, 8), True),
    ('Patch Tempo = 3500', A(5, 1, 0), nib(3500, 8), True),
    ('Patch Tempo = 2800', A(5, 1, 0), nib(2800, 8), True),
    ('step 1 Gate voice 1 = 0 (OS 1-100, plugin 0-99)', A(6, 0, 0x10, 0x10), [0], False),
    ('step 1 Gate voice 1 = 100', A(6, 0, 0x10, 0x10), [100], False),
    ('step 1 Gate voice 1 = 127', A(6, 0, 0x10, 0x10), [127], False),
    ('chord Note voice 1 = 144 (OS stored 0-128)', A(5, 1, 0x70, 2), nib(144, 2), True),
    ('chord Note voice 1 = 0', A(5, 1, 0x70, 2), nib(0, 2), True),
]


def main():
    s = S8(listen=('SYSTEM-8 CTRL',)); s.drain(0.3)
    orig = {}
    try:
        for k, (a, n) in LEAVES.items():
            d, _ = s.read(a, n, wait=2.0)
            assert len(d) == n, (k, len(d))
            orig[k] = d
        for what, a, data, is_nib in TESTS:
            s.send(dt1(a, data)); time.sleep(0.15); s.drain(0.1)
            back, _ = s.read(a, len(data), wait=1.5)
            v = unnib(back) if is_nib else (back[0] if back else None)
            print(f'{what}: sent {unnib(data) if is_nib else data[0]}, read back {v} ({hexs(back)})', flush=True)
    finally:
        for k, (a, n) in LEAVES.items():
            if k in orig:
                s.send(dt1(a, list(orig[k]))); time.sleep(0.2)
        s.drain(0.2)
        ok = True
        for k, (a, n) in LEAVES.items():
            if k in orig:
                d, _ = s.read(a, n, wait=2.0)
                same = d == orig[k]
                ok &= same
                print(f'restored {k}: {"same" if same else "DIFFERENT"}')
        s.close()
    print('all restored' if ok else 'RESTORE CHECK FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
