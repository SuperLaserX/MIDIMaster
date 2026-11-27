# Access Virus Rack XL

Editor: `js/devices/defs/access-virus-rack-xl.js`, built with `abcModel()` of `access-virus-abc.js` over the
tables of the Rack XL's own OS 6.5 build 079 (`access-virus-rack-xl-os.js`). The SysEx and the shared editor:
[access-virus-abc.md](access-virus-abc.md). Mapped from the firmware only: no Rack XL was connected.

## Firmware

- The update `Virus_rackXL_OS650x79_INT (1).zip` (OS 6.5 build 079), decoded from its first MIDI file with
  `re/virus/old/osupd.py` to `re/virus/upd/bin/rxl079.bin` (boot text "VIRUS rack XL", `OS 6.5`).

Regenerate (about 4 minutes; config `RXL` in `tools/virus/abc_host.py`):

    python -I tools/virus/abc_tables.py extract rxl re/virus/upd/bin/rxl079.bin re/virus/tabs/rxl_raw.json
    python -I tools/virus/abc_tables.py js rxl re/virus/upd/bin/rxl079.bin re/virus/tabs/rxl_raw.json js/devices/defs/access-virus-rack-xl-os.js

## Host OS (Rack XL 6.5 x079 addresses)

The C's code reorganised for a rack with a value knob and four parameter knobs:

- Edit menus: 11 edit modes (pointers in the fixed code at 0138, records in bank 2): program select (two),
  oscillators, filters, envelopes, LFOs, effects, common / mod matrix, arpeggiator / setup (soft knobs,
  categories, random, second output, globals), multi parts, store. Records are 23 bytes: the C's with one byte
  fewer (byte 7 is the record's knob page, no second parameter): 5 / 6 page and index, 0A / 0B range, 0E reset
  value, 10 layout, 11 display type (94 routines, jump table 76B1), 12 title (bank 1 D6D6, 99 texts), 13 label
  (bank 1 DD06), 16 marker AAh (bit 0 a flag, so AAh or ABh). The record reader 0150 checks the marker.
- Loader 3E24 (R7 edit mode, R6 record), item display 6FB7 (prints the stored value, then the edited one),
  main loop 1E94. Play mode XRAM 4202 (page C 122), part IRAM 51h.
- Parameter reader 0788 (part 54h, page 55h, index 56h -> 57h; a 2-byte handler per index at 1408 + 100h x
  page): the C's memory layout (part buffers 0000h / (p + 3) x 100h, multi 2300h, globals 2400h). Page B 126 /
  127 are not bytes of the sound: the reader shows the selected filter's resonance / env amount there (A 42 / 43
  or 44 / 45 by the filter select in page A 4).
- Knobs: the value knob and four parameter knobs (2AB0, knob number in R0). The shown record's byte 7 picks a
  knob page (bank 2 9FE1: 24 pages of 4 x 16 bytes: kind, page, index, range, title, short name (12-byte texts
  E936), display type, and a second parameter for kinds that switch, e.g. an LFO's rate or its clock); the
  kind's handler stores the parameter at 2CC5 for the knob display 71C0.

`abc_host.py` runs the loader and display for every record and value (the multi parts, effects and setup pages a
second time in multi mode) and each parameter knob on each of the 24 knob pages, following every branch its
handler tests.

## What the OS shows

- 317 menu records; the Rack XL's menus also show what the B / C edit with knobs only: oscillator shapes,
  pulse widths, semitones and detune, the mixer, filter envelope attack, Osc 3, the distortion, the LFO
  rates. Cutoffs, resonances, env amounts and the other envelope stages are knob-only (parameter knobs on the
  filter / envelope pages): their names, titles and value texts are the knob display's.
- The vocoder page shows filter parameters under vocoder names (A 41 Offset, A 42 Q-Carrier, A 55 Release,
  A 57 SpecBalance ...); the editor names them by the knob that edits them elsewhere (Cutoff2, Reso1, Decay,
  Time) and lists the vocoder name as another menu.
- Page C 43 is the part's pan (the reader takes it from the part row); the RANDOM menu shows the same index
  as ParaDepth (listed as another menu of it).
- Panel selection stored with the sound: the filter select (page A 4 bits 0-1). Everything else as on the C
  ([access-virus-c.md](access-virus-c.md)): format 7 sounds, banks A-H (RAM A-B), 128 multis, 16 parts.

## Open

- A hardware check; the DSP-side SysEx receiver (requests as Access documented them).
- The sound format a Rack XL writes in page A 0 is assumed to be the C's 7 (same engine, same OS family);
  no Rack XL dump was in the collection.
