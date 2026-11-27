# Access Virus b (and kb, Indigo, Rack, Classic)

Editor: `js/devices/defs/access-virus-b.js` (also `access-virus-kb.js`, `access-virus-indigo.js`,
`access-virus-rack.js`, `access-virus-classic.js`), built with `abcModel()` of
`access-virus-abc.js` over the tables of the Virus B OS 4.9 (`access-virus-b-os.js`) or the Virus
Classic OS 4.9 x061 (`access-virus-classic-os.js`). How the tables are read and the SysEx: see
[access-virus-abc.md](access-virus-abc.md). Mapped from the firmware only: no Virus b, kb, Indigo,
Rack or Classic was connected.

## Firmware

- Virus B OS 4.9: the flash dump `Access Virus B (am29f040b_4v9).BIN` (boot texts `@ 09.01.04 049`,
  `OS 4.9 T`, "VIRUS b", "VIRUS kb", "VIRUS Indigo"; IRAM 30h picks the text: 0 b, 1 kb, 2 Indigo,
  B 4.9 4F5C) and the update `Virus_OSB490x050_INT.zip` (first files for the S and T hardware
  revisions; the T file decodes to the flash dump byte for byte). The tables are read from the T build.
- Virus Classic: the update `Virus_Classic490x061_INT.zip` (build 061, 26.03.04): the B's code with
  everything from 2A3C on moved by -44h (`re/virus/old/maproutines.py` matched every routine used).
  Its tables come out identical to the B's (every label, range and value text).
- Virus Rack: no firmware in the collection; the B OS 4.9 is assumed.

Regenerate:

    python -I tools/virus/abc_tables.py extract b49 re/virus/upd/bin/b_t049.bin re/virus/tabs/b49_raw.json
    python -I tools/virus/abc_tables.py js b49 re/virus/upd/bin/b_t049.bin re/virus/tabs/b49_raw.json js/devices/defs/access-virus-b-os.js
    (the same with classic, re/virus/upd/bin/classic061.bin -> access-virus-classic-os.js)

## What the OS shows

- 244 / 250 / 214 menu records (single / multi single / multi play mode tables); every page A / B /
  C index they edit gets the record's label, title, range and the text of each value as the display
  routine prints it (e.g. LFO shapes "Sine" ... "S&G", "Wave 3" ... "Wave 64"; Semitone "-48" ... "+48"
  over 16-112; delay times in ms; the alphabetical assign destinations through the OS's remap tables,
  stored 1 = "PatchVol"; categories; Device ID 1-16 / "Omni").
- The 32 panel knobs: each handler's parameter in every panel state (the cutoff knob edits page A 40
  as "Cutoff1", "Center" or "Cutoff", resonance 42 / 43 by the filter select, "Wave1" / "PW1" by the
  Osc 1 knob's selection ...) with the knob display's value texts. Knob-only parameters (cutoffs,
  resonances, both envelopes, oscillator shapes / waves / pulse widths, detune, FM amount, mixer,
  LFO 1 / 2 rates) are named with the page A controller names of the definable list ("Cutoff",
  "Filt1Reso", "FiltAttack", "AmpRelease" ...).
- Set with panel buttons and shown by LEDs only (no menu, knob or screen text): Osc2Sync (A 28),
  Filt1Mode / Filt2Mode (A 51 / 52: LP, HP, BP, BS), FiltRouting (A 53: Ser4, Ser6, Par4, Split),
  Lfo1EnvMode / Lfo2EnvMode (A 69 / 81: Off, On): named with the controller list, values as Access's
  documentation names them (A OS 2.8 addendum), editable.
- Page A bytes no screen shows: 1-16 and 64-66 are performance controllers (the reader takes them from
  the controller table, not the sound), 0 / 32 / 123 are asked from the DSP (0 = the sound format,
  6 in B sounds); page A 4 holds the panel selections (filter select bits 0-1, Osc 1 / 2 knob Wave or
  PW bits 5 / 6). The rest are read-only reserved entries.
- Page C: multi parameters (common: tempo, the multi delay / reverb; per part: bank, program, MIDI
  channel, key range, transpose, detune, volume, MIDI volume init, output, effect send, pan, and the
  switches enable, MIDI volume, hold pedal, keyboard to MIDI, priority, program change) and the global
  settings (MIDI, system, keyboard, definable knobs, input, memory protect ...). The play mode (C 122),
  the part number (C 119 / 123) and the current bank / program selections (C 100-105) are the unit's
  state, not settings, and are left out.

## Banks

RAM A and B (SysEx banks 1-2) are stored; ROM C-H (3-8) are read only (1024 sounds since OS 4.5;
"Store to Flash" copies RAM banks into the flash banks on the unit). 128 RAM multis (bank 1).

## Open

- A hardware check (b, kb, Indigo, Rack, Classic).
- The DSP-side receiver: which requests each model answers, and refusals (Memory Protect, MIDI Dump
  RX) are as Access documented them, not traced.
- The Virus Rack's own OS (assumed B 4.9).
