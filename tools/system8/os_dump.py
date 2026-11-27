#!/usr/bin/env python3
"""Dump the SYSTEM-8 OS plaintext (0x60000000 + 0x2CDA70) with the community SDK's INIT-BULK PLUG-OUT.

The SDK (re/system8/sdk/roland-plugout-reveng, MIT; docs vol. IV ch. 6 sections 7.12-7.14) installs a JX-3P
container whose region-0 init hook sends COUNT SysEx messages `F0 7D 01 <addr 8 nibbles> <LEN bytes as nibbles>
F7` through the OS MIDI router (to the `SYSTEM-8` USB port and DIN OUT), then runs the stock init. One install =
COUNT x LEN bytes (2048 x 32 = 64 KiB); the OS needs 45 installs (~45 s each). This is the Windows driver: the
SDK's bulk_loop.py / bulk_dump.py use amidi and sh. Hook addresses are those of OS 1.32 (the unit's).

  python -I tools/system8/os_dump.py OUT.bin [--slot 3] [--start 0x60000000] [--end 0x602CDA70] [--settle 3]
     (OUT.bin holds the bytes from --start: a new range needs a new file)
  python -I tools/system8/os_dump.py --install CODE8_N.DAT --slot 3     (reinstall a container, e.g. JUNO-106)

Resumable: OUT.bin is extended from its current length. Stops on any protocol error or a missing info answer
(the SDK reports hangs at "receiving plg" that needed a power cycle when the idle wait was skipped).
AFTERWARDS: reinstall the slot's own PLUG-OUT (--install) and restore its patches from a backup.
"""
import os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SDK = os.path.join(ROOT, 're', 'system8', 'sdk', 'roland-plugout-reveng')
sys.path.insert(0, os.path.join(SDK, 'tools'))
import mido  # noqa: E402
import plugout as P  # noqa: E402  (SDK: container format, addresses)
from plugout_tool import Session  # noqa: E402  (SDK: install protocol with the plugin's pacing)

ARM = r'C:\Program Files (x86)\GNU Tools ARM Embedded\6 2017-q2-update\bin'
JX3P = os.path.join(ROOT, 're', 'system8', 'plugins', 'JX-3P', 'Script')
WORK = os.path.join(ROOT, 're', 'system8', 'osdump', 'work')
OS_BASE, OS_SIZE = 0x60000000, 0x2CDA70
MSG = re.compile(rb'\xf0\x7d\x01([\x00-\x0f]{8})([\x00-\x0f]*)\xf7')
# OS 1.32 addresses (SDK make_init_bulk.sh)
DEFS = dict(CAVE_OFF=0x100, INIT_OFF=0x11823c, ROUTER=0x6000345c, DTORW=0x600753f4, MASK=0x1A20,
            CTOR=0x600753cc, SETSX=0x600754bc, WRAPM=0x600754c6, DTORM=0x600753e0)
BASE = 0x61800000


def port_name(names, want):
    for n in names:
        b = n.rsplit(' ', 1)[0] if n.rsplit(' ', 1)[-1].isdigit() else n
        if b == want:
            return n
    raise SystemExit(f'port {want!r} not found in {names}')


class Ports:
    """SDK Session port on SYSTEM-8 CTRL (install) + a capture of SYSTEM-8 (the hook's output)."""

    def __init__(self):
        self.out = mido.open_output(port_name(mido.get_output_names(), 'SYSTEM-8 CTRL'))
        self.inp = mido.open_input(port_name(mido.get_input_names(), 'SYSTEM-8 CTRL'))
        self.cap = mido.open_input(port_name(mido.get_input_names(), 'SYSTEM-8'))
        self.captured = []

    def send(self, msg):
        self.out.send(mido.Message('sysex', data=list(msg[1:-1])))

    def receive(self):
        self.drain_capture()
        return [bytes(m.bytes()) for m in self.inp.iter_pending() if m.type == 'sysex']

    def drain_capture(self):
        n = 0
        for m in self.cap.iter_pending():
            if m.type == 'sysex':
                self.captured.append(bytes(m.bytes())); n += 1
        return n

    def close(self):
        for p in (self.out, self.inp, self.cap):
            p.close()


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        raise SystemExit(f'{cmd[0]} failed:\n{r.stdout}\n{r.stderr}')
    return r.stdout


def build(src, count, length, out_dat, slot):
    """The INIT-BULK container for one chunk (make_init_bulk.sh in Python)."""
    os.makedirs(WORK, exist_ok=True)
    defs = dict(DEFS, SRC=src, LEN=length, COUNT=count)
    args = [os.path.join(ARM, 'arm-none-eabi-as.exe'), '-mcpu=cortex-a9', '-mthumb']
    for k, v in defs.items():
        args += ['--defsym', f'{k}={v:#x}']
    o, elf, binf = (os.path.join(WORK, x) for x in ('h.o', 'h.elf', 'init_bulk.bin'))
    run(args + [os.path.join(SDK, 'examples', 'midi_send', 'init_bulk.s'), '-o', o])
    run([os.path.join(ARM, 'arm-none-eabi-ld.exe'), f'-Ttext={BASE + DEFS["CAVE_OFF"]:#x}', '--entry=hook', o, '-o', elf])
    hdr = run([os.path.join(ARM, 'arm-none-eabi-objdump.exe'), '-h', elf])
    for bad in ('.rodata', '.data', '.bss'):
        if bad in hdr and re.search(r'\s' + re.escape(bad) + r'\s+0*[1-9a-f]', hdr):
            raise SystemExit(f'hook has a {bad} section')
    run([os.path.join(ARM, 'arm-none-eabi-objcopy.exe'), '-O', 'binary', '-j', '.text', elf, binf])
    B = [sys.executable, '-I', os.path.join(SDK, 'tools', 'plugout_build.py')]
    base = os.path.join(WORK, 'base')
    if not os.path.exists(os.path.join(base, 'plugout.json')):
        run(B + ['unpack', os.path.join(JX3P, 'Code8_1.Dat'), base, '--relocs-from', os.path.join(JX3P, 'Code8_2.Dat')])
    p = os.path.join(WORK, 'p')
    if os.path.exists(p):
        shutil.rmtree(p)
    shutil.copytree(base, p)
    run(B + ['set-id', p, '--name', 'INIT BULK', '--version', '1.22'])
    run(B + ['patch', p, '--region', '0', '--at', '0x61800100', '--file', binf])
    run(B + ['patch', p, '--region', '0', '--at', '0x61800024', '--hex', '01018061', '--reloc', '0x61800024'])
    run(B + ['pack', p, '-o', out_dat, '--slot', str(slot)])


def decode(msgs):
    out = []
    for raw in msgs:
        m = MSG.fullmatch(raw)
        if not m:
            continue
        a = 0
        for n in m.group(1):
            a = a << 4 | n
        nib = m.group(2)
        out.append((a, bytes(nib[i] << 4 | nib[i + 1] for i in range(0, len(nib) - 1, 2))))
    return out


def slot_info(s, slot):
    d = s.write(P.ADDR_SLOT_INFO, bytes([slot]), 0x30, timeout=3.0)
    return P.parse_slot_info(slot, d)


def install(ports, dat, slot, idle=3.0):
    """Install a container; then wait until the capture port is idle for `idle` s (needed, SDK 7.14)."""
    s = Session(ports)
    c = P.load(dat)
    t0 = time.time()
    s.install(c, slot)
    last, still = time.time(), 0.0
    while time.time() - last < idle:
        if ports.drain_capture():
            last = time.time()
        time.sleep(0.05)
    return s, time.time() - t0


def dump(out, start, end, slot, count=2048, length=32, settle=3.0):
    total = end - start
    done = os.path.getsize(out) if os.path.exists(out) else 0
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    ports = Ports()
    t0 = time.time()
    try:
        while done < total:
            addr = start + done
            size = min(count * length, total - done)
            n = -(-size // length)
            dat = os.path.join(WORK, f'Code8_{slot}.Dat')
            build(addr, n, length, dat, slot)
            print(f'== {addr:#010x} +{size:#x}  {done}/{total} ({100 * done / total:.1f} %), {time.time() - t0:.0f} s', flush=True)
            time.sleep(settle)
            ports.drain_capture(); ports.receive(); ports.captured = []
            s, secs = install(ports, dat, slot)
            msgs = decode(ports.captured)
            data = bytearray(); expect = addr
            for a, d in msgs:
                if a != expect:
                    print(f'   GAP: expected {expect:#010x}, got {a:#010x}', flush=True)
                    break
                data += d; expect += len(d)
            info = slot_info(s, slot)
            print(f'   {len(msgs)}/{n} messages, {len(data)} bytes, {secs:.1f} s; slot {slot}: {info}', flush=True)
            if len(data) < size:
                print('   chunk incomplete: stopping (rerun to resume)', flush=True)
                return 1
            with open(out, 'ab') as f:
                f.write(bytes(data[:size]))
            done += size
    finally:
        ports.close()
    print(f'done: {done}/{total} bytes in {out}, {time.time() - t0:.0f} s', flush=True)
    return 0


def main():
    a = sys.argv[1:]
    opt = lambda k, d: (lambda i: a[i + 1] if i >= 0 else d)(a.index(k) if k in a else -1)
    slot = int(opt('--slot', '3'))
    if '--install' in a:
        dat = opt('--install', None)
        ports = Ports()
        try:
            c = P.load(dat)
            print(f'install {c.model} {c.version:#x} -> slot {slot}', flush=True)
            s, secs = install(ports, dat, slot)
            print(f'done in {secs:.0f} s; slot {slot}: {slot_info(s, slot)}', flush=True)
        finally:
            ports.close()
        return 0
    out = a[0]
    return dump(out, int(opt('--start', hex(OS_BASE)), 0), int(opt('--end', hex(OS_BASE + OS_SIZE)), 0), slot, settle=float(opt('--settle', '3')))


if __name__ == '__main__':
    sys.exit(main())
