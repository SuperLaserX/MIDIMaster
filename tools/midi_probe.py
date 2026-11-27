"""Read-only MIDI port check: sends the Universal Identity Request (and optionally one more read
request given as hex) to a port and prints what comes back within 3 s.

  python -I tools/midi_probe.py "2- VSynth" ["F0 00 20 29 01 22 7F 10 F7"]

Only requests are sent; nothing on the device changes.
"""
import sys
import time

import rtmidi


def main():
    name = sys.argv[1]
    extra = [int(x, 16) for x in sys.argv[2].split()] if len(sys.argv) > 2 else None
    mi, mo = rtmidi.MidiIn(), rtmidi.MidiOut()
    ii = [i for i, n in enumerate(mi.get_ports()) if n.rsplit(' ', 1)[0] == name]
    oo = [i for i, n in enumerate(mo.get_ports()) if n.rsplit(' ', 1)[0] == name]
    if not ii or not oo:
        print('port not found'); return 1
    try:
        mi.open_port(ii[0]); mo.open_port(oo[0])
    except Exception as e:  # held by another program
        print('open failed:', e); return 1
    mi.ignore_types(sysex=False, timing=True, active_sense=True)
    for req in [[0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]] + ([extra] if extra else []):
        while mi.get_message():
            pass
        mo.send_message(req)
        t0, got = time.time(), []
        while time.time() - t0 < 3:
            m = mi.get_message()
            if m:
                got.append(m[0])
            else:
                time.sleep(0.01)
        echo = [g for g in got if g == req]
        real = [g for g in got if g != req]
        print(' '.join(f'{b:02X}' for b in req[:8]), '->', len(real), 'reply' + ('' if len(real) == 1 else 'ies'),
              ' '.join(f'{b:02X}' for b in real[0][:16]) if real else '', '(+ echo)' if echo else '')
    mi.close_port(); mo.close_port()
    return 0


if __name__ == '__main__':
    sys.exit(main())
