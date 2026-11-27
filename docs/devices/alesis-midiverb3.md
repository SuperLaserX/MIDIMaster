# Alesis MIDIVerb III: MIDI implementation from the v1.01 firmware

Source: `Alesis Midiverb3 V1.01.zip` (`Alesis Midiverb3 V1.01 - 27C256.BIN`, 32 KB, 8031 code, not
scrambled; copy, Ghidra project and listings in `re/fx/alesis-midiverb3/`). The v1.00 image
(`Alesis MIDIVerb 3 (MidiVerb iii, MidiVerb III) v100 EPROM Firmware.zip`) differs in 502 bytes: the version
digit (2B7D), the SysEx receiver three bytes further on, and the dump sender (v1.01 saves PSW and selects
register bank 0 first); its MIDI implementation is the same. All addresses below are in v1.01.
Editor: `js/devices/defs/alesis-midiverb3.js`; tables (`alesis-midiverb3-fw.js`) from
`tools/alesis/midiverb3_fw.py`, which reads the descriptor and page tables and runs every display routine
in the 8051 emulator (`tools/alesis/i8051.py`):

    python -I tools/alesis/midiverb3_fw.py "<v1.01 image .bin>" > js/devices/defs/alesis-midiverb3-fw.js

**Not checked on hardware** (no MIDIVerb III is connected); the tests use the definition's simulator.

## Where the names come from

The MIDIVerb III shows values on a 3-digit 7-segment LED; the parameter names are printed on the front
panel, so the firmware holds none. Names in the editor come from the Alesis documents, values from the
firmware:

| Program byte | Name in the editor | Name source | Values |
|---|---|---|---|
| 0 | INPUT EQ | Reference manual (EQ button, upper EDIT LED); service manual "Input EQ" | Firmware: display 0518, table 05F6 (0.16 ... 13.8, OFF) |
| 1 | EFFECT EQ | Reference manual (EQ button, lower LED); service manual "Effect EQ" | Firmware: same routine |
| 2 | CHORUS ALGORITHM | Reference manual (CHORUS button, upper LED); service manual | Firmware: 0537, table 0653 (OFF, C1-C6, SC1-SC6, F1-F6, SF1-SF6); depths from manual figure 6 |
| 3 | CHORUS SPEED | Reference manual (CHORUS, lower LED) | Firmware: 057E (value + 1: 01-99) |
| 4 / 5 | DELAY TIME (MSB / LSB) | Reference manual (DELAY, upper LED); service manual "Delay time MSB / LSB" | Firmware: 05C6, milliseconds 001-100 or 001-490 |
| 6 | DELAY REGENERATION | Reference manual (DELAY, lower LED) | Firmware: 0585 (00-99) |
| 7 | REVERB ALGORITHM | Reference manual (REVERB, upper LED) | Firmware: 0547, table 069E (ro1-ro4, HL1-HL4, CH1-CH4, PL1-PL4, gt1, gt2, rE1, rE2); names and kinds from manual figure 5 |
| 8 | REVERB DECAY | Reference manual (REVERB, lower LED) | Firmware: 0585 (00-99) |
| 9 | REVERB MIX | Reference manual (MIX, upper LED); service manual "Reverb mix" | Firmware: 0585 |
| 10 | DELAY MIX | Reference manual (MIX, lower LED); service manual "Delay mix" | Firmware: 0585 |
| 11 | CONFIG | Reference manual (CONFIG button) | Firmware: 057E (01-15); signal paths from manual figure 10 |
| 12 | MOD ROUTING | Reference manual (MOD button) | Firmware: 0557, table 06DA (OFF, then source P 1 n U A S b 7 x target rd dt dr cs rL dL); meanings from manual figure 10 (mod routing display) and the MIDI receiver (below) |
| 13 | MOD AMPLITUDE | Reference manual (MOD, second press) | Firmware: 059B (-99 ... 00 ... 99, stored 0-198) |
| 14 / 15 | Spare | Service manual "spare" | No page, display or DSP routine reads them (no descriptor points there; opcode 03 parameters 13 / 14 write them; a recall passes them unchanged) |

Which byte the REVERB / DELAY / CHORUS / EQ / MIX buttons edit with the lower or upper EDIT LED is the
reference manual's (section 4, "Editing a program") and agrees with the firmware's button positions
(4400: 0-4 lower, 5-9 upper; table 0DB2).

## Firmware tables

- 0ECF + 11n: 21 parameter descriptors (0D15): storage 44xx (the work copy of EEPROM 06xx), minimum,
  maximum (two bytes for the long DELAY TIME), default (both VALUE buttons, 0BD5), "marks the program
  edited", display routine, DSP routine, VALUE handler (100C, two-byte 1012: down stops at 1, INT. PROG
  1018). Descriptor 18 shows `---`, 20 `Snd`.
- 0DB2 + 19c: per configuration, the descriptor of each button position: 0-4 REVERB..MIX (lower LED), 5-9
  (upper LED), 10 CONFIG, 11 / 12 MOD (each press toggles routing / amplitude, 1083), 13 MIDI PROG, 14 INT.
  PROG, 15-18 the MIDI pages (channel, program change, echo, send; 10A8). Configurations 14 and 15 show
  descriptor 18 (`---`) for REVERB ALGORITHM, DECAY and MIX, and descriptor 17 (1-490 ms) for DELAY TIME.
- 0D2B: the longest delay of each configuration (100 ms, 490 ms in 14 / 15); 11AF limits the program's
  delay to it whenever the configuration or reverb changes.
- 4000: the 100 factory programs (16 bytes each), programs 000-099; a reset copies them to 100-199.
- 31D0 (read backwards): the limit of each program byte on recall (29EB); 31C1 / 31A3 the limit and DSP
  routine of each SysEx parameter number.

## Memory and MIDI

EEPROM 0000-06D5 (1750 bytes) is what a dump carries; 06D6 / 06D7 hold E6h / 3Ah ("initialised"; 06D6 is
also the location polled while a byte is written).

| Address | Contents |
|---|---|
| 0000 + 16n | User program 100 + n |
| 0640 | Edit buffer (the current program as edited) |
| 0650 | Current program 0-199 |
| 0651 | Edited (1: dot after the program number) |
| 0652 | The program change number the MIDI PROG page shows |
| 0653 | MIDI ECHO (EoF / Eon) |
| 0654 | MIDI CHANNEL - 1 (c01-c16) |
| 0655 | MIDI PROGRAM CHANGE (PoF / Pon) |
| 0656-06D5 | MIDI program map: program change 0-127 -> program 0-199 (INT. PROG) |

SysEx `F0 00 00 0E 03 <op> ... F7`, no channel byte; header check 2FF0, opcode below 8, jump table 3031:

| Op | Message | Handling |
|---|---|---|
| 00 | `00 <bytes as bits 0-6, bit 7>` | All data (3261): bytes go to a buffer at 4100 until F7, are written to EEPROM 0000 on (as many as came), then the unit restarts (331B). The unit sends this (3320) with all 1750 bytes |
| 01 | `01 n <16 bytes as bits 0-6, bit 7>` | One program (3049) into the edit buffer; n < 100 also stores it as program 100 + n and makes that current (0650 = n + 100, edited off); otherwise the buffer is marked edited. 11AF then limits its delay time |
| 02 | `02` | Request: answered with 00 at once (3320) |
| 03 | `03 p <bits 0-6> <bit 7, bits 8-9 in bits 1-2>` | Parameter p 0-14 of the edit buffer (310F): 0-3 = bytes 0-3, 4 = delay time (bytes 4 / 5), 5-14 = bytes 6-15; limited to table 31C1 (the delay time to 1-490 only through 11AF on a configuration change); marks the buffer edited and runs the parameter's DSP routine |
| 04-07 | | Ignored |

With MIDI ECHO on, the header of a SysEx message for the unit is echoed and closed with F7
(`F0 00 00 0E 03 F7`, 301B); the editor recognises and ignores that. v1.01 sends no program changes and no
SysEx except the dump.

Channel messages (2D38): program change with Pon recalls the mapped program (2E4B); MOD ROUTING sources:
pitch bend (P), controller 1 (1), note number (n) and velocity (U) of note-ons, aftertouch / channel
pressure (A), controller 64 (S), controller 2 (b) and controller 7 (7) on the MIDI channel.

## Editor

- **Program** (the edit buffer, 16 bytes): grouped as Configuration, Reverb, Delay, Chorus, EQ, Modulation,
  Spare, each value as the LED shows it. Reverb pages are hidden in configurations 14 and 15; DELAY TIME is
  typed in ms up to the configuration's limit (labelled pre-delay in 1, 7, 13). Every change sends opcode
  03; Send to edit buffer sends opcode 01 with number 127. Store as user program sends opcode 01 with
  n = program - 100. Slots: user 100-199 (read from the all-data dump, written with opcode 01) and the
  factory programs 000-099 (from the ROM table). Programs have no names: the name shown is made of the
  configuration, reverb, chorus and delay time.
- **Memory** (the 1750 bytes): MIDI channel, program change, echo, MIDI PROG page, current program, edited
  flag, the 128-entry program map; user programs and edit buffer are edited on the Program page. Sent only
  as a whole (opcode 00; the unit writes it for about 10 s and restarts). Factory contents = what INT. PROG
  + STORE at power-on leaves (010B-0169: channel 1, Pon, Eon, the map 000-127 to themselves, program 000).
- minGap 400 ms: a program message writes 34 EEPROM bytes (each polled at 06D6) while MIDI waits in the
  256-byte receive ring.

## Head Library

Patch kind `effect`. toCommon: `effects.reverb` (type from manual figure 5, decay, REVERB MIX; pre-delay =
DELAY TIME / 140 ms in configurations 1, 7, 13), `effects.delay` (time ms / 1500, regeneration, DELAY
MIX), `effects.modulation` (and `effects.chorus` for the chorus algorithms: type, CHORUS SPEED as rate,
the algorithm number as depth), the 16 bytes in `extra` (family `alesis-midiverb3`), so MIDIVerb III to
MIDIVerb III is exact. From another family: configuration 1 (reverb with pre-delay), 2 (reverb) or 14 (no
reverb), started from the first factory program with that configuration, then reverb kind, decay, levels,
delay time, regeneration, chorus kind / depth / speed; the report lists each.

## Unverified

Everything on hardware; whether the unit takes a dump shorter than 1750 bytes as harmlessly as the code
suggests; the manual figure 5 row order (kinds of reverb) as read from the PDF text.
