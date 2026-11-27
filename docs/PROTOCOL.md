# Kurzweil K2000 MIDI protocol notes

What KEdit2000 relies on, with the evidence for each item. Firmware addresses refer to the
K2000 OS v3.87J image (`Kurzweil K2000 V3.87J (English) - High/Low.bin`, interleaved HIGH =
even bytes, linked at `0x100000`). The v3.87C image (`Kurzweil-Engine-387C-HI/LO.dat`) is a
different build with the same SysEx command set; its code sits `0x176` bytes higher.

Sources, in order of authority:

1. The K2000 firmware, read in Ghidra (project `K2000`, program `k2000_387J.bin`, functions
   renamed and bookmarked under the `KEdit2000` category).
2. The K2500 Reference Guide, chapter 11 (System Exclusive Protocol), which matches the
   K2000 dispatcher exactly.
3. ConvertWithMoss (git-moss/ConvertWithMoss) for the object byte layouts.
4. k2kremote (lentferj/k2kremote) for timings and offsets measured on a K2000R running 3.87J.

## Transport rules

| Rule | Value | Evidence |
|---|---|---|
| Header | `F0 07 <dev> 78 <type> ... F7` | `MIDI_RouteSysexByManufacturer` (0x178E48) checks 07, then 78 |
| Device ID | Accepted only if `<dev>` equals the K2000 SysEx ID, or the K2000's own ID is 127 | Same function. Sending 127 does not reach a K2000 set to 0 |
| Universal SysEx | `F0 7E <dev> ...` routed to `SDS_HandleUniversalMessage` (0x17C8AC) with the same device rule | 0x178E48 |
| Minimum gap | about 120 ms between SysEx messages; 150 ms is safe | k2kremote measurements; 100 ms stalled the unit |
| Busy states | Disk loads and large deletes make the K2000 deaf for seconds to minutes; traffic then can crash it | k2kremote |

### Field encodings

* Numeric fields are 7-bit groups, most significant first, right justified (`132` = `01 04`).
* `form = 0`: nibbles, high nibble first.
* `form = 1`: bit stream. The 8-bit data is sliced into 7-bit groups from the most significant
  bit; the final group is padded with zero bits on the right. (The psobot Python library pads
  on the left instead, which corrupts data whose bit length is not a multiple of 7.)
* `xsum` = low 7 bits of the sum of the encoded data bytes.

## Message types

The dispatcher `K2SYSEX_DispatchMessageType` (0x179030) binary-searches the sorted type table at
0x1790CC and jumps through the offset table at 0x17909E. It accepts exactly these types:

| Type | Name | Fields | Reply |
|---|---|---|---|
| 00 | DUMP | type(2) id(2) offs(3) size(3) form(1) | LOAD. Silence if the object does not exist |
| 01 | LOAD | type(2) id(2) offs(3) size(3) form(1) data xsum | DACK or DNAK |
| 04 | DIR | type(2) id(2) | INFO (size 0 if missing) |
| 05 | INFO | (accepted as input; reads a 32-byte name, no visible effect) | none |
| 06 | NEW | type(2) id(2) size(3) mode(1) name | INFO |
| 07 | DEL | type(2) id(2) | INFO |
| 08 | CHANGE | type(2) id(2) newid(2) name | INFO |
| 09 | WRITE | type(2) id(2) size(3) mode(1) name form(1) data xsum | DACK or DNAK |
| 0A | READ | type(2) id(2) form(1) | WRITE |
| 0B | READBANK | type(2) bank(1) form(1) ramonly(1) | WRITE ... ENDOFBANK |
| 0C | DIRBANK | type(2) bank(1) ramonly(1) | INFO ... ENDOFBANK |
| 0E | DELBANK | type(2) bank(1) | ENDOFBANK only when type = 0 |
| 0F | MOVEBANK | type(2) bank(1) newbank(1) | ENDOFBANK |
| 10 | LOADMACRO | | MACRODONE |
| **12** | **MEMQUERY** (undocumented) | none | **13**: programFreeK(3) sampleFree(3), sample unit 2 KB |
| 14 | PANEL | 3 bytes per event: type (08 up, 09 down, 0A repeat, 0D wheel), button, 64+clicks | none |
| 15 | ALLTEXT | | 19: 320 characters (bit 7 = reverse video) + NUL |
| 16 | PARAMVALUE | | 19: NUL-terminated string |
| 17 | PARAMNAME | | 19: NUL-terminated string |
| 18 | GETGRAPHICS | | 19: 2560 bytes, 6 pixels per byte, MSB first |
| **79** | **SPLITBLOCK** (undocumented) | sampleId(2) firstNewId(2) | none |
| **7C** | **OBJADDR** (undocumented) | type(2) id(2) | **7D**: type(2) id(2) address as 8 nibbles |
| **7E** | **SUBNAME** (undocumented) | sampleId(2) subIndex(2) name(32, NUL padded) | none |

### Hidden commands in detail

* **12 / 13, free memory.** Cheaper than reading the screen, works in any mode.
* **79, split soundblock** (`K2SYSEX_SplitSoundblock_0x79`, 0x17B37C). For each sub-sample header
  of soundblock `sampleId`, allocates a new soundblock at the next free ID at or above
  `firstNewId`, and copies that header and its envelope data. This is how a stereo pair or
  multisample block becomes separate samples.
* **7C / 7D, object address** (`K2SYSEX_ReplyObjectAddress_0x7D`, 0x17A370). Returns the RAM
  address of an object's handle, or 0. Useful only for debugging; there is no memory-write
  command to go with it.
* **7E, sub-sample name** (`K2SYSEX_SetSubsampleName_0x7E`, 0x17B2C0). Refused while the
  soundblock is open in an editor. Grows the object and stores the name after the headers,
  updating the header's self-relative name offset.

### DNAK codes

1 object open in the K2000 editor, 2 checksum error, 3 ID out of range, 4 object not found or
bad offset, 5 memory full.

## Live editing: why partial LOAD works

The LOAD handler (0x179138) first calls `OBJ_IsOpenInEditor` (0x10A344). If the object is the
one open in the K2000's own editor, the K2000 answers DNAK code 1. Otherwise the data goes
into a working copy, and `K2SYSEX_FinishLoadReplaceObject` (0x17AAAC):

1. For programs, recounts the layers and resizes the copy.
2. Validates the copy, deletes the old object and installs the new one.
3. Calls `OBJ_MarkChangedForPlayback` (0x10A47E), which flags the current program and every
   MIDI channel playing this object as changed, so following notes use the new data.
4. For effects (type 113), reloads the effect into the effects processor.
5. For the Master table (type 100, ID 16), applies the master parameters.
6. Posts a display refresh.

So a LOAD of one byte at a field's offset is a complete live edit. KEdit2000 sends one LOAD
per change, waits for the DACK before the next message, and collapses queued edits to the same
offset into the latest value.

## Sample Dump Standard

`SDS_HandleUniversalMessage` (0x17C8AC) handles:

| Sub-ID | Meaning |
|---|---|
| 01 | Dump header: creates a sample, answers ACK or NAK |
| 02 | Data packet: ACK or NAK |
| 03 | Dump request: the K2000 sends header and packets (RAM samples only) |
| 06 01 | Identity request: replies `F0 7E dev 06 02 07 ...` |
| 7C / 7D / 7E / 7F | Wait / cancel / NAK / ACK |

SDS fields are 7-bit, least significant byte first. In a dump request, bits 0-9 of the sample
number select the soundblock ID and bits 10-13 select the sub-sample (for example the right
half of a stereo pair). The K2000 always sends 16-bit data.

Receiving (`FUN_0017bdfa`): an incoming dump header with sample number n creates soundblock
n + 1. If that is 1 (n = 0), the first free ID from 200 is used; if it is below 200, 200 is
added. To land on ID T (200-999), send n = T - 1. The sub-sample bits are ignored: every dump
creates a mono, one-header soundblock and replaces an existing soundblock at that ID unless it
is open in an editor. The header handler sets start = 0, loop start and end from the dump's
loop points, alt start = length - 1 when there is audio after the loop, and the loop flags,
then rebases all pointers by the sample memory pointer.

### Sample memory

Sample RAM is a bump allocator. The free pointer at `A5+0x5646` is written only at boot
(memory sizing and restoring volatile samples), by Sample Dump and disk loads (which add to
it), and by the sample editor's resampler. Deleting a soundblock never frees or moves its
audio. The memory comes back only with Delete Everything or a restart (boot deletes
soundblocks whose headers have flag 0x10, volatile RAM data).

This makes full-fidelity imports possible over MIDI: send each audio range by SDS into a
temporary ID, DUMP that soundblock to read its start pointer, WRITE the original soundblock
(all headers, loops, names, flags) with its pointers moved by (start - original offset), and
delete the temporary soundblock. The audio stays where the dump put it.

## Object types

| Type | Object |
|---|---|
| 100 | Table (ID 16 = Master parameters, ID 35 = macros) |
| 103 | Intonation table |
| 104 / 105 | Velocity / pressure map |
| 111 | Quick Access bank |
| 112 | Song |
| 113 | Effect |
| 132 | Program |
| 133 | Keymap |
| 134 | Soundblock (sample) |
| 135 | Setup |

Bank `b` holds IDs `b*100` to `b*100+99` (bank 0 starts at 1). Factory ROM objects use IDs
1-199; a RAM object at the same ID hides the ROM one.

## Program object

A sequence of segments, each a tag byte followed by fixed-length data, ended by a zero word.
Segments after a LAYER segment belong to that layer.

| Tag | Segment | Length incl. tag |
|---|---|---|
| 08 | Program common | 16 |
| 09 | Layer | 16 |
| 0F | Effect | 8 |
| 10-11 | ASR 1-2 | 8 |
| 14-15 | LFO 1-2 | 8 |
| 18-1B | FUN 1-4 | 4 |
| 20 | Envelope control | 16 |
| 21-23 | AMPENV, ENV2, ENV3 | 16 |
| 40 | Calibration: keymaps and pitch | 32 |
| 50-53 | DSP blocks F1, F2, F3, AMP | 16 |

### The complete segment set (checked on the unit, OS 3.87J, 2026-11-25)

The K2000 keeps every program with all its segments, in this order: program (08), the four
program-level controls GASR2, GFUN2, GLFO2, GFUN4 (11, 19, 15, 1B; zeros in every ROM program),
effect (0F), then per layer: layer, ASR1, ASR2, FUN1, FUN2, LFO1, LFO2, FUN3, FUN4, envelope
control, AMPENV, ENV2, ENV3, calibration, F1-F4 (09 10 11 18 19 14 15 1A 1B 20 21 22 23 40 50-53).

**A program written by SysEx without the complete set is not taken**: the K2000 answers DACK but
stores an empty program (the header bytes, then every segment zeroed: algorithm 0, no keymap, no
sound). Program files leave out the segments a program does not use: none of 1080 programs in 23
.KRZ files had the complete set (K2KFARM, user files). The K2000's own disk loader fills them in.
`completeProgram` (`disk/krz.js`) does the same before Disk Import (and Load from Head Library)
writes a program: missing segments get the values the OS gives a new program (its default program,
ROM 88548h, `DEFAULT_PROGRAM` in `fwparams.js`), the program-level controls zeros; nothing present
changes. Checked: ROM program 2 copied to RAM by WRITE came back byte for byte; TR909-0 and
Chick Lead 1 from .KRZ files came back empty before and byte for byte after completion.

### Algorithms

`model/algorithms.js` holds the signal flow of the 31 algorithms (which block feeds which, wires
that bypass blocks under or over them, two-wire outputs, hard sync), read from the diagrams in the
K2000 Reference Guide (chapter 26; drawn in a symbol font and decoded glyph by glyph), checked
against the blocks and widths the OS offers per algorithm. The Program Editor's Algorithm card draws
it with the layer's functions and describes it in words. Changing the algorithm sets each block the
new algorithm has to a function it takes (kept when allowed, else the first of the block's list),
so its pages appear (checked on the unit: algorithm 1 to 22 set F1 LOPASS, F2 x GAIN, F3 LOPASS,
F4 x AMP, read back as sent). Algorithm 30 (HM-1-HS-MA) is the least certain reading: F3 drawn
with two inputs (the slave and the master oscillator), F4 mixing F3 and the master.

### Parameter map from the OS

The K2000 OS describes every front-panel parameter in ROM, and `tools/k2000/extract_params.py`
turns that into `js/devices/kurzweil-k2000/model/fwparams.js`. Sources, by ROM object:

| Object | Meaning |
|---|---|
| Type 109 ("mel...") | Page layouts: 6-byte items `[type][s16 rel][group][index]`. Type 1 points to `[labelCol][labelRow][6][valueCol][valueRow][width] label`, type 2 is a soft button |
| Type 107 | Page titles and modes: `[page id][parameter group]`, e.g. 52 LAYER, 55 PITCH, 90 FRQ, AE AMP |
| Table 100:8 "pids" | Parameter table: s16 offsets per group to `[u16 count][u16]` + 8-byte entries `[s16 rel descriptor][u16 location][u16 context][u16 offset]` |
| Table 100:16 | Master table (global, MIDI and per-channel settings) |
| Table 100:33 | Control source names |
| Types 102, 114, 115 | Algorithm, LFO shape and FUN function names |

A descriptor is `[u16 edit routine][u16 display routine][u16 parse routine][s16 rel format]
[u8 storage][u8 coarse step][u8 shift][u8 width][u16 range count]` then `[s16 min][u16 span]`
per range. Storage: low 3 bits 1 s8, 2 s16, 3 s32, 5 u8, 6 u16; 0x08 bit field (shift, width);
0x10 clamps at the ends. Routine numbers index the function table at 0x186D06
(dispatcher 0x15E690); 0x14B is the generic value editor (0x15E8F4), 0x268 prints
"<id> <object name>".

Value texts are produced by running each parameter's own display routine in a 68000 emulator
(`tools/k2000/fwemu.py`, needs `pip install unicorn`), with object lookups (0x1032EA, 0x103310, 0x10B90A) answered
from the ROM object area. So "C 4", "2POLE LOWPASS", "-1.20dB/key" or "L  * R" come out exactly
as the K2000 prints them.

Location codes select the edited object. Program codes match the K2000's edit buffer layout
(0x30-byte header, 0xE0 bytes per layer); in a stored program they map to segments by tag, and
offsets count the tag byte:

| Code | Segment | Code | Segment |
|---|---|---|---|
| 107 | Program common (08) | 112 | Envelope control (20) |
| 108 | Layer (09) | 113 | Effect (0F) |
| 109, 10A | LFO1, LFO2 (14, 15) | 114-117 | FUN1-4 (18-1B) |
| 10B, 10E, 118, 119 | Global LFO2, ASR2, FUN2, FUN4 (program header) | 11A | The DSP block being edited |
| 10C, 10D | ASR1, ASR2 (10, 11) | 11B-11E | F1, F2, F3, AMP (50-53) |
| 10F-111 | AMPENV, ENV2, ENV3 (21-23) | 11F | Keymap / pitch / algorithm (40) |
| FE, 100 | Master table | FF | Master table, per MIDI channel (base 0x58, 16 bytes each) |

DSP pages: each function's width in blocks comes from 0x117C5A, its name from display routine
0x89, and the table at 0x1881CF (`[code or 0][start block][block][title]`) picks the page for
each block (FRQ, RES, AMP, PCH, ...). The algorithm number is at offset 30 of segment 40 and each
block's function code at offset 1 of segments 50-53.

Checked against the 1,075 programs in a factory library: the map reads in-range values for 294
of 334 page parameters in every program. The exceptions are FUN inputs and effect mod targets
(which allow inverted control sources and per-effect targets) and a handful of DSP amounts.

KeyTrk bytes use a three-part scale: n <= 8 gives 5n cents per key, n <= 33 gives
40 + 2(n - 8), above that 90 + (n - 33). 43 = 100 cents per key.

### Firmware conversion tables

Extracted by `tools/extract_rom_tables.py` into `js/model/romtables.js`:

| Address | Count | Meaning |
|---|---|---|
| 0x1FB404 | 256 | LFO rate in 1/100 Hz, indexed by the raw byte |
| 0x1FC204 | 128 | DSP frequency in Hz, indexed by signed semitone + 48 (C0 = 16 Hz) |
| 0x1F9604 | 256 | ENV2 to frequency depth in cents, indexed by signed byte + 128 |
| 0x1FA204 | 256 | LFO to pitch depth in cents, indexed by signed byte + 128 |
| 0x1FBA04 | 256 | Envelope and ASR times in milliseconds (0 to 60 s) |

### Control sources

0 OFF, 1 MWheel, 2 Breath, 4 Foot, 5 PortTim, 6 Data, 7 Volume, 8 Balance, 10 Pan, 11 Express,
other values below 96 are MIDI controllers (64 Sustain, 65 PortSw, 66 SostPd, 67 SoftPd,
69 FrezPd), 32-63 are global sources (32 Chan St, 33 MPress, 35 PWheel, 38-42 global ASR/FUN/LFO,
47-59 clocks, 60-63 global phase and random), 96 Note St, 97 Key St, 98 KeyNum, 99 BKeyNum,
100 AttVel, 101 InvAVel, 102 PPress, 103 BPPress, 104 RelVel, 105 Bi-AVel, 106-107 VTRIG,
108-109 RandV, 110-111 ASR, 112-113 FUN1-2, 114 LFO1, 115 LFO1ph, 116 LFO2, 117 LFO2ph,
118-119 FUN3-4, 120 AMPENV, 121 ENV2, 122 ENV3, 123 Loop St, 124 PB Rate, 125 Atk State,
126 Rel State, 127 ON.

## Keymap object

Header (16-bit big-endian): base sample ID, method, base pitch (cents), cents per entry,
entries - 1, entry size, then eight self-relative pointers to the entry table for each dynamic
level (ppp..fff). Method bits: 0x10 16-bit tuning, 0x08 8-bit tuning, 0x04 volume adjust,
0x02 per-entry sample ID, 0x01 sub-sample number. Entry `i` starts at MIDI note
`12 + (basePitch + i * centsPerEntry) / 100`.

## Soundblock object

12-byte header: base ID(2), headers - 1 (2), offset to the first header (2, = 8 from its own
field), flags(1, bit 0 stereo), pad, copy ID(2), pad(2). Then 32-byte sample headers:

| Offset | Field |
|---|---|
| 0 | Root key |
| 1 | Flags: 0x80 one-shot (not looped), 0x40 data in RAM, 0x10 volatile (deleted at boot) |
| 2 | Volume adjust, signed, 0.5 dB steps |
| 3 | Alt volume adjust |
| 4 | Max pitch (cents) |
| 6 | Self-relative offset to the sub-sample name |
| 8, 12, 16, 20 | Start, alt start, loop start, end (inclusive), in 16-bit words |
| 24, 26 | Offsets to the envelope data |
| 28 | Sample period in nanoseconds |

## Kurzweil object files (.KRZ, .K25, .K26)

All values are big-endian.

| Offset | Field |
|---|---|
| 0 | "PRAM" |
| 4 | u32 file offset of the sample data |
| 18 | u16 OS version x 100 of the instrument that saved the file (387 = 3.87) |
| 20 | u8 format number (seen: 3, 4, 5) |
| 32 | Blocks |

Each block starts with a negative s32: minus the block size including that field. A
non-negative value ends the list. A block holds one or more object entries back to back:

| Offset | Field |
|---|---|
| 0 | u16 hash. Bit 15 set: file type = hash >> 10, ID = hash & 1023. Otherwise type = hash >> 8, ID = hash & 255. |
| 2 | u16 entry size. The next entry starts at the size rounded up to even; 0 ends the block. |
| 4 | u16 name offset. The NUL-terminated name starts at entry + 6. |
| 4 + name offset | Object data, in the same format the K2000 sends over SysEx |

SysEx type = file type + 96 for 16-bit hashes (36 program = 132, 37 keymap = 133, 38 soundblock
= 134, 39 setup = 135). 8-bit hashes carry the SysEx type directly (113 effect, 112 song).
Soundblock pointers are word offsets from the sample data offset. Audio is 16-bit big-endian.

K2500/K2600 files use the same container. They add types the K2000 does not have (137 and
140-147, for example KDFX studios and presets). Their programs have mode 4 (K2600) in the first
data byte of the program segment, where a K2000 program has 2. K2000 drum programs can have up
to 32 layers; normal programs use up to 3.

## Disk and CD images

Kurzweil formats floppies, SCSI disks and its CD-ROMs as plain DOS FAT (FAT12/16/32) volumes,
usually without a partition table (OEM names seen: KMSI, KCDM1.2, INSIGNIA; 512-byte sectors).
CD images come with 2048-byte sectors (.iso) or raw 2352-byte sectors (.bin). Raw sectors start
with the sync pattern `00 FF x10 00`, byte 15 is the mode, and the 2048 data bytes start at 16
(MODE1) or 24 (MODE2). Cue sheets carry absolute paths from the ripping machine, so the .bin is
matched by file name. The K2000 also reads ISO 9660 discs.

## Open questions

* Effect parameter pages (EditEffect, title objects B6-D0) and the effect object layout are in
  the same tables but not yet in the editor.
* The ranges the OS allows for FUN inputs and FX mod targets are narrower than the values found
  in factory programs; the extra values are probably inverted sources.
* What INFO (05) does when sent to the K2000.
