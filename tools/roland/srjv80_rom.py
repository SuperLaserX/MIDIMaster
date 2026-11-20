"""Read Roland SR-JV80 expansion board ROM dumps.

The dumps are the board's mask ROM read straight from the chip, so address and data lines
are scrambled the way Roland's PCM chips expect (the same wiring as the Sound Canvas wave
ROMs; see the Nuked-SC55 project). Within each 1 MB block, CPU address bit j comes from
chip address bit AA[j]; data bit j from chip data bit DD[j].

Unscrambled board layout (big-endian):
  00-1F  scrambled "Roland JV80 O.S." signature      20  board ID text ("POP100")
  30     release date ("1992-02-16")
  60     u16 sample count, u16 wave count, u16 0, u16 patch count, u16 rhythm set count
  80     u32 sample table, u32 wave table, u32 0, u32 patch table, u32 rhythm table
  Waves:   60 bytes: name[12], top key[16], sample number[16] (u16, FFFF unused)
  Patches: 362 bytes, JV-80 format: name[12], 14 common bytes, 4 tones of 84 bytes
  Rhythm:  61 notes (C2-C7) of 44 bytes, no name

The Experience boards SR-JV80-97 and -98 hold waves only; their patches are not on the
board (the 98's 100 patches come from the patch list shipped with the dump, the 97 has
none listed and is read from the unit once). The SR-JV80-99 has 64 patches on the board.
No board holds performances.

usage: python3 -I srjv80_rom.py <folder with the board .zip or .bin files> <out folder>
       writes <out>/jvNN.uns (unscrambled) for every board found
       python3 -I srjv80_rom.py <folder> --js <out.js>
       writes the board names, wave names and patch names as a JS module
"""
import glob
import json
import os
import re
import struct
import sys
import zipfile

AA = [2, 0, 3, 4, 1, 9, 13, 10, 18, 17, 6, 15, 11, 16, 8, 5, 12, 7, 14, 19]
DD = [2, 0, 4, 5, 7, 6, 3, 1]

_AMAP = None
_DMAP = None


def _tables():
    global _AMAP, _DMAP
    if _AMAP is None:
        amap = [0] * (1 << 20)
        for i in range(1 << 20):
            a = 0
            for j in range(20):
                if i & (1 << j):
                    a |= 1 << AA[j]
            amap[i] = a
        dmap = bytearray(256)
        for s in range(256):
            d = 0
            for j in range(8):
                if s & (1 << DD[j]):
                    d |= 1 << j
            dmap[s] = d
        _AMAP, _DMAP = amap, bytes(dmap)
    return _AMAP, _DMAP


def unscramble(src):
    amap, dmap = _tables()
    dst = bytearray(len(src))
    for base in range(0, len(src), 1 << 20):
        blk = src[base:base + (1 << 20)]
        out = bytes(blk[amap[i]] for i in range(len(blk)))
        dst[base:base + len(out)] = out.translate(dmap)
    return bytes(dst)


def text(b):
    return b.decode('latin-1').rstrip(' \x00')


def parse(rom):
    """Header, waves, patch names and rhythm set count of an unscrambled board."""
    board_id = rom[0x20:0x30].split(b'\0')[0].decode('latin-1')
    date = rom[0x30:0x3A].decode('latin-1')
    n_samples, n_waves, _, n_patches, n_rhythm = struct.unpack('>5H', rom[0x60:0x6A])
    p_samples, p_waves, _, p_patches, p_rhythm = struct.unpack('>5I', rom[0x80:0x94])
    waves = []
    for i in range(n_waves):
        r = rom[p_waves + i * 60:p_waves + (i + 1) * 60]
        keys = list(r[12:28])
        samples = [s for s in struct.unpack('>16H', r[28:60]) if s != 0xFFFF]
        waves.append({'name': text(r[:12]), 'keys': keys, 'samples': samples})
    patches = []
    for i in range(n_patches):
        r = rom[p_patches + i * 362:p_patches + (i + 1) * 362]
        patches.append({'name': text(r[:12]), 'data': r})
    return {
        'id': board_id, 'date': date, 'samples': n_samples, 'waves': waves, 'patches': patches,
        'rhythm_sets': n_rhythm, 'rhythm_at': p_rhythm, 'tables': (p_samples, p_waves, p_patches),
    }


def board_number(name):
    """'SR-JV80-05 World ...' -> 5."""
    m = re.search(r'SR-JV80-(\d+)', name, re.I)
    return int(m.group(1)) if m else None


def listed_patches(text_file):
    """Patch names from a board's text patch list ("01 *Dy.Rhodes 1     Piano").

    The name is the 12 characters after the number; a leading '*' is part of the name, as
    on the SR-JV80-99 whose ROM names match its list.
    """
    lines = text_file.splitlines()
    start = next((k for k, line in enumerate(lines) if 'PATCH LIST' in line), None)
    if start is None:
        return None
    names = []
    for line in lines[start + 1:]:
        m = re.match(r'(\d{2,3})', line)
        if m and int(m.group(1)) == len(names) + 1:
            names.append(line[3:15].rstrip())
    return names or None


def load_boards(folder):
    """Yield (board number, unscrambled ROM, text files) for every .zip or .bin in a folder."""
    for path in sorted(glob.glob(os.path.join(folder, '*'))):
        num = board_number(os.path.basename(path))
        if num is None:
            continue
        if path.lower().endswith('.zip'):
            with zipfile.ZipFile(path) as zf:
                texts = [zf.read(i).decode('latin-1') for i in zf.infolist() if i.filename.lower().endswith('.txt')]
                for info in zf.infolist():
                    if info.filename.lower().endswith('.bin'):
                        yield num, unscramble(zf.read(info)), texts
                        break
        elif path.lower().endswith('.bin'):
            with open(path, 'rb') as f:
                yield num, unscramble(f.read()), []


HEADER = """// Generated by tools/roland/srjv80_rom.py from SR-JV80 expansion board ROM dumps. Do not edit.
// Per board number (as the JV-2080 reports it in its patch group ID): the board's ID text and
// release date from its ROM header, its wave names in wave-number order, and its patch names in
// patch-number order (null when they are not on the board). Boards hold no performances.
"""


def write_js(boards, path):
    lines = [HEADER, 'export const SRJV80_BOARDS = {']
    for num in sorted(boards):
        b = boards[num]
        lines.append(f'  {num}: {{')
        lines.append(f'    code: {json.dumps(b["code"])}, date: {json.dumps(b["date"])}, rhythmSets: {b["rhythm_sets"]},'
                     f' patchSource: {json.dumps(b["patch_source"])},')
        lines.append(f'    waves: {json.dumps(b["waves"], ensure_ascii=False)},')
        lines.append(f'    patches: {json.dumps(b["patches"], ensure_ascii=False)},')
        lines.append('  },')
    lines.append('};')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


def collect(folder):
    boards = {}
    for num, rom, texts in load_boards(folder):
        b = parse(rom)
        patches = [p['name'] for p in b['patches']]
        source = 'rom' if patches else None
        if not patches:
            for t in texts:
                listed = listed_patches(t)
                if listed:
                    patches, source = listed, 'list'
                    break
        boards[num] = {
            'code': b['id'].strip(), 'date': b['date'], 'rhythm_sets': b['rhythm_sets'],
            'waves': [w['name'] for w in b['waves']], 'patches': patches or None, 'patch_source': source,
        }
        print(f'{num:02d} {b["id"]:10} {b["date"]} samples {b["samples"]:4} waves {len(b["waves"]):3} '
              f'patches {len(patches or []):3} ({source}) rhythm sets {b["rhythm_sets"]}', file=sys.stderr)
    return boards


if __name__ == '__main__':
    src = sys.argv[1]
    if sys.argv[2] == '--js':
        write_js(collect(src), sys.argv[3])
    else:
        out = sys.argv[2]
        os.makedirs(out, exist_ok=True)
        for num, rom, _texts in load_boards(src):
            with open(os.path.join(out, f'jv{num:02d}.uns'), 'wb') as f:
                f.write(rom)
            b = parse(rom)
            print(f'{num:02d} {b["id"]:10} {b["date"]} samples {b["samples"]:4} waves {len(b["waves"]):3} '
                  f'patches {len(b["patches"]):3} rhythm sets {b["rhythm_sets"]}')
