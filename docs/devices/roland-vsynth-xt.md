# Roland V-Synth XT

Editor definition `js/devices/defs/roland-vsynthxt.js`, generated tables `roland-vsynthxt-fw.js`,
translator `roland-vsynthxt-translate.js`, tests `tests/roland-vsynthxt.test.js`. Built from the
OS 2.02 update (`z:/firmwares/Roland V-Synth XT v2.02.zip`) and checked on a V-Synth XT
(port `2- VSynth`, device ID 10h, identity `F0 7E 10 06 02 41 53 01 00 00 01 00 00 00 F7`).

Scope so far: the **V-Synth engine** (the XT's normal mode). The VC-1 (D-50) and VC-2 (Vocal
Designer) engines are separate applications with their own MIDI implementation; see Open items.

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

Ghidra: `re/vsynthxt/ghidra/vsynthxt.gpr` (VAPP1 at 89300000, SuperH4 LE). Analysis only finds
part of the code; `~/ghidra_scripts/VsFuncs.java` creates functions after every `rts`, and
`VsDecomp.java` decompiles by address (headless: `analyzeHeadless ... -postScript VsDecomp.java`).

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

Envelopes and LFOs are numbered in the order of the Matrix Control destinations and of the long
parameter names ("OSC 1 Pit Env", "Time/PW Env", "Fmt/Fat Env", "TVA Env", "COSM [..] ENV (A)/(B)"):
Env 1-4 OSC 1 pitch / time-PW / formant-fat / level, Env 5-8 the same for OSC 2, Env 9-10 COSM 1 A/B,
Env 11-12 COSM 2 A/B, Env 13 TVA; LFO 1-5 OSC 1, OSC 2, COSM 1, COSM 2, TVA.

Patch categories: the PATCH Category screen's 16 names (No Assign, Synth, Lead, Pad/Strings ...).

No SysEx address in OS 2.02 (set on the XT): Power Up Mode, Transmit Edit Data, Receive Exclusive,
Exclusive Protect, Device ID, Output Gain, digital output, external input, USB settings, Local
Switch, Remote Keyboard, Active Sensing, V-LINK settings, Key Hold Panic Key (ids 71h-7Eh, 9Ah-B9h).

## Checked on the unit (2026-11-23)

Read-only: identity; every block of the temporary patch, the system blocks and user patches
U001/U002/U512 (24 00 00 00 does not answer); the whole-range RQ1. Edit buffer only, captured
before and restored after (byte for byte):

- the temporary patch written back through the editor: read back identical;
- single parameters (OSC 1 coarse tune, patch tempo as 4 nibbles, MFX parameter 1): only those change;
- a JP-8080 patch ("Den U") through the Main Library translator: all 5 775 parameters read back as sent;
- bank select 87/0-3 + program change: the temporary patch becomes U001, U002, U129, U512.

## Translator (Main Library)

`roland-vsynthxt-translate.js`: zone 1 to and from the shared model. Another synth's patch becomes
OSC 1/2 analog waves (SUPER-SAW, FBACK-OSC, SQUARE...), MOD for ring/sync/FM, COSM 1 as TVF Mode0
(type, cutoff, Q, key follow, LFO and envelope depth; envelope A = Env 9), the TVA envelope (Env 13),
the shared LFO on LFOs 1-5, chorus/MFX/reverb-delay by effect name, name and category. The report
lists what was approximated (e.g. JP control knobs of SUPER SAW → Detune/Fat, delay time scale) and
dropped (unison, tone control, velocity and controller matrices, second LFO depths).

## Open items

1. **VC-1 (D-50) engine**: VAPP3 at flash 400000. Its own SysEx (likely the D-50's, model 14h, plus
   a VC-1 map) and parameters; the "Card" mode is selected on the XT.
2. **VC-2 (Vocal Designer) engine**: VAPP2 at flash 500000.
3. **Model 00 24** (5-byte addresses): sample and project access. Worth mapping for moving samples
   to and from the Main Library.
4. **Device ID 7E + model 00 53** (handler 894769A0, five sub-commands that change modes): not
   probed on the unit; map from the firmware before trying.
5. **36 effect parameters** whose value lists the effect pages compute (reverb times 0.06-32 s, room
   sizes, some delay times with note values, LFO rates 0.02-5 Hz): shown as raw steps between the
   firmware's end labels. The display code for them (special ids in `FUN_89461a70`) is the place to
   look.
6. **Wave names** for PCM oscillators (Wave Number 1-999): the samples are on the XT's disk, not in
   the firmware; model 00 24 may read them.
7. **V-Synth and V-Synth GT**: same family; check their firmware against this map.
