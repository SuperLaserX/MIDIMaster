"""Generate js/devices/defs/roland-vsynthxt-vc1-fw.js from the V-Synth XT VC-1 ("D-50") application.

The VC-1 is the third application in the V-Synth XT firmware (VAPP3, os.3.40001C.bin once
unpacked with vsynth_rom.py), loaded at 0x89300000 like the others. It speaks D-50 SysEx (model
14h): a 448-byte patch made of seven 64-byte blocks, checked byte by byte against a range table.

Everything this script writes comes out of the image:
  * the range table (min, max for every byte of the seven blocks),
  * the value lists the edit pages display (notes, keyfollow, bias points, waves, EQ, modes...),
  * the D-50 character set used by tone and patch names,
  * the parameter names of the control-assign list (short name, long name on two lines),
  * the edit-page labels for the bytes that list leaves out.
Tables are found by their contents, so the script does not depend on fixed addresses.

Usage: python -I vc1_fw.py <os.3 image> <out .js>
"""
import json
import struct
import sys

BASE = 0x89300000
b = open(sys.argv[1], 'rb').read()
N_WORDS = len(b) // 4
WORDS = struct.unpack('<%dI' % N_WORDS, b[:N_WORDS * 4])


def cstr(p, maxlen=64):
    if not BASE <= p < BASE + len(b):
        return None
    o = p - BASE
    e = b.find(b'\x00', o, o + maxlen)
    if e < o:
        return None
    s = b[o:e]
    return s.decode('latin1') if all(32 <= c < 127 for c in s) else None


def ptr_list(first, count):
    """The `count` strings of the pointer table whose first entries read `first` (blanks ignored)."""
    for i in range(N_WORDS - count):
        if all((cstr(WORDS[i + k]) or '\x00').strip() == x for k, x in enumerate(first)):
            out = [(cstr(WORDS[i + k]) or '').strip() for k in range(count)]
            return out, BASE + 4 * i
    raise SystemExit(f'pointer table {first} not found')


def str_run(first, count, stride=None):
    """`count` strings stored one after another, starting where the strings read `first` (a list)."""
    first = [first] if isinstance(first, str) else first
    want = first[0].encode('latin1')
    o = 0
    while True:
        o = b.find(want, o)
        if o < 0:
            raise SystemExit(f'strings {first} not found')
        if (b[o - 1] in (0, 0x20) or o % 4 == 0) and b[o + len(want)] in (0, 0x20):
            p = o
            while b[p - 1] == 0x20:
                p -= 1
            out = read_run(p, max(count, len(first)), stride)
            if out[:len(first)] == first:
                return out[:count], BASE + p
        o += 1


def read_run(p, count, stride):
    out = []
    for _ in range(count):
        e = b.index(b'\x00', p)
        out.append(b[p:e].decode('latin1').strip())
        if stride:
            p += stride
        else:
            p = e + 1
            while b[p] == 0:
                p += 1
    return out


# ------------------------------------------------------------------ range table
# Seven blocks of 64 (min, max) pairs: upper partial 1, upper partial 2, upper common, lower
# partial 1, lower partial 2, lower common, patch. A partial block starts with WG Pitch Coarse
# 0-72, Fine 0-100, Keyfollow 0-16, LFO mode 0-3.
PARTIAL_HEAD = bytes([0, 72, 0, 100, 0, 16, 0, 3, 0, 2, 0, 2, 0, 1, 0, 127])
o = b.index(PARTIAL_HEAD)
RANGE_AT = BASE + o
blocks = [[list(b[o + 128 * k + 2 * i:o + 128 * k + 2 * i + 2]) for i in range(64)] for k in range(7)]
assert blocks[1] == blocks[0] and blocks[3] == blocks[0] and blocks[4] == blocks[0], 'partial blocks differ'
assert blocks[5] == blocks[2], 'common blocks differ'
assert blocks[2][:10] == [[0, 63]] * 10 and blocks[6][:18] == [[0, 63]] * 18, 'name ranges'
RANGES = {'partial': blocks[0], 'common': blocks[2], 'patch': blocks[6]}
# The 12 pairs just before it belong to the VC-1's own settings (not reachable by SysEx).
SETTINGS_RANGES = [list(b[o - 24 + 2 * i:o - 24 + 2 * i + 2]) for i in range(12)]


def count(block, off):
    lo, hi = RANGES[block][off]
    return hi - lo + 1


# ------------------------------------------------------------------ value lists
L = {}
L['notes'], _ = str_run(['C1', 'C#1'], count('partial', 0x00), 8)          # WG Pitch Coarse C1..C7
L['keyfollow'], _ = ptr_list(['-1', '-1/2', '-1/4', '0'], count('partial', 0x02))
L['lfoMode'], _ = str_run(['OFF', '(+)', '(-)', 'A&L'], 4, 8)
L['bendMode'] = [L['lfoMode'][0]] + str_run(['KF', 'NOM'], 2, 8)[0]  # OFF KF NOM
L['waveform'], _ = str_run(['SQU', 'SAW', 'WG Waveform'], 2, 8)                            # SQU SAW
L['pcm'], _ = str_run(['Marmba', 'Vibes'], count('partial', 0x07), 8)
L['lfoSelect'], _ = ptr_list(['+1', '-1', '+2', '-2'], count('partial', 0x0a))
L['bias'], _ = ptr_list(['<A1', '<A#1', '<B1'], count('partial', 0x10))
L['keyMode'], _ = str_run(['WHOLE', 'DUAL'], count('patch', 0x12))
L['split'], _ = str_run(['C2', 'C#2', 'D2'], count('patch', 0x13))
L['lfoWave'], _ = ptr_list(['TRI', 'SAW', 'SQU', 'RND'], count('common', 0x19))
L['sync'], _ = ptr_list(['OFF', 'ON', 'KEY'], count('common', 0x1c))
# Low EQ frequencies (63 Hz-840 Hz) and High EQ frequencies (250 Hz-9.5 kHz): one table, low list first
_eq, _ = ptr_list(['63', '75', '88'], count('common', 0x25) + count('common', 0x27))
L['eqLow'], L['eqHigh'] = _eq[:count('common', 0x25)], _eq[count('common', 0x25):]
assert L['eqHigh'][0] == '250' and L['eqHigh'][-1] == '9.5k', L['eqHigh']
L['eqQ'], _ = ptr_list(['0.3', '0.5', '0.7'], count('common', 0x28))
L['ul'], _ = ptr_list(['U', 'L', 'UL'], count('patch', 0x14))       # portamento / hold mode
L['chaseMode'], _ = ptr_list(['UL', 'ULL', 'ULU'], count('patch', 0x22))
L['offOn'], _ = ptr_list(['Off', 'On'], 2)
L['basic'] = ['Basic']                                             # MIDI TxCH 0
L['off'] = ['OFF']                                                 # SepCH / TxPC / TxBS 0

# the D-50 character set of tone and patch names
cs_at = b.index(b' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890-')
CHARSET = b[cs_at:cs_at + 64].decode('latin1')

# ------------------------------------------------------------------ factory patches
# The application keeps "Initial patch" (what INITIALIZE loads) followed by the factory patches
# of the preset banks, 448 bytes each in SysEx layout. The editor starts from the initial patch;
# the tests read the presets from the image.
enc = bytes(CHARSET.index(c) for c in 'Initial patch'.ljust(18))
o = b.index(enc) - 0x180
PRESET_AT = BASE + o
lim = [(lo, hi) for blk in (blocks[0], blocks[1], blocks[2], blocks[3], blocks[4], blocks[5], blocks[6]) for lo, hi in blk]


def in_range(q):
    return all(lim[i][0] <= b[q + i] <= lim[i][1] for i in range(448))


assert in_range(o), 'initial patch out of range'
INIT = list(b[o:o + 448])
n_presets = 0
while in_range(o + 448 * (n_presets + 1)):
    n_presets += 1
# their names (patch name at 180h, 18 characters): the preset banks P1-P6 in order (checked on the
# unit: P2-11 plays "Brass Tacks", factory patch 65)
PRESET_NAMES = [''.join(CHARSET[c] for c in b[o + 448 * (k + 1) + 0x180:o + 448 * (k + 1) + 0x192]).rstrip() for k in range(n_presets)]


# ------------------------------------------------------------------ names
# The control-assign list: entries of (short name, long name, second line of the long name), kept in
# order because two entries share a short name ("TVA Velo").
NAMES = []
_, at = ptr_list(['ToneBal', 'Tone Balance'], 2)
i = (at - BASE) // 4
while True:
    s, l1, l2 = WORDS[i:i + 3]
    short = cstr(s)
    if short is None or not cstr(l1):
        break
    long = ' '.join(x for x in ((cstr(l1) or '').strip(), (cstr(l2) or '').strip() if l2 else '') if x)
    if [short.strip(), ' '.join(long.split())] not in NAMES:
        NAMES.append([short.strip(), ' '.join(long.split())])
    i += 3

def has_label(s):
    """True when `s` is a whole string (padding blanks allowed) somewhere in the image."""
    want, o = s.encode(), 0
    while True:
        o = b.find(want, o)
        if o < 0:
            return False
        if (b[o - 1] in (0, 0x20) or o % 4 == 0) and b[o + len(want)] in (0, 0x20):
            return True
        o += 1


# Edit-page labels for the bytes the assign list leaves out (each must be in the image).
LABELS = {}
for s in ['Structure', 'Partial Balance', 'Output Mode', 'RevType', 'KEYMODE', 'SPLIT', 'Hold', 'Mode',
          'TxCH', 'TxPC', 'TxBS', 'SepCH', 'LowFreq', 'HiFreq', 'HiQ', 'Type', 'Chase Edit', 'Portamento Edit',
          'EQ Edit', 'Chorus Edit', 'MIDI', 'TONE NAME', 'PATCH NAME', 'UPPER', 'LOWER', 'Wave', 'Sync', 'Basic', 'OFF']:
    if not has_label(s):
        raise SystemExit(f'label {s!r} not found')
    LABELS[s] = s

out = {
    'RANGE_AT': f'{RANGE_AT:08X}', 'RANGES': RANGES, 'SETTINGS_RANGES': SETTINGS_RANGES,
    'LISTS': L, 'CHARSET': CHARSET, 'NAMES': NAMES, 'LABELS': sorted(LABELS), 'INIT': INIT,
    'PRESETS': {'at': f'{PRESET_AT + 448:08X}', 'count': n_presets, 'offset': PRESET_AT + 448 - BASE}, 'PRESET_NAMES': PRESET_NAMES,
}
with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Generated by tools/roland/vc1_fw.py from the V-Synth XT VC-1 application (os.3.40001C.bin).\n')
    f.write('// Do not edit by hand: re-run the generator.\n')
    f.write(f'// Range table at {RANGE_AT:08X}; {len(NAMES)} control-assign names.\n')
    for k in ('RANGES', 'SETTINGS_RANGES', 'LISTS', 'CHARSET', 'NAMES', 'LABELS', 'INIT', 'PRESETS', 'PRESET_NAMES'):
        f.write(f'export const {k} = {json.dumps(out[k], ensure_ascii=False)};\n')
print('presets', out['PRESETS'], 'ranges at', out['RANGE_AT'], {k: len(v) for k, v in L.items()}, len(NAMES), 'names')
