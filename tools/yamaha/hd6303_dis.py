"""HD6303 / 6801 disassembler for the Yamaha DX/TX firmware analysis (Ghidra has no 6801 family).

Usage: python -I tools/yamaha/hd6303_dis.py ROM BASE OUT [entry ...] [tab:ADDR:N ...] [--auto]

Disassembles a ROM image loaded at BASE (hex) by following code from the interrupt vectors
(FFE8-FFFF) and the given extra entry points (hex), and writes a listing to OUT: one line per
instruction, labels for branch and call targets, and the text of printable strings that an
immediate or extended operand points at. Bytes that are never reached are listed as data with
their ASCII, so tables and strings stay visible. Read only: it never runs anything from the ROM.
tab:ADDR:N follows the N words of a jump table at ADDR; --auto also finds the tables reached as
"ldx #T ... ldx 0,x ; jmp/jsr 0,x" and follows their words (T labels, J entries).
sw:ADDR names a switch routine called as "jsr ADDR" followed by an inline table of (offset, limit)
byte pairs (DX7II BADE: the first pair whose limit is above B, or whose limit is 0, is taken; the
target is the pair's own address + offset); the pairs are listed as data and their targets followed.
ix:ADDR names a routine that loads X from the word table at X indexed by B (DX7II DB0A: abx abx
ldx 0,x rts), so --auto also finds the tables reached as "ldx #T ... jsr ADDR ... jmp/jsr 0,x".
bt:ADDR names a routine called as "jsr ADDR" followed by an inline table of byte offsets indexed by
a register (TX81Z B563 by B, B55E by A: entry i jumps to its own address + its byte); the table ends
where the nearest target starts.
"""
import sys

# mnemonic, mode   modes: inh, imm8, imm16, dir, ext, idx, rel, bim (6303 AIM/OIM/EIM/TIM: imm8 + dir/idx)
OPS = {}
def op(code, m, mode):
    OPS[code] = (m, mode)

for c, m in {0x01: 'nop', 0x04: 'lsrd', 0x05: 'asld', 0x06: 'tap', 0x07: 'tpa', 0x08: 'inx', 0x09: 'dex',
             0x0a: 'clv', 0x0b: 'sev', 0x0c: 'clc', 0x0d: 'sec', 0x0e: 'cli', 0x0f: 'sei', 0x10: 'sba', 0x11: 'cba',
             0x16: 'tab', 0x17: 'tba', 0x18: 'xgdx', 0x19: 'daa', 0x1a: 'slp', 0x1b: 'aba', 0x30: 'tsx', 0x31: 'ins',
             0x32: 'pula', 0x33: 'pulb', 0x34: 'des', 0x35: 'txs', 0x36: 'psha', 0x37: 'pshb', 0x38: 'pulx', 0x39: 'rts',
             0x3a: 'abx', 0x3b: 'rti', 0x3c: 'pshx', 0x3d: 'mul', 0x3e: 'wai', 0x3f: 'swi'}.items():
    op(c, m, 'inh')
BR = ['bra', 'brn', 'bhi', 'bls', 'bcc', 'bcs', 'bne', 'beq', 'bvc', 'bvs', 'bpl', 'bmi', 'bge', 'blt', 'bgt', 'ble']
for i, m in enumerate(BR):
    op(0x20 + i, m, 'rel')
UN = {0: 'neg', 3: 'com', 4: 'lsr', 6: 'ror', 7: 'asr', 8: 'asl', 9: 'rol', 0xa: 'dec', 0xc: 'inc', 0xd: 'tst', 0xf: 'clr'}
for lo, m in UN.items():
    op(0x40 + lo, m + 'a', 'inh')
    op(0x50 + lo, m + 'b', 'inh')
    op(0x60 + lo, m, 'idx')
    op(0x70 + lo, m, 'ext')
op(0x6e, 'jmp', 'idx'); op(0x7e, 'jmp', 'ext')
for lo, m in {1: 'aim', 2: 'oim', 5: 'eim', 0xb: 'tim'}.items():
    op(0x60 + lo, m, 'bimx')
    op(0x70 + lo, m, 'bimd')
AOPS = {0: 'suba', 1: 'cmpa', 2: 'sbca', 4: 'anda', 5: 'bita', 6: 'ldaa', 7: 'staa', 8: 'eora', 9: 'adca', 0xa: 'oraa', 0xb: 'adda'}
BOPS = {0: 'subb', 1: 'cmpb', 2: 'sbcb', 4: 'andb', 5: 'bitb', 6: 'ldab', 7: 'stab', 8: 'eorb', 9: 'adcb', 0xa: 'orab', 0xb: 'addb'}
for hi, mode in ((0x80, 'imm8'), (0x90, 'dir'), (0xa0, 'idx'), (0xb0, 'ext')):
    for lo, m in AOPS.items():
        if hi == 0x80 and lo == 7: continue
        op(hi + lo, m, mode)
    w = 'imm16' if hi == 0x80 else mode
    op(hi + 3, 'subd', w); op(hi + 0xc, 'cpx', w); op(hi + 0xe, 'lds', w)
    if hi != 0x80:
        op(hi + 0xf, 'sts', mode); op(hi + 0xd, 'jsr', mode)
op(0x8d, 'bsr', 'rel')
for hi, mode in ((0xc0, 'imm8'), (0xd0, 'dir'), (0xe0, 'idx'), (0xf0, 'ext')):
    for lo, m in BOPS.items():
        if hi == 0xc0 and lo == 7: continue
        op(hi + lo, m, mode)
    w = 'imm16' if hi == 0xc0 else mode
    op(hi + 3, 'addd', w); op(hi + 0xc, 'ldd', w); op(hi + 0xe, 'ldx', w)
    if hi != 0xc0:
        op(hi + 0xd, 'std', mode); op(hi + 0xf, 'stx', mode)

SIZE = {'inh': 1, 'imm8': 2, 'imm16': 3, 'dir': 2, 'ext': 3, 'idx': 2, 'rel': 2, 'bimx': 3, 'bimd': 3}


def main():
    rom = open(sys.argv[1], 'rb').read()
    base = int(sys.argv[2], 16)
    out = sys.argv[3]
    end = base + len(rom)
    rd = lambda a: rom[a - base] if base <= a < end else None
    w16 = lambda a: (rd(a) << 8) | rd(a + 1)
    entries = []
    for v in range(0xffe8, 0x10000, 2):
        if base <= v < end:
            t = w16(v)
            if base <= t < end: entries.append((t, 'vec_%04X' % v))
    auto = False
    tables = []  # (address, words) given as tab:ADDR:N
    for e in sys.argv[4:]:
        if e == '--auto': auto = True
        elif e.startswith('sw:'): SWITCHES.add(int(e[3:], 16))
        elif e.startswith('ix:'): INDEXERS.add(int(e[3:], 16))
        elif e.startswith('bt:'): BYTETABLES.add(int(e[3:], 16))
        elif e.startswith('tab:'):
            _, a, n = e.split(':')
            tables.append((int(a, 16), int(n)))
        else: entries.append((int(e, 16), None))
    code = {}
    labels = {}
    for t, n in entries:
        labels.setdefault(t, n or 'L%04X' % t)
    for ta, n in tables:
        labels.setdefault(ta, 'T%04X' % ta)
        for i in range(n):
            t = w16(ta + 2 * i)
            if base <= t < end:
                labels.setdefault(t, 'J%04X' % t)
                entries.append((t, None))
    todo = [t for t, _ in entries]
    flow(rd, w16, base, end, code, labels, todo)
    # --auto: jump tables reached as  ldx #T ... ldx 0,x ; jmp 0,x / jsr 0,x  (T indexed by abx before):
    # read words from T while they point at ROM addresses that start an instruction, and follow them.
    seen = set()
    while auto:
        found = []
        addrs = sorted(code)
        for k, a in enumerate(addrs):
            m, mode, n = code[a]
            if not (m == 'ldx' and mode == 'imm16'): continue
            T = w16(a + 1)
            if not (base <= T < end) or T in seen or T in code: continue
            win = addrs[k + 1:k + 9]
            ops = [(code[x][0], code[x][1], rd(x + 1)) for x in win]
            ixr = any(code[x][0] == 'jsr' and code[x][1] == 'ext' and w16(x + 1) in INDEXERS for x in win)
            hit = (ixr or any(o[0] == 'ldx' and o[1] == 'idx' for o in ops)) and any(o[0] in ('jmp', 'jsr') and o[1] == 'idx' for o in ops)
            if not hit: continue
            seen.add(T)
            labels.setdefault(T, 'T%04X' % T)
            for i in range(160):
                p = T + 2 * i
                if p + 1 >= end or (i and (p in labels or p in code)): break
                t = w16(p)
                if not (base <= t < end) or rd(t) not in OPS: break
                labels.setdefault(t, 'J%04X' % t)
                found.append(t)
        if not found: break
        flow(rd, w16, base, end, code, labels, found)
    write(rom, rd, w16, base, end, code, labels, out)


SWITCHES = set()  # sw:ADDR routines followed by inline (offset, limit) tables
INDEXERS = set()  # ix:ADDR routines that load X from the word table at X indexed by B (abx abx ldx 0,x)
SWDATA = {}  # table address -> number of pairs
BYTETABLES = set()  # bt:ADDR routines followed by an inline table of byte offsets (TX81Z B563/B55E)
BTDATA = {}  # table address -> number of bytes


def byte_table(rd, base, end, labels, p):
    """The targets of an inline byte-offset table at p: entry i jumps to p + i + byte i. The table
    ends where the nearest target starts (the targets follow the table)."""
    out = []
    n = 0
    lim = end
    while base <= p + n < min(end, lim) and n < 128:
        t = p + n + rd(p + n)
        if t <= p + n: break
        labels.setdefault(t, 'C%04X' % t)
        out.append(t)
        lim = min(lim, t)
        n += 1
    return out, n


def switch_table(rd, base, end, labels, p):
    """The targets of an inline (offset, limit) table at p (the last pair has limit 0)."""
    out = []
    n = 0
    while base <= p + 1 < end and n < 64:
        t = p + rd(p)
        labels.setdefault(t, 'C%04X' % t)
        out.append(t)
        n += 1
        if rd(p + 1) == 0: break
        p += 2
    return out, n


def flow(rd, w16, base, end, code, labels, todo):
    while todo:
        a = todo.pop()
        while base <= a < end and a not in code:
            if any(s <= a < s + 2 * k for s, k in SWDATA.items()): break
            if any(s <= a < s + k for s, k in BTDATA.items()): break
            b = rd(a)
            if b not in OPS: break
            m, mode = OPS[b]
            n = SIZE[mode]
            if a + n > end: break
            code[a] = (m, mode, n)
            nxt = a + n
            if m == 'jsr' and mode == 'ext' and w16(a + 1) in SWITCHES:
                t = w16(a + 1)
                labels.setdefault(t, 'S%04X' % t)
                todo.append(t)
                labels.setdefault(nxt, 'W%04X' % nxt)
                targets, k = switch_table(rd, base, end, labels, nxt)
                SWDATA[nxt] = k
                todo.extend(targets)
                break
            if m == 'jsr' and mode == 'ext' and w16(a + 1) in BYTETABLES:
                t = w16(a + 1)
                labels.setdefault(t, 'S%04X' % t)
                todo.append(t)
                labels.setdefault(nxt, 'W%04X' % nxt)
                targets, k = byte_table(rd, base, end, labels, nxt)
                BTDATA[nxt] = k
                todo.extend(targets)
                break
            if mode == 'rel':
                d = rd(a + 1); d = d - 256 if d > 127 else d
                t = nxt + d
                labels.setdefault(t, 'L%04X' % t)
                todo.append(t)
                if m == 'bra': break
            elif m in ('jmp', 'jsr') and mode == 'ext':
                t = w16(a + 1)
                labels.setdefault(t, ('S%04X' if m == 'jsr' else 'L%04X') % t)
                todo.append(t)
                if m == 'jmp': break
            elif m == 'jmp' or m in ('rts', 'rti'):
                break
            a = nxt


def write(rom, rd, w16, base, end, code, labels, out):
    def text_at(t):
        if not (base <= t < end): return None
        s = []
        while base <= t < end and 32 <= rd(t) < 127 and len(s) < 40:
            s.append(chr(rd(t))); t += 1
        return ''.join(s) if len(s) >= 3 else None
    lines = []
    a = base
    while a < end:
        if a in labels: lines.append('%s:' % labels[a])
        if a in SWDATA and a not in code:
            for i in range(SWDATA[a]):
                p = a + 2 * i
                lim = rd(p + 1)
                lines.append('  %04X  sw %02X %02X   %s -> %s' % (p, rd(p), lim, 'b<$%02X' % lim if lim else 'else ', labels.get(p + rd(p), '%04X' % (p + rd(p)))))
            a += 2 * SWDATA[a]
            continue
        if a in BTDATA and a not in code:
            for i in range(BTDATA[a]):
                p = a + i
                lines.append('  %04X  bt %02X      [%d] -> %s' % (p, rd(p), i, labels.get(p + rd(p), '%04X' % (p + rd(p)))))
            a += BTDATA[a]
            continue
        if a in code:
            m, mode, n = code[a]
            raw = ' '.join('%02X' % rd(a + i) for i in range(n))
            if mode == 'inh': opnd = ''
            elif mode == 'imm8': opnd = '#$%02X' % rd(a + 1)
            elif mode == 'imm16': opnd = '#$%04X' % w16(a + 1)
            elif mode == 'dir': opnd = '$%02X' % rd(a + 1)
            elif mode == 'ext': opnd = '$%04X' % w16(a + 1)
            elif mode == 'idx': opnd = '$%02X,x' % rd(a + 1)
            elif mode == 'rel':
                d = rd(a + 1); d = d - 256 if d > 127 else d
                opnd = labels.get(a + 2 + d, '$%04X' % (a + 2 + d))
            elif mode == 'bimx': opnd = '#$%02X,$%02X,x' % (rd(a + 1), rd(a + 2))
            else: opnd = '#$%02X,$%02X' % (rd(a + 1), rd(a + 2))
            if mode in ('ext',) and m in ('jsr', 'jmp'): opnd = labels.get(w16(a + 1), opnd)
            note = ''
            if mode in ('imm16', 'ext'):
                s = text_at(w16(a + 1))
                if s: note = '  ; "%s"' % s
            lines.append('  %04X  %-9s %-6s %s%s' % (a, raw, m, opnd, note))
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
