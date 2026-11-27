# Access Virus C (and KC, Indigo 2)

Editor: `js/devices/defs/access-virus-c.js` (also `access-virus-kc.js`, `access-virus-indigo2.js`), built
with `abcModel()` of `access-virus-abc.js` over the tables of the Virus C OS 6.6
(`access-virus-c-os.js`). The SysEx and how the shared editor works: [access-virus-abc.md](access-virus-abc.md).
Mapped from the firmware only: no Virus C, KC or Indigo 2 was connected.

## Firmware

- Virus C OS 6.6: the flash dump `Access Virus C (am29f040b_6v6).BIN` (`re/virus/c/flash66`, boot texts
  "V I R U S   C", "V I R U S    K C", "I n d i g o  2", `OS 6.6`; IRAM 75h picks the text at 5E9B: 0 C,
  1 KC, 2 or more Indigo 2). The tables are read from this dump.
- The update `Virus_OSC650x352_INT (1).zip` (OS 6.5 build 352, `re/virus/upd/bin/c352.bin`): its banks 1
  and 2 (texts, menu tables) are identical to the 6.6 dump's, its fixed code differs in places (not
  compared further). The readme names the Virus c, kc and Indigo-2.
- An older dump, OS 5.5 (`re/virus/c/flash55`), is not used.

Regenerate:

    python -I tools/virus/abc_tables.py extract c66 "re/virus/c/flash66/Access Virus C (am29f040b_6v6).BIN" re/virus/tabs/c66_raw.json
    python -I tools/virus/abc_tables.py js c66 "re/virus/c/flash66/Access Virus C (am29f040b_6v6).BIN" re/virus/tabs/c66_raw.json js/devices/defs/access-virus-c-os.js

(about 4 minutes; the config is `C66` in `tools/virus/abc_host.py`).

## Host OS (C OS 6.6 addresses)

The C's host is a reorganised build of the B's code (same 8051, LCD, bank switching at 1E23):

- Edit menus: 18 edit modes, one per panel edit section (LFO 1 / 2 / 3 amounts, the mod matrix,
  LFO edit, arpeggiator, effects with the distortion / phaser / chorus selected, delay / reverb,
  oscillators, filters, common, multi / global, program select, store, other, a test page). Pointer table
  bank 2 B598; each table is a count byte, 24-byte records ending FEh, FDh after the last (the OS checks
  them itself at 679D: "teste EditMode", "TabEnde kein $FD", "Wert zu gross!"). Record bytes as on the B:
  5 / 6 page and index, 7 / 8 a second parameter, 0B / 0C range, 0F reset value, 11 layout, 12 display
  type (92 routines, jump table 097B), 13 title (16-byte texts bank 1 C373, 99 of them; titles 80h and up
  print the bank / program), 14 label (bank 1 C9A3, 0 = none).
- Loader 5300 (R7 edit mode, R6 record: fields to XRAM 4367-4371, 441B-4423), item display 0B10 (the main
  loop 3259 calls it). Play mode XRAM 4302 (page C 122), current part IRAM 4Eh (40h single mode).
- Parameter reader 1425 (part 51h, page 52h, index 53h -> 54h): per page a handler number per index
  (bank 1 F71A), handlers through the jump table 1482: page A / B from the part's edit buffer (single mode
  0000h, part p (p + 3) x 100h, 20F2), page B through the alphabetical remaps (82C8, 8348, 83C8, 8448), the
  performance controllers from 2600h, the multi at 2300h (part rows 2320h + 10h x row + part, part bits
  23F0h + part: the same layout as the B's 1200h), globals at 2400h; page A 0, 32, 123 have no value
  (FFh); C 100-105 / 119 / 122 / 123 are the unit's selections and play mode.
- Panel knobs: dispatch 3A20 (knob number from 71BB, 32 knobs, handlers 3A76-3EA8), each sets the short
  name (12-byte texts D5B3), display type, page and index and stores them at 3F11 for the knob display
  0D15 (shown while Knob Display is on). The C has no knob test texts: knobs are named by their first
  page A parameter's controller name.
- Page A names per index: the definable controller list (15-byte records at A939).

`tools/virus/abc_host.py` runs that code in the 8051 emulator (C66 config: the 18 tables, the multi /
global and delay / reverb tables a second time in multi mode, every value 0-127 of every record; each
knob handler over every panel state it tests, explored branch by branch).

## What the OS shows

- 332 menu records in the 18 tables (324 of them edit a page A / B / C index); every index they edit (92 of
  page A, 100 of page B, 74 of page C, knob-only ones included) has the record's label, title (the menu card),
  range and the screen text of each value: the C's filter modes (LowPass ... Analog 1P-4P), 22 categories
  (Organ, Piano, String, FM, Digital new), 26 delay / reverb modes, six assign slots (4-6 new), EQ
  low / mid / high with frequencies in Hz, Analog Boost, Phaser, LFO 3 (its destination B 11 is the
  record edit mode 2 shows: 4CB1 reads it, 0E68 writes it, so the editor offers it as a list of the
  records' labels; B 12 is the amount).
- Knob-only parameters: cutoffs, resonances, envelopes, oscillator shapes / pulse widths, semitones,
  detune, FM amount, the mixer, LFO rates, chorus depth, effect send, phaser feedback, and the
  distortion (type Off ... HighPass, intensity) and Osc 3 (mode Off / Slave / Saw / Pulse / Sin / Tri /
  waves 3-64, semitone, detune), which have no menu on the C. Their value texts are the knob display's;
  ranges end where the display stops changing (Osc 3 mode 0-67, distortion type 0-11).
- Panel selections stored with the sound (the knob handlers read them): page A 4 bits 0-1 the filter
  select, page B 125 the effects select (Distortion, Phaser, Chorus), 126 the LFO select, 127 the
  oscillator select (Osc 1 / 2: Wave while its Shape is below 64, else Pulse Width; Osc 3: its mode).
  Names are the parameters the knobs edit in each state (no screen text).
- Set with panel buttons, LEDs only: Osc 2 Sync (A 28), Filter 2 mode (A 52), shown with the controller
  list's names and Access's value names (as for the B).
- Page A bytes no screen shows: 1-16 and 64-66 are performance controllers; 0, 32, 123 have no value in
  the host (page A 0 is the sound format, 7 in C sounds). The rest are read-only reserved entries.
- Page C: the multi (common: tempo, delay / reverb of the multi; per part: bank A-H, program, MIDI
  channel, key range, transpose, detune, volume, MIDI volume init, output, pan and the switches enable,
  hold pedal, keyboard to MIDI, priority, program change) and the global settings. The C's ChanVolRx menu
  record edits page C 40 (0 / 1, the same byte as ChanVolInit) rather than the part bit C 73 the B used:
  the editor shows C 40 with the ChanVolInit range and lists ChanVolRx as another menu of it.

## Banks

RAM A and B (SysEx banks 1-2) are stored; ROM C-H (3-8) read only. 128 RAM multis. Access's dumps
(`re/virus/dumps/c_abm.syx`: 10 01 / 10 02 banks, 11 01 multis; `c_analog.syx`: 60 singles) are format 7
and read back byte for byte (tests/access-virus-abc.test.js).

## Open

- A hardware check (C, KC, Indigo 2).
- The DSP-side SysEx receiver is not traced: requests 30-35 are Access's documented ones.
- The edit-mode test page (table 17), the store page (table 15: name entry, store targets) and the
  link records of table 9 (page FFh: jumps to other pages) are not parameters and are left out.
