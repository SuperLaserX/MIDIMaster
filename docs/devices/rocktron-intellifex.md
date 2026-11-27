# Rocktron Intellifex LTD: MIDI implementation from the v1.0 firmware

Source: `Rocktron Intellifex LDT firmware v1.0 - Jan-1995 eprom 27C256.zip` (32 KB, 8031 code at 12 MHz;
the screen says `ROCKTRON INTELLIFEX-LTD` and `LTD VERSION 1.00`). Work copy, Ghidra project and a
listing that follows the jump tables (`re/fx/tools/rdis8051.py`) are in `re/fx/rocktron-intellifex/`.
All addresses below are in that image. The editor (`js/devices/defs/rocktron-intellifex.js`) is for the
LTD; the full-size Intellifex may differ (no firmware of it in the collection). Tables
(`rocktron-intellifex-fw.js`) come from `tools/rocktron/intellifex_fw.py`, which reads the menu tables
and runs every page's display routine in the 8051 emulator (`tools/alesis/i8051.py`):

    python -I tools/rocktron/intellifex_fw.py "<image .bin>" > js/devices/defs/rocktron-intellifex-fw.js

**Not checked on hardware** (no Intellifex is connected); the tests use the definition's simulator.

## Memory and presets

- 160 presets: 1-80 in an 8 KB EEPROM (XRAM 0000-1FFF, byte writes wait about 12 ms each, 0C9B, and are
  read back to check: "XMEM ERROR"), 81-160 in ROM (titles 1C54, 13 characters; parameters 2084, 55 bytes).
- A user preset is three pieces, sent together as 100 bytes: 55 parameter bytes (0A81 + 55n), the title
  (1BEF + 13n, characters 20h-5Bh, TITLE EDIT pages 63h-6Fh) and 8 controller assignments (0081 + 32n).
- Byte 0 is the configuration, 0-5 (a larger value loads as 0, 0DED; the factory presets keep it + 8, and
  160 BYPASS has 14, which also opens the FACTORY RESTORE block):

| Byte 0 | Name (45A0) | Blocks (368F, 37AF) |
|---|---|---|
| 0 | HUSH>CHORUS>DLY>REV | MIXER, HUSH, VOICE/DLY 1-4, DUCKER, REVERB |
| 1 | HUSH>PSHIFT>DLY>REV | MIXER, HUSH, VOICE/DLY 1-2, DELAY 3, DUCKER, REVERB |
| 2 | HUSH>REVERB | MIXER, HUSH, REVERB |
| 3 | HUSH>DELAY>DUCKER | MIXER, HUSH, DELAY, DUCKER |
| 4 | HUSH>8V-CHORUS>DLY | MIXER, HUSH, VOICE/DLY 1-8 |
| 5 | HUSH>PSHIFT>DELAY | MIXER, HUSH, VOICE/DLY 1-4 |

The names are written with display characters 9B-9E: a letter plus an arrow segment and the decimal
point; the editor writes them as `Y>`, `H>`, `S>`, `T>`.

- Bytes 1.. hold the configuration's pages in the order of table 320F (41, 34, 18, 23, 49, 29 pages);
  338F is the reverse map. The rest of the 55 bytes is not read in that configuration (the loader 0DED
  stops at the end of the list); the editor keeps them as they came. A value at or above the page's
  count (12C8) loads as 0 (0E2C).
- Every page has its label at 39B0 + 16p and a display routine (jump table 0905). The generator runs each
  routine for every value and decodes the 16-segment font at 1834 (two bytes per character from 20h;
  bit 15 is the decimal point, so 6Ch-75h are `0.`-`9.` and 6Ah is a lone point; `!` lights segments
  c, d, e and g, a small o, so the lowest level reads `-oo`, minus infinity). Values are listed as the
  display shows them: levels -oo, -48 ... 0.0 (or ... + 6.0 for the mix levels), pans `L< 0 R` ... `L<50>R`
  ... `L100>R`, pitch -2400 ... 00 ... +1200 cents in 20-cent steps with FINE -20 ... +20, delay times in
  ms (DLY TIME1 / TIME2 in 5 ms steps, 10 ms when D TYPE is 2-TAP: 09E3 reads page 23h), RATE / DEPTH /
  DECAY / DAMP / GATE DECAY / HOLD TIME as plain numbers. The display shows no unit for the levels.
- Controller assignments (block CONTROLLER ASSIG, utility pages 2-21h): NUMB n = MIDI controller 0-120,
  121 = OFF (1B27 takes controllers below 121); PARA n = an index into the configuration's 320F list
  (0B7C shows the first ten characters of that page's label; the maximum is 3209 + configuration);
  ULIM / LLIM n = the range, in that parameter's values (0C06 shows them with its display routine).
  Choosing PARA sets ULIM to the parameter's top value and LLIM to 0 (0438). Controllers act only while
  a user preset is current (1AEE: preset below 81).

## Globals and program map

Six bytes at 1BE9 and the program map at 0001-0080 travel with the user data:

| Byte | Page | Values |
|---|---|---|
| 1BE9 | (none) | 17h or 0Ah: the power-on test (009C) wants one of them, else EXT MEMORY ERRORS; FACTORY RESTORE writes 17h with ENTER CODE 249 and 0Ah with code 10; code 2 repeats the restore it names (04E7) |
| 1BEA | PROG MAPPING | OFF / ON: program changes looked up in the map (1B06) |
| 1BEB | BYPASS | LATCH / MOMNTARY: the bypass footswitch (1599) |
| 1BEC | INC/DEC | LATCH / MOMNTARY: the INC/DEC footswitches (15A2) |
| 1BED | PWR ON PR | preset 1-160 recalled at power-on (values from 160 up give 160); stored from the first menu column ("PWR ON PR STORED", 03C3) |
| 1BEE | MIDI CHANNL | 1-16, OMNI, OFF (1ACF) |
| 0001+n | n MAP TO | program change n+1 -> preset 1-160 or OFF (A0h); the editor lists 0-160 |

The FOOTSWITCH TYPES block (88h) holds BYPASS and INC/DEC, but no configuration's block list (368F) and no
utility row (3944) reaches it in the LTD v1.0, so the two bytes change only over MIDI or by a restore.
FACTORY RESTORE (ENTER CODE): code 249 (108A) = map 1:1, mapping OFF, OMNI; code 10 (10AF) = map 1BD4
(1-30 to 1-30, 31-78 to 111-158, the rest to 160), mapping ON, channel 1. Both copy the factory presets
81-160 into 1-80 with the default controller assignments at 2064 (all NUMB OFF; PARA = the first eight
parameters of the list).

## SysEx

`F0 00 00 29 02 <op> <data> <cs> F7`: every data byte is two bytes, bits 0-6 then bit 7 (0 or 1); `<cs>` =
XOR of those, 7 bits (sender 058B / 05C2 / 05A4, receiver state machine 1A3A, check 0849). The MIDI channel
does not apply. There are no requests and no parameter messages: the MIDI DUMP/LOAD menu (utility pages
28h-2Bh) sends, and the receiver takes data only while PRESET LOAD or LOAD USER DATA is shown (1B6A).

| Op | Data | Sent by / taken on |
|---|---|---|
| 28h | 100 bytes: a preset | PRESET DUMP sends the preset chosen on the page (04F6); PRESET LOAD stores into the one chosen there (0796) |
| 2Ah | 100 bytes: preset 1 | first message of DUMP USER DATA (0520) / LOAD USER DATA (07DE) |
| 2Bh | 100 bytes, presets 2-80; then 128 bytes, the map; then 6 bytes, 1BE9-1BEE | the other 81 messages; LOAD USER DATA takes them only after a 2Ah |

The sender waits about 1.8 s between the user-data messages (0633: 9 x 256 display ticks) so the
receiver can write its EEPROM; the editor's SysEx gap is 2 s. A complete user-data dump takes about
2 1/2 minutes. Program change: preset = program + 1, or the map with PROG MAPPING ON (1B06).

## Editor

- **Preset**: configuration, the pages of its blocks (each with its display texts; REVERB LVL appears in
  MIXER and REVERB of configurations 0/1 and is one byte), the title (Rename) and the eight controller
  assignments. Nothing is sent per change (the unit has no such message): Send to PRESET LOAD sends the
  preset, and a preset the unit sends with PRESET DUMP replaces the editor's. Slots: user 1-80 (Read waits
  for a PRESET DUMP, Read names for DUMP USER DATA, Write sends to PRESET LOAD) and factory 81-160 (from
  the ROM, loaded as FACTORY RESTORE copies them). Play sends program change preset - 1 (128 and up need the map).
- **User data**: the globals and the program map, plus the 80 presets it is sent with; Send to LOAD USER
  DATA sends all 82 messages (after a confirmation: it replaces every user preset). The factory contents of
  both restore codes are offered.
- Branch Library: "Record a dump" or the complete dump records PRESET DUMP / DUMP USER DATA; a user-data
  dump becomes the 80 presets (each sent alone through PRESET LOAD) and one user-data item.
- Head Library translator: reverb (REV TYPE, REVERB DECAY, PREDELAY on HUSH>REVERB; REVERB LVL), delay
  (DELAY block, DELAY 3 or the voice delays with REGEN L), chorus (voice 1's RATE / DEPTH, CHORUS LVL)
  and pitch shift (PSHIFT LVL) as `effects`; levels in dB as gain; exact bytes in `extra`.

## Open

- A hardware check: the dump format, the 2 s pacing on LOAD USER DATA and the program map.
- Which front-panel key starts a dump on the MIDI DUMP/LOAD pages (the firmware reads it in the
  utility handler 03BB; the manual is not in the collection).

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Controller assignments: the preset byte holds PARA + 1.
