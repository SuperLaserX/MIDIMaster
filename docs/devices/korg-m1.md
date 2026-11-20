# Korg M1 / M1R / M1EX / M1REX: MIDI implementation from the M1R v1.06 firmware

The editor (`js/devices/defs/korg-m1.js`) serves both catalog entries (M1 and M1R; the EX
models use the same messages). It was built from the M1R v1.06 OS and checked against an M1R
over MIDI with `tools/korg/m1live.py` and `tools/korg/m1probe.py`.

## Firmware

Two 27C512s per version: IC32 holds the even bytes, IC23 the odd ones. Interleaved they make a
128 KB image at E000:0000 (the reset vector jumps to E000:0000). The CPU is a NEC V50 (x86
real mode). The startup code sets DS = F7BF, so data offsets below 8410h address the top of the
ROM (image offset = 17BF0h + offset) and higher offsets wrap into RAM. The MIDI code runs in
code segment EF69, so Ghidra (with the image based at E000:0000) shows its offsets 970h lower.

## SysEx

`F0 42 3g 19 ff ... F7`, g = global channel. The function dispatcher is at F000:1C1A; codes
0E-1F jump through DS:8384, codes 40-51 through DS:8360.

| Code | Message | Notes |
|---|---|---|
| 10 | program dump request | reply 40, 143 bytes (program modes) |
| 19 | combination dump request | reply 49, 124 bytes (combination modes; else 24) |
| 0E bb | global request | reply 51 bb, 861 bytes; bb 0 internal, 1 card |
| 1C bb / 1D bb | all programs / all combinations | replies 4C / 4D, 100 records each |
| 0F bb / 18 bb | all data / sequence data | replies 50 / 48 |
| 12 | mode request | reply 42 mode ... |
| 4E mm bb | mode change | 0 combi play, 1 combi edit, 2 program play, 3 program edit; bb card |
| 11 bb nn / 1A bb nn | program / combination write | refused (22) while memory protect is on |
| 41 pl ph vl vh | parameter change | edit modes only; numbers 0-27, the high byte is ignored |

Without the memory byte, the bulk requests answer 26 (format error). Replies: 21 write
completed, 22 write error, 23 data load completed, 24 data load error (wrong mode), 26 format
error. Dumps are 7-in-8 packed (a byte of high bits, then 7 bytes). The M1R also answers the
universal identity request (family 19 00).

## Data layout

The edit pages are tables of field records (image 18F00h-19800h): a layout word, a pointer to a
descriptor `[max, min, format, label]`, the field's RAM address and one more word. Program
fields point into the edit buffer at DS:9969, which gives each byte's label and range:

| Bytes | Program contents |
|---|---|
| 0-9 | name |
| 10 | OSC mode (SINGLE, DOUBLE, DRUMS); 11 bit 0 voice mode (POLY/MONO), bit 1 hold |
| 12, 14 | OSC1/OSC2 multisound 0-99 (drum kit 0-3 in DRUMS mode); 13, 15 octave -1..1 |
| 16-18 | OSC2 interval ±12, detune ±50, delay start |
| 19-22, 23-26 | pitch MG / VDF MG: waveform (bits 0-1), OSC or VDF select (bits 5-6), key sync (bit 7); frequency, delay, intensity |
| 27-31 | aftertouch: pitch ±12, pitch MG, VDF cutoff ±99, VDF MG, VDA amplitude ±99 |
| 32-37 | joystick: bend range ±12, VDF sweep ±99, pitch MG intensity/frequency, VDF MG intensity/frequency |
| 38-62 | effects: types (0 none, 1-33 Hall ... Delay/Tremolo), then 23 bytes not mapped yet |
| 63-70 | OSC1 pitch EG: start level, attack time/level, decay time, release time/level, level and time velocity sensitivity |
| 71-77 | VDF1 cutoff, kbd track center key and cutoff, EG intensity, kbd/velocity EG time, velocity EG intensity |
| 78-85 | VDF1 EG: attack time/level, decay time, break point, slope time, sustain level, release time/level |
| 86-91 | VDA1 level, kbd track center key and amplitude, velocity amplitude, kbd/velocity EG time |
| 92-98 | VDA1 EG |
| 99-102 | EG time switches (AT/DT/ST/RT, 2 bits each) for VDF kbd, VDF velocity, VDA kbd, VDA velocity |
| 103-142 | the same for OSC2 |

Combinations: name, type (SINGLE, LAYER, SPLIT, VEL.SW, MULTI), the same 25-byte effect block
(11-35), then 8 timbres of 11 bytes: program, level, transpose, detune, panpot, key window
top/bottom, velocity window top/bottom, MIDI channel, MIDI filter bits (program change,
damper, aftertouch, control change; bit 4 is set on unused timbres). Global: 21 bytes of
settings, then 4 drum kits of 30 instruments x 7 bytes (drum sound 0-43, key, tune and level
bytes). Multisound, drum sound and effect names come from the firmware (image 1DFFAh, 1E5C6h,
1EE0Dh).

The parameter-change numbers 0-27 (found by sending each to the M1R and reading back) cover
OSC mode, both multisounds, the VDF/VDA levels and center keys, MG waveforms, controller pitch
ranges and effect types. The editor sends every edit as a whole dump (program 170 bytes,
combination 150) instead, which reaches every parameter and is heard at once.

## Not mapped yet

The effect parameters and placement (program 40-62, combination 13-35), the order of the 21
global settings, and the drum kit bytes beyond sound, key and tune. The editor shows them as
typed values. The effect pages address the data indirectly, so their field tables do not give
the offsets; a capture of the M1's own parameter-change messages while editing on the panel,
or more tracing of the effect page code, would.
