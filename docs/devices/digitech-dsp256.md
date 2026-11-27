# DigiTech DSP-256: MIDI implementation from the v1.05 firmware

Source: `Digitech DSP_256_1.05.zip` (`DSP_256_105.bin`, 64 KB, HD6303 code at 2000-FFFF; it shows "DIGITECH
DSP-256Version 1.05"). Work copies: `re/fx/digitech-dsp256/fw/dsp256_v105.bin` and `dsp256_v104.bin` (v1.04, the
same MIDI code); listing `re/fx/digitech-dsp256/dsp256.lst`:

    python -I tools/yamaha/hd6303_dis.py re/fx/digitech-dsp256/fw/dsp256_v105.bin 0 re/fx/digitech-dsp256/dsp256.lst $(cat re/fx/digitech-dsp256/entries.txt) --auto

The tables (`js/devices/defs/digitech-dsp256-fw.js`) and the test vectors (`tests/digitech-dsp256.vectors.json`)
come from `tools/digitech/dsp256_fw.py` (about 1.5 minutes):

    python -I tools/digitech/dsp256_fw.py re/fx/digitech-dsp256/fw/dsp256_v105.bin js/devices/defs/digitech-dsp256-fw.js --vectors tests/digitech-dsp256.vectors.json

The generator finds every address it uses by code pattern (`layout()`), so it also serves the DSP-256XL (see
`docs/devices/digitech-dsp256xl.md`); the editor is shared too (`digitech-dsp256-common.js`, thin model files).
It runs the firmware in a new HD6303 emulator (`tools/yamaha/hd6303.py`, general: it uses the opcode table of
`hd6303_dis.py`) on a board model (`tools/digitech/dsp256_board.py`): boot from reset (the empty RAM counts as a
battery failure, so the factory presets are loaded as on a new unit), then the edit display (5034h) for every value
of every page of every configuration, and the utility pages' display and value routines. Each text is what the LCD
buffer (04C2h, 2 x 16) holds afterwards. Every page was also run with other values in the other program bytes: no
text depends on them. The vectors feed MIDI bytes through the SCI interrupt (at MIDI speed) and the main-loop parser.

**Not checked on hardware** (no DSP-256 is connected).

## Hardware as the firmware uses it

- HD6303: internal registers 0000-001F, RAM to 1FFF (stack at 1FFE), HD44780 LCD at 0100 (instruction) / 0101
  (data), output latches 0300-0305 (DSP, key scan columns), EPROM 2000-FFFF. Reset 3DA4.
- The hand controller's 16 keys are read through port 1 bits 5-7 and the latch 0304 (timer interrupt 3E7F). Key
  codes (table 47D9): 0F / 0B parameter up / down, 07 / 03 value up / down, 06 / 02 program up / down, 08 utility,
  0C title, 0E copy, 04 compare.
- MIDI: SCI. The receive interrupt (60A3) runs a state machine (next state in 0700h) that checks the SysEx header
  and the channel, and queues the bytes (100-byte ring at 0725h); the main loop parses the queue (state in 0702h).

## Programs

A program is 22 bytes: byte 0 the configuration, bytes 1-21 the parameters of that configuration in page order
(the parameter list is 22 words at 6400h + 2Ch x configuration; each word points at the page's record, whose first
byte is the parameter's "Linked to CC" number). The 16-character title is kept apart. A value above the page's
range is shown (and set) as 0 (5E9E).

| Memory | Where |
|---|---|
| User titles 1-128 | 08CEh, 16 bytes each |
| User programs 1-128 | 10CEh, 22 bytes each |
| Configuration memories 0-26 | 1BCEh, 22 bytes each: the values a program takes when the panel switches it to that configuration (626Dh); every value change saves the program there (62A3h) |
| Settings | 1E20h-1F23h |
| Factory presets 129-256 | ROM: titles 2A82h, programs 3282h |

The 27 configurations: Mute, Dry, Stereo Chorus, Stereo Flange, Stereo Delay, 4-Tap Delay, Ultimate Reverb, Gated
Reverb, Reverse Reverb, Parametric EQ, Graphic EQ, Para+Delay+Mixer, Para+Chorus+Mix, Chorus+Room+Mix,
Delay+Room+Mixer, Chorus+Hall+Mix, Delay+Hall+Mixer, EQ+Gated+Mixer, EQ+Reverse+Mixer, Para+Cho+Dly+Mix,
Para+Fla+Dly+Mix, Cho+Dly+Room+Mix, Fla+Dly+Room+Mix, Cho+Dly+Hall+Mix, Fla+Dly+Hall+Mix, EQ+Chor+4Tap+Mix,
EQ+Flan+4Tap+Mix (0-26). Every page's label and value texts are in the generated table.

The title editor (table 4D76h) steps through space, A-Z, LCD character 1, a-z, character 2, 0-9, character 3,
! to /, : to @, [, ] to ` and { to 7Fh; the HD44780 shows 7Eh / 7Fh as arrows (factory preset 153 uses 7Fh).

After the first power-up (factory init 42F7h) the user programs hold the factory presets, each configuration memory
holds the first factory preset with that configuration (zeros for Mute and Dry), the MIDI channel is 1, the map
1:1.

## Settings (utility pages, table 46FAh: display, up, down routine per page)

| Page | Byte | Values |
|---|---|---|
| MIDI Channel | 1E21h | 0 NONE, 1-16, 17 OMNI |
| <parameter> Linked to CC | 1E22h + link number | 0-128 (CC n), 129 ChP. The selector lists 90 names (link numbers 1-92 except 23 and 90, which no page uses; 0 is unused); Bypass is 91, Repeat Hold 92 (S45F3 treats those two as switches) |
| Midi Program n is m on DSP256 | 1E7Fh + n | program 1-256 |
| Transmit ProgramChange? | 1EFFh | NO, YES |
| Hand / Foot Controller | 1F00h | FFh Hand Controller, 0 Foot Controller; with a foot controller each switch code k (1-15) does the function in 1F01h + k (No Function, Program Up / Down, Parameter Up / Down, Right, Left, Compare, Store, Name, Utility, ByPass, Repeat Hold, Patch Select; names 2A4Eh) and Patch Select loads the program in 1F12h + k |
| LCD Contrast | 1F23h | 1-10 (high four bits 0-9) |
| Dump MIDI data? / Dump program ? | | send the 41h / 42h dumps |
| Restore Presets? | | the factory init |

Byte 1E20h is the program loaded. 1F01h, 1F11h, 1F12h and 1F22h are in the dump; no page shows them.

## SysEx

`F0 00 00 10 <n> 06 <command> ... F7`: DOD / DigiTech (00 00 10), DSP-256 (06); n is the MIDI channel - 1 (with
OMNI any n; with NONE nothing is taken). Data bytes travel as pairs: bit 7, then bits 6-0.

| Command | Meaning |
|---|---|
| `00` | request: the unit sends the 41h dump at once (41F0h) |
| `41 <5718 pairs>` | all memory 08CEh-1F23h: titles, programs, configuration memories, settings |
| `42 <39 pairs>` | one program: number 0-127, 22 program bytes, 16 title characters. Stored into that user program; not loaded |
| `01 hb lo` | program request: the handler does `JSR $42` (direct page) and so runs RAM at 0042h, in v1.04 and v1.05 alike. Not used |
| `40 a b c d` | a DSP register write (5E65h): not used |

Program change: the program map turns MIDI program 1-128 into program 1-256 (taken while the unit shows a program:
modes 0 and 2). Control changes move the parameters linked to them.

## The editor

- Program: the configuration (switching it loads that configuration's memory, as the panel does: from the memory read
  with Settings, else as after the first power-up), every page of the configuration with the LCD text of every value,
  the 21 bytes as numbers, the title (Rename). The unit has no edit-buffer message: each change writes the whole
  program into the chosen user program (42h) and loads it with a program change. Slots: user programs 1-128 (read from
  the 41h dump, stored with 42h) and the factory presets 129-256 (from the firmware). Gallery of the configurations.
- Settings: the whole 41h dump (MIDI, program map, Linked to CC, foot controller, configuration memories). Send writes
  the whole memory back (the user programs too, as read).
- Translator (Head Library): reverb, delay, chorus / flange and EQ blocks from the configuration, values as fractions of
  the pages' ranges; exact bytes and title in extra.

## Open

- A hardware check.
- The 01h program request (jumps to 0042h): what a real unit does with it.
- v1.04 not compared beyond the MIDI code (both have the same receiver).
