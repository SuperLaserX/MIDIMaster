# Access Virus TI Snow

The Snow (2008) is the Virus TI sound engine in a small desktop unit with its own host OS build. The editor
(`js/devices/defs/access-virus-snow.js`) uses the TI editor's single, multi page layout and messages
(`access-virus-ti2.js`, documented in `access-virus-ti2.md`) with the Snow's own tables:
`access-virus-snow-fw.js` (Virus Control's Snow description: `python -I tools/virus/vc_xml.py <dll>
re/virus/snow/snow.json "Virus TI Snow"`, then `python -I tools/virus/gen_fw.py re/virus/snow/snow.json
js/devices/defs/access-virus-snow-fw.js`) and `access-virus-snow-os.js` (`python -I tools/virus/os_tables.py snow`).

**No Snow was connected: nothing here is checked on a unit.** Everything is from the firmware (the Snow host OS in
the Virus TI Software Suite 5.1.7, `vti_snow.bin`; host banks in `re/virusti/fw/snowhost/`, Ghidra project
`re/virus/ghidra_snow`, `sh re/virus/snow/gh.sh BANK OUT lin:A:B`) and the Snow's parameter reference manual
(`re/virus/snow/pdf/snow_ref.txt`).

## What differs from the TI (firmware evidence)

| What | Snow | Where |
|---|---|---|
| Single | the TI's 512 bytes; the OS parameter table (bank 2 8701), display lists (banks 10-13) and reordering tables are the TI2's byte for byte | `re/virus/snow/p5/probe2.py` |
| Value-list table | bank 1 D19D (TI2 D720), same content | `find_tbl.py`, `os_tables.py` `VALUE_LISTS` |
| Range routines | bank 2 BB19 (TI2 BB6D); they call 01C5 / 0180 where the TI2 calls 0826 / 012A, and test bit 14h where the TI2 tests 13h | `os_tables.py` `RANGES`, `GET_PARAM`, `BANK_COUNT`, `USB_BIT` |
| Output selects | internal parameters 035D / 035F (part output, lists 119 / 121, reordering tables 6 / 7) and 0441 (surround output, list 117, table 4) where the TI2 has 035C / 035E / 0440: the screen lists Out 1, USB 1-3, then the greyed Out 2 / Out 3 (stored values 0-2, 9-17, 3-8); a part offers 12 positions (3 without USB audio, 9 with Virus Control's third USB pair off) | `access-virus-snow-os.js` `PARAM` |
| LED Mode | 5 values (Lfo, Ext Inputs, Auto, Output1, Output2); Virus Control offers 7 | range routine |
| Parts | 4: single dumps and parameter messages to parts 4-15 are refused (352E `CJNE R7,#04`; request slot check 46BF) | receiver |
| Single banks | banks of 64 named RAM 1-8 and ROM 1-8 (display list 68); SysEx keeps banks of 128: bank 1 = RAM 1 + RAM 2 (slots 0-63 / 64-127), 4 = RAM 7 + 8, 5-8 = ROM 1+2 ... 7+8. The slot address routine 5A52: memory bank 2 + 2 x (bank - 1) + slot / 64, 512 bytes a slot. The OS's own dump menu (list 79): Single Buffer, RAM 1+2, RAM 3+4, RAM 5+6, RAM 7+8, Controller Dump, Arrangement, Multis | 5A52, 3673, 4597 |
| ROM | 512 singles (sections P064-P071, 64 each, format 8): SysEx banks 5-8 | `re/virusti/fw/snow_sections.txt` |
| Multis | 64; each holds its 4 part singles (memory banks 0A-0D: 16 multis a bank, 2 KB of singles each; the factory multis are S010-S014 of the image) | 5A91 |

## SysEx (the TI's family: F0 00 20 33 01 dd cc ... F7)

| Message | Snow |
|---|---|
| 30 bb pp | single request: bb 0 (pp 40 single mode, 0-3 a part, 7F the current part), 1-4 RAM, 5-8 ROM (any pp 0-127), 20h + m (multi m, pp 0-3) |
| 31 bb pp | multi request: 00 = the edit buffer (answer 11 00 7F), 01 mm, or 20h + m (answer 11 01 m) |
| 32 bb | single bank request: 128 singles for bb 1-8, the 4 part singles for 20h + m |
| 33 01 | the 64 multis (11 01 00-3F); other banks are refused (receiver state 37: 3AF0) |
| 34 bb | bb 00: the multi edit buffer and the part singles (11 00 7F, 10 00 pp; a part may be left out: check 0076); bb 20h + m: multi m with its 4 singles (11 01 m, 10 (20h + m) 00-03) (state 38: 3AFC, kinds 3C64) |
| 10 bb pp | single: bb 0 into an edit buffer (40, 0-3), 1-4 store into RAM (any slot), 20h + m store as part pp (0-3) of multi m (receiver 34FF, store 366D; MIDI Dump RX: Enable stores where the dump says, Force To Bank A+B ... G+H (2-5) store bank 1-4 dumps into that pair, To Edit Buffer (6) into the edit buffer, Verify (7) compares) |
| 11 bb pp | multi: 00 7F the edit buffer; 32h mm stores multi mm (0-63); bank 1 is always refused (3791) |
| 70 71 6E 6F, 72, 73 | parameters as on the TI (parts 0-3 and 40) |

The OS sends 11 32 m followed by the 4 singles 10 (20h + m) pp from its own "Multis" dump (kind 3 continuing
through banks 20h-5Fh, 3D64): the editor's multi store sends the same messages.

## The editor

- Single page: as the TI; the edit buffer is single mode or one of the 4 parts. Slots: RAM 1-8 and ROM 1-8 of 64;
  reading a bank's names asks for its SysEx bank of 128 (both halves arrive) and shows this half.
- Multi page: the 256-byte multi plus its 4 part singles (2304 bytes). Get from device = 34 00; a slot = 34 20h + m;
  store = 11 32 m and the 4 singles; Send to Virus = 11 00 7F and 10 00 00-03. MIDI channels page with 4 parts.
  The places of parts 5-16 in the multi bytes are read-only reserved entries.
- Global page: Virus Control's Snow globals with the Snow's ranges (sent only: no global request).
- Translator (`access-virus-snow-translate.js`): singles as the TI2 (exact within the TI family); multis with 4 parts,
  exact between Snows through `extra`.
- USB and DIN: as the TI (access-virus-ti2.md, "DIN and USB"): the same `def.link` (`TI_CONNECTION`), needs and DIN
  warning, without the Remote mode (the Snow has none). The Snow's host build routes MIDI the same way: USB MIDI mode
  is bit 25h (set by the global 82 "USB MidiPort active" handler at bank 2 A839, cleared at 12E5 / 61F3); while it is
  set the MIDI In receive (2A5D) passes the socket's bytes to USB instead of the synth, and the Virus answers over USB;
  while it is clear everything works through a MIDI interface on the MIDI In / Out sockets. Firmware only.

## Open

- Everything needs a check on a Snow (bank numbering and the 64-sound halves, the multi store with its singles,
  which parts 34 00 leaves out, the output selects, its USB port names and DIN).
- The multi part Bank parameter (internal 0353) still shows the TI's bank list (list 67, RAM-A ... ROM-Z) as the value
  table says; whether the Snow's screen shows list 68 (RAM 1 ... ROM 8) for it is not traced.
- Patch numbers within a bank are shown 01-64 (not seen on the Snow's screen).
- Remote templates: the receiver takes 38 / 13 as the TI's and its dump menu offers "Remote Patches", but the Snow's
  panel knob table (bank 1 D121, other format than the TI2's D014 tables) is not decoded, so no template page yet.
