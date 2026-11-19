"""Talk to a Roland JV-series module over MIDI (python-rtmidi) for hardware checks.

usage:
  python3 -I jvlive.py ports
  python3 -I jvlive.py identity  [--port "2- JV2080"]
  python3 -I jvlive.py read ADDR SIZE [--model 6a] [--dev 10]     e.g. read "00 00 00 00" 62
  python3 -I jvlive.py write ADDR BYTES... [--model 6a] [--dev 10]
  python3 -I jvlive.py names user-patches | user-perfs
  python3 -I jvlive.py raw HEX...                                  send any bytes, print replies

ADDR is four hex bytes; SIZE is hex. Replies are printed as hex.
"""
import sys
import time

import rtmidi

ARGS = sys.argv[1:]


def opt(name, default):
    if name in ARGS:
        i = ARGS.index(name)
        v = ARGS[i + 1]
        del ARGS[i:i + 2]
        return v
    return default


PORT = opt('--port', '2- JV2080')
MODEL = [int(x, 16) for x in opt('--model', '6a').split()]
DEV = int(opt('--dev', '10'), 16)
QUIET = float(opt('--quiet', '0.4'))
FIRST = float(opt('--first', '2.5'))


def open_ports():
    mi, mo = rtmidi.MidiIn(), rtmidi.MidiOut()
    ins = [i for i, n in enumerate(mi.get_ports()) if n.startswith(PORT + ' ') or n == PORT]
    outs = [i for i, n in enumerate(mo.get_ports()) if n.startswith(PORT + ' ') or n == PORT]
    if not ins or not outs:
        sys.exit(f'port {PORT!r} not found')
    mi.open_port(ins[0])
    mo.open_port(outs[0])
    mi.ignore_types(sysex=False, timing=True, active_sense=True)
    return mi, mo


def checksum(b):
    return (128 - sum(b) % 128) % 128


def a2i(a):
    v = 0
    for x in a:
        v = v * 128 + (x & 0x7f)
    return v


def i2a(n, ln=4):
    out = [0] * ln
    for i in range(ln - 1, -1, -1):
        out[i] = n % 128
        n //= 128
    return out


def rq1(addr, size):
    body = addr + i2a(size)
    return [0xf0, 0x41, DEV] + MODEL + [0x11] + body + [checksum(body), 0xf7]


def dt1(addr, data):
    body = addr + list(data)
    return [0xf0, 0x41, DEV] + MODEL + [0x12] + body + [checksum(body), 0xf7]


def exchange(mi, mo, msgs, quiet=QUIET, total=8.0):
    """Send messages, then collect replies until `quiet` seconds pass with nothing new."""
    while mi.get_message():
        pass
    for m in msgs:
        mo.send_message(m)
        time.sleep(0.03)
    out = []
    sent = [list(m) for m in msgs]
    t0 = last = time.time()
    replied = False
    # Wait up to FIRST seconds for the first real reply (the JV can take over 400 ms),
    # then until `quiet` seconds pass without a message. Echoes of what we sent are dropped.
    while time.time() - t0 < total and (time.time() - last < quiet or (not replied and time.time() - t0 < FIRST)):
        m = mi.get_message()
        if m:
            if m[0] in sent:
                continue
            out.append(m[0])
            replied = True
            last = time.time()
        else:
            time.sleep(0.002)
    return out


def hx(b):
    return ' '.join(f'{x:02x}' for x in b)


def read_block(mi, mo, addr, size):
    reps = exchange(mi, mo, [rq1(addr, size)])
    start = a2i(addr)
    data = bytearray(size)
    got = 0
    ml = len(MODEL)
    for r in reps:
        if r[0] != 0xf0 or r[1] != 0x41 or r[3:3 + ml] != MODEL or r[3 + ml] != 0x12:
            continue
        a = r[4 + ml:8 + ml]
        d = r[8 + ml:-2]
        if checksum(a + d) != r[-2]:
            print('checksum error', hx(r[:12]))
        off = a2i(a) - start
        if 0 <= off < size:
            n = min(len(d), size - off)
            data[off:off + n] = bytes(d[:n])
            got += n
    return bytes(data), got, reps


def main():
    cmd = ARGS[0] if ARGS else 'ports'
    if cmd == 'ports':
        print('in ', rtmidi.MidiIn().get_ports())
        print('out', rtmidi.MidiOut().get_ports())
        return
    mi, mo = open_ports()
    if cmd == 'identity':
        for r in exchange(mi, mo, [[0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]]):
            print(hx(r))
    elif cmd == 'read':
        addr = [int(x, 16) for x in ARGS[1].split()]
        size = int(ARGS[2], 16)
        data, got, reps = read_block(mi, mo, addr, size)
        print(f'{len(reps)} messages, {got}/{size} bytes')
        for i in range(0, size, 16):
            print(f'{i:04x}: {hx(data[i:i + 16])}  {"".join(chr(c) if 32 <= c < 127 else "." for c in data[i:i + 16])}')
    elif cmd == 'write':
        addr = [int(x, 16) for x in ARGS[1].split()]
        data = [int(x, 16) for x in ARGS[2:]]
        for r in exchange(mi, mo, [dt1(addr, data)]):
            print(hx(r))
        print('sent', hx(dt1(addr, data)))
    elif cmd == 'names':
        kind = ARGS[1]
        base, count = ((0x11, 128) if kind == 'user-patches' else (0x10, 32))
        for n in range(count):
            data, got, _ = read_block(mi, mo, [base, n, 0, 0], 12)
            print(f'{n + 1:3d} {data.decode("latin-1")!r} ({got})')
    elif cmd == 'raw':
        for r in exchange(mi, mo, [[int(x, 16) for x in ' '.join(ARGS[1:]).split()]]):
            print(hx(r))
    mi.close_port()
    mo.close_port()


if __name__ == '__main__':
    main()
