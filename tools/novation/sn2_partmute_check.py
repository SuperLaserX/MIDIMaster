"""Live check of the SuperNova II part mutes (performance byte 19), edit buffer only.

  python -I sn2_partmute_check.py OUTDIR [--port "2- Supernova"] [--ch 16]

1. Back up the current performance, program and global (requests 08, 03, 10) to OUTDIR.
2. Send packed NRPN 113 = 63 (mute part 1) on the global channel, read the performance back
   (byte 19 bit 0 expected set); then 113 = 55 (un-mute), read it back (bit 0 expected clear).
3. Send the backed-up performance (05, 1B, 20) back to the edit buffer and compare performance,
   program and global with the backup byte for byte.
No memory writes (no store, no global write); Memory protect is not touched.
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


PORT = opt('--port', '2- Supernova')
CH = int(opt('--ch', '16')) - 1
OUT = ARGS[0]


def open_ports():
    mi, mo = rtmidi.MidiIn(), rtmidi.MidiOut()
    low = PORT.lower()
    ins = [i for i, n in enumerate(mi.get_ports()) if n.lower().startswith(low + ' ') or n.lower() == low]
    outs = [i for i, n in enumerate(mo.get_ports()) if n.lower().startswith(low + ' ') or n.lower() == low]
    if not ins or not outs:
        sys.exit(f'port {PORT!r} not found: {mi.get_ports()} {mo.get_ports()}')
    mi.open_port(ins[0])
    mo.open_port(outs[0])
    mi.ignore_types(sysex=False, timing=True, active_sense=True)
    return mi, mo


def collect(mi, quiet=0.8, first=3.0):
    out, buf = [], []
    t0 = last = time.time()
    while True:
        m = mi.get_message()
        if m:
            data = m[0]
            if data and data[0] != 0xF0 and not buf and data[0] >= 0x80:
                last = time.time()
                continue
            buf.extend(data)
            last = time.time()
            if buf and buf[0] == 0xF0 and buf[-1] == 0xF7:
                out.append(bytes(buf))
                buf = []
            continue
        if time.time() - (last if out or buf else t0) > (quiet if out or buf else first):
            return out
        time.sleep(0.002)


def request(mi, mo, typ):
    while mi.get_message():
        pass
    mo.send_message([0xF0, 0x00, 0x20, 0x29, 0x01, 0x22, 0x7F, typ, 0xF7])
    return collect(mi)


def perf_main(msgs):
    return next(m for m in msgs if m[7] == 0x05)


def save(name, msgs):
    with open(f'{OUT}/{name}', 'wb') as f:
        for m in msgs:
            f.write(m)


def main():
    mi, mo = open_ports()
    perf0 = request(mi, mo, 0x08)
    prog0 = request(mi, mo, 0x03)
    glob0 = request(mi, mo, 0x10)
    save('backup_perf.syx', perf0)
    save('backup_prog.syx', prog0)
    save('backup_global.syx', glob0)
    p = perf_main(perf0)
    print('backup: perf', len(perf0), 'messages, name', p[8:24].decode('latin1'), 'byte16', hex(p[8 + 16]), 'byte19', hex(p[8 + 19]),
          '| prog', len(prog0), '| global', len(glob0))
    results = []
    for v, label in ((63, 'mute part 1'), (55, 'un-mute part 1')):
        mo.send_message([0xB0 | CH, 99, 0])
        mo.send_message([0xB0 | CH, 98, 113])
        mo.send_message([0xB0 | CH, 6, v])
        time.sleep(0.4)
        msgs = request(mi, mo, 0x08)
        q = perf_main(msgs)
        save(f'after_{v}.syx', msgs)
        diff = [i for i in range(8, len(q) - 1) if q[i] != p[i]]
        print(f'packed NRPN 113 = {v} ({label}): byte19 = {q[8 + 19]:#04x}, byte16 = {q[8 + 16]:#04x}, changed data bytes {[i - 8 for i in diff]}')
        results.append((v, q[8 + 19], [i - 8 for i in diff]))
    # restore: the backed-up performance edit buffer (05, 1B, 20)
    for m in perf0:
        if m[7] in (0x05, 0x1B, 0x20):
            mo.send_message(list(m))
            time.sleep(0.5)
    time.sleep(0.5)
    perf1 = request(mi, mo, 0x08)
    prog1 = request(mi, mo, 0x03)
    glob1 = request(mi, mo, 0x10)
    save('restored_perf.syx', perf1)
    save('restored_prog.syx', prog1)
    save('restored_global.syx', glob1)
    same = lambda a, b: len(a) == len(b) and all(x == y for x, y in zip(a, b))
    print('restored: perf equal', same(perf0, perf1), '| prog equal', same(prog0, prog1), '| global equal', same(glob0, glob1))
    ok = results[0][1] & 1 == 1 and results[1][1] & 1 == 0 and same(perf0, perf1) and same(prog0, prog1) and same(glob0, glob1)
    print('RESULT', 'OK' if ok else 'CHECK')


if __name__ == '__main__':
    main()
