"""Talk to a Korg M1 / M1R / M1EX / M1REX over MIDI (python-rtmidi) for hardware checks.

usage:
  python3 -I m1live.py ports
  python3 -I m1live.py raw HEX...            send any bytes, print the replies
  python3 -I m1live.py req FUNC [DATA...]    send F0 42 3g 19 FUNC DATA F7, print the replies
  python3 -I m1live.py save FUNC OUT.syx [DATA...]   same, and write the replies to a file
options: --port "2- M1"  --ch 1 (global channel 1-16)  --quiet 0.6  --first 3

FUNC and DATA are hex. Replies are printed as hex with the function code named.
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


PORT = opt('--port', '2- M1')
CH = int(opt('--ch', '1')) - 1
QUIET = float(opt('--quiet', '0.6'))
FIRST = float(opt('--first', '3'))

NAMES = {
    0x40: 'PROGRAM PARAMETER DUMP', 0x49: 'COMBINATION PARAMETER DUMP', 0x4C: 'ALL PROGRAM DUMP',
    0x4D: 'ALL COMBINATION DUMP', 0x51: 'GLOBAL DATA DUMP', 0x48: 'SEQUENCE DATA DUMP', 0x50: 'ALL DATA DUMP',
    0x42: 'MODE DATA', 0x21: 'WRITE COMPLETED', 0x22: 'WRITE ERROR', 0x23: 'DATA LOAD COMPLETED',
    0x24: 'DATA LOAD ERROR', 0x26: 'RECEIVED MESSAGE FORMAT ERROR',
}


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


def exchange(mi, mo, msg):
    """Send one message; collect replies until QUIET seconds pass without one (FIRST for the first)."""
    while mi.get_message():
        pass
    mo.send_message(msg)
    out = []
    buf = []
    t0 = last = time.time()
    while True:
        m = mi.get_message()
        if m:
            data = m[0]
            # rtmidi may split long SysEx; join until F7
            buf.extend(data)
            if buf and buf[0] == 0xF0 and buf[-1] != 0xF7:
                last = time.time()
                continue
            out.append(bytes(buf))
            buf = []
            last = time.time()
            continue
        if time.time() - (last if out or buf else t0) > (QUIET if out or buf else FIRST):
            break
        time.sleep(0.002)
    return out


def show(replies):
    for r in replies:
        name = NAMES.get(r[4], '') if len(r) > 4 and r[:2] == b'\xf0\x42' else ''
        print(f'{len(r):5d} bytes {name}: {r[:24].hex(" ")}{" ..." if len(r) > 24 else ""}')


def main():
    if not ARGS or ARGS[0] == 'ports':
        print('in ', rtmidi.MidiIn().get_ports())
        print('out', rtmidi.MidiOut().get_ports())
        return
    mi, mo = open_ports()
    cmd = ARGS[0]
    if cmd == 'raw':
        show(exchange(mi, mo, [int(x, 16) for x in ARGS[1:]]))
    elif cmd in ('req', 'save'):
        func = int(ARGS[1], 16)
        rest = ARGS[3:] if cmd == 'save' else ARGS[2:]
        msg = [0xF0, 0x42, 0x30 | CH, 0x19, func, *[int(x, 16) for x in rest], 0xF7]
        replies = exchange(mi, mo, msg)
        show(replies)
        if cmd == 'save':
            with open(ARGS[2], 'wb') as f:
                for r in replies:
                    f.write(r)
            print('saved', ARGS[2])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
