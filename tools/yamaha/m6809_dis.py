"""6809 disassembler for the Yamaha DX5 / DX1 firmware (their CPU is a 6809; the DX7 family's is an
HD6303, see hd6303_dis.py). Same listing format as hd6303_dis.py.

Usage: python -I tools/yamaha/m6809_dis.py ROM BASE OUT [entry ...] [tab:ADDR:N ...] [--auto]

Follows code from the vectors (FFF2-FFFE) and the given entry points (hex); tab:ADDR:N follows the
N words of a jump table at ADDR; --auto also follows the tables reached as "ldx #T ... jmp/jsr [r,X]"
(T labels, J entries). Unreached bytes are listed as data with their ASCII. Read only: it never runs
anything from the ROM.
"""
import sys

REGS = ['x', 'y', 'u', 's']
BR = ['bra', 'brn', 'bhi', 'bls', 'bcc', 'bcs', 'bne', 'beq', 'bvc', 'bvs', 'bpl', 'bmi', 'bge', 'blt', 'bgt', 'ble']
TFR = ['d', 'x', 'y', 'u', 's', 'pc', '?6', '?7', 'a', 'b', 'cc', 'dp', '?c', '?d', '?e', '?f']
PSH_S = ['cc', 'a', 'b', 'dp', 'x', 'y', 'u', 'pc']

P1 = {}  # code -> (mnemonic, mode)   modes: inh imm8 imm16 dir idx ext rel8 rel16 reg psh
UN = {0: 'neg', 3: 'com', 4: 'lsr', 6: 'ror', 7: 'asr', 8: 'asl', 9: 'rol', 0xa: 'dec', 0xc: 'inc', 0xd: 'tst', 0xe: 'jmp', 0xf: 'clr'}
for lo, m in UN.items():
    P1[0x00 + lo] = (m, 'dir'); P1[0x60 + lo] = (m, 'idx'); P1[0x70 + lo] = (m, 'ext')
    if m not in ('jmp',):
        P1[0x40 + lo] = (m + 'a', 'inh'); P1[0x50 + lo] = (m + 'b', 'inh')
for c, m in {0x12: 'nop', 0x13: 'sync', 0x19: 'daa', 0x1d: 'sex', 0x39: 'rts', 0x3a: 'abx', 0x3b: 'rti', 0x3d: 'mul', 0x3f: 'swi'}.items():
    P1[c] = (m, 'inh')
P1[0x16] = ('lbra', 'rel16'); P1[0x17] = ('lbsr', 'rel16')
P1[0x1a] = ('orcc', 'imm8'); P1[0x1c] = ('andcc', 'imm8'); P1[0x3c] = ('cwai', 'imm8')
P1[0x1e] = ('exg', 'reg'); P1[0x1f] = ('tfr', 'reg')
for i, m in enumerate(BR):
    P1[0x20 + i] = (m, 'rel8')
for i, m in enumerate(['leax', 'leay', 'leas', 'leau']):
    P1[0x30 + i] = (m, 'idx')
P1[0x34] = ('pshs', 'psh'); P1[0x35] = ('puls', 'psh'); P1[0x36] = ('pshu', 'psh'); P1[0x37] = ('pulu', 'psh')
A = {0: 'suba', 1: 'cmpa', 2: 'sbca', 3: 'subd', 4: 'anda', 5: 'bita', 6: 'lda', 7: 'sta', 8: 'eora', 9: 'adca', 0xa: 'ora', 0xb: 'adda', 0xc: 'cmpx', 0xd: 'jsr', 0xe: 'ldx', 0xf: 'stx'}
B = {0: 'subb', 1: 'cmpb', 2: 'sbcb', 3: 'addd', 4: 'andb', 5: 'bitb', 6: 'ldb', 7: 'stb', 8: 'eorb', 9: 'adcb', 0xa: 'orb', 0xb: 'addb', 0xc: 'ldd', 0xd: 'std', 0xe: 'ldu', 0xf: 'stu'}
for hi, mode in ((0x80, 'imm'), (0x90, 'dir'), (0xa0, 'idx'), (0xb0, 'ext')):
    for lo, m in A.items():
        if mode == 'imm':
            if lo in (7, 0xf): continue
            if lo == 0xd: P1[0x8d] = ('bsr', 'rel8'); continue
            P1[hi + lo] = (m, 'imm16' if lo in (3, 0xc, 0xe) else 'imm8')
        else:
            P1[hi + lo] = (m, mode)
for hi, mode in ((0xc0, 'imm'), (0xd0, 'dir'), (0xe0, 'idx'), (0xf0, 'ext')):
    for lo, m in B.items():
        if mode == 'imm':
            if lo in (7, 0xd, 0xf): continue
            P1[hi + lo] = (m, 'imm16' if lo in (3, 0xc, 0xe) else 'imm8')
        else:
            P1[hi + lo] = (m, mode)
P2 = {0x3f: ('swi2', 'inh'), 0x83: ('cmpd', 'imm16'), 0x8c: ('cmpy', 'imm16'), 0x8e: ('ldy', 'imm16'), 0xce: ('lds', 'imm16')}
for i, m in enumerate(BR):
    if i: P2[0x20 + i] = ('l' + m, 'rel16')
for hi, mode in ((0x90, 'dir'), (0xa0, 'idx'), (0xb0, 'ext')):
    P2[hi + 3] = ('cmpd', mode); P2[hi + 0xc] = ('cmpy', mode); P2[hi + 0xe] = ('ldy', mode); P2[hi + 0xf] = ('sty', mode)
for hi, mode in ((0xd0, 'dir'), (0xe0, 'idx'), (0xf0, 'ext')):
    P2[hi + 0xe] = ('lds', mode); P2[hi + 0xf] = ('sts', mode)
P3 = {0x3f: ('swi3', 'inh'), 0x83: ('cmpu', 'imm16'), 0x8c: ('cmps', 'imm16')}
for hi, mode in ((0x90, 'dir'), (0xa0, 'idx'), (0xb0, 'ext')):
    P3[hi + 3] = ('cmpu', mode); P3[hi + 0xc] = ('cmps', mode)


def decode(rd, a):
    """(mnemonic, mode, length, operand text, target, imm16, indirect_jump) or None."""
    op = rd(a)
    if op is None: return None
    pre = 0
    table = P1
    if op in (0x10, 0x11):
        pre = 1
        table = P2 if op == 0x10 else P3
        op = rd(a + 1)
        if op is None: return None
    if op not in table: return None
    m, mode = table[op]
    p = a + 1 + pre
    s16 = lambda v: v - 0x10000 if v & 0x8000 else v
    w = lambda q: (rd(q) << 8) | rd(q + 1)
    target = None
    imm = None
    ind = False
    if mode == 'inh': n, t = 0, ''
    elif mode == 'imm8': n, t = 1, '#$%02X' % rd(p)
    elif mode == 'imm16': n, t = 2, '#$%04X' % w(p); imm = w(p)
    elif mode == 'dir': n, t = 1, '<$%02X' % rd(p)
    elif mode == 'ext': n, t = 2, '$%04X' % w(p); target = w(p); imm = w(p)
    elif mode == 'rel8':
        d = rd(p); d = d - 256 if d > 127 else d
        n = 1; target = (p + 1 + d) & 0xffff; t = '$%04X' % target
    elif mode == 'rel16':
        n = 2; target = (p + 2 + s16(w(p))) & 0xffff; t = '$%04X' % target
    elif mode == 'reg':
        n = 1; pb = rd(p); t = '%s,%s' % (TFR[pb >> 4], TFR[pb & 15])
    elif mode == 'psh':
        n = 1; pb = rd(p)
        names = PSH_S if op in (0x34, 0x35) else ['cc', 'a', 'b', 'dp', 'x', 'y', 's', 'pc']
        t = ','.join(names[i] for i in range(8) if pb & (1 << i))
    else:  # idx
        pb = rd(p); r = REGS[(pb >> 5) & 3]
        if not pb & 0x80:
            o = pb & 31; o = o - 32 if o > 15 else o
            n, t = 1, '%d,%s' % (o, r)
        else:
            k = pb & 15; ind = bool(pb & 0x10)
            n = 1
            if k == 0: t = ',%s+' % r
            elif k == 1: t = ',%s++' % r
            elif k == 2: t = ',-%s' % r
            elif k == 3: t = ',--%s' % r
            elif k == 4: t = ',%s' % r
            elif k == 5: t = 'b,%s' % r
            elif k == 6: t = 'a,%s' % r
            elif k == 8: d = rd(p + 1); d = d - 256 if d > 127 else d; n = 2; t = '%d,%s' % (d, r)
            elif k == 9: n = 3; t = '$%04X,%s' % (w(p + 1), r)
            elif k == 0xb: t = 'd,%s' % r
            elif k == 0xc: d = rd(p + 1); d = d - 256 if d > 127 else d; n = 2; imm = (p + 2 + d) & 0xffff; t = '$%04X,pcr' % imm
            elif k == 0xd: n = 3; imm = (p + 3 + s16(w(p + 1))) & 0xffff; t = '$%04X,pcr' % imm
            elif k == 0xf: n = 3; t = '$%04X' % w(p + 1); imm = w(p + 1)
            else: return None
            if ind: t = '[%s]' % t
    return m, mode, 1 + pre + n, t, target, imm, ind


def main():
    rom = open(sys.argv[1], 'rb').read()
    base = int(sys.argv[2], 16)
    out = sys.argv[3]
    end = base + len(rom)
    rd = lambda a: rom[a - base] if base <= a < end else None
    w16 = lambda a: (rd(a) << 8) | rd(a + 1)
    entries = []
    for v in range(0xfff2, 0x10000, 2):
        if base <= v < end:
            t = w16(v)
            if base <= t < end: entries.append((t, 'vec_%04X' % v))
    auto = False
    tables = []
    for e in sys.argv[4:]:
        if e == '--auto': auto = True
        elif e.startswith('tab:'):
            _, a, n = e.split(':'); tables.append((int(a, 16), int(n)))
        else: entries.append((int(e, 16), None))
    code, labels = {}, {}
    for t, n in entries: labels.setdefault(t, n or 'L%04X' % t)
    for ta, n in tables:
        labels.setdefault(ta, 'T%04X' % ta)
        for i in range(n):
            t = w16(ta + 2 * i)
            if base <= t < end: labels.setdefault(t, 'J%04X' % t); entries.append((t, None))
    flow(rd, base, end, code, labels, [t for t, _ in entries])
    seen = set()
    while auto:
        found = []
        addrs = sorted(code)
        for k, a in enumerate(addrs):
            m, mode, n, t, tgt, imm, ind = code[a]
            if not (m in ('ldx', 'ldy', 'ldu', 'leax', 'leay', 'leau') and imm is not None and mode in ('imm16', 'idx')): continue
            T = imm
            if not (base <= T < end) or T in seen or T in code: continue
            win = [code[x] for x in addrs[k + 1:k + 9]]
            if not any(c[0] in ('jmp', 'jsr') and c[1] == 'idx' and c[6] for c in win): continue
            seen.add(T)
            labels.setdefault(T, 'T%04X' % T)
            for i in range(128):
                p = T + 2 * i
                if p + 1 >= end or (i and (p in labels or p in code)): break
                t = w16(p)
                if not (base <= t < end) or decode(rd, t) is None: break
                labels.setdefault(t, 'J%04X' % t)
                found.append(t)
        if not found: break
        flow(rd, base, end, code, labels, found)
    write(rd, w16, base, end, code, labels, out)


def flow(rd, base, end, code, labels, todo):
    while todo:
        a = todo.pop()
        while base <= a < end and a not in code:
            d = decode(rd, a)
            if d is None or a + d[2] > end: break
            code[a] = d
            m, mode, n, t, tgt, imm, ind = d
            nxt = a + n
            if mode in ('rel8', 'rel16'):
                labels.setdefault(tgt, ('S%04X' if m in ('bsr', 'lbsr') else 'L%04X') % tgt)
                todo.append(tgt)
                if m in ('bra', 'lbra'): break
            elif m in ('jmp', 'jsr') and mode == 'ext':
                labels.setdefault(tgt, ('S%04X' if m == 'jsr' else 'L%04X') % tgt)
                todo.append(tgt)
                if m == 'jmp': break
            elif m == 'jmp' or m in ('rts', 'rti') or (m in ('puls', 'pulu') and rd(a + 1) & 0x80):
                break
            a = nxt


def write(rd, w16, base, end, code, labels, out):
    def text_at(t):
        if t is None or not (base <= t < end): return None
        s = []
        while base <= t < end and 32 <= rd(t) < 127 and len(s) < 40:
            s.append(chr(rd(t))); t += 1
        return ''.join(s) if len(s) >= 3 else None
    lines = []
    a = base
    while a < end:
        if a in labels: lines.append('%s:' % labels[a])
        if a in code:
            m, mode, n, t, tgt, imm, ind = code[a]
            raw = ' '.join('%02X' % rd(a + i) for i in range(n))
            if tgt is not None and tgt in labels and mode in ('rel8', 'rel16', 'ext') and m in ('jsr', 'jmp', 'bsr', 'lbsr') + tuple(BR) + tuple('l' + b for b in BR):
                t = labels[tgt]
            s = text_at(imm)
            note = '  ; "%s"' % s if s else ''
            lines.append('  %04X  %-12s %-6s %s%s' % (a, raw, m, t, note))
            a += n
        else:
            s = a
            row = []
            while a < end and a not in code and len(row) < 16 and (a == s or a not in labels):
                row.append(rd(a)); a += 1
            lines.append('  %04X  db %s  |%s|' % (s, ' '.join('%02X' % x for x in row), ''.join(chr(x) if 32 <= x < 127 else '.' for x in row)))
    open(out, 'w').write('\n'.join(lines) + '\n')
    print('instructions', len(code), 'labels', len(labels))


if __name__ == '__main__':
    main()
