#!/usr/bin/env python3
"""Live MIDI helpers for the Roland SYSTEM-8 (python-rtmidi through mido).

Ports (Windows names): 'SYSTEM-8' (normal MIDI: notes, CC, PC, clock) and
'SYSTEM-8 CTRL' (the PLUG-OUT / editor port: Roland SysEx, model 00 00 7E).
Windows MIDI ports are exclusive: close the browser app before running these.

SysEx: F0 41 <dev> 00 00 7E <cmd> <a1 a2 a3 a4> <data|size4> <sum> F7
  cmd 11 = RQ1 (size as 4 x 7-bit bytes), 12 = DT1. Device ID 0x10 (17).
"""
import sys, time
import mido

MODEL = [0x00, 0x00, 0x7E]


def find_port(names, want):
    for n in names:
        base = n.rsplit(' ', 1)[0] if n.rsplit(' ', 1)[-1].isdigit() else n
        if base == want:
            return n
    raise SystemExit(f'port {want!r} not found in {names}')


def checksum(body):
    return (-sum(body)) & 0x7F


def a28(addr):
    return [(addr >> 21) & 0x7F, (addr >> 14) & 0x7F, (addr >> 7) & 0x7F, addr & 0x7F]


def rq1(addr, size, dev=0x10):
    body = a28(addr) + a28(size)
    return [0xF0, 0x41, dev] + MODEL + [0x11] + body + [checksum(body), 0xF7]


def dt1(addr, data, dev=0x10):
    body = a28(addr) + list(data)
    return [0xF0, 0x41, dev] + MODEL + [0x12] + body + [checksum(body), 0xF7]


def parse_dt1(msg):
    """bytes of a complete SysEx (F0..F7) -> (addr, data) or None."""
    b = list(msg)
    if len(b) < 13 or b[0] != 0xF0 or b[1] != 0x41 or b[3:6] != MODEL or b[6] != 0x12:
        return None
    body = b[7:-2]
    if checksum(body) != b[-2]:
        raise ValueError('checksum')
    addr = (body[0] << 21) | (body[1] << 14) | (body[2] << 7) | body[3]
    return addr, body[4:]


class S8:
    def __init__(self, out='SYSTEM-8 CTRL', inp=None, listen=('SYSTEM-8', 'SYSTEM-8 CTRL')):
        self.out = mido.open_output(find_port(mido.get_output_names(), out))
        self.ins = {}
        for n in listen:
            self.ins[n] = mido.open_input(find_port(mido.get_input_names(), n))

    def close(self):
        self.out.close()
        for p in self.ins.values():
            p.close()

    def send(self, data):
        if data[0] == 0xF0:
            self.out.send(mido.Message('sysex', data=data[1:-1]))
        else:
            self.out.send(mido.Message.from_bytes(data))

    def drain(self, wait=0.3, quiet=0.15):
        """collect (port, bytes) until nothing arrives for `quiet` s or `wait` total."""
        got = []
        t0 = time.time(); last = t0
        while time.time() - t0 < wait or time.time() - last < quiet:
            any_ = False
            for n, p in self.ins.items():
                for m in p.iter_pending():
                    if m.type in ('clock', 'active_sensing'):
                        continue
                    got.append((n, bytes(m.bytes())))
                    any_ = True; last = time.time()
            if not any_:
                if time.time() - last > quiet and time.time() - t0 > wait:
                    break
                time.sleep(0.002)
            if time.time() - t0 > wait + 5:
                break
        return got

    def read(self, addr, size, wait=1.0, dev=0x10):
        """RQ1 -> concatenated DT1 data (may arrive in several messages)."""
        self.send(rq1(addr, size, dev))
        data = bytearray(); addrs = []
        t0 = time.time()
        while time.time() - t0 < wait and len(data) < size:
            for n, p in self.ins.items():
                for m in p.iter_pending():
                    if m.type != 'sysex':
                        continue
                    r = parse_dt1(m.bytes())
                    if r:
                        addrs.append((n, r[0], len(r[1])))
                        data += bytes(r[1])
            time.sleep(0.001)
        return bytes(data), addrs


def hexs(b):
    return ' '.join(f'{x:02X}' for x in b)


if __name__ == '__main__':
    pass
