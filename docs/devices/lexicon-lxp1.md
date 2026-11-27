# Lexicon LXP-1: MIDI implementation from the v1.06 firmware

Source: `Lexicon LXP1 v1.06.zip` (`v1.06 00350d38.bin`, one 32 KB EPROM, Z80 code; it starts "LXP Version 1.06
Copyright 1988 Lexicon, Inc."). Work copy: `re/fx/lexicon-lxp1/fw/lxp1_v106.bin`; listing
`re/fx/lexicon-lxp1/lxp1.lst` from `tools/lexicon/lxp_dis.py` (it follows the stackless `LD IX/IY,return / JP`
calls, the MIDI state machine's next-state pointers and the C compiler's switch tables):

    python -I tools/lexicon/lxp_dis.py re/fx/lexicon-lxp1/fw/lxp1_v106.bin re/fx/lexicon-lxp1/lxp1.lst hv:dbed hv:dbeb hv:d89b hv:dc81 tab:2583:16 tab:233a:8 cs:7daf

**The LXP-1 has no display.** Its parameters are edited with the Lexicon MRC (MIDI Remote Controller), whose
firmware holds the LXP-1's algorithm names, page labels, the fader steps and the display routine of every
parameter. The names and value texts of the editor are the MRC's screens: `Lexicon MRC v4.00.zip` (U102 27C512,
U103 / U104 2764; work copies in `re/fx/lexicon-mrc/`, listing `mrcA.lst`). The bytes, messages and the
conversions are the LXP-1's own.

The tables (`js/devices/defs/lexicon-lxp1-fw.js`) and the test vectors (`tests/lexicon-lxp1.vectors.json`) come
from `tools/lexicon/lxp1_fw.py` (about one minute):

    python -I tools/lexicon/lxp1_fw.py re/fx/lexicon-lxp1/fw/lxp1_v106.bin re/fx/lexicon-mrc js/devices/defs/lexicon-lxp1-fw.js --vectors tests/lexicon-lxp1.vectors.json

It runs the MRC's display routines in the Z80 emulator (`tools/art/z80.py`, memory model
`tools/lexicon/mrc_board.py`) for every step of every parameter, the MRC's patch page (067Bh) for every Src,
Dest and Scale value, and the LXP-1 firmware itself (`tools/lexicon/lxp1_board.py`, started at 017Eh after the
power-up tests, which need the DSP) for the vectors: its answers to every request and what its receiver did
with dumps, parameter messages, store, load and a program change.

**Not checked on hardware** (no LXP-1 or MRC is connected).

## Hardware as the firmware uses it

- 0000-7FFF the EPROM, C000-DFFF RAM (C000-D87F the 128 registers of 49 bytes, DAA2 the active setup, D883
  the MIDI channel, D884 the register number), E000-E3FF the DSP host window.
- MIDI: an 8251 UART, 00 data, 01 status / command (mode 4Eh). Interrupt mode 1 through D89Bh (a timer; the
  receiver 223F runs from it). Receiver: a state machine (next state in DBEDh), 2254 / 2264 (Omni).
- Panel: three 16-position switches (port 80h both nibbles, C0h low nibble, gray code table 580Eh) and a
  button (C0h bit 4). Holding the button at power-up starts the diagnostics.

## The setup

A register, the setup dump and a register dump hold 49 bytes:

| Bytes | Meaning |
|---|---|
| 0 | algorithm: 1 REVERB, 2 PLATE, 3 CHORUS 1, 4 DELAY 2, 5 CHORUS 2, 6 INVERSE, 7 GATE, 8 DELAY 1 |
| 1-20 | ten 16-bit words, low byte first (parameters 0-9); each algorithm reads them its own way |
| 21-36 | the name, 16 bytes (parameters 20h-2Fh; the MRC writes 8 characters) |
| 37-40 | patch Src 1-4 (30h-33h): 00h-1Fh controllers 0-31, 20h-3Fh controllers 64-95, 40h NOTE, 41h VEL, 42h AFTCH, 43h PBEND, 44h TEMPO, 7Fh NONE |
| 41-44 | patch Dest 1-4 (34h-37h): the word moved (0-10), 7Fh NONE |
| 45-48 | patch Scale 1-4 (38h-3Bh): signed, 7Fh +200%, 80h -200% |

The active setup in RAM has an eleventh word (parameter 10, after word 9) and eight work bytes; dumps leave
them out. The 16 ROM presets (programs 128-143, 3380h, 59 bytes each in the active setup form) are reached
only from the panel; preset 2 is named "DUMB HALL", the others have no name.

### The MRC pages

Each algorithm has two MRC pages of four faders (the MRC's LXP-1 module: algorithms at 0060h, page records
with a 24-character label line and parameter records of 8 bytes: MRC slot, steps, send routine, LXP-1 word,
display routine, its argument). A fader step v (0 to steps - 1) is sent as a word:

- send routine 10A0h: 8000h + v x (4000h / steps); with 255 steps 8000h + v' x 40h
- send routine 1112h (bipolar: BASS, FDBK, RESON, TUNE...): 4000h + v x (8000h / steps); with 255 steps 4000h + v' x 80h
- v' = v + 1 above 79h (one step is left out).

The editor offers every step with the MRC's text for it (the display routine run for that step) and writes
the word the MRC would send. A word between steps (the ROM presets keep FXLVL at BFFEh / BFFFh and BASS at
8C00h) is shown with the text of the step below it and the word itself; the Words (exact) table shows all ten
words as numbers. Words the pages leave out are named from the MRC's patch Dest list where it names them
(CHORUS 1 word 0 "-FDBK", DELAY 2 word 0 "+FDBK"); the others have no name on any screen.

| Algorithm | Page 1 | Page 2 |
|---|---|---|
| REVERB, PLATE | RTIME (w0, 16), SIZE (w5, 64), HICUT (w4, 16), FXLVL (w2, 255) | BASS (w3, 16, bipolar), PDLY (w1, 255), FDBK (w6, 255, bipolar), DIFF (w7, 255) |
| CHORUS 1 | RATE (w8, 16), DEPTH (w1, 255), SHAPE (w5, 8), FXLVL (w2) | L-DLY (w7, 128), LFDBK (w6), R-DLY (w4, 128), RFDBK (w3) |
| CHORUS 2 | TUNE (w9, 128, bipolar), RESON (w6, 64, bipolar), LOCUT (w4, 255), FXLVL (w2) | SLOPE (w8, 32), PDLY (w3), RICH (w7, 16), SHIMR (w5, 16) |
| DELAY 1 | RATE (w8, 16), DELAY (w1, 255), HICUT (w3, 16), FXLVL (w2) | DLY-2 (w4, 128), DLY-3 (w5, 128), FDBK3 (w6), DIFF (w7) |
| DELAY 2 | GPDLY (w1, 255), FDBK (w3), HICUT (w7, 16), FXLVL (w2) | L-DLY (w4, 255), R-DLY (w5, 255), DIFF (w8) |
| INVERSE | SLOPE (w5, 32), SIZE (w0, 32), HICUT (w4, 16), FXLVL (w2) | FDBK (w6), PDLY (w8), DIFF (w7) |
| GATE | SLOPE (w5, 16), TIME (w0, 32), HICUT (w4, 16), FXLVL (w2) | FDBK (w6), PDLY (w8), DIFF (w7) |

The MRC writes its texts in six columns (for example "1.02m" is 1.02 ms cut to the column, HICUT is in kHz);
the editor keeps them as the MRC shows them.

## SysEx

`F0 06 02 <function, n> ... F7`: Lexicon (06), LXP-1 (02); n is the MIDI channel the unit listens on (set on
its panel; with Omni any). Dumps are sent in groups of eight bytes: one holding bit 7 of the next seven (bit 0
first), then the seven. The count byte is the number of bytes sent (38h = 56 = 49 data bytes); cs is the sum
of the sent bytes (high-bit bytes included) AND 7Fh. A dump with a wrong checksum is ignored.

| Message | Meaning |
|---|---|
| `0n 38 <56> cs` | active setup (sent on request; taken: the unit loads it) |
| `1n rr 38 <56> cs` | register rr (0-127) |
| `4n 38 00 <7168> cs` | all 128 registers (6272 bytes) |
| `5n pp a b c d` | parameter pp = abcd (four nibbles; what the MRC sends) |
| `2n pp hb lo hi` | parameter pp, 16 bits as one group (what the unit answers to 3n 62) |
| `3n 60` / `61 rr` / `62 pp` / `65 pp` / `64` | requests: active setup, register, parameter (2n or 5n answer), all registers |
| `6n 70 rr` | store the active setup into register rr |
| `6n 71 rr` | load register rr (a program change does the same) |

Parameters (setter 0C09, system part 0DDC): 0-9 the words (10 is the eleventh word, special-cased at 0328),
20h-2Fh the name, 30h-3Bh the patches, 41h the algorithm (the unit changes it and keeps every other byte),
40h the register number. **40h loads register 64 whatever value it carries**: the event handler (034C) passes
the parameter number as the value, so the editor never sends it and loads registers with 6n 71.

Channel messages: program change loads a register (while the panel is in its store mode, DD01h, it stores the active setup into that register instead: 0287); controllers 0-31 and 64-95, note number and velocity,
channel pressure and pitch bend are kept as patch sources (2583 table); FF resets the MIDI state.

## The editor

- Active setup: the algorithm (MRC algorithm page order), the two MRC pages of the selected algorithm with
  every fader step and its MRC text, the four patches (Src, Dest with the algorithm's Dest names, Scale), the
  ten words as exact numbers, the name (Rename: 16 characters; the MRC shows 8). Each change is sent as 5n
  pp + four nibbles. Get requests the active setup (3n 60); Send to the active setup sends it as a setup dump
  (0n); Store into register sends it and stores it (6n 70).
- Registers 1-128 (Edit: 3n 61; Store: 1n register dump; Play: 6n 71) and the 16 ROM presets (Edit from the
  firmware; Play sends one as a setup dump).
- Library: setup, register and all-register dumps (split into 128 registers).
- Translator (Head Library): REVERB / PLATE / INVERSE / GATE as a reverb, DELAY 1 / 2 as a delay, CHORUS 1 / 2
  as a chorus, each value as a fraction of the MRC steps; exact bytes in extra.

## Open

- A hardware check.
- The MIDI channel and Omni are set on the panel only; no message reads or sets them.
- The MRC's own ten LXP-1 setups (Big Hall, SmalHall, ...; U102 0526h, 29 bytes: name, algorithm index, eight
  fader steps, the patches) are not offered: they are MRC memories, not the unit's.
