# Oberheim Matrix-1000: MIDI implementation from its firmware

Sources (`re/firmware/`, not in git):

| Image | What |
|---|---|
| `Oberheim_M1000-ROM_v111/M1000-CAT27256P-17_v111.BIN` | OS 1.11, the last Oberheim release (27256, 6809, at 0x8000) |
| `Oberheim_M1000-ROM_v113/...v113.BIN` | unofficial 1.13: 1.11 with three fixes (7 bytes; see "OS versions") |
| `Oberheim_M1000-ROM_v114/...v114.BIN` | unofficial 1.14: 1.13 plus an NRPN fix (C694) |
| `Oberheim_M1000-ROM_v103/...v103.BIN` | OS 1.03, early units (28,000 bytes differ from 1.11) |
| `Oberheim_M1000-IC_C2DB_ORG_RO(Black&White)/M1000-IC_C2DB.BIN` | the factory patch ROM (27512): banks 2-9 |
| `Oberheim - Matrix 6R EPROM Firmware (v2.11)/m6r_211.bin`, `Oberheim - Matrix 6 ... (v2.13 ...)` | Matrix-6R / Matrix-6 OS: the master menu that names the bytes the 1000 only keeps |

Addresses below are in 1.13 (the same in 1.11 and 1.14 unless said). `tools/matrix1000/check_def.mjs`
compares the editor definition (`js/devices/defs/oberheim-matrix1000.js`) with the ROM (remote-edit
table, bit widths of the patch packer); `tools/matrix1000/check_editor.mjs` runs the OS itself (see
"Check in an emulator of the OS").

## Hardware, as the OS uses it

6809 at 2 MHz (8 MHz crystal). Memory map (from the code; gligli's m1k-emu agrees):

| Address | What |
|---|---|
| 0000-0FFF | four 8254s: the twelve DCO timers (2 MHz; 4545 counts = 440 Hz). The voice update reads their counts and, through the read-back command, their OUT state |
| 1000-13FF | CV DAC registers |
| 1406/1407 | 6850 ACIA (MIDI), interrupt on FIRQ (0x84B4) |
| 1600-1603 | 8254 system timer: counter 2 gives the first IRQ |
| 1800-1802 | front panel switches (1 = pressed; key scan DDC7) |
| 1D80 | bank latch: bits 0-2 pick the patch ROM page at 2000-3FFF, bits 0-1 the RAM page at 6000-7FFF (0 work RAM, 1 = bank 0, 2 = bank 1) |
| 1E00/1E80/1F00, 1F80 | the three 7-segment digits, the LEDs |
| 6000-7FFF | RAM: voice pages 6000-71FF (one per voice, 300h apart), variables 7200-7FFF; master table at 7485 |

The first IRQ never returns: its handler (85E7, through the vector in RAM at 79F9) is the main loop.
It updates the six voices, runs the MIDI parser as a coroutine (C42B, its own stack at 7C2C) when bytes
are waiting in the receive ring (7593-7792, filled by the FIRQ), scans the panel, and jumps back to its
own start. Patches are stored packed in 80-byte slots (bank b slot n: RAM page b+1 or ROM page b-2,
offset 80n); the OS copies them with the RAM page switched and FIRQ masked.

## Receive path

The FIRQ (0x84B4) fills the ring buffer at 0x7593-0x7792. The parser reads it at 0xC457 and dispatches
status bytes through the table at 0xC4AC and system messages through 0xC840.

## Channel messages

| Message | Handling |
|---|---|
| Note on/off | Master transpose (byte 34) is added; the velocity is doubled (D683: `asla; rts`) and used as it is |
| CC = master byte 19 / 20 / 17 / 18 | Lever 2, lever 3, pedal 1, pedal 2 (sustain switch). Defaults 1, 2, 4, 64 |
| CC 7 | Volume |
| CC 6, 96, 97, 98, 99 | NRPN editing: CC 99/98 pick a remote parameter number (0-99), CC 6 sets value - 64, CC 96/97 step it (1.14 fixes the NRPN handling) |
| CC 100/101 | RPN 0-2 map to internal parameters 0xBC-0xBE (bend range, fine tune, coarse tune) |
| CC 31 | When 64 or more, program changes 0-9 select a bank |
| CC 121, 123, 124, 125, 126, 127 | Reset controllers, all notes off, omni off/on, mono/poly |
| Program change | Bank locked: patch = bank × 100 + n (n ≤ 99). Unlocked: patch n (0-127) |
| Pressure, bend | Per channel |
| 0xFE | Active sensing, only if master byte 31 is set |

Controllers, program changes and pressure are ignored when master bytes 13 / 14 are off. Outside omni
mode only the basic channel (byte 11) is used. With MIDI echo on (byte 32) the 1000 echoes every byte
it reads: a request's first bytes come back before the reply and its last bytes after it.

## SysEx

Header `F0 10 06 <cmd>`, parsed at 0xC87D, commands through the table at 0xC9E6. Commands 00, 02, 05
and 07 are ignored; 0F points into a front-panel routine and is not used here. Data travels as nibbles,
low nibble first, followed by the 7-bit sum of the bytes.

| Cmd | Message | Notes |
|---|---|---|
| 01 | `01 nn <134 bytes> cs` | Store a patch into slot nn of the current bank; the edit buffer reloads if nn is current |
| 03 | `03 03 <172 bytes> cs` | Master data, applied at once (copied whole into 0x7485, then the voices are updated) |
| 04 | `04 type nn` | 0: the 100 patches of the current bank, 80 dummy splits (`02 nn`, for the Matrix-6; each followed by a stray F7) and the master; 1: patch nn of the current bank; 3: master; 4: edit buffer, sent as `01 nn` with nn = the current patch (not 0D). Not 1.03 (see "OS versions") |
| 06 | `06 pp vv` | Remote edit of parameter pp (table 0xDE13) into the patch at the pointer 0x79AB; vv is 7-bit two's complement except for parameter 21 |
| 08 | `08 units unit` | Group mode on; forwarded with unit + 1 |
| 09 | `09` | Group mode off |
| 0A | `0A bank` | Select and lock bank 0-9 |
| 0B | `0B slot src amt dst` | Modulation matrix slot 0-9 |
| 0C | `0C` | Unlock bank |
| 0D | `0D nn <134 bytes> cs` | Patch into the edit buffer (nn ignored) |
| 0E | `0E nn bank unit` | Store the edit buffer as patch bank×100+nn. In group mode (byte 168 bit 7) the unit byte 7Fh is refused and every other value stores (CA41: the test compares 7Fh with this unit, so it never matches); outside group mode it always stores. The editor sends unit 0 |

Patches sent by the 1000 carry the name "BNKb: nn" (the 1000 has no names). Stores are refused while
memory protect (master byte 171) is on; a store into a ROM bank (2-9) changes nothing.

The remote-edit pointer 0x79AB is set only when the OS selects a patch (BC2D). After a memory
initialisation, until the first patch change, 06 and 0B edits land in the DCO timers (address 0 +
offset) and a 0E store copies from there; a unit in use has always selected a patch.

Universal: `F0 7E <basic channel or 7F> 06 01 F7` is answered with
`F0 7E <ch> 06 02 10 06 00 02 00 20 31 31 33 F7` (the last three bytes: the version, "111", "113"...).
`F0 7F <id> 02 01 ...` (a MIDI Show Control message) is used between grouped units to pass bank changes.

## Patch layout (134 bytes)

Bytes 0-7 name, 8-103 parameters, 104-133 ten matrix slots (source 0-20, amount ±63, destination 0-32).
Remote parameter n lives at byte 8 + table[0xDE13 + n]. Field widths come from the store's bit packer
(threaded code at 0xDF85, 81 packed bytes per patch); signed fields from the table at 0xE08B (7-bit for
the modulation amounts, 6-bit for DCO 2 detune). Env 2 delay is stored in 5 bits. A matrix slot with a
source and destination 0 reads back as destination 32.

### Modulation list

For each voice the OS compiles the patch's active modulations into a threaded list in the voice's RAM
page, from offset EFh; it is run with `pulu pc`. The envelope records start at offset 20Ch, so the list
has 285 bytes. The 800 factory patches use at most 221 (patches 332 and 333). In the emulator a patch
with all 18 fixed modulation amounts non-zero, all ten matrix slots used and every trigger and tracking
option on builds a longer list, which runs into the envelope records: the OS runs away. With one amount
fewer (281 bytes) it runs. The editor's patch note tells users to avoid using almost every modulation
at once; the check (below) sweeps the amounts and the other parameters in separate groups for this
reason.

## Master layout (172 bytes)

The Matrix-6 and 6R keep the same table: their master menu (0xE9C7 in Matrix-6R 2.11 and Matrix-6 2.13:
a type byte, the 10-character screen text, the table offset, and for lists the maximum, minimum and the
value texts) names every byte up to 35. The 1000 replaced the Matrix-6 patch map with the group bits.

| Byte | Meaning (Matrix-6 screen text) | Matrix-1000 use | Default |
|---|---|---|---|
| 0 | (no screen; no code) | none | 0 |
| 1-7 | Vibrato speed (VIB SPD), speed mod source (VIBSPD/: OFF LEV2 PED1), amount, waveshape (VIB WAV: TRI UPSAW DNSAW SQUAR RANDM NOISE), amplitude (VIB AMP), amp mod source, amount | vibrato (900D, through X = 7486h) | 40, 0, 0, 0, 0, Lever 2, 63 |
| 8 | Master tune ±31 (MASTR TUNE) | yes | 0 |
| 9 | VEL SCALE: LIN, EXP1, EXP2 (3: no screen; the EXP1 curve with the input doubled) | none: Matrix-6 keyboard velocity curve | 0 |
| 10 | VEL SENS 0-63 | none: Matrix-6 keyboard velocity sensitivity | 63 |
| 11 | Basic channel 0-15 | yes | 0 |
| 12-14 | Omni (OMNI MODE), controllers (CONTROLER), program changes (PATCHES) | yes | on, on, on |
| 15 | SYSTEMX (SysEx on/off) | none: the 1000 always takes SysEx | on |
| 16 | LOCAL CTL | none; set OFF at every power-on (DBC4) | on after an initialisation |
| 17-20 | Pedal 1, pedal 2, lever 2, lever 3 controller numbers (PEDAL1 = ... LEVER3 =, 0-121) | yes | 4, 64, 1, 2 |
| 21 | PED2 INV | none | off |
| 22 | LEVS INV | none | off |
| 23 | SET DISP 1-31 | none | 27 |
| 24 | SQUICK | none | off |
| 25 | PMAP ECHO | none | off |
| 26 | STEREO | none | off |
| 27 | BASIC CHAN (1-16, the Matrix-6 menu copy of the channel) | none | 1 |
| 28 | STANDOFF 0-63 | none | 5 |
| 29 | SPILLOVER | none | off |
| 30 | (no screen) | none; set 0 at every power-on (DBAF; the Matrix-6R does the same at EED2) | 0 |
| 31, 32, 34, 35 | Active sensing (ACT SENSE), MIDI echo, transpose ±24 (TRANSPOSE), mono (MIDI MONO) | yes | on, off, 0, off |
| 33 | PATCH MAP | none | off |
| 36-160 | Group mode per patch: bit patch % 8 of byte 36 + patch / 8 | when unit 0 of a group of 2 or more selects a patch, group mode follows its bit (BC84, S8376); the panel's group page sets it (BF5D) | all set |
| 161 | (after the last patch's bit) | none; set FFh by the initialisation fill (DD0D, 126 bytes from 74A9h) | 255 |
| 162 | (none) | none | 0 |
| 163 | Basic channel copy | written by the front panel's channel page (BE11, BE2B) next to byte 11; never read | 0 |
| 164 | Bend range 1-24 (front panel BND) | yes | 2 |
| 165 | Bank (bits 0-3) and bank lock (bit 7) | bit 7 is the lock; bits 0-3 are rebuilt from the current patch when the 1000 sends the table (CD20) and never read, so a received bank number selects nothing | |
| 166-168 | Units in group, this unit (front panel G), group mode (bit 7) | yes | 1, 0, off |
| 169-171 | Unison (U), volume invert (I), memory protect (P) | yes (volume invert is set off at every power-on) | off |

Defaults: 27 bytes copied from 0xB1A8 at a memory initialisation, then set at 0xDC41.

### Master bytes without a Matrix-1000 use

Bytes 0, 9, 10, 15, 16, 21-30, 33, 161, 162 and 163 are kept, sent and received by the 1000, but no
Matrix-1000 code reads them for a purpose. The evidence:

- Every 16-bit operand in the 1.11 and 1.13 images that falls in 7485h-7531h (the table) was listed.
  For these bytes they are: byte 0 only as the base of the three block loops (default copy B0CC, SysEx
  receive copy CB32, send and checksum CD48); bytes 9 and 10 only in the velocity curve routine D685,
  which nothing calls (the note handlers call D683, `asla; rts`, just before it; no branch or pointer
  reaches D685; 1.03 has the same dead copy at D31D), and the default write DCD1; bytes 15, 24, 25,
  27, 28, 33, 163 only in the initialisation writes (DC41-DCD9); bytes 16 and 30 only in the power-on
  writes (DBC4, DBAF); byte 163 also in the channel page's two writes; bytes 21, 22, 23, 26, 29, 161
  and 162 nowhere. The only pointer loads into the table besides those block loops are 7486h (the
  vibrato block, offsets 0-6) and 74A9h (the group bits, at most 124 bytes on).
- In the emulator every read of these bytes was recorded while the OS booted, took notes with
  velocities, controllers, NRPN and RPN, program changes with and without bank select, pressure, bend,
  active sensing and every SysEx command the editor sends: none outside the send loop (a control byte,
  32, was read 341 times meanwhile). Values written into them come back unchanged.
- The Matrix-6R uses them (it reads byte 24 SQUICK, 25, 26, 29, 33 and so on): they belong to the
  Matrix-6 and keep its names in the editor, in a card "Matrix-6 settings (not used by the Matrix-1000)".
  The Matrix-6R and 6 apply VEL SCALE and VEL SENS only to their own keyboard (6R: DAD0 → DED5); their
  MIDI note handlers (C55C, C57A) double the velocity like the 1000.

## OS versions

| Version | Differences that matter to the editor |
|---|---|
| 1.03 | no identity reply and no edit-buffer request (04 04), so the Patch page cannot read the unit; its reply to 04 01 05 carried slot number 38h. The editor needs 1.10 or later (its patch note says so) |
| 1.11 | remote edit 53 (Env 1 sustain) is filed under Env 2 amplitude (0xDE48 holds 38h, not 2Dh); remote edit 29 (VCA 2 by Env 2) calls the wrong voice update (0x8DC1 holds 992Ch, not 8F34h) and in the emulator the OS runs away. The editor sends these two parameters as the whole edit buffer (0D), which every version takes |
| 1.13 | fixes both, and VCF frequency (21) updating slowly (0x97CA) |
| 1.14 | also fixes NRPN (0xC694); the editor does not use NRPN |

## Complete dump (Branch Library)

`fullDump`: the ten banks (Set bank b, then 04 00: 100 patches, 80 dummy splits, the master), then
Unlock bank. The edit buffer is left out: the 1000 answers its request with `01 nn` (store into slot nn,
the current patch), so sending it back would overwrite the stored patch with the edit buffer.

The 1000 sends the bank's patches as `01 nn`, which store into the current bank. So each bank step has
`record: (m) => m is Set bank`: the step's own Set bank message belongs at the head of what it records,
and sending the bank's entry back puts the patches into that bank. This needs the generic option
`record` in `js/devices/generic/fulldump.js` (requested from main; until then an entry sent back whole
stores into the bank selected on the unit). `libraryItems` splits a dump into its patches (each with a
Set bank first, the bank taken from the "BNKb: nn" name the 1000 writes), the master and the split data,
so sending a selection of items always goes to the right bank.

## Check in an emulator of the OS

No Matrix-1000 was available. The check that stands in for a hardware check runs the 1000's own OS and
patch ROM in a 6809 emulator: `tools/m6809/cpu.mjs` (a general 6809 core, every documented opcode,
interrupts; `node tools/m6809/selftest.mjs`) and `tools/matrix1000/emu.mjs` (the board above: banked
RAM and patch ROM, the 8254 timers with read-back, the ACIA at the MIDI rate, display, panel keys).
`node tools/matrix1000/check_editor.mjs [os.bin] [patchrom.bin]` sends the editor's own messages (the
definition's request/decode, param.send, sendAll, slots, fullDump, libraryItems) and compares byte for
byte. Validated in an emulator of its OS, not on hardware. On 1.11, 1.13 and 1.14 all 30 checks pass:

- memory initialisation (the panel keys the OS reads at reset), identity, master = `initMaster()`
- every patch parameter changed as a live edit (06, 0B, and 0D for 29 and 53) and read back; whole
  patches (0D) with every parameter changed, at its lowest and at its highest value; the modulation
  amounts and the other parameters in separate groups ("Modulation list")
- stores (0E) into 007 and 199, a write (0A + 01) into 142, read back (0A + 04 01, names "BNKb: nn");
  recall (0A + program change) into the edit buffer; memory protect refusing a store and a write; the
  store's unit byte in group mode; ROM patches 200, 550, 999 read and recalled; a store into ROM refused
- every master parameter (172 bytes) changed one at a time, each sent as the whole table, read back;
  byte 165 after Set bank 4 reads 84h
- the master bytes without a use: values kept; no reads (above)
- the complete dump: 1000 patches, every parameter of each in its range; the Branch Library items of a
  bank; bank 1's entry sent back with bank 0 selected restores slot 110
- separately: all 800 factory patches selected one by one run without fault

`tests/oberheim-matrix1000.test.js` runs the check on 1.13 and 1.11 when the images are present.

The emulator's assumptions: the IRQ comes 20000 counts of a 1 MHz clock after counter 2 is programmed
(only the first IRQ matters, see above); after a memory initialisation the per-voice DCO periods at
offsets A0h/A2h start at 11C1h (on a unit they hold the last periods from battery RAM; at 0 the DCO
update adds 0 until a count turns positive, forever); the analogue tuning inputs are not modelled
(the initialisation is told to skip the calibration, as the panel key for it does).

## Translator (Head Library)

`js/devices/defs/oberheim-matrix1000-translate.js` moves patches through the shared synth model
(`intdocs/HEAD_LIBRARY.md`). The Matrix-6, 6R and 1000 share the 134-byte patch, so it is kept whole
in `common.extra` (family `oberheim-matrix`) and comes back exactly.

What the shared model reads: DCO 1/2 (Off/Pulse → square with its pulse width, Wave → saw or
triangle by Waveshape, DCO 2 Noise → noise; PW by LFO 2 as PWM depth; Sync as OSC 2 sync), DCO 2's
frequency as semitones from DCO 1's and its detune, Mix as the balance, the VCF (24 dB low pass:
frequency, resonance, keyboard tracking on/off, VCF freq by Env 1 as the envelope depth, Env 1 as
the filter envelope), VCA 1 level and Env 2 (which drives VCA 2 on every patch) as the amplifier,
DCO freq by LFO 1 as the pitch LFO, LFO 1/2 speed and shape, portamento and legato, Unison. From
the modulation matrix: an envelope to a DCO's frequency (pitch envelope), LFO 1/2 to the VCF
(filter LFO depths) and to a VCA (amp LFO depths); the other slots stay in `extra`.

Into a Matrix-1000 from another model: the same fields; a pitch envelope uses Env 3 through two
matrix slots, filter and amp LFO depths one slot each. DCO 1 keeps the patch's frequency (the
shared model has no absolute pitch). Reported as approximated or dropped: mono and legato (mono is
a Master setting here), filter types other than low pass, bend range (Master), effects, tone, pan,
ring and cross modulation, velocity and controller depths.

Assumed, not traced in the firmware: Mix 0 is DCO 1 alone and 63 DCO 2 alone; Waveshape 0 is a
sawtooth and 63 a triangle; Detune ±31 steps is read as ±50 cents. A hardware check (or the Matrix-6
manual) should confirm them.

## Left open

- A check on a real Matrix-1000 (none available): the emulator stands in for it.
- The generic `record` option for complete-dump steps (main), so that a whole bank entry sent back goes
  to its own bank.
- The translator's three sound assumptions above (Mix, Waveshape, Detune scale) are not traced in the
  firmware (they are DAC values; the emulator does not model the analogue side).
