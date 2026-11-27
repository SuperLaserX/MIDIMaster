"""Yamaha DX firmware tables -> js/devices/defs/yamaha-dx*-fw.js

Usage: python -I tools/yamaha/dx_fw.py dx7 ROM OUT.js

Reads the screen texts, value lists and parameter tables the editors use from a DX/TX firmware
image (read only) and writes them as a JavaScript module, each with the ROM address it came from,
so every label and value display in the editor can be traced to the firmware
(docs/devices/yamaha-dx7.md). Disassemble with tools/yamaha/hd6303_dis.py to see the code using them.

dx7: DX7 (mark I) v1.8, 16 KB at C000h (DX7-V1-8.OBJ in z:/firmwares/DX7-V1-8.zip).
dx7ii: DX7II-D/FD v1.9, 64 KB (two 32 KB banks at 8000h; file offsets below), from
       z:/firmwares/Yamaha_DX7II_ROM_V1.9.zip. Texts are separated by 80h.
"""
import json
import sys


class Rom:
    def __init__(self, path, base):
        self.b = open(path, 'rb').read()
        self.base = base

    def u8(self, a):
        return self.b[a - self.base]

    def u16(self, a):
        return (self.u8(a) << 8) | self.u8(a + 1)

    def cstr(self, a, n=None):
        s = []
        while (n is None or len(s) < n) and 32 <= self.u8(a + len(s)) < 127:
            s.append(chr(self.u8(a + len(s))))
        return ''.join(s)

    def cstr80(self, off):
        """Text at file offset `off` up to an 80h separator (DX7II style)."""
        e = self.b.index(b'\x80', off)
        return self.b[off:e].decode('latin1').lstrip('*')

    def ptrs(self, a, n):
        out = []
        for i in range(n):
            p = self.u16(a + 2 * i)
            out.append({'ptr': '%04X' % p, 'text': self.cstr(p) if p else None})
        return out

    def fixed(self, a, n, width):
        return [self.cstr(a + i * width, width) for i in range(n)]


def dx7(rom):
    t = {}
    # Edit mode: label pointer table F4F9 (per edit parameter, 44 entries) and the parameter
    # table F551 (max, VCED offset; offsets 7Eh and up are voice-wide, lower ones per operator).
    labels = rom.ptrs(0xF4F9, 44)
    attrs = [{'max': rom.u8(0xF551 + 2 * i), 'offset': rom.u8(0xF552 + 2 * i)} for i in range(44)]
    t['EDIT'] = {'labels': 'F4F9', 'attrs': 'F551', 'params': [dict(i=i, **labels[i], **attrs[i]) for i in range(44)]}
    t['CURVES'] = {'table': 'F5C1', 'items': rom.ptrs(0xF5C1, 4)}
    t['LFO_WAVES'] = {'table': 'F5C9', 'items': rom.ptrs(0xF5C9, 6)}
    t['OFF_ON'] = {'table': 'F5D5', 'items': rom.ptrs(0xF5D5, 2)}
    t['OSC_MODES'] = {'table': 'F5D9', 'items': rom.ptrs(0xF5D9, 2)}
    t['NOTES'] = {'table': 'F5A9', 'items': rom.fixed(0xF5A9, 12, 2)}
    t['DETUNE'] = {'table': 'F314', 'items': rom.fixed(0xF314, 15, 2)}
    t['FIXED_FREQ'] = {'table': 'F21D', 'note': 'fixed frequency digits for F FINE 0-99 (display routine F1B6)', 'items': [rom.u16(0xF21D + 2 * i) for i in range(100)]}
    # Function mode: button labels 1-16 (F7DB), the controller page texts (F813: WHEEL FOOT BREATH
    # AFTER, then RANGE PITCH AMP EG B.), poly/mono and portamento modes (F843), and the RAM
    # addresses of function parameters 64-77 as the parameter-change receiver uses them (F028).
    t['FUNCTION'] = {'table': 'F7DB', 'items': rom.ptrs(0xF7DB, 14)}
    t['CONTROLLERS'] = {'table': 'F813', 'items': rom.ptrs(0xF813, 8)}
    t['MODES'] = {'table': 'F843', 'items': rom.ptrs(0xF843, 6)}
    t['FUNCTION_RAM'] = {'table': 'F028', 'items': ['%04X' % rom.u16(0xF028 + 2 * i) for i in range(14)]}
    texts = {}
    for a in (0xFC61, 0xFB16, 0xFC79, 0xFB22, 0xFB33, 0xF7A3, 0xF783, 0xF792, 0xF84F, 0xF85E, 0xF86B, 0xFBF8, 0xFC13,
              0xFCD8, 0xFD91, 0xFD9F, 0xFDDE, 0xFDCD, 0xF9C9, 0xF9D8, 0xFC57, 0xEF44, 0xF044, 0xFC3F, 0xFC91, 0xFCA2, 0xC23E):
        texts['%04X' % a] = rom.cstr(a).strip()
    t['TEXTS'] = texts
    # VOICE INIT (function button 10, D16B) and CARTRIDGE FORMAT (D1A7) unpack this packed voice.
    t['INIT_VOICE'] = {'table': 'C25C', 'items': [rom.u8(0xC25C + i) for i in range(128)]}
    # Edit parameters whose label the display code loads itself (no entry in F4F9): parameter index,
    # the text and the code that shows it.
    t['CODE_LABELS'] = {str(i): {'ptr': '%04X' % a, 'code': c, 'text': rom.cstr(a)} for i, a, c in ((0, 0xFC61, 'F11A'), (11, 0xFA5B, 'F145'), (12, 0xFA65, 'F14F'), (13, 0xFA6F, 'F2ED'))}
    return t


def dx7ii(rom):
    b = rom.b
    t = {}
    def texts(a, end):
        out, off = [], a
        for part in b[a:end].split(b'\x80'):
            out.append({'addr': '%04X' % off, 'text': part.decode('latin1')})
            off += len(part) + 1
        return out
    # initial voice (VCED 155 + operator on/off), ACED and performance (INIT VOICE / INIT PERF)
    t['INIT_VCED'] = {'table': '0163', 'items': list(b[0x163:0x1FF])}
    t['INIT_ACED'] = {'table': '0200', 'items': list(b[0x200:0x231])}
    t['INIT_PCED'] = {'table': '0231', 'items': list(b[0x231:0x264])}
    # parameter maximum tables: VCED (EC4E), ACED (ECE9), PCED (ED1A, without the name)
    t['VCED_MAX'] = {'table': 'EC4E', 'items': list(b[0xEC4E:0xECE9])}
    t['ACED_MAX'] = {'table': 'ECE9', 'items': list(b[0xECE9:0xECE9 + 49])}
    t['PCED_MAX'] = {'table': 'ED1A', 'items': list(b[0xED1A:0xED1A + 31])}
    t['FIXED_FREQ'] = {'table': 'EE60', 'items': [(b[0xEE60 + 2 * i] << 8) | b[0xEE61 + 2 * i] for i in range(100)]}
    t['NOTES'] = {'table': 'EA31', 'items': [b[0xEA31 + 2 * i:0xEA33 + 2 * i].decode('latin1') for i in range(12)]}
    t['VALUES'] = {'table': 'F9F7', 'items': texts(0xF9F7, 0xFD28)}
    t['SCREENS'] = {'table': 'F39F', 'items': texts(0xF39F, 0xF990)}
    # continuous slider assign list: 36 names (0E88) and the pointer table of the 106 choices after them
    names = texts(0x0E88, 0x10A0)[:36]
    end = 0x0E88 + sum(len(n['text']) + 1 for n in names)
    ptrs = [(b[end + 2 * i] << 8) | b[end + 2 * i + 1] for i in range(106)]
    t['CS_ASSIGN'] = {'table': '%04X' % end, 'items': [rom.cstr80(p - 0x8000) for p in ptrs]}
    # 7Eh bulk headers and their byte counts (count includes the header), 8683-86F0
    hdr = []
    for a in range(0x8686 - 0x8000, 0x86F0 - 0x8000, 13):
        hdr.append({'header': b[a + 3:a + 13].decode('latin1'), 'count': (b[a + 1] << 7) | b[a + 2], 'addr': '%04X' % (a + 0x8000)})
    t['HEADERS'] = {'table': '8686', 'items': hdr}
    # --- found in the MIDI and edit code of both banks (listings re/dx/dx7ii_lower.lst / _upper.lst)
    # micro tuning table names: pointer table 059C (lower bank 859C) for PCED byte 3 = 0-13 (13 and up: cartridge);
    # the group words of the display (9900): Preset 1-11, User 1-2, CRT 1-
    t['MICRO_NAMES'] = {'table': '059C', 'items': [rom.cstr((b[0x59C + 2 * i] << 8 | b[0x59D + 2 * i]) - 0x8000).strip() for i in range(14)]}
    t['MICRO_GROUPS'] = {'table': '07E6 08A4 088D', 'items': [rom.cstr(a).strip() for a in (0x07E6, 0x08A4, 0x088D)]}
    # the 12 semitone steps of an octave in 1/1024 octave (084C0, 14-bit words as two 7-bit bytes): equal temperament
    t['EQUAL_STEPS'] = {'table': '04C0', 'items': [(b[0x4C0 + 2 * i] << 7) | b[0x4C1 + 2 * i] for i in range(12)]}
    t['VALUES2'] = {'table': 'FD28', 'items': texts(0xFD28, 0xFDFC)}
    # system setup (RAM 5000h, 85 bytes "LM  8973S "): maxima of bytes 0-20 (ED39, checked by E1B9) and
    # the initial values (lower bank 8CA4 = file 0CA4, copied by F4F6)
    t['SYS_MAX'] = {'table': 'ED39', 'items': list(b[0xED39:0xED39 + 21])}
    t['SYS_INIT'] = {'table': '0CA4', 'items': list(b[0xCA4:0xCA4 + 85])}
    return t


def main():
    model, path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    if model == 'dx7':
        rom = Rom(path, 0xC000)
        t = dx7(rom)
        head = ('// Yamaha DX7 (mark I) v1.8 firmware tables (HD6303, 16 KB at C000h), generated by\n'
                '// tools/yamaha/dx_fw.py from DX7-V1-8.OBJ. Do not edit: run the tool again.\n'
                '// Every entry carries the ROM address it was read from (docs/devices/yamaha-dx7.md).\n')
    elif model == 'dx7ii':
        rom = Rom(path, 0)
        t = dx7ii(rom)
        head = ('// Yamaha DX7II-D/FD v1.9 firmware tables (HD6303, 64 KB in two 32 KB banks), generated by\n'
                '// tools/yamaha/dx_fw.py from DX7II_ROM_V1.9. Addresses are file offsets. Do not edit: run the tool again.\n'
                '// See docs/devices/yamaha-dx7ii.md.\n')
    else:
        raise SystemExit('unknown model ' + model)
    body = ''.join('export const %s = %s;\n' % (k, json.dumps(v, separators=(',', ':'))) for k, v in t.items())
    open(out, 'w', newline='\n').write(head + '\n' + body)
    print('wrote', out)


if __name__ == '__main__':
    main()
