# Viscount EFX-10: MIDI implementation from the v1.02 firmware

Source: `viscount_efx-10.zip` (one 128 KB EPROM image, 8051 code; the copyright block at 0026 reads
"INTERCONTINENTAL ELECTRONICS SpA Mondaino (FO) ITALY, Date: 16/10/1995, Version: 01.02, Developed by:
TERRULI GIACOMO", the last bytes "Ver.13/Nov./1995 COD.18P134--1.02"). Work copy and listing are in
`re/fx/viscount-efx10/` (`efx10.lst`, made with `re/fx/tools/rdis8051.py`, which follows the firmware's
`ADD A,#k / MOVC A,@A+PC` word jump tables; the per-algorithm page tables are given their sizes on the
command line, see below). All addresses below are in that image.

The tables (`js/devices/defs/viscount-efx10-fw.js`) come from `tools/viscount/efx10_fw.py`, which runs the
firmware in the 8051 emulator (`tools/alesis/i8051.py` with the board model `tools/viscount/efx10_board.py`)
from reset, then shows and steps every edit page of every algorithm (about 40 minutes; `--cache DIR` keeps
each algorithm's result and reuses it on the next run):

    python -I tools/viscount/efx10_fw.py re/fx/viscount-efx10/fw/viscount_efx10_v1_02.bin js/devices/defs/viscount-efx10-fw.js --cache <dir>

The listing was made with
`python -I re/fx/tools/rdis8051.py fw/efx10_lo.bin efx10.lst 1b@116f 10@5528 10@5e08 f@5e47 e@5ee9 10@61ae f@662f b@67c2 e@6ad3 c@d8e9 1d@6ebd 2d@75b5 17@7cfc c@81c7 16@8911 c@8edb 10@9403 12@9771 1f@9f21 14@a88c 2f@b1d0 1a@c003 16@c7b2 16@cca9 24@d339 a@dc8f a@e3b1`
(in `re/fx/viscount-efx10/`; the sizes are the page counts of the ROM records).

**Not checked on hardware** (no EFX-10 is connected); the tests use the definition's simulator.

## Hardware as the firmware uses it

- Code fetches and `MOVC` read the low 64 KB of the EPROM; `MOVX` reads at 8000-FFFF read the high 64 KB
  (image 10000 + address: LCD texts, page templates at 8000, the ROM presets at D6A2). With port P1.7 low
  (interrupts off) `MOVX` reads at 0000-7FFF also come from the high half (DSP tables at 3000-5F36, the user
  presets of the first power-up at 0000); otherwise 0000-3FFF is the battery-backed RAM.
- RAM: user presets 028-128 at 2000 + 40h n, the 03 message buffer at 3C00, the block receive buffer at
  3D00, the edit buffer at 3D80, the transmit buffer at 3E00, the program map at 3F00-3F7F, a signature at
  3F80-3FBF (a copy of code 00A0-00DF), the settings at 3FC0-3FFF. Writes at 8000 and up go to the DSP; E000
  is an output latch. The LCD (2 x 16) is driven serially through P3.4 / P3.5 (0A49, 0A7C).
- First power-up (030A): when 3F80-3FBF differ from code 00A0 the unit writes the signature, sets the map
  1:1, copies the 101 user presets from ROM 10000 (each with its XOR byte at 3Eh) and the settings from code
  00E0 (032B).

## Presets

64 bytes, the same in RAM, in the edit buffer and in a block:

| Bytes | Meaning |
|---|---|
| 0-3 | not shown (the program number takes their place; spaces in the factory presets, "001 " ... after storing a recalled ROM preset) |
| 4-15 | the title, 12 characters 20h-7Fh (NAME EDIT, 11DD: the cursor runs over 4-15, 0F08) |
| 16 | the algorithm, 0-26 |
| 17-54 | the algorithm's parameters (unused ones FFh in the ROM presets) |
| 55-57 | DIRECT LEVEL, EFFECT LEVEL, MASTER LEVEL (0-100; not every algorithm has the first two) |
| 58-59 | MIDI CTRL 1 / 2: the controller each listens to (80h OFF, 60h PB, 0-31, 64-95) |
| 60-61 | the parameter MIDI CTRL 1 / 2 moves: an index into the algorithm's list (431E; the 03 parser limits it to the page count - 4) |
| 62 | XOR of bytes 0-61: STORE (159E) writes it, a recall (0E31) refuses a user preset whose byte does not match ("** DATA ERROR **") |
| 63 | not used (STORE leaves it alone; 55h in the ROM copies) |

- 001-027 are the ROM presets, one per algorithm in algorithm order (81-byte records at 1D6A2: LCD line 1
  "001 Large Hall  ", line 2 the algorithm name, 48 bytes from byte 16, then the number of edit pages).
  Recalling one copies line 1 and the 48 bytes into the edit buffer (0DDD).
- The edit pages of each algorithm: handler table 116F (one handler per algorithm, each with its own word
  table of pages), page templates 42B1 (32-byte LCD screens at XDATA 8000+), the assignable parameter
  names 431E. The generator shows each page (1AC7) and steps it down to its lowest value and up to its
  highest (1152, with 20.2 = up), recording the bytes each step changes and the LCD text. A page whose bytes
  no other page uses is taken as whole bytes; pages that share a byte keep their bits (EFF. ON/OFF flags in
  byte 17 of the KEYBOARD MULTI and GUITAR MULTI algorithms, MULTI TAP DELAY's pan in the top nibble of each
  tap time). Two-byte values are big-endian.
- Pages the unit hides: MIDI CTRL 1 / 2 (the parameter) only while the controller is assigned; some pages of
  the multi-effects only with certain values of other pages (GUITAR MULTI: WAH-WAH SENS and LEVEL while
  WAH-WAH is ON, the PRE-DIST / POST-DIST / LINE DRIVER filters while DISTORTION TYPE is USER, MODULATION
  FEEDBACK while MODE is FLANGER; MULTI CHORUS: stage 6 / 7 pages by MODE). The generator finds such a value
  by trying the states the option-like pages step through; the editor shows these pages always and names
  that value in their help.
- Fields the display reads as two bytes although the page never reaches the high byte (a value up to 200 in
  the low byte): the generator sets the byte before the field to 1 and compares the page (KEYBOARD MULTI 1
  PRE DELAY: 20ms becomes 276ms); 15 pages are two-byte fields this way (MULTI DELAY tap 5, the chorus pre
  delays, KEYBOARD MULTI 1 / 2 delays). With them no preset byte that the DSP update (3982) reads is left
  without a page: the other bytes of 17-54 are not used by the algorithm (FFh in the ROM presets).
- Values are listed as the LCD shows them (e.g. REV TIME 0.1s-20.0s, delay times in ms, PAN `L 50:R 50`,
  signed values with bit 7 as the plus sign: PITCH -24 ... +24, FINE / RESONANCE -100 ... +100).

| Byte 16 | ROM preset | Algorithm | Pages | Blocks (page order) |
|---|---|---|---|---|
| 0 | 001 Large Hall | LARGE HALL | 16 | HALL, REVERB |
| 1 | 002 Medium Hall | MEDIUM HALL | 16 | HALL, REVERB |
| 2 | 003 Large Room 1 | LARGE ROOM | 15 | REVERB |
| 3 | 004 Medium Room | MEDIUM ROOM | 15 | REVERB |
| 4 | 005 Small Room 1 | SMALL ROOM | 14 | REVERB |
| 5 | 006 Early Ref. | EARLY REF. | 16 | EARLY REF. |
| 6 | 007 Gate Reverb | GATE REVERB | 15 | GATE REVERB |
| 7 | 008 Plate 1 | PLATE | 11 | REVERB |
| 8 | 009 Ambience 1 | AMBIENCE | 14 | AMBIENCE |
| 9 | 010 Delay 2000ms | MONO DELAY | 12 | MONO DELAY |
| 10 | 011 Multi Dly 1 | MULTI DELAY | 29 | DELAY 1-5 |
| 11 | 012 Tap Delay 1 | MULTI TAP DELAY | 45 | DELAY TAP 1-11, DELAY FEEDB., DELAY |
| 12 | 013 Delay 1000ms | STEREO DELAY | 23 | DELAY LEFT, DELAY RIGHT, DELAY |
| 13 | 014 Chorus 1 | SPACE CHORUS | 12 | SPACE CHORUS |
| 14 | 015 P. Shifter | ST.PITCH SHIFTER | 22 | P. SHIFTER |
| 15 | 016 Flanger 1 | STEREO FLANGER | 12 | FLANGER |
| 16 | 017 Phaser 1 | ST. PHASER DELAY | 16 | PHASER, DELAY |
| 17 | 018 Rotary 1 | ROTARY | 18 | ROTARY |
| 18 | 019 Keyboard 1 | KEYBOARD MULTI 1 | 31 | EFF. ON/OFF, FLANGER, DELAY, CHORUS, PANNING, REVERB |
| 19 | 020 Keyboard 2 | KEYBOARD MULTI 2 | 20 | PHASER, N.SUPPRESSOR, CHORUS |
| 20 | 021 Guitar Multi | GUITAR MULTI | 47 | EFF. ON/OFF, COMPRESSOR, WAH-WAH, DISTORTION (PRE-DIST, POST-DIST, LINE DRIVER), N.SUPPRESSOR, DELAY, MODULATION, REVERB |
| 21 | 022 Reverb+Delay | REVERB+DELAY | 26 | REVERB, DELAY |
| 22 | 023 Reverb+Chor. | REVERB+CHORUS | 22 | REVERB, CHORUS |
| 23 | 024 Chorus+Delay | CHORUS+DELAY | 22 | CHORUS, DELAY |
| 24 | 025 Multi Chorus | MULTI CHORUS | 36 | MULTI CHORUS (6 / 10 / 14 STAGES) |
| 25 | 026 Hum Canc. | HUM CANCELLER | 10 | HUM CANC., NOISE RED. |
| 26 | 027 Voc. Canc. | VOCAL CANCELLER | 10 | VOCAL CANC. |

Each algorithm also has its level pages (DIRECT / EFFECT / MASTER LEVEL, not all three everywhere) and the
four MIDI CTRL pages (ASSIGN MIDI CTRL 1 / 2 and the parameter each moves).

## Settings and program map

The MIDI menu pages (16A7, value handlers 0FF8; texts at E15D-E39D):

| Byte | Page | Values |
|---|---|---|
| 3FC0 | (none) | the program shown (0-127), recalled at power-on; a settings block received sets it |
| 3FC1 bits 0-3 | MIDI CHANNEL | CHANNEL: 01-16 |
| 3FC1 bit 7 | MIDI OMNI MODE | OMNI : OFF / ON (ON skips the channel page) |
| 3FC2 bit 0 | EFFECT OFF MODE | SELECT : DIRECT / MUTE |
| 3FC2 bit 1 | MIDI EDIT EXC. | SELECT : OFF / ON: ON takes SysEx at any time |
| 3FC2 bits 2-3 | PED.PRG. INC/DEC | SHIFT XXX TO XXX / PROGRAM MAP / SEL: XXX XXX XXX |
| 3FC2 bits 4-5 | AUX PEDAL SELECT | BY PASS / PROGRAM DECREASE / SPECIAL FUNCTION |
| 3FC2 bit 6 | MIDI OUT / THRU | SELECT : OUT / THRU (P1.6) |
| 3FC3, 3FC4 | MIDI BULK DUMP | FROM / To: SYSTEM (0) or No.028-No.128 (27-127; To is kept at or above FROM, 126B) |
| 3FC5, 3FC6 | PED.PRG. INC/DEC | SHIFT 001 TO 128 |
| 3FC7-3FC9 | PED.PRG. INC/DEC | SEL: three programs |
| 3FCA-3FCD | MIDI CTRL 1 / 2 | RANGE MIN / RANGE MAX 000-127 (MIN stays below MAX) |
| 3FCE | L.C.D. CONTRAST | ADJUST 0-7 bars |
| 3FCF-3FDF | (none) | kept from a received block, never read |
| 3FE0-3FFF | (none) | sent in the settings block, not kept on receive |
| 3F00-3F7F | MIDI PROGRAM MAP | PRO: 001-128 -> NO: 001-128 (program change n recalls preset map[n], 1E08) |

Bit 7 of 3FC2 is not used. Other menu pages are actions: NAME EDIT (user presets), SWAP PROGRAMS, MIDI
BULK DUMP / BULK LOAD.

## SysEx

`F0 31 1n 02 ...` (Viscount, 1n = 10h + channel, model 02); the receiver (serial interrupt 1C3E) takes 1n
for its channel or any with OMNI ON, and only with MIDI EDIT EXC. ON or while MIDI BULK LOAD shows WAITING
(1CB1). In BULK LOAD the first message turns the display to DATA RECEIVING (0A0D), the end message to DATA
RECEIVED and recalls the program again (0A21).

| Message | Meaning |
|---|---|
| `12 aa bb <128 nibbles> <cs> F7` | a 64-byte block, number aa x 16 + bb; each byte high nibble first; cs = XOR of the 128 nibbles (1DBB); a wrong one shows ** DATA ERROR ** |
| block F0 / F1 | program map 001-064 / 065-128 |
| block F2 | settings 3FC0-3FFF (the unit sends 64 bytes and keeps the first 32, 0845) |
| block 1B-7F | user preset 028-128; while the unit is in EDIT any preset block goes to the edit buffer (39E8); blocks 00-1A are not checked and land on 3940-3FFF (39E8: the buffers, the edit buffer, the map, the signature at 3F80, which would make the next power-up a first one, and the settings): the editor never sends them |
| `45 F7` | end of a dump; BULK DUMP sends it last (1571), the receiver ends DATA RECEIVING with it |
| `03 xx pp <section> <index> <parameter> <value> F7` | MIDI EDIT EXC.: one parameter of the program shown; pp must equal it (program number - 1), xx is not read; parsed per algorithm (table 2039) |

MIDI BULK DUMP (14B3) sends, from FROM to To: with FROM SYSTEM the blocks F0 (as `0F 00`), F1, F2, then the
presets (from 028 when FROM is SYSTEM) and `45`. The unit waits for each message to leave and about 0.37 s
more (0B31): SYSTEM To No.128 is 105 messages, about 45 s. Nothing can be requested.

The 03 parameter messages: section and parameter numbers per algorithm (e.g. LARGE HALL: section 01 with
2D SIZE, 0C REV TIME, 18 REV DELAY, 15 REV TONE, 20 REV HF GATE, 31 REV ATTACK; section 0D with 18 E.R. DELAY,
15 E.R. TONE, 02 E.R. LEVEL; any section with index 00 and 03 DIRECT, 52 EFFECT, 01 MASTER LEVEL; index 01 / 02
with 64, the controller and the parameter, for MIDI CTRL 1 / 2). The generator explores the parser by
following the values it compares message bytes with, and matches each path to the page that stores the
same bytes. Value forms: one byte; two 7-bit bytes (times); the controller with 7Fh for OFF; a byte the
parser converts from 0-127 (the hum canceller's frequencies and thresholds, the noise reduction envelope:
the generator lists what each message value stores, and the editor sends the nearest it can); signed values
as two 7-bit bytes around 2000h (3Fh xx below zero, 40h xx above). Two pages have no working message in
v1.02: GUITAR MULTI's REVERB PRE DELAY (`01 00 18` stores two bytes into 52-53, so it also overwrites EFF.
LEVEL) and MODULATION PRE DELAY (`1B 00 18` stores into 43, the MODE byte); the editor does not send those
two live (write the preset instead). A message whose value the parser cannot use for the algorithm shown
is ignored or misread, so the editor's algorithm must match the program on the unit.

Universal identity request `F0 7E 0F 06 01 F7` (only device number 0F, 1D2C) is answered with
`F0 7E 0F 06 02 31 00 1C 12 00 00 00 00 00 F7` (0B7A; also sent once at power-up, 05C2). Program change
recalls through the map (on the channel, or any with OMNI). MIDI CTRL 1 / 2: controller changes (or pitch
bend) move the parameter each preset assigns, within RANGE MIN / MAX.

## Editor

- **Preset**: the algorithm (changing it loads its ROM preset's values, as recalling that preset and storing
  it does on the unit), every edit page of the algorithm with its LCD label and value texts, the levels, the
  two MIDI CTRL assignments and the title (Rename). Each change is sent at once as a MIDI EDIT EXC. message
  for the "Program on the unit" chosen above the page (the unit takes it with MIDI EDIT EXC. ON while it shows
  that program, and the program must use the same algorithm). Get from device reads that program: a ROM
  preset from the firmware, a user preset by waiting for its MIDI BULK DUMP. "Write and recall" sends the
  preset into that user preset and recalls it. Slots: user 028-128 (Edit waits for MIDI BULK DUMP of that preset, Read names
  for SYSTEM To No.128, Store sends the block and the end message) and ROM 001-027 (from the firmware).
  Play sends program change preset - 1 (the map as the first power-up sets it).
- **Algorithms** gallery: the 27 algorithms with the blocks their pages edit, in page order.
- **Settings**: the MIDI menu settings and the program map (blocks F0-F2); Send to the EFX-10 after
  putting it on MIDI BULK LOAD or with MIDI EDIT EXC. ON.
- Branch Library: "Record a dump" or the complete dump (SYSTEM To No.128) records the blocks; a dump becomes
  its presets and one settings item.
- Head Library translator: reverb (REV TIME / TIME, REV DELAY / PRE DELAY, its level or EFFECT LEVEL),
  delay (the first delay time, feedback, level), chorus / flanger / phaser (RATE, DEPTH, LEVEL) and the pitch
  shifter and rotary as `effects`; exact bytes in `extra`.

## Open

- A hardware check: the block format and pacing, MIDI EDIT EXC. with each algorithm, the identity reply.
- What "xx" (the byte after 03) means to a Viscount controller: the EFX-10 does not read it.
