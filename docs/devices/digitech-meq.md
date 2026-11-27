# DigiTech MEQ 28 / MEQ 14 / MEQ 7: MIDI implementation from the v1.06 firmware

Source: `digitech_meq.zip` (`meq_v106.bin`, 32 KB NM27C256, sticker "72-3144-15 MEQ V1.06 4E0E", from a "MEQ Dual 14",
HD6303RP). Work copy: `re/fx/digitech-meq/fw/meq_v106.bin`; listing `re/fx/digitech-meq/meq.lst`:

    python -I tools/yamaha/hd6303_dis.py re/fx/digitech-meq/fw/meq_v106.bin 8000 re/fx/digitech-meq/meq.lst $(cat re/fx/digitech-meq/entries.txt) --auto

The tables (`js/devices/defs/digitech-meq-fw.js`) and the test vectors (`tests/digitech-meq.vectors.json`) come from
`tools/digitech/meq_fw.py` (about 15 seconds):

    python -I tools/digitech/meq_fw.py re/fx/digitech-meq/fw/meq_v106.bin js/devices/defs/digitech-meq-fw.js --vectors tests/digitech-meq.vectors.json

It runs the firmware in the HD6303 emulator (`tools/yamaha/hd6303.py`) on a board model (`tools/digitech/meq_board.py`)
for each of the three models: boot from reset with empty RAM (error "E1", a key, the factory initialisation "FP", a
restart showing the model number), then the firmware's own display routines for every value, and program changes and
SysEx through its MIDI receiver. The two display digits are read back through the firmware's own 7-segment font.

**Not checked on hardware** (no MEQ is connected).

## One firmware, three models

The program is the upper half of the EPROM (C000-FFFF). At reset it reads two jumpers (4000h with row 7: C79C) and
becomes one of three units:

| Model | Jumpers | SysEx model byte | Channels | Bands | Power-up display |
|---|---|---|---|---|---|
| MEQ 28 | bit 4 | 07 | 1 | 28 (1/3 octave, 31.5 Hz - 16 kHz) | "28" |
| MEQ 14 | bit 3 | 08 | 2 | 2 x 14 (2/3 octave, 40 Hz - 16 kHz) | "14" |
| MEQ 7 | neither | 09 | 4 | 4 x 7 (63 Hz - 16 kHz) | " 7" |

The editor has a Model choice (Settings page); any message from the unit sets it (the model byte).

## Hardware as the firmware uses it

- HD6303RP: registers 0000-001F, internal RAM 0080-00FF, RAM 8000-9FFF (battery backed), EPROM C000-FFFF. Reads of
  0020-007F float: the program up / down keys compare with direct address 0063h (`cmpa $63`), which reads 63h = 99.
- Display: two 7-segment digits (8Ah left, 89h right, through the font at D6C7h, '0' onwards) and a lamp byte (8Bh);
  31 LED columns of 13 LEDs (B2h-EFh, one 13-bit pattern per column), all scanned by the timer interrupt (DCF5).
- Keys: an 8 x 5 matrix (4004h row, 4000h bits 0-4; codes from C136h): 31 column keys (one per program byte) and seven
  function keys (20h recall, 21h store, 22h compare, 23h level, 24h channel select / exit, 25h MIDI, 26h bypass; names
  from what their handlers do), and an encoder (4000h bits 6-7, codes 29h / 2Ah).
- The MEQ 28 also has a serial EEPROM (port 1): programs 1-7 can be saved there (store twice) and recalled from it
  (recall three times); the first power-up writes them there or reads them back (D55E). The board model has no EEPROM
  (that step is skipped); nothing of it travels over MIDI.
- Power-up with a key held: the channel select key runs the factory initialisation, the bypass key switches the
  semi lockout (816Ah = A3h), the recall key the full lockout (A5h), compare and level start test modes.

## Programs

A program is 35 bytes, 99 programs (816Bh + 35 x n, shown "1" - "99"):

| Bytes | Meaning |
|---|---|
| 0-30 | the 31 band columns, 0-24 = -12 dB to +12 dB in 1 dB steps (DigiTech's manual). Which columns are bands depends on the model (the filter chip map 80F2h: MEQ 28 columns 2-29; MEQ 14 1-14 and 16-29; MEQ 7 0-6, 8-14, 16-22, 24-30); the other columns are stored but drive nothing |
| 31-34 | the output level of channels 1-4 (MEQ 28: byte 31 only, MEQ 14: 31-32), 0-15 shown "-14" to "16" (D86B, its own segment table D84Bh) |

The unit shows a band as its LED column (D923, table D8A3h): value 0 lights the bottom LED, 24 the top one, 12 the centre
one; odd values light the two LEDs around them. A selected band (being edited) shows its column inverted (table D8D5h).
The firmware has no text for the bands: their names (frequencies) are those of DigiTech's MIDI implementation manual,
whose band tables match the firmware's column map for all three models.

The first power-up (D4E3) fills every program flat (bands 12, levels 7) and writes the 10 factory programs of its model
into programs 1-10 (C488h for the MEQ 28 and MEQ 14, which share them; C5E6h for the MEQ 7).

Two edit buffers (808Fh, 80B2h) serve the compare key. Loading a program copies into the edit buffer only the parts of
the channels being loaded (channel select key; for MIDI the channels receiving the program change):

| Model | Channel 1 | Channel 2 | Channel 3 | Channel 4 | all |
|---|---|---|---|---|---|
| MEQ 28 | 0-30, 31 | | | | |
| MEQ 14 | 1-14, 31 | 16-29, 32 | | | 0-32 |
| MEQ 7 | 0-6, 31 | 8-14, 32 | 16-22, 33 | 24-30, 34 | 0-34 |

## Settings (the head of the 41h memory, 813Dh-816Ah)

| Byte | Meaning |
|---|---|
| 0 | current program (0-98) |
| 1-4 | MIDI channel of channels 1-4 (MIDI page, D793): "--" off (0), 1-16, "oi" every channel (17). The first power-up sets 17 |
| 5-8 | the channels' section masks (the firmware's table: MEQ 28 0F, MEQ 14 0C 03, MEQ 7 08 04 02 01; the rest A5h from the RAM fill). The editor shows them, does not change them |
| 9-39 | the controller of each band column (D7E9: "--" none, 1-99) |
| 40-43 | the controller of each output level |
| 44 | the controller of the bypass (shown with the left digit's point: "-.-", " .1" - "9.9", D831) |
| 45 | power-up lock: A3h semi lockout (every edit handler returns at once), A5h full lockout (after power-up, or the restart a 41h memory causes, the unit loops at C8E1 for ever: no keys, no MIDI). Any other value is off. Names from DigiTech's manual, which says MEQ 28 only; the v1.06 code tests them on every model |

The MIDI page's dump selection (813Bh, not in the dump): "≡≡" (three bars on both digits: all) or a program 1-99; the
store key on that page sends 41h or 42h.

## SysEx

`F0 00 00 10 <n> <model> <command> ... F7`: DOD / DigiTech (00 00 10), model 07 / 08 / 09. The receiver (SCI interrupt
DF32, state pointer 8087h) checks the header, then n + 1 against each channel's MIDI channel (17 takes any; E07C), then
the model byte (8111h), and queues the rest (ring 8F7Ah) for the main loop's parser (D148). Data bytes travel as pairs:
bit 7, then bits 6-0.

| Command | Meaning |
|---|---|
| `00` | request: the unit sends 41h (D43C) on channel 1's MIDI channel; when that one is off or every channel (17) it sends nothing |
| `41 <3511 pairs>` | memory 813Dh-8EF3h (settings, then the 99 programs). Stored byte by byte; at the last byte the unit loads program (byte 0) + 1 into all its channels (C988) and restarts (jmp C744); extra bytes are ignored |
| `42 <n> <35 pairs>` | program n (0-98, unchecked: keep it below 99), stored at its last byte; nothing is loaded |
| `01 <n>` | DigiTech's manual: request one program. The v1.06 handler (D28C) sets the program number and does `jsr $42`: address 0042h, where nothing answers, so the CPU meets an illegal opcode and its trap restarts the unit. Never sent |

Program change n (0-98) loads program n + 1 into the channels receiving on that MIDI channel (D173, table D2AFh) and
makes it the current program; 99 and above are ignored. Control change (D36E): controllers 1-99; every band, level or
bypass linked to the controller takes it: bands value x 2 x 25 / 256 (only for the channels on that MIDI channel), levels
value x 2 x 16 / 256 (any), bypass on for 0-64, off for 65-127. A band changed by a controller while the unit shows a
MIDI or level page reaches the filters when it leaves the page (the same for program changes).

Vectors (`tests/digitech-meq.vectors.json`, MEQ 14) check the request and its answer, the silence with channel 1 on
every channel, a 42h program, program changes on each channel's MIDI channel, controllers, a wrong model byte, a 41h
memory with the restart, and the 01h request's illegal opcode.

## The editor

- Model (Settings page): MEQ 28 / MEQ 14 / MEQ 7; a message from the unit sets it.
- Program: the model's bands (each value as dB and the LEDs it lights) and output levels (the level page's texts), a
  drawing of the LED columns per card, the 35 bytes as numbers. Each change writes the program into the chosen program
  number (42h) and loads it with program changes on the channels' MIDI channels (as last read, else the editor's).
  Slots: the 99 user programs (Edit / Read names read the memory: one 00 request, one 41h answer of about 2.3 s; Store
  sends 42h) and the 10 factory programs of the model.
- Settings: current program, MIDI channels, controller links (bands, levels, bypass), power-up lock (keep it Off),
  section masks (shown only). Send writes the whole memory (41h); the unit restarts.
- Translator (Head Library): effects.eq with the bands (frequency, gain in dB) of channel 1, every channel's bands and the
  level texts; exact bytes in extra. Another model or device: each band takes the gain of the nearest source band.

## Open

- A hardware check.
- The MEQ 28's EEPROM programs (no MIDI message carries them).
- The panel key names (the handlers say what each does; the panel's printing is not in the collection).
