# Recursive Z80 listing for the small Lexicon images (LXP-1, LXP-5: one 32 KB EPROM at 0000-7FFF; the MRC:
# U102 bank at 0000-7FFF, U103 at 8000-9FFF, U104 at A000-BFFF, see lexicon_mrc.py). Follows calls, jumps,
# RST, the stackless "LD IX,return / JP routine" and "LD IY,return / JP routine" pairs, and handler pointers
# stored with "LD HL,nn / LD (var),HL" for the variables given as hv:VAR (the MIDI byte state machines keep
# their next state that way), and the C compiler's switch helper given as cs:ADDR ("LD HL,default / PUSH HL /
# LD BC,count / LD HL,table / JP helper"; table entries are value word, address word).
#   python -I lxp_dis.py <image> <out.lst> [hex entry ...] [hv:VAR ...] [tab:ADDR:N] [cs:ADDR] [base:HEX]
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 're', 'fx', 'tools'))
from z80dis import dis, w  # noqa: E402


def run(img, entries, hvars, base=0, cswitch=()):
    code, calls = {}, set()
    work = list(entries)
    lo, hi = base, base + len(img)
    view = bytearray(0x10000)
    view[base:base + len(img)] = img
    while work:
        pc = work.pop()
        prev = None
        hist = []
        while lo <= pc < hi and pc not in code:
            t, n, tg, falls, call = dis(view, pc)
            code[pc] = (t, n)
            for x in tg:
                work.append(x)
                if call:
                    calls.add(x)
            m = re.match(r'LD I[XY],0x([0-9a-f]{4})$', t)
            if m:
                work.append(int(m.group(1), 16))
            m = re.match(r'LD \(0x([0-9a-f]{4})\),HL$', t)
            if m and prev and int(m.group(1), 16) in hvars:
                m2 = re.match(r'LD HL,0x([0-9a-f]{4})$', prev)
                if m2:
                    work.append(int(m2.group(1), 16))
            hist.append(t)
            m = re.match(r'JP 0x([0-9a-f]{4})$', t)
            if m and int(m.group(1), 16) in cswitch and len(hist) >= 5:
                mt = re.match(r'LD HL,0x([0-9a-f]{4})$', hist[-2])
                mc = re.match(r'LD BC,0x([0-9a-f]{4})$', hist[-3])
                md = re.match(r'LD HL,0x([0-9a-f]{4})$', hist[-5])
                if mt and mc and md and hist[-4] == 'PUSH HL':
                    tb, cnt = int(mt.group(1), 16), int(mc.group(1), 16)
                    work.append(int(md.group(1), 16))
                    for i in range(cnt):
                        work.append(w(view, tb + 4 * i + 2))
            prev = t
            if not falls:
                break
            pc += n
    return code, calls, view


def write(view, lo, hi, code, calls, path):
    with open(path, 'w') as f:
        pc = lo
        while pc < hi:
            if pc in code:
                t, n = code[pc]
                if pc in calls:
                    f.write(f'\n;---- sub_{pc:04x}\n')
                f.write(f'{pc:04x}  {bytes(view[pc:pc + n]).hex():10s} {t}\n')
                pc += n
            else:
                s = pc
                while pc < hi and pc not in code and pc - s < 16:
                    pc += 1
                bs = bytes(view[s:pc])
                asc = ''.join(chr(c) if 32 <= c < 127 else '.' for c in bs)
                f.write(f'{s:04x}  db {bs.hex(" ")}  ; {asc}\n')


def main():
    img = open(sys.argv[1], 'rb').read()
    out = sys.argv[2]
    ent, hv, base, cs = {0, 0x38, 0x66}, set(), 0, set()
    for a in sys.argv[3:]:
        if a.startswith('base:'):
            base = int(a[5:], 16)
    for a in sys.argv[3:]:
        if a.startswith('hv:'):
            hv.add(int(a[3:], 16))
        elif a.startswith('cs:'):
            cs.add(int(a[3:], 16))
        elif a.startswith('tab:'):
            _, ad, nn = a.split(':')
            view = bytearray(0x10000)
            view[base:base + len(img)] = img
            for i in range(int(nn)):
                ent.add(w(view, int(ad, 16) + 2 * i))
        elif not a.startswith('base:'):
            ent.add(int(a, 16))
    if base:
        ent = {e for e in ent if e >= base}
    code, calls, view = run(img, sorted(ent), hv, base, cs)
    write(view, base, base + len(img), code, calls | ent, out)
    print('instructions', len(code), 'entries', len(ent))


if __name__ == '__main__':
    main()
