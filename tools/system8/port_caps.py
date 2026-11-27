#!/usr/bin/env python3
"""Which SYSTEM-8 port carries what (2026-11-26, phase 2): CC, DT1, RQ1, bank select + program change on the
plain USB port 'SYSTEM-8' and on 'SYSTEM-8 CTRL'; where the unit's own transmissions appear (all inputs are
watched while it changes patch, to find a DIN connection through an interface).

Each test changes the temporary patch only (FILTER CUTOFF, then the patch number) and puts it back:
the original temporary patch is read first and rewritten at the end (DT1 of all its leaves over CTRL),
after recalling the original patch number. usage: python -I port_caps.py [--din-out NAME --din-in NAME]
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mido
from s8midi import rq1, dt1, parse_dt1, a28, hexs, find_port

TEMP = 0x03 << 21
CUTOFF = 58  # FILTER CUTOFF, 2 nibbles (patch struct offset)
LEAVES = [(0x00, 14), (0x0e, 10), (0x18, 16), (0x28, 12), (0x34, 6), (0x3a, 20), (0x4e, 10), (0x58, 8), (0x60, 12), (0x6c, 20), (0x80, 240), (0x170, 240), (0x260, 32)]


class Rig:
    def __init__(self, watch_all=False, extra_out=None):
        self.outs = {n: mido.open_output(find_port(mido.get_output_names(), n)) for n in ('SYSTEM-8', 'SYSTEM-8 CTRL')}
        if extra_out:
            self.outs['DIN'] = mido.open_output(find_port(mido.get_output_names(), extra_out))
        self.ins = {}
        names = mido.get_input_names() if watch_all else [find_port(mido.get_input_names(), n) for n in ('SYSTEM-8', 'SYSTEM-8 CTRL')]
        for n in names:
            try:
                self.ins[n] = mido.open_input(n)
            except Exception as e:  # ports other programs hold
                print('  (cannot open', n, e, ')')

    def close(self):
        for p in list(self.outs.values()) + list(self.ins.values()):
            p.close()

    def send(self, port, data):
        self.outs[port].send(mido.Message('sysex', data=data[1:-1]) if data[0] == 0xF0 else mido.Message.from_bytes(data))

    def drain(self, wait=0.4):
        got = []
        t0 = time.time()
        while time.time() - t0 < wait:
            for n, p in self.ins.items():
                for m in p.iter_pending():
                    if m.type not in ('clock', 'active_sensing'):
                        got.append((n, bytes(m.bytes())))
            time.sleep(0.002)
        return got

    def read(self, addr, size, port='SYSTEM-8 CTRL', wait=0.8):
        self.drain(0.05)
        self.send(port, rq1(addr, size))
        mem = {}
        replies = []
        for n, b in self.drain(wait):
            p = parse_dt1(b) if b[0] == 0xF0 else None
            if p:
                replies.append(n)
                for i, x in enumerate(p[1]):
                    mem[p[0] + i] = x
        return mem, replies


def patch_of(mem, base=TEMP):
    return bytes(mem.get(base + i, 0) for i in range(640))


def name_of(d):
    return bytes((d[0x80 + 2 * i] << 4) | d[0x81 + 2 * i] for i in range(16)).decode('latin1').rstrip()


def cutoff(r):
    mem, _ = r.read(TEMP + CUTOFF, 2)
    return (mem.get(TEMP + CUTOFF, 0) << 4) | mem.get(TEMP + CUTOFF + 1, 0)


def main():
    a = sys.argv[1:]
    din_out = a[a.index('--din-out') + 1] if '--din-out' in a else None
    r = Rig(watch_all='--watch-all' in a, extra_out=din_out)
    res = {}
    try:
        mem, _ = r.read(TEMP, 640, wait=1.5)
        orig = patch_of(mem)
        print('temporary patch:', name_of(orig), 'cutoff', (orig[CUTOFF] << 4) | orig[CUTOFF + 1])
        # 1. RQ1 on each output
        for port in ('SYSTEM-8', 'SYSTEM-8 CTRL') + (('DIN',) if din_out else ()):
            _, rep = r.read(TEMP + CUTOFF, 2, port=port)
            res[f'RQ1 via {port}'] = sorted(set(rep)) or 'no reply'
        # 2. CC 3 (CUTOFF) on channel 1 on each output
        for port in ('SYSTEM-8', 'SYSTEM-8 CTRL') + (('DIN',) if din_out else ()):
            r.send('SYSTEM-8 CTRL', dt1(TEMP + CUTOFF, [0, 0])); r.drain(0.2)
            r.send(port, [0xB0, 3, 100]); echo = r.drain(0.4)
            res[f'CC3=100 via {port}'] = f'cutoff now {cutoff(r)}' + (f' (echo {[(n, hexs(b)) for n, b in echo]})' if echo else '')
        # 3. DT1 on each output
        for i, port in enumerate(('SYSTEM-8', 'SYSTEM-8 CTRL') + (('DIN',) if din_out else ())):
            v = 0x20 + i
            r.send(port, dt1(TEMP + CUTOFF, [v >> 4, v & 15])); r.drain(0.3)
            res[f'DT1 cutoff={v} via {port}'] = f'cutoff now {cutoff(r)}'
        # 4. bank select 85/0 + program change on each output; who sees the unit transmit?
        for i, port in enumerate(('SYSTEM-8', 'SYSTEM-8 CTRL') + (('DIN',) if din_out else ())):
            pc = 9 + i  # B-2, B-3, B-4
            r.send(port, [0xB0, 0, 85]); r.send(port, [0xB0, 32, 0]); r.send(port, [0xC0, pc])
            seen = r.drain(1.0)
            mem, _ = r.read(TEMP + 0x80, 32)
            nm = bytes((mem.get(TEMP + 0x80 + 2 * k, 0) << 4) | mem.get(TEMP + 0x81 + 2 * k, 0) for k in range(16)).decode('latin1').rstrip()
            res[f'PC {pc} via {port}'] = f'temporary patch now "{nm}"' + (f'; transmitted: {[(n, hexs(b)) for n, b in seen][:12]}' if seen else '')
        # back: patch A-1, then the original temporary patch
        r.send('SYSTEM-8', [0xB0, 0, 85]); r.send('SYSTEM-8', [0xB0, 32, 0]); r.send('SYSTEM-8', [0xC0, 0]); r.drain(1.0)
        for o, n in LEAVES:
            r.send('SYSTEM-8 CTRL', dt1(TEMP + o, list(orig[o:o + n]))); time.sleep(0.02)
        r.drain(0.5)
        mem, _ = r.read(TEMP, 640, wait=1.5)
        res['temporary patch restored'] = patch_of(mem) == orig
    finally:
        r.close()
    for k, v in res.items():
        print(f'{k}: {v}')


if __name__ == '__main__':
    main()
