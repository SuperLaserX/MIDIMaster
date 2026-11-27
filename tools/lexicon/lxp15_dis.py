# Lexicon LXP-15 listing: the 64 KB EPROM is two 32 KB banks seen at CPU 0000-7FFF (OUT (80h) = bank A =
# image 0000-7FFF, OUT (40h) = bank B = image 8000-FFFF; the first page is the same in both). Cross-bank
# calls go through thunks "LD BC,target / JP 018D" (bank B) and "LD BC,target / JP 0195" (bank A); early
# code calls without a stack as "LD IY,return / JP routine" (routine ends JP (IY)).
#   python -I lxp15_dis.py <image> <outdir> [A:hex ...] [B:hex ...] [tabA:ADDR:N] [tabB:ADDR:N]
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 're', 'fx', 'tools'))
from z80dis import dis, w  # noqa: E402


def thunks(img):
    """{'A': set, 'B': set} of cross-bank targets: LD BC,nn / JP 018D|0195 anywhere."""
    out = {'A': set(), 'B': set()}
    for m in re.finditer(rb'\x01(..)\xc3([\x8d\x95])\x01', img, re.S):
        t = m.group(1)[0] | (m.group(1)[1] << 8)
        out['B' if m.group(2) == b'\x8d' else 'A'].add(t)
    return out


def run(img, entries, extra):
    code, calls = {}, set()
    work = list(entries)
    while work:
        pc = work.pop()
        while 0 <= pc < len(img) and pc not in code:
            t, n, tg, falls, call = dis(img, pc)
            code[pc] = (t, n)
            for x in tg:
                work.append(x)
                if call: calls.add(x)
            m = re.match(r'LD IY,0x([0-9a-f]{4})', t)
            if m:
                work.append(int(m.group(1), 16))
            if t.startswith('LD BC,0x') and img[pc + 3] == 0xc3 and img[pc + 5] == 0x01 and img[pc + 4] in (0x8d, 0x95):
                extra[('B' if img[pc + 4] == 0x8d else 'A')].add(int(t[6:], 16))
            if not falls:
                break
            pc += n
    return code, calls


def write(img, code, calls, path):
    with open(path, 'w') as f:
        pc = 0
        while pc < len(img):
            if pc in code:
                t, n = code[pc]
                if pc in calls:
                    f.write(f'\n;---- sub_{pc:04x}\n')
                f.write(f'{pc:04x}  {img[pc:pc + n].hex():10s} {t}\n')
                pc += n
            else:
                s = pc
                while pc < len(img) and pc not in code and pc - s < 16:
                    pc += 1
                bs = img[s:pc]
                asc = ''.join(chr(c) if 32 <= c < 127 else '.' for c in bs)
                f.write(f'{s:04x}  db {bs.hex(" ")}  ; {asc}\n')


def main():
    full = open(sys.argv[1], 'rb').read()
    out = sys.argv[2]
    banks = {'A': full[:0x8000], 'B': full[0x8000:]}
    ent = {'A': {0, 0x38, 0x66}, 'B': {0, 0x38, 0x66}}
    for a in sys.argv[3:]:
        if a.startswith('tab'):
            k, ad, nn = a.split(':')
            b = k[3]
            for i in range(int(nn)):
                ent[b].add(w(banks[b], int(ad, 16) + 2 * i))
        else:
            b, ad = a.split(':')
            ent[b].add(int(ad, 16))
    th = thunks(full)
    for b in 'AB':
        ent[b] |= th[b]
    res = {}
    for _ in range(4):
        extra = {'A': set(), 'B': set()}
        for b in 'AB':
            res[b] = run(banks[b], sorted(ent[b]), extra)
        grown = False
        for b in 'AB':
            if not extra[b] <= ent[b]:
                ent[b] |= extra[b]
                grown = True
        if not grown:
            break
    stem = os.path.splitext(os.path.basename(sys.argv[1]))[0]
    for b in 'AB':
        code, calls = res[b]
        write(banks[b], code, calls | ent[b], os.path.join(out, f'{stem}_{b}.lst'))
        print(b, 'instructions', len(code), 'entries', len(ent[b]))


if __name__ == '__main__':
    main()
