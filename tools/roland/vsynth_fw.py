"""Build the V-Synth XT editor's firmware tables (V-Synth engine, OS v2.02) as a JS module.

usage: python -I vsynth_fw.py <os image> <out .js> [<more images for value lists>]
  VC-2: python -I vsynth_fw.py os.4.50001C.bin roland-vsynthxt-vc2-fw.js os.2.0B001C.bin
  <os image>: the V-Synth application ("VAPP1"), the zlib stream at flash 0B0000 of V-SynthXT.rom
              (tools/roland/vsynth_rom.py unpacks the update file; re/vsynthxt/img/os.2.0B001C.bin),
              loaded at CPU 89300000 (SH-4, little endian).

Tables used (CPU addresses; see docs/devices/roland-vsynth-xt.md):
  89790338  parameter names, 2389 pointers. Index = parameter id; ids 0-55C are the system and
            patch parameters (one id per SysEx address: a value of n nibbles takes the n-1 ids before
            its name, named "!(dummy)"), 55D-954 the effect-type parameters (MFX, chorus, reverb,
            COSM type parameters, held in the "Parameter 1-32" slots of their block).
  897A167C  ids 0-55C, 12 bytes each: u16 byte offset and u8 bit width / u8 bit position in the
            internal 7-bit-packed patch (width FCh = a nibble of the next value, F8h/F0h/E0h = 8/16/32
            bits sent as 2/4/8 nibbles), s16 bias (display zero), s16 default, s16 min, s16 max.
  897A56D8  ids 55D-954, 8 bytes each: u16 slot (4n+3: "Parameter n+1"), s16 default, s16 min, s16 max.
  89792BA0  ids 0-55C, display spec per id: items separated by 01h, "a<02>b" a range, 03h a unit,
            e.g. "OFF\\x011\\x02999", "-48\\x02+48", "50\\x024000\\x03[Hz]", "0\\x02127\\x01MUSICAL-NOTES".
  89794114  the same for ids 55D-954.
  8979288C  effect types: u16 first id, u16 last id, pointer to the type's name, 98 entries
            (MFX 0-50, chorus 51-62, reverb 63-80, COSM 81-97).
  89795484  the 17 tempo-sync note values (LCD glyphs), 897950F4 pan L64-63R, 897952F4 CC names.
SysEx (decoder 89483E80 / 89483510, block handlers in the vtable at 89830028): a value is the
internal one, plus 64 - bias when its range goes below the bias and the bias is under 64
(FUN_894819C0); effect "Parameter n" slots hold value + 32768 in 4 nibbles.
"""
import json
import re
import struct
import sys

BASE = 0x89300000
b = open(sys.argv[1], 'rb').read()
u32 = lambda a: struct.unpack('<I', b[a - BASE:a - BASE + 4])[0]


def cstr(a):
    o = a - BASE
    return b[o:b.index(b'\x00', o)].decode('latin1')


# ------------------------------------------------------------------ where the tables are
# Found by their contents, so the same code reads the V-Synth (VAPP1) and VC-2 (VAPP2) applications,
# which share this framework (VAPP1 addresses in the header).
N_WORDS = len(b) // 4
WORDS = struct.unpack('<%dI' % N_WORDS, b[:N_WORDS * 4])


def is_str(p, maxlen=80):
    if not BASE <= p < BASE + len(b):
        return False
    o = p - BASE
    e = b.find(b'\x00', o, o + maxlen)
    return e > o and all(0x20 <= c < 0x7f for c in b[o:e])


def ptr_table(first_strings):
    """Address of a table of pointers whose first targets are these strings."""
    want = [x.encode('latin1') for x in first_strings]
    for i in range(N_WORDS - len(want)):
        ok = True
        for k, x in enumerate(want):
            p = WORDS[i + k]
            if not BASE <= p < BASE + len(b) - len(x) or b[p - BASE:p - BASE + len(x) + 1] != x + b'\x00':
                ok = False
                break
        if ok:
            return BASE + 4 * i
    raise SystemExit(f'pointer table {first_strings} not found')


# names: the pointer table whose first name is " Part 1 Bank Select MSB (CC# 0)"
NAMES = ptr_table([' Part 1 Bank Select MSB (CC# 0)'])
N_ALL = 0
while is_str(WORDS[(NAMES - BASE) // 4 + N_ALL]):
    N_ALL += 1
names = [cstr(u32(NAMES + 4 * i)).strip() for i in range(N_ALL)]
N_PATCH = names.index('_')  # the first effect-type parameter ("THRU")
# the literal pool of the name lookup holds: names, effect names, effect types, specs, effect specs
POOL = WORDS.index(NAMES)
assert WORDS[POOL + 1] == NAMES + 4 * N_PATCH, 'name lookup pool'
GROUPS, SPEC, ESPEC = WORDS[POOL + 2], WORDS[POOL + 3], WORDS[POOL + 4]
# the parameter table starts with the bank select entries; the effect table follows it
PTAB = BASE + b.index(bytes.fromhex('00 00 07 00 00 00 57 00 00 00 7f 00 00 00 07 07 00 00 00 00 00 00 7f 00'))
ETAB = PTAB + 12 * N_PATCH
print(f'names {NAMES:08X} ({N_ALL}, effects from {N_PATCH:X}), parameters {PTAB:08X}, effects {ETAB:08X}, types {GROUPS:08X}, specs {SPEC:08X} / {ESPEC:08X}')

# ------------------------------------------------------------------ firmware value lists
# Every run of adjacent strings in the data area: non-linear ranges (EQ frequencies, Q values...)
# are looked up here by their first value, last value and length.
# The data area: from the first 64 KB without code returns (rts) on. Further images given after the
# output (the V-Synth application when building the VC-2 tables) add their lists: the effect
# algorithms are the same, and some VC-2 value lists are only in the V-Synth's image.
norm = lambda s: re.sub(r'\s+|Hz$|\[.*\]$', '', s)
runs = []
for img in [b] + [open(x, 'rb').read() for x in sys.argv[3:]]:
    DATA = next(o for o in range(0, len(img), 0x10000) if img[o:o + 0x10000].count(b'\x0b\x00') < 12 and o > 0x100000)
    strs = [(m.start() + BASE + DATA, m.group(1).decode('latin1')) for m in re.finditer(rb'([\x20-\x7e]{1,24})\x00', img[DATA:])]
    cur = []
    for a, s in strs:
        if cur and a - (cur[-1][0] + len(cur[-1][1])) > 8:
            runs.append(cur)
            cur = []
        cur.append((a, s))
    runs.append(cur)


def find_list(first, last, n=None, fits=None):
    """Firmware strings from `first` to `last`: exactly n of them, or (n None) a list of rising
    numbers whose length satisfies fits(length) (e.g. "leaves 1-17 values for the note list")."""
    for run in runs:
        vals = [norm(s) for _, s in run]
        for i, v in enumerate(vals):
            if v != first:
                continue
            if n is not None:
                if i + n - 1 < len(vals) and vals[i + n - 1] == last:
                    return [s.strip() for _, s in run[i:i + n]]
                continue
            for j in range(i + 1, len(vals)):
                if vals[j] != last:
                    continue
                lst = [s.strip() for _, s in run[i:j + 1]]
                nums = [number_parts(norm(x)) for x in lst]
                # a value list: numbers rising from first to last
                if all(nums) and all(nums[k][2] < nums[k + 1][2] for k in range(len(nums) - 1)) and (fits is None or fits(len(lst))):
                    return lst
    return None


NOTE_GLYPHS = {0x0C: '1/32', 0x11: '1/16', 0x12: '1/8', 0x18: '1/4', 0x13: '1/2', 0x14: '1', 0x15: '2'}


def note_value(s):
    g = NOTE_GLYPHS[ord(s[0])]
    return g + ('T' if s[1:] == '\x17' else '.' if s[1:] == '.' else '')


MUSICAL_AT = ptr_table(['\x0c ', '\x11 ', '\x12\x17'])
PAN_AT = ptr_table(['L64', 'L63'])
CC_AT = ptr_table(['OFF', 'CC01', 'CC02'])
MUSICAL = [note_value(cstr(u32(MUSICAL_AT + 4 * k))) for k in range(17)]
PAN = [cstr(u32(PAN_AT + 4 * k)).strip() for k in range(128)]
CC = [cstr(u32(CC_AT + 4 * k)).strip() for k in range(0x60)]  # CC32 shows as OFF
CC_SPEC = 'OFF\x01CC01\x02CC31\x01CC33\x02CC95'
NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
note = lambda n: f'{NOTE_NAMES[n % 12]}{n // 12 - 1}'
NOTE_INDEX = {note(n): n for n in range(128)}

# ------------------------------------------------------------------ display spec -> segments
# A segment: ["L", label] one value | ["N", count, first, step, decimals, plus, prefix, suffix, pad]
# numbers | ["K", count, first note] note names | ["T", [labels]] a firmware list | ["X", digits] hex.
problems = []


def number_parts(s):
    m = re.fullmatch(r'(\D*?)([+-]?)(\d+(?:\.\d+)?)(\D*)', s)
    if not m:
        return None
    pre, sign, num, post = m.groups()
    return pre, sign, float(num) * (-1 if sign == '-' else 1), len(num.split('.')[1]) if '.' in num else 0, post, len(num.split('.')[0])


def segments(spec, count, pid):
    unit = ''
    if '\x03' in spec:
        spec, unit = spec.split('\x03', 1)
        unit = unit.strip('[]')
        if unit == 'ASCII':
            return [['A']], ''
    pre = []
    if spec.startswith(CC_SPEC):  # the CC name table (FUN_894621A0): OFF, CC01-CC31, OFF, CC33-CC95
        pre = [['T', CC]]
        spec = spec[len(CC_SPEC):].lstrip('\x01')
        count -= len(CC)
    items = spec.split('\x01') if spec else []
    segs = []
    sizes = []
    for it in items:
        if it == 'MUSICAL-NOTES':
            segs.append(['T', MUSICAL])
            sizes.append(17)
        elif it == 'note':  # tempo-synced values: the note glyphs, as many as the range leaves
            segs.append(['note'])
            sizes.append(None)
        elif '\x02' in it:
            a, z = it.split('\x02')
            segs.append(['R', a.strip(), z.strip()])
            sizes.append(None)
        else:
            segs.append(['L', it])
            sizes.append(1)
    # range sizes: integer step-1 ranges first, then the one left takes the rest
    for i, s in enumerate(segs):
        if s[0] != 'R':
            continue
        a, z = s[1], s[2]
        if a in NOTE_INDEX and z in NOTE_INDEX:
            sizes[i] = NOTE_INDEX[z] - NOTE_INDEX[a] + 1
            continue
        pa, pz = number_parts(a), number_parts(z)
        if pa and pz and pa[3] == 0 and pz[3] == 0 and pa[0] == pz[0] and pa[4] == pz[4] and len(segs) > 1 and sizes.count(None) > 1 and not any(x[0] == 'note' for x in segs):
            sizes[i] = int(pz[2] - pa[2]) + 1
    # an integer range that alone fills the value range: the other items do not apply (the VC-2's
    # envelope times list MUSICAL-NOTES but hold 0-127 only)
    for i, sg in enumerate(segs):
        if sg[0] == 'R' and len(segs) > 1:
            pa, pz = number_parts(sg[1]), number_parts(sg[2])
            if pa and pz and pa[3] == pz[3] == 0 and not pa[0] and not pa[4] and int(pz[2] - pa[2]) + 1 == count and pa[2] == 0:
                segs, sizes = [sg], [count]
                break
    # a range next to 'note': its length is that of the firmware's own list
    if any(x[0] == 'note' for x in segs):
        for i, sg in enumerate(segs):
            if sg[0] == 'R' and sizes[i] is None:
                others = sum(x for k, x in enumerate(sizes) if x is not None and k != i)
                lst = find_list(norm(sg[1]), norm(sg[2]), fits=lambda L: 0 <= count - others - L <= len(MUSICAL))
                if lst:
                    segs[i] = ['T', lst]
                    sizes[i] = len(lst)
    known = sum(x for x in sizes if x is not None)
    unknown = [i for i, x in enumerate(sizes) if x is None]
    if len(unknown) == 1:
        sizes[unknown[0]] = count - known
    elif unknown:
        problems.append((pid, 'several open ranges', spec))
        return [['L', spec]], unit
    out = list(pre)
    for s, n in zip(segs, sizes):
        if s[0] == 'note':
            if not 0 <= n <= len(MUSICAL):
                problems.append((pid, f'{n} note values', spec))
            elif n:  # none left: this range holds no note values
                out.append(['T', MUSICAL[-n:]])
            continue
        if s[0] != 'R':
            out.append(s)
            continue
        a, z = s[1], s[2]
        if a in NOTE_INDEX and z in NOTE_INDEX:
            out.append(['K', n, NOTE_INDEX[a]])
            continue
        if a in ('L64', 'L63') and z == '63R':
            out.append(['T', PAN[128 - n:]])
            continue
        if a == 'E0:D100' and z == 'E100:D0':  # effect balance, effect:direct
            out.append(['T', [f'E{k}:D{n - 1 - k}' for k in range(n)]])
            continue
        if re.fullmatch(r'[0-9A-F]+h', a) and re.fullmatch(r'[0-9A-F]+h', z):
            out.append(['X', len(a) - 1])
            continue
        pa, pz = number_parts(a), number_parts(z)
        if not pa or not pz or pa[0] != pz[0] or pa[4] != pz[4]:
            problems.append((pid, 'range not understood', it_repr(a, z)))
            out.append(['L', f'{a}..{z}'])
            continue
        if n < 1:
            problems.append((pid, f'range has {n} values', it_repr(a, z)))
            out.append(['L', f'{a}..{z}'])
            continue
        dec = max(pa[3], pz[3])
        step = (pz[2] - pa[2]) / (n - 1) if n > 1 else 1
        # a linear run when every value lands on the display's decimal places
        if n == 1 or abs(round(step * 10 ** dec + 1e-9) - step * 10 ** dec) < 1e-6 or abs(step * 2 * 10 ** dec - round(step * 2 * 10 ** dec)) < 1e-6:
            dec2 = dec if abs(round(step * 10 ** dec) - step * 10 ** dec) < 1e-6 else dec + 1
            pad = pa[5] if a.lstrip('+-').startswith('0') and pa[5] > 1 else 0
            out.append(['N', n, round(pa[2], 6), round(step, 6), dec2, '+' in a or '+' in z, pa[0], pa[4], pad])
            continue
        lst = find_list(norm(a), norm(z), n)
        if lst:
            out.append(['T', lst])
            continue
        problems.append((pid, f'non-linear range, no firmware list ({n} values)', it_repr(a, z)))
        out.append(['N', n, pa[2], step, dec + 2, '+' in a, pa[0], pa[4], 0])
    return out, unit


def it_repr(a, z):
    return f'{a}..{z}'


# ------------------------------------------------------------------ the parameters
P = []
for i in range(N_PATCH):
    off, wd, bp, bias, dflt, mn, mx = struct.unpack('<HBBhhhh', b[PTAB - BASE + 12 * i:PTAB - BASE + 12 * i + 12])
    name = names[i]
    if wd == 0xFC or name == '!(dummy)' or name == '_':
        P.append(None)
        continue
    nib = {0xF8: 2, 0xF0: 4, 0xE0: 8}.get(wd, 1)
    if nib > 1:
        mn &= (1 << (4 * nib)) - 1 if mn < 0 and nib == 4 and bias == -32768 else -1
    shift = 64 - bias if nib == 1 and mn < bias < 64 else 0
    spec = cstr(u32(SPEC + 4 * i))
    if bias == -32768:  # effect parameter slots: value + 32768, ranges per effect type
        P.append([name, nib, 0, 65535, 32768, [['E']], '', 0])
        continue
    count = mx - mn + 1
    segs, unit = segments(spec, count, i)
    P.append([name, nib, mn + shift, mx + shift, dflt + shift, segs, unit, shift])

E = []
for i in range(N_PATCH, N_ALL):
    slot, dflt, mn, mx = struct.unpack('<HhhH', b[ETAB - BASE + 8 * (i - N_PATCH):ETAB - BASE + 8 * (i - N_PATCH) + 8])
    mx = struct.unpack('<h', struct.pack('<H', mx))[0]
    name = names[i]
    if name == '_':
        E.append(None)
        continue
    spec = cstr(u32(ESPEC + 4 * (i - N_PATCH)))
    segs, unit = segments(spec, mx - mn + 1, i)
    E.append([name, (slot - 3) // 4 + 1, dflt, mn, mx, segs, unit])

FX = []
k = 0
while True:
    f, l, p = struct.unpack('<HHI', b[GROUPS - BASE + 8 * k:GROUPS - BASE + 8 * k + 8])
    if not (N_PATCH <= f <= l < N_ALL) or not is_str(p):
        break
    FX.append([json.loads(cstr(p))[0], f - N_PATCH, l - N_PATCH])
    k += 1
# Effect type lists by block (the accessors at 89461A10/A30/A50 in VAPP1 index the table from 51,
# 62 and 81): MFX from 0 (THRU), chorus from the first OFF, reverb from the OFF that follows the
# chorus types, COSM from the THRU after that. Spare THRU/OFF entries pad each block.
names_fx = [x[0] for x in FX]
ch = names_fx.index('OFF')
rv = next(i for i in range(ch + 1, len(FX)) if names_fx[i] == 'OFF' and names_fx[i - 1] != 'OFF' and i > ch + 1)
while names_fx[rv + 1] == 'OFF':  # several spare OFF entries: the reverb list starts at the last one
    rv += 1
cs = names_fx.index('THRU', rv)
FX_BLOCKS = {'mfx': [0, ch], 'chorus': [ch, rv], 'reverb': [rv, cs], 'cosm': [cs, len(FX)]}
print('effect blocks', FX_BLOCKS)

if problems:
    print(f'{len(problems)} display specs need attention:')
    for p in problems[:60]:
        print('  ', p[0], names[p[0]], '|', p[1], '|', repr(p[2]))

js = [
    '// Generated by tools/roland/vsynth_fw.py from the V-Synth XT OS 2.02 V-Synth application (VAPP1).',
    '// P[id]: [name, nibbles, min, max, default, display, unit, sysexShift] (SysEx values; null = a nibble',
    '// of the next parameter). E[id - 0x55D]: [name, slot n ("Parameter n"), default, min, max, display, unit].',
    '// FX: [type name, first E index, last E index]; FX_BLOCKS: the FX entries of each effect block.',
    '// Display segments: ["L", label] | ["N", count, first, step, decimals, plus, prefix, suffix, pad]',
    '// | ["K", count, first note] | ["T", [labels]] | ["X", hex digits] | ["A"] ASCII | ["E"] effect slot.',
    f'export const P = {json.dumps(P, separators=(",", ":"))};',
    f'export const E = {json.dumps(E, separators=(",", ":"))};',
    f'export const FX = {json.dumps(FX, separators=(",", ":"))};',
    f'export const FX_BLOCKS = {json.dumps(FX_BLOCKS)};',
    f'export const MUSICAL = {json.dumps(MUSICAL)};',
]
open(sys.argv[2], 'w', encoding='utf-8').write('\n'.join(js) + '\n')
print('written', sys.argv[2], len([p for p in P if p]), 'parameters,', len([e for e in E if e]), 'effect parameters,', len(FX), 'effect types; notes', MUSICAL)

# Patch categories (the PATCH Category screen): "No Assign", "Synth", "Lead", "Pad\nStrings"...
h = b.index(b'No Assign\x00\x00\x00Synth\x00')
cats = [re.sub(r'\n(?=Sequence)', ' ', s.decode('latin1')).replace('\n', '/') for s in re.findall(rb'([\x20-\x7e\n]+)\x00', b[h:h + 400])][:16]
assert len(cats) == 16 and cats[-1].startswith('Combination'), cats
open(sys.argv[2], 'a', encoding='utf-8').write(f'export const CATEGORIES = {json.dumps(cats)};\n')
print('categories', cats)
