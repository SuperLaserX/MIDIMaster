# Roland JP-8000: MIDI implementation from the OS v1.05 firmware

The editor (`js/devices/defs/roland-jp8000.js`) is the JP-8000 model config over the code it
shares with the JP-8080 editor (`roland-jp.js`). Its tables are in `roland-jp8000-fw.js`, which
`tools/roland/jp8080_fw.py` regenerates from `jp8000_v1.05.bin`. Read
[roland-jp8080.md](roland-jp8080.md) first: everything there applies unless it is listed below.

**Validated in an emulator of its OS, not on hardware.** No JP-8000 was available. The JP-8000's
own OS v1.05 runs in the H8/300H emulator (`tools/roland/jp8000/emu.mjs`, on the core in
`tools/novation/h8`), and every message the editor sends was checked against the OS's own SysEx
receiver and transmitter (`tools/roland/jp8000/check_editor.mjs`, see "Emulator"). The SysEx
format is also the JP-8080's, which was checked on hardware.

**Owner's manual.** Roland's public PDF (`JP-8000_OM.pdf`, from the JP-8000 support page; a scan,
138 pages). Its parameter address map (pages 121-125) names every block and byte; the copy is kept
in the gitignored `re/jp8080/manual/` with the page images. It agrees with the editor everywhere
(panel switch names and value orders, ranges), and it named system 12h-16h. Two differences:

- It gives the patch as 239 bytes (00-EEh). OS 1.05 has one more, EFh Env Type in Mono
  (RESET/FLOWING), and sends and takes F0h bytes (checked in the emulator).
- It lists pattern data (08 nn 00 00) and motion data at 09 00 00 00 / 09 40 00 00 ("Motion
  Controller A / B"). OS 1.05 answers all four motions, 09 00, 09 40, 0A 00 and 0A 40, as on the
  JP-8080.

## Firmware

Hitachi H8/3002 (H8/300H core). The image is loaded at 0, with plain 32-bit vectors: a boot block
(reset at 200h, MIDI update loader) that starts the OS at 4100h; the OS vectors are jumps at 4000h.

| Table | Address | Note |
|---|---|---|
| SysEx dispatcher | `05880` | |
| Address decoder | `2C6EE` | |
| SysEx parameter table | `6D830` | 190h entries |
| UI table | `72F88` | Patch class 3 |
| Knob descriptors | `70B04` | |
| Menu records | `6E4F0` | 2Ch bytes each, not 2Eh |
| Option lists | `73E10`, offsets at `753FE` | |
| Format handlers | `6FF30` | |
| Per-id table | `53E8C` | 12 bytes an internal id: min, max, init, ..., knob flag 81h, switch 82h (not 82h/83h) |
| Bank select MSB table | `6E278` | FF 50 51 FF |
| Preset patches | `562B6` | A0h bytes each, 128 records |
| Preset performances | `5B2B6` | 180h bytes each, 64 records |

`re/jp8080/work/extract2.py jp8000` prints the joined tables.

**Memory.** RAM from 200000h (stack 20F000h). The battery-backed data starts at 210000h with the
signature "JD-4 VER1.00 '96" (compared at boot by `13056`; a second copy at 21B5D0h); without it
the OS shows "Memory Damaged!". The system settings are internal ids A0h-118h at 210010h + id -
A0h (SysEx system bytes 00-16h are ids A0h-B6h); the Device ID is at 210085h (id 115h) and the Rx
Exclusive switch at 210086h (id 116h, tested by the dispatcher at `5964`). At boot `12F26` puts
every system byte outside its range (table `5460C`) back to its default.

**Initialize** (SHIFT + INIT/UTIL, "Initialze[WRITE]"): `13422`, with the type in R0 (0-0Dh, the
page's list) and a jump table at `68934`. It writes the memory signature first.

## SysEx

`F0 41 dev 00 06 ...`, with the same RQ1 (11h), DT1 (12h) and identity request as the JP-8080.
There is no 3Ah channel-message message.

| Address | Size | Block |
|---|---|---|
| 00 00 00 00 | 17h | System |
| 00 00 10 00 | 30h | RPS pattern loop length per key, C#2-C6 (1-4 measures; menu "Loop Length") |
| 00 00 20 00 | 4 | Motion A[1] A[2] B[1] B[2] loop length, 1-8 measures |
| 00 00 30 00 | 2Ah | Tx/Rx CC per knob (MODE2), Ribbon Up/Down |
| 01 00 00 00 | 24h | Temporary performance, common |
| 01 00 10 00 / 11 00 | 7 | Upper / lower part (no Patch group byte) |
| 01 00 40 00 / 42 00 | F0h | Upper / lower patch (the JP-8080 adds F0h-F7h) |
| 02 nn mm 00 | F0h | User patch n, 0-127 |
| 03 nn 00 00 | | User performance n, 0-63 |
| 08 nn 00 00 | | RPS pattern n (key C#2 + n, 0-47): see "RPS patterns" |
| 09 00 ... 0A 40 | | Motion data, the same format as the JP-8080 |

There is no voice modulator (01 00 08 00).

**Two-byte values.** Their combined ranges are in the per-id table (`53E8C`), and the receiver keeps
the old value when a DT1 sends one outside them: TEMPO 20-250 (init 120), Trig Source Note 0-128
(init 128 = ALL), depths 0-254 (127 = 0), OSC2 Range depths 77-177, OSC2 Fine/Wide depths 27-227.
The editor takes them from the table (`RANGES2` in the generated file; the JP-8080 table has the
same values).

## Labels that differ from the JP-8080

- **Ribbon instead of Control.** The depth matrix (patch 4Ah-9Ah) is "Ribbon", the JP-8000's
  ribbon controller. Patch 98h is PITCH BEND (Ribbon), the ribbon's pitch bend switch. Tx/Rx
  00 00 30 28/29 are Ribbon Up / Ribbon Down: the messages of the right-hand and left-hand halves
  of the ribbon (manual: "Tx/Rx Setting (Ribbon Controller Up/Down)", 00-5Fh: EXCLUSIVE cannot be
  assigned to them).
- **Chorus Type** (patch 3Dh) has 12 types; the JP-8080's Multi-FX Type has 13.
- **Env Type in Mono** (patch EFh) is RESET or FLOWING.
- **Pedal Assign** (performance 1Ch) and **Remote Ctrl CH** (system 09: 1-16, ALL, OFF) have
  JP-8000 menus. **Motion Set** (system 0Dh) has a menu on both models.
- **OSC2 waveform** has three values: SQUARE, TRIANGLE, SAW (the manual: PULSE, TRI, SAW).
- **The patch and performance bank** is USER or PRESET. PRESET is the ROM set: the same 128
  patches as JP-8080 PRESET 1, and the same 64 performances as JP-8080 PRESET 1.
- **Display formats.** The JP-8000's format codes 0Fh, 11h and 13h are the JP-8080's 18h (input
  quantize: OFF, then the note glyphs of table `6FF22`, handler `31A18`), 1Ah (remote channel) and
  1Ch (OSC2 range). (Until 2026-11-27 the editor mapped FFh instead of 0Fh, so Input Quantize
  showed plain numbers.)
- **The CC list** of the Tx/Rx table is option list 10 in the JP-8000 OS (11 in the JP-8080's;
  the entries are the same: OFF, CC1-31, AFTERTOUCH, CC33-95, EXCLUSIVE). (Until 2026-11-27 the
  editor read list 11, which in the JP-8000 OS is the ProgChg list, so the Tx/Rx menus showed
  wrong text.)

**An OS 1.05 bug with EXCLUSIVE.** When Tx/Rx Edit SW is ON and Tx/Rx Edit Mode is MODE2, `12A60`
builds a list of knobs per CC in a 96-entry table at 21B450h (one long word per CC). Its MODE2 branch
(`12D4E`) skips only 0 (OFF), so a knob set to EXCLUSIVE (96) writes a list pointer at 21B450h +
96 x 4 = 21B5D0h, over the first four bytes of the second memory signature. At the next power-on
the OS shows "Memory Damaged!" (the user data stays: checked in the emulator, a stored user patch
read back unchanged). The panel's Tx/Rx menu reaches the same code, so this is the JP-8000's own
behaviour; the editor offers EXCLUSIVE (it is a valid value) and says so in the Tx/Rx group note.
The JP-8080 OS has the same table code (`20780`, table 22457Ch); what lies after its table was not
checked.

Panel switches show no text on the JP-8000 either; their names and values are those of Roland's
JP-8000 address map, which match the JP-8080's. Bend Range Up/Down (patch 43h/44h) have no JP-8000
menu; the map gives them 0-24 semitones, as on the JP-8080.

## System 12h-16h

No menu of either firmware shows these bytes. Roland's JP-8000 address map names them:

| Byte | Name (address map) | Values | What the OS does with it |
|---|---|---|---|
| 12h | Factory Preset Menu | 0-0Dh: the Initialize page's list (option list 16): PATCH: TEMP, PATCH: USER ALL, PERFORM: TEMP, PERFORM: USER ALL, PATTERN: ALL, PATTERN: C#2-C4, PATTERN: C#4-C6, PATTERN: CURRENT, MOTION: ALL, MOTION: SET A-1 ... SET B-2, FACTORY PRESET | stored, sent and received only |
| 13h | Bulk Dump Menu | 0-11h: the Bulk Dump page's list (option list 17): ALL, PATCH: USER ALL, USER A, USER B, TEMP UPPER, TEMP LOWER, TEMP UP&LO, PERFORM: USER ALL, TEMP, PATTERN: ALL ... CURRENT, MOTION: ALL, SET A-1 ... SET B-2 | stored, sent and received only |
| 14h | Keyboard Shift | -2 to +2 octaves (2 = 0) | SHIFT + -OCT/+OCT turns the OSC SHIFT buttons into Keyboard Shift buttons; read by the key code (`27A66`, `2FFEE`) and shown on the OCT LEDs (`32CEC`, UI B2h) |
| 15h | Ribbon Relative | OFF, ON | panel RIBBON CONTROLLER [RELATIVE] (LED `32D3A`, ribbon code `38C24`) |
| 16h | Ribbon Hold | OFF, ON | panel [HOLD] (LED, ribbon code `38CF8`) |

Evidence for 12h and 13h. The Initialize page (menu record `6EB20`, label "Initialze[WRITE]",
format 4 list 16, UI 143h) and the Bulk Dump page (record `6EB4C`, list 17, UI 144h) keep their
selection in work RAM (ids 146h/147h at 209A74h/209A75h), which starts at the first entry after
power-up. In the emulator the only code that reads 210022h/210023h is the boot range check `12F26`
and the RQ1 transmitter (`2C9C0`, by table index); only the DT1 receiver and the Initialize routine
write them. With 12h = 5 and 13h = 7 sent by DT1 (and kept through a power cycle), the pages still
open at PATCH: TEMP and ALL, and choosing other entries there does not change the bytes. So OS 1.05
keeps them only so that a bulk dump restores exactly; the editor shows them with the address map's
names and the pages' lists, and says so.

Evidence for 14h-16h, in the emulator: SHIFT + +OCT, then +OCT, sets 14h from 2 to 3; -OCT sets
it to 1. The RELATIVE and HOLD switches (switch 113, 121) toggle 15h and 16h.

## RPS patterns

Unlike the JP-8080 (whose OS has no SysEx for them), OS 1.05 reads and writes the 48 RPS patterns
by address, 08 nn 00 00 for key C#2 + n, in the motions' 7-in-8 packing and DT1 messages of up to
E7h bytes. One RQ1 from 08 00 00 00 with size 00 30 00 00 answers every pattern (the factory set:
161 messages, about 31 KB). Each event is 6 bytes:

| Byte | Meaning |
|---|---|
| 0 | Ticks to wait after the event (MIDI clocks: 24 a beat, 96 a measure) |
| 1 | 0 |
| 2 | Note number; 80h ends the pattern (its wait fills the pattern to its length) |
| 3 | Velocity (end event: 16h) |
| 4-5 | Gate time in ticks, high byte first |

Every factory pattern is 384 ticks (4 measures). The editor reads and writes them through the
Branch Library: a request "All RPS patterns (C#2-C6)" and a step of the complete dump; each pattern
is a library item ("RPS pattern C#2" ...) that can be sent back. Byte 1 was 0 in every factory
event; the player was not traced further.

## Emulator

`tools/roland/jp8000/emu.mjs` runs OS 1.05 (the image `re/jp8080/fw/jp8000_v1.05.bin`, not in
git) on the H8/300H core and machine of `tools/novation/h8` (the JP-8000 uses the same H8/3002
peripherals as the Novation boards: SCI0 for MIDI at 31250 baud from 16 MHz, ITU timers, ports).

- **Board.** LCD (HD44780 type: instruction 600004h, data 600005h). Four DSPs at 400000h,
  404000h, 408000h and 40C000h (control at +2000h; written, their status reads 0). Panel switches:
  a 16-row matrix scanned by the ITU1 interrupt `3873E`; the row index is at 20C0BEh and the row is
  read from port B (FFFFD6h, 0 = pressed); switch number = row x 8 + bit. Found by pressing each
  one: SHIFT/EXIT 3, WRITE 11, UP 16, DOWN 24, number keys [1] 25, [2] 17, [3] 9, [4] 26, [5] 18,
  [6] 10, [7] (INIT/UTIL) 27, [8] 19, +OCT 97, -OCT 105, RIBBON RELATIVE 113, HOLD 121.
- **First boot.** The empty memory gives "Memory Damaged!" and the Rx Exclusive switch off, so the
  tool runs the OS's own Initialize routine (type 0Dh, FACTORY PRESET) inside the OS's message task
  and switches the unit off and on again. The state is saved in `re/jp8080/emu/jp8000.snap`.
- **Panel.** `panelInitialize(m, type)` does what the manual describes (SHIFT + INIT/UTIL, UP,
  WRITE: "Executing", then "Completed").

`node tools/roland/jp8000/check_editor.mjs` (about 2.5 minutes) runs the editor's definition against
it, through its own functions (fetch, param.send, sendAll, slots, requests) and a MIDI client that
answers from the emulator. Results (2026-11-27, 42 checks, all passed): see "Checked in the emulator".

## Checked in the emulator

Every round trip compared byte for byte:

| Check | Result |
|---|---|
| Identity request | F0 7E 10 06 02 06 01 00 00 00 03 00 00 F7 (no 41h, as on the JP-8080) |
| System read | bytes 00-16h equal the OS's system memory |
| Live edits: every parameter of system (114), performance (28), upper and lower patch (141 each) set to another value, one DT1 each, then read back | equal (patch ECh-EEh, the active indicators, are set by the OS from the depths and not compared) |
| Whole objects edited (performance 24, patches 136/132 parameters) and sent with Send to JP-8000 | equal |
| Patch stored into USER B88 and A16, read back, names read, recalled with bank select 50h + program change on the part's channel | equal |
| PRESET patches A11, B26, B88 and performances 11, 61, 88 recalled | names equal the ROM records |
| Performance stored into USER 88, read back, recalled on the Perform Ctrl channel | equal (part banks and numbers as stored) |
| Motion B[2] written as A[1], read back, A[1] restored | equal |
| RPS pattern D2 written to C#2, read back, restored | equal |
| TEMPO and Trig Source Note at both ends of their ranges and one past | ends taken, outside refused |
| System 12h/13h and 14h-16h | see "System 12h-16h" |
| Complete dump (646 messages: system, temporary performance and patches, user patches and performances, motions, RPS patterns; 248 Branch Library items), FACTORY PRESET from the panel (after it 601 of the dumped bytes differed), the dump sent back, a second dump | equal byte for byte (102569 bytes) |
| EXCLUSIVE on a Tx/Rx slot with MODE2 and Edit SW ON | the signature copy is overwritten; "Memory Damaged!" at the next power-on; data kept (see above) |

The live edits leave value 96 (EXCLUSIVE) out of the Tx/Rx sweep because of that bug.

## Checked on the JP-8080 (shared code)

2026-11-27, JP-8080 on `MIDI (OCTA-CAPTURE)` (`tools/roland/jp8000/jp8080_live.py`, files in
`re/jp8080/live/2026-11-27/`): backup of the system, temporary performance, both temporary patches
and motion A[1]; TEMPO 251 refused and 250 taken (the range the editor now takes from the
firmware), then the original value (85) put back; everything read again equal to the backup byte
for byte. Motion A[1]'s replies, read through the reworked motion reader, decode to the recorded
`motion_a1.bin` (2800 bytes, 176 events). Nothing was written to memory.

## Open items

- A check on a real JP-8000 (none available; the emulator check above stands in for it).
- RPS patterns move as data (Branch Library); there is no page that shows or edits their notes.
