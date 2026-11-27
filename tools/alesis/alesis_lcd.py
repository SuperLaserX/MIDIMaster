# The custom LCD of the Alesis Wedge and MIDIVerb 4 (same glass, same segment map): run a display
# routine in the 8051 emulator and read back the text it draws under a slider column.
#   three 7-segment digits per column (segment groups table, 7 entries each, column c at 29c + 14),
#   decimal points (segments 30+23c after the first digit, 22+23c after the second) and unit icons
#   (190+c %, 198+c k, 202+c Hz, 206+c m, 210+c s). The firmware holds no text for the icons.
from i8051 import Cpu

SEG = {  # 7-segment patterns (bit 0 = a ... bit 6 = g) the firmware draws, as text; digits from its font
    0x00: ' ', 0x40: '-', 0x08: '_', 0x77: 'A', 0x7c: 'b', 0x39: 'C', 0x58: 'c', 0x5e: 'd', 0x79: 'E', 0x71: 'F',
    0x3d: 'G', 0x76: 'H', 0x74: 'h', 0x30: 'I', 0x1e: 'J', 0x38: 'L', 0x54: 'n', 0x5c: 'o', 0x73: 'P', 0x50: 'r',
    0x78: 't', 0x3e: 'U', 0x1c: 'u', 0x6e: 'y', 0x63: 'o', 0x04: 'i',
}


class Lcd:
    def __init__(self, data, font, groups, set_, clear, by_carry, skip=(), page=0xa2):
        self.d = data
        self.seg = dict(SEG)
        for i in range(10): self.seg[data[font + i]] = str(i)
        self.t550 = data[groups:groups + 0x100]
        self.set_, self.clear, self.by_carry, self.skip, self.page = set_, clear, by_carry, skip, page

    def run(self, setup, entry):
        cpu = Cpu(self.d)
        ops = {}
        def on(c): ops[c.a] = 1; return True
        def off(c): ops[c.a] = 0; return True
        cpu.hooks[self.set_] = on
        cpu.hooks[self.clear] = off
        cpu.hooks[self.by_carry] = lambda c: (ops.__setitem__(c.a, c.cy), True)[1]
        for a in self.skip: cpu.hooks[a] = lambda c: True
        cpu.wr(0xa0, self.page)
        cpu.ram[0x81] = 0x30
        setup(cpu)
        cpu.call(entry)
        return ops

    def text(self, ops, col):
        base = 29 * col
        chars = []
        for k in range(5):
            segs = self.t550[base + 7 * k: base + 7 * k + 7]
            pat = sum(1 << i for i, s in enumerate(segs) if ops.get(s))
            known = any(s in ops for s in segs)
            if k < 2:
                assert not pat, 'digit group %d used' % k
                continue
            if pat not in self.seg: raise ValueError('segment pattern %02x' % pat)
            chars.append(self.seg[pat] if known else ' ')
        if any(c.isalpha() for c in chars):  # 0/O and 5/S are the same segments: words read as letters
            chars = [{'0': 'O', '5': 'S'}.get(c, c) for c in chars]
        on = lambda s: ops.get(s) == 1
        t = chars[0] + ('.' if on(30 + 23 * col) else '') + chars[1] + ('.' if on(22 + 23 * col) else '') + chars[2]
        t = t.strip()
        unit = ('%' if on(190 + col) else '') + ('k' if on(198 + col) else '') + ('Hz' if on(202 + col) else '')             + ('m' if on(206 + col) else '') + ('s' if on(210 + col) else '')
        known = {30 + 23 * col, 22 + 23 * col, 190 + col, 198 + col, 202 + col, 206 + col, 210 + col}
        used = set(self.t550[base + 14: base + 43])
        extra = [s for s, v in ops.items() if v and s not in known and s not in used]
        assert not extra, 'unknown icons %s' % extra
        return t + (' ' + unit if unit and unit != '%' else unit)
