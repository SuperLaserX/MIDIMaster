# Alesis Quadraverb 2: MIDI implementation from the v2.01e firmware

Source: `Alesis_QV2_v2.01e_D9AB.zip` (one 128 KB EPROM image, 8031 code; the power-up banner reads
"ALESIS  QUADRAVERB 2", the credits at hi DDB1 name Michel Doidic, Curtis Senffner, Michael Mecca and Marcus
Ryle). Work copy and listing are in `re/fx/alesis-quadraverb2/` (`fw/qv2_v201e.bin`, the two banks
`fw/qv2_lo.bin` / `fw/qv2_hi.bin`, the listing `qv2_lo.lst` made with `re/fx/tools/rdis8051.py`). "lo" and
"hi" addresses below are in the two 64 KB banks of the image.

The tables (`js/devices/defs/alesis-quadraverb2-fw.js`) come from `tools/alesis/qv2_fw.py`, which runs the
firmware from reset in the 8051 emulator (`tools/alesis/i8051.py`, board `tools/alesis/qv2_board.py`, panel
driver `tools/alesis/qv2_emu.py`) and works the front panel: keys, the encoder and its ENTER push. Every block
type is set up on block 1 through the CONFIG pages, then every EDIT page is shown and its display routine run
for each value the encoder steps through. The same for the MOD, GEN, MIX, routing, GLOBAL and MIDI pages; the
100 ROM presets are recalled and requested over SysEx; the SysEx formats are checked by feeding messages into
the MIDI receive buffer.

    python -I tools/alesis/qv2_fw.py re/fx/alesis-quadraverb2/fw/qv2_v201e.bin js/devices/defs/alesis-quadraverb2-fw.js --cache <dir>

(about 40 minutes without a cache; `--cache DIR` keeps every stage as JSON; stages can be named:
`blocks mods modes routes presets sysex config emit`.)

**Not checked on hardware** (no Quadraverb 2 is connected); the tests use the definition's simulator and the
values the generator recorded from the firmware (`CHECKS` in the tables).

## Hardware as the firmware uses it

- Two code banks: a write to 8008 selects the bank code fetches and `MOVC` read (0 = image 0-FFFF, 1 = image
  10000-1FFFF); lo 0000-17C1 and FF00-FFFF are the same in both (FF00 / FF12 switch, FF25 copies a ROM preset
  from hi 1C00 + C0h n into 0900). The hi bank holds the presets, DSP tables and most texts.
- XDATA: RAM 0000-7FFF (system 0000-1BFF, user programs 1C00 + 100h n; P1.5 picks one of two RAM banks for
  1C00-7FFF: User 0 and User 1), the LCD at 8004 / 8005 (the firmware keeps the 32 characters at 0200-021F,
  custom characters at 0220), the ASIC / DSP at 8010-801C (801B status: bit 0 answers each write to 8017).
- Front panel: a 4 x 4 key matrix (8002 bits 4-7 drive the columns, P1.0-P1.3 read the rows): BLOCK (4,0),
  PROGRAM (4,3), cursor right / left (5,0) / (5,1), BYPASS (5,2), STORE (5,3), CONFIG (6,0), ROUTING (6,1),
  EDIT (6,2), MIX (6,3), GLOBAL (7,0), NAME (7,1), MIDI (7,2), MOD (7,3); (4,1) and (4,2) do nothing in these
  modes. The encoder counts on timer 0 (P3.4 pulses, P1.4 the direction) into 13h:14h; its push button (P3.5)
  is ENTER. Footswitches on P1.6 / P1.7.
- MIDI: receive ring 1000-13FF (serial interrupt 003B), parser B05F as a coroutine (B05B keeps its place);
  sending through BB94 (buffer 1400).

## The UI tables

A mode (key) sets XDATA 0056 to a group table: per group a title record (length, text) and a page list (the
rest of the screen line, the page count, then 15-byte page records). 38h is the group, 39h the page, 3Bh the
block. A page record: cursor column, encoder step, display width, minimum and maximum (16 bits, signed when
the minimum is negative), default, a text table pointer, the display routine and the store routine. The page
set-up (2660) puts the parameter's address in XDATA 0065 (page 01 in EDIT mode: the block data at
0100 + 1Ah x block) and the 16-bit flag in 21.6.

The block types: function table lo 2A67 (EQ, PITCH, DELAY, REVERB), per type a descriptor: group count,
"16-bit page" mask bytes (bit 6 first, bit 7 = another byte follows) and the group table. A type's block data
is one byte per page and two for each 16-bit page (the pack routine counts it so, 74C3).

## Programs (256 bytes)

| Bytes | Meaning |
|---|---|
| 00-0D | name, 14 characters 20h-7Fh (EDIT NAME) |
| 0E-15 | blocks 1-8: function << 5 \| type; 0 = OFF. Functions 1 EQUALIZATION (19 types), 2 PITCH (13), 3 DELAY (7), 4 REVERBERATION (14) |
| 16-35 | MOD 1-8, four bytes each: SOURCE (0 PITCH BEND, 1 AFTERTOUCH, 2 NOTE NUMBER, 3 NOTE VELOCITY, 4-127 CONTROLLER 000-123, 128 / 129 LOCAL GENERATOR 1 / 2), TO block (1-8, 9 OUT L, 10 OUT R, 11 MIX), TO parameter (0-63 the block's parameters in page order, 64 + source column the level of a route into that block or output, 128 + n the MIX level n), AMPLITUDE (-99..+99) |
| 36-47 | levels 0-100 %: DIRECT LEVEL FROM INPUT, then per block LEVEL TO L/R (MIX TO L/R) and INMIX TO L/R, MASTER EFFECTS LEVEL (the MOD targets MIX 128-145 name them) |
| 48-5B | GEN 1 / GEN 2, ten bytes each: TYPE (ENVELOPE, PEAK FOLLOWER, RAMP, LOW FREQ. OSCILLATOR, FOOTSWITCH), then the type's pages (trigger source, thresholds, times, gain, footswitch source, action) |
| 5C- | the data of every block in use, block 1 first |
| then | the routes, two bytes each: the low byte of the matrix cell and level 0-58 (OFF, -48.0 dB ... +0.0 dB) with bit 7 = the cell is in page 04h; FF FF after the last when there is room; zeros |
| FF | the block bypass bits (00CF) as STORE found them |

The ROM presets are the first 192 bytes (hi 1C00 + C0h n). A recalled program is unpacked by 7738 (78C3 checks
the block bytes: a bad one loads "*BAD  PROGRAM*" with INPUT -> OUT routes) and packed again by 7488 for STORE
and the dumps.

Routes: matrix 0300h + 34 x destination + source. Destinations 0-7 the inputs of blocks 1-8, 8 OUT L, 9 OUT R.
Sources 0 INPUT LEFT, 1 INPUT RIGHT, then four per block: INMIX (its input mix), MIX and, for types with a
stereo output, LEFT / RIGHT (ADD ROUTE FROM texts; mono types show MIX on all three). The matrix cell holds
80h + level; LEVEL FROM sets the level, DELETE ROUTE clears the cell.

CONFIG (eleven changes run in the emulator, `CHECKS.config`; the eight the unit took are reproduced byte for
byte by the editor's `setBlockTypes`): another function (or OFF) starts the block from the type's defaults
and sets its LEVEL TO L/R to 100 %; within PITCH the values carry over page by page; within REVERBERATION the
shared reverb parameters carry over by name (DECAY, REVERSE TIME and GATE TIME as one; REFLECTION LEVEL /
SPREAD, SWIRL and ATTACK start from their defaults); DELAY types start from the defaults (EQ: not checked,
treated the same). The data of the following blocks moves along. Routes from LEFT / RIGHT of a type that has
only MIX move to MIX, a block that turns stereo sends its MIX routes to OUT L / OUT R from LEFT / RIGHT, and
routes from and to a block turned OFF go. Defaults: EQ, PITCH and DELAY types as the firmware set them when
the generator changed Concert Hall's reverb (another function); REVERB types from their page records (the
recorded data carries Concert Hall's values). The unit also refuses combinations its DSP cannot run ("DSP IS
FULL", "EFFECT MEMORY IS FULL", "OUT OF LFOs", "BLOCK COMBINATION NOT ALLOWED", lo 9276: three of the checked
changes); the editor does not check these.

Value texts: each page's display routine (record bytes 11-12) run for every value. Ranges over 3000 values
(delay times, 0.1 mS steps up to 5000.0 mS) are run for the first and last thousand and every 61st value in
between, extended by the last template and checked against all of these. The delay pages also show the tempo
"[xxx.xBPM]" and the note value "1/4" of the stored time: the editor lists the time without the bracket.
SAMPLING's MAXIMUM SAMPLE LENGTH, START and END show the sampler's state, not a function of the value: they
are typed in raw (0.1 mS units). MOD target names belong to the type (lo 5F50, names at hi E683 + 17 n) and
are paired with the pages by their order and words (the pages without a name are not modulation targets).

The trigger types (TRIGGERED PANNING, MONO / STEREO TRIGGER FLANGE, SAMPLING) start with two records whose
display routines (5455 / 5462) only move the cursor round; their bytes 0 / 1 are the modulation-only targets
"PANNING / FLANGE TRIGGER 1 / 2", "SAMPLE PLAY / REC TRIG." (0 / 1), with no page.

## SysEx

`F0 00 00 0E 0F` (Alesis, model 0F), no channel byte; taken only with SYSTEM EXCLUSIVE RECEIVE ON (00E5).

| Message | Meaning |
|---|---|
| `01 f b g p v1 v2 v3` | one page value as the panel sets it: f 0 EDIT (block parameters), 1 MIX, 2 GLOBAL, 3 CONFIG; b the block 1-8, g / p group and page from 1 (B80B); the value 16 bits, low byte first, as three 7-bit groups; clamped to the page range |
| `02 n <293>` | program n: 0-99 User 0, 64h the edit buffer (loaded at once, 76E9). 256 bytes as a stream of 7-bit groups, high bit first (B765) |
| `0C n <293>` | program n of User 1 |
| `03 n` | request: 0-63h User 0 program, 64h the edit buffer (packed first), 65h-7Fh everything: 200 programs, globals, the program table (BC30) |
| `0D n` | request a User 1 program (64h: the edit buffer) |
| `07 <16>` | GLOBAL data, 14 bytes: 00F0, F2, F4-FE, then F3 bit 0 << 1 \| F1 bit 0 (BD8E / B577); `08` requests it |
| `11 <256>` | MIDI program table, 128 entries of two bytes: low 7 bits, then bit 8 << 1 \| bit 7 (0C00 + bit table 0C80); `12` requests it |
| `0F b1 b2` | block bypass bits (b1 << 1 \| b2 >> 6); `10` requests them |
| `09 a b` | bypass / factory test switches (E1C1, E772) |
| `0B` | asks for a display refresh (1BEF) |
| `05`, `06` | DSP microcode upload, one DSP register: factory functions, not offered |

MIDI CHANNEL (00E0, 1-16 / OMNI), MIDI PROGRAM CHANGE (OFF / ON / TABLE), MIDI THRU and SYSTEM EXCLUSIVE
RECEIVE travel in no message.

## GLOBAL pages

| XDATA | Dump byte | Page |
|---|---|---|
| 00F0 | 0 | ADJUST DISPLAY CONTRAST 1-10 |
| 00F1-F2 | 13 bit 0, 1 | FOOTSWITCH (from) Preset00 ... User1-99 (0-299) |
| 00F3-F4 | 13 bit 1, 2 | FOOTSWITCH TO |
| 00F5 | 3 | VU METER PEAK HOLD OFF / ON |
| 00F6 | 4 | INPUT AUDIO SOURCE ANALOG DATA / OPTICAL DATA (the unit sets the clock with it) |
| 00F7 | 5 | SAMPLE CLOCK SOURCE INTERNAL / OPTICAL / 48kHz INPUT |
| 00F8-FB | 6-9 | DIG CH IN L / R, OUT L / R 1-8 |
| 00FC | 10 | DIGITAL OUTPUT MODE |
| 00FD | 11 | TAP TEMPO FOOTSWITCH NONE / BYPASS / ADVANCE |
| 00FE | 12 | GLOBAL DIRECT SIGNAL ON / MUTE |

## The editor

- Program object (the edit buffer): name, the eight blocks (function / type, then the type's pages with the
  LCD's label and value texts; pages with more than 1500 values are typed in raw with the LCD text shown),
  the MIX levels, MOD 1-8, GEN 1 / 2, the routes (one slot per route, cells named with the program's blocks),
  the bypass bits. EDIT and MIX page values go live (SysEx 01); everything else sends the program to the edit
  buffer (02 64h). Slots User 0 / User 1 (request 03 / 0D, store 02 / 0C) and the ROM presets; a gallery of
  the presets with their blocks.
- Globals object: the GLOBAL pages and the program table (07 / 08, 11 / 12).
- Simulator and translator (reverb, delay and chorus blocks to effects.*, the program in extra).

## The 53 block types

Byte = function << 5 | type; size = bytes of block data; pages in order (LCD label; `*` = a modulation-only trigger byte with no page; `raw` = typed in raw).

| Byte | Function | Type | Size | Pages |
|---|---|---|---|---|
| 20h | EQUALIZATION | LOWPASS FILTER | 2 | LOWPASS Fc |
| 21h | EQUALIZATION | BANDPASS FILTER | 3 | BANDPASS Fc, BW |
| 22h | EQUALIZATION | HIGHPASS FILTER | 2 | HIGHPASS Fc |
| 23h | EQUALIZATION | LOWPASS SHELF EQ | 4 | LOWPASS, GAIN |
| 24h | EQUALIZATION | 1 BAND LOW PARAMETRIC | 5 | BANDPASS, BANDPASS GAIN, BANDPASS WIDTH |
| 25h | EQUALIZATION | 1 BAND HIGH PARAMETRIC | 5 | BP, G, BW |
| 26h | EQUALIZATION | HIGHPASS SHELF EQ | 4 | HIGHPASS, GAIN |
| 27h | EQUALIZATION | 2 BAND SWEEP SHELF EQ | 8 | LOWPASS, GAIN, HIGHPASS, GAIN |
| 28h | EQUALIZATION | 3 BAND PARAMETRIC EQ | 13 | LOWPASS, GAIN, MID BAND, BANDPASS GAIN, BANDPASS WIDTH, HIGHPASS, GAIN |
| 29h | EQUALIZATION | 4 BAND PARAMETRIC EQ | 18 | LOWPASS, GAIN, LOW MID, LOW BP GAIN, LOW BP BANDWIDTH, HIGH MID, HIGH BP GAIN, HIGH BP BANDWIDTH, HIGHPASS, GAIN |
| 2Ah | EQUALIZATION | 5 BAND GRAPHIC EQ | 5 | 63Hz, 250Hz BAND GAIN, 1KHz BAND GAIN, 4KHz BAND GAIN, 16KHz BAND GAIN |
| 2Bh | EQUALIZATION | RESONATOR | 2 | TUNING, DECAY |
| 2Ch | EQUALIZATION | MONO TREMOLO | 3 | SPEED, DEPTH, SHAPE |
| 2Dh | EQUALIZATION | STEREO TREMOLO | 3 | SPEED, DEPTH, SHAPE |
| 2Eh | EQUALIZATION | STEREO SIMULATOR | 1 | STEREO SPREAD |
| 2Fh | EQUALIZATION | SOFT OVERDRIVE | 3 | EFFECT MIX: OVERDRIVE, BRIGHTNESS, DRIVE LEVEL |
| 30h | EQUALIZATION | HARD OVERDRIVE | 3 | EFFECT MIX: OVERDRIVE, BRIGHTNESS, DRIVE LEVEL |
| 31h | EQUALIZATION | TRIGGERED PANNING | 8 | *PANNING TRIGGER 1, *PANNING TRIGGER 2, SPEED, DOPPLER, DISTANCE, RETRIGGER POINT, SWEEPING MODE, TRIGGER SOURCE |
| 32h | EQUALIZATION | PHASE INVERTER | 1 | OUTPUT PHASE |
| 40h | PITCH | MONO CHORUS | 5 | SPEED, DEPTH, FEEDBACK, CHORUS PREDELAY, CHORUS SHAPE |
| 41h | PITCH | STEREO CHORUS | 6 | SPEED, DEPTH, FEEDBACK, PREDELAY CHR1, CHR2, CHORUS SHAPE |
| 42h | PITCH | QUAD CHORUS | 7 | SPEED, DEPTH, FEEDBACK, PREDELAY CHR1, CHR2, PREDELAY CHR3, CHR4 |
| 43h | PITCH | MONO FLANGING | 4 | SPEED, DEPTH, FEEDBACK, FLANGING SHAPE |
| 44h | PITCH | STEREO FLANGING | 4 | SPEED, DEPTH, FEEDBACK, FLANGING SHAPE |
| 45h | PITCH | PHASOR | 2 | SPEED, DEPTH |
| 46h | PITCH | MONO LEZLIE | 3 | LEZLIE MOTOR, SPEED, HIGH ROTOR LEVEL |
| 47h | PITCH | STEREO LEZLIE | 4 | LEZLIE MOTOR, SPEED, HIGH ROTOR LEVEL, STEREO SEPARATION |
| 48h | PITCH | PITCH SHIFTER | 2 | PITCH SHIFT FINE, COARSE |
| 49h | PITCH | PITCH DETUNE | 1 | DETUNE AMOUNT |
| 4Ah | PITCH | RING MODULATOR | 1 | SPECTRUM SHIFT |
| 4Bh | PITCH | MONO TRIGGER FLANGE | 8 | *FLANGE TRIGGER 1, *FLANGE TRIGGER 2, SPEED, DEPTH, FEEDBACK, RETRIGGER POINT, SWEEPING MODE, TRIGGER SOURCE |
| 4Ch | PITCH | STEREO TRIG. FLANGE | 8 | *FLANGE TRIGGER 1, *FLANGE TRIGGER 2, SPEED, DEPTH, FEEDBACK, RETRIGGER POINT, SWEEPING MODE, TRIGGER SOURCE |
| 60h | DELAY | MONO DELAY | 4 | DELAY, DELAY (2), FEEDBACK |
| 61h | DELAY | STEREO DELAY | 8 | L DLY, L DLY (2), L FDBACK, R DLY, R DLY (2), R FDBACK |
| 62h | DELAY | PING PONG DELAY | 4 | DELAY, DELAY (2), FEEDBACK |
| 63h | DELAY | MULTI TAP DELAY | 26 | TAP1, TAP 1 LEVEL, L, FB, TAP2, TAP 2 LEVEL, L, FB, TAP3, TAP 3 LEVEL, L, FB, TAP4, TAP 4 LEVEL, L, FB, TAP5, TAP 5 LEVEL, L, FB, MASTER FEEDBACK |
| 64h | DELAY | TAP TEMPO MONO DELAY | 4 | DELAY, DELAY (2), FEEDBACK |
| 65h | DELAY | TAP TEMPO PING PONG | 4 | DELAY, DELAY (2), FEEDBACK |
| 66h | DELAY | SAMPLING | 14 | *SAMPLE PLAY TRIG., *SAMPLE REC TRIG., SAMPLE PLAY, REC, raw MAXIMUM SAMPLE LENGTH, raw START, raw END, PLAY TRIGGER, REC TRIGGER, MIDI NOTE#, REC OUTPUT |
| 80h | REVERBERATION | MONO ROOM | 15 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 81h | REVERBERATION | ROOM 1 | 15 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 82h | REVERBERATION | HALL 1 | 15 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 83h | REVERBERATION | PLATE 1 | 15 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 84h | REVERBERATION | CHAMBER 1 | 15 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 85h | REVERBERATION | ROOM 2 | 18 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, LEVEL, SPREAD, REVERBERATION SWIRL, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 86h | REVERBERATION | HALL 2 | 18 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, LEVEL, SPREAD, REVERBERATION SWIRL, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 87h | REVERBERATION | PLATE 2 | 18 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, LEVEL, SPREAD, REVERBERATION ATTACK, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 88h | REVERBERATION | CHAMBER 2 | 18 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, LEVEL, SPREAD, REVERBERATION ATTACK, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 89h | REVERBERATION | LARGE PLATE | 18 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, LEVEL, SPREAD, REVERBERATION SWIRL, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 8Ah | REVERBERATION | LARGE ROOM | 18 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, LEVEL, SPREAD, REVERBERATION SWIRL, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 8Bh | REVERBERATION | SPRING | 15 | DECAY, DAMPING HI, LO, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT, GATE TRIG, GATED LEVEL, GATE HOLD, RELEASE |
| 8Ch | REVERBERATION | NONLINEAR | 7 | GATE HOLD TIME, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT |
| 8Dh | REVERBERATION | REVERSE | 7 | REVERSE TIME, DENSITY, DIFFUSION, INPUT HIGH FREQ ROLL OFF, PREDELAY, MIX:DIRECT |

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- The program a user memory holds after the unit's initialisation (18B5): no blocks, INPUT -> OUT
