# ART Multiverb Alpha 2: MIDI implementation from the v2.02 firmware

Source: `ART_MULTIVERB_alpha2_EPROM_Firmware_v2.02.zip` (64 KB, Z80 code; the screen says `ALPHA v2.02`
and `ART Jul 15, 1992`). Work copy, a listing (`re/fx/tools/z80dis.py`, a recursive Z80 disassembler
that takes jump tables) and a Ghidra project are in `re/fx/art-alpha2/`; the owner's manual from ART's
site (`om-multiverb_alpha20.pdf`, with its text) is in `re/fx/art-alpha2/doc/`. Addresses below are CPU
addresses: 0000-9FFF is the image's first 40 KB, A000-BFFF an 8 KB page chosen by port 28h (page p =
image p x 2000h: 5 = image A000, 7 = image E000 with the factory presets; the SE confirmed this layout),
C000-DFFF battery-backed RAM.

The tables (`js/devices/defs/art-multiverb-alpha2-fw.js`) and the test vectors
(`tests/art-multiverb-alpha2.vectors.json`) come from `tools/art/alpha2_fw.py`, which reads the
firmware's tables and runs its own display, recall and packing routines in a Z80 emulator
(`tools/art/z80.py`, board model `tools/art/alpha2_board.py`), about one minute. It finds every address
by code pattern, so it also reads the Alpha 2 SE (`docs/devices/art-multiverb-alpha2-se.md`); the editor is
shared with the SE (`art-multiverb-alpha2-common.js`, thin model files):

    python -I tools/art/alpha2_fw.py re/fx/art-alpha2/fw/alpha2_v202.bin js/devices/defs/art-multiverb-alpha2-fw.js tests/art-multiverb-alpha2.vectors.json

**Not checked on hardware** (no Alpha 2 is connected); the tests use the definition's simulator and the
emulator's results.

Every name in the editor is the text the unit's LCD shows (parameter labels and values from the edit
display 2CD7, page titles and values from the UTILITY / MIDI pages, controller names, switch names);
the manual was used only to confirm them and for the SysEx messages it documents (bypass, all presets,
program table).

## Presets

200 presets: 1-115 are the factory presets in ROM (pointer table B32B, bank 7) until one is stored
over (the panel needs PRESET 1..115 = UNLOCKED; MIDI does not check), 116-200 start empty (B09E). A
directory of 200 pointers (C62B) points into ROM or into 5587 bytes of preset memory (C7BB-DD8D,
allocator 6DDF; UTILITY MEMORY USED / AVAILABLE).

A preset is a chain. Its **configuration** (0-53, table 1788) lists up to five effect types; LOW-PASS
is always first, then a delay or sampler, then reverbs / pitch / modulation / pan. Some of the chain's
effects are in use (DELETE EFFECT leaves the configuration, ADD EFFECT picks one that has all wanted
effects, 15B0). The EQUALIZER, the A.E.S. and the MIX are outside the chain.

| Configurations | Chain after LOW-PASS |
|---|---|
| 0-8 | STREO-DDL-L / -S > FLANGER or CHORUS > PANNER, TREMOLO or MIDI-PAN |
| 9-20 | REGEN-DDL-S / -L > REVERB-2 or REVERB-1 > FLANGER or CHORUS > PANNER, TREMOLO or MIDI-PAN |
| 21-24 | REGEN-DDL > FLANGER or CHORUS > GATE-VERB-1 / -2 |
| 25-26 | REGEN-DDL-L / -S > PITCH-TRANS |
| 27-28 | REGEN-DDL-S > REVERB-3 or GATE-VERB-3 (the only chains with them) |
| 29-31, 35-40 | REGEN-DDL > GATE-VERB-1 / -2 > PANNER, TREMOLO or MIDI-PAN |
| 32-34 | TAP'D-DDL-S / -L > REVERB-2 or REVERB-1 |
| 41-44 | SAMPLER-S > REVERB-2 / REVERB-1; SAMPLER-L; SAMPLER+PTr |
| 45 | REGEN-DDL-S > PITCH-TRANS > REVERB-1 |
| 46 | TUNER |
| 47-52 | STREO-DDL-L / -S > PHASER > PANNER, TREMOLO or MIDI-PAN |
| 53 | STREO-DDL-S > DUAL PTr |

The edit buffer (C0E6) holds a preset expanded in 98 bytes; the 05 message carries exactly this:

| Byte | Meaning |
|---|---|
| 0 | X-15 FX ON/OFF status as recalled: bit 0-5 = switch #4 EQUALIZER, #6 REVERB, #7 DELAY, #8 PITCH EFX, #9 FLNG/CHOR, #10 SPECL FX (list 6E78; 6D99 / 6D65 convert to the switch states C0CF) |
| 1 | bit 0 EQUALIZER in use, bit 1 A.E.S. in use (chunk sizes 7 / 1, 210E) |
| 2 | configuration 0-53 |
| 3 | bit k: the configuration's k-th effect in use |
| 4-6 | MIX DRY, EFX, DRYEQ (0-31: 0%-100%) |
| 7-13 | EQUALIZER 40Hz, 100Hz, 250Hz, 640Hz, 1.6KHz, 4KHz, 10KHz (0-12: -15dB to +15dB) |
| 14 | A.E.S. (0-13: OFF, DEAD ROOM ... OPEN AMBNCE) |
| 15-32 | the configuration's effects in chain order, each with all its parameters (LOW-PASS HF-CUT is byte 15) |
| 33-48 | title, 16 characters |
| 49 | PERFORMANCE MIDI assignments in use, bit k = #k+1 |
| 50 + 6k | assignment #k+1: controller (0-120 = MC n, 121 NOTE OFF KEY #, 122 NOTE OFF VELOCTY, 123 NOTE ON KEY #, 124 NOTE ON VELOCITY, 125 POLY AFTER TOUCH, 126 CHANNEL PRESSURE, 127 PITCH BEND WHEEL, 128 OFF), LOW VALUE, HIGH VALUE, parameter (1-29 = bytes 4-32 as the edit pages number them, 0 = none: the page shows MIDI DataMONITOR), then two runtime bytes: the parameter's value as recalled (6BC6; STORE writes it back, 6AEE) and a controller value not yet applied (5B56, FFh none) |

Parameters of effects not in use, and bytes after the configuration's last effect, are not stored:
recalling a preset leaves whatever the edit buffer held there (69C2). The editor fills them with the
defaults instead.

**Packed form** (6CDB; the form stored in memory and sent in 06 / 0B): byte 0, bytes 1-6, the 7 EQ
bytes if bit 0 of byte 1, the A.E.S. byte if bit 1, the bytes of each effect in use, the title as 16
7-bit characters (14 bytes, first character in the top bits; 6C23 / 6CAD), byte 49 and the first four
bytes of each assignment in use: 22-80 bytes. ROM presets are kept in the same form. The generator
packs every factory preset with the firmware's own routine and checks it against the ROM; the tests
check the editor's pack / unpack against the firmware's for all 115 factory presets, the empty
preset and every configuration with all effects and all eight assignments (stored with 6AEE and
recalled with 6A38).

### Effect types

Table 20BA: per type its parameter records (11 bytes: name, min, max, the value the DSP gets while the
effect is not in use (1BC8), the value while its X-15 switch is off (80h = not affected, 1BDD), default,
type, X-15 switch, order, display format). Labels and values as the LCD shows them (`IN` is the record
INVERT, `STAT` STATE); [default]; "off" = while the X-15 switch is off.

| Type | Name | LCD | X-15 switch | Parameters |
|---|---|---|---|---|
| 0 | LOW-PASS | LPF | #4 EQUALIZER | HF-CUT 630Hz..17.8K, THRU [THRU] |
| 1 | FLANGER | FLA | #9 FLNG/CHOR | TYPE FLANGER OFF, POST REVERB, POST INV L / R / L+R, PRE-REVERB, PRE INV L / R / L+R [POST REVERB]; WIDTH 0%..100% [71%]; SPEED 0.04Hz..27.3Hz [0.84Hz]; REGEN 0%..100% [76%] off 0%; LEVEL [100%] off 0% |
| 2 | CHORUS | CHO | #9 FLNG/CHOR | TYPE OFF, POST, PRE [POST]; WIDTH [34%]; SPEED [0.84Hz]; DELAY 0ms..47ms [30ms]; LEVEL [100%] off 0% |
| 3 | PITCH-TRANS | PTr | #8 PITCH EFX | TYPE OFF, QUICK, NORMAL, SMOOTH [SMOOTH]; PITCH -12..+12; FINE -4.00..+4.00; BASE KEY OFF, C#- .. G 9 [OFF]; REGEN [0%] off 0%; LEVEL [100%] off 0% |
| 4, 5 | PANNER, TREMOLO | PAN, TRM | #10 SPECL FX | MOD % [100%] off 0%; SPEED [2.16Hz] |
| 6 | MIDI-PAN | MPN | #10 SPECL FX | POSITN 0..127 [64] off 64 |
| 7-9 | REVERB-1, -2, -3 | REV | #6 REVERB | TYPE (REVERB-1: HALL-1..VOCAL-1; -2 adds the -2 types; -3 all, then OFF); IN PRE DDL / POST DDL; DECAY 0.1s..25.0s [2.4s]; HFDAMP 0%..50% [14%]; POSITN FRONT, 17%..83%, REAR; DIFFUS 40%..100% (REVERB-3 only); LEVEL off 0% |
| 10-12 | GATE-VERB-1, -2, -3 | GAT | #6 REVERB | TYPE SLOPE, FLAT, RVRS A, RVRS B, OFF; IN; DECAY 0.05s..0.25s / 0.40s; DIFFUS 60%..100%; LEVEL off 0% |
| 13, 14 | TAP'D-DDL-S, -L | DDL | #7 DELAY | TYPE FLAT-1m .. SLOPE3s (18); # TAPS 1..7; DELAY 0ms..960ms / 1.10s; D-FINE 0ms..50ms; REGEN off 0%; LEVEL off 0% |
| 15, 16 | REGEN-DDL-S, -L | DDL | #7 DELAY | DELAY 0ms..960ms / 1.10s; D-FINE; REGEN off 0%; LEVEL off 0% |
| 17, 18 | STREO-DDL-S, -L | DDL | #7 DELAY | DLY-L, L-FINE, DLY-R, R-FINE (up to 1.10s / 1.30s); REGEN off 0%; HFDAMP; LEVEL off 0% |
| 19-21 | SAMPLER-S, -L, SAMPLER+PTr | SMP, SPT | #10 SPECL FX | STAT (the byte is 0; the LCD shows the running state C14D); RECORD AUTO, MANUL, MIDI; PLAY SINGLE, PUNCHIN, MIDI, REPEAT, AUDIO; LENGTH 0.01s..1.30s / 1.58s / 1.25s; START 0ms..100ms; SAMPLER+PTr: PITCH, FINE, BASE KEY; LEVEL off 0% |
| 22 | TUNER | TNR | #10 SPECL FX | TYPE BASS, GUITAR [GUITAR]; REFRNC OFF, the strings' notes for that TYPE (B 31 .. C 131 or E 82 .. E 330), A 440, AUTO (32DC shows the note AUTO picks, DDAA); DETUNE -2.00..+2.00; LEVEL [0%] |
| 23 | PHASER | PSR | #10 SPECL FX | TYPE OFF, POST, PRE; WIDTH; SPEED; REGEN; DEPTH off 0% |
| 24 | DUAL PTr | 2PT | #8 PITCH EFX | TYPE; PITCH1; FINE 1; PITCH2; FINE 2; RGN-FD PRE, POST; LEVEL off 0%; POSTN1, POSTN2 0..63 [31] |
| 25 | MIX | MIX | | DRY, EFX, DRYEQ [100%] |
| 26 | EQUALIZER | EQL | #4 EQUALIZER | seven bands -15dB..+15dB, off 0dB |
| 27 | ACU ENV SIM | AES | #10 SPECL FX | A.E.S. OFF, DEAD ROOM, HEAVY CARPET, WOOD/RUG MIX, DRAPE/CARPET, WOOD + TILE, PEWS/PEOPLE, WOOD BAFFLES, LT FLOOR RUG, CEILNG DRAPE, STONE CEILNG, WALL DRAPES, NATURAL WOOD, OPEN AMBNCE |

The value texts of every parameter were run through the edit display for every value in every
configuration: none depends on the configuration, and only TUNER REFRNC depends on another byte (TYPE).

## Settings

Battery-backed RAM, changed on the UTILITY and MIDI pages without STORE, read and written one at a time
with 43 s / 03 s v (5FC4 / 5CDF). Factory reset (0305) copies 04C7 to C0B1-C0D8 and maps program c to
preset c + 1 (6973).

| s | RAM | Page | Values (reset value first) |
|---|---|---|---|
| 00 | C0BA | BYPASS button | 0 ACTIVE, 1 BYPASS |
| 01 | C0B7 | REMOTE SWITCH 1 | BYPASS ON/OFF, SAMPLE-TRIGGER, INCR PROGS 2-127 (limit 2A0C) |
| 02 | C0BC | LCD VIEW ANGLE | 6; 0-7 |
| 03 | C0B3 | PRESET 1..115 | LOCKED (1), UNLOCKED (0) |
| 04 | C15D | (read only) | 1 = the edit buffer packs to the stored preset (69A3); 0 shows the "not equal" sign |
| 05 | C0B8 | REMOTE SWITCH 2 | BYPASS ON/OFF, SAMPLE-TRIGGER, SAMPLER ARM, DECR PROGS |
| 06 | C0B9 | BYPASS LEVEL | 100% (31); 0%-100%, 32 = MIX DRY LEVEL |
| 07 | C0C2 | AUTO PM DISPLAY | ALWAYS DISPLAYED (2); OFF, PRESET MODE ONLY |
| 20 | C0B4 | MIDI CHANNEL | 1; OFF, 1-16 (the receiver takes 0-16) |
| 21 | C0B5 | OMNI MODE | ON; OFF |
| 22 | C0B6 | MIDI PROG= (program table page) | 0-127 |
| 24 | C0BE | MIDI ENABLE PM | ON; OFF (controllers, 5ACA) |
| 25 | C0BD | MIDI ENABLE PROG | ON; OFF (program change, 5A93) |
| 26 | C0C3 | FX ON/OFF ENABLE (USING X-15) | ON; OFF |
| 30-3A | C0C4-C0CE | FX ON/OFF controllers for switches #0 BYPASS .. #10 SPECL FX | MC 84, 70-79; 0-120 (limit 2937) |
| 40 | C0B1 | (preset shown) | 0-199 as two bytes |
| 41 | 001F | (software version, read only) | 02 02 |

The receiver masks 00 and 03 to one bit and 02 to three, refuses 20 above 16 and 21 / 24-26 above 1, and
takes the others as sent. The FX ON/OFF controllers turn a switch on with values 64-127 and off with
0-63 while FX ON/OFF ENABLE is on (5B5A; controllers below 121). Switches #1-#3 and #5 (EXCITER,
COMPRESOR, DISTORTON, EXPANDER) belong to the firmware's analog modules, which the Alpha 2 does not have.

## SysEx

`F0 1A <ch> 11 <id> ... F7` (receiver 5C65, sender 61D2). `<ch>` is MIDI CHANNEL - 1 and must match:
OMNI does not apply to SysEx, and with the channel OFF no SysEx is received (the unit sends on channel 1
then). Preset numbers 0-199 and data bytes travel as pairs: bits 0-6, then bit 7 (the manual's "preset
200 is 47h 01h"). Received messages are handled by tasks the main loop runs (flags C502 / C503, table
6280).

| ID | Data | Meaning |
|---|---|---|
| 01 | | answer to 41 |
| 03 | s v (s 40: n n; s 41: version) | a setting (above); 03 00 00 / 01 is the manual's Set Bypass OFF / ON |
| 05 | 98 pairs | the edit buffer; taken whole (5DB6), then the switch states and the DSP follow it |
| 06 | n n L, L pairs | preset n packed (L 3-80); stored without touching the edit buffer (5F81) |
| 06 | n n 02 n n | preset n is in ROM: the unit sends this for factory and empty presets; received, preset n below 116 becomes its factory preset again, from 116 empty |
| 08 | c n n | MIDI program table entry c -> preset n |
| 09 | n n | recall preset n (6199); with 40h in the second byte (number 2000h + n), recall factory preset n into the edit buffer only (HIT RECALL FOR A.R.T. PRESET) |
| 0A | n n | store the edit buffer as preset n (6AEE, the STORE routine; no lock check) |
| 0B | 200 x (L, L pairs or 02 n n) | all presets in order; received, the preset memory is cleared first (6DC7) |
| 0C | 128 pairs | the MIDI program table |
| 0D | n n | answer to 4D: C0C0, bit 0 = the last store found room in memory |
| 0F | 200 x (62h, 98 pairs or 02 n n) | answer to 4F: every preset expanded (each recalled through the edit buffer); not received |

Requests: 41, 43 s, 45 (05), 46 n n (06), 48 c (08), 4B (0B), 4C (0C), 4D (0D), 4F (0F). The MIDI page
PRESS ENTER TO sends SEND A PRESET = 05 (the edit buffer), SEND ENTIRE MPT = 0C, SEND ALL PRESETS = 0B.
Task 0E (a memory dump: address, length, bytes) exists but nothing starts it in v2.02. The manual's
general format names product 06h; the unit uses 11h, as the manual's examples do.

Other MIDI: program change (MIDI ENABLE PROG, channel or OMNI) recalls the preset of the program table;
CC 124 / 125 on the channel set OMNI off / on; Performance MIDI takes the controllers, note on / off
(key or velocity), poly pressure, channel pressure and pitch bend of its assignments.

## Editor

- **Preset** (the edit buffer, read with 45): Chain (configuration, EQUALIZER / A.E.S. / each chain effect
  in use), MIX, EQUALIZER, A.E.S., a card per effect in use with its LCD labels and values, X-15 FX
  ON/OFF status, PERFORMANCE MIDI #1-#8 (IS CONTROLING, CONTROLLER IS, LOW / HIGH VALUE with the
  parameter's own value texts) and the runtime bytes as a table. Every change sends the whole edit buffer
  (05, 202 bytes): the unit has no single-parameter message. Changing the configuration keeps each
  effect's values and use, adds the new effects with their defaults and X-15 switch on (as ADD EFFECT
  does, 1C50), and moves the assignments with their parameters (or drops them, as DELETE EFFECT does,
  13A4). Choosing an assignment's parameter sets LOW / HIGH to its range (1195). Before sending, each
  assignment's recalled value is set to its parameter's value so STORE keeps it. Actions: Store as preset
  (05 + 0A), Rename, Recall factory preset (09 with 40h). Slots 1-200: Edit reads one preset (46), Read
  names all of them (4B), Store writes the packed preset (06; an empty one from 116 on as 02), Play
  recalls (09).
- **Settings**: the UTILITY and MIDI settings, the FX ON/OFF controllers, status (edited, preset shown,
  store status, version) and the MIDI program table; each change is sent at once (03 / 08).
- Branch Library: the complete dump asks for all presets (4B), the program table (4C), every setting
  (43) and the edit buffer (45); a dump becomes 200 presets (each sent back alone with 06), the edit
  buffer and one settings item.
- Head Library translator: reverb (REVERB / GATE-VERB TYPE, DECAY, LEVEL), delay (DELAY or DLY-L, REGEN,
  LEVEL) and one modulation (chorus, flanger, phaser, tremolo, panner or pitch: SPEED, WIDTH / MOD %,
  LEVEL) as `effects`; the exact 98 bytes in `extra`. From other sources the configuration with the
  wanted kinds is chosen and the effects put in use.

## Related firmware

The Multiverb Alpha 2 SE v1.03 (1993) and v1.04 (1994; its archive is named "Alpha SE") run the same
software with four ROM preset banks, a bit-packed preset format and other preset / program table messages:
see `docs/devices/art-multiverb-alpha2-se.md` (done, same editor). The SGE Mach II v1.20-1.24 (1990) images
show the same software family (the same init texts, effect abbreviations and NO MORE FX / MIDI CONTRL) and
are not covered yet.

## Open

- A hardware check: the messages, the pacing of 05 for live edits (`minGap` 120 ms) and the 0B load.
- The descriptors' order byte (record byte 9) is not used by the MIDI code; what it orders was not traced.

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Addresses the help texts named (v2.02) that this doc does not list elsewhere: a new PERFORMANCE MIDI assignment is set up at 1158 (MC 4, the first parameter in use, its full range); the parameter choice at 1DD9 offers only parameters in use; a pending controller value (assignment byte 5, written at 5B56) is applied by the main loop at 5B92.
