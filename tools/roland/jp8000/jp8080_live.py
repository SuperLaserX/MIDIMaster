"""Live check, on a JP-8080, of the code the JP-8080 and JP-8000 editors share (2026-11-27).

usage: python -I jp8080_live.py [--port "MIDI (OCTA-CAPTURE)"] OUTDIR

1. Back up: system (3 blocks), temporary performance (4 blocks), both temporary patches, motion A[1].
2. Read only: the identity reply and the same blocks; motion A[1]'s raw DT1 replies are saved
   (OUTDIR/motion_a1_replies.syx) for the editor's motion reader to decode (check in node).
3. One write test, in the temporary performance: TEMPO (01 00 00 22/23, two bytes) set to 251
   (outside the firmware's 20-250: should be refused), then 250 (should be taken), then the
   original value put back.
4. Everything read again and compared with the backup byte for byte.
Nothing is written to memory; Memory Protect is not touched.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
args = sys.argv[1:]
outdir = args[-1]
sys.argv = [sys.argv[0], '--port', 'MIDI (OCTA-CAPTURE)', '--model', '00 06']
if '--port' in args:
    sys.argv[2] = args[args.index('--port') + 1]
import jvlive as J  # noqa: E402

BLOCKS = [
    ('system', [0, 0, 0, 0], 0x19), ('motion loops', [0, 0, 0x20, 0], 4), ('tx/rx', [0, 0, 0x30, 0], 0x2A),
    ('perf common', [1, 0, 0, 0], 0x25), ('voice mod', [1, 0, 8, 0], 0x29),
    ('part upper', [1, 0, 0x10, 0], 8), ('part lower', [1, 0, 0x11, 0], 8),
    ('patch upper', [1, 0, 0x40, 0], 0xF8), ('patch lower', [1, 0, 0x42, 0], 0xF8),
]


def read_all(mi, mo):
    out = {}
    for name, addr, size in BLOCKS:
        data, got, _ = J.read_block(mi, mo, addr, size)
        if got != size:
            sys.exit(f"incomplete read of {name}: {got} of {size}")
        out[name] = bytes(data)
    return out


def read_motion(mi, mo):
    reps = J.exchange(mi, mo, [J.rq1([9, 0, 0, 0], J.a2i([0, 0x40, 0, 0]))], quiet=0.8, total=10.0)
    return [bytes(r) for r in reps if r[:6] == [0xF0, 0x41, J.DEV, 0, 6, 0x12]]


def tempo(perf):
    return (perf[0x22] & 1) * 128 + (perf[0x23] & 127)


def main():
    os.makedirs(outdir, exist_ok=True)
    mi, mo = J.open_ports()
    print('port', J.PORT)
    ident = J.exchange(mi, mo, [[0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]])
    print('identity', [J.hx(x) for x in ident])
    backup = read_all(mi, mo)
    motion = read_motion(mi, mo)
    with open(os.path.join(outdir, 'backup.syx'), 'wb') as f:
        for name, addr, size in BLOCKS:
            f.write(bytes(J.dt1(addr, backup[name])))
        for r in motion:
            f.write(r)
    with open(os.path.join(outdir, 'motion_a1_replies.syx'), 'wb') as f:
        for r in motion:
            f.write(r)
    print('backup', {k: len(v) for k, v in backup.items()}, 'motion A[1]', len(motion), 'messages',
          sum(len(r) - 12 for r in motion), 'bytes')
    t0 = tempo(backup['perf common'])
    print('TEMPO now', t0)
    results = []
    for v, should_take in ((251, False), (250, True)):
        J.exchange(mi, mo, [J.dt1([1, 0, 0, 0x22], [v >> 7, v & 127])], quiet=0.2, total=1.0)
        time.sleep(0.1)
        got = tempo(J.read_block(mi, mo, [1, 0, 0, 0], 0x25)[0])
        ok = (got == v) if should_take else (got != v)
        results.append((v, got, ok))
        print(f'TEMPO {v}: reads back {got} ->', 'taken' if got == v else 'refused', 'OK' if ok else 'UNEXPECTED')
    J.exchange(mi, mo, [J.dt1([1, 0, 0, 0x22], [t0 >> 7, t0 & 127])], quiet=0.2, total=1.0)
    time.sleep(0.2)
    after = read_all(mi, mo)
    motion2 = read_motion(mi, mo)
    diffs = []
    for name, _, _ in BLOCKS:
        a, b = backup[name], after[name]
        diffs += [f'{name} {i:02x}h: {a[i]:02x}->{b[i]:02x}' for i in range(len(a)) if a[i] != b[i]]
    same_motion = b''.join(motion) == b''.join(motion2)
    print('compare with backup:', 'equal byte for byte' if not diffs else diffs, '| motion A[1]', 'equal' if same_motion else 'DIFFERENT')
    with open(os.path.join(outdir, 'result.txt'), 'w') as f:
        f.write(f'identity {[J.hx(x) for x in ident]}\n')
        f.write(f'tempo before {t0}; ' + '; '.join(f'{v}: read back {g} ({"ok" if k else "UNEXPECTED"})' for v, g, k in results) + '\n')
        f.write(f'backup compare: {"equal" if not diffs else diffs}; motion A[1] {"equal" if same_motion else "different"}\n')


main()
