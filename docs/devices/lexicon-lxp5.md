# Lexicon LXP-5: MIDI implementation from the v1.12 firmware

Source: `lexicon_lxp-5.zip` (`lexicon_lxp5_v1-12.bin`, one 27C256, Z80 code; it starts "LXP5 Version 1.12
Copyright 1989 Lexicon, Inc."). Work copy: `re/fx/lexicon-lxp5/fw/lxp5_v112.bin`; listing `re/fx/lexicon-lxp5/lxp5.lst`:

    python -I tools/lexicon/lxp_dis.py re/fx/lexicon-lxp5/fw/lxp5_v112.bin re/fx/lexicon-lxp5/lxp5.lst hv:a6d5 hv:a5f4 hv:a05f tab:2b05:8 tab:2c80:8 cs:7e45

**The LXP-5 shows only a program number.** Its parameters are edited with the Lexicon MRC (MIDI Remote
Controller), whose firmware (`Lexicon MRC v4.00.zip`, copies in `re/fx/lexicon-mrc/`) holds the LXP-5 module:
the algorithm names, page labels, parameter records and display routines. The names and value texts of the
editor are the MRC's screens; the bytes and messages are the LXP-5's own. See `docs/devices/lexicon-lxp1.md`
for the MRC (memory model `tools/lexicon/mrc_board.py`).

The tables (`js/devices/defs/lexicon-lxp5-fw.js`) and the test vectors (`tests/lexicon-lxp5.vectors.json`) come
from `tools/lexicon/lxp5_fw.py` (about ten minutes; `--cache DIR` keeps the pair tables):

    python -I tools/lexicon/lxp5_fw.py re/fx/lexicon-lxp5/fw/lxp5_v112.bin re/fx/lexicon-mrc js/devices/defs/lexicon-lxp5-fw.js --cache re/fx/lexicon-lxp5/cache --vectors tests/lexicon-lxp5.vectors.json

The MRC's display routines read the values from its setup record (CC20h, values at +9 + slot), so the generator
stores each value there before running the routine. The delay routines read a coarse value and its FINE
together, so each coarse / FINE pair gets a text for every pair of values (run-length coded in the table). The
patch page texts come from the module's page routine (2143h) run for every Src, Thrsh, Dest and Scale value.
The vectors come from the LXP-5 firmware in the Z80 emulator (`tools/lexicon/lxp1_board.py` with its 8251 at
80h, started at 0239h after the power-up tests).

**Not checked on hardware** (no LXP-5 or MRC is connected).

## Hardware as the firmware uses it

- 0000-7FFF the EPROM, A000-FFFF RAM: A971h the active setup (94 bytes), AA51h the 128 registers of 57 bytes,
  A6xx the MIDI receiver state; stack below A263h.
- MIDI: an 8251 UART at 80h data / 81h status. Interrupt mode 1 through A05Fh. Receiver 2A2F, a state machine
  (next state in A6D5h).
- The 65 ROM presets are programs 128-192 (3AA5h, register form); program C1h copies the setup kept at AA10h
  back (03AE).

## The active setup and the registers

| Setup bytes | Parameters | Meaning |
|---|---|---|
| 0 | (42h) | algorithm: 1 DLY/RVB, 2 PTCH/DLY, 3 BYPASS (the last ROM preset; not on the MRC) |
| 1-23 | 0-22 | the algorithm's parameters (MRC slots 0-7 = parameters 0-7, slots 8-21 = parameters 9-22) |
| 24-31 | 17h-1Eh | values the unit works out (writing SIZE sets some of them) |
| 32-44 | 1Fh-2Bh | name: 11 characters, 0, one more byte (no screen names it; every preset keeps a value there) |
| 45-64 | 2Ch-3Fh | four patches of five bytes: Src, Thrsh, Dest, Scale, a byte the unit works out from Scale |
| 65 | 40h | the program loaded (writing it loads that register) |
| 66, 68-70 | 41h, 43h-45h | no screen names them |
| 67 | 42h | the algorithm (writing it sets byte 0 too) |
| 71-93 | 46h-5Ch | for each of parameters 0-22, a MIDI source that moves it directly (7Fh none; read at 3009) |

Parameter p is setup byte p + 1; every value is 7 bits. A register (and a ROM preset) is 57 bytes: byte 0, bytes
1-23, the name block, the patches.

### The MRC pages

| Algorithm | Pages |
|---|---|
| DLY/RVB | DELAY / FINE (0-1, a pair), FDBK (2); HICUT (16), LOCUT (17), LFO-RATE (22); RLVL (18), RTIME (11), SIZE (14), DIFF (15); PREDLY / FINE (3-4, a pair), TDECAY (12), BASS (13); PAN (19), INPUT (21), OUTPUT (20). Pages "PITCH N/A THIS ALGO" and "STEREO DLY N/A THIS ALGO" are empty |
| PTCH/DLY | MDELAY / FINE (0-1), MFDBK (2); PITCH (8-9), FINE (10), DLY2 (3, read with 4), LFDBK (5); HICUT, LOCUT, LFO-RATE; DELAY2 / FINE (3-4), DELAY3 / FINE (6-7); RLVL, RTIME, SIZE, DIFF; TDECAY, BASS; PAN, INPUT, OUTPUT |

- PITCH (send routine 43D5h): the MRC sends step 0 as parameter 8 = 0 (OFF), any other step v as parameter
  8 = 1 then parameter 9 = v - 1 (the interval: -2oct ... unison ... +1oct).
- The other pages send the fader step as the byte (43ABh: 2n pp v).
- Patch pages: Src 0-71 (controllers 0-31 and 64-95, NOTE, VEL, AFTCH, PBEND, TEMPO, KNOB, LFO; 71 shows "CTRL:3", the top of the fader; 7Fh NONE),
  Thrsh 0-127, Dest 0-27 (the algorithm's parameter names; the MRC sends its Dest 23-26 as 2Fh, 34h, 39h, 3Eh,
  the Scale parameters of patches 1-4: BBBDh), Scale 0-127.
- The name pages write 8 characters (the unit keeps 11).

## SysEx

`F0 06 05 <function, n> ... F7`: Lexicon (06), LXP-5 (05); n is the MIDI channel. Data bytes are 7-bit; cs is
their sum AND 7Fh.

| Message | Meaning |
|---|---|
| `0n 5E <94> cs` | active setup (sent on request; taken) |
| `1n rr 39 <57> cs` | register rr |
| `4n 39 00 <7296> cs` | all 128 registers |
| `2n pp vv` | parameter pp = vv |
| `3n 60` / `61 rr` / `62 pp` / `64` | requests: active setup, register, parameter, all registers |
| `6n 70 rr` / `6n 71 rr` | store the active setup into register rr / load register rr |

A program change loads a register.

## The editor

- Active setup (register form): the algorithm, the MRC pages of the selected algorithm with the text of every
  value (pairs with the text for the value of the other half), PITCH as the MRC shows it (OFF or the interval),
  the four patches, parameters 0-22 and the other bytes as exact numbers, the name (Rename). Each change is sent
  as 2n pp vv; Send to the active setup sends every parameter (algorithm first); Store into register sends
  them and 6n 70.
- Settings: setup bytes 65-93 (the program and algorithm shown, the MIDI source of each parameter editable).
- Registers 1-128 (Edit 3n 61, Store as 1n, Play 6n 71) and the 65 ROM presets (Edit from the firmware; Play
  sends one as parameter messages).
- Translator (Head Library): delay, reverb and pitch as fractions of the MRC steps; exact bytes in extra.

## Open

- A hardware check.
- Parameters 41h and 43h-45h and the byte after the name: no screen names them.
- The MRC's own LXP-5 setups (its module's ROM memories) are not offered.
