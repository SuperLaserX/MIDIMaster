"""Put a JV-2080 back to a snapshot written by the live tests (re/jv2080/live_backup.json):
patch mode, the given patch selection, then the temporary patch and performance contents.

usage: python3 -I jv_restore.py <live_backup.json> [expansion slot 0-7 of the selected patch] [--port "2- JV2080"]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jvlive as J  # noqa: E402

SNAP = json.load(open(J.ARGS[0]))
PATCH = [(J.a2i([3, 0, 0, 0]), 74)] + [(J.a2i([3, 0, 0x10 + 2 * t, 0]), 129) for t in range(4)]
PERF = [(J.a2i([1, 0, 0, 0]), 68)] + [(J.a2i([1, 0, 0x10 + p, 0]), 26) for p in range(16)]


def restore_blocks(mi, mo, layout, data, label):
    off = 0
    same = True
    for addr, size in layout:
        want = bytes(data[off:off + size])
        cur, _, _ = J.read_block(mi, mo, J.i2a(addr), size)
        if cur != want:
            same = False
            J.exchange(mi, mo, [J.dt1(J.i2a(addr), list(want))], quiet=0.2)
            again, _, _ = J.read_block(mi, mo, J.i2a(addr), size)
            print(f'{label} {J.hx(J.i2a(addr))}: rewritten', 'OK' if again == want else 'STILL DIFFERENT')
        off += size
    if same:
        print(label, 'unchanged')


def main():
    mi, mo = J.open_ports()
    sysw = SNAP['system']
    ch_patch, ch_ctrl = sysw[0x1d], sysw[0x1c]
    # performance first (performance mode, user performance n), then patch mode and the patch
    J.exchange(mi, mo, [J.dt1([0, 0, 0, 0], [0])], quiet=0.3)
    time.sleep(0.6)
    perf_no = sysw[1]
    bank = (80, 0, perf_no) if perf_no < 32 else (81, 0, perf_no - 64) if perf_no < 96 else (81, 1, perf_no - 96)
    J.exchange(mi, mo, [[0xb0 | ch_ctrl, 0, bank[0]], [0xb0 | ch_ctrl, 0x20, bank[1]], [0xc0 | ch_ctrl, bank[2]]], quiet=0.05)
    time.sleep(0.6)
    restore_blocks(mi, mo, PERF, SNAP['performance'], 'performance')
    J.exchange(mi, mo, [J.dt1([0, 0, 0, 0], [1])], quiet=0.3)
    time.sleep(0.6)
    t, i, n = sysw[2], sysw[3], (sysw[4] << 4) | sysw[5]
    if t == 0:
        msb, lsb = {1: (80, 0), 2: (82, 0)}.get(i, (81, i - 3))
    else:
        msb, lsb = 84, int(J.ARGS[1]) * 2 + (n >> 7) if len(J.ARGS) > 1 else (n >> 7)
    J.exchange(mi, mo, [[0xb0 | ch_patch, 0, msb], [0xb0 | ch_patch, 0x20, lsb], [0xc0 | ch_patch, n & 127]], quiet=0.05)
    time.sleep(0.6)
    restore_blocks(mi, mo, PATCH, SNAP['patch'], 'patch')
    if sysw[0] != 1:
        J.exchange(mi, mo, [J.dt1([0, 0, 0, 0], [sysw[0]])], quiet=0.3)
        time.sleep(0.6)
    cur, _, _ = J.read_block(mi, mo, [0, 0, 0, 0], 0x62)
    diff = [k for k in range(0x62) if cur[k] != sysw[k]]
    print('system', 'unchanged' if not diff else f'differs at {[hex(k) for k in diff]}: {[cur[k] for k in diff]} vs {[sysw[k] for k in diff]}')


if __name__ == '__main__':
    main()
