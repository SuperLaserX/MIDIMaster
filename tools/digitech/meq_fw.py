"""DigiTech MEQ 28 / MEQ 14 / MEQ 7 tables from the v1.06 EPROM, by running its own routines (tools/yamaha/hd6303.py).

Usage: python -I tools/digitech/meq_fw.py FIRMWARE.bin OUT.js [--vectors VECTORS.json]

One firmware serves three models, chosen by two jumpers it reads at reset (board model tools/digitech/meq_board.py,
Board(image, model=0 MEQ 28 / 1 MEQ 14 / 2 MEQ 7)). For each model the system is booted from reset with empty RAM
(error "E1", a key, the factory initialisation, a restart) and then:
  - the boot display (the model number, C899), the SysEx model byte (8111h), the number of sections (8112h), the band
    column map (80F2h: the filter chip address of each of the 31 program bytes, FFh = no band), the section masks;
  - the memory as the first power-up leaves it (813Dh-8EF3h, what the 41h dump carries) and the 10 factory programs;
  - which edit-buffer bytes a program change loads for each set of sections listening on its channel (the program
    memory filled with markers, a program change sent through the SCI interrupt and the main-loop parser, the edit
    buffer read back);
the display texts (two 7-segment digits: 8Ah left, 89h right, read back through the firmware's own font) of: the
program number (D769), the output level (D86B, its own segment table D84B), the MIDI channel (D793), the controller
links (D7E9), the bypass link (D831), the dump selection (D81D); the LED column of a band value (D923: 13 LEDs, the
pattern table D8A3, and D8D5 for a selected band).
  - --vectors: MIDI messages through the SCI interrupt and the parser (MEQ 14): the 00 request and the 41h answer, a
    42h program, a 41h memory (the unit restarts), program changes, a controller link, the 01h request, a wrong model.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from meq_board import Board, Halt  # noqa: E402

NAMES = ['MEQ 28', 'MEQ 14', 'MEQ 7']
SETTINGS = 0x813D
PROGRAMS = 0x816B
PROG = 35
COUNT = 99
END = PROGRAMS + PROG * COUNT   # 8EF4h
EDIT = 0x808F
FACTORY_TABLE = 0xC482          # a pointer per model to 10 x 35 bytes
COLUMN_MAP = 0x80F2


def booted(img, model):
    b = Board(img, model=model)
    shown = {}

    def at_boot_number(c):
        shown['boot'] = b.display()
        return False
    b.cpu.hooks[0xC8A8] = at_boot_number
    b.boot()
    del b.cpu.hooks[0xC8A8]
    b.boot_shown = shown.get('boot')
    return b


def texts(b):
    out = {}
    t = []
    for n in range(COUNT):
        b.poke(0x813D, n)
        b.call(0xD769)
        t.append(b.display().strip())
    out['program'] = t
    b.poke(0x808D, EDIT >> 8)
    b.poke(0x808E, EDIT & 0xFF)
    b.poke(0x813C, 0)
    t = []
    for v in range(16):
        b.poke(EDIT + 31, v)
        b.call(0xD86B)
        t.append(b.display().strip())
    out['level'] = t
    b.poke(0x8139, 0)
    t = []
    for v in range(18):
        b.poke(0x813E, v)
        b.call(0xD793)
        t.append(b.display())
    out['channel'] = t
    b.poke(0xF0, 0)
    t = []
    for v in range(100):
        b.poke(0x8146, v)
        b.call(0xD7E9)
        t.append(b.display())
    out['link'] = t
    t = []
    for v in range(100):
        b.poke(0x8169, v)
        b.call(0xD831)
        t.append(b.display())
    out['bypassLink'] = t
    t = []
    for v in range(100):
        b.poke(0x813B, v)
        b.call(0xD81D)
        t.append(b.display())
    out['dump'] = t
    leds = []
    for sel in (0, 1):
        col = []
        for v in range(25):
            c = b.cpu
            c.a, c.b = v, sel
            b.call(0xD923)
            pat = (c.a << 8) | c.b
            # active low, bit 12 the bottom LED (value 0) .. bit 0 the top LED (value 24)
            col.append([13 - k for k in range(13) if not (pat >> k) & 1])
        leds.append(col)
    out['led'] = leds[0]
    out['ledSelected'] = leds[1]
    return out


def model_info(img, m):
    b = booted(img, m)
    first = b.mem(SETTINGS, END - SETTINGS)
    n = b.peek(0x8112)
    cmap = list(b.mem(COLUMN_MAP, 31))
    ft = (img[FACTORY_TABLE - 0x8000 + 2 * m] << 8) | img[FACTORY_TABLE - 0x8000 + 2 * m + 1]
    factory = [img[ft - 0x8000 + PROG * i: ft - 0x8000 + PROG * (i + 1)].hex() for i in range(10)]
    for i in range(10):
        assert first[PROGRAMS - SETTINGS + PROG * i: PROGRAMS - SETTINGS + PROG * (i + 1)].hex() == factory[i]
    info = {
        'name': NAMES[m], 'fc': m, 'byte': b.peek(0x8111), 'boot': b.boot_shown, 'bootError': getattr(b, 'boot_error', None),
        'sections': n, 'columns': [None if v == 0xFF else v for v in cmap], 'masks': list(b.mem(0x8142, n)),
        'first': first.hex(), 'factory': factory,
    }
    info['loads'] = program_change_loads(img, m, n)
    return info, b


def program_change_loads(img, m, n):
    """For each set of sections on the program change's channel (bit i = section i): the edit-buffer bytes it loads."""
    out = {}
    for mask in range(1, 1 << n):
        b = booted(img, m)
        # section i on channel 1 if it is in the set, else channel 16
        for i in range(n):
            b.poke(0x813E + i, 1 if mask >> i & 1 else 16)
        for i in range(PROG):
            b.poke(PROGRAMS + PROG * 5 + i, 0x40 + i)
        before = b.mem(EDIT, PROG)
        b.receive([0xC0, 5])
        after = b.mem(EDIT, PROG)
        assert b.peek(0x813D) == 5
        got = [i for i in range(PROG) if after[i] == 0x40 + i and before[i] != after[i]]
        out[str(mask)] = got
    return out


def vectors(img):
    m = 1
    v = {'model': NAMES[m]}
    b = booted(img, m)
    b.poke(0x813E, 1)   # section 1 on channel 1, section 2 on channel 2 (the first power-up has omni, which sends nothing)
    b.poke(0x813F, 2)
    v['dumpBefore'] = b.mem(SETTINGS, END - SETTINGS).hex()
    req = [0xF0, 0x00, 0x00, 0x10, 0x00, 0x08, 0x00, 0xF7]
    b.tx.clear()
    b.receive(req)
    v['request'] = {'msg': req, 'reply': bytes(b.tx).hex()}
    # nothing answers a request while section 1 has omni (811h > 16: D48D)
    b2 = booted(img, m)
    b2.tx.clear()
    b2.receive([0xF0, 0x00, 0x00, 0x10, 0x05, 0x08, 0x00, 0xF7])
    v['requestOmni'] = {'msg': [0xF0, 0x00, 0x00, 0x10, 0x05, 0x08, 0x00, 0xF7], 'reply': bytes(b2.tx).hex()}
    # 42h: program 7 (n = 6)
    prog = [(i * 7) % 25 for i in range(31)] + [3, 12, 0, 15]
    msg = [0xF0, 0x00, 0x00, 0x10, 0x01, 0x08, 0x42] + [x for d in [6] + prog for x in ((d >> 7) & 1, d & 0x7F)] + [0xF7]
    edit0 = b.mem(EDIT, PROG)
    b.receive(msg)
    v['program'] = {'msg': msg, 'n': 6, 'stored': b.mem(PROGRAMS + PROG * 6, PROG).hex(), 'edit': b.mem(EDIT, PROG).hex(),
                    'editBefore': edit0.hex(), 'current': b.peek(0x813D)}
    # program change on channel 2 (section 2 only), then on channel 1 (section 1)
    b.receive([0xC1, 6])
    v['pcSection2'] = {'msg': [0xC1, 6], 'edit': b.mem(EDIT, PROG).hex(), 'current': b.peek(0x813D)}
    b.receive([0xC0, 6])
    v['pcSection1'] = {'msg': [0xC0, 6], 'edit': b.mem(EDIT, PROG).hex(), 'current': b.peek(0x813D)}
    b.receive([0xC2, 3])
    v['pcOther'] = {'msg': [0xC2, 3], 'current': b.peek(0x813D)}
    b.receive([0xC0, 99])
    v['pcRange'] = {'msg': [0xC0, 99], 'current': b.peek(0x813D)}
    # a controller link: band column 4 on controller 20, level 2 on 21
    b.poke(0x8146 + 4, 20)
    b.poke(0x8146 + 32, 21)
    out = []
    for val in (0, 1, 63, 64, 100, 127):
        b.receive([0xB0, 20, val])
        b.receive([0xB1, 21, val])
        out.append([val, b.peek(EDIT + 4), b.peek(EDIT + 32)])
    v['control'] = {'band': 4, 'cc': 20, 'level': 32, 'levelCc': 21, 'values': out}
    # a wrong model byte (MEQ 28's 07 sent to a MEQ 14) changes nothing
    msg7 = [0xF0, 0x00, 0x00, 0x10, 0x00, 0x07, 0x42] + [0, 0] + [0, 5] * PROG + [0xF7]
    before = b.mem(PROGRAMS, PROG)
    b.receive(msg7)
    v['wrongModel'] = {'msg': msg7, 'unchanged': b.mem(PROGRAMS, PROG) == before}
    # 41h: the whole memory; at its last byte the unit loads program (byte 0) + 1 and restarts (D277-D289)
    mem = bytearray(b.mem(SETTINGS, END - SETTINGS))
    mem[0] = 2
    mem[1] = 3
    mem[2] = 4
    for i in range(PROG):
        mem[PROGRAMS - SETTINGS + PROG * 2 + i] = (i * 3) % 25 if i < 31 else (i - 31) * 4
    data = [x for d in mem for x in ((d >> 7) & 1, d & 0x7F)]
    msg41 = [0xF0, 0x00, 0x00, 0x10, 0x00, 0x08, 0x41] + data + [0xF7]
    b.receive(msg41)
    v['all'] = {'mem': bytes(mem).hex(), 'after': b.mem(SETTINGS, END - SETTINGS).hex(), 'edit': b.mem(EDIT, PROG).hex(),
                'current': b.peek(0x813D), 'shown': b.display()}
    # 01h: "jsr $42" jumps to 0042h, where nothing answers: the HD6303 takes an illegal opcode
    b3 = booted(img, m)
    try:
        b3.receive([0xF0, 0x00, 0x00, 0x10, 0x00, 0x08, 0x01, 0x00, 0x05, 0xF7])
        v['request01'] = 'returned'
    except Halt as e:
        v['request01'] = str(e)
    return v


def emit(out, firmware, models, tx):
    js = lambda x: json.dumps(x, separators=(',', ':'), ensure_ascii=False)
    lines = [
        '// Generated by tools/digitech/meq_fw.py from the DigiTech MEQ v1.06 EPROM: do not edit.',
        '// MODELS (one firmware, chosen by two jumpers at reset): name, fc = the jumper setting, byte = the SysEx model byte,',
        '// boot = what the display shows at power-up, sections = channels of the unit, columns[c] = the filter chip address',
        '// of program byte c (null: no band on this model), masks = the section masks (dump bytes 5-8), first = the 41h',
        '// memory (813Dh-8EF3h) as the first power-up leaves it, factory = the 10 programs it writes first, loads[mask] = the',
        '// edit-buffer bytes a program change loads when the sections in mask (bit i = section i + 1) take its channel.',
        '// TEXTS: the two display digits (left, right) for each value: program 0-98, level 0-15 (the output level pages),',
        '// channel 0-17, link 0-99 (controller links), bypassLink 0-99 (with the left digit\'s point), dump 0-99 (the dump',
        '// selection); led[v] / ledSelected[v] = the LEDs (1 bottom - 13 top) a band value lights in its column.',
        f'export const FIRMWARE = {js(firmware)};',
        'export const MODELS = [',
        *[f'  {js(m)},' for m in models],
        '];',
        f'export const TEXTS = {js(tx)};',
        '',
    ]
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))


def main():
    args = sys.argv[1:]
    vec = None
    if '--vectors' in args:
        i = args.index('--vectors')
        vec = args[i + 1]
        del args[i:i + 2]
    src, out = args
    img = open(src, 'rb').read()
    models = []
    tx = None
    for m in range(3):
        info, b = model_info(img, m)
        models.append(info)
        if tx is None:
            tx = texts(b)
        else:
            assert texts(b) == tx, 'texts differ between models'
    emit(out, 'DigiTech MEQ v1.06 EPROM (sticker "MEQ V1.06", 4E0E; one program for the MEQ 28, MEQ 14 and MEQ 7)', models, tx)
    if vec:
        with open(vec, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(vectors(img), f, separators=(',', ':'))
            f.write('\n')


if __name__ == '__main__':
    main()
