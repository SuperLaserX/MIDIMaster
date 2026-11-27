# Alesis Quadraverb: MIDI implementation from the v1.07 firmware

Source: `Alesis_QuadraVerb_Firmware_v1.07.zip` (64 KB EPROM dump, 8031 code, "(C) 1989 ALESIS
CORPORATION", software by Fast Forward Designs). The v1.03 dump (`Alesis_QuadraVerb_Firmware_v1.03.zip`)
is wired the same way. Editor: `js/devices/defs/alesis-quadraverb.js`; tables
(`alesis-quadraverb-fw.js`) from `tools/alesis/quadraverb_fw.py`:

    python -I tools/alesis/quadraverb_fw.py "<EPROM dump .bin>" > js/devices/defs/alesis-quadraverb-fw.js
    python -I tools/alesis/quadraverb_fw.py "<EPROM dump .bin>" --report     (page lists and descriptors)

**Not checked on hardware** (no Quadraverb is connected); the tests use the definition's simulator.

## Reading the dump

The board wires the EPROM's low address lines in reverse: CPU A0-A7 go to EPROM A7-A0 (A8-A15 and the
data lines are straight). `tools/alesis/qv_unscramble.py` puts a dump into CPU order; the permutation was
found by hill-climbing over address-bit permutations with an LCD-word score (the text then reads
"***  ALESIS  ***** QUADRAVERB **" at 1100h and the reset vector lands on code). The Quadraverb Plus
(v2.02) and Quadraverb GT (v1.03) dumps unscramble the same way. Work files: `re/fx/alesis-quadraverb/`
(dumps in `fw/`, CPU-order images in `cpu/`, Ghidra project in `gh/`, listing `qv107.lst`).
All addresses below are in the v1.07 CPU image.

## The page system (where every value comes from)

The front panel has eleven functions (the firmware's own numbering, used by SysEx): 0 program select,
1 reverb, 2 delay, 3 pitch (Lezlie in LEZLIE→DL→REVERB, REVERB CHORUS in 3 BAND EQ→REVERB), 4 EQ
(graphic EQ bands, HIGH ROTOR LEVEL), 5 MIDI, 6 store / recall, 7 configuration, 8 mix, 9 modulation,
10 name. The firmware has no names for the buttons; the editor's card names are these.

- Page tree at 3174 (walked by 308B): [configuration, 8392h] → [function, 838Eh] → [variant,
  8383h + function] → page list (count - 1, then page stubs; bit 7 set: NOT USED IN THIS
  CONFIGURATION). The variant of a function is a program byte the firmware copies to 8383h + f: reverb
  type (32h, 78A7) for reverb, delay type (27h, 6EDD) for delay, pitch mode / REVERB CHORUS (1Ah, 74AD)
  for pitch, direct signal select (45h, 6BA6) for mix. So the pages depend on configuration and type: a
  REVERSE reverb has no gate pages and calls byte 39h REVERB REVERSE TIME, a stereo delay has LEFT /
  RIGHT pages, and so on.
- Page stub: `MOV 73h,#lo / MOV 72h,#hi / LJMP 359C` → engine 5A96: a 16-byte descriptor at hi:lo,
  then the 32-character screen, then (for lists) 16 characters per value. Descriptor: +0 byte
  (edit buffer 8300h + n; function 5 uses the MIDI settings at 8500h), +1 LCD position of the value,
  +2 characters per step (16 = list), +3 flags, +4 offset added for the display, +6 minimum, +8 maximum
  (a value is two bytes, big-endian, when the maximum is above 255), +10 initial value, +12 display
  routine, +14 the routine that sends the value to the DSP.
- Every value text in the editor is what the page shows: the generator runs each page in the 8051
  emulator (`tools/alesis/i8051.py`) for every value and reads the screen buffer 83E0-83FF (LCD codes
  7Eh / 7Fh are the arrows → / ←). Long numeric ranges (MID / HI EQ FREQUENCY) are stored as a checked
  formula (zero-padded decimal + "Hz").
- MOD TARGET (display 14A7 → 14BC): value = group × 16 + item; groups are reverb, delay, pitch, EQ, mix
  (14C5), and the names come from the target lists at 1681 [configuration][group][variant] (names at
  184C). The editor lists the targets of the program's own configuration and types.
- The graphic EQ page (9DBC) draws all eleven bands as bars of custom characters, without a number: the
  editor shows a band as value - 14 (the descriptor's display offset), i.e. -14 to +14.

## Program (128 bytes)

| Bytes | Meaning (LCD label) |
|---|---|
| 00-0C | EQ: LOW EQ FREQUENCY (00-01, 20-999 Hz), LOW EQ AMPLITUDE (02-03, -14.00 to +14.00 dB in 0.05 dB), MID EQ FREQUENCY (04-05, 200-9999 Hz), MID EQ BANDWIDTH (06, 0.20-2.55 octaves), MID EQ AMPLITUDE (07-08), HI EQ FREQUENCY (09-0A, 2000-18000 Hz), HI EQ AMPLITUDE (0B-0C). GRAPHIC EQ→DELAY: 01-0B are the eleven bands 16 Hz-16 kHz (00 and 0C unused there) |
| 0D | HIGH ROTOR LEVEL (Lezlie, -20 to +06 dB) |
| 0E-17 | 5BAND EQ: LOW MID EQ FREQ (0E-0F), WIDTH (10), AMP (11-12), HIGH MID EQ FREQ (13-14), WDTH (15), AMP (16-17) |
| 1A-21, 25 | Pitch: PITCH MODE (mono / stereo chorus, mono / stereo flange, pitch detune, phase shifter) or REVERB CHORUS (3 BAND EQ→REVERB), PITCH INPUT, LFO WAVESHAPE, LFO / PHASER SPEED (1D), LFO / PHASER DEPTH (1E), PITCH FEEDBACK (20), DETUNE AMOUNT (21), TRIGGER FLANGE (25) |
| 22-24 | LEZLIE STEREO SEPARATION, MOTOR CONTROL, SPEED |
| 27-2F | Delay: DELAY TYPE (mono, stereo, ping pong), DELAY INPUT, DELAY INPUT MIX, DELAY TIME / LEFT DELAY TIME (2A-2B: 1-800 ms mono, 1-400 ms stereo and ping pong in the reverb configurations; 1500 / 750 / 750 in GRAPHIC EQ→DELAY and 5BAND EQ→PCH→DLY), FEEDBACK (2C), RIGHT DELAY TIME (2D-2E), RIGHT FEEDBACK (2F) |
| 32-41 | Reverb: REVERB TYPE (plate, room, chamber, hall, reverse), INPUT 1 / INPUT, INPUT 2, INPUT MIX, PREDELAY (1-140 ms), PREDELAY MIX, DECAY / REVERSE TIME, DIFFUSION, LOW / HIGH FREQUENCY DECAY, DENSITY, GATE, GATE HOLD TIME, GATE RELEASE TIME, GATED LEVEL |
| 44 | CONFIGURATION (EQ→PCH→DL→REVERB, LEZLIE→DL→REVERB, GRAPHIC EQ→DELAY, 5BAND EQ→PCH→DLY, 3 BAND EQ→REVERB) |
| 45-4A | Mix: DIRECT SIGNAL SELECT, DIRECT SIGNAL / EQ OUTPUT LEVEL, MASTER EFFECTS LEVEL, PITCH / LEZLIE OUTPUT LEVEL, DELAY OUTPUT LEVEL, REVERB OUTPUT LEVEL |
| 50-67 | MOD 1-8: SOURCE (pitch bend, aftertouch, note number, velocity, controller 000-121), TARGET, AMPLITUDE (-99 to +99) |
| 6A-77 | Name, 14 characters (EDIT NAME pages) |
| 18, 19, 1F, 26, 30, 31, 33, 42, 43, 4B-4F, 68, 69, 78-7F | On no page, read by no routine (no `MOV DPTR,#83xx` reaches them) and 0 in all 90 factory programs: the editor keeps them as they are (Spare bytes card) |

Memory: 100 programs at CE00h + 80h × n (XRAM, recalled by 1269), edit buffer 8300h. The 90 Alesis
programs are in the EPROM at D2FE + 80h × n (RECALL ALESIS PROG / RECALL ALL copy them with 5EE4); the
editor offers them as the Preset bank (Play sends one to the edit buffer).

## SysEx

`F0 00 00 0E 02 <op> ... F7`, receiver A44B; no channel byte. Nothing is received or sent while the MIDI
page's SYSEX ENABLE is OFF (bit 2C.1).

| Op | Message | Handling |
|---|---|---|
| 01 | `<function> <page> <b1> <b2> <b3>` | A611: the page of the current configuration and variant; value lo = b1<<1 \| b2>>6, hi = (b2 & 3Fh)<<2 \| b3>>5 (a single bit stream, low byte first). 16-bit pages (maximum above 255) take both bytes (5A39), the others the low byte (5990); the value is limited to the page's range, stored, sent to the DSP and the LCD shows the page. Function 0 page 0 recalls a program; function 5 writes the MIDI settings. The Quadraverb sends the same message when a value is edited on its panel (A73D) |
| 02 | `<n> <data>` | A54C: n 0-99 = memory program, 100 = edit buffer (reloaded at once, 8E3A), 101 = all 100 programs. Data: each 128-byte program as one MSB-first bit stream cut into 7-bit bytes (147 bytes; the all-data message packs every program on its own: 14,700 bytes) |
| 03 | `<n>` | A540 → A7C9: answered with 02 `<n>` (same numbering) |
| 04 | `<n> <pairs>` | A502: writes DSP registers 4n up to 181h (each byte from two MIDI bytes). A factory tool: the editor does not send it |

The editor sends each change as opcode 01 for the page the Quadraverb shows it on in the program's
configuration; the configuration, the name and the spare bytes send the whole program (opcode 02,
program 100). Reading uses opcode 03 (one program at a time, or 101 for the bank scan).

## MIDI page (function 5)

8500 MIDI CHANNEL (00-15 = 01-16, 16 = OMNI), 8501 MIDI PROGRAM CHANGE (OFF / ON / TABLE), 8502 /
8503 PROGRAM TABLE entry and value (the table is at 850A + n, 128 entries; 6A81 / 6AC2), 8504 MIDI
THRU, 8505 SYSEX ENABLE, 8506 / 8507 SEND MIDI PROG range (the dump is started from the panel),
8508 / 8509 FOOTSWITCH RANGE. No message reads them, so the editor's MIDI page is send-only (opcode 01,
function 5; a table entry is two messages: select the entry, then set its program).

## Code layout

The editor is built by `makeQuadraverb()` in `js/devices/defs/alesis-quadraverb-common.js` from a model's
generated tables; `alesis-quadraverb.js` (v1.07) and `alesis-quadraverb-plus.js` (v2.03, see
`alesis-quadraverb-plus.md`) are thin wrappers. The generator finds every table and variable from code
patterns, so it reads both versions.

## Open

- A hardware check of everything above.
- Quadraverb GT (model byte 07): done on the same code, `alesis-quadraverb-gt.md` (it also loads
  Quadraverb programs sent with this header, converting them). The Quadraverb 2 is a different design.
