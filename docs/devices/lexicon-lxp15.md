# Lexicon LXP-15: MIDI implementation from the v2.00 firmware

Source: `Lexicon LXP-15 v2.zip` (`Lxp15 v2.BIN`, one 64 KB EPROM, Z80 code; the power-up screen reads
"Lexicon LXP-15  Version 2.00 / Copyright 1994 Lexicon, Inc."). Work copies are in `re/fx/lexicon-lxp15/fw/`
(also v1.31 from `Lexicon LXP-15 v1.31.zip`, U45, "Copyright 1991", not covered: see Open). Listings
`re/fx/lexicon-lxp15/lxp15_v2_A.lst` and `_B.lst` come from `tools/lexicon/lxp15_dis.py` (one per bank; it
follows the cross-bank thunks and the stackless `LD IY,return / JP routine` calls of the start-up code):

    python -I tools/lexicon/lxp15_dis.py re/fx/lexicon-lxp15/fw/lxp15_v2.bin re/fx/lexicon-lxp15/ A:00e5 A:0f0e A:3687 B:1819 B:2155 B:2352

The tables (`js/devices/defs/lexicon-lxp15-fw.js`) come from `tools/lexicon/lxp15_fw.py`, which runs the
firmware in the Z80 emulator (`tools/art/z80.py`, board model `tools/lexicon/lxp15_board.py`, panel driver
`tools/lexicon/lxp15_emu.py`, page survey `tools/lexicon/lxp15_survey.py`) and works the front panel
(about two hours; `--cache DIR` keeps every stage):

    python -I tools/lexicon/lxp15_fw.py re/fx/lexicon-lxp15/fw/lxp15_v2.bin js/devices/defs/lexicon-lxp15-fw.js --cache re/fx/lexicon-lxp15/cache

The test vectors (`tests/lexicon-lxp15.vectors.json`: the firmware's replies to every request, and what its
receiver did with dumps) come from the same tool with the stage `vectors` and the vectors file as output.

**Not checked on hardware** (no LXP-15 is connected); the tests use the definition's simulator and the vectors.

## Hardware as the firmware uses it

- CPU 0000-7FFF is one 32 KB bank of the EPROM: `OUT (80h)` bank A (image 0000-7FFF), `OUT (40h)` bank B
  (image 8000-FFFF). The first 1 KB is the same in both. The firmware keeps the bank in the I register;
  cross-bank calls go through thunks `LD BC,target / JP 018D` (bank B) and `JP 0195` (bank A).
- 8000-A17F: the 128 registers (67 bytes each); A180-A200: the active setup (129 parameters); BD00 / BE00 the
  event queues; stack below BC80; E000-E3FF RAM shared with the slave processor (the DSP host).
- Interrupt mode 1: RST 38h jumps through A372h; a timer interrupt about every 300 instructions; the panel is
  read every 32nd interrupt (68EF).
- LCD 2 x 40 (HD44780 type): port 03 command, 02 data, 01 status, 00 data read. Line 1 shows the setup, line 2
  the five soft-button names (or the long name and value of the parameter ADJUST works on, at column 8 / 20).
- MIDI: an 8251 UART, 28h data, 29h status / command (mode 4Eh). Receiver 3687 (bank A): a state machine
  (next-state addresses A667h for data bytes, A581h for channel messages).
- Panel: port 20h bits 4 / 5 select a key row read on 30h bits 0-2 (active low): soft buttons 1-5 and VIEW;
  port 38h holds two 4-bit gray-coded encoders (high nibble ADJUST, low nibble PAGE, table 69CA); 20h bits
  0-3 the meter LEDs; 18h-1Eh the ADC for the foot pedals.
- Holding VIEW at power-up starts the diagnostics (they need the slave processor, so the emulator starts the
  system at 00E5, after them). First power-up copies the 128 ROM presets into the registers.

## The active setup and the registers

The active setup is 129 parameters; parameter n is RAM A180h + n, and every parameter message, request and
dump uses the same numbers. Every value is 7 bits; 14-bit values take two parameters, low 7 bits first.

| Parameters | Meaning |
|---|---|
| 0 | algorithm: 1 Dly/Rvb, 2 Pch/Dly, 3 Gate, 4 Plate, 5 ChorDly (PAGE 6, Algthm) |
| 1-26 | the algorithm's parameters (each algorithm reads the same bytes its own way: see the tables below) |
| 27-54 | four patches of 7: Src, Thresh, Dest, Scale (14 bits), Offset (14 bits, signed) |
| 55-66 | the name, 12 characters 20h-7Eh (PAGE 14) |
| 67-124 | the unit's settings (PAGE 0, 11-13, 15) and working values: the active setup dump carries them |
| 125-128 | working values the dump leaves out |

A register (and a ROM preset) is parameters 0-66. The 128 ROM presets are at 42DCh in bank A (67 bytes each).
Changing the algorithm changes parameter 0 only.

Every change made on the panel is sent at once as a parameter message (2n pp vv, or 5n pp lo hi for 14-bit
values); the unit takes the same messages and stores them without checking the range (a value the panel
cannot reach is shown with whatever the display routine makes of it).

### How the tables were made

For every algorithm (set with a received parameter message) and every PAGE position 1-10 the generator
presses each soft button and turns ADJUST: the message the change sends names the parameter and its form;
turning to both ends gives the range (a 14-bit value that turns round through 0 is signed: the patch
Offsets); the 7-bit parameters are then stepped one detent at a time over their whole range, which shows the
values the panel reaches (the patch Src and Dest lists end with a jump to 127, an unused patch). The text for
each value comes from the parameter's own display routine (the firmware keeps it at A6ACh for the selected
parameter; bank B 17B5 / 17CE delays, 1A9E percent, 1BB7 pan, 1EDD decay, 1FC1 size, 2111 source, 2133
destination, 2155 scale, 2352 offset, ...), run with each value put in the active setup, and checked
against the panel's own screens for the values it stepped through. The 7-bit tables cover 0-127, so the
values the ROM presets keep outside a panel range have their text too.

The patch Scale and Offset are shown by the unit in the units of the patch's destination (2155 / 2352 call
the destination's display routine with a scaled value, parameter number 5Ch). The tables hold the texts the
unit shows with no destination (percent of full scale, as in the ROM presets, whose patches are unused).

## SysEx

`F0 06 06 <function, n> ... F7`: Lexicon (06), LXP-15 (06); n is the MIDI channel (MIDIchn; any with
Omni). The checksum (cs) is the sum of the data bytes AND 7Fh.

| Message | Meaning |
|---|---|
| `0n 7D <125> cs` | active setup, parameters 0-124 (sent on request or from PAGE 12) |
| `1n rr 43 <67> cs` | register rr (0-127) |
| `4n 43 00 <8576> cs` | all 128 registers |
| `7n 00 02 <256> cs` | program map |
| `2n pp vv` | parameter pp = vv |
| `5n pp lo hi` | parameter pp = lo + 128 hi (14 bits; pp and pp + 1) |
| `3n 60` / `61 rr` / `62 pp` / `65 pp` / `64` / `66` | requests: active setup, register rr, parameter pp as 2n or as 5n, all registers, program map |
| `6n 70 rr` | store the active setup into register rr |
| `6n 71 rr` | load register rr |

- The active setup dump cannot be sent back to a v2.00 unit: its receiver (376A) takes the 0n message only
  with a count of 81h (129 parameters), and 81h is a status byte, which ends the message. v1.31 sent and took
  0n 7D. The editor sets the active setup with parameter messages.
- Register dumps and Store are refused while Memory Protect is On ("Dump Failed: Memory Protected", "MIDI
  Store Failed: Memory Protected"); the all-registers dump is written straight into the registers as it
  arrives, even then.
- Program changes follow PgmChg on PAGE 13: OFF, PRE (presets), REG (registers) or the map.
- Real time: F8 clock (tempo), FA, FC, FF (reset).

## Program map

256 bytes, entry n at 2n: the number 0-127, then 20h for a register, 10h for a preset, 0 for OFF. PAGE 13
edits it: PgmChg on Map n, MapVal Reg 1-128, Pre 1-128, OFF.

## The editor

- Active setup (the register part): every parameter of the five algorithms with the unit's text for every
  value, the four patches, the name; live parameter messages; Get requests the active setup (3n 60); Send to
  the active setup as parameter messages; Store into register (6n 70); registers 1-128 (request 3n 61, store
  as a register dump, play with 6n 71) and the ROM presets 1-128 (from the firmware; play sets Setup #,
  2n 4D).
- Settings: PAGE 0, 11-13 and 15 items (MIDI channel, display contrast and brightness, Memory Protect, Disp
  Update, PgmChg, global patch Dest / Source / Mode, setup numbers), live; the other setup bytes read only.
- Program map: the 128 entries, sent as a 7n dump.
- Simulator and translator (algorithm and the reverb / delay / modulation values as fractions; exact bytes
  within the family).

## Open

- A hardware check.
- The patch Scale and Offset texts in the destination's units (the editor shows the no-destination percent).
- v1.31 (1991): a different program (its texts ask to "Press LOAD"); same SysEx framework, no program map
  message, 0n 7D both ways. Not compared parameter by parameter.
- The names the global patch Dest list shows are the Dly/Rvb parameter names (the list follows the algorithm).

## Tables

Generated from the tables (value: first .. last text, and how many values the panel reaches). MapVal shows --- while PgmChg is OFF, PRE or REG; with PgmChg on a map entry it shows the map values (Reg 1-128, Pre 1-128, OFF). Load and Send are actions on parameter 127, outside the setup dump. The global patch Dest list is shown with the Dly/Rvb names.

### 1 Dly/Rvb

| PAGE / button | Name | Long name | Setup | Values (panel) |
|---|---|---|---|---|
| 1 / 1 | Glidely | Glide Delay | 1-2 (14 bits) | 0..9983: 0us .. 638ms (9984) |
| 1 / 2 | Gldfbk | Glide Fdbk | 3 | 0..127: 0% .. 100% (128) |
| 1 / 3 | Delay 2 | Delay 2 | 4-5 (14 bits) | 0..8959: 0us .. 179ms (8960) |
| 2 / 4 | HiCut | High Cut Frq | 17 | 0..15: 320Hz .. Full (16) |
| 2 / 5 | LoCut | Low Cut Freq | 18 | 0..31: Full .. 1.35kHz (32) |
| 3 / 1 | Decay | Decay Time | 12 | 0..15: 0.6s .. Infinit (16) |
| 3 / 2 | Treble | Treble Decay | 13 | 0..15: 320Hz .. Full (16) |
| 3 / 3 | BassMpy | Bass Multply | 14 | 0..31: 0.35x .. 2.50x (32) |
| 3 / 4 | Size | Room Size | 15 | 0..63: 8Meter .. 71Meter (64) |
| 3 / 5 | Diffus | Diffusion | 16 | 0..100: 0% .. 100% (101) |
| 4 / 1 | InLevl | Input Level | 24 | 0..127: 0% .. 100% (128) |
| 4 / 2 | Mix | Output Mix | 22 | 0..127: 0% .. 100% (128) |
| 4 / 3 | Wet Pan | Wet Pan | 20 | 0..126: 100%L .. 100%R (127) |
| 4 / 4 | Dry Pan | Dry Pan | 21 | 0..126: 100%L .. 100%R (127) |
| 4 / 5 | OutLevl | Output Level | 23 | 0..127: 0% .. 100% (128) |
| 5 / 1 | LFO Rat | LFO Rate | 25 | 0..127: 0.03Hz .. 4.84Hz (128) |
| 5 / 2 | Rvb Mix | Reverb Mix | 19 | 0..127: 0% .. 100% (128) |
| 7 / 1 | Src 1 | Patch Src 1 | 27 | 0..127 (with jumps): 0 .. Off (79) |
| 7 / 2 | Thresh1 | Threshold 1 | 28 | 0..127: 0 .. 127 (128) |
| 7 / 3 | Dest 1 | Patch Dest 1 | 29 | 1..127 (with jumps): Glidely .. - (26) |
| 7 / 4 | Scale1 | Pch Scale 1 | 30-31 (14 bits) | 0..511: -200% .. 199% (512) |
| 7 / 5 | Offset1 | Offset Pch 1 | 32-33 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 8 / 1 | Src 2 | Patch Src 2 | 34 | 0..127 (with jumps): 0 .. Off (79) |
| 8 / 2 | Thresh2 | Threshold 2 | 35 | 0..127: 0 .. 127 (128) |
| 8 / 3 | Dest 2 | Patch Dest 2 | 36 | 1..127 (with jumps): Glidely .. - (26) |
| 8 / 4 | Scale2 | Pch Scale 2 | 37-38 (14 bits) | 0..511: -200% .. 199% (512) |
| 8 / 5 | Offset2 | Offset Pch 2 | 39-40 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 9 / 1 | Src 3 | Patch Src 3 | 41 | 0..127 (with jumps): 0 .. Off (79) |
| 9 / 2 | Thresh3 | Threshold 3 | 42 | 0..127: 0 .. 127 (128) |
| 9 / 3 | Dest 3 | Patch Dest 3 | 43 | 1..127 (with jumps): Glidely .. - (26) |
| 9 / 4 | Scale3 | Pch Scale 3 | 44-45 (14 bits) | 0..511: -200% .. 199% (512) |
| 9 / 5 | Offset3 | Offset Pch 3 | 46-47 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 10 / 1 | Src 4 | Patch Src 4 | 48 | 0..127 (with jumps): 0 .. Off (79) |
| 10 / 2 | Thresh4 | Threshold 4 | 49 | 0..127: 0 .. 127 (128) |
| 10 / 3 | Dest 4 | Patch Dest 4 | 50 | 1..127 (with jumps): Glidely .. - (26) |
| 10 / 4 | Scale4 | Pch Scale 4 | 51-52 (14 bits) | 0..511: -200% .. 199% (512) |
| 10 / 5 | Offset4 | Offset Pch 4 | 53-54 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |

### 2 Pch/Dly

| PAGE / button | Name | Long name | Setup | Values (panel) |
|---|---|---|---|---|
| 1 / 1 | Predely | Pre Delay | 1-2 (14 bits) | 0..16383: 0us .. 1.04s (16384) |
| 1 / 2 | PdlyFbk | PreDly Fdbk | 3 | 0..127: 0% .. 100% (128) |
| 1 / 3 | Delay L | Left Delay | 4-5 (14 bits) | 0..16255: 0us .. 325ms (16256) |
| 1 / 4 | Feedbak | Feedback | 6 | 0..126: 0% .. 100% (127) |
| 1 / 5 | Delay R | Right Delay | 7-8 (14 bits) | 0..16255: 0us .. 325ms (16256) |
| 2 / 1 | Pitch | Pitch Enable | 9 | 0..1: Off .. On (2) |
| 2 / 2 | Intervl | Pitch Intrvl | 10 | 0..36: -2 Oct .. Octave (37) |
| 2 / 3 | PchFine | Pitch Fine | 11 | 0..127: -64 .. 63 (128) |
| 2 / 4 | HiCut | High Cut Frq | 17 | 0..15: 320Hz .. Full (16) |
| 2 / 5 | LoCut | Low Cut Freq | 18 | 0..31: Full .. 1.35kHz (32) |
| 3 / 1 | Decay | Decay Time | 12 | 0..14: 0.6s .. 6.1s (15) |
| 3 / 2 | Treble | Treble Decay | 13 | 0..15: 320Hz .. Full (16) |
| 3 / 3 | BassMpy | Bass Multply | 14 | 0..31: 0.35x .. 2.50x (32) |
| 3 / 4 | Size | Room Size | 15 | 0..25: 8Meter .. 33Meter (26) |
| 3 / 5 | Diffus | Diffusion | 16 | 0..100: 0% .. 100% (101) |
| 4 / 1 | InLevl | Input Level | 24 | 0..126: 0% .. 100% (127) |
| 4 / 2 | Mix | Output Mix | 22 | 0..127: 0% .. 100% (128) |
| 4 / 3 | Wet Pan | Wet Pan | 20 | 0..126: 100%L .. 100%R (127) |
| 4 / 4 | Dry Pan | Dry Pan | 21 | 0..126: 100%L .. 100%R (127) |
| 4 / 5 | OutLevl | Output Level | 23 | 0..127: 0% .. 100% (128) |
| 5 / 1 | LFO Rat | LFO Rate | 25 | 0..127: 0.03Hz .. 4.84Hz (128) |
| 5 / 2 | Rvb Mix | Reverb Mix | 19 | 0..127: 0% .. 100% (128) |
| 7 / 1 | Src 1 | Patch Src 1 | 27 | 0..127 (with jumps): 0 .. Off (79) |
| 7 / 2 | Thresh1 | Threshold 1 | 28 | 0..127: 0 .. 127 (128) |
| 7 / 3 | Dest 1 | Patch Dest 1 | 29 | 1..127 (with jumps): Predely .. - (26) |
| 7 / 4 | Scale1 | Pch Scale 1 | 30-31 (14 bits) | 0..511: -200% .. 199% (512) |
| 7 / 5 | Offset1 | Offset Pch 1 | 32-33 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 8 / 1 | Src 2 | Patch Src 2 | 34 | 0..127 (with jumps): 0 .. Off (79) |
| 8 / 2 | Thresh2 | Threshold 2 | 35 | 0..127: 0 .. 127 (128) |
| 8 / 3 | Dest 2 | Patch Dest 2 | 36 | 1..127 (with jumps): Predely .. - (26) |
| 8 / 4 | Scale2 | Pch Scale 2 | 37-38 (14 bits) | 0..511: -200% .. 199% (512) |
| 8 / 5 | Offset2 | Offset Pch 2 | 39-40 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 9 / 1 | Src 3 | Patch Src 3 | 41 | 0..127 (with jumps): 0 .. Off (79) |
| 9 / 2 | Thresh3 | Threshold 3 | 42 | 0..127: 0 .. 127 (128) |
| 9 / 3 | Dest 3 | Patch Dest 3 | 43 | 1..127 (with jumps): Predely .. - (26) |
| 9 / 4 | Scale3 | Pch Scale 3 | 44-45 (14 bits) | 0..511: -200% .. 199% (512) |
| 9 / 5 | Offset3 | Offset Pch 3 | 46-47 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 10 / 1 | Src 4 | Patch Src 4 | 48 | 0..127 (with jumps): 0 .. Off (79) |
| 10 / 2 | Thresh4 | Threshold 4 | 49 | 0..127: 0 .. 127 (128) |
| 10 / 3 | Dest 4 | Patch Dest 4 | 50 | 1..127 (with jumps): Predely .. - (26) |
| 10 / 4 | Scale4 | Pch Scale 4 | 51-52 (14 bits) | 0..511: -200% .. 199% (512) |
| 10 / 5 | Offset4 | Offset Pch 4 | 53-54 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |

### 3 Gate

| PAGE / button | Name | Long name | Setup | Values (panel) |
|---|---|---|---|---|
| 1 / 1 | Predely | Pre Delay | 1-2 (14 bits) | 0..8191: 0us .. 262ms (8192) |
| 1 / 2 | PdlyFbk | PreDly Fdbk | 3 | 0..127: - 98% .. 98% (128) |
| 3 / 1 | Slope | Slope | 12 | 0..127: 0 .. 127 (128) |
| 3 / 2 | Treble | Treble Decay | 13 | 0..15: 320Hz .. Full (16) |
| 3 / 4 | Size | Room Size | 15 | 0..31: 8Meter .. 39Meter (32) |
| 3 / 5 | Diffus | Diffusion | 16 | 0..127: 0% .. 100% (128) |
| 4 / 1 | InLevl | Input Level | 24 | 0..127: 0% .. 100% (128) |
| 4 / 2 | Mix | Output Mix | 22 | 0..127: 0% .. 100% (128) |
| 4 / 3 | Wet Pan | Wet Pan | 20 | 0..126: 100%L .. 100%R (127) |
| 4 / 4 | Dry Pan | Dry Pan | 21 | 0..126: 100%L .. 100%R (127) |
| 4 / 5 | OutLevl | Output Level | 23 | 0..127: 0% .. 100% (128) |
| 5 / 1 | LFO Rat | LFO Rate | 25 | 0..127: 0.03Hz .. 4.84Hz (128) |
| 7 / 1 | Src 1 | Patch Src 1 | 27 | 0..127 (with jumps): 0 .. Off (79) |
| 7 / 2 | Thresh1 | Threshold 1 | 28 | 0..127: 0 .. 127 (128) |
| 7 / 3 | Dest 1 | Patch Dest 1 | 29 | 1..127 (with jumps): Predely .. - (26) |
| 7 / 4 | Scale1 | Pch Scale 1 | 30-31 (14 bits) | 0..511: -200% .. 199% (512) |
| 7 / 5 | Offset1 | Offset Pch 1 | 32-33 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 8 / 1 | Src 2 | Patch Src 2 | 34 | 0..127 (with jumps): 0 .. Off (79) |
| 8 / 2 | Thresh2 | Threshold 2 | 35 | 0..127: 0 .. 127 (128) |
| 8 / 3 | Dest 2 | Patch Dest 2 | 36 | 1..127 (with jumps): Predely .. - (26) |
| 8 / 4 | Scale2 | Pch Scale 2 | 37-38 (14 bits) | 0..511: -200% .. 199% (512) |
| 8 / 5 | Offset2 | Offset Pch 2 | 39-40 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 9 / 1 | Src 3 | Patch Src 3 | 41 | 0..127 (with jumps): 0 .. Off (79) |
| 9 / 2 | Thresh3 | Threshold 3 | 42 | 0..127: 0 .. 127 (128) |
| 9 / 3 | Dest 3 | Patch Dest 3 | 43 | 1..127 (with jumps): Predely .. - (26) |
| 9 / 4 | Scale3 | Pch Scale 3 | 44-45 (14 bits) | 0..511: -200% .. 199% (512) |
| 9 / 5 | Offset3 | Offset Pch 3 | 46-47 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 10 / 1 | Src 4 | Patch Src 4 | 48 | 0..127 (with jumps): 0 .. Off (79) |
| 10 / 2 | Thresh4 | Threshold 4 | 49 | 0..127: 0 .. 127 (128) |
| 10 / 3 | Dest 4 | Patch Dest 4 | 50 | 1..127 (with jumps): Predely .. - (26) |
| 10 / 4 | Scale4 | Pch Scale 4 | 51-52 (14 bits) | 0..511: -200% .. 199% (512) |
| 10 / 5 | Offset4 | Offset Pch 4 | 53-54 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |

### 4 Plate

| PAGE / button | Name | Long name | Setup | Values (panel) |
|---|---|---|---|---|
| 1 / 1 | Predely | Pre Delay | 1-2 (14 bits) | 0..8191: 0us .. 262ms (8192) |
| 1 / 2 | PdlyFbk | PreDly Fdbk | 3 | 0..127: - 98% .. 98% (128) |
| 3 / 1 | Decay | Decay Time | 12 | 0..14: 0.6s .. 6.1s (15) |
| 3 / 2 | Treble | Treble Decay | 13 | 0..15: 320Hz .. Full (16) |
| 3 / 3 | BassMpy | Bass Multply | 14 | 0..31: 0.35x .. 2.50x (32) |
| 3 / 4 | Size | Room Size | 15 | 0..79: 8Meter .. 87Meter (80) |
| 3 / 5 | Diffus | Diffusion | 16 | 0..127: 0% .. 100% (128) |
| 4 / 1 | InLevl | Input Level | 24 | 0..127: 0% .. 100% (128) |
| 4 / 2 | Mix | Output Mix | 22 | 0..127: 0% .. 100% (128) |
| 4 / 3 | Wet Pan | Wet Pan | 20 | 0..126: 100%L .. 100%R (127) |
| 4 / 4 | Dry Pan | Dry Pan | 21 | 0..126: 100%L .. 100%R (127) |
| 4 / 5 | OutLevl | Output Level | 23 | 0..127: 0% .. 100% (128) |
| 5 / 1 | LFO Rat | LFO Rate | 25 | 0..127: 0.03Hz .. 4.84Hz (128) |
| 7 / 1 | Src 1 | Patch Src 1 | 27 | 0..127 (with jumps): 0 .. Off (79) |
| 7 / 2 | Thresh1 | Threshold 1 | 28 | 0..127: 0 .. 127 (128) |
| 7 / 3 | Dest 1 | Patch Dest 1 | 29 | 1..127 (with jumps): Predely .. - (26) |
| 7 / 4 | Scale1 | Pch Scale 1 | 30-31 (14 bits) | 0..511: -200% .. 199% (512) |
| 7 / 5 | Offset1 | Offset Pch 1 | 32-33 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 8 / 1 | Src 2 | Patch Src 2 | 34 | 0..127 (with jumps): 0 .. Off (79) |
| 8 / 2 | Thresh2 | Threshold 2 | 35 | 0..127: 0 .. 127 (128) |
| 8 / 3 | Dest 2 | Patch Dest 2 | 36 | 1..127 (with jumps): Predely .. - (26) |
| 8 / 4 | Scale2 | Pch Scale 2 | 37-38 (14 bits) | 0..511: -200% .. 199% (512) |
| 8 / 5 | Offset2 | Offset Pch 2 | 39-40 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 9 / 1 | Src 3 | Patch Src 3 | 41 | 0..127 (with jumps): 0 .. Off (79) |
| 9 / 2 | Thresh3 | Threshold 3 | 42 | 0..127: 0 .. 127 (128) |
| 9 / 3 | Dest 3 | Patch Dest 3 | 43 | 1..127 (with jumps): Predely .. - (26) |
| 9 / 4 | Scale3 | Pch Scale 3 | 44-45 (14 bits) | 0..511: -200% .. 199% (512) |
| 9 / 5 | Offset3 | Offset Pch 3 | 46-47 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 10 / 1 | Src 4 | Patch Src 4 | 48 | 0..127 (with jumps): 0 .. Off (79) |
| 10 / 2 | Thresh4 | Threshold 4 | 49 | 0..127: 0 .. 127 (128) |
| 10 / 3 | Dest 4 | Patch Dest 4 | 50 | 1..127 (with jumps): Predely .. - (26) |
| 10 / 4 | Scale4 | Pch Scale 4 | 51-52 (14 bits) | 0..511: -200% .. 199% (512) |
| 10 / 5 | Offset4 | Offset Pch 4 | 53-54 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |

### 5 ChorDly

| PAGE / button | Name | Long name | Setup | Values (panel) |
|---|---|---|---|---|
| 1 / 1 | Delay 1 | Delay 1 | 1 | 0..97: 0us .. 794ms (98) |
| 1 / 3 | Delay 2 | Delay 2 | 4 | 0..127: 0us .. 1.04s (128) |
| 1 / 4 | Feedbk3 | Feedback 3 | 3 | 0..127: - 98% .. 98% (128) |
| 1 / 5 | Delay 3 | Delay 3 | 7 | 0..127: 0us .. 1.04s (128) |
| 2 / 4 | Treble | Treble Decay | 17 | 0..15: 320Hz .. Full (16) |
| 3 / 5 | Diffus | Diffusion | 16 | 0..127: 0% .. 100% (128) |
| 4 / 1 | InLevl | Input Level | 24 | 0..126: 0% .. 100% (127) |
| 4 / 2 | Mix | Output Mix | 22 | 0..127: 0% .. 100% (128) |
| 4 / 3 | Wet Pan | Wet Pan | 20 | 0..126: 100%L .. 100%R (127) |
| 4 / 4 | Dry Pan | Dry Pan | 21 | 0..126: 100%L .. 100%R (127) |
| 4 / 5 | OutLevl | Output Level | 23 | 0..127: 0% .. 100% (128) |
| 5 / 1 | LFO Rat | LFO Rate | 25 | 0..127: 0.03Hz .. 4.84Hz (128) |
| 5 / 2 | ChorRat | Chorus Rate | 11 | 0..15: 0 .. 15 (16) |
| 7 / 1 | Src 1 | Patch Src 1 | 27 | 0..127 (with jumps): 0 .. Off (79) |
| 7 / 2 | Thresh1 | Threshold 1 | 28 | 0..127: 0 .. 127 (128) |
| 7 / 3 | Dest 1 | Patch Dest 1 | 29 | 1..127 (with jumps): Delay 1 .. - (26) |
| 7 / 4 | Scale1 | Pch Scale 1 | 30-31 (14 bits) | 0..511: -200% .. 199% (512) |
| 7 / 5 | Offset1 | Offset Pch 1 | 32-33 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 8 / 1 | Src 2 | Patch Src 2 | 34 | 0..127 (with jumps): 0 .. Off (79) |
| 8 / 2 | Thresh2 | Threshold 2 | 35 | 0..127: 0 .. 127 (128) |
| 8 / 3 | Dest 2 | Patch Dest 2 | 36 | 1..127 (with jumps): Delay 1 .. - (26) |
| 8 / 4 | Scale2 | Pch Scale 2 | 37-38 (14 bits) | 0..511: -200% .. 199% (512) |
| 8 / 5 | Offset2 | Offset Pch 2 | 39-40 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 9 / 1 | Src 3 | Patch Src 3 | 41 | 0..127 (with jumps): 0 .. Off (79) |
| 9 / 2 | Thresh3 | Threshold 3 | 42 | 0..127: 0 .. 127 (128) |
| 9 / 3 | Dest 3 | Patch Dest 3 | 43 | 1..127 (with jumps): Delay 1 .. - (26) |
| 9 / 4 | Scale3 | Pch Scale 3 | 44-45 (14 bits) | 0..511: -200% .. 199% (512) |
| 9 / 5 | Offset3 | Offset Pch 3 | 46-47 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |
| 10 / 1 | Src 4 | Patch Src 4 | 48 | 0..127 (with jumps): 0 .. Off (79) |
| 10 / 2 | Thresh4 | Threshold 4 | 49 | 0..127: 0 .. 127 (128) |
| 10 / 3 | Dest 4 | Patch Dest 4 | 50 | 1..127 (with jumps): Delay 1 .. - (26) |
| 10 / 4 | Scale4 | Pch Scale 4 | 51-52 (14 bits) | 0..511: -200% .. 199% (512) |
| 10 / 5 | Offset4 | Offset Pch 4 | 53-54 (14 bits, signed) | -8192..8191: -202% .. 201% (16384) |

### Settings pages

| PAGE / button | Name | Setup | Values |
|---|---|---|---|
| 0 / 1 | Preset | 76 | 0..127: Preset 1 .. Preset 128 (128) |
| 0 / 2 | Registr | 75 | 0..127: Register 1 .. Register 128 (128) |
| 0 / 3 | PreScan | 74 | 0..127: Preset 1 .. Preset 128 (128) |
| 0 / 4 | RegScan | 73 | 0..127: Register 1 .. Register 128 (128) |
| 0 / 5 | Load | 127 | 0..127: Preset 1 .. Preset 1 (128) |
| 11 / 1 | MIDIchn (MIDI Channel) | 79 | 0..16: 1 .. Omni |
| 11 / 2 | Contrst (Disp Cntrast) | 69 | 0..15: 0 .. 15 |
| 11 / 3 | Bright (Disp Bright) | 70 | 0..15: 0 .. 15 |
| 11 / 4 | MemProt (Mem Protect) | 82 | 0..1: Off .. On |
| 11 / 5 | Update (Disp Update) | 81 | 0..1: Off .. On |
| 12 / 1 | Param | 86 | 0..127: Parameter Algthm .. Active Setup (128) |
| 12 / 2 | Registr | 87-88 | 0..129: Registr 1 .. Midi Map Table (130) |
| 12 / 5 | Send | 127 | 0..127: Parameter Algthm .. Parameter Algthm (128) |
| 13 / 1 | PgmChg | 96-97 | 0..130: OFF .. Map128 (131) |
| 13 / 2 | MapVal | 94-95 | 0..256: --- .. --- (257) |
| 13 / 3 | Dest | 84 | 0..27: Algthm .. Setup - (28) |
| 13 / 4 | Source | 85 | 0..127: 0 .. Off (79) |
| 13 / 5 | Mode | 80 | 0..2: Off .. Immed (3) |
| 14 / 1 | <<Char | 55 | 32..126:  |
| 14 / 2 | Char>> | 56 | 32..126:  |
| 15 / 1 | Reg # | 91 | 0..127: Register 1 .. Register 128 (128) |
| 15 / 5 | Store | (action) | |
