#!/usr/bin/env python3
"""Check, compare and restore SYSTEM-8 backups made by backup.py.

  python -I restore.py verify DIR            every byte of every area is present
  python -I restore.py compare DIR1 DIR2     byte-for-byte comparison of two backups
  python -I restore.py restore DIR [AREA..]  send the DT1 messages back to SYSTEM-8 CTRL
                                             (default areas: system perf slot0 slot1 slot2 slot3)
      --bank [0|1]   wrap each slot area in the patch-bank brackets Roland's plugin sends around its
                     64 patches (70 20 01 01 [64] ... 70 20 01 02 [flag]; flag 0 after a fresh PLUG-OUT
                     install, 1 when the PLUG-OUT was already there). Used after reinstalling a PLUG-OUT.

Memory is compared as {packed address: byte} so different message splits compare equal.
The restore sends the unit's own DT1 messages (the same form Roland's plugin writes), 4 ms apart,
bracketed like the plugin's patch-bank transfer is not needed for single leaves.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s8midi import parse_dt1, a28

AREAS = ['system', 'perf', 'slot0', 'slot1', 'slot2', 'slot3']
SIZES = {'patch': 640, 'patch2': 3975, 'patch3': 15580, 'perf': 2709, 'system': 336}


def messages(path):
    raw = open(path, 'rb').read()
    return [m + b'\xf7' for m in raw.split(b'\xf7') if m.startswith(b'\xf0')]


def memory(d, areas=None):
    mem = {}
    for f in sorted(os.listdir(d)):
        if not f.endswith('.syx') or f == 'all.syx':
            continue
        if areas and f[:-4].split('-')[0] not in areas:
            continue
        for m in messages(os.path.join(d, f)):
            a, data = parse_dt1(m)
            for i, b in enumerate(data):
                mem[a + i] = b
    return mem


def verify(d):
    mem = memory(d)
    by_top = {}
    for a in mem:
        by_top.setdefault(a >> 14, 0)
        by_top[a >> 14] += 1
    # group 1<<14 blocks into structs: patch (b0 20-27/40-47, 0E/0F), patch2 (3 blocks), patch3 (9 blocks), perf (2 blocks)
    def total(prefixes):
        return sum(v for k, v in by_top.items() if (k >> 7) in prefixes)
    rep = {
        'system': total({0x01}),
        'patch slot0': total(set(range(0x20, 0x28))), 'patch slot1': total(set(range(0x40, 0x48))),
        'patch slot2': total({0x0E}), 'patch slot3': total({0x0F}),
        'patch2 slot0': total(set(range(0x28, 0x30))), 'patch2 slot1': total(set(range(0x30, 0x38))),
        'patch2 slot2': total(set(range(0x38, 0x40))), 'patch2 slot3': total(set(range(0x68, 0x70))),
        'patch3 slot0': total(set(range(0x48, 0x50))), 'patch3 slot1': total(set(range(0x50, 0x58))),
        'patch3 slot2': total(set(range(0x58, 0x60))), 'patch3 slot3': total(set(range(0x60, 0x68))),
        'perf': total(set(range(0x10, 0x18))),
    }
    want = {'system': 336, 'perf': 64 * 2709}
    for k in rep:
        if k.startswith('patch '): want[k] = 64 * 640
        if k.startswith('patch2'): want[k] = 64 * 3975
        if k.startswith('patch3'): want[k] = 64 * 15580
    ok = True
    for k, v in rep.items():
        flag = 'OK' if v == want[k] else f'MISMATCH (want {want[k]})'
        ok &= v == want[k]
        print(f'{k:14s} {v:8d} bytes  {flag}')
    print('complete' if ok else 'INCOMPLETE')
    return ok


def compare(d1, d2, areas=None):
    m1, m2 = memory(d1, areas), memory(d2, areas)
    diff = [a for a in set(m1) | set(m2) if m1.get(a) != m2.get(a)]
    print(f'{len(m1)} / {len(m2)} bytes, {len(diff)} differ')
    for a in sorted(diff)[:40]:
        print('  %02X %02X %02X %02X' % tuple(a28(a)), m1.get(a), m2.get(a))
    return not diff


def restore(d, areas, bank=None):
    from s8midi import S8, dt1
    import mido
    s = S8(listen=('SYSTEM-8 CTRL',))
    n = 0
    A = lambda b0, b1, b2, b3: b0 << 21 | b1 << 14 | b2 << 7 | b3
    for area in areas:
        msgs = messages(os.path.join(d, area + '.syx'))
        if bank is not None and area.startswith('slot'):
            msgs = [bytes(dt1(A(0x70, 0x20, 1, 1), [64]))] + msgs + [bytes(dt1(A(0x70, 0x20, 1, 2), [bank]))]
        for m in msgs:
            s.out.send(mido.Message('sysex', data=list(m[1:-1])))
            n += 1
            time.sleep(0.004 + len(m) * 0.00002)
            if n % 200 == 0:
                s.drain(0.05)
        print(area, 'sent', flush=True)
    s.drain(0.5)
    s.close()
    print('restored', n, 'messages')


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'verify':
        sys.exit(0 if verify(sys.argv[2]) else 1)
    if cmd == 'compare':
        sys.exit(0 if compare(sys.argv[2], sys.argv[3], AREAS) else 1)
    if cmd == 'restore':
        args = sys.argv[3:]
        bank = None
        if '--bank' in args:
            i = args.index('--bank')
            bank = int(args[i + 1]) if i + 1 < len(args) and args[i + 1] in ('0', '1') else 0
            del args[i:i + (2 if i + 1 < len(args) and args[i + 1] in ('0', '1') else 1)]
        restore(sys.argv[2], args or AREAS, bank)
