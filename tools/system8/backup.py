#!/usr/bin/env python3
"""Complete read-only backup of a Roland SYSTEM-8 over the 'SYSTEM-8 CTRL' port.

Writes OUTDIR/ (default re/system8/backup/<date>/):
  info.json            device type, patch counts, the 48-byte slot records (slot 0-3)
  <area>.syx           every DT1 the unit sent, as received (restorable as is)
  backup.json          {address: hex data} for every leaf, plus the read plan
Areas (4 x 7-bit addresses, model 00 00 7E):
  system      01 50 00 00                    (2 leaves, 336 bytes)
  edit        03/04/05/06 ... (patch, performance, patch2, patch3 temporary areas)
  perf        10+bank nn 00 00 (bank 0-7, nn = 00,10..70)   64 performances, 12 leaves
  slotN       patch / patch2 / patch3 of the 64 patches of slot N (see slot_addr)
usage: python -I backup.py [OUTDIR] [--slots 0,1,2,3] [--no-edit]
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s8midi import S8, rq1, dt1, parse_dt1, a28, hexs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))

PATCH_BASE = {0: 0x4000000, 1: 0x8000000, 2: 0x1C00000, 3: 0x1E00000}
P23_BASE = [0x5000000, 0x6000000, 0x7000000, 0x0D000000, 0x9000000, 0xA000000, 0xB000000, 0x0C000000]


def slot_addr(slot, p, struct):
    """struct 0 = patch (usrX), 1 = patch2 (usr2X), 2 = patch3 (usr3X) -> packed address."""
    if struct == 0:
        b, i = p // 8, p % 8
        if slot in (0, 1):
            return (((b << 7) + i) << 14) + PATCH_BASE[slot]
        return (((b << 4) + i) << 14) + PATCH_BASE[slot]
    return (p << 18) + P23_BASE[slot + (struct - 1) * 4]


def perf_addr(n):
    return ((0x10 + n // 8) << 21) | ((n % 8) << 18)


def addr_s(a):
    return '%02X %02X %02X %02X' % tuple(a28(a))


class Reader:
    def __init__(self):
        self.s = S8(listen=('SYSTEM-8 CTRL',))
        self.s.drain(0.3)
        self.got = {}      # addr -> bytes
        self.raw = []      # raw sysex in arrival order

    def pump(self, wait, quiet=0.15):
        for n, b in self.s.drain(wait, quiet):
            p = parse_dt1(b)
            if p:
                self.got[p[0]] = bytes(p[1])
                self.raw.append(bytes(b))

    def request(self, addr, size, wait=0.4, quiet=0.15):
        self.s.send(rq1(addr, size))
        self.pump(wait, quiet)

    def info(self):
        out = {}
        def q(addr, data):
            self.s.send(dt1(addr, data))
            for n, b in self.s.drain(0.6, 0.2):
                p = parse_dt1(b)
                if p:
                    return list(p[1])
            return None
        A = lambda b0, b1, b2, b3: b0 << 21 | b1 << 14 | b2 << 7 | b3
        out['type'] = q(A(0x70, 0, 2, 0), [0])
        out['countA'] = q(A(0x70, 0, 2, 1), [0])
        out['countB'] = q(A(0x70, 0, 2, 2), [0])
        out['slots'] = q(A(0x70, 0, 2, 3), [0])
        out['slot'] = []
        for i in range(out['slots'][0]):
            d = q(A(0x70, 0, 1, 0), [i])
            name = bytes((d[16 + 2 * k] << 4) | d[17 + 2 * k] for k in range(16)).rstrip(b'\0').decode('ascii', 'replace')
            nib = lambda a, b: int(''.join('%X' % x for x in d[a:b]), 16)
            out['slot'].append({'raw': d, 'name': name, 'model': nib(8, 12), 'version': '%X.%02X' % divmod(nib(12, 16), 256),
                                'fw': nib(0, 4), 'engine': nib(4, 8)})
        return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    slots = [0, 1, 2, 3]
    for a in sys.argv[1:]:
        if a.startswith('--slots='):
            slots = [int(x) for x in a.split('=')[1].split(',')]
    outdir = args[0] if args else os.path.join(ROOT, 're', 'system8', 'backup', time.strftime('%Y%m%d-%H%M%S'))
    os.makedirs(outdir, exist_ok=True)
    layout = json.load(open(os.path.join(ROOT, 're', 'system8', 'layout', 'SYSTEM-8.json')))
    spans = {}
    for k, key in enumerate(('patch', 'patch2', 'patch3')):
        leaves = layout[key]
        spans[k] = [(l['base'], l['size']) for l in leaves]
    r = Reader()
    t0 = time.time()
    info = r.info()
    json.dump(info, open(os.path.join(outdir, 'info.json'), 'w'), indent=1)
    print('info', json.dumps({k: v for k, v in info.items() if k != 'slot'}), [(s['name'], s['version']) for s in info['slot']], flush=True)
    areas = {}

    def area(name, reqs):
        before = set(r.got)
        start = len(r.raw)
        for addr, size, wait in reqs:
            r.request(addr, size, wait)
        r.pump(0.5, 0.3)
        new = r.raw[start:]
        open(os.path.join(outdir, name + '.syx'), 'wb').write(b''.join(new))
        areas[name] = sorted(set(r.got) - before)
        print(f'{name}: {len(new)} messages, {sum(len(b) for b in new)} bytes, {time.time() - t0:.0f}s', flush=True)

    # system and temporary areas
    area('system', [(0x01 << 21 | 0x50 << 14, 0x4000, 0.6)])
    if '--no-edit' not in sys.argv:
        edit = [(0x03 << 21, 0x500, 0.5), (0x04 << 21, 0x10000, 0.8)]
        for b1 in (0x00, 0x10, 0x20, 0x30):
            edit.append((0x05 << 21 | b1 << 14, 0x14000, 0.8))
            edit.append((0x06 << 21 | b1 << 14, 0x24000, 1.5))
            edit.append((0x03 << 21 | b1 << 14, 0x500, 0.4))
        area('edit', edit)
    # performances
    area('perf', [(perf_addr(n), 0x10000, 0.5) for n in range(64)])
    # patch memory per slot, struct by struct; re-request leaves that did not arrive
    for slot in slots:
        reqs = []
        for p in range(64):
            for k in range(3):
                base = slot_addr(slot, p, k)
                end = max(b + s for b, s in spans[k])
                reqs.append((base, end, 0.35 if k < 2 else 0.9))
        area(f'slot{slot}', reqs)
        missing = []
        for p in range(64):
            for k in range(3):
                base = slot_addr(slot, p, k)
                for b, s in spans[k]:
                    if base + b not in r.got:
                        missing.append(base + b)
        print(f'slot{slot}: {len(missing)} leaves missing after the first pass', flush=True)
        if missing:
            area(f'slot{slot}-retry', [(a, 0x80, 0.3) for a in missing])
    json.dump({'areas': {k: [addr_s(a) for a in v] for k, v in areas.items()},
               'data': {addr_s(a): r.got[a].hex() for a in sorted(r.got)}},
              open(os.path.join(outdir, 'backup.json'), 'w'), indent=0)
    open(os.path.join(outdir, 'all.syx'), 'wb').write(b''.join(r.raw))
    print('done', outdir, len(r.got), 'leaves', f'{time.time() - t0:.0f}s')
    r.s.close()


if __name__ == '__main__':
    main()
