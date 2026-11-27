# ART Multiverb Alpha 2 SE: MIDI implementation from the v1.03 firmware

Sources: `ART_alpha2_se_EPROM_Firmware_v103_27c1001` (128 KB, Z80; the screen says `Alpha 2 SE  1.03`,
`ART Jul 15, 1993`) and `ART_MULTIVERB_ALPHA_SE_V1_04` (`Alpha 2 SE  1.04`, `ART May 23, 1994`; the
catalog lists it as "Multiverb Alpha SE", id `art-multiverb-alpha-se`, which opens the same editor). Copies
in `re/fx/art-alpha2se/fw/`, string lists and Z80 listings (`re/fx/tools/z80dis.py`, linear sweep of
0000-9FFF) in `re/fx/art-alpha2se/work/`. No manual for the SE was found; the Alpha 2 manual
(`re/fx/art-alpha2/doc/`) covers the common part.

**Not checked on hardware** (no Alpha 2 SE is connected); the tests use the definition's simulator and the
results of the firmware's own routines run in a Z80 emulator.

The SE runs the Alpha 2's software (`docs/devices/art-multiverb-alpha2.md`): the same effect types,
configurations, 98-byte edit buffer, PERFORMANCE MIDI, X-15 switches and settings. The editor is shared
(`js/devices/defs/art-multiverb-alpha2-common.js`, thin model files `art-multiverb-alpha2.js` and
`art-multiverb-alpha2-se.js`). What the SE adds or changes is below. The tables
(`js/devices/defs/art-multiverb-alpha2-se-fw.js`) and test vectors (`tests/art-multiverb-alpha2-se.vectors.json`)
come from the same generator as the Alpha 2's, which finds every address by code pattern:

    python -I tools/art/alpha2_fw.py re/fx/art-alpha2se/fw/ART_alpha2_se_EPROM_Firmware_v103_27c1001.BIN js/devices/defs/art-multiverb-alpha2-se-fw.js tests/art-multiverb-alpha2-se.vectors.json

(about one minute; the Alpha 2's output from the same tool is byte for byte what it was). Addresses below
are v1.03 CPU addresses; v1.04 has the code one byte later from 0517 on.

## Memory map

CPU 0000-9FFF is the image's first 40 KB; A000-BFFF an 8 KB page chosen by port 28h (page p = image p x
2000h: 5 and 6 the configurations' DSP data, 7-10 the ROM preset banks); C000-DFFF battery-backed RAM.
The Alpha 2 uses the same paging (its page 7 = image E000 holds its factory presets).

## Presets

200 preset slots. The directory (C6B9, two bytes per slot, 6FED) holds either the address of a packed
preset in user RAM (C000-DFFF) or a **ROM reference**: L = preset number, H = 0 "OPEN" (the selected
BANK's preset L), H = 1-4 bank H - 1. A reference past a bank's last preset reads the empty preset (6FC6).
A factory reset (0319, 701F) makes every slot OPEN with its own number, so slots 1-112 show the selected
bank and the rest are empty.

Four ROM banks, 8 KB each (page 7 + b at A000: name pointer, count, preset pointers, preset lengths):

| BANK | Name | Presets | Image |
|---|---|---|---|
| A | "CLASSIC" | 112 | E000 |
| B | "STUDIO" | 103 | 10000 |
| C | "PERFORMANCE" | 103 | 12000 |
| D | "PRODUCTION" | 86 | 14000 |

Both versions have the same four banks byte for byte.

UTILITY pages (11; the Alpha 2's nine come after these two):

- **SLOT** (3F39, C0E7 = slot): line 1 says what the slot holds, `USER RAM (U)`, `OPEN` or `BANK A, #  6`
  (custom characters drawn from 4DA5 show the letters U and A-D inverted; bank 4 shows as a number,
  `BANK   4, #  6`), line 2 `SLOT = n`.
- **BANK** (3FBD, C0DA): the selected bank, line 1 its name, line 2 `BANK = A`..`D`. Also SysEx setting 09.

HIT RECALL FOR A.R.T. PRESET (and 09 n 4x) loads preset n of the selected bank into the edit buffer (71D6;
n below 112, past the bank's end the empty preset). PRESET 1..112 LOCKED protects slots 1-112 from the
panel's STORE.

**STORE** (70A6) packs the edit buffer and then: an empty buffer (no effects, blank title, MIX 0% / 75% /
75%, 71A3) leaves the slot empty (OPEN, preset FFh); one that packs exactly like a ROM preset becomes a
reference to it (7175 searches banks A-D, each from its last preset, 713C); otherwise it goes to user RAM
(allocator 734C; when it does not fit, the slot is left empty and C0C0 bit 0 cleared).

**Recalling** (7062) unpacks the preset into the edit buffer and then settles it (1B76 / 1B88): every
parameter of an effect not in use takes its record's "unused" value (the value the DSP gets), the others
are limited to their ranges, the bytes after the chain become 0. The editor's unpack does the same.

### Packed form (bit fields)

The SE packs presets as one MSB-first bit stream (6C27, unpacked by 6C8A; the widths come from 6D71):

| Field | Bits |
|---|---|
| byte 0 (X-15 status) | 6 |
| byte 1 (EQ / A.E.S. in use) | 2 |
| byte 2 (configuration) | 6 |
| byte 3 (effects in use) | 5 |
| parameters 1-29 of the effects in use (MIX always) | each value - min in as many bits as max - min needs; none when max = min (SAMPLER STATE) |
| title | 16 x 7 |
| byte 49 (assignments in use) | 8 |
| each assignment in use | controller 8, parameter 5, and with a parameter LOW and HIGH (value - min) in that parameter's width |

The last byte is filled with zero bits. ROM presets are kept in this form without their length (the
bank's length table has it); RAM presets with a length byte first. The generator loads every ROM preset
(404) through the firmware's recall, packs it with the firmware's routine and checks it against the ROM;
the tests check the editor's pack / unpack against these, the empty preset and every configuration with
everything in use (STOREd and recalled by the firmware).

## Effect types: what differs from the Alpha 2

| Type | Alpha 2 v2.02 | SE |
|---|---|---|
| TUNER TYPE | BASS, GUITAR | BASS, GUITAR, BASS12F, GTR 12F; REFRNC lists the notes of the chosen strings (B 31.. / E 82.. / B 62.. / E 164..) |
| REGEN-DDL-L DELAY | 0-122 | 0-125 (up to the longer time the LCD shows) |
| PHASER | X-15 switch #10 SPECL FX | #9 FLNG/CHOR |

Everything else (names, records, all LCD texts of all parameters in all configurations, the 54
configurations) is the same; the generator runs the edit display for every value as for the Alpha 2.

## Settings

As on the Alpha 2, plus:

| s | RAM | Page | Values |
|---|---|---|---|
| 04 | C160 | (read only) | 1 = the edit buffer equals the recalled preset (704E) |
| 09 | C0DA | BANK | 0-3 = A "CLASSIC" .. D "PRODUCTION" (the receiver takes 4 and up as 3); v1.03 resets to A, v1.04 to B |
| 22 | C0B6 | MIDI PROG= (program table page) | 0-199 |

The MIDI program table has 200 entries (C567): a program change recalls entry `program + 128 x (bit 0
of the last CC 32, bank select LSB)`, so CC 32 = 1 reaches entries 128-199. Factory: entry c = preset c + 1.

## SysEx

`F0 1A <ch> 11 <id> ... F7`, received only on MIDI CHANNEL (receiver 5EC7, the same rules as the Alpha 2);
the unit sends on MIDI CHANNEL - 1 (channel 1 when OFF). Numbers and data as pairs (bits 0-6, bit 7).

| ID | Data | Meaning |
|---|---|---|
| 01 | | answer to 41 |
| 03 | s v (40: n n; 41: version) | a setting; 43 41 answers 03 41 03 02 (the word 2.03; v1.04: 2.04) |
| 05 | 98 pairs | the edit buffer (taken by task 6035) |
| 09 | n n | recall preset n; 09 n 4x: the selected bank's preset n into the edit buffer |
| 0A | n n | STORE the edit buffer as preset n (above) |
| 0B | 200 x (L, L pairs or 02 n n) | all presets in the Alpha 2's packed form: memory cleared, each converted to the SE's form (6CEE, then task 6123), 02 n n = OPEN n |
| 0C | 128 pairs | program table entries 0-127 |
| 0D | n n | answer to 4D: C0C0, bit 0 = the last store found room |
| 0F | 200 x (62h, 98 pairs or 02 n n) | answer to 4F: the user RAM presets expanded, 02 + the slot number for the others; not received |
| 11 | c c n n | program table entry c -> preset n (answer to 51 c) |
| 12 | 200 x (L, L pairs or 02 l l h h) | all presets: L (3-80) packed bytes for a user RAM preset, or 02 and the ROM reference (preset l, h as above); received, the memory is cleared first (answer to 52) |
| 13 | 200 pairs | the whole program table (answer to 53) |

Requests: 41, 43 s, 45, 4D, 4F, 51 c, 52, 53. Gone from the Alpha 2: 06 / 46 (single preset), 08 / 48,
4B, 4C. A 10 message (one preset: number, length and bytes as pairs) is still in the sender, but no
request starts it. The MIDI page PRESS ENTER TO sends SEND A PRESET = 05, SEND ENTIRE MPT = 13, SEND ALL
PRESETS = 12.

## Editor

- **Preset**: the Alpha 2's editor (chain, MIX, EQ, A.E.S., the effect cards with the LCD's texts, X-15
  status, PERFORMANCE MIDI). Every change sends the whole edit buffer (05). Actions: Store as preset
  (05 + 0A), Rename, Recall factory preset (09 with 40h: the editor asks for the BANK first to show the same
  preset).
- **Slots**: Presets 1-200 on the unit, then the four ROM banks from the firmware. Edit and Read names
  on the unit's list ask for all presets (52) and the BANK (43 09) and resolve OPEN and bank references.
  Store sends the edit buffer and STOREs it (05 + 0A), the only way to write one preset; Play recalls
  (09). A ROM bank's Play sends the preset to the edit buffer (05).
- **Settings**: the Alpha 2's plus BANK, and the 200-entry program table (11 per entry, 13 / 53 whole).
- Branch Library: the complete dump asks for all presets (52), the program table (53), every setting and
  the edit buffer; OPEN slots are resolved with the BANK in the same dump. Each preset goes back as
  05 + 0A. Files with SE-only messages (11, 12, 13, BANK, version 2.03 / 2.04) are read as SE, files with
  Alpha 2-only ones (06, 08, 0B, 0C) as Alpha 2.
- Head Library translator: the Alpha 2's (kind `effect`); the 98 bytes are the same in both models, so
  presets move between them exactly (values outside a model's ranges are limited).

## v1.04

Generated from v1.04 the tables are the same except: the factory reset sets BANK = B "STUDIO" (one more
byte in the defaults block, 04EE); the version texts; and two adjacent bytes of the configuration table
(1810-1811): configuration 15 ends in TREMOLO instead of PANNER and configuration 16 starts with FLANGER
instead of LOW-PASS, a chain of 22 bytes that overruns the 18-byte effect area. With them the firmware
cannot recall PRODUCTION presets 27 and 28 (configuration 16) as they are packed in ROM, and the panel
could no longer choose REGEN-DDL-S > REVERB-1 > FLANGER > PANNER. Both bytes are their v1.03 value with
bit 0 set, so this looks like a read error in this dump rather than a change; the generator reports
configuration 16 as broken for this image, and the editor uses the v1.03 tables for both versions.

## Open

- A hardware check: the messages, STORE's ROM references and empty slots, 12 / 13 timing, the pacing of
  05 for live edits (`minGap` 120 ms).
- Another v1.04 dump to settle the two configuration bytes.
- The SGE Mach II (1990, same software family, in the collection) is not covered.
