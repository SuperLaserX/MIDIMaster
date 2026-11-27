# Alesis MIDIVerb 4: MIDI implementation from the v1.04 firmware

Source: `Alesis Midiverb IV Firmware v1.04.zip` (`midiverb iv 1.04 firmware.bin`, 64 KB, 8051 code;
"ALESIS MIDIVERB 4" at 0xAEC8). The v1.03 image (`Alesis MIDIVerb 4 v103 EPROM Firmware.zip`) has the
same SysEx framework at slightly different addresses; the editor follows v1.04. All addresses below are
in the v1.04 image. Editor: `js/devices/defs/alesis-midiverb4.js`; its tables
(`alesis-midiverb4-fw.js`) come from `tools/alesis/midiverb4_fw.py`, which reads the descriptors and runs
every parameter's display routine in the 8051 emulator (`tools/alesis/i8051.py`, `alesis_lcd.py`):

    python -I tools/alesis/midiverb4_fw.py "<image .bin>" > js/devices/defs/alesis-midiverb4-fw.js

**Not checked on hardware** (no MIDIVerb 4 is connected). The tests run against the definition's
simulator, which follows the receiver described here.

The MIDIVerb 4 is the Wedge's sibling: the same software author, the same SysEx framework and the same
custom LCD (segment map 0xA8FA identical to the Wedge's 0x0FB5, digit groups 0xAB07, font 0xB4BE, segment
set/clear 0xAD3C / 0xAD61). See `docs/devices/alesis-wedge.md` for the LCD, the icon segments and how
the display texts are read.

## Configurations and programs

32 descriptors of 124 bytes at 0x3000 (index = program byte 1): +00h name (16 characters), +14h four page
masks (low nibble = sliders A-D in use), +18h four page titles (high nibble = first character in the name,
low nibble = length), +1Ch the 16 parameter maxima, +2Ch the page table, +5Ch the display routine of each
parameter (dispatcher 0xCA19: A = parameter, 59h/5Ah = descriptor, value in XRAM 22D6h + parameter). Page
records are 144 bytes: a 24-character column heading, a 24-character page title ("REVERB PAGE 1
PARAMETERS") and four 24-character long names, inline (the Wedge uses pointers).

Programs are 26 bytes: [0] edit position (page x 4 + slider), [1] configuration 0-31, [2-9] name (8
characters), [10-25] the 16 parameters. 128 presets at 0xDD67; the user bank's reset contents (128) at
0xEA67 (copy loop 0xC17B). The editor labels parameters like the Wedge's: column heading (long name and
page title as help), after the effect's title when a configuration has several, and every value with
its LCD text (Decay 1.00 s to 75.8 s, LPF 059 Hz to OFF, rates 00.0-25.5 Hz, Tempo EcL / 050-250, note
values 4 ... 32, Sin / tri, SLo / FSt...).

## SysEx

`F0 00 00 0E 11 <dd> <op> ... F7`; header check 0xB9E6, opcode dispatch 0xBA72 (jump table 0xBA60).
`<dd>` must equal 1Dh (Util MIDI channel - 1) unless Omni is on (flag bit 1). Bytes 0-9 of a program travel
as they are, parameters and 8-bit settings as two nibbles (encoder 0xBCEB). The decoder (0xBFF1) refuses
the whole message unless position < E6h, configuration < 32 (54h), name >= 20h and every parameter <= its
maximum; the editor limits values before sending.

| Op | Message | Handling |
|---|---|---|
| 00 | `00 InSt In1 In2 OutSt Out1 Out2 Mod#X AmpX(2) Mod#Y AmpY(2) Foot flags` | Global (0xBD87): levels <= 100, Mod# <= 122, Amp <= 197, footswitch < 2 |
| 01 | `01 <128 x 2 nibbles>` | Program change table (0xBEDA): bit 7 = User, bits 0-6 = program |
| 02 | `02 <program>` | Edit buffer (0xBF18, XRAM 22CCh) |
| 03 | `03 <128 programs>` | User bank (0xBF55, XRAM 2500h), 5384 bytes |
| 04 | `04 n <program>` | User program n (0xBF71) |
| 05 | `05 n` | Store the edit buffer into user n (0xBF97) |
| 40-43 | request | Global, table, edit buffer, user bank (0xBAAF -> 0xBBB0, table 0xBBA4) |
| 7F | request | Global, table, edit buffer, user bank, in that order (0xBBC4) |
| 44 n | request | Read but answered by nothing (as on the Wedge: 0xBAC5 passes 4 to the transmitter, whose single-program branch 0xBBE4 needs bit 7) |

There is no parameter-change message (opcodes above 5 are errors, 0xBA9D): the editor sends the whole
program (50 bytes) for every change. Identity reply (0xBB14): `F0 7E dd 06 02 00 00 0E 00 00 11 00 01 00 04
00 F7`.

### System data

| Byte | Name | Evidence |
|---|---|---|
| 0-2 | Input level Stereo, Ch 1, Ch 2 (228Bh-228Dh) | Util Input Level page (0xCA7E): "Stereo", or "Ch 1 Ch 2" when the channels are set separately (2Eh bit 7 picks the column, not sent); 000-100 (display 0xCB68) |
| 3-5 | Output level Stereo, Ch 1, Ch 2 (228Eh-2290h) | Util Output Level page (0xCD1F) |
| 6, 8 | Mod#X, Mod#Y (2289h, 228Ah) | Modulator page columns A and C (0xD766, 0xD77A): bnd, AFt, not, UEL, Controller 000-119 |
| 7, 9 | AmpX, AmpY (229Dh, 229Eh) | Columns B and D (0xD7BE, 0xD7D3): -99..+99, 00 = off |
| 10 | Footswitch (2288h) | Footswitch page column B (0xD423): Adu, byP, CtL; the receiver accepts 0-1 only |
| 11 bit 0 | Thru | MIDI page "Thru" (0xD62D; a second column routine at 0xD60C showing bit 1 is never called) |
| 11 bit 1 | Omni | CC 125 / 124; a reset sets it (0xD2DC) |
| 11 bit 2 | Dry defeat switch | Toggled and applied at 0xC12A; the Dry Defeat setting (22A1h, not sent) keeps it in step (0xD40E) |
| 11 bit 3 | Cascade | Util "Dual Programs: Cascade" page (0xD466) |
| 11 bit 4 | (none) | No code reads or writes it |
| 11 bit 5 | Program display flag | Set at reset (0xD2DE); 0xC60A and 0xC769 test it before drawing the program display; read-only |
| 11 bit 6 | Program edited | Set by a parameter change (0xCA0B), cleared by store and recall; read-only |
| 11 bit 7 | (not sent) | The transmitter clears it; it selects the Ch 1 / Ch 2 column on the level pages |

The MIDI channel (2287h), PChg (229Fh: OFF, On, tbL), Dry Defeat (22A1h) and the Send Sysex page are
front-panel settings no message carries. The Util pages reach Mod# 123, Amp 198 and footswitch CtL, one
past what the receiver accepts; the editor's lists stop at the receiver's limits.

## Channel messages

Program change: PChg OFF ignores it, On recalls the same number in the current bank, tbL looks it up in
the table (0xB7A7). Controller 0 before it (PChg On) selects the bank: 0 = Preset, 1-127 = User (0xB703).
Mod#X / Mod#Y sources modulate two parameters of each configuration. CC 124/125: Omni off/on.

## What comes from where

- Firmware: every message, layout, configuration, label, range, display text, preset and flag above.
- Manual: nothing was needed beyond the unit names of the LCD icons (shared with the Wedge).
- Unverified: everything on hardware; the meaning of footswitch modes Adu and byP beyond their LCD text
  (advance and bypass, presumably) and of flag bit 5.

## Head Library

Patch kind `effect`; the translator is the Wedge's (`alesis-wedge-translate.js`) with family
`alesis-midiverb4`, parameters from byte 10: exact for MIDIVerb 4 to MIDIVerb 4, through the shared
`effects` section otherwise (a Wedge LARGE HALL becomes a CONCERT HALL, REALROOM+DELAY for reverb with
delay...).
