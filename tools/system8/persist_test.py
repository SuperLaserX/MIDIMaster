#!/usr/bin/env python3
"""Do DT1 writes into SYSTEM-8 user memory survive a power cycle? (phase 4, needs the user to power-cycle)

  python -I persist_test.py write BACKUPDIR   before the power cycle:
      1. the whole SYSTEM-8 bank (slot 0) from BACKUPDIR/slot0.syx with H-8 renamed "MM PERSIST BANK", between the
         patch-bank brackets Roland's plugin sends (70 20 01 01 [64] ... 70 20 01 02 [1]);
      2. then H-7 renamed "MM PERSIST PLAIN" by plain DT1 (the editor's Store);
      3. performance H-8 renamed "MM PERSIST PERF" by plain DT1 (the editor's performance Store);
      each read back.
  python -I persist_test.py check            after the power cycle: the three names as the unit reads them
  python -I persist_test.py restore BACKUPDIR  slot 0 between brackets (flag 1) + the name of performance H-8, read back

Test 2 (the patch-bank brackets with flag 0, as Roland's plugin and the editor's install send them):
  python -I persist_test.py write2 BACKUPDIR  (BACKUPDIR with slot0-2 and perf, e.g. backup.py --slots=0,1,2)
      1. plain DT1 before the brackets: JUPITER-8 (slot 1) H-8 "MM PLAIN BEFORE", performance H-8 "MM PERF BEFORE";
      2. the SH-101 bank (slot 2) between the brackets, flag 0, H-8 "MM FLAG0 SLOT2";
      3. the SYSTEM-8 bank (slot 0) between the brackets, flag 0, H-8 "MM FLAG0 SLOT0";
      4. plain DT1 after them: SYSTEM-8 H-7 "MM PLAIN AFTER".
  python -I persist_test.py check2            the five names
  python -I persist_test.py restore2 BACKUPDIR  the two names by plain DT1, then slots 2 and 0 between brackets (flag 0)

Only the names change (2 nibbles per character at patch offset 0x80, performance leaf 10).
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s8midi import S8, dt1, parse_dt1

A = lambda b0, b1=0, b2=0, b3=0: b0 << 21 | b1 << 14 | b2 << 7 | b3
BANK_START, BANK_END = A(0x70, 0x20, 1, 1), A(0x70, 0x20, 1, 2)
H7, H8 = 62, 63


def patch_addr(p, slot=0):  # patch struct of patch p in slot 0-3
    b, i = p >> 3, p & 7
    return A(0x20 + b, i) if slot == 0 else A(0x40 + b, i) if slot == 1 else A(0x0C + slot, (b << 4) + i)


def perf_name_addr(n):  # performance n, leaf 10 (name)
    return A(0x10 + (n >> 3), (n & 7) << 4) + 10 * 0x800


def messages(path):
    raw = open(path, 'rb').read()
    return [m + b'\xf7' for m in raw.split(b'\xf7') if m.startswith(b'\xf0')]


def nib_name(text):
    s = text.ljust(16)[:16]
    out = []
    for ch in s:
        out += [ord(ch) >> 4, ord(ch) & 15]
    return out


def renamed(msgs, name_addr, text):
    """The messages with the 16 name characters at name_addr replaced (wherever a DT1 covers them)."""
    want = nib_name(text)
    out = []
    for m in msgs:
        a, data = parse_dt1(m)
        data = list(data)
        for i in range(len(data)):
            k = a + i - name_addr
            if 0 <= k < 32:
                data[i] = want[k]
        out.append(bytes(dt1(a, data)))
    return out


def send_all(s, msgs):
    for m in msgs:
        s.send(list(m))
        time.sleep(0.004 + len(m) * 0.00002)


def read_name(s, addr):
    data, _ = s.read(addr, 32, wait=1.5)
    return ''.join(chr((data[2 * i] << 4) | data[2 * i + 1]) for i in range(min(16, len(data) // 2))).rstrip()


def report(s):
    return {'SYSTEM-8 H-8 (bank between brackets)': read_name(s, patch_addr(H8) + 0x80),
            'SYSTEM-8 H-7 (plain DT1)': read_name(s, patch_addr(H7) + 0x80),
            'performance H-8 (plain DT1)': read_name(s, perf_name_addr(63))}


def name_msgs(d, area, addr):
    return [m for m in messages(os.path.join(d, area + '.syx')) if parse_dt1(m)[0] == addr]


def bracketed(msgs, flag):
    return [bytes(dt1(BANK_START, [64]))] + msgs + [bytes(dt1(BANK_END, [flag]))]


def report2(s):
    return {'JUPITER-8 H-8 (plain, before the brackets)': read_name(s, patch_addr(H8, 1) + 0x80),
            'performance H-8 (plain, before the brackets)': read_name(s, perf_name_addr(63)),
            'SH-101 H-8 (bank between brackets, flag 0)': read_name(s, patch_addr(H8, 2) + 0x80),
            'SYSTEM-8 H-8 (bank between brackets, flag 0)': read_name(s, patch_addr(H8, 0) + 0x80),
            'SYSTEM-8 H-7 (plain, after the brackets)': read_name(s, patch_addr(H7, 0) + 0x80)}


def main():
    cmd = sys.argv[1]
    s = S8(listen=('SYSTEM-8 CTRL',))
    try:
        s.drain(0.3)
        if cmd == 'write':
            d = sys.argv[2]
            bank = messages(os.path.join(d, 'slot0.syx'))
            bank = renamed(bank, patch_addr(H8) + 0x80, 'MM PERSIST BANK')
            send_all(s, [bytes(dt1(BANK_START, [64]))] + bank + [bytes(dt1(BANK_END, [1]))])
            s.drain(1.0)
            h7 = [m for m in messages(os.path.join(d, 'slot0.syx')) if parse_dt1(m)[0] == patch_addr(H7) + 0x80]
            send_all(s, renamed(h7, patch_addr(H7) + 0x80, 'MM PERSIST PLAIN'))
            pf = [m for m in messages(os.path.join(d, 'perf.syx')) if parse_dt1(m)[0] == perf_name_addr(63)]
            send_all(s, renamed(pf, perf_name_addr(63), 'MM PERSIST PERF'))
            s.drain(0.5)
        elif cmd == 'restore':
            d = sys.argv[2]
            bank = messages(os.path.join(d, 'slot0.syx'))
            send_all(s, [bytes(dt1(BANK_START, [64]))] + bank + [bytes(dt1(BANK_END, [1]))])
            pf = [m for m in messages(os.path.join(d, 'perf.syx')) if parse_dt1(m)[0] == perf_name_addr(63)]
            send_all(s, pf)
            s.drain(0.5)
        elif cmd == 'write2':
            d = sys.argv[2]
            send_all(s, renamed(name_msgs(d, 'slot1', patch_addr(H8, 1) + 0x80), patch_addr(H8, 1) + 0x80, 'MM PLAIN BEFORE'))
            send_all(s, renamed(name_msgs(d, 'perf', perf_name_addr(63)), perf_name_addr(63), 'MM PERF BEFORE'))
            s.drain(0.5)
            send_all(s, bracketed(renamed(messages(os.path.join(d, 'slot2.syx')), patch_addr(H8, 2) + 0x80, 'MM FLAG0 SLOT2'), 0))
            s.drain(1.0)
            send_all(s, bracketed(renamed(messages(os.path.join(d, 'slot0.syx')), patch_addr(H8, 0) + 0x80, 'MM FLAG0 SLOT0'), 0))
            s.drain(1.0)
            send_all(s, renamed(name_msgs(d, 'slot0', patch_addr(H7, 0) + 0x80), patch_addr(H7, 0) + 0x80, 'MM PLAIN AFTER'))
            s.drain(0.5)
        elif cmd == 'restore2':
            d = sys.argv[2]
            send_all(s, name_msgs(d, 'slot1', patch_addr(H8, 1) + 0x80) + name_msgs(d, 'perf', perf_name_addr(63)))
            s.drain(0.5)
            send_all(s, bracketed(messages(os.path.join(d, 'slot2.syx')), 0))
            s.drain(1.0)
            send_all(s, bracketed(messages(os.path.join(d, 'slot0.syx')), 0))
            s.drain(1.0)
        for k, v in (report2(s) if cmd.endswith('2') else report(s)).items():
            print(f'{k}: "{v}"', flush=True)
    finally:
        s.close()


if __name__ == '__main__':
    main()
