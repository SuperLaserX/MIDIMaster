#!/usr/bin/env python3
"""Does the SYSTEM-8 save a whole bank sent between the patch-bank markers? (phase 5, needs the user at the display and
one power cycle)

What the OS code says (OS 1.32, doc "Saving over MIDI"): 70 20 01 01 [n] opens the "Receiving" screen; it counts the
patches written since they were last saved (all slots), which must all be in one slot and number n; after
70 20 01 02 [flag] it shows "Writing!" and saves that slot's 64 patches into the flash. Any patch written into another
slot since the last save (or power-on) stops it. The phase-4 tests had such writes (browser stores into the H-8 of
slots 1-3 before test 1; JUPITER-8 H-8 before the banks of test 2), which would explain why they kept nothing.

Run it right after a power cycle (no other writes since), with nothing else on the ports:
  python -I keep_test.py send BACKUPDIR     the SYSTEM-8 bank from BACKUPDIR/slot0.syx with H-8 renamed "MM KEEP TEST",
                                            between the markers (64 / flag 1) and nothing else; waits 25 s; reads H-8.
                                            Watch the display: "Receiving", then "Writing!"?
  (the user switches the SYSTEM-8 off and on)
  python -I keep_test.py check              H-8's name: "MM KEEP TEST" = the bank was saved over MIDI
  python -I keep_test.py restore BACKUPDIR  the bank as backed up, the same way (only needed when check found the new
                                            name); then backup.py --slots=0 --no-edit and restore.py compare
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s8midi import S8, dt1, parse_dt1

A = lambda b0, b1=0, b2=0, b3=0: b0 << 21 | b1 << 14 | b2 << 7 | b3
BANK_START, BANK_END = A(0x70, 0x20, 1, 1), A(0x70, 0x20, 1, 2)
H8 = 63
NAME = A(0x20 + (H8 >> 3), H8 & 7) + 0x80  # SYSTEM-8 H-8, name leaf
WAIT = 25.0


def messages(path):
    raw = open(path, 'rb').read()
    return [m + b'\xf7' for m in raw.split(b'\xf7') if m.startswith(b'\xf0')]


def renamed(msgs, text):
    want = []
    for ch in text.ljust(16)[:16]:
        want += [ord(ch) >> 4, ord(ch) & 15]
    out = []
    for m in msgs:
        a, data = parse_dt1(m)
        data = list(data)
        for i in range(len(data)):
            k = a + i - NAME
            if 0 <= k < 32:
                data[i] = want[k]
        out.append(bytes(dt1(a, data)))
    return out


def send_bank(s, msgs):
    allm = [bytes(dt1(BANK_START, [64]))] + msgs + [bytes(dt1(BANK_END, [1]))]
    for n, m in enumerate(allm):
        s.send(list(m))
        time.sleep(0.004 + len(m) * 0.00002)
        if n % 200 == 0:
            s.drain(0.02)
    print(f'{len(allm)} messages sent (markers + {len(msgs)}); waiting {WAIT:.0f} s for the save', flush=True)
    s.drain(WAIT)


def read_name(s):
    data, _ = s.read(NAME, 32, wait=1.5)
    return ''.join(chr((data[2 * i] << 4) | data[2 * i + 1]) for i in range(min(16, len(data) // 2))).rstrip()


def main():
    cmd = sys.argv[1]
    s = S8(listen=('SYSTEM-8 CTRL',))
    try:
        s.drain(0.3)
        if cmd in ('send', 'send2'):
            bank = messages(os.path.join(sys.argv[2], 'slot0.syx'))
            print('H-8 before:', read_name(s), flush=True)
            if '--delay' in sys.argv:
                d = float(sys.argv[sys.argv.index('--delay') + 1])
                print(f'starting in {d:.0f} s', flush=True)
                time.sleep(d)
            if cmd == 'send2':
                # the questions Roland's plugin asks before it sends a bank: device type, banks, patches per bank,
                # slots, the four slot records (read-only)
                for a, d in [(A(0x70, 0, 2, 0), 0), (A(0x70, 0, 2, 1), 0), (A(0x70, 0, 2, 2), 0), (A(0x70, 0, 2, 3), 0)] + [(A(0x70, 0, 1, 0), k) for k in range(4)]:
                    s.send(list(dt1(a, [d])))
                    got = s.drain(0.3)
                    print('query', '%02X %02X %02X %02X' % (a >> 21, (a >> 14) & 127, (a >> 7) & 127, a & 127), '->', [g[1].hex(' ') for g in got], flush=True)
            send_bank(s, renamed(bank, 'MM KEEP TEST'))
        elif cmd == 'restore':
            send_bank(s, messages(os.path.join(sys.argv[2], 'slot0.syx')))
        print(f'SYSTEM-8 H-8: "{read_name(s)}"', flush=True)
    finally:
        s.close()


if __name__ == '__main__':
    main()
