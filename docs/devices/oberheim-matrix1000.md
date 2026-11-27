# Oberheim Matrix-1000: MIDI implementation from the v1.13 firmware

Source: `M1000-CAT27256P-17_v113.BIN` (27256, 6809, mapped at 0x8000; version string "113" at
0x8000). All addresses below are in that image. Checked by `tools/matrix1000/check_def.mjs`,
which compares the editor definition (`js/devices/defs/oberheim-matrix1000.js`) with the ROM.

## Receive path

The serial FIRQ (0x84B4) fills a ring buffer at 0x7593-0x7792. The parser reads it at 0xC457
and dispatches status bytes through the table at 0xC4AC (one entry per message type) and
system messages through 0xC840.

## Channel messages

| Message | Handling |
|---|---|
| Note on/off | Master transpose (byte 34) is added; velocity goes through the curve in master bytes 9-10 |
| CC = master byte 19 / 20 / 17 / 18 | Lever 2, lever 3, pedal 1, pedal 2 (sustain switch). Defaults 1, 2, 4, 64 |
| CC 7 | Volume |
| CC 6, 96, 97, 98, 99 | NRPN editing: CC 99/98 pick a remote parameter number (0-99), CC 6 sets value - 64, CC 96/97 step it |
| CC 100/101 | RPN 0-2 map to internal parameters 0xBC-0xBE (bend range, fine tune, coarse tune) |
| CC 31 | When 64 or more, program changes 0-9 select a bank |
| CC 121, 123, 124, 125, 126, 127 | Reset controllers, all notes off, omni off/on, mono/poly |
| Program change | Bank locked: patch = bank × 100 + n (n ≤ 99). Unlocked: patch n (0-127) |
| Pressure, bend | Per channel |
| 0xFE | Active sensing, only if master byte 31 is set |

Controllers, program changes and pressure are ignored when master bytes 13 / 14 are off.
Outside omni mode only the basic channel (byte 11) is used.

## SysEx

Header `F0 10 06 <cmd>`, parsed at 0xC87D, commands through the table at 0xC9E6. Commands 00,
02, 05 and 07 are ignored; 0F points into a front-panel routine and is not used here. Data
travels as nibbles, low nibble first, followed by the 7-bit sum of the bytes.

| Cmd | Message | Notes |
|---|---|---|
| 01 | `01 nn <134 bytes> cs` | Store a patch into slot nn of the current bank; the edit buffer reloads if nn is current |
| 03 | `03 03 <172 bytes> cs` | Master data, applied at once |
| 04 | `04 type nn` | 0: the 100 patches of the current bank, 80 dummy splits (for the Matrix-6) and the master; 1: patch nn; 3: master; 4: edit buffer |
| 06 | `06 pp vv` | Remote edit of parameter pp (table 0xDE13); vv is 7-bit two's complement except for parameter 21 |
| 08 | `08 units unit` | Group mode on; forwarded with unit + 1 |
| 09 | `09` | Group mode off |
| 0A | `0A bank` | Select and lock bank 0-9 |
| 0B | `0B slot src amt dst` | Modulation matrix slot 0-9 |
| 0C | `0C` | Unlock bank |
| 0D | `0D nn <134 bytes> cs` | Patch into the edit buffer (nn ignored) |
| 0E | `0E nn bank unit` | Store the edit buffer as patch bank×100+nn; in group mode unit must match or be 7F |

Patches sent by the 1000 carry the name "BNKb: nn" (the 1000 has no names). Stores are refused
while memory protect (master byte 171) is on. Banks 0-1 are RAM; 2-9 hold the factory patches.

Universal: `F0 7E <basic channel or 7F> 06 01 F7` is answered with
`F0 7E <ch> 06 02 10 06 00 02 00 31 31 33 F7`. `F0 7F <id> 02 01 ...` (a MIDI Show Control
message) is used between grouped units to pass bank changes.

## Patch layout (134 bytes)

Bytes 0-7 name, 8-103 parameters, 104-133 ten matrix slots (source 0-20, amount ±63,
destination 0-32). Remote parameter n lives at byte 8 + table[0xDE13 + n]. Field widths come
from the store's bit packer (threaded code at 0xDF85, 81 packed bytes per patch); signed fields
from the table at 0xE08B (7-bit for the modulation amounts, 6-bit for DCO 2 detune). Env 2
delay is stored in 5 bits. A matrix slot with a source and destination 0 reads back as
destination 32.

## Master layout (172 bytes)

| Byte | Meaning | Default |
|---|---|---|
| 1-7 | Vibrato speed, speed mod source, speed mod amount, waveshape, amplitude, amp mod source, amp mod amount | 40, 0, 0, 0, 0, Lever 2, 63 |
| 8 | Master tune ±31 | 0 |
| 9, 10 | Velocity curve 0-3, velocity scale | 0, 63 |
| 11-14 | Basic channel, omni, controllers, program changes | 0, on, on, on |
| 17-20 | Pedal 1, pedal 2, lever 2, lever 3 controller numbers | 4, 64, 1, 2 |
| 31, 32, 34, 35 | Active sensing, MIDI echo, transpose ±24, mono | on, off, 0, off |
| 36-161 | One bit per patch: stored with group mode on | all set |
| 164 | Bend range 1-24 | 2 |
| 165 | Bank (bits 0-3) and bank lock (bit 7) | |
| 166-168 | Units in group, this unit, group mode (bit 7) | 1, 0, off |
| 169-171 | Unison, volume invert, memory protect | off |

Defaults: 27 bytes copied from 0xB1A8 at cold start, then set at 0xDC41.

## Translator (Head Library)

`js/devices/defs/oberheim-matrix1000-translate.js` moves patches through the shared synth model
(`docs/HEAD_LIBRARY.md`). The Matrix-6, 6R and 1000 share the 134-byte patch, so it is kept whole
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
