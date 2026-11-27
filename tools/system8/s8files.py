"""SYSTEM-8 SD-card files (OS 1.32): the .s8p patch export, the .s8f performance export and the BACKUP .bin.

Format (read from the OS's file code, master core 0: header builder 0x6000CB3E, chunk header 0x6000CC04, checks
0x6000C76A / 0x6000C71E / 0x6000C6E8, chunk tables 0x600954A4 (backup), 0x6009566C (.s8p), 0x60095694 (.s8f)):

  file header (0x30): magic[4] ("S8P ", "S8F ", "SYS8"), u32 0, u32 chunk count, u32 0, 16 bytes name (spaces),
                      8 bytes 0, u32 CRC32 of all chunk headers, u32 CRC32 of header[0:0x2C]
  chunk header (0x20): tag[4], u32 0, u32 data size, u32 0, u32 count, u32 entry size, u32 CRC32 of the data,
                      u32 CRC32 of chunk header[0:0x1C]; then the data.
  CRC32 = zlib.crc32 (checked on the factory sound bank S8_V120_Pat.s8p).

Entries are the OS's internal structs: one 32-bit little-endian word per OS parameter, the catalog groups back to
back (PAT 512 = lfo..extend + pat_name, PAT2 2200, PAT3 14096, PRF 1744, SYS 2196). A word holds the parameter's
logical value: SysEx raw value minus the bias for the parameters stored with a bias (type 200h), otherwise the raw
value (8-nibble values as their 32-bit pattern).

This module: conversion SysEx compact data <-> internal structs (from re/system8/osdump/os_params.json), the file
reader / writer, and a self-check against the factory bank and the plugin's preset bank:

  python -I tools/system8/s8files.py check
"""
import json
import os
import struct
import sys
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
OS_JSON = os.path.join(ROOT, 're', 'system8', 'osdump', 'os_params.json')

PATCH_LEAVES = [[0x00, 14], [0x0e, 10], [0x18, 16], [0x28, 12], [0x34, 6], [0x3a, 20], [0x4e, 10], [0x58, 8], [0x60, 12],
                [0x6c, 20], [0x80, 240], [0x170, 240], [0x260, 32]]
PATCH2_LEAVES = [[k * 0x800, n] for k, n in enumerate([240, 240, 240, 240, 240, 234, 234, 240, 240, 240, 230, 216, 212, 233, 222, 234, 240])]
PATCH3_LEAVES = [[k * 0x800, n] for k, n in enumerate([236] * 65 + [240])]
PERF_LEAVES = [[k * 0x800, n] for k, n in enumerate([228, 226, 226, 225, 211, 230, 216, 212, 233, 222, 240, 240])]


class Struct:
    def __init__(self, leaves, at=0):
        self.leaves = leaves
        self.at = at
        self.starts = []
        o = at
        for _, n in leaves:
            self.starts.append(o)
            o += n
        self.size = o - at

    def compact(self, p):
        for k in range(len(self.leaves) - 1, -1, -1):
            if p >= self.leaves[k][0]:
                return self.starts[k] + p - self.leaves[k][0] if p - self.leaves[k][0] < self.leaves[k][1] else -1
        return -1


S_PATCH = Struct(PATCH_LEAVES, 0)
S_PATCH2 = Struct(PATCH2_LEAVES, S_PATCH.size)
S_PATCH3 = Struct(PATCH3_LEAVES, S_PATCH.size + S_PATCH2.size)
S_PERF = Struct(PERF_LEAVES, 0)
FULL_SIZE = S_PATCH.size + S_PATCH2.size + S_PATCH3.size  # 20195

PAT_GROUPS = ['lfo', 'osc1', 'osc2', 'mix', 'pit', 'flt', 'amp', 'efx', 'ctrl', 'extend', 'pat_name']
PAT2_GROUPS = ['pat2_lfo', 'pat2_osc1', 'pat2_osc2', 'pat2_mix', 'pat2_pit', 'pat2_flt', 'pat2_amp', 'pat2_efx', 'pat2_ctrl',
               'pat2_name', 'pat2_dly', 'pat2_cho', 'pat2_fl', 'pat2_mfx', 'pat2_rev', 'pat2_chord', 'pat2_extd']
PAT3_GROUPS = ['pat3_seq_com'] + ['pat3_seq_step%d' % i for i in range(64)] + ['g129']
PRF_GROUPS = ['pfm_com', 'pfm_upper', 'pfm_lower', 'pfm_cvgate', 'pfm_input', 'pfm_in_dly', 'pfm_in_cho', 'pfm_in_fl',
              'pfm_in_mfx', 'pfm_in_rev', 'pfm_name', 'pfm_extd']
SYS_GROUPS = ['sys_com', 'plugout', 'sys_cal', 'sys_cvgate', 'sys_input', 'sys_in_dly', 'sys_in_cho', 'sys_in_fl',
              'sys_in_mfx', 'sys_in_rev', 'sys_scale', 'sys_extd']
PAT_SIZE, PAT2_SIZE, PAT3_SIZE, PRF_SIZE, SYS_SIZE = 0x200, 0x898, 0x3710, 0x6D0, 0x894
PATS_SIZE = PAT_SIZE + PAT2_SIZE + PAT3_SIZE  # 16808, one .s8p entry
PRFS_SIZE = PRF_SIZE + 2 * PATS_SIZE  # 35360, one .s8f entry


def load_catalog(path=OS_JSON):
    j = json.load(open(path))
    by = {}
    for p in j['params']:
        by.setdefault(p['gkey'], []).append(p)
    return by


def layout(cat, groups, sysex_struct=None, sysex_b0=None):
    """[(internal offset, compact offset or None, nibbles, bias or None)] for every parameter of `groups` in order;
    the internal struct is the groups back to back (each group's size = its last offset + 4)."""
    rows = []
    o = 0
    for g in groups:
        ps = cat[g]
        for p in ps:
            c = None
            if sysex_struct is not None and p['addr'] is not None:
                a = p['addr']
                if a[0] != sysex_b0:
                    raise ValueError(f'{g} {p["name"]}: address {a} not in area {sysex_b0:02x}')
                c = sysex_struct.compact((a[1] << 14) | (a[2] << 7) | a[3])
                if c < 0:
                    raise ValueError(f'{g} {p["name"]}: address {a} outside the leaves')
            rows.append((o + p['offset'], c, p['nibbles'], p['bias'] if p['type'] & 0x200 else None))
        o += max(p['offset'] for p in ps) + 4
    return rows, o


def raw_at(d, c, n):
    if n == 1:
        return d[c] & 0x7f
    v = 0
    for i in range(n):
        v = (v << 4) | (d[c + i] & 15)
    return v


def put_raw(d, c, n, v):
    if n == 1:
        d[c] = v & 0x7f
        return
    for i in range(n - 1, -1, -1):
        d[c + i] = v & 15
        v >>= 4


def to_internal(rows, size, d):
    out = bytearray(size)
    for o, c, n, bias in rows:
        if c is None:
            continue
        r = raw_at(d, c, n)
        v = r - bias if bias is not None else r
        struct.pack_into('<I', out, o, v & 0xffffffff)
    return bytes(out)


def from_internal(rows, b, d):
    for o, c, n, bias in rows:
        if c is None:
            continue
        v = struct.unpack_from('<i', b, o)[0]
        r = v + bias if bias is not None else v
        mask = 0x7f if n == 1 else (1 << (4 * n)) - 1
        put_raw(d, c, n, r & mask)
    return d


# ------------------------------------------------------------------ files
def crc(b):
    return zlib.crc32(b) & 0xffffffff


def build_file(magic, chunks, name=b''):
    """chunks: [(tag, count, entry size, data)] -> file bytes."""
    heads = []
    body = b''
    for tag, count, esize, data in chunks:
        h = bytearray(0x20)
        h[0:4] = tag
        struct.pack_into('<IIIIII', h, 4, 0, len(data), 0, count, esize, crc(data))
        struct.pack_into('<I', h, 0x1c, crc(bytes(h[:0x1c])))
        heads.append(bytes(h))
        body += bytes(h) + data
    hdr = bytearray(0x30)
    hdr[0:4] = magic
    struct.pack_into('<III', hdr, 4, 0, len(chunks), 0)
    hdr[0x10:0x20] = (name or b'').ljust(16, b' ')[:16]
    struct.pack_into('<I', hdr, 0x28, crc(b''.join(heads)))
    struct.pack_into('<I', hdr, 0x2c, crc(bytes(hdr[:0x2c])))
    return bytes(hdr) + body


def read_file(b):
    """{'magic', 'name', 'chunks': {tag: (count, esize, data)}, 'ok': [problems]}"""
    problems = []
    magic = b[0:4]
    count = struct.unpack_from('<I', b, 8)[0]
    if struct.unpack_from('<I', b, 0x2c)[0] != crc(b[:0x2c]):
        problems.append('header CRC')
    o = 0x30
    heads = []
    chunks = {}
    for _ in range(count):
        h = b[o:o + 0x20]
        heads.append(h)
        tag = h[0:4]
        _, size, _, n, esize, dcrc, hcrc = struct.unpack_from('<IIIIIII', h, 4)
        if hcrc != crc(h[:0x1c]):
            problems.append(f'{tag} header CRC')
        data = b[o + 0x20:o + 0x20 + size]
        if dcrc != crc(data):
            problems.append(f'{tag} data CRC')
        chunks[tag] = (n, esize, data)
        o += 0x20 + size
    if struct.unpack_from('<I', b, 0x28)[0] != crc(b''.join(heads)):
        problems.append('chunk headers CRC')
    if o != len(b):
        problems.append(f'{len(b) - o} bytes after the chunks')
    return {'magic': magic, 'name': b[0x10:0x20], 'chunks': chunks, 'problems': problems}


def check():
    cat = load_catalog()
    pat, n1 = layout(cat, PAT_GROUPS, S_PATCH, 3)
    pat2, n2 = layout(cat, PAT2_GROUPS, Struct(PATCH2_LEAVES, 0), 5)
    pat3, n3 = layout(cat, PAT3_GROUPS, Struct(PATCH3_LEAVES, 0), 6)
    prf, n4 = layout(cat, PRF_GROUPS, S_PERF, 4)
    sysl, n5 = layout(cat, SYS_GROUPS)
    print('struct sizes', n1, n2, n3, n4, n5, 'expected', PAT_SIZE, PAT2_SIZE, PAT3_SIZE, PRF_SIZE, SYS_SIZE)
    assert (n1, n2, n3, n4, n5) == (PAT_SIZE, PAT2_SIZE, PAT3_SIZE, PRF_SIZE, SYS_SIZE)
    sb = os.path.join(ROOT, 're', 'system8', 'soundbank', 'sb', 'S8_V120_Pat.s8p')
    f = read_file(open(sb, 'rb').read())
    print('factory .s8p', f['magic'], f['problems'] or 'all CRCs correct', {k: v[:2] for k, v in f['chunks'].items()})
    assert build_file(b'S8P ', [(t, *f['chunks'][t]) for t in (b'NAME', b'PLG ', b'PATs')]) == open(sb, 'rb').read()
    print('rebuilt byte for byte')
    names = [f['chunks'][b'NAME'][2][i * 16:(i + 1) * 16] for i in range(64)]
    pats = [f['chunks'][b'PATs'][2][i * PATS_SIZE:(i + 1) * PATS_SIZE] for i in range(64)]
    bank = r'C:\Program Files\Common Files\VST3\Roland\SYSTEM-8\Patch\2 Preset.bin'
    if os.path.exists(bank):
        kb = open(bank, 'rb').read()
        rec = 16 + 12 + FULL_SIZE
        recs = {kb[26 + i * rec:26 + i * rec + 16]: kb[26 + i * rec + 28:26 + (i + 1) * rec] for i in range((len(kb) - 26) // rec)}
        same = 0
        for nm, p in zip(names, pats):
            sx = recs.get(nm)
            if sx is None:
                print('not in the plugin bank:', nm)
                continue
            mine = to_internal(pat, PAT_SIZE, sx[:640]) + to_internal(pat2, PAT2_SIZE, sx[640:640 + 3975]) + to_internal(pat3, PAT3_SIZE, sx[4615:])
            diff = [i for i in range(PATS_SIZE) if mine[i] != p[i]]
            if diff:
                print(nm, len(diff), 'bytes differ, first at', [hex(x) for x in diff[:8]])
            else:
                same += 1
            back = bytearray(FULL_SIZE)
            from_internal(pat, p[:PAT_SIZE], memoryview(back)[:640])
        print(f'{same} of 64 factory patches: the plugin bank converted to internal = the .s8p entry byte for byte')


if __name__ == '__main__':
    if sys.argv[1:2] == ['check']:
        check()
