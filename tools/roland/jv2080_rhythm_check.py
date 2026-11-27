"""Hardware check of the JV-2080 editor's rhythm set selection and of the bytes named from Roland's
address map (python-rtmidi). Run only after the port is confirmed.

It backs up system byte 00, the temporary performance (common and parts), the temporary rhythm set
(02 09 00 00, all 64 keys) and the system block; then:
  1. puts each preset rhythm set on part 10 with a DT1 to 01 00 19 02 [group type, ID, number] (as
     the editor's Play / Edit do), reads the whole set back from 02 09 00 00 and compares it with the
     set decoded from the v1.02 flash (tools/roland/jv2080_rhythm.py);
  2. the two user sets: the name at 02 09 00 00 must be the one in 10 40 / 10 41;
  3. each expansion board number with rhythm sets: after PR-A 001, board n set 1 must read
     "JV rhythm" when the board is installed (the name stays PopDrumSet 1 when it is not);
  4. part 13h-18h (JV-1080 / XP-80 bytes): a DT1 with other values must read back as the defaults
     3 0 0 0 8 0 (not stored); part 19h (Output select), performance 40h and system 2Bh / 58h
     must read back as written (stored);
then writes everything back and verifies it byte for byte. Nothing goes to user memory.

usage: python3 -I jv2080_rhythm_check.py <jv2080_v102.bin> [--port "2- JV2080"] [--dev 10]
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jvlive as J  # noqa: E402  (reads --port / --dev from the command line)
import jv2080_rhythm as R  # noqa: E402

PART10 = [0x01, 0x00, 0x19, 0x00]
RHY = [0x02, 0x09, 0x00, 0x00]


def read(mi, mo, addr, size):
    data, got, _ = J.read_block(mi, mo, addr, size)
    if got != size:
        raise SystemExit(f'read {J.hx(addr)} size {size}: got {got} bytes')
    return data


def write(mo, addr, data):
    mo.send_message(J.dt1(addr, list(data)))
    time.sleep(0.05)


def read_rhythm(mi, mo):
    name = read(mi, mo, RHY, 12)
    notes = [read(mi, mo, [0x02, 0x09, key, 0x00], 58) for key in range(35, 99)]
    return name, notes


def select(mo, typ, gid, n):
    write(mo, [0x01, 0x00, 0x19, 0x02], [typ, gid, n >> 4, n & 15])
    time.sleep(0.4)


def main():
    fw = open(J.ARGS[0], 'rb').read()
    mi, mo = J.open_ports()
    results = []

    # backups
    sys0 = read(mi, mo, [0, 0, 0, 0], 0x62)
    perf_common = read(mi, mo, [0x01, 0x00, 0x00, 0x00], 0x44)
    parts = [read(mi, mo, [0x01, 0x00, 0x10 + p, 0x00], 0x1A) for p in range(16)]
    rhythm0 = read_rhythm(mi, mo)
    print('backed up: system, temporary performance, temporary rhythm set', rhythm0[0])
    if sys0[0] != 0:
        print('note: the JV-2080 is switched to performance mode for the check and back afterwards')
    try:
        write(mo, [0, 0, 0, 0], [0])  # performance mode
        time.sleep(0.8)
        # 1. presets
        for i, (g, ptr) in enumerate(R.GROUPS):
            for n, rec in enumerate(R.group_sets(fw, ptr)):
                name, notes = R.decode(fw, rec)
                select(mo, 0, 3 + i, n)
                got = read_rhythm(mi, mo)
                ok = got[0] == name and all(got[1][k] == notes[k] for k in range(64))
                results.append((f'{g} {n + 1} {name.decode()}', ok))
        # 2. user sets
        for n in range(2):
            want = read(mi, mo, [0x10, 0x40 + n, 0x00, 0x00], 12)
            select(mo, 0, 1, n)
            results.append((f'USER {n + 1} {want.decode()}', read(mi, mo, RHY, 12) == want))
        # 3. boards
        found = []
        for board in [5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19]:  # boards with rhythm sets
            select(mo, 0, 3, 0)
            select(mo, 2, board, 0)
            if read(mi, mo, RHY, 12).decode().strip() == 'JV rhythm':
                found.append(board)
        results.append((f'boards with rhythm sets answering: {found}', True))
        # 4. bytes named from the address map
        write(mo, [0x01, 0x00, 0x10, 0x13], [5, 1, 1, 3, 4, 2])
        results.append(('part 1 13h-18h not stored (defaults 3 0 0 0 8 0)', list(read(mi, mo, [0x01, 0x00, 0x10, 0x13], 6)) == [3, 0, 0, 0, 8, 0]))
        new19 = (parts[0][0x19] + 1) % 3
        write(mo, [0x01, 0x00, 0x10, 0x19], [new19])
        results.append(('part 1 19h Output select stored', read(mi, mo, [0x01, 0x00, 0x10, 0x19], 1)[0] == new19))
        write(mo, [0x01, 0x00, 0x00, 0x40], [1 - perf_common[0x40]])
        results.append(('performance 40h stored', read(mi, mo, [0x01, 0x00, 0x00, 0x40], 1)[0] == 1 - perf_common[0x40]))
        write(mo, [0, 0, 0, 0x2B], [1 - sys0[0x2B]])
        write(mo, [0, 0, 0, 0x58], [(sys0[0x58] + 1) % 33])
        back = read(mi, mo, [0, 0, 0, 0x2B], 0x2E)
        results.append(('system 2Bh and 58h stored', back[0] == 1 - sys0[0x2B] and back[0x58 - 0x2B] == (sys0[0x58] + 1) % 33))
    finally:
        # restore: system 06h-61h (00h-05h were not changed but byte 00), performance common and
        # parts (part 10 reloads its set), then the temporary rhythm set as it was (unsaved edits too)
        write(mo, [0, 0, 0, 0x06], sys0[0x06:0x62])
        write(mo, [0x01, 0x00, 0x00, 0x00], perf_common)
        for p in range(16):
            write(mo, [0x01, 0x00, 0x10 + p, 0x00], parts[p])
        time.sleep(0.5)
        write(mo, RHY, rhythm0[0])
        for k in range(64):
            write(mo, [0x02, 0x09, 35 + k, 0x00], rhythm0[1][k])
        if sys0[0] != 0:
            write(mo, [0, 0, 0, 0], sys0[0:1])
            time.sleep(1.0)
    same = (read(mi, mo, [0, 0, 0, 0], 0x62) == sys0 and read(mi, mo, [0x01, 0x00, 0x00, 0x00], 0x44) == perf_common
            and all(read(mi, mo, [0x01, 0x00, 0x10 + p, 0x00], 0x1A) == parts[p] for p in range(16)) and read_rhythm(mi, mo) == rhythm0)
    for what, ok in results:
        print('ok  ' if ok else 'FAIL', what)
    print('restored byte for byte' if same else 'RESTORE DIFFERS: check the unit')


if __name__ == '__main__':
    main()
