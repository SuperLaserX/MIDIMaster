# Roland JV-2080: MIDI implementation from the v1.02 firmware

The editor (`js/devices/defs/roland-jv2080.js`) is built from the firmware: the address map,
every range and default, the edit-screen labels and option lists, the names of the EFX
parameters for each EFX type, and the bank-select decoder. It was checked against a JV-2080
over MIDI (see "Checked on a unit" below).

## Getting the firmware

The collection holds Roland's updater `JV2080 (1.02).exe`. It is an LZH self-extractor
(7-Zip opens it) with 24 MIDI files. Each file is a run of DT1 messages to model 6A at
address `70 aa bb cc`, 256 data bytes each. Every 8 data bytes carry 7 firmware bytes: the
first holds the high bits (bit 0 belongs to the next byte), then 7 low-bit bytes. The 7-bit
address is the byte offset in a 2 MB flash (files 1-23 and 32; the rest is blank).
`tools/roland/jv2080_image.py` rebuilds the image; the CPU is a big-endian SuperH (SH-2
code), with flash mapped at 0x0E000000. The updater's own receiver is at 0x0E147038.

## Address map

The DT1 builder (0x0E12294C) asks the decoder at 0x0E122554 for an address. Each block is a
contiguous range of internal parameter IDs that maps one to one onto the block's bytes:

| IDs | Block | Size | Temporary area | User | Card |
|---|---|---|---|---|---|
| 000-061 | System common | 98 | 00 00 00 00 | | |
| 08B-096 | Scale tune, performance part p | 12 | 00 00 1p 00 | | |
| 098-0A3 | Scale tune, patch mode | 12 | 00 00 20 00 | | |
| 0C7-10A | Performance common | 68 | 01 00 00 00 | 10 nn 00 00 (nn 00-1F) | 20 nn 00 00 |
| 113-12C | Performance part p | 26 | 01 00 1p 00 | 10 nn 1p 00 | 20 nn 1p 00 |
| 13A-183 | Patch common | 74 | 03 00 00 00 (patch mode), 02 pp 00 00 (part pp) | 11 nn 00 00 | 21 nn 00 00 |
| 19F-21F | Patch tone t | 129 | +00 00 10 00 + t × 00 00 02 00 | | |
| 23B-246 | Rhythm set name | 12 | 02 09 00 00 | 10 40 00 00, 10 41 00 00 | 20 40 00 00 |
| 24B-284 | Rhythm note, key k | 58 | 02 09 kk 00 | 10 4n kk 00 | |

The bases in the firmware are plain 7-bit integers (aa << 21 | bb << 14 | cc << 7 | dd), so
a 129-byte tone carries into the next address byte. Part 10's temporary area (02 09) is the
rhythm set; the other parts' patches are at 02 pp. There are two user rhythm sets.

## Ranges and defaults

The value getter (0x0E12B8A4) reads an 8-byte descriptor per ID from 0x0E058100:
`[u16 mask][internal byte][shift][default][min][max][0]`. `tools/roland/jv2080_params.py`
dumps them into `js/devices/defs/roland-jv2080-fw.js`.

## Labels, option lists and EFX parameters

`tools/roland/jv2080_ui.py` writes `js/devices/defs/roland-jv2080-ui.js` from three tables
(`tools/roland/jv2080_screens.py` prints the screens for checking):

- **Screens** (0x0E078ECC, 288 records of `[u32 text][u32 fields][u16 count][u16 flags]`).
  The text is the title and `[x][y]label` entries; each field is 16 bytes
  `[u16 field][..][u16 display][u16 arg][..][x][y]`. The field table at 0x0E08C0AC (8 bytes
  per field) gives the parameter ID, so every on-screen label ties to an address.
- **Option lists** (0x0E091958, 118 pointers; each list is a width byte and fixed-width
  strings). Display routine 0x36 with argument n shows list n.
- **EFX screens**: one per EFX type, in type order (40). Within a type, the virtual
  parameter ID minus the type's first ID is the EFX parameter slot; hidden slots (the
  unused feedback slot of the chorus types) keep their place. The editor relabels EFX
  parameters 1-12 when the EFX type changes, shows the type's option lists, pans as L/R
  and gains (display 0x68/0x1C) as -15..+15 dB.

Every patch-common, tone and rhythm name in the editor matches a screen label. The option
lists from the firmware corrected several earlier guesses: tone delay mode (NORMAL, HOLD,
PLAYMATE, CLOCK-SYNC, KEY-OFF-N, KEY-OFF-D, TEMPO-SYNC), the fourth choice of the
TAP/HOLD/PEAK control switch (SOSTENUTO), patch control sources 2/3 (16 entries), EFX
sources (PERFORM, PART 1-9, 11-16), and the patch category names (patch common 49h).
Performance common 41h is the performance clock source (PERFORM/SYSTEM).

## Bank select and selection

The program change handler (0x0E12A4C6) sends every part's bank select through the decoder
at 0x0E1230BC:

| MSB/LSB | Group | Reported as (type, ID) |
|---|---|---|
| 80/0 | USER | 0, 1 |
| 82/0 | CARD | 0, 2 |
| 81/0-4 | PR-A, PR-B, PR-C, PR-D (GM), PR-E | 0, 3-7 |
| 84/2k, 84/2k+1 | expansion slot k (A-H), patches 1-128 and 129-256 | 2, board number |
| 83/x | PCM card (not a patch group; ignored) | |

Performances on the control channel: USER 80/0 (performance numbers 0-31), PR-A 81/0
(64-95), PR-B 81/1 (96-127). The type/ID pairs and the performance numbers are as a unit
reports them in system bytes 02-05 and 01.

A panel mode change (system byte 00) takes the JV-2080 about half a second, and a program
change sent meanwhile lands late; replies can also take more than 400 ms to start while a
patch loads. The editor therefore switches the mode only when it differs and confirms every
selection by reading system bytes 00-05 before it reads the temporary area.

## Preset names, wave names and expansion boards

The preset patches and performances live in the wave ROM, not the updatable flash. Their
names (`js/devices/defs/roland-jv2080-presets.js`) were read from a unit by selecting each
preset and reading the temporary name. Wave names are in the wave ROM too: the 60-byte name
records in the flash (0x0E061FC8 and 0x0E066C30) are not in wave-number order (a preset
using INT-A 4 plays "Ac Piano1 A", record 0), so tones show wave numbers only.

Expansion boards cannot be listed by SysEx. **Find boards** selects patch 1 of each slot
(starting from USER 1, so an empty slot leaves the selection unchanged), records the board
numbers, and selects the previous patch again. **Read names** on an expansion bank selects
each patch in turn; a board may hold fewer than 128 patches in a bank (an SR-JV80-98 holds
100), and the first number the JV-2080 does not select ends the scan.

## Bytes without a screen

System 28h-61h, performance common 40h and part 14h-19h are kept and editable with their
firmware ranges, but no JV-2080 screen shows them. The firmware is shared with Roland's XP
keyboards (it contains disk and song messages), and these bytes look like their keyboard
settings (system 31h/34h, range 1-104, hold CC 7 and 11; 3Dh-51h are seven
switch/MSB/LSB triplets 80/0, 81/0-3, 84/0-1). They are labelled "Byte nnh".

## When the JV-2080 connects

The editor reads the system block first (it gives the patch receive and control channels),
then the temporary patch and performance, then the names of the 128 user patches and 32
user performances (12-byte RQ1 reads, which change nothing on the unit). On a unit this
takes about 40 seconds and runs in the background. With Tx Edit Data on, DT1 messages the
JV-2080 sends for panel edits update the open editor page.

## Checked on a unit

A JV-2080 (identity `41 6A 00 03 00 00 00 00 00`, device ID 17) with six SR-JV80 boards,
through `tools/roland/jvlive.py` and through the app in Chrome (Web MIDI):

- every block reads back complete at the documented addresses and sizes;
- a parameter changed in the editor reads back from the unit;
- bank select and performance selection as in the tables above, presets PR-A..PR-E and
  performances PR-A/PR-B by name;
- Store: a user patch written back unchanged into its memory reads back identical;
- the patch of performance part 1 at 02 00 00 00; both user rhythm sets;
- Find boards and expansion name scans, restoring the previous patch.

`tools/roland/jv_restore.py` puts a unit back to a snapshot the tests write
(`re/jv2080/live_backup.json`).

## Not covered

Data cards (none was available to test), GM mode, wave names, and receiving panel edits
(implemented, not tried: it needs Tx Edit Data and someone at the panel).
