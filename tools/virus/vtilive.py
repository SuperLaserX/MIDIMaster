"""Talk to an Access Virus TI / TI2 over its USB MIDI ports (python-rtmidi) for hardware checks.

usage:
  python -I vtilive.py ports
  python -I vtilive.py id                      universal identity request
  python -I vtilive.py raw HEX...              send any bytes, print the replies (on every Virus input)
  python -I vtilive.py req TYPE [DATA...]      send F0 00 20 33 01 dd TYPE DATA F7, print the replies
  python -I vtilive.py save OUT.syx TYPE [DATA...]   same, and write the replies to a file
  python -I vtilive.py send IN.syx             send every message of a .syx file (edit buffers only!)
  python -I vtilive.py listen SECONDS          print what arrives on the Virus inputs
options: --port "Virus TI Synth" (the port to send on)  --dev 10 (device byte, 10 = omni)
         --quiet 0.6  --first 3  --listen "Virus TI Synth,Virus TI MIDI" (inputs to read)

TYPE and DATA are hex. Replies are printed as hex with the input port they came from.
Only requests and edit-buffer messages belong here: never send store/write or OS update messages.
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


PORT = opt('--port', 'Virus TI Synth')
LISTEN = [s.strip() for s in opt('--listen', 'Virus TI Synth,Virus TI MIDI').split(',') if s.strip()]
DEV = int(opt('--dev', '10'), 16)
QUIET = float(opt('--quiet', '0.6'))
FIRST = float(opt('--first', '3'))


def find(names, want):
    low = want.lower()
    return [i for i, n in enumerate(names) if n.lower().startswith(low + ' ') or n.lower() == low]


def open_ports(send=True):
    ins = []
    for name in LISTEN:
        mi = rtmidi.MidiIn()
        idx = find(mi.get_ports(), name)
        if not idx:
            print(f'(input {name!r} not found)')
            continue
        try:
            mi.open_port(idx[0])
        except Exception as e:  # held by another program (e.g. the browser)
            print(f'(input {name!r} busy: {e})')
            continue
        mi.ignore_types(sysex=False, timing=True, active_sense=True)
        ins.append((name, mi, []))
    mo = None
    if send:
        mo = rtmidi.MidiOut()
        idx = find(mo.get_ports(), PORT)
        if not idx:
            sys.exit(f'output {PORT!r} not found')
        mo.open_port(idx[0])
    return ins, mo


def collect(ins, quiet=None, first=None):
    """Collect replies from every input until QUIET seconds pass without one (FIRST before the first)."""
    quiet = QUIET if quiet is None else quiet
    first = FIRST if first is None else first
    out = []
    t0 = last = time.time()
    while True:
        got = False
        for name, mi, buf in ins:
            m = mi.get_message()
            if not m:
                continue
            got = True
            data = m[0]
            if data and data[0] != 0xF0 and not buf and data[0] >= 0x80:
                out.append((name, bytes(data)))
                continue
            buf.extend(data)
            if buf and buf[0] == 0xF0 and buf[-1] != 0xF7:
                continue
            out.append((name, bytes(buf)))
            buf.clear()
        if got:
            last = time.time()
            continue
        if time.time() - (last if out else t0) > (quiet if out else first):
            break
        time.sleep(0.002)
    return out


def drain(ins):
    for _, mi, buf in ins:
        while mi.get_message():
            pass
        buf.clear()


def exchange(ins, mo, msg, quiet=None, first=None):
    drain(ins)
    mo.send_message(msg)
    return collect(ins, quiet, first)


def hdr(typ):
    return [0xF0, 0x00, 0x20, 0x33, 0x01, DEV, typ]


def show(replies):
    for name, r in replies:
        print(f'[{name}] {len(r):5d} bytes: {r[:40].hex(" ")}{" ..." if len(r) > 40 else ""}')


def split_syx(raw):
    msgs, cur = [], None
    for b in raw:
        if b == 0xF0:
            cur = [b]
        elif cur is not None:
            cur.append(b)
            if b == 0xF7:
                msgs.append(cur)
                cur = None
    return msgs


def main():
    if not ARGS or ARGS[0] == 'ports':
        print('in ', rtmidi.MidiIn().get_ports())
        print('out', rtmidi.MidiOut().get_ports())
        return
    cmd = ARGS[0]
    if cmd == 'listen':
        ins, _ = open_ports(send=False)
        show(collect(ins, quiet=float(ARGS[1]) if len(ARGS) > 1 else 5, first=float(ARGS[1]) if len(ARGS) > 1 else 5))
        return
    ins, mo = open_ports()
    if cmd == 'id':
        show(exchange(ins, mo, [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]))
    elif cmd == 'raw':
        show(exchange(ins, mo, [int(x, 16) for x in ARGS[1:]]))
    elif cmd in ('req', 'save'):
        rest = ARGS[2:] if cmd == 'save' else ARGS[1:]
        msg = hdr(int(rest[0], 16)) + [int(x, 16) for x in rest[1:]] + [0xF7]
        replies = exchange(ins, mo, msg)
        show(replies)
        if cmd == 'save':
            with open(ARGS[1], 'wb') as f:
                for _, r in replies:
                    f.write(r)
            print('saved', ARGS[1])
    elif cmd == 'send':
        with open(ARGS[1], 'rb') as f:
            msgs = split_syx(f.read())
        drain(ins)
        for m in msgs:
            mo.send_message(m)
            time.sleep(0.05)
        print('sent', len(msgs), 'messages')
        show(collect(ins, first=1))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
