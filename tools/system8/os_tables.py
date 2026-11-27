#!/usr/bin/env python3
"""Extract the SYSTEM-8 OS 1.32 parameter catalog from the OS plaintext (re/system8/osdump/os_full.bin, run
address 0x60000000; master core 0 = the first 0x130E00 bytes).

What the OS holds (found 2026-11-26, docs/devices/roland-system8.md "OS parameter catalog"):
  0x600ED688  129 group keys (sys_com, plugout, ..., pfm_com, ..., lfo, osc1, ..., pat2_lfo, ..., pat3_seq_step63)
  0x600ED8C8  6783 parameter names (the OS's own labels: "Rx Edit Data", "Perf Lev", "Wave" ...)
  0x600F42C4  6783 value descriptions: the screen texts, in the OS's mini language
              \\x01 list separator, \\x02 range anchors, \\x03[TAG] special formatter, \\x04 first value apart,
              \\x05{unit}, \\x06(offset), \\x07<decimals>
  0x6009D9A8  6783 records of 32 bytes: default, min, max, bias (s32 each), type<<16 | offset, 0x00FF0000 | group,
              SysEx address (b0 b1 b2 b3 big-endian in a word, FFFFFFFF = not reachable by SysEx), 0
              type: low byte = nibbles << 4 | 4 (0x14 = one 7-bit byte), 0x100 read-only, 0x200 signed (bias),
              0x400 not in the SysEx map, 0x800 reserved
  0x600FB3D8  CC map: 128 x (u16 cc, u16 group, u16 parameter index), FFFF = no parameter
  0x600D2988  SysEx leaf map: 107 x (u32 unpacked address, u16 bytes, u16 group, u32 0) - every leaf the RQ1 / DT1
              handler knows in the system and temporary areas (01 50, 03, 04, 05, 06); the parameter manager's
              descriptor at 0x6009C538 points at the records, the group ranges (0x6009C568), the CC map and this map
  formatter tables of FUN_6005032e: 0x600FB0C0 note names, 0x600FB0F0 [PART_LEV], 0x600FB2F0 [HI_CUT],
              0x600FB32C [LO_CUT], 0x600FB374 [LDMP_F], 0x600FB3A0 [HDMP_F], 0x600FACC0 [OSC3_TUNE]

usage: python -I tools/system8/os_tables.py re/system8/osdump/os_full.bin re/system8/osdump/os_params.json
"""
import json, struct, sys

BASE = 0x60000000
N = 6783
NGROUPS = 129
A_GROUPS, A_NAMES, A_VALS, A_RECS, A_CC = 0x600ED688, 0x600ED8C8, 0x600F42C4, 0x6009D9A8, 0x600FB3D8
A_LEAVES = 0x600D2988
TAG_TABLES = {'NOTE': (0x600FB0C0, 12, 'ptr'), 'PART_LEV': (0x600FB0F0, 128, 'ptr'), 'HI_CUT': (0x600FB2F0, 15, 'ptr'),
              'LO_CUT': (0x600FB32C, 18, 'ptr'), 'LDMP_F': (0x600FB374, 11, 'ptr'), 'HDMP_F': (0x600FB3A0, 14, 'ptr'),
              'OSC3_TUNE': (0x600FACC0, 256, 'ptr')}


def main():
    src, out = sys.argv[1:3]
    img = open(src, 'rb').read()[:0x130E00]
    u32 = lambda a: struct.unpack_from('<I', img, a - BASE)[0]

    def cstr(a):
        o = a - BASE
        return img[o:img.index(b'\0', o)].decode('latin-1')

    groups = [cstr(u32(A_GROUPS + 4 * i)) for i in range(NGROUPS)]
    params = []
    for i in range(N):
        d, mn, mx, bias, to, grp, addr, _x = struct.unpack_from('<iiiiIIII', img, A_RECS + 32 * i - BASE)
        g = grp & 0xFFFF
        params.append({
            'i': i, 'group': g, 'gkey': groups[g] if g < NGROUPS else f'g{g}', 'name': cstr(u32(A_NAMES + 4 * i)),
            'text': cstr(u32(A_VALS + 4 * i)), 'default': d, 'min': mn, 'max': mx, 'bias': bias,
            'type': to >> 16, 'nibbles': (to >> 20) & 0xF, 'offset': to & 0xFFFF,
            'addr': None if addr == 0xFFFFFFFF else [(addr >> 24) & 0x7F, (addr >> 16) & 0x7F, (addr >> 8) & 0x7F, addr & 0x7F],
        })
    cc = []
    for n in range(128):
        c, g, p = struct.unpack_from('<HHH', img, A_CC + 6 * n - BASE)
        assert c == n, (n, c)
        cc.append(None if p == 0xFFFF else {'cc': n, 'group': groups[g], 'i': p, 'name': params[p]['name']})
    leaves = []
    a = A_LEAVES
    while True:
        addr, size, g, _z = struct.unpack_from('<IHHI', img, a - BASE)
        if not (addr or size or g):
            break
        leaves.append({'addr': [(addr >> 21) & 0x7F, (addr >> 14) & 0x7F, (addr >> 7) & 0x7F, addr & 0x7F], 'size': size, 'group': groups[g] if g < NGROUPS else f'g{g}'})
        a += 12
    tables = {}
    for k, (a, n, how) in TAG_TABLES.items():
        if how == 'ptr':
            tables[k] = [cstr(u32(a + 4 * i)) for i in range(n)]
        else:
            tables[k] = [img[a - BASE + 4 * i:a - BASE + 4 * i + 4].split(b'\0')[0].decode() for i in range(n)]
    json.dump({'source': 'SYSTEM-8 OS 1.32 core 0 (re/system8/osdump/os_full.bin)', 'groups': groups, 'params': params,
               'cc': cc, 'leaves': leaves, 'tables': tables}, open(out, 'w'), indent=0)
    reach = [p for p in params if p['addr']]
    print(out, len(params), 'parameters,', len(reach), 'with SysEx addresses,', sum(1 for c in cc if c), 'CCs,', len(leaves), 'SysEx leaves')


if __name__ == '__main__':
    main()
