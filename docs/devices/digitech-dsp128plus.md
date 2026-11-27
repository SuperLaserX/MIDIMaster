# DigiTech DSP-128 Plus: MIDI implementation from the v2.00 firmware

Source: `digitech_dsp-128plus.zip` (`digitech_dsp128plus_v200.bin`, 32 KB NMC27C256, sticker "DSP128+ V2.00"; it
holds "DIGITECH_DSP128_VERSION_2.00_PROGRAMMED_BY_JIM_PENNOCK"). Work copy: `re/fx/digitech-dsp128plus/fw/dsp128p_v200.bin`;
listing `re/fx/digitech-dsp128plus/dsp128p.lst`:

    python -I tools/yamaha/hd6303_dis.py re/fx/digitech-dsp128plus/fw/dsp128p_v200.bin 8000 re/fx/digitech-dsp128plus/dsp128p.lst $(cat re/fx/digitech-dsp128plus/entries.txt) --auto

The tables (`js/devices/defs/digitech-dsp128plus-fw.js`) and the test vectors (`tests/digitech-dsp128plus.vectors.json`)
come from `tools/digitech/dsp128p_fw.py` (about 1.5 minutes):

    python -I tools/digitech/dsp128p_fw.py re/fx/digitech-dsp128plus/fw/dsp128p_v200.bin js/devices/defs/digitech-dsp128plus-fw.js --vectors tests/digitech-dsp128plus.vectors.json

It runs the firmware in the HD6303 emulator (`tools/yamaha/hd6303.py`) on a board model
(`tools/digitech/dsp128p_board.py`): boot from reset (the empty RAM counts as a battery failure: "bAtt", then "F Pr" and
the factory programs), then the page records for every value of every page of every configuration, and the MIDI pages
for every value. The board's copy of the image has the display font replaced so that the four display bytes read back
as the characters the firmware chose (each with its decimal point); the texts below are those characters.

**Not checked on hardware** (no DSP-128 Plus is connected).

## Hardware as the firmware uses it

- HD6303: internal registers 0000-001F, internal RAM 0080-00FF (display buffers), external RAM 4000-5FFF (battery
  backed: 47FFh = 99h once initialised; programs 5000h-55FFh; MIDI receive ring 4800h-4FF7h; stack 47FEh), output latches
  2000-2003 (DSP address / data), 2004-2006 (display digit and lamp latches), key inputs 2008 / 2009, EPROM 8000-FFFF.
  Reset D500, SCI interrupt FB21, timer (OCF) F99F.
- Display: four 7-segment digits with points, scanned by the timer interrupt. Characters go through the font at F6B0h
  ('0' onwards, lower case at F6E0h; numbers through the digit table E069h). Some characters look alike on 7 segments
  (U / V, the digit 0 / O, 5 / S); the texts keep the firmware's character. ':' lights the point alone (written " .")
  and ';' segment g alone (written "-").
- The character routine F687 masks with `andb $7F`, a read of address 007Fh where nothing answers: on a 6303 bus the
  floating data lines still hold the operand byte 7Fh, which is what the routine needs. The board model returns the
  address byte for 0020-007F.
- Keys: the timer interrupt reads 2008h (low four bits) and 2009h (bits 2-3) into a key code. At reset the firmware
  picks one of two key tables by 2009h: codes 3xh only (7 keys: page, value up / down, store, restore, bypass, 33h) or a
  wider panel with a MIDI key (1Fh), a page-down key and the FS / SC pages. A foot switch input (port 2) has five
  layouts ("FS 1" - "FS 5", byte 408Bh; the fifth reaches every function including the MIDI pages).
- An expansion socket at 6000h: a ROM there with 1Dh / E2h at 6001h / 6002h adds configurations after the 15 of the
  EPROM (6003h their count, 6004h / 6006h its tables). Nothing in the collection fills it.

## Programs

A program is 12 bytes at 5000h + 12 x n (n = 0-127, shown "P  1" - "P128"): byte 0 the configuration, bytes 1-11 the
values of that configuration's pages in page order. The configuration table (8040h + 18h x c) holds a record pointer
per page; page 1 is the configuration itself ("A  0" - "A 14"), pages 2-12 are program bytes 1-11. The unit shows no
parameter names: each page shows a two-character code and the value, both from its record. The record types:

| Type | Shows |
|---|---|
| 0Dh | a text per value from the record's table (e.g. "LP.40" - "LP20", "rd1.0" - "rd20", "F  0" - "hold") |
| 0Fh | delay times: "d.000" - "d.750" (1 ms, then 5 ms steps) |
| 10h / 12h | 0-99 after the code ("SP", "DE") |
| 13h | the delay range "dr 1" - "dr 3"; it keeps the range in RAM (408Fh) for the next page |
| 14h | a number with the range of table F4B8h ("Cd 0" - "Cd60", "Pd 0" - "Pd80"; "d.000" - "d.749" in three ranges that follow "dr") |
| 11h | the configuration ("A  1"), with the lamp bytes |

The 15 configurations and their pages (every value's text is in the generated table):

| Configuration | Pages (program bytes 1-11) |
|---|---|
| A  0 | none |
| A  1, A  3, A  5 | LP rL rd dL d F CL Cd SP DE (the rd ranges differ: 1.0-20, .8-2.8, .1-1.1) |
| A  2, A  4, A  6 | LP rL rd dL d F FL Fd SP DE FF |
| A  7 | LP CL Cd SP DE dL b c d E F (four delay taps b, c, d, E: .000-1.25) |
| A  8 | FL Fd SP DE FF dL b c d E F |
| A  9 | LP rL Pd rd dL dr d F |
| A 10 | LP rL rd AA AE dL dr d F |
| A 11 | 1F 1L 2F 2L dL d F CL Cd SP DE |
| A 12 | 1F 1L 2F 2L dL d F FL SP DE FF |
| A 13 | EL SL rF rv dP En St Sd Et Ed |
| A 14 | 1L - 9L (-6 to 6) |

The delay time pages of A 9 and A 10 ("d") show three ranges by the "dr" byte before them: the generator runs the "dr"
record first (as loading the program does: EC5C runs every record) and makes one table per range. Every other page was
run with the lowest and highest values in the other bytes and does not change.

A value above its page's range is set to 0 when the page is shown (type 0Dh also shows error 06).

- **Factory programs:** D8F0h (128 x 12); the first power-up (D86E) copies them into the user programs and clears the
  MIDI settings. The panel's restore key (E632) copies the factory program into the program shown.
- **Start programs:** DEF0h (15 x 12). Switching the configuration on page 1 loads the configuration's start program,
  all 12 bytes (E8AF).
- **Store** (E590 / E5F5): copies the program shown into another program number.

## MIDI settings (MIDI pages, F84C)

| Page | Byte | Values |
|---|---|---|
| 0 | 4049h | "CH 1" - "CH16" (0-15), "CH o" (16: every channel), "CH n" (17: none). The page steps on to 45 but shows those as "CH n" and sets them back to 17 |
| 1-44 | 4049h + k | the controller of link k: "xx n" none (0), "xx 1" - "xx99" the controller, "xxCP" channel pressure (100); xx = the link's name (F93Bh: rd Pd rL AE AA d dr F dL b c E HP SP dE Cd CL Fd FF FL ir rh bY 1F 1L 2F 2L 3L-9L Ed Et EL Sd St SL En dP rv rF) |
| none | 4076h-407Bh | links 45-50 (named "SA"): no page shows them |

Each page record names its link (record byte 2), so a controller moves that page in every configuration that has it
(the LP filter pages use link 13, whose MIDI page is named "HP"). Link 22 ("rh") is the delay hold and link 23 ("bY")
the bypass: their controllers switch them (above 64 on, 64 and below off). Bytes 408Bh ("FS 1" - "FS 5", foot switch
layout) and 408Ch ("SC 1" - "SC 4", display scrolling) are not in the dump.

## SysEx

`F0 00 00 10 <n> 03 <command> ... F7`: DOD / DigiTech (00 00 10), DSP-128 Plus (03); n is the MIDI channel - 1 (with
"CH o" any n; with "CH n" nothing is taken). Data bytes travel as pairs: bit 7, then bits 6-0. The SCI interrupt checks
the header and queues the bytes (ring 4800h); the main loop parses them (E093).

| Command | Meaning |
|---|---|
| `00` | request: the unit sends the 41h message at once (FCEC; its channel byte is 4049h AND 0Fh) |
| `41 <1587 pairs>` | memory: 5000h-55FFh (programs 1-128), then 4049h-407Bh (channel, links 1-50). The receiver shows "in", stores each byte as its pair completes and needs no count: a message cut after program n writes programs 1-n and keeps the rest (a half pair at F7 is error 0E). At F7 the program loaded is loaded again |
| `40 a b c d` | a DSP register write (E1AD): not used |

Program change: data byte n loads program n + 1 (no map). Control change: the parameters of the current program whose
link has that controller take value x 2 x (range + 1) / 256 (E266); channel pressure counts as controller 100. The
vectors check the request, a whole and a cut 41h message, a program change, a wrong channel and a controller moving a
linked page, all through the SCI interrupt and the main-loop parser.

## The editor

- Program: the configuration (switching loads its start program, as the panel does), every page of the configuration
  with the display text of every value, the 11 bytes as numbers. The unit has no edit-buffer or single-program message,
  so each change writes programs 1 to n through a 41h message cut after the chosen program n and loads it with a
  program change. Program 1 needs nothing else; for program n > 1 the programs before it are sent as last read (Get or
  Read names), and until the memory has been read those changes are not sent. Slots: user programs 1-128 (read from
  the 41h dump; Store writes programs 1 to n) and the 128 factory programs (from the firmware). Gallery of the
  configurations' pages.
- MIDI settings: the MIDI channel and the controller of each link, from the whole 41h dump. Send writes the whole memory
  back (the 128 programs too, as read).
- Translator (Head Library): reverb ("rd", "rL"), delay ("d", "F", "dL"), chorus / flange ("SP", "DE", "CL" / "FL") and EQ
  blocks from the configuration's pages, values as fractions of the pages' ranges; exact bytes in extra.

## Open

- A hardware check.
- Which key panel the DSP-128 Plus has (the firmware has both tables).
- The expansion ROM (none in the collection).

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Links 22 and 23 have MIDI pages but move no program page: link 22's controller holds the delay (repeat hold, E6EA / E752), link 23's switches the bypass (E9B5).
