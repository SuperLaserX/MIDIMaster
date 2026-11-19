"""Read every SysEx message from Standard MIDI Files.

usage (as a module): from smf_sysex import sysex_messages
"""
import struct


def _vlq(b, i):
    v = 0
    while True:
        c = b[i]
        i += 1
        v = (v << 7) | (c & 0x7f)
        if c < 0x80:
            return v, i


def sysex_messages(path):
    d = open(path, 'rb').read()
    if d[:4] != b'MThd':
        raise ValueError(f'{path}: not a MIDI file')
    i = 8 + struct.unpack('>I', d[4:8])[0]
    out = []
    while i + 8 <= len(d):
        if d[i:i + 4] != b'MTrk':
            break
        ln = struct.unpack('>I', d[i + 4:i + 8])[0]
        j, end, run = i + 8, min(len(d), i + 8 + ln), None
        while j < end - 1:
            _, j = _vlq(d, j)
            st = d[j]
            if st in (0xF0, 0xF7):
                j += 1
                ln2, j = _vlq(d, j)
                body = d[j:j + ln2]
                out.append(bytes([0xF0]) + body if st == 0xF0 else body)
                j += ln2
            elif st == 0xFF:
                ln2, j2 = _vlq(d, j + 2)
                j = j2 + ln2
            else:
                if st & 0x80:
                    run = st
                    j += 1
                j += 1 if (run & 0xF0) in (0xC0, 0xD0) else 2
        i = end
    return out
