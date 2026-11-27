# Alesis Microverb 4: MIDI implementation from the C4C v1.02 firmware

Source: `alesis_microverb-4.zip` (`alesis_microverb4_c4c_v1-02.bin`, 64 KB, 8051 code, sticker
2-31-0066 C4C V1.02 10/31/95). The zip also holds the C4 v1.01 image (for the M4 DSP board); its SysEx
code is the same at other addresses (header check 0xB76B). All addresses below are in the C4C v1.02
image. Editor: `js/devices/defs/alesis-microverb4.js`; tables (`alesis-microverb4-fw.js`) from
`tools/alesis/microverb4_fw.py`, which reads the descriptors and runs each configuration's Edit A /
Edit B display routine in the 8051 emulator (`tools/alesis/i8051.py`):

    python -I tools/alesis/microverb4_fw.py "<image .bin>" > js/devices/defs/alesis-microverb4-fw.js

**Not checked on hardware** (no Microverb 4 is connected); the tests use the definition's simulator.

## What a program is

The Microverb 4 runs the Wedge / MIDIVerb 4 effects (32 configurations with 16 parameters, descriptors
of 128 bytes at 0x3000, the MIDIVerb 4's 144-byte page records) but has a 3-digit LED and two edit
knobs. Programs:

- 100 presets: 26-byte ROM programs at 0xC2A2 (position, configuration, 8-character name, 16 parameters;
  the names never appear on the LED), with their Edit A / Edit B values at 0xC0A2 (read on recall, 0xBC0F).
- 100 user programs, two bytes each in a serial EEPROM (read 0xAD34, write 0xAD58): Edit A with bit 7 =
  "builds on the user bank's own factory program" and Edit B. User program n always builds on preset n
  (bit 7 clear, table 0xC2A2) or on factory program n (bit 7 set, the 26-byte programs at 0xCFA2; 0xBA75).
  A reset writes the table at 0xC1A2 into the EEPROM (0xBAAF).

Edit A and Edit B of a configuration: descriptor bytes +10h / +11h are their maxima; the routines at
+36h / +38h show the value (a display routine of the parameter, LED in IRAM 7Eh/7Dh/7Ch, bit 7 = decimal
point, digit font 0xAF7E) and then jump into the DSP routine (table +40h) of the parameter they drive.
The generator follows that jump to name the knob (REVERB DECAY TIME, INPUT LOWPASS FILTER, CHORUS RATE,
DELAY TIME...). On MULTI TAP DELAY, Edit A addresses the three tap times together (MOV R0,#D6h+i at 0x6731).
Values are listed as the LED shows them (1.97 ... 135 for a hall decay, 059 ... OFF for the filter, -12 ...
12 semitones, SLo / FSt); the LED has no unit marks.

## SysEx

`F0 00 00 0E 12 <dd> <op> ... F7`, header check 0xB6C5, dispatch 0xB72E (jump table 0xB74D). `<dd>` must
equal 1Dh (the MIDI channel - 1) unless Omni is on (bit 2F.1).

| Op | Message | Handling |
|---|---|---|
| 00 | `00 n A B base` | Current program (0xB972): user program n (26h = n + 80h) with Edit A, Edit B and base bit; applied at once |
| 01 | `01 (A B base) x 100` | Every user program (0xB9C0), each checked as below |
| 02 | `02 n A B base` | User program n (0xB9DF) |
| 03 | `03` | Store the current program into its user number (0xB9F7 -> 0xBC4B) |
| 40 / 41 / 7F | request | Current program, user programs, both (0xB865) |
| 42 n | request | Read but answered by nothing (0xB759 passes 2, not the number, to the transmitter) |

A program is refused unless Edit A <= +10h and Edit B <= +11h of the configuration it builds on (0xBA1A).
Identity reply (0xB7A5): `F0 7E dd 06 02 00 00 0E 00 00 12 00 01 00 02 00 F7`. Program change selects
0-99 in the current bank; Controller 0 picks the bank (0 = Preset, 1-127 = User, 0xB50F). CC 124 / 125:
Omni off / on. No global settings travel over MIDI.

## Editor

One object, the current program: program number, which ROM program it builds on (preset or user factory),
the configuration (read-only, from that program) and Edit A / Edit B with their LED texts. Slots: the 100
user programs (read with the 41h dump, written with opcode 02; a program stored into slot n builds on
program n) and the 100 presets (from the ROM tables).

## Head Library

Patch kind `effect`. The translator writes Edit A / B into the parameter they drive (when the knob's range
is that parameter's) and runs the Wedge-family translator over the 26-byte program; Microverb 4 to
Microverb 4 is exact (`extra.program`). From another model it finds the first preset whose configuration
holds the wanted effects and sets Edit A / B from the wanted amounts; everything else is the preset's.

## Unverified

Everything on hardware; whether the LED shows the preset and user values exactly as emulated (no unit
marks are lit by these routines).
