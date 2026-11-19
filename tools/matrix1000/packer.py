"""Run the Matrix-1000 patch (un)packer's threaded code to learn each field's bit width.

The firmware stores patches bit-packed. The unpacker at 0xE12D walks a list of
code addresses (thread at 0xDF85); each snippet shifts bits between A and B
and stores/loads bytes. This is a tiny 6809 subset interpreter for exactly
those snippets.

usage: python3 -I packer.py <M1000 v1.13 ROM>
"""
import struct
import sys

B0 = 0x8000
rom = open(sys.argv[1], 'rb').read()


def w(a): return struct.unpack('>H', rom[a - B0:a - B0 + 2])[0]


def run(start_pc, thread, src, dst_len, x0=0, y0=0, backwards=False):
    """Execute snippets. src: bytes indexed by Y; dst: bytearray indexed by X."""
    mem_src = bytearray(src)
    dst = bytearray(dst_len)
    A = B = 0
    C = 0
    X, Y, U = x0, y0, thread
    pc = start_pc
    steps = 0
    while steps < 100000:
        steps += 1
        op = rom[pc - B0]
        nxt = rom[pc - B0 + 1]
        if op == 0x44:   # LSRA
            C = A & 1; A >>= 1; pc += 1
        elif op == 0x54:  # LSRB
            C = B & 1; B >>= 1; pc += 1
        elif op == 0x49:  # ROLA
            A = ((A << 1) | C) & 0xff; C = 0; pc += 1
        elif op == 0x59:  # ROLB
            B = ((B << 1) | C) & 0xff; C = 0; pc += 1
        elif op == 0x4f: A = 0; pc += 1
        elif op == 0x5f: B = 0; pc += 1
        elif op == 0x39: return dst, X, Y
        elif op == 0x37 and nxt == 0x80:  # PULU PC
            pc = w(U); U += 2
        elif op in (0xa7, 0xe7, 0xed, 0xa6, 0xe6, 0xec):
            post = nxt
            mode = post & 0x9f
            reg = 'X' if (post & 0x60) == 0 else 'Y'
            size = 2 if op in (0xed, 0xec) else 1
            r = X if reg == 'X' else Y
            if mode == 0x80: addr = r; r += 1
            elif mode == 0x81: addr = r; r += 2
            elif mode == 0x82: r -= 1; addr = r
            elif mode == 0x83: r -= 2; addr = r
            elif mode == 0x84: addr = r
            else: raise SystemExit(f'mode {post:02x} at {pc:04x}')
            if reg == 'X': X = r
            else: Y = r
            if op == 0xa7: dst[addr] = A
            elif op == 0xe7: dst[addr] = B
            elif op == 0xed: dst[addr] = A; dst[addr + 1] = B
            elif op == 0xa6: A = mem_src[addr] if 0 <= addr < len(mem_src) else 0
            elif op == 0xe6: B = mem_src[addr] if 0 <= addr < len(mem_src) else 0
            elif op == 0xec:
                A = mem_src[addr] if 0 <= addr < len(mem_src) else 0
                B = mem_src[addr + 1] if 0 <= addr + 1 < len(mem_src) else 0
            pc += 2
        else:
            raise SystemExit(f'unsupported opcode {op:02x} at {pc:04x}')
    raise SystemExit('runaway')


def unpack(packed):
    # e12d: U = 0xDF85, enter at 0xE19F (CLRB; LDA ,Y+; next)
    dst, X, Y = run(0xE19F, 0xDF85, packed, 126)
    return dst, Y


# Find packed size: unpack a zero buffer and see how far Y went.
_, used = unpack(bytes(200))
PACKED = used
widths = {}
for bit in range(PACKED * 8):
    src = bytearray(PACKED)
    src[bit // 8] = 1 << (bit % 8)
    out, _ = unpack(src)
    for off, v in enumerate(out):
        if v:
            widths.setdefault(off, []).append((bit, v))

# Sign extension list at 0xE08B: [bits][offset] pairs, 0 terminates.
signed = {}
a = 0xE08B
while rom[a - B0]:
    signed[rom[a - B0 + 1]] = rom[a - B0]
    a += 2

if __name__ == '__main__':
    print('packed bytes per patch:', PACKED)
    for off in range(126):
        bits = widths.get(off, [])
        vals = sorted(v for _, v in bits)
        nbits = len(bits)
        s = signed.get(off)
        print(f'{off:3d} sysex byte {off + 8:3d}: {nbits} bits {"signed(" + str(8 - s) + " bits)" if s else ""} values {vals}')
