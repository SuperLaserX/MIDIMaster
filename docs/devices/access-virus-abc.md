# Access Virus A / B / C family: how the editors are made

The editors of the earlier Virus models share one definition, `js/devices/defs/access-virus-abc.js`
(`abcModel()`), and differ in the tables read from each model's own operating system
(`access-virus-<os>-os.js`, written by `tools/virus/abc_tables.py`). Nothing here was checked on a
unit: none was connected (phase 6 of the Virus work, 2026-11-26).

| Model | OS used | Device file | Doc |
|---|---|---|---|
| Virus b (desktop) | B OS 4.9 (T build 049 = the VB_490T flash dump) | `access-virus-b.js` | [access-virus-b.md](access-virus-b.md) |
| Virus kb | B OS 4.9 (boot text "VIRUS kb") | `access-virus-kb.js` | [access-virus-kb.md](access-virus-kb.md) |
| Virus Indigo | B OS 4.9 (boot text "VIRUS Indigo") | `access-virus-indigo.js` | [access-virus-indigo.md](access-virus-indigo.md) |
| Virus Rack | assumed B OS 4.9 (no Rack firmware in the collection) | `access-virus-rack.js` | [access-virus-rack.md](access-virus-rack.md) |
| Virus Classic | Classic OS 4.9 build 061 | `access-virus-classic.js` | [access-virus-classic.md](access-virus-classic.md) |
| Virus C | C OS 6.6 (flash dump am29f040b_6v6) | `access-virus-c.js` | [access-virus-c.md](access-virus-c.md) |
| Virus KC | C OS 6.6 (boot text "V I R U S    K C") | `access-virus-kc.js` | [access-virus-kc.md](access-virus-kc.md) |
| Virus Indigo 2 | C OS 6.6 (boot text "I n d i g o  2") | `access-virus-indigo2.js` | [access-virus-indigo2.md](access-virus-indigo2.md) |
| Virus Rack XL | Rack XL OS 6.5 build 079 | `access-virus-rack-xl.js` | [access-virus-rack-xl.md](access-virus-rack-xl.md) |
| Virus A | A OS 2.8 (update Virus_A_Series_OS280) | `access-virus-a.js` | [access-virus-a.md](access-virus-a.md) |

## Firmware

- Flash dumps (am29f040b, 512 KB): Virus B OS 4.9 (`re/virus/b/flash`), Virus C OS 5.5 and 6.6
  (`re/virus/c/flash55`, `flash66`).
- OS updates as standard MIDI files (A 2.80, B 4.9 S / T, Classic 4.9 x061, C 6.5 x352, Rack XL
  6.5 x79), unpacked to `re/virus/upd/` and decoded with `re/virus/old/osupd.py`: messages
  `F0 00 20 33 01 kk bb ss <128 nibbles, low nibble first> cs F7` carry 64 bytes at block bb
  (256 bytes) quarter ss of the current 32 KB segment, `kk 7F nn 7F` starts segment nn; kk is the
  model's update id (50 A, 51 B "S", 53 B "T", 57 C, 58 Rack XL, 59 Classic). The decoded B T image
  equals the flash dump byte for byte. Images: `re/virus/upd/bin/*.bin`, first 64 KB in
  `re/virus/hosts/`.
- The readmes name the models of each OS: B 4.9 for the Virus b, kb and Indigo (the S and T
  versions are two hardware revisions, "no quality or performance difference"); C 6.5 for the
  Virus c, kc and Indigo-2; the Classic and the Rack XL have their own builds; A 2.8 for the Virus A.

## Host OS

The host is an 8051 driving a 2 x 16 LCD (HD44780 on port 1); 0000-7FFF is fixed code, 8000-FFFF a
32 KB bank of the flash chosen by SFR F8 bits 4-7 (B 4.9: 2AC6). The sound engine and the MIDI
receiver run on the DSP (56300 code in the flash from bank 3, loaded through the host port at boot,
B 4.9 41EF); the host asks it for parameters it does not keep itself.

What the tables come from (addresses of B 4.9; the Classic's build is the same code with everything
from 2A3C on moved by -44h; the C OS 6.6 is reorganised: 18 edit-mode tables, its own reader and knob
dispatch, see [access-virus-c.md](access-virus-c.md)):

- Edit menus: three tables of 24-byte records in bank 2 (8000, 96F9, AE82), one per play mode
  (Single, Multi Single, Multi: page C 122, read from 7F02 by 2A52). Record bytes: 3 kind, 5/6 page and
  index of the parameter, 7/8 a second parameter, 0B/0C the range, 0F the value the OS resets to
  (Value + / - together, 56DC), 11 the layout, 12 the display type (83 routines, jump table 1881),
  13 the title (16-byte texts at DB66), 14 the label (16-byte texts at E086), 17 AAh. The loader is
  40D2, the item display 1164.
- Panel knobs: handler table 2688 (32 knobs, dispatch 267A); each handler picks the parameter by the
  panel state (sound byte 4 bits, 2F0E) and stores display type, short name (12-byte texts at 8BC8),
  page and index for the knob display 130B. Knob names: CADB.
- Parameter reader 65ED (part 53h, page 54h, index 55h -> 56h): per index a handler (jump table 7724,
  three pages of 128): page A / B from the part's edit buffer (single mode at 0000, part p at
  (p + 2) x 100h), the performance controllers from the controller table (page A 1-16, 64-66), the
  remapped destination lists (B 65, 68, 70, 73, 75, 77, 79, 81 through A414; B 62 / 63 and C 112 /
  113 through A514: the alphabetical lists of OS 4.07), page C multi parameters from the multi at
  1200 (common bytes at 1200 + index, part rows 1220 + 10h x (index - 32) + part, part bits 12F0 + part),
  global ones from 2400 + index, and a few from the DSP (A 0, A 32, A 123, C 0, 1, 14, 30, 127).
- Page A names per index: the definable MIDI list (15-byte records "name ... number" at AF22).

`tools/virus/abc_host.py` runs that code in the 8051 emulator of `tools/alesis/i8051.py`: for every
menu record the loader once, then the item display for each stored value 0-127, with only the leaf
routines that fetch a stored byte hooked (so the remapping and the special handlers run as on the
unit) and the LCD routines captured; for every knob the handler in each panel state, then the knob
display. The text a display prints after the label is the value's screen text. The tables keep the
range and texts of the record shown in single mode first (some multi-mode records print the part's
bank and program instead of a title).

## SysEx (as the TI kept it)

| Message | Meaning |
|---|---|
| `10 bb pp <256> cs` | single: page A (0-127) and page B (128-255); bb 0 = edit buffer (pp 40 single mode, 0-15 part), 1-2 RAM A-B, 3-8 ROM C-H |
| `11 bb pp <256> cs` | multi: bb 0 = edit buffer (pp 7F), 1 = RAM multis 0-127; common bytes = page C index, part p of page C ci at 32 + 16 (ci - 32) + p, part switches C 72-78 = bits 0-6 of byte 240 + p |
| `12 bb pp <256> cs` | global settings: byte i = page C index i (the host's 2400 + i) |
| `30 bb pp`, `31 bb pp`, `32 bb`, `33 bb`, `34`, `35` | requests: single, multi, single bank, multi bank, multi edit buffer with the 16 part singles, global |
| `70 / 71 / 72 pp ii vv` | parameter of page A / B / C, part pp (40 single mode) |

cs = (sum of dd .. the last data byte) & 7F. The dump layouts and the checksum are confirmed by the
dumps Access shipped with the updates (`ABM.mid` of the B and the C: 10 01 / 10 02 banks, 10 00 pp
edit buffers, 11 00 7F, 11 01 pp multis, one 12 global dump; the C's "Analog Filter Sounds.syx"):
`re/virus/dumps/`. The receiver runs on the DSP (56300 code, no disassembler here): the request
numbers are Access's documented ones (the TI still answers 30-34), not traced in the code.

## Single page

Every page A / B byte with a menu record or a panel knob is a parameter with the screen's label (the
menu title as its group), range and value texts; selections are dropdowns, amounts knobs showing the
screen's text. Knob-only parameters (cutoff, resonance, envelopes, oscillator shape / wave / pulse
width, detune, FM, mixer) use the definable list's page A name and the knob's display. Sound
parameters set with panel buttons and shown by LEDs only (sync, filter modes, routing, LFO envelope
modes) use the definable list's names and the value names of Access's documentation. Bytes no screen
shows are read-only entries saying what the reader does with them (performance controllers, the
DSP, nothing). Page A 0 is the sound format (6 in B sounds, 7 in C sounds); in a B / Classic sound
page A 4 holds the panel selections the knob handlers test (filter select bits 0-1, Osc 1 / Osc 2
knob Wave or Pulse Width bits 5 / 6).

## Open

- Every model now has its editor (the C, Rack XL and A added 2026-11-26 with configs `C66`, `RXL`, `A28` in
  `abc_host.py`). What each assumes is in its doc.
- A hardware check of every model (none was connected).
- The DSP-side receiver (requests, refusals) is not traced.

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Filter select (page A 4 bits 0-1): the OS reads it at 15F0.
