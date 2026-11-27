# Access Virus A

Editor: `js/devices/defs/access-virus-a.js`, built with `abcModel()` of `access-virus-abc.js` over the tables of
the Virus A OS 2.8 (`access-virus-a-os.js`). The SysEx and the shared editor: [access-virus-abc.md](access-virus-abc.md).
Mapped from the firmware only: no Virus A was connected.

## Firmware

- The update `Virus_A_Series_OS280-EN.zip` (OS 2.8; its first MIDI file is the OS, the second holds the ROM
  sounds), decoded with `re/virus/old/osupd.py` to `re/virus/upd/bin/a280.bin` (boot text "V I R U S").

Regenerate (several minutes; config `A28` in `tools/virus/abc_host.py`):

    python -I tools/virus/abc_tables.py extract a28 re/virus/upd/bin/a280.bin re/virus/tabs/a28_raw.json
    python -I tools/virus/abc_tables.py js a28 re/virus/upd/bin/a280.bin re/virus/tabs/a28_raw.json js/devices/defs/access-virus-a-os.js

## Host OS (A 2.8 addresses)

The B's ancestor, with its own layout:

- Edit menus: three play-mode tables (Single, Multi Single, Multi: XRAM 7F02) of 254 records each at bank 2
  8000 / 98E8 / B1D0, 25 bytes per record (the record reader 6306 takes the record from 7F04): 4 / 5 page and
  index, 8 / 9 range, 0C reset value, 0E layout, 0F display type, 10 title (bank 1 A3C0, 128 texts; titles from
  80h on are the bank / program screens), 11 label (bank 1 ABC0), 12 / 13 a second parameter, 18 marker AAh.
- Loader 726E (R6 record), item display 333C (prints the value the loader read, XRAM 7F2B), main loop 5A74.
- Parameter reader 3963 (part 52h, page 53h, index 54h -> 55h; a 2-byte handler per index at 3BAF + 100h x page):
  page A / B straight from the part's edit buffer (no alphabetical remapping yet), the performance controllers,
  the panel selections (page B 122 from page A 4), the multi at 1200h (part rows C 31-42, switches C 72-74, 77,
  78), the global settings at 2400h; page A 0, 32, 123 have no value in the host.
- Panel knobs: dispatch 5B3B (knob number from 19A6, 32 knobs, handlers 5B89-5E8C) store the display type, a
  label as the short name, page and index at 5E93 for the knob display 34A2. Knob texts (the knob test) at ECC7.
- The A has no numbered controller list (its definable list has no controller numbers): knob-only parameters
  are named by the knob's text, or by the knob display's numbered name when one knob edits two bytes (Reso1 /
  Reso2, EnvAmt1 / 2, KeyFlw1 / 2).

## What the OS shows

- Every page A / B / C index a menu edits, with its label, title, range and screen texts (LFO shapes "Sinus" ...,
  waves "Sin", "Tri", 3-64, categories, the edit mode Easy / Expert, banks A-D).
- Knob-only parameters (cutoffs, resonances, envelopes, oscillator shapes, mixer, LFO rates) with the knob
  display's texts; Osc 2 Sync, filter modes and routing, LFO envelope modes: panel buttons (as on the B).
- Page A 4: the panel selections (filter select, Osc 1 / 2 knob Wave or PW), as on the B.
- The multi: 16 parts with bank, program, channel, key range, transpose, detune, volume, MIDI volume init,
  output, effect send and the part switches; no part pan (page C 43 is a global setting on the A), so the MIDI
  channels page has no Pan column.

## Assumed (not in the OS host code)

- Banks: the menus offer A-D; RAM A-B (SysEx banks 1-2) and ROM C-D (3-4) are assumed.
- The sound format the A's DSP writes in page A 0 (6 is used for new sounds, as on the B); 128 RAM multis.

## Open

- A hardware check; the DSP-side SysEx receiver (requests as Access documented them).
- Which banks are RAM, the A's own sound format and multi count (no A dump in the collection).
