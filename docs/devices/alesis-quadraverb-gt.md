# Alesis Quadraverb GT: MIDI implementation from the v1.03 firmware

Source: `Alesis_QuadraVerb_GT_Firmware_v1.03.zip` and `alesis_quadraverb_plus_gt.zip`
(`alesis_quadraverb-gt_v103.bin`, 64 KB EPROM, "QUADRAVERB  GT"; v1.00 is in the collection too). The
dump has the low address lines reversed like the other Quadraverbs (`tools/alesis/qv_unscramble.py`;
the zip's `_usemapped` file is the same CPU image). Work copies: `re/fx/alesis-quadraverb-gt/`
(CPU image, Ghidra project `gh/`, listing `qvgt103.lst`). Editor:
`js/devices/defs/alesis-quadraverb-gt.js` on the family module `alesis-quadraverb-common.js`; tables
(`alesis-quadraverb-gt-fw.js`) from the same generator as the Quadraverb and the Plus:

    python -I tools/alesis/quadraverb_fw.py "<v1.03 dump .bin>" > js/devices/defs/alesis-quadraverb-gt-fw.js

**Not checked on hardware** (no Quadraverb GT is connected); the tests use the definition's simulator.
The GT runs the Quadraverb Plus software (eight configurations, multi-tap delay, ring modulator,
resonator, sampling; `alesis-quadraverb-plus.md`) with a guitar preamp in front. Everything in
`alesis-quadraverb.md` about the page engine, descriptors and value texts holds; this file lists what
the GT changes. Addresses are in the v1.03 CPU image; the generator finds them from code patterns.

## SysEx

| Message | Bytes | Notes |
|---|---|---|
| Header | `F0 00 00 0E 07 <op> ... F7` | Receiver B78D; no channel byte; SYSEX ENABLE must be ON |
| Page edit | `01 <function> <page> <b1> <b2> <b3>` | As the Quadraverb (value = lo `b1<<1 \| b2>>6`, hi `(b2&3Fh)<<2 \| b3>>5`); functions 0-10, function 10 is the preamp |
| Program data | `02 <n> <147 bytes>` | n 0-99 memory (CE00 + 80h n), 100 edit buffer, 101 all 100 programs (each packed on its own) |
| Request | `03 <n>` | Answered with `02 <n>` (BB64); the edit buffer is packed first (1476) |
| DSP registers | `04 ...` | Factory tool, not offered |
| Quadraverb program | `F0 00 00 0E 02 02 <n> <147 bytes> F7` | The GT takes a Quadraverb / Plus program and converts it (flag 8668, B92D): bytes 7C, 7D = 0, 7E = 1 (NOISE GATE OFF), 7F = 99 (PREAMP OUT LEVEL); if byte 45 bit 0 is clear (direct signal PRE-EQ) byte 45 becomes the old byte 46 shifted left (DIRECT LEVEL) and byte 46 is cleared, else byte 45 = 1. The editor's translator does the same for Quadraverb programs (`fromQuadraverb`) |

The program is the Quadraverb's 128 bytes sent as one MSB-first bit stream in 7-bit bytes (147).

## What the GT changes

- Function 9 holds the name (pages 0-13, 836A + page) and the eight MOD slots (pages 14-37); function 10
  is the preamp: COMPRESSION, OVERDRIVE, DISTORTION, PREAMP TONE, BASS BOOST, CAB SIMULATOR PROGRAM,
  CAB SIMULATOR, EFFECT LOOP, NOISE GATE, PREAMP OUT LEVEL (SAMPLING has no PREAMP OUT LEVEL page).
- Work bytes. The preamp and some new pages edit bytes 83A8h-83C9h outside the 128-byte program. The
  pack routine 1476 (store, dump) puts them in program bits and 13DB (recall, edit-buffer load) takes
  them out again, leaving the host bytes with their own low bits. The generator finds the map by running
  1476 in the emulator one bit at a time (`PACK`):

  | Work byte | Page | Program bits |
  |---|---|---|
  | A8 | COMPRESSION (OFF, 01-07) | 7C bits 6-4 |
  | A9 | DISTORTION (OFF, 01-08) | 7C bits 3-0 |
  | AF | EQ MODE | 7C bit 7 |
  | AA | PREAMP TONE (FLAT, PRESENCE, BRIGHT) | 7D bits 3-2 |
  | AB | BASS BOOST | 7D bit 4 |
  | AC | CAB SIMULATOR (OFF, CABINET 1, CABINET 2) | 7D bits 1-0 |
  | B0 | EFFECT LOOP (OUT, IN) | 7D bit 5 |
  | C6 | MODULATION (mix page: OFF, TREMOLO, PANNING) | 7D bits 7-6 |
  | AD | OVERDRIVE (OFF, 01-07) | 7E bits 7-5 |
  | AE | NOISE GATE (AUTO, OFF, 01-16) | 7E bits 4-0 |
  | B1 | DIRECT LEVEL (mix) | 45 bits 7-1 (bit 0: PREAMP SIGNAL PRE-EQ / POST-EQ) |
  | B2 | EQ PRESET (USER, 01-06) | 1C bits 7-1 (bit 0: LFO WAVESHAPE) |
  | C8 | RESONATOR 4 AMP (5 resonators) | 1B bits 7-1 (bit 0: PITCH INPUT) |
  | C9 | RESONATOR 5 AMP | 28 bits 7-1 (bit 0: DELAY INPUT) |

  PREAMP OUT LEVEL is program byte 7F. Every program byte is on some page (no spare bytes).
- EQ MODE (work byte AF) picks the EQ page list (variant writer 7983): EQ→PCH→DL→REVERB "3 BAND EQ" or
  "RESONATORS + EQ" (two resonators on bytes 00-03, 09, 0A and the mid EQ), 5BAND EQ→PCH→DLY "5 BAND EQ"
  or "5 RESONATOR/3 EQ": RESONATOR NUMB (69) and the indexed pages FDh-FFh (resolver 677A, tables 682D:
  TUNE 0E-16, DCY 0F-17, AMP 4A, 78, 79, C8, C9). The editor shows the five resonators as their own
  fields; a change sends RESONATOR NUMB and then the value.
- Changing EQ MODE loads that mode's EQ defaults (9E98) and EQ PRESET 1-6 copies a preset EQ (CF94, tables
  D064 / D0B8 / D148 / D196 per configuration, the first byte's bit 0 setting EQ MODE; in 5BAND EQ the five
  resonator amplitudes go to 99). The generator runs both routines in the emulator for every
  configuration and value (`EFFECTS`); the editor makes the same writes and sends the whole program. EQ
  PRESET USER restores the copy of the EQ the unit makes at recall (8298, D021), which the editor cannot
  see: it keeps the values it has.
- CAB SIMULATOR PROGRAM (preamp page 6) is a setting at 8590 (PROGRAM / GLOBAL), not program data; while
  it is GLOBAL the CAB SIMULATOR page reads and edits 8591 (shown "OFF       GLOBAL", "CABINET 1 GLOBAL"...)
  instead of the program's value. The editor's MIDI page tab has both (send only, like the MIDI page).
- MOD TARGET groups: 0 reverb, 1 delay, 2 pitch, 3 EQ (by EQ MODE), 4 mix, 5-6 the delay's (1711); group 7
  would be the preamp but MOD TARGET stops at 111.
- Factory programs: 90 at D2FE. Four hold values outside their pages' ranges and are sent as they are
  (the receiver stores dumps unchecked): 5 and 72 MODULATION SPEED 99 (page 0-98), 62 LOW EQ FREQUENCY
  12488 (bytes 30 C8), 68 MOD 1 SOURCE 132 (page 0-125).

## Head Library

Family `alesis-quadraverb-gt` (exact). Effects as the Quadraverb's (reverb, delay, modulation, chorus)
plus `effects.distortion` {type OVERDRIVE / DISTORTION, drive, level} when the preamp drives. Quadraverb and
Quadraverb Plus programs load converted as the GT converts them (above); other sources go through the
effects.

## Open

- A hardware check (preamp packing, global cab simulator, EQ MODE / PRESET writes, the 02-header load).
- v1.00 not compared.
- With EQ MODE 5 RESONATOR/3 EQ and the multi-tap delay in the same program, RESONATOR 1 AMP (4A) is also a
  tap storage byte (TAP_MAP): the firmware's own overlap, not handled.
