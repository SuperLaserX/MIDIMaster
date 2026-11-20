"""Talk to a Novation SuperNova II over MIDI (python-rtmidi) for hardware checks.

usage:
  python -I sn2live.py ports
  python -I sn2live.py id                      universal identity request
  python -I sn2live.py raw HEX...              send any bytes, print the replies
  python -I sn2live.py req TYPE [DATA...]      send F0 00 20 29 01 22 dd TYPE DATA F7, print the replies
  python -I sn2live.py save OUT.syx TYPE [DATA...]   same, and write the replies to a file
options: --port "2- SuperNova"  --dev 7f (device byte)  --quiet 0.6  --first 3

TYPE and DATA are hex. Replies are printed as hex.
Only requests and edit-buffer messages belong here: nothing in this tool writes memory.
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


PORT = opt('--port', '2- SuperNova')
DEV = int(opt('--dev', '7f'), 16)
QUIET = float(opt('--quiet', '0.6'))
FIRST = float(opt('--first', '3'))
MODEL = 0x22


def open_ports():
    mi, mo = rtmidi.MidiIn(), rtmidi.MidiOut()
    low = PORT.lower()
    ins = [i for i, n in enumerate(mi.get_ports()) if n.lower().startswith(low + ' ') or n.lower() == low]
    outs = [i for i, n in enumerate(mo.get_ports()) if n.lower().startswith(low + ' ') or n.lower() == low]
    if not ins or not outs:
        sys.exit(f'port {PORT!r} not found')
    mi.open_port(ins[0])
    mo.open_port(outs[0])
    mi.ignore_types(sysex=False, timing=True, active_sense=True)
    return mi, mo


def collect(mi, quiet=None, first=None):
    """Collect replies until QUIET seconds pass without one (FIRST before the first)."""
    quiet = QUIET if quiet is None else quiet
    first = FIRST if first is None else first
    out = []
    buf = []
    t0 = last = time.time()
    while True:
        m = mi.get_message()
        if m:
            data = m[0]
            if data and data[0] != 0xF0 and not buf and data[0] >= 0x80:
                out.append(bytes(data))  # channel message
                last = time.time()
                continue
            buf.extend(data)
            if buf and buf[0] == 0xF0 and buf[-1] != 0xF7:
                last = time.time()
                continue
            out.append(bytes(buf))
            buf = []
            last = time.time()
            continue
        if time.time() - (last if out or buf else t0) > (quiet if out or buf else first):
            break
        time.sleep(0.002)
    return out


def exchange(mi, mo, msg, quiet=None, first=None):
    while mi.get_message():
        pass
    mo.send_message(msg)
    return collect(mi, quiet, first)


def hdr(typ):
    return [0xF0, 0x00, 0x20, 0x29, 0x01, MODEL, DEV, typ]


def show(replies):
    for r in replies:
        print(f'{len(r):5d} bytes: {r[:32].hex(" ")}{" ..." if len(r) > 32 else ""}')


def main():
    if not ARGS or ARGS[0] == 'ports':
        print('in ', rtmidi.MidiIn().get_ports())
        print('out', rtmidi.MidiOut().get_ports())
        return
    mi, mo = open_ports()
    cmd = ARGS[0]
    if cmd == 'id':
        show(exchange(mi, mo, [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]))
    elif cmd == 'raw':
        show(exchange(mi, mo, [int(x, 16) for x in ARGS[1:]]))
    elif cmd in ('req', 'save'):
        rest = ARGS[2:] if cmd == 'save' else ARGS[1:]
        msg = hdr(int(rest[0], 16)) + [int(x, 16) for x in rest[1:]] + [0xF7]
        replies = exchange(mi, mo, msg)
        show(replies)
        if cmd == 'save':
            with open(ARGS[1], 'wb') as f:
                for r in replies:
                    f.write(r)
            print('saved', ARGS[1])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
