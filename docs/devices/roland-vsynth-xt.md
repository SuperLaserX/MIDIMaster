# Roland V-Synth XT

Built from the OS 2.02 update (`z:/firmwares/Roland V-Synth XT v2.02.zip`) and checked on a
V-Synth XT (port `2- VSynth`, device ID 10h, identity `F0 7E 10 06 02 41 53 01 00 00 01 00 00 00 F7`).
The XT runs one of three applications, each with its own MIDI implementation, so each is a device
of its own in the editor:

| Device | Definition | Tables (generated) | Translator | Tests |
|---|---|---|---|---|
| V-Synth XT (V-Synth engine) | `roland-vsynthxt.js` | `roland-vsynthxt-fw.js` (`tools/roland/vsynth_fw.py`) | `roland-vsynthxt-translate.js` | `tests/roland-vsynthxt.test.js` |
| V-Synth XT VC-1 (D-50) | `roland-vsynthxt-vc1.js` | `roland-vsynthxt-vc1-fw.js` (`tools/roland/vc1_fw.py`) | `roland-vsynthxt-vc1-translate.js` | `tests/roland-vsynthxt-vc1.test.js` |
| V-Synth XT VC-2 (Vocal Designer) | `roland-vsynthxt-vc2.js` | `roland-vsynthxt-vc2-lists.js` (`tools/roland/vc2_fw.py`), effect tables `roland-vsynthxt-vc2-fw.js` (`vsynth_fw.py`), starting patch `roland-vsynthxt-vc2-init.js` | `roland-vsynthxt-vc2-translate.js` | `tests/roland-vsynthxt-vc2.test.js` |

All three are in `js/devices/catalog-extra.js` until the catalog is rebuilt.

## Firmware

`V-SynthXT.rom` is an "MI004" update file: a table of 16-byte entries (CPU address, size, 16-bit
checksum, flags, index, block type) followed by the flash blocks. `tools/roland/vsynth_rom.py`
rebuilds the 8 MB flash image and inflates the zlib streams in it:

| Flash | Name | Version | Size | What |
|---|---|---|---|---|
| 020000 | MI004 | 0.09 | 112 KB | updater |
| 030000 | MI004 | 2.02 | 0.97 MB | system / boot ("V-Synth XT Ver.2.02") |
| 0B0000 | VAPP1 | 0.20 | 8.75 MB | **V-Synth application** (loaded at 89300000, SH-4 little endian) |
| 400000 | VAPP3 | 2.00 | 12.6 MB | VC-1 application ("V-Card VC-1 D-50") |
| 500000 | VAPP2 | 0.17 | 9.6 MB | VC-2 application (Vocal Designer) |

`V-SynthXTDiskImage.bin` (one zlib stream, 64 MB) is the internal disk image; `MI004.BIN` the
updater for USB.

Ghidra: `re/vsynthxt/ghidra/vsynthxt.gpr` holds VAPP1 (`os.2.0B001C.bin`), VAPP2 (`os.4.50001C.bin`)
and VAPP3 (`os.3.40001C.bin`), all at 89300000, and the system image (`os.1.03001C.bin`) at
88000000 (SuperH4 LE). Analysis only finds part of the code; `~/ghidra_scripts/VsFuncs.java`
creates functions after every `rts`, `VsDecomp.java` decompiles by address and `VsDecompRange.java`
a range (headless: `analyzeHeadless ... -process <image> -noanalysis -postScript VsDecomp.java`).
`tools/roland/ghidra/VsEmuFmt.java` (copy it to `~/ghidra_scripts`) runs the value display routine
in the p-code emulator: `-postScript VsEmuFmt.java <out.tsv> <jobs: "id min max" lines> [fpscr]
[function]` (VAPP2: function `894fa070`).

## MIDI implementation (V-Synth engine)

**SysEx parser** `FUN_8946e040`: Roland header, then the model ID (zero bytes count as 100h each)
looked up in a table at 897A0668 that also gives the address length:

| Model | Address bytes | Handled as |
|---|---|---|
| 00 53 | 4 | **V-Synth**: DT1 and RQ1 (below) |
| 00 24 | 5 | undocumented: DT1 to 89476FC0 and RQ1 to 89477690 by the address's top nibble (1, 4, 5, 6); reads sample and project data (file sizes, sample headers). Not used by the editor yet. |
| 42 | 3 | GS DT1 (handler 89472CE0) |
| 01 10, 46, 6A | 4 | parsed, no handler for this engine |

Device ID 7F (and 7E for model 00 53, handler 894769A0 with five sub-commands) are accepted too.
Universal messages (handler 8946D240): master volume (04 01), fine tune (04 03), coarse tune
(04 04), global parameter control (04 05), controller destination (09 01, 09 03), key-based
instrument control (0A 01). Identity request answers family 53 01.

**Address map** (decoder `FUN_89483E80`, patch blocks `FUN_89483510`, block handlers in the vtables
at 89830028 / 8982FD40, each adding the block's first parameter id):

| Address | Size | First id | What |
|---|---|---|---|
| 01 00 00 00 | 37h | 0 | setup: part 1-16 bank/program, transpose, octave, beep, template, palette |
| 02 00 00 00 | 38h | 39h | system: master tune/key/level, clock, Rx PC/bank, part receive switches and channels, EQ |
| 02 00 40 00 | 1Bh | 7Fh | Tx PC/bank, keyboard and aftertouch, beams, pad, Time Trip, knobs, pedals |
| 02 00 50 00 | 48h | BAh | user sets 1-8 knob parameters, knob CC assigns |
| 10 0n 00 00 | patch | | temporary patch (n = 0-F all answer the current patch) |
| 20 00 00 00 + n × 00 01 00 00 | patch | | user patch n, U001-U512 (20 00 - 23 7F) |

Patch layout (offsets from the patch address):

| Offset | Size | First id | Block |
|---|---|---|---|
| 00 00 00 | 72h | 103h | common: name, category, tune, mono/poly, portamento, tempo, bend, effect switches, zones, scale tune, matrix control 1-8 |
| 00 02 00 | 84h | 177h | MFX: type, levels, 32 parameters |
| 00 04 00 | 33h | 1FCh | chorus: type, levels, 12 parameters |
| 00 06 00 | 62h | 230h | reverb: type, level, 24 parameters |
| 00 08 00 | 0Dh | 42Bh | beam, pad, arpeggio |
| 00 09 00 | 10h | 439h | zone 1-16 knob sets |
| 00 0A 00 | 62h | 48Dh | step sequencer (4 tracks of 16 steps) |
| 00 10 00 + z | 80h | 293h | zone z tone: structure, MOD, TVA, OSC 1, OSC 2 |
| 00 20 00 + 2z | A9h | 314h | zone z envelopes 1-13 |
| 00 40 00 + z | 28h | 3BEh | zone z LFOs 1-5 |
| 00 50 00 + z | 42h | 3E7h | zone z COSM 1 |
| 00 60 00 + z | 42h | 3E7h | zone z COSM 2 |
| 00 70 00 + n | 42h | 44Ah | arpeggio step pattern n (control and 32 step velocities) |

One RQ1 over any range returns every block inside it (`FUN_8947d240` walks the range and skips
gaps): `RQ1 10 00 00 00 / 00 01 00 00` answers 103 DT1 (10 318 bytes, 4.9 s). The editor reads
patches this way. Patch selection: bank select 87 / 0-3 and program change 0-127 on the part 1
receive channel select U001-U512.

**Parameters**: names (2389 pointers at 89790338), internal layout and ranges (12-byte entries at
897A167C: byte offset and bit width/position in the 7-bit-packed patch, bias, default, min, max),
display specs (89792BA0; items separated by 01h, ranges a 02h b, unit after 03h), effect-type
parameters (8-byte entries at 897A56D8 with their "Parameter n" slot, ranges and specs at
89794114) and the effect type table (8979288C). A value of more than 7 bits takes 2, 4 or 8
addresses (nibbles, high first) and its extra addresses are named "!(dummy)". In SysEx a value is the
internal one, plus 64 - bias for small signed fields (octave shift is 61-67), see `FUN_894819C0`;
effect parameters are value + 32768.

Value displays come from the specs: option lists, numbers with units, note names, the tempo-sync
note values (LCD glyphs at 89795484: 1/32 ... 2, with triplets and dots), the CC name table (CC32
shows OFF), pans, and non-linear ranges taken from the firmware's own value lists (1/3-octave
frequencies, Q values, rates, delay times).

Some lists are not in any table: the display routine (`FUN_89461A70`: r4 = id, r5 = value, r6 = 1
to add the unit) computes them per id (`FUN_89462A90`, `FUN_89463670` and their helpers: reverb and
pre-delay times, room sizes, delay times in ms followed by note values, slow LFO rates).
`tools/roland/ghidra/VsEmuFmt.java` runs that routine in Ghidra's p-code emulator for every value
of the 55 parameters (V-Synth, 5476 values; the VC-2's copy at `894FA070`: 71 parameters) and
`vsynth_fw.py --display` takes the texts from `tools/roland/vsynth_display_vapp1.tsv` /
`_vapp2.tsv`. Two things the routine does that the screen then shows too:

- **Reverb Time / Low and Hi Rev Time** of ROOM1-3, PLATE and HALL1-3, GARAGE (64 or 80 values)
  read 0.06, 0.10 ... 0.30, then **0.31, 0.32 ... 0.46**, then 2.00, 2.25 ...: `FUN_89462840` adds
  25 hundredths to values 5-21 where the VC-2's routine shows 0.40 ... 1.90 for the same reverbs. A
  display bug of the V-Synth application; the XT's screen shows it (checked on the unit: ROOM2 and
  HALL2 step 0.30, 0.31 ... 0.46, then 2.00).
- **HALL2 / HALL3 / GARAGE Reverb Time**: the routine has no case for their ids, yet the screen shows
  the list: their display spec is the same string as HALL1's / ROOM1's Low Rev Time, so the editor
  takes that list (`vsynth_fw.py`: same spec pointer, same number of values).
- **NON-LINEAR Feedback Level, 2ND ORDER SIDE BAND FILTER Q, DUAL FILTER Filter 1/2 Frequency**: no
  case and no parameter sharing their spec, so the editor shows the step number with the unit, as
  the routine prints it ("12[Hz]"); their specs ("160<02>15000", "100<02>4900") give the span. Not
  yet looked at on the screen.

Envelopes and LFOs are numbered in the order of the Matrix Control destinations and of the long
parameter names ("OSC 1 Pit Env", "Time/PW Env", "Fmt/Fat Env", "TVA Env", "COSM [..] ENV (A)/(B)"):
Env 1-4 OSC 1 pitch / time-PW / formant-fat / level, Env 5-8 the same for OSC 2, Env 9-10 COSM 1 A/B,
Env 11-12 COSM 2 A/B, Env 13 TVA; LFO 1-5 OSC 1, OSC 2, COSM 1, COSM 2, TVA.

Patch categories: the PATCH Category screen's 16 names (No Assign, Synth, Lead, Pad/Strings ...).

No SysEx address in OS 2.02 (set on the XT): Power Up Mode, Transmit Edit Data, Receive Exclusive,
Exclusive Protect, Device ID, Output Gain, external input, USB settings, Local Switch, Remote
Keyboard, Active Sensing, V-LINK settings, Key Hold Panic Key (ids 71h-7Eh, 9Ah-B9h). **Digital
Output Frequency** (id 77h) can be set, not read, through the device-7E message (see Undocumented
SysEx); the System page's **Digital output frequency** button sends it.

## VC-1 engine (D-50)

The VC-1 application (VAPP3) speaks the D-50's SysEx: model 14h, 3-byte addresses, device ID =
MIDI basic channel - 1. Parser `FUN_8930DC00`: RQ1 11h, DT1 12h, and the handshake commands WSD 40h,
RQD 41h, DAT 42h (answered ACK 43h or ERR 4Eh), EOD 45h, ERR 4Eh, RJC 4Fh. DT1 `FUN_8930DF10` and
RQ1 `FUN_8930DE80`:

| Address | Size | What |
|---|---|---|
| 00 00 00 | 1C0h | temporary patch: upper partial 1 (+00 00), upper partial 2 (+00 40), upper common (+01 00), lower partial 1 (+01 40), lower partial 2 (+02 00), lower common (+02 40), patch (+03 00); 64 bytes each |
| 02 00 00 + n × 03 40 | 1C0h | patch memory 11-88 (n = 0-63) **of the bank selected on the VC-1** (8 banks of 64) |
| 03 60 00 + k × 02 78 | 178h | reverb data 17-32 (k = 0-15) of the current bank: 188 values 0-255 as nibble pairs |

Every written byte is checked against a range table (895E1C98: 7 blocks × 64 min/max pairs; the
12 pairs before it are the VC-1's own settings, which have no SysEx address). The editor's names
are the firmware's control-assign list (896281A0: short name, long name on two lines) and, for the
bytes it leaves out, its edit-page labels; the value displays are its screen lists (notes C1-C7,
keyfollow -1 ... s2, bias points <A1 ... >C7, the 128 PCM waves Marmba ... RevVox, LFO waves,
EQ frequencies and Q, key modes WHOLE ... SEP-S, chase modes). Chorus type 1-8 and reverb type 1-32
show as numbers on the VC-1. Names use the D-50 character set (space, A-Z, a-z, 1-9, 0, -).

The VC-1 adds six bytes to the D-50's patch block (the VC-1 manual names them): 28h Chase Switch,
29h Portamento Switch, 2Ah Separate Switch, 2Bh MIDI Transmit Bank Select (OFF, 0-99; matches the
firmware's display routine), 2Ch Tone Select, 2Dh Partial Select. The rest of each block is
"Extension" (partial 36h-3Fh, common 30h-3Fh, patch 2Eh-3Fh), kept but not shown.

The image keeps "Initial patch" (the editor's defaults) followed by 384 factory patches (preset
banks P1-P6: Fantasia ... Big Waves) at 8939FE50; the tests read them from the image. D-50 dumps
send 256-byte DT1 packets that run across patch boundaries; the Branch Library files each packet under
every patch it touches and picks the patch a set of packets covers most. Handshake recordings (DAT
42h) import the same way.

## VC-2 engine (Vocal Designer)

The VC-2 application (VAPP2) answers its **own model, 00 00 0D** (identity family 0D 02), not the
V-Synth's 00 53. Its map is built at run time: `FUN_89316A40` fills 40-byte descriptors (one per
address) that the DT1 handler `FUN_8931C1B0` uses, so the rows come from the VC-2 MIDI
Implementation (2005) and every size and range below was checked on the unit. (The image also
holds the V-Synth framework's tables and address decoder `FUN_8932A010`: left over from the shared
code; nothing answers on them. Its effect tables still name the effect parameters.)

| Address | Size | What |
|---|---|---|
| 01 00 00 00 | 0Ch | setup: bank/program, transpose, octave, beep, sampling template, palette, chord memory switch and hold |
| 02 00 00 00 | 91h | system: master tune/key/level, clock, MIDI, keyboard and beam sensitivity, beam/pad/trip/knob/pedal assigns, voice assign, EQ, chord memory grid and 12 × 4 notes |
| 03 00 0n 00 | 1Dh | sampling template n+1 (n = 0-7): name, mic EQ (low, mid, high), pre-effect (noise suppressor, compressor, limiter) |
| 10 00 00 00 | patch | temporary patch |
| 20 00 00 00 + n × 00 01 00 00 | patch | user patch n, U001-U448 (20 00 - 23 3F) |
| patch +00 00 00 | 14Bh | common: algorithm (12), name, tempo (4 nibbles), beam type, pad, coarse/fine tune, scale tune (12 × 2 nibbles), MFX/chorus/reverb switches, MFX (00 32), chorus (01 36), reverb (01 69) with their parameters (4 nibbles, value + 32768) |
| +00 03 00 | 43h | carrier: portamento, mono/poly, legato, bender, glide, vibrato; OSC 1 and 2 (wave, offset, level, pan, pitch, glide, PW, sub oscillator, detune, formant style, formant, vibrato); growl; EQ 1/2; TVA |
| +00 04 00 | 0Fh | modulator: key mode, wave, pitch/time/formant, tempo sync, level, four controls with depths |
| +00 05 00 | 0Eh | vocoder: natural and vocoder levels, level control, attack, release, auto note on, hold dump, unvoiced detect and level, formant type, tone |

Value names are the VC-2's screen strings (`vc2_fw.py`): the 12 algorithms (Modeling Choir ...
Process Type2), MFX (Thru ... Pseudo Stereo), chorus (Off, Chorus 1 ... Fbk Short Delay), reverb
(Off, Stereo Plate ... Garage: the unit takes 0-14 and refuses 15-17), formant styles (FLAT ...
IMPROV), formant types (FLAT ... STFEM2), vibrato types (NORMAL, FEMALE1, FEMALE2, MALE) and the
controller list, which is indexed by CC number (32 shows OFF; 96-109 BEND ... BREATH; the modulator
controls leave out VELO and KEYF). Effect parameters follow the type through the framework tables.

What the unit does that the manual does not say:

- The **algorithm decides which values are taken**: choosing one makes the VC-2 load that
  algorithm's **INIT PATCH** (every value, the same whatever patch it held), and each parameter
  belongs to an algorithm group (from the VC-2's address descriptors, emulated) that only some
  algorithms take; a value outside them, or out of the algorithm's wave range, is silently refused.
  Wave numbers: carrier OSC 1 takes 1-24 (the choir waves), 25-35 or 36-46 depending on the
  algorithm, OSC 2 0-52 or nothing, the modulator 0-127 under the Keyboard algorithms only. The
  tables, checked on the unit, are in
  [roland-vsynth-xt-vc2-params.md](roland-vsynth-xt-vc2-params.md); the editor hides what the
  algorithm does not use. It writes the common block (with the algorithm) first, so whole patches
  land, and translations start from the factory patch ("LargeChoir 1",
  `roland-vsynthxt-vc2-init.js`), which the unit accepts in full.
- A **value of several nibbles split over two DT1 messages is dropped**: the editor cuts messages
  between parameters (the VC-2's own replies are 255-byte packets cut anywhere).
- **Bank select 87/0** is the preset bank P001-P128 (no SysEx address); the user patches are
  **87/1-87/4**: 87/4 + program 63 recalled U448. An RQ1 over several user patches answers wrongly
  (it returned the sampling templates), so the complete dump asks for each patch.
- Model 00 24 works in VC-2 mode: 58 waves (1 "LargeCho A S" ... 58 "116 WahCutG+"); the editor's
  **Read wave names** shows them next to the oscillator wave numbers.

## Undocumented SysEx

| App | Message | What it does | Status |
|---|---|---|---|
| V-Synth, VC-2 | model **00 24**, 5-byte addresses (and 5-byte RQ1 size): `kind << 28 \| (n - 1) << 14 \| low` | The project's waves (`V:\Internal.prj\Wave\`, up to 500). RQ1 (`FUN_89477690`): kind 4/5, low 0 = **wave n's 16-character name**; low 80h + 10h·k = entry k of the wave's two 128-entry records (4 and 6 bytes, in nibbles; records of 210h and 310h bytes in RAM at 89C375C0 / 89C38560); kind 6 = 12 bytes of sample facts (a size, a tempo-like value, three header fields). DT1 (`FUN_89476FC0`): kinds 4/5 write the name (16 bytes as sent) and record entries (nibbles), kind 6 writes the sample facts back, **kind 1 n = 1/2 sets OSC 1/2 Wave Number** of the edited patch (ids 2BEh/2F2h) to a 2-byte value. No audio: there is no message carrying sample data, and the XT has no Sample Dump Standard (its universal handler takes identity, GM on/off and scale tuning only) | names read on the unit (1 DLP-Crenshaw ... 100 WND-Oboe ... 224 PRC-UduPot; numbers after the last answer zeros). The names come from the table of waves **loaded into wave memory** (`FUN_89477740`: n up to a count; `FUN_89480e30` enters wave n, 1-500, when `FUN_893c5c60` loads it from the drive and raises the count to the highest number loaded), so a WAV copied onto the drive is not there until the XT loads it (2026-11-25: a full 1-999 scan found 224 waves, none of the copied samples). The 224 names read in 38 s. The editors' **Read wave names** action uses it, stops at the first empty number and remembers the names. DT1 checked on the unit 2026-11-24 (kind 1, names, record entries; see Checked on the unit); the editor sends none |
| V-Synth | device **7E**, model 00 53, DT1 to 00 00 00 00 with one byte 0-4 (`FUN_894769A0`) | The XT's factory-test remote (the strings next to it are the test screen's: "DIGITAL OUT (48KHz @ OPTICAL)", "DIGITAL IN (96KHz @ COAXIAL)"...). **0/1/2 set system parameter 119, Digital Output Frequency, to 44.1/48/96 kHz** (`FUN_89476830` → parameter set 77h) and clear the two sampling mode bytes (`FUN_894AF1E0/894AF200`); 3/4 set them to 2 and select input 0/1 through an OS call (88008460) that 0-2 do not undo: **the coaxial sampling screen opens for an instant for the left/right channel**. Nothing restarts the XT or switches V-Card | checked on the unit 2026-11-24: 0 showed 44.1 kHz, 1 put back the user's 48 kHz; the user saw 3/4 open the coaxial sampling screen (L/R) and close at once. The System page offers 0-2 (write only) |
| VC-1 | model **00 11** at device 10h, 4-byte addresses 71 xx xx xx (`FUN_89309FA0`; each byte is one 8-bit position) | DSP host port (command 34h/35h/36h, `FUN_89308DC0`...): DT1 71 00 00 00 = 6 bytes straight into hardware registers at B0002000; 71 00 10 00 + nibble offset = coefficients 0-2FFh, 71 00 40 00 + offset = 400h-6FFh, 7 nibbles (28 bits) each; 71 01 00 00 and 71 01 01 00 single coefficients (16-bit field with a 2-bit selector, or 24 bits). RQ1 (status word at 71 00 00 10, coefficients) builds a reply but the release firmware's send routine (8930F060) is an empty `rts`: **write-only**, nothing can be read back | RQ1 sent on the unit: no reply, as the code says. DT1 not sent: no read-back to restore from, and raw coefficients can make the engine loud or unstable |
| VC-2 | models **00 00 0D**, **00 6D**, **00 4D**, 00 53 (4-byte addresses) in its model table | **00 00 0D is the VC-2's own** (all its data); 00 6D, 00 4D and 00 53 are parsed but nothing on the XT answers or applies them: RQ1 at device 10h, 7Fh and 00 to 00, 01, 10 and 40 00 00 00 got no reply, and a DT1 to the vocoder level through each changed nothing (through 00 00 0D it did). Not VariOS (its model is 00 1D) | checked on the unit 2026-11-24 |
| V-Synth, VC-2 | GS model 42 (3-byte), 01 10, 46, 6A | parsed; GS DT1 handled, the others have no handler | |

## Disk (USB storage, internal drive)

`V-SynthXTDiskImage.bin` is the factory internal drive: MBR, one FAT16 partition at sector 32
(24 MB, label "RJA2.00"). What the XT keeps there, readable and writable from a computer in USB
storage mode, which is the way to move audio (MIDI cannot):

| Path | What |
|---|---|
| `Internal.prj\` | the V-Synth project: `V-Synth System.s00`, `Template.s00`, `Palette.s00` |
| `Internal.prj\Wave\nnn <name>.w00` | the 224 preset waves: 36-byte files of tagged chunks (4-character tag, 32-bit LE length), `link` (the preset wave number) and `name` (16 characters); `tools/roland/vsynth_waves.py` lists them for the editor's wave menus |
| `Internal.prj\Wave\nnn <name>.wav` | **user samples** (a sample recorded on the unit became `225 User Sample.wav`): a RIFF WAVE, 16-bit PCM, 44.1 kHz (mono here), with Roland chunks before `data`: `vpfl` (\"0102 \", the sizes of the other chunks, encoding \"LINR\"), `vpsc` (32 bytes, the sample count among them), `vpno` (16), `vplp` (loop points: start 0, end = samples - 1), `vpdt` (724 bytes, probably the Variphrase analysis), `LIST INFO` (\"V-Synth Ver.0.20\", \"(C) 2003 Roland Corporation.\") and `rdmd`, a small Standard MIDI File (tempo 118.18, 4/4, RPN 0 = 12, a sequencer meta text \"A01_MO_60_110_44000\", markers, one note A#2). The Head Library imports it as a sample (the audio). Model 00 24 does not list it: its tables end at the 224 preset waves (kinds 4 and 5 answer zeros for 225), so a user sample's name cannot be read over MIDI. Whether the XT takes a plain WAV copied into the folder, without the `vp*` chunks, is not tested |
| `Internal.prj\Patch\nnn <name>.p00` | the 512 user patches, 5402 bytes each: **read and written by the editor** (layout below) |
| `Internal.vc2\` | the VC-2's system, template, palette, Wave and Patch folders; `Patch\nnn <name>.p02` (5060 bytes): the same container, header "VC20Rev008", chunk `PATa` `VC_2` of 13A4h bytes: the V-Synth packing with 8 zones, the VC-2's values in V-Synth fields and extension areas (`roland-vsynthxt-vc2-p02.js`; every value's place in [roland-vsynth-xt-vc2-params.md](roland-vsynth-xt-vc2-params.md)); read, written and imported, checked on the 16 factory files |
| `VC1.S10` | VC-1 settings (36 bytes) |
| `VC1_I1.P10` ... `VC1_I8.P10` | the VC-1's user banks I1-I8, 36 944 bytes: a 16-character date stamp ("2004/03/23 00003"), the 64 patches 11-88 in the 448-byte patch-memory layout (what 02 00 00 answers; byte for byte the bank read from the unit), the reverb data 17-32 (16 × 178h nibbles, as at 03 60 00) and 64 records of 35 bytes (identical in every factory file; not mapped). **Imported by the VC-1 definition** (64 patches per file) |

**`.p00` patch files** (`js/devices/defs/roland-vsynthxt-p00.js`): a 32-byte header that is the
same in every file (`00 1E "SVD0"`, ten zero bytes, chunk `PATa` `KATE` at 20h, 14FAh bytes) and
the firmware's bit-packed patch, 5370 bytes. Each value is at the [byte offset, bits, bit position
from the MSB] of the parameter table (897A167C; `PACK` in `roland-vsynthxt-fw.js`) counted from its
block's start, and the blocks lie end to end:

| Block | Start | Block | Start |
|---|---|---|---|
| common | 0 | COSM 1 (zone z) | 3590 + 34z |
| MFX | 84 | COSM 2 (zone z) | 4134 + 34z |
| chorus | 152 | beam, pad, arpeggio | 4678 |
| reverb | 180 | arpeggio step pattern n | 4684 + 34n |
| tone (zone z) | 230 + 78z | tone offsets 78-81 (OSC 1/2 Detune, Sub Oscillator) | 5228 + 4z |
| envelopes (zone z) | 1478 + 112z | step sequencer | 5292 |
| LFOs (zone z) | 3270 + 20z | zone knob sets | 5362 |

A value holds its SysEx value less the editor's shift (two's complement in its width when it goes
below zero); 8/16/32-bit values hold the SysEx value. Found by matching the factory files 001 and
002 against the unit's SysEx answers for the same patches (all 5791 values agree); 489 of the 512
factory files are written back byte for byte, the rest differ only in bits no parameter uses (12 at
the end of each envelope block, the last bits of LFO, COSM and step blocks) and in bits 1-4 of a
COSM block, an older 4-bit copy of the COSM Type that unused zones leave stale (written as the
type). The Head Library imports `.p00` and `.P10` files and whole drive images (the factory image:
512 V-Synth and 512 VC-1 patches in 2.5 s); the Patch page has **Open .p00** and **Save .p00**
(named "nnn Name.p00" for the user patch it will replace). Not yet loaded on the unit.

**Editor pages** (`roland-vsynthxt-ui.js`, from the Owner's Manual): oscillator settings are shown
for the OSC Type in use (ANALOG: waveform, impact, pulse width and fat, renamed Detune/Mix for
SUPER-SAW, Harmonics/FBK Amount for FEEDBACK-OSC and X-MOD for X-MOD-OSC, sub-oscillator for SAW,
SQUARE, TRIANGLE, SINE, RAMP, JUNO, LA-SAW and LA-SQUARE, its Detune instead of Fat when on; PCM:
the wave as a list of names, start offset, time, formant and the playback switches; EXT IN: the
common settings). The arpeggio pattern is **one pattern of 32 steps by 16 lines** (OM p. 65): the
16 blocks at 00 70 00 + n are its lines (State NOTE/CTRL, the note or controller number, 32
velocities: 0 = rest, 128 = tie), not 16 patterns. The Multi Step Modulator's four tracks and the
arpeggio pattern use the generic step grid / tracker (`core/ui/stepgrid.js`). System: Part n Patch
(bank select 87/0-3 + program, U001-U512 with names) replaces the three bytes; receive channels,
User Set knob positions (0-23: the PATCH PLAY screen's knobs OSC1-PRM1 ... TVA-REL, names read
off the unit; the firmware only numbers them) and controller numbers (with standard CC names) are lists. "Analog Wavefrom" (sic, the
firmware's name) is shown as "Waveform".

## Checked on the unit (2026-11-23)

Read-only: identity; every block of the temporary patch, the system blocks and user patches
U001/U002/U512 (24 00 00 00 does not answer); the whole-range RQ1. Edit buffer only, captured
before and restored after (byte for byte):

- the temporary patch written back through the editor: read back identical;
- single parameters (OSC 1 coarse tune, patch tempo as 4 nibbles, MFX parameter 1): only those change;
- a JP-8080 patch ("Den U") through the Head Library translator: all 5 775 parameters read back as sent;
- bank select 87/0-3 + program change: the temporary patch becomes U001, U002, U129, U512.

2026-11-24, read only: model 00 24 wave names and sample facts (numbers 1-12, 50, 100, 200 named;
400 and up empty).

**Model 00 24 writes and device 7E (2026-11-24, V-Synth mode)**: temporary patch captured first and
written back (all four 10 0x areas read back identical); every name and entry written was put back
and read back as it was. Tool: `re/vsynthxt/work/vsfile.py`.

- **Kind 1** (address bytes `01 00 00 00 00` for OSC 1, `01 00 01 00 00` for OSC 2, 4 nibbles): the
  two bytes are **little-endian** (nibbles of the low byte first: 0 1 0 2 = 513, 7 5 0 0 = 117) and
  the command sets **OSC Type = PCM** as well as the Wave Number (OSC 2 went ANALOG → PCM): "play
  wave n on OSC 1/2" of the edit buffer.
- **Kind 4 and kind 5 are separate records** with a name each; renaming one leaves the other. The
  **screen shows the kind-4 name** (wave 117 showed "MM-RenameTest 4" on the OSC page). Changes are
  in RAM (the 500-entry tables at 89C375C0 / 89C38560); whether they reach the disk was not tested.
- **Record entries** are key-map rows: kind 4 = `7F 7F` + sample number (16-bit LE), kind 5 =
  `7F 7F 00 00` + sample number; a preset wave has one row (wave 1 → sample 1, wave 117 → 117).
  Writing entry 127 (unused) with 01 02 03 04 read back as written; then zeroed again.
- **Kind 6** of wave 1: size 55 524 (32-bit LE), tempo fields 0, flag byte 1; not written (the
  firmware writes it to two different sample objects; no reason to touch it).
- **Device 7E sub 0** set Digital Output Frequency to 44.1 kHz (from 48): **sub 0/1/2 = system
  parameter 119 Digital Output Frequency 44.1/48/96 kHz**, which has no other SysEx address. Sub 0-2
  also clear the sampling mode bytes; sub 3/4 set them to 2 and select an input 0/1 through an OS
  call that sub 0-2 do not undo. The strings next to it are the factory test screen ("DIGITAL OUT
  (48KHz @ OPTICAL)", "DIGITAL IN (96KHz @ COAXIAL)"...), so the message is the test jig's remote.
  Toggled by hand, **sub 3 and 4 open the coaxial sampling screen for an instant**, for the left and
  right channel, and it closes at once (the sound the user first noticed after sub 3 was the patch
  itself). Nothing for the editor there; sub 1 put the user's 48 kHz back.

**VC-2 (2026-11-24, XT switched to VC-2; the user allowed writes and asked for everything back
as it was)**: everything touched was captured first (setup, system, the 8 templates, the temporary
patch "LargeChoir 1", U001, U448) and written back afterwards; each read back identical.

- the editor's Send to VC-2: read back identical; single parameters (vocoder level, a reverb
  parameter and the tempo as 4 nibbles) and the name: read back as sent; formant style 9 refused
  (locked by the algorithm);
- a JP-8080 patch through the translator: read back as sent except OSC 2 Switch, which Modeling
  Choir locks (the report says so); a system parameter (chord memory grid): read back as sent;
- Store into U448: read back identical once messages were cut between parameters (before that,
  Reverb Parameter 6, cut at 100h, was dropped); bank select 87/4 + program 63 then recalled it;
- range checks: reverb type 14 taken, 15 and 17 refused; carrier wave numbers as above.

**VC-1 (2026-11-24, XT switched to VC-1)**: device ID 00; the temporary patch was "Fantasia", byte
for byte the factory patch decoded from the image. Edit buffer only, captured before and restored
after (0 bytes differ):

- the editor's Send to VC-1 (two DT1 of 256 + 192 bytes, the sizes the VC-1 itself answers with):
  read back identical;
- one parameter (upper partial 1 TVF cutoff), a VC-1-only byte (MIDI Tx bank select) and the
  rename action: only those bytes change, read back as sent;
- Structure written as 7Fh (range 0-6): refused, the patch is unchanged (the range table works);
- a patch from a D-50 bulk-dump file (the factory bank P3 written out as a D-50 sends it, since no
  D-50 files were on disk), a JP-8080 patch ("Den U") and a V-Synth patch ("Da 'V' Code", the
  apostrophe becomes a space in the D-50 character set) through the Head Library translator: read
  back exactly as sent;
- read only: patch 11 (= Fantasia) and the whole current bank with one RQ1: 112 DT1, 28 672 bytes,
  about 21 s, longest pause 0.19 s.

**In Chrome, on the unit (2026-11-24)**, driven with `tools/browser/cdp.mjs` (DevTools protocol, a
separate profile): connecting loads the system, the temporary patch and all 512 patch names (about
21 s per bank of 128); choosing the ports on the Connect page now does the same (before, it only
sent an identity request, so nothing loaded and nothing said so). Part 16 Patch set to U002 and back
to U001, OSC 1 Wave 117 to 118 and back: each read back from the unit as set. Oscillator cards,
the Part patch lists with names, the step tracks (drawn and typed) and the arpeggio pattern checked
on screen.

## Translators (Head Library)

`roland-vsynthxt-translate.js` (V-Synth engine): zone 1 to and from the shared model. Another synth's patch becomes
OSC 1/2 analog waves (SUPER-SAW, FBACK-OSC, SQUARE...), MOD for ring/sync/FM, COSM 1 as TVF Mode0
(type, cutoff, Q, key follow, LFO and envelope depth; envelope A = Env 9), the TVA envelope (Env 13),
the shared LFO on LFOs 1-5, chorus/MFX/reverb-delay by effect name, name and category. The report
lists what was approximated (e.g. JP control knobs of SUPER SAW → Detune/Fat, delay time scale) and
dropped (unison, tone control, velocity and controller matrices, second LFO depths).

`roland-vsynthxt-vc1-translate.js` (VC-1): the upper tone to and from the shared model. Partials
become oscillators (synth partials SQU/SAW with pulse width; PCM partials `rom:<wave name>`), the
structure gives ring modulation, the first synth partial's TVF is the filter, the five-stage
envelopes read as ADSR (T1 attack, T2-T4 decay, sustain level, T5 release), LFO-1/2, EQ as tone,
chorus (D-50 manual names: Chorus 1 ... Dimension) and reverb by number. Into the VC-1: key mode
WHOLE (WHOLE-S for mono), structure from the oscillator types (S+P only exists with ring
modulation, so the PCM partial goes first otherwise), ADSR spread over T1-T5. The report lists the
approximations (triangle/sine → SQU, other filter types → the TVF's low pass) and what is dropped
(sync, cross modulation, delay, velocity and controller matrices).

`roland-vsynthxt-vc2-translate.js` (VC-2): the playing side of a vocal patch. Voice mode,
portamento, bend range, the carrier oscillators' level, pan, tuning and detune, the TVA attack and
release, tempo, and the effects by name (chorus or MFX for modulation, reverb, delay as the MFX
Stereo Delay), loading the new effect type's parameter defaults. Waves stay the VC-2's own
(`rom:<name>` once the names were read, else `vc2-wave:<n>`); filters, LFOs, ring/sync and the
pitch envelope are reported as dropped, and the report says that the algorithm decides which
oscillator and modulator settings the unit keeps.

## Open items

Done 2026-11-24: device 7E (Digital Output Frequency; test screens), model 00 24 writes, the effect
value lists the firmware computes (emulated), `.p00` read/write (also 100 third-party patches: all
read, 87 written back byte for byte, the rest differ only in payload byte 0, a 0/1 flag no parameter
covers, 0 in every factory file), `.P10` import and export, VC-1 bank select (87/0-13), the
V-Synth WAV settings (original key, tempo, range, Variphrase) on import.

Done 2026-11-25: the VC-2's address descriptors (emulated) give every parameter its algorithm
group and firmware parameter; per-algorithm groups, wave ranges and INIT PATCHes checked on the
unit; `.p02` read/write/import (all 208 values in 16 factory files); the editor shows the VC-2 per
algorithm; every VC-2 parameter documented in
[roland-vsynth-xt-vc2-params.md](roland-vsynth-xt-vc2-params.md).

Checked by the user on the unit (2026-11-25): a `VC1_I1.P10` written by Save bank .P10 and a
`001 LargeChoir 1.p02` written by Save .p02 load through USB storage; a plain WAV copied into
`Internal.prj\Wave\` works; VC-1 Play with bank select 87/n selects the patch (P2-11 played "Brass
Tacks", factory patch 65: the preset banks are the factory patches in order). The VC-1 shows its
banks as Int1-Int8 and Pre1-Pre6.

VC-1 SysEx patch memory (02 00 00) follows a bank chosen by bank select (checked 2026-11-25: from
Int1-11, 87/9 + program 0 made it answer Pre2's patches). The V-Synth OSC wave lists offer every
number 1-500, those without a name as user samples.

1. **On the unit**: wave names of samples copied onto the drive: model 00 24 answers only for waves loaded into wave memory (see
   "Undocumented SysEx"); does the XT load a copied WAV when a patch uses it, or only when the
   project loads?
2. **VC-2 modulator waves**: 0-127 with no names (stored 46 places on from the carrier's numbering
   in `.p02` files).
3. **User-sample chunks** still unread: `vplp` (start, loop and crossfade words, flags), `vpdt`
   (the Variphrase analysis), the `vpsc` words 3 and 6, the `rdmd` markers (SN1..SNn = events, FB,
   LB); needed only to write samples the XT plays as Variphrase without re-encoding.
4. **V-Synth and V-Synth GT**: same family; check their firmware against these maps.
